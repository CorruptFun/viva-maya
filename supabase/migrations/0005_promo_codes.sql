-- ============================================================================
-- 0005_promo_codes.sql
-- Promo / reward codes: the OWNER mints codes and hands them out; a signed-in
-- player types a code in the Gift Store and redeems it for chips / hearts / a
-- boost. Distinct from referrals (0004): referrals are for NEW users via a link;
-- promo codes are for EXISTING users who type a code you gave them.
--
-- SECRECY + SINGLE-USE: codes must NOT be enumerable from the client (or players
-- could dump them), and each must be redeemable once per account (and optionally
-- capped globally). So redemption goes through ONE SECURITY DEFINER function,
-- redeem_promo(code): it reads the code table (which has NO client-readable RLS
-- policy — deny-by-default), checks active / not-expired / not-already-redeemed /
-- under-cap, records the redemption, and returns the reward. The client can only
-- CALL the function; it can never read the code table directly.
--
-- TRUST MODEL (v1, consistent with 0004): the grant itself lands in the client
-- save (like referral chips). A modified client could re-apply a reward it was
-- legitimately given, but can never read other codes, redeem twice (the
-- (code,user_id) PK blocks it), or forge a code that isn't in the table. Fine at
-- family/friends scale; the redemption ledger is the audit trail.
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- ==========================================
-- TABLE: public.promo_codes — one row per mintable code. OWNER-managed (insert
-- rows from the SQL editor / dashboard). NEVER client-readable.
-- ==========================================
create table if not exists public.promo_codes (
    code            text primary key check (code ~ '^[A-Z0-9]{4,16}$'),
    -- 'chips' → amount chips · 'hearts' → full lives refill (amount ignored)
    -- 'boost' → `amount` copies of boost_type queued for the next level
    reward_kind     text not null check (reward_kind in ('chips', 'hearts', 'boost')),
    reward_amount   integer not null default 0 check (reward_amount >= 0 and reward_amount <= 100000),
    -- required + validated only when reward_kind = 'boost'
    boost_type      text check (boost_type in ('wildReel', 'diceBomb', 'jackpot', 'extraMoves', 'doubleScore')),
    -- null = unlimited total redemptions; otherwise the global lifetime cap
    max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
    active          boolean not null default true,
    expires_at      timestamptz,
    note            text,             -- free-text label for your own reference ("launch week", "creatorX")
    created_at      timestamptz not null default now(),
    constraint boost_needs_type check (reward_kind <> 'boost' or boost_type is not null)
);

alter table public.promo_codes enable row level security;
-- NO policies → deny-by-default for anon/authenticated. Only the SECURITY DEFINER
-- function below (which runs as the table owner) can read this table, so codes
-- stay secret. Revoke table grants too, belt-and-suspenders.
revoke all on public.promo_codes from anon, authenticated;

-- ==========================================
-- TABLE: public.promo_redemptions — the ledger. One row per (code, user) EVER,
-- so the PK itself enforces once-per-account. Written ONLY by redeem_promo.
-- ==========================================
create table if not exists public.promo_redemptions (
    code          text not null references public.promo_codes(code) on delete cascade,
    user_id       uuid not null references auth.users(id) on delete cascade,
    reward_kind   text not null,
    reward_amount integer not null default 0,
    redeemed_at   timestamptz not null default now(),
    primary key (code, user_id)
);

create index if not exists promo_redemptions_by_code on public.promo_redemptions (code);

alter table public.promo_redemptions enable row level security;
-- Players may READ their own redemption history (for a "already redeemed" UI);
-- writes happen ONLY through the SECURITY DEFINER function (no insert policy).
drop policy if exists "read own redemptions" on public.promo_redemptions;
create policy "read own redemptions"
    on public.promo_redemptions for select using (auth.uid() = user_id);

-- ==========================================
-- FUNCTION: redeem_promo(code) — the ONE atomic entry point. Returns a json
-- result the client can act on:
--   { ok:true,  kind, amount, boost_type }
--   { ok:false, reason:'not_found'|'inactive'|'expired'|'already'|'exhausted'|'signed_out' }
-- Runs as the table owner (security definer) so it can read promo_codes past RLS.
-- ==========================================
create or replace function public.redeem_promo(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid  uuid := auth.uid();
    v_code text := upper(btrim(coalesce(p_code, '')));
    r      public.promo_codes%rowtype;
    v_used integer;
begin
    if v_uid is null then
        return json_build_object('ok', false, 'reason', 'signed_out');
    end if;
    if v_code !~ '^[A-Z0-9]{4,16}$' then
        return json_build_object('ok', false, 'reason', 'not_found');
    end if;

    select * into r from public.promo_codes where code = v_code;
    if not found then
        return json_build_object('ok', false, 'reason', 'not_found');
    end if;
    if not r.active then
        return json_build_object('ok', false, 'reason', 'inactive');
    end if;
    if r.expires_at is not null and r.expires_at < now() then
        return json_build_object('ok', false, 'reason', 'expired');
    end if;
    if exists (select 1 from public.promo_redemptions where code = v_code and user_id = v_uid) then
        return json_build_object('ok', false, 'reason', 'already');
    end if;
    if r.max_redemptions is not null then
        select count(*) into v_used from public.promo_redemptions where code = v_code;
        if v_used >= r.max_redemptions then
            return json_build_object('ok', false, 'reason', 'exhausted');
        end if;
    end if;

    -- Record the redemption; the (code,user_id) PK makes a same-user race a no-op.
    insert into public.promo_redemptions (code, user_id, reward_kind, reward_amount)
        values (v_code, v_uid, r.reward_kind, r.reward_amount)
        on conflict (code, user_id) do nothing;
    if not found then
        return json_build_object('ok', false, 'reason', 'already');
    end if;

    return json_build_object('ok', true, 'kind', r.reward_kind, 'amount', r.reward_amount, 'boost_type', r.boost_type);
end;
$$;

-- Only signed-in players may call it (never anon).
revoke all on function public.redeem_promo(text) from public, anon;
grant execute on function public.redeem_promo(text) to authenticated;

-- ============================================================================
-- MINTING CODES (run from the Supabase SQL editor / dashboard):
--
--   -- 250 chips, once per account, unlimited players:
--   insert into public.promo_codes (code, reward_kind, reward_amount, note)
--   values ('WELCOME250', 'chips', 250, 'launch');
--
--   -- Full hearts refill, first 100 players only:
--   insert into public.promo_codes (code, reward_kind, max_redemptions, note)
--   values ('FULLHEARTS', 'hearts', 100, 'comeback');
--
--   -- A free Jackpot Chip boost, expires in a week:
--   insert into public.promo_codes (code, reward_kind, boost_type, reward_amount, expires_at, note)
--   values ('JACKPOT1', 'boost', 'jackpot', 1, now() + interval '7 days', 'creatorX');
--
--   -- Retire a code early:  update public.promo_codes set active = false where code = 'WELCOME250';
-- ============================================================================

-- ============================================================================
-- 0004_referrals.sql
-- Referral program: invite a friend → they play and test (reach the qualify
-- level) → both sides earn. Two tables + RLS + a guard trigger.
--
-- FLOW: every player mints one short code (referral_codes). The invite link
-- carries ?ref=CODE; the friend's client stashes it, and after Google sign-in
-- inserts its own referrals row (one per account, ever — the PK). When the
-- friend reaches the qualify level the referee's client stamps qualified_at;
-- the referrer's client later finds qualified-unclaimed rows, plays the reward
-- moment, grants chips+lives locally, and stamps claimed_at.
--
-- TRUST MODEL (v1, consistent with the leaderboard): clients self-report, RLS
-- confines every writer to its own lane, the guard trigger makes timestamps
-- set-once and columns immutable, and the schema blocks self-referral and
-- double-referral outright. Real-play qualification + client-side lifetime cap
-- keep farming unprofitable at family/friends scale.
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- ==========================================
-- TABLE: public.referral_codes — one short code per user.
-- ==========================================
create table if not exists public.referral_codes (
    code       text primary key check (code ~ '^[A-Z0-9]{6}$'),
    user_id    uuid unique not null references auth.users(id) on delete cascade,
    created_at timestamptz not null default now()
);

alter table public.referral_codes enable row level security;

-- Anyone may RESOLVE a code (the referee must map code → referrer at signup),
-- but a user may only mint their own, and codes are immutable once minted.
drop policy if exists "Anyone can resolve codes" on public.referral_codes;
create policy "Anyone can resolve codes"
    on public.referral_codes for select using (true);

drop policy if exists "Users mint own code" on public.referral_codes;
create policy "Users mint own code"
    on public.referral_codes for insert with check (auth.uid() = user_id);
-- (no UPDATE/DELETE policies → immutable by deny-by-default)

-- ==========================================
-- TABLE: public.referrals — one row per referred account, EVER (PK = referee).
-- ==========================================
create table if not exists public.referrals (
    referee_user_id  uuid primary key references auth.users(id) on delete cascade,
    referrer_user_id uuid not null references auth.users(id) on delete cascade,
    created_at       timestamptz not null default now(),
    /** Stamped by the REFEREE's client when they reach the qualify level. */
    qualified_at     timestamptz,
    /** Stamped by the REFERRER's client after playing the reward moment. */
    claimed_at       timestamptz,
    constraint no_self_referral check (referee_user_id <> referrer_user_id)
);

create index if not exists referrals_by_referrer
    on public.referrals (referrer_user_id, qualified_at, claimed_at);

alter table public.referrals enable row level security;

-- The referee creates their own (single) row; both parties can read their side.
drop policy if exists "Referee inserts own referral" on public.referrals;
create policy "Referee inserts own referral"
    on public.referrals for insert with check (auth.uid() = referee_user_id);

drop policy if exists "Parties read own referrals" on public.referrals;
create policy "Parties read own referrals"
    on public.referrals for select
    using (auth.uid() = referee_user_id or auth.uid() = referrer_user_id);

-- Updates: referee may stamp qualified_at; referrer may stamp claimed_at (only
-- after qualification). Column-level immutability is enforced by the trigger.
drop policy if exists "Referee qualifies own referral" on public.referrals;
create policy "Referee qualifies own referral"
    on public.referrals for update
    using (auth.uid() = referee_user_id)
    with check (auth.uid() = referee_user_id);

drop policy if exists "Referrer claims qualified referral" on public.referrals;
create policy "Referrer claims qualified referral"
    on public.referrals for update
    using (auth.uid() = referrer_user_id and qualified_at is not null)
    with check (auth.uid() = referrer_user_id);

-- ==========================================
-- TRIGGER: identity columns immutable; timestamps set-once, server-clocked,
-- and ordered (claim requires qualification).
-- ==========================================
create or replace function public.referrals_guard()
returns trigger
language plpgsql
security definer
as $$
begin
    -- Identity + creation are frozen.
    new.referee_user_id := old.referee_user_id;
    new.referrer_user_id := old.referrer_user_id;
    new.created_at := old.created_at;
    -- qualified_at: set-once, server time, never cleared.
    if old.qualified_at is not null then
        new.qualified_at := old.qualified_at;
    elsif new.qualified_at is not null then
        new.qualified_at := now();
    end if;
    -- claimed_at: set-once, server time, only after qualification, never cleared.
    if old.claimed_at is not null then
        new.claimed_at := old.claimed_at;
    elsif new.claimed_at is not null then
        if old.qualified_at is null then
            new.claimed_at := null; -- can't claim an unqualified referral
        else
            new.claimed_at := now();
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists referrals_guard on public.referrals;
create trigger referrals_guard
    before update on public.referrals
    for each row execute function public.referrals_guard();

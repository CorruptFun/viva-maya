-- ============================================================================
-- 0025_paid_entry_and_referral_cash.sql
-- PAID ENTRY ($3.99 once, per new account) + CASH REFERRAL COMMISSIONS.
--
-- This is the first table set in this schema that holds MONEY, and it is
-- therefore the first one that is NOT self-reported. Everything the game has
-- written until now (scores, level progress, referral qualification) follows
-- the trust model in 0002/0006/0007/0012: the client says what happened, RLS
-- confines it to its own lane, and a guard trigger keeps it monotonic. That
-- model is fine for a leaderboard — the worst case is a fake score. It is NOT
-- fine here: the worst case would be a client minting its own entitlement or
-- its own commission, i.e. free product and real money out.
--
-- So the rule for every table below is the same and it is absolute:
--
--   *** NO INSERT / UPDATE / DELETE POLICY EXISTS FOR ANY ROLE. ***
--
-- RLS is enabled and only SELECT policies are granted (own rows only). With no
-- write policy, `anon` and `authenticated` are denied by default — the ONLY
-- writer is `service_role`, which bypasses RLS and is held exclusively by the
-- Edge Functions in supabase/functions/ (never shipped to a client). If you
-- ever find yourself adding a write policy here to make a client feature work,
-- the feature is wrong, not the policy.
--
-- ---------------------------------------------------------------------------
-- THE COMMISSION MODEL (see also src/core/referralcash.ts, which MUST agree)
--
--   A player's DEPTH is how far they sit down the invite chain:
--     depth 0 — arrived organically (no `referrals` row naming them as referee)
--     depth 1 — joined through a depth-0 player's link
--     depth 2 — joined through a depth-1 player's link
--     …
--
--   When a player pays the entry fee, exactly ONE cash commission is written,
--   to their DIRECT referrer, at a rate set by THAT REFERRER's own depth:
--     referrer depth 0 → 169c
--     referrer depth 1 →  69c
--     referrer depth 2+ →  0c  (in-game rewards only — no ledger row is written)
--
--   ⚠️ ONE ENTRY FEE PAYS AT MOST ONE PERSON. This is not a multi-level payout
--   and must never become one: 169c + Stripe's ~42c on a $3.99 charge leaves
--   the house solvent on every single transaction, and that solvency is the
--   property that makes the program safe to run at any scale. A second payout
--   rung stacked on the same fee would break it. The `referee_user_id UNIQUE`
--   constraint on referral_earnings is the hard enforcement — one commission
--   per referred account, ever, no matter how many times the webhook fires.
--
-- ---------------------------------------------------------------------------
-- THE CHARGEBACK HOLE, AND WHAT CLOSES IT
--
--   Cash out of a card charge is reversible in one direction only: the payer
--   can claw the $3.99 back for months, but the $1.69 we already wired to the
--   referrer is gone. Buy with a stolen card → refer yourself through a second
--   account → withdraw → dispute is a complete, profitable attack against a
--   naive version of this table.
--
--   Three things close it, all of them here rather than in the client:
--     1. HOLD. A commission lands `pending` with `available_at = now() + 30d`
--        and only the payout function's own query promotes it. Nothing a
--        client can call moves that date.
--     2. REVERSAL. `charge.refunded` / `charge.dispute.created` flips the
--        commission to `reversed` (and the entitlement to `refunded`). If it
--        was already paid out, the row still flips and the balance goes
--        negative-by-omission — the debt is recorded, see `reversed_at`.
--     3. NO SELF-REFERRAL. Inherited from 0004's check constraint, plus the
--        payment-instrument fingerprint the webhook records below.
--
-- ---------------------------------------------------------------------------
-- TWO-PHASE / CACHED-CLIENT SAFETY
--
--   The PWA is `registerType: 'prompt'`, so players run cached bundles for
--   days (measured: 13 distinct builds live at once on 2026-08-07). Every
--   table here is ADDITIVE and no existing client reads any of it, so applying
--   this migration on its own changes nothing for anyone. The paywall then
--   turns on by DATE (`paywall_active_from()` below and PAYWALL_ACTIVE_FROM in
--   src/core/entitlement.ts — the same switch on two sides of the wire, change
--   one and change both, exactly like the race salt's v_salt_from/SALT_ACTIVE_FROM).
--
--   A stale client that predates the paywall simply lets its player play for
--   free. That is the deliberate failure direction: a locked-out paying
--   customer is a refund and a support ticket; a free play is a rounding error.
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- ==========================================
-- SWITCH: when paid entry begins.
--
-- ⚠️ THE SAME SWITCH AS `PAYWALL_ACTIVE_FROM` in src/core/entitlement.ts.
-- Change one, change both. The server half decides who is GRANDFATHERED (an
-- account that existed before this instant never pays); the client half
-- decides who is SHOWN the paywall. If they disagree, one of two bad things
-- happens: the client bills a grandfathered player (who then can't be charged,
-- because the server hands them an entitlement anyway — confusing but safe),
-- or the client waves through a cohort the server considers billable (free
-- product — safe, but unmeasured).
-- ==========================================
create or replace function public.paywall_active_from()
returns timestamptz
language sql
immutable
as $$
    select timestamptz '2026-09-01 00:00:00+00'
$$;

-- ==========================================
-- TABLE: public.entitlements — may this account play at all.
-- One row per user; written ONLY by the Stripe webhook (service_role).
-- ==========================================
create table if not exists public.entitlements (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    /** paid → bought it · granted → comped by us · grandfathered → predates the paywall
     *  refunded → the charge came back; access is revoked (revoked_at is stamped). */
    status     text not null check (status in ('paid', 'granted', 'grandfathered', 'refunded')),
    /** Where it came from, for support + accounting: 'stripe' | 'comp' | 'grandfather'. */
    source     text not null,
    amount_cents int not null default 0 check (amount_cents >= 0),
    currency   text not null default 'usd',
    /** The Stripe PaymentIntent that bought it. UNIQUE — a replayed webhook cannot
     *  mint a second entitlement, and a second charge for the same account is refundable
     *  evidence rather than a silent double-bill. */
    stripe_payment_intent text unique,
    /** Fingerprint of the card used, from Stripe. Not PII — Stripe's own opaque handle.
     *  Held so a ring of accounts funded by ONE card is visible to the payout query. */
    payment_fingerprint text,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);

create index if not exists entitlements_by_fingerprint
    on public.entitlements (payment_fingerprint)
    where payment_fingerprint is not null;

alter table public.entitlements enable row level security;

-- Own row only, read only. No write policy for any client role — see the header.
drop policy if exists "Users read own entitlement" on public.entitlements;
create policy "Users read own entitlement"
    on public.entitlements for select
    using (auth.uid() = user_id);

-- ==========================================
-- TABLE: public.payout_accounts — the referrer's Stripe Connect (Express) account.
-- Created by connect-onboard, kept current by the webhook's `account.updated`.
-- ==========================================
create table if not exists public.payout_accounts (
    user_id           uuid primary key references auth.users(id) on delete cascade,
    stripe_account_id text unique not null,
    /** Stripe's verdict, mirrored. A transfer is only ever attempted when this is true —
     *  it means identity + bank details cleared Stripe's own KYC. */
    payouts_enabled   boolean not null default false,
    details_submitted boolean not null default false,
    country           text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

alter table public.payout_accounts enable row level security;

drop policy if exists "Users read own payout account" on public.payout_accounts;
create policy "Users read own payout account"
    on public.payout_accounts for select
    using (auth.uid() = user_id);

-- ==========================================
-- TABLE: public.payouts — one row per Stripe transfer out.
-- Created by the payout function; settled by the webhook.
-- ==========================================
create table if not exists public.payouts (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references auth.users(id) on delete cascade,
    amount_cents      int not null check (amount_cents > 0),
    status            text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
    stripe_transfer_id text unique,
    /** Idempotency key handed to Stripe. UNIQUE here as well, so a retried invocation of the
     *  payout function can never create a second transfer for the same batch even if the
     *  Stripe call's response was lost. */
    idempotency_key   text unique not null,
    requested_at      timestamptz not null default now(),
    settled_at        timestamptz,
    failure_reason    text
);

create index if not exists payouts_by_user on public.payouts (user_id, requested_at desc);

alter table public.payouts enable row level security;

drop policy if exists "Users read own payouts" on public.payouts;
create policy "Users read own payouts"
    on public.payouts for select
    using (auth.uid() = user_id);

-- ==========================================
-- TABLE: public.referral_earnings — the commission ledger.
-- One row per REFERRED ACCOUNT, ever. Written only by the Stripe webhook.
-- ==========================================
create table if not exists public.referral_earnings (
    id               uuid primary key default gen_random_uuid(),
    referrer_user_id uuid not null references auth.users(id) on delete cascade,
    /** ⚠️ UNIQUE, and this is the single most important constraint in the file: one
     *  commission per referred account for all time. A replayed webhook, a second
     *  charge, a re-registered referral — none of them can pay the same referrer twice
     *  for the same friend. */
    referee_user_id  uuid not null unique references auth.users(id) on delete cascade,
    /** The REFERRER's depth when the fee was paid (0 or 1 — depth 2+ writes no row at all).
     *  Stored rather than derived on read, because it is what we actually paid: a chain that
     *  is later edited must not retroactively restate a settled commission. */
    tier             smallint not null check (tier >= 0),
    amount_cents     int not null check (amount_cents > 0),
    status           text not null default 'pending'
                     check (status in ('pending', 'available', 'paid', 'reversed')),
    /** The entry payment that funded this commission — the audit link back to the money in. */
    stripe_payment_intent text not null,
    /** The hold. Nothing promotes a row to 'available' before this instant; only the payout
     *  function's own query does it, and no client role can write this table at all. */
    available_at     timestamptz not null,
    payout_id        uuid references public.payouts(id) on delete set null,
    created_at       timestamptz not null default now(),
    reversed_at      timestamptz,
    reversal_reason  text,
    constraint no_self_commission check (referrer_user_id <> referee_user_id)
);

create index if not exists referral_earnings_by_referrer
    on public.referral_earnings (referrer_user_id, status, available_at);

alter table public.referral_earnings enable row level security;

-- A referrer reads their own earnings. The REFEREE deliberately cannot read the row about
-- them: what their friend was paid for inviting them is the friend's business, and exposing
-- it would also expose the referrer's depth (i.e. their position in the chain).
drop policy if exists "Referrer reads own earnings" on public.referral_earnings;
create policy "Referrer reads own earnings"
    on public.referral_earnings for select
    using (auth.uid() = referrer_user_id);

-- ==========================================
-- FUNCTION: public.referral_depth(uuid) — how far down the invite chain a user sits.
--
-- DERIVED, never stored on the user — the same call the trophy badges make
-- (core/trophies.ts chaptersFromCleared): the chain in `referrals` is already
-- immutable (0004's guard freezes referee/referrer/created_at), so a depth
-- column would be a second copy of a fact that cannot change, and the first
-- time the two disagreed the money would follow the wrong one.
--
-- Bounded at MAX_DEPTH hops. The bound is not defensive dressing: `referrals`
-- has no cycle constraint beyond no-self-referral, and while a cycle cannot
-- arise from the normal flow (a referee row is inserted once, at signup, and
-- the referrer must already exist), an unbounded recursive CTE over
-- user-influenced data is exactly the shape that takes a database down. Past
-- the bound we return the bound, which pays 0 — the safe direction.
-- ==========================================
create or replace function public.referral_depth(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
    with recursive chain as (
        select r.referrer_user_id as ancestor, 1 as depth
          from public.referrals r
         where r.referee_user_id = p_user
        union all
        select r.referrer_user_id, c.depth + 1
          from chain c
          join public.referrals r on r.referee_user_id = c.ancestor
         where c.depth < 8
    )
    select coalesce(max(depth), 0) from chain;
$$;

-- ==========================================
-- FUNCTION: public.referral_cash_rate_cents(uuid) — what THIS user earns per paid referral.
--
-- ⚠️ THE SAME TABLE AS `CASH_BY_DEPTH` in src/core/referralcash.ts. The client
-- half only ever DISPLAYS a rate; this half is what actually pays. If they
-- drift, the game promises one number and the ledger writes another — which is
-- the single most damaging class of bug this feature can have, because the
-- player is looking at a dollar figure they were told they earned.
-- referralcash.test.ts pins the client half; this comment is the other end of
-- that string.
-- ==========================================
create or replace function public.referral_cash_rate_cents(p_user uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
    select case public.referral_depth(p_user)
        when 0 then 169
        when 1 then 69
        else 0
    end;
$$;

-- ==========================================
-- FUNCTION: public.my_access() — the one call the game's boot gate makes.
--
-- SECURITY DEFINER because grandfathering reads `auth.users.created_at`, which
-- no client role may select. Returns a verdict, never the chain or anyone
-- else's row.
--
-- Order matters: a live entitlement wins, then the grandfather clause, then
-- the paywall's own start date (before it, everyone plays). A REFUNDED
-- entitlement deliberately does NOT fall through to the grandfather clause —
-- `created_at` would still be old for an account that paid, played and charged
-- back, and letting it re-grant access for free is the whole reason the checks
-- are ordered rather than OR'd.
-- ==========================================
create or replace function public.my_access()
returns table (entitled boolean, reason text, since timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid  uuid := auth.uid();
    v_from timestamptz := public.paywall_active_from();
    v_ent  public.entitlements%rowtype;
    v_created timestamptz;
begin
    if v_uid is null then
        return query select false, 'signed_out'::text, null::timestamptz;
        return;
    end if;

    select * into v_ent from public.entitlements where user_id = v_uid;
    if found then
        if v_ent.status = 'refunded' then
            return query select false, 'refunded'::text, v_ent.revoked_at;
        else
            return query select true, v_ent.status, v_ent.created_at;
        end if;
        return;
    end if;

    select u.created_at into v_created from auth.users u where u.id = v_uid;
    if v_created is not null and v_created < v_from then
        return query select true, 'grandfathered'::text, v_created;
        return;
    end if;

    if now() < v_from then
        return query select true, 'prelaunch'::text, v_from;
        return;
    end if;

    return query select false, 'unpaid'::text, null::timestamptz;
end;
$$;

-- ==========================================
-- FUNCTION: public.my_cash_summary() — the cash-out panel's single read.
--
-- SECURITY DEFINER for the rate alone: `referral_cash_rate_cents` walks the
-- chain ABOVE the caller, and a caller can only read the one `referrals` row
-- naming them as referee — so they can see their own referrer but not their
-- referrer's referrer, and could not compute their own rate client-side
-- without being handed a chain they have no business seeing.
--
-- Balances could technically be aggregated client-side off the SELECT policy,
-- and are folded in here anyway so the panel makes ONE call and can never
-- render a rate from one instant against balances from another.
-- ==========================================
create or replace function public.my_cash_summary()
returns table (
    rate_cents      int,
    depth           int,
    pending_cents   bigint,
    available_cents bigint,
    paid_cents      bigint,
    referral_count  bigint,
    payouts_enabled boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        public.referral_cash_rate_cents(auth.uid()),
        public.referral_depth(auth.uid()),
        coalesce(sum(e.amount_cents) filter (
            where e.status = 'pending' or (e.status = 'available' and e.available_at > now())
        ), 0),
        coalesce(sum(e.amount_cents) filter (
            where e.status in ('pending', 'available') and e.available_at <= now()
        ), 0),
        coalesce(sum(e.amount_cents) filter (where e.status = 'paid'), 0),
        count(*) filter (where e.status <> 'reversed'),
        coalesce(bool_or(a.payouts_enabled), false)
      from public.referral_earnings e
      full outer join public.payout_accounts a on a.user_id = auth.uid()
     where e.referrer_user_id = auth.uid() or e.referrer_user_id is null;
$$;

-- Execute grants. Every function above is SECURITY DEFINER and answers only for
-- `auth.uid()` (or, for the two rate helpers, for a uuid the caller already had),
-- so exposing them to `authenticated` leaks nothing the caller may not see.
grant execute on function public.paywall_active_from() to anon, authenticated;
grant execute on function public.referral_depth(uuid) to authenticated;
grant execute on function public.referral_cash_rate_cents(uuid) to authenticated;
grant execute on function public.my_access() to authenticated;
grant execute on function public.my_cash_summary() to authenticated;

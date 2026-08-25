-- ============================================================================
-- 0027_contact_email_and_recovery.sql
-- Records WHO paid, as Stripe knows them, and lets the client tell whether an
-- account could actually be recovered.
--
-- CONTEXT: paid entry requires a real sign-in BEFORE the price
-- (src/scenes/PaywallScene.ts) — an entitlement has to belong to something that
-- survives a cleared browser, and the honest moment to establish that is before
-- money changes hands rather than after. So by the time a payment lands, the
-- account already has a verified address on it.
--
-- That is exactly why the column below exists. The address Stripe collects at
-- checkout is frequently NOT the one the player signed in with: a card receipt
-- goes to a work address, a partner's address, an old address the browser
-- autofilled. Neither is wrong, and the webhook must not overwrite the sign-in
-- address with the billing one (doing so would silently change the address a
-- player signs in with, and the first they would learn of it is being locked
-- out of a game they paid for). So both are kept, in their own places.
--
-- SAFE TO APPLY NOW: the paywall is dark behind `paywall_active_from()`, so
-- nothing here is reachable by a player until that date moves. The column is
-- nullable and the replaced function only GAINS a return column, which an old
-- cached client reading named fields simply ignores.
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- ==========================================
-- entitlements.contact_email — the address the payer gave STRIPE.
--
-- The support breadcrumb, and the reason it is a separate column rather than a
-- write to auth.users: when somebody writes in about a receipt from an address
-- we have never seen, this is the only thing that connects that receipt to an
-- account. It is also the record of what was actually collected at the point of
-- sale, which is not the same fact as what the account is called.
--
-- ⚠️ NOT PROOF OF ANYTHING. It is whatever was typed into a payment form; nobody
-- has clicked a link to prove they control it. Treat it as a lookup key for a
-- human, never as an authenticated identity — the verified copy lives on
-- auth.users and only a sign-in puts it there.
-- ==========================================
alter table public.entitlements
    add column if not exists contact_email text;

-- Support look-ups are by address ("I paid and I can't get in"), so index it.
-- Partial: the column is null for every comped and grandfathered row.
create index if not exists entitlements_by_contact_email
    on public.entitlements (lower(contact_email))
    where contact_email is not null;

-- ==========================================
-- my_access() — now also reports whether this account can be RECOVERED.
--
-- `recoverable` is true when the auth row carries a CONFIRMED email, which is
-- what the one-time-code flow needs to hand the account back on another device.
-- With sign-in required before purchase this is the normal state, so the field
-- is mostly a health check rather than a branch — and that is precisely what
-- makes it worth having: if it ever starts reporting false at volume, an
-- identity path has broken somewhere and every affected player is one cleared
-- browser away from losing something they paid for.
--
-- It may drive a nudge. It must NEVER become a gate: having taken someone's
-- money, refusing to let them play until they complete an extra identity step
-- would be a wall behind the paywall.
--
-- DROP first — the return signature gains a column, which CREATE OR REPLACE
-- cannot do. The gap is sub-second and the paywall is dark.
-- ==========================================
drop function if exists public.my_access();

create or replace function public.my_access()
returns table (entitled boolean, reason text, since timestamptz, recoverable boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_uid   uuid := auth.uid();
    v_from  timestamptz := public.paywall_active_from();
    v_ent   public.entitlements%rowtype;
    v_user  auth.users%rowtype;
    v_recoverable boolean;
begin
    if v_uid is null then
        return query select false, 'signed_out'::text, null::timestamptz, false;
        return;
    end if;

    select * into v_user from auth.users where id = v_uid;

    -- An UNCONFIRMED address cannot hand the account back, so `email_confirmed_at`
    -- is the test rather than `email` being non-null.
    v_recoverable := v_user.email is not null and v_user.email_confirmed_at is not null;

    select * into v_ent from public.entitlements where user_id = v_uid;
    if found then
        if v_ent.status = 'refunded' then
            return query select false, 'refunded'::text, v_ent.revoked_at, v_recoverable;
        else
            return query select true, v_ent.status, v_ent.created_at, v_recoverable;
        end if;
        return;
    end if;

    -- ⚠️ GRANDFATHERING READS auth.users.created_at, AND THAT IS WEAKER THAN IT
    -- LOOKS. Sign-in was optional for this game's whole life, so a player who has
    -- been here since June and only makes an account when the paywall asks them to
    -- has a created_at of TODAY. This clause therefore only ever ADMITS people; it
    -- can never be relied on to refuse. The client's own pre-cutover
    -- `save.firstPlayDate` is what covers that cohort, and gateVerdict
    -- (core/entitlement.ts) lets an 'unpaid' verdict fall through to it for exactly
    -- this reason — while a 'refunded' verdict still overrides it.
    if v_user.created_at is not null and v_user.created_at < v_from then
        return query select true, 'grandfathered'::text, v_user.created_at, v_recoverable;
        return;
    end if;

    if now() < v_from then
        return query select true, 'prelaunch'::text, v_from, v_recoverable;
        return;
    end if;

    return query select false, 'unpaid'::text, null::timestamptz, v_recoverable;
end;
$$;

grant execute on function public.my_access() to authenticated;

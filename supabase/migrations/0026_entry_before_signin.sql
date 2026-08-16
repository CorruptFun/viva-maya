-- ============================================================================
-- 0026_entry_before_signin.sql
-- PAY FIRST, IDENTIFY SECOND. Reorders the door so a new player meets the price
-- immediately and never meets a sign-in wall in front of it.
--
-- WHAT CHANGED AND WHY
--   0025 shipped the paywall behind Google sign-in, because an entitlement has
--   to attach to something durable. That put two walls in front of a player who
--   has not yet seen a board: "make an account" and then "pay". The account wall
--   is the expensive one — it asks for a commitment before any value has been
--   delivered, and it is the step this game's own funnel already shows most
--   players never take.
--
--   The order is now: pay → we take the email STRIPE ALREADY COLLECTS at
--   checkout → access. The player types an email exactly once, inside a payment
--   form they are already filling in, and never sees a separate sign-up.
--
--   The identity that carries the entitlement is minted silently: the client
--   calls `signInAnonymously()` at the moment UNLOCK is tapped (⚠️ at the TAP,
--   not at page load — an anonymous user is a real `auth.users` row and counts
--   toward the project's monthly actives, so it is minted for purchase INTENT
--   rather than for raw traffic). The webhook then binds the Stripe email onto
--   that row, which is what turns a device-local account into a recoverable one.
--
-- ⚠️ REQUIRES A DASHBOARD CHANGE THAT IS NOT IN THIS FILE.
--   Anonymous sign-ins must be enabled on the hosted project
--   (Authentication → Sign In / Providers → Anonymous sign-ins). `config.toml`
--   sets it for the LOCAL stack only. Without it, `signInAnonymously()` fails,
--   `beginCheckout` refuses, and the paywall is a dead end for every new player
--   — so verify it on the project BEFORE moving the switch date.
--
-- ⚠️ EMAIL RESTORE REQUIRES REAL SMTP.
--   Supabase's built-in sender is throttled to a testing-grade ~2/hour — the
--   very limitation that made this project choose Google OAuth in the first
--   place (docs/CLOUD_SAVE_GOOGLE_SIGNIN.md). The restore-on-a-new-device path
--   sends a one-time code, so a real SMTP provider must be configured or that
--   path silently fails for everyone after the first couple of players an hour.
--
-- SAFE TO APPLY NOW: the paywall is still dark behind `paywall_active_from()`,
-- so nothing here is reachable by a player until that date moves. The added
-- column is nullable and the replaced function only GAINS a return column,
-- which an old cached client reading named fields simply ignores.
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- ==========================================
-- entitlements.contact_email — the address the payer gave Stripe.
--
-- Stored HERE as well as on auth.users because the two can disagree and the
-- disagreement is the interesting case: binding the email onto the auth row
-- fails when that address already belongs to a different account (the same
-- person paying again from a second device without restoring first). When that
-- happens the auth row stays anonymous and this column is the only record of
-- who the payer said they were — i.e. the only way support can reunite them
-- with a purchase they really made. Losing that would turn a recoverable
-- annoyance into a refund.
--
-- ⚠️ NOT PROOF OF ANYTHING. It is whatever was typed into a payment form; no
-- one has clicked a link to prove they control it. Treat it as a support
-- breadcrumb, never as an authenticated identity — the verified copy is the one
-- on auth.users, and only the one-time-code flow puts it there.
-- ==========================================
alter table public.entitlements
    add column if not exists contact_email text;

-- Support look-ups are by address ("I paid and lost my game"), so index it. Partial:
-- the column is null for every comped and grandfathered row.
create index if not exists entitlements_by_contact_email
    on public.entitlements (lower(contact_email))
    where contact_email is not null;

-- ==========================================
-- my_access() — now also reports whether this account can be RECOVERED.
--
-- `recoverable` is false for a player whose entitlement is attached to an
-- anonymous row with no email bound to it. That is a player who is one cleared
-- browser away from losing something they paid for, and the client uses this to
-- put a quiet, non-blocking nudge in front of them. It is deliberately NOT a
-- gate: having taken their money, refusing to let them play until they finish
-- an identity step would be the same wall this migration exists to remove.
--
-- DROP first — the return signature gains a column, which CREATE OR REPLACE
-- cannot do. The gap is sub-second and the paywall is dark; an old cached client
-- reads the columns it knows by name and ignores the new one.
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

    -- Recoverable means: there is a CONFIRMED email on the auth row, so the
    -- one-time-code flow can hand this account back on another device. An
    -- unconfirmed address cannot, which is why `email_confirmed_at` is the test
    -- rather than `email` being non-null.
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

    -- ⚠️ Grandfathering reads auth.users.created_at, and anonymous sign-in makes
    -- that subtler than it was in 0025: a long-standing player who has never had
    -- an account gets an anonymous row minted TODAY, whose created_at proves
    -- nothing about how long they have been playing. This clause therefore only
    -- ever ADMITS people; the client's own pre-cutover `save.firstPlayDate` is
    -- what covers the un-accounted cohort, and gateVerdict now lets an 'unpaid'
    -- verdict fall through to it rather than overriding it. (A 'refunded'
    -- verdict still overrides — see the note in core/entitlement.ts.)
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

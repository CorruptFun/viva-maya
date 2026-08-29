-- ============================================================================
-- 0029_paid_entry.sql
-- PAID ENTRY — the store of who paid the one-time $1.33 lifetime unlock via
-- Stripe Checkout, and which anonymous devices that purchase has been linked
-- to. Backs core/paywall.ts + the `stripe-checkout` / `stripe-webhook` /
-- `entitlement-status` Edge Functions (supabase/functions/).
--
-- WHY TWO TABLES: a purchase belongs to an EMAIL (Stripe's identity — there is
-- no player account system here), a device belongs to a BROWSER INSTALL (the
-- same anonymous id core/analytics.ts mints), and one email can legitimately
-- link many devices ("restore purchase" on a second phone). Folding both into
-- one row would mean either re-inserting the payment record per device (a
-- second insert isn't a second sale — Stripe would only ever send one
-- `checkout.session.completed` per session) or a payment row that gets
-- overwritten when the SAME email restores on a new device, losing the
-- original checkout session id.
--
-- ⚠️ NO SELECT/INSERT/UPDATE POLICY ON EITHER TABLE — deliberately, not an
-- oversight. Every read and write goes through the three Edge Functions using
-- the SERVICE ROLE key, which bypasses RLS entirely. A client-writable
-- entitlement is a client that can grant itself the whole game for free by
-- calling PostgREST directly with a fabricated device_id/email pair; a
-- client-readable one leaks who paid and what email they used. RLS stays
-- enabled (so a future policy added by habit is opt-in, not a silent gap) but
-- carries zero policies, same posture as 0010's events table and 0011's push
-- subscriptions (endpoint secrecy) before it.
--
-- TRUST MODEL, stated plainly because it is a gradient, not a wall (mirrors
-- CLAUDE.md's score-defence framing): this is a $1.33 one-time unlock, not a
-- subscription or a high-value good, so the bar is "keep an honest player's
-- purchase working across devices and stop a client from self-granting it" —
-- not cryptographic proof of payment. The client caches entitlement in
-- localStorage once granted and trusts it from then on; a wiped cache or a
-- new device re-verifies against these tables via `entitlement-status`. See
-- core/paywall.ts's header for the full contract.
--
-- Idempotent-friendly: safe to re-run.
-- Rollback: drop table public.entitlement_devices cascade;
--           drop table public.entitlements cascade;
-- ============================================================================

create table if not exists public.entitlements (
    id                          uuid primary key default gen_random_uuid(),

    -- Stripe's own idempotency key for this purchase — the webhook and the
    -- direct-verify path (`entitlement-status` on the Stripe return trip) can
    -- both race to record the same session; upserting on this column is what
    -- makes that safe rather than a duplicate-charge-looking double row.
    stripe_checkout_session_id text not null unique
                                check (length(stripe_checkout_session_id) between 8 and 255),

    stripe_customer_id         text,

    -- The identity a purchase is attributed to. Stripe Checkout always
    -- collects an email in payment mode, so this is never backfilled null.
    email                       text not null check (length(email) between 3 and 320),

    amount_cents                integer not null check (amount_cents > 0),
    currency                    text not null default 'usd',

    created_at                  timestamptz not null default now()
);

-- `entitlement-status`'s restore-by-email path does a case-insensitive lookup.
create index if not exists entitlements_email on public.entitlements (lower(email));

create table if not exists public.entitlement_devices (
    -- The same anonymous id core/analytics.ts mints (`viva-maya:device`), so a
    -- purchase attribution never introduces a second fingerprint. Primary key:
    -- one device links to exactly one paying email at a time (the most recent
    -- successful checkout or restore on that device wins).
    device_id  uuid primary key,
    email      text not null check (length(email) between 3 and 320),
    linked_at  timestamptz not null default now()
);

create index if not exists entitlement_devices_email on public.entitlement_devices (lower(email));

alter table public.entitlements enable row level security;
alter table public.entitlement_devices enable row level security;

-- No policies — see the header. Every access is the service role from an Edge Function.

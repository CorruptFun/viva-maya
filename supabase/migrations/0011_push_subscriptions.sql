-- ============================================================================
-- 0011_push_subscriptions.sql
-- WEB PUSH — the store of who has opted in to a notification, so the weekly
-- race can actually call players back.
--
-- WHY: the endless race resets Monday 00:00 UTC (core/endless.ts weekKey, made
-- UTC in the 2026-07-26 timezone fix) and NOTHING tells anyone it is happening.
-- The one measured churn so far — a W30 player who never appeared in W31 —
-- churned across exactly that boundary. A reset with no nudge is a reset most
-- players sleep through.
--
-- WHY A SEPARATE TABLE FROM `saves`: a subscription belongs to a BROWSER
-- INSTALL, not to a player. One person with a phone and a laptop has two, and
-- a signed-out player has one with no account at all. Keying on the endpoint
-- (below) is the only key that matches that lifetime.
--
-- ⚠️ NO SELECT POLICY, same as 0010 — a readable subscription table would hand
-- any visitor a list of push endpoints, and a push endpoint is a BEARER
-- CAPABILITY: whoever holds it can send that device notifications. This must
-- never be enumerable. The sender (scripts/send-push.mjs, run from CI) reads it
-- with the service role, which bypasses RLS.
--
-- TRUST MODEL, stated plainly because it is a gradient, not a wall:
--   * SIGNED-IN rows are properly protected — `auth.uid() = user_id` on every
--     write, so nobody can touch another account's subscriptions.
--   * ANONYMOUS rows (user_id is null — the signed-out majority) are protected
--     by ENDPOINT SECRECY only. The write policies below admit any caller who
--     can NAME an existing anonymous row by its endpoint. That is acceptable
--     because the endpoint is a ~200-char unguessable URL minted by the push
--     service, there is no SELECT policy to enumerate it with, and it is
--     already a bearer secret by construction. Worst case for a leaked
--     endpoint is that someone silences that one device — strictly less than
--     what holding the endpoint already lets them do.
--
-- Idempotent-friendly: safe to re-run.
-- Rollback: drop table public.push_subscriptions cascade;
-- ============================================================================

create table if not exists public.push_subscriptions (
    -- The push service URL IS the identity of a subscription — globally unique,
    -- minted by the browser's push service, and re-minted whenever the browser
    -- rotates it. Primary key, so a re-subscribe upserts the same row instead of
    -- accumulating duplicates that would each fire a notification.
    endpoint     text primary key check (
                     endpoint like 'https://%' and length(endpoint) between 20 and 1024
                 ),

    -- The two halves of the Web Push encryption key material, straight from
    -- PushSubscription.toJSON().keys. Opaque base64url here; only the sender
    -- interprets them.
    p256dh       text not null check (length(p256dh) between 16 and 256),
    auth         text not null check (length(auth) between 8 and 128),

    -- Ties the subscription to the same anonymous identity core/analytics.ts
    -- uses, so an opt-in is attributable in the funnel without an account.
    device_id    uuid not null,

    -- Present only for a signed-in player. Load-bearing for the CONTENT, not
    -- just the audience: it is what lets the sender look up this player's row on
    -- the weekly board and say "you're #3, 1,200 off #2" instead of a generic
    -- blast. Null is fully supported — a signed-out player still gets the
    -- impersonal "the week ends soon" version.
    user_id      uuid references auth.users(id) on delete cascade,

    -- Per-category opt-in. One column rather than a preferences blob so the
    -- sender's audience query stays a plain indexed predicate, and so adding a
    -- category later is an additive migration that defaults existing rows to a
    -- sane value instead of rewriting JSON.
    week_race    boolean not null default true,

    -- Delivery bookkeeping, written by the sender (service role).
    -- `failure_count` is how a dead subscription gets retired: push services
    -- return 404/410 for an expired endpoint, and a subscription that keeps
    -- failing must stop being retried or every send drags a growing tail of
    -- corpses. The sender deletes on 404/410 outright and increments here for
    -- soft failures.
    last_sent_at  timestamptz,
    failure_count integer not null default 0 check (failure_count >= 0),

    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- The sender's audience query: everyone opted in to the weekly race who isn't a
-- known corpse. Partial index because that predicate IS the whole query.
create index if not exists push_subscriptions_week_race
    on public.push_subscriptions (user_id)
    where week_race and failure_count < 5;

alter table public.push_subscriptions enable row level security;

-- ==========================================
-- RLS — writes only, per the gradient in the header.
-- ==========================================

drop policy if exists "Anyone can register their own subscription" on public.push_subscriptions;
create policy "Anyone can register their own subscription"
    on public.push_subscriptions
    for insert
    with check (user_id is null or auth.uid() = user_id);

-- UPDATE is needed for the re-subscribe upsert (same endpoint, refreshed keys)
-- and for toggling `week_race` back off.
drop policy if exists "Owners can update their subscription" on public.push_subscriptions;
create policy "Owners can update their subscription"
    on public.push_subscriptions
    for update
    using (user_id is null or auth.uid() = user_id)
    with check (user_id is null or auth.uid() = user_id);

-- Unsubscribing must always be possible, including for a signed-out device.
drop policy if exists "Owners can delete their subscription" on public.push_subscriptions;
create policy "Owners can delete their subscription"
    on public.push_subscriptions
    for delete
    using (user_id is null or auth.uid() = user_id);

-- ==========================================
-- TRIGGER: the client does not get to write delivery bookkeeping.
-- Without this, any client could zero its own failure_count and keep a dead
-- endpoint in the send set forever, or forge last_sent_at.
-- ==========================================
-- ⚠️ SECURITY INVOKER (the default — stated here by omission, deliberately) and
-- NOT `security definer`, which is what the sibling guards in 0007/0010 use.
-- Two reasons, and the first one is a correctness bug that testing caught:
--
--  1. This trigger must know WHICH ROLE is writing, to let the sender record
--     delivery bookkeeping while refusing it to players. Inside a SECURITY
--     DEFINER function `current_user` is the function's OWNER (postgres) for
--     every caller alike, so the role test would be unconditionally false and
--     the sender could never write. Under SECURITY INVOKER `current_user` is
--     the PostgREST role — `service_role` / `authenticated` / `anon` — which is
--     exactly the distinction needed.
--     (The obvious-looking `current_setting('request.jwt.claim.role')` does NOT
--     work either: it reads empty even for the service role on this PostgREST
--     version. Verified against a local stack, not assumed.)
--
--  2. It needs no privilege anyway: it only rewrites NEW and reads no table, so
--     running it elevated would be privilege for nothing.
create or replace function public.push_subscriptions_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if tg_op = 'INSERT' then
        -- A fresh registration always starts clean, whatever the client sent.
        new.failure_count := 0;
        new.last_sent_at := null;
        new.created_at := now();
    else
        -- On UPDATE, preserve the server's own bookkeeping against the client.
        -- The service role bypasses RLS but NOT triggers, so the sender has to
        -- be admitted explicitly or it could never record a failure — which
        -- would leave dead endpoints in the send set forever.
        if current_user is distinct from 'service_role' then
            new.failure_count := old.failure_count;
            new.last_sent_at := old.last_sent_at;
        end if;
        new.created_at := old.created_at;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists push_subscriptions_guard on public.push_subscriptions;
create trigger push_subscriptions_guard
    before insert or update on public.push_subscriptions
    for each row execute function public.push_subscriptions_guard();

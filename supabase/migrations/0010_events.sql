-- ============================================================================
-- 0010_events.sql
-- PRODUCT ANALYTICS — a write-only event log, so the game can finally be
-- measured instead of guessed at.
--
-- WHY THIS EXISTS: before this migration the ONLY telemetry was the two
-- leaderboards, and both require a Google sign-in. On 2026-07-28 that meant 8
-- known accounts against an owner estimate of 10-12 active players — everyone
-- who never signed in was completely invisible, and questions like "how many
-- people opened the game at all", "where do players quit", and "did a referral
-- link ever convert" had no answer at all. Sign-in is optional by design
-- (view/cloudmodal.ts), so ANY table keyed on auth.users can only ever see the
-- minority who opted in. Hence `device_id` below: analytics must work for the
-- signed-out majority or it does not answer the question it was built for.
--
-- ⚠️ NO SELECT POLICY — DELIBERATE, AND THE MOST IMPORTANT LINE IN THIS FILE.
-- RLS denies everything not explicitly allowed, so with only an INSERT policy
-- this table is APPEND-ONLY to every client: a visitor holding the publishable
-- key (i.e. everyone — it ships in the bundle) can write their own events and
-- read NOTHING, not even their own. This is the direct lesson of 0008/0009,
-- where `referral_codes` shipped `for select using (true)` and every invite
-- code plus its owner's auth UUID was dumpable by any visitor. An event log is
-- strictly worse to leak than invite codes: it is a per-device behavioural
-- history. The owner reads it through the SQL editor / service role, which
-- bypasses RLS — no policy needed for that, and none should ever be added here.
--
-- TRUST MODEL: identical in spirit to 0002/0007 — rows are self-reported by an
-- untrusted client, and a modified client can write junk or spam. The guard
-- trigger below bounds the DAMAGE (row size, name shape, no backdating, no
-- impersonating another user) rather than pretending to prevent forgery. What
-- it CANNOT stop is volume: anyone with the publishable key can insert rows,
-- and the free-tier database is 500 MB. `prune_events()` below plus the
-- retention note is the mitigation; if the table is ever seen growing
-- abnormally, the fix is a rate limit or an edge function, not a policy change.
--
-- Idempotent-friendly: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).
-- Rollback: drop table public.events cascade; drop function public.prune_events(integer);
-- ============================================================================

-- ==========================================
-- TABLE: public.events
-- ==========================================
create table if not exists public.events (
    id          bigint generated always as identity primary key,

    -- The anonymous identity. A random UUID minted in localStorage on first run
    -- (core/analytics.ts). NOT tied to auth — this is the whole point of the
    -- table. Survives sign-out, dies with a cache wipe; that inflates new-device
    -- counts slightly and is the accepted cost of storing no fingerprint.
    device_id   uuid not null,

    -- Set only while signed in, and the RLS policy below pins it to the caller's
    -- own auth.uid(). `on delete set null` so a deleted account's rows become
    -- plain anonymous rows rather than cascading away the whole behavioural
    -- history the aggregate numbers are built from.
    user_id     uuid references auth.users(id) on delete set null,

    -- One per app open (core/analytics.ts mints it in memory, never persisted).
    -- Turns a flat event stream into sessions, which is what makes "opened the
    -- game but never started a level" countable.
    session_id  uuid not null,

    -- Canonical names live in core/analytics.ts EVENTS. Deliberately NOT a
    -- Postgres enum or a FK to a lookup table: adding an event would then need a
    -- migration + a deploy in the right order, and under a cached PWA (see
    -- 0008/0009) a client writing an event the server doesn't know yet would
    -- have its inserts rejected until every player updated. A shape check is the
    -- right amount of rigour here.
    name        text not null,

    -- Small, event-specific payload (e.g. {"level": 21, "moves_left": 0}).
    -- Bounded by the guard trigger; see the size note there.
    props       jsonb not null default '{}'::jsonb,

    -- Which build produced the event. Load-bearing for reading any funnel under
    -- a 'prompt'-mode PWA, where players sit on several different bundles at
    -- once — a metric that moves after a deploy is meaningless if you can't tell
    -- which players are actually running the new code.
    app_version text,

    created_at  timestamptz not null default now()
);

-- Recency scans (dashboards nearly always window on time).
create index if not exists events_created_at on public.events (created_at desc);
-- The funnel query: one event name across time.
create index if not exists events_name_created_at on public.events (name, created_at desc);
-- Retention / session cohorts: everything one device ever did, in order.
create index if not exists events_device_created_at on public.events (device_id, created_at desc);

alter table public.events enable row level security;

-- ==========================================
-- RLS: INSERT ONLY. Read access is intentionally absent (see header).
-- ==========================================

-- `user_id is null` is what lets a signed-OUT visitor log at all — without it,
-- anon inserts would fail and the table would have the exact blind spot it was
-- built to remove. `auth.uid() = user_id` stops a signed-in client attributing
-- its events to somebody else's account.
drop policy if exists "Anyone can append their own events" on public.events;
create policy "Anyone can append their own events"
    on public.events
    for insert
    with check (user_id is null or auth.uid() = user_id);

-- ==========================================
-- TRIGGER: bound what an untrusted client can put in a row.
-- ==========================================
create or replace function public.events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- Normalise the name to the shape the client is supposed to send:
    -- lower snake_case, <= 40 chars. Anything else collapses to 'unknown' rather
    -- than being rejected — a bad name must never throw an error back into the
    -- game loop, and a visible 'unknown' bucket is how a client-side typo gets
    -- noticed instead of silently vanishing.
    new.name := lower(left(trim(coalesce(new.name, '')), 40));
    if new.name !~ '^[a-z][a-z0-9_]*$' then
        new.name := 'unknown';
    end if;

    -- Props must be a JSON OBJECT and small. 2 KB is ~10x the largest payload
    -- the client sends and still lets 500 MB hold >200k events. A scalar or an
    -- oversized blob is dropped to '{}' rather than rejected, for the same
    -- never-throw reason as above.
    if jsonb_typeof(new.props) is distinct from 'object'
       or length(new.props::text) > 2048 then
        new.props := '{}'::jsonb;
    end if;

    new.app_version := left(nullif(trim(coalesce(new.app_version, '')), ''), 32);

    -- The client does not get to choose when something happened. Without this a
    -- forged created_at could bend every time-series query on the table.
    new.created_at := now();
    return new;
end;
$$;

drop trigger if exists events_guard on public.events;
create trigger events_guard
    before insert on public.events
    for each row execute function public.events_guard();

-- ==========================================
-- OWNER-FACING ROLLUPS
--
-- ⚠️ `security_invoker = on` is REQUIRED on every view over this table. A
-- Postgres view without it executes as its OWNER, so it would happily hand a
-- caller rows that RLS forbids them — an RLS-protected table re-exposed through
-- an unprotected view is the classic way this leaks, and it would undo the "no
-- SELECT policy" decision above in one line. With security_invoker the caller's
-- own permissions apply, so anon/authenticated get zero rows and the service
-- role (SQL editor) gets everything. The explicit revokes below are belt and
-- braces on top of that.
-- ==========================================

-- Daily actives, split by whether the player has ever signed in. The signed-out
-- column is the number that did not exist before this migration.
create or replace view public.events_daily
with (security_invoker = on) as
select
    date_trunc('day', created_at)::date            as day,
    count(distinct device_id)                      as devices,
    count(distinct device_id) filter (where user_id is not null) as signed_in_devices,
    count(distinct session_id)                     as sessions,
    count(*)                                       as events
from public.events
group by 1
order by 1 desc;

-- THE LEVEL FUNNEL — the query this whole migration was commissioned to answer.
-- On 2026-07-28 three of seven players on the level board sat at exactly 21
-- cleared, which is either a difficulty wall or just one day's progress. Win
-- rate per level distinguishes them: a wall shows as a rate that falls off a
-- cliff at one level and recovers after it.
create or replace view public.events_level_funnel
with (security_invoker = on) as
select
    (props->>'level')::int                                  as level,
    count(*) filter (where name = 'level_start')            as starts,
    count(*) filter (where name = 'level_win')              as wins,
    count(*) filter (where name = 'level_fail')             as fails,
    count(distinct device_id) filter (where name = 'level_start') as devices_reached,
    round(
        100.0 * count(*) filter (where name = 'level_win')
        / nullif(count(*) filter (where name in ('level_win', 'level_fail')), 0)
    , 1)                                                    as win_pct
from public.events
where name in ('level_start', 'level_win', 'level_fail')
  and props ? 'level'
  and jsonb_typeof(props->'level') = 'number'
group by 1
order by 1;

revoke all on public.events_daily from anon, authenticated;
revoke all on public.events_level_funnel from anon, authenticated;

-- ==========================================
-- RETENTION
-- Not scheduled here on purpose: pg_cron has to be enabled per project from the
-- dashboard, and a migration that silently starts deleting production rows on a
-- timer is a bad surprise. Call it by hand, or schedule it once pg_cron is on:
--   select cron.schedule('prune-events','0 4 * * *',$$select public.prune_events(90)$$);
-- ==========================================
create or replace function public.prune_events(keep_days integer default 90)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    removed bigint;
begin
    delete from public.events
     where created_at < now() - make_interval(days => greatest(keep_days, 1));
    get diagnostics removed = row_count;
    return removed;
end;
$$;

-- Housekeeping is the owner's, not the players'.
revoke all on function public.prune_events(integer) from public, anon, authenticated;

-- ============================================================================
-- 0018_event_dedupe_in_guard.sql
-- FIX: the 0015 dedupe path could never work — and would have KILLED ingestion.
--
-- ⚠️ THE ROOT CAUSE, a sibling of the 0012→0016 lesson, on the INSERT side this
-- time: PostgreSQL refuses ANY `INSERT ... ON CONFLICT` against a table whose
-- caller has no SELECT policy — conflict arbitration must be able to SEE
-- existing rows, and an append-only table (0010's deliberate no-SELECT design)
-- denies that. The failure is not "dedupe silently absent": the whole insert
-- errors ("new row violates row-level security policy"), PostgREST answers
-- 403, and a client sending `on_conflict=event_id` (the 0015 client) would
-- have every batch rejected — analytics off, entirely, the moment 0015 landed.
-- Caught by an adversarial re-implementation exercise BEFORE 0015 was applied
-- to production, then reproduced minimally: as `anon`, a plain insert passes
-- and the same insert + `on conflict do nothing` is refused, conflict or not.
--
-- THE FIX keeps every design rule intact: no SELECT policy, clients send PLAIN
-- inserts (no on_conflict, no special Prefer), and the dedupe moves into the
-- guard trigger — which is SECURITY DEFINER precisely so it can check what the
-- caller cannot see. A duplicate event_id returns NULL (row silently skipped),
-- matching the guard's degrade-never-throw contract.
--
-- The 0015 unique index STAYS, as the backstop for the one case the trigger
-- can't order: two concurrent inserts of the same event_id racing past the
-- exists() check. That collision errors the batch (409); the client's
-- schema-fallback then re-sends it id-less, so events survive even that.
-- For a single device re-sending sequentially — the only real duplicate
-- source — the trigger path is the one that runs.
--
-- Apply TOGETHER WITH 0015 (either order relative to each other, both before
-- reading dedupe as working). Idempotent-friendly; safe to re-run.
-- Rollback: re-run 0015's create or replace of events_guard (via 0010's body)
--           — but note the 0015-style client would then 403 again.
-- ============================================================================

create or replace function public.events_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- IDEMPOTENT INGESTION (0018). The client re-sends a batch when a response
    -- is lost, keeping each event's minted id; a resend whose first attempt
    -- landed must insert nothing. definer context is what lets this see the
    -- table the caller can't. Cheap: one probe of the 0015 unique index.
    if new.event_id is not null
       and exists (select 1 from public.events e where e.event_id = new.event_id) then
        return null;
    end if;

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

-- The trigger itself is unchanged (0010) — only the function body moved on.
drop trigger if exists events_guard on public.events;
create trigger events_guard
    before insert on public.events
    for each row execute function public.events_guard();

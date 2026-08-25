-- ============================================================================
-- 0025_push_daily_nudge.sql
-- A SECOND NOTIFICATION CATEGORY — the morning play nudge, alongside the
-- evening race reminder 0011 shipped.
--
-- WHY: the game has exactly one notification and it is about the daily race.
-- That serves the players who already race, which is the audience least in need
-- of being called back, and says nothing at all to the larger group who play
-- levels, hold a streak and never touch the board. It also only ever fires in
-- the EVENING, a few hours before a board closes — the right moment to tell
-- somebody their standing, and the wrong one to invite somebody who has not
-- opened the game in four days to start a session.
--
-- So: `daily_play`, a per-category opt-in for a MORNING nudge that carries the
-- day's HOUSE GIFT (src/core/bonusdrop.ts) and, where the sender can see it, a
-- streak about to break.
--
-- ⚠️ THIS DOES NOT ADD A SECOND NOTIFICATION TO ANYONE'S DAY, AND THAT
-- CONSTRAINT IS THE REASON THE COLUMN DEFAULTS TO TRUE FOR EXISTING ROWS.
-- Everyone who ever opted in did so against a promise printed on the card
-- (src/view/pushoptin.ts): "One nudge before the board closes — and that is the
-- only one you will ever get." Silently enrolling those people into a second
-- daily send would break that promise, and a notification permission is the one
-- thing in this game a player cannot give back twice.
--
-- What the sender does instead is spend ONE notification per device per day on
-- whichever message is worth the most, and it is bounded three ways so that
-- stays true rather than merely intended:
--   1. The two slots have DISJOINT audiences by construction — the morning
--      nudge goes only to devices that did NOT play yesterday, the evening race
--      reminder only to those that did.
--   2. Every send re-checks `last_sent_at` against the current race day and
--      skips anything already written to today, so a manual run, a retried
--      cron or a future third slot cannot stack.
--   3. A device that keeps ignoring the nudge backs off to weekly and then
--      stops (see scripts/send-push.mjs).
-- The volume promise is therefore kept exactly, which is what makes defaulting
-- this on honest rather than convenient. The card's copy is updated in the same
-- change to describe the deal as it now is, and Settings gains a per-category
-- control so anyone can narrow it back to race-only.
--
-- TWO-PHASE (0008/0009): purely additive. The column has a default, so an old
-- cached client that keeps calling the 4-argument register_push_subscription
-- lands a row that is opted in — no client change is required for the audience
-- to exist. `set_push_category` is a NEW function, so a client deployed before
-- this migration is applied gets a 404 from PostgREST and reports the toggle as
-- failed rather than throwing (src/core/push.ts handles that shape).
-- ⚠️ The SENDER is the one thing that is NOT tolerant: `--drop` filters on
-- `daily_play`, and PostgREST answers a filter on a missing column with a 400.
-- That is deliberate — a loud failed workflow run beats a job that silently
-- falls back to blasting the whole `week_race` audience at 9am. APPLY THIS
-- BEFORE MERGING THE WORKFLOW CHANGE (CI never applies migrations; see
-- CLAUDE.md).
--
-- Idempotent-friendly: safe to re-run.
-- Rollback: drop function public.get_push_categories(text);
--           drop function public.set_push_category(text, text, boolean);
--           alter table public.push_subscriptions drop column daily_play;
--           …then RE-APPLY 0016, which is not optional: this migration REPLACES
--           register_push_subscription with a version that writes `daily_play`,
--           and dropping the column leaves that function raising on every call —
--           i.e. nobody can subscribe at all. Verified against a real Postgres:
--           the three statements above succeed and leave exactly that trap.
-- ============================================================================

-- ==========================================
-- THE COLUMN
-- ==========================================
-- One boolean per category rather than a preferences blob, for the reason 0011
-- states on `week_race`: the sender's audience query stays a plain indexed
-- predicate, and adding a category stays an additive migration that defaults
-- existing rows to a sane value instead of rewriting JSON.
alter table public.push_subscriptions
    add column if not exists daily_play boolean not null default true;

comment on column public.push_subscriptions.daily_play is
    'Opted in to the MORNING play nudge (house gift + streak). Distinct from week_race, which is the evening race reminder. Both true is one notification a day, never two — see 0025''s header.';

-- The morning sender's audience query, mirroring 0011's partial index on the
-- evening one. Same predicate shape because it IS the whole query.
create index if not exists push_subscriptions_daily_play
    on public.push_subscriptions (user_id)
    where daily_play and failure_count < 5;

-- ==========================================
-- register_push_subscription — re-enable BOTH categories on re-register
-- ==========================================
-- Replaced rather than added to: same signature, so every cached client keeps
-- working unchanged. The only new line is `daily_play = true` in the conflict
-- branch, and it matters for the same reason `week_race = true` is there —
-- turning notifications back on is the entire point of calling this again after
-- opting out, and a row that came back opted-in to one category and out of the
-- other would leave the player with a switch that says ON and a morning that
-- stays silent.
create or replace function public.register_push_subscription(
    p_endpoint  text,
    p_p256dh    text,
    p_auth      text,
    p_device_id uuid
)
returns void
language plpgsql
security definer
-- REQUIRED on every definer function: an unpinned search_path is hijackable by
-- a caller who puts their own `push_subscriptions` earlier in the path.
set search_path = public, pg_temp
as $$
begin
    insert into public.push_subscriptions (endpoint, p256dh, auth, device_id, user_id, week_race, daily_play)
    values (
        p_endpoint,
        p_p256dh,
        p_auth,
        p_device_id,
        -- Taken from the JWT, NEVER from a parameter. A definer function bypasses
        -- RLS, so accepting a caller-supplied user_id here would let anyone attach
        -- their subscription to somebody else's account and receive that player's
        -- personalised standings.
        auth.uid(),
        true,
        true
    )
    on conflict (endpoint) do update
        set p256dh    = excluded.p256dh,
            auth      = excluded.auth,
            device_id = excluded.device_id,
            user_id   = excluded.user_id,
            -- Re-enabling is the whole point of calling this again after opting out.
            week_race  = true,
            daily_play = true,
            -- A re-register means the browser handed us a live subscription, so any
            -- past delivery failures are stale. Safe here (and NOT client-forgeable)
            -- because the client cannot reach this column except through this function.
            failure_count = 0;
end;
$$;

-- ==========================================
-- set_push_category — the per-category toggle
-- ==========================================
-- A SECURITY DEFINER function for the reason 0016's header spells out at
-- length, and it is worth restating because it will bite again on any other
-- write-only table: PostgreSQL requires a row to be VISIBLE under a SELECT
-- policy before UPDATE can locate it. This table deliberately has NO SELECT
-- POLICY (a push endpoint is a bearer capability and must never be enumerable),
-- so a direct PATCH would return 204 and change nothing — silently, exactly as
-- the unsubscribe bug did. Possession of the endpoint IS the authorization,
-- consistent with the trust model 0011 documents.
--
-- ⚠️ TURNING OFF THE LAST CATEGORY DELETES THE ROW, rather than storing an
-- endpoint that will never be sent to. That is 0016's rule on `unsubscribe_push`
-- applied consistently: "deleting is the honest implementation of off — no row,
-- no send, nothing retained", and public/privacy.html says as much. The client
-- treats a categories-all-off as a full unsubscribe and drops the browser
-- subscription too, so the two halves cannot disagree.
create or replace function public.set_push_category(
    p_endpoint text,
    p_category text,
    p_on       boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_week  boolean;
    v_daily boolean;
begin
    -- Whitelist, not dynamic SQL. The category name arrives from an untrusted
    -- client, and building `set %I = ...` out of it would be an injection point
    -- for the sake of saving four lines.
    if p_category not in ('week_race', 'daily_play') then
        return;
    end if;

    update public.push_subscriptions
       set week_race  = case when p_category = 'week_race'  then p_on else week_race  end,
           daily_play = case when p_category = 'daily_play' then p_on else daily_play end
     where endpoint = p_endpoint
    returning week_race, daily_play into v_week, v_daily;

    -- No row matched: nothing to do, and deliberately no error. A client whose
    -- subscription the push service already rotated away would otherwise get a
    -- failure for asking us to stop sending to an endpoint we are not sending to.
    if not found then
        return;
    end if;

    if not v_week and not v_daily then
        delete from public.push_subscriptions where endpoint = p_endpoint;
    end if;
end;
$$;

-- ==========================================
-- get_push_categories — the READ half, and the reason it is a function
-- ==========================================
-- The Settings screen has to paint two switches, which means the client needs to
-- know which categories its own subscription currently holds. It cannot SELECT
-- them: 0011 grants no SELECT policy, on purpose and permanently.
--
-- ⚠️ The tempting alternative is a localStorage mirror of the two booleans, and
-- it is wrong for the reason this codebase keeps relearning: it is a SECOND
-- definition of a fact the server already owns, and the two drift the first time
-- a row is deleted (a rotated endpoint, a re-register, the last-category delete
-- below) — leaving a switch that says ON over a subscription that no longer
-- exists. One definition, read back from the row that decides.
--
-- Safe to expose because it is not enumerable: it takes the endpoint as an
-- ARGUMENT and returns only that row, so a caller learns nothing they did not
-- already hold. Possession of the endpoint is the authorization, exactly as it
-- is for the two writers above. It returns no endpoint, no keys, no device id
-- and no user id — only the two switches.
create or replace function public.get_push_categories(p_endpoint text)
returns table (week_race boolean, daily_play boolean)
language sql
security definer
set search_path = public, pg_temp
as $$
    select s.week_race, s.daily_play
      from public.push_subscriptions s
     where s.endpoint = p_endpoint;
$$;

-- All three are reachable by signed-out players by design — the signed-out
-- majority holds the majority of subscriptions and must be able to manage them.
-- Authorization is possession of the endpoint, which is unguessable and
-- unenumerable (0011 grants no SELECT).
revoke all on function public.set_push_category(text, text, boolean) from public;
revoke all on function public.get_push_categories(text) from public;
grant execute on function public.set_push_category(text, text, boolean) to anon, authenticated;
grant execute on function public.get_push_categories(text) to anon, authenticated;

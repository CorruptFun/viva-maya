-- ============================================================================
-- 0020_race_day_key_repair.sql
-- Restore `public.race_day_key(timestamptz)` — the function 0013 defines and
-- that production has been CALLING WITHOUT HAVING.
--
-- WHAT WENT WRONG. Migrations on this project are pasted by hand, and 0013 was
-- authored but never applied. 0017 WAS applied (as "0015", before the
-- 2026-07-30 renumbering — its live body still carries that label), and 0017
-- recreates `endless_daily_guard` carrying 0013's anchor forward verbatim. So
-- production ended up with the trigger that calls `public.race_day_key(now())`
-- and no such function.
--
-- THE SYMPTOM, in the Postgres log, on every daily submission:
--     42883  function public.race_day_key(timestamp with time zone) does not exist
-- The guard is BEFORE INSERT OR UPDATE and on INSERT always evaluates the
-- anchor, so EVERY endless_daily_scores insert aborted and the daily board
-- received nothing. No score was destroyed — maybeSubmitEndless only advances
-- `lastSent` on success (core/leaderboard.ts), so the local save stayed
-- authoritative and each later push retried — but the board stayed frozen for
-- as long as the function was missing, which is not a state that self-heals.
--
-- WHY THIS IS NOT "JUST APPLY 0013". 0013 also runs
-- `create or replace function public.endless_daily_guard()` with its OWN,
-- PRE-0017 body. Replaying it against today's production would silently revert
-- two things that are live and load-bearing:
--   · the `public_display_name()` call that stops a display name from ever
--     being the account's own email name (0017);
--   · the `if tg_op = 'INSERT' or new.day_key <> old.day_key` narrowing, so a
--     rename-only UPDATE is not judged on a day it never claimed (0017).
-- 0013 is therefore recorded as APPLIED in the migration history — its guard
-- half genuinely is, superseded by 0017 — and this migration supplies the one
-- object that half left behind. Nothing here touches the trigger.
--
-- The function body is byte-for-byte 0013's, and the self-check below is
-- 0013's, carried over unchanged: it is the whole reason a wrong anchor cannot
-- reach production quietly, and a repair migration is exactly when you want it.
--
-- Idempotent-friendly: safe to re-run (CREATE OR REPLACE, and the self-check
-- only reads).
-- ============================================================================

-- ==========================================
-- FUNCTION: public.race_day_key(timestamptz) -> 'YYYY-MM-DD'
-- The server's copy of core/endless.ts `dayKey` (RACE_TZ = 'America/Edmonton').
-- MUST stay identical in format and semantics — same discipline as 0006/0012:
-- the explicit zone pins the conversion so no session TimeZone setting can move
-- the answer. Same volatility declaration as utc_day_key in 0012.
-- ==========================================
create or replace function public.race_day_key(ts timestamptz)
returns text
language sql
immutable
as $$
    select to_char(ts at time zone 'America/Edmonton', 'YYYY-MM-DD');
$$;

-- ==========================================
-- SELF-CHECK — this migration REFUSES TO APPLY if the server's idea of the
-- race day disagrees with the game client's (the instants below mirror
-- src/core/endless.test.ts), or if the server's tzdata lacks the zone, or if
-- a session TimeZone can bend the answer. Same reasoning as 0006/0012/0013: a
-- drifted boundary silently empties the board by rejecting honest scores.
-- ==========================================
do $$
declare
    day_cases constant text[][] := array[
        -- [instant (UTC), expected race-day key]
        ['2026-07-30T05:59:59Z', '2026-07-29'],  -- 23:59:59 MDT — last second of the 29th's board
        ['2026-07-30T06:00:00Z', '2026-07-30'],  -- midnight MDT — the rollover, exactly
        ['2026-01-15T06:59:59Z', '2026-01-14'],  -- 23:59:59 MST — the winter offset
        ['2026-01-15T07:00:00Z', '2026-01-15'],  -- midnight MST
        ['2026-03-08T07:00:00Z', '2026-03-08'],  -- spring-forward day opens (a 23-hour board)…
        ['2026-03-09T05:59:59Z', '2026-03-08'],  -- …and holds to 23:59:59 MDT
        ['2026-11-01T06:00:00Z', '2026-11-01'],  -- fall-back day opens (a 25-hour board)…
        ['2026-11-02T06:59:59Z', '2026-11-01'],  -- …and holds to 23:59:59 MST
        ['2026-01-01T06:59:59Z', '2025-12-31'],  -- the year turns at MOUNTAIN midnight
        ['2026-03-01T06:59:59Z', '2026-02-28']   -- month seam, non-leap February
    ];
    i        int;
    got      text;
    expected text;
begin
    for i in 1 .. array_length(day_cases, 1) loop
        expected := day_cases[i][2];
        got := public.race_day_key(day_cases[i][1]::timestamptz);
        if got <> expected then
            raise exception
                'race_day_key(%) returned % but the game client computes % — the server and client disagree about which race day it is; DO NOT deploy this guard until they match',
                day_cases[i][1], got, expected;
        end if;
        if got !~ '^\d{4}-\d{2}-\d{2}$' then
            raise exception
                'race_day_key(%) returned %, which violates the day_key CHECK constraint',
                day_cases[i][1], got;
        end if;
    end loop;

    -- The risk a named zone reintroduces: a session TimeZone quietly shifting
    -- the answer. `at time zone 'America/Edmonton'` must pin it regardless of
    -- what the connection says — same probe as 0012/0013, at the new boundary.
    set local timezone = 'Pacific/Kiritimati';  -- UTC+14, the furthest ahead on earth
    if public.race_day_key('2026-07-30T05:59:59Z'::timestamptz) <> '2026-07-29' then
        raise exception 'race_day_key is sensitive to the session timezone — it must be pinned to America/Edmonton';
    end if;
    set local timezone = 'Pacific/Niue';        -- UTC-11, the furthest behind
    if public.race_day_key('2026-07-30T06:00:00Z'::timestamptz) <> '2026-07-30' then
        raise exception 'race_day_key is sensitive to the session timezone — it must be pinned to America/Edmonton';
    end if;

    -- The rollup is untouched by design; assert it anyway so a future edit that
    -- couples it to the anchor cannot ride in on this migration unnoticed.
    if public.iso_week_of_day('2026-08-02') <> '2026-W31'
       or public.iso_week_of_day('2026-08-03') <> '2026-W32' then
        raise exception 'iso_week_of_day changed behaviour — the weekly totals would roll up the wrong days';
    end if;

    raise notice 'race_day_key agrees with the game client across all checked instants, both DST seams, and hostile session timezones.';
end;
$$;

-- ==========================================
-- REPAIR ASSERTION — the point of this migration is that the LIVE guard can
-- now resolve its anchor. Prove it here rather than discovering it in the log
-- on the next player's run: this is the exact call that was throwing 42883.
-- ==========================================
do $$
begin
    perform public.race_day_key(now());
    perform public.race_day_key(now() - interval '1 hour');
    raise notice 'endless_daily_guard can resolve race_day_key — daily submissions will land again.';
end;
$$;

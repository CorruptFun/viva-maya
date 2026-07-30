-- ============================================================================
-- 0013_race_day_mountain_time.sql
-- The race day moves from UTC midnight to MIDNIGHT AMERICA/EDMONTON (Mountain).
--
-- WHY. The boards were flipping at 00:00 UTC — 6 PM on the home crowd's clock.
-- The game says "at midnight the board closes and crowns a winner", and on
-- 2026-07-30 the owner looked up at 11 PM and found the countdown reading
-- NINETEEN HOURS: the board had already turned over at dinner time, the
-- winner had already been decided, and the reset the players were promised at
-- midnight was nowhere in sight. Midnight has to mean midnight to the people
-- actually racing.
--
-- WHAT DID NOT CHANGE. The anchor is still ONE FIXED ZONE for every player on
-- earth — this is NOT per-device local time (the 2026-07-26 lesson stands: a
-- device-local day key splits the race into per-timezone boards). One instant
-- still maps to one board worldwide; a racer elsewhere just sees the handover
-- at a different wall-clock hour, exactly as the whole world once saw it at
-- 00:00 UTC. Day keys are still 'YYYY-MM-DD', so every existing row keeps its
-- meaning, and the day→week rollup (iso_week_of_day, the weekly view, its
-- expression index) is pure calendar math on the key and is untouched.
--
-- DST, HANDLED BY NAME. 'America/Edmonton' is an IANA zone, so `at time zone`
-- applies MST (−7) and MDT (−6) per instant. Mountain time switches at 02:00
-- local — never at midnight — so every race day still opens exactly once: one
-- 23-hour board each March, one 25-hour board each November, the same board
-- for everyone either way.
--
-- DEPLOY ORDER: APPLY THIS BEFORE SHIPPING THE CLIENT. The guard below defines
-- which day_key the server accepts. A NEW client against the OLD guard has its
-- evening scores rejected for up to six hours a day (Mountain lags UTC, and
-- the old guard's one-hour grace does not reach back that far). An OLD client
-- against THIS guard is rejected only in the 00:00Z–06:00Z window where the
-- UTC date has run ahead of the Mountain date — and rejection is already safe
-- and self-healing: core/leaderboard.ts swallows the error, keeps the save
-- authoritative, and retries on the next cloud push, which lands once the race
-- day catches up. Nobody's score is lost in either direction; PWA clients may
-- update lazily.
--
-- AT THE MOMENT OF CUTOVER the current race-day key either stays what it was
-- (deploys between 06:00Z and 24:00Z — today's board simply runs to midnight
-- Mountain instead of 6 PM) or steps back to yesterday's key (deploys between
-- 00:00Z and 06:00Z — the board that "closed" at 6 PM reopens for the rest of
-- the true evening). A board gets a few extra hours exactly once; none is ever
-- skipped, and the monotonic trigger makes resubmission harmless.
--
-- `public.utc_day_key()` stays defined: 0012's self-check consumed it at apply
-- time and nothing at runtime calls it any more. Dropping it would only make
-- this migration harder to re-run.
--
-- Idempotent-friendly: safe to re-run (CREATE OR REPLACE throughout).
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
-- TRIGGER FUNCTION: public.endless_daily_guard — re-anchored, otherwise
-- byte-for-byte the 0012 guard. Every guarantee carries forward:
--   · the SERVER decides which board a score belongs to, not the submitter's
--     clock (day key = board seed, so a bent clock opens tomorrow's board
--     early or re-opens a memorised one);
--   · score is MONOTONIC per (user, day);
--   · scored_at moves only when the score genuinely rises (the tiebreak);
--   · display_name trimmed + capped server-side; updated_at is server time.
-- GRACE: a run that starts before midnight Mountain and syncs after it is
-- honest, so the previous day is accepted for one hour past the boundary —
-- "the race day of now() or of now() - 1 hour", which needs no extra constant
-- and self-closes. Rejection stays safe client-side (maybeSubmitEndless
-- swallows it and retries on a later push).
-- The trigger object itself (endless_daily_guard ON endless_daily_scores)
-- already points at this function name; replacing the body is the whole swap.
-- ==========================================
create or replace function public.endless_daily_guard()
returns trigger
language plpgsql
security definer
as $$
begin
    if new.day_key <> public.race_day_key(now())
       and new.day_key <> public.race_day_key(now() - interval '1 hour') then
        raise exception
            'endless_daily_scores: day_key % is not the current race day (server race day is %)',
            new.day_key, public.race_day_key(now())
            using errcode = 'check_violation';
    end if;

    if tg_op = 'UPDATE' then
        if new.score > old.score then
            new.scored_at := now();
        else
            new.score := old.score;         -- monotonic: an update can never lower it
            new.scored_at := old.scored_at; -- and a no-rise update can't touch the tiebreak
        end if;
    else
        new.scored_at := now();
    end if;

    new.display_name := left(coalesce(nullif(trim(new.display_name), ''), 'player'), 24);
    new.updated_at := now();
    return new;
end;
$$;

-- ==========================================
-- SELF-CHECK — this migration REFUSES TO APPLY if the server's idea of the
-- race day disagrees with the game client's (the instants below mirror
-- src/core/endless.test.ts), or if the server's tzdata lacks the zone, or if
-- a session TimeZone can bend the answer. Same reasoning as 0006/0012: a
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
    -- what the connection says — same probe as 0012, at the new boundary.
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

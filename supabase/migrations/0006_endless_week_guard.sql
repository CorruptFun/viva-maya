-- ============================================================================
-- 0006_endless_week_guard.sql
-- Make the server, not the client's clock, decide which week a score belongs to.
--
-- WHY: `week_key` was whatever the client sent. Two holes fell out of that.
--
--   1. CLOCK TAMPERING. The week key seeds the board (core/endless.ts
--      seedForWeek), so setting a device clock forward opened a future week's
--      board early — play it at leisure, then arrive on that week with a score
--      nobody else had time to chase. Setting it back re-opened a board whose
--      layout was already known.
--
--   2. BACKFILLING A CLOSED WEEK — the quieter one. The champion is read as
--      "top score of the week that just closed" (0003), so a client submitting
--      an old `week_key` could drop a score into a finished week and take a
--      crown that had already been awarded. This needed no tampering at all: a
--      player who ran the race and only synced days later would do it by
--      accident.
--
-- The client half of this shipped in 2e90fb4 (weekKey is now UTC, so every
-- player agrees which week it is). This is the other half: the database now
-- refuses to file a score under any week but the current one.
--
-- GRACE: a run that starts before the rollover and syncs after it is honest, so
-- the previous week is accepted for one hour past the boundary. Expressed as
-- "the ISO week of now() or of now() - 1 hour", which needs no extra constant
-- and self-closes.
--
-- Rejection is safe client-side: core/leaderboard.ts `maybeSubmitEndless`
-- swallows the error and simply doesn't memo the send, so a stale submit is a
-- no-op rather than a crash, and the next genuine run overwrites the stale key.
--
-- STILL OPEN, deliberately: the SCORE itself is self-reported, so a modified
-- client can inflate its own number. That is a different control (server-side
-- deterministic replay — submit the move list, replay the seeded board) and is
-- sketched in Supabase_Architecture.md. This migration closes WHEN a score can
-- be filed, not WHAT it says.
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- ==========================================
-- FUNCTION: public.iso_week_key(timestamptz) -> 'YYYY-Www'
-- The server's own copy of core/endless.ts `weekKey`. MUST stay byte-identical
-- in format and semantics: ISO-8601, Thursday-anchored, weeks start Monday, in
-- UTC. Postgres 'IYYY' is the ISO year and 'IW' the zero-padded ISO week, which
-- is exactly the shape the week_key CHECK constraint enforces.
-- Immutable: `at time zone 'utc'` pins the conversion, so no session TimeZone
-- setting can move the answer.
-- ==========================================
create or replace function public.iso_week_key(ts timestamptz)
returns text
language sql
immutable
as $$
    select to_char(ts at time zone 'utc', 'IYYY-"W"IW');
$$;

-- ==========================================
-- TRIGGER: endless_scores_guard
-- Recreated whole (the house pattern — 0003 did the same), carrying forward
-- every earlier behaviour so nothing is lost:
--   · 0002 — score is MONOTONIC per (user, week); display_name trimmed/capped;
--            updated_at is server time.
--   · 0003 — scored_at moves ONLY when the score genuinely rises, so the
--            champion tiebreak survives cosmetic edits.
--   · 0006 — NEW: week_key must be the current UTC race week (or the one that
--            closed within the last hour).
-- The week check runs FIRST: a row filed under the wrong week should be refused
-- outright, not sanitized into acceptability.
-- ==========================================
create or replace function public.endless_scores_guard()
returns trigger
language plpgsql
security definer
as $$
begin
    -- 0006: the server decides the week, not the submitter's clock.
    if new.week_key <> public.iso_week_key(now())
       and new.week_key <> public.iso_week_key(now() - interval '1 hour') then
        raise exception
            'endless_scores: week_key % is not the current race week (server week is %)',
            new.week_key, public.iso_week_key(now())
            using errcode = 'check_violation';
    end if;

    -- 0003: monotonic score + a tiebreak stamp that only moves on a real rise.
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

    -- 0002: sanitize the one free-text field; server time is the only time.
    new.display_name := left(coalesce(nullif(trim(new.display_name), ''), 'player'), 24);
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists endless_scores_guard on public.endless_scores;
create trigger endless_scores_guard
    before insert or update on public.endless_scores
    for each row execute function public.endless_scores_guard();

-- ==========================================
-- SELF-CHECK — this migration REFUSES TO APPLY if the server's idea of an ISO
-- week ever disagrees with the client's.
--
-- The whole guard rests on public.iso_week_key() returning exactly what
-- core/endless.ts weekKey() returns. If those two drift by even one day, the
-- database starts rejecting every honest score for a week and the leaderboard
-- silently goes empty — a far worse failure than the tampering being closed.
-- So instead of trusting that Postgres 'IYYY-"W"IW' matches, prove it here,
-- against the SAME table of instants asserted in src/core/endless.test.ts.
-- ==========================================
do $$
declare
    cases constant text[][] := array[
        -- [instant (UTC), expected key] — mirrors src/core/endless.test.ts
        ['2026-07-20T00:00:00Z', '2026-W30'],  -- Monday, the moment W30 opens
        ['2026-07-26T23:59:59Z', '2026-W30'],  -- last second of the week
        ['2026-07-27T00:00:00Z', '2026-W31'],  -- the rollover, exactly
        ['2025-12-29T00:00:00Z', '2026-W01'],  -- ISO year seam: W01 starts in December
        ['2026-01-04T23:59:59Z', '2026-W01'],
        ['2026-01-05T00:00:00Z', '2026-W02']
    ];
    i        int;
    got      text;
    expected text;
begin
    for i in 1 .. array_length(cases, 1) loop
        expected := cases[i][2];
        got := public.iso_week_key(cases[i][1]::timestamptz);
        if got <> expected then
            raise exception
                'iso_week_key(%) returned % but the game client computes % — the server and client disagree about which week it is; DO NOT deploy this guard until they match',
                cases[i][1], got, expected;
        end if;
        if got !~ '^\d{4}-W\d{2}$' then
            raise exception
                'iso_week_key(%) returned %, which violates the week_key CHECK constraint',
                cases[i][1], got;
        end if;
    end loop;

    -- The real risk this guards: a session TimeZone quietly shifting the answer.
    -- The client is UTC, so the server must be too, whatever the connection says.
    set local timezone = 'Pacific/Kiritimati';  -- UTC+14, the furthest ahead on earth
    if public.iso_week_key('2026-07-26T23:59:59Z'::timestamptz) <> '2026-W30' then
        raise exception 'iso_week_key is sensitive to the session timezone — it must be pinned to UTC';
    end if;
    set local timezone = 'Pacific/Niue';        -- UTC-11, the furthest behind
    if public.iso_week_key('2026-07-27T00:00:00Z'::timestamptz) <> '2026-W31' then
        raise exception 'iso_week_key is sensitive to the session timezone — it must be pinned to UTC';
    end if;

    raise notice 'iso_week_key agrees with the game client across all checked instants and timezones.';
end;
$$;

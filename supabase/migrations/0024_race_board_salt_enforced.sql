-- ============================================================================
-- 0024_race_board_salt_enforced.sql
-- PHASE 2 of 2 (phase 1 is 0023). Makes the board salt MANDATORY: from
-- SALT_ACTIVE_FROM onward a score must carry the salt of the board that day
-- actually dealt, or it is refused.
--
-- ── APPLY ON OR AFTER THE ACTIVATION DATE BELOW ────────────────────────────
-- `v_salt_from` MIRRORS `SALT_ACTIVE_FROM` in src/core/endless.ts. Change one,
-- change both — they are the same switch on two sides of the wire, and a
-- disagreement between them is the one way this mechanism fails silently.
--
-- Applying this BEFORE the activation date is harmless: every day before it
-- skips the check entirely. Applying it after leaves a window in which a stale
-- client can post an old-board score into the same partition as everyone
-- racing the real one — corruption that looks exactly like normal results.
--
-- THE COST, SPELLED OUT. This is a prompt-mode PWA, so players keep a cached
-- bundle until they accept an update. From the activation date, any client
-- older than the salt-aware build sends no board_salt and is REJECTED. The
-- client swallows submit errors (core/leaderboard.ts `maybeSubmitEndless` only
-- memoises on success), so such a player sees no error — their score simply
-- never appears. That is the deliberate, safe side of the fork.
--
-- ── TWO CORRECTNESS FIXES OVER THE FIRST DRAFT ─────────────────────────────
--  1. THE CHECK RUNS ON SCORE RISES, NOT JUST INSERTS. `maybeSubmitEndless`
--     UPSERTs, so only a player's FIRST submission of a day is an INSERT —
--     every improvement after that is an UPDATE. Gating the salt check on
--     `tg_op = 'INSERT'` (the shape the day check uses) therefore verified the
--     first score of the day and waved through every one that beat it, which
--     is exactly backwards: the big score is the last one. It now fires on any
--     UPDATE that RAISES the score. A rename still claims no board and is
--     still exempt, which is what the day check's narrowing was protecting.
--
--  2. THE DAY IS SALTED BY DATE, NOT BY WHETHER A ROW EXISTS. Reading
--     `race_day_salts` directly meant a day only became enforceable once
--     someone had fetched its salt — so the FIRST submitter of a day, before
--     any modern client had loaded, hit `v_salt is null` and was accepted on
--     the unsalted board. Every later (salted) score then joined it, and the
--     board silently mixed two layouts. Calling `race_salt()` instead mints on
--     demand, so the day's identity exists the instant it is needed and does
--     not depend on who turned up first. The submitter gains nothing by
--     triggering the mint: the salt is server-generated randomness they cannot
--     predict, so causing it to exist only guarantees their own rejection.
--
-- Release with:  sb unhold 0024
--
-- ROLLBACK: re-run 0017's body of `endless_daily_guard` (this file is that
-- definition plus the salt block).
-- ============================================================================

create or replace function public.endless_daily_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    -- MIRRORS src/core/endless.ts SALT_ACTIVE_FROM. See the header.
    v_salt_from constant text := '2026-08-04';
    v_salt text;
begin
    -- 0012/0013 + 0017: judge the day only when the submitter is actually choosing one. An UPDATE
    -- that leaves day_key alone (a rename) makes no claim about the day and must not be judged on it.
    if tg_op = 'INSERT' or new.day_key <> old.day_key then
        if new.day_key <> public.race_day_key(now())
           and new.day_key <> public.race_day_key(now() - interval '1 hour') then
            raise exception
                'endless_daily_scores: day_key % is not the current race day (server race day is %)',
                new.day_key, public.race_day_key(now())
                using errcode = 'check_violation';
        end if;
    end if;

    -- 0024: ...and any real score claim must come from the board that day dealt. INSERT or a rise —
    -- see fix (1) in the header for why "INSERT only" verified precisely the wrong submission.
    if (tg_op = 'INSERT' or new.score > old.score) and new.day_key >= v_salt_from then
        v_salt := public.race_salt(new.day_key);
        if new.board_salt is distinct from v_salt then
            raise exception
                'endless_daily_scores: score for % was not played on that day''s board', new.day_key
                using errcode = 'check_violation';
        end if;
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
    -- 0017: ...and it may never be this account's email name. AFTER the trim/cap, so the comparison
    -- sees exactly what would otherwise be stored.
    new.display_name := public.public_display_name(new.user_id, new.display_name);
    new.updated_at := now();
    return new;
end;
$$;

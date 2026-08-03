-- ============================================================================
-- 0024_race_board_salt_enforced.sql
--
--   ⚠️  DO NOT APPLY UNTIL THE SALT-AWARE CLIENT HAS REACHED PLAYERS.  ⚠️
--
-- PHASE 2 of 2 (phase 1 is 0023). This migration makes the board salt
-- MANDATORY: once a day has a salt, a score for that day must carry the
-- matching one or it is refused.
--
-- THE CONSEQUENCE, SPELLED OUT. This game is an installed PWA using
-- vite-plugin-pwa in PROMPT mode, so a player keeps running the bundle they
-- have cached until they accept an update toast. A green deploy is not "players
-- are on it". Every client older than the salt-aware build sends no board_salt,
-- so from the moment this is applied those clients' scores are REJECTED. The
-- client swallows submit errors by design (core/leaderboard.ts
-- `maybeSubmitEndless` only memoises on success), so the player sees no error —
-- their score simply never appears on the board.
--
-- That is the deliberate trade, and it is the safe side of the fork. The
-- alternative is worse and silent in the other direction: a stale client
-- generates the UNSALTED board, plays a completely different layout, and posts
-- into the same day partition as everyone racing the real one. A leaderboard
-- mixing two different boards is corruption that looks exactly like normal
-- results, and there is nothing on screen — for the player or the owner — that
-- would ever reveal it.
--
-- BEFORE APPLYING, CHECK ALL THREE:
--   1. The client carrying `SALT_ACTIVE_FROM` (src/core/endless.ts) is
--      deployed, and that date has arrived or is imminent.
--   2. Analytics show app_open traffic on the new build — compare the live
--      bundle hash against what clients actually load; a deploy is not adoption.
--   3. Ideally apply on the activation day itself. Applied EARLY it rejects
--      honest scores on days that are not salted yet; applied LATE it leaves
--      the mixed-board window open. The `v_salt is not null` guard below makes
--      early application harmless for unsalted days, so erring early is the
--      cheaper mistake.
--
-- Release with:  sb unhold 0024
--
-- ROLLBACK: re-run 0017's body of `endless_daily_guard` (it is the definition
-- this file extends — everything below the salt block is carried forward from
-- it verbatim).
-- ============================================================================

create or replace function public.endless_daily_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
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

        -- 0024: ...and it must be a score from the board that day actually dealt.
        --
        -- Read directly from the table rather than through `race_salt()`: that function MINTS on
        -- miss, and a guard that created the day's salt as a side effect of the first submission
        -- would hand the board's identity to whoever posted first. If no salt exists the day was
        -- never salted, and the score is accepted exactly as it was before this migration — which
        -- is what makes applying this early harmless rather than destructive.
        select salt into v_salt from public.race_day_salts where day_key = new.day_key;

        if v_salt is not null and new.board_salt is distinct from v_salt then
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

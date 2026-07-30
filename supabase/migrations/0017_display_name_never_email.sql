-- ============================================================================
-- 0017_display_name_never_email.sql
--
-- ⚠️ ALREADY APPLIED TO PRODUCTION, on 2026-07-30, while this file was still
-- numbered 0015 — it was pasted into the SQL editor by hand, as everything on
-- this project is, so `schema_migrations` holds no record of it under EITHER
-- number. It was renumbered to 0017 the same day because a parallel session
-- pushed its own `0015_analytics_hardening.sql`, and `version` is the PRIMARY
-- KEY of `supabase_migrations.schema_migrations` — a duplicate prefix aborts
-- `supabase db reset` and `sb push` outright. THIS file moved rather than that
-- one because that one is referenced ~20 times across docs, workflows, scripts
-- and source comments, while this one was referenced only by its own tests.
-- Do NOT re-run this against production expecting it to be new; it is idempotent
-- (see the bottom of this header), so a re-run is survivable, not necessary.
--
-- A leaderboard display_name may NEVER be the account's own email name.
--
-- WHAT WENT WRONG. Every public board carries a self-reported display_name, and
-- the client's fallback for a player who had never opened the race-name picker
-- was the email LOCAL-PART (core/leaderboard.ts preferredName). For a Google
-- account that is very often a real name — 'jane.doe' — so every player who had
-- not found the picker was publishing one to a world-readable table. A player
-- reported it: he was re-entering his name repeatedly and seeing his email name
-- come back whenever he didn't.
--
-- The client no longer does this: the fallback is now the anonymous
-- anon_display_name() below, derived from the user id (already on every row, so
-- it discloses nothing new). This migration exists because THAT IS NOT ENOUGH:
--
--   1. STALE CLIENTS. The PWA uses registerType 'prompt', so players stay on a
--      cached bundle until they accept an update. Every un-updated device keeps
--      submitting its email name for as long as it takes to update — a green
--      deploy is not "players are on it". Only the server can refuse it.
--   2. HISTORY. Rows already published keep their name until their owner next
--      submits, which for a closed day is never — and see the RENAME BUG below,
--      which means a rename could not reach them even then.
--
-- HOW. public_display_name() compares a submitted name against the submitting
-- account's own email local-part and substitutes the anonymous name on a match.
-- It is exact, not a heuristic: the server reads auth.users for THAT user, so it
-- needs no guess about what "looks like" an email name and touches no other
-- account. All three guards call it after their existing trim/cap, and the
-- backfill at the bottom applies the same rule to every existing row.
--
-- Deliberate trade-off: a player who *chose* their own email local-part as a
-- handle gets the anonymous name instead. That is the privacy-preserving answer
-- and the requirement here is absolute, so it is the right way to be wrong.
--
-- ALSO FIXED — THE RENAME BUG, found while writing this and the reason the
-- report said the name "keeps coming back". BOTH race guards checked the board
-- partition on EVERY write, including an UPDATE that only touches display_name:
--
--   · 0006's endless_scores_guard raises unless week_key is the current week;
--   · 0012/0013's endless_daily_guard raises unless day_key is the current race
--     day (one hour of grace).
--
-- So renaming has never been able to reach anything but today. core/leaderboard.ts's
-- renameEverywhere() promises a name can be scrubbed from history and it has been
-- failing on every past day and every legacy week — silently, because the client
-- catches and discards the rejection. Worse for `endless_scores`, which 0012 froze
-- and no longer writes to: EVERY row in it is a past week, so not one of them could
-- ever be renamed, while the table stays world-readable. That is precisely where the
-- weekly-board-era email names still sit. It also broke the weekly view's promise —
-- endless_weekly_totals takes display_name from the player's most recent day, so a
-- player who last raced on Tuesday could not fix what the week shows.
--
-- Both checks now run only when the partition key is actually being SET, which
-- preserves their intent exactly — you still cannot file a score under a board of
-- your choosing, nor move a row to another board — and lets a rename through. The
-- backfill below depends on this fix; without it, it would abort.
--
-- ONE-PHASE, SAFE TO APPLY NOW. This removes no access and breaks no deployed
-- client: it only rewrites one value and LOOSENS two checks. An old client's
-- submission still succeeds, its display_name just comes back anonymised. So the
-- two-phase rule does not apply — no client deploy has to land first, and
-- applying this BEFORE the client ships is strictly better than after, because it
-- stops new leaks from cached clients immediately.
--
-- ROLLBACK (restores prior behaviour; does NOT un-anonymise the backfill, which
-- is not reversible — the original names are gone, by design):
--   -- re-run 0013_race_day_mountain_time.sql (endless_daily_guard)
--   -- re-run 0006_endless_week_guard.sql     (endless_scores_guard)
--   -- re-run 0007_level_progress.sql         (level_progress_guard)
--   drop function if exists public.public_display_name(uuid, text);
--   drop function if exists public.anon_display_name(uuid);
--
-- Idempotent-friendly: safe to re-run (OR REPLACE / DROP IF EXISTS, and the
-- backfill's WHERE clauses match nothing on a second pass).
-- ============================================================================

-- ==========================================
-- FUNCTION: anon_display_name — the public name for a player with no chosen one.
--
-- MUST stay byte-identical to `anonName` in src/core/leaderboard.ts. The client
-- shows this string in the app while the server substitutes it into rows, so a
-- drift would show the player one name and the board another. The SELF-CHECK at
-- the bottom of this file refuses to apply the migration if it ever diverges.
--
-- Four hex digits of the user's own id: enough to keep a board legible (twenty
-- rows of 'player' tells a reader nothing) while revealing nothing that reading
-- the board did not already give you — user_id is a selected column.
-- ==========================================
create or replace function public.anon_display_name(p_user uuid)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select 'Player ' || upper(substr(replace(p_user::text, '-', ''), 1, 4));
$$;

-- ==========================================
-- FUNCTION: public_display_name — the guard rule, in one place.
--
-- Returns p_name unchanged, EXCEPT when it is the submitting account's own email
-- local-part, in which case it returns the anonymous name.
--
-- Comparison is normalised to letters+digits, case-folded, on both sides. It has
-- to be: the client stores a SANITIZED local-part (sanitizeName strips the
-- punctuation an address may contain), so a raw equality test against
-- split_part(email,'@',1) would miss 'Jane.Doe' vs 'janedoe' — precisely the
-- shape this exists to catch.
--
-- SECURITY DEFINER because it reads auth.users, with search_path pinned (an
-- unpinned definer function is hijackable via a shadowing schema). EXECUTE is
-- revoked from every client role below: it answers one yes/no about a user id
-- you already hold, which is a weak oracle but not one worth publishing. The
-- guards can still call it — inside a definer function the call runs as the
-- function's owner, which holds execute as owner.
-- ==========================================
create or replace function public.public_display_name(p_user uuid, p_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
stable
as $$
declare
    v_name  text;
    v_local text;
begin
    v_name := lower(regexp_replace(coalesce(p_name, ''), '[^[:alnum:]]', '', 'g'));
    if v_name = '' then
        return p_name;  -- nothing comparable (the caller's trim/cap owns this case)
    end if;

    select lower(regexp_replace(split_part(u.email, '@', 1), '[^[:alnum:]]', '', 'g'))
      into v_local
      from auth.users u
     where u.id = p_user;

    -- No address on the account, or nothing comparable in it: nothing can leak.
    if v_local is null or v_local = '' then
        return p_name;
    end if;

    if v_name = v_local then
        return public.anon_display_name(p_user);
    end if;
    return p_name;
end;
$$;

revoke all on function public.public_display_name(uuid, text) from public;
revoke all on function public.public_display_name(uuid, text) from anon;
revoke all on function public.public_display_name(uuid, text) from authenticated;

-- ==========================================
-- TRIGGER: endless_daily_guard — the live daily board.
-- Recreated whole (the house pattern), carrying forward 0013 exactly:
--   · the SERVER decides which board a score belongs to, not the submitter's
--     clock — NOW ONLY WHEN day_key IS BEING SET (see the header);
--   · score is MONOTONIC per (user, day);
--   · scored_at moves only when the score genuinely rises (the tiebreak);
--   · display_name trimmed + capped; updated_at is server time.
--   · 0017 — NEW: display_name can never be the account's own email name.
-- The one-hour grace past midnight Mountain is unchanged.
-- ==========================================
create or replace function public.endless_daily_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

drop trigger if exists endless_daily_guard on public.endless_daily_scores;
create trigger endless_daily_guard
    before insert or update on public.endless_daily_scores
    for each row execute function public.endless_daily_guard();

-- ==========================================
-- TRIGGER: endless_scores_guard — the FROZEN weekly-board-era table.
-- 0012 stopped writing to it, but it is still world-readable and the client still
-- renames it (deliberately — those rows are exactly the history the rename
-- exists to scrub). Recreated whole, carrying forward:
--   · 0002 — score MONOTONIC per (user, week); display_name trimmed/capped.
--   · 0003 — scored_at moves ONLY on a genuine rise, so the champion tiebreak
--            survives a cosmetic edit (which is what makes the backfill safe).
--   · 0006 — week_key must be the current race week — NOW ONLY WHEN week_key IS
--            BEING SET. Since the table is frozen, every row in it is a past
--            week, so under the old check not one of them could be renamed.
--   · 0017 — NEW: display_name can never be the account's own email name.
-- ==========================================
create or replace function public.endless_scores_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- 0006 + 0017: as above — judge the week only when the week is being set.
    if tg_op = 'INSERT' or new.week_key <> old.week_key then
        if new.week_key <> public.iso_week_key(now())
           and new.week_key <> public.iso_week_key(now() - interval '1 hour') then
            raise exception
                'endless_scores: week_key % is not the current race week (server week is %)',
                new.week_key, public.iso_week_key(now())
                using errcode = 'check_violation';
        end if;
    end if;

    if tg_op = 'UPDATE' then
        if new.score > old.score then
            new.scored_at := now();
        else
            new.score := old.score;
            new.scored_at := old.scored_at;
        end if;
    else
        new.scored_at := now();
    end if;

    new.display_name := left(coalesce(nullif(trim(new.display_name), ''), 'player'), 24);
    new.display_name := public.public_display_name(new.user_id, new.display_name);
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists endless_scores_guard on public.endless_scores;
create trigger endless_scores_guard
    before insert or update on public.endless_scores
    for each row execute function public.endless_scores_guard();

-- ==========================================
-- TRIGGER: level_progress_guard — the all-time ladder.
-- Recreated whole, carrying forward 0007 unchanged (monotonic cleared/stars,
-- reached_at re-stamped only on a real advance, stars capped at 3 * cleared,
-- display_name trimmed + capped) and adding the 0017 privacy substitution. This
-- row never rolls over, so a name left on it would be permanent.
-- ==========================================
create or replace function public.level_progress_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    advanced boolean := true;
begin
    if tg_op = 'UPDATE' then
        -- Compare BEFORE clamping, or the monotonic floor below would hide the advance.
        advanced := new.cleared > old.cleared;
        new.cleared := greatest(new.cleared, old.cleared);
        new.stars := greatest(new.stars, old.stars);
        if not advanced then
            new.reached_at := old.reached_at;
        end if;
    end if;

    if advanced then
        new.reached_at := now();
    end if;

    -- 3 stars per cleared level is the hard ceiling the game can produce.
    new.stars := least(new.stars, new.cleared * 3);

    new.display_name := left(coalesce(nullif(trim(new.display_name), ''), 'player'), 24);
    -- 0017: never this account's email name. See the daily guard above.
    new.display_name := public.public_display_name(new.user_id, new.display_name);
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists level_progress_guard on public.level_progress;
create trigger level_progress_guard
    before insert or update on public.level_progress
    for each row execute function public.level_progress_guard();

-- ==========================================
-- BACKFILL — the rows already published.
--
-- Each WHERE clause selects exactly the rows the rule above would change, so
-- this touches only genuine leaks and matches nothing on a re-run. It cannot be
-- reconstructed later: once a client renames a row the evidence is gone, and for
-- a closed day no client ever will.
--
-- public.endless_weekly_totals needs no entry — it is a VIEW that takes
-- display_name from the player's most recent day, so anonymising
-- endless_daily_scores anonymises the weekly standings with it.
--
-- The guards fire on these UPDATEs and that is intended: they preserve
-- scored_at / reached_at on a no-progress update, so neither the champion
-- tiebreak nor the ladder's rung timing moves. Only updated_at is re-stamped.
-- ==========================================
do $$
declare
    n_daily  integer;
    n_weekly integer;
    n_levels integer;
begin
    update public.endless_daily_scores s
       set display_name = public.public_display_name(s.user_id, s.display_name)
     where public.public_display_name(s.user_id, s.display_name) <> s.display_name;
    get diagnostics n_daily = row_count;

    update public.endless_scores s
       set display_name = public.public_display_name(s.user_id, s.display_name)
     where public.public_display_name(s.user_id, s.display_name) <> s.display_name;
    get diagnostics n_weekly = row_count;

    update public.level_progress p
       set display_name = public.public_display_name(p.user_id, p.display_name)
     where public.public_display_name(p.user_id, p.display_name) <> p.display_name;
    get diagnostics n_levels = row_count;

    raise notice '0017 backfill: anonymised % endless_daily_scores, % endless_scores, % level_progress row(s)',
        n_daily, n_weekly, n_levels;
end $$;

-- ==========================================
-- SELF-CHECK — this migration REFUSES TO APPLY if the server's anonymous name
-- ever stops matching the client's.
--
-- The whole guarantee rests on anon_display_name() and src/core/leaderboard.ts's
-- anonName() producing the same string: the client renders one and the server
-- stores the other, and a mismatch would be invisible until a player noticed the
-- board calling them something the app never showed them. This is the same
-- shared case asserted in src/core/leaderboard.test.ts.
-- ==========================================
do $$
declare
    got      text;
    expected text := 'Player 7F3A';
begin
    got := public.anon_display_name('7f3a91b2-0000-0000-0000-000000000000'::uuid);
    if got <> expected then
        raise exception
            'anon_display_name has drifted from the client formula: got %, expected % — fix this and anonName() in src/core/leaderboard.ts together',
            got, expected;
    end if;
end $$;

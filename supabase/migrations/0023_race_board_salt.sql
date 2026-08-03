-- ============================================================================
-- 0023_race_board_salt.sql
-- PHASE 1 of 2. Safe to apply immediately — this migration is purely ADDITIVE
-- and changes no existing behaviour. The enforcing half is 0024, which is HELD.
--
-- ── THE HOLE THIS CLOSES ───────────────────────────────────────────────────
-- The daily race board is generated client-side from
--
--     mulberry32(seedForKey(day_key))          -- src/core/endless.ts
--
-- where `seedForKey` is a plain FNV-1a hash of the literal date string
-- "YYYY-MM-DD". There is no secret and no server input anywhere in that chain,
-- so ANY future day's board can be generated today, by anyone, and solved
-- offline at leisure. Measured 2026-08-03: boards three weeks out were
-- generated and scored in a single test run. The repo being public makes this
-- easy, but making it private would not fix it — the same function ships in
-- the client bundle and is readable in devtools on the live site.
--
-- It matters more here than it would in a single-player daily puzzle, because
-- the board is also DETERMINISTIC end to end: sampling 600 runs against each
-- real day seed produced only 1-5 distinct scores, the entire spread coming
-- from the one Plinko drop. One board, one solution, knowable the night
-- before — against a leaderboard that pays a purse.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- Mix a server-held random salt into the seed:
--
--     mulberry32(seedForKey(day_key || ':' || salt))
--
-- The salt for a day DOES NOT EXIST until that day has opened. `race_salt()`
-- below refuses any day past the current race day, and mints lazily on first
-- request — so there is no future salt sitting in a table to leak, and no
-- amount of read access to this database reveals tomorrow's board.
--
-- What this buys, stated honestly: it does not make the board unsolvable, it
-- makes it unsolvable IN ADVANCE. Once the day opens the salt is public to
-- everyone at once (it has to be — every player's client needs it to build the
-- same board), so a determined player can still dump the board into a solver
-- at 00:01 and play a strong line at 00:30. That is a far smaller edge than
-- unlimited preparation time, and it is the same clock everyone else is on.
--
-- ── WHY anon MAY CALL IT ───────────────────────────────────────────────────
-- Endless is PLAYABLE signed out (only posting a score needs an account), so a
-- signed-out client must be able to build today's board. Granting execute to
-- anon is therefore required, not a loosening — and it costs nothing, because
-- the function's whole security property is the day check, not who is asking.
--
-- ROLLBACK:
--   drop function if exists public.race_salt(text);
--   drop table if exists public.race_day_salts;
--   alter table public.endless_daily_scores drop column if exists board_salt;
-- ============================================================================

-- ==========================================
-- TABLE: public.race_day_salts
-- One row per day that has OPENED. Never pre-populated: a row appearing here
-- for a future day would be exactly the leak this migration exists to prevent.
-- ==========================================
create table if not exists public.race_day_salts (
    day_key    text primary key check (day_key ~ '^\d{4}-\d{2}-\d{2}$'),
    salt       text not null,
    created_at timestamptz not null default now()
);

-- RLS on with NO policies at all: the table is unreachable by anon and
-- authenticated alike, in either direction. `race_salt()` is security definer
-- and so bypasses this — the function is the ONLY door, which is what lets the
-- day check below be the single place the rule is enforced.
alter table public.race_day_salts enable row level security;

-- ==========================================
-- FUNCTION: public.race_salt(text) -> text
-- The day's salt, minted on first request. NULL for a day that has not opened.
--
-- Returns NULL rather than raising for a future day, deliberately: a client
-- whose clock is a few minutes fast is asking an honest question, and the
-- answer "not yet" should not surface to the player as an error. The client
-- falls back to the unsalted board and simply does not post (see
-- core/endless.ts `endlessRngForDay`).
--
-- The one-hour grace mirrors `endless_daily_guard`: a run that starts before
-- midnight and syncs after it is honest, and must still be able to fetch the
-- salt for the board it was actually played on.
-- ==========================================
create or replace function public.race_salt(p_day text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_salt text;
begin
    if p_day is null or p_day !~ '^\d{4}-\d{2}-\d{2}$' then
        return null;
    end if;

    -- THE GATE. A day the server's own race clock has not reached yet has no
    -- salt and cannot be given one. `race_day_key` is the same Mountain-time
    -- anchor the score guard uses (0013, restored by 0020), so the salt and the
    -- board partition can never disagree about which day it is.
    if p_day > public.race_day_key(now()) then
        return null;
    end if;

    -- Mint-once. Concurrent first-requests race here, so the insert absorbs the
    -- collision rather than erroring, and the select after it is what returns —
    -- whichever writer won, every caller gets the same string.
    insert into public.race_day_salts (day_key, salt)
    values (p_day, gen_random_uuid()::text)
    on conflict (day_key) do nothing;

    select salt into v_salt from public.race_day_salts where day_key = p_day;
    return v_salt;
end;
$$;

revoke all on function public.race_salt(text) from public;
grant execute on function public.race_salt(text) to anon, authenticated;

-- ==========================================
-- COLUMN: endless_daily_scores.board_salt
-- Which board this score was actually played on.
--
-- NULLABLE and unenforced in this migration — that is the whole point of the
-- two-phase split. A deployed PWA client keeps running its cached bundle until
-- the player accepts an update, so on the day salting activates there will be
-- clients still generating the OLD board. They must not be able to post into
-- the same partition as everyone else: two populations racing different boards
-- under one leaderboard is silent corruption, not a visible failure.
--
-- 0024 adds the check that rejects them. It is HELD until the salt-aware client
-- has actually reached players — see that file's header.
-- ==========================================
alter table public.endless_daily_scores
    add column if not exists board_salt text;

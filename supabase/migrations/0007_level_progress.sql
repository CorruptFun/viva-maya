-- ============================================================================
-- 0007_level_progress.sql
-- The LEVEL RACE — an all-time leaderboard for campaign progress, so "who has
-- got the farthest" is visible the way the weekly endless score already is.
--
-- WHY A SECOND TABLE (not more columns on endless_scores): endless_scores is
-- partitioned by ISO week and its rows die with the race. Campaign progress is
-- cumulative and permanent — one row per player, forever — so it has a different
-- primary key, a different lifetime, and a different index. Bolting it onto the
-- weekly table would mean a nullable week and a nonsense (user, week) key.
--
-- WHY THE STAR TIEBREAK MATTERS HERE: levels are a LADDER, so ties are the
-- normal case, not the exception — a friends-and-family board will routinely
-- have several players sitting on the same level. Ranking on `cleared` alone
-- would show a pile of joint-firsts. `stars` (total earned, 3 max per level)
-- separates mastery from mere arrival, and `reached_at` settles the rest by who
-- got there first — the same "first to the mark wins" rule the champion crown
-- already uses (0003).
--
-- TRUST MODEL: identical to 0002 — rows are self-reported by the signed-in
-- client, RLS stops anyone writing anyone else's row, and the guard trigger
-- below keeps both counters MONOTONIC and internally consistent. A modified
-- client can still inflate its own row; acceptable for this release, and the
-- server-side replay validation sketched in Supabase_Architecture.md remains
-- the hardening path.
--
-- Idempotent-friendly: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).
-- ============================================================================

-- ==========================================
-- TABLE: public.level_progress
-- One row per user, all-time. Nothing private lives here.
-- ==========================================
create table if not exists public.level_progress (
    user_id      uuid primary key references auth.users(id) on delete cascade,
    -- Highest level number the player has CLEARED (0 = has cleared none yet).
    -- Bounded generously rather than pinned to LEVEL_COUNT: the campaign length
    -- is a client constant that has already moved once (100 -> 300), and a
    -- migration should not need re-running when it moves again.
    cleared      integer not null default 0 check (cleared >= 0 and cleared <= 10000),
    -- Total stars banked across every cleared level. At most 3 per level, which
    -- the guard below enforces against `cleared` — a cheap consistency floor
    -- that makes a naively inflated star count fail loudly.
    stars        integer not null default 0 check (stars >= 0),
    display_name text not null default 'player',
    -- When the player FIRST arrived at their current `cleared` value. Reset by
    -- the guard whenever cleared advances, so it always answers "how long have
    -- they held this rung", never "when did they first install".
    reached_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

-- The one query shape the game issues: the ladder, best first.
-- Mirrors the ORDER BY in core/leaderboard.ts fetchLevelBoard exactly — keep
-- the two in step or the index stops being used.
create index if not exists level_progress_ladder
    on public.level_progress (cleared desc, stars desc, reached_at asc);

alter table public.level_progress enable row level security;

-- ==========================================
-- RLS POLICIES
-- Reads are public (only name + progress live here). Writes are owner-only.
-- ==========================================

drop policy if exists "Anyone can read level progress" on public.level_progress;
create policy "Anyone can read level progress"
    on public.level_progress
    for select
    using (true);

drop policy if exists "Users can insert own progress" on public.level_progress;
create policy "Users can insert own progress"
    on public.level_progress
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "Users can update own progress" on public.level_progress;
create policy "Users can update own progress"
    on public.level_progress
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- ==========================================
-- TRIGGER: keep the ladder monotonic and self-consistent
--  - cleared and stars only ever RISE, so a stale client (an old tab, a device
--    syncing a pre-progress save) can never walk a player back down the board.
--  - reached_at is re-stamped ONLY when cleared actually advances, so the
--    tiebreak measures arrival at the current rung.
--  - stars is capped at 3 * cleared. A client claiming more stars than its
--    cleared count can physically hold is clamped rather than trusted.
--  - display_name is trimmed + capped server-side (defense in depth).
-- ==========================================
create or replace function public.level_progress_guard()
returns trigger
language plpgsql
security definer
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
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists level_progress_guard on public.level_progress;
create trigger level_progress_guard
    before insert or update on public.level_progress
    for each row execute function public.level_progress_guard();

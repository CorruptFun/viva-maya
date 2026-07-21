-- ============================================================================
-- 0002_endless_leaderboard.sql
-- Weekly endless-race leaderboard — the second slice of Supabase_Architecture.md.
--
-- WHY A SEPARATE TABLE (not a view over public.saves): saves rows are owner-only
-- by RLS design — the whole SaveData blob is private. A leaderboard needs
-- cross-user reads, so we mirror ONLY the three shareable fields (display name,
-- week, score) into a table whose SELECT is world-readable. The client submits
-- its weekly best at the same debounced moment the cloud save syncs, so the
-- leaderboard "just happens" for signed-in players with zero extra traffic paths.
--
-- FAIRNESS: the endless race is already deterministic client-side (same weekly
-- seed → same board, fixed move budget for everyone), so scores are comparable.
-- TRUST MODEL (v1): rows are self-reported by the signed-in client. RLS stops
-- anyone from writing anyone ELSE's row, and a trigger keeps scores monotonic
-- per (user, week), but a modified client could still inflate its own score.
-- Acceptable for a friends-and-family release; the deterministic-replay
-- validation sketched in Supabase_Architecture.md (submit the move list, server
-- replays the seeded board) is the future hardening path if it ever matters.
--
-- Idempotent-friendly: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).
-- ============================================================================

-- ==========================================
-- TABLE: public.endless_scores
-- One row per (user, ISO week). Nothing private lives here.
-- ==========================================
create table if not exists public.endless_scores (
    user_id      uuid not null references auth.users(id) on delete cascade,
    week_key     text not null check (week_key ~ '^\d{4}-W\d{2}$'),
    score        bigint not null check (score >= 0),
    display_name text not null default 'player',
    updated_at   timestamptz not null default now(),
    primary key (user_id, week_key)
);

-- The one query shape the game issues: top-N for a week, best first.
create index if not exists endless_scores_week_rank
    on public.endless_scores (week_key, score desc);

alter table public.endless_scores enable row level security;

-- ==========================================
-- RLS POLICIES
-- Reads are public (that's the point of a leaderboard — only name/score/week
-- are stored). Writes are owner-only.
-- ==========================================

drop policy if exists "Anyone can read the leaderboard" on public.endless_scores;
create policy "Anyone can read the leaderboard"
    on public.endless_scores
    for select
    using (true);

drop policy if exists "Users can insert own score" on public.endless_scores;
create policy "Users can insert own score"
    on public.endless_scores
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "Users can update own score" on public.endless_scores;
create policy "Users can update own score"
    on public.endless_scores
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- ==========================================
-- TRIGGER: sanitize + keep scores honest-ish
--  - score is MONOTONIC per (user, week): an update can only raise it, so a
--    stale/duplicate client submit can never clobber a better run.
--  - display_name is trimmed + capped at 24 chars server-side (defense in
--    depth; the client also sanitizes) and never empty.
--  - updated_at is always server time.
-- ==========================================
create or replace function public.endless_scores_guard()
returns trigger
language plpgsql
security definer
as $$
begin
    if tg_op = 'UPDATE' then
        new.score := greatest(new.score, old.score);
    end if;
    new.display_name := left(coalesce(nullif(trim(new.display_name), ''), 'player'), 24);
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists endless_scores_guard on public.endless_scores;
create trigger endless_scores_guard
    before insert or update on public.endless_scores
    for each row execute function public.endless_scores_guard();

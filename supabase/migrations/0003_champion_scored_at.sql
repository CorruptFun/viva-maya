-- ============================================================================
-- 0003_champion_scored_at.sql
-- Weekly CHAMPION support: a fair tiebreak column for closed-week winners.
--
-- WHY: the weekly winner is "top score of the closed week", but `updated_at`
-- bumps on ANY row update (e.g. a display-name change), so it can't be the
-- tiebreak. `scored_at` moves ONLY when the score actually increases — so a tie
-- goes to whoever reached the score FIRST, and cosmetic edits never affect
-- standing. The client reads the champion as:
--     order by score desc, scored_at asc limit 1
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

alter table public.endless_scores
    add column if not exists scored_at timestamptz not null default now();

-- Recreate the guard trigger fn: keep the monotonic-score + name-sanitize +
-- server-time behaviour from 0002, and additionally stamp scored_at only when
-- the score genuinely rises (insert counts as its first rise).
create or replace function public.endless_scores_guard()
returns trigger
language plpgsql
security definer
as $$
begin
    if tg_op = 'UPDATE' then
        if new.score > old.score then
            new.scored_at := now();
        else
            new.score := old.score;       -- monotonic: an update can never lower it
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

drop trigger if exists endless_scores_guard on public.endless_scores;
create trigger endless_scores_guard
    before insert or update on public.endless_scores
    for each row execute function public.endless_scores_guard();

-- The champion query shape: (week, score desc, scored_at asc).
create index if not exists endless_scores_champion
    on public.endless_scores (week_key, score desc, scored_at asc);

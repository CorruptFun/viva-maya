-- ============================================================================
-- 0012_endless_daily.sql
-- The endless race becomes a DAILY board with a WEEKLY season on top of it.
--
-- WHAT CHANGED, AND WHY IT NEEDED A NEW TABLE
--
-- Until now the race was one board per ISO week: a single seed, a single best
-- per (user, week), one champion each Monday. Two things were wrong with that.
-- The board went stale — by Thursday the leaders had memorised a layout that
-- never changed, and a player arriving on Saturday was racing a week of other
-- people's practice. And there was no reason to come back TOMORROW; the only
-- rhythm the game had was weekly.
--
-- Now every UTC day is its own board (core/endless.ts dayKey seeds it), every
-- day crowns its own winner, and a WEEK'S standing is the SUM of that player's
-- daily bests inside it. Showing up is the strategy: miss a day and you bank a
-- zero for it, and no single run can make that back.
--
-- That sum is why this is a new table rather than a widened `endless_scores`.
-- The old primary key is (user_id, week_key) — ONE row per player per week —
-- so a weekly total made of seven daily bests has nowhere to live in it. The
-- grain of the data genuinely changed: one row per (user, DAY).
--
-- `public.endless_scores` is left in place, untouched and no longer written to.
-- Its rows are the historical record of the weekly-board era, and its 0006
-- guard already refuses anything but the current week, so a rolled-back client
-- can't quietly resume filing scores into it either.
--
-- WEEKLY TOTALS are a VIEW, not a second table. A stored weekly total would be
-- a denormalised copy that has to be kept in step with every daily upsert by
-- yet another trigger — and the first time those two disagree, the leaderboard
-- lies. Summing the daily rows means the total is BY CONSTRUCTION the sum of
-- the scores that produced it, and PostgREST reads the view with the same
-- select/order/limit shape the client already uses for every other board.
--
-- TRUST MODEL: unchanged from 0002/0006 — rows are self-reported by the
-- signed-in client, RLS stops anyone writing anyone ELSE's row, the trigger
-- keeps a day's score monotonic and refuses any day but the current one. The
-- SCORE itself is still self-reported; server-side deterministic replay
-- (submit the move list, replay the seeded board) remains the hardening path
-- sketched in Supabase_Architecture.md. Note the daily board makes that a
-- little cheaper to want: a forged score now buys one day, not one week.
--
-- Idempotent-friendly: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP IF EXISTS).
-- ============================================================================

-- ==========================================
-- FUNCTION: public.utc_day_key(timestamptz) -> 'YYYY-MM-DD'
-- The server's own copy of core/endless.ts `dayKey`. MUST stay identical in
-- format and semantics: the UTC calendar date, nothing local. `at time zone
-- 'utc'` pins the conversion so no session TimeZone setting can move the
-- answer — the same discipline 0006 applied to the week key, for the same
-- reason (a day boundary that moves per connection would reject honest scores
-- for hours at a time).
-- ==========================================
create or replace function public.utc_day_key(ts timestamptz)
returns text
language sql
immutable
as $$
    select to_char(ts at time zone 'utc', 'YYYY-MM-DD');
$$;

-- ==========================================
-- FUNCTION: public.iso_week_of_day(text) -> 'YYYY-Www'
-- Which race week a day key belongs to — the server's copy of core/endless.ts
-- `weekKeyOfDay`, and the ONE definition of the daily→weekly rollup below.
--
-- `to_date`, not `::date`: the cast reads DateStyle and is therefore only
-- STABLE, which would make this function un-indexable. to_date's format is
-- explicit, so this is genuinely IMMUTABLE and the expression index further
-- down is legal — which is what keeps the weekly view a cheap lookup rather
-- than a full scan of every day ever played.
-- ==========================================
create or replace function public.iso_week_of_day(day_key text)
returns text
language sql
immutable
as $$
    select to_char(to_date(day_key, 'YYYY-MM-DD'), 'IYYY-"W"IW');
$$;

-- ==========================================
-- TABLE: public.endless_daily_scores
-- One row per (user, UTC day). Nothing private lives here — same three
-- shareable fields as 0002, with the partition key now a day.
-- ==========================================
create table if not exists public.endless_daily_scores (
    user_id      uuid not null references auth.users(id) on delete cascade,
    day_key      text not null check (day_key ~ '^\d{4}-\d{2}-\d{2}$'),
    score        bigint not null check (score >= 0),
    display_name text not null default 'player',
    scored_at    timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    primary key (user_id, day_key)
);

-- The daily board's query shape: top-N for a day, best first, earliest-to-reach
-- breaking ties (the champion rule inherited from 0003).
create index if not exists endless_daily_day_rank
    on public.endless_daily_scores (day_key, score desc, scored_at asc);

-- The weekly rollup's filter. The view groups on iso_week_of_day(day_key), so a
-- `week_key=eq.…` from PostgREST lands on this expression index instead of
-- scanning and hashing every daily row in the table's history.
create index if not exists endless_daily_week
    on public.endless_daily_scores (public.iso_week_of_day(day_key));

alter table public.endless_daily_scores enable row level security;

-- ==========================================
-- RLS POLICIES
-- Reads are public (that's the point of a leaderboard — only name/day/score are
-- stored). Writes are owner-only. Identical shape to 0002.
-- ==========================================

drop policy if exists "Anyone can read the daily leaderboard" on public.endless_daily_scores;
create policy "Anyone can read the daily leaderboard"
    on public.endless_daily_scores
    for select
    using (true);

drop policy if exists "Users can insert own daily score" on public.endless_daily_scores;
create policy "Users can insert own daily score"
    on public.endless_daily_scores
    for insert
    with check (auth.uid() = user_id);

drop policy if exists "Users can update own daily score" on public.endless_daily_scores;
create policy "Users can update own daily score"
    on public.endless_daily_scores
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

-- ==========================================
-- TRIGGER: endless_daily_guard
-- Carries forward every guarantee the weekly guard accumulated (0002/0003/0006),
-- re-pointed at a day:
--   · the SERVER decides which board a score belongs to, not the submitter's
--     clock. The day key seeds the board, so without this a device clock set
--     forward opens tomorrow's board early (play it unhurried, arrive on that
--     day with a score nobody else had time to chase) and a clock set back
--     re-opens a board whose layout is already known. It also closes the
--     quieter hole: backfilling a CLOSED day, whose winner has already been
--     crowned — no tampering required, just a client that synced late.
--   · score is MONOTONIC per (user, day): a stale or duplicate submit can never
--     clobber a better run.
--   · scored_at moves ONLY when the score genuinely rises, so the "first to
--     reach it wins the tie" rule survives a cosmetic display-name edit.
--   · display_name is trimmed + capped server-side; updated_at is server time.
--
-- GRACE: a run that starts before midnight UTC and syncs after it is honest, so
-- the previous day is accepted for one hour past the boundary — expressed as
-- "the UTC day of now() or of now() - 1 hour", which needs no extra constant
-- and self-closes.
--
-- Rejection is safe client-side: core/leaderboard.ts `maybeSubmitEndless`
-- swallows the error and simply doesn't memo the send, so a stale submit is a
-- no-op rather than a crash.
-- ==========================================
create or replace function public.endless_daily_guard()
returns trigger
language plpgsql
security definer
as $$
begin
    if new.day_key <> public.utc_day_key(now())
       and new.day_key <> public.utc_day_key(now() - interval '1 hour') then
        raise exception
            'endless_daily_scores: day_key % is not the current race day (server day is %)',
            new.day_key, public.utc_day_key(now())
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

drop trigger if exists endless_daily_guard on public.endless_daily_scores;
create trigger endless_daily_guard
    before insert or update on public.endless_daily_scores
    for each row execute function public.endless_daily_guard();

-- ==========================================
-- VIEW: public.endless_weekly_totals
-- The season standings — one row per (week, player).
--
--   total        the SUM of that player's daily bests in the week. This is the
--                ranking key, and it is why turning up matters: a player who
--                skips Wednesday is not "one board behind", they are down a
--                whole board's worth of score with no way to make it up.
--   days_played  how many of the week's boards they actually raced. Shown next
--                to the total ("18,204 · 5d") because it is the explanation for
--                the ranking, and it breaks ties in the player's favour when
--                two totals land equal — more turnout wins.
--   display_name taken from the player's MOST RECENT day, so a rename lands on
--                the weekly board immediately, exactly as it does on the daily
--                one (core/leaderboard.ts renames every row it owns).
--
-- `where score > 0` keeps a zero-scored row (possible only via a hand-crafted
-- submit; the client never sends one) from inflating days_played.
-- ==========================================
drop view if exists public.endless_weekly_totals;
create view public.endless_weekly_totals as
select
    public.iso_week_of_day(day_key)                     as week_key,
    user_id,
    (array_agg(display_name order by day_key desc))[1]  as display_name,
    sum(score)::bigint                                  as total,
    count(*)::int                                       as days_played,
    max(scored_at)                                      as last_scored_at
from public.endless_daily_scores
where score > 0
group by 1, 2;

-- Run the view as the CALLER, so the base table's RLS applies rather than being
-- bypassed by the view owner's rights. The SELECT policy above is `using (true)`,
-- so this changes nothing about who can read the standings — it just means the
-- day the base table's read policy is ever narrowed, this view narrows with it
-- instead of quietly becoming a way around it.
-- Wrapped: security_invoker needs PG15+, and a migration must not fail on an
-- older server for a hardening detail that is belt-and-braces here.
do $$
begin
    execute 'alter view public.endless_weekly_totals set (security_invoker = true)';
exception when others then
    raise notice 'security_invoker not supported here; the view runs as owner (base-table RLS is public-read anyway)';
end;
$$;

grant select on public.endless_weekly_totals to anon, authenticated;

-- ==========================================
-- SELF-CHECK — this migration REFUSES TO APPLY if the server's idea of a day,
-- or of which week a day belongs to, disagrees with the game client's.
--
-- Same reasoning as 0006's self-check, now doubled because the rollup is new.
-- If utc_day_key() drifts from core/endless.ts dayKey(), the database starts
-- rejecting every honest score and the board silently goes empty. If
-- iso_week_of_day() drifts from weekKeyOfDay(), the daily boards keep working
-- perfectly while the weekly standings quietly rank the wrong seven days —
-- which is worse, because nothing about it looks broken.
-- ==========================================
do $$
declare
    day_cases constant text[][] := array[
        -- [instant (UTC), expected day key] — mirrors src/core/endless.test.ts
        ['2026-07-29T00:00:00Z', '2026-07-29'],  -- the moment the board opens
        ['2026-07-29T23:59:59Z', '2026-07-29'],  -- last second of the same board
        ['2026-07-30T00:00:00Z', '2026-07-30'],  -- the rollover, exactly
        ['2026-01-01T12:00:00Z', '2026-01-01'],  -- year seam
        ['2026-03-01T00:00:00Z', '2026-03-01']   -- month seam, non-leap February
    ];
    week_cases constant text[][] := array[
        -- [day key, expected ISO week] — the seven days of 2026-W31 plus both seams
        ['2026-07-27', '2026-W31'],  -- Monday: the season opens
        ['2026-08-02', '2026-W31'],  -- Sunday: still the same season
        ['2026-08-03', '2026-W32'],  -- next Monday: a new one
        ['2025-12-29', '2026-W01'],  -- ISO year seam: W01 starts in December
        ['2026-01-04', '2026-W01'],
        ['2026-01-05', '2026-W02']
    ];
    i        int;
    got      text;
    expected text;
begin
    for i in 1 .. array_length(day_cases, 1) loop
        expected := day_cases[i][2];
        got := public.utc_day_key(day_cases[i][1]::timestamptz);
        if got <> expected then
            raise exception
                'utc_day_key(%) returned % but the game client computes % — the server and client disagree about which day it is; DO NOT deploy this guard until they match',
                day_cases[i][1], got, expected;
        end if;
        if got !~ '^\d{4}-\d{2}-\d{2}$' then
            raise exception
                'utc_day_key(%) returned %, which violates the day_key CHECK constraint',
                day_cases[i][1], got;
        end if;
    end loop;

    for i in 1 .. array_length(week_cases, 1) loop
        expected := week_cases[i][2];
        got := public.iso_week_of_day(week_cases[i][1]);
        if got <> expected then
            raise exception
                'iso_week_of_day(%) returned % but the game client computes % — the weekly totals would roll up the wrong days',
                week_cases[i][1], got, expected;
        end if;
    end loop;

    -- The real risk both functions share: a session TimeZone quietly shifting
    -- the answer. The client is UTC, so the server must be too, whatever the
    -- connection says.
    set local timezone = 'Pacific/Kiritimati';  -- UTC+14, the furthest ahead on earth
    if public.utc_day_key('2026-07-29T23:59:59Z'::timestamptz) <> '2026-07-29' then
        raise exception 'utc_day_key is sensitive to the session timezone — it must be pinned to UTC';
    end if;
    set local timezone = 'Pacific/Niue';        -- UTC-11, the furthest behind
    if public.utc_day_key('2026-07-30T00:00:00Z'::timestamptz) <> '2026-07-30' then
        raise exception 'utc_day_key is sensitive to the session timezone — it must be pinned to UTC';
    end if;
    if public.iso_week_of_day('2026-08-02') <> '2026-W31' then
        raise exception 'iso_week_of_day is sensitive to the session timezone — it must not be';
    end if;

    raise notice 'utc_day_key and iso_week_of_day agree with the game client across all checked instants and timezones.';
end;
$$;

-- ============================================================================
-- 0014_analytics_dashboard.sql
-- THE OWNER'S WINDOW INTO 0010 — an admin-gated aggregate RPC, so the analytics
-- can be read from a dashboard page (stats.html) without weakening the events
-- table's "no SELECT policy, ever" rule.
--
-- WHY THIS EXISTS: 0010 made the game measurable, but the only read path was
-- the SQL editor — fine for a spot check, useless as a daily habit, and it
-- means every question re-derives its query from scratch. A dashboard needs a
-- read path, and on a static Pages site there is nowhere to keep the service
-- key: whatever a browser page holds, every visitor holds. So the browser must
-- be able to ask with credentials it already has (the publishable key + the
-- owner's own Google session), and the SERVER must decide whether to answer.
--
-- THE SHAPE — the 0012 lesson applied to reads. The events table stays exactly
-- as 0010 left it: RLS on, INSERT-only, no SELECT policy, and none is added
-- here. Instead a single SECURITY DEFINER function is the sole reader, and it
-- refuses everyone except user ids listed in `app_admins` — a table only the
-- service role can write (RLS on, zero policies, plus explicit revokes), so
-- membership is granted in the SQL editor and nowhere else. What the function
-- returns is AGGREGATES ONLY — counts, rates, distributions — never raw rows,
-- so even the admin path exposes no per-device event stream to a browser. The
-- distinction matters: a SELECT policy would hand out rows to a ROLE (which
-- every visitor shares); this hands a fixed summary to a PERSON.
--
-- TRUST MODEL: unchanged from 0010 — rows are self-reported by untrusted
-- clients, so every value this function touches is treated as hostile. Numeric
-- props are type-checked (jsonb_typeof) before casting — a forged
-- {"level": "abc"} or {"level": 21.5} must not be able to error the whole
-- dashboard — string props are length-capped, and every grouped list is
-- LIMIT-bounded so a spammed table cannot balloon the response.
--
-- Idempotent-friendly: safe to re-run (IF NOT EXISTS / OR REPLACE).
-- Rollback: drop function public.admin_analytics(integer);
--           drop table public.app_admins;
-- ============================================================================

-- ==========================================
-- TABLE: public.app_admins — who may read the aggregates.
-- ==========================================
create table if not exists public.app_admins (
    -- `on delete cascade` (not `set null` like events.user_id): an admin row is
    -- an authorization, not history — a deleted account must take its access
    -- with it.
    user_id    uuid primary key references auth.users(id) on delete cascade,
    -- Free-text label ("owner's account") so a second admin added a year from
    -- now is identifiable without joining auth.users in your head.
    note       text,
    created_at timestamptz not null default now()
);

-- RLS on with NO policies: the API can neither read nor write this table, in
-- either role. Membership is managed from the SQL editor (service role), which
-- bypasses RLS. The revokes are belt and braces on top — the same doubling-up
-- 0010 uses on its views.
alter table public.app_admins enable row level security;
revoke all on table public.app_admins from public, anon, authenticated;

-- ==========================================
-- FUNCTION: public.admin_analytics(p_days)
-- One call returns every panel the dashboard draws, as a single jsonb object —
-- the page is a static site fetching over the public API, so one round trip
-- beats eight, and one function keeps the authorization check in one place.
-- ==========================================
create or replace function public.admin_analytics(p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
-- REQUIRED on every definer function (see 0012): an unpinned search_path is
-- hijackable by a caller who puts their own `events` earlier in the path.
set search_path = public, pg_temp
as $$
declare
    -- Clamp rather than reject: the parameter is caller-supplied and this
    -- function's contract is "answer or refuse", never "error on shape".
    d      integer := least(greatest(coalesce(p_days, 14), 1), 365);
    since  timestamptz;
    result jsonb;
begin
    -- THE GATE. auth.uid() comes from the caller's JWT — it cannot be forged
    -- without Supabase's signing key — and membership can only be granted via
    -- the service role. 42501 (insufficient_privilege) so PostgREST answers
    -- 403 and the dashboard can tell "not an admin" apart from "broken".
    if auth.uid() is null
       or not exists (select 1 from public.app_admins a where a.user_id = auth.uid()) then
        raise exception 'admin_analytics is admin-only' using errcode = '42501';
    end if;

    since := now() - make_interval(days => d);

    with
    -- One window scan feeds every panel (multi-referenced CTEs materialize).
    win as (
        select device_id, user_id, session_id, name, props, app_version, created_at,
               -- Day/hour bucketing is EXPLICITLY UTC rather than whatever the
               -- session TZ happens to be, so this function and the 0010
               -- events_daily view can never disagree about which day an event
               -- belongs to. (The RACE day is deliberately a different clock —
               -- America/Edmonton since 0013_race_day — so race standings and
               -- analytics days are expected to cut at different midnights.)
               (created_at at time zone 'utc') as utc_at
        from public.events
        where created_at >= since
    ),
    -- First-ever sighting per device, over the WHOLE table (not the window) so
    -- a device returning after a quiet week isn't miscounted as new. Bounded by
    -- prune_events retention, so "new" honestly means "first seen within the
    -- retention horizon" — the dashboard says so.
    first_seen as (
        select device_id, min(created_at) as first_at
        from public.events
        group by 1
    ),
    -- The level-shaped events, with the level coerced defensively: typeof-check
    -- before cast (a forged string must not error), round() because ::int on
    -- the text of "21.5" throws where numeric does not, and a sane range cap
    -- so forged levels can't mint thousands of output rows.
    lvl as (
        select round((props->>'level')::numeric)::int as level, name, props, device_id
        from win
        where name in ('level_start','level_win','level_fail','level_quit',
                       'continue_shown','continue_taken')
          and jsonb_typeof(props->'level') = 'number'
          and (props->>'level')::numeric between 0 and 100000
    )
    select jsonb_build_object(
        'meta', jsonb_build_object(
            'days', d,
            'since', since,
            'generated_at', now()
        ),
        'totals', (
            select jsonb_build_object(
                'devices',          count(distinct w.device_id),
                'signed_in',        count(distinct w.device_id) filter (where w.user_id is not null),
                'sessions',         count(distinct w.session_id),
                'events',           count(*),
                'app_opens',        count(*) filter (where w.name = 'app_open'),
                'standalone_opens', count(*) filter (where w.name = 'app_open'
                                                       and w.props->>'standalone' = 'true'),
                'new_devices',      (select count(*) from first_seen f where f.first_at >= since)
            )
            from win w
        ),
        'daily', coalesce((
            select jsonb_agg(jsonb_build_object(
                'day', t.day, 'devices', t.devices, 'signed_in', t.signed_in,
                'sessions', t.sessions, 'events', t.events, 'app_opens', t.app_opens,
                'standalone_opens', t.standalone_opens,
                'new_devices', coalesce(n.new_devices, 0)
            ) order by t.day)
            from (
                select w.utc_at::date as day,
                       count(distinct w.device_id) as devices,
                       count(distinct w.device_id) filter (where w.user_id is not null) as signed_in,
                       count(distinct w.session_id) as sessions,
                       count(*) as events,
                       count(*) filter (where w.name = 'app_open') as app_opens,
                       count(*) filter (where w.name = 'app_open'
                                          and w.props->>'standalone' = 'true') as standalone_opens
                from win w
                group by 1
            ) t
            left join (
                select (f.first_at at time zone 'utc')::date as day, count(*) as new_devices
                from first_seen f
                where f.first_at >= since
                group by 1
            ) n using (day)
        ), '[]'::jsonb),
        'hourly', coalesce((
            select jsonb_agg(jsonb_build_object(
                'hour', t.hour, 'sessions', t.sessions, 'events', t.events
            ) order by t.hour)
            from (
                select extract(hour from w.utc_at)::int as hour,
                       count(distinct w.session_id) as sessions,
                       count(*) as events
                from win w
                group by 1
            ) t
        ), '[]'::jsonb),
        -- Every distinct name in the window, unfiltered on purpose: this is how
        -- the 'unknown' bucket (a client-side typo, per the 0010 guard) becomes
        -- VISIBLE on the dashboard instead of silently vanishing.
        'counts', coalesce((
            select jsonb_agg(jsonb_build_object(
                'name', t.name, 'events', t.events, 'devices', t.devices
            ) order by t.events desc)
            from (
                select w.name, count(*) as events, count(distinct w.device_id) as devices
                from win w
                group by 1
                order by 2 desc
                limit 200
            ) t
        ), '[]'::jsonb),
        'levels', coalesce((
            select jsonb_agg(jsonb_build_object(
                'level', t.level, 'starts', t.starts, 'wins', t.wins, 'fails', t.fails,
                'fails_moves', t.fails_moves, 'fails_lives', t.fails_lives,
                'quits', t.quits, 'continues_shown', t.continues_shown,
                'continues_taken', t.continues_taken, 'devices', t.devices
            ) order by t.level)
            from (
                select l.level,
                       count(*) filter (where l.name = 'level_start') as starts,
                       count(*) filter (where l.name = 'level_win') as wins,
                       count(*) filter (where l.name = 'level_fail') as fails,
                       count(*) filter (where l.name = 'level_fail'
                                          and l.props->>'reason' = 'out_of_moves') as fails_moves,
                       count(*) filter (where l.name = 'level_fail'
                                          and l.props->>'reason' = 'out_of_lives') as fails_lives,
                       count(*) filter (where l.name = 'level_quit') as quits,
                       count(*) filter (where l.name = 'continue_shown') as continues_shown,
                       count(*) filter (where l.name = 'continue_taken') as continues_taken,
                       count(distinct l.device_id) filter (where l.name = 'level_start') as devices
                from lvl l
                group by 1
                order by 1
                limit 1000
            ) t
        ), '[]'::jsonb),
        'deal', (
            select jsonb_build_object(
                'offers',    count(*) filter (where w.name = 'deal_offered'),
                'wins',      count(*) filter (where w.name = 'deal_won'),
                'fast_wins', count(*) filter (where w.name = 'deal_won'
                                                and w.props->>'fast' = 'true'),
                'charms',    count(*) filter (where w.name = 'deal_won'
                                                and w.props->>'charm' = 'true'),
                -- CASE (not FILTER) so the cast provably never sees a non-number.
                'avg_flips', round(avg(case
                                 when w.name = 'deal_won'
                                  and jsonb_typeof(w.props->'flips') = 'number'
                                 then (w.props->>'flips')::numeric
                               end), 2),
                'streaks', coalesce((
                    select jsonb_agg(jsonb_build_object(
                        'streak', s.streak, 'count', s.count
                    ) order by s.streak)
                    from (
                        select least(round((w2.props->>'streak')::numeric)::int, 99) as streak,
                               count(*) as count
                        from win w2
                        where w2.name = 'deal_offered'
                          and jsonb_typeof(w2.props->'streak') = 'number'
                          and (w2.props->>'streak')::numeric between 0 and 1e6
                        group by 1
                        order by 1
                        limit 100
                    ) s
                ), '[]'::jsonb),
                'faces', coalesce((
                    select jsonb_agg(jsonb_build_object(
                        'face', s.face, 'count', s.count
                    ) order by s.count desc)
                    from (
                        select left(w2.props->>'face', 24) as face, count(*) as count
                        from win w2
                        where w2.name = 'deal_won' and w2.props->>'face' is not null
                        group by 1
                        order by 2 desc
                        limit 24
                    ) s
                ), '[]'::jsonb)
            )
            from win w
        ),
        'plinko', (
            select jsonb_build_object(
                'offered', count(*) filter (where w.name = 'plinko_offered'),
                'played',  count(*) filter (where w.name = 'plinko_played'),
                'slots', coalesce((
                    select jsonb_agg(jsonb_build_object(
                        'slot', s.slot, 'count', s.count, 'avg_payout', s.avg_payout
                    ) order by s.slot)
                    from (
                        select least(round((w2.props->>'slot')::numeric)::int, 99) as slot,
                               count(*) as count,
                               round(avg(case
                                 when jsonb_typeof(w2.props->'payout') = 'number'
                                 then (w2.props->>'payout')::numeric
                               end), 1) as avg_payout
                        from win w2
                        where w2.name = 'plinko_played'
                          and jsonb_typeof(w2.props->'slot') = 'number'
                          and (w2.props->>'slot')::numeric between 0 and 1e6
                        group by 1
                        order by 1
                        limit 100
                    ) s
                ), '[]'::jsonb)
            )
            from win w
        ),
        'shares', coalesce((
            select jsonb_agg(jsonb_build_object(
                'surface', t.surface, 'count', t.count
            ) order by t.count desc)
            from (
                select left(coalesce(w.props->>'surface', '?'), 24) as surface,
                       count(*) as count
                from win w
                where w.name = 'share_clicked'
                group by 1
                order by 2 desc
                limit 24
            ) t
        ), '[]'::jsonb),
        'versions', coalesce((
            select jsonb_agg(jsonb_build_object(
                'version', t.version, 'devices', t.devices, 'events', t.events,
                'first_seen', t.first_seen, 'last_seen', t.last_seen
            ) order by t.last_seen desc)
            from (
                select coalesce(w.app_version, '?') as version,
                       count(distinct w.device_id) as devices,
                       count(*) as events,
                       min(w.created_at) as first_seen,
                       max(w.created_at) as last_seen
                from win w
                group by 1
                order by max(w.created_at) desc
                limit 60
            ) t
        ), '[]'::jsonb)
    )
    into result;

    return result;
end;
$$;

-- anon is DENIED at the grant level (never reaches the function body); every
-- signed-in caller reaches the app_admins gate and all but admins bounce off
-- it. service_role is granted for parity with how the sender scripts operate,
-- though it could also just read the table directly.
revoke all on function public.admin_analytics(integer) from public, anon;
grant execute on function public.admin_analytics(integer) to authenticated, service_role;

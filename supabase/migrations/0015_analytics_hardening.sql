-- ============================================================================
-- 0015_analytics_hardening.sql
-- THE MEASUREMENT LAYER GROWS UP: dedupe, retention, session length, crash
-- telemetry, and an ops path — the ring of things a studio pipeline has that
-- 0010/0014 didn't yet.
--
-- ⚠️⚠️ AMENDED BY 0019 — READ THIS FIRST. APPLY 0019 TOGETHER WITH THIS FILE.
-- The dedupe below is HALF a mechanism. The column and the unique index are
-- correct and stay exactly as they are; the WIRE SHAPE this header specifies for
-- using them — `POST /rest/v1/events?on_conflict=event_id` with
-- `Prefer: resolution=ignore-duplicates` — CANNOT EXECUTE against this table and
-- never could. `ON CONFLICT` makes PostgreSQL require SELECT rights on the
-- target, which folds the table's SELECT policies in as an extra WITH CHECK on
-- the row being inserted; `events` deliberately has none (0010), so that check is
-- built from an empty policy list and is a constant false. Every send is refused
-- 42501 → 401, including the first, with nothing to conflict against.
-- Worse than a missing dedupe: core/analytics.ts drops any 4xx that is not a 400,
-- so applying THIS FILE ALONE does not double-count events, it discards all of
-- them. 0019 moves the conflict handling into a SECURITY DEFINER function and
-- the client onto it. Sentences below that describe the on_conflict wire are
-- kept only so the amendment reads against the original — they are WRONG.
-- (This file's SQL is unchanged and still correct; only its prose is amended.)
--
-- WHAT THIS ADDS, and why each piece exists:
--
-- 1. events.event_id + a unique index — IDEMPOTENT INGESTION. The client's
--    flush re-queues a batch when the response is lost (core/analytics.ts), so
--    a POST that actually landed can be re-sent and double-count. Real
--    pipelines carry idempotency keys; ours is a client-minted UUID. NULLABLE
--    on purpose: every pre-0015 client keeps inserting rows without it forever
--    (prompt-mode PWA — see 0008/0009), and a full (non-partial) unique index
--    is what makes that safe: NULLs never collide with NULLs, while duplicate
--    real ids conflict and are ignored (the client posts with
--    on_conflict=event_id + resolution=ignore-duplicates).
--
-- 2. admin_analytics grows retention (D1/D7), session-length, and client_error
--    sections, and its gate now ALSO admits the service_role JWT — that is
--    what lets the weekly digest (scripts/analytics-digest.mjs, run by GitHub
--    Actions with the service key) report the SAME numbers the dashboard
--    shows instead of maintaining a second aggregation that drifts. The claim
--    is read from the VERIFIED JWT (PostgREST sets request.jwt.claims from a
--    token only Supabase can sign), so anon/authenticated cannot forge it.
--
-- 3. prune_events becomes callable by service_role — 0010 revoked it from
--    everyone and left scheduling to pg_cron, which is still not enabled. The
--    weekly Actions job now calls it, so retention (90 days) actually happens
--    instead of waiting for someone to remember.
--
-- DEPLOY ORDER: apply this BEFORE the client that sends event_id ships, per
-- the standing two-phase rule. The client is belt-and-braces resilient anyway:
-- its first 400 flips it into a legacy mode that re-queues (not drops) the
-- batch and strips event_id until the next session — so a wrong order delays
-- events rather than losing them. Do not rely on that; apply first.
--
-- Idempotent-friendly: safe to re-run (IF NOT EXISTS / OR REPLACE).
-- Rollback: drop index if exists events_event_id;
--           alter table public.events drop column if exists event_id;
--           revoke execute on function public.prune_events(integer) from service_role;
--           re-run 0014 to restore the previous admin_analytics.
-- ============================================================================

-- ==========================================
-- 1. Idempotency key
-- ==========================================
alter table public.events add column if not exists event_id uuid;

-- Full unique index, NOT partial: ON CONFLICT (event_id) can only infer a
-- whole-column unique index, and NULLs are distinct so legacy rows never
-- collide. (A partial "where event_id is not null" index would be invisible
-- to the conflict inference and the dedupe would silently not happen.)
create unique index if not exists events_event_id on public.events (event_id);

-- ==========================================
-- 2. prune_events: let the weekly ops job run it
-- ==========================================
grant execute on function public.prune_events(integer) to service_role;

-- ==========================================
-- 3. admin_analytics v2 — same contract, three new sections
-- ==========================================
create or replace function public.admin_analytics(p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    d      integer := least(greatest(coalesce(p_days, 14), 1), 365);
    since  timestamptz;
    today  date := (now() at time zone 'utc')::date;
    -- The caller's JWT role, read the same way auth.role() does — inlined so
    -- this function has no dependency on the auth helper existing.
    jwt_role text := coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    result jsonb;
begin
    -- THE GATE. Two ways in: a signed-in admin (the dashboard), or the
    -- service_role key (the weekly digest job — server-side only, never in a
    -- browser). Everyone else gets 42501 → PostgREST 403.
    if jwt_role is distinct from 'service_role'
       and (auth.uid() is null
            or not exists (select 1 from public.app_admins a where a.user_id = auth.uid())) then
        raise exception 'admin_analytics is admin-only' using errcode = '42501';
    end if;

    since := now() - make_interval(days => d);

    with
    win as (
        select device_id, user_id, session_id, name, props, app_version, created_at,
               -- Day/hour bucketing is EXPLICITLY UTC so this function and the
               -- 0010 events_daily view can never disagree about which day an
               -- event belongs to. (The RACE day is deliberately a different
               -- clock — America/Edmonton since 0013_race_day — so race
               -- standings and analytics days cut at different midnights.)
               (created_at at time zone 'utc') as utc_at
        from public.events
        where created_at >= since
    ),
    first_seen as (
        select device_id, min(created_at) as first_at
        from public.events
        group by 1
    ),
    -- Retention works over the WHOLE retained table, not the window: a D7
    -- answer needs history on both sides of the cohort day.
    device_days as (
        select distinct device_id, (created_at at time zone 'utc')::date as day
        from public.events
    ),
    firsts as (
        select device_id, min(day) as day0 from device_days group by 1
    ),
    ret as (
        select f.day0,
               f.device_id,
               exists (select 1 from device_days x
                        where x.device_id = f.device_id and x.day = f.day0 + 1) as r1,
               exists (select 1 from device_days x
                        where x.device_id = f.device_id and x.day = f.day0 + 7) as r7
        from firsts f
    ),
    sess as (
        select session_id,
               extract(epoch from max(created_at) - min(created_at))::int as secs,
               count(*) as events
        from win
        group by 1
    ),
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
        -- D1/D7 exact-day retention. `eligible` counts only devices whose
        -- day0+N has FULLY elapsed (UTC) — a device first seen yesterday is
        -- not "0% D7", it is not measurable yet, and folding those in would
        -- drag every fresh cohort toward zero.
        'retention', jsonb_build_object(
            'd1', (select jsonb_build_object(
                       'eligible', count(*) filter (where day0 + 1 < today),
                       'returned', count(*) filter (where day0 + 1 < today and r1))
                   from ret),
            'd7', (select jsonb_build_object(
                       'eligible', count(*) filter (where day0 + 7 < today),
                       'returned', count(*) filter (where day0 + 7 < today and r7))
                   from ret),
            'cohorts', coalesce((
                select jsonb_agg(jsonb_build_object(
                    'day', t.day0, 'cohort', t.cohort,
                    'd1', t.d1, 'd7', t.d7,
                    'd1_ready', t.day0 + 1 < today,
                    'd7_ready', t.day0 + 7 < today
                ) order by t.day0 desc)
                from (
                    select day0, count(*) as cohort,
                           count(*) filter (where r1) as d1,
                           count(*) filter (where r7) as d7
                    from ret
                    where day0 >= today - d
                    group by 1
                    order by 1 desc
                    limit 60
                ) t
            ), '[]'::jsonb)
        ),
        -- Session length: how long a sitting actually lasts, and how many are
        -- bounces (opened, barely touched, gone). Buckets are indexed 0..4;
        -- the dashboard owns the labels. secs is capped into the bucket CASE,
        -- so a clock-skewed outlier can't invent a sixth bucket.
        'sessions', (
            select jsonb_build_object(
                'total', count(*),
                'median_seconds', round(coalesce(
                    percentile_cont(0.5) within group (order by s.secs), 0))::int,
                'bounces', count(*) filter (where s.events <= 1 or s.secs < 10),
                'buckets', coalesce((
                    select jsonb_agg(jsonb_build_object('b', b.bucket, 'count', b.count) order by b.bucket)
                    from (
                        select case
                                 when s2.secs < 60   then 0
                                 when s2.secs < 180  then 1
                                 when s2.secs < 600  then 2
                                 when s2.secs < 1800 then 3
                                 else 4
                               end as bucket,
                               count(*) as count
                        from sess s2
                        group by 1
                    ) b
                ), '[]'::jsonb)
            )
            from sess s
        ),
        -- Crash telemetry rollup. `message` is attacker-writable text — the
        -- dashboard renders it via textContent only, and it is length-capped
        -- here as well as by the props guard.
        'errors', (
            select jsonb_build_object(
                'events', count(*) filter (where w.name = 'client_error'),
                'devices', count(distinct w.device_id) filter (where w.name = 'client_error'),
                'top', coalesce((
                    select jsonb_agg(jsonb_build_object(
                        'message', t.message, 'count', t.count, 'devices', t.devices,
                        'versions', t.versions, 'last_seen', t.last_seen
                    ) order by t.count desc)
                    from (
                        select left(coalesce(w2.props->>'message', '?'), 140) as message,
                               count(*) as count,
                               count(distinct w2.device_id) as devices,
                               to_jsonb((array_agg(distinct coalesce(w2.app_version, '?')))[1:4]) as versions,
                               max(w2.created_at) as last_seen
                        from win w2
                        where w2.name = 'client_error'
                        group by 1
                        order by 2 desc
                        limit 30
                    ) t
                ), '[]'::jsonb)
            )
            from win w
        ),
        'deal', (
            select jsonb_build_object(
                'offers',    count(*) filter (where w.name = 'deal_offered'),
                'wins',      count(*) filter (where w.name = 'deal_won'),
                'fast_wins', count(*) filter (where w.name = 'deal_won'
                                                and w.props->>'fast' = 'true'),
                'charms',    count(*) filter (where w.name = 'deal_won'
                                                and w.props->>'charm' = 'true'),
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

-- Grants are inherited from 0014 for existing roles; restated so this file
-- stands alone if 0014's were ever tightened.
revoke all on function public.admin_analytics(integer) from public, anon;
grant execute on function public.admin_analytics(integer) to authenticated, service_role;

-- ============================================================================
-- 0021_analytics_timezone.sql
-- THE DASHBOARD LEARNS TO READ A CLOCK: admin_analytics takes a timezone.
--
-- WHY. Every bucket in 0014/0015 is cut at UTC midnight. For this game that is
-- not a neutral choice: UTC midnight is 18:00-19:00 in Alberta and 19:00 in
-- Central, i.e. it lands INSIDE the evening peak. So a Monday-evening session
-- was being counted on Tuesday's bar, and the owner had to convert every hour
-- in their head besides. Hours could be fixed in the browser (a 24-bucket
-- histogram is just rotated), but a day bucket is a count(distinct device_id)
-- and CANNOT be re-cut from an aggregate — the raw rows never leave the
-- database, by design. That is what forces the timezone server-side.
--
-- WHAT CHANGES. One new parameter, p_tz, defaulting to 'UTC'. At the default
-- this function returns byte-identical output to 0015 — that is the whole
-- safety argument. `daily`, `hourly`, `retention` and the new-device firsts all
-- cut on the SAME clock, so no payload ever mixes two.
--
-- WHAT DOES NOT CHANGE — read this before believing this file is risky:
--   * NO leaderboard object is touched. The race/weekly path is endless_scores,
--     endless_scores_guard, endless_daily_guard, race_day_key, iso_week_key and
--     iso_week_of_day. This function reads public.events and public.app_admins
--     and nothing else, and it is `stable` — it cannot write anything at all.
--   * race_day_key stays America/Edmonton (0013/0020) and iso_week_key stays
--     UTC. Analytics days, race days and race weeks are THREE different clocks
--     on purpose; this file changes only the first, and only when asked.
--   * The 0010 events_daily view stays UTC. It therefore agrees with this
--     function at the default and diverges when a tz is passed — intended, and
--     called out in the body where the bucketing happens.
--
-- WHY A DROP. Postgres treats a changed argument list as an OVERLOAD, not a
-- replacement, so a plain `create or replace` would leave admin_analytics(int)
-- beside the new one and PostgREST could not resolve `{p_days: 14}` between
-- them — the dashboard would start failing "function is not unique". Dropping
-- first is what avoids that. Both statements are in ONE transaction, so no
-- concurrent session ever observes the function missing.
--
-- CACHED CLIENTS (the standing two-phase rule). p_tz has a DEFAULT, so a
-- client that never heard of it calls the new function unchanged and gets UTC —
-- which is exactly what it renders labels for today. APPLY THIS BEFORE
-- deploying the dashboard that sends p_tz: a client ahead of its schema gets
-- PGRST202 (no function matches) and shows an error, rather than wrong numbers.
--
-- Idempotent-friendly: drop if exists + create or replace, safe to re-run.
-- Rollback:
--   drop function if exists public.admin_analytics(integer, text);
--   -- then re-run 0015 to restore the single-argument version, and redeploy
--   -- the pre-0021 dashboard (a p_tz-sending client 404s against the old one).
-- ============================================================================

-- See "WHY A DROP" above: this must precede the create, in the same transaction.
drop function if exists public.admin_analytics(integer);

create or replace function public.admin_analytics(p_days integer default 14,
                                                  p_tz   text    default 'UTC')
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    d      integer := least(greatest(coalesce(p_days, 14), 1), 365);
    since  timestamptz;
    -- The clock every day and hour bucket below is cut on. Length-capped here
    -- and proven to resolve in the body: p_tz arrives from a browser.
    tz     text := left(coalesce(nullif(btrim(p_tz), ''), 'UTC'), 64);
    today  date;
    -- The caller's JWT role, read the same way auth.role() does — inlined so
    -- this function has no dependency on the auth helper existing.
    jwt_role text := coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
    );
    result jsonb;
begin
    -- p_tz is attacker-supplied text heading for AT TIME ZONE. An unknown zone
    -- RAISES, which would take down the entire payload over what is only a
    -- display preference — so prove it resolves once, here, and fall back to
    -- UTC if it does not. It is passed as a VALUE, never interpolated into SQL,
    -- so there is no injection surface to worry about separately.
    begin
        perform now() at time zone tz;
    exception when others then
        tz := 'UTC';
    end;
    today := (now() at time zone tz)::date;

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
               -- Day/hour bucketing is cut on `tz` — 'UTC' unless the caller
               -- asks otherwise, which is what holds every pre-0021 caller (the
               -- weekly digest included) on exactly the numbers it had before.
               -- When a tz IS passed, every bucket in the payload moves together:
               -- days, hours, retention, and new-device firsts. Cutting one
               -- section on a different clock than another is the one thing this
               -- must never do — a day whose hours belong to a different day is
               -- worse than an honestly-labelled UTC chart.
               -- The 0010 events_daily view is always UTC, so it agrees with this
               -- function only at the default. (The RACE day is a third clock
               -- again — America/Edmonton since 0013_race_day — and nothing here
               -- touches it.)
               (created_at at time zone tz) as bucket_at
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
        select distinct device_id, (created_at at time zone tz)::date as day
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
                select w.bucket_at::date as day,
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
                select (f.first_at at time zone tz)::date as day, count(*) as new_devices
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
                select extract(hour from w.bucket_at)::int as hour,
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
        -- day0+N has FULLY elapsed (on `tz`) — a device first seen yesterday is
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

-- Grants restated for the NEW signature — the drop above took the old function's
-- grants with it, so omitting these would leave the dashboard 403ing on its own
-- RPC. anon stays revoked: this returns aggregates, but only the owner's.
revoke all on function public.admin_analytics(integer, text) from public, anon;
grant execute on function public.admin_analytics(integer, text) to authenticated, service_role;

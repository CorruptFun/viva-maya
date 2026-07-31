-- ============================================================================
-- 0022_plinko_by_mode.sql
-- THE PLINKO HISTOGRAM LEARNS WHICH BOARD IT IS LOOKING AT.
--
-- WHY. As of 2026-07-31 the drop rolls TWO different weight tables: numbered
-- levels put 6% of drops on the ×10 edges, ENDLESS puts 8% (core/plinko.ts,
-- PLINKO_SLOTS vs PLINKO_ENDLESS_SLOTS). The existing `plinko.slots` histogram
-- groups by slot alone, so it pools both boards into one distribution and
-- therefore measures NEITHER tuning — a pooled edge rate somewhere between 6%
-- and 8% confirms nothing, because the mix of modes is itself unknown and moves
-- with how people play. The client started sending `endless` on every
-- plinko_played event in the same release, so the data to separate them is
-- already arriving; this is only the read side catching up.
--
-- WHAT CHANGES. Exactly one new key inside the existing `plinko` object:
--
--   'modes': [ {mode, played, top_hits, avg_mult}, … ]
--
-- `top_hits` counts landings paying ×10 or better, so `top_hits / played` per
-- mode is directly comparable against the 6% / 8% the tables were tuned to, and
-- `avg_mult` is the field check on the EV those tables imply (~3.61× numbered
-- with its ticket wells live, ~4.28× endless where they restrike as ×8).
--
-- Grouped off the `endless` PROP, not off the slot index, because slot 0 and
-- slot 8 are the ×10 wells on BOTH boards — the slot number cannot tell you
-- which table produced it. An event whose `endless` prop is missing or not a
-- boolean lands in a VISIBLE 'unknown' bucket rather than being quietly folded
-- into 'numbered': every plinko_played event ever sent carries the prop, so a
-- non-empty 'unknown' means something is wrong and must not be disguised as a
-- real reading. Same discipline as the guard trigger's unknown event-name
-- bucket in 0010.
--
-- WHAT DOES NOT CHANGE — the compatibility argument, in full:
--   * `plinko.slots` is returned BYTE-IDENTICALLY. It is deliberately not
--     re-cut per mode. A cached dashboard reads that array and would render
--     two rows per slot if this file had split it in place; instead the split
--     arrives under a NEW key that old clients do not look for and therefore
--     ignore. This is the two-phase rule applied to a payload shape rather
--     than to a permission.
--   * The SIGNATURE is untouched, so this is a plain `create or replace` with
--     no drop — unlike 0021, which had to drop because it ADDED an argument
--     and would otherwise have left an unresolvable overload. Grants survive a
--     same-signature replace, and are restated below only for idempotence.
--   * No other section of the payload is edited. This file was produced by
--     copying 0021 and changing only the plinko block, so `daily`, `hourly`,
--     `retention`, `levels`, `deal`, `errors`, `shares` and `versions` cannot
--     have drifted.
--   * Still `stable` + `security definer` + `set search_path = public, pg_temp`,
--     still admin-or-service_role gated with 42501, still reads nothing but
--     public.events and public.app_admins, still writes nothing.
--
-- ORDERING. No constraint in either direction. The new key is additive, so this
-- may be applied before or after the dashboard that reads it: an old dashboard
-- ignores `modes`, and a new dashboard treats a missing `modes` as an empty
-- list (coerceAnalytics in src/stats/model.ts is shape-tolerant by design and
-- is tested against a payload without this key).
--
-- Idempotent-friendly: create or replace, safe to re-run.
-- Rollback:
--   -- re-run 0021 verbatim; it restores this exact function without `modes`,
--   -- and a dashboard that expects the key degrades to an empty panel.
-- ============================================================================

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
                ), '[]'::jsonb),
                -- NEW in 0022. Split by the board that produced the landing, so
                -- the 6% (numbered) and 8% (endless) ×10 edge tunings can each
                -- be checked against reality. `slots` above stays pooled and
                -- untouched for cached dashboards; see the header.
                'modes', coalesce((
                    select jsonb_agg(jsonb_build_object(
                        'mode', m.mode, 'played', m.played,
                        'top_hits', m.top_hits, 'avg_mult', m.avg_mult
                    ) order by m.mode)
                    from (
                        select case
                                 -- A visible bucket, never silently 'numbered'.
                                 --
                                 -- `is distinct from`, NOT `<>`. jsonb_typeof of an
                                 -- ABSENT key returns SQL NULL, and `NULL <> 'boolean'`
                                 -- evaluates to NULL — not true — so a plain <> skips
                                 -- this branch and drops prop-less events into the
                                 -- `else` arm, i.e. silently counts them as numbered.
                                 -- Caught by the local fixture, which put a
                                 -- deliberately prop-less event in and got numbered=21
                                 -- where 20 was correct.
                                 when jsonb_typeof(w2.props->'endless') is distinct from 'boolean' then 'unknown'
                                 when (w2.props->>'endless')::boolean then 'endless'
                                 else 'numbered'
                               end as mode,
                               count(*) as played,
                               -- ×10 or better. Every cast is typeof-guarded
                               -- first: props are self-reported, and a forged
                               -- "mult": "ten" must not error the whole payload.
                               count(*) filter (
                                 where jsonb_typeof(w2.props->'mult') = 'number'
                                   and (w2.props->>'mult')::numeric >= 10
                               ) as top_hits,
                               round(avg(case
                                 when jsonb_typeof(w2.props->'mult') = 'number'
                                  and (w2.props->>'mult')::numeric between 0 and 1e6
                                 then (w2.props->>'mult')::numeric
                               end), 2) as avg_mult
                        from win w2
                        where w2.name = 'plinko_played'
                        group by 1
                        order by 1
                        limit 10   -- at most 3 buckets exist; a cap on principle
                    ) m
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

-- Grants restated for idempotence only. Unlike 0021 there is no drop here, and a
-- same-signature `create or replace` PRESERVES existing grants — so these are a
-- no-op on a live database and matter only if this file is ever replayed against
-- one where the function is absent. anon stays revoked: this returns aggregates,
-- but only the owner's.
revoke all on function public.admin_analytics(integer, text) from public, anon;
grant execute on function public.admin_analytics(integer, text) to authenticated, service_role;

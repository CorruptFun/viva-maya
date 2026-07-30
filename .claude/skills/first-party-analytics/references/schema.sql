-- ============================================================================
-- first-party-analytics: schema template (Postgres + RLS, Supabase/PostgREST shape)
-- Adapt names; keep the invariants. Sections: events / guard / admins / RPC / prune.
-- Idempotent-friendly on purpose (IF NOT EXISTS / OR REPLACE) so re-runs are safe.
-- ============================================================================

create table if not exists public.events (
    id          bigint generated always as identity primary key,
    -- Anonymous identity: random UUID minted client-side into localStorage. NOT derived from
    -- the device (that's fingerprinting), NOT auth (that only sees the signed-in minority).
    device_id   uuid not null,
    -- Only while signed in; RLS pins it to auth.uid() below so it cannot be forged.
    user_id     uuid references auth.users(id) on delete set null,
    -- Minted per app open, never persisted — turns the stream into sessions.
    session_id  uuid not null,
    -- Deliberately TEXT, not an enum/FK: cached clients (PWAs!) send yesterday's vocabulary for
    -- weeks; the guard buckets unrecognisable names as 'unknown' instead of rejecting.
    name        text not null,
    props       jsonb not null default '{}'::jsonb,
    -- Which build produced the event — unreadable funnels otherwise under staggered rollouts.
    app_version text,
    -- Idempotency key (client-minted UUID), deduped by the GUARD TRIGGER below — never by
    -- ON CONFLICT: PostgreSQL refuses ANY `INSERT ... ON CONFLICT` for a caller with no SELECT
    -- policy (conflict arbitration must see existing rows), so an upsert wire shape 403s every
    -- batch on this deliberately append-only table. NULLABLE so legacy id-less clients insert
    -- forever; the unique index is the race backstop behind the trigger.
    event_id    uuid,
    created_at  timestamptz not null default now()
);

create index if not exists events_created_at        on public.events (created_at desc);
create index if not exists events_name_created_at   on public.events (name, created_at desc);
create index if not exists events_device_created_at on public.events (device_id, created_at desc);
create unique index if not exists events_event_id   on public.events (event_id);

alter table public.events enable row level security;

-- THE MOST IMPORTANT LINES: an INSERT policy and NO SELECT POLICY, EVER. Append-only to the world.
-- `user_id is null` admits the signed-out majority; `auth.uid() = user_id` stops impersonation.
drop policy if exists "Anyone can append their own events" on public.events;
create policy "Anyone can append their own events"
    on public.events for insert
    with check (user_id is null or auth.uid() = user_id);

-- Guard: bound what an untrusted client can put in a row. Degrade, never throw — an error here
-- surfaces into the app's runtime.
create or replace function public.events_guard()
returns trigger language plpgsql security definer
set search_path = public, pg_temp as $$
begin
    -- IDEMPOTENT INGESTION: a re-sent batch (lost response) inserts nothing the second time.
    -- Lives HERE because definer context can see rows the append-only caller can't — the only
    -- dedupe mechanism compatible with "no SELECT policy" (ON CONFLICT is not; see event_id).
    if new.event_id is not null
       and exists (select 1 from public.events e where e.event_id = new.event_id) then
        return null;  -- silently skip; degrade, never throw
    end if;
    new.name := lower(left(trim(coalesce(new.name, '')), 40));
    if new.name !~ '^[a-z][a-z0-9_]*$' then new.name := 'unknown'; end if;  -- visible, not vanished
    if jsonb_typeof(new.props) is distinct from 'object'
       or length(new.props::text) > 2048 then new.props := '{}'::jsonb; end if;
    new.app_version := left(nullif(trim(coalesce(new.app_version, '')), ''), 32);
    new.created_at := now();  -- the client never chooses when
    return new;
end; $$;
drop trigger if exists events_guard on public.events;
create trigger events_guard before insert on public.events
    for each row execute function public.events_guard();

-- ============================================================================
-- Admin allow-list: RLS on, ZERO policies — the API can neither read nor write it in any role.
-- Membership is granted only via the SQL editor / service role. This is the whole authorization
-- model for reads: a row here is a person, not a role.
-- ============================================================================
create table if not exists public.app_admins (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    note       text,
    created_at timestamptz not null default now()
);
alter table public.app_admins enable row level security;
revoke all on table public.app_admins from public, anon, authenticated;

-- ============================================================================
-- THE READ PATH: one SECURITY DEFINER RPC, AGGREGATES ONLY, admin- or service-role-gated.
-- Everything it touches is hostile: typeof-check before every cast, round() before ::int,
-- length-cap strings, LIMIT every grouped list, clamp p_days. Bucket in EXPLICIT UTC.
-- Skeleton below — extend the jsonb with the product's own panels.
-- ============================================================================
create or replace function public.admin_analytics(p_days integer default 14)
returns jsonb language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare
    d integer := least(greatest(coalesce(p_days, 14), 1), 365);
    since timestamptz;
    today date := (now() at time zone 'utc')::date;
    jwt_role text := coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role');
    result jsonb;
begin
    -- Admin OR the service_role JWT (server-side ops digest) — 42501 lets the dashboard
    -- distinguish "not an admin" from "broken".
    if jwt_role is distinct from 'service_role'
       and (auth.uid() is null
            or not exists (select 1 from public.app_admins a where a.user_id = auth.uid())) then
        raise exception 'admin_analytics is admin-only' using errcode = '42501';
    end if;
    since := now() - make_interval(days => d);

    with
    win as (
        select device_id, user_id, session_id, name, props, app_version, created_at,
               (created_at at time zone 'utc') as utc_at
        from public.events where created_at >= since
    ),
    first_seen as (select device_id, min(created_at) as first_at from public.events group by 1),
    device_days as (select distinct device_id, (created_at at time zone 'utc')::date as day
                    from public.events),
    firsts as (select device_id, min(day) as day0 from device_days group by 1),
    ret as (
        select f.day0, f.device_id,
               exists (select 1 from device_days x where x.device_id = f.device_id
                                                     and x.day = f.day0 + 1) as r1,
               exists (select 1 from device_days x where x.device_id = f.device_id
                                                     and x.day = f.day0 + 7) as r7
        from firsts f
    ),
    sess as (
        select session_id,
               extract(epoch from max(created_at) - min(created_at))::int as secs,
               count(*) as events
        from win group by 1
    )
    select jsonb_build_object(
        'meta', jsonb_build_object('days', d, 'since', since, 'generated_at', now()),
        'totals', (select jsonb_build_object(
            'devices',  count(distinct w.device_id),
            'signed_in',count(distinct w.device_id) filter (where w.user_id is not null),
            'sessions', count(distinct w.session_id),
            'events',   count(*),
            'new_devices', (select count(*) from first_seen f where f.first_at >= since)
        ) from win w),
        'daily', coalesce((
            select jsonb_agg(jsonb_build_object(
                'day', t.day, 'devices', t.devices, 'sessions', t.sessions, 'events', t.events,
                'new_devices', coalesce(n.new_devices, 0)) order by t.day)
            from (select w.utc_at::date as day, count(distinct w.device_id) devices,
                         count(distinct w.session_id) sessions, count(*) events
                  from win w group by 1) t
            left join (select (f.first_at at time zone 'utc')::date as day, count(*) as new_devices
                       from first_seen f where f.first_at >= since group by 1) n using (day)
        ), '[]'::jsonb),
        -- Every name in the window, unfiltered — this is how the 'unknown' bucket gets SEEN.
        'counts', coalesce((
            select jsonb_agg(jsonb_build_object('name', t.name, 'events', t.events,
                                                'devices', t.devices) order by t.events desc)
            from (select w.name, count(*) events, count(distinct w.device_id) devices
                  from win w group by 1 order by 2 desc limit 200) t
        ), '[]'::jsonb),
        -- D1/D7 with HONEST eligibility: only devices whose day0+N fully elapsed.
        'retention', jsonb_build_object(
            'd1', (select jsonb_build_object(
                     'eligible', count(*) filter (where day0 + 1 < today),
                     'returned', count(*) filter (where day0 + 1 < today and r1)) from ret),
            'd7', (select jsonb_build_object(
                     'eligible', count(*) filter (where day0 + 7 < today),
                     'returned', count(*) filter (where day0 + 7 < today and r7)) from ret)
        ),
        'sessions', (select jsonb_build_object(
            'total', count(*),
            'median_seconds', round(coalesce(
                percentile_cont(0.5) within group (order by s.secs), 0))::int,
            'bounces', count(*) filter (where s.events <= 1 or s.secs < 10)
        ) from sess s),
        'errors', (select jsonb_build_object(
            'events', count(*) filter (where w.name = 'client_error'),
            'devices', count(distinct w.device_id) filter (where w.name = 'client_error'),
            'top', coalesce((select jsonb_agg(jsonb_build_object(
                       'message', t.message, 'count', t.count, 'devices', t.devices,
                       'versions', t.versions) order by t.count desc)
                   from (select left(coalesce(w2.props->>'message','?'),140) message,
                                count(*) count, count(distinct w2.device_id) devices,
                                to_jsonb((array_agg(distinct coalesce(w2.app_version,'?')))[1:4]) versions
                         from win w2 where w2.name = 'client_error'
                         group by 1 order by 2 desc limit 30) t), '[]'::jsonb)
        ) from win w)
        -- TODO: add the product's own panels (level funnels, purchase funnels, feature usage…)
        -- following the same shape: typeof-checked casts, LIMIT-bounded groups.
    ) into result;
    return result;
end; $$;

revoke all on function public.admin_analytics(integer) from public, anon;
grant execute on function public.admin_analytics(integer) to authenticated, service_role;

-- ============================================================================
-- Retention pruning. NOT auto-scheduled in a migration (silent deletion is a bad surprise) —
-- grant service_role and call it from the weekly CI job (references/ops.md).
-- ============================================================================
create or replace function public.prune_events(keep_days integer default 90)
returns bigint language plpgsql security definer
set search_path = public, pg_temp as $$
declare removed bigint;
begin
    delete from public.events
     where created_at < now() - make_interval(days => greatest(keep_days, 1));
    get diagnostics removed = row_count;
    return removed;
end; $$;
revoke all on function public.prune_events(integer) from public, anon, authenticated;
grant execute on function public.prune_events(integer) to service_role;

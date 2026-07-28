-- ============================================================================
-- 0012_push_subscription_rpc.sql
-- FIX: a push subscriber could never unsubscribe, and a rotated key could never
-- be refreshed. Both failed SILENTLY — 204 from PostgREST, zero rows affected.
--
-- ⚠️ THE ROOT CAUSE, because it will bite again on any other write-only table:
-- PostgreSQL requires rows to be VISIBLE under a SELECT policy before UPDATE or
-- DELETE can locate them. `UPDATE ... WHERE endpoint = $1` has to FIND the row
-- first, and that lookup is governed by the SELECT policy — not by the UPDATE
-- policy. 0011 deliberately gives this table NO SELECT POLICY AT ALL (endpoints
-- are bearer capabilities and must never be enumerable), so the UPDATE and
-- DELETE policies it does define can never match anything. They are not wrong,
-- they are unreachable.
--
-- That design is correct for `events` (0010), which is append-only and never
-- updated. It is wrong the moment a client must modify its own row.
--
-- WHY NOT JUST ADD A SELECT POLICY: the only one that would work for the
-- signed-OUT majority is `using (true)`, which republishes every push endpoint
-- to every visitor — precisely the enumeration hole 0008/0009 existed to close.
-- `using (auth.uid() = user_id)` would fix signed-in players only and leave the
-- majority unable to opt out, which the privacy policy promises they can.
--
-- THE FIX is the shape 0005 and 0008 already use: the table stays unreadable,
-- and a SECURITY DEFINER function is the sole entry point. Possession of the
-- endpoint IS the authorization — consistent with the trust model 0011 already
-- documents (a push endpoint is a bearer capability by construction; whoever
-- holds it can already notify that device).
--
-- Purely ADDITIVE: adds two functions, removes no access. The two-phase rule
-- (0008/0009) does not apply, so this can land in any order relative to the
-- client deploy. An old cached client keeps issuing its direct writes, which
-- are exactly as ineffective as they already were — no worse.
--
-- Rollback: drop function public.register_push_subscription(text,text,text,uuid);
--           drop function public.unsubscribe_push(text);
-- ============================================================================

-- ==========================================
-- register_push_subscription
-- Upsert on the endpoint. Definer, so it can see the conflicting row.
-- ==========================================
create or replace function public.register_push_subscription(
    p_endpoint  text,
    p_p256dh    text,
    p_auth      text,
    p_device_id uuid
)
returns void
language plpgsql
security definer
-- REQUIRED on every definer function: an unpinned search_path is hijackable by
-- a caller who puts their own `push_subscriptions` earlier in the path.
set search_path = public, pg_temp
as $$
begin
    insert into public.push_subscriptions (endpoint, p256dh, auth, device_id, user_id, week_race)
    values (
        p_endpoint,
        p_p256dh,
        p_auth,
        p_device_id,
        -- Taken from the JWT, NEVER from a parameter. A definer function bypasses
        -- RLS, so accepting a caller-supplied user_id here would let anyone attach
        -- their subscription to somebody else's account and receive that player's
        -- personalised standings.
        auth.uid(),
        true
    )
    on conflict (endpoint) do update
        set p256dh    = excluded.p256dh,
            auth      = excluded.auth,
            device_id = excluded.device_id,
            user_id   = excluded.user_id,
            -- Re-enabling is the whole point of calling this again after opting out.
            week_race = true,
            -- A re-register means the browser handed us a live subscription, so any
            -- past delivery failures are stale. Safe here (and NOT client-forgeable)
            -- because the client cannot reach this column except through this function.
            failure_count = 0;
end;
$$;

-- ==========================================
-- unsubscribe_push
-- Deleting is the honest implementation of "off": no row, no send, nothing
-- retained. Flipping week_race would leave the endpoint stored after the player
-- asked us to stop, which the privacy policy says we don't do.
-- ==========================================
create or replace function public.unsubscribe_push(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    delete from public.push_subscriptions where endpoint = p_endpoint;
end;
$$;

-- Both are reachable by signed-out players by design — the signed-out majority
-- must be able to subscribe AND unsubscribe. Authorization is possession of the
-- endpoint, which is unguessable and unenumerable (0011 grants no SELECT).
revoke all on function public.register_push_subscription(text, text, text, uuid) from public;
revoke all on function public.unsubscribe_push(text) from public;
grant execute on function public.register_push_subscription(text, text, text, uuid) to anon, authenticated;
grant execute on function public.unsubscribe_push(text) to anon, authenticated;

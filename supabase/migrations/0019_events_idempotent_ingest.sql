-- ============================================================================
-- 0019_events_idempotent_ingest.sql
-- THE DEDUPE 0015 ADDED HAS NEVER ONCE RUN — and while it was broken it was not
-- double-counting events, it was DELETING them. This makes it actually work,
-- without giving anything a way to read or rewrite the event log.
--
-- ⚠️ SYMPTOM: every idempotent flush is refused 401. `scripts/verify-rls.sh local`
-- against a stack with 0015 applied:
--     ✗ idempotent insert rejected — is 0015 applied?   got: 401/401
--     ✗ DEDUPE DID NOTHING — a re-sent batch double-counts   got: 0 rows
-- The column and the unique index are both present and correct. The wire shape
-- 0015 designed — `POST /rest/v1/events?on_conflict=event_id` with
-- `Prefer: resolution=ignore-duplicates` — simply cannot be executed by anon:
--     {"code":"42501","message":"new row violates row-level security policy
--      for table \"events\""}
-- BOTH sends fail, including the FIRST, when no conflicting row exists at all.
--
-- ⚠️ AND IT IS WORSE THAN A MISSING DEDUPE. core/analytics.ts treats a 4xx that
-- is not 400 as "this batch will never be accepted" and DROPS it. A 401 on every
-- flush means every event of every session is discarded — the pipe reports
-- nothing at all. The live bundle already ships this wire shape, so applying
-- 0015 to production WITHOUT this file takes analytics dark rather than merely
-- double-counting it. That is the real urgency here.
--
-- ==========================================================================
-- THE ROOT CAUSE — and why the obvious fix is the wrong one
-- ==========================================================================
-- This is 0016's lesson again ("PostgreSQL requires rows to be VISIBLE under a
-- SELECT policy before UPDATE or DELETE can locate them"), but it arrives
-- through a door 0016 never opened, and the intuitive diagnosis is WRONG:
--
--   ❌ "an upsert needs an UPDATE policy, not just the UPDATE grant."
--
-- It does not. Measured on a local stack, all three inside a rolled-back
-- transaction, as `anon`, inserting a row with NO conflicting row present:
--
--   + create policy ... for update using (true) with check (false)  → STILL 42501
--   + create policy ... for select using (false)                    → STILL 42501
--   + create policy ... for select using (true)                     → ✅ INSERTS
--
-- An UPDATE policy changes nothing. The blocker is the missing SELECT policy.
--
-- WHY: `ON CONFLICT` (even `DO NOTHING`) marks the target relation as requiring
-- SELECT rights, because the executor has to look for a conflicting row. When
-- SELECT rights are required, the rewriter folds the table's SELECT policies in
-- as an ADDITIONAL WITH CHECK on the row being inserted. `events` has zero
-- SELECT policies — 0010's most important line — so that check is built from an
-- empty policy list, which becomes a constant FALSE that nothing can satisfy.
-- The give-away is in the error text itself: PostgreSQL names the offending
-- policy when one exists ('violates ... policy "name" for table'). Here there is
-- no name, because there is no policy — the check is unconditionally false.
--
-- So the ONLY policy that makes the direct wire shape work is
-- `for select using (true)` — and that does not merely satisfy the insert, it
-- also republishes the whole table to every holder of the publishable key (i.e.
-- everyone; it ships in the bundle). That is a per-device behavioural history,
-- and it is the exact hole 0008/0009 existed to close. 0010 says it plainly and
-- it still stands: "none should ever be added here."
--
-- `using (false)` does not work either — the check is evaluated against the NEW
-- row, so the policy would have to be TRUE for the row being written, which for
-- the signed-out majority means TRUE for everyone. There is no SELECT policy
-- that admits the insert without also admitting the read. The direct-table
-- upsert path is unsalvageable. It is not tuned here, it is abandoned.
--
-- ==========================================================================
-- THE FIX — the shape 0005, 0008 and 0016 already use
-- ==========================================================================
-- The table stays exactly as 0010 left it (append-only, no SELECT policy, no
-- UPDATE policy) and a SECURITY DEFINER function does the conflict handling on
-- the caller's behalf. A definer function is not subject to the caller's RLS, so
-- it can see the conflicting row that anon may not — which is the whole reason
-- 0016 exists, applied to INSERT instead of UPDATE/DELETE.
--
-- What this deliberately does NOT do:
--   · no SELECT policy on events        — the log stays unreadable
--   · no UPDATE policy on events        — an event, once written, is immutable
--   · no change to 0010's INSERT policy — old cached clients keep working
--
-- Instead it TIGHTENS: the UPDATE/DELETE table grants anon and authenticated
-- hold on `events` (Supabase's default `grant all`, dead weight since 0010 gives
-- them no matching policy) are revoked, so the append-only guarantee no longer
-- rests on the policy list alone. That is belt-and-braces in 0010's own style,
-- and it is what stops the tempting-but-wrong fix above from ever half-working.
--
-- ⚠️ DEPLOY ORDER — purely ADDITIVE, so the two-phase rule (0008/0009) is
-- satisfied in EITHER order, but apply this FIRST anyway:
--   · A client built from this revision calls ingest_events(). Against a server
--     without it, PostgREST answers 404/PGRST202 and the client re-queues and
--     falls back to the direct POST — events are delayed, never lost.
--   · An OLD cached client keeps POSTing directly. 0010's INSERT policy is
--     untouched, so it keeps working exactly as it does today.
--   · The one generation that stays broken is the CURRENTLY LIVE bundle, which
--     sends the 0015 upsert shape and 401s. Nothing server-side can rescue it
--     (see above) — it heals when the player picks up the new build.
--
-- Idempotent-friendly: safe to re-run (OR REPLACE / idempotent revokes).
-- Rollback: drop function public.ingest_events(jsonb);
--           grant update, delete on public.events to anon, authenticated;
-- ============================================================================

-- ==========================================
-- ingest_events — the sole idempotent write path for the event log.
--
-- Takes the whole batch as one jsonb array, so a flush is one round trip, and
-- returns HOW MANY ROWS WERE ACTUALLY INSERTED. That return value is not
-- decoration: it is the only way to prove the dedupe from outside without a
-- service key, which is what lets scripts/verify-rls.sh assert the EFFECT
-- against PRODUCTION. 0015's dedupe check could only ever be verified by an
-- owner holding the secret key, and so in practice was never run there.
-- ==========================================
create or replace function public.ingest_events(p_events jsonb)
returns integer
language plpgsql
security definer
-- REQUIRED on every definer function: an unpinned search_path is hijackable by a
-- caller who puts their own `events` earlier in the path.
set search_path = public, pg_temp
as $$
declare
    -- Canonical UUID text. Used as a GUARD, not a parser: a row whose ids are
    -- malformed is skipped rather than cast, because a failed ::uuid cast raises
    -- 22P02 and would take the entire batch down with it. Same instinct as
    -- 0010's guard trigger — bound the damage, never throw at the game.
    uuid_re constant text :=
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
    -- A flush carries at most MAX_QUEUE (200) events. 500 leaves headroom and
    -- still bounds what one call can cost. Excess elements are IGNORED, not
    -- rejected: dropping the tail of an over-long batch loses less than throwing
    -- the whole thing away. (This is defence in depth, not a new limit — anon can
    -- already POST an unbounded array straight at the table under 0010.)
    max_rows constant integer := 500;
    inserted integer;
begin
    -- jsonb_array_elements() raises on a non-array. The client never sends one;
    -- a hand-rolled caller might.
    if jsonb_typeof(p_events) is distinct from 'array' then
        return 0;
    end if;

    -- `as materialized` is load-bearing, not a hint: it fences the guard from the
    -- casts in the outer SELECT, guaranteeing no ::uuid ever runs on a value the
    -- WHERE clause rejected.
    with src as materialized (
        select e
        from jsonb_array_elements(p_events) with ordinality as t(e, ord)
        where ord <= max_rows
          and jsonb_typeof(e) = 'object'
          and e ->> 'device_id'  ~ uuid_re
          and e ->> 'session_id' ~ uuid_re
          and (e ->> 'event_id' is null or e ->> 'event_id' ~ uuid_re)
    )
    insert into public.events (device_id, session_id, user_id, name, props, app_version, event_id)
    select
        (e ->> 'device_id')::uuid,
        (e ->> 'session_id')::uuid,
        -- ⚠️ FROM THE VERIFIED JWT, NEVER FROM THE PAYLOAD. This is the one line
        -- that makes a definer function safe here. RLS is bypassed inside this
        -- body, so 0010's `auth.uid() = user_id` policy is NOT protecting us —
        -- honouring a caller-supplied user_id would let any anonymous visitor
        -- attribute events to any account, which is strictly worse than the hole
        -- 0010's policy closes. Any `user_id` in the payload is ignored outright;
        -- it cannot be forged because it is never read.
        auth.uid(),
        e ->> 'name',
        coalesce(e -> 'props', '{}'::jsonb),
        e ->> 'app_version',
        (e ->> 'event_id')::uuid
    from src
    -- The dedupe. NULL event_ids (pre-0015 clients) never collide with each
    -- other, so legacy rows all land; a repeated real id lands once. Atomic, so
    -- unlike an EXISTS check it is immune to a re-send racing its own original.
    on conflict (event_id) do nothing;

    -- Rows the unique index swallowed do not count. 0 from a non-empty batch is
    -- therefore the positive proof that dedupe happened.
    get diagnostics inserted = row_count;
    return inserted;
end;
$$;

-- Reachable by signed-out players by design — the signed-out majority is the
-- entire reason this table is keyed on device_id (0010). service_role is not
-- granted: it bypasses RLS and inserts directly.
revoke all on function public.ingest_events(jsonb) from public;
grant execute on function public.ingest_events(jsonb) to anon, authenticated;

-- ==========================================
-- Append-only, now at the GRANT layer too.
--
-- Supabase's default privileges hand anon/authenticated `grant all` on new public
-- tables. Since 0010 defines no UPDATE or DELETE policy, those two have always
-- been unreachable — but they are exactly what makes "just add an UPDATE policy"
-- look like a one-line fix. Revoking them means a future permissive policy
-- added in haste still cannot rewrite or erase an event.
--
-- SELECT is deliberately NOT revoked: 0010's no-SELECT-policy design already
-- returns an empty set, and verify-rls.sh asserts `[]` there specifically to
-- prove RLS is doing the work. Revoking the grant would swap that proof for a
-- permission error and hide the property it is testing.
-- prune_events() is SECURITY DEFINER and so keeps its own DELETE rights.
-- ==========================================
revoke update, delete, truncate on public.events from anon, authenticated;

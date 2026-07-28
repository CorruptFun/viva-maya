-- ============================================================================
-- 0008_referral_code_lookup.sql
-- Add a lookup function for referral codes. ADDITIVE ONLY — this migration
-- changes no existing behaviour and is safe to apply at any time.
--
-- THE PROBLEM (found by an RLS audit on 2026-07-28): `referral_codes` carries
-- `for select using (true)`, so the table is fully ENUMERABLE by anyone holding
-- the publishable key — which is every visitor, because it ships in the client
-- bundle. A stranger can dump every invite code together with the auth UUID of
-- the player who owns it. Confirmed live: an anonymous GET returned real rows.
--
-- The intent was only ever "somebody I gave a code to can resolve it", and that
-- needs lookup-BY-EXACT-CODE, not read-the-whole-table. 0005 already solves the
-- same shape correctly for promo codes: the table is unreadable and a
-- SECURITY DEFINER function is the single entry point. This brings 0004 in line.
--
-- WHY THIS IS SPLIT ACROSS TWO MIGRATIONS. Tightening the policy and shipping
-- the client that needs the function cannot land in the same instant, and the
-- app is a PWA whose service worker pins players to a cached bundle until they
-- accept an update prompt (observed for real earlier the same day). So:
--
--   0008 (this file)  add the function          -> apply NOW, breaks nothing
--   deploy the client  uses the function
--   0009              tighten the SELECT policy -> apply once players updated
--
-- Applying 0009 early would silently break referral registration for anyone
-- still on an old bundle: their direct SELECT would simply return no rows, the
-- code would look dead, and the stash would be cleared as a definitive
-- rejection. That is a data-losing failure, not a retryable one.
--
-- Idempotent-friendly: safe to re-run (OR REPLACE / explicit revoke+grant).
-- ============================================================================

-- ==========================================
-- FUNCTION: resolve_referral_code(code) -> the owner's user_id, or NULL.
--
-- SECURITY DEFINER so it can read a table the caller cannot, with search_path
-- pinned (an unpinned definer function can be hijacked by a caller-controlled
-- search_path — the standard Postgres footgun).
--
-- STABLE, not VOLATILE: it only reads, so the planner may cache it within a
-- statement.
--
-- Normalizes exactly like the client does (`raw.trim().toUpperCase()` in
-- core/referrals.ts) so a code pasted with stray whitespace or in lower case
-- resolves rather than looking dead.
--
-- HONEST LIMIT: this is still a lookup oracle — it answers "is this code real"
-- one guess at a time. That is a deliberate, enormous improvement over handing
-- over the entire table, not a claim of perfection. The keyspace is 36^6 ≈ 2.2
-- billion and EXECUTE is granted to `authenticated` only, so an attacker must
-- hold an account and brute-force one code at a time. If that ever stops being
-- acceptable, the next step is a rate limit or an attempt ledger, not a
-- different function shape.
-- ==========================================
create or replace function public.resolve_referral_code(p_code text)
returns uuid
language sql
security definer
set search_path = public, pg_temp
stable
as $$
    select user_id
    from public.referral_codes
    where code = upper(trim(p_code))
    limit 1;
$$;

-- Anonymous visitors have no reason to resolve a code: the client only ever
-- resolves one at sign-in, when it is already authenticated.
revoke all on function public.resolve_referral_code(text) from public, anon;
grant execute on function public.resolve_referral_code(text) to authenticated;

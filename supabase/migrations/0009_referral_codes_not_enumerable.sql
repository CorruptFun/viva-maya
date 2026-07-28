-- ============================================================================
-- 0009_referral_codes_not_enumerable.sql
-- Close the enumeration hole: `referral_codes` becomes own-rows-only.
--
-- *** DO NOT APPLY THIS UNTIL BOTH ARE TRUE ***
--   1. 0008 is applied (resolve_referral_code exists), AND
--   2. the client that CALLS it has been deployed and players have picked it up.
--
-- Why the wait is real and not ceremony: the app is a PWA with
-- `registerType: 'prompt'`, so a player keeps running a cached bundle until
-- they accept the update toast. A client that predates 0008's rollout resolves
-- codes with a direct `select ... eq('code', …)`. The moment this migration
-- lands, that SELECT returns zero rows for anyone else's code — and
-- `maybeRegisterReferral` reads "no owner" as a DEFINITIVE rejection (dead
-- code), so it CLEARS the stashed code. The referral is lost, silently, and
-- retrying will not bring it back because the stash is gone.
--
-- So the ordering is not "nice to have": applying this early destroys pending
-- referrals for un-updated players.
--
-- ROLLBACK: re-create the permissive policy (kept here, commented, so the
-- undo does not have to be reconstructed under pressure):
--
--   drop policy if exists "Users read own code" on public.referral_codes;
--   create policy "Anyone can resolve codes"
--       on public.referral_codes for select using (true);
--
-- Idempotent-friendly: safe to re-run.
-- ============================================================================

-- The permissive policy this replaces: `for select using (true)` — the whole
-- table, including every owner's auth UUID, readable with the publishable key.
drop policy if exists "Anyone can resolve codes" on public.referral_codes;

-- Own row only. This is what `mintMyCode` needs (it reads/re-reads the caller's
-- own code by user_id); resolving SOMEBODY ELSE's code now goes exclusively
-- through resolve_referral_code() from 0008.
drop policy if exists "Users read own code" on public.referral_codes;
create policy "Users read own code"
    on public.referral_codes
    for select
    using (auth.uid() = user_id);

-- INSERT ("Users mint own code") is deliberately untouched, and there are still
-- no UPDATE/DELETE policies, so codes remain immutable by deny-by-default.

# Go-Live Checklist — social & economy features

The game runs fully offline with everything below DORMANT. These steps light up cloud
save, the weekly race, the champion prize, and referrals on the live deployment.

## 1. Database (Supabase SQL editor — paste in order; all idempotent, safe to re-run)
1. `supabase/migrations/0001_saves.sql` — per-user cloud saves (if not already applied)
2. `supabase/migrations/0002_endless_leaderboard.sql` — `endless_scores` + RLS + guard
3. `supabase/migrations/0003_champion_scored_at.sql` — fair-tiebreak column + index
4. `supabase/migrations/0004_referrals.sql` — `referral_codes` + `referrals` + guards

## 2. Environment
Set repo Actions variables (already wired into `.github/workflows/deploy.yml`):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The anon key is safe to ship — RLS is
the security boundary (deny-by-default; every policy is owner-scoped except the
deliberate leaderboard SELECT and referral-code resolve).

Google OAuth must be enabled in Supabase Auth (see `CLOUD_SAVE_GOOGLE_SIGNIN.md`).

## 3. What activates when
- Env vars absent → 100% dormant; game is local-only (current behaviour).
- Env set, player signed out → cloud UI invites sign-in; race panel shows the
  signed-out invite; nothing is submitted.
- Signed in → saves sync; weekly bests mirror to the leaderboard on the existing save
  push (no new traffic path); referrals register/qualify on that same beat; champion
  check runs on Home entry after a week closes.

## 4. Post-deploy smoke test (live URL)
1. Sign in on two accounts (two browsers); play one endless run each → both appear in
   the WEEKLY RACE panel with correct ranks.
2. `?ref=<your code>` in a fresh profile → sign in → reach level 5 → referrer gets the
   friend-joined toast (+300 + hearts), friend gets the welcome (+150) in the store.
3. Win levels until the jackpot meter fills → wheel fires, payout lands in balance.
4. Trigger a MEGA WIN (cascade ×4) → "+3 FREE SPINS" ticket → DAILY BONUS badge →
   chained free spins at the cabinet.
5. After the ISO week rolls over (Mon), the closed week's #1 sees the coronation once.

## 5. Rollback notes
Everything client-side degrades to dormant if env vars are removed. The SQL objects
are additive; leaving them in place with a dormant client is harmless. Save-schema
changes are shape-tolerant and backward-compatible (older saves coerce cleanly;
hearts above the new 5-max clamp down once).

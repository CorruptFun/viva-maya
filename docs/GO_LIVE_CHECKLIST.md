# Go-Live Checklist — social & economy features

The game runs fully offline with everything below DORMANT. These steps light up cloud
save, the endless race (daily boards + weekly season), the prizes, and referrals on the
live deployment.

## 1. Database (Supabase SQL editor — paste in order; all idempotent, safe to re-run)
1. `supabase/migrations/0001_saves.sql` — per-user cloud saves (if not already applied)
2. `supabase/migrations/0002_endless_leaderboard.sql` — `endless_scores` + RLS + guard
3. `supabase/migrations/0003_champion_scored_at.sql` — fair-tiebreak column + index
4. `supabase/migrations/0004_referrals.sql` — `referral_codes` + `referrals` + guards
5. …through `0011_push_subscriptions.sql`
6. `supabase/migrations/0012_endless_daily.sql` — `endless_daily_scores` + the
   `endless_weekly_totals` view + the per-day guard. **Self-checking:** it refuses to apply if the
   server's UTC day, or its day→ISO-week rollup, disagrees with `src/core/endless.ts`

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
- Signed in → saves sync; TODAY's best mirrors to the leaderboard on the existing save
  push (no new traffic path — earlier days were already mirrored when they were set, and the
  server refuses any day but the current one); referrals register/qualify on that same beat;
  the daily-winner and weekly-champion checks run on Home entry after a board closes.

## 4. Post-deploy smoke test (live URL)
1. Sign in on two accounts (two browsers); play one endless run each → both appear on the
   race panel's TODAY tab with correct ranks, and on THIS WEEK with a "· 1d" turnout.
2. `?ref=<your code>` in a fresh profile → sign in → reach level 5 → referrer gets the
   friend-joined toast (+300 + hearts), friend gets the welcome (+150) in the store.
3. Win levels until the jackpot meter fills → wheel fires, payout lands in balance.
4. Trigger a MEGA WIN (cascade ×4) → "+3 FREE SPINS" ticket → DAILY BONUS badge →
   chained free spins at the cabinet.
5. After 00:00 UTC, yesterday's #1 sees the DAILY WINNER coronation once (+150); after the ISO
   week rolls over (Mon), the closed week's #1 sees the WEEKLY CHAMPION one (+1,000). A Monday
   that closes both shows the weekly ceremony first, then the daily.
6. Play on two consecutive days → THIS WEEK shows the two days' scores ADDED, with "· 2d".

## 5. Rollback notes
Everything client-side degrades to dormant if env vars are removed. The SQL objects
are additive; leaving them in place with a dormant client is harmless. Save-schema
changes are shape-tolerant and backward-compatible (older saves coerce cleanly;
hearts above the new 5-max clamp down once).

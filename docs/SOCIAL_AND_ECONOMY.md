# Social & Economy Systems

The reference for every reward loop, social feature, and fairness rule added in the
2026-07 overhaul rounds. Code is the source of truth; this explains the *why* and maps
every tunable to its home. (Neutral wording throughout — no third-party game is named
anywhere in this repo by policy.)

## The economy at a glance

```
level wins ──► chips ──► boosts/helpers (Gift Store, in-level power bar)
     │            ▲
     │            ├── jackpot wheel payouts (meter fills 1 notch/win)
     │            ├── weekly champion purse (1,000, one player/week)
     │            ├── referral rewards (300/friend · 150 welcome)
     │            └── daily check-in (streak-scaled chips 10→150 + a boost / free-spin prize)
     │
     ├──► jackpot meter ──► wheel fires after the win that fills it
     └──► MEGA WIN (cascade ≥4) ──► free spins (3 or 6) ──► daily-cabinet prizes
```

Chips are a **closed loop**: earned only, never purchased. That single property means
every fixed-size faucet above is inflation-safe regardless of player count.

## Lives (energy)

5 hearts max; one regenerates every 20 minutes (empty → full ≈ 100 min). **Only a loss
or mid-level quit costs a heart — wins are always free** (the game's signature mercy
rule; keep it). Losses on levels 1–9 are also free (`LIVES_GRACE_LEVELS` — beginners
learn without stalling; scarcity begins once a player is invested). Old saves holding
6–10 hearts clamp to 5 on first load after upgrade. Endless never costs hearts.

## Free spins

A MEGA WIN banks free spins of the daily-bonus cabinet: cascade ×4 → 3 spins, ×6+ → 6
(`FREE_SPIN_AWARDS`, best-first). Earnable in **numbered levels only — never endless**:
the endless board is deterministic (same weekly seed for everyone), so a memorized
cascade line would be an infinite-spin printer. Caps: 6 earned/day, 12 banked. Free
spins bypass the daily latch and never touch the streak or `lastSpinDate`; the cabinet
chains spins while the bank lasts (accelerating bulb chase per consecutive spin) and
the Home DAILY BONUS button wears a "×N FREE SPINS" badge while any are banked.

## Daily check-in chips

Every daily bonus pull also banks **chips**, scaled by the spin streak — the diagram's "chips" faucet,
made dependable. The reward climbs across a 7-day week and **resets with the week**, indexed by
`((streak − 1) % 7)` — the same wrap the §D3 week strip draws, so the day-7 payday lands exactly as the
7th dot lights and starts fresh on day 8. Default ladder (`CHECKIN_CHIPS`, `src/core/daily.ts`):
`10 · 15 · 25 · 40 · 60 · 90 · 150`. Chips bank onto the same save `performSpin` persists
(award-before-animation, like the boost), so a mid-celebration close can't lose them; the
DailyBonusScene celebration shows the rose "+N CHIPS" beat.

Why a repeating week rather than an ever-climbing flat cap: the ladder's **steady state** is what a
committed daily player earns forever (~56 chips/day, ~390/week). A permanent 150/day cap (~1,050/week)
would rival the one-per-week champion purse (1,000) and trivialize the Gift Store sinks (boosts 40–120);
the weekly reset keeps the exciting 150 "payday" while holding the average to a *supplement* of level-win
income (~33/day) — real pull, inflation-safe by construction (a fixed per-day faucet). The whole curve
is that one array. A banked **free spin never pays check-in chips** (it bypasses the daily latch/streak,
so a hoard of free spins can't farm them).

## Jackpot meter & wheel

Each level win charges the meter one notch; the win that fills it arms the wheel, which
fires from the win card's Continue. The wheel is the game's biggest single moment:
anticipation spin-up → long deceleration with per-wedge ticks → a near-miss almost-stop
on the neighbouring wedge → detent spring → screen-wide payoff (gold burst, chip
fountain landing physically in the balance readout, marquee typography). The landing is
**honest**: the rigged angle is chosen award-first and the pointer genuinely ends on
the paying wedge (`?wedge=N` DEV pin exists to prove it). Near-full meters (one win
away) glow on the shared heartbeat clock — the "one more win" tease.

## Weekly race (leaderboard)

Everyone plays the SAME endless board each ISO week (seeded from the week key) with the
same 30-move budget and **no boosts allowed in endless** — that rule is the race's
constitution; new boost features can never corrupt fairness while it holds. Weekly
bests mirror to the shared `endless_scores` table automatically when a signed-in
player's save syncs (no separate traffic path). The WEEKLY RACE panel (Home module →
tap the standings line) shows the podium, your highlighted row, your rank when outside
the top, and last week's champion crown row.

- Privacy: only user id, sanitized display name, week key, and score ever leave the
  device. Cloud saves themselves are owner-readable ONLY (RLS) — the leaderboard is a
  deliberate, minimal shared surface, never a window into saves.
- Ties: competition ranking; a shared top score goes to whoever reached it FIRST
  (`scored_at`, stamped only when a score rises — renames can't move standings).

## Weekly champion

When a week closes, its #1 earns the champion tier: **1,000-chip purse** (~a month of
level-win income; one winner/week ⇒ inflation-safe), a crown by their name all next
week, and a coronation ceremony on Home (once, latched in the cloud-synced save so a
second device can't double-award; award happens AFTER the ceremony, so a crash simply
re-offers). Prize structure is a DATA table (`PRIZE_TIERS`) — adding top-3/top-10
tiers later is adding rows, not plumbing. If the player base ever outgrows tiers, the
next step is league brackets (~30-player groups); the schema already supports it
(everything is rank-per-week queries).

## Referrals

Every player can mint a 6-char invite code; the share link is `<game-url>/?ref=CODE`.
The friend's client stashes the code at first boot, registers the referral after
Google sign-in, and the referral **qualifies when the friend passes level 5** (real
play, not a click). Rewards: referrer +300 chips AND a full hearts refill per
qualified friend (max 20 lifetime); friend +150 chips welcome. Both sides land as
celebration moments (Home toast queue / store welcome toast). Abuse fences: one
referral per account EVER (PK), self-referral blocked in the schema, timestamps
set-once and server-clocked, claim only after qualify, caps client-side.

## Promo / reward codes

Referrals bring NEW users in via a link; **promo codes** reward EXISTING users who type a code you
handed out (a returning-player gift, a creator code, a holiday drop). A signed-in player opens the
Gift Store → **ENTER CODE** → types the code; the reward (chips / full hearts / a boost) lands in the
save. You mint codes from the Supabase SQL editor (`insert into promo_codes …`, see
`supabase/migrations/0005_promo_codes.sql`) and can cap, expire, or retire each one.

Codes are **server-validated and secret**: redemption goes through the `redeem_promo(code)` SECURITY
DEFINER function, which alone can read the (deny-by-default RLS) `promo_codes` table — so a client can
never enumerate codes — and the `(code, user_id)` PK on `promo_redemptions` enforces **once per
account**. `max_redemptions` gives an optional global lifetime cap. This keeps codes an
**owner-controlled, inflation-safe faucet** (they're granted, never purchased — iron rule #1 holds),
and dormant-safe: cloud-off / signed-out / offline all degrade to a friendly message, never a throw.

## Trust model (v1) and the hardening path

All submissions (scores, qualifications, claims) are self-reported by signed-in
clients. RLS confines every writer to its own rows; server triggers make scores
monotonic and timestamps set-once — so nobody can touch anyone else's data, but a
modified client could inflate its OWN numbers. Acceptable at family-and-friends
scale. If stakes ever rise: the endless race is fully deterministic (seed + move
list), so server-side replay validation (submit moves, server replays the board) is
the designed hardening path — see `Supabase_Architecture.md`.

## Multi-device notes

`mergeSaves` keeps a WHOLE record (furthest-progressed wins) — never a field-wise
merge. Claim latches (champion weeks, referral welcome, free-spin bank) ride the
winning record. Worst case for a lost latch is a re-offered celebration or a purse
that re-grants after having been overwritten — self-healing, never a permanent loss.

## Tuning table — every knob and where it lives

| Constant | Value | File |
|---|---|---|
| `LIVES_MAX` | 5 | `src/config.ts` |
| `LIFE_REGEN_MS` | 20 min | `src/config.ts` |
| `LIVES_GRACE_LEVELS` | 10 | `src/config.ts` |
| `CHAMPION_PURSE` | 1000 | `src/core/leaderboard.ts` |
| `PRIZE_TIERS` | [rank 1 → 1000] | `src/core/leaderboard.ts` |
| `FREE_SPIN_AWARDS` | ×4→3 · ×6+→6 | `src/core/daily.ts` |
| `CHECKIN_CHIPS` | 10·15·25·40·60·90·150 (7-day, repeats) | `src/core/daily.ts` |
| `FREE_SPIN_DAILY_CAP` / `FREE_SPIN_BANK_CAP` | 6 / 12 | `src/core/save.ts` |
| `QUALIFY_LEVEL` | 5 | `src/core/referrals.ts` |
| `REFERRER_CHIPS` / `REFEREE_CHIPS` | 300 / 150 | `src/core/referrals.ts` |
| `REFERRAL_CAP` | 20 lifetime | `src/core/referrals.ts` |
| Promo codes | owner-minted (chips/hearts/boost) | `supabase/…/0005_promo_codes.sql` · `src/core/promo.ts` |
| Win payout | stars×8 + leftover×2 | `src/scenes/GameScene.ts` |
| Boost prices | 40–120 / helpers 8–35 | `src/core/store.ts` |
| `ENDLESS_MOVES` / unlock | 30 / level 30 | `src/core/endless.ts` |

## Iron rules (do not bend without redesigning around them)

1. **Chips stay earned-only.** The moment they're purchasable, every faucet above
   needs an economist.
2. **Endless stays boost-free.** It's the leaderboard's fairness foundation.
3. **Free spins never come from endless.** Deterministic board ⇒ farmable.
4. **Award after celebration, latch in the save.** Crashes re-offer; nothing
   double-grants.
5. **Every cloud path honors the dormant contract** — unconfigured builds must run
   byte-identical to offline, and nothing may ever throw into the game.

# Gift Store — build note

A closed-loop **in-game store** where the player spends earned **chips** on consumable
**boosts** for their next level. No real money, no cash-out, no crypto — chips are earned
only by winning and have no monetary value. This is the sink that gives the earned-chip
balance a purpose.

Built on top of `main` @ `3094e3a` (300-level build, theme picker P8, save v7). Lives on
the `feature/gift-store` branch so it can be reviewed and merged into the game cleanly.

## What it does
- New **GIFT STORE** button on Home (paired beside LEVELS) → opens the store scene.
- Store lists 5 boosts; each shows an icon, a one-line blurb, and a chip price.
- Tapping a price: if affordable, deducts chips, queues the boost for the next numbered
  level (the same `pendingBoosts` pile the daily spin feeds), pops the balance, flies a
  chip into it, and shows a green "added — applies next level" toast. If not affordable,
  the price pill is ghosted; tapping it thuds + shakes + shows "Not enough chips" and the
  save is left completely untouched (no partial spend, no phantom boost).
- Reduced-motion aware (no fly/shake/toast-slide); theme-aware backdrop text.

## Economy
Priced against the ~25–45 chips a win pays (`stars*8 + movesLeft*2`, see `GameScene.finishWin`):

| Boost         | Type          | Price |
|---------------|---------------|-------|
| +5 MOVES      | `extraMoves`  | 40    |
| WILD REEL     | `wildReel`    | 60    |
| DICE BOMB     | `diceBomb`    | 75    |
| DOUBLE SCORE  | `doubleScore` | 90    |
| JACKPOT CHIP  | `jackpot`     | 120   |

Boosts stack: buying several before a level applies them all at once on the next numbered
level start (`GameScene.applyBoosts` consumes the whole pile; endless never consumes it).

## Cosmetics are intentionally NOT sold here
Themes stay **free and progress-unlocked** via the existing theme picker
(`view/theme.ts` `themeUnlocked` — Rose Midnight at L10, Neon Vegas past L30). The store is
boosts-only by design, so the picker's "always free, never chip-priced" contract is untouched.

## Files
- `src/core/store.ts` — **new.** Pure logic (no Phaser), mirrors `core/daily.ts`. The boost
  catalogue (`BOOST_ITEMS`) + `buyBoost(item)` (atomic load→spend→queue→persist, returns the
  new balance or `{ ok:false, reason:'insufficient' }`). Unit-testable.
- `src/scenes/StoreScene.ts` — **new.** The `'store'` scene, sibling to `DailyBonusScene`:
  cross-fade in, back to Home, live balance pill, 5 cards, buy/deny feedback.
- `src/core/save.ts` — comment-only: chips are no longer "never spent" (no schema change; the
  `chips` field already existed, still v7).
- `src/scenes/HomeScene.ts` — the LEVELS row became a two-up LEVELS + GIFT STORE row.
- `src/main.ts` — registered `StoreScene` in the scene list.

## How to extend later
- Add cosmetics if desired (would need an owned-items store in save + reconciling with the
  theme picker's unlock model — see the "Progress OR chips" option we discussed).
- Add a "boosts queued: N" indicator on the store or Home if stacking gets used heavily.

## Verified
- `tsc --noEmit` clean; `npm run build` green.
- Core logic exercised against the real bundle: buy deducts + queues; insufficient leaves the
  save untouched.
- Driven in-browser: Home→Store nav, all 5 cards render, buying +5 MOVES took 300→260 chips,
  queued `extraMoves`, updated the balance pill, and showed the confirmation toast.

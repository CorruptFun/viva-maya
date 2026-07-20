# In-level helpers (power bar) — build note

A mid-level **helper shelf** below the jackpot meter where the player spends earned **chips** on
consumables that apply to the level **being played** — top up moves so you don't run out, or drop a
targeted bomb to clear a spot. No real money, no cash-out: chips are earned only by winning and have
no monetary value. This complements the **Gift Store** (`docs/GIFT_STORE.md`), which queues boosts for
the *next* level; the power bar helps the level in front of you *right now*.

## What it does
- New **HELPERS** shelf at the bottom of the game screen (below the jackpot meter), numbered levels
  only — endless stays a boost-free fairness race (planting/altering the shared board would break it).
- Three items, cheapest → priciest: **+1 MOVE** (8 chips), **+5 MOVES** (30, better value per move),
  **BOMB** (35). Each is a chunky pressable with a chip price beneath; affordable pills read gold, the
  rest ghost.
- **Moves top-ups** add straight to the live move counter (restoring the "plenty" colour + stopping the
  ≤3 urgent pulse), play the coin sound, and fly a chip into the HUD balance.
- **BOMB** arms an **aim mode**: a pulsing gold frame round the board + a "TAP A TILE — 3×3 BLAST"
  prompt + a **CANCEL** that refunds the chips. The next board tap fires a free 3×3 blast at that tile —
  *no move spent* — run through the normal detonation → cascade → scoring → objective pipeline, so it
  clears goal symbols and chains any special caught in the blast (exactly like a matched Dice Bomb).
- Insufficient chips: a thud + red "Not enough chips" toast + a shake of the tapped button; the save is
  left completely untouched (atomic spend — no partial deduct, no phantom grant).
- Buys are idle-only (the bar dims mid-resolve, hides under the win/lose card). Reduced-motion,
  haptics, and mute aware throughout.

## Economy + anti-farm
Priced against the ~25–45 chips a win pays (`GameScene.finishWin`). Purchased moves must never become a
star/chip farm, so `purchasedMoves` is tracked and **subtracted** from the win's grade math:

```
earnedLeftover = max(0, movesLeft − purchasedMoves)
stars      = by earnedLeftover / spec.moves      (≥50% → 3★, ≥25% → 2★, else 1★)
movesBonus = earnedLeftover × 60
chipReward = stars × 8 + earnedLeftover × 2
```

So buying moves can win a level you'd otherwise lose, but it can't inflate stars or pay out more chips
than you spent. A clean in-budget run (`purchasedMoves === 0`) is unaffected — identical to before.

## Files
- `src/core/store.ts` — **added** `PowerType` / `PowerItem` / `POWER_ITEMS` (the catalogue only; pure,
  unit-testable, mirrors `BOOST_ITEMS`). The spend + effect live elsewhere (the effect needs the board).
- `src/core/save.ts` — **added** `spendChips(price)`: atomic load→check→deduct→persist, returns the new
  balance or `null` when broke (sibling to `addChips`; does NOT queue a pendingBoost).
- `src/core/board.ts` — **added** `detonate(center, radius)`: seeds a square blast and floods through the
  existing private `chainExpand`, returning a `ClearWave` (chains specials for free). No match required,
  no special created. Mirrors `swapActivation`'s shape.
- `src/scenes/GameScene.ts` — the power bar (`buildPowerBar` / `renderPowerItems`), buy/deny/toast/
  chip-fly feedback, the bomb aim mode (`armBomb` / `showBombAim` / `cancelBombAim` /
  `detonatePurchasedBomb`), the `onDown` aim tap, the `update()` dim, and the `finishWin` anti-farm math.

## Verified
- `tsc --noEmit` clean; `npm run build` green.
- `board.detonate` exercised against the real core bundle (11/11): interior 3×3 clears 9, corner clears
  4, radius-2 clears 25, a jackpot chip caught in the blast chains a jackpot event (+colour), cleared
  entries carry distinct piece ids/coords.
- Driven in a real headless Chromium against the live `GameScene` (20/20): the bar renders 3 buttons
  below the jackpot; +1 MOVE 37→38 (−8 chips), +5 MOVES →43 (−30), BOMB arms/hides shelf (−35); the
  detonation scored points, decremented objectives (21,21 → 20,19), spent NO move, and restored the
  shelf on idle; buying with 0 chips granted nothing and left the balance at 0.

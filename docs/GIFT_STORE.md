# Gift Store — build note

A closed-loop **in-game store** where the player spends earned **chips** on consumable
**boosts** for their next level. No real money, no cash-out, no crypto — chips are earned
only by winning and have no monetary value. This is the sink that gives the earned-chip
balance a purpose.

Built on top of `main` @ `3094e3a` (300-level build, theme picker P8, save v7).

> ⚠️ **The `feature/gift-store` branch is NOT this feature's home any more, and must never be
> merged.** The store shipped to `main` long ago; that branch has since become the Viva Ton fork
> (Telegram/TON rebrand, renames `package.json`) and merging it would rebrand the live game and
> revert a hundred-plus commits. See the repo `CLAUDE.md`.

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

Boosts stack, but **not without limit** — this line used to say the whole pile is consumed and
that has not been true since `DIFFICULTY.economy.boostApplyMax` gained a reader. A level takes at
most 3 (and at most 1 JACKPOT CHIP); the surplus **stays banked in order** rather than evaporating
on whatever level happened to be next. Endless never consumes any of it — it is a boost-free
fairness board.

The player is not a passenger in that decision any more. See **The stash** below.

## Cosmetics are intentionally NOT sold here
Themes stay **free and progress-unlocked** via the existing theme picker
(`view/theme.ts` `themeUnlocked` — Rose Midnight at L10, Neon Vegas past `ENDLESS_UNLOCK_LEVEL`,
which is **10** since 2026-08-03, not the 20 an older draft of this note recorded). The store is
boosts-only by design, so the picker's "always free, never chip-priced" contract is untouched.

## The stash (added 2026-08-03)

Boosts were invisible: they landed in `pendingBoosts`, applied themselves at the next level start
behind a toast that faded, and Home showed one line naming neither what nor how many. A player
asked *"where does it go, where do I see my stash, and how do I use it?"* — and, seeing an
identically-named item priced on the in-level shelf, reasonably concluded he was being **charged
for his own winnings**. He was not; `applyBoosts` has never deducted anything.

What changed:

- **`BOOST_META` (`core/inventory.ts`) is now the only place a boost is named**, and both this
  store's table and the free prize table read from it. Three separate things were once called
  "+5 MOVES". `inventory.test.ts` pins them together.
- **A stash panel** (`view/stash.ts`) showing what you own, what is marked NEXT, and — when you
  own more than a level can take — that the surplus is *kept*, not lost.
- **Two doors:** the line under LUCKY SLOTS on Home (which now NAMES what is going in, e.g.
  `next level: +5 MOVES · WILD REEL +1`), and a gift chip in the LEVELS header, so a player who
  starts a level from the grid still passes the stash.
- **Choose what goes in:** tapping a tile flips whether that type is used. Promotion reorders
  `pendingBoosts` (consumed from the front); exclusion is `heldBoosts`, a set of TYPES. Neither
  introduces a second inventory to keep in sync across grants, spends and device merges. A held
  type **frees its slot** rather than wasting one.
- **Store rows show `YOU OWN n`**, so a price tag never looks like a charge for something you
  already have.
- **The in-level HELPER shelf spends a stashed boost before chips** where one is genuinely
  equivalent — only `moves5 ← extraMoves`. `BLAST` is deliberately *not* `DICE BOMB`: a Dice Bomb
  is a planted piece you must match, BLAST is an immediate aimed 3×3. The shelf's purchased-move
  cap applies either way, so paying with a won boost changes the price, never the ceiling.

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

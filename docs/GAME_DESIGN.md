# Viva Maya — Game Design & Mechanics Reference

Casino match-3 PWA (Phaser 3.90 + Vite 7 + TS strict). Live: https://corruptfun.github.io/viva-maya/
Repo: github.com/CorruptFun/viva-maya · Local: `~/Creative/viva-maya/` (Mac mini)
This file is the canonical mechanics reference — keep it updated when rules change.

## Pillars
- The match-3 board IS the game. Everything else is a doorway back into it.
- Additions must create reasons to RETURN, never chores to clear. A light lives/energy pool
  (lose-only, self-refilling — see Lives) paces sessions and pulls players back. NO REAL-MONEY
  purchases, NO cash-out, NO meta-building. The one spendable currency is CHIPS — earned only by
  winning, with no monetary value — spent on consumable boosts in the Gift Store (next level) and
  the in-level helper bar (this level; see "In-level helpers"). Lives still regenerate for free.
  (Direction change 2026-07-17: the earlier "no energy systems" rule was reversed at the owner's
  request — energy that forces a short break is now a wanted return hook.)
  (Direction change 2026-07-20: mid-level chip spending — the in-level helper bar — added at
  the owner's request. "No pay-to-win" now means "no PAY-WITH-CASH"; earned chips may buy help.)
- Warm "modern slot screen" look: off-white #f6f3ec, gold #f2b234/#c9930a, rose #d3304f,
  navy #26304d, system-emoji symbols. Heart motif = Maya tribute (name carries it; no
  explicit dedication text in product copy).

## Board & matching (src/core/board.ts — pure TS, no Phaser imports)
- 8×8 grid (config.ts: ROWS/COLS/CELL=80, board at BOARD_X=40, BOARD_Y=300, design 720×1280).
- Symbols: cherry 🍒, seven (styled red 7), diamond 💎, bell 🔔, clover 🍀, bar (navy pill).
  Levels 1–3 use first 5; level 4+ all 6 (levelSpec.symbolCount).
- Swap adjacent pieces via swipe (drag ≥ 0.3·CELL) or tap-select→tap-adjacent. Invalid swaps
  snap back (no move consumed). A swap is valid if it creates a run ≥3 OR activates specials.
- Board generation: never spawns pre-existing matches; guarantees ≥1 valid move; reshuffles
  (regenerate) when no valid move remains — carrying any SPECIALS on the board onto the new layout
  (kind only; each cell keeps the fresh fill's symbol, so it stays match-free and a reshuffle can
  never confiscate a Wild Reel/Dice Bomb/Jackpot Chip). findFirstValidMove doubles as the
  autoplay/hint engine.
- Resolve loop (GameScene state machine): idle → swapping → resolving (wave→gravity→refill,
  repeat while matches exist) → idle | ended. Cascade counter increments per wave.

## Special pieces
Created at the swapped cell when possible, else run intersection, else run middle.
Specials keep their symbol (still match by color); Jackpot is colorless (never in runs).
Match-created specials are blast-protected during their birth wave — BUT if a live special is
already standing on that birth cell, it detonates first and its blast rides along in the same wave
(blastOf, computed before the overwrite; carried events lead ClearWave.events). So swiping a Wild
Reel into a match-4 gives you both the line blast and the upgrade. Fixed 2026-07-25 (6ab80b5) —
before that the old special was overwritten in silence and never fired.

| Shape | Piece | Effect |
|---|---|---|
| 4 in a row | Wild Reel (chevrons) | Clears full line PERPENDICULAR to the match |
| L/T (two crossing runs) | Dice Bomb (🎲 badge) | 3×3 blast |
| 5+ straight | Jackpot Chip (gold 🎰 disc) | Swap with anything: clears all of that color |

Chain rule: any blast that hits a special detonates it (chainExpand). Jackpot hit by a blast
clears a RANDOM present color. Swap-combos (both consumed, epicenter = drag destination):
- Reel+Reel: full cross (row+col)
- Bomb+Bomb: 5×5 blast
- Reel+Bomb: 3 rows + 3 cols through epicenter
- Jackpot+normal: clears that color
- Jackpot+Reel/Bomb: converts every piece of that color into that special, detonates all
- Jackpot+Jackpot: clears the entire board

## Plinko bonus drop (src/core/plinko.ts + src/view/plinko.ts + GameScene.offerPlinko)
- Trigger (numbered levels): a SETTLED chain of PLINKO_MIN_CASCADE (x5) or deeper, then a
  PLINKO_CHANCE (1/2) roll, and at most ONE drop per level. Offered after the win/lose checks, so it
  never collides with a result card. Ships at ~1 level in 7 played passively, ~1 in 5 played well —
  MEASURED (plinko.rate.test.ts), not guessed: the x4 MEGA bar lands ~1 chain/level even passively
  and would have fired most levels.
- Trigger (ENDLESS): its own, more generous pair — PLINKO_ENDLESS_MIN_CASCADE (x4) and
  PLINKO_ENDLESS_CHANCE (always). Endless has NO hazards and a flat 30 moves, so the numbered-level
  constants halved the rate on the one mode scored purely on points: 5.4% of runs passive / 11.1%
  typical, versus ~27% / ~59% now. The one-drop-per-run latch is unchanged.
- UNREAL override: a chain at PLINKO_GUARANTEED_CASCADE (x8) skips the roll entirely in BOTH modes —
  at that rarity a lost coin flip reads as the game welching. Costs ~+0.7pp in endless.
- Board: 8 peg rows → 9 slots. Ball breaks left/right once per row, so "right N times" = "slot N".
- Slots (l→r): x10 · SPIN · x5 · x3 · x2 · x3 · x5 · SPIN · x10, weights 3/6/10/17/28/17/10/6/3
  (sum 100). Symmetric, binomial-shaped — cheap+common in the middle, x10 a 3% thrill at each edge.
- ENDLESS rolls its OWN weight table (PLINKO_ENDLESS_SLOTS): 4/6/10/16/28/16/10/6/4, same wells and
  same order, only fatter x10 edges (8% of drops vs 6%). Retuned 2026-07-31 because the top prize was
  the standing complaint: at the old 4% on both boards, and with only one drop per run, a ×10 landed
  ~1 run in 92 passively / ~1 in 43 played well. Now ~1 in 46 / ~1 in 21. The extra weight comes off
  the x3 shoulders, not the x2 centre, so the curve keeps its peak. The table choice is keyed off
  ENDLESS, deliberately NOT off allowTickets — endless always suppresses tickets, but so does a full
  spin bank on a numbered level, and that player must keep the numbered odds.
- SUBSTITUTION when a spin can't be paid (endless, or the daily/bank cap is full): the two SPIN wells
  are RESTRUCK as x8 keeping their weight — `plinkoSlots(allowTickets, endless)` returns the effective table
  and paint/labels/payout all read from it. They used to be weight-zeroed instead, which kept the ball
  out but left the view painting two unwinnable "SPIN" faces — 2 of 9 wells advertising a prize the
  player could never land. Effective ramp x2·x3·x5·x8·x10 outward — x8 sits above its x5 neighbour so
  the ramp climbs, and below the x10 edges so they keep the top plate tone. The table still sums to
  100 in both modes (zeroing summed to 88), and multiplier EV goes ~3.44x → ~3.98x.
- Multiplier slots pay THE TRIGGERING CHAIN'S POINTS x the multiplier, one-shot, via GameScene.addScore
  (so it composes with the doubleScore boost). SPIN slots bank one free wheel pull.
- AWARD-FIRST: slot rolled + any ticket banked BEFORE the animation; dropPath then rigs the bounce to
  land there. Quitting mid-drop can't lose the prize. Ticket slots leave the pool when they can't be
  honoured (endless, or free-spin caps full — save.freeSpinRoom).
- DROP to release · tap again to skip · CLAIM is the only exit and hands the board back to idle.
- Presentation: a cast cabinet (goldFace frame, bezel rivets, crown/apron bulb chase, recessed
  playfield, release gate, domed pegs, slot divider pins) and a value ladder you can read at a glance —
  cream x2 → dim gold x3 → gold x5 → NAVY for the SPIN tickets → rose-under-gold for the x10 edges
  (navy = "another currency", rose = "the richest", both borrowed from the wheel's wedge language).
- The fall is a ballistic PHYSICS integrator, not a tween chain — see BUILD_OVERVIEW for why that
  distinction is load-bearing. Skipping mid-fall always snaps the chip to its slot at rest.

## Lucky Deal — the card pick'em (src/core/deal.ts + src/view/deal.ts + GameScene.offerDeal)
- WHY it exists: the daily slot cabinet, the jackpot wheel and the plinko drop are all things you
  WATCH — arm them by playing, press one button, the machine performs. Nothing in the build let the
  player CHOOSE anything for a reward. The Deal is that, and it is the only reward surface whose pace
  and order the player sets.
- Trigger: HOT STREAK — every DEAL_STREAK (3) consecutive numbered-level WINS (save.winStreak). Fires
  from the win card via continueAfterWin, like the wheel. A LOSS or a mid-level quit-after-a-move
  breaks the streak (the same two events that spend a life, so there is one rule, not two). A REPLAY
  neither advances nor breaks it — advancing would make the Deal farmable by re-clearing level 1 on a
  loop (the jackpot meter's §G4 rule), and breaking it would punish star-chasing, which the game wants.
- A new trigger AXIS on purpose: plinko keys off cascade depth, the wheel off total wins, the daily
  spin off the calendar. None of them care whether you keep winning, so nothing ever rode on the NEXT
  level. A streak is the only thing a loss can take — and it takes momentum, never anything earned, so
  the mercy rule ("wins are free") is untouched.
- Board: 9 cards, 3×3, face-down. Tap to turn one. Every card pays a small chip PIP (1–4 by face), so
  there are no dead taps; the third card of a matching face ENDS the round and pays that face's prize.
- THE RIG: the deck holds EXACTLY 3 of the rolled winning face and AT MOST 2 of every other, so the
  winner is the only face that CAN reach three. Whatever order the player turns cards in, the first
  face to hit three is the face rolled before they touched anything — no reveal is ever rewritten
  mid-round to steer the result. Same discipline as plinko's dropPath: settle the outcome, then build
  a presentation PROVABLY consistent with it. `buildDeck` guarantees the ≤2 invariant for every seed
  (the "more slots left than decoy faces left ⇒ take a pair" guard is load-bearing); deal.test.ts
  fuzzes both the invariant and order-independence across every winner.
- Faces (l→r cheapest→richest) and weights at LUCK 0 / LUCK 9: 🍒 CHERRY 25 chips 19/9 · 🍀 CLOVER 40
  chips 22/16 · 🔔 BELL 1 free spin 16/16 · BAR 60 chips 14/16 · 💎 DIAMOND a boost 12/13 · 7 SEVEN
  120 chips 7/12 · ❤️ HEART a CHARM 10/18. Both columns sum to 100, so every weight reads as a percentage.
  - The HEART shipped at 3/8 and was raised when charms became SPENDABLE (the exchange, below). At 3%
    a Deal every 3–4 wins yields well under one charm per 100 wins, so a shelf whose cheapest item
    costs a charm would have been unreachable for weeks. 10% lands near 2.5 charms/100 wins — an
    exchange item every couple of hours, a first album over a few weeks. The weight came off the
    CHERRY (the cheapest card), so chip EV barely moves. Guarded by a floor in deal.test.ts.
- SUBSTITUTION when a spin can't be paid: the BELL is restruck as BELL_SUBSTITUTE_CHIPS (50) keeping
  its weight — the same rule plinko's ticket wells answer to, for the same reason (a face the player
  can see must be a face they can win). `dealFaces(allowSpins)` is the effective table and the
  paytable strip paints from it, so the board never advertises a prize it can't honour.
  - The Deal asks the 'mega' (DEFAULT) free-spin source — BOTH the daily earn cap and the bank cap.
    It does NOT take plinko's bank-cap-only exemption: that exists because a drop's own x5+ trigger
    chain has already spent the daily allowance in the same resolve, and a win streak banks nothing,
    so the Deal has no claim on it. `freeSpinRoom` and `addFreeSpins` are called with the same source,
    which is the invariant save.freespins.test.ts guards.
- PACE: three winners among nine cards ⇒ the third lands on the 7.5th flip on average (guarded in
  deal.test.ts), so a round is ~7 taps and a few seconds. PAIR GLOW is the beat that carries it — when
  a face reaches two, both its cards ring and breathe. Because no loser can reach three, a ring means
  "one card from being the answer, or already dead", and the player cannot tell which.
- FAST DEAL: match in ≤4 flips → +50 chips. C(4,3)/C(9,3) = 4/84 ≈ 4.8% of rounds, ~2.4 chips of EV —
  pure luck, unplayable-for, the table's own applause.
- AWARD-FIRST: the hand is rolled before the cabinet is on screen, and the prize is BANKED the instant
  the third card turns — before a frame of celebration. Quitting mid-payoff can't lose it.
- THE PROOF: on the match, every card the player never turned flips face-up, so the finished table
  shows three of the winner and no more than two of anything else. The prize plate lands in the
  PAYTABLE's slot (not over the cabinet) precisely so the nine cards stay countable to CLAIM.
- CLAIM is the only exit; it runs the win card's own continuation, so the level flow is identical
  whether the Deal fired or not. If both bonuses arm on the same win (~1 in 15), they QUEUE:
  wheel → Deal → continue, and the win card crowns both banners in that order.

## Charms — the collection (src/core/charms.ts + src/view/charmalbum.ts)
- Everything else the game gives out is CONSUMED (chips spent, boosts burnt, spins pulled). A charm
  just stays. Nine to a SERIES, shown in a 3×3 album (the same shape as the Deal's grid).
- ONE source: the HEART card in the Lucky Deal. One source, one rarity weight, nothing else to audit.
- rollCharm draws uniformly from the charms you are MISSING, never blind over all nine — a blind roll
  makes the last slot take ~9 hearts (coupon-collector), so the closer you got the worse the game
  would treat you. Every heart is progress; the ninth is as reachable as the first.
- DUPLICATES (album already full) pay DUPLICATE_CHIPS (40) — about a level win. A collectible whose
  duplicate is a blank turns the rarest card in the deck into the worst feeling in the game.
- COMPLETING a series pays SERIES_PURSE (500), empties the album and bumps `charmSeries` — one atomic
  write, so a crash can never bank half a completion. `charmsAllTime` is NEVER reset.
- What a charm DOES: **LUCK**. luckOf(save) = min(LUCK_CAP=9, charmsAllTime), and core/deal.ts
  `luckWeights` lerps the face table from its base column to its lucky column by luck/LUCK_CAP. At full
  luck the HEART goes 3% → 8% and the CHERRY 26% → 14%. Collecting makes the game that hands out
  charms better — a compounding loop.
  - Luck reads ALL-TIME (not the current album) so completing a series can never lower it, and is
    CAPPED at one series' worth so it plateaus at a legible milestone instead of running away — an
    uncapped table would quietly turn a fixed-size faucet into a growing one.
  - It touches the Deal's prize roll and NOTHING else — not the board, not the level curve, not
    scoring, not endless. So it can't drift difficulty and can't reach the weekly race (iron rule #2).
- MERGE: `charms` resets per series, so mergeSaves compares `charmSeries` FIRST and unions the ids only
  when both devices sit on the same album — a blind union would hand a Series-II device all nine of the
  Series-I album it already cashed, i.e. a second purse. `charmsAllTime` takes the max (it never resets).
- Album: Home top-bar chip (x=532) with a live "N/9" collar, opening the panel — owned charms lit,
  missing ones in silhouette (so you can see WHICH one you still need; any charm added to CHARMS must
  survive that flat-tint treatment, which is why 🧿 was swapped for 🍄 — a nazar silhouettes to a
  featureless circle), the luck readout, and the line naming where charms come from.

## The charm exchange (core/charms.ts CHARM_EXCHANGE + the album panel)
- Charms are a CURRENCY, not only a keepsake. A shelf under the album grid spends them:
  **FREE SPIN 1 · FULL HEARTS 2 · DEAL NOW 3**. That gives the collection a near-term payoff next to
  the two slow ones (luck, and the ninth slot), and turns a thing you watch fill into a thing you make
  decisions about — bank a reward now, or hold the set for the purse.
- It sells ONLY what the chip economy can't: a wheel pull, an instant heart refill, a Deal on demand.
  Chips are deliberately absent — the Gift Store already sells for chips and a completed series already
  PAYS chips, so a chips slot here would compete with completing the album on the same axis and one of
  the two would always be strictly the wrong choice. Different KIND of good ⇒ both stay worth doing.
- SPENDING NEVER COSTS LUCK. Prices come out of `save.charms` (the current album); `charmsAllTime`,
  which luck reads, is never touched. The worst a purchase can do is set back the ninth slot — it can
  never make the Deal stingier than it was before you shopped. The panel says so under the heading.
- `redeemCharms(item, dayKey)` is atomic and REFUSES rather than half-paying: it returns null (save
  untouched) when the album can't afford it, or when a FREE SPIN's bank is full — same "never
  advertise a prize you can't pay" rule the BELL and the plinko wells follow, and it matters more here
  because the player is handing over a collectible. The reward is granted BEFORE the charms are taken,
  so the only crash window leaves them holding both rather than neither.
- Charms are spent NEWEST-FIRST, so the ones held longest survive. Spent slots re-open for future draws.
- Every purchase needs TWO taps (the pill arms to "TAP TO CONFIRM" for 2.6s). Charms are the one thing
  in the game that can't be re-earned quickly, so a mis-tap spending two of them is the worst accident
  the UI could allow; a second deliberate tap removes the whole class of regret.
- The panel STAYS OPEN after a buy (it repaints in place — cookbook §7) and the host is refreshed on
  CLOSE, never per purchase: the host's refresh is a scene restart, which would throw the player out
  of the album mid-shop and, for DEAL NOW, destroy the Deal overlay on the frame it opened. DEAL NOW
  fires `onChanged` from the Deal's own CLAIM instead, which covers the spend and the winnings at once.

## Scoring
- 20 pts/piece × cascade number (wave 1 ×1, wave 2 ×2, …). Specials count as their symbol.
- COMBO popup at cascade ≥2; MEGA WIN at ≥4 (siren + big vibrate).
- Win: +60 pts per unused move (moves bonus). doubleScore boost multiplies EVERYTHING
  that level ×2 (including moves bonus) — GameScene.addScore applies scoreMult.
- BEST = highest single-level score, shown home/level-select.

## Levels (src/core/levels.ts + src/core/difficulty.ts — those two files are the spec)
- levelSpec(n) is deterministic per level (seed 0xC0FFEE ^ n·2654435761): same goals every
  attempt; boards are random per attempt. LEVEL_COUNT = 500, grouped into 50 chapters of
  CHAPTER_LEVELS = 10 (see "Chapters, trophies & the showroom"). ACT1_LEVELS = 300 is a SEPARATE
  constant — how far the campaign's first act runs, which is what every shipped curve, plaque and
  ramp is anchored to; LEVEL_COUNT is only how far the ladder currently reaches (see "Act II"
  below). LevelSelect is a masked, drag-scrollable grid that auto-scrolls to the current level,
  building only the rows in view.
- Objectives: collect N of 1 symbol (L1–2), 2 symbols (L3–7), 3 (L8+); per-objective
  N = min(110, max(12, round(32·(n/10)^0.34))) — a concave power curve, ≈15 → 32 → 102 at
  L1 → L10 → L300 (the 110 clamp is never reached inside 1–300). Collected = cleared pieces of
  that symbol (jackpot pieces excluded).
- Moves are DERIVED from a density-aware target collect ratio (total collects ÷ moves — the real
  difficulty knob): 0.50 with 1 objective, 1.15→1.63 across L3–7, then an eased 3-objective
  onset and a slow log climb (~2.8 at L8 → ~3.5 at L300; the post-L30 branch starts from the
  exact L30 seam value so the handover can never step easier). Feasibility floor:
  moves ≥ ceil(total/6.2) + objectiveCount. The +2-moves every-5th breather survives only in the
  protected band (L1–30); above it the breather is a visibly hazard-light table
  (DIFFICULTY.breatherHazardScale) and the teaching levels get +3 moves instead.
- The old ~L24 plateau is GONE (curve overhaul): L1–30 are pinned byte-identical to the
  pre-overhaul curve (golden table in levels.test.ts), and above L30 the required ratio climbs
  monotonically to L300 — no level easier than its predecessor except taught mechanics — with
  the total ramp (hazards on) asserted in feasibility.test.ts. Panic switch:
  DIFFICULTY.curve.enabled=false restores the pre-overhaul budget exactly, also test-pinned.
- Win when all objectives hit 0 (cascades count); lose when moves hit 0 first.
- Stars grade a COLLECT RATE, not a fixed slice of the budget: 3★ ≈ sustain 4.7 collects/move,
  2★ ≈ 4.0 (starThresholds; L1–7 clamp to the old 0.5/0.25 remaining-moves bars exactly), graded
  on EARNED leftover moves only — purchased moves never inflate stars. recordResult persists
  best-of stars, unlocks n+1.
- Every 10th level: the FIRST-ever clear of a chapter plays the trophy ceremony (below); repeat
  clears play the "LEVEL n! · N STARS EARNED" star-tally splash (GameScene.milestoneSplash).
  L300's first clear plays the one-time ALL CLEAR finale, then chapter 30's car ceremony.

## The mid-game refresh (Slice 0, 2026-08-04) — new beats from L86 to L300
- The new-thing cadence never goes quiet past L56 any more: LOCKBOX blockers live at 86 ·
  2-layer felt 151 · THE MARKER from 151 · 2-hp lockboxes 181 · HOUSE MINIMUM from 201.
- HOUSE MINIMUM (src/core/levels.ts isMinimumLevel, cadence L%10∈{1,6} from 201; L201 teaches):
  a brass score plaque REPLACES the third collect objective — win = 2 collect goals + felt +
  `score >= scoreTarget`. The plaque is priced off the sim's goal-completing runs
  (MINIMUM_POINTS_PER_GOAL, re-measured by minimum.rate.test.ts; exact targets are GOLDEN in
  levels.test.ts). The move budget is byte-identical to the 3-objective sibling; DOUBLE SCORE is
  skipped-not-consumed on plaque levels (levelBoostExclusions — threaded through the stash
  preview so the promise matches the level start).
- THE MARKER (src/core/marker.ts, numbered ≥151, never breathers, never endless): an opt-in side
  bet — the stake is SPENT like a helper-shelf purchase; winning the level pays a non-chip
  kicker (+1/+2 jackpot pips, or a free spin at 250 that degrades to pips when capped). Strict
  sink at any win rate — marker.rate.test.ts proves kicker value < stake from the shipped prize
  tables. Back out free before your first move; first busted marker each day is comped
  (save.markerCompDay).

## Act II — the high-roller floors (Slice 1, levels 301–400; src/core/actII.ts is the spec)
- Act I is levels 1–300 (ACT1_LEVELS), ending on the chapter-30 car. Act II is the House playing
  back: six themed FLOORS of 50 levels, of which four ship — F1 THE HIGH-LIMIT ROOM 301–350
  (chapters 31–35), F2 THE SPEAKEASY 351–400 (36–40), F3 THE VAULT 401–450 (41–45) and F4 THE
  CARD ROOM 451–500 (46–50). `FLOORS` in actII.ts is the table; `DIFFICULTY.act2` is the panic
  switch (per-feature and independently revocable — with the act off, 301+ are ordinary levels on
  the plain extended curve, asserted in actII.test.ts).
- THE 300 SEAM. `ACT1_LEVELS` and `LEVEL_COUNT` were one constant and are now two, because raising
  the ladder must not re-price the act below it: `minimumTargetFrac` divides by ACT1_LEVELS, so
  every shipped Act I plaque golden is untouched. Hazard densities FLATLINE above 300 by design
  (every ramp in hazards.ts clamps there) — a floor-1 board carries exactly a L300 board's felt,
  lockboxes and clamps, because stacking a fresh hazard ramp on a fresh mechanic is how you get an
  unplayable teaching level.
- THE REEL PULL (`Board.pullColumn` + a chrome 8-handle rail under the board, from 301): a slot arm
  pulls one COLUMN down a notch, the bottom piece riding over the top into row 0. It costs a move
  and resolves through the ordinary wave pipeline, so a pull that lands a run cascades like a swap —
  and a pull that lands nothing is a move spent on POSITION, which is the trade the verb sells. One
  refusal, derived from the mechanic: a column holding a BLOCKER will not pull (gravity already
  treats a blocker as a wall). A CLAMPED piece rides the pull — gravity moves locked pieces too, and
  refusing them emptied the rail outright in the late band. The rail arms on `pointerdown`, per
  CLAUDE.md's rule for any control abutting a swipe surface.
- THE ROPED RUN (311–315, `act2Plan`): the curated band where the verb and the sharp hazard argue.
  It PERMUTES the hazard plan — same boxes, same hit points, same coats, same locks, moved — into a
  contiguous block of columns, so half the rail is visibly roped off and breaking one box frees the
  handle above it. Same call folded into `GameScene` and `sim.buildLevelBoard`, so the feasibility
  gates measure the board that is actually played. The row pattern is MEASURED, not drawn (see the
  comment on `ROPE_ROWS`).
- FLOOR MOODS (`view/floormood.ts`, applied through `theme.setFloorOverlay`): the floor owns the
  ROOM, the theme owns the CABINET. A mood may tint the light — glows, rays, motes, the marquee's
  hue arc, the audio room, the hazard skins, the margin flourish — and may never touch a wash, a
  card, an ink or a cushion. The overlay's key list is a `Pick`, not a `Partial<Theme>`, which is
  what makes that structural rather than a convention.
- THE TELL (`ringHue`'s `lean` + `RgbRing.setTell`): while the board idles, the cabinet marquee
  leans toward the colour of the best available move. It redistributes the ring's LENGTH across its
  existing arc rather than moving the arc, so no theme's hue band can be violated; one eased scalar
  on the ring's existing UPDATE clock, no extra tween, no shader. Act II levels only.
- THE COUNTING SHOE (`core/shoe.ts`, floor 3 only — 401–450, breathers sit out): refills deal from
  a finite, visible shoe instead of thin air — open information, card counting made legal. The seam
  is an optional `RefillSource` on `Board.refill` that endless NEVER receives (dormant by absence,
  the `pullColumn` precedent; boardpick goldens are the tripwire). Contents deterministic (uniform,
  `SHOE_COPIES` 8 × 6 symbols), draw order random per attempt, empty reshuffles itself; counts ride
  the level-resume snapshot so a reload is never a free re-deal. The SHOE pill above the board opens
  a live per-symbol panel; teach card at 401. Measured (banker, 40 seeds): the shoe costs 7–13pp on
  plain floor-3 levels — a goal-chaser drains its own symbols — and thins the score distribution's
  right tail without moving its completer mean, which is why the band's plaques post RELIEVED
  minimums (`SHOE_PLAQUE_RELIEF` 0.92, its own monotone series; enforced full-brass, L406 measured
  5% — a wall). The floor-pair hazard-cell ramp (`DIFFICULTY.act2.ramp`) ships BUILT AND HELD OFF:
  its candidates measured inside seed noise, and the shoe is the pair's climb.
- Trophies and purses extend to chapter 50 (lifetime CHAPTER_PURSE_TOTAL 13,800), the tier ladder
  gains 🎖️ HIGH-ROLLER CASE at 40 chapters and 🕴️ THE HIGH ROLLER at 50, and the showroom's second
  wing fills through chapter 50 (MAIN FLOOR /
  HIGH-ROLLER WING). THE PRIVATE ELEVATOR is a one-time reveal card on the raceunlockcard pattern
  (`view/act2card.ts`, latched by `save.seenAct2Reveal`); each floor's first level shows a one-time
  croupier door card (`view/floordoor.ts`, latched by `save.floorIntros`).
- Endless and the daily/weekly race are UNTOUCHED. Everything above keys off a level NUMBER and
  endless has none; `boardpick.test.ts`'s goldens are the tripwire and pass unmodified.

## Hazards — locks, coats, blockers (src/core/difficulty.ts + src/core/hazards.ts)
- Numbered levels ONLY — endless is a same-board fairness contract and levelSpec is not even on
  its code path. Names are behavioural; appearance is a view-layer skin (view/hazardskins.ts),
  resolved FLOOR → THEME → default. Floor 1 dresses them as BAIZE / CHIP RACK / DEALER'S CLAMP and
  floor 2 as CANDLE WAX / OAK BARREL / PADLOCK & CHAIN; the rule copy is word-for-word the default's
  with the nouns swapped, so a re-dressed obstacle can never read as a new mechanic. The FELT n/m
  HUD counter and the standing brief read the skin too (`label.coat` / `coatNoun`).
- LOCK (live, from L31): the piece still MATCHES but cannot be SWAPPED until an adjacent clear
  frees it. Cheapest mechanic (~−4% collects/move); used for texture.
- COAT (live, from L56): a coated table square that clears when a match lands on it — the one
  win-condition change (the FELT n/m HUD counter; the genre's "jelly" objective).
- BLOCKER (live, from L86 — Slice 0 flipped the long-staged flag on 2026-08-04): never matches,
  broken by adjacent clears; skinned as the LOCKBOX. The sharp instrument — ~10× a lock's cost
  per cell and superlinear — so it is capped hard (≤6, ≤1/column, ≤2/row, never the refill row)
  and gravity is segment-aware so a column can never wall off. 2-hp lockboxes creep in from L181
  as originally staged.
- Densities ramp per band and creep after L121 (DIFFICULTY.bands/density); hazards are strictly
  front-loaded (nothing spawns mid-level) and placed on their OWN RNG stream so they can never
  perturb the level's goals — levels.test.ts freezes L1–30 to prove it. Every 5th level is a
  hazard-light breather (×0.5); the level introducing a live mechanic gets +3 moves and a
  just-in-time intro card, once (save.hazardIntros).
- Panic switches: DIFFICULTY.hazards.enabled / DIFFICULTY.curve.enabled — independently
  reversible, each restores pre-overhaul behaviour exactly, proven by npm test. The DIFFICULTY
  table carries every knob, cap and measured cost; hazards.test.ts + feasibility.test.ts are the
  contract.

## Chapters, trophies & the showroom (src/core/trophies.ts + view/showroom.ts + view/trophyceremony.ts)
- 500 levels = 50 chapters of CHAPTER_LEVELS=10 (core/levels.ts — the one constant, FROZEN because
  LevelSelect's `rowIndexAt` is a closed form; the ribbons, the win flow and trophies all read it).
  Chapters 1–30 are Act I, 31–50 the first four high-roller floors.
- First-ever clear of a chapter's closing level pays, once per chapter: a permanent TROPHY
  (TROPHIES catalogue — chapter 30 is THE CAR on the rotating plinth, 29 its wheels, the
  showroom's own near-miss tease; 31–50 are the high-roller floors' own furniture, each floor
  closing on its emblem — ⚜️ 35, 🎭 40, 🔐 THE VAULT LOCK 45, ♠️ THE ACE OF SPADES 50), a one-time
  chip PURSE (CHAPTER_PURSES, escalating 100→1,000 with steps on every 5th; lifetime total
  CHAPTER_PURSE_TOTAL = 13,800, test-pinned in trophies.test.ts), and on milestone chapters a
  BOOST into pendingBoosts.
- AWARD-FIRST via claimChapter; the claim latch is save.chapterRewards — the SAME list the
  showroom renders, so the purse latch and the trophy shelf can never disagree. Unioned on
  device merge; never trimmed. A one-time Home catch-up card (claimChapterCatchUp) back-pays
  players already past chapter boundaries.
- THE SHOWROOM (view/showroom.ts): 50 live plinths behind doors on the LevelSelect chapter ribbons,
  in TWO WINGS (MAIN FLOOR 1–30 / HIGH-ROLLER WING 31–60, chapters past the shipped catalogue
  rendering as empty sockets) with a per-wing hero and tally — the panel's own height is unchanged,
  which is what the tab rail was budgeted against. Locked trophies render as flat navy silhouettes,
  so every glyph must survive that treatment (the catalogue's comments name the failures — no
  coins, cards, rosettes or pianos).
- Leaderboard tier badges (🥉→🏎️→🎖️→🕴️) are DERIVED, never submitted: floor(cleared/10) through
  TROPHY_TIERS via chaptersFromCleared — deliberately the only place that coupling lives. Act II
  added the 🎖️ HIGH-ROLLER CASE rung at 40 chapters (the whole of Act I under one rung, which is
  the point) and 🕴️ THE HIGH ROLLER at 50 — the top of the shipped tower. No badge column exists
  anywhere; see CLAUDE.md's trophy-badge bullet first.

## Endless race — daily boards, weekly season (src/core/endless.ts + GameScene endless mode)
- Unlocks after ENDLESS_UNLOCK_LEVEL=10 (fixed, independent of LEVEL_COUNT — save.unlocked > 10;
  lowered 20 → 10 on 2026-08-03 so the race is reachable sooner, with a one-time DAILY RACE
  UNLOCKED reveal on Home — view/raceunlockcard.ts). Entry: rose ENDLESS pill on Home and
  LevelSelect.
- **A NEW BOARD EVERY DAY.** dayKey(now) = "YYYY-MM-DD" on the **RACE_TZ = America/Edmonton**
  clock. The board opens and closes at midnight Mountain time for EVERYONE at once (06:00 UTC on
  MDT, 07:00 on MST), and the day's top score is crowned (DAILY_PURSE = 150 chips).
  endlessRngForDay(day, salt) = mulberry32(FNV-1a of the salted day key): everyone gets the SAME
  board that day; every attempt that day replays the identical starting board (a BEST-score race,
  not per-attempt random). Since 2026-08-04 the key is SALTED and NORMALISED — next bullet.
- **The board is salted and normalised (core/racesalt.ts + core/boardpick.ts, migrations
  0023/0024).** The raw seed was a public hash of the date, so any future day's board could be
  generated and solved in advance. Now: (1) the server mints a random per-day SALT only once the
  day has OPENED and refuses to hand it out before then — mixed into the seed it makes the board
  unknowable in advance; a posted score must carry the day's salt or 0024's guard refuses it
  (which is what stops a stale cached client posting an old-board score). SALT_ACTIVE_FROM in
  core/endless.ts and v_salt_from in 0024 are the same switch on two sides of the wire — change
  both. Offline fallback: the unsalted board is playable but its score cannot post. (2) boardpick
  NORMALISES the day by deterministic rejection sampling — it walks day, day#1, day#2… until the
  greedy sim scores inside [8000, 16000], so the size of a big day is the player's doing, not the
  hash's (raw day boards spanned 6.1×; normalised 1.9×). boardpick.test.ts pins the chosen
  offsets as GOLDEN — a failure there means the race boards MOVED; ship board-affecting changes
  behind a new activation date, never re-record.
- **THE WEEK IS THE SEASON.** weekKey(now) = ISO-8601 "YYYY-Www" of the race calendar
  (Thursday-anchored), rolling over Monday midnight Mountain — the same instant Sunday's board
  closes. A week's standing is the SUM of that player's daily bests inside
  it (endlessWeekStanding), so a missed day is a zero you cannot make back with one big run —
  turning up IS the strategy. Ranked on total, ties broken by MORE days played, then first-to-reach.
  The season's #1 takes CHAMPION_PURSE = 1,000 chips.
- Why it changed (2026-07-29): a single frozen weekly board went stale by Thursday — the leaders had
  memorised a layout that never moved, anyone arriving on Saturday was racing a week of other
  people's practice, and there was no reason at all to come back TOMORROW. Daily boards give the
  game a daily heartbeat; the weekly sum is what stops that heartbeat being seven disconnected
  sprints, and it rewards the habit rather than one lucky session.
- ONE FIXED ZONE, not device-local time, for BOTH keys. It was local until 2026-07-26, which
  silently split the race: the key drives the board SEED, the leaderboard partition written to AND
  the one read back, so a player whose local date had already ticked over sat on a different
  board — a leaderboard containing only themselves, and no way to tell why (hit for real by two
  friends 6 timezones apart). A forward-set device clock could also jump into tomorrow's board
  early. The stakes went UP when the race went daily: a timezone-sensitive key would now split the
  player base every night. The fixed zone was UTC until 2026-07-30, which put the flip at 6 PM on
  the home crowd's clock — a player told "it resets at midnight" found a 19-hour countdown at
  11 PM — so the anchor moved to the home zone (RACE_TZ, mirrored by `race_day_key()` in migration
  0013 and the copies in scripts/send-push.mjs). Panels show "ends in 5h 12m" beside the key
  (formatRaceRemaining + dayEndsAt/weekEndsAt).
- Score attack: ENDLESS_MOVES=30, all 6 symbols, NO objectives, NO boosts applied (planting
  specials would change the board and break fairness). Ends only on moves-out → finishEndless.
- recordEndless keeps the max per day in save.endlessDays (pruned to ~16 days); also flows into
  all-time save.best — always of the POSTED score, never a raw pre-clamp one. HUD shows a
  "TODAY'S BEST" card; the end card shows NEW BEST! / TIME'S UP, today's best, and the running
  week total with "N of 7 boards raced".
- The endless CHEAT CODE (core/cheat.ts — a secret swipe pattern on the dead strip below the
  board; deliberate, not a bug) mints free mega wins, each paying its own Plinko drop. Its runs
  still reach the race, at min(score, ENDLESS_MAX_CHEAT_SCORE): a 300,000 BACKSTOP, not a
  normaliser (owner calls 2026-07-31 and 2026-08-04; it began as a 13,000 "pace score" that
  replaced nearly every cheat run's real score). A single fire posts what it actually scored;
  only a re-fired runaway hits the ceiling. recordEndless({ paced: true }) is the ONE place the
  clamp lives — never route a cheat score around it. The contract (really clamps, never floors,
  sits above the best honest measured run, inside 10× of it) is guarded by endless.pace.test.ts.
- Panel: one card, TODAY / THIS WEEK tabs (view/leaderboardpanel.ts) + the all-time LEVEL ladder.
  Crown row is "yesterday's winner" on the daily tab, "last week's champion" on the weekly one.
- RESULT RECAP (HomeScene.openRaceRecap): for everyone who raced the closed day and did NOT win it —
  rank, score, who took it, the gap to the NEXT place up (catchable, unlike the gap to the leader),
  the week total with boards remaining, and a rose PLAY TODAY'S BOARD button. Latched per day in
  save.raceRecapDays BEFORE it animates (nothing is owed, unlike a coronation, so an interrupted card
  must not come back reporting a stale day). Winners get the coronation instead and never both.
- RULES (openRaceRulesPanel): the in-app explainer, reached from the race card's `?` chip and from
  how-to-play's RACE RULES button. Three numbered beats over a WEEK STRIP diagram — seven bars with
  a hole where a skipped day should be, summing to a total underneath. The diagram is the point: the
  weekly rule ("your daily bests added up") is the one thing no screen shows on its own, and the
  missing bar teaches the cost of a skipped day without a sentence. Every number in it reads from the
  constant (ENDLESS_MOVES, DAILY_PURSE, CHAMPION_PURSE, DAYS_PER_WEEK), never a literal.

## Lives / energy (src/core/lives.ts + GameScene gate)
- Pool: LIVES_MAX=5, LIFE_REGEN_MS=20 min, LIVES_GRACE_LEVELS=10 (config.ts). Originally 3/30min,
  widened to 10/8min after Maya burned through a stingy pool while learning (2026-07-17), then
  retuned 2026-07-21 to 5/20min because 10/8 was effectively infinite — beginners are protected by
  the GRACE LEVELS instead of pool size (losses below L10 never cost a heart), so scarcity only
  exists once a player is invested. Only a LOSS drains a life; a mid-level QUIT after ≥1 move also
  drains one (closes the quit-to-dodge-loss exploit). WINS ARE FREE — so a steady/skilled player
  never hits the wall.
- Regen is wall-clock (device clock trusted, like the daily spin): +1 life every 20 min, so a
  single life returns after a short break and an empty pool refills in ~100 min. save v5→v6 does a
  one-time GRACE REFILL to full on upgrade so nobody is stranded at the old count. Storage: save.lives +
  save.livesAnchor (epoch ms the current regen cycle started; 0 when full). refreshLives() banks
  regen + persists on every read; spendLife/grantLife mutate; devSetLives for ?lives=N.
- ENDLESS is NEVER gated (it's already weekly-scarce). Numbered levels gate on entry: 0 lives →
  GameScene.showLivesGate ("TAKE A BREAK", faded hearts, live "next life mm:ss / full mm:ss"
  countdown, PLAY appears when one regenerates). Gate is checked BEFORE boosts are consumed, so a
  gated entry never wastes a pending boost. Hearts HUD (addLivesHud) on Home + the lose overlay.

## Daily Bonus (src/core/daily.ts + store.ts freeSlotSpin, on SlotScene)
- One FREE pull per LOCAL calendar day (lastSpinDate 'YYYY-MM-DD'; device clock trusted — offline
  toy), taken on the LUCKY SLOTS cabinet with all four paylines lit. Banked free spins (MEGA
  cascades / plinko) spend the same way. Result settled & persisted BEFORE the animation
  (freeSlotSpin) — closing the app loses nothing.
- GIFT FLOOR: a free pull never pays NOTHING — an empty spin is topped with one prize off the
  classic table (Wild Reel 30, Dice Bomb 25, +5 Moves 20, Double Score 15, Jackpot Chip 10),
  so the daily stays a gift even on a machine with a real house edge. Paid spins have no floor.
- Streak: consecutive days (+1 if yesterday spun, else reset to 1); pays the CHECKIN_CHIPS ladder
  (10→150 across the week). Every 5th streak day = a bonus prize on top (milestoneDue).
- Prizes land in save.pendingBoosts; GameScene.applyBoosts consumes ALL on the next NUMBERED
  level start (win or lose; endless never consumes them): plants specials at random cells rows
  3–7 (board.plant keeps cell's symbol), +5 moves each, ×2 scoreMult. Shown at level start as a
  self-sizing gold banner over the top of the board (GameScene.showBoostBanner — pops in, holds,
  fades up) plus a ×2 badge. (Was a flat toast at BOARD_Y−44 that overlapped the objective row.)
- Home button: "LUCKY SLOTS" — gold with a chasing marquee-stud crown while any FREE pull waits
  (daily or banked), quiet ghost with dim studs once the gifts are spent; opens SlotScene.
  NOTE: no emoji in pill labels — letterSpacing splits surrogate pairs (renders tofu).

## In-level helpers / power bar (src/core/store.ts POWER_ITEMS + GameScene.buildPowerBar)
- A shelf below the jackpot meter (numbered levels only — endless stays a boost-free fairness race)
  where earned CHIPS buy help for the level being PLAYED. Distinct from the Gift Store, which queues
  boosts for the NEXT level; these apply NOW. Catalogue is pure (POWER_ITEMS, cheapest→priciest):
  +1 MOVE (8), +5 MOVES (30, better value — "don't run out"), BOMB (35). Spend is atomic
  (save.spendChips: load→check→deduct→persist, returns the new balance or null; the save is untouched
  when broke). Affordable pills read GOLD, the rest GHOST; buying rebuilds the shelf for the new balance.
- Moves top-ups add straight to movesLeft (restoring the "plenty" colour + stopping the ≤3 urgent
  pulse) and a chip flies into the HUD balance. BOMB arms an AIM mode: a pulsing gold frame round the
  board + "TAP A TILE — 3×3 BLAST" + a CANCEL that refunds. The next board tap fires board.detonate(cell,1)
  — a free 3×3 blast (NO move spent) run through the normal detonation→cascade→scoring→objective
  pipeline (chains any special caught in it, exactly like a matched Dice Bomb), so it clears goal symbols.
- Anti-farm: purchasedMoves is tracked and SUBTRACTED from the win's star/moves-bonus/chip-reward math
  (earnedLeftover = max(0, movesLeft − purchasedMoves)), so buying moves can win a level but never inflate
  stars or farm chips (which would run the closed economy away). A clean in-budget run is unaffected.
- Buys are idle-only (the bar dims mid-resolve, hides on level end); reduced-motion / haptics / mute aware.

## Save (src/core/save.ts — localStorage key 'viva-maya:v1', all access try/catch)
v13: { v:13, best, unlocked, stars{level:1..3}, lastSpinDate|null, streak, pendingBoosts[],
      endlessDays{"YYYY-MM-DD": score}, lives, livesAnchor, chips, + v7 personal-warmth fields
      (incl. later shape-tolerant latches: heldBoosts, seenRaceUnlock), + v8 jackpot-wheel meter,
      champion claims (championWeeks + championDays), raceRecapDays, chapterRewards (trophy shelf
      + purse latch in one list), referral/free-spin fields, + v10 charms[] (current series),
      charmSeries, charmsAllTime, winStreak, + v13 handle/handleSetAt (the cloud-carried race
      name + its merge tiebreak) }
Migrations: v1 {best} → v2 (+unlocked/stars) → v3 (+daily) → v4 (+endless: endlessWeek
"YYYY-Www", endlessBest) → v5 (+lives/energy: lives, livesAnchor — pre-v5 saves start full)
→ v6 (grace refill: tops every save to full — lives=LIVES_MAX, livesAnchor=0 — on upgrade)
→ v7 (+personal-warmth fields, §E9) → v8 (+jackpot-wheel meter; absent in older saves → 0)
→ v9 (+hazard/special teach latches) → v10 (+Lucky Deal & charms: charms[], charmSeries, charmsAllTime,
winStreak — absent in older saves → an empty Series I album and a cold streak)
→ v11 (endless goes DAILY: endlessWeek/endlessBest → endlessDays, +championDays)
→ v12 (+raceRecapDays, the seen-latch for yesterday's result card) → v13 (+handle/handleSetAt).
Fields whose absence has a safe default (chapterRewards, heldBoosts, seenRaceUnlock, and Act II's
seenAct2Reveal + floorIntros — both one-time card latches, unioned on device merge) are added
WITHOUT a version bump — the shape-tolerant loader defaults them. Act II added ZERO server
migrations; every one of its latches is client-side.
The pre-v11 endless pair is deliberately NOT carried across — it held a best for a week-long board that
no longer exists, and filing it under any day would credit a score nobody could earn on that layout.
Loader is shape-tolerant (old saves default new fields). Mute flag is separate: 'viva-maya:muted'.
Charm ids are NOT validated against the CHARMS catalogue on load: core/save.ts stays dependency-free
(charms.ts imports IT, not the reverse) and every reader looks charms up BY catalogue, so an unknown
id simply never renders.

## Audio (src/audio/sfx.ts — procedural WebAudio, zero assets)
Singleton, lazy AudioContext, unlocked on first pointerdown (iOS), master gain 0.5 →
compressor. Muted flag persisted; every call guarded (never throws; silent if unavailable).
Map: uiTap (buttons) · swapWhoosh · invalidThud (snap-back) · pop(cascade) rises one
semitone per cascade (2^((c−1)/12)) · reelSweep · bombBoom (+30ms vibrate) · jackpotStrike ·
MEGA WIN → jackpotStrike + vibrate [60,40,120] · winFanfare + starDing per earned star +
vibrate 80 · loseWah · reshuffleSwirl.

## Scenes & UI
Boot (textures) → Home (streak flame badge when streak>0, heart emblem, marquee, PLAY→current
level, LEVELS, LUCKY SLOTS, ENDLESS when unlocked) → LevelSelect (5×6 chips, stars, locks,
back‹, mute, ENDLESS banner when unlocked) → Game (numbered or endless) → SlotScene.
Shared: ui.ts (addMarquee, addPillButton, addMuteChip, addStreakBadge, GOLD/GHOST/ROSE pill
styles — ROSE marks the endless "special mode"; streak flame keeps 🔥 in its own text object
to dodge the letterSpacing surrogate-pair bug),
background.ts addCasinoBackdrop(scene, 'home'|'menu'|'game') — gradient wash, twinkling
marquee dot strips, corner bokeh, ♥♦♣♠ watermarks, drifting motes (not on 'game').
All textures generated at boot (textures.ts): emoji → DynamicTextures; specials composed
lazily (ensurePieceTexture); NEVER destroy a RenderTexture you saveTexture'd — use
addDynamicTexture instead.

## Mobile/PWA
Portrait design 720×1280, Scale.FIT + CENTER_BOTH (no CSS flex on #app — double-centering).
touch-action:none, no pinch zoom, viewport-fit=cover, apple-touch meta, standalone display.
vite-plugin-pwa registerType:'prompt' (NOT autoUpdate — a new deploy raises a visible
"new version — refresh" toast the player taps, so an update can't land a launch late;
see main.ts onNeedRefresh). SW precaches everything except og-image.png and supabase-*.js
(lazy + optional cloud client), with about/privacy/terms.html denylisted from the SPA
navigate-fallback. Install: Safari → Share → Add to Home Screen. base:'./' keeps builds
host-agnostic.

## Icons & social (scripts/gen-icons.mjs — macOS: headless Chrome + sips)
icon.html → 5×5 emoji board + VIVA MAYA banner (checkerboard = (row+col)%2). Banner on
≥180px; 16/32/48 + favicon.ico are board-only (#plain hash). og.html → 1200×630 poster.
`npm run icons` regenerates all of public/. favicon.svg is hand-authored.

## Dev/test knobs (DEV builds only; see GameScene/BootScene/SlotScene create)
?level=N jump · ?endless=1 boot today's race · ?lives=N set the life pool (test the gate) ·
?scene=slots|home|levelselect · ?auto=MS autoplay hinted moves · ?turbo=N scale tween/timer
clocks · ?goal=N ?moves=N override level · ?plant=1 seed specials · ?spin=1 force spin ·
?autospin=1 auto-trigger spin · ?plinko[=PTS] open the bonus drop · ?slot=N pin its landing slot ·
?deal open the Lucky Deal · ?face=cherry|clover|bell|bar|diamond|seven|heart pin its winning face
(the only way to reach the CHARM / SERIES COMPLETE payoffs without grinding a 3% card; the deck is
still built by the REAL buildDeck, so a pinned hand keeps the ≤2 invariant) ·
?charms open the charm album from Home ·
?repro=upgrade|upgrade-col plant the "special swallowed by its
own upgrade" case (gapped column + a reel at (3,4); swipe it LEFT into the gap → match-4).
DEV strip (top-left) mirrors model state (level/state/moves/score/objectives/hint) — the
Claude browser pane starves the RAF clock and drops clicks while hidden; screenshots are
the only reliable channel there, so verify via strip + autoplay/autospin, and confirm
tap-targets on a real device.

## Build & deploy
npm run dev (5173, or $PORT if set — strict) · build (tsc+vite→dist) · preview (4173) ·
test (vitest run) · icons.
Deploy: GitHub Pages. With workflow scope: push to main → .github/workflows/deploy.yml
builds and deploys automatically. Legacy fallback: publish dist/ to gh-pages branch.

## Roadmap (agreed direction)
DONE: streak flame on Home (addStreakBadge) · endless daily-seed race after L10 (shared board,
BEST race — src/core/endless.ts) · star-milestone celebration every 10 levels (milestoneSplash) ·
lives/energy (lose-only, 5-pool, 20-min regen, grace below L10 — src/core/lives.ts) · in-level helper bar (spend
earned chips on +1/+5 moves or a targeted bomb for the current level — src/core/store.ts POWER_ITEMS).
TODO: tune levelSpec from Maya's real play · optionally let the daily spin grant a bonus life.
Still rejected: real-money purchases, cash-out, home-decorating meta. (Both lives/energy and mid-level
chip spending were previously rejected but reintroduced at the owner's request — 2026-07-17 and 2026-07-20.)

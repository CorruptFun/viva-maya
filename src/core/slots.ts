import { JACKPOT_GOAL } from './jackpot'
import type { Rng } from './rng'
import { SYMBOLS } from './types'
import type { BoostType, SymbolType } from './types'

/**
 * LUCKY SLOTS — the purchased spin. Pure logic (no Phaser), mirroring core/daily.ts, core/jackpot.ts
 * and core/plinko.ts.
 *
 * Every other machine in this game is a GIFT you are handed: the daily wheel arrives once a day, the
 * jackpot wheel arrives every fifth win, the plinko board falls out of a cascade you played well. None
 * of them can be reached for. This one you BUY, with chips you earned, whenever you feel like it — the
 * first reward surface in the build whose pacing is the player's to set.
 *
 * ── THE MACHINE ──────────────────────────────────────────────────────────────
 * Five reels, up to four rows, one payline per row read LEFT→RIGHT: three or more of the same symbol
 * starting at reel 1 pays. Your bet buys ROWS — one row is one payline, four rows are four — so paying
 * more is literally more chances on the same spin, and the top prize (the CHARM scatter, below) gets
 * dramatically more reachable with every row lit.
 *
 * Reels are STRIPS, not per-cell dice. Each reel stops at one index and the visible rows are that many
 * CONSECUTIVE strip entries (wrapping), which is how a real machine works and is what makes the view
 * honest: the strip on screen is the strip that was rolled. It also means rows in one column are
 * correlated — but not in a way that can distort the payout, because expectation is linear: each row is
 * `strip[(stop + row) % len]` with `stop` uniform, so every single line's marginal distribution is the
 * plain per-reel weighting, and total EV is exactly the per-line EV times the number of rows. Only the
 * HIT FREQUENCY (how often at least one line pays) feels the correlation — measured, not derived, in
 * slots.rate.test.ts.
 *
 * ── WHAT IT PAYS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────────
 * Power-ups (the same BoostType the Gift Store sells and the daily wheel pays), jackpot POINTS that
 * charge the wheel meter, and — very rarely — a CHARM.
 *
 * It never pays CHIPS. That is the whole safety argument: a chip-priced machine that paid chips is a
 * loop that either drains to nothing or mints forever depending on one constant, and the fairness rule
 * this economy is built on is that every faucet is a fixed-size gift, never a rate. Paying only in
 * consumables means the machine is a pure SINK no matter how much it is played — chips go in and never
 * come back out — so it cannot inflate the currency however it is tuned.
 *
 * ── THE HOUSE EDGE, AND WHY IT MUST EXIST ────────────────────────────────────
 * Prices are set so the expected return is BELOW the ticket at every row count (see SLOT_BETS and the
 * RTP guard in slots.rate.test.ts). That is not stinginess, it is the thing that stops this screen
 * cannibalising the Gift Store: the store hands you a boost for its exact price with no risk, so if the
 * slots returned ≥100% nobody would ever buy a boost outright again and the store would be dead
 * furniture. Under an edge the two coexist honestly — the store is "I want this one, now", the slots
 * are "I want a shot at more than I paid for".
 *
 * The edge narrows as you buy rows (≈78% at one row → ≈91% at four), so the "more rows is better" claim
 * on the cabinet is true in expectation and not just in excitement.
 *
 * ── AWARD-FIRST ──────────────────────────────────────────────────────────────
 * Like every other machine here, `buySpin` settles and BANKS the whole result before the view spins a
 * single reel. Closing the app mid-animation cannot lose a prize; the reels are theatre over a result
 * that is already in the save.
 */

/** Reels across the cabinet. Five, like every modern video slot. */
export const SLOT_REELS = 5

/** Rows the cabinet can light. The 4th is the max bet. */
export const SLOT_MAX_ROWS = 4

/** Symbols shortest run that pays. Classic left-to-right: reels 1..3 must match. */
export const SLOT_MIN_RUN = 3

/** Charm scatters needed anywhere in the LIT window to pay a charm. */
export const SLOT_SCATTER_NEEDED = 3

/**
 * A slot face: the six board symbols (so the machine is built out of the game's own art, exactly like
 * the daily cabinet) plus `charm` — the scatter, which is not a board piece at all.
 */
export type SlotSymbol = SymbolType | 'charm'

/** The scatter face. Only ever appears on `SCATTER_REELS`. */
export const SLOT_CHARM: SlotSymbol = 'charm'

/**
 * Reels the charm scatter lives on: the 1st, 3rd and 5th.
 *
 * Confining the scatter to three of the five reels is the standard way to make a top prize rare
 * without making it invisible, and it is what puts the charm's odds where they belong. Needing three
 * scatters out of three eligible reels means every one of them has to show it, so the rate is exactly
 * (rows / strip length)³ — 1 in ~244 spins at four rows, 1 in ~15,600 at one. Spreading the scatter
 * across all five reels instead would have forced strips several times longer to reach the same rarity,
 * and would have thrown away the cleanest demonstration this machine has that rows buy odds: sixty-four
 * times better at four rows than at one, from the same table.
 */
export const SCATTER_REELS: readonly number[] = [0, 2, 4]

// ─────────────────────────────────────────────────────────────────────────────
// THE STRIPS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every strip is this long, so a row's odds on any reel are `count / SLOT_STRIP_LEN` and the whole
 * table can be read off the compositions below without arithmetic.
 */
export const SLOT_STRIP_LEN = 25

/**
 * The five reel strips, hand-authored rather than generated.
 *
 * Composition is the entire tuning surface — the paytable multiplies it, nothing else touches it — so
 * it is written out face by face where it can be read and diffed. Every strip holds 25 faces:
 *
 *     cherry 10 · clover 7 · bell 3 · bar 2–3 · diamond 1 · seven 1 · charm 0–1
 *
 * Two properties are deliberate and are asserted in slots.test.ts:
 *
 *  • **The charm sits on reels 1, 3 and 5 only** (SCATTER_REELS). Reels 2 and 4 spend that face on an
 *    extra bar instead, so all five strips stay exactly 25 long and the odds stay readable.
 *  • **No two adjacent faces on a strip are the same.** A four-row window therefore never shows a
 *    column of stacked duplicates, which keeps the cabinet visually varied AND keeps a single reel from
 *    dumping the same symbol onto several paylines at once — the "one lucky column paid everything"
 *    shape that makes a machine feel arbitrary rather than lucky.
 */
export const SLOT_STRIPS: readonly (readonly SlotSymbol[])[] = [
  // Reel 1 — scatter reel.
  ['cherry', 'clover', 'cherry', 'bell', 'cherry', 'clover', 'bar', 'cherry', 'clover', 'cherry',
   'seven', 'clover', 'cherry', 'bell', 'cherry', 'clover', 'cherry', 'diamond', 'clover', 'cherry',
   'bell', 'cherry', 'charm', 'clover', 'bar'],
  // Reel 2 — plain reel (the charm's face goes to a third bar).
  ['clover', 'cherry', 'bar', 'cherry', 'clover', 'cherry', 'bell', 'cherry', 'clover', 'cherry',
   'diamond', 'cherry', 'clover', 'bell', 'cherry', 'bar', 'cherry', 'clover', 'cherry', 'seven',
   'clover', 'cherry', 'bell', 'clover', 'bar'],
  // Reel 3 — scatter reel.
  ['cherry', 'bell', 'cherry', 'clover', 'cherry', 'bar', 'clover', 'cherry', 'clover', 'cherry',
   'charm', 'cherry', 'clover', 'bell', 'cherry', 'clover', 'seven', 'cherry', 'clover', 'cherry',
   'diamond', 'cherry', 'bell', 'clover', 'bar'],
  // Reel 4 — plain reel.
  ['clover', 'cherry', 'bell', 'cherry', 'clover', 'cherry', 'bar', 'clover', 'cherry', 'diamond',
   'cherry', 'bell', 'clover', 'cherry', 'bar', 'clover', 'cherry', 'seven', 'cherry', 'bell',
   'cherry', 'clover', 'cherry', 'clover', 'bar'],
  // Reel 5 — scatter reel.
  ['cherry', 'clover', 'seven', 'cherry', 'bell', 'cherry', 'clover', 'cherry', 'bar', 'clover',
   'cherry', 'diamond', 'cherry', 'clover', 'bell', 'cherry', 'charm', 'clover', 'cherry', 'bar',
   'cherry', 'clover', 'bell', 'cherry', 'clover'],
]

// ─────────────────────────────────────────────────────────────────────────────
// THE PAYTABLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one winning line hands over.
 *
 * `boosts` copies of `boost` go straight into `pendingBoosts` (the same pile the daily spin and the
 * Gift Store feed), and `points` charge the jackpot meter. A run of 3 pays the power-up alone — the
 * bread-and-butter win — and only 4s and 5s carry jackpot points, so the meter stays something the
 * machine occasionally throws in rather than its main product.
 */
export interface SlotPayout {
  boosts: number
  points: number
}

export interface SlotSymbolPay {
  symbol: SymbolType
  /** The power-up this face pays. */
  boost: BoostType
  /** Payout for a run of exactly 3, 4 and 5 — indexed by `run - SLOT_MIN_RUN`. */
  runs: [SlotPayout, SlotPayout, SlotPayout]
}

/**
 * Face → prize, richest face last. The mapping is deliberately value-ordered against the Gift Store's
 * own price list (+5 MOVES 40 · WILD REEL 60 · DICE BOMB 75 · DOUBLE SCORE 90 · JACKPOT CHIP 120), so
 * the rarer the face on the strips, the better the boost it pays and the ladder reads correctly to a
 * player who has only ever seen the store.
 *
 * Cherry carries the machine: at 10 faces in 25 it is ~72% of the total expected return, which is the
 * normal shape for a slot — the common symbol is what makes the thing pay often enough to be worth
 * playing, and the rare faces are the story you tell afterwards. Seven is the top face and is the only
 * one whose five-of-a-kind breaks the pattern (5 boosts and 10 points rather than 4 and 5); at 1 in
 * ~9.8 million per line it costs essentially nothing in EV and gives the paytable a real summit.
 */
export const SLOT_PAYS: SlotSymbolPay[] = [
  {
    symbol: 'cherry',
    boost: 'extraMoves',
    runs: [{ boosts: 1, points: 0 }, { boosts: 2, points: 2 }, { boosts: 4, points: 5 }],
  },
  {
    symbol: 'clover',
    boost: 'wildReel',
    runs: [{ boosts: 1, points: 0 }, { boosts: 2, points: 2 }, { boosts: 4, points: 5 }],
  },
  {
    symbol: 'bell',
    boost: 'diceBomb',
    runs: [{ boosts: 1, points: 0 }, { boosts: 2, points: 2 }, { boosts: 4, points: 5 }],
  },
  {
    symbol: 'bar',
    boost: 'doubleScore',
    runs: [{ boosts: 1, points: 0 }, { boosts: 2, points: 2 }, { boosts: 4, points: 5 }],
  },
  {
    symbol: 'diamond',
    boost: 'jackpot',
    runs: [{ boosts: 1, points: 0 }, { boosts: 2, points: 2 }, { boosts: 4, points: 5 }],
  },
  {
    symbol: 'seven',
    boost: 'jackpot',
    runs: [{ boosts: 1, points: 0 }, { boosts: 2, points: 3 }, { boosts: 5, points: 10 }],
  },
]

/** Paytable row for a face, or undefined for the scatter (which pays by count, not by run). */
export function payFor(symbol: SlotSymbol): SlotSymbolPay | undefined {
  return SLOT_PAYS.find(p => p.symbol === symbol)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BETS
// ─────────────────────────────────────────────────────────────────────────────

export interface SlotBet {
  /** Rows lit — and therefore paylines played. 1..SLOT_MAX_ROWS. */
  rows: number
  /** Chips this spin costs. */
  price: number
}

/**
 * The four bets, cheapest first. `rows` IS the number of paylines, so the ladder is "how much of the
 * cabinet do you want switched on".
 *
 * Priced at 12 / 22 / 32 / 42 — a flat +10 per row, which means each extra row is cheaper than the
 * first one was while paying exactly as much. That is where "more rows, better odds" stops being
 * marketing: expected return climbs ≈78% → ≈85% → ≈89% → ≈91% across the ladder (guarded in
 * slots.rate.test.ts), because the price rises linearly while the scatter — whose odds go with the
 * CUBE of the row count — does not.
 *
 * The absolute numbers are set against a level win's ~25–45 chip payout: one win buys roughly one max
 * bet, so the machine is a treat you can reach for after a good level rather than a grind, and against
 * the Gift Store's 40–120 shelf, so a max spin is never more than a cheap boost.
 */
export const SLOT_BETS: SlotBet[] = [
  { rows: 1, price: 12 },
  { rows: 2, price: 22 },
  { rows: 3, price: 32 },
  { rows: 4, price: 42 },
]

/** The bet for a row count (clamped into the table). */
export function betFor(rows: number): SlotBet {
  const i = Math.max(0, Math.min(SLOT_BETS.length - 1, Math.round(rows) - 1))
  return SLOT_BETS[i]
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SPIN
// ─────────────────────────────────────────────────────────────────────────────

/** One paying line: which row, which face, how far the run reached, and what it hands over. */
export interface SlotLineWin {
  row: number
  symbol: SymbolType
  /** Matching faces from reel 1 (3..SLOT_REELS). */
  run: number
  payout: SlotPayout
}

/** A settled spin, before anything is banked. `grid[row][reel]`, rows top → bottom. */
export interface SlotSpin {
  bet: SlotBet
  /** Where each reel stopped (index into its strip) — the view replays exactly these. */
  stops: number[]
  /** The LIT window only: `bet.rows` rows of SLOT_REELS faces. */
  grid: SlotSymbol[][]
  lines: SlotLineWin[]
  /** Charm faces in the lit window, as [row, reel] — the cells the view lights up. */
  scatters: [number, number][]
  /** True once `scatters` reaches SLOT_SCATTER_NEEDED. */
  charm: boolean
  /** Every boost the lines paid, in reel order (may repeat). */
  boosts: BoostType[]
  /** Jackpot points the lines paid, before the meter's own headroom clamps them. */
  points: number
}

/** The face showing in `row` of `reel` when that reel stopped at `stop`. */
export function faceAt(reel: number, stop: number, row: number): SlotSymbol {
  const strip = SLOT_STRIPS[reel]
  return strip[(stop + row) % strip.length]
}

/**
 * Read one payline left→right: the run of the leading face, and the pay it earns.
 *
 * The scatter never forms a line — it pays by COUNT across the whole window, so a charm sitting in
 * reel 1 must not start a run (and must not block one either; it simply isn't a line symbol).
 */
export function readLine(row: SlotSymbol[]): SlotLineWin | null {
  const lead = row[0]
  if (lead === SLOT_CHARM) return null
  const pay = payFor(lead)
  if (!pay) return null
  let run = 1
  while (run < row.length && row[run] === lead) run++
  if (run < SLOT_MIN_RUN) return null
  return { row: 0, symbol: lead as SymbolType, run, payout: pay.runs[run - SLOT_MIN_RUN] }
}

/**
 * Roll a spin. PURE — decides the stops, reads the window, and totals the prizes. Banks nothing; that
 * is `buySpin`'s job (see slotstore.ts), which is what keeps this testable against a seeded Rng.
 */
export function spinSlots(rng: Rng, rows: number): SlotSpin {
  const bet = betFor(rows)
  const stops = SLOT_STRIPS.map(strip => Math.floor(rng() * strip.length) % strip.length)
  const grid: SlotSymbol[][] = []
  for (let row = 0; row < bet.rows; row++) {
    grid.push(stops.map((stop, reel) => faceAt(reel, stop, row)))
  }

  const lines: SlotLineWin[] = []
  const boosts: BoostType[] = []
  let points = 0
  grid.forEach((cells, row) => {
    const win = readLine(cells)
    if (!win) return
    lines.push({ ...win, row })
    const pay = payFor(win.symbol)
    if (pay) for (let i = 0; i < win.payout.boosts; i++) boosts.push(pay.boost)
    points += win.payout.points
  })

  const scatters: [number, number][] = []
  grid.forEach((cells, row) =>
    cells.forEach((face, reel) => {
      if (face === SLOT_CHARM) scatters.push([row, reel])
    })
  )

  return { bet, stops, grid, lines, scatters, charm: scatters.length >= SLOT_SCATTER_NEEDED, boosts, points }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ECONOMY AUDIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one unit of each prize is WORTH in chips — the reference the RTP guard in slots.rate.test.ts
 * measures the machine against. Not used by the game itself; it exists so "is this machine priced
 * honestly" is a question the test suite answers rather than a thing somebody has to re-derive.
 *
 *  • **boosts** — the Gift Store's own prices (core/store.ts BOOST_ITEMS). Those are what the player
 *    can actually pay for the same goods, so they are the only defensible valuation.
 *  • **point** — one notch of the jackpot meter, priced as (one wheel spin's expected value) /
 *    JACKPOT_GOAL. The wheel pays 114 chips on average plus a ~36% chance of a mid-tier boost
 *    (~70 chips), so ≈139 chips per spin over 5 notches ≈ 28 chips a notch.
 *  • **charm** — deliberately valued HIGH (a charm buys a bonus-wheel pull outright in the charm
 *    exchange, i.e. ~139 chips, and it is also +1 permanent LUCK and a step toward a 500-chip series
 *    purse). Overvaluing the rarest prize can only make the guard stricter, which is the direction an
 *    audit constant should err in.
 */
export const SLOT_CHIP_VALUE = {
  boost: { extraMoves: 40, wildReel: 60, diceBomb: 75, doubleScore: 90, jackpot: 120 } as Record<BoostType, number>,
  point: 28,
  charm: 200,
} as const

/** Chip-equivalent worth of a settled spin — the audit's view of what the player just won. */
export function spinChipValue(spin: SlotSpin): number {
  const boosts = spin.boosts.reduce((sum, b) => sum + SLOT_CHIP_VALUE.boost[b], 0)
  return boosts + spin.points * SLOT_CHIP_VALUE.point + (spin.charm ? SLOT_CHIP_VALUE.charm : 0)
}

/**
 * Exact expected chip-equivalent return for a bet, computed CLOSED-FORM rather than sampled.
 *
 * Legitimate because expectation is linear: a row's faces are `strip[(stop + row) % len]` with `stop`
 * uniform, so each row is marginally an independent per-reel draw even though rows in a column are
 * correlated. Total line EV is therefore exactly `rows × (one line's EV)`, and the scatter is exact
 * too — a window of `rows` consecutive faces contains a strip's single charm iff the stop is one of
 * `rows` positions, so all three scatter reels showing it is (rows / len)³.
 *
 * The Monte-Carlo half of slots.rate.test.ts checks this against a real sampled run, so a change to
 * the strips that breaks the reasoning shows up as the two disagreeing.
 */
export function expectedReturn(rows: number): number {
  const bet = betFor(rows)
  const p = (reel: number, face: SlotSymbol): number =>
    SLOT_STRIPS[reel].filter(f => f === face).length / SLOT_STRIPS[reel].length

  let perLine = 0
  for (const pay of SLOT_PAYS) {
    // P(the first `n` reels all show this face) — the chance a run reaches AT LEAST n.
    const atLeast: number[] = []
    let acc = 1
    for (let reel = 0; reel < SLOT_REELS; reel++) {
      acc *= p(reel, pay.symbol)
      atLeast.push(acc)
    }
    for (let run = SLOT_MIN_RUN; run <= SLOT_REELS; run++) {
      // Exactly `run` long: reaches `run` but not `run + 1` (a 5 has nothing beyond it to fail).
      const exactly = atLeast[run - 1] - (run < SLOT_REELS ? atLeast[run] : 0)
      const payout = pay.runs[run - SLOT_MIN_RUN]
      perLine += exactly * (payout.boosts * SLOT_CHIP_VALUE.boost[pay.boost] + payout.points * SLOT_CHIP_VALUE.point)
    }
  }

  const scatter = SCATTER_REELS.reduce((chance, reel) => chance * (bet.rows / SLOT_STRIPS[reel].length), 1)
  return perLine * bet.rows + scatter * SLOT_CHIP_VALUE.charm
}

/** Return-to-player for a bet: expected chip-equivalent out ÷ chips in. Always < 1 by design. */
export function returnToPlayer(rows: number): number {
  const bet = betFor(rows)
  return expectedReturn(bet.rows) / bet.price
}

/** Exact chance a bet lands the charm scatter — `(rows / strip length)` on each of the three reels. */
export function charmChance(rows: number): number {
  const bet = betFor(rows)
  return SCATTER_REELS.reduce((chance, reel) => chance * (bet.rows / SLOT_STRIPS[reel].length), 1)
}

/** Every face on the strips, board symbols first then the scatter — the paytable panel's row order. */
export const SLOT_FACES: SlotSymbol[] = [...SYMBOLS, SLOT_CHARM]

/** Re-exported so the view can size "how full is the meter" copy without importing two modules. */
export { JACKPOT_GOAL }

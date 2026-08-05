import { isAct2Level } from './actII'
import type { Board } from './board'
import { DIFFICULTY } from './difficulty'
import { mulberry32, randInt } from './rng'
import type { Rng } from './rng'
import type { Coord } from './types'

/**
 * THE PIT BOSS — Floor 2's mechanic, and the first thing in this game that ADDS work mid-level.
 *
 * Every few moves the House takes a visible turn at the table: a CLAMP DEAL puts a dealer's clamp on
 * a few squares, and from `pitBossFeltFrom` a FRESH FELT deal lays new baize. Floor 2 shipped in
 * Slice 1 as a re-dress of Floor 1 — same verb, same hazards, new candlelight — and this is what
 * makes it a floor rather than a paint job.
 *
 * ── THE FAIRNESS CONSTITUTION IS BINDING ────────────────────────────────────────────────────────
 * *The House may add work; it may never add despair.* Every clause below is load-bearing, and the
 * mechanic is worth nothing without them — an opponent that can act on you at random is not a
 * villain, it is noise:
 *
 *  1. THE SCHEDULE IS A PURE FUNCTION OF THE LEVEL. `dealPlan(level, moves)` draws from its own
 *     stream seeded off the level alone, so the deals land on the SAME moves on every attempt. A
 *     level you failed is therefore learnable as a RHYTHM — the same bargain `hazardPlan` already
 *     strikes (the plan is fixed, the symbols are fresh), and the reason a second-attempt clear
 *     reads as earned rather than lucky.
 *  2. TELEGRAPHED A FULL MOVE AHEAD. Placement is decided one move early (`dealTargets`) and shown,
 *     so you always get one move to answer it. Hence `FIRST_DEAL_AT` — a deal can never land before
 *     there has been a move to telegraph it on.
 *  3. THE DEALER STANDS ON YOUR LAST FIVE. Nothing lands with fewer than `STAND_OFF` moves left. An
 *     endgame you had solved cannot be taken away from you.
 *  4. BUDGETED UP FRONT. The level's move budget grows by `dealMoveAllowance` before a single deal is
 *     placed (core/levels.ts folds it in beside the teaching bonus), so the work is PAID FOR rather
 *     than taken out of a budget sized for a table nobody was interfering with.
 *  5. AT LEAST `DEAL_GAP` MOVES BETWEEN DEALS. Two deals in quick succession read as a malfunction.
 *  6. NEVER MID-CASCADE. GameScene fires this from the idle handoff at the tail of `resolveLoop` —
 *     the seam Plinko already uses — on a settled, playable board, and AFTER the win/lose checks
 *     have returned. So a deal can never interrupt a chain, and can never un-win a won level.
 *  7. EMPTY CHAIR ON EVERY BREATHER. `level % 5 === 0` gets no deals at all, the same beat the
 *     hazard densities already halve. The floor's rhythm needs a bar's rest in it.
 *  8. IT PRESSURES THE TABLE, NEVER YOUR PIECES. A deal may clamp a plain piece or lay felt on a
 *     bare square. It may not touch a special you banked, and it may never take the last legal move
 *     off the board (see `Board.dealLocks`).
 *
 * ── DORMANT BY ABSENCE ──────────────────────────────────────────────────────────────────────────
 * Everything here keys off a level NUMBER, and endless has none. `Board.dealLocks`/`dealCoats`/
 * `dealBlocker` are additive operations nothing on the endless path invokes, exactly like
 * `pullColumn`. `boardpick.test.ts`'s goldens are the tripwire and must pass unmodified.
 */

/** What the House is dealing. */
export type DealKind = 'clamp' | 'felt'

export interface Deal {
  /** Moves SPENT when this lands — the deal resolves at the settle after the player's `atMove`th move. */
  atMove: number
  kind: DealKind
  /** How many squares it takes. */
  cells: number
}

/** Earliest a deal may land. `>= 2` is what buys the telegraph its move; 3 lets the player settle in. */
const FIRST_DEAL_AT = 3

/** The dealer stands on your last five: nothing lands with fewer than this many moves left. */
const STAND_OFF = 5

/** Fewest moves between two deals. Closer together and the table reads as malfunctioning. */
const DEAL_GAP = 4

/**
 * Squares per deal.
 *
 * A CLAMP is the cheap instrument by measurement — `difficulty.ts` records a lock at roughly a tenth
 * of a blocker's cost per cell, and a clamp lifts the moment any clear lands beside it — so three is
 * a visible turn rather than a punishing one. FELT is genuinely dear: every dealt square is one more
 * on the win condition, so two is the whole deal.
 */
const CLAMP_CELLS = 3
const FELT_CELLS = 2

/**
 * True when this numbered level has a pit boss working it.
 *
 * Bounded by `isAct2Level`, which is what keeps it inside the SHIPPED tower rather than merely above
 * a number: a level past the last floor in `FLOORS` has no room, no mood and no croupier, and an
 * antagonist working a room that does not exist is the one Act II failure a staged rollout must not
 * have. It also means the boss follows the tower up on its own when the next floor pair lands, which
 * is what the mechanic ladder asks for (the deals gain a lockbox upstairs).
 */
export function pitBossLevel(level: number): boolean {
  const { act2 } = DIFFICULTY
  if (!act2.pitBoss || !isAct2Level(level)) return false
  if (level < act2.pitBossStart) return false
  // Clause 7 — the empty chair. The every-5th breather is the beat the hazard densities already
  // halve, and a floor whose antagonist never sits down is a floor with no rhythm.
  return level % 5 !== 0
}

/**
 * How many deals this level takes. A pure band ramp: two while the clamp is the whole book, three
 * once fresh felt joins it. Zero off the band and on every breather.
 */
export function dealCount(level: number): number {
  if (!pitBossLevel(level)) return 0
  return level >= DIFFICULTY.act2.pitBossFeltFrom ? 3 : 2
}

/**
 * How many of this level's deals are FRESH FELT. Exactly one once the band opens: the boss always
 * leads with a clamp (see `dealPlan`), so the felt is the second deal and there is only ever one.
 * Kept as its own function because the move allowance is priced off it and `dealPlan` cannot be —
 * the plan needs the move budget, and the budget needs the allowance.
 */
export function feltDealCount(level: number): number {
  return dealCount(level) >= 2 && level >= DIFFICULTY.act2.pitBossFeltFrom ? 1 : 0
}

/**
 * Extra moves the level is given for the work the House is about to add — clause 4, and the one
 * piece of this mechanic that lives outside this module (core/levels.ts folds it into the budget
 * beside the teaching bonus, gated on the same `curve.enabled` panic switch).
 *
 * ── IT IS PRICED AT MEASURED COST, NOT PER DEAL ─────────────────────────────────────────────────
 * The first cut paid one move per deal. Measured against the real board (banker proxy, 40 seeds,
 * 2026-08-05) that turned out to be a large OVERPAYMENT — the levels came out measurably easier than
 * the floor they were meant to intensify:
 *
 *     level          352  358  363  372  378  387  393  399
 *     no boss         33   35   53   33   33   23   35   23   (% cleared)
 *     deals, unpaid   33   40   53   38   30   28   40   33
 *     deals, +1/deal  43   48   60   43   38   43   43   43
 *
 * Read the middle row: the deals cost the proxy NOTHING. That is not a claim that they cost a player
 * nothing — it is the same blindness `difficulty.ts` records for felt ("the proxy cannot see it and
 * clears it by accident") and `sim.ts` records for the pull, pointing the other way for once: the
 * measurement bounds how HARMLESS the mechanic is, not how harmful. A clamp lifts on the next clear
 * that lands beside it and the banker never had a plan for it to spoil; a person loses the move they
 * had lined up.
 *
 * So paying per deal would be buying insurance against a cost this instrument cannot see, with moves
 * it CAN see — and the bottom row is what that costs: a Floor 2 easier than the Floor 1 above it.
 * What is paid for instead is the felt, which is the one deal that provably adds to the WIN
 * CONDITION (`coatsToClear` grows by every square dealt), and the clamp is free because it provably
 * removes nothing from the board. Re-derive these rows, never hand-tune them.
 *
 * ⚠️ ZERO ON A BREATHER, and that is not an oversight. A breather takes no deals, so an allowance
 * there would pay for work that never arrives — and, less obviously, it would put a saw-tooth into
 * the collect ratio that `levels.test.ts`'s monotonicity assertion reads. As it stands the level
 * after every breather is a plaque level, which that test already carves out, so the series stays
 * clean. (`LEVEL_COUNT` is itself a multiple of 5 — a breather — which is also why the "climbs by
 * L300" ratio guard is untouched by any of this.)
 */
export function dealMoveAllowance(level: number): number {
  return feltDealCount(level)
}

/**
 * WHEN the House acts, for a level of `moves` moves. Deterministic — same level, same schedule,
 * every attempt (clause 1).
 *
 * The window is `[FIRST_DEAL_AT, moves - STAND_OFF]`, split into equal buckets with one jittered
 * placement each, then walked forward to honour `DEAL_GAP`. A deal that cannot fit inside the window
 * is DROPPED rather than squeezed: fewer deals is always the kind failure.
 */
export function dealPlan(level: number, moves: number): Deal[] {
  const n = dealCount(level)
  if (n <= 0) return []
  const lo = FIRST_DEAL_AT
  const hi = Math.floor(moves) - STAND_OFF
  if (hi < lo) return []

  // Its OWN stream. Sharing `levelSpec`'s (0xc0ffee…) or `hazardPlan`'s (0x5eeded…) would shift
  // every goal symbol or every hazard cell in the game — the determinism trap hazards.ts documents.
  const rng = mulberry32((0xb0551e ^ Math.imul(level, 3266489917)) >>> 0)
  const span = hi - lo + 1
  const bucket = span / n
  const out: Deal[] = []
  let last = -Infinity
  for (let i = 0; i < n; i++) {
    const start = lo + Math.floor(i * bucket)
    let at = start + randInt(rng, Math.max(1, Math.floor(bucket)))
    if (at - last < DEAL_GAP) at = last + DEAL_GAP
    if (at > hi) break
    // Fresh felt joins the book at `pitBossFeltFrom`, and only ever as the SECOND deal of the level:
    // the first one is always a clamp, so the rhythm teaches itself with the cheap instrument before
    // the dear one arrives.
    const kind: DealKind = level >= DIFFICULTY.act2.pitBossFeltFrom && i === 1 ? 'felt' : 'clamp'
    out.push({ atMove: at, kind, cells: kind === 'felt' ? FELT_CELLS : CLAMP_CELLS })
    last = at
  }
  return out
}

/**
 * WHERE the House acts — decided one move early so it can be telegraphed (clause 2), from a stream
 * the caller owns so it can never disturb the board's own.
 *
 * Eligibility is the whole safety story here (clause 8):
 *  · a CLAMP wants a plain, unclamped, unblocked piece. Never a special — a Wild Reel you built and
 *    were saving is yours, and the House pressures the table, not your hand.
 *  · FELT wants a bare square with nothing already on it and no blocker standing there. A coat under
 *    a lockbox is the unreachable-coat bug the original `hazardPlan` avoids by construction.
 * Both spread across DISTINCT COLUMNS where they can, so a deal reads as the House working the whole
 * table rather than as three squares picked out of one column.
 *
 * Returns fewer than `n` — possibly none — when the board cannot supply the cells. A short deal is
 * always correct; a deal that forced its way onto ineligible cells would not be.
 */
export function dealTargets(b: Board, kind: DealKind, n: number, rng: Rng): Coord[] {
  const pool: Coord[] = []
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      const at = { row: r, col: c }
      const p = b.get(at)
      if (!p || p.kind === 'blocker') continue
      if (kind === 'clamp') {
        if (p.kind !== 'normal' || p.locked) continue
      } else if (b.coatAt(at) > 0) continue
      pool.push(at)
    }
  }
  // Shuffle once, then take: one per column on the first walk, topping up from the rest only if the
  // board could not supply that many columns. One shuffle keeps this a clean function of `rng`.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1)
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  const out: Coord[] = []
  const usedCols = new Set<number>()
  for (const cell of pool) {
    if (out.length >= n) break
    if (usedCols.has(cell.col)) continue
    usedCols.add(cell.col)
    out.push(cell)
  }
  for (const cell of pool) {
    if (out.length >= n) break
    if (out.some(c => c.row === cell.row && c.col === cell.col)) continue
    out.push(cell)
  }
  return out
}

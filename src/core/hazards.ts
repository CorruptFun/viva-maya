import { mulberry32, randInt } from './rng'
import { DIFFICULTY, isTeachingLevel } from './difficulty'
import type { HazardKind } from './difficulty'

/**
 * Deterministic hazard PLAN for a numbered level — pure logic, no Phaser, no board state.
 *
 * The plan says WHICH CELLS carry a hazard; the symbols under them are still rolled fresh on every
 * attempt, exactly mirroring how objectives already work (`levelSpec` fixes the goals, the board
 * fills at random). That mix is deliberate: a failed level is LEARNABLE — the table looks the same
 * next try — which is what makes a second-attempt clear feel earned rather than lucky.
 *
 * ── DETERMINISM TRAP (do not "simplify" this away) ──────────────────────────────────────────
 * `levelSpec` seeds `mulberry32(0xc0ffee ^ imul(L, 2654435761))` and consumes it in its
 * objective-symbol loop. Drawing from THAT stream here — or adding any draw before it — would
 * shift every existing level's goal symbols and silently rewrite the whole game. Hazard placement
 * therefore runs on its own independent stream, and `levels.test.ts` freezes L1-30 to prove it.
 *
 * ── SAFETY PROPERTIES (relied on elsewhere; keep them true) ─────────────────────────────────
 *  1. Nothing here is ever created mid-level. Every hazard is seeded at level start and every
 *     rule only ever REMOVES them, so a level gets strictly easier as it proceeds and can never
 *     soft-lock behind a hazard it just spawned.
 *  2. Blockers can never wall off a column (>=1 per column, never row 0), which — together with
 *     segment-aware gravity in board.ts — is what keeps cascades deep enough for Plinko to fire.
 *  3. Below `bands.lockStart` the plan is empty, so the early game is untouched.
 */

/** A coated table square: `layers` clears strip one each. Sits UNDER the pieces, blocks nothing. */
export interface CoatCell {
  row: number
  col: number
  layers: number
}

/** An obstacle occupying a cell: never matches, never swaps, broken by adjacent clears. */
export interface BlockerCell {
  row: number
  col: number
  hp: number
}

/** A normal piece that still matches but cannot be swapped until an adjacent clear frees it. */
export interface LockCell {
  row: number
  col: number
}

export interface HazardPlan {
  coats: CoatCell[]
  blockers: BlockerCell[]
  locks: LockCell[]
}

export const EMPTY_PLAN: HazardPlan = { coats: [], blockers: [], locks: [] }

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

/** Linear count ramp across a level window, rounded. Flat below `from`, flat at `hi` above `to`. */
function ramp(level: number, from: number, to: number, lo: number, hi: number): number {
  if (to <= from) return hi
  return Math.round(lo + (hi - lo) * clamp01((level - from) / (to - from)))
}

/**
 * How many cells of `kind` this level seeds, before caps. Zero below the mechanic's band start or
 * when its flag is off. Every 5th level scales down by `breatherHazardScale` — the visible
 * replacement for the old invisible "+2 moves" breather.
 */
export function densityFor(kind: HazardKind, level: number): number {
  const { hazards, bands, density, breatherHazardScale } = DIFFICULTY
  if (!hazards.enabled || !hazards[kind]) return 0

  const d = density[kind]
  if (level < d.from) return 0

  const raw =
    level <= bands.lateStart
      ? ramp(level, d.from, d.to, d.count[0], d.count[1])
      : ramp(level, bands.lateStart, 300, d.lateCount[0], d.lateCount[1])

  // A teaching level always gets that band's FLOOR, never a breather-shrunk version of it.
  if (isTeachingLevel(level) && level === d.from) return d.count[0]

  const scaled = level % 5 === 0 ? Math.floor(raw * breatherHazardScale) : raw
  return Math.max(0, scaled)
}

const cellKey = (row: number, col: number): string => `${row},${col}`

/**
 * Draw `n` distinct cells from `pool` (mutating it), using `rng`. Returns fewer than `n` only when
 * the pool runs dry — callers treat that as "the caps bound harder than the density", which is the
 * intended precedence.
 */
function drawCells(rng: () => number, pool: { row: number; col: number }[], n: number): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = []
  for (let i = 0; i < n && pool.length > 0; i++) {
    out.push(pool.splice(randInt(rng, pool.length), 1)[0])
  }
  return out
}

/**
 * The full hazard layout for `level` on a `rows`x`cols` board. Deterministic: same level always
 * yields an identical plan. Returns `EMPTY_PLAN` for the protected early game and for endless
 * (which passes level 0 and is excluded at the call site regardless).
 */
export function hazardPlan(level: number, rows: number, cols: number): HazardPlan {
  if (!DIFFICULTY.hazards.enabled || level < DIFFICULTY.bands.lockStart) return EMPTY_PLAN

  // Independent stream — see the determinism trap above.
  const rng = mulberry32((0x5eeded ^ Math.imul(level, 2246822519)) >>> 0)
  const { caps, density } = DIFFICULTY

  // ── Blockers first: the most constrained placement, so it gets first pick of the board. ──
  const blockers: BlockerCell[] = []
  const wantBlockers = Math.min(densityFor('blocker', level), caps.maxBlockers)
  if (wantBlockers > 0) {
    const perCol = new Map<number, number>()
    const perRow = new Map<number, number>()
    const pool: { row: number; col: number }[] = []
    for (let r = 0; r < rows; r++) {
      if ((caps.forbiddenBlockerRows as readonly number[]).includes(r)) continue
      for (let c = 0; c < cols; c++) pool.push({ row: r, col: c })
    }
    while (blockers.length < wantBlockers && pool.length > 0) {
      const [cell] = drawCells(rng, pool, 1)
      if (!cell) break
      const colUsed = perCol.get(cell.col) ?? 0
      const rowUsed = perRow.get(cell.row) ?? 0
      if (colUsed >= caps.blockersPerColumn || rowUsed >= caps.blockersPerRow) continue
      perCol.set(cell.col, colUsed + 1)
      perRow.set(cell.row, rowUsed + 1)
      blockers.push({ row: cell.row, col: cell.col, hp: 1 })
    }
    // Second hit points creep in only in the late band.
    const hp2 =
      level < density.blocker2HpFrom
        ? 0
        : Math.round(
            blockers.length *
              density.blocker2HpMaxFrac *
              clamp01((level - density.blocker2HpFrom) / (300 - density.blocker2HpFrom))
          )
    for (let i = 0; i < hp2 && i < blockers.length; i++) blockers[i].hp = 2
  }

  const taken = new Set(blockers.map(b => cellKey(b.row, b.col)))
  const freeCells: { row: number; col: number }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) if (!taken.has(cellKey(r, c))) freeCells.push({ row: r, col: c })
  }

  // ── Coats: on the floor, so they may sit under a locked piece (adds depth, costs nothing).
  //    Never under a blocker — an unreachable coat reads as a bug even though the blocker breaks. ──
  const coatPool = [...freeCells]
  const coats: CoatCell[] = drawCells(rng, coatPool, densityFor('coat', level)).map(c => ({ ...c, layers: 1 }))
  const layer2 =
    level < density.coat2LayerFrom
      ? 0
      : Math.round(
          coats.length *
            density.coat2LayerMaxFrac *
            clamp01((level - density.coat2LayerFrom) / (300 - density.coat2LayerFrom))
        )
  for (let i = 0; i < layer2 && i < coats.length; i++) coats[i].layers = 2

  // ── Locks: on the piece. Drawn from a fresh copy of the free cells, so a locked piece may
  //    stand on a coated square. Cheap by measurement — used for texture, not for difficulty. ──
  const lockPool = [...freeCells]
  const locks: LockCell[] = drawCells(rng, lockPool, densityFor('lock', level))

  return { coats, blockers, locks }
}

/** Total coat layers to clear — the win condition's second term. 0 when coats are off. */
export function coatsToClear(plan: HazardPlan): number {
  return plan.coats.reduce((sum, c) => sum + c.layers, 0)
}

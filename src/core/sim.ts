import { POINTS_PER_PIECE } from '../config'
import { Board } from './board'
import { ENDLESS_MOVES } from './endless'
import { levelSpec } from './levels'
import type { LevelSpec } from './types'
import { hazardPlan } from './hazards'
import type { HazardPlan } from './hazards'
import { plinkoSlots, rollSlotIndex, shouldOfferPlinko } from './plinko'
import { mulberry32 } from './rng'
import type { Rng } from './rng'
import { SYMBOLS } from './types'
import type { Coord, Piece, SymbolType } from './types'

/**
 * Headless play of the REAL board core — one simulator, shared by every test that needs to know
 * how the game actually behaves rather than how we hope it behaves.
 *
 * This was extracted from `plinko.rate.test.ts`, which grew the first version of it. Having two
 * copies would be worse than untidy: that test guards Plinko's feel and this one guards difficulty,
 * and if they disagreed about how a level is played, one of them would be quietly lying. In
 * particular `playLevel` here SEEDS HAZARDS — a simulator that skipped them would keep measuring a
 * hazard-free world and report that everything is fine no matter how the hazards are tuned.
 *
 * The policies bracket real play rather than pretending to model it exactly:
 *   'first'  — takes the first valid swap it scans. A floor, weaker than any real player.
 *   'greedy' — takes the biggest opening wave it can SEE, no lookahead. Roughly a person playing
 *              quickly, and the policy the historical baselines were measured with.
 *   'banker' — greedy, but it values what the LEVEL wants: goal symbols, coats stripped and
 *              blockers damaged, not raw clear count. This is the "competent player" proxy the
 *              clear-rate bands are asserted against. A policy that ignored coats would starve the
 *              sweep goal and report false failures once coats gate the win.
 */
export type Policy = 'first' | 'greedy' | 'banker'

export interface LevelRun {
  won: boolean
  movesLeft: number
  collected: number
  needed: number
  coatsLeft: number
  /** Final score, counted the way GameScene's playWave does (`cleared × 20 × cascade`). What the
   *  HOUSE MINIMUM win term reads, and what minimum.rate.test.ts calibrates the plaque against. */
  score: number
  /** Settled chain depth for each move played. */
  chains: number[]
  maxCascade: number
  /** Sum over moves of blockers still standing — proves hazards decay instead of persisting. */
  blockerCellTurns: number
}

type Grid = (Piece | null)[][]
const gridOf = (b: Board): Grid => (b as unknown as { grid: Grid }).grid
const coatsOf = (b: Board): number[][] | null => (b as unknown as { coats: number[][] | null }).coats

interface Snap {
  grid: Grid
  coats: number[][] | null
}

/** Full board state, INCLUDING coats — a grid-only snapshot would let trial moves leak coat strips. */
function snapshot(b: Board): Snap {
  const coats = coatsOf(b)
  return {
    grid: gridOf(b).map(r => r.map(p => (p ? { ...p } : null))),
    coats: coats ? coats.map(r => [...r]) : null,
  }
}

function restore(b: Board, s: Snap): void {
  const cur = gridOf(b)
  for (let r = 0; r < s.grid.length; r++) {
    for (let c = 0; c < s.grid[r].length; c++) cur[r][c] = s.grid[r][c] ? { ...s.grid[r][c]! } : null
  }
  const coats = coatsOf(b)
  if (coats && s.coats) {
    for (let r = 0; r < s.coats.length; r++) for (let c = 0; c < s.coats[r].length; c++) coats[r][c] = s.coats[r][c]
  }
}

export function everyValidMove(b: Board): { a: Coord; to: Coord }[] {
  const out: { a: Coord; to: Coord }[] = []
  for (let r = 0; r < b.rows; r++) {
    for (let c = 0; c < b.cols; c++) {
      for (const to of [
        { row: r, col: c + 1 },
        { row: r + 1, col: c },
      ]) {
        if (b.inBounds(to) && b.wouldSwapMatch({ row: r, col: c }, to)) out.push({ a: { row: r, col: c }, to })
      }
    }
  }
  return out
}

/**
 * Columns THE REEL PULL could take on this board (Act II). Empty on every Act I level, because the
 * caller only asks when the spec carries `pull`.
 */
export function everyPull(b: Board): number[] {
  const out: number[] = []
  for (let c = 0; c < b.cols; c++) if (b.canPull(c)) out.push(c)
  return out
}

/** Goal-aware collect count for one wave: only goal symbols, never jackpots or blockers. */
function goalValue(cleared: { piece: Piece }[], goals: Set<SymbolType>): number {
  let n = 0
  for (const { piece } of cleared) {
    if (piece.kind === 'jackpot' || piece.kind === 'blocker') continue
    if (goals.has(piece.symbol)) n++
  }
  return n
}

/** Resolve a committed swap through the real cascade loop. Mirrors GameScene's resolve loop. */
function resolveSwap(
  b: Board,
  a: Coord,
  to: Coord,
  goals: Set<SymbolType>
): { cascade: number; collected: number } {
  b.swap(a, to)
  let wave = b.swapActivation(a, to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(a, to)
      return { cascade: 0, collected: 0 }
    }
    wave = b.matchWave([to, a])
  }
  let cascade = 0
  let collected = 0
  while (wave) {
    cascade++
    collected += goalValue(wave.cleared, goals)
    b.applyGravity()
    b.refill()
    wave = b.matchWave()
  }
  return { cascade, collected }
}

/** What a player can SEE before committing: the opening wave, scored by the chosen policy. */
function previewValue(b: Board, a: Coord, to: Coord, goals: Set<SymbolType>, policy: Policy): number {
  b.swap(a, to)
  let wave = b.swapActivation(a, to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(a, to)
      return 0
    }
    wave = b.matchWave([to, a])
  }
  if (!wave) return 0
  if (policy === 'greedy') return wave.cleared.length
  // 'banker' scores what the level actually asks for.
  const COAT_WEIGHT = 2
  const BLOCK_WEIGHT = 3
  const h = wave.hazards
  return (
    goalValue(wave.cleared, goals) * 2 +
    wave.cleared.length * 0.5 +
    (h ? h.coatsStripped.length * COAT_WEIGHT : 0) +
    (h ? (h.blockersDamaged.length + h.blockersBroken.length) * BLOCK_WEIGHT : 0)
  )
}

/**
 * What a player can SEE before committing a PULL — the same one-wave lookahead `previewValue` gives
 * a swap, so the two options are compared on equal terms.
 *
 * ⚠️ PROXY BIAS, stated plainly. This scores only what the pull IMMEDIATELY matches, which means the
 * proxy will essentially never spend a move on a pull that matches nothing — and repositioning for
 * a move you can see two moves out is the entire strategic point of the verb. So the sim's Act II
 * numbers are a FLOOR on player power and therefore a CEILING on difficulty: a level the banker can
 * clear is comfortably clearable, and one it struggles with may still be fine. Do not tune Act II
 * downward off these figures without first making the proxy plan a pull.
 */
function previewPull(b: Board, col: number, goals: Set<SymbolType>, policy: Policy): number {
  if (!b.pullColumn(col)) return 0
  const wave = b.matchWave()
  if (!wave) return 0
  if (policy === 'greedy') return wave.cleared.length
  const h = wave.hazards
  return (
    goalValue(wave.cleared, goals) * 2 +
    wave.cleared.length * 0.5 +
    (h ? h.coatsStripped.length * 2 : 0) +
    (h ? (h.blockersDamaged.length + h.blockersBroken.length) * 3 : 0)
  )
}

/** Resolve a committed PULL through the real cascade loop, decrementing objectives as it goes. */
function resolvePullTracking(b: Board, col: number, remaining: Map<SymbolType, number>): { cascade: number; points: number } {
  if (!b.pullColumn(col)) return { cascade: 0, points: 0 }
  let wave = b.matchWave()
  let cascade = 0
  let points = 0
  while (wave) {
    cascade++
    points += wave.cleared.length * POINTS_PER_PIECE * cascade
    for (const { piece } of wave.cleared) {
      if (piece.kind === 'jackpot' || piece.kind === 'blocker') continue
      const left = remaining.get(piece.symbol)
      if (left !== undefined && left > 0) remaining.set(piece.symbol, left - 1)
    }
    b.applyGravity()
    b.refill()
    wave = b.matchWave()
  }
  return { cascade, points }
}

/** Build the board a real attempt at `level` would get, hazards included. */
export function buildLevelBoard(level: number, seed: number): Board {
  const spec = levelSpec(level)
  const b = new Board(8, 8, spec.symbolCount, mulberry32(seed))
  b.seedHazards(hazardPlan(level, 8, 8))
  return b
}

/** Count blockers still standing. */
function blockersStanding(b: Board): number {
  let n = 0
  for (const row of gridOf(b)) for (const p of row) if (p?.kind === 'blocker') n++
  return n
}

/** Play one full attempt at `level` and report what happened. `specOverride` lets a measurement
 *  play a VARIANT of the level (minimum.rate.test.ts strips the score target to observe the
 *  natural full-budget score distribution — pricing the plaque off target-truncated runs is
 *  circular, since winners stop playing the moment they cross it). */
export function playLevel(level: number, seed: number, policy: Policy, specOverride?: LevelSpec): LevelRun {
  const spec = specOverride ?? levelSpec(level)
  const b = buildLevelBoard(level, seed)
  const goals = new Set(spec.objectives.map(o => o.symbol))
  const needed = spec.objectives.reduce((n, o) => n + o.count, 0)

  // Per-symbol remaining, so over-collecting one goal cannot pay for another (as in the real game).
  const remaining = new Map<SymbolType, number>()
  for (const o of spec.objectives) remaining.set(o.symbol, o.count)

  const chains: number[] = []
  let collected = 0
  let score = 0
  let blockerCellTurns = 0
  const scoreTarget = spec.scoreTarget ?? 0
  let m = 0

  for (; m < spec.moves; m++) {
    blockerCellTurns += blockersStanding(b)
    if ([...remaining.values()].every(v => v <= 0) && b.coatsRemaining() === 0 && score >= scoreTarget) break

    let moves = everyValidMove(b)
    if (moves.length === 0) {
      b.regenerate()
      moves = everyValidMove(b)
      if (moves.length === 0) break
    }

    let pick = moves[0]
    // THE REEL PULL competes with the swaps on the same yardstick — `pullCol` wins only when its
    // opening wave beats every swap's. Guarded by the SPEC's flag, not by the level number, so an
    // Act I measurement can never pick up a verb that level does not have and every recorded figure
    // for L1–300 stays exactly where it was.
    let pullCol = -1
    if (policy !== 'first') {
      const snap = snapshot(b)
      let best = -Infinity
      for (const mv of moves) {
        const v = previewValue(b, mv.a, mv.to, goals, policy)
        restore(b, snap)
        if (v > best) {
          best = v
          pick = mv
        }
      }
      if (spec.pull) {
        for (const col of everyPull(b)) {
          const v = previewPull(b, col, goals, policy)
          restore(b, snap)
          if (v > best) {
            best = v
            pullCol = col
          }
        }
      }
    }

    // Track per-symbol progress through the committed wave. A pull costs the same one move a swap
    // does — that is the whole trade the verb sells — so both land in the same loop iteration.
    const before = new Map(remaining)
    const res =
      pullCol >= 0 ? resolvePullTracking(b, pullCol, remaining) : resolveSwapTracking(b, pick.a, pick.to, remaining)
    chains.push(res.cascade)
    score += res.points
    for (const [s, v] of before) collected += Math.max(0, v - (remaining.get(s) ?? 0))
  }

  const objectivesMet = [...remaining.values()].every(v => v <= 0)
  return {
    won: objectivesMet && b.coatsRemaining() === 0 && score >= scoreTarget,
    movesLeft: Math.max(0, spec.moves - m),
    collected,
    needed,
    coatsLeft: b.coatsRemaining(),
    score,
    chains,
    maxCascade: chains.length > 0 ? Math.max(...chains) : 0,
    blockerCellTurns,
  }
}

/** resolveSwap, but decrementing per-symbol objective counters — and totting up points — exactly
 *  as the real scene does (`cleared × POINTS_PER_PIECE × cascade`, the playWave rule). */
function resolveSwapTracking(
  b: Board,
  a: Coord,
  to: Coord,
  remaining: Map<SymbolType, number>
): { cascade: number; points: number } {
  b.swap(a, to)
  let wave = b.swapActivation(a, to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(a, to)
      return { cascade: 0, points: 0 }
    }
    wave = b.matchWave([to, a])
  }
  let cascade = 0
  let points = 0
  while (wave) {
    cascade++
    points += wave.cleared.length * POINTS_PER_PIECE * cascade
    for (const { piece } of wave.cleared) {
      if (piece.kind === 'jackpot' || piece.kind === 'blocker') continue
      const left = remaining.get(piece.symbol)
      if (left !== undefined && left > 0) remaining.set(piece.symbol, left - 1)
    }
    b.applyGravity()
    b.refill()
    wave = b.matchWave()
  }
  return { cascade, points }
}

/** Aggregate several seeds of one level. */
export function sampleLevel(level: number, seeds: number, policy: Policy, specOverride?: LevelSpec): {
  winRate: number
  meanMaxCascade: number
  plinkoEligibleRate: number
  runs: LevelRun[]
} {
  const runs: LevelRun[] = []
  for (let i = 0; i < seeds; i++) runs.push(playLevel(level, 0xbeef + i * 7919 + level * 104729, policy, specOverride))
  const wins = runs.filter(r => r.won).length
  const plinko = runs.filter(r => r.chains.some(c => c >= 5)).length
  return {
    winRate: wins / runs.length,
    meanMaxCascade: runs.reduce((s, r) => s + r.maxCascade, 0) / runs.length,
    plinkoEligibleRate: plinko / runs.length,
    runs,
  }
}

/** Unused-import guard for the goal-value helper when policies change. */
export { goalValue as __goalValue, resolveSwap as __resolveSwap }

// ------------------------------------------------------------------ endless

export interface EndlessRun {
  /** Final score, exactly as GameScene would have counted it — Plinko award included. */
  score: number
  /** Settled chain depth for each move played. */
  chains: number[]
  /** The one Plinko drop a run can earn, if this one earned it. */
  plinko: { stake: number; mult: number } | null
}

/**
 * Play one full ENDLESS run and report the score it would actually have posted.
 *
 * Deliberately NOT `playLevel` with a level number: endless never goes through `levelSpec` at all
 * (GameScene builds its own spec), it has no hazards, no objectives and a flat ENDLESS_MOVES budget,
 * and it is the one mode scored purely on points. Everything scoring-relevant is mirrored from
 * GameScene here — the per-wave `cleared × POINTS_PER_PIECE × cascade`, the once-per-run Plinko
 * latch, and the fact that endless passes `allowTickets: false` so every well pays a multiplier.
 *
 * `roll` is the Plinko stream (GameScene uses `Math.random`); seeding it explicitly is what makes a
 * measurement built on this reproducible.
 *
 * On the reshuffle: an unplayable board is regenerated and the move is then PLAYED, not skipped.
 * That mirrors the real loop, where `reshuffle()` runs at the tail of the move that emptied the
 * board — so a player never loses a move to it. (plinko.rate.test.ts has an older endless walker
 * that consumes the move instead. It is left alone on purpose: its bands are calibrated numbers,
 * and the case is vanishingly rare on a 6-symbol hazard-free board either way.)
 */
export function playEndless(
  seed: number,
  policy: Policy,
  roll: Rng = mulberry32(seed ^ 0x9e3779b9),
  shape?: { moves: number; plan?: HazardPlan }
): EndlessRun {
  const b = new Board(8, 8, SYMBOLS.length, mulberry32(seed))
  // The week's ramp (core/endlessramp.ts) gives a real day's board a move budget and a lock layout.
  // DEFAULTED OFF, deliberately: the economy guards on this function (endless.pace.test.ts,
  // plinko.rate.test.ts) are calibrated numbers measured against the flat 30-move hazard-free board,
  // and silently re-pointing them at a ramped one would invalidate every recorded figure without a
  // single assertion changing. A caller that wants the real board passes the shape explicitly —
  // endlessramp.test.ts does, which is where the ramp's own measurement lives.
  const moves = shape?.moves ?? ENDLESS_MOVES
  if (shape?.plan) b.seedHazards(shape.plan)
  const goals = new Set<SymbolType>() // endless has no objectives — 'banker' collapses to 'greedy'
  const chains: number[] = []
  let score = 0
  let plinko: { stake: number; mult: number } | null = null

  for (let m = 0; m < moves; m++) {
    let moves = everyValidMove(b)
    if (moves.length === 0) {
      b.regenerate()
      moves = everyValidMove(b)
      if (moves.length === 0) break
    }

    let pick = moves[0]
    if (policy !== 'first') {
      const snap = snapshot(b)
      let best = -Infinity
      for (const mv of moves) {
        const v = previewValue(b, mv.a, mv.to, goals, policy)
        restore(b, snap)
        if (v > best) {
          best = v
          pick = mv
        }
      }
    }

    const { cascade, points } = scoreSwap(b, pick.a, pick.to)
    chains.push(cascade)
    score += points

    // The chain settled: it may buy the run's one Plinko drop, which pays a multiplier on the
    // points that chain just scored (`chainPoints` in GameScene).
    if (!plinko && points > 0 && shouldOfferPlinko(cascade, roll, true)) {
      const slot = plinkoSlots(false)[rollSlotIndex(roll, false)]
      const mult = slot.kind === 'mult' ? slot.mult : 1
      plinko = { stake: points, mult }
      score += points * mult
    }
  }

  return { score, chains, plinko }
}

/** resolveSwap, but totting up points the way GameScene's playWave does. */
function scoreSwap(b: Board, a: Coord, to: Coord): { cascade: number; points: number } {
  b.swap(a, to)
  let wave = b.swapActivation(a, to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(a, to)
      return { cascade: 0, points: 0 }
    }
    wave = b.matchWave([to, a])
  }
  let cascade = 0
  let points = 0
  while (wave) {
    cascade++
    points += wave.cleared.length * POINTS_PER_PIECE * cascade
    b.applyGravity()
    b.refill()
    wave = b.matchWave()
  }
  return { cascade, points }
}

/** Ascending-sorted percentile of a sample (p in 0..1). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[i]
}

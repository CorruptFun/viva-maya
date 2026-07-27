import { Board } from './board'
import { levelSpec } from './levels'
import { hazardPlan } from './hazards'
import { mulberry32 } from './rng'
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

/** Play one full attempt at `level` and report what happened. */
export function playLevel(level: number, seed: number, policy: Policy): LevelRun {
  const spec = levelSpec(level)
  const b = buildLevelBoard(level, seed)
  const goals = new Set(spec.objectives.map(o => o.symbol))
  const needed = spec.objectives.reduce((n, o) => n + o.count, 0)

  // Per-symbol remaining, so over-collecting one goal cannot pay for another (as in the real game).
  const remaining = new Map<SymbolType, number>()
  for (const o of spec.objectives) remaining.set(o.symbol, o.count)

  const chains: number[] = []
  let collected = 0
  let blockerCellTurns = 0
  let m = 0

  for (; m < spec.moves; m++) {
    blockerCellTurns += blockersStanding(b)
    if ([...remaining.values()].every(v => v <= 0) && b.coatsRemaining() === 0) break

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

    // Track per-symbol progress through the committed wave.
    const before = new Map(remaining)
    const res = resolveSwapTracking(b, pick.a, pick.to, remaining)
    chains.push(res.cascade)
    for (const [s, v] of before) collected += Math.max(0, v - (remaining.get(s) ?? 0))
  }

  const objectivesMet = [...remaining.values()].every(v => v <= 0)
  return {
    won: objectivesMet && b.coatsRemaining() === 0,
    movesLeft: Math.max(0, spec.moves - m),
    collected,
    needed,
    coatsLeft: b.coatsRemaining(),
    chains,
    maxCascade: chains.length > 0 ? Math.max(...chains) : 0,
    blockerCellTurns,
  }
}

/** resolveSwap, but decrementing per-symbol objective counters as the real scene does. */
function resolveSwapTracking(
  b: Board,
  a: Coord,
  to: Coord,
  remaining: Map<SymbolType, number>
): { cascade: number } {
  b.swap(a, to)
  let wave = b.swapActivation(a, to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(a, to)
      return { cascade: 0 }
    }
    wave = b.matchWave([to, a])
  }
  let cascade = 0
  while (wave) {
    cascade++
    for (const { piece } of wave.cleared) {
      if (piece.kind === 'jackpot' || piece.kind === 'blocker') continue
      const left = remaining.get(piece.symbol)
      if (left !== undefined && left > 0) remaining.set(piece.symbol, left - 1)
    }
    b.applyGravity()
    b.refill()
    wave = b.matchWave()
  }
  return { cascade }
}

/** Aggregate several seeds of one level. */
export function sampleLevel(level: number, seeds: number, policy: Policy): {
  winRate: number
  meanMaxCascade: number
  plinkoEligibleRate: number
  runs: LevelRun[]
} {
  const runs: LevelRun[] = []
  for (let i = 0; i < seeds; i++) runs.push(playLevel(level, 0xbeef + i * 7919 + level * 104729, policy))
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

import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { ENDLESS_MOVES } from './endless'
import { hazardPlan } from './hazards'
import { levelSpec } from './levels'
import {
  PLINKO_CHANCE,
  PLINKO_ENDLESS_CHANCE,
  PLINKO_ENDLESS_MIN_CASCADE,
  PLINKO_MIN_CASCADE,
  shouldOfferPlinko,
} from './plinko'
import { mulberry32 } from './rng'
import { SYMBOLS } from './types'
import type { Coord, Piece } from './types'

/**
 * A guard on FEEL, not on logic: "the Plinko drop must stay a treat, never routine".
 *
 * This plays the real board core headlessly across the real difficulty curve and measures how often a
 * settled chain reaches PLINKO_MIN_CASCADE, then converts that into "what fraction of levels would
 * show a drop". It exists because the obvious guess was badly wrong — x4 MEGA chains, which *feel*
 * rare, actually land ~1×/level even for a passive player and ~1.9× for one playing normally, so the
 * originally-planned x4 trigger would have shown a drop in 60–84% of levels. x5 is the bar that
 * keeps it special without making it a unicorn: ~1 level in 8 passive, ~1 in 5 typical.
 *
 * It is a band, not a fixed number: it fails if a future difficulty-curve change (levels.ts) or a
 * tweak to the two Plinko constants would make the drop routine — or so rare nobody sees it. If you
 * deliberately re-tune the feel, move the band and say why.
 *
 * Two policies bracket real play. FIRST-valid-move is the floor — it takes whatever swap it scans
 * first, weaker than anyone actually playing. HUMAN is the realistic ceiling: it takes the biggest
 * match it can SEE, with no lookahead past the opening wave, which is what a person does. (A third,
 * brute-forcing every move for the deepest cascade, was tried as a ceiling and rejected — at ~6.2
 * MEGA chains per level it models an oracle no human matches, and asserting against it would force
 * the drop to be far rarer than intended.)
 */

const POINTS_PER_PIECE = 20 // mirrors config.ts; kept local so this stays a pure-core test

const gridOf = (b: Board): (Piece | null)[][] => (b as unknown as { grid: (Piece | null)[][] }).grid
const snapshot = (b: Board): (Piece | null)[][] => gridOf(b).map(r => r.map(p => (p ? { ...p } : null)))
const restore = (b: Board, g: (Piece | null)[][]): void => {
  const cur = gridOf(b)
  for (let r = 0; r < g.length; r++) for (let c = 0; c < g[r].length; c++) cur[r][c] = g[r][c]
}

/** GameScene.trySwap + resolveLoop, headless: returns the settled chain depth and the points it scored. */
function resolveSwap(b: Board, a: Coord, to: Coord): { cascade: number; points: number } {
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

function everyValidMove(b: Board): Array<{ a: Coord; to: Coord }> {
  const out: Array<{ a: Coord; to: Coord }> = []
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

/** Just the opening wave's clear count — what a player can actually SEE before committing. */
function firstWaveSize(b: Board, a: Coord, to: Coord): number {
  b.swap(a, to)
  let wave = b.swapActivation(a, to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(a, to)
      return 0
    }
    wave = b.matchWave([to, a])
  }
  return wave?.cleared.length ?? 0
}

/** Play a level's whole move budget; return every settled chain. */
function playLevel(seed: number, level: number, human: boolean): Array<{ cascade: number; points: number }> {
  const spec = levelSpec(level)
  const b = new Board(8, 8, spec.symbolCount, mulberry32(seed))
  // Hazards ON, deliberately: this guard exists to catch a difficulty change that makes the drop
  // routine or extinct, and hazards are now part of the difficulty. Seeding nothing here would
  // leave it measuring a board no player above L30 ever sees.
  b.seedHazards(hazardPlan(level, 8, 8))
  const chains: Array<{ cascade: number; points: number }> = []
  for (let m = 0; m < spec.moves; m++) {
    const moves = everyValidMove(b)
    if (moves.length === 0) {
      b.regenerate()
      continue
    }
    let pick = moves[0]
    if (human) {
      const snap = snapshot(b)
      let best = -1
      for (const mv of moves) {
        const size = firstWaveSize(b, mv.a, mv.to)
        if (size > best) {
          best = size
          pick = mv
        }
        restore(b, snap)
      }
    }
    chains.push(resolveSwap(b, pick.a, pick.to))
  }
  return chains
}

/**
 * One ENDLESS run: 8x8, every symbol, NO hazards, a flat 30 moves. Deliberately NOT `playLevel` with
 * a level number — endless does not go through `levelSpec` at all (GameScene builds its own spec),
 * and seeding hazards here would measure a board the weekly race never puts in front of anyone.
 */
function playEndlessRun(seed: number, human: boolean): Array<{ cascade: number; points: number }> {
  const b = new Board(8, 8, SYMBOLS.length, mulberry32(seed))
  const chains: Array<{ cascade: number; points: number }> = []
  for (let m = 0; m < ENDLESS_MOVES; m++) {
    const moves = everyValidMove(b)
    if (moves.length === 0) {
      b.regenerate()
      continue
    }
    let pick = moves[0]
    if (human) {
      const snap = snapshot(b)
      let best = -1
      for (const mv of moves) {
        const size = firstWaveSize(b, mv.a, mv.to)
        if (size > best) {
          best = size
          pick = mv
        }
        restore(b, snap)
      }
    }
    chains.push(resolveSwap(b, pick.a, pick.to))
  }
  return chains
}

/**
 * Replay GameScene's actual gate over a run's chains: walk them in order and stop at the first that
 * fires, which is exactly what the once-per-level latch does. Calls the REAL `shouldOfferPlinko`, so
 * this guards the shipped function rather than a copy of its arithmetic that can drift away from it.
 */
function runShowsDrop(chains: Array<{ cascade: number }>, rng: () => number, endless: boolean): boolean {
  return chains.some(c => shouldOfferPlinko(c.cascade, rng, endless))
}

const LEVELS = [1, 10, 40, 120, 300] // a spread across the difficulty curve

function measure(human: boolean, runs: number): { perLevel: number; pctOfLevels: number; medianPoints: number } {
  const chains: Array<{ cascade: number; points: number }> = []
  for (const lv of LEVELS) for (let s = 1; s <= runs; s++) chains.push(...playLevel(s * 1000 + lv, lv, human))
  const levels = LEVELS.length * runs
  const hits = chains.filter(c => c.cascade >= PLINKO_MIN_CASCADE)
  const perLevel = hits.length / levels
  // P(at least one offer in a level), Poisson-approximated — GameScene caps it at one per level.
  const pctOfLevels = (1 - Math.exp(-perLevel * PLINKO_CHANCE)) * 100
  const pts = hits.map(h => h.points).sort((a, b) => a - b)
  return { perLevel, pctOfLevels, medianPoints: pts.length ? pts[Math.floor(pts.length / 2)] : 0 }
}

describe('Plinko stays a treat', () => {
  it('fires in a sane share of levels at both ends of player skill', () => {
    const weak = measure(false, 20)
    const strong = measure(true, 10)
    console.log(
      `\nPLINKO_MIN_CASCADE=${PLINKO_MIN_CASCADE} PLINKO_CHANCE=${PLINKO_CHANCE}\n` +
        `  passive player: ${weak.perLevel.toFixed(3)} qualifying chains/level → drop in ${weak.pctOfLevels.toFixed(1)}% of levels` +
        ` (~1 in ${(100 / weak.pctOfLevels).toFixed(0)}), median chain ${weak.medianPoints} pts\n` +
        `  typical player: ${strong.perLevel.toFixed(3)} qualifying chains/level → drop in ${strong.pctOfLevels.toFixed(1)}% of levels` +
        ` (~1 in ${(100 / strong.pctOfLevels).toFixed(0)}), median chain ${strong.medianPoints} pts`
    )

    // The owner's constraint: never "every game", but not a unicorn either.
    expect(strong.pctOfLevels, 'a typical player would see Plinko too often').toBeLessThan(35)
    expect(weak.pctOfLevels, 'a passive player would hardly ever see Plinko').toBeGreaterThan(5)
  }, 120_000)

  /**
   * ENDLESS is guarded separately and to a DELIBERATELY more generous band. It is the one mode
   * scored purely on points and raced on a shared weekly board, and it plays without the hazards the
   * numbered curve leans on — so the drop has to be reachable inside 30 moves or it cannot influence
   * the thing the mode is about. The old shared x5/0.5 pair put it at ~5% of runs passive.
   *
   * Still a ceiling, not a blank cheque: the per-run latch means one drop per run at most, and if a
   * board change ever pushed this toward "every run" the upper bound below fails.
   */
  it('endless stays reachable inside 30 hazard-free moves, without becoming every run', () => {
    const measureEndless = (human: boolean, runs: number): { pctOfRuns: number; perRun: number } => {
      // A fixed roll stream, seeded once, so the whole guard is deterministic across CI runs.
      const roll = mulberry32(0xc0ffee)
      let shown = 0
      let qualifying = 0
      for (let s = 1; s <= runs; s++) {
        const chains = playEndlessRun(s * 7919 + 13, human)
        qualifying += chains.filter(c => c.cascade >= PLINKO_ENDLESS_MIN_CASCADE).length
        if (runShowsDrop(chains, roll, true)) shown++
      }
      return { pctOfRuns: (shown / runs) * 100, perRun: qualifying / runs }
    }

    const weak = measureEndless(false, 150)
    const strong = measureEndless(true, 80)
    console.log(
      `\nENDLESS: MIN_CASCADE=${PLINKO_ENDLESS_MIN_CASCADE} CHANCE=${PLINKO_ENDLESS_CHANCE} (${ENDLESS_MOVES} moves, no hazards)\n` +
        `  passive player: ${weak.perRun.toFixed(3)} qualifying chains/run → drop in ${weak.pctOfRuns.toFixed(1)}% of runs\n` +
        `  typical player: ${strong.perRun.toFixed(3)} qualifying chains/run → drop in ${strong.pctOfRuns.toFixed(1)}% of runs`
    )

    expect(strong.pctOfRuns, 'endless Plinko has become effectively every run').toBeLessThan(80)
    expect(weak.pctOfRuns, 'endless Plinko is back out of reach for a passive player').toBeGreaterThan(15)
  }, 120_000)
})

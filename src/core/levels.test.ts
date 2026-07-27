import { describe, expect, it } from 'vitest'
import { LEVEL_COUNT, levelSpec } from './levels'
import { DIFFICULTY, isTeachingLevel } from './difficulty'
import type { SymbolType } from './types'

/**
 * Two promises are made about the difficulty curve, and both are easy to break by accident:
 *
 *  1. THE EARLY GAME IS UNTOUCHED. Levels 1-30 are a brand-new player's whole experience — they
 *     reach the weekly race at L20 and never see a hazard. The golden table below is a literal
 *     before-image captured from the pre-overhaul `levelSpec`, so any drift in the move budget OR
 *     in the goal symbols fails loudly. The symbols matter as much as the numbers: hazard placement
 *     runs on its own RNG stream precisely so it cannot perturb this table, and this is the test
 *     that proves it.
 *
 *  2. IT ACTUALLY GETS HARDER. The pre-overhaul curve rose only ~18% across 292 levels and 31% of
 *     levels were EASIER than the level before them — the "+2 moves every 5th level" breather was
 *     a 4-5% dip, larger than the trend gain over the surrounding 15-25 levels, so the noise
 *     swamped the signal. Above the protected band the requirement must now climb monotonically.
 */

/** [level, moves, symbolCount, [[symbol, count], ...]] — captured from the curve as it shipped. */
const GOLDEN: [number, number, number, [SymbolType, number][]][] = [
  [1, 30, 5, [['clover', 15]]],
  [2, 38, 5, [['diamond', 19]]],
  [3, 37, 5, [['clover', 21], ['bell', 21]]],
  [4, 36, 6, [['bar', 23], ['cherry', 23]]],
  [5, 38, 6, [['bar', 25], ['seven', 25]]],
  [6, 36, 6, [['cherry', 27], ['bar', 27]]],
  [7, 34, 6, [['cherry', 28], ['seven', 28]]],
  [8, 31, 6, [['bar', 30], ['seven', 30], ['diamond', 30]]],
  [9, 32, 6, [['bell', 31], ['bar', 31], ['clover', 31]]],
  [10, 34, 6, [['cherry', 32], ['bar', 32], ['diamond', 32]]],
  [11, 33, 6, [['bar', 33], ['seven', 33], ['bell', 33]]],
  [12, 34, 6, [['bell', 34], ['diamond', 34], ['seven', 34]]],
  [13, 35, 6, [['bell', 35], ['clover', 35], ['seven', 35]]],
  [14, 36, 6, [['cherry', 36], ['seven', 36], ['clover', 36]]],
  [15, 39, 6, [['bell', 37], ['cherry', 37], ['diamond', 37]]],
  [16, 38, 6, [['diamond', 38], ['cherry', 38], ['bar', 38]]],
  [17, 37, 6, [['clover', 38], ['diamond', 38], ['cherry', 38]]],
  [18, 38, 6, [['bell', 39], ['seven', 39], ['cherry', 39]]],
  [19, 39, 6, [['clover', 40], ['bell', 40], ['seven', 40]]],
  [20, 42, 6, [['clover', 41], ['bell', 41], ['seven', 41]]],
  [21, 40, 6, [['bar', 41], ['clover', 41], ['seven', 41]]],
  [22, 41, 6, [['seven', 42], ['cherry', 42], ['bar', 42]]],
  [23, 41, 6, [['diamond', 42], ['bar', 42], ['bell', 42]]],
  [24, 42, 6, [['diamond', 43], ['bell', 43], ['seven', 43]]],
  [25, 45, 6, [['clover', 44], ['bar', 44], ['diamond', 44]]],
  [26, 43, 6, [['bar', 44], ['diamond', 44], ['bell', 44]]],
  [27, 44, 6, [['diamond', 45], ['seven', 45], ['bell', 45]]],
  [28, 44, 6, [['seven', 45], ['bell', 45], ['clover', 45]]],
  [29, 45, 6, [['diamond', 46], ['bar', 46], ['seven', 46]]],
  [30, 47, 6, [['bell', 46], ['cherry', 46], ['diamond', 46]]],
]

/** The real difficulty knob: how many collects a player must average per move. */
const required = (level: number): number => {
  const s = levelSpec(level)
  return s.objectives.reduce((n, o) => n + o.count, 0) / s.moves
}

describe("levelSpec — the early game a new player sees", () => {
  it('is byte-identical to the pre-overhaul curve for levels 1-30', () => {
    for (const [level, moves, symbolCount, objectives] of GOLDEN) {
      const s = levelSpec(level)
      expect({ level: s.level, moves: s.moves, symbolCount: s.symbolCount }).toEqual({
        level,
        moves,
        symbolCount,
      })
      expect(s.objectives.map(o => [o.symbol, o.count])).toEqual(objectives)
    }
  })

  it('keeps the protected band below the first hazard level', () => {
    // If the bands ever move down, the golden table above stops covering the whole protected range.
    expect(DIFFICULTY.bands.lockStart).toBeGreaterThan(GOLDEN.length)
  })
})

describe('levelSpec — the climb above the protected band', () => {
  it('never gets easier from one level to the next, except where a mechanic is taught', () => {
    const dips: number[] = []
    for (let L = DIFFICULTY.bands.lockStart + 1; L <= LEVEL_COUNT; L++) {
      // The three teaching levels are DELIBERATELY softer (+3 moves) — you are meeting a new rule
      // for the first time. That dip is intentional and, unlike the old +2 breather, it is visible:
      // it lands on a level that also announces itself with an intro card.
      if (isTeachingLevel(L)) continue
      // 0.01 absorbs integer-rounding noise in the move budget; the old +2 breather was 50x larger.
      const delta = required(L) - required(L - 1)
      if (delta < 0) dips.push(delta)
      expect(required(L)).toBeGreaterThanOrEqual(required(L - 1) - 0.01)
    }
    // Pre-overhaul, 91 of 292 levels dipped and the worst was -5.1%. Whatever survives now must be
    // rounding noise, not a design flaw.
    expect(Math.min(0, ...dips)).toBeGreaterThan(-0.01)
  })

  it('resumes the climb immediately after a teaching level', () => {
    for (const L of [DIFFICULTY.bands.lockStart, DIFFICULTY.bands.coatStart, DIFFICULTY.bands.blockerStart]) {
      expect(required(L + 1)).toBeGreaterThan(required(L))
    }
  })

  it('does not dip at the seam where the new branch takes over', () => {
    const b = DIFFICULTY.bands.lockStart
    expect(required(b)).toBeGreaterThanOrEqual(required(b - 1) - 0.01)
  })

  it('climbs meaningfully by L300 instead of flatlining', () => {
    // Pre-overhaul this ratio was 1.17 (a ~17% climb no player could perceive).
    expect(required(LEVEL_COUNT) / required(30)).toBeGreaterThan(1.25)
  })

  it('still leaves real headroom — never demands more than 70% of a flawless clear', () => {
    // levels.ts treats ~6.2 collects/move as the flawless ceiling.
    for (let L = 1; L <= LEVEL_COUNT; L++) expect(required(L)).toBeLessThan(6.2 * 0.7)
  })
})

/** The pre-overhaul move budget, transcribed verbatim. The rollback path is only real if something
 *  independent can attest to it, so this is the reference the switch is checked against. */
function legacyMoves(L: number): number {
  const objectiveCount = L < 3 ? 1 : L < 8 ? 2 : 3
  const perObjective = Math.min(110, Math.max(12, Math.round(32 * Math.pow(L / 10, 0.34))))
  const total = perObjective * objectiveCount
  let ratio: number
  if (objectiveCount === 1) {
    ratio = 0.5
  } else if (objectiveCount === 2) {
    ratio = 1.15 + 0.12 * (L - 3)
  } else {
    const onsetEase = 0.14 * Math.max(0, Math.min(1, (11 - L) / 3))
    ratio = Math.min(3.5, 3.0 - onsetEase + 0.27 * Math.log(1 + Math.max(0, L - 8) / 52))
  }
  return Math.max(Math.round(total / ratio) + (L % 5 === 0 ? 2 : 0), Math.ceil(total / 6.2) + objectiveCount)
}

describe('the panic switch', () => {
  it('curve.enabled = false restores the pre-overhaul budget on every one of the 300 levels', () => {
    const curve = DIFFICULTY.curve as { enabled: boolean }
    const was = curve.enabled
    try {
      curve.enabled = false
      for (let L = 1; L <= LEVEL_COUNT; L++) {
        expect({ L, moves: levelSpec(L).moves }).toEqual({ L, moves: legacyMoves(L) })
      }
    } finally {
      curve.enabled = was
    }
  })

  it('leaves levels 1-30 on the legacy budget even with the retune ON', () => {
    for (let L = 1; L <= 30; L++) expect(levelSpec(L).moves).toBe(legacyMoves(L))
  })
})

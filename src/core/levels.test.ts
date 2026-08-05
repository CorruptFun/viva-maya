import { describe, expect, it } from 'vitest'
import {
  LEVEL_COUNT,
  isHotTable,
  isMinimumLevel,
  isPointsNight,
  levelBoostExclusions,
  levelSpec,
  minimumTargetFrac,
  starThresholds,
  starsFor,
} from './levels'
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
      // The teaching levels are DELIBERATELY softer (+3 moves) — you are meeting a new rule
      // for the first time. That dip is intentional and, unlike the old +2 breather, it is visible:
      // it lands on a level that also announces itself with an intro card.
      if (isTeachingLevel(L)) continue
      // Minimum levels ask for a third of their demand in POINTS, so their collect ratio is lower
      // by construction — this metric cannot see the plaque. Their own monotone series (the
      // scoreTarget ladder) is asserted in the HOUSE MINIMUM describe below, and their total
      // difficulty is measured on the real board by minimum.rate.test.ts.
      if (isMinimumLevel(L)) continue
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
    // §G12 — derived from `isTeachingLevel`, not from the raw band list. A band whose mechanic is
    // switched off no longer buys its start level the +3 teaching bonus (it had nothing to teach),
    // so that level no longer DIPS and there is no dip to resume from: L86 and L87 now land on the
    // same budget after integer rounding, which is the same rounding noise the monotonicity test
    // above tolerates at 0.01. Asserting a strict climb there would be asserting rounding.
    const teaching = [DIFFICULTY.bands.lockStart, DIFFICULTY.bands.coatStart, DIFFICULTY.bands.blockerStart].filter(
      isTeachingLevel
    )
    expect(teaching.length).toBeGreaterThan(0) // a rollout with nothing live would make this vacuous
    for (const L of teaching) {
      expect(required(L + 1)).toBeGreaterThan(required(L))
    }
  })

  it('does not dip at the seam where the new branch takes over', () => {
    const b = DIFFICULTY.bands.lockStart
    expect(required(b)).toBeGreaterThanOrEqual(required(b - 1) - 0.01)
  })

  it('climbs by L300 instead of flatlining', () => {
    // Pre-overhaul this ratio was 1.171 — a ~17% climb across 270 levels that no player could feel.
    // The retune only lifts it to ~1.20 ON PURPOSE: a hotter arithmetic curve measured far too
    // punishing once hazards were stacked on it (clear rate fell 71% at L300, squarely into
    // "insane"). Hazards now carry most of the late-game climb, so the honest guarantee here is
    // "the budget still tightens"; the TOTAL difficulty ramp is asserted in feasibility.test.ts,
    // which measures the real board with hazards on.
    expect(required(LEVEL_COUNT) / required(30)).toBeGreaterThan(1.18)
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

/**
 * §G3 — the star grade must stay inside the curve's own definition of achievable play.
 *
 * `levelSpec` floors the move budget at `total / 6.2` and calls that "even a flawless clear". The
 * old fixed `movesLeft/moves >= 0.5` bar for 3★ therefore demanded twice the level's required
 * ratio — 7.03 collects/move at L300 — which is well past that flawless ceiling, so from L32 the
 * top grade was asking for more than the game itself considered possible. These assertions make
 * that class of bug fail loudly rather than silently draining every star out of the late game.
 */
describe('star thresholds stay achievable', () => {
  const FLAWLESS = 6.2

  it('never asks for more than a flawless clear, at any of the 300 levels', () => {
    for (let L = 1; L <= LEVEL_COUNT; L++) {
      const spec = levelSpec(L)
      const total = spec.objectives.reduce((n, o) => n + o.count, 0)
      const t = starThresholds(spec)
      // Rate a 3-star clear implies: finish `total` collects inside the moves it is allowed to spend.
      const rate3 = total / (spec.moves * (1 - t.three))
      expect({ L, over: rate3 > FLAWLESS }).toEqual({ L, over: false })
      expect(t.two).toBeLessThanOrEqual(t.three)
    }
  })

  it('keeps the pre-existing 0.5 / 0.25 bar on the early levels it was calibrated for', () => {
    for (let L = 1; L <= 7; L++) {
      const t = starThresholds(levelSpec(L))
      expect({ L, ...t }).toEqual({ L, three: 0.5, two: 0.25 })
    }
  })

  it('grades the boundaries exactly, and every level can still reach all three grades', () => {
    for (const L of [1, 8, 32, 100, 300]) {
      const spec = levelSpec(L)
      const t = starThresholds(spec)
      const at = (frac: number): number => starsFor(spec, Math.ceil(frac * spec.moves))
      expect({ L, s: at(t.three) }).toEqual({ L, s: 3 })
      expect({ L, s: at((t.two + t.three) / 2) }).toEqual({ L, s: 2 })
      expect({ L, s: starsFor(spec, 0) }).toEqual({ L, s: 1 })
      // A grade you cannot reach is not a grade: 3-star must cost fewer moves than the level HAS.
      expect(Math.ceil(t.three * spec.moves)).toBeLessThan(spec.moves)
    }
  })

  it('never grades a bought move — purchased surplus is excluded before it gets here', () => {
    const spec = levelSpec(100)
    // starsFor takes the EARNED leftover; passing the raw remainder is the bug it guards against.
    expect(starsFor(spec, 0)).toBe(1)
    expect(starsFor(spec, spec.moves)).toBe(3)
  })
})

/**
 * HOUSE MINIMUM — the third goal archetype (Slice 0, 2026-08-04). A brass score plaque replaces
 * the third collect objective on a fixed cadence from L201. Two promises, both cheap to break:
 * the cadence is exactly where it says it is (a shipped level's win condition is content, like a
 * golden symbol table), and the plaque REPLACES a goal rather than adding one — the move budget
 * must be byte-identical to the 3-objective sibling the flag-off game would deal.
 */
describe('HOUSE MINIMUM — the plaque cadence', () => {
  it('runs on L % 10 ∈ {1, 6} from the band start, and nowhere below it', () => {
    for (let L = 1; L <= 200; L++) {
      expect(isMinimumLevel(L)).toBe(false)
      expect(levelSpec(L).scoreTarget).toBeUndefined()
    }
    for (let L = 201; L <= LEVEL_COUNT; L++) {
      const expected = L % 10 === 1 || L % 10 === 6
      expect({ L, min: isMinimumLevel(L) }).toEqual({ L, min: expected })
      expect({ L, plaque: levelSpec(L).scoreTarget !== undefined }).toEqual({ L, plaque: expected })
      // Two goals on an ordinary plaque level, NONE on a POINTS NIGHT — the plaque's pure form takes
      // the last two as well as the third (core/levels.ts isPointsNight).
      if (expected) expect(levelSpec(L).objectives).toHaveLength(isPointsNight(L) ? 0 : 2)
    }
  })

  it('never lands on an every-5th breather (and so never on a chapter-closing 10th)', () => {
    for (let L = 201; L <= LEVEL_COUNT; L++) {
      if (isMinimumLevel(L)) expect(L % 5).not.toBe(0)
    }
  })

  it('replaces a goal, never buys moves — the budget is its 3-objective sibling\'s exactly', () => {
    const g = DIFFICULTY.goals as { minimum: boolean }
    try {
      // 291 rather than the 296 this used to check: 296 is a POINTS NIGHT now, and its own version
      // of this promise (all three goals replaced, budget still untouched) is asserted below.
      for (const L of [206, 251, 291]) {
        const on = levelSpec(L)
        g.minimum = false
        const off = levelSpec(L)
        g.minimum = true
        expect({ L, moves: on.moves }).toEqual({ L, moves: off.moves })
        expect(off.scoreTarget).toBeUndefined()
        expect(off.objectives).toHaveLength(3)
        // The two surviving goals are the sibling's first two — same stream, same order.
        expect(on.objectives.map(o => o.symbol)).toEqual(off.objectives.slice(0, 2).map(o => o.symbol))
      }
    } finally {
      g.minimum = true
    }
  })

  it('teaches at 201: +3 moves over the flag-off budget, and a gentler plaque than the band', () => {
    const g = DIFFICULTY.goals as { minimum: boolean }
    const on = levelSpec(201)
    try {
      g.minimum = false
      const off = levelSpec(201)
      expect(on.moves).toBe(off.moves + 3)
    } finally {
      g.minimum = true
    }
    expect(minimumTargetFrac(201)).toBeLessThan(minimumTargetFrac(206))
  })

  it('the brass ladder only ever rises — with GOLDEN anchors from the shipped calibration', () => {
    // TWO series, walked separately. From 216 the `…6` half of the cadence is POINTS NIGHT, priced
    // off MOVES against its own constant while the `…1` half stays priced off COLLECTS — different
    // currencies of demand, so interleaving them compares numbers that were never comparable.
    // Each must climb on its own; neither may drift.
    let prev = 0
    let prevPoints = 0
    for (let L = 201; L <= LEVEL_COUNT; L++) {
      if (!isMinimumLevel(L)) continue
      if (isPointsNight(L)) {
        if (isTeachingLevel(L)) continue
        const p = levelSpec(L).scoreTarget as number
        expect({ L, rises: p >= prevPoints }).toEqual({ L, rises: true })
        prevPoints = p
        continue
      }
      // A TEACHING level's plaque steps back on purpose (see minimumTargetFrac). Every act opens on
      // a …01, and the cadence puts a plaque on every …01, so an act opening is always both — the
      // dip is where a new verb is being introduced, and it is carved out here for exactly the
      // reason the move-budget monotonicity test above carves teaching levels out.
      if (isTeachingLevel(L)) continue
      const t = levelSpec(L).scoreTarget as number
      expect({ L, rises: t >= prev }).toEqual({ L, rises: true })
      prev = t
    }
    // GOLDEN: the plaque numbers as calibrated 2026-08-04 (banker completer distribution — see
    // minimum.rate.test.ts). A failure here means SHIPPED LEVELS MOVED — retune deliberately and
    // re-record, never let a target drift as a side effect of touching the curve or the scoring.
    // Act I's four are the SHIPPED values and must never move: the Act II ramp is anchored to
    // ACT1_LEVELS rather than LEVEL_COUNT precisely so that opening a new act cannot re-price them.
    // ⚠️ THE FOURTH ANCHOR MOVED FROM 296 TO 291, and that is a real content change, not a test edit.
    // AFTER DARK's POINTS NIGHT cadence is `…6` from 216, so 296 stopped being an ordinary plaque
    // level; its 18,600 is gone and its new number is pinned in the points ladder below. 291 is now
    // the last ordinary plaque of Act I and carries the top of this series. The three that could
    // stay, stayed: 201 / 206 / 251 are byte-identical, as is everything below 201.
    expect([201, 206, 251, 291].map(L => levelSpec(L).scoreTarget)).toEqual([11900, 14200, 16400, 18400])
    // Act II's, added Slice 1. 301 is the act-opening teaching dip; 306 resumes ABOVE 296, and the
    // ladder climbs to a `perObjective`-clamped ceiling by the high 370s.
    expect([301, 306, 351, 396].map(L => levelSpec(L).scoreTarget)).toEqual([16100, 18900, 20000, 20700])
    // AFTER DARK's POINTS NIGHT ladder (Slice 3, 2026-08-05) — its OWN goldens, calibrated against
    // the full-budget banker distribution in minimum.rate.test.ts. 216 is the teaching level and
    // sits deliberately under the proxy's p10.
    //
    // ⚠️ 296 USED TO BE 18,600 AND IS NOW A POINTS NIGHT. That is the one shipped Act I plaque this
    // slice moves, and it is unavoidable rather than incidental: the cadence is `…6` from 216, and
    // carving a hole at the band's last level to preserve a golden would be preserving the number
    // instead of the design. 201 / 206 / 251 are untouched, and so is every level below 201.
    expect([216, 226, 236, 246, 256, 266, 276, 286, 296].map(L => levelSpec(L).scoreTarget)).toEqual([
      9800, 11300, 11600, 11900, 12200, 12500, 12800, 13100, 13300,
    ])
  })

  /**
   * POINTS NIGHT — the plaque's pure form (AFTER DARK, Slice 3). Same two promises the plaque signs,
   * taken one step further: it replaces EVERY collect goal, and it still must not buy or sell a
   * single move. A level that quietly changed size while changing shape would make the whole band's
   * feasibility measurement meaningless.
   */
  describe('POINTS NIGHT — the plaque with nothing else on it', () => {
    it('runs on the …6 half from 216, and never on the …1 half', () => {
      for (let L = 1; L <= LEVEL_COUNT; L++) {
        expect({ L, pn: isPointsNight(L) }).toEqual({ L, pn: L >= 216 && L <= 300 && L % 10 === 6 })
      }
    })

    it('takes every goal and still deals the same board size', () => {
      const g = DIFFICULTY.goals as { minimum: boolean }
      for (const L of [216, 256, 296]) {
        const on = levelSpec(L)
        expect(on.objectives).toEqual([])
        expect(on.scoreTarget).toBeGreaterThan(0)
        try {
          g.minimum = false
          const off = levelSpec(L)
          // Byte-identical budget to the 3-objective sibling — the demand moved from pieces to
          // points, the level did not get bigger or smaller.
          expect({ L, moves: on.moves }).toEqual({ L, moves: off.moves })
          expect(on.demand).toBe(off.objectives.reduce((n, o) => n + o.count, 0))
        } finally {
          g.minimum = true
        }
      }
    })

    it('still grades stars against a real bar, not the unreachable clamp', () => {
      // With no objectives the collect RATE is zero, which would clamp 3★ to half the move budget —
      // by this curve's own reckoning, harder than flawless play. `demand` is what stops that.
      for (const L of [216, 256, 296]) {
        const pn = starThresholds(levelSpec(L))
        expect(pn.three).toBeLessThan(0.5)
        // …and it grades exactly like the plain 3-objective level of the same size would.
        const g = DIFFICULTY.goals as { minimum: boolean }
        try {
          g.minimum = false
          expect(pn).toEqual(starThresholds(levelSpec(L)))
        } finally {
          g.minimum = true
        }
      }
    })

    it('auto-holds DOUBLE SCORE like any plaque level — a 2x on a score target is the whole level', () => {
      expect(levelBoostExclusions(216)).toEqual(['doubleScore'])
    })
  })

  /**
   * HOT TABLE — scoring only. The one promise worth pinning is the one the spec originally got
   * wrong: it must not touch the move budget (see the measurement in levels.ts).
   */
  describe('HOT TABLE — the multiplier that costs nothing', () => {
    it('runs on the …3 cadence from 233, and never leaves Act I', () => {
      for (let L = 1; L <= LEVEL_COUNT; L++) {
        expect({ L, hot: isHotTable(L) }).toEqual({ L, hot: L >= 233 && L <= 300 && L % 10 === 3 })
        expect({ L, flag: levelSpec(L).hot === true }).toEqual({ L, flag: isHotTable(L) })
      }
    })

    it('never trims the budget — the flag changes scoring and nothing else', () => {
      const a = DIFFICULTY.afterDark as { hot: boolean }
      // 253 and 293, NOT the teaching level: switching the beat off also takes 233's +3 teaching
      // bonus with it (§G12 — a mechanic that does not appear must not buy its level a discount),
      // so 233 is legitimately three moves apart with the flag off. That is asserted separately.
      for (const L of [253, 293]) {
        const on = levelSpec(L)
        try {
          a.hot = false
          const off = levelSpec(L)
          expect({ L, moves: on.moves }).toEqual({ L, moves: off.moves })
          expect({ L, ...on, hot: undefined }).toEqual({ L, ...off, hot: undefined })
        } finally {
          a.hot = true
        }
      }
    })

    it('teaches at 233 with +3 moves, and gives them back when the beat is switched off', () => {
      const a = DIFFICULTY.afterDark as { hot: boolean }
      const on = levelSpec(233)
      try {
        a.hot = false
        expect(on.moves).toBe(levelSpec(233).moves + 3)
      } finally {
        a.hot = true
      }
    })

    it('never collides with a plaque, a points night or a breather', () => {
      for (let L = 1; L <= LEVEL_COUNT; L++) {
        if (!isHotTable(L)) continue
        expect({ L, min: isMinimumLevel(L), pn: isPointsNight(L), breather: L % 5 === 0 }).toEqual({
          L,
          min: false,
          pn: false,
          breather: false,
        })
      }
    })
  })

  it('resumes the brass climb straight after an act-opening dip', () => {
    // The dip is allowed to exist, not to persist: the first plaque after it must clear the last
    // plaque before it, or the House quietly lowered its minimum for a whole floor.
    // Measured against 291, the last ORDINARY plaque of Act I — 296 is a points night now and its
    // number is priced off a different anchor entirely, so it is not the thing 301 has to clear.
    expect(levelSpec(301).scoreTarget!).toBeLessThan(levelSpec(291).scoreTarget!)
    expect(levelSpec(306).scoreTarget!).toBeGreaterThan(levelSpec(291).scoreTarget!)
  })

  it('auto-holds DOUBLE SCORE on minimum levels only (skipped, never consumed)', () => {
    expect(levelBoostExclusions(206)).toEqual(['doubleScore'])
    expect(levelBoostExclusions(205)).toEqual([])
    expect(levelBoostExclusions(51)).toEqual([])
  })
})

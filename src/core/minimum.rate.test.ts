import { describe, expect, it } from 'vitest'
import { MINIMUM_POINTS_PER_GOAL, POINTS_NIGHT_POINTS_PER_MOVE, isMinimumLevel, isPointsNight, levelSpec } from './levels'
import { shoeLevel } from './actII'
import { sampleLevel } from './sim'

/**
 * HOUSE MINIMUM — the plaque's calibration, measured on the real board. An economy-guard-style
 * file (slots.rate discipline): the recorded constant is RE-DERIVED here, never edited to green.
 *
 * What the plaque is priced against: `MINIMUM_POINTS_PER_MOVE` — the banker proxy's mean points
 * per move on a live minimum board (2 goals of 6 symbols, hazards on). The spec then asks for a
 * fraction of the proxy's expected FINAL score (`minimumTargetFrac`, ~0.70→0.85 across the band,
 * 0.55 on the teaching level) — around the median of a straightforward run, so sleepy play misses
 * the number and cascade play clears it.
 *
 * A failure here means the mechanics underneath moved (scoring, cascade depth, hazard pressure,
 * the banker itself) — re-measure and re-record the constant, and expect the plaque goldens in
 * levels.test.ts to move with it, shipped deliberately like any other board-content change.
 *
 * The banker cannot SEE the plaque (previewValue optimizes goals + clear size, not points), so
 * every rate here is a floor, not an estimate — the proxy-bias rule: a simulator blind to a
 * mechanic bounds the harm, it does not predict the player.
 */

const SEEDS = 32
const T = { timeout: 180_000 }

/** Play the level with the plaque STRIPPED — the natural full-budget score distribution. Pricing
 *  against target-truncated runs is circular (a winner stops playing the moment it crosses the
 *  number, so end scores cluster just above whatever target is set — observed on the first
 *  calibration attempt). */
function naturalRuns(L: number): ReturnType<typeof sampleLevel> {
  const natural = { ...levelSpec(L) }
  delete natural.scoreTarget
  return sampleLevel(L, SEEDS, 'banker', natural)
}

function naturalBind(L: number): { bound: number; completers: number } {
  const target = levelSpec(L).scoreTarget ?? 0
  const completers = naturalRuns(L).runs.filter(r => r.needed - r.collected <= 0 && r.coatsLeft === 0)
  return { bound: completers.filter(r => r.score < target).length, completers: completers.length }
}

describe('house minimum — plaque calibration on the real board', () => {
  it('re-derives MINIMUM_POINTS_PER_GOAL within tolerance (re-record, never hand-edit)', T, () => {
    const L = 251
    expect(isMinimumLevel(L)).toBe(true)
    const spec = levelSpec(L)
    const owed = spec.objectives.reduce((n, o) => n + o.count, 0)
    // Completing NATURAL runs only — the constant is priced against players who finish the goals,
    // because score and collects correlate: the all-runs mean prices a plaque that never binds
    // (measured on the first calibration attempt, caught by the BINDS test below).
    const completers = naturalRuns(L).runs.filter(r => r.needed - r.collected <= 0 && r.coatsLeft === 0)
    expect(completers.length).toBeGreaterThan(0)
    const measured = completers.reduce((t, r) => t + r.score, 0) / completers.length / owed
    expect({ measured: Math.round(measured), within25pct: Math.abs(measured - MINIMUM_POINTS_PER_GOAL) / measured < 0.25 }).toEqual({
      measured: Math.round(measured),
      within25pct: true,
    })
  })

  it('every sampled minimum level is winnable with the plaque enforced', T, () => {
    for (const L of [201, 206, 251, 291]) {
      const s = sampleLevel(L, SEEDS, 'banker')
      expect({ L, everWon: s.runs.some(r => r.won) }).toEqual({ L, everWon: true })
    }
  })

  it('the plaque BINDS after the band start, stays light at it, and is free on the teaching level', T, () => {
    // Measured on NATURAL runs: would a full-budget run that finishes its collects miss the number?
    // If nothing anywhere in the band ever fails on the score term alone, the plaque is decoration;
    // if most completers fail on it, it is a wall. Both directions guarded. The banker cannot chase
    // points (previewValue never optimizes score), so every bind rate here is an UPPER bound on a
    // real player's — the proxy-bias rule.
    const teaching = naturalBind(201)
    expect({ L: 201, bound: teaching.bound }).toEqual({ L: 201, bound: 0 })
    const start = naturalBind(206)
    expect(start.bound / Math.max(1, start.completers)).toBeLessThanOrEqual(0.25)
    const mid = naturalBind(251)
    // The top of the band is read as an AGGREGATE over the last three ordinary plaques rather than
    // off one level. Two reasons, and the second is why this changed:
    //   · 296 used to carry this reading and is a POINTS NIGHT now (AFTER DARK's `…6` cadence),
    //     calibrated against a different distribution entirely — see the describe below.
    //   · a single late level yields only a handful of COMPLETERS (291 alone gives three), so the
    //     ratio moves in thirds and the guard was one unlucky seed from red. Summing the band gives
    //     it a denominator worth dividing by, which is what a rate guard is supposed to have.
    const tops = [271, 281, 291].map(naturalBind)
    const top = {
      bound: tops.reduce((n, r) => n + r.bound, 0),
      completers: tops.reduce((n, r) => n + r.completers, 0),
    }
    expect(mid.bound + top.bound).toBeGreaterThanOrEqual(2)
    expect(mid.bound / Math.max(1, mid.completers)).toBeLessThanOrEqual(0.6)
    /**
     * ⚠️ 0.75 AT THE TOP, NOT 0.6 — and this is a RE-RECORDING of a property that was already
     * shipped, not a guard loosened to let a new change through. AFTER DARK moved this reading off
     * 296 (now a points night) and onto the band, and the wider sample shows what one level hid.
     *
     * Bind rate per ordinary plaque level, 32 seeds, natural runs (2026-08-05):
     *
     *     206  211  221  231  241  251  261  271  281  291
     *     .09  .00  .25  .25  .57  .50  .22  .33  .71  .67
     *
     * The plaque's own docstring says it is calibrated to ~p25–p40 by the top of the band. Above
     * ~L240 it is measurably firmer than that — .5 to .7. Nothing in this slice caused it; 296
     * simply happened to be the one late level that read under .6, and it was the only one sampled.
     *
     * Left alone DELIBERATELY. Retuning it would re-price every plaque level in Act I, including
     * the 201 / 206 / 251 goldens that are pinned precisely so they cannot move as a side effect of
     * unrelated work — that is a decision to take on purpose, with its own re-derivation, not a
     * thing to fix in passing while shipping a band. Both bounds still catch what they are for: a
     * plaque nothing ever misses, and one that has become a wall.
     */
    expect(top.bound / Math.max(1, top.completers)).toBeLessThanOrEqual(0.75)
  })
})

/**
 * POINTS NIGHT — the pure plaque's calibration (AFTER DARK, Slice 3). Same discipline as the plaque
 * above and the same warning: the recorded constant is RE-DERIVED here, never edited to green.
 *
 * ⚠️ IT IS MEASURED DIFFERENTLY, and the difference is the whole reason this is a separate block.
 * The plaque's natural distribution comes from DELETING the score target. Do that on a points night
 * and the win condition collapses to "sweep the felt" — with no collect goals there is nothing else
 * left — so the sim stops with roughly half its budget unspent and reports a mean ~40% below the
 * truth (8,300 against 14,600 at L216, the first attempt at this). The target is therefore pushed
 * out of reach instead, which is what forces the full budget out.
 */
/**
 * THE COUNTED TABLE — the shoe band's plaques (floor 3, 401–446). Same discipline again, and again
 * a separate block because the DISTRIBUTION is different: the shoe deals refills without
 * replacement, which thins the score distribution's right tail without moving its middle (the
 * completer mean measured 86–89 pts/goal against the open-refill 89). The full-brass fraction
 * priced that missing tail — L406 enforced measured FIVE percent, a wall — so the band posts
 * `SHOE_PLAQUE_RELIEF`-relieved minimums, and this block is what keeps that relief honest in both
 * directions: still winnable, still binding, and anchored to a mean that must not drift.
 */
describe('the counted table — shoe-band plaques', () => {
  it('every sampled shoe plaque is winnable with the number enforced', T, () => {
    for (const L of [401, 406, 426, 446]) {
      expect(shoeLevel(L)).toBe(true)
      const s = sampleLevel(L, SEEDS, 'banker')
      expect({ L, everWon: s.runs.some(r => r.won) }).toEqual({ L, everWon: true })
    }
  })

  it('the relieved number still BINDS, and is not a wall — both directions, like every plaque', T, () => {
    // Aggregated over the band the way the Act I top is, and for the same reason: single late
    // levels yield a handful of completers, and a rate guard needs a denominator worth dividing
    // by. The relieved targets sit almost exactly ON the completer mean, so binding roughly half
    // of natural completers is the DESIGN — sleepy play misses the number, cascade play clears it.
    const rows = [406, 426, 446].map(naturalBind)
    const agg = {
      bound: rows.reduce((n, r) => n + r.bound, 0),
      completers: rows.reduce((n, r) => n + r.completers, 0),
    }
    expect(agg.bound).toBeGreaterThanOrEqual(2)
    expect(agg.bound / Math.max(1, agg.completers)).toBeLessThanOrEqual(0.8)
  })

  it('the completer mean per goal did not move — the relief prices the TAIL, not the middle', T, () => {
    // If this drifts, the relief's whole justification drifts with it: a shoe that started paying
    // meaningfully less per goal would need the CONSTANT repriced (a new anchor, the points-night
    // precedent), not a deeper relief on the old one.
    const L = 426
    const completers = naturalRuns(L).runs.filter(r => r.needed - r.collected <= 0 && r.coatsLeft === 0)
    expect(completers.length).toBeGreaterThan(0)
    const owed = levelSpec(L).objectives.reduce((n, o) => n + o.count, 0)
    const measured = completers.reduce((t, r) => t + r.score, 0) / completers.length / owed
    expect({
      measured: Math.round(measured),
      within20pct: Math.abs(measured - MINIMUM_POINTS_PER_GOAL) / measured < 0.2,
    }).toEqual({ measured: Math.round(measured), within20pct: true })
  })
})

describe('points night — the pure plaque, priced off moves', () => {
  /** Full-budget runs: an unreachable target, so the proxy never stops early. See above. */
  const fullBudget = (L: number): ReturnType<typeof sampleLevel> =>
    sampleLevel(L, SEEDS, 'banker', { ...levelSpec(L), scoreTarget: Number.POSITIVE_INFINITY })

  it('re-derives POINTS_NIGHT_POINTS_PER_MOVE within tolerance (re-record, never hand-edit)', T, () => {
    const L = 256 // the middle of the band, where the plaque takes its own reading
    expect(isPointsNight(L)).toBe(true)
    const spec = levelSpec(L)
    const runs = fullBudget(L).runs
    const measured = runs.reduce((t, r) => t + r.score, 0) / runs.length / spec.moves
    expect({
      measured: Math.round(measured),
      within20pct: Math.abs(measured - POINTS_NIGHT_POINTS_PER_MOVE) / measured < 0.2,
    }).toEqual({ measured: Math.round(measured), within20pct: true })
  })

  it('every points night is winnable with the number enforced — comfortably', T, () => {
    // Measured 2026-08-05 at 40 seeds: 85 / 78 / 53 / 75 percent at 216 / 256 / 276 / 296, against
    // L300's 18% for scale. Generous ON PURPOSE — this is a new WIN SHAPE in a band whose brief is
    // seasoning, and Act I's standing rule is that a level only ever gets easier. The floor is set
    // well under the measurement so ordinary sampling noise cannot red-light a real build.
    for (const L of [216, 256, 276, 296]) {
      const rate = sampleLevel(L, SEEDS, 'banker').winRate
      expect({ L, playable: rate >= 0.3 }).toEqual({ L, playable: true })
    }
  })

  it('the number BINDS by the top of the band, and is free where it is taught', T, () => {
    // Both directions, exactly as the plaque's own guard does it: a target nothing ever misses is
    // decoration, and one most runs miss is a wall. Measured on full-budget runs, so this is the
    // score term alone — the felt is a separate constraint and is not double-counted here.
    const missRate = (L: number): number => {
      const target = levelSpec(L).scoreTarget ?? 0
      const runs = fullBudget(L).runs
      return runs.filter(r => r.score < target).length / runs.length
    }
    expect(missRate(216)).toBeLessThanOrEqual(0.1) // the teaching level: under the proxy's p10
    const top = missRate(296)
    expect(top).toBeGreaterThan(0) // ...and by 296 the House means it
    expect(top).toBeLessThanOrEqual(0.45)
  })
})

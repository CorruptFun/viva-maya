import { describe, expect, it } from 'vitest'
import { MINIMUM_POINTS_PER_GOAL, isMinimumLevel, levelSpec } from './levels'
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
    for (const L of [201, 206, 251, 296]) {
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
    const top = naturalBind(296)
    expect(mid.bound + top.bound).toBeGreaterThanOrEqual(2)
    for (const r of [mid, top]) {
      expect(r.bound / Math.max(1, r.completers)).toBeLessThanOrEqual(0.6)
    }
  })
})

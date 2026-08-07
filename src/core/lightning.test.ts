import { describe, expect, it } from 'vitest'
import {
  CARRY_FRACTION,
  chargeFor,
  MAX_STRIKES,
  STORM_GOAL,
  STORM_PAY_CAP,
  STORM_PAY_FLOOR,
  stormDue,
  stormPayout,
  stormProgress,
  MIN_SECONDS,
  QUOTA_STEP,
  START_QUOTA,
  START_SECONDS,
  chargesLeft,
  credit,
  nextRound,
  quotaFor,
  quotaMet,
  secondsFor,
  startRun,
  strike,
} from './lightning'

/**
 * These pin the four design rules from the module header, not a feel. The numbers are tunable and
 * expected to move in playtesting; the RULES are what a retune must not break, so every test here is
 * written against the rule rather than against a recorded value where it possibly can be.
 */

describe('lightning — the ramp', () => {
  it('quota grows a fixed step per round and time shrinks toward a floor', () => {
    expect(quotaFor(1)).toBe(START_QUOTA)
    expect(quotaFor(2)).toBe(START_QUOTA + QUOTA_STEP)
    expect(secondsFor(1)).toBe(START_SECONDS)
    expect(secondsFor(2)).toBeLessThan(secondsFor(1))
  })

  it('the clock floors rather than reaching zero, however deep the run goes', () => {
    // Without a floor a deep run reaches a 0-second round, which is unwinnable by construction — the
    // run would end on the clock rather than on the player.
    for (const round of [50, 500, 5000]) expect(secondsFor(round)).toBe(MIN_SECONDS)
    expect(MIN_SECONDS).toBeGreaterThan(0)
  })

  it('the quota keeps growing after the clock has floored — the difficulty still moves', () => {
    expect(quotaFor(500)).toBeGreaterThan(quotaFor(50))
  })
})

describe('lightning — rule 1: the quota ramps on SUCCESS only', () => {
  it('a strike does NOT advance the round', () => {
    // THE death-spiral guard. A player who just failed a target must never be handed a harder one.
    const run = { round: 6, cleared: 12, strikes: 0, over: false }
    expect(strike(run).round).toBe(6)
    expect(quotaFor(strike(run).round)).toBe(quotaFor(run.round))
  })

  it('meeting a quota is the only thing that advances the round', () => {
    let run = startRun()
    expect(run.round).toBe(1)
    run = strike(run)
    run = strike(run)
    expect(run.round).toBe(1) // two failures later, still asking for the opening quota
    run = nextRound(credit(run, quotaFor(run.round)))
    expect(run.round).toBe(2)
  })
})

describe('lightning — rule 3: overflow carries, capped', () => {
  it('carries the surplus from a big cascade', () => {
    const run = credit(startRun(), START_QUOTA + 6)
    expect(nextRound(run).cleared).toBe(6)
  })

  it('caps the carry so one monster chain cannot skip a whole round', () => {
    const huge = credit(startRun(), START_QUOTA * 10)
    const after = nextRound(huge)
    const cap = Math.floor(quotaFor(2) * CARRY_FRACTION)
    expect(after.cleared).toBe(cap)
    expect(after.cleared).toBeLessThan(quotaFor(2)) // never arrives already-complete
    expect(quotaMet(after)).toBe(false)
  })

  it('never carries a negative when the quota was only just met', () => {
    const exact = credit(startRun(), START_QUOTA)
    expect(nextRound(exact).cleared).toBe(0)
  })
})

describe('lightning — rule 4: a strike resets the meter', () => {
  it('zeroes progress toward the current round', () => {
    const run = credit(startRun(), START_QUOTA - 1) // agonisingly close
    expect(strike(run).cleared).toBe(0)
  })
})

describe('lightning — strikes and the end of a run', () => {
  it(`survives ${MAX_STRIKES - 1} strikes and ends on the ${MAX_STRIKES}th`, () => {
    let run = startRun()
    for (let i = 1; i < MAX_STRIKES; i++) {
      run = strike(run)
      expect(run.over, `strike ${i} must be survivable`).toBe(false)
    }
    run = strike(run)
    expect(run.over).toBe(true)
  })

  it('counts charges down to zero in step with the strikes', () => {
    let run = startRun()
    expect(chargesLeft(run)).toBe(MAX_STRIKES - 1)
    run = strike(run)
    expect(chargesLeft(run)).toBe(MAX_STRIKES - 2)
    while (!run.over) run = strike(run)
    expect(chargesLeft(run)).toBe(0)
  })

  it('a finished run is inert — further credit and strikes change nothing', () => {
    let run = startRun()
    while (!run.over) run = strike(run)
    const frozen = { ...run }
    expect(credit(run, 999)).toEqual(frozen)
    expect(strike(run)).toEqual(frozen)
    expect(nextRound(run)).toEqual(frozen)
    expect(quotaMet(run)).toBe(false) // an over run is never "one more round" away
  })
})

/**
 * THE CHARGE — the trigger's economy guard, in the family of plinko.rate.test.ts. These numbers are
 * RE-DERIVED from a sweep, never edited to go green: `PIECES_PER_MOVE` came from L3–L296 × 40 seeds
 * through `sim.playLevel().pieces` on 2026-08-07.
 */
describe('storm — the charge is normalised across the whole level curve', () => {
  // Measured pieces-per-level and the matching move budgets, early / mid / late.
  const CURVE: Array<[label: string, pieces: number, moves: number]> = [
    ['L8', 195, 31],
    ['L50', 322, 52],
    ['L120', 429, 67],
    ['L250', 576, 83],
  ]

  it('a level played to its budget contributes about ONE level-equivalent, everywhere', () => {
    for (const [label, pieces, moves] of CURVE) {
      const contribution = chargeFor(pieces, moves)
      expect(contribution, `${label} contributes ~1`).toBeGreaterThan(0.85)
      expect(contribution, `${label} contributes ~1`).toBeLessThan(1.2)
    }
  })

  it('⚠️ the cadence does NOT drift across the curve — the whole reason the goal is not raw pieces', () => {
    // A flat piece goal would have fired every ~9 levels for a beginner and ~1.7 for a veteran:
    // rarest for the player who most needs the reward. Normalising by the move budget is what fixes
    // it, and this is the assertion that would fail if someone "simplified" chargeFor back to pieces.
    const rates = CURVE.map(([, pieces, moves]) => chargeFor(pieces, moves))
    const spread = Math.max(...rates) / Math.min(...rates)
    expect(spread, 'early-vs-late cadence spread').toBeLessThan(1.3)
    // The raw piece counts these came from really do span ~3x, so the guard above is load-bearing.
    const rawSpread = Math.max(...CURVE.map(c => c[1])) / Math.min(...CURVE.map(c => c[1]))
    expect(rawSpread).toBeGreaterThan(2.5)
  })

  it('fires roughly every 3-4 levels', () => {
    const perLevel = chargeFor(429, 67) // the mid-curve sample
    const levels = STORM_GOAL / perLevel
    expect(levels).toBeGreaterThan(2.5)
    expect(levels).toBeLessThan(4.5)
  })

  it('cannot mint charge from a malformed spec', () => {
    expect(chargeFor(100, 0)).toBe(0)
    expect(chargeFor(100, -5)).toBe(0)
    expect(chargeFor(0, 40)).toBe(0)
    expect(chargeFor(-10, 40)).toBe(0)
  })

  it('stormDue flips exactly at the goal, and progress reads 0..1', () => {
    expect(stormDue(STORM_GOAL - 0.01)).toBe(false)
    expect(stormDue(STORM_GOAL)).toBe(true)
    expect(stormProgress(0)).toBe(0)
    expect(stormProgress(STORM_GOAL / 2)).toBeCloseTo(0.5, 5)
    expect(stormProgress(STORM_GOAL * 3)).toBe(1) // clamped, never past full
  })
})

describe('storm — the payout can only ever leave you better off', () => {
  it('pays a floor even for a storm survived zero rounds', () => {
    // An EARNED bonus that could pay nothing would read as a test rather than a reward, and would
    // break the one property this shape exists to guarantee.
    expect(stormPayout(0)).toBe(STORM_PAY_FLOOR)
    expect(stormPayout(0)).toBeGreaterThan(0)
  })

  it('rises with rounds survived and is hard-capped', () => {
    expect(stormPayout(3)).toBeGreaterThan(stormPayout(1))
    expect(stormPayout(999)).toBe(STORM_PAY_CAP)
    for (const r of [0, 1, 5, 50, 5000]) expect(stormPayout(r)).toBeLessThanOrEqual(STORM_PAY_CAP)
  })

  it('stays a fixed-size gift, in-band against what already exists', () => {
    // Iron rule 1: every faucet is a fixed-size gift, never a rate. For scale a level win pays
    // ~30-60 and one jackpot wheel spin averages ~114 — a storm must not eclipse the wheel.
    expect(STORM_PAY_CAP).toBeLessThanOrEqual(150)
    expect(stormPayout(2)).toBeGreaterThan(30)
  })
})

describe('lightning — crediting', () => {
  it('accumulates across waves and ignores non-positive credit', () => {
    let run = startRun()
    run = credit(run, 4)
    run = credit(run, 11)
    expect(run.cleared).toBe(15)
    expect(credit(run, 0).cleared).toBe(15)
    expect(credit(run, -5).cleared).toBe(15)
  })

  it('quotaMet flips exactly at the quota, not before', () => {
    const short = credit(startRun(), START_QUOTA - 1)
    expect(quotaMet(short)).toBe(false)
    expect(quotaMet(credit(short, 1))).toBe(true)
  })

  it('is pure — crediting never mutates the run it was handed', () => {
    // The scene holds this state across frames; an in-place mutation would make a mid-cascade credit
    // visible to a timeout check that had already decided the round was lost.
    const run = startRun()
    credit(run, 40)
    strike(run)
    nextRound(run)
    expect(run).toEqual({ round: 1, cleared: 0, strikes: 0, over: false })
  })
})

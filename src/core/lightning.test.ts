import { describe, expect, it } from 'vitest'
import {
  CARRY_FRACTION,
  MAX_STRIKES,
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

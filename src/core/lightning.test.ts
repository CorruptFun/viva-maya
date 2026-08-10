import { describe, expect, it } from 'vitest'
import {
  addTime,
  CARRY_FRACTION,
  chainBonusFor,
  chargeFor,
  CHAIN_TIERS,
  CLOCK_CAP_SECONDS,
  clockFraction,
  credit,
  drain,
  endRun,
  nextRound,
  outOfTime,
  QUOTA_STEP,
  quotaFor,
  quotaMet,
  ROUND_SECONDS,
  secondsLeft,
  START_QUOTA,
  START_SECONDS,
  startRun,
  STORM_GOAL,
  STORM_MIN_COLLECTS_LEFT,
  STORM_MIN_MOVES_LEFT,
  STORM_PAY_CAP,
  STORM_PAY_FLOOR,
  stormDue,
  stormPayout,
  stormProgress,
} from './lightning'

/**
 * These pin the design rules from the module header, not a feel. The numbers are tunable and expected
 * to move in playtesting; the RULES are what a retune must not break, so every test here is written
 * against the rule rather than against a recorded value where it possibly can be.
 */

describe('lightning — ONE clock, and it is the one life', () => {
  it('opens with the whole run on the clock and nothing else to lose', () => {
    const run = startRun()
    expect(secondsLeft(run)).toBe(START_SECONDS)
    expect(run.over).toBe(false)
    // There is no strike count, no lives, no second chance — if a retune adds one back it has to
    // delete this assertion, which is the point of it being here.
    expect(Object.keys(run).sort()).toEqual(['cleared', 'msLeft', 'over', 'round', 'wonMs'])
  })

  it('draining the clock is the ONLY thing that can end a run', () => {
    let run = startRun()
    run = drain(run, START_SECONDS * 1000)
    expect(secondsLeft(run)).toBe(0)
    expect(outOfTime(run)).toBe(true)
    expect(endRun(run).over).toBe(true)
  })

  it('⚠️ draining never ends the run BY ITSELF — the tie goes to the player', () => {
    // A cascade that empties the clock and completes the quota in the same breath is one the player
    // earned. The scene checks the quota first and only then spends the timeout, which is only safe
    // while `drain` leaves `over` alone.
    const spent = drain(startRun(), START_SECONDS * 1000)
    expect(spent.over).toBe(false)
    expect(quotaMet(credit(spent, START_QUOTA))).toBe(true)
    expect(nextRound(credit(spent, START_QUOTA)).over).toBe(false)
  })

  it('drains to zero rather than going negative, and reads down honestly', () => {
    const run = drain(startRun(), START_SECONDS * 1000 * 10)
    expect(run.msLeft).toBe(0)
    expect(secondsLeft(run)).toBe(0)
    // Rounded UP, so a clock with 100ms on it still reads 1 and never lies about being spent.
    expect(secondsLeft(drain(startRun(), START_SECONDS * 1000 - 100))).toBe(1)
  })

  it('a finished run is inert — no credit, no time, no rounds', () => {
    const over = endRun(startRun())
    expect(credit(over, 999)).toEqual(over)
    expect(addTime(over, 30)).toEqual(over)
    expect(nextRound(over)).toEqual(over)
    expect(drain(over, 9999)).toEqual(over)
    expect(quotaMet(over)).toBe(false)
    expect(outOfTime(over)).toBe(false) // already over, not "about to be"
  })
})

describe('lightning — rule 3: time CARRIES, capped', () => {
  it('meeting a quota tops the clock up instead of resetting it', () => {
    // THE difference from the three-lives design. Seconds you did not need are seconds you keep, so
    // playing well visibly buys more of the mode. A reset here would delete the entire reward.
    const spent = drain(credit(startRun(), START_QUOTA), 5000)
    const after = nextRound(spent)
    expect(after.msLeft).toBe(spent.msLeft + ROUND_SECONDS * 1000)
    expect(after.msLeft).toBeGreaterThan(START_SECONDS * 1000 - 5000)
  })

  it('never banks past the cap', () => {
    let run = startRun()
    for (let i = 0; i < 50; i++) run = addTime(run, ROUND_SECONDS)
    expect(secondsLeft(run)).toBe(CLOCK_CAP_SECONDS)
    expect(clockFraction(run)).toBe(1)
  })

  it('⚠️ the cap is a BACKSTOP, not a budget — it must not bite during ordinary play', () => {
    // Measured, the cap swallows under 2% of the seconds this mode offers. A cap set near the working
    // range would delete the reward for exactly the players earning it. Concretely: opening clock plus
    // a round award plus the best chain bonus has to still fit, or a good first round is already
    // losing seconds it was promised.
    const best = Math.max(...CHAIN_TIERS.map(t => t.seconds))
    expect(START_SECONDS + ROUND_SECONDS + best).toBeLessThanOrEqual(CLOCK_CAP_SECONDS)
  })

  it('paying time never REDUCES the clock, whatever it is holding', () => {
    const overfull = { ...startRun(), msLeft: (CLOCK_CAP_SECONDS + 30) * 1000 }
    expect(addTime(overfull, 10).msLeft).toBe(overfull.msLeft)
    expect(addTime(overfull, 10).wonMs).toBe(0)
  })

  it('counts what was BANKED, not what was offered', () => {
    // A card claiming "+8s" for seconds the cap ate would be lying to the player about their own run.
    let run = startRun()
    for (let i = 0; i < 50; i++) run = addTime(run, ROUND_SECONDS)
    expect(run.wonMs).toBe((CLOCK_CAP_SECONDS - START_SECONDS) * 1000)
  })
})

describe('lightning — rule 3: overflow pieces carry, capped', () => {
  it('carries the surplus from a big cascade', () => {
    const run = credit(startRun(), START_QUOTA + 6)
    expect(nextRound(run).cleared).toBe(6)
  })

  it('caps the carry so one monster chain cannot skip a whole round', () => {
    const huge = credit(startRun(), START_QUOTA * 10)
    const after = nextRound(huge)
    expect(after.cleared).toBe(Math.floor(quotaFor(2) * CARRY_FRACTION))
    expect(quotaMet(after)).toBe(false) // never arrives already-complete
  })

  it('never carries a negative when the quota was only just met', () => {
    expect(nextRound(credit(startRun(), START_QUOTA)).cleared).toBe(0)
  })
})

describe('lightning — rule 1: the quota ramps on SUCCESS only', () => {
  it('grows a fixed step per round, and only nextRound moves it', () => {
    expect(quotaFor(1)).toBe(START_QUOTA)
    expect(quotaFor(2)).toBe(START_QUOTA + QUOTA_STEP)
    const run = startRun()
    expect(drain(run, 9999).round).toBe(1)
    expect(credit(run, 999).round).toBe(1)
    expect(nextRound(credit(run, START_QUOTA)).round).toBe(2)
  })

  it('keeps growing without bound — the difficulty never plateaus', () => {
    expect(quotaFor(500)).toBeGreaterThan(quotaFor(50))
  })
})

/**
 * THE RAMP vs WHAT A HUMAN CAN PHYSICALLY DO — the guard that decides whether a run ends at all.
 *
 * Measured 2026-08-07 on 30 seeded hazard-free storm boards: played optimally the board yields 8.7
 * pieces per move at an average chain of 1.93, and a move costs at minimum `SWAP_MS` + per-wave
 * (`CLEAR_MS` + `FALL_BASE_MS` + a ~2-cell refill) from config.ts — about 0.77s of animation the
 * player cannot skip — plus a floor on human reaction. That caps the whole mode at roughly 7.8
 * pieces/second, forever, no matter how good anyone gets.
 *
 * Both directions matter and they fail in opposite ways.
 */
describe('lightning — the ramp must outrun the player, but not at the door', () => {
  /** Pieces/second nobody can beat: 8.7 pieces per move ÷ ~1.12s of unavoidable move cost. */
  const CEILING_PPS = 7.8
  /** Pieces/second the opening round asks for — the whole clock, since round 1 is not paid for. */
  const openingRate = START_QUOTA / START_SECONDS
  /** Every round after the first is bought with exactly one award. */
  const rateFor = (round: number): number => quotaFor(round) / ROUND_SECONDS

  it('the opening round is comfortably enterable', () => {
    // A storm the player is GIVEN (it fires mid-level, unasked) that opens above a jog would read as
    // a punishment for clearing pieces. Well under half the ceiling.
    expect(openingRate).toBeLessThan(CEILING_PPS * 0.5)
  })

  it('⚠️ the ramp crosses the physical ceiling, so a run always ends', () => {
    // Without this the clock can be banked faster than it drains and the run has no end — which is
    // exactly what "it drags" felt like in the three-lives build. The quota is the real executioner;
    // the clock only carries out the sentence.
    const wall = [...Array(20).keys()].map(i => i + 1).find(r => rateFor(r) > CEILING_PPS)
    expect(wall).toBeDefined()
    // And it has to arrive while the run is still a MINI-GAME. A storm interrupts a level and has to
    // hand it back while the player still wants it.
    expect(wall).toBeLessThanOrEqual(8)
  })

  it('leaves real room to be good at it before that wall', () => {
    // A wall at round 2 would make the mode a coin flip with no skill expression. Chain bonuses and
    // carried overflow push good runs past this, which is the headroom a personal best lives in.
    const wall = [...Array(20).keys()].map(i => i + 1).find(r => rateFor(r) > CEILING_PPS) ?? 0
    expect(wall).toBeGreaterThanOrEqual(4)
  })
})

describe('lightning — chain bonuses ride the game’s own tier ladder', () => {
  it('pays nothing for an ordinary chain and more for each deeper tier', () => {
    expect(chainBonusFor(1)).toBe(0)
    expect(chainBonusFor(3)).toBe(0)
    const tiers = [...CHAIN_TIERS].sort((a, b) => a.cascade - b.cascade)
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i].seconds).toBeGreaterThan(tiers[i - 1].seconds)
    }
  })

  it('matches the thresholds the game already shouts about (x4 / x6 / x8)', () => {
    // GameScene's comboTier: x4 MEGA WIN, x6 SUPER MEGA, x8 UNREAL. The award has to land on a beat
    // the player has been taught since level 1 rather than inventing a second definition of "big".
    expect(CHAIN_TIERS.map(t => t.cascade).sort((a, b) => a - b)).toEqual([4, 6, 8])
    expect(chainBonusFor(4)).toBeGreaterThan(0)
    expect(chainBonusFor(7)).toBe(chainBonusFor(6))
    expect(chainBonusFor(99)).toBe(chainBonusFor(8))
  })

  it('a single chain is worth less than clearing a round', () => {
    // Otherwise the quota — the thing the whole HUD is built around — stops being the point.
    for (const tier of CHAIN_TIERS) expect(tier.seconds).toBeLessThan(ROUND_SECONDS)
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

describe('storm — it defers rather than taking a board about to be finished', () => {
  it('both thresholds are live — a zero here silently deletes the guard', () => {
    // Player-reported: the storm fired on the move that would have cleared the level. The guard only
    // exists at all if these are positive; a "simplification" to 0 would read as harmless and restore
    // the exact complaint.
    expect(STORM_MIN_MOVES_LEFT).toBeGreaterThan(0)
    expect(STORM_MIN_COLLECTS_LEFT).toBeGreaterThan(0)
  })

  it('stays narrow enough that the storm is not starved', () => {
    // Deferring costs the player nothing (the charge is not spent and rolls to the next board), but a
    // wide window would push every storm to the next level and make an EARNED bonus feel withheld.
    // A level's budget runs ~30-80 moves, so the endgame window has to stay a sliver of it.
    expect(STORM_MIN_MOVES_LEFT).toBeLessThanOrEqual(5)
    expect(STORM_MIN_COLLECTS_LEFT).toBeLessThanOrEqual(5)
  })
})

describe('storm — the payout can only ever leave you better off', () => {
  it('pays a floor even for a storm survived zero rounds', () => {
    // An EARNED bonus that could pay nothing would read as a test rather than a reward, and would
    // break the one property this shape exists to guarantee.
    expect(stormPayout(0)).toBe(STORM_PAY_FLOOR)
    expect(stormPayout(0)).toBeGreaterThan(0)
  })

  it('⚠️ the floor is not pocket change — one life makes a short run a REAL outcome', () => {
    // With three strikes almost nobody ended on zero rounds, so the floor was theoretical. It is not
    // any more, and a storm costs three and a half levels of clearing to earn. Roughly a level win.
    expect(STORM_PAY_FLOOR).toBeGreaterThanOrEqual(30)
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

  it('is pure — nothing here ever mutates the run it was handed', () => {
    // The scene holds this state across frames; an in-place mutation would make a mid-cascade credit
    // visible to a timeout check that had already decided the run was lost.
    const run = startRun()
    credit(run, 40)
    drain(run, 5000)
    addTime(run, 10)
    nextRound(run)
    endRun(run)
    expect(run).toEqual({ round: 1, cleared: 0, msLeft: START_SECONDS * 1000, wonMs: 0, over: false })
  })
})

import { describe, expect, it } from 'vitest'
import { mulberry32 } from './rng'
import {
  SLOT_BETS,
  SLOT_CHIP_VALUE,
  SLOT_MAX_ROWS,
  charmChance,
  expectedReturn,
  returnToPlayer,
  spinChipValue,
  spinSlots,
} from './slots'

/**
 * THE ECONOMY GUARD for Lucky Slots — the sibling of plinko.rate.test.ts, and for the same reason: the
 * strips and the paytable are two tables that can each be edited in isolation, and the thing they
 * jointly decide (what a spin is actually worth) is invisible from either one.
 *
 * Three claims are pinned here, all of them load-bearing:
 *
 *  1. **The house edge exists at every bet.** A machine returning ≥100% would be a chip printer — a
 *     player could farm boosts by spinning rather than by playing, and the Gift Store would become
 *     furniture nobody uses. This is the assertion that must never be relaxed.
 *  2. **More rows really are better odds.** The cabinet says so, so it has to be true: return-to-player
 *     must rise monotonically with the row count, and the charm has to get dramatically more reachable.
 *  3. **The closed form and the real machine agree.** `expectedReturn` is derived by hand (see its
 *     note on linearity of expectation under correlated rows); the sampled run is the check that the
 *     derivation still describes the strips actually shipped.
 *
 * Every number here is MEASURED, not asserted from the design doc. Change a strip, a price or a
 * paytable row and re-run this — the recorded values below are what the current table produces.
 */

/** Spins per bet in the sampled sweep. Large enough that the RTP band is tight, fast enough to keep
 *  `npm test` a couple of seconds; the charm rarity is checked against the CLOSED FORM, not sampled,
 *  because 1-in-15,600 needs far more spins than that to measure honestly. */
const SAMPLES = 150_000

interface Measured {
  rtp: number
  /** Share of spins that paid anything at all — a line, a charm, or both. */
  hitRate: number
  boostsPerSpin: number
  pointsPerSpin: number
}

function sweep(rows: number, seed: number): Measured {
  const bet = SLOT_BETS[rows - 1]
  const rng = mulberry32(seed)
  let value = 0
  let hits = 0
  let boosts = 0
  let points = 0
  for (let i = 0; i < SAMPLES; i++) {
    const spin = spinSlots(rng, rows)
    value += spinChipValue(spin)
    if (spin.lines.length > 0 || spin.charm) hits++
    boosts += spin.boosts.length
    points += spin.points
  }
  return {
    rtp: value / SAMPLES / bet.price,
    hitRate: hits / SAMPLES,
    boostsPerSpin: boosts / SAMPLES,
    pointsPerSpin: points / SAMPLES,
  }
}

const measured = SLOT_BETS.map((bet, i) => sweep(bet.rows, 4242 + i * 7919))

describe('the house edge', () => {
  it('is real at every bet — the machine can never return more than it takes', () => {
    for (const bet of SLOT_BETS) {
      expect(returnToPlayer(bet.rows), `${bet.rows} row(s), closed form`).toBeLessThan(1)
      expect(measured[bet.rows - 1].rtp, `${bet.rows} row(s), sampled`).toBeLessThan(1)
    }
  })

  it('leaves the Gift Store the better deal for a player who wants a specific boost', () => {
    // The store sells certainty at 100% of the price. If the slots ever beat that, buying a boost
    // outright becomes strictly irrational and one of the two screens is dead. The margin is what
    // makes both worth using.
    for (const bet of SLOT_BETS) expect(returnToPlayer(bet.rows)).toBeLessThan(0.95)
  })

  it('is not so steep that a spin stops being worth taking', () => {
    // Measured 2026-07-31: 78.0% / 85.4% / 88.7% / 90.9%. A floor here catches a price rise or a
    // paytable trim that quietly turns the machine into a chip shredder.
    for (const bet of SLOT_BETS) expect(returnToPlayer(bet.rows), `${bet.rows} row(s)`).toBeGreaterThan(0.7)
  })
})

describe('rows buy odds', () => {
  it('return-to-player rises with every row bought', () => {
    for (let i = 1; i < SLOT_BETS.length; i++) {
      expect(returnToPlayer(SLOT_BETS[i].rows), `${SLOT_BETS[i].rows} vs ${SLOT_BETS[i - 1].rows} rows`)
        .toBeGreaterThan(returnToPlayer(SLOT_BETS[i - 1].rows))
    }
  })

  it('so does the chance a spin pays anything at all', () => {
    // Measured: 8.9% → 16.3% → 22.6% → 28.3%. Sub-linear (the same reels feed every payline), which
    // is why the RTP ladder above leans on the scatter rather than on hit rate alone.
    for (let i = 1; i < measured.length; i++) {
      expect(measured[i].hitRate).toBeGreaterThan(measured[i - 1].hitRate)
    }
    expect(measured[SLOT_MAX_ROWS - 1].hitRate).toBeGreaterThan(0.25)
    expect(measured[0].hitRate).toBeGreaterThan(0.05)
  })

  it('and the charm goes from a rumour to something you might actually see', () => {
    // Exact, not sampled: (rows / 25)³ across the three scatter reels.
    // 1 in 15,625 → 1,953 → 579 → 244. Sixty-four times more reachable at the max bet.
    expect(1 / charmChance(1)).toBeCloseTo(15625, 0)
    expect(1 / charmChance(SLOT_MAX_ROWS)).toBeCloseTo(244.14, 1)
    expect(charmChance(SLOT_MAX_ROWS) / charmChance(1)).toBeCloseTo(64, 5)
  })

  it('keeps the charm far rarer than simply playing the game for one', () => {
    // A charm normally arrives from the Lucky Deal at ~2.5 per 100 wins, i.e. ~1,300 chips of income
    // per charm. Through the slots it costs ~10,000 chips at the max bet. The slots must never become
    // the cheap route to a collectible whose whole point is that it is earned slowly.
    const chipsPerCharm = SLOT_BETS[SLOT_MAX_ROWS - 1].price / charmChance(SLOT_MAX_ROWS)
    expect(chipsPerCharm).toBeGreaterThan(5_000)
  })
})

describe('the closed form describes the machine that shipped', () => {
  it('agrees with a sampled run at every bet', () => {
    for (const bet of SLOT_BETS) {
      const exact = expectedReturn(bet.rows)
      const sampled = measured[bet.rows - 1].rtp * bet.price
      // Within 4% relative — the charm is a 200-chip prize at up to 1-in-244, so the tail dominates
      // the sampling error and a tighter band would just be flaky.
      expect(Math.abs(sampled - exact) / exact, `${bet.rows} row(s): sampled ${sampled} vs exact ${exact}`)
        .toBeLessThan(0.04)
    }
  })

  it('scales the line half of the return exactly linearly in rows', () => {
    // Rows in a column are correlated (they are consecutive strip entries), but expectation is not:
    // each row's marginal is a plain per-reel draw, so N rows pay exactly N times one row. Subtracting
    // the scatter — which is cubic in rows, not linear — leaves the part that must scale.
    const lineEV = (rows: number): number => expectedReturn(rows) - charmChance(rows) * SLOT_CHIP_VALUE.charm
    const one = lineEV(1)
    for (const bet of SLOT_BETS) expect(lineEV(bet.rows)).toBeCloseTo(one * bet.rows, 6)
  })
})

describe('what a spin actually hands you', () => {
  it('pays power-ups as its staple, jackpot points as the occasional extra', () => {
    // The design claim from core/slots.ts: a run of 3 pays a boost alone, so boosts arrive far more
    // often than points. Measured at the max bet: ~0.58 boosts vs ~0.40 points per spin, and points
    // come in batches of 2+ from a single 4- or 5-of-a-kind, so they land on far fewer spins.
    const max = measured[SLOT_MAX_ROWS - 1]
    expect(max.boostsPerSpin).toBeGreaterThan(0.4)
    expect(max.pointsPerSpin).toBeLessThan(max.boostsPerSpin)
  })

  it('takes about a dozen max-bet spins to fill the jackpot meter', () => {
    // ~0.4 points a spin against a 5-notch goal. Slow enough that the meter stays something the game
    // gives you for playing, rather than something the shop sells.
    const spinsToFill = 5 / measured[SLOT_MAX_ROWS - 1].pointsPerSpin
    expect(spinsToFill).toBeGreaterThan(8)
    expect(spinsToFill).toBeLessThan(20)
  })
})

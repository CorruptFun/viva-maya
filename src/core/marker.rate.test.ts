import { beforeEach, describe, expect, it } from 'vitest'
import { JACKPOT_GOAL, WHEEL_PRIZES } from './jackpot'
import {
  MARKER_FROM,
  MARKER_KICKERS,
  MARKER_SPIN_FALLBACK_PIPS,
  MARKER_STAKES,
  markerOfferable,
  settleMarkerLoss,
  settleMarkerWin,
} from './marker'
import { BOOST_ITEMS } from './store'
import { SLOT_BETS } from './slots'
import { loadSave, persistSave } from './save'

/**
 * THE MARKER's economy guard — the side bet must be a STRICT SINK at every possible win rate, or
 * iron rule #1 (chips earned-only, every faucet a fixed-size gift) quietly breaks: pips mint chips
 * downstream through the wheel, so "the stake comes back plus a kicker" turns into a rate faucet
 * for exactly the strong mid-game players most likely to use it. The shape that survives is the
 * one shipped: the stake is SPENT (helper-shelf semantics) and the kicker's chips-equivalent value
 * is provably below the stake — so even a player who wins every single hand pays for the drama.
 *
 * The bound is computed from the SHIPPED prize tables (wheel wedges at face value, boost wedges at
 * their Gift-Store price — the dearest honest valuation; a free spin at the dearest bet price plus
 * the dearest boost the reels could pay). Re-derive, never hand-edit: if the wheel, the store or
 * the slots retune, this file is the tripwire that re-prices the marker.
 */

/** Wheel EV per SPIN in chips-equivalent, valuing boost wedges at Gift-Store price. */
function wheelEvPerSpin(): number {
  const total = WHEEL_PRIZES.reduce((sum, p) => sum + p.weight, 0)
  const value = WHEEL_PRIZES.reduce((sum, p) => {
    const v = p.kind === 'chips' ? p.chips : (BOOST_ITEMS.find(b => b.type === p.boost)?.price ?? 0)
    expect(v).toBeGreaterThan(0) // an unpriced wedge would silently undervalue the bound
    return sum + v * p.weight
  }, 0)
  return value / total
}

// Node test env has no localStorage — the same Map stub the other save-touching suites use
// (save.freespins.test.ts is the reference implementation).
beforeEach(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    },
  })
})

describe('the marker is a strict sink', () => {
  it('every kicker is worth provably less than its stake — even a 100% winner pays', () => {
    const pipValue = wheelEvPerSpin() / JACKPOT_GOAL
    // A free spin, valued generously: the dearest paid bet, PLUS the dearest boost prize the
    // reels could hand back on top. Real EV is far lower (slots RTP < 1); the bound only needs
    // to sit above reality and below the stake.
    const dearestBet = Math.max(...SLOT_BETS.map(b => b.price))
    const dearestBoost = Math.max(...BOOST_ITEMS.map(b => b.price))
    const spinValue = dearestBet + dearestBoost
    for (const stake of MARKER_STAKES) {
      const k = MARKER_KICKERS[stake]
      const kickerValue = k.spin
        ? Math.max(spinValue, MARKER_SPIN_FALLBACK_PIPS * pipValue) // whichever way it settles
        : k.pips * pipValue
      expect({ stake, kickerValue: Math.round(kickerValue), sink: kickerValue < stake }).toEqual({
        stake,
        kickerValue: Math.round(kickerValue),
        sink: true,
      })
    }
  })

  it('offers only where it belongs: numbered, from the band, never breathers, never unaffordable', () => {
    expect(markerOfferable(MARKER_FROM, false, 999)).toBe(true)
    expect(markerOfferable(MARKER_FROM - 1, false, 999)).toBe(false)
    expect(markerOfferable(200, false, 999)).toBe(false) // %5 breather
    expect(markerOfferable(151, true, 999)).toBe(false) // endless never
    expect(markerOfferable(151, false, MARKER_STAKES[0] - 1)).toBe(false)
    expect(markerOfferable(300, false, 999)).toBe(false) // breather AND boss — stays quiet
  })

  it('comps exactly one bust per day, atomically', () => {
    const save = loadSave()
    save.chips = 0
    save.markerCompDay = null
    persistSave(save)
    const first = settleMarkerLoss(100, '2026-08-04')
    expect(first).toEqual({ comped: true, balance: 100 })
    const second = settleMarkerLoss(100, '2026-08-04')
    expect(second).toEqual({ comped: false, balance: 100 })
    const nextDay = settleMarkerLoss(50, '2026-08-05')
    expect(nextDay).toEqual({ comped: true, balance: 150 })
  })

  it('pays the win kicker in pips, and degrades the spin to pips when the caps refuse it', () => {
    const save = loadSave()
    save.jackpotMeter = 0
    save.freeSpins = 0
    save.freeSpinsDay = null
    save.freeSpinsEarnedToday = 0
    persistSave(save)
    expect(settleMarkerWin(50, '2026-08-04')).toEqual({ pips: 1, spins: 0, meter: 1 })
    expect(settleMarkerWin(100, '2026-08-04')).toEqual({ pips: 2, spins: 0, meter: 3 })
    expect(settleMarkerWin(250, '2026-08-04')).toEqual({ pips: 0, spins: 1, meter: 3 })
    // Exhaust the daily earn cap, then the top stake must fall back to pips — never a dead payout.
    const s2 = loadSave()
    s2.freeSpinsEarnedToday = 6
    s2.freeSpinsDay = '2026-08-04'
    persistSave(s2)
    expect(settleMarkerWin(250, '2026-08-04')).toEqual({ pips: MARKER_SPIN_FALLBACK_PIPS, spins: 0, meter: 5 })
  })
})

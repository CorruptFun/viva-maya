import { beforeEach, describe, expect, it } from 'vitest'
import { CHARMS, SERIES_PURSE, SERIES_SIZE } from './charms'
import { JACKPOT_GOAL } from './jackpot'
import { mulberry32 } from './rng'
import { loadSave, persistSave, spendJackpotCharge } from './save'
import {
  SCATTER_REELS,
  SLOT_BETS,
  SLOT_CHARM,
  SLOT_MAX_ROWS,
  SLOT_MIN_RUN,
  SLOT_PAYS,
  SLOT_REELS,
  SLOT_SCATTER_NEEDED,
  SLOT_STRIPS,
  SLOT_STRIP_LEN,
  betFor,
  faceAt,
  readLine,
  spinSlots,
} from './slots'
import type { SlotSymbol } from './slots'
import { buySpin } from './store'

/**
 * Lucky Slots — the structure of the machine, and the one thing a purchased spin must never get wrong:
 * you are charged exactly once, for exactly what you were shown, and everything it paid is in the save
 * before the reels are allowed to move. The economics (return-to-player, hit frequency, how rare a
 * charm actually is) are measured separately in slots.rate.test.ts.
 */

const KEY = 'viva-maya:v1'

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
  localStorage.removeItem(KEY)
})

/** Bank a starting balance without going through a payout path. */
function setChips(chips: number): void {
  const save = loadSave()
  save.chips = chips
  persistSave(save)
}

/** A stop vector that puts `face` in row 0 of the first `reels` reels — used to force a run. */
function stopsShowing(face: SlotSymbol, reels: number): number[] {
  return SLOT_STRIPS.map((strip, reel) => {
    if (reel >= reels) {
      // Any stop whose row-0 face is NOT `face`, so the run ends exactly where we want it to.
      const i = strip.findIndex(f => f !== face)
      return i
    }
    const i = strip.indexOf(face)
    expect(i, `reel ${reel} carries ${face}`).toBeGreaterThanOrEqual(0)
    return i
  })
}

describe('reel strips', () => {
  it('are all the documented length', () => {
    expect(SLOT_STRIPS).toHaveLength(SLOT_REELS)
    for (const strip of SLOT_STRIPS) expect(strip).toHaveLength(SLOT_STRIP_LEN)
  })

  it('carry the charm scatter on reels 1, 3 and 5 only, exactly once each', () => {
    SLOT_STRIPS.forEach((strip, reel) => {
      const charms = strip.filter(f => f === SLOT_CHARM).length
      expect(charms, `reel ${reel}`).toBe(SCATTER_REELS.includes(reel) ? 1 : 0)
    })
  })

  it('never place the same face twice in a row (the window always reads varied)', () => {
    // Checked around the wrap too — the strip is a loop, so the last face neighbours the first.
    SLOT_STRIPS.forEach((strip, reel) => {
      for (let i = 0; i < strip.length; i++) {
        expect(strip[i], `reel ${reel} position ${i}`).not.toBe(strip[(i + 1) % strip.length])
      }
    })
  })

  it('only carry faces the paytable can pay', () => {
    const payable = new Set<SlotSymbol>([...SLOT_PAYS.map(p => p.symbol), SLOT_CHARM])
    for (const strip of SLOT_STRIPS) for (const face of strip) expect(payable.has(face)).toBe(true)
  })

  it('hold the same composition on every reel, bar the charm/bar swap', () => {
    // The scatter reels spend one face on the charm and the plain reels spend it on a third bar, so
    // the strips stay the same length and every other count matches across all five.
    const count = (strip: readonly SlotSymbol[], face: SlotSymbol): number => strip.filter(f => f === face).length
    for (const [reel, strip] of SLOT_STRIPS.entries()) {
      expect(count(strip, 'cherry'), `reel ${reel} cherry`).toBe(10)
      expect(count(strip, 'clover'), `reel ${reel} clover`).toBe(7)
      expect(count(strip, 'bell'), `reel ${reel} bell`).toBe(3)
      expect(count(strip, 'diamond'), `reel ${reel} diamond`).toBe(1)
      expect(count(strip, 'seven'), `reel ${reel} seven`).toBe(1)
      expect(count(strip, 'bar'), `reel ${reel} bar`).toBe(SCATTER_REELS.includes(reel) ? 2 : 3)
    }
  })
})

describe('faceAt', () => {
  it('reads consecutive strip entries, wrapping at the end', () => {
    const strip = SLOT_STRIPS[0]
    const stop = strip.length - 2
    expect(faceAt(0, stop, 0)).toBe(strip[strip.length - 2])
    expect(faceAt(0, stop, 1)).toBe(strip[strip.length - 1])
    expect(faceAt(0, stop, 2)).toBe(strip[0]) // wrapped
    expect(faceAt(0, stop, 3)).toBe(strip[1])
  })
})

describe('readLine', () => {
  it('pays a run of three from the left', () => {
    const win = readLine(['cherry', 'cherry', 'cherry', 'bell', 'clover'])
    expect(win?.symbol).toBe('cherry')
    expect(win?.run).toBe(3)
    expect(win?.payout.boosts).toBe(1)
  })

  it('ignores a run of two', () => {
    expect(readLine(['cherry', 'cherry', 'bell', 'cherry', 'cherry'])).toBeNull()
  })

  it('only reads from reel 1 — a run that starts on reel 2 pays nothing', () => {
    expect(readLine(['bell', 'cherry', 'cherry', 'cherry', 'cherry'])).toBeNull()
  })

  it('pays the longest run reached', () => {
    expect(readLine(['clover', 'clover', 'clover', 'clover', 'bell'])?.run).toBe(4)
    expect(readLine(['clover', 'clover', 'clover', 'clover', 'clover'])?.run).toBe(SLOT_REELS)
  })

  it('never starts a line on the scatter, and the scatter breaks one', () => {
    expect(readLine([SLOT_CHARM, SLOT_CHARM, SLOT_CHARM, SLOT_CHARM, SLOT_CHARM])).toBeNull()
    expect(readLine(['cherry', 'cherry', SLOT_CHARM, 'cherry', 'cherry'])).toBeNull()
  })

  it('pays richer the further the run reaches', () => {
    for (const pay of SLOT_PAYS) {
      const [three, four, five] = pay.runs
      expect(four.boosts).toBeGreaterThan(three.boosts)
      expect(five.boosts).toBeGreaterThan(four.boosts)
      expect(three.points).toBe(0) // a 3 pays the power-up alone; only 4s and 5s carry jackpot points
      expect(five.points).toBeGreaterThan(four.points)
    }
  })
})

describe('spinSlots', () => {
  it('lights exactly the rows the bet paid for', () => {
    const rng = mulberry32(7)
    for (const bet of SLOT_BETS) {
      const spin = spinSlots(rng, bet.rows)
      expect(spin.grid).toHaveLength(bet.rows)
      for (const row of spin.grid) expect(row).toHaveLength(SLOT_REELS)
      for (const line of spin.lines) expect(line.row).toBeLessThan(bet.rows)
      for (const [row] of spin.scatters) expect(row).toBeLessThan(bet.rows)
    }
  })

  it('reports a grid that matches the stops it settled on', () => {
    const spin = spinSlots(mulberry32(99), SLOT_MAX_ROWS)
    spin.grid.forEach((row, r) =>
      row.forEach((face, reel) => expect(face).toBe(faceAt(reel, spin.stops[reel], r)))
    )
  })

  it('totals the boosts and points its lines paid', () => {
    const rng = mulberry32(3)
    for (let i = 0; i < 500; i++) {
      const spin = spinSlots(rng, SLOT_MAX_ROWS)
      const boosts = spin.lines.reduce((n, l) => n + l.payout.boosts, 0)
      const points = spin.lines.reduce((n, l) => n + l.payout.points, 0)
      expect(spin.boosts).toHaveLength(boosts)
      expect(spin.points).toBe(points)
    }
  })

  it('only calls a charm once the scatter count is reached', () => {
    const rng = mulberry32(11)
    for (let i = 0; i < 2000; i++) {
      const spin = spinSlots(rng, SLOT_MAX_ROWS)
      expect(spin.charm).toBe(spin.scatters.length >= SLOT_SCATTER_NEEDED)
    }
  })
})

describe('bets', () => {
  it('ladder up one row at a time to the height of the cabinet', () => {
    expect(SLOT_BETS).toHaveLength(SLOT_MAX_ROWS)
    SLOT_BETS.forEach((bet, i) => expect(bet.rows).toBe(i + 1))
  })

  it('cost more per spin but less per row as you climb', () => {
    for (let i = 1; i < SLOT_BETS.length; i++) {
      expect(SLOT_BETS[i].price).toBeGreaterThan(SLOT_BETS[i - 1].price)
      expect(SLOT_BETS[i].price / SLOT_BETS[i].rows).toBeLessThan(SLOT_BETS[i - 1].price / SLOT_BETS[i - 1].rows)
    }
  })

  it('clamp an out-of-range row count into the table', () => {
    expect(betFor(0)).toBe(SLOT_BETS[0])
    expect(betFor(-3)).toBe(SLOT_BETS[0])
    expect(betFor(99)).toBe(SLOT_BETS[SLOT_BETS.length - 1])
  })
})

describe('buySpin', () => {
  it('refuses — and touches nothing — when the bet is unaffordable', () => {
    const bet = betFor(SLOT_MAX_ROWS)
    setChips(bet.price - 1)
    const before = JSON.stringify(loadSave())
    const res = buySpin(SLOT_MAX_ROWS, mulberry32(1))
    expect(res.ok).toBe(false)
    expect(JSON.stringify(loadSave())).toBe(before)
  })

  it('charges the bet exactly once', () => {
    const bet = betFor(2)
    setChips(1000)
    const res = buySpin(2, mulberry32(5))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // A charm scatter can pay chips of its own (a duplicate, or a completed album's purse), so the
    // debit is checked against those rather than against a bare subtraction.
    const award = res.purchase.charm
    let credited = 0
    if (award?.kind === 'duplicate') credited = award.chips
    else if (award?.kind === 'charm' && award.completed) credited = award.purse
    expect(loadSave().chips).toBe(1000 - bet.price + credited)
    expect(res.purchase.balance).toBe(loadSave().chips)
  })

  it('banks every prize BEFORE returning, so a spin lost mid-animation is still paid', () => {
    setChips(100_000)
    const rng = mulberry32(4242)
    let banked = 0
    let charged = 0
    for (let i = 0; i < 400; i++) {
      const res = buySpin(SLOT_MAX_ROWS, rng)
      expect(res.ok).toBe(true)
      if (!res.ok) return
      banked += res.purchase.spin.boosts.length
      charged += res.purchase.spin.points
      const save = loadSave()
      expect(save.pendingBoosts).toHaveLength(banked)
      expect(save.jackpotMeter).toBe(charged)
      expect(res.purchase.meter).toBe(charged)
    }
    expect(banked).toBeGreaterThan(0) // 400 max-bet spins that paid nothing at all would be a broken table
  })

  it('spends the balance down to zero and then stops, never below', () => {
    const bet = betFor(1)
    setChips(bet.price * 3)
    const rng = mulberry32(8)
    for (let i = 0; i < 3; i++) expect(buySpin(1, rng).ok).toBe(true)
    expect(buySpin(1, rng).ok).toBe(false)
    expect(loadSave().chips).toBeGreaterThanOrEqual(0)
  })

  it('hands over a charm when the scatter lands, and reports what the album did with it', () => {
    setChips(1_000_000)
    const rng = mulberry32(20260731)
    let awarded = 0
    for (let i = 0; i < 4000 && awarded < 3; i++) {
      const res = buySpin(SLOT_MAX_ROWS, rng)
      if (!res.ok || !res.purchase.spin.charm) continue
      awarded++
      const award = res.purchase.charm
      expect(award).toBeDefined()
      if (award?.kind === 'charm') {
        expect(CHARMS.map(c => c.id)).toContain(award.charm.id)
        expect(loadSave().charms).toContain(award.charm.id)
      }
    }
    expect(awarded, 'the scatter is rare, but 4000 max-bet spins should land a few').toBeGreaterThan(0)
    // Under SERIES_SIZE awards from an empty album, every one is a new charm — no duplicates yet.
    expect(loadSave().charmsAllTime).toBe(awarded)
  })

  it('never grants a charm without the scatter', () => {
    setChips(100_000)
    const rng = mulberry32(31)
    for (let i = 0; i < 600; i++) {
      const before = loadSave().charmsAllTime
      const res = buySpin(SLOT_MAX_ROWS, rng)
      if (!res.ok) break
      const after = loadSave().charmsAllTime
      expect(after).toBe(res.purchase.spin.charm ? before + 1 : before)
    }
  })
})

describe('jackpot points', () => {
  it('queue the next wheel instead of evaporating when the slots overfill the meter', () => {
    const save = loadSave()
    save.jackpotMeter = JACKPOT_GOAL + 3
    persistSave(save)
    expect(spendJackpotCharge()).toBe(3)
    expect(loadSave().jackpotMeter).toBe(3)
  })

  it('empties a meter that is exactly full (the level-win case, unchanged)', () => {
    const save = loadSave()
    save.jackpotMeter = JACKPOT_GOAL
    persistSave(save)
    expect(spendJackpotCharge()).toBe(0)
  })

  it('never goes negative', () => {
    expect(spendJackpotCharge()).toBe(0)
    expect(loadSave().jackpotMeter).toBe(0)
  })
})

describe('the paytable a player is shown', () => {
  it('covers every board face on the strips', () => {
    const onStrips = new Set<SlotSymbol>(SLOT_STRIPS.flatMap(s => [...s]))
    onStrips.delete(SLOT_CHARM)
    expect(new Set(SLOT_PAYS.map(p => p.symbol))).toEqual(onStrips)
  })

  it('gives every face a payout for each run length it can reach', () => {
    for (const pay of SLOT_PAYS) expect(pay.runs).toHaveLength(SLOT_REELS - SLOT_MIN_RUN + 1)
  })

  it('pays what the paytable promises for a forced run', () => {
    for (const pay of SLOT_PAYS) {
      for (let run = SLOT_MIN_RUN; run <= SLOT_REELS; run++) {
        const stops = stopsShowing(pay.symbol, run)
        const row = stops.map((stop, reel) => faceAt(reel, stop, 0))
        const win = readLine(row)
        expect(win?.symbol, `${pay.symbol} × ${run}`).toBe(pay.symbol)
        expect(win?.run, `${pay.symbol} × ${run}`).toBe(run)
        expect(win?.payout).toEqual(pay.runs[run - SLOT_MIN_RUN])
      }
    }
  })

  it('completing a series through the slots still pays the album purse', () => {
    // The slots are a second charm faucet; the album's own completion rules must be untouched by that.
    setChips(50_000)
    const save = loadSave()
    save.charms = CHARMS.slice(0, SERIES_SIZE - 1).map(c => c.id)
    persistSave(save)
    const rng = mulberry32(20260801)
    for (let i = 0; i < 6000; i++) {
      const res = buySpin(SLOT_MAX_ROWS, rng)
      if (!res.ok) break
      if (res.purchase.charm?.kind === 'charm' && res.purchase.charm.completed) {
        expect(res.purchase.charm.purse).toBe(SERIES_PURSE)
        expect(loadSave().charms).toEqual([])
        expect(loadSave().charmSeries).toBe(2)
        return
      }
    }
    throw new Error('never completed the album — the scatter or the charm grant is broken')
  })
})

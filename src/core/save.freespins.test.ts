import { beforeEach, describe, expect, it } from 'vitest'
import { FREE_SPIN_BANK_CAP, FREE_SPIN_DAILY_CAP, addFreeSpins, freeSpinRoom, loadSave, persistSave } from './save'
import { awardFreeSpinsFor } from './daily'
import { PLINKO_MIN_CASCADE } from './plinko'

/**
 * Free-spin banking, and the ONE rule the Plinko board leans on: what `freeSpinRoom` promises for a
 * source is exactly what `addFreeSpins` then grants for that source. GameScene paints the SPIN wells
 * from the former and view/plinko.ts pays them from the latter, so if the two ever disagree the
 * board either advertises a prize it can't honour or hides one it could.
 *
 * The regression that motivated the split is pinned below: a Plinko drop needs an x5+ chain, and that
 * chain has already banked its MEGA award moments earlier in the same resolve — so under one shared
 * daily budget the drop's own trigger routinely emptied the allowance, and the board it bought had
 * to restrike both SPIN wells as ×8. Plinko answers to the BANK cap only; MEGA answers to both.
 */

const KEY = 'viva-maya:v1'
const DAY = '2026-07-28'

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

/** Put the bank at an exact size without going through the capped earn path. */
function setBank(freeSpins: number, earnedToday: number, day: string | null = DAY): void {
  const save = loadSave()
  save.freeSpins = freeSpins
  save.freeSpinsEarnedToday = earnedToday
  save.freeSpinsDay = day
  persistSave(save)
}

describe("the 'mega' source", () => {
  it('stops at the daily earn cap', () => {
    expect(addFreeSpins(FREE_SPIN_DAILY_CAP, DAY)).toBe(FREE_SPIN_DAILY_CAP)
    expect(addFreeSpins(3, DAY)).toBe(0)
    expect(freeSpinRoom(DAY)).toBe(0)
  })

  it('resets the earn counter on a new local day', () => {
    addFreeSpins(FREE_SPIN_DAILY_CAP, DAY)
    expect(freeSpinRoom('2026-07-29')).toBeGreaterThan(0)
    expect(addFreeSpins(3, '2026-07-29')).toBe(3)
  })

  it('stops at the bank cap even across days', () => {
    setBank(FREE_SPIN_BANK_CAP, 0, null)
    expect(freeSpinRoom(DAY)).toBe(0)
    expect(addFreeSpins(1, DAY)).toBe(0)
  })
})

describe("the 'plinko' source", () => {
  it('is NOT blocked by the daily earn cap — the SPIN wells survive a maxed-out day', () => {
    addFreeSpins(FREE_SPIN_DAILY_CAP, DAY) // the day's MEGA allowance, spent
    expect(freeSpinRoom(DAY, 'mega')).toBe(0)
    expect(freeSpinRoom(DAY, 'plinko')).toBeGreaterThan(0)
    expect(addFreeSpins(1, DAY, 'plinko')).toBe(1)
  })

  /**
   * The exact shape of the bug. A qualifying chain banks its MEGA award (awardFreeSpinsFor) and THEN
   * the drop is offered, so the board must still be able to show SPIN on the very next line.
   */
  it('leaves SPIN payable on the drop the trigger chain just earned', () => {
    for (const cascade of [PLINKO_MIN_CASCADE, 6, 8]) {
      localStorage.removeItem(KEY)
      addFreeSpins(awardFreeSpinsFor(cascade), DAY) // maybeAwardFreeSpins, moments before the drop
      expect(freeSpinRoom(DAY, 'plinko'), `x${cascade} chain left no room for its own drop`).toBeGreaterThan(0)
    }
  })

  it('IS blocked by the bank cap — a full bank honestly restrikes the wells', () => {
    setBank(FREE_SPIN_BANK_CAP, 0)
    expect(freeSpinRoom(DAY, 'plinko')).toBe(0)
    expect(addFreeSpins(1, DAY, 'plinko')).toBe(0)
  })

  it('never persists an earn counter past the daily cap (coerceSave clamps that field)', () => {
    addFreeSpins(FREE_SPIN_DAILY_CAP, DAY)
    addFreeSpins(1, DAY, 'plinko')
    expect(loadSave().freeSpinsEarnedToday).toBe(FREE_SPIN_DAILY_CAP)
    expect(loadSave().freeSpins).toBe(FREE_SPIN_DAILY_CAP + 1)
  })
})

/**
 * The board/payment contract, swept over every reachable bank+earn state: whatever `freeSpinRoom`
 * reports for a source is what `addFreeSpins` grants for it. GameScene shows the SPIN wells when the
 * former is > 0; view/plinko.ts pays with the latter. They must never disagree.
 */
describe('freeSpinRoom agrees with addFreeSpins', () => {
  it('for both sources, across every bank and earn state', () => {
    const bad: string[] = []
    for (let bank = 0; bank <= FREE_SPIN_BANK_CAP; bank++) {
      for (let earned = 0; earned <= FREE_SPIN_DAILY_CAP; earned++) {
        for (const source of ['mega', 'plinko'] as const) {
          setBank(bank, earned)
          const promised = Math.min(1, freeSpinRoom(DAY, source))
          const granted = addFreeSpins(1, DAY, source)
          if (promised !== granted) bad.push(`bank=${bank} earned=${earned} ${source}: said ${promised}, gave ${granted}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})

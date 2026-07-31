import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mulberry32 } from './rng'
import type { Rng } from './rng'
import { coerceSave, loadSave, persistSave, type SaveData } from './save'
import { spinSlots } from './slots'
import { freeSlotSpin } from './store'
import { checkinChipsFor, todayKey } from './daily'

/**
 * FREE PULLS on the Lucky Slots cabinet (core/store.ts freeSlotSpin) — the daily spin and the banked
 * free-spin currency, now taken on the same machine the paid bets run on. What these pin:
 *
 *  • the GIFT FLOOR — a free pull never pays nothing (the classic daily PRIZES table tops up an
 *    empty spin), and never fires when the reels DID pay;
 *  • the DAILY ritual — streak/latch/check-in chips advance exactly once, and the every-5th-day
 *    double prize still lands;
 *  • the BANKED contract — bank − 1 and NOTHING else: no latch, no streak, no chips;
 *  • the race guards — claimed daily / empty bank return null with the save untouched.
 *
 * freeSlotSpin banks through loadSave/persistSave (the buySpin shape), so these tests give the node
 * environment a real localStorage: a Map-backed shim installed for this file only. Seeds are hunted
 * at run time with the REAL spinSlots, so a strip retune can never silently invalidate a fixture —
 * if no seed in the search window produces the shape a test needs, the hunt itself fails loudly.
 */

// ── localStorage shim (this file only) ───────────────────────────────────────
const backing = new Map<string, string>()
const hadLocalStorage = 'localStorage' in globalThis
const realLocalStorage = hadLocalStorage ? globalThis.localStorage : undefined
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
  },
})
afterAll(() => {
  if (hadLocalStorage) Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: realLocalStorage })
  else delete (globalThis as Record<string, unknown>).localStorage
})

/** Seed the persisted save through the REAL coercion + persist path, then return the live copy. */
const seedSave = (partial: Partial<SaveData>): SaveData => {
  backing.clear()
  persistSave(coerceSave(partial))
  return loadSave()
}

const rng = (seed: number): Rng => mulberry32(seed)

/** Hunt the first seed in [0, 20000) whose FULL-cabinet spin satisfies `want`. Throws if none does. */
const seedWhere = (want: (spin: ReturnType<typeof spinSlots>) => boolean): number => {
  for (let s = 0; s < 20000; s++) {
    if (want(spinSlots(rng(s), 4))) return s
  }
  throw new Error('no seed in the search window produced the required spin shape')
}

const EMPTY_SEED = seedWhere(sp => sp.boosts.length === 0 && sp.points === 0 && !sp.charm)
// Boosts but NO charm: the charm path re-enters the save through grantCharm and would blur the
// single-write assertions these fixtures make.
const PAYING_SEED = seedWhere(sp => sp.boosts.length > 0 && !sp.charm)

const YESTERDAY = (() => {
  const d = new Date(Date.now() - 86400000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

beforeEach(() => backing.clear())

describe('freeSlotSpin — the gift floor', () => {
  it('tops an empty spin up with exactly one classic prize boost', () => {
    seedSave({ lastSpinDate: YESTERDAY, streak: 1, chips: 0, pendingBoosts: [] })
    const r = freeSlotSpin('daily', rng(EMPTY_SEED))
    expect(r).not.toBeNull()
    expect(r?.spin.boosts).toHaveLength(0) // the reels really did pay nothing…
    expect(r?.comp).not.toBeNull() // …so the house added the floor
    const after = loadSave()
    expect(after.pendingBoosts).toHaveLength(1)
    expect(after.pendingBoosts[0]).toBe(r?.comp?.type)
  })

  it('never fires when the reels themselves paid', () => {
    seedSave({ lastSpinDate: YESTERDAY, streak: 1, pendingBoosts: [] })
    const r = freeSlotSpin('daily', rng(PAYING_SEED))
    expect(r?.spin.boosts.length).toBeGreaterThan(0)
    expect(r?.comp).toBeNull()
    expect(loadSave().pendingBoosts).toHaveLength(r!.spin.boosts.length)
  })
})

describe('freeSlotSpin — the daily ritual', () => {
  it('advances streak, latches today, and banks the ladder chips once', () => {
    seedSave({ lastSpinDate: YESTERDAY, streak: 3, chips: 100 })
    const r = freeSlotSpin('daily', rng(PAYING_SEED))
    expect(r?.streak).toBe(4)
    expect(r?.checkinChips).toBe(checkinChipsFor(4))
    const after = loadSave()
    expect(after.streak).toBe(4)
    expect(after.lastSpinDate).toBe(todayKey())
    expect(after.chips).toBe(100 + checkinChipsFor(4)) // chips only ever ARRIVE on a free pull
  })

  it('pays the every-5th-day double prize on top of whatever the reels did', () => {
    seedSave({ lastSpinDate: YESTERDAY, streak: 4, pendingBoosts: [] })
    const r = freeSlotSpin('daily', rng(PAYING_SEED))
    expect(r?.streak).toBe(5)
    expect(r?.milestone).not.toBeNull()
    expect(loadSave().pendingBoosts).toHaveLength(r!.spin.boosts.length + 1)
  })

  it('refuses a second daily on the same day, save untouched', () => {
    seedSave({ lastSpinDate: todayKey(), streak: 2, chips: 50 })
    expect(freeSlotSpin('daily', rng(PAYING_SEED))).toBeNull()
    const after = loadSave()
    expect(after.streak).toBe(2)
    expect(after.chips).toBe(50)
    expect(after.pendingBoosts).toHaveLength(0)
  })
})

describe('freeSlotSpin — the banked contract', () => {
  it('spends bank − 1 and touches nothing else: no latch, no streak, no chips', () => {
    seedSave({ freeSpins: 3, chips: 100, streak: 5, lastSpinDate: YESTERDAY })
    const r = freeSlotSpin('banked', rng(PAYING_SEED))
    expect(r?.remaining).toBe(2)
    expect(r?.streak).toBeUndefined()
    expect(r?.milestone).toBeNull() // the day-5 double is the DAILY's promise, never a banked pull's
    const after = loadSave()
    expect(after.freeSpins).toBe(2)
    expect(after.chips).toBe(100) // NO check-in chips — banked spins ride alongside the daily rhythm
    expect(after.streak).toBe(5)
    expect(after.lastSpinDate).toBe(YESTERDAY) // latch untouched — today's daily is still available
  })

  it('refuses on an empty bank, save untouched', () => {
    seedSave({ freeSpins: 0, chips: 80 })
    expect(freeSlotSpin('banked', rng(PAYING_SEED))).toBeNull()
    expect(loadSave().chips).toBe(80)
  })

  it('always lights the full cabinet — a free pull is the machine at its best odds', () => {
    seedSave({ freeSpins: 1 })
    const r = freeSlotSpin('banked', rng(PAYING_SEED))
    expect(r?.spin.bet.rows).toBe(4)
    expect(r?.spin.grid).toHaveLength(4)
  })
})

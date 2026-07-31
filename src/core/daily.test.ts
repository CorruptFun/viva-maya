import { describe, expect, it } from 'vitest'
import { CHECKIN_CHIPS, advanceDailyRitual, checkinChipsFor, milestoneDue } from './daily'
import { coerceSave, type SaveData } from './save'

/**
 * The daily CHECK-IN ritual: a streak-scaled chip gift banked by advanceDailyRitual (the ritual half
 * of the daily spin — the spin itself now rides the Lucky Slots cabinet, see slotfree.test.ts).
 * These tests pin the ladder, the weekly wrap, the streak arithmetic + latch, that the ritual banks
 * exactly what it returns onto the passed save, and the every-5th-day double-prize schedule.
 */

// Build a full SaveData from a partial through the REAL coercion path, so fixtures can't drift from the
// on-disk shape (same helper shape as merge.test.ts).
const save = (partial: Partial<SaveData>): SaveData => coerceSave(partial)

// A deterministic clock + day keys around it. advanceDailyRitual reads local Y-M-D via todayKey(now).
const NOW = new Date(2026, 6, 22) // 2026-07-22 (local)
const YESTERDAY = '2026-07-21'
const THREE_DAYS_AGO = '2026-07-19'

describe('checkinChipsFor — the 7-day ladder', () => {
  it('maps streak days 1..7 to the CHECKIN_CHIPS ladder', () => {
    expect(CHECKIN_CHIPS).toHaveLength(7)
    for (let day = 1; day <= 7; day++) expect(checkinChipsFor(day)).toBe(CHECKIN_CHIPS[day - 1])
  })

  it('ramps small→big and peaks on day 7 (the weekly payday)', () => {
    expect(checkinChipsFor(1)).toBe(10)
    expect(checkinChipsFor(7)).toBe(150)
    // strictly increasing across the week — "start small and add them up"
    for (let day = 2; day <= 7; day++) expect(checkinChipsFor(day)).toBeGreaterThan(checkinChipsFor(day - 1))
  })

  it('repeats every 7 days — day 8 wraps back to day 1, day 14 back to day 7', () => {
    expect(checkinChipsFor(8)).toBe(checkinChipsFor(1)) // 10
    expect(checkinChipsFor(14)).toBe(checkinChipsFor(7)) // 150
    expect(checkinChipsFor(15)).toBe(checkinChipsFor(1)) // 10 — a fresh week
    expect(checkinChipsFor(30)).toBe(checkinChipsFor(2)) // (30-1)%7 = 1 → day 2 → 15
  })

  it('pays nothing for a non-positive streak (never-spun / defensive)', () => {
    expect(checkinChipsFor(0)).toBe(0)
    expect(checkinChipsFor(-3)).toBe(0)
  })
})


describe('advanceDailyRitual — the streak/latch/chips half of the daily spin', () => {
  it('first-ever check-in starts the streak at day 1, latches today, and banks day 1 chips', () => {
    const s = save({ lastSpinDate: null, streak: 0, chips: 0 })
    const r = advanceDailyRitual(s, NOW)
    expect(r.streak).toBe(1)
    expect(r.chips).toBe(10)
    expect(s.chips).toBe(10) // banked onto the SAME object the caller persists
    expect(s.lastSpinDate).toBe('2026-07-22')
  })

  it('a consecutive day advances the streak and pays that day up the ladder, adding to the balance', () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 6, chips: 100 })
    const r = advanceDailyRitual(s, NOW)
    expect(r.streak).toBe(7)
    expect(r.chips).toBe(150) // day 7 payday
    expect(s.chips).toBe(250) // 100 + 150 — accumulates, never replaces
  })

  it('a missed day resets the streak to day 1 and back to the small day-1 reward', () => {
    const s = save({ lastSpinDate: THREE_DAYS_AGO, streak: 40, chips: 500 })
    const r = advanceDailyRitual(s, NOW)
    expect(r.streak).toBe(1)
    expect(r.chips).toBe(10)
    expect(s.chips).toBe(510)
  })

  it('returns exactly what it banks — result.chips always equals the balance delta and the ladder', () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 3, chips: 42 })
    const before = s.chips
    const r = advanceDailyRitual(s, NOW)
    expect(s.chips - before).toBe(r.chips)
    expect(r.chips).toBe(checkinChipsFor(r.streak))
  })

  it('never touches the free-spin bank or the boost pile — it is the ritual half only', () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 1, freeSpins: 4, pendingBoosts: [] })
    advanceDailyRitual(s, NOW)
    expect(s.freeSpins).toBe(4)
    expect(s.pendingBoosts).toHaveLength(0)
  })
})

describe('milestoneDue — the every-5th-day double-prize promise', () => {
  it('is due on days 5, 10, 15 … and nowhere else', () => {
    for (let day = 1; day <= 20; day++) expect(milestoneDue(day)).toBe(day % 5 === 0)
  })
  it('is never due for a non-positive streak', () => {
    expect(milestoneDue(0)).toBe(false)
    expect(milestoneDue(-5)).toBe(false)
  })
})

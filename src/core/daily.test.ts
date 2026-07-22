import { describe, expect, it } from 'vitest'
import { CHECKIN_CHIPS, checkinChipsFor, performFreeSpin, performSpin } from './daily'
import { mulberry32 } from './rng'
import { coerceSave, type SaveData } from './save'

/**
 * The daily CHECK-IN chip reward: a streak-scaled gift banked by performSpin, ramping across a 7-day
 * week and RESETTING with it (indexed like the D3 week strip). These tests pin the ladder, the weekly
 * wrap, that performSpin banks exactly what it returns onto the passed save, and — critically — that a
 * banked FREE spin never pays check-in chips (it bypasses the daily latch/streak by contract).
 */

// Build a full SaveData from a partial through the REAL coercion path, so fixtures can't drift from the
// on-disk shape (same helper shape as merge.test.ts).
const save = (partial: Partial<SaveData>): SaveData => coerceSave(partial)

// A deterministic clock + day keys around it. performSpin reads local Y-M-D via todayKey(now).
const NOW = new Date(2026, 6, 22) // 2026-07-22 (local)
const YESTERDAY = '2026-07-21'
const THREE_DAYS_AGO = '2026-07-19'
const rng = () => mulberry32(1) // fresh deterministic stream per spin (prize choice is irrelevant here)

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

describe('performSpin — banks the check-in chips', () => {
  it("first-ever spin starts the streak at day 1 and banks day 1's chips", () => {
    const s = save({ lastSpinDate: null, streak: 0, chips: 0 })
    const result = performSpin(s, rng(), NOW)
    expect(result.streak).toBe(1)
    expect(result.chips).toBe(10)
    expect(s.chips).toBe(10) // banked onto the SAME object performSpin persists
  })

  it('a consecutive day advances the streak and pays that day up the ladder, adding to the balance', () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 6, chips: 100 })
    const result = performSpin(s, rng(), NOW)
    expect(result.streak).toBe(7)
    expect(result.chips).toBe(150) // day 7 payday
    expect(s.chips).toBe(250) // 100 + 150 — accumulates, never replaces
  })

  it('a missed day resets the streak to day 1 and back to the small day-1 reward', () => {
    const s = save({ lastSpinDate: THREE_DAYS_AGO, streak: 40, chips: 500 })
    const result = performSpin(s, rng(), NOW)
    expect(result.streak).toBe(1)
    expect(result.chips).toBe(10)
    expect(s.chips).toBe(510)
  })

  it("returns exactly what it banks — result.chips always equals the balance delta", () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 3, chips: 42 })
    const before = s.chips
    const result = performSpin(s, rng(), NOW)
    expect(s.chips - before).toBe(result.chips)
    expect(result.chips).toBe(checkinChipsFor(result.streak))
  })

  it('still pays a DOUBLE boost on the 5th streak day while paying that day\'s chips once', () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 4, chips: 0 })
    const result = performSpin(s, rng(), NOW)
    expect(result.streak).toBe(5)
    expect(result.prizes).toHaveLength(2) // the pre-existing every-5th-day double-boost is untouched
    expect(result.chips).toBe(60) // chips are ladder-driven, NOT doubled — one payout for the day
    expect(s.chips).toBe(60)
  })
})

describe('performFreeSpin — never pays check-in chips', () => {
  it('spends a banked spin and awards a boost but leaves chips, streak, and the daily latch untouched', () => {
    const s = save({ freeSpins: 2, chips: 100, streak: 5, lastSpinDate: YESTERDAY })
    const result = performFreeSpin(s, rng())
    expect(result).not.toBeNull()
    expect(result?.remaining).toBe(1)
    expect(result?.prizes).toHaveLength(1)
    expect(s.chips).toBe(100) // NO check-in chips — free spins ride alongside the daily rhythm
    expect(s.streak).toBe(5) // streak untouched
    expect(s.lastSpinDate).toBe(YESTERDAY) // latch untouched — today's daily is still available
  })
})

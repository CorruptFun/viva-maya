import { describe, expect, it } from 'vitest'
import {
  CHECKIN_CHIPS,
  STREAK_REWARDS,
  advanceDailyRitual,
  checkinChipsFor,
  daysToNextStreakReward,
  grantStreakReward,
  milestoneDue,
  nextStreakReward,
  streakRewardFor,
} from './daily'
import { BOOST_META } from './inventory'
import { FREE_SPIN_BANK_CAP, coerceSave, type SaveData } from './save'

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
    expect(r.chips).toBe(150) // day 7 payday — the CHECK-IN ladder's peak
    // ⚠️ Day 7 pays TWO faucets, and `chips` is only the first of them: the STREAK REWARD's ONE WEEK
    // rung lands on the same day and banks its purse onto the same object. This assertion is about
    // accumulation (never replacement), so it sums both rather than dodging the collision — see the
    // ladder's own tests below for the rung in isolation.
    expect(s.chips).toBe(100 + 150 + streakRewardFor(7)!.chips)
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


// ─────────────────────────────────────────────────────────────────────────────
// STREAK REWARDS — the 3/7/14/30/60/100 ladder.
//
// Two very different kinds of test live below and they are NOT interchangeable:
//
//  • the BEHAVIOUR tests pin mechanics (exact-day matching, the bank cap, where
//    `repeat` is read from). Break one and something is wrong.
//  • the last block is an ECONOMY GUARD in the sense endless.pace.test.ts uses
//    the phrase — it measures what the ladder actually pays against the budget
//    its header claims and against the rules the rest of the economy is built
//    on. It pins a CONTRACT, not a recorded number: rungs must ascend, none may
//    reach the weekly champion purse, and the 100-day total must stay a side
//    dish. ⚠️ If you retune STREAK_REWARDS, re-derive the header comment's
//    arithmetic — never edit the bands to make this green.
// ─────────────────────────────────────────────────────────────────────────────

describe('STREAK_REWARDS — the ladder table', () => {
  it('is sorted ascending by day with no duplicates (nextStreakReward walks it front-to-back)', () => {
    for (let i = 1; i < STREAK_REWARDS.length; i++) {
      expect(STREAK_REWARDS[i].day).toBeGreaterThan(STREAK_REWARDS[i - 1].day)
    }
  })

  it('names every boost from BOOST_META — the only place a boost is called anything', () => {
    for (const rung of STREAK_REWARDS) {
      if (rung.boost) expect(BOOST_META[rung.boost]).toBeDefined()
    }
  })
})

describe('streakRewardFor — lands on the exact day, never "at least"', () => {
  it('pays on each rung day', () => {
    for (const rung of STREAK_REWARDS) expect(streakRewardFor(rung.day)).toBe(rung)
  })

  it('pays nothing on an ordinary day, including the day after a rung', () => {
    expect(streakRewardFor(2)).toBeNull()
    expect(streakRewardFor(4)).toBeNull() // the day after day 3
    expect(streakRewardFor(8)).toBeNull() // the day after ONE WEEK
    expect(streakRewardFor(99)).toBeNull()
    expect(streakRewardFor(101)).toBeNull() // past the top rung — nothing, not a repeat
  })

  it('pays nothing for a non-positive or garbage streak (defensive — this also runs on merged saves)', () => {
    expect(streakRewardFor(0)).toBeNull()
    expect(streakRewardFor(-7)).toBeNull()
    expect(streakRewardFor(NaN)).toBeNull()
  })
})

describe('nextStreakReward / daysToNextStreakReward — the countdown the badge and the card read', () => {
  it('points at the first rung AHEAD, never at the one just reached', () => {
    expect(nextStreakReward(0)?.day).toBe(3)
    expect(nextStreakReward(1)?.day).toBe(3)
    // Standing ON a rung, the next one is the one after it — otherwise the card that just paid ONE
    // WEEK would tell the player they are 0 days from ONE WEEK.
    expect(nextStreakReward(3)?.day).toBe(7)
    expect(nextStreakReward(7)?.day).toBe(14)
  })

  it('counts down to it, always at least 1 day', () => {
    expect(daysToNextStreakReward(0)).toBe(3)
    expect(daysToNextStreakReward(6)).toBe(1) // tomorrow is ONE WEEK
    expect(daysToNextStreakReward(7)).toBe(7) // ONE WEEK → TWO WEEKS
    for (let day = 0; day < 100; day++) {
      const away = daysToNextStreakReward(day)
      if (away !== null) expect(away).toBeGreaterThanOrEqual(1)
    }
  })

  it('returns null once the ladder is topped out — the caller must have copy for that', () => {
    const top = STREAK_REWARDS[STREAK_REWARDS.length - 1].day
    expect(nextStreakReward(top)).toBeNull()
    expect(daysToNextStreakReward(top)).toBeNull()
    expect(nextStreakReward(top + 50)).toBeNull()
  })
})

describe('grantStreakReward — banks the rung onto the passed save', () => {
  it('banks chips and the boost, and reports the balance after', () => {
    const rung = streakRewardFor(7)!
    const s = save({ chips: 100, streak: 7, bestStreak: 7 })
    const g = grantStreakReward(s, 7)!
    expect(g.reward).toBe(rung)
    expect(g.chips).toBe(rung.chips)
    expect(s.chips).toBe(100 + rung.chips)
    expect(g.balance).toBe(s.chips)
    expect(s.pendingBoosts).toContain(rung.boost)
  })

  it('leaves the save completely untouched on an ordinary day', () => {
    const s = save({ chips: 100, freeSpins: 2 })
    const before = JSON.stringify(s)
    expect(grantStreakReward(s, 8)).toBeNull()
    expect(JSON.stringify(s)).toBe(before)
  })

  it('banks free spins and REPORTS WHAT STUCK — the bank cap can swallow some', () => {
    const rung = streakRewardFor(14)!
    expect(rung.freeSpins).toBeGreaterThan(0)
    // One seat left in the bank, the rung pays more than that.
    const s = save({ freeSpins: FREE_SPIN_BANK_CAP - 1 })
    const g = grantStreakReward(s, 14)!
    expect(g.freeSpins).toBe(1)
    expect(s.freeSpins).toBe(FREE_SPIN_BANK_CAP)
  })

  it('never overflows the bank cap, and forfeits silently when it is already full', () => {
    const s = save({ freeSpins: FREE_SPIN_BANK_CAP })
    const g = grantStreakReward(s, 30)!
    expect(g.freeSpins).toBe(0)
    expect(s.freeSpins).toBe(FREE_SPIN_BANK_CAP)
    // The chips and the boost still land — a full spin bank must not cost the rest of the rung.
    expect(s.chips).toBeGreaterThan(0)
    expect(s.pendingBoosts.length).toBeGreaterThan(0)
  })

  it('does NOT spend the daily free-spin earn allowance (a rung is not the farmable source)', () => {
    const s = save({ freeSpins: 0, freeSpinsEarnedToday: 0, freeSpinsDay: '2026-07-22' })
    grantStreakReward(s, 30)
    expect(s.freeSpinsEarnedToday).toBe(0)
  })

  it('reads `repeat` off bestStreak — false on the first climb, true on a rebuild', () => {
    expect(grantStreakReward(save({ bestStreak: 6 }), 7)!.repeat).toBe(false)
    expect(grantStreakReward(save({ bestStreak: 7 }), 7)!.repeat).toBe(true)
    expect(grantStreakReward(save({ bestStreak: 40 }), 7)!.repeat).toBe(true)
  })
})

describe('advanceDailyRitual — the ladder rides the streak advance', () => {
  it('pays the rung on the day the streak reaches it, on top of the check-in chips', () => {
    // Six days in, spun yesterday → today is day 7.
    const s = save({ lastSpinDate: YESTERDAY, streak: 6, chips: 0 })
    const r = advanceDailyRitual(s, NOW)
    expect(r.streak).toBe(7)
    expect(r.reward?.reward.day).toBe(7)
    // Both faucets paid, and the save holds exactly their sum.
    expect(s.chips).toBe(checkinChipsFor(7) + r.reward!.reward.chips)
  })

  it('pays nothing extra on an ordinary day', () => {
    const s = save({ lastSpinDate: YESTERDAY, streak: 7, chips: 0 })
    const r = advanceDailyRitual(s, NOW)
    expect(r.streak).toBe(8)
    expect(r.reward).toBeNull()
    expect(s.chips).toBe(checkinChipsFor(8))
  })

  it('a BROKEN streak restarts the ladder — day 3 pays again, flagged as a repeat', () => {
    // The repeatable-per-run design in one test. Missed days, so the streak resets to 1...
    const s = save({ lastSpinDate: THREE_DAYS_AGO, streak: 40, bestStreak: 40, chips: 0 })
    expect(advanceDailyRitual(s, NOW).streak).toBe(1)
    // ...and climbing back to day 3 pays THREE DAYS a second time.
    s.lastSpinDate = '2026-07-23'
    s.streak = 2
    const again = advanceDailyRitual(s, new Date(2026, 6, 24))
    expect(again.streak).toBe(3)
    expect(again.reward?.reward.day).toBe(3)
    expect(again.reward?.repeat).toBe(true)
  })

  it('bumps bestStreak AFTER the grant, so a first-ever rung is never reported as a repeat', () => {
    // ⚠️ The ordering guard. Bump first and `repeat` would read the streak that was just set.
    const s = save({ lastSpinDate: YESTERDAY, streak: 2, bestStreak: 2 })
    const r = advanceDailyRitual(s, NOW)
    expect(r.reward?.reward.day).toBe(3)
    expect(r.reward?.repeat).toBe(false)
    expect(s.bestStreak).toBe(3)
  })

  it('bestStreak only ever climbs — a broken streak does not erase the record', () => {
    const s = save({ lastSpinDate: THREE_DAYS_AGO, streak: 40, bestStreak: 40 })
    advanceDailyRitual(s, NOW)
    expect(s.streak).toBe(1)
    expect(s.bestStreak).toBe(40)
  })
})

describe('STREAK_REWARDS — economy guard (a CONTRACT, not recorded numbers)', () => {
  it('every rung pays strictly more chips than the one below it', () => {
    for (let i = 1; i < STREAK_REWARDS.length; i++) {
      expect(STREAK_REWARDS[i].chips).toBeGreaterThan(STREAK_REWARDS[i - 1].chips)
    }
  })

  it('no rung reaches the weekly champion purse — nothing repeatable may top the crown', () => {
    // The rule is written down in core/trophies.ts CHAPTER_PURSES: the 1,000-chip weekly crown is
    // the ceiling for anything that recurs. This ladder recurs per streak run, so it sits under it.
    for (const rung of STREAK_REWARDS) expect(rung.chips).toBeLessThan(1000)
  })

  it('stays a SIDE dish — a perfect 100-day run adds 25-45% on top of the check-in ladder', () => {
    const ladder = STREAK_REWARDS.filter(r => r.day <= 100).reduce((sum, r) => sum + r.chips, 0)
    const checkin = (CHECKIN_CHIPS.reduce((sum, n) => sum + n, 0) / 7) * 100
    const share = ladder / checkin
    // A band, not a number: retuning inside it is free, and walking out of either end is a real
    // change to what a chip is worth — which is the moment to re-derive the header's arithmetic.
    expect(share).toBeGreaterThan(0.25)
    expect(share).toBeLessThan(0.45)
  })

  it('a full run cannot mint more free spins than the bank can ever hold at once', () => {
    // Not an inflation bound but a HONESTY one: a rung that pays spins the bank must throw away
    // shows the player a number they did not receive. Rungs are spread over 100 days, so the real
    // guard is that no SINGLE rung exceeds the bank on its own.
    for (const rung of STREAK_REWARDS) expect(rung.freeSpins).toBeLessThanOrEqual(FREE_SPIN_BANK_CAP)
  })
})

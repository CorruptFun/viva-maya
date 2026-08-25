import { describe, expect, it } from 'vitest'
import { dropForDay as senderDropForDay } from '../../scripts/send-push.mjs'
import {
  BONUS_DROPS,
  bonusDropDue,
  dropBoostLabel,
  dropForDay,
  grantBonusDrop,
  todaysDrop,
} from './bonusdrop'
import { dayKey, seedForKey } from './endless'
import { BOOST_META } from './inventory'
import { mergeSaves } from './merge'
import { mulberry32 } from './rng'
import { FREE_SPIN_BANK_CAP, coerceSave, type SaveData } from './save'

/**
 * THE HOUSE GIFT — the once-a-day surprise that gives a player a reason to open the game, and the
 * only reward in it that is NAMED IN ADVANCE by a push notification.
 *
 * That last property is what most of this file is guarding. Everything else here is an ordinary
 * economy/latch test; the parity block is the load-bearing one.
 */

// Fixtures go through the REAL coercion path so they cannot drift from the on-disk shape (the same
// helper shape merge.test.ts and daily.test.ts use).
const save = (partial: Partial<SaveData> = {}): SaveData => coerceSave(partial)

describe('sender/app gift agreement', () => {
  /**
   * THE LOAD-BEARING TEST IN THIS FILE, and it is the `weekKey` pin one step worse.
   *
   * scripts/send-push.mjs cannot import from src/ — it runs in CI as plain Node with no TypeScript
   * step — so it carries its own copy of the gift table and the roll. A copy is a thing that drifts,
   * and the failure here is not a wrong-looking message, it is a LIE: the notification says "THE
   * VAULT is on the table today" and the player opens the app to twenty chips. That is worse than
   * sending no notification at all, and it would be invisible from either side alone — the sender's
   * log and the game's card would each look completely correct.
   *
   * A failure here means the two tables have diverged. Fix the copy, never the expectation.
   */
  it('rolls the same gift as the app on every day for three years', () => {
    const start = Date.UTC(2026, 0, 1)
    const mismatches: string[] = []
    for (let i = 0; i < 365 * 3; i++) {
      const day = new Date(start + i * 86400000).toISOString().slice(0, 10)
      const app = dropForDay(day)
      const sender = senderDropForDay(day)
      if (app.id !== sender.id) mismatches.push(`${day}: app=${app.id} sender=${sender.id}`)
    }
    expect(mismatches).toEqual([])
  })

  it('agrees on the strings the notification actually prints', () => {
    // The sender quotes the label, the emoji and the blurb verbatim. It deliberately carries no copy
    // of what a gift PAYS — see the note on its DROP_TABLE — so those columns are not compared here
    // because there is nothing on the other side to compare them to.
    for (const drop of BONUS_DROPS) {
      const day = firstDayPaying(drop.id)
      expect(day, `no day in three years pays ${drop.id}`).not.toBeNull()
      const sender = senderDropForDay(day as string)
      expect(sender.label).toBe(drop.label)
      expect(sender.emoji).toBe(drop.emoji)
      expect(sender.blurb).toBe(drop.blurb)
    }
  })
})

/** The first day in a three-year sweep that pays a given gift, or null. */
function firstDayPaying(id: string): string | null {
  const start = Date.UTC(2026, 0, 1)
  for (let i = 0; i < 365 * 3; i++) {
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10)
    if (dropForDay(day).id === id) return day
  }
  return null
}

describe('the roll', () => {
  it('is deterministic — the same day always pays the same gift', () => {
    for (const day of ['2026-08-24', '2026-12-31', '2027-02-28']) {
      expect(dropForDay(day).id).toBe(dropForDay(day).id)
      expect(dropForDay(day)).toBe(dropForDay(day)) // the same table row, not a copy of it
    }
  })

  it('is namespaced off the board seed, not drawn from it', () => {
    // `#gift` is what keeps the gift and the day's BOARD from being two readings of one 32-bit
    // value. Sharing a seed would correlate them forever — Vault day would always be the same
    // board — and would silently move the gift table the next time anything touched the board seed.
    //
    // The proof is that dropping the suffix changes the answer on a large share of days. If this
    // ever comes back near zero, the suffix has stopped doing anything and the two are coupled.
    const rollUnsuffixed = (day: string): string => {
      const rng = mulberry32(seedForKey(day))
      const total = BONUS_DROPS.reduce((sum, d) => sum + d.weight, 0)
      let roll = rng() * total
      for (const drop of BONUS_DROPS) {
        roll -= drop.weight
        if (roll < 0) return drop.id
      }
      return BONUS_DROPS[0].id
    }
    const start = Date.UTC(2026, 0, 1)
    let differ = 0
    for (let i = 0; i < 365; i++) {
      const day = new Date(start + i * 86400000).toISOString().slice(0, 10)
      if (dropForDay(day).id !== rollUnsuffixed(day)) differ++
    }
    // Two independent draws off this table disagree ~82% of the time (1 − Σp²). Anything above half
    // is comfortably "these are not the same sequence"; equality would land this at 0.
    expect(differ / 365).toBeGreaterThan(0.5)
  })

  it('reaches every row on the table', () => {
    // A row nothing can ever roll is a row that will be edited without anyone noticing. Three years
    // is ~1,095 days against a 1-in-100 rarest row, so this is not a close call.
    const seen = new Set<string>()
    const start = Date.UTC(2026, 0, 1)
    for (let i = 0; i < 365 * 3; i++) {
      seen.add(dropForDay(new Date(start + i * 86400000).toISOString().slice(0, 10)).id)
    }
    expect([...seen].sort()).toEqual(BONUS_DROPS.map(d => d.id).sort())
  })

  it('tracks the declared weights over a long sweep', () => {
    // Not a distribution test in the statistical sense — it is a guard against a weight being edited
    // in one place and not the other, or a row being reordered. The tolerance is wide enough that
    // ordinary PRNG lumpiness never trips it and a real retune always does.
    const DAYS = 365 * 30
    const counts = new Map<string, number>()
    const start = Date.UTC(2026, 0, 1)
    for (let i = 0; i < DAYS; i++) {
      const id = dropForDay(new Date(start + i * 86400000).toISOString().slice(0, 10)).id
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const total = BONUS_DROPS.reduce((sum, d) => sum + d.weight, 0)
    for (const drop of BONUS_DROPS) {
      const expected = (drop.weight / total) * DAYS
      const actual = counts.get(drop.id) ?? 0
      expect(Math.abs(actual - expected) / expected, `${drop.id} is off its weight`).toBeLessThan(0.25)
    }
  })

  it('todaysDrop is dropForDay on the RACE calendar', () => {
    const now = new Date('2026-08-24T22:00:00Z')
    expect(todaysDrop(now)).toBe(dropForDay(dayKey(now)))
  })
})

describe('the table', () => {
  it('never writes a boost name down — BOOST_META is the only place one is named', () => {
    // The scar this guards: three different things were once called "+5 MOVES", and a player
    // reasonably concluded he was being charged for his own winnings. A gift's `label` names the
    // GIFT; the boost inside it is resolved through BOOST_META at render time.
    const boostNames = Object.values(BOOST_META).map(m => m.label)
    for (const drop of BONUS_DROPS) {
      expect(boostNames, `${drop.id}'s label is a boost name`).not.toContain(drop.label)
    }
  })

  it('resolves a gift boost through BOOST_META, and only when there is one', () => {
    for (const drop of BONUS_DROPS) {
      expect(dropBoostLabel(drop)).toBe(drop.boost ? BOOST_META[drop.boost].label : null)
    }
  })

  it('has no dead row — every gift pays something', () => {
    for (const drop of BONUS_DROPS) {
      expect(drop.weight, `${drop.id} can never be rolled`).toBeGreaterThan(0)
      expect(drop.chips + drop.freeSpins + (drop.boost ? 1 : 0), `${drop.id} pays nothing`).toBeGreaterThan(0)
    }
  })

  it('stays a SIDE dish against the check-in ladder', () => {
    // THE BUDGET, and the reason this file pins it rather than trusting the header: chips are a
    // lifetime budget, so a faucet that quietly grows reprices every Gift Store sink without a
    // single price changing. The check-in ladder pays ~56 chips/day (core/daily.ts CHECKIN_CHIPS);
    // this must stay a supplement to that, not a second main. Re-derive these numbers if the table
    // is retuned — do NOT widen the bounds to make a richer table green.
    const total = BONUS_DROPS.reduce((sum, d) => sum + d.weight, 0)
    const ev = (pick: (d: (typeof BONUS_DROPS)[number]) => number): number =>
      BONUS_DROPS.reduce((sum, d) => sum + (d.weight / total) * pick(d), 0)

    const chips = ev(d => d.chips)
    expect(chips).toBeGreaterThan(15)
    expect(chips).toBeLessThan(30)

    // Weighted toward things that cannot be spent without PLAYING — a free spin sends you to the
    // cabinet, a boost is inert until a level starts. That is what keeps a "reason to open" from
    // becoming a "reason not to play".
    expect(ev(d => d.freeSpins)).toBeGreaterThan(0.25)
    expect(ev(d => (d.boost ? 1 : 0))).toBeGreaterThan(0.25)
  })
})

describe('the claim', () => {
  const NOW = new Date('2026-08-24T18:00:00Z')
  const TODAY = dayKey(NOW)

  it('pays the day’s gift and latches the day', () => {
    const s = save({ chips: 100 })
    const grant = grantBonusDrop(s, NOW)
    const drop = dropForDay(TODAY)
    expect(grant).not.toBeNull()
    expect(grant?.drop).toBe(drop)
    expect(grant?.day).toBe(TODAY)
    expect(s.bonusDropDay).toBe(TODAY)
    expect(s.chips).toBe(100 + drop.chips)
    expect(grant?.balance).toBe(s.chips)
    if (drop.boost) expect(s.pendingBoosts).toContain(drop.boost)
    expect(s.freeSpins).toBe(drop.freeSpins)
  })

  it('is inert the second time — the day latch IS the claim latch', () => {
    const s = save({ chips: 100 })
    grantBonusDrop(s, NOW)
    const before = JSON.stringify(s)
    expect(grantBonusDrop(s, NOW)).toBeNull()
    expect(JSON.stringify(s)).toBe(before)
  })

  it('comes back tomorrow', () => {
    const s = save()
    grantBonusDrop(s, NOW)
    expect(bonusDropDue(s, NOW)).toBe(false)
    const tomorrow = new Date(NOW.getTime() + 86400000)
    expect(bonusDropDue(s, tomorrow)).toBe(true)
    expect(grantBonusDrop(s, tomorrow)).not.toBeNull()
  })

  it('honours the free-spin BANK cap and reports what actually stuck', () => {
    // A gift that names spins the player did not receive is the ugliest possible way to pay one.
    const day = firstDayPaying('the_vault') as string
    const at = new Date(`${day}T18:00:00Z`)
    // dayKey is timezone-shifted, so seat the clock late enough in the day that both agree.
    const key = dayKey(at)
    const drop = dropForDay(key)
    const s = save({ freeSpins: FREE_SPIN_BANK_CAP })
    const grant = grantBonusDrop(s, at)
    expect(grant?.freeSpins).toBe(0)
    expect(s.freeSpins).toBe(FREE_SPIN_BANK_CAP)
    // …and the chips still land: a full bank forfeits the overflow, not the whole gift.
    expect(s.chips).toBe(drop.chips)
  })

  it('bypasses the daily EARN cap, like every non-farmable source', () => {
    // FREE_SPIN_DAILY_CAP exists to bound the one farmable source — a marathon session banking
    // cascade awards. A once-a-day gift is not that, and letting a day's cascades silently eat it
    // would be the same mistake `grantStreakReward` documents.
    const day = firstDayPaying('double_pull') as string
    const at = new Date(`${day}T18:00:00Z`)
    const s = save({ freeSpins: 0, freeSpinsDay: dayKey(at), freeSpinsEarnedToday: 6 })
    const grant = grantBonusDrop(s, at)
    expect(grant?.freeSpins).toBe(2)
    expect(s.freeSpins).toBe(2)
  })
})

describe('merge', () => {
  it('keeps the later claim, so a merge can never re-open a paid gift', () => {
    // MAX of the date string. The failure this prevents: take the gift on the phone, open a tablet
    // that happens to be further through the levels, and a progress-winner merge would hand back the
    // tablet's empty latch — and the gift with it.
    const phone = save({ unlocked: 5, bonusDropDay: '2026-08-24' })
    const tablet = save({ unlocked: 40, bonusDropDay: null })
    expect(mergeSaves(phone, tablet).bonusDropDay).toBe('2026-08-24')
    expect(mergeSaves(tablet, phone).bonusDropDay).toBe('2026-08-24')
  })

  it('takes the later of two real claims', () => {
    const a = save({ bonusDropDay: '2026-08-20' })
    const b = save({ bonusDropDay: '2026-08-24' })
    expect(mergeSaves(a, b).bonusDropDay).toBe('2026-08-24')
    expect(mergeSaves(b, a).bonusDropDay).toBe('2026-08-24')
  })

  it('survives a save that never claimed on either side', () => {
    expect(mergeSaves(save(), save()).bonusDropDay).toBeNull()
  })
})

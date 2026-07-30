import { describe, expect, it } from 'vitest'
import {
  DAYS_PER_WEEK,
  ENDLESS_UNLOCK_LEVEL,
  dayEndsAt,
  dayKey,
  endlessBestForDay,
  endlessRngForDay,
  endlessUnlocked,
  endlessWeekStanding,
  formatRaceRemaining,
  formatWeekStanding,
  previousDayKey,
  previousWeekKey,
  seedForKey,
  weekEndsAt,
  weekKey,
  weekKeyOfDay,
} from './endless'
import { coerceSave } from './save'

/**
 * The race only works if every player agrees on which BOARD it is. The keys drive THREE things at
 * once — the board seed (the actual layout you play), the leaderboard partition your score is
 * written to, and the partition read back to build the standings — so if two players disagree about
 * the day they are not racing at all: different boards, and each sees a leaderboard containing only
 * themselves, with nothing on screen to explain why.
 *
 * That is exactly what happened on 2026-07-26, when the (then weekly) key was derived from the
 * DEVICE'S LOCAL calendar date: a player whose local date had already reached Monday sat on 2026-W31
 * while everyone still on Sunday sat on 2026-W30. These tests pin the fix for both cadences — one
 * instant, one board, worldwide — and they are written against fixed UTC instants precisely so they
 * would FAIL on a device-local implementation when the runner's timezone disagrees.
 *
 * The anchor is the FIXED home zone RACE_TZ (America/Edmonton) rather than UTC since 2026-07-30:
 * boards used to flip at 00:00 UTC, which is 6 PM on the home crowd's clock, so a player checking
 * "the board resets at midnight" at 11 PM found NINETEEN HOURS on the countdown. The boundary
 * instants pinned here are therefore 06:00 UTC in summer (MDT) and 07:00 UTC in winter (MST) —
 * midnight in Alberta, both times.
 *
 * The stakes went UP when the race went daily: a day boundary is seven times as frequent as a week
 * boundary, so a timezone-sensitive key would now split the player base every single night.
 */

/** Build an instant from a UTC ISO string — no local-time ambiguity anywhere in this file. */
const at = (iso: string): Date => new Date(iso)

describe('dayKey — one instant, one board, for everyone', () => {
  it('holds the day right up to the last second before midnight in Alberta', () => {
    expect(dayKey(at('2026-07-29T06:00:00Z'))).toBe('2026-07-29') // midnight MDT — the moment it opens
    expect(dayKey(at('2026-07-29T18:00:00Z'))).toBe('2026-07-29') // midday at home
    expect(dayKey(at('2026-07-30T05:59:59Z'))).toBe('2026-07-29') // 23:59:59 MDT
  })

  it('rolls over exactly at midnight America/Edmonton — 06:00 UTC in summer', () => {
    expect(dayKey(at('2026-07-30T06:00:00Z'))).toBe('2026-07-30')
    expect(dayKey(at('2026-07-30T06:00:01Z'))).toBe('2026-07-30')
  })

  it('rolls over at 07:00 UTC in winter — the SAME midnight, now on MST', () => {
    expect(dayKey(at('2026-01-15T06:59:59Z'))).toBe('2026-01-14') // 23:59:59 MST
    expect(dayKey(at('2026-01-15T07:00:00Z'))).toBe('2026-01-15') // midnight MST
  })

  it('gives two players the SAME board for the same instant, whatever their offset', () => {
    // 18:44 in Chicago is 08:44 the next morning in Tokyo. One instant — one board.
    const instant = at('2026-07-29T23:44:00Z')
    const chicago = new Date(instant.getTime()) // rendered locally as Wed 18:44 CDT
    const tokyo = new Date(instant.getTime()) // rendered locally as Thu 08:44 JST
    expect(dayKey(chicago)).toBe(dayKey(tokyo))
    expect(dayKey(chicago)).toBe('2026-07-29')
  })

  it('zero-pads month and day, and crosses month/year seams cleanly', () => {
    expect(dayKey(at('2026-01-01T12:00:00Z'))).toBe('2026-01-01')
    expect(dayKey(at('2026-03-01T06:59:59Z'))).toBe('2026-02-28') // non-leap February's last second, MST
    expect(dayKey(at('2026-03-01T07:00:00Z'))).toBe('2026-03-01')
    expect(dayKey(at('2026-01-01T06:59:59Z'))).toBe('2025-12-31') // the year turns at MOUNTAIN midnight
  })

  it('bends with the clocks at the DST seams without skipping or repeating a board', () => {
    // 2026 in Alberta: spring forward Sun Mar 8 (02:00 MST → 03:00 MDT), fall back Sun Nov 1.
    // The switch happens at 2 AM, never at midnight, so every day still opens exactly once.
    expect(dayKey(at('2026-03-08T06:59:59Z'))).toBe('2026-03-07') // 23:59:59 MST
    expect(dayKey(at('2026-03-08T07:00:00Z'))).toBe('2026-03-08') // midnight MST — a 23-hour board opens
    expect(dayKey(at('2026-03-09T05:59:59Z'))).toBe('2026-03-08') // 23:59:59 MDT, 23h later
    expect(dayKey(at('2026-03-09T06:00:00Z'))).toBe('2026-03-09') // midnight MDT

    expect(dayKey(at('2026-11-01T05:59:59Z'))).toBe('2026-10-31') // 23:59:59 MDT
    expect(dayKey(at('2026-11-01T06:00:00Z'))).toBe('2026-11-01') // midnight MDT — a 25-hour board opens
    expect(dayKey(at('2026-11-02T06:59:59Z'))).toBe('2026-11-01') // 23:59:59 MST, 25h later
    expect(dayKey(at('2026-11-02T07:00:00Z'))).toBe('2026-11-02') // midnight MST
  })

  it('never emits a malformed key — the leaderboard column has a CHECK constraint on the shape', () => {
    const bad: string[] = []
    for (let i = 0; i < 730; i++) {
      const k = dayKey(new Date(Date.UTC(2025, 0, 1) + i * 86400000))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) bad.push(`day ${i} → ${k}`)
    }
    expect(bad).toEqual([])
  })

  it('advances by exactly one board a day, with no repeats or gaps', () => {
    const keys = Array.from({ length: 400 }, (_, i) => dayKey(new Date(Date.UTC(2026, 0, 1) + i * 86400000)))
    expect(new Set(keys).size, 'a day key repeated across 400 consecutive days').toBe(keys.length)
  })
})

describe('dayEndsAt / previousDayKey', () => {
  it('points at the next midnight in Alberta — the instant the board hands over', () => {
    expect(dayEndsAt(at('2026-07-29T18:44:00Z')).toISOString()).toBe('2026-07-30T06:00:00.000Z')
    expect(dayEndsAt(at('2026-07-29T06:00:00Z')).toISOString()).toBe('2026-07-30T06:00:00.000Z')
  })

  it('shows an 11 PM player ONE hour to the reset, not nineteen — the 2026-07-30 owner report', () => {
    // Under the old UTC anchor the board had already flipped at 6 PM Mountain, so a player checking
    // "it resets at midnight" just before their midnight found a countdown reading 19 hours.
    const elevenPmInAlberta = at('2026-07-31T05:00:00Z') // 23:00 MDT on 2026-07-30
    const left = dayEndsAt(elevenPmInAlberta).getTime() - elevenPmInAlberta.getTime()
    expect(formatRaceRemaining(left)).toBe('1h 0m')
    expect(dayKey(elevenPmInAlberta)).toBe('2026-07-30') // still the 30th's board at 11 PM the 30th
  })

  it('is the exact moment the key flips — one second either side straddles the rollover', () => {
    const ends = dayEndsAt(at('2026-07-29T15:00:00Z'))
    expect(dayKey(new Date(ends.getTime() - 1000))).toBe('2026-07-29')
    expect(dayKey(ends)).toBe('2026-07-30')
  })

  it('crosses the DST seams to the TRUE next midnight — 23h and 25h boards, never 24 by rote', () => {
    expect(dayEndsAt(at('2026-03-08T07:00:00Z')).toISOString()).toBe('2026-03-09T06:00:00.000Z') // 23h day
    expect(dayEndsAt(at('2026-11-01T06:00:00Z')).toISOString()).toBe('2026-11-02T07:00:00.000Z') // 25h day
  })

  it('names the board that just closed — the one whose winner is crowned', () => {
    expect(previousDayKey(at('2026-07-30T06:00:00Z'))).toBe('2026-07-29') // the moment after handover
    expect(previousDayKey(at('2026-07-30T05:59:59Z'))).toBe('2026-07-28') // still racing the 29th's
    // Month seams are where a naive "subtract 1 from the date field" would break.
    expect(previousDayKey(at('2026-03-01T12:00:00Z'))).toBe('2026-02-28')
    expect(previousDayKey(at('2026-01-01T12:00:00Z'))).toBe('2025-12-31')
  })

  it('survives the 25th hour of fall-back Sunday — where "now minus 24h" names the day ITSELF', () => {
    // 23:30 MST on 2026-11-01: more than 24h after that day's own midnight, so the subtraction
    // trick lands inside the same local day and would crown the wrong board.
    expect(previousDayKey(at('2026-11-02T06:30:00Z'))).toBe('2026-10-31')
  })
})

describe('weekKey — the season the daily boards roll up into', () => {
  it('holds W30 right up to the last second of Sunday in Alberta', () => {
    expect(weekKey(at('2026-07-20T06:00:00Z'))).toBe('2026-W30') // Monday midnight MDT — it opens
    expect(weekKey(at('2026-07-27T05:59:59Z'))).toBe('2026-W30') // Sunday 23:59:59 MDT
  })

  it('rolls to W31 exactly at Monday midnight America/Edmonton — 06:00 UTC in summer', () => {
    expect(weekKey(at('2026-07-27T06:00:00Z'))).toBe('2026-W31')
  })

  it('numbers the ISO year boundary correctly (2026 opens on a Thursday)', () => {
    // ISO week 1 is the week containing the first Thursday, so 2026-W01 starts Mon 2025-12-29.
    expect(weekKey(at('2025-12-29T12:00:00Z'))).toBe('2026-W01')
    expect(weekKey(at('2026-01-05T06:59:59Z'))).toBe('2026-W01') // Sunday 23:59:59 MST
    expect(weekKey(at('2026-01-05T07:00:00Z'))).toBe('2026-W02') // Monday midnight MST
  })

  it('never emits a malformed key — the leaderboard column has a CHECK constraint on the shape', () => {
    const bad: string[] = []
    for (let i = 0; i < 730; i++) {
      const k = weekKey(new Date(Date.UTC(2025, 0, 1) + i * 86400000))
      if (!/^\d{4}-W\d{2}$/.test(k)) bad.push(`day ${i} → ${k}`)
    }
    expect(bad).toEqual([])
  })
})

describe('weekEndsAt / previousWeekKey', () => {
  it('points at the next Monday midnight in Alberta — the instant the season resets', () => {
    expect(weekEndsAt(at('2026-07-26T18:44:00Z')).toISOString()).toBe('2026-07-27T06:00:00.000Z')
    expect(weekEndsAt(at('2026-07-20T06:00:00Z')).toISOString()).toBe('2026-07-27T06:00:00.000Z')
  })

  it('closes the season at the same instant Sunday\'s board closes — one handover, not two', () => {
    const sundayNight = at('2026-08-02T20:00:00Z')
    expect(weekEndsAt(sundayNight).getTime()).toBe(dayEndsAt(sundayNight).getTime())
  })

  it('names the season that just closed', () => {
    expect(previousWeekKey(at('2026-07-27T06:00:00Z'))).toBe('2026-W30')
    expect(previousWeekKey(at('2026-07-27T05:59:59Z'))).toBe('2026-W29')
  })
})

/**
 * The daily→weekly rollup. This is the single client-side definition of which seven boards make up a
 * season, and its server twin is `public.iso_week_of_day()` in migration 0012 (which self-checks
 * against this same table of days before it will apply). A drift here is the quiet kind: the daily
 * boards keep working perfectly while the weekly standings rank the wrong days.
 */
describe('weekKeyOfDay — which season a board belongs to', () => {
  it('maps every day of a week onto that week, Monday through Sunday', () => {
    const days = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']
    expect(days.map(weekKeyOfDay)).toEqual(new Array(DAYS_PER_WEEK).fill('2026-W31'))
  })

  it('starts a new season on Monday, not on Sunday', () => {
    expect(weekKeyOfDay('2026-08-02')).toBe('2026-W31') // Sunday — still last week
    expect(weekKeyOfDay('2026-08-03')).toBe('2026-W32') // Monday
  })

  it('agrees with weekKey on the same instant, so the two can never rank different days', () => {
    for (let i = 0; i < 400; i++) {
      const instant = new Date(Date.UTC(2025, 11, 1) + i * 86400000)
      expect(weekKeyOfDay(dayKey(instant)), dayKey(instant)).toBe(weekKey(instant))
    }
  })

  it('returns null for a malformed key rather than a NaN week', () => {
    // `endlessDays` is restored shape-tolerantly from storage, so anything can be in there — and a
    // NaN week would silently drop or duplicate days inside a total nobody could audit.
    expect(weekKeyOfDay('')).toBeNull()
    expect(weekKeyOfDay('2026-W31')).toBeNull()
    expect(weekKeyOfDay('not-a-date')).toBeNull()
    expect(weekKeyOfDay('2026-13-45')).toBeNull()
  })
})

describe('formatRaceRemaining', () => {
  it('reads coarsely at both scales — a day board and a week season', () => {
    expect(formatRaceRemaining(2 * 86400000 + 5 * 3600000)).toBe('2d 5h')
    expect(formatRaceRemaining(5 * 3600000 + 12 * 60000)).toBe('5h 12m')
    expect(formatRaceRemaining(42 * 60000)).toBe('42m')
  })

  it('never shows a negative or a bare zero on a board that just closed', () => {
    expect(formatRaceRemaining(0)).toBe('under a minute')
    expect(formatRaceRemaining(-90_000)).toBe('under a minute')
  })

  it('agrees with the actual rollover instants', () => {
    const now = at('2026-07-29T18:44:00Z') // Wednesday 12:44 in Alberta
    expect(formatRaceRemaining(dayEndsAt(now).getTime() - now.getTime())).toBe('11h 16m')
    // Wednesday lunchtime → the season closes Monday midnight Mountain, four boards later.
    expect(formatRaceRemaining(weekEndsAt(now).getTime() - now.getTime())).toBe('4d 11h')
  })
})

describe('the board everyone plays', () => {
  it('derives one seed per day key, so the same day is the same layout', () => {
    expect(seedForKey('2026-07-29')).toBe(seedForKey('2026-07-29'))
    expect(seedForKey('2026-07-29')).not.toBe(seedForKey('2026-07-30'))
  })

  it('gives two players on the same day an identical board sequence', () => {
    const a = endlessRngForDay('2026-07-29')
    const b = endlessRngForDay('2026-07-29')
    const rollsA = Array.from({ length: 50 }, () => a())
    const rollsB = Array.from({ length: 50 }, () => b())
    expect(rollsA).toEqual(rollsB)
  })

  it('gives consecutive days genuinely different boards — the whole point of going daily', () => {
    // Adjacent keys differ by one character, so a weak hash could hand out near-identical streams and
    // "a new board every day" would quietly be a lie.
    const week = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']
    const openings = week.map(d => {
      const rng = endlessRngForDay(d)
      return Array.from({ length: 20 }, () => rng()).join(',')
    })
    expect(new Set(openings).size).toBe(DAYS_PER_WEEK)
  })
})

/**
 * The WEEKLY STANDING — the sum that makes turning up the strategy. This is the number the season
 * board ranks on, so what it counts (and what it refuses to count) is the whole competitive contract.
 */
describe('endlessWeekStanding — daily bests, added up', () => {
  const withDays = (days: Record<string, number>) => coerceSave({ endlessDays: days })

  it('adds every board raced inside the week and counts the turnout', () => {
    const save = withDays({ '2026-07-27': 5000, '2026-07-29': 3200, '2026-08-02': 1800 })
    expect(endlessWeekStanding(save, '2026-W31')).toEqual({ total: 10000, days: 3 })
  })

  it('ignores days from other weeks — a season is seven boards, not a running lifetime total', () => {
    const save = withDays({ '2026-07-26': 99999, '2026-07-27': 5000, '2026-08-03': 99999 })
    expect(endlessWeekStanding(save, '2026-W31')).toEqual({ total: 5000, days: 1 })
  })

  it('is zero for a week with nothing in it', () => {
    expect(endlessWeekStanding(withDays({}), '2026-W31')).toEqual({ total: 0, days: 0 })
    expect(endlessWeekStanding(withDays({ '2026-07-20': 4000 }), '2026-W31')).toEqual({ total: 0, days: 0 })
  })

  it('survives a corrupt map without emitting NaN', () => {
    // A NaN total would sort unpredictably against every other player on a PUBLIC board.
    const dirty = {
      '2026-07-27': 5000,
      '2026-07-28': NaN,
      '2026-07-29': 'lots',
      '2026-07-30': null,
      '2026-07-31': -400,
      'not-a-day': 9999,
    } as unknown as Record<string, number>
    const s = endlessWeekStanding({ endlessDays: dirty } as never, '2026-W31')
    expect(Number.isFinite(s.total)).toBe(true)
    expect(s).toEqual({ total: 5000, days: 1 })
  })

  it('tolerates a missing map entirely', () => {
    expect(endlessWeekStanding({} as never, '2026-W31')).toEqual({ total: 0, days: 0 })
  })

  it('caps turnout at the number of boards a week actually has', () => {
    const every: Record<string, number> = {}
    const w31 = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']
    for (const day of w31) every[day] = 1000
    expect(endlessWeekStanding(withDays(every), '2026-W31')).toEqual({ total: 7000, days: DAYS_PER_WEEK })
  })
})

describe('endlessBestForDay', () => {
  it('reads a day it has, and zero for one it does not', () => {
    const save = coerceSave({ endlessDays: { '2026-07-29': 4200 } })
    expect(endlessBestForDay(save, '2026-07-29')).toBe(4200)
    expect(endlessBestForDay(save, '2026-07-30')).toBe(0)
  })

  it('never returns junk from a corrupt entry', () => {
    const save = { endlessDays: { a: NaN, b: -5, c: 'x' } } as unknown as Parameters<typeof endlessBestForDay>[0]
    expect(endlessBestForDay(save, 'a')).toBe(0)
    expect(endlessBestForDay(save, 'b')).toBe(0)
    expect(endlessBestForDay(save, 'c')).toBe(0)
  })
})

describe('formatWeekStanding', () => {
  it('shows the total first, then the turnout that explains it', () => {
    expect(formatWeekStanding({ total: 18204, days: 5 })).toBe('18,204 · 5d')
    expect(formatWeekStanding({ total: 0, days: 0 })).toBe('0 · 0d')
  })
})

/**
 * `save.unlocked` is "the level you may now play", so it reads n+1 once level n is cleared. The gate
 * is therefore `>` and not `>=`: the race opens when ENDLESS_UNLOCK_LEVEL has been BEATEN, not when
 * it is merely reachable. Pinned because both the retune (30 → 20) and the boundary are easy to get
 * off by one, and a wrong boundary silently locks the leaderboard away from players who earned it.
 */
describe('endlessUnlocked — who gets onto the leaderboard', () => {
  it('opens the moment ENDLESS_UNLOCK_LEVEL is cleared, not before', () => {
    expect(endlessUnlocked(coerceSave({ unlocked: ENDLESS_UNLOCK_LEVEL }))).toBe(false) // on it, not past it
    expect(endlessUnlocked(coerceSave({ unlocked: ENDLESS_UNLOCK_LEVEL + 1 }))).toBe(true) // cleared it
  })

  it('keeps a brand-new save locked and a far-progressed one open', () => {
    expect(endlessUnlocked(coerceSave({}))).toBe(false)
    expect(endlessUnlocked(coerceSave({ unlocked: 300 }))).toBe(true)
  })

  it('is set to level 20 — the tuned milestone', () => {
    expect(ENDLESS_UNLOCK_LEVEL).toBe(20)
  })
})

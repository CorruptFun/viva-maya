import { describe, expect, it } from 'vitest'
import { previousWeekKey } from './leaderboard'
import {
  ENDLESS_UNLOCK_LEVEL,
  endlessRngForWeek,
  endlessUnlocked,
  formatWeekRemaining,
  seedForWeek,
  weekEndsAt,
  weekKey,
} from './endless'
import { coerceSave } from './save'

/**
 * The weekly race only works if every player agrees on which week it is. The key drives THREE things
 * at once — the board seed (the actual layout you play), the leaderboard partition your score is
 * written to, and the partition read back to build the standings — so if two players disagree about
 * the week they are not racing at all: different boards, and each sees a leaderboard containing only
 * themselves, with nothing on screen to explain why.
 *
 * That is exactly what happened on 2026-07-26: the key was derived from the DEVICE'S LOCAL calendar
 * date, so a player whose local date had already reached Monday sat on 2026-W31 while everyone still
 * on Sunday sat on 2026-W30. These tests pin the fix — one instant, one week, worldwide — and they
 * are written against fixed UTC instants precisely so they would FAIL on the old local-time
 * implementation when the runner's timezone disagrees with UTC.
 */

/** Build an instant from a UTC ISO string — no local-time ambiguity anywhere in this file. */
const at = (iso: string): Date => new Date(iso)

describe('weekKey — one instant, one week, for everyone', () => {
  it('holds W30 right up to the last second of Sunday UTC', () => {
    expect(weekKey(at('2026-07-20T00:00:00Z'))).toBe('2026-W30') // Monday, the moment it opens
    expect(weekKey(at('2026-07-26T12:00:00Z'))).toBe('2026-W30')
    expect(weekKey(at('2026-07-26T23:59:59Z'))).toBe('2026-W30')
  })

  it('rolls to W31 exactly at Monday 00:00 UTC', () => {
    expect(weekKey(at('2026-07-27T00:00:00Z'))).toBe('2026-W31')
    expect(weekKey(at('2026-07-27T00:00:01Z'))).toBe('2026-W31')
  })

  it('gives two players the SAME week for the same instant, whatever their offset', () => {
    // The reported bug: 18:44 Sunday in Chicago is 09:44 Monday in Tokyo. One instant — one race.
    const instant = at('2026-07-26T23:44:00Z')
    const chicago = new Date(instant.getTime()) // rendered locally as Sun 18:44 CDT
    const tokyo = new Date(instant.getTime()) // rendered locally as Mon 08:44 JST
    expect(weekKey(chicago)).toBe(weekKey(tokyo))
    expect(weekKey(chicago)).toBe('2026-W30')
  })

  it('numbers the ISO year boundary correctly (2026 opens on a Thursday)', () => {
    // ISO week 1 is the week containing the first Thursday, so 2026-W01 starts Mon 2025-12-29.
    expect(weekKey(at('2025-12-29T00:00:00Z'))).toBe('2026-W01')
    expect(weekKey(at('2026-01-01T00:00:00Z'))).toBe('2026-W01')
    expect(weekKey(at('2026-01-04T23:59:59Z'))).toBe('2026-W01')
    expect(weekKey(at('2026-01-05T00:00:00Z'))).toBe('2026-W02')
  })

  it('never emits a malformed key — the leaderboard column has a CHECK constraint on the shape', () => {
    const bad: string[] = []
    // Every day across two years, plus both year seams.
    for (let i = 0; i < 730; i++) {
      const k = weekKey(new Date(Date.UTC(2025, 0, 1) + i * 86400000))
      if (!/^\d{4}-W\d{2}$/.test(k)) bad.push(`day ${i} → ${k}`)
    }
    expect(bad).toEqual([])
  })

  it('advances by exactly one week each week, with no repeats or gaps', () => {
    // Step a whole year in 7-day hops from a known Monday; every hop must be a new, distinct key.
    const keys = Array.from({ length: 52 }, (_, i) => weekKey(new Date(Date.UTC(2026, 0, 5) + i * 7 * 86400000)))
    expect(keys[0]).toBe('2026-W02')
    expect(new Set(keys).size, 'a week key repeated across 52 consecutive weeks').toBe(keys.length)
  })
})

describe('weekEndsAt', () => {
  it('points at the next Monday 00:00 UTC — the instant the board resets', () => {
    expect(weekEndsAt(at('2026-07-26T18:44:00Z')).toISOString()).toBe('2026-07-27T00:00:00.000Z')
    expect(weekEndsAt(at('2026-07-20T00:00:00Z')).toISOString()).toBe('2026-07-27T00:00:00.000Z')
  })

  it('is the exact moment the key flips — one second either side straddles the rollover', () => {
    const ends = weekEndsAt(at('2026-07-22T09:00:00Z'))
    expect(weekKey(new Date(ends.getTime() - 1000))).toBe('2026-W30')
    expect(weekKey(ends)).toBe('2026-W31')
  })
})

describe('formatWeekRemaining', () => {
  it('reads coarsely at week scale, not as a life timer', () => {
    expect(formatWeekRemaining(2 * 86400000 + 5 * 3600000)).toBe('2d 5h')
    expect(formatWeekRemaining(5 * 3600000 + 12 * 60000)).toBe('5h 12m')
    expect(formatWeekRemaining(42 * 60000)).toBe('42m')
  })

  it('never shows a negative or a bare zero on a week that just closed', () => {
    expect(formatWeekRemaining(0)).toBe('under a minute')
    expect(formatWeekRemaining(-90_000)).toBe('under a minute')
  })

  it('agrees with the actual rollover instant', () => {
    const now = at('2026-07-26T18:44:00Z')
    expect(formatWeekRemaining(weekEndsAt(now).getTime() - now.getTime())).toBe('5h 16m')
  })
})

describe('previousWeekKey — who the champion crown belongs to', () => {
  it('names the week that just closed', () => {
    expect(previousWeekKey(at('2026-07-27T00:00:00Z'))).toBe('2026-W30')
    expect(previousWeekKey(at('2026-07-26T23:59:59Z'))).toBe('2026-W29')
  })
})

describe('the board everyone plays', () => {
  it('derives one seed per week key, so the same week is the same layout', () => {
    expect(seedForWeek('2026-W30')).toBe(seedForWeek('2026-W30'))
    expect(seedForWeek('2026-W30')).not.toBe(seedForWeek('2026-W31'))
  })

  it('gives two players on the same week an identical board sequence', () => {
    const a = endlessRngForWeek('2026-W30')
    const b = endlessRngForWeek('2026-W30')
    const rollsA = Array.from({ length: 50 }, () => a())
    const rollsB = Array.from({ length: 50 }, () => b())
    expect(rollsA).toEqual(rollsB)
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

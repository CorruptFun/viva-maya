import { describe, expect, it } from 'vitest'
import { backoffAllows, sentToday, streakAtRisk } from '../../scripts/send-push.mjs'
import { dayKey } from './endless'

/**
 * THE NOTIFICATION CADENCE — the three rules that make it honest for this game to send more than one
 * kind of notification.
 *
 * The game now has three scheduled sends (scripts/send-push.mjs: the morning play nudge, the evening
 * race reminder, the Sunday season summary) against an audience that opted in on a card promising
 * one nudge. That promise is kept by VOLUME, not by count of features — at most one notification per
 * device per race day, ever — and it is kept by these predicates plus a disjoint audience split.
 *
 * ⚠️ WHY THIS IS TESTED AT ALL, given it lives in a .mjs the game never imports: a bug here is
 * unobservable from inside the game and expensive outside it. Nobody files a report saying "I got
 * two notifications"; they switch notifications off, permanently, and the only trace is a
 * subscription count that stops going up. There is no way to walk that back, so the rules that
 * prevent it get tests rather than trust.
 *
 * The sender cannot be imported from TypeScript any other way — it runs in CI as bare Node, so
 * scripts/send-push.d.mts declares the helpers and this file pins their behaviour, exactly as
 * analytics.test.ts pins dayKey/weekKey and bonusdrop.test.ts pins the gift roll.
 */

const TODAY = '2026-08-24'
/** An instant safely inside TODAY on the race clock, so `dayKey` and the literal above agree. */
const NOW = new Date('2026-08-24T18:00:00Z')

describe('one notification per device per race day', () => {
  it('lets through a device never sent to', () => {
    expect(sentToday({}, TODAY)).toBe(false)
    expect(sentToday({ last_sent_at: null }, TODAY)).toBe(false)
  })

  it('blocks a device already sent to today', () => {
    expect(sentToday({ last_sent_at: NOW.toISOString() }, dayKey(NOW))).toBe(true)
  })

  it('blocks the EVENING slot after the MORNING one, nine hours earlier the same day', () => {
    // The seam the audience split cannot cover on its own: the Sunday season blast and the Sunday
    // morning nudge share a race day, and a manually dispatched run can land beside a scheduled one.
    // Both slots are on the same board, so "one a day" has to mean one per BOARD — an elapsed-hours
    // rule would wave this through.
    const morning = new Date('2026-08-24T15:00:00Z') // ≈9am at home
    const evening = new Date('2026-08-25T01:00:00Z') // ≈7pm the SAME home day
    expect(dayKey(morning)).toBe(dayKey(evening))
    expect(sentToday({ last_sent_at: morning.toISOString() }, dayKey(evening))).toBe(true)
  })

  it('lets the next day through', () => {
    const yesterday = new Date(NOW.getTime() - 86400000)
    expect(sentToday({ last_sent_at: yesterday.toISOString() }, dayKey(NOW))).toBe(false)
  })

  it('treats an unparseable timestamp as never sent', () => {
    // Fails toward sending, which is the right direction for a corrupt bookkeeping column: the
    // other guards still bound the volume, and refusing to send on junk data would silently retire
    // a live subscriber.
    expect(sentToday({ last_sent_at: 'not a date' }, TODAY)).toBe(false)
  })
})

describe('the lapse backoff', () => {
  const sentDaysAgo = (n: number): { last_sent_at: string } => ({
    last_sent_at: new Date(NOW.getTime() - n * 86400000).toISOString(),
  })

  it('never slows down a player who is still around', () => {
    for (const away of [0, 1, 2]) {
      expect(backoffAllows(sentDaysAgo(1), away, NOW), `away ${away}`).toBe(true)
    }
  })

  it('drops to every third day once someone has been gone a few days', () => {
    expect(backoffAllows(sentDaysAgo(1), 5, NOW)).toBe(false)
    expect(backoffAllows(sentDaysAgo(2), 5, NOW)).toBe(false)
    expect(backoffAllows(sentDaysAgo(3), 5, NOW)).toBe(true)
  })

  it('drops to weekly after a fortnight', () => {
    expect(backoffAllows(sentDaysAgo(3), 20, NOW)).toBe(false)
    expect(backoffAllows(sentDaysAgo(7), 20, NOW)).toBe(true)
  })

  it('stops entirely past a month', () => {
    // Somebody who has ignored a month of nudges is not coming back for the next one, and every
    // extra send is a chance to be switched off for good.
    expect(backoffAllows({ last_sent_at: null }, 30, NOW)).toBe(false)
    expect(backoffAllows(sentDaysAgo(90), 400, NOW)).toBe(false)
  })

  it('always lets a never-nudged subscriber through', () => {
    expect(backoffAllows({ last_sent_at: null }, 0, NOW)).toBe(true)
    expect(backoffAllows({ last_sent_at: null }, 10, NOW)).toBe(true)
    expect(backoffAllows({}, null, NOW)).toBe(true)
  })

  it('gives an UNKNOWN device the conservative cadence, never the silent treatment', () => {
    // `null` days away means the device emits no events at all — which is exactly what a player who
    // turned off anonymous gameplay events looks like (public/privacy.html promises that switch).
    // Reading that as "gone forever" would silence the one group whose only mistake was using a
    // privacy control, so they get every-third-day indefinitely and never expire.
    expect(backoffAllows(sentDaysAgo(1), null, NOW)).toBe(false)
    expect(backoffAllows(sentDaysAgo(3), null, NOW)).toBe(true)
    expect(backoffAllows(sentDaysAgo(400), null, NOW)).toBe(true)
  })
})

describe('the streak-in-danger hook', () => {
  it('fires on a live, unsecured streak', () => {
    expect(streakAtRisk({ streak: 12, lastSpinDate: '2026-08-23' }, TODAY)).toBe(12)
  })

  it('stays quiet once today’s spin is taken', () => {
    expect(streakAtRisk({ streak: 12, lastSpinDate: TODAY }, TODAY)).toBeNull()
  })

  it('stays quiet on a streak that is already broken', () => {
    // The worst line the sender could produce is telling somebody a streak they lost on Tuesday is
    // about to end. Two days back is not "at risk", it is gone.
    expect(streakAtRisk({ streak: 12, lastSpinDate: '2026-08-22' }, TODAY)).toBeNull()
    expect(streakAtRisk({ streak: 30, lastSpinDate: '2026-07-01' }, TODAY)).toBeNull()
  })

  it('ignores a one-day streak', () => {
    // A single day is a day, not a run worth defending — and "your 1-day streak ends at midnight" is
    // a sentence that makes the whole feature look silly.
    expect(streakAtRisk({ streak: 1, lastSpinDate: '2026-08-23' }, TODAY)).toBeNull()
  })

  it('stays quiet when the player’s local date has run ahead of the race day', () => {
    // `lastSpinDate` is the player's DEVICE-LOCAL day; `today` is the race day. Far enough east they
    // disagree by one, and the test is `=== 1` precisely so that case yields silence rather than a
    // false alarm about a streak that is perfectly safe.
    expect(streakAtRisk({ streak: 12, lastSpinDate: '2026-08-25' }, TODAY)).toBeNull()
  })

  it('survives a missing or shapeless save', () => {
    expect(streakAtRisk(null, TODAY)).toBeNull()
    expect(streakAtRisk(undefined, TODAY)).toBeNull()
    expect(streakAtRisk({ streak: 12, lastSpinDate: null }, TODAY)).toBeNull()
  })
})

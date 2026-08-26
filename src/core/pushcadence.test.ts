import { describe, expect, it } from 'vitest'
import type { PushMode } from '../../scripts/send-push.mjs'
import {
  backoffAllows,
  JACKPOT_GOAL as SENDER_JACKPOT_GOAL,
  jackpotWinsAway,
  LEVEL_COUNT as SENDER_LEVEL_COUNT,
  notificationUrl,
  sentToday,
  streakAtRisk,
} from '../../scripts/send-push.mjs'
import { pushSource } from './analytics'
import { dayKey } from './endless'
import { JACKPOT_GOAL } from './jackpot'
import { LEVEL_COUNT } from './levels'

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

describe('the jackpot-within-reach hook', () => {
  it('carries the app’s own goal and ladder reach', () => {
    // The parity that keeps the copy honest, exactly as bonusdrop.test.ts pins the gift roll: a
    // sender drifting from core/jackpot.ts would tell a player they are "one win from the wheel"
    // when they are not, and a LEVEL_COUNT drift would let the next-level line name a level the
    // catalogue does not hold.
    expect(SENDER_JACKPOT_GOAL).toBe(JACKPOT_GOAL)
    expect(SENDER_LEVEL_COUNT).toBe(LEVEL_COUNT)
  })

  it('fires inside two wins of the wheel', () => {
    expect(jackpotWinsAway({ jackpotMeter: JACKPOT_GOAL - 2 })).toBe(2)
    expect(jackpotWinsAway({ jackpotMeter: JACKPOT_GOAL - 1 })).toBe(1)
  })

  it('reports a loaded wheel as zero, even past the goal', () => {
    // A store batch or a cross-device merge can carry the meter past the goal; "wins away" floors
    // at zero rather than going negative and reading as nonsense copy.
    expect(jackpotWinsAway({ jackpotMeter: JACKPOT_GOAL })).toBe(0)
    expect(jackpotWinsAway({ jackpotMeter: JACKPOT_GOAL + 3 })).toBe(0)
  })

  it('stays quiet on an early meter — a half-charged meter is a meter, not news', () => {
    expect(jackpotWinsAway({ jackpotMeter: 0 })).toBeNull()
    expect(jackpotWinsAway({ jackpotMeter: JACKPOT_GOAL - 3 })).toBeNull()
  })

  it('survives a missing or shapeless save', () => {
    expect(jackpotWinsAway(null)).toBeNull()
    expect(jackpotWinsAway(undefined)).toBeNull()
    expect(jackpotWinsAway({})).toBeNull()
    expect(jackpotWinsAway({ jackpotMeter: Number.NaN })).toBeNull()
  })
})

/**
 * THE OPEN URL — where a tapped notification lands, and the marker that says which send sent it.
 *
 * The payload used to carry the literal './', so a push-driven return was indistinguishable from an
 * organic one and the ceiling above was being spent on faith. `notificationUrl` stamps
 * `?from=push-<mode>`; src/core/analytics.ts reports it as `app_open`'s `from` prop and strips it.
 *
 * Three properties of the string are load-bearing, and each of them is a different disaster:
 *   · RELATIVE — the game is served from a sub-path on TWO origins, which do not share storage. An
 *     absolute URL would land half the audience on the other one, with a different save.
 *   · QUERY, NOT FRAGMENT — the fragment carries the origin handoff's whole profile payload
 *     (core/originmigrate.ts). A marker there could collide with somebody's save.
 *   · The `./?from=` PREFIX — public/push-sw.js's same-page test. Miss it and a tap on an
 *     already-open game NAVIGATES, which is a reload, which ends an endless run that
 *     core/levelresume.ts deliberately cannot restore.
 */
describe('the notification’s open URL', () => {
  const MODES: PushMode[] = ['drop', 'daily', 'week']

  it('stamps which of the three sends opened the app', () => {
    expect(notificationUrl('drop')).toBe('./?from=push-drop')
    expect(notificationUrl('daily')).toBe('./?from=push-daily')
    expect(notificationUrl('week')).toBe('./?from=push-week')
  })

  it('stays RELATIVE, so it resolves under the game’s own path on BOTH origins', () => {
    for (const base of [
      'https://corrupt.solutions/games/viva-maya/',
      'https://corruptfun.github.io/viva-maya/',
    ]) {
      for (const mode of MODES) {
        expect(new URL(notificationUrl(mode), base).href, `${base} ${mode}`).toBe(
          `${base}?from=push-${mode}`
        )
      }
    }
  })

  it('keeps the marker in the QUERY — the fragment belongs to the origin handoff', () => {
    for (const mode of MODES) expect(notificationUrl(mode)).not.toContain('#')
  })

  it('matches the same-page prefix public/push-sw.js focuses on instead of reloading', () => {
    // ⚠️ The service worker is not importable from here (it is ES5-ish, `self`-scoped, and ships
    // verbatim out of public/), so this pins the SENDER's half of that contract and names the
    // literal to keep in step: `target.indexOf('./?from=') === 0` in push-sw.js's isSamePage. If
    // this prefix ever moves, that file has to move with it in the same commit — otherwise every
    // notification tap on an already-open game becomes a navigate(), i.e. a reload of a live board.
    for (const mode of MODES) expect(notificationUrl(mode).indexOf('./?from=')).toBe(0)
  })

  it('is understood by the CLIENT half — the two allow-lists must not drift', () => {
    // The parity that keeps the attribution honest, in the same spirit as the JACKPOT_GOAL pin
    // above. A fourth mode stamped by the sender but missing from `pushSource`'s allow-list would
    // not error anywhere: it would report as a silent zero, which reads like "nobody came back"
    // rather than like a bug, and could sit there for months.
    for (const mode of MODES) {
      const search = new URL(notificationUrl(mode), 'https://corrupt.solutions/games/viva-maya/').search
      expect(pushSource(search), mode).toBe(`push-${mode}`)
    }
  })
})

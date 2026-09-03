import { describe, expect, it } from 'vitest'
import type { PushMode } from '../../scripts/send-push.mjs'
import {
  ALL_CLEAR_CHIPS as SENDER_ALL_CLEAR_CHIPS,
  ALL_CLEAR_ID as SENDER_ALL_CLEAR_ID,
  ALL_CLEAR_SPINS as SENDER_ALL_CLEAR_SPINS,
  backoffAllows,
  backoffApplies,
  budgetAllows,
  DAILY_SEND_CAP,
  dueForMode,
  JACKPOT_GOAL as SENDER_JACKPOT_GOAL,
  jackpotWinsAway,
  LEVEL_COUNT as SENDER_LEVEL_COUNT,
  MIN_GAP_HOURS,
  modeForClock,
  notificationUrl,
  QUEST_COUNT as SENDER_QUEST_COUNT,
  questsOpen,
  raceInstant,
  sendsToday,
  sentInSlot,
  sentToday,
  slotFor,
  SLOTS,
  streakAtRisk,
  windowOpen,
} from '../../scripts/send-push.mjs'
import { pushSource } from './analytics'
import { dayKey } from './endless'
import { JACKPOT_GOAL } from './jackpot'
import { LEVEL_COUNT } from './levels'
import { ALL_CLEAR_CHIPS, ALL_CLEAR_ID, ALL_CLEAR_SPINS, QUEST_COUNT } from './quests'

/**
 * THE NOTIFICATION CADENCE — the three rules that make it honest for this game to send more than one
 * kind of notification.
 *
 * The game now has five scheduled sends (scripts/send-push.mjs: the morning house gift, the
 * afternoon quest nudge, the evening race reminder, the late streak rescue, the Sunday season
 * summary) against an audience that opted in on a card printing a NUMBER. That promise is kept by
 * VOLUME, not by count of features — at most `DAILY_SEND_CAP` per device per race day — and it is
 * kept by the predicates below plus a per-race-day counter (migration 0028).
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
  const MODES: PushMode[] = ['drop', 'quests', 'daily', 'laststand', 'week']

  it('stamps which of the three sends opened the app', () => {
    expect(notificationUrl('drop')).toBe('./?from=push-drop')
    expect(notificationUrl('quests')).toBe('./?from=push-quests')
    expect(notificationUrl('daily')).toBe('./?from=push-daily')
    expect(notificationUrl('laststand')).toBe('./?from=push-laststand')
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

/**
 * ⚠️ THE REGRESSION THIS SUITE EXISTS FOR, AND THE ONLY TEST HERE THAT PINS A TOTAL PROPERTY RATHER
 * THAN A BRANCH.
 *
 * Between 2026-08-25 and 2026-08-26 the two weekday sends partitioned the audience by activity:
 * `drop` took `away >= 2` (not here yesterday) and `daily` took `away === 1` (here exactly
 * yesterday). Every individual branch was correct, every unit test passed, and between them they
 * left out `away === 0` — the player who opens the game every day. All four live subscribers were
 * there. Every scheduled run for two days reported `4 opted in · 4 held back · 0 due`, exited 0, and
 * delivered nothing; the session that shipped it recorded the quiet as correct in good faith.
 *
 * A per-branch test cannot catch that, because no branch was wrong — the hole was BETWEEN them. So
 * these assert the property the branches exist to serve: a player in an ordinary state must be
 * reachable by SOMETHING. Tune a bound and this is what fails.
 */
describe('reach — every ordinary player matches some weekday mode', () => {
  const WEEKDAY: PushMode[] = ['drop', 'quests', 'daily', 'laststand']
  const reached = (ctx: Parameters<typeof dueForMode>[1]) => WEEKDAY.filter(m => dueForMode(m, ctx))

  it('reaches THE DAILY-ACTIVE PLAYER — the exact case that went dark', () => {
    // Here today, an unfinished quest slate: the afternoon nudge is for exactly this person.
    expect(reached({ away: 0, questsOpen: 2 })).toContain('quests')
    // Here today with a streak hours from breaking: the late rescue takes it.
    expect(reached({ away: 0, streakDays: 12 })).toContain('laststand')
    // Here today and racing: the evening board has their rank.
    expect(reached({ away: 0, onBoard: true })).toContain('daily')
    // Here today, chasing the wheel.
    expect(reached({ away: 0, winsAway: 1 })).toContain('daily')
  })

  it('reaches every OTHER away value too, including unknown', () => {
    for (const away of [1, 2, 3, 7, 29, null]) {
      expect(reached({ away }).length, `away ${away}`).toBeGreaterThan(0)
    }
  })

  it('still says NOTHING to a player with genuinely nothing waiting', () => {
    // The one silence that is correct, and the reason this is a property and not "always send":
    // here today, slate cleared, no streak at risk, off the board, no wheel in reach. Every mode
    // declining is the feature — "the board closes soon" is not news to someone holding the phone.
    expect(reached({ away: 0, questsOpen: 0 })).toEqual([])
  })

  it('never lets a mode fire on an empty context by accident', () => {
    // A default-everything ctx must not light up the two NARROW modes: both are gated on a specific
    // fact, and a mode that fires on "no information" is a mode that fires on a failed read.
    expect(dueForMode('quests', {})).toBe(false)
    expect(dueForMode('laststand', {})).toBe(false)
    expect(dueForMode('week', {})).toBe(true)
  })

  it('backs off only the two BROAD modes', () => {
    // A quest slate and a dying streak are time-critical facts about today; throttling those because
    // the player has been quiet throttles the only messages that could change that.
    expect(backoffApplies('drop')).toBe(true)
    expect(backoffApplies('daily')).toBe(true)
    expect(backoffApplies('quests')).toBe(false)
    expect(backoffApplies('laststand')).toBe(false)
    expect(backoffApplies('week')).toBe(false)
  })
})

/**
 * THE DAY'S BUDGET — the bound the opt-in card prints. `DAILY_SEND_CAP` is the number in
 * src/view/pushoptin.ts's VOLUME_RULE; if this suite is edited to allow more, that sentence is a lie
 * and the card has to move in the same commit.
 */
describe('the send budget', () => {
  const TODAY = '2026-08-26'
  const AT = (h: number) => new Date(`${TODAY}T${String(h).padStart(2, '0')}:00:00Z`)
  const row = (day: string | null, count: number, lastH: number | null) => ({
    sends_day: day,
    sends_count: count,
    last_sent_at: lastH === null ? null : AT(lastH).toISOString(),
  })

  it('counts only sends belonging to TODAY', () => {
    expect(sendsToday(row(TODAY, 2, 1), TODAY)).toBe(2)
    // A stale counter reads as zero rather than needing a nightly sweep to reset it.
    expect(sendsToday(row('2026-08-25', 3, 1), TODAY)).toBe(0)
    expect(sendsToday(row(null, 0, null), TODAY)).toBe(0)
  })

  it('stops at the cap the card promises', () => {
    expect(budgetAllows(row(TODAY, DAILY_SEND_CAP - 1, 1), TODAY, AT(20))).toBe(true)
    expect(budgetAllows(row(TODAY, DAILY_SEND_CAP, 1), TODAY, AT(20))).toBe(false)
    expect(budgetAllows(row(TODAY, DAILY_SEND_CAP + 9, 1), TODAY, AT(20))).toBe(false)
  })

  it('refuses two inside the minimum gap, whatever the cap says', () => {
    // The cap bounds the DAY; the gap is what a player actually experiences as spam. A manual run
    // landing beside a scheduled one is the case this catches.
    expect(budgetAllows(row(TODAY, 1, 10), TODAY, AT(10 + MIN_GAP_HOURS - 1))).toBe(false)
    expect(budgetAllows(row(TODAY, 1, 10), TODAY, AT(10 + MIN_GAP_HOURS))).toBe(true)
  })

  it('lets a never-sent device through', () => {
    expect(budgetAllows(row(null, 0, null), TODAY, AT(9))).toBe(true)
    expect(budgetAllows({}, TODAY, AT(9))).toBe(true)
  })

  it('falls back to ONE a day when migration 0028 is not applied', () => {
    // The un-migrated path errs QUIET — it under-sends rather than over-sends, which is the side a
    // notification budget must fail toward when it cannot see its own accounting. See 0028's header.
    // ⚠️ The legacy rule compares RACE DAY KEYS, not elapsed hours, so these timestamps have to land
    // inside the right Edmonton day: race day 2026-08-26 runs 06:00 UTC Aug 26 → 06:00 UTC Aug 27.
    // `AT(1)` looks like "1am today" and is in fact 7pm on the PREVIOUS race day, which is exactly
    // the confusion the sender avoids by never comparing hours across this boundary.
    const legacy = { legacy: true }
    expect(budgetAllows({ last_sent_at: null }, TODAY, AT(9), legacy)).toBe(true)
    expect(budgetAllows(row(TODAY, 1, 10), TODAY, AT(20), legacy)).toBe(false)
    expect(budgetAllows({ last_sent_at: AT(1).toISOString() }, TODAY, AT(20), legacy)).toBe(true)
  })
})

/**
 * THE QUEST SLATE, as the sender sees it. The four constants are duplicated into the .mjs (which
 * cannot import from src/) and pinned here for the reason every duplicated constant in that file is:
 * a drift makes the notification promise a payout the game does not hand over.
 */
describe('the quest nudge', () => {
  const TODAY = '2026-08-26'

  it('keeps the sender in step with the app’s own slate', () => {
    expect(SENDER_QUEST_COUNT).toBe(QUEST_COUNT)
    expect(SENDER_ALL_CLEAR_ID).toBe(ALL_CLEAR_ID)
    expect(SENDER_ALL_CLEAR_CHIPS).toBe(ALL_CLEAR_CHIPS)
    expect(SENDER_ALL_CLEAR_SPINS).toBe(ALL_CLEAR_SPINS)
  })

  it('treats a slate that has not rolled over as untouched', () => {
    // The common case for this hook: they opened the app without yet tripping a quest signal, so
    // their save still carries yesterday's slate. All of today's goals are open.
    expect(questsOpen({ quests: { day: '2026-08-25', claimed: ['a', 'b'] } }, TODAY)).toBe(QUEST_COUNT)
  })

  it('counts unfinished goals, and never counts the all-clear bonus as one', () => {
    expect(questsOpen({ quests: { day: TODAY, claimed: [] } }, TODAY)).toBe(QUEST_COUNT)
    expect(questsOpen({ quests: { day: TODAY, claimed: ['a'] } }, TODAY)).toBe(QUEST_COUNT - 1)
    // A finished slate carries the bonus id too. Counting it would report -1 open, which dueForMode
    // would read as "nothing due" by luck rather than by rule.
    const finished = { quests: { day: TODAY, claimed: ['a', 'b', 'c', ALL_CLEAR_ID] } }
    expect(questsOpen(finished, TODAY)).toBe(0)
    expect(dueForMode('quests', { away: 0, questsOpen: questsOpen(finished, TODAY) })).toBe(false)
  })

  it('answers null on junk rather than guessing', () => {
    // A missing personalisation must never cost a notification — and here it costs only this mode,
    // which is correct, because this mode is ENTIRELY about the slate.
    expect(questsOpen(null, TODAY)).toBe(null)
    expect(questsOpen({}, TODAY)).toBe(null)
    expect(questsOpen({ quests: null }, TODAY)).toBe(null)
    expect(dueForMode('quests', { away: 0, questsOpen: null })).toBe(false)
  })
})

/**
 * THE CLOCK, NOT THE CRON — the fix for the second silent outage.
 *
 * Five fixed-hour crons ran 2–11 hours late on this repo (measured 2026-08-26 → 09-03). The ~9pm
 * streak last call landed at 1:40–2:00 AM, on the NEXT race day, said "ends at midnight, in 22
 * hours", and spent the device's one-a-day fallback budget on it. Every run was green. The sender
 * now polls hourly and asks the home clock which slot it is in, so the instants below are the ones
 * that matter: the run that actually fired, and the seams around each slot.
 */
describe('the clock picks the mode', () => {
  // America/Edmonton is UTC−6 in September (MDT). 07:52Z is 01:52 at home — the real run.
  const THE_2AM_RUN = new Date('2026-09-03T07:52:09Z')

  it('selects NOTHING at 1:52 AM — the instant the late last call actually fired', () => {
    expect(modeForClock(THE_2AM_RUN)).toBeNull()
    expect(windowOpen('laststand', THE_2AM_RUN)).toBe(false)
  })

  it('walks the day in order on a weekday', () => {
    expect(modeForClock(new Date('2026-09-03T15:37:00Z'))?.mode).toBe('drop') // 09:37
    expect(modeForClock(new Date('2026-09-03T19:37:00Z'))?.mode).toBe('quests') // 13:37
    expect(modeForClock(new Date('2026-09-03T22:37:00Z'))?.mode).toBe('daily') // 16:37
    expect(modeForClock(new Date('2026-09-04T02:37:00Z'))?.mode).toBe('laststand') // 20:37
  })

  it('is quiet between the evening board and the last call, and after 23:30', () => {
    expect(modeForClock(new Date('2026-09-04T01:15:00Z'))).toBeNull() // 19:15
    expect(modeForClock(new Date('2026-09-04T05:45:00Z'))).toBeNull() // 23:45
    expect(modeForClock(new Date('2026-09-04T06:00:00Z'))).toBeNull() // 00:00 — the day flips
  })

  it('gives Sunday evening to the season, and leaves the rest of Sunday to the weekday slots', () => {
    // 2026-09-06 is a Sunday.
    expect(modeForClock(new Date('2026-09-06T22:37:00Z'))?.mode).toBe('week')
    expect(modeForClock(new Date('2026-09-06T15:37:00Z'))?.mode).toBe('drop')
    expect(modeForClock(new Date('2026-09-07T02:37:00Z'))?.mode).toBe('laststand')
    // Monday evening is a board again.
    expect(modeForClock(new Date('2026-09-07T22:37:00Z'))?.mode).toBe('daily')
  })

  it('reads the home clock, not UTC, across the DST seam', () => {
    // 2026-11-01 is the fall-back Sunday: Mountain time goes from −6 to −7 at 02:00 local.
    // 16:37Z is 09:37 MST that day — the morning gift, not the quest slate 15:37Z would be in MDT.
    expect(modeForClock(new Date('2026-11-01T16:37:00Z'))?.mode).toBe('drop')
    expect(modeForClock(new Date('2026-11-02T03:37:00Z'))?.mode).toBe('laststand') // 20:37 MST
  })

  it('keeps every slot clear of midnight, in order, and gives the last call room after the board', () => {
    const byStart = [...SLOTS].sort((a, b) => a.from - b.from)
    expect(byStart.map(s => s.mode)).toEqual(['drop', 'quests', 'daily', 'laststand'])
    for (let i = 1; i < byStart.length; i++) expect(byStart[i].from).toBeGreaterThanOrEqual(byStart[i - 1].until)
    // The last call's sentence is about THIS midnight; a slot that touched it would let a run
    // fire on the next race day and say "in 22 hours" again.
    expect(byStart[byStart.length - 1].until).toBeLessThan(24 * 60)
    expect(byStart[0].from).toBeGreaterThanOrEqual(8 * 60)
    // A board reminder at the very end of its slot must not lock the last call out via the gap.
    const daily = slotFor('daily')!
    const last = slotFor('laststand')!
    expect(last.until - daily.until).toBeGreaterThan(MIN_GAP_HOURS * 60)
    // `week` rides the board's slot.
    expect(slotFor('week')).toBe(daily)
  })

  it('latches a device the slot has already reached today, and only that slot', () => {
    const now = new Date('2026-09-03T23:10:00Z') // 17:10 at home, inside the evening board's slot
    const daily = slotFor('daily')!
    const opened = raceInstant('2026-09-03', daily.from) // 16:00 at home
    expect(opened.toISOString()).toBe('2026-09-03T22:00:00.000Z')
    // Sent at 16:20 by an earlier run this slot: done.
    expect(sentInSlot({ last_sent_at: '2026-09-03T22:20:00Z' }, daily, now)).toBe(true)
    // Sent at 13:30 — that was the quest slot's send, not this one.
    expect(sentInSlot({ last_sent_at: '2026-09-03T19:30:00Z' }, daily, now)).toBe(false)
    // Yesterday's board reminder at the same hour is yesterday's.
    expect(sentInSlot({ last_sent_at: '2026-09-02T22:20:00Z' }, daily, now)).toBe(false)
    // Never sent, junk, or no slot (the season on a weekday dry run): never latched.
    expect(sentInSlot({}, daily, now)).toBe(false)
    expect(sentInSlot({ last_sent_at: 'not a date' }, daily, now)).toBe(false)
    expect(sentInSlot({ last_sent_at: '2026-09-03T22:20:00Z' }, null, now)).toBe(false)
  })
})

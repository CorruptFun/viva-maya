import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayKey as senderDayKey, weekKey as senderWeekKey } from '../../scripts/send-push.mjs'
import { EVENTS, _queueDepth, _reset, analyticsEnabled, setAnalyticsEnabled, track } from './analytics'
import { dayKey as appDayKey, weekKey as appWeekKey } from './endless'

/**
 * THE LOAD-BEARING TEST IN THIS FILE.
 *
 * scripts/send-push.mjs cannot import from src/ — it runs in CI as plain Node against the built
 * repo, with no TypeScript step — so it carries its own copies of weekKey() and dayKey(). A copy is a
 * thing that drifts, and this particular drift is SILENT AND TOTAL: the keys select the leaderboard
 * partitions, so a sender computing a different key reads an empty board and sends every player the
 * generic "the board is wide open" copy instead of their standing. Nothing errors. The notification
 * still arrives. It is just quietly worthless, and it would stay that way for weeks.
 *
 * The DAY key is the more dangerous of the two now, because it is the one the race actually turns on
 * and it rolls over seven times as often — a drift there is wrong every single evening.
 *
 * The 2026-07-26 timezone split is the precedent: weekKey was moved to UTC because a local-time
 * derivation put players in different timezones on different races. A second, drifting definition of
 * the same function is the same class of bug with a longer fuse.
 */
describe('sender/app week key agreement', () => {
  it('agrees with core/endless.ts on every day for three years', () => {
    const start = Date.UTC(2026, 0, 1)
    const mismatches: string[] = []
    for (let day = 0; day < 365 * 3; day++) {
      const d = new Date(start + day * 86400000)
      const app = appWeekKey(d)
      const sender = senderWeekKey(d)
      if (app !== sender) mismatches.push(`${d.toISOString().slice(0, 10)}: app=${app} sender=${sender}`)
    }
    expect(mismatches).toEqual([])
  })

  it('agrees across the Monday 00:00 UTC rollover, to the minute', () => {
    // The boundary is the only place an off-by-one can hide: a whole-day sweep steps straight over
    // the instant the race actually closes.
    const rollover = Date.UTC(2026, 6, 27, 0, 0, 0) // a Monday
    for (const offset of [-60_000, -1000, 0, 1000, 60_000]) {
      const d = new Date(rollover + offset)
      expect(senderWeekKey(d), `at ${d.toISOString()}`).toBe(appWeekKey(d))
    }
  })

  it('agrees across an ISO year boundary (the classic week-53 trap)', () => {
    for (const iso of ['2026-12-28', '2026-12-31', '2027-01-01', '2027-01-03', '2027-01-04']) {
      const d = new Date(`${iso}T12:00:00Z`)
      expect(senderWeekKey(d), iso).toBe(appWeekKey(d))
    }
  })
})

describe('sender/app DAY key agreement', () => {
  it('agrees with core/endless.ts on every day for three years', () => {
    const start = Date.UTC(2026, 0, 1)
    const mismatches: string[] = []
    for (let day = 0; day < 365 * 3; day++) {
      const d = new Date(start + day * 86400000)
      const app = appDayKey(d)
      const sender = senderDayKey(d)
      if (app !== sender) mismatches.push(`${d.toISOString().slice(0, 10)}: app=${app} sender=${sender}`)
    }
    expect(mismatches).toEqual([])
  })

  it('agrees across the 00:00 UTC rollover, to the minute', () => {
    // The boundary is the only place an off-by-one can hide: a whole-day sweep steps straight over
    // the instant the board actually closes.
    const rollover = Date.UTC(2026, 6, 30, 0, 0, 0)
    for (const offset of [-60_000, -1000, 0, 1000, 60_000]) {
      const d = new Date(rollover + offset)
      expect(senderDayKey(d), `at ${d.toISOString()}`).toBe(appDayKey(d))
    }
  })

  it('agrees across month and year seams (the zero-padding traps)', () => {
    for (const iso of ['2026-02-28', '2026-03-01', '2026-09-30', '2026-10-01', '2026-12-31', '2027-01-01']) {
      const d = new Date(`${iso}T12:00:00Z`)
      expect(senderDayKey(d), iso).toBe(appDayKey(d))
    }
  })
})

/**
 * The suite runs in the Node environment (vitest.config.ts) because everything else under core/ is
 * pure logic. analytics.ts touches localStorage for the device id and the opt-out flag, so it gets a
 * minimal in-memory stand-in rather than dragging jsdom into the whole test run for two tests.
 */
function installLocalStorage(): void {
  const data = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    },
  })
}

describe('analytics queue', () => {
  beforeEach(() => {
    _reset()
    // The module reads these at import time for `configured()`; stubbing makes track() live rather
    // than taking its dormant no-op path, which is what the assertions below are about.
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-key')
    installLocalStorage()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    _reset()
  })

  it('opting out stops collection and discards what is already queued', () => {
    track(EVENTS.LEVEL_START, { level: 1 })
    const before = _queueDepth()
    setAnalyticsEnabled(false)
    expect(analyticsEnabled()).toBe(false)
    expect(_queueDepth()).toBe(0)
    track(EVENTS.LEVEL_WIN, { level: 1 })
    expect(_queueDepth()).toBe(0)
    // …and opting back in resumes, so the control is a toggle and not a one-way door.
    setAnalyticsEnabled(true)
    track(EVENTS.LEVEL_WIN, { level: 1 })
    expect(_queueDepth()).toBeGreaterThan(0)
    expect(before).toBeGreaterThan(0)
  })

  it('never throws, whatever it is handed', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => track(EVENTS.LEVEL_FAIL, circular)).not.toThrow()
    expect(() => track('' as never)).not.toThrow()
    expect(() => track(EVENTS.APP_OPEN, undefined as never)).not.toThrow()
  })
})

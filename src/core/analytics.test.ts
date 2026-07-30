import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dayKey as senderDayKey, weekKey as senderWeekKey } from '../../scripts/send-push.mjs'
import {
  EVENTS,
  _flush,
  _queueDepth,
  _reportClientError,
  _reset,
  analyticsEnabled,
  setAnalyticsEnabled,
  track,
} from './analytics'
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
 * The 2026-07-26 timezone split is the precedent: weekKey was moved off DEVICE-LOCAL time because a
 * local derivation put players in different timezones on different races. (The fixed anchor moved
 * again on 2026-07-30, from UTC to the home zone America/Edmonton — still one worldwide instant,
 * now at the home crowd's actual midnight.) A second, drifting definition of the same function is
 * the same class of bug with a longer fuse.
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

  it('agrees across the Monday-midnight-Mountain rollover, to the minute', () => {
    // The boundary is the only place an off-by-one can hide: a whole-day sweep steps straight over
    // the instant the race actually closes. Monday 00:00 America/Edmonton = Monday 06:00Z in July.
    const rollover = Date.UTC(2026, 6, 27, 6, 0, 0)
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

  it('agrees across the midnight-Mountain rollover, to the minute', () => {
    // The boundary is the only place an off-by-one can hide: a whole-day sweep steps straight over
    // the instant the board actually closes. Midnight America/Edmonton = 06:00Z in July (MDT).
    const rollover = Date.UTC(2026, 6, 30, 6, 0, 0)
    for (const offset of [-60_000, -1000, 0, 1000, 60_000]) {
      const d = new Date(rollover + offset)
      expect(senderDayKey(d), `at ${d.toISOString()}`).toBe(appDayKey(d))
    }
  })

  it('agrees across the DST seams, where the two copies could bend the clock differently', () => {
    // Alberta 2026: spring forward Mar 8 (a 23h race day), fall back Nov 1 (a 25h race day). Sweep
    // the minutes around each day's midnight handover — the only instants the offset flip can bite.
    for (const boundary of [Date.UTC(2026, 2, 9, 6, 0, 0), Date.UTC(2026, 10, 2, 7, 0, 0)]) {
      for (const offset of [-60_000, -1000, 0, 1000, 60_000]) {
        const d = new Date(boundary + offset)
        expect(senderDayKey(d), `at ${d.toISOString()}`).toBe(appDayKey(d))
        expect(senderWeekKey(d), `at ${d.toISOString()}`).toBe(appWeekKey(d))
      }
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

/**
 * The 0015 wire contract: every event carries an idempotency key, a resend after a lost response
 * cannot double-count, and a client deployed AHEAD of the 0015 migration falls back to the legacy
 * shape without losing a single event. The fallback test is the load-bearing one — it is the
 * 0008/0009 deploy-race lesson applied to this table, and it is exactly the path nobody would
 * notice breaking until a whole day of events silently vanished.
 */
describe('flush idempotency + schema fallback (0015)', () => {
  interface SentBatch {
    url: string
    prefer: string
    rows: Record<string, unknown>[]
  }
  let sent: SentBatch[]
  let respond: () => { ok: boolean; status: number }

  beforeEach(() => {
    _reset()
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-key')
    installLocalStorage()
    sent = []
    respond = () => ({ ok: true, status: 201 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
        sent.push({ url: String(url), prefer: init.headers.Prefer, rows: JSON.parse(init.body) })
        return respond() as Response
      })
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    _reset()
  })

  it('mints a distinct event_id per event and posts with on_conflict + ignore-duplicates', async () => {
    track(EVENTS.LEVEL_START, { level: 1 })
    track(EVENTS.LEVEL_WIN, { level: 1 })
    await _flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toContain('/rest/v1/events?on_conflict=event_id')
    expect(sent[0].prefer).toContain('resolution=ignore-duplicates')
    const ids = sent[0].rows.map(r => r.event_id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(String(id)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a 5xx re-queues the batch with the SAME ids — that persistence is the dedupe', async () => {
    track(EVENTS.APP_OPEN)
    respond = () => ({ ok: false, status: 503 })
    await _flush()
    const firstIds = sent[0].rows.map(r => r.event_id)
    expect(_queueDepth()).toBe(1) // kept, not dropped
    respond = () => ({ ok: true, status: 201 })
    await _flush()
    expect(sent[1].rows.map(r => r.event_id)).toEqual(firstIds)
  })

  it('a 400 while sending ids flips to the legacy shape and re-queues instead of dropping', async () => {
    track(EVENTS.APP_OPEN)
    respond = () => ({ ok: false, status: 400 }) // a pre-0015 server rejecting the unknown column
    await _flush()
    expect(_queueDepth()).toBe(1) // the batch survived the schema mismatch
    respond = () => ({ ok: true, status: 201 })
    await _flush()
    expect(sent[1].url).not.toContain('on_conflict') // legacy wire shape…
    expect(sent[1].prefer).not.toContain('ignore-duplicates')
    expect(sent[1].rows[0]).not.toHaveProperty('event_id') // …with the ids stripped
    expect(sent[1].rows[0]).toHaveProperty('name', EVENTS.APP_OPEN)
  })

  it('a 400 in legacy mode drops (a genuinely bad batch must not loop forever)', async () => {
    track(EVENTS.APP_OPEN)
    respond = () => ({ ok: false, status: 400 })
    await _flush() // flips to fallback, re-queues
    await _flush() // legacy send also 400s
    expect(_queueDepth()).toBe(0)
  })
})

describe('client error telemetry (0015)', () => {
  beforeEach(() => {
    _reset()
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-key')
    installLocalStorage()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    _reset()
  })

  it('queues a client_error, truncated and once per distinct message', () => {
    _reportClientError('x'.repeat(999), { source: 'main.js:1' })
    _reportClientError('x'.repeat(999)) // same message after truncation — deduped
    expect(_queueDepth()).toBe(1)
  })

  it('caps the per-session budget so an error loop cannot flood the pipe', () => {
    for (let i = 0; i < 50; i++) _reportClientError(`boom ${i}`)
    expect(_queueDepth()).toBe(5)
  })

  it('never throws, even handed hostile reasons', () => {
    const evil = {
      get message(): string {
        throw new Error('gotcha')
      },
    }
    expect(() => _reportClientError(evil)).not.toThrow()
    expect(() => _reportClientError(undefined)).not.toThrow()
  })
})

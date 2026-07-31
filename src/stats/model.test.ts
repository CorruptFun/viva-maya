import { describe, expect, it } from 'vitest'
import { EVENTS } from '../core/analytics'
import { PLINKO_ENDLESS_SLOTS, PLINKO_SLOTS } from '../core/plinko'
import {
  buildFunnels,
  coerceAnalytics,
  fillDaily,
  fillHourly,
  fmtAgo,
  fmtCompact,
  fmtDayLabel,
  fmtDuration,
  fmtPct,
  FUNNEL_DEFS,
  hourInZone,
  plinkoTargetPct,
  SESSION_BUCKETS,
  sessionBucketCounts,
  lastNDays,
  linePath,
  niceTicks,
  roundedTopRect,
  share,
  unexpectedCounts,
  utcDayKey,
  wallLevels,
  winPct,
  zoneAbbr,
  zoneDayKey,
  zoneOffsetMinutes,
  type DailyRow,
  type LevelRow,
} from './model'

function level(partial: Partial<LevelRow>): LevelRow {
  return {
    level: 1,
    starts: 0,
    wins: 0,
    fails: 0,
    fails_moves: 0,
    fails_lives: 0,
    quits: 0,
    continues_shown: 0,
    continues_taken: 0,
    devices: 0,
    ...partial,
  }
}

/**
 * THE VOCABULARY PIN. The funnels are drawn from event-name COUNTS, so a name here that the client
 * never sends would render as a permanently-zero step — indistinguishable from a real 0% conversion,
 * which is the worst kind of wrong (it looks like data). Referencing EVENTS gets compile-time
 * safety; this test additionally proves no def smuggles in a literal that drifted from the
 * canonical vocabulary, the same one-source-of-truth discipline the sender/app dayKey tests enforce.
 */
describe('funnel definitions', () => {
  it('every funnel step and aside is a canonical EVENTS name', () => {
    const known = new Set<string>(Object.values(EVENTS))
    for (const def of FUNNEL_DEFS) {
      for (const s of def.steps) expect(known.has(s.name), `${def.id}: ${s.name}`).toBe(true)
      for (const a of def.aside ?? []) expect(known.has(a.name), `${def.id}: ${a.name}`).toBe(true)
    }
  })

  /**
   * THE PIN THAT ACTUALLY BITES — and the reason the one above is not enough.
   *
   * The test above proves a funnel step is a REAL name. It cannot prove anything SENDS that name,
   * because both sides of the comparison are the same TypeScript constant: a step referencing a
   * perfectly canonical event that no code path ever fires passes it easily. That is not
   * hypothetical. `plinko_played` was declared, charted, aggregated by the admin RPC — and never
   * fired by anything, for the whole life of the dashboard. "Offered → Dropped" rendered a permanent
   * 0%, which is the worst failure mode available here: it does not look broken, it looks like every
   * player abandoning the drop.
   *
   * So this one reads the OTHER SIDE'S SOURCE TEXT — every non-test .ts under src/ — and asks
   * whether a `track(...)` call mentioning the constant exists at all. Source text, not imports,
   * because the senders are spread across scenes, views and lazily-imported core modules, and two of
   * them fire through `import('./analytics').then(a => a.track(a.EVENTS.X))`, which no amount of
   * static importing from this file would reveal.
   *
   * Read via Vite's `?raw` glob rather than node:fs deliberately — this project compiles with
   * `types: ["vite/client"]` and no @types/node, so a `node:fs` import here type-checks fine under
   * vitest and then fails `npm run build`, which runs tsc over the same file.
   */
  it('every funnel step is actually FIRED somewhere in the app, not merely declared', () => {
    /**
     * Events charted but genuinely unsent as of 2026-07-31. Listed, not silently tolerated: each is
     * a real dashboard funnel reading 0% for want of a `track()` call, and the point of naming them
     * is that this test fails the moment a SIXTH one appears. Delete entries as they get wired.
     */
    const KNOWN_UNSENT = new Set<string>([
      EVENTS.SIGNIN_SHOWN, // the sign-in funnel's own denominator
      EVENTS.INSTALL_SHOWN, // whole PWA-install funnel: both steps
      EVENTS.INSTALL_ACCEPTED,
      EVENTS.REFERRAL_CAPTURED, // invite.ts fires SHARE_CLICKED, referrals.ts REFERRAL_REGISTERED
    ])

    const modules = import.meta.glob('/src/**/*.ts', { query: '?raw', import: 'default', eager: true })
    const source = Object.entries(modules as Record<string, string>)
      .filter(([p]) => !p.endsWith('.test.ts'))
      .filter(([p]) => !p.startsWith('/src/stats/')) // the dashboard READS names; it never sends them
      .map(([, text]) => text)
      .join('\n')

    // `a.track(a.EVENTS.X)` and `track(EVENTS.X, {...})` both have to count.
    const fired = new Set<string>()
    for (const m of source.matchAll(/track\(\s*(?:\w+\.)?EVENTS\.([A-Z0-9_]+)/g)) {
      const value = (EVENTS as Record<string, string>)[m[1]]
      if (value) fired.add(value)
    }
    expect(fired.size, 'no track() calls found at all — the scan regex has drifted').toBeGreaterThan(10)

    const names = FUNNEL_DEFS.flatMap(d => [...d.steps, ...(d.aside ?? [])].map(s => s.name))
    const unsent = [...new Set(names)].filter(n => !fired.has(n) && !KNOWN_UNSENT.has(n))
    expect(unsent, 'charted on the dashboard but nothing fires it — it will read as a real 0%').toEqual([])

    // And the list stays honest in the other direction: an entry that HAS been wired must be removed,
    // or it goes on excusing a step that no longer needs excusing.
    const staleExcuses = [...KNOWN_UNSENT].filter(n => fired.has(n))
    expect(staleExcuses, 'these are sent now — delete them from KNOWN_UNSENT').toEqual([])
  })

  it('builds ordered steps with conversion against first and previous', () => {
    const funnels = buildFunnels([
      { name: EVENTS.SIGNIN_SHOWN, events: 40, devices: 10 },
      { name: EVENTS.SIGNIN_STARTED, events: 10, devices: 6 },
      { name: EVENTS.SIGNIN_COMPLETED, events: 5, devices: 5 },
    ])
    const signin = funnels.find(f => f.id === 'signin')!
    expect(signin.steps.map(s => s.events)).toEqual([40, 10, 5])
    expect(signin.steps[0].pctOfFirst).toBeNull() // the first step is the denominator, not a rate
    expect(signin.steps[1].pctOfFirst).toBe(25)
    expect(signin.steps[2].pctOfFirst).toBe(12.5)
    expect(signin.steps[2].pctOfPrev).toBe(50)
  })

  it('a funnel whose events never fired reads as zeros, not a crash', () => {
    const push = buildFunnels([]).find(f => f.id === 'push')!
    expect(push.steps.every(s => s.events === 0)).toBe(true)
    expect(push.steps[1].pctOfFirst).toBeNull() // 0-of-0 is "no data", never "0%"
    expect(push.aside).toEqual([{ label: 'Blocked', events: 0 }])
  })

  it('flags names outside the vocabulary (the unknown bucket must stay visible)', () => {
    const odd = unexpectedCounts([
      { name: EVENTS.APP_OPEN, events: 5, devices: 2 },
      { name: 'unknown', events: 3, devices: 1 },
      { name: 'totally_forged', events: 1, devices: 1 },
    ])
    expect(odd.map(o => o.name)).toEqual(['unknown', 'totally_forged'])
  })
})

describe('coerceAnalytics', () => {
  it('turns complete garbage into a safe empty dashboard', () => {
    for (const junk of [null, undefined, 42, 'no', [], { daily: 'x', totals: 7, deal: [] }]) {
      const a = coerceAnalytics(junk)
      expect(a.totals.devices).toBe(0)
      expect(a.daily).toEqual([])
      expect(a.deal.streaks).toEqual([])
      expect(a.meta.days).toBe(14)
    }
  })

  it('passes a realistic payload through intact', () => {
    const a = coerceAnalytics({
      meta: { days: 7, since: 's', generated_at: 'g' },
      totals: { devices: 3, signed_in: 1, sessions: 4, events: 22, app_opens: 2, standalone_opens: 1, new_devices: 3 },
      daily: [{ day: '2026-07-30', devices: 2, signed_in: 1, sessions: 2, events: 10, app_opens: 2, standalone_opens: 1, new_devices: 2 }],
      levels: [{ level: 21, starts: 2, wins: 1, fails: 2, fails_moves: 1, fails_lives: 1, quits: 0, continues_shown: 1, continues_taken: 1, devices: 2 }],
      deal: { offers: 2, wins: 2, fast_wins: 1, charms: 1, avg_flips: 7, streaks: [{ streak: 3, count: 1 }], faces: [{ face: 'heart', count: 1 }] },
    })
    expect(a.meta.days).toBe(7)
    expect(a.totals.events).toBe(22)
    expect(a.daily[0].day).toBe('2026-07-30')
    expect(a.levels[0].fails_lives).toBe(1)
    expect(a.deal.avg_flips).toBe(7)
  })

  it('null avg_flips stays null (no fabricated zero)', () => {
    expect(coerceAnalytics({ deal: { avg_flips: null } }).deal.avg_flips).toBeNull()
  })

  it('a pre-0015 payload (no retention/sessions/errors keys) degrades to empty panels, not a crash', () => {
    const a = coerceAnalytics({ totals: { devices: 3 } })
    expect(a.retention.d1).toEqual({ eligible: 0, returned: 0 })
    expect(a.retention.cohorts).toEqual([])
    expect(a.sessions.total).toBe(0)
    expect(a.errors.top).toEqual([])
  })

  /**
   * The load-bearing compatibility case for 0022. The RPC and this dashboard deploy INDEPENDENTLY —
   * the migration is applied by hand, the page ships with the game — so a client that knows about
   * `modes` will meet a payload without it, and the panel has to degrade to "not shown" rather than
   * throw and blank the whole page.
   */
  it('a pre-0022 plinko payload (no modes key) degrades to an empty split, not a crash', () => {
    const a = coerceAnalytics({
      plinko: { offered: 40, played: 31, slots: [{ slot: 0, count: 2, avg_payout: 9999 }] },
    })
    expect(a.plinko.played).toBe(31)
    expect(a.plinko.slots).toHaveLength(1) // the pooled histogram still reads
    expect(a.plinko.modes).toEqual([]) // and the new panel simply does not render
  })

  it('splits plinko by board, with honest denominators', () => {
    const a = coerceAnalytics({
      plinko: {
        offered: 100,
        played: 32,
        slots: [],
        modes: [
          { mode: 'endless', played: 10, top_hits: 1, avg_mult: 2.8 },
          { mode: 'numbered', played: 20, top_hits: 1, avg_mult: 3.35 },
          { mode: 'unknown', played: 2, top_hits: 0, avg_mult: null },
          { mode: 'nothing_played', played: 0, top_hits: 0, avg_mult: null },
        ],
      },
    })
    const by = Object.fromEntries(a.plinko.modes.map(m => [m.mode, m]))
    expect(by.endless.topPct).toBeCloseTo(10)
    expect(by.numbered.topPct).toBeCloseTo(5)
    expect(by.unknown.avgMult).toBeNull()
    // 0 of 0 is "no data" — a fabricated 0% here would read as "the x10 never lands".
    expect(by.nothing_played.topPct).toBeNull()
  })

  /**
   * The target rates are DERIVED from the shipped weight tables, so the dashboard cannot go on
   * comparing live data against a stale number after the next retune. Pinned against the tables
   * themselves rather than against 6/8 literals, for exactly the same reason.
   */
  it('derives each board’s x10 target from the real table, and has none for unknown', () => {
    const edge = (t: typeof PLINKO_SLOTS): number =>
      (t.filter(p => p.kind === 'mult' && p.mult >= 10).reduce((s, p) => s + p.weight, 0) /
        t.reduce((s, p) => s + p.weight, 0)) *
      100
    expect(plinkoTargetPct('numbered')).toBeCloseTo(edge(PLINKO_SLOTS))
    expect(plinkoTargetPct('endless')).toBeCloseTo(edge(PLINKO_ENDLESS_SLOTS))
    // Endless is the more generous board — if this ever inverts, the dashboard is mislabelling them.
    expect(plinkoTargetPct('endless')!).toBeGreaterThan(plinkoTargetPct('numbered')!)
    expect(plinkoTargetPct('unknown')).toBeNull()
    expect(plinkoTargetPct('something_else')).toBeNull()
  })

  it('passes the 0015 sections through intact', () => {
    const a = coerceAnalytics({
      retention: {
        d1: { eligible: 8, returned: 3 },
        d7: { eligible: 4, returned: 1 },
        cohorts: [{ day: '2026-07-20', cohort: 2, d1: 1, d7: 0, d1_ready: true, d7_ready: false }],
      },
      sessions: { total: 40, median_seconds: 272, bounces: 6, buckets: [{ b: 2, count: 18 }] },
      errors: {
        events: 3,
        devices: 2,
        top: [{ message: 'boom', count: 3, devices: 2, versions: ['abc1234'], last_seen: 'x' }],
      },
    })
    expect(a.retention.d1.returned).toBe(3)
    expect(a.retention.cohorts[0].d7_ready).toBe(false)
    expect(a.sessions.median_seconds).toBe(272)
    expect(a.errors.top[0].versions).toEqual(['abc1234'])
  })
})

describe('sessions + duration helpers', () => {
  it('densifies sparse buckets into the five fixed slots and drops junk indices', () => {
    expect(
      sessionBucketCounts({ total: 0, median_seconds: 0, bounces: 0, buckets: [{ b: 2, count: 7 }, { b: 4, count: 1 }, { b: 9, count: 5 }, { b: -1, count: 5 }] })
    ).toEqual([0, 0, 7, 0, 1])
  })

  it('labels stay index-aligned with the SQL CASE in 0015', () => {
    expect(SESSION_BUCKETS).toHaveLength(5)
    expect(SESSION_BUCKETS[0]).toBe('<1 min')
    expect(SESSION_BUCKETS[4]).toBe('30 min+')
  })

  it('fmtDuration reads like a human wrote it', () => {
    expect(fmtDuration(0)).toBe('0s')
    expect(fmtDuration(45)).toBe('45s')
    expect(fmtDuration(272)).toBe('4m 32s')
    expect(fmtDuration(600)).toBe('10m')
    expect(fmtDuration(4320)).toBe('1h 12m')
    expect(fmtDuration(-5)).toBe('0s')
  })
})

describe('day window filling', () => {
  const noon = Date.UTC(2026, 6, 30, 12, 0, 0) // 2026-07-30

  it('utcDayKey / lastNDays cut on UTC days, spanning month seams', () => {
    expect(utcDayKey(noon)).toBe('2026-07-30')
    expect(lastNDays(3, Date.UTC(2026, 7, 1, 5, 0, 0))).toEqual(['2026-07-30', '2026-07-31', '2026-08-01'])
  })

  it('zero-fills silent days — the silence is the signal a retention chart exists for', () => {
    const rows: DailyRow[] = [
      { day: '2026-07-28', devices: 2, signed_in: 0, sessions: 2, events: 9, app_opens: 2, standalone_opens: 0, new_devices: 1 },
      { day: '2026-07-30', devices: 1, signed_in: 1, sessions: 1, events: 5, app_opens: 1, standalone_opens: 1, new_devices: 0 },
    ]
    const filled = fillDaily(rows, 4, noon)
    expect(filled.map(d => d.day)).toEqual(['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'])
    expect(filled.map(d => d.devices)).toEqual([0, 2, 0, 1])
  })

  it('fillHourly always yields the full 24-hour clock', () => {
    const filled = fillHourly([{ hour: 18, sessions: 4, events: 40 }])
    expect(filled).toHaveLength(24)
    expect(filled[18].sessions).toBe(4)
    expect(filled[0]).toEqual({ hour: 0, sessions: 0, events: 0 })
  })
})

describe('rendering hours on the viewer’s clock', () => {
  const july = Date.UTC(2026, 6, 30, 12, 0, 0) // daylight time
  const january = Date.UTC(2026, 0, 15, 12, 0, 0) // standard time

  it('resolves the offset per instant, so Central is not pinned to one of its two offsets', () => {
    expect(zoneOffsetMinutes('America/Chicago', july)).toBe(-300) // CDT, UTC-5
    expect(zoneOffsetMinutes('America/Chicago', january)).toBe(-360) // CST, UTC-6
    expect(zoneOffsetMinutes('UTC', july)).toBe(0)
    expect(zoneOffsetMinutes('Asia/Kolkata', july)).toBe(330)
  })

  it('names the zone it actually rendered, DST included', () => {
    expect(zoneAbbr('America/Chicago', july)).toBe('CDT')
    expect(zoneAbbr('America/Chicago', january)).toBe('CST')
    expect(zoneAbbr('UTC', july)).toBe('UTC')
  })

  it('never throws on a zone the runtime will not parse — a bad clock must not blank the page', () => {
    expect(zoneOffsetMinutes('Mars/Olympus', july)).toBe(0)
    expect(zoneAbbr('Mars/Olympus', july)).toBe('Mars/Olympus')
  })

  it('reads a UTC-scheduled hour on the viewer’s clock (the push cron is fixed at 01:00 UTC)', () => {
    expect(hourInZone(1, -300)).toBe(20) // the 01:00 UTC push lands at 20:00 CDT
    expect(hourInZone(1, -360)).toBe(19) // …and at 19:00 once CST returns
  })

  it('zoneDayKey reads the calendar date the zone is on, not the one UTC is on', () => {
    const lateEvening = Date.UTC(2026, 6, 31, 2, 0, 0) // 02:00Z on the 31st…
    expect(utcDayKey(lateEvening)).toBe('2026-07-31')
    expect(zoneDayKey(lateEvening, -300)).toBe('2026-07-30') // …is still Thursday evening in Chicago
    expect(zoneDayKey(lateEvening, 330)).toBe('2026-07-31') // Kolkata is already well into the 31st
  })

  /**
   * The regression this exists for: the RPC cuts days on p_tz (0021), and fillDaily zero-fills a
   * window it builds itself. If the two use different calendars the keys never match and a full
   * chart renders as an unbroken row of zeroes — a silent, total misread, not a visible error.
   */
  it('builds the zero-fill window on the SAME clock the server bucketed on', () => {
    const lateEvening = Date.UTC(2026, 6, 31, 2, 0, 0) // 21:00 Jul 30 in Chicago
    expect(lastNDays(3, lateEvening, -300)).toEqual(['2026-07-28', '2026-07-29', '2026-07-30'])
    expect(lastNDays(3, lateEvening, 0)).toEqual(['2026-07-29', '2026-07-30', '2026-07-31'])
  })

  it('fills a Chicago-bucketed payload without dropping its newest day', () => {
    const lateEvening = Date.UTC(2026, 6, 31, 2, 0, 0)
    const rows: DailyRow[] = [
      { day: '2026-07-30', devices: 4, signed_in: 1, sessions: 5, events: 40, app_opens: 5, standalone_opens: 2, new_devices: 1 },
    ]
    const filled = fillDaily(rows, 2, lateEvening, -300)
    expect(filled.map(d => d.day)).toEqual(['2026-07-29', '2026-07-30'])
    expect(filled[1].devices).toBe(4) // the server's newest row is IN the window, not past its end
  })

  it('walks calendar dates across a DST seam — no duplicated or skipped day', () => {
    const afterSpringForward = Date.UTC(2026, 2, 10, 12, 0, 0) // US spring-forward was Mar 8
    const week = lastNDays(5, afterSpringForward, -300)
    expect(week).toEqual(['2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
    expect(new Set(week).size).toBe(5)
  })
})

describe('rates and the wall detector', () => {
  it('share/winPct return null on a zero denominator — never NaN into the DOM', () => {
    expect(share(3, 0)).toBeNull()
    expect(winPct(level({ starts: 5, quits: 5 }))).toBeNull() // quits are not decisions
    expect(winPct(level({ wins: 1, fails: 3 }))).toBe(25)
  })

  it('flags a low win rate only past the sample floor', () => {
    const wall = level({ level: 21, wins: 2, fails: 8 }) // 20% over 10 decided
    const unluckyEvening = level({ level: 22, wins: 1, fails: 3 }) // 25% but only 4 decided
    const fine = level({ level: 23, wins: 8, fails: 2 }) // 80%
    expect(wallLevels([wall, unluckyEvening, fine]).map(r => r.level)).toEqual([21])
  })

  it('a level failed constantly at exactly the threshold is included (≤, not <)', () => {
    const edge = level({ level: 9, wins: 4, fails: 6 }) // exactly 40% over 10
    expect(wallLevels([edge]).map(r => r.level)).toEqual([9])
  })
})

describe('formatting', () => {
  it('follows the stat-tile figure spec: commas to four digits, then compact', () => {
    expect(fmtCompact(0)).toBe('0')
    expect(fmtCompact(1284)).toBe('1,284')
    expect(fmtCompact(9999)).toBe('9,999')
    expect(fmtCompact(12_940)).toBe('12.9K')
    expect(fmtCompact(20_000)).toBe('20K')
    expect(fmtCompact(4_200_000)).toBe('4.2M')
  })

  it('fmtPct renders null as an em dash — "no data" must not read as 0%', () => {
    expect(fmtPct(null)).toBe('—')
    expect(fmtPct(62.4)).toBe('62%')
    expect(fmtPct(62.44, 1)).toBe('62.4%')
  })

  it('fmtDayLabel is UTC (a local-time render would shift the label across midnight)', () => {
    expect(fmtDayLabel('2026-07-30')).toBe('Jul 30')
    expect(fmtDayLabel('garbage')).toBe('garbage')
  })

  it('fmtAgo buckets coarsely and never throws on junk', () => {
    const now = Date.UTC(2026, 6, 30, 12, 0, 0)
    expect(fmtAgo(new Date(now - 30_000).toISOString(), now)).toBe('just now')
    expect(fmtAgo(new Date(now - 45 * 60_000).toISOString(), now)).toBe('45m ago')
    expect(fmtAgo(new Date(now - 5 * 3_600_000).toISOString(), now)).toBe('5h ago')
    expect(fmtAgo(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3d ago')
    expect(fmtAgo('nope', now)).toBe('')
  })
})

describe('chart geometry', () => {
  it('niceTicks snaps to clean steps, starts at 0, covers max', () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]) // the percent axis
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
    expect(niceTicks(10)).toEqual([0, 5, 10]) // 2.5 would be a fractional session — snap past it
    const t = niceTicks(1234)
    expect(t[0]).toBe(0)
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(1234)
  })

  it('an empty chart still gets a frame', () => {
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(-5)).toEqual([0, 1])
  })

  it('linePath emits one M then Ls', () => {
    const d = linePath([0, 5, 10], i => i * 10, v => 100 - v)
    expect(d).toBe('M0 100 L10 95 L20 90')
  })

  it('roundedTopRect rounds only the data end and clamps the radius', () => {
    // Wide bar: starts at the baseline, curves only at the top.
    const d = roundedTopRect(0, 0, 20, 30, 4)
    expect(d.startsWith('M0 30')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect((d.match(/Q/g) ?? []).length).toBe(2)
    // Sliver bar: radius clamps to half the width, and the path stays finite.
    expect(roundedTopRect(0, 0, 3, 30, 4)).toContain('Q0 0 1.5 0')
    // Bar shorter than the radius: clamps to the height.
    expect(roundedTopRect(0, 29, 20, 1, 4)).toContain('L0 30')
  })
})

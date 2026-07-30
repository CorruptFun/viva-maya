import { describe, expect, it } from 'vitest'
import { EVENTS } from '../core/analytics'
import {
  buildFunnels,
  coerceAnalytics,
  fillDaily,
  fillHourly,
  fmtAgo,
  fmtCompact,
  fmtDayLabel,
  fmtPct,
  FUNNEL_DEFS,
  lastNDays,
  linePath,
  niceTicks,
  roundedTopRect,
  share,
  unexpectedCounts,
  utcDayKey,
  wallLevels,
  winPct,
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

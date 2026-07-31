/**
 * Pure data layer for the owner analytics dashboard (stats.html).
 *
 * Everything here is Phaser-free, DOM-free and side-effect-free so it can be unit-tested the same
 * way core/ is (model.test.ts). The split mirrors the game's own core/view divide: main.ts wires
 * the page, charts.ts draws, THIS file decides what the numbers mean.
 *
 * The input is the jsonb returned by admin_analytics (0014). That payload crosses a trust seam —
 * not because the server is hostile, but because SQL and TypeScript drift independently and a
 * dashboard that throws on one missing key is a dashboard that shows nothing. So the shape is
 * coerced field-by-field with defaults, the same shape-tolerance contract core/save.ts uses.
 * String fields (face, surface, version, event names) additionally originate from UNTRUSTED
 * clients (0010's trust model: anyone can insert), so renderers must treat them as text, never
 * markup — charts.ts/main.ts only ever put them in the DOM via textContent.
 */

import { EVENTS } from '../core/analytics'
import { PLINKO_ENDLESS_SLOTS, PLINKO_SLOTS } from '../core/plinko'

// ---------------------------------------------------------------------------- payload types

export interface Totals {
  devices: number
  signed_in: number
  sessions: number
  events: number
  app_opens: number
  standalone_opens: number
  new_devices: number
}

export interface DailyRow {
  /** UTC day, 'YYYY-MM-DD' — the same bucketing as events_daily (0010). The race day is NOT this
   *  clock: it anchors to America/Edmonton (0013_race_day), 6–7 hours behind these buckets. */
  day: string
  devices: number
  signed_in: number
  sessions: number
  events: number
  app_opens: number
  standalone_opens: number
  new_devices: number
}

export interface HourlyRow {
  hour: number
  sessions: number
  events: number
}

export interface CountRow {
  name: string
  events: number
  devices: number
}

export interface LevelRow {
  level: number
  starts: number
  wins: number
  fails: number
  fails_moves: number
  fails_lives: number
  quits: number
  continues_shown: number
  continues_taken: number
  devices: number
}

export interface DealPanel {
  offers: number
  wins: number
  fast_wins: number
  charms: number
  avg_flips: number | null
  streaks: { streak: number; count: number }[]
  faces: { face: string; count: number }[]
}

/**
 * `modes` splits the drop by which weight table produced it (0022). The two boards are tuned to
 * different ×10 edge rates — 6% on numbered levels, 8% in endless — so `slots` alone, which pools
 * them, cannot confirm either: a pooled rate somewhere between the two is consistent with both.
 * `topPct` is the field reading to compare against those targets.
 *
 * `mode` carries a third value, 'unknown', for events whose `endless` prop is missing or not a
 * boolean. It should always be zero — every plinko_played event sends the prop — so a non-zero
 * unknown row is a signal, not noise, and is rendered rather than filtered.
 *
 * Empty on any payload from before 0022. That is a real state, not an error: the RPC and this client
 * deploy independently, so a cached dashboard may be talking to the new function and vice versa.
 */
export interface PlinkoModeRow {
  mode: string
  played: number
  topHits: number
  avgMult: number | null
  /** topHits/played as a percentage, or null when nothing has been played — never a fabricated 0. */
  topPct: number | null
}

export interface PlinkoPanel {
  offered: number
  played: number
  slots: { slot: number; count: number; avg_payout: number | null }[]
  modes: PlinkoModeRow[]
}

/**
 * The ×10 edge share a board is TUNED to, as a percentage — the target `topPct` should converge on.
 *
 * DERIVED from the shipped weight tables rather than written down, because a hardcoded 6/8 here is a
 * number that goes quietly wrong the next time someone retunes the drop, and a dashboard confidently
 * comparing live data against a stale target is worse than one showing no target at all.
 *
 * Returns null for 'unknown' (and any mode this client does not recognise): there is no board behind
 * it, so there is nothing to aim at.
 */
export function plinkoTargetPct(mode: string): number | null {
  const table = mode === 'endless' ? PLINKO_ENDLESS_SLOTS : mode === 'numbered' ? PLINKO_SLOTS : null
  if (!table) return null
  const total = table.reduce((s, p) => s + p.weight, 0)
  if (total <= 0) return null
  const top = table.filter(p => p.kind === 'mult' && p.mult >= 10).reduce((s, p) => s + p.weight, 0)
  return (top / total) * 100
}

export interface ShareRow {
  surface: string
  count: number
}

export interface VersionRow {
  version: string
  devices: number
  events: number
  first_seen: string
  last_seen: string
}

export interface RetentionSide {
  /** Devices whose day0+N has fully elapsed — the honest denominator. */
  eligible: number
  returned: number
}

export interface CohortRow {
  day: string
  cohort: number
  d1: number
  d7: number
  d1_ready: boolean
  d7_ready: boolean
}

export interface RetentionPanel {
  d1: RetentionSide
  d7: RetentionSide
  cohorts: CohortRow[]
}

export interface SessionsPanel {
  total: number
  median_seconds: number
  bounces: number
  /** Sparse {b: 0..4, count} — see SESSION_BUCKETS for the labels. */
  buckets: { b: number; count: number }[]
}

export interface ErrorRow {
  message: string
  count: number
  devices: number
  versions: string[]
  last_seen: string
}

export interface ErrorsPanel {
  events: number
  devices: number
  top: ErrorRow[]
}

export interface Analytics {
  meta: { days: number; since: string; generated_at: string }
  totals: Totals
  daily: DailyRow[]
  hourly: HourlyRow[]
  counts: CountRow[]
  levels: LevelRow[]
  retention: RetentionPanel
  sessions: SessionsPanel
  errors: ErrorsPanel
  deal: DealPanel
  plinko: PlinkoPanel
  shares: ShareRow[]
  versions: VersionRow[]
}

// ---------------------------------------------------------------------------- coercion

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function retentionSide(v: unknown): RetentionSide {
  const o = obj(v)
  return { eligible: num(o.eligible), returned: num(o.returned) }
}

/** Shape-tolerant read of the admin_analytics payload. Any missing/miscast piece becomes an empty
 *  default — which is also what a pre-0015 server's payload (no retention/sessions/errors keys)
 *  coerces to, so the dashboard degrades to its 0014 panels instead of breaking. */
export function coerceAnalytics(raw: unknown): Analytics {
  const r = obj(raw)
  const meta = obj(r.meta)
  const t = obj(r.totals)
  const deal = obj(r.deal)
  const plinko = obj(r.plinko)
  const retention = obj(r.retention)
  const sessions = obj(r.sessions)
  const errors = obj(r.errors)
  return {
    meta: {
      days: num(meta.days, 14),
      since: str(meta.since),
      generated_at: str(meta.generated_at),
    },
    totals: {
      devices: num(t.devices),
      signed_in: num(t.signed_in),
      sessions: num(t.sessions),
      events: num(t.events),
      app_opens: num(t.app_opens),
      standalone_opens: num(t.standalone_opens),
      new_devices: num(t.new_devices),
    },
    daily: arr(r.daily).map(d => {
      const o = obj(d)
      return {
        day: str(o.day),
        devices: num(o.devices),
        signed_in: num(o.signed_in),
        sessions: num(o.sessions),
        events: num(o.events),
        app_opens: num(o.app_opens),
        standalone_opens: num(o.standalone_opens),
        new_devices: num(o.new_devices),
      }
    }),
    hourly: arr(r.hourly).map(h => {
      const o = obj(h)
      return { hour: num(o.hour, -1), sessions: num(o.sessions), events: num(o.events) }
    }),
    counts: arr(r.counts).map(c => {
      const o = obj(c)
      return { name: str(o.name, '?'), events: num(o.events), devices: num(o.devices) }
    }),
    levels: arr(r.levels).map(l => {
      const o = obj(l)
      return {
        level: num(o.level, -1),
        starts: num(o.starts),
        wins: num(o.wins),
        fails: num(o.fails),
        fails_moves: num(o.fails_moves),
        fails_lives: num(o.fails_lives),
        quits: num(o.quits),
        continues_shown: num(o.continues_shown),
        continues_taken: num(o.continues_taken),
        devices: num(o.devices),
      }
    }),
    retention: {
      d1: retentionSide(retention.d1),
      d7: retentionSide(retention.d7),
      cohorts: arr(retention.cohorts).map(c => {
        const o = obj(c)
        return {
          day: str(o.day),
          cohort: num(o.cohort),
          d1: num(o.d1),
          d7: num(o.d7),
          d1_ready: o.d1_ready === true,
          d7_ready: o.d7_ready === true,
        }
      }),
    },
    sessions: {
      total: num(sessions.total),
      median_seconds: num(sessions.median_seconds),
      bounces: num(sessions.bounces),
      buckets: arr(sessions.buckets).map(b => {
        const o = obj(b)
        return { b: num(o.b, -1), count: num(o.count) }
      }),
    },
    errors: {
      events: num(errors.events),
      devices: num(errors.devices),
      top: arr(errors.top).map(e => {
        const o = obj(e)
        return {
          message: str(o.message, '?'),
          count: num(o.count),
          devices: num(o.devices),
          versions: arr(o.versions).map(v => str(v, '?')),
          last_seen: str(o.last_seen),
        }
      }),
    },
    deal: {
      offers: num(deal.offers),
      wins: num(deal.wins),
      fast_wins: num(deal.fast_wins),
      charms: num(deal.charms),
      avg_flips: numOrNull(deal.avg_flips),
      streaks: arr(deal.streaks).map(s => {
        const o = obj(s)
        return { streak: num(o.streak, -1), count: num(o.count) }
      }),
      faces: arr(deal.faces).map(f => {
        const o = obj(f)
        return { face: str(o.face, '?'), count: num(o.count) }
      }),
    },
    plinko: {
      offered: num(plinko.offered),
      played: num(plinko.played),
      slots: arr(plinko.slots).map(s => {
        const o = obj(s)
        return { slot: num(o.slot, -1), count: num(o.count), avg_payout: numOrNull(o.avg_payout) }
      }),
      // Absent on any pre-0022 payload — `arr` yields [] and the panel simply does not render.
      modes: arr(plinko.modes).map(m => {
        const o = obj(m)
        const played = num(o.played)
        const topHits = num(o.top_hits)
        return {
          mode: str(o.mode, 'unknown'),
          played,
          topHits,
          avgMult: numOrNull(o.avg_mult),
          // Zero denominator is "no data", never 0% — the honest-denominator rule.
          topPct: played > 0 ? (topHits / played) * 100 : null,
        }
      }),
    },
    shares: arr(r.shares).map(s => {
      const o = obj(s)
      return { surface: str(o.surface, '?'), count: num(o.count) }
    }),
    versions: arr(r.versions).map(v => {
      const o = obj(v)
      return {
        version: str(o.version, '?'),
        devices: num(o.devices),
        events: num(o.events),
        first_seen: str(o.first_seen),
        last_seen: str(o.last_seen),
      }
    }),
  }
}

// ---------------------------------------------------------------------------- time series shaping

/** Epoch ms → UTC 'YYYY-MM-DD'. The zero-offset case of `zoneDayKey`, which is what the RPC still
 *  returns whenever no p_tz is asked for (0021).
 *  NOTE: the RACE day is a different clock on purpose (America/Edmonton since 0013_race_day). */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The n day keys ending on (and including) `nowMs`'s day in a zone `offsetMinutes` ahead of UTC,
 * oldest first. This MUST agree with the clock the RPC bucketed on (0021's p_tz) — a window built
 * on a different calendar misses every row and renders the whole chart as zeroes.
 *
 * Walks calendar dates rather than subtracting 86.4e6 ms per step: across a DST seam a fixed-length
 * day duplicates one date and skips another, which is exactly the kind of gap that reads as "nobody
 * played that day".
 */
export function lastNDays(n: number, nowMs: number, offsetMinutes = 0): string[] {
  const [y, m, d] = zoneDayKey(nowMs, offsetMinutes).split('-').map(Number)
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) out.push(utcDayKey(Date.UTC(y, m - 1, d - i)))
  return out
}

const EMPTY_DAY: Omit<DailyRow, 'day'> = {
  devices: 0,
  signed_in: 0,
  sessions: 0,
  events: 0,
  app_opens: 0,
  standalone_opens: 0,
  new_devices: 0,
}

/**
 * Zero-fill the daily series onto a contiguous window ending today. The RPC only returns days that
 * HAVE events, but a chart that skips silent days would hide exactly the thing a retention chart
 * exists to show — the silence. (The first bucket can be partial: the window opens days×24h ago,
 * not at that day's midnight.)
 */
export function fillDaily(rows: DailyRow[], days: number, nowMs: number, offsetMinutes = 0): DailyRow[] {
  const byDay = new Map(rows.map(r => [r.day, r]))
  return lastNDays(days, nowMs, offsetMinutes).map(day => byDay.get(day) ?? { day, ...EMPTY_DAY })
}

/** Zero-fill all 24 UTC hours (the RPC omits hours with no events). */
export function fillHourly(rows: HourlyRow[]): HourlyRow[] {
  const byHour = new Map(rows.map(r => [r.hour, r]))
  return Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, sessions: 0, events: 0 })
}

// ---------------------------------------------------------------------------- the viewer's clock

/**
 * The zone the dashboard renders wall-clock times in — whatever the browser says it is sitting in.
 * The server keeps bucketing in UTC (0014/0015) and that does not change; this is a READ-SIDE
 * relabel so the owner stops converting hours in their head.
 *
 * Falls back to UTC when the runtime will not answer, which also makes every function below safe to
 * call under a test runner or a headless build with no zone database.
 */
export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Minutes `zone` runs AHEAD of UTC at instant `ms` — America/Chicago is -300 in July and -360 in
 * January. Resolved per-instant rather than from a constant precisely because that pair exists: a
 * hard-coded -360 for "CST" is wrong for two thirds of the year.
 */
export function zoneOffsetMinutes(zone: string, ms: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const p: Record<string, string> = {}
    for (const { type, value } of parts) p[type] = value
    // %24 guards the engines that still render midnight as hour "24" under an h23 cycle.
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
    if (!Number.isFinite(wall)) return 0
    return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000)
  } catch {
    return 0
  }
}

/** Short zone name for headings — 'CDT', 'UTC', or a 'GMT+5:30' style fallback where there is no
 *  abbreviation. Every heading that shows an hour carries one of these; an unlabelled hour on a
 *  dashboard read from two timezones is exactly the ambiguity this whole section exists to remove. */
export function zoneAbbr(zone: string, ms: number): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(
      new Date(ms)
    )
    return parts.find(p => p.type === 'timeZoneName')?.value || zone
  } catch {
    return zone
  }
}

/** Whole hours to rotate a UTC histogram by to land in a zone `offsetMinutes` ahead of UTC. */
function hourShift(offsetMinutes: number): number {
  return Math.round(offsetMinutes / 60)
}

/** A UTC hour-of-day read as a wall-clock hour in a zone `offsetMinutes` ahead of UTC. */
export function hourInZone(utcHour: number, offsetMinutes: number): number {
  return (((utcHour + hourShift(offsetMinutes)) % 24) + 24) % 24
}

/**
 * NOTE ON WHERE BUCKETING HAPPENS. Nothing here re-buckets. Since 0021 the RPC takes `p_tz` and
 * cuts days, hours, retention and new-device firsts on that one clock, so this file's job is to
 * decide which zone to ask for and to label what comes back.
 *
 * The browser could rotate the 24 hour buckets itself — that much is only a relabel — but it could
 * never re-cut a DAY bucket, because those are count(distinct device_id) and the raw rows never
 * leave the database. Doing hours here and days there would have put two clocks in one payload.
 * One clock, chosen by the caller, is the whole point.
 *
 * `zoneDayKey` below still matters on this side: the zero-fill window has to be built from the
 * SAME calendar the server bucketed on, or every day misses its row and the chart reads as silence.
 */

/** Epoch ms → 'YYYY-MM-DD' as read in a zone `offsetMinutes` ahead of UTC. */
export function zoneDayKey(ms: number, offsetMinutes: number): string {
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------- rates & walls

/** n/d as a 0..100 percentage, or null when the denominator is zero (never NaN into the DOM). */
export function share(n: number, d: number): number | null {
  return d > 0 ? (100 * n) / d : null
}

/** Win rate per level — wins / (wins + fails), the SAME denominator events_level_funnel (0010)
 *  uses, so the dashboard and the SQL view can never disagree about what a wall is. Quits are
 *  deliberately not decisions: backing out mid-level reads very differently from losing. */
export function winPct(r: LevelRow): number | null {
  return share(r.wins, r.wins + r.fails)
}

export interface WallOptions {
  /** Minimum decided attempts (wins+fails) before a rate is believed at all. */
  minDecided: number
  /** A win rate at or below this, with enough sample, flags the level. */
  maxPct: number
}

export const WALL_DEFAULTS: WallOptions = { minDecided: 6, maxPct: 40 }

/**
 * The wall detector — the question 0010 was commissioned to answer ("is level 21 a wall?"). A level
 * is flagged when enough attempts were DECIDED there and the win rate is low. The sample floor is
 * what keeps a single unlucky evening from lighting the chart up red; docs/ANALYTICS_AND_PUSH.md's
 * "give it a week" warning applies to reading these flags too.
 */
export function wallLevels(levels: LevelRow[], opts: WallOptions = WALL_DEFAULTS): LevelRow[] {
  return levels.filter(r => {
    const pct = winPct(r)
    return r.wins + r.fails >= opts.minDecided && pct !== null && pct <= opts.maxPct
  })
}

// ---------------------------------------------------------------------------- funnels

export interface FunnelStep {
  name: string
  label: string
  events: number
  devices: number
  /** % of the funnel's first step, or null when the first step is 0. */
  pctOfFirst: number | null
  /** % of the previous step, or null on the first step / zero previous. */
  pctOfPrev: number | null
}

export interface Funnel {
  id: string
  title: string
  /** One-line reading aid rendered under the title. */
  note?: string
  steps: FunnelStep[]
  /** Extra non-step counts worth showing beside the funnel (e.g. push_blocked). */
  aside: { label: string; events: number }[]
}

interface FunnelDef {
  id: string
  title: string
  note?: string
  steps: { name: string; label: string }[]
  aside?: { name: string; label: string }[]
}

/**
 * The funnel vocabulary, pinned to EVENTS (core/analytics.ts) so a renamed event breaks the
 * dashboard at compile time instead of silently flatlining a chart.
 */
export const FUNNEL_DEFS: FunnelDef[] = [
  {
    id: 'signin',
    title: 'Google sign-in',
    steps: [
      { name: EVENTS.SIGNIN_SHOWN, label: 'Offer seen' },
      { name: EVENTS.SIGNIN_STARTED, label: 'Started' },
      { name: EVENTS.SIGNIN_COMPLETED, label: 'Completed' },
    ],
  },
  {
    id: 'install',
    title: 'PWA install',
    note: 'Installs are believed to predict retention — this is the test.',
    steps: [
      { name: EVENTS.INSTALL_SHOWN, label: 'Nudge seen' },
      { name: EVENTS.INSTALL_ACCEPTED, label: 'Accepted' },
    ],
  },
  {
    id: 'push',
    title: 'Push opt-in',
    steps: [
      { name: EVENTS.PUSH_SHOWN, label: 'Offer seen' },
      { name: EVENTS.PUSH_ENABLED, label: 'Enabled' },
    ],
    aside: [{ name: EVENTS.PUSH_BLOCKED, label: 'Blocked' }],
  },
  {
    id: 'continue',
    title: 'Out-of-moves continue',
    note: 'Decline rate per level is in the levels table — high decline near the goal means the price is wrong.',
    steps: [
      { name: EVENTS.CONTINUE_SHOWN, label: 'Offered' },
      { name: EVENTS.CONTINUE_TAKEN, label: 'Taken' },
    ],
  },
  {
    id: 'referral',
    title: 'Invites',
    note: 'Capture/registration happen on the invitee’s device, so steps can cross sessions.',
    steps: [
      { name: EVENTS.SHARE_CLICKED, label: 'Share tapped' },
      { name: EVENTS.REFERRAL_CAPTURED, label: 'Link captured' },
      { name: EVENTS.REFERRAL_REGISTERED, label: 'Registered' },
    ],
  },
  {
    id: 'update',
    title: 'Update toast',
    steps: [
      { name: EVENTS.UPDATE_SHOWN, label: 'Toast seen' },
      { name: EVENTS.UPDATE_APPLIED, label: 'Applied' },
    ],
  },
  {
    id: 'deal',
    title: 'Lucky Deal',
    steps: [
      { name: EVENTS.DEAL_OFFERED, label: 'Dealt' },
      { name: EVENTS.DEAL_WON, label: 'Played out' },
    ],
  },
  {
    id: 'plinko',
    title: 'Plinko',
    steps: [
      { name: EVENTS.PLINKO_OFFERED, label: 'Offered' },
      { name: EVENTS.PLINKO_PLAYED, label: 'Dropped' },
    ],
  },
]

/** Index the counts list by event name for O(1) funnel assembly. */
export function countsByName(counts: CountRow[]): Map<string, CountRow> {
  return new Map(counts.map(c => [c.name, c]))
}

/** Assemble every funnel from the window's per-event counts. */
export function buildFunnels(counts: CountRow[]): Funnel[] {
  const by = countsByName(counts)
  return FUNNEL_DEFS.map(def => {
    let first = 0
    let prev = 0
    const steps = def.steps.map((s, i) => {
      const row = by.get(s.name)
      const events = row?.events ?? 0
      const devices = row?.devices ?? 0
      if (i === 0) first = events
      const step: FunnelStep = {
        name: s.name,
        label: s.label,
        events,
        devices,
        pctOfFirst: i === 0 ? null : share(events, first),
        pctOfPrev: i === 0 ? null : share(events, prev),
      }
      prev = events
      return step
    })
    const aside = (def.aside ?? []).map(a => ({ label: a.label, events: by.get(a.name)?.events ?? 0 }))
    return { id: def.id, title: def.title, note: def.note, steps, aside }
  })
}

/** Names on the wire that the dashboard has no definition for — a typo'd client, the guard's
 *  'unknown' bucket, or an event added without updating FUNNEL_DEFS/KNOWN. Surfaced, never dropped:
 *  a visible oddity is how a mistake gets noticed (same philosophy as the 0010 guard). */
export function unexpectedCounts(counts: CountRow[]): CountRow[] {
  const known = new Set<string>(Object.values(EVENTS))
  return counts.filter(c => !known.has(c.name))
}

// ---------------------------------------------------------------------------- formatting

/** Stat-tile numbers: 1,284 · 12.9K · 4.2M (compact only from five digits up, per the tile spec). */
export function fmtCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return trimZero(n / 1_000_000) + 'M'
  if (abs >= 10_000) return trimZero(n / 1_000) + 'K'
  return n.toLocaleString('en-US')
}
function trimZero(x: number): string {
  const s = x.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

/** 0..100 → '62%' (or '—' for null: a zero denominator is "no data", never "0%"). */
export function fmtPct(pct: number | null, digits = 0): string {
  return pct === null ? '—' : `${pct.toFixed(digits)}%`
}

/** 'YYYY-MM-DD' → 'Jul 24' (UTC, matching the buckets). Unparseable input passes through. */
export function fmtDayLabel(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(t)) return day
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/** Bucket labels for SessionsPanel.buckets — index-aligned with the SQL CASE in 0015. */
export const SESSION_BUCKETS = ['<1 min', '1–3 min', '3–10 min', '10–30 min', '30 min+'] as const

/** Densify the sparse {b, count} list into the five fixed slots (unknown indices are dropped). */
export function sessionBucketCounts(p: SessionsPanel): number[] {
  const out = [0, 0, 0, 0, 0]
  for (const { b, count } of p.buckets) if (b >= 0 && b < out.length) out[b] = count
  return out
}

/** Seconds → '45s' / '4m 32s' / '1h 12m'. Sub-second and negative junk clamp to '0s'. */
export function fmtDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

/** Coarse relative time for table cells ('3h ago'). Unparseable → ''. */
export function fmtAgo(iso: string, nowMs: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((nowMs - t) / 60_000)
  if (mins < 2) return 'just now'
  if (mins < 90) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 36) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// ---------------------------------------------------------------------------- chart geometry (pure)

/**
 * Clean axis ticks 0..≥max: steps snap to 1/2/5×10ⁿ so the labels read as counting, not noise.
 * Always includes 0; the last tick is the first clean step at or above max. max<=0 → [0, 1] so an
 * empty chart still has a frame.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const rawStep = max / target
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  // 2.5× only when the resulting step is still an integer (mag ≥ 10): a percent axis gets
  // 0/25/50/75/100, but a small count axis must never tick at "2.5 sessions".
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 && mag >= 10 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const out: number[] = []
  for (let v = 0; v < max + step; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

/** Polyline path for a zero-filled series: 'M x0 y0 L x1 y1 …'. Coordinates are rounded to 0.1px
 *  to keep the d attribute small. */
export function linePath(values: number[], x: (i: number) => number, y: (v: number) => number): string {
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${round1(x(i))} ${round1(y(v))}`)
    .join(' ')
}

/** Bar with a 4px-rounded DATA end and a square baseline end (the mark spec) — as an SVG path. */
export function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  const x2 = x + w
  return (
    `M${round1(x)} ${round1(y + h)} ` +
    `L${round1(x)} ${round1(y + rr)} Q${round1(x)} ${round1(y)} ${round1(x + rr)} ${round1(y)} ` +
    `L${round1(x2 - rr)} ${round1(y)} Q${round1(x2)} ${round1(y)} ${round1(x2)} ${round1(y + rr)} ` +
    `L${round1(x2)} ${round1(y + h)} Z`
  )
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

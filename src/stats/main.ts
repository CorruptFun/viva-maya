/**
 * Owner analytics dashboard — the page behind stats.html.
 *
 * A SECOND Vite entry, not a route in the game: it ships zero Phaser and the game ships zero
 * dashboard (vite.config input + PWA precache excludes). It lives on the game's own origin so the
 * owner's existing Google session (core/cloud.ts signs in with persistSession on, default storage
 * key) is already here — opening the page while signed in to the game just works, and the OAuth
 * redirect back to stats.html is inside the `…/viva-maya/**` allow-list documented in
 * docs/CLOUD_SAVE_GOOGLE_SIGNIN.md.
 *
 * All reading goes through ONE RPC, admin_analytics (0014): the events table itself has no SELECT
 * policy and never will (0010), the service key never touches a browser, and whether THIS user may
 * read is decided server-side against app_admins. The page holds nothing secret — a stranger who
 * finds it gets a sign-in button and a 403.
 *
 * Unlike core/analytics.ts this file is allowed to SHOW errors — the audience is the owner, and
 * "broken and saying so" beats "quietly empty" here.
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { columnChart, dataTable, el, legend, lineChart, type ColumnDatum, type TipRow } from './charts'
import {
  buildFunnels,
  coerceAnalytics,
  fillDaily,
  fillHourly,
  fmtAgo,
  fmtCompact,
  fmtDayLabel,
  fmtPct,
  share,
  unexpectedCounts,
  WALL_DEFAULTS,
  wallLevels,
  winPct,
  type Analytics,
  type Funnel,
  type LevelRow,
} from './model'
import './stats.css'

const env = import.meta.env as unknown as Record<string, string | undefined>
const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_KEY = env.VITE_SUPABASE_ANON_KEY

const root = document.getElementById('stats') as HTMLElement

const WINDOWS = [7, 14, 30, 90]
let days = 14
let data: Analytics | null = null

// ---------------------------------------------------------------------------- supabase client

let clientPromise: Promise<SupabaseClient> | null = null

/** Same lazy-import shape as core/cloud.ts, and crucially the same default auth storage key — that
 *  is what lets this page reuse the session the game established. */
function sb(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(m =>
      m.createClient(SUPABASE_URL as string, SUPABASE_KEY as string, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    )
  }
  return clientPromise
}

// ---------------------------------------------------------------------------- shell pieces

function masthead(session: Session | null): HTMLElement {
  const head = el('div', 'masthead')
  const h1 = el('h1')
  h1.append('VIVA MAYA ')
  h1.appendChild(el('span', 'heart', '❤'))
  h1.append(' ANALYTICS')
  head.appendChild(h1)
  if (session) {
    const who = el('div', 'who')
    who.appendChild(el('span', undefined, session.user.email ?? session.user.id))
    const out = el('button', 'ghost', 'Sign out')
    out.addEventListener('click', () => {
      void (async () => {
        await (await sb()).auth.signOut()
      })()
    })
    who.appendChild(out)
    head.appendChild(who)
  }
  return head
}

function page(session: Session | null, ...children: HTMLElement[]): void {
  root.replaceChildren(masthead(session), ...children)
}

function notice(title: string, body: string, extra?: HTMLElement): HTMLElement {
  const card = el('div', 'notice')
  card.appendChild(el('h2', undefined, title))
  card.appendChild(el('p', undefined, body))
  if (extra) card.appendChild(extra)
  return card
}

// ---------------------------------------------------------------------------- states

function renderUnconfigured(): void {
  page(
    null,
    notice(
      'Analytics isn’t configured on this build',
      'This page needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY at build time — the same pair the game’s cloud save uses. Locally: put them in .env.local and restart the dev server.'
    )
  )
}

function renderSignedOut(): void {
  const btn = el('button', 'primary', 'Sign in with Google')
  btn.addEventListener('click', () => {
    void (async () => {
      const c = await sb()
      await c.auth.signInWithOAuth({
        provider: 'google',
        // Return to THIS page (hash stripped) — covered by the …/viva-maya/** redirect allow-list.
        options: { redirectTo: window.location.href.split('#')[0] },
      })
    })()
  })
  page(
    null,
    notice(
      'Owner dashboard',
      'Gameplay analytics for Viva Maya. Sign in with an admin Google account to view — the data is unreadable without one (admin_analytics, 0014).',
      btn
    )
  )
}

function renderNotAdmin(session: Session): void {
  const code = el('code')
  code.textContent =
    `-- Run in the Supabase SQL editor to grant this account access:\n` +
    `insert into public.app_admins (user_id, note)\n` +
    `values ('${session.user.id.replace(/[^0-9a-f-]/gi, '')}', 'owner')\n` +
    `on conflict (user_id) do nothing;`
  page(
    session,
    notice(
      'This account isn’t an analytics admin',
      `You’re signed in as ${session.user.email ?? session.user.id}, but only accounts listed in app_admins can read the aggregates. If this is your owner account, add it (one-time, SQL editor — the API can’t write that table):`,
      code
    )
  )
}

function renderError(session: Session, message: string): void {
  const retry = el('button', 'primary', 'Retry')
  retry.addEventListener('click', () => void route())
  page(session, notice('Couldn’t load analytics', message, retry))
}

// ---------------------------------------------------------------------------- dashboard sections

function statTile(label: string, value: string, sub?: string): HTMLElement {
  const card = el('div', 'card tile')
  card.appendChild(el('div', 'tile-label', label))
  card.appendChild(el('div', 'tile-value', value))
  if (sub) card.appendChild(el('div', 'tile-sub', sub))
  return card
}

function chartCard(title: string, sub: string, ...children: HTMLElement[]): HTMLElement {
  const card = el('div', 'card')
  card.appendChild(el('h2', undefined, title))
  if (sub) card.appendChild(el('p', 'sub', sub))
  for (const c of children) card.appendChild(c)
  return card
}

function tableTwin(summary: string, table: HTMLTableElement): HTMLElement {
  const d = el('details')
  d.appendChild(el('summary', undefined, summary))
  const scroll = el('div', 'table-scroll')
  scroll.appendChild(table)
  d.appendChild(scroll)
  return d
}

function kpis(a: Analytics): HTMLElement {
  const t = a.totals
  const row = el('div', 'kpis')
  row.appendChild(
    statTile('Active devices', fmtCompact(t.devices), `${fmtCompact(t.new_devices)} new · ${fmtCompact(t.signed_in)} signed in`)
  )
  row.appendChild(
    statTile('Sessions', fmtCompact(t.sessions), t.devices > 0 ? `${(t.sessions / t.devices).toFixed(1)} per device` : undefined)
  )
  row.appendChild(
    statTile('Events', fmtCompact(t.events), t.sessions > 0 ? `${Math.round(t.events / t.sessions)} per session` : undefined)
  )
  row.appendChild(
    statTile('Installed opens', fmtPct(share(t.standalone_opens, t.app_opens)), `${fmtCompact(t.standalone_opens)} of ${fmtCompact(t.app_opens)} opens`)
  )
  row.appendChild(
    statTile('Sign-in share', fmtPct(share(t.signed_in, t.devices)), 'devices that were ever signed in')
  )
  return row
}

function dailyCard(a: Analytics): HTMLElement {
  const filled = fillDaily(a.daily, a.meta.days, Date.now())
  const labels = filled.map(d => fmtDayLabel(d.day))
  const chart = lineChart({
    series: [
      { label: 'Devices', colorVar: '--s1', values: filled.map(d => d.devices) },
      { label: 'Sessions', colorVar: '--s2', values: filled.map(d => d.sessions) },
      { label: 'New devices', colorVar: '--s3', values: filled.map(d => d.new_devices) },
    ],
    xLabels: labels,
  })
  const twin = dataTable(
    ['Day', 'Devices', 'New', 'Signed in', 'Sessions', 'Events', 'Opens', 'Installed opens'],
    filled.map(d => [d.day, d.devices, d.new_devices, d.signed_in, d.sessions, d.events, d.app_opens, d.standalone_opens])
  )
  return chartCard(
    'Daily actives',
    'Distinct devices per UTC day — the number that did not exist before 0010. The first day of the window can be partial.',
    legend([
      { label: 'Devices', colorVar: '--s1', kind: 'line' },
      { label: 'Sessions', colorVar: '--s2', kind: 'line' },
      { label: 'New devices', colorVar: '--s3', kind: 'line' },
    ]),
    chart,
    tableTwin('Table view', twin)
  )
}

function hourlyCard(a: Analytics): HTMLElement {
  const filled = fillHourly(a.hourly)
  const chart = columnChart({
    data: filled.map(h => ({ label: `${h.hour}:00`, value: h.sessions, tipRows: [{ label: 'events', value: fmtCompact(h.events) }] })),
    colorVar: '--s1',
    xTickEvery: 3,
    labelMax: true,
  })
  return chartCard(
    'Sessions by hour (UTC)',
    'When the game actually gets played — the push reminders currently go out at 01:00 UTC (evening in Alberta).',
    chart,
    tableTwin('Table view', dataTable(['Hour (UTC)', 'Sessions', 'Events'], filled.map(h => [`${h.hour}:00`, h.sessions, h.events])))
  )
}

function levelTip(r: LevelRow): TipRow[] {
  return [
    { label: 'starts', value: fmtCompact(r.starts) },
    { label: 'won / lost', value: `${fmtCompact(r.wins)} / ${fmtCompact(r.fails)}` },
    { label: 'fails: moves / lives', value: `${fmtCompact(r.fails_moves)} / ${fmtCompact(r.fails_lives)}` },
    { label: 'quit mid-level', value: fmtCompact(r.quits) },
    { label: 'continue shown / taken', value: `${fmtCompact(r.continues_shown)} / ${fmtCompact(r.continues_taken)}` },
    { label: 'devices reached', value: fmtCompact(r.devices) },
  ]
}

function levelsCard(a: Analytics): HTMLElement {
  const decided = a.levels.filter(r => r.wins + r.fails > 0)
  const walls = new Set(wallLevels(a.levels).map(r => r.level))
  const chart = columnChart({
    data: decided.map<ColumnDatum>(r => ({
      label: String(r.level),
      value: winPct(r) ?? 0,
      colorVar: walls.has(r.level) ? '--critical' : undefined,
      tipRows: levelTip(r),
    })),
    colorVar: '--s1',
    yMax: 100,
    yFmt: v => `${Math.round(v)}%`,
    labelMax: false,
  })
  const card = chartCard(
    'Win rate by level',
    'wins ÷ (wins + losses) per level — a wall is a rate that falls off a cliff and recovers after. Same maths as events_level_funnel, so the SQL view agrees.',
    chart
  )
  if (decided.length === 0) {
    card.appendChild(el('p', 'sub', 'No decided attempts in this window yet.'))
  }
  if (walls.size > 0) {
    const flag = el('div', 'flag')
    flag.appendChild(el('span', 'flag-swatch'))
    flag.appendChild(
      el(
        'span',
        undefined,
        `⚠ possible wall (≤${WALL_DEFAULTS.maxPct}% win rate over ≥${WALL_DEFAULTS.minDecided} decided): level ${[...walls].sort((x, y) => x - y).join(', ')}`
      )
    )
    card.appendChild(flag)
  }
  card.appendChild(
    tableTwin(
      'Table view (all level events)',
      dataTable(
        ['Level', 'Starts', 'Wins', 'Fails', '· moves', '· lives', 'Quits', 'Cont. shown', 'Cont. taken', 'Devices', 'Win %'],
        a.levels.map(r => [
          r.level,
          r.starts,
          r.wins,
          r.fails,
          r.fails_moves,
          r.fails_lives,
          r.quits,
          r.continues_shown,
          r.continues_taken,
          r.devices,
          fmtPct(winPct(r)),
        ])
      )
    )
  )
  return card
}

/** Horizontal labelled bars for small nominal breakdowns (funnels, faces, share surfaces). */
function barRows(rows: { label: string; count: number; pct?: string }[], colorVar = '--s1'): HTMLElement {
  const max = Math.max(1, ...rows.map(r => r.count))
  const box = el('div')
  for (const r of rows) {
    const step = el('div', 'fn-step')
    step.appendChild(el('span', 'fn-label', r.label))
    const meter = el('div', 'fn-meter')
    // The bar fills a FLEXIBLE track, so the count and conversion text keep their space at any
    // card width instead of being pushed off the edge by a 100%-of-meter bar.
    const track = el('div', 'fn-track')
    const bar = el('span', 'fn-bar')
    bar.style.width = `${Math.max(2, (r.count / max) * 100)}%`
    bar.style.background = `var(${colorVar})`
    track.appendChild(bar)
    meter.appendChild(track)
    meter.appendChild(el('span', 'fn-count', fmtCompact(r.count)))
    if (r.pct !== undefined) meter.appendChild(el('span', 'fn-pct', r.pct))
    step.appendChild(meter)
    box.appendChild(step)
  }
  return box
}

function funnelCard(f: Funnel): HTMLElement {
  const card = chartCard(
    f.title,
    f.note ?? '',
    barRows(
      f.steps.map(s => ({
        label: s.label,
        count: s.events,
        pct: s.pctOfPrev === null ? undefined : `${fmtPct(s.pctOfPrev)} of prev`,
      }))
    )
  )
  for (const aside of f.aside) {
    card.appendChild(el('div', 'fn-aside', `${aside.label}: ${fmtCompact(aside.events)}`))
  }
  return card
}

function dealCard(a: Analytics): HTMLElement {
  const d = a.deal
  const chart = columnChart({
    data: d.streaks.map(s => ({ label: String(s.streak), value: s.count })),
    colorVar: '--s1',
    labelMax: true,
    height: 150,
  })
  const facts = [
    d.avg_flips !== null ? `avg flips ${d.avg_flips} (model says ~7.5)` : null,
    d.wins > 0 ? `fast ${fmtPct(share(d.fast_wins, d.wins))}` : null,
    d.wins > 0 ? `charm ${fmtPct(share(d.charms, d.wins))}` : null,
  ].filter((s): s is string => s !== null)
  const card = chartCard(
    'Lucky Deal — trigger streaks',
    'Distribution of the win streak when a Deal fires. All mass at 3 = a loss resets almost everyone; a tail = players really string wins together.',
    chart
  )
  if (facts.length > 0) card.appendChild(el('div', 'fn-aside', facts.join(' · ')))
  if (d.faces.length > 0) {
    card.appendChild(el('h2', undefined, 'Winning faces'))
    card.appendChild(el('p', 'sub', 'The only field check on the luck-weighted table.'))
    card.appendChild(barRows(d.faces.map(f => ({ label: f.face, count: f.count }))))
  }
  return card
}

function plinkoCard(a: Analytics): HTMLElement {
  const p = a.plinko
  const chart = columnChart({
    data: p.slots.map(s => ({
      label: String(s.slot),
      value: s.count,
      tipRows: s.avg_payout !== null ? [{ label: 'avg payout', value: fmtCompact(s.avg_payout) }] : [],
    })),
    colorVar: '--s1',
    labelMax: true,
    height: 150,
  })
  return chartCard(
    'Plinko — landing slots',
    `Offered ${fmtCompact(p.offered)} · dropped ${fmtCompact(p.played)}. Field data for the 2026-07-28 endless retune.`,
    chart
  )
}

function versionsCard(a: Analytics): HTMLElement {
  const now = Date.now()
  const totalEvents = a.totals.events
  const card = chartCard(
    'Builds in the wild',
    'Under a prompt-mode PWA players sit on several bundles at once — read every funnel with this table open.',
    dataTable(
      ['Build', 'Devices', 'Events', 'Share', 'Last seen'],
      a.versions.map(v => [
        v.version,
        v.devices,
        v.events,
        fmtPct(share(v.events, totalEvents)),
        fmtAgo(v.last_seen, now),
      ])
    )
  )
  const odd = unexpectedCounts(a.counts)
  if (odd.length > 0) {
    const warn = el('div', 'fn-aside')
    warn.textContent = `⚠ events outside the client vocabulary (typo or forged): ${odd
      .map(o => `${o.name} ×${o.events}`)
      .join(', ')}`
    card.appendChild(warn)
  }
  card.appendChild(
    tableTwin(
      'All events in window',
      dataTable(['Event', 'Count', 'Devices'], a.counts.map(c => [c.name, c.events, c.devices]))
    )
  )
  return card
}

function sharesCard(a: Analytics): HTMLElement {
  const card = chartCard(
    'Share taps by surface',
    'Which surface actually gets the invite link moving.',
    a.shares.length > 0 ? barRows(a.shares.map(s => ({ label: s.surface, count: s.count }))) : el('p', 'sub', 'None in this window.')
  )
  return card
}

function filtersRow(session: Session, a: Analytics | null): HTMLElement {
  const row = el('div', 'filters')
  const seg = el('div', 'seg')
  seg.setAttribute('role', 'group')
  seg.setAttribute('aria-label', 'Date range')
  for (const w of WINDOWS) {
    const b = el('button', undefined, `${w}d`)
    b.setAttribute('aria-pressed', String(w === days))
    b.addEventListener('click', () => {
      if (days === w) return
      days = w
      void load(session)
    })
    seg.appendChild(b)
  }
  row.appendChild(seg)
  const refresh = el('button', 'ghost', 'Refresh')
  refresh.addEventListener('click', () => void load(session))
  row.appendChild(refresh)
  if (a) {
    row.appendChild(el('span', 'hint', `generated ${fmtAgo(a.meta.generated_at, Date.now()) || 'now'} · days are UTC`))
  }
  return row
}

function renderDashboard(session: Session, a: Analytics): void {
  const grid = el('div', 'grid')
  grid.appendChild(kpis(a))
  grid.appendChild(dailyCard(a))
  const pair = el('div', 'cards-2')
  pair.appendChild(hourlyCard(a))
  pair.appendChild(sharesCard(a))
  grid.appendChild(pair)
  grid.appendChild(levelsCard(a))
  const funnels = el('div', 'funnels')
  for (const f of buildFunnels(a.counts)) funnels.appendChild(funnelCard(f))
  grid.appendChild(funnels)
  const pair2 = el('div', 'cards-2')
  pair2.appendChild(dealCard(a))
  pair2.appendChild(plinkoCard(a))
  grid.appendChild(pair2)
  grid.appendChild(versionsCard(a))
  const foot = el('p', 'foot')
  foot.textContent = `Window: last ${a.meta.days} days, UTC · events are pruned after ~90 days, so “new device” means first seen within retention · aggregates only — no per-player rows leave the database (0014).`
  grid.appendChild(foot)
  page(session, filtersRow(session, a), grid)
}

// ---------------------------------------------------------------------------- data loading + routing

async function load(session: Session): Promise<void> {
  // Refetch holds the previous frame at reduced opacity — no skeleton, no layout jump.
  const existing = root.querySelector('.grid')
  if (existing) existing.classList.add('loading')
  else page(session, notice('Loading…', 'Fetching the aggregates.'))

  const c = await sb()
  const { data: raw, error } = await c.rpc('admin_analytics', { p_days: days })
  if (error) {
    // 42501 is the deliberate "not an admin" answer from 0014 — a different page, not an error.
    if (error.code === '42501' || /42501|permission denied|admin-only/i.test(error.message)) {
      renderNotAdmin(session)
    } else {
      renderError(session, error.message || 'The analytics RPC failed.')
    }
    return
  }
  data = coerceAnalytics(raw)
  renderDashboard(session, data)
}

async function route(): Promise<void> {
  const c = await sb()
  const { data: s } = await c.auth.getSession()
  if (s.session) await load(s.session)
  else renderSignedOut()
}

function boot(): void {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    renderUnconfigured()
    return
  }
  void (async () => {
    const c = await sb()
    // Re-route only when the USER changes (sign-in redirect return, sign-out) — a token refresh
    // re-firing this would pointlessly refetch every hour.
    let lastUid: string | null | undefined
    c.auth.onAuthStateChange((_event, s) => {
      const uid = s?.user?.id ?? null
      if (uid === lastUid) return
      lastUid = uid
      void route()
    })
    const { data: s } = await c.auth.getSession()
    lastUid = s.session?.user.id ?? null
    await route()
  })()
}

boot()

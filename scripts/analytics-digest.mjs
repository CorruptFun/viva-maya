/**
 * Weekly analytics digest — .github/workflows/analytics-weekly.yml runs this every Monday and
 * posts the output (markdown on stdout) to the run summary and a pinned GitHub issue.
 *
 * WHY IT EXISTS: a dashboard nobody opens is decoration. The digest is the push half of the
 * measurement layer — the numbers come to the owner, and the ⚠ lines are the alerting: a dead
 * pipe (zero events), client errors, or a typo'd event name gets surfaced without anyone
 * remembering to look.
 *
 * ONE SOURCE OF TRUTH: this calls the SAME admin_analytics RPC the dashboard renders (0015 admits
 * the service_role JWT for exactly this), so the digest can never disagree with stats.html. The
 * duplicated-aggregation trap that bit send-push.mjs (dayKey drift) is designed out rather than
 * pinned by tests.
 *
 * Runs as bare Node in CI (like send-push.mjs): no imports from src/, no dependencies — Node 18+
 * fetch only. Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in the environment; the service key
 * NEVER leaves Actions secrets.
 */

const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
const DAYS = Math.max(1, Number(process.env.DIGEST_DAYS) || 7)

if (!URL_ || !KEY) {
  console.error('analytics-digest: SUPABASE_URL and SUPABASE_SERVICE_KEY are required')
  process.exit(2)
}

const pct = (n, d) => (d > 0 ? `${Math.round((100 * n) / d)}%` : '—')

const res = await fetch(`${URL_.replace(/\/$/, '')}/rest/v1/rpc/admin_analytics`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify({ p_days: DAYS }),
})
if (!res.ok) {
  console.error(`analytics-digest: admin_analytics answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
  process.exit(1)
}
const a = await res.json()

const t = a.totals ?? {}
const daily = Array.isArray(a.daily) ? a.daily : []
const yesterdayKey = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const yesterday = daily.find(d => d.day === yesterdayKey)
const ret = a.retention ?? {}
const sess = a.sessions ?? {}
const errs = a.errors ?? {}
const counts = Array.isArray(a.counts) ? a.counts : []
const unknown = counts.find(c => c.name === 'unknown')

// Worst levels: enough decided attempts to mean something, lowest win rate first.
const walls = (Array.isArray(a.levels) ? a.levels : [])
  .map(l => ({ ...l, decided: (l.wins ?? 0) + (l.fails ?? 0) }))
  .filter(l => l.decided >= 6)
  .map(l => ({ ...l, pct: Math.round((100 * l.wins) / l.decided) }))
  .sort((x, y) => x.pct - y.pct)
  .slice(0, 3)

const alerts = []
if ((t.events ?? 0) === 0) alerts.push(`⚠ **ZERO events in ${DAYS} days** — the pipe may be dead (check a recent deploy).`)
else if (!yesterday || yesterday.events === 0) alerts.push('⚠ **Zero events yesterday** — quiet day, or a broken deploy.')
if ((errs.events ?? 0) > 0) {
  const top = (errs.top ?? [])[0]
  alerts.push(
    `⚠ **${errs.events} client errors** on ${errs.devices} device(s)` +
      (top ? ` — top: \`${String(top.message).slice(0, 80).replace(/`/g, "'")}\` (${top.count}× on ${JSON.stringify(top.versions)})` : '')
  )
}
if (unknown) alerts.push(`⚠ **'unknown' events ×${unknown.events}** — a client is sending a name the guard doesn't recognise (typo?).`)

const lines = []
lines.push(`## 📊 Viva Maya — last ${DAYS} days`)
lines.push('')
if (alerts.length > 0) {
  for (const al of alerts) lines.push(`- ${al}`)
  lines.push('')
}
lines.push(`| | |`)
lines.push(`|---|---|`)
lines.push(`| Active devices | **${t.devices ?? 0}** (${t.new_devices ?? 0} new, ${t.signed_in ?? 0} signed in) |`)
lines.push(`| Sessions | **${t.sessions ?? 0}** · median ${sess.median_seconds ?? 0}s · ${pct(sess.bounces ?? 0, sess.total ?? 0)} bounce |`)
lines.push(`| Events | ${t.events ?? 0} |`)
lines.push(`| Installed opens | ${pct(t.standalone_opens ?? 0, t.app_opens ?? 0)} of ${t.app_opens ?? 0} |`)
lines.push(`| D1 / D7 retention | **${pct(ret.d1?.returned ?? 0, ret.d1?.eligible ?? 0)}** (${ret.d1?.returned ?? 0}/${ret.d1?.eligible ?? 0}) / **${pct(ret.d7?.returned ?? 0, ret.d7?.eligible ?? 0)}** (${ret.d7?.returned ?? 0}/${ret.d7?.eligible ?? 0}) |`)
if (walls.length > 0) {
  lines.push(`| Hardest levels | ${walls.map(w => `L${w.level} ${w.pct}% (${w.decided} tries)`).join(' · ')} |`)
}
const contShown = counts.find(c => c.name === 'continue_shown')?.events ?? 0
const contTaken = counts.find(c => c.name === 'continue_taken')?.events ?? 0
if (contShown > 0) lines.push(`| Continue offers | ${contTaken}/${contShown} taken (${pct(contTaken, contShown)}) |`)
lines.push('')
lines.push(`_Dashboard: https://corruptfun.github.io/viva-maya/stats.html · generated ${new Date().toISOString().slice(0, 16)}Z_`)

console.log(lines.join('\n'))

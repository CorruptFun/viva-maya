#!/usr/bin/env node
/**
 * Weekly-race push sender.
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE APP: the game is hosted on GitHub Pages, which is static —
 * there is no server to run a timer on. Web Push requires an authenticated application server to sign
 * and send each message, so the sender has to live somewhere that can hold the VAPID private key and
 * wake up on a schedule. A GitHub Actions cron is the smallest thing that satisfies both, and this
 * repo already deploys from Actions, so it adds no new infrastructure and no new vendor.
 * (A Supabase Edge Function would also work; it was not chosen because it means Deno, a second deploy
 * path, and pg_cron enabled by hand — more moving parts for a job that runs once a week.)
 *
 * WHAT IT SENDS: one notification, a few hours before the endless race closes, personalised with the
 * player's current standing when it can be — "you're #3, 1,240 off #2" is a reason to open the game;
 * "the week is ending" is a fact. Signed-out subscribers get the impersonal version, which is why
 * user_id is nullable in 0011.
 *
 * USAGE
 *   node scripts/send-push.mjs --dry-run     # print exactly what would be sent, send nothing
 *   node scripts/send-push.mjs               # send
 *
 * ENV (all required unless noted)
 *   SUPABASE_URL           project URL
 *   SUPABASE_SERVICE_KEY   service-role key — bypasses RLS, which is the ONLY way to read
 *                          push_subscriptions (0011 grants no SELECT to anyone else). Must never
 *                          reach the client bundle; it lives as a GitHub Actions secret.
 *   VAPID_PUBLIC_KEY       must be the pair of the key the client subscribed with — a mismatch makes
 *                          every send fail 403, which is the #1 way this breaks silently
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT          optional; a mailto: or https: URL identifying the sender to push services
 */

import webpush from 'web-push'

const DRY = process.argv.includes('--dry-run')

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = 'mailto:hello@corrupt.fun',
} = process.env

/**
 * Config validation lives in a function, NOT at module scope: this file is imported by
 * src/core/analytics.test.ts to pin weekKey() against the app's copy, and a module that calls
 * process.exit() on import takes the whole test runner down with it (it did — that is why this is
 * shaped this way).
 */
function requireConfig() {
  const missing = Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY })
    .filter(([, v]) => !v)
    .map(([k]) => k)
  if (missing.length) {
    console.error(`missing required env: ${missing.join(', ')}`)
    process.exit(1)
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

const rest = (path, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

/**
 * ISO-8601 week key, UTC.
 *
 * ⚠️ MUST STAY BYTE-IDENTICAL TO `weekKey()` IN src/core/endless.ts. It selects the leaderboard
 * partition, so a sender that computes a different key reads an EMPTY board and silently sends
 * everyone the generic copy — a failure that looks like "nobody has played" rather than like a bug.
 * That function was made UTC on 2026-07-26 precisely because a local-time derivation split players
 * in different timezones onto different races; re-deriving it from local time here would reintroduce
 * that bug on the notification side only.
 */
export function weekKey(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow + 3) // hop to this week's Thursday
  const year = d.getUTCFullYear()
  const firstThu = new Date(Date.UTC(year, 0, 4))
  const firstDow = (firstThu.getUTCDay() + 6) % 7
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDow + 3)
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000))
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Monday 00:00 UTC — mirrors weekEndsAt() in src/core/endless.ts. */
export function weekEndsAt(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() + (7 - ((d.getUTCDay() + 6) % 7)))
  return d
}

function hoursLeft(now = new Date()) {
  return Math.max(0, Math.round((weekEndsAt(now).getTime() - now.getTime()) / 3600000))
}

/**
 * Build the message for one subscriber.
 *
 * The personalised branches are the whole point of joining against the board: a bare "the week is
 * ending" is a fact, whereas a gap to the next player up is a goal. Ordered from most to least
 * motivating, and every branch falls back safely when the player has no row this week.
 */
function messageFor(sub, board, hrs) {
  // The scheduled run is always ~6h out, but a manual/dry run can happen any day of the week, and
  // "in 123 hours" is not something a person parses. Degrade to days past two days out.
  const when =
    hrs <= 1 ? 'in under an hour' : hrs < 48 ? `in ${hrs} hours` : `in ${Math.round(hrs / 24)} days`
  const idx = sub.user_id ? board.findIndex(r => r.user_id === sub.user_id) : -1

  if (idx === -1) {
    // Never played this week (or signed out). The leader's score is the hook.
    const top = board[0]
    return {
      title: 'The weekly race ends soon',
      body: top
        ? `Ends ${when} — ${top.display_name} is leading with ${top.score.toLocaleString('en-US')}. Still time for a run.`
        : `Ends ${when}. The board is wide open — one run could take it.`,
    }
  }

  const me = board[idx]
  const rank = idx + 1
  const mine = me.score.toLocaleString('en-US')

  if (rank === 1) {
    const second = board[1]
    return {
      title: `You're #1 — for now`,
      body: second
        ? `Ends ${when}. ${second.display_name} is ${(me.score - second.score).toLocaleString('en-US')} behind. Hold the crown.`
        : `Ends ${when}. You're top of the board with ${mine}.`,
    }
  }

  const ahead = board[idx - 1]
  const gap = (ahead.score - me.score).toLocaleString('en-US')
  return {
    title: `You're #${rank} with ${mine}`,
    body: `Ends ${when} — you're ${gap} behind ${ahead.display_name}. One good run could take the spot.`,
  }
}

async function main() {
  requireConfig()
  const now = new Date()
  const week = weekKey(now)
  const hrs = hoursLeft(now)

  // The audience: opted in, and not a known corpse. Matches the partial index in 0011.
  const subsRes = await rest(
    'push_subscriptions?select=endpoint,p256dh,auth,user_id,device_id&week_race=is.true&failure_count=lt.5'
  )
  if (!subsRes.ok) {
    console.error(`could not read subscriptions: ${subsRes.status} ${await subsRes.text()}`)
    process.exit(1)
  }
  const subs = await subsRes.json()

  // The standings, best first — the same ordering fetchWeeklyBoard uses, so a rank computed here
  // matches the rank the player sees in the app. A disagreement between the two would be worse than
  // sending nothing.
  const boardRes = await rest(
    `endless_scores?select=user_id,display_name,score&week_key=eq.${week}&order=score.desc,scored_at.asc`
  )
  const board = boardRes.ok ? await boardRes.json() : []

  console.log(`week ${week} · ends in ${hrs}h · ${subs.length} subscriber(s) · ${board.length} on the board`)
  if (!subs.length) return

  let sent = 0
  let retired = 0
  let failed = 0

  for (const sub of subs) {
    const { title, body } = messageFor(sub, board, hrs)
    const payload = JSON.stringify({ title, body, tag: `week-${week}`, url: './' })

    if (DRY) {
      console.log(`  [dry] ${sub.user_id ? sub.user_id.slice(0, 8) : 'anon'} → ${title} :: ${body}`)
      sent++
      continue
    }

    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 6 * 3600 } // pointless to deliver after the race has closed
      )
      sent++
      await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_sent_at: new Date().toISOString(), failure_count: 0 }),
      })
    } catch (err) {
      const status = err?.statusCode
      if (status === 404 || status === 410) {
        // The push service says this endpoint is gone for good — the browser dropped it or the app
        // was uninstalled. Deleting is the ONLY correct response: retrying a 410 forever is how a
        // send job slowly turns into a list of corpses.
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: 'DELETE' })
        retired++
      } else {
        // Soft failure (rate limit, transient 5xx). Count it; the partial index retires anything
        // that reaches 5 without ever deleting data on a guess.
        failed++
        const cur = await rest(
          `push_subscriptions?select=failure_count&endpoint=eq.${encodeURIComponent(sub.endpoint)}`
        )
        const rows = cur.ok ? await cur.json() : []
        const next = (rows[0]?.failure_count ?? 0) + 1
        await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
          method: 'PATCH',
          body: JSON.stringify({ failure_count: next }),
        })
        console.warn(`  send failed (${status ?? 'network'}) → failure_count=${next}`)
      }
    }
  }

  console.log(`${DRY ? '[dry-run] ' : ''}sent ${sent} · retired ${retired} · soft-failed ${failed}`)
}

// Only run when executed directly, so the pure helpers above can be imported by
// scripts/send-push.test.ts — which pins weekKey() against the app's own copy. Without this guard
// importing the module would fire a real send.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

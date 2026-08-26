#!/usr/bin/env node
/**
 * The game's push sender — every scheduled notification Viva Maya sends, in one script.
 *
 * WHY THIS IS A SCRIPT AND NOT PART OF THE APP: the game is hosted on GitHub Pages, which is static —
 * there is no server to run a timer on. Web Push requires an authenticated application server to sign
 * and send each message, so the sender has to live somewhere that can hold the VAPID private key and
 * wake up on a schedule. A GitHub Actions cron is the smallest thing that satisfies both, and this
 * repo already deploys from Actions, so it adds no new infrastructure and no new vendor.
 * (A Supabase Edge Function would also work; it was not chosen because it means Deno, a second deploy
 * path, and pg_cron enabled by hand — more moving parts for a job that runs once a week.)
 *
 * ── THE ONE RULE THIS FILE IS BUILT AROUND ───────────────────────────────────────────────────────
 * ⚠️ **AT MOST ONE NOTIFICATION PER DEVICE PER RACE DAY, ACROSS EVERY MODE BELOW.** Not a guideline —
 * it is the thing that makes it honest to have grown from one notification to three, and it is
 * enforced three ways so it stays true rather than merely intended:
 *
 *   1. The MODES HAVE DISJOINT AUDIENCES by construction. `--drop` goes only to devices that did NOT
 *      open the game yesterday; `--daily` goes only to those that DID. A device cannot be in both.
 *   2. Every mode re-checks `last_sent_at` against today's race day (`sentToday`) and skips anything
 *      already written to. That covers the seams the audience split cannot: a manual run, a retried
 *      cron, the Sunday weekly overlapping a Sunday morning nudge, and any future fourth mode.
 *   3. A device that keeps being nudged without coming back BACKS OFF (`backoffAllows`) — to every
 *      third day, then weekly, then not at all. Somebody who has ignored seven nudges will ignore the
 *      eighth, and is one tap from switching notifications off forever.
 *
 * The audience is opted in on a card that promises exactly this (src/view/pushoptin.ts), and
 * migration 0025's header records why the second category was allowed to default ON for the people
 * who opted in under the first one's wording. Read that before widening anything here.
 *
 * ── THE MODES ────────────────────────────────────────────────────────────────────────────────────
 *   --drop    MORNING (≈9am at home). The play nudge, for people who were not here yesterday. Leads
 *             with a JACKPOT WHEEL within reach when this player has one (jackpotWinsAway), else
 *             carries the day's HOUSE GIFT by name — "a JACKPOT CHIP is on the table" — which it can
 *             do because the gift is seeded from the day alone and this file carries a byte-identical
 *             copy of the roll (see dropForDay). Audience column: `daily_play` (0025).
 *   --daily   EVENING (≈6–7pm at home). Today's board closes at midnight America/Edmonton; for people
 *             who WERE here yesterday. Leads with a streak about to break when there is one, then a
 *             jackpot wheel within reach, and otherwise the player's standing. Audience column:
 *             `week_race` (0011).
 *   (default) SUNDAY EVENING. The weekly season, which closes Monday midnight America/Edmonton,
 *             ranked on the SUM of daily bests from the endless_weekly_totals view. Deliberately the
 *             one mode with NO activity filter: a season summary silenced for anyone who drifted off
 *             mid-week would be silent for exactly the people it is for.
 *
 * All three share every line of plumbing below — audience, retire-on-410, failure counting, the
 * one-a-day guard — because the only real differences are which partition to read and what to say.
 *
 * WHAT PERSONALISATION COSTS: the race modes join against the leaderboard, which is public data. The
 * streak and jackpot hooks additionally read the player's own save blob with the service role
 * (signed-in players only — a signed-out subscriber has no cloud save and gets the impersonal copy,
 * which is why user_id is nullable in 0011), and the next-level line reads `level_progress`, which
 * 0007 makes world-readable (it is what the leaderboard's trophy badges derive from). ⚠️ A streak
 * count and a jackpot meter are NOT public, unlike a leaderboard rank, and this runs in a PUBLIC
 * repo whose Actions logs anyone can read — so `--dry-run` prints WHICH HOOK fired and never the
 * composed body for a hook built on private data. See the dry-run block in `main`.
 *
 * USAGE
 *   node scripts/send-push.mjs --dry-run          # weekly, print what would be sent
 *   node scripts/send-push.mjs --daily --dry-run  # today's board, print what would be sent
 *   node scripts/send-push.mjs --drop --dry-run   # the morning play nudge
 *   node scripts/send-push.mjs                    # send
 *
 * ENV (all required unless noted)
 *   SUPABASE_URL           project URL
 *   SUPABASE_SERVICE_KEY   service-role key — bypasses RLS, which is the ONLY way to read
 *                          push_subscriptions (0011 grants no SELECT to anyone else), the events log
 *                          (0010, same) or another player's save (0001). Must never reach the client
 *                          bundle; it lives as a GitHub Actions secret.
 *   VAPID_PUBLIC_KEY       must be the pair of the key the client subscribed with — a mismatch makes
 *                          every send fail 403, which is the #1 way this breaks silently
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT          optional; a mailto: or https: URL identifying the sender to push services
 */

import webpush from 'web-push'

const DRY = process.argv.includes('--dry-run')
const DAILY = process.argv.includes('--daily')
const DROP = process.argv.includes('--drop')

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env

/**
 * ⚠️ `||`, not a destructuring default or `??`.
 *
 * GitHub Actions passes an UNSET repo variable as an EMPTY STRING, not as undefined — so
 * `const { VAPID_SUBJECT = '...' } = process.env` (and `??`) both keep the empty string and the
 * fallback never runs. web-push then dies with "No subject set in vapidDetails.subject", which reads
 * like a missing secret rather than a defaulting bug. Cost one failed run to find.
 *
 * VAPID subject identifies the sender to push services so they can make contact about a
 * misbehaving sender. It accepts an `https:` URL as well as `mailto:`, and the repo URL is the
 * better default here: stable, real, and it keeps a personal address out of a repo variable.
 */
const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT?.trim() || 'https://github.com/CorruptFun/viva-maya'

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
 * The race's home timezone — MUST MATCH `RACE_TZ` in src/core/endless.ts. Since 2026-07-30 the
 * boards flip at midnight on this clock (they used to flip at 00:00 UTC — 6 PM at home, which is
 * how "the board resets at midnight" became a 19-hour countdown at 11 PM).
 */
export const RACE_TZ = 'America/Edmonton'

// Same wall-clock machinery as src/core/endless.ts, line for line. h23 pins midnight to "00".
const raceClock = new Intl.DateTimeFormat('en-US', {
  timeZone: RACE_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function raceWallClock(at) {
  const v = {}
  for (const part of raceClock.formatToParts(at)) {
    if (part.type !== 'literal') v[part.type] = Number(part.value)
  }
  return { y: v.year, mo: v.month, d: v.day, h: v.hour % 24, mi: v.minute, s: v.second }
}

const pad2 = n => String(n).padStart(2, '0')

/** RACE_TZ's UTC offset at `at`, in ms — negative when behind UTC (Mountain is −6h/−7h). */
function raceOffsetMs(at) {
  const w = raceWallClock(at)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - at.getTime()
}

/** Calendar arithmetic on a day key — DST-free, because keys are dates and not instants. */
function shiftDayKey(key, days) {
  const d = new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** The instant RACE_TZ's clocks strike midnight opening `key` — two-pass for the DST seams. */
function raceMidnight(key) {
  const naive = Date.parse(`${key}T00:00:00Z`)
  let t = naive - raceOffsetMs(new Date(naive))
  t = naive - raceOffsetMs(new Date(t))
  return new Date(t)
}

/**
 * Race-day calendar key (midnight-to-midnight America/Edmonton).
 *
 * ⚠️ MUST STAY BEHAVIOURALLY IDENTICAL TO `dayKey()` IN src/core/endless.ts — it selects the daily
 * leaderboard partition, so a sender computing a different key reads an EMPTY board and silently
 * sends everyone the generic copy: a failure that looks like "nobody has played" rather than like
 * a bug. Pinned against the app's own copy in src/core/analytics.test.ts (this file cannot import
 * from src/ — it runs in CI as plain Node with no TypeScript step — so it carries this copy).
 */
export function dayKey(now = new Date()) {
  const w = raceWallClock(now)
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`
}

/** The next midnight America/Edmonton — mirrors dayEndsAt() in src/core/endless.ts. */
export function dayEndsAt(now = new Date()) {
  return raceMidnight(shiftDayKey(dayKey(now), 1))
}

/** ISO-8601 week of a day key — pure calendar math, byte-identical to isoWeekOf() in endless.ts. */
function isoWeekOf(key) {
  const d = new Date(Date.parse(`${key}T00:00:00Z`))
  const dow = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow + 3) // hop to this week's Thursday
  const year = d.getUTCFullYear()
  const firstThu = new Date(Date.UTC(year, 0, 4))
  const firstDow = (firstThu.getUTCDay() + 6) % 7
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDow + 3)
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000))
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * ISO-8601 week key of the race calendar.
 *
 * ⚠️ MUST STAY BEHAVIOURALLY IDENTICAL TO `weekKey()` IN src/core/endless.ts, for exactly the
 * reason spelled out on dayKey above. That function was made timezone-FIXED on 2026-07-26 precisely
 * because a device-local derivation split players in different timezones onto different races;
 * re-deriving it from local time here would reintroduce that bug on the notification side only.
 */
export function weekKey(now = new Date()) {
  return isoWeekOf(dayKey(now))
}

/** Monday midnight America/Edmonton — mirrors weekEndsAt() in src/core/endless.ts. */
export function weekEndsAt(now = new Date()) {
  const key = dayKey(now)
  const dow = (new Date(Date.parse(`${key}T00:00:00Z`)).getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  return raceMidnight(shiftDayKey(key, 7 - dow))
}

/** Hours until the thing this run is about closes — today's board, or the season. */
function hoursLeft(now = new Date()) {
  // `--drop` runs in the morning and its copy never quotes a deadline, but the run's LOG does, and a
  // morning nudge reporting "ends in 130h" (the season's clock) reads as a bug in the run summary.
  const ends = DAILY || DROP ? dayEndsAt(now) : weekEndsAt(now)
  return Math.max(0, Math.round((ends.getTime() - now.getTime()) / 3600000))
}

/** Whole days between two YYYY-MM-DD keys (b − a). Calendar arithmetic, so DST cannot reach it. */
function daysBetweenKeys(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOUSE GIFT — a byte-for-byte copy of src/core/bonusdrop.ts's roll.
//
// ⚠️ MUST STAY BEHAVIOURALLY IDENTICAL TO THE APP'S COPY, for the same reason
// dayKey/weekKey above carry the same warning, and with a worse failure: those
// drift into sending the WRONG COPY, this one drifts into sending a LIE. The
// whole point of naming the gift in the notification is that the player finds
// exactly that gift when they arrive; a sender rolling a different table has
// promised a Jackpot Chip and handed over twenty chips, which is worse than
// having sent nothing. `src/core/bonusdrop.test.ts` pins this file's dropForDay
// against the app's across a long span of days.
//
// This file cannot import from src/ — it runs in CI as plain Node with no
// TypeScript step — so the table, the PRNG and the hash are all restated here.
// Keep the ORDER of the table identical too: the roll walks it accumulating
// weights, so a reordered copy pays a different gift from the same day.
// ─────────────────────────────────────────────────────────────────────────────

/** mulberry32 — src/core/rng.ts, verbatim. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a — src/core/endless.ts seedForKey, verbatim. */
function seedForKey(key) {
  let h = 0x811c9dc5 >>> 0
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * The gift table — src/core/bonusdrop.ts DROP_TABLE, in the same order.
 *
 * Only the fields this file actually says out loud are carried: the id (for the log), the label and
 * emoji (the notification's title) and the blurb (its body). The chips/spins/boost columns are
 * deliberately NOT duplicated here — the sender never quotes an amount, so a copy of the numbers
 * would be a second source of truth that nothing checks and everything could drift from. What the
 * gift PAYS is the app's business; what it is CALLED is all this needs.
 */
const DROP_TABLE = [
  { id: 'chips_small', label: 'HOUSE CHIPS', emoji: '🪙', blurb: 'A little something from the floor manager.', weight: 26 },
  { id: 'chips_stack', label: 'A STACK', emoji: '💰', blurb: 'Somebody left this on the table with your name on it.', weight: 18 },
  { id: 'free_pull', label: 'A FREE PULL', emoji: '🎰', blurb: 'One extra turn on the LUCKY SLOTS wheel, on the house.', weight: 16 },
  { id: 'boost_moves', label: 'ON THE HOUSE', emoji: '♟️', blurb: 'Banked for your next level.', weight: 12 },
  { id: 'boost_dice', label: 'ON THE HOUSE', emoji: '🎲', blurb: 'Banked for your next level.', weight: 10 },
  { id: 'double_pull', label: 'A DOUBLE PULL', emoji: '🎟️', blurb: 'Two extra turns on the LUCKY SLOTS wheel.', weight: 8 },
  { id: 'boost_wild', label: 'ON THE HOUSE', emoji: '🃏', blurb: 'Banked for your next level.', weight: 6 },
  { id: 'high_roller', label: 'HIGH ROLLER', emoji: '💎', blurb: 'The good table. Chips, a pull and a boost.', weight: 3 },
  { id: 'the_vault', label: 'THE VAULT', emoji: '🏆', blurb: 'The best day the house gives away. Take all of it.', weight: 1 },
]

/** The gift a given race day pays. Exported for the parity test in src/core/bonusdrop.test.ts. */
export function dropForDay(day) {
  const rng = mulberry32(seedForKey(`${day}#gift`))
  const total = DROP_TABLE.reduce((sum, d) => sum + d.weight, 0)
  let roll = rng() * total
  for (const drop of DROP_TABLE) {
    roll -= drop.weight
    if (roll < 0) return drop
  }
  return DROP_TABLE[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// THE AUDIENCE — who is due a notification today, and who is not.
// ─────────────────────────────────────────────────────────────────────────────

/** How far back the activity read looks. Wider than GONE_DAYS so "gone" is a fact, not a horizon. */
const LOOKBACK_DAYS = 32
/** Past this many days away, stop nudging entirely. They are not coming back for a notification. */
const GONE_DAYS = 30

/** Split a list into fixed-size chunks — keeps a PostgREST `in.(…)` filter inside the URL limit. */
function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * Has this device already been sent to on today's race day?
 *
 * THE BACKSTOP FOR THE ONE-A-DAY RULE. The modes' audiences are disjoint by construction, so in
 * normal operation this never fires — it exists for the seams that construction cannot cover: a
 * manual `workflow_dispatch` run beside a scheduled one, a cron GitHub retried, the Sunday weekly
 * blast landing on a day the morning nudge already went out, and whatever fourth mode gets added
 * later by someone who has not read the header.
 *
 * ⚠️ Compared on the RACE day key, not on elapsed hours: "one a day" means one per board, and the
 * morning slot (≈9am) and the evening slot (≈6pm) are only nine hours apart on the same board.
 */
export function sentToday(sub, today) {
  if (!sub.last_sent_at) return false
  const at = Date.parse(sub.last_sent_at)
  return Number.isFinite(at) && dayKey(new Date(at)) === today
}

/**
 * Whether a device that is not coming back may be nudged again today.
 *
 * Somebody who has ignored seven nudges will ignore the eighth, and every one of them is a chance
 * to be switched off for good — so the cadence decays with the absence rather than hammering the
 * people least likely to respond. Fresh players are untouched by this; it only ever slows down.
 *
 * `awayDays === null` is UNKNOWN, not gone: a player who turned off anonymous gameplay events
 * (public/privacy.html promises that switch) emits nothing at all, so no activity read can ever see
 * them. Treating unknown as "away forever" would silence the one group whose only mistake was using
 * a privacy control, so they get the conservative every-third-day cadence indefinitely — and never
 * the win-back copy, which would be asserting something about them that is not known.
 */
export function backoffAllows(sub, awayDays, now) {
  if (awayDays !== null && awayDays >= GONE_DAYS) return false
  const sinceSendDays = sub.last_sent_at
    ? (now.getTime() - Date.parse(sub.last_sent_at)) / 86400000
    : Infinity
  if (awayDays === null) return sinceSendDays >= 3
  if (awayDays >= 14) return sinceSendDays >= 7
  if (awayDays >= 3) return sinceSendDays >= 3
  return true
}

/**
 * Last `app_open` per device, as a race day key. Returns null when the read FAILED — which the
 * callers treat differently on purpose, so read the note in `main` before collapsing them.
 *
 * `app_open` rather than a gameplay event because it is the one thing every client emits on every
 * launch (core/analytics.ts calls it "the denominator for literally every other rate"), so it is the
 * only signal that means the same thing for a level player, a racer and someone who opened the app
 * and bounced. "Was this person here" is the question; "did they enjoy it" is not one a notification
 * can act on.
 *
 * Chunked because the filter is a URL: 60 uuids is ~2.2 KB of query string, comfortably inside every
 * proxy's limit, and the alternative (fetch every device's events and reduce locally) reads rows for
 * players who are not subscribers at all. The per-chunk `limit` truncates OLDEST-FIRST (the order is
 * newest-first), so a truncated chunk loses only rows already older than everything kept — a device
 * dropped that way is genuinely stale and lands in the "unknown" bucket, which fails safe.
 */
async function fetchLastSeen(deviceIds, now) {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86400000).toISOString()
  const seen = new Map()
  for (const group of chunk(deviceIds, 60)) {
    const res = await rest(
      `events?select=device_id,created_at&name=eq.app_open&created_at=gte.${since}` +
        `&device_id=in.(${group.join(',')})&order=created_at.desc&limit=5000`
    )
    if (!res.ok) return null
    for (const row of await res.json()) {
      // Rows arrive newest-first, so the first sighting of a device IS its most recent one.
      if (!seen.has(row.device_id)) seen.set(row.device_id, dayKey(new Date(row.created_at)))
    }
  }
  return seen
}

/**
 * The save-blob facts of signed-in subscribers: how many consecutive days, the day of the last
 * daily spin, and the jackpot meter. Everything else in the save blob is dropped on the floor here
 * and never leaves this function — a notification needs three numbers, not a player's progress.
 *
 * ⚠️ A failed or partial read is NOT fatal and never throws: the personal hooks simply do not fire
 * and the message falls back to the standing (or the gift), which is what every player got before
 * they existed. A missing personalisation must never cost a notification.
 *
 * ⚠️ `lastSpinDate` is the player's DEVICE-LOCAL calendar day (core/daily.ts todayKey) and it is
 * being compared against the RACE day here, because the race day is the only clock this script has.
 * For the home crowd the two agree. Far enough east and they can disagree by one, which is why the
 * hook's test below is `=== 1` rather than `>= 1`: a player whose local date has already run AHEAD
 * of the race day produces 0 or a negative, and the hook stays silent. It fails toward saying
 * nothing rather than toward telling somebody their streak is dying when it is not.
 */
async function fetchPlayerFacts(userIds) {
  const out = new Map()
  for (const group of chunk(userIds, 40)) {
    const res = await rest(`saves?select=user_id,data&user_id=in.(${group.join(',')})`)
    if (!res.ok) return out
    for (const row of await res.json()) {
      const d = row.data && typeof row.data === 'object' ? row.data : {}
      const streak = Number(d.streak)
      const meter = Number(d.jackpotMeter)
      out.set(row.user_id, {
        streak: Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0,
        lastSpinDate: typeof d.lastSpinDate === 'string' ? d.lastSpinDate : null,
        jackpotMeter: Number.isFinite(meter) ? Math.max(0, Math.floor(meter)) : 0,
      })
    }
  }
  return out
}

/**
 * The streak-in-danger hook, or null.
 *
 * Fires only when the streak is ALIVE AND UNSECURED: at least two days deep (a one-day streak is a
 * day, not a run worth defending), and last spun EXACTLY yesterday — spun today means it is already
 * safe, and anything older means it broke before this message could have saved it. Telling somebody
 * a streak they have already lost is about to end is the worst line in the whole sender.
 */
export function streakAtRisk(info, today) {
  if (!info || !info.lastSpinDate || info.streak < 2) return null
  return daysBetweenKeys(info.lastSpinDate, today) === 1 ? info.streak : null
}

/**
 * THE JACKPOT WHEEL'S GOAL and THE LADDER'S REACH — src/core/jackpot.ts JACKPOT_GOAL and
 * src/core/levels.ts LEVEL_COUNT.
 *
 * ⚠️ MUST STAY IDENTICAL TO THE APP'S COPIES, for the reason every duplicated constant in this file
 * carries: a drift here means telling a player they are "one win from the wheel" when they are not,
 * or naming a level the catalogue does not hold. Pinned in src/core/pushcadence.test.ts.
 */
export const JACKPOT_GOAL = 5
export const LEVEL_COUNT = 500

/**
 * The jackpot-within-reach hook, or null.
 *
 * The JACKPOT WHEEL (core/jackpot.ts) is a meter charged one notch per NEW level win that fires an
 * always-pays wheel at JACKPOT_GOAL — the game's own "keep playing levels" engine, which makes it
 * the most concrete unfinished business a nudge can point at. Fires only when the wheel is at most
 * TWO wins away: further out is a meter reading, not news. Returns the wins left — 0 is a wheel
 * already LOADED (a store batch or a cross-device merge can carry the meter past the goal), 1–2 a
 * chase nearly home.
 *
 * Total on junk: a signed-out subscriber has no save row, a malformed meter reads as absent, and
 * both answer null — a missing personalisation must never cost a notification.
 */
export function jackpotWinsAway(info) {
  const meter = info ? Number(info.jackpotMeter) : NaN
  if (!Number.isFinite(meter)) return null
  const left = JACKPOT_GOAL - Math.floor(meter)
  return left <= 2 ? Math.max(0, left) : null
}

/**
 * Highest level each signed-in subscriber has WON, from `level_progress` — the world-readable table
 * the leaderboard's trophy badges derive from (0007's monotonic guard is what makes it trustworthy).
 * `cleared` is the highest level won (core/trophies.ts spells that coupling out), so the level to
 * name is `cleared + 1` — and only while that level exists (LEVEL_COUNT; the caller guards it).
 *
 * PUBLIC data, unlike the save read above, so a level number may appear in a --dry-run log.
 * Fail-soft the same way: a failed read costs the copy its level number, never the send.
 */
async function fetchCleared(userIds) {
  const out = new Map()
  for (const group of chunk(userIds, 40)) {
    const res = await rest(`level_progress?select=user_id,cleared&user_id=in.(${group.join(',')})`)
    if (!res.ok) return out
    for (const row of await res.json()) {
      const c = Number(row.cleared)
      if (Number.isFinite(c) && c > 0) out.set(row.user_id, Math.floor(c))
    }
  }
  return out
}

/** Hooks whose copy is built on private save data — `--dry-run` withholds their bodies from the log. */
const PRIVATE_HOOKS = new Set(['streak', 'jackpot'])

/**
 * The jackpot hook's message, said ONCE for both slots so the wheel is described identically in the
 * morning and the evening — only the gift tail differs (the morning send owns the gift's name; the
 * evening matches the streak hook's register and leaves it unnamed).
 *
 * ⚠️ The level line rides `nextLevel`, which the caller sets null past LEVEL_COUNT — a maxed-out
 * ladder falls back to the level-less copy rather than naming a level that does not exist. "It
 * always pays" is the wheel's real contract (core/jackpot.ts: a reward, not gambling) and the one
 * fact worth repeating to somebody deciding whether the chase is worth finishing.
 */
function jackpotMessage(winsAway, nextLevel, giftTail) {
  const chase =
    winsAway === 0
      ? 'The spin is waiting.'
      : winsAway === 1
        ? nextLevel
          ? `Win level ${nextLevel} and it fires.`
          : 'One more level win fires it.'
        : nextLevel
          ? `Two level wins away — level ${nextLevel} is next.`
          : 'Two level wins away.'
  const title =
    winsAway === 0
      ? '🎰 Your JACKPOT wheel is loaded'
      : winsAway === 1
        ? '🎰 One win from your JACKPOT spin'
        : '🎰 Two wins from your JACKPOT spin'
  return { hook: 'jackpot', title, body: `${chase} It always pays — and ${giftTail}` }
}

/**
 * The MORNING nudge (`--drop`) — for people who were not here yesterday.
 *
 * The gift is the hook, and it is a hook precisely because it can be NAMED: "come back and play" is
 * a request, "THE VAULT is on the table today" is an appointment. Everything the copy says is
 * verifiably true when they arrive — the same gift, from the same table, seeded from the same day.
 *
 * ⚠️ THE JACKPOT WHEEL OUTRANKS THE GIFT when it is within reach: the gift is the same appointment
 * every subscriber has, the wheel is THIS player's unfinished business with a guaranteed payout
 * behind it. The gift still rides along by name in every branch, so the appointment is never lost
 * to the better headline.
 *
 * ⚠️ NO DAY COUNTS IN THE COPY. "5 days away" is only accurate for a device that emits events, and
 * the one group it would be wrong for is the group that turned events off — who would be told they
 * had been absent while playing daily. The vaguer line is right in every case.
 */
function messageForDrop(gift, awayDays, winsAway = null, nextLevel = null) {
  if (winsAway !== null) {
    return jackpotMessage(winsAway, nextLevel, `today's gift, ${gift.label}, is on the table too.`)
  }
  if (awayDays !== null && awayDays >= 4) {
    return {
      hook: 'winback',
      title: 'Your seat is still here',
      body: nextLevel
        ? `Level ${nextLevel} is waiting — and today's gift is ${gift.label}. ${gift.blurb}`
        : `It has been a while — and today's gift is ${gift.label}. ${gift.blurb}`,
    }
  }
  return {
    hook: 'gift',
    title: `${gift.emoji} Today's gift: ${gift.label}`,
    body: `${gift.blurb} One a day, waiting on the cabinet — open it and see.`,
  }
}

/**
 * Build the message for one subscriber.
 *
 * The personalised branches are the whole point of joining against the board: a bare "the board is
 * closing" is a fact, whereas a gap to the next player up is a goal. Ordered from most to least
 * motivating, and every branch falls back safely when the player has no row on this board.
 *
 * The two cadences want different pressure. A DAILY board that closes tonight and can be taken with
 * one good run says "still time"; a WEEKLY total made of seven boards cannot be caught in one run, so
 * its copy points at the thing that can still move — the boards left to play.
 *
 * ⚠️ THE STREAK OUTRANKS EVERYTHING, AND THE JACKPOT WHEEL OUTRANKS THE STANDING. The order is loss
 * before gain before news: a streak is a thing you LOSE tonight, permanently, and the ladder it
 * indexes pays real purses at 3/7/14/30/60/100 days (core/daily.ts STREAK_REWARDS) — the most
 * urgent true sentence this sender can say to anyone. A wheel within reach is THIS player's
 * unfinished business with a guaranteed payout behind it. The standing is a fact about other
 * people. In practice the evening audience (last seen exactly yesterday) rarely has a row on
 * TODAY'S board at all, so without the personal hooks most evenings open with the impersonal
 * leader line — the hooks are what make the one allowed message worth its slot.
 */
function messageFor(sub, board, hrs, streakDays = null, winsAway = null, nextLevel = null) {
  if (streakDays) {
    return {
      hook: 'streak',
      title: `🔥 Your ${streakDays}-day streak ends at midnight`,
      body: 'One pull on LUCKY SLOTS keeps it alive — and the daily gift is still on the table.',
    }
  }
  if (winsAway !== null) {
    return jackpotMessage(winsAway, nextLevel, 'the daily gift is still on the table.')
  }
  return { hook: 'standing', ...standingMessage(sub, board, hrs) }
}

/** The standing half of the evening message — the original copy, unchanged. */
function standingMessage(sub, board, hrs) {
  // The scheduled run is always ~6h out, but a manual/dry run can happen any time, and "in 123 hours"
  // is not something a person parses. Degrade to days past two days out.
  const when =
    hrs <= 1 ? 'in under an hour' : hrs < 48 ? `in ${hrs} hours` : `in ${Math.round(hrs / 24)} days`
  const idx = sub.user_id ? board.findIndex(r => r.user_id === sub.user_id) : -1
  const race = DAILY ? `Today's board` : `The weekly race`

  if (idx === -1) {
    // Never played this board (or signed out). The leader's score is the hook.
    const top = board[0]
    if (!top) {
      return {
        title: `${race} ends soon`,
        body: DAILY
          ? `Closes ${when}. Nobody has played today — one run could take it.`
          : `Ends ${when}. The board is wide open — every day you play adds to your total.`,
      }
    }
    return {
      title: `${race} ends soon`,
      body: DAILY
        ? `Closes ${when} — ${top.display_name} leads with ${top.score.toLocaleString('en-US')}. Still time for a run.`
        : `Ends ${when} — ${top.display_name} leads on ${top.score.toLocaleString('en-US')}. A run today still counts.`,
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
        ? `${DAILY ? 'Closes' : 'Ends'} ${when}. ${second.display_name} is ${(me.score - second.score).toLocaleString('en-US')} behind. Hold the crown.`
        : `${DAILY ? 'Closes' : 'Ends'} ${when}. You're top of the board with ${mine}.`,
    }
  }

  const ahead = board[idx - 1]
  const gap = (ahead.score - me.score).toLocaleString('en-US')
  return {
    title: `You're #${rank} with ${mine}`,
    body: DAILY
      ? `Closes ${when} — you're ${gap} behind ${ahead.display_name}. One good run could take the spot.`
      : `Ends ${when} — you're ${gap} behind ${ahead.display_name}. Every board you play adds to your total.`,
  }
}

/**
 * The URL a tapped notification opens — the game's own page, stamped with WHICH SEND opened it.
 *
 * Until this existed the payload carried the literal `'./'`, so a push-driven return was
 * indistinguishable from an organic one. That made the single most expensive channel this game has
 * — one permission ask per install, one notification per device per race day — the only one with no
 * measurement behind it at all: "did the morning nudge bring anybody back" could not be asked, let
 * alone answered, so the ceiling was being spent on faith. The client reports it as a `from` prop on
 * the `app_open` it already fires (src/core/analytics.ts `pushSource`), never as a new event name —
 * the dashboard's views hardcode the names they chart, so a new NAME is stored perfectly and charted
 * nowhere until a migration ships, where a new PROP is queryable the moment it lands.
 *
 * ⚠️ A QUERY PARAM ON A RELATIVE URL. Every clause there is load-bearing:
 *   · RELATIVE (`./…`) because the game answers on two origins from a sub-path on each
 *     (corruptfun.github.io/viva-maya/ and corrupt.solutions/games/viva-maya/, see
 *     core/originmigrate.ts). An absolute URL here would land half the audience on the OTHER
 *     origin — a different localStorage, a different save, a different push subscription.
 *   · THE QUERY, NEVER THE FRAGMENT. The fragment is spoken for: it is how the origin handoff
 *     carries a player's entire profile between those two origins, and a marker sharing that space
 *     is a marker that can collide with a save.
 *   · The `./?from=` PREFIX is also what public/push-sw.js matches on to decide that a tap on an
 *     already-open window should FOCUS rather than navigate — and navigate() is a reload, on a game
 *     whose endless run is deliberately not resumable. Change this prefix and read that file first.
 *
 * ⚠️ The client half validates against exactly these three names and drops anything else, so a
 * FOURTH mode added here without being added there is not an error — it is a silent zero on the new
 * mode's attribution, which reads as "nobody came back" rather than as a bug. `pushcadence.test.ts`
 * pins the two sides against each other.
 */
export function notificationUrl(mode) {
  return `./?from=push-${mode}`
}

async function main() {
  // The modes are mutually exclusive by definition — they read different audience columns and say
  // different things. Both flags together would silently run as `--drop` against a `daily_play`
  // audience while every `DAILY`-gated branch below still believed it was the evening job, which is
  // a confusing enough hour to spend that it is worth one line to make impossible.
  if (DROP && DAILY) {
    console.error('--drop and --daily are different sends; pass one')
    process.exit(1)
  }
  requireConfig()
  const now = new Date()
  const today = dayKey(now)
  const key = DROP ? today : DAILY ? today : weekKey(now)
  const hrs = hoursLeft(now)
  const mode = DROP ? 'drop' : DAILY ? 'daily' : 'week'
  const gift = dropForDay(today)

  // The audience: opted in to THIS category, and not a known corpse. Each mode's predicate matches
  // a partial index — `week_race` from 0011, `daily_play` from 0025.
  //
  // ⚠️ A 400 here on `--drop` almost certainly means migration 0025 has not been applied: PostgREST
  // answers a filter on a missing column with a 400, and exiting loudly is the intended behaviour.
  // The alternative — silently falling back to the `week_race` audience — would blast every race
  // subscriber at nine in the morning with a message they never opted into. See 0025's header.
  const column = DROP ? 'daily_play' : 'week_race'
  const subsRes = await rest(
    `push_subscriptions?select=endpoint,p256dh,auth,user_id,device_id,created_at,last_sent_at` +
      `&${column}=is.true&failure_count=lt.5`
  )
  if (!subsRes.ok) {
    console.error(`could not read subscriptions: ${subsRes.status} ${await subsRes.text()}`)
    if (DROP) console.error('a 400 on --drop usually means migration 0025 (daily_play) is not applied yet')
    process.exit(1)
  }
  const all = await subsRes.json()

  // ── GUARD 1: one notification per device per race day, before anything else is read ───────────
  const eligible = all.filter(s => !sentToday(s, today))
  const alreadySent = all.length - eligible.length

  // ── GUARD 2: the activity split — who was here yesterday ──────────────────────────────────────
  // The two guards are ordered this way on purpose: the activity read costs two round trips and is
  // pointless for a device that is already out on the one-a-day rule.
  //
  // ⚠️ THE TWO MODES FAIL IN OPPOSITE DIRECTIONS, DELIBERATELY.
  //   --drop FAILS CLOSED. It is a new send whose entire audience definition is "was not here
  //     yesterday"; without that answer it degrades to a 9am blast at everyone, including the
  //     player who finished a level ten minutes ago. Sending nothing is strictly better.
  //   --daily FAILS OPEN. It is the send that has been shipping since 0011, and its audience filter
  //     is a refinement rather than its premise. Losing an evening's race reminders to a transient
  //     read failure would be a regression caused by a feature that is supposed to add reach.
  // The weekly mode reads no activity at all — see the header.
  //
  // ⚠️ The guard is per ENDPOINT, and a device can briefly hold two rows — the push service rotates
  // an endpoint and `register_push_subscription` inserts the new one while the old lingers. That is
  // not deduped here on purpose: picking one row per device would pick the DEAD one half the time,
  // dropping the notification AND leaving the corpse un-retired. The old endpoint answers 410 on the
  // next send and is deleted, so exactly one message lands either way.
  const deviceIds = [...new Set(eligible.map(s => s.device_id))]
  const lastSeen = mode === 'week' || !eligible.length ? new Map() : await fetchLastSeen(deviceIds, now)
  if (!lastSeen) {
    if (DROP) {
      console.error('could not read activity — sending nothing rather than nudging players who are already here')
      return
    }
    console.warn('could not read activity — sending the race reminder to the whole audience')
  }
  const seen = lastSeen ?? new Map()
  /** Days since this device was last seen, or null when it has never emitted an event we can read. */
  const awayOf = sub => {
    const day = seen.get(sub.device_id)
    return day ? Math.max(0, daysBetweenKeys(day, today)) : null
  }

  let subs = eligible
  let heldBack = 0
  if (DROP) {
    subs = eligible.filter(sub => {
      const away = awayOf(sub)
      // Here today, or here yesterday: today's player needs no invitation, and yesterday's player
      // belongs to the evening slot, which has a better thing to say to them.
      if (away !== null && away <= 1) return false
      return backoffAllows(sub, away, now)
    })
    heldBack = eligible.length - subs.length
  } else if (DAILY && lastSeen) {
    // The mirror image: the evening race reminder is for the people who were here yesterday. Anyone
    // else already had their turn this morning, or is being deliberately left alone.
    subs = eligible.filter(sub => awayOf(sub) === 1)
    heldBack = eligible.length - subs.length
  }

  // ── The personalisation reads ────────────────────────────────────────────────────────────────
  // The standings, best first — the SAME ordering the app's fetchDailyBoard / fetchWeeklyBoard use,
  // so a rank computed here matches the rank the player sees in the app. A disagreement between the
  // two would be worse than sending nothing.
  //
  // The weekly rows come from the endless_weekly_totals VIEW and rank on `total`, so they are
  // normalised to `score` on the way in — everything downstream then treats one shape and the
  // personalisation branches stay cadence-agnostic.
  //
  // Skipped entirely for `--drop`: the morning nudge is about the gift, not the board, and reading a
  // leaderboard to send a message that never mentions one is a round trip for nothing.
  let board = []
  if (!DROP && subs.length) {
    const boardRes = await rest(
      DAILY
        ? `endless_daily_scores?select=user_id,display_name,score&day_key=eq.${key}&order=score.desc,scored_at.asc`
        : `endless_weekly_totals?select=user_id,display_name,total,days_played&week_key=eq.${key}&order=total.desc,days_played.desc,last_scored_at.asc`
    )
    const raw = boardRes.ok ? await boardRes.json() : []
    board = DAILY ? raw : raw.map(r => ({ ...r, score: r.total }))
    if (!boardRes.ok) console.warn(`could not read the board: ${boardRes.status} — sending the impersonal copy`)
  }

  // The save-blob facts (streak + jackpot meter, PRIVATE) and the level ladder (public), for the
  // two personalised sends and only for the signed-in subscribers who can have them. The weekly
  // season reads neither — it is a summary, not a nudge.
  const signedIn = mode === 'week' ? [] : [...new Set(subs.filter(s => s.user_id).map(s => s.user_id))]
  const facts = signedIn.length ? await fetchPlayerFacts(signedIn) : new Map()
  const cleared = signedIn.length ? await fetchCleared(signedIn) : new Map()
  /** The level to name for this subscriber, or null when unknown or past the ladder's end. */
  const nextLevelOf = sub => {
    const won = sub.user_id ? cleared.get(sub.user_id) : undefined
    return won && won + 1 <= LEVEL_COUNT ? won + 1 : null
  }

  console.log(
    `${mode} ${key} · ends in ${hrs}h · ${all.length} opted in · ${alreadySent} already sent today · ` +
      `${heldBack} held back · ${subs.length} due` +
      (DROP ? ` · today's gift: ${gift.id}` : ` · ${board.length} on the board`)
  )
  if (!subs.length) return

  let sent = 0
  let retired = 0
  let failed = 0
  /** Composed messages per hook — the run's only per-branch observability outside `--dry-run`. */
  const hooks = {}

  for (const sub of subs) {
    const msg = DROP
      ? messageForDrop(gift, awayOf(sub), jackpotWinsAway(facts.get(sub.user_id)), nextLevelOf(sub))
      : messageFor(
          sub,
          board,
          hrs,
          DAILY ? streakAtRisk(facts.get(sub.user_id), today) : null,
          DAILY ? jackpotWinsAway(facts.get(sub.user_id)) : null,
          DAILY ? nextLevelOf(sub) : null
        )
    const { title, body, hook } = msg
    hooks[hook] = (hooks[hook] ?? 0) + 1
    // The tag collapses a re-send onto the same notification rather than stacking a second one; it
    // is per-BOARD and per-MODE so no reminder can ever overwrite another in the tray. It is NOT
    // what carries the attribution — `url` is (see notificationUrl); the tag never leaves the tray.
    const payload = JSON.stringify({ title, body, tag: `${mode}-${key}`, url: notificationUrl(mode) })

    if (DRY) {
      // Identify the recipient well enough to audit the audience, WITHOUT printing the endpoint
      // path: that path is a bearer capability (anyone holding it can notify the device) and this
      // log is readable by anyone who can see the repo's Actions runs. Host + age + whether it is
      // attached to an account is enough to tell a real subscriber from a leftover test row.
      const host = (() => {
        try {
          return new URL(sub.endpoint).host
        } catch {
          return 'unparseable'
        }
      })()
      const who = sub.user_id ? `user:${sub.user_id.slice(0, 8)}` : 'anon'
      // ⚠️ THE HOOK NAME, NOT THE BODY, FOR ANYTHING BUILT ON PRIVATE DATA. A leaderboard rank and
      // a display name are already public, so the race copy prints in full as it always has. A
      // STREAK COUNT and a JACKPOT METER are not published anywhere, and this repo is public — its
      // Actions logs with it — so printing "Your 34-day streak ends at midnight" here would
      // publish, in a place nobody thinks of as a surface, a number the game itself never shows to
      // anyone but its owner. (The jackpot body's LEVEL number is public on its own, but the body
      // exists only because of the meter, so the whole line is withheld with it.)
      // The hook name is what a dry run is actually for: it proves which branch fired and for whom.
      const shown = PRIVATE_HOOKS.has(hook)
        ? `(${hook} hook — body withheld from the log)`
        : `${title} :: ${body}`
      console.log(`  [dry] ${who} via ${host} (device ${String(sub.device_id).slice(0, 8)}) → [${hook}] ${shown}`)
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

  // The hook tally counts COMPOSED messages (a soft-fail still counts its hook) — enough to watch
  // which branch is carrying the send from a scheduled run's log without printing anybody's body.
  const hookLine = Object.entries(hooks)
    .map(([h, n]) => `${h}:${n}`)
    .join(' ')
  console.log(
    `${DRY ? '[dry-run] ' : ''}sent ${sent} · retired ${retired} · soft-failed ${failed}` +
      (hookLine ? ` · hooks ${hookLine}` : '')
  )
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

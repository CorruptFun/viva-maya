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
 * ⚠️ **AT MOST `DAILY_SEND_CAP` NOTIFICATIONS PER DEVICE PER RACE DAY, ACROSS EVERY MODE BELOW, AND
 * NEVER TWO INSIDE `MIN_GAP_HOURS`.** Not a guideline — it is the thing that makes it honest to
 * nudge more than once, and it is enforced three ways so it stays true rather than merely intended:
 *
 *   1. Every mode has to have SOMETHING TRUE AND SPECIFIC TO SAY or it stays silent (`dueForMode`).
 *      This is the primary control, and it is what keeps the volume well under the cap in practice:
 *      the morning gift skips anyone already here today, the afternoon quest nudge fires ONLY for
 *      somebody already here with an unfinished slate, and the evening board says nothing at all to
 *      a player who is already playing, off the board and holding no streak or wheel.
 *   2. Every send re-checks the day's BUDGET (`budgetAllows`) — a per-race-day counter (migration
 *      0028) and a minimum gap. That covers the seams the mode gates cannot: a manual run beside a
 *      scheduled one, a retried cron, and any future mode added by somebody who has not read this.
 *   3. A device that keeps being nudged without coming back BACKS OFF (`backoffAllows`) — to every
 *      third day, then weekly, then not at all. Somebody who has ignored seven nudges will ignore the
 *      eighth, and is one tap from switching notifications off forever.
 *
 * ⚠️ THIS RULE USED TO BE "ONE A DAY", ENFORCED BY DISJOINT AUDIENCES, AND THAT CONSTRUCTION FAILED
 * SILENTLY. `--drop` took `away >= 2` and `--daily` took `away === 1`, which between them look like
 * a partition of everybody and leave out `away === 0` — the player who opens the game every single
 * day. All four live subscribers sat there, and from 2026-08-25 every scheduled run reported
 * `4 opted in · 4 held back · 0 due` and delivered nothing, green, for two days. The owner's call
 * (2026-08-26) was to nudge a few times through the day instead; `dueForMode` carries the full
 * story, and the away-histogram on every run's log line exists so a repeat cannot hide the same way.
 *
 * The audience is opted in on a card that prints this volume (src/view/pushoptin.ts VOLUME_RULE —
 * `DAILY_SEND_CAP` is the same number, change one and change both), and migration 0025's header
 * records why the second category was allowed to default ON for the people who opted in under the
 * first one's wording. Read both before widening anything here.
 *
 * ── THE MODES ────────────────────────────────────────────────────────────────────────────────────
 *   --drop      MORNING (≈9am at home). The play nudge, for anyone not already here today. Leads with
 *               a JACKPOT WHEEL within reach when this player has one (jackpotWinsAway), else carries
 *               the day's HOUSE GIFT by name — "a JACKPOT CHIP is on the table" — which it can do
 *               because the gift is seeded from the day alone and this file carries a byte-identical
 *               copy of the roll (see dropForDay). Audience column: `daily_play` (0025).
 *   --quests    AFTERNOON (≈1pm at home). The only mode that fires for somebody who IS here today:
 *               an unfinished quest slate is the most closable thing in the game (src/core/quests.ts
 *               — "a finite amount of play now has an end"). Counts goals, never names one; see
 *               `questsOpen`. Audience column: `daily_play`.
 *   --daily     EVENING (≈6pm at home). Today's board closes at midnight America/Edmonton. Goes to
 *               anyone with real news — on the board, a streak about to break, a wheel within reach,
 *               or simply not here yet today. Leads streak → jackpot → standing. Audience column:
 *               `week_race` (0011).
 *   --laststand LATE (≈9pm at home, three hours before the streak dies). The narrowest gate in the
 *               file: a live, unsecured streak and nothing else. The most valuable sentence this
 *               sender can say, which is what earns it a slot rather than a branch. Audience column:
 *               `daily_play`.
 *   (default)   SUNDAY EVENING. The weekly season, which closes Monday midnight America/Edmonton,
 *               ranked on the SUM of daily bests from the endless_weekly_totals view. Deliberately
 *               the one mode with NO activity filter: a season summary silenced for anyone who
 *               drifted off mid-week would be silent for exactly the people it is for.
 *
 * All five share every line of plumbing below — audience, retire-on-410, failure counting, the day's
 * budget — because the only real differences are which partition to read and what to say.
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
 *   node scripts/send-push.mjs --dry-run               # weekly, print what would be sent
 *   node scripts/send-push.mjs --daily --dry-run       # today's board
 *   node scripts/send-push.mjs --drop --dry-run        # the morning play nudge
 *   node scripts/send-push.mjs --quests --dry-run      # the afternoon quest nudge
 *   node scripts/send-push.mjs --laststand --dry-run   # the late streak rescue
 *   node scripts/send-push.mjs --drop --explain        # WHY each device was or was not sent to
 *   node scripts/send-push.mjs                         # send
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
/** Per-device decision lines in the log. The diagnostic for "why did nobody get one". */
const EXPLAIN = process.argv.includes('--explain')

/**
 * THE FIVE SENDS, and the flag that selects each.
 *
 * A single MODE rather than the boolean-per-flag this replaced: with two sends a pair of booleans is
 * readable, and with five it is a truth table where `--quests --laststand` has a meaning nobody
 * intended. `DROP`/`DAILY` survive as derived constants because the copy builders below branch on
 * them by name, and renaming those is churn with no reader benefit.
 */
const MODE_FLAGS = {
  '--drop': 'drop',
  '--quests': 'quests',
  '--daily': 'daily',
  '--laststand': 'laststand',
}

/**
 * ⚠️ Returns rather than exits, and the mode conflict is reported by `main`.
 *
 * This module is imported by src/core/pushcadence.test.ts to pin its pure helpers, and a
 * `process.exit()` reached at module scope takes the whole test runner down with it — the same
 * reason `requireConfig` is a function. No flags at all means the weekly season, so a bare
 * `node scripts/send-push.mjs` keeps the behaviour it has always had.
 */
function parseMode(argv) {
  const picked = [...new Set(argv.filter(a => a in MODE_FLAGS).map(a => MODE_FLAGS[a]))]
  if (argv.includes('--auto')) picked.push('auto')
  return { mode: picked[0] ?? 'week', conflict: picked.length > 1, picked }
}

/**
 * `--auto`: let the HOME CLOCK pick the mode (`modeForClock`), which is how every scheduled run
 * works now. `--force`: send an explicit mode outside its slot anyway — for a deliberate manual run,
 * never for a cron (see `SLOTS` for why a cron must not be trusted with a fixed hour).
 */
const AUTO = process.argv.includes('--auto')
const FORCE = process.argv.includes('--force')

const { mode: PARSED_MODE, conflict: MODE_CONFLICT, picked: MODES_PICKED } = parseMode(process.argv)

/**
 * The mode this run is, and the four derived booleans the copy builders branch on by name.
 *
 * `let`, not `const`: under `--auto` the mode is not knowable until `main` has looked at the clock,
 * and everything below reads these at call time rather than at import. `selectMode` is the ONLY
 * writer, so a run can never be half one mode and half another.
 */
let MODE = 'week'
let DAILY = false
let DROP = false
let QUESTS = false
let LASTSTAND = false

function selectMode(mode) {
  MODE = mode
  DAILY = mode === 'daily'
  DROP = mode === 'drop'
  QUESTS = mode === 'quests'
  LASTSTAND = mode === 'laststand'
}
selectMode(PARSED_MODE === 'auto' ? 'week' : PARSED_MODE)

/**
 * THE VOLUME PROMISE, IN CODE. `src/view/pushoptin.ts`'s VOLUME_RULE prints this number to every
 * player deciding whether to hand over a notification permission — change one, change both, and
 * read that constant's comment first.
 *
 * Three is the number the four weekday slots can actually reach, not a ceiling picked to sound
 * modest: the slots are gated so a given player matches at most three of them on any real day (the
 * morning gift skips anyone already here; the quest nudge fires ONLY for somebody already here).
 * The cap is therefore a BACKSTOP against a fifth slot, a retried cron or a manual run landing
 * beside a scheduled one — not the primary control. The primary control is that every mode has to
 * have something true and specific to say or it stays silent.
 */
export const DAILY_SEND_CAP = 3

/**
 * Never two notifications inside this many hours, whatever the modes think.
 *
 * The slots (`SLOTS`) are laid out so this can never lock a later slot out: the evening board's
 * slot closes at 19:00 and the last call's runs 20:00–23:30, so even a board reminder that lands
 * at 18:59 leaves the last call an hour and a half of its slot. Two hours is far enough apart that
 * no player experiences a double-tap, and short enough that it never eats a slot. (This used to
 * be justified against a cron timetable and "10–30 minutes of scheduler drift"; the drift turned
 * out to be hours — see `SLOTS`.)
 */
export const MIN_GAP_HOURS = 2

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

/**
 * The instant RACE_TZ's clocks read `minutes` past midnight on `key` — two-pass for the DST seams.
 * `raceMidnight` is the zero case; the slot windows below are the others.
 */
export function raceInstant(key, minutes = 0) {
  const naive = Date.parse(`${key}T00:00:00Z`) + minutes * 60000
  let t = naive - raceOffsetMs(new Date(naive))
  t = naive - raceOffsetMs(new Date(t))
  return new Date(t)
}

/** The instant RACE_TZ's clocks strike midnight opening `key`. */
function raceMidnight(key) {
  return raceInstant(key, 0)
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
  const ends = MODE === 'week' ? weekEndsAt(now) : dayEndsAt(now)
  return Math.max(0, Math.round((ends.getTime() - now.getTime()) / 3600000))
}

/**
 * THE DAY'S SLOTS, ON THE HOME CLOCK — minutes past midnight America/Edmonton, `[from, until)`.
 *
 * ⚠️ THE CLOCK PICKS THE MODE. THE CRON DOES NOT. Until 2026-09-03 each mode had its own cron and
 * the workflow decided which send this was from WHICH cron had fired. GitHub's scheduler is not a
 * clock: measured over 2026-08-26 → 09-03 on this repo, the 15:00 UTC entry ran 3.1–3.4 h late, the
 * 19:00 one 2.4–4.9 h, the 00:00 one 2.4–3.0 h, and the 03:00 one — the ~9pm streak last call —
 * 4.7 to 10.9 HOURS late. That last one therefore fired at 1:40–2:00 AM on the home clock, past
 * the midnight the message is about, so it landed on the NEXT race day, read
 * "your streak ends at midnight, in 22 hours", and (under the one-a-day fallback the sender was
 * running in, because migration 0028 had not been applied) spent that device's whole day on it.
 * The player whose phone that was saw one strange 2 AM message a day and nothing else, ever.
 *
 * So the workflow now runs ONE cron, hourly, with `--auto`, and each run asks the home clock which
 * slot it is standing in. A run that lands late still lands in a slot; a run that lands in the
 * quiet hours does nothing; and a slot that has already been served to a device is skipped for that
 * device (`sentInSlot`), so two runs in one slot are one notification. The slots are what keep the
 * copy honest — `laststand` closes at 23:30 because the sentence it says is about THIS midnight.
 *
 * Spacing: `daily` ends an hour before `laststand` opens, and `laststand` outlasts `daily` by more
 * than MIN_GAP_HOURS, so a board reminder that lands at the very end of its slot can never lock the
 * last call out (src/core/pushcadence.test.ts pins that). Sunday's season summary takes the evening
 * board's slot (`modeForClock`), exactly as the old Monday-00:00-UTC cron did.
 */
export const SLOTS = [
  { mode: 'drop', from: 8 * 60, until: 12 * 60 },
  { mode: 'quests', from: 12 * 60, until: 16 * 60 },
  { mode: 'daily', from: 16 * 60, until: 19 * 60 },
  { mode: 'laststand', from: 20 * 60, until: 23 * 60 + 30 },
]

/** The slot a mode runs in. `week` shares the evening board's. */
export function slotFor(mode) {
  return SLOTS.find(s => s.mode === (mode === 'week' ? 'daily' : mode)) ?? null
}

/** Minutes past midnight on the home clock, whether it is Sunday there, and "HH:MM" for the log. */
function homeClock(at) {
  const w = raceWallClock(at)
  const dow = new Date(Date.parse(`${dayKey(at)}T00:00:00Z`)).getUTCDay() // 0 = Sunday
  return { minutes: w.h * 60 + w.mi, sunday: dow === 0, label: `${pad2(w.h)}:${pad2(w.mi)}` }
}

/** "08:00–12:00", for the log. */
export function slotLabel(slot) {
  const f = m => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
  return `${f(slot.from)}–${f(slot.until)}`
}

/**
 * Which send is due at this instant, by the home clock — or null in the quiet hours.
 *
 * Sunday evening is the season, not the board: the weekly total closes Monday midnight, and the
 * evening slot is the one place both modes would otherwise say something about "the race".
 */
export function modeForClock(now = new Date()) {
  const { minutes, sunday } = homeClock(now)
  const slot = SLOTS.find(s => minutes >= s.from && minutes < s.until)
  if (!slot) return null
  return { mode: slot.mode === 'daily' && sunday ? 'week' : slot.mode, slot }
}

/** Is this mode's slot open right now on the home clock? */
export function windowOpen(mode, now = new Date()) {
  const slot = slotFor(mode)
  if (!slot) return false
  const { minutes } = homeClock(now)
  return minutes >= slot.from && minutes < slot.until
}

/**
 * Has this device already been sent to since this slot opened today?
 *
 * The per-device latch that makes an hourly cron safe: the second, third and fourth run to land in
 * one slot find every device the first one served and skip them. Compared against the slot's
 * OPENING instant on today's race day, not against elapsed hours — a send from the previous slot is
 * not this slot's, and the minimum gap already stops two landing back to back.
 */
export function sentInSlot(sub, slot, now = new Date()) {
  if (!sub || !sub.last_sent_at || !slot) return false
  const at = Date.parse(sub.last_sent_at)
  if (!Number.isFinite(at)) return false
  return at >= raceInstant(dayKey(now), slot.from).getTime()
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
 * THE LEGACY ONE-A-DAY RULE, kept for exactly one job: the fallback when migration 0028 has not
 * been applied and `sends_count` cannot be read. `budgetAllows` is what the sender normally uses.
 *
 * ⚠️ Compared on the RACE day key, not on elapsed hours: a day means a BOARD, and the morning slot
 * (≈9am) and the evening slot (≈6pm) are only nine hours apart on the same one.
 */
export function sentToday(sub, today) {
  if (!sub.last_sent_at) return false
  const at = Date.parse(sub.last_sent_at)
  return Number.isFinite(at) && dayKey(new Date(at)) === today
}

/**
 * How many notifications this device has already had on today's race day.
 *
 * The counter is stored beside the day it belongs to (migration 0028) rather than swept nightly, so
 * a stale `sends_day` reads as zero — a device last written to on a previous board starts today's
 * budget fresh with nothing to reset and no second job to run.
 */
export function sendsToday(sub, today) {
  if (!sub || sub.sends_day !== today) return 0
  const n = Number(sub.sends_count)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * May this device be sent to right now — the volume half of the decision, before any mode has said
 * whether it has anything to say.
 *
 * TWO BOUNDS, because they stop different things. The CAP stops a day exceeding what the opt-in
 * card promises, and survives somebody adding a fifth cron without reading the header. The GAP
 * stops two landing back to back, which is the thing a player actually experiences as spam — a
 * manual `workflow_dispatch` beside a scheduled run, or a cron GitHub retried.
 *
 * `legacy` is the un-migrated path: no counter to read, so it falls back to the pre-0028 rule of one
 * per race day. That errs QUIET (see 0028's header), which is the correct side for a budget to fail
 * toward when it cannot see its own accounting.
 */
export function budgetAllows(sub, today, now, { cap = DAILY_SEND_CAP, gapHours = MIN_GAP_HOURS, legacy = false } = {}) {
  if (legacy) return !sentToday(sub, today)
  if (sendsToday(sub, today) >= cap) return false
  if (!sub.last_sent_at) return true
  const at = Date.parse(sub.last_sent_at)
  if (!Number.isFinite(at)) return true
  return now.getTime() - at >= gapHours * 3600000
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
 * Whether THIS mode has anything to say to THIS subscriber — the content half of the decision,
 * beside `budgetAllows`' volume half.
 *
 * ⚠️ THIS FUNCTION IS THE FIX FOR A REAL, MEASURED OUTAGE, AND THE SHAPE OF IT IS THE LESSON.
 * Until 2026-08-26 the two weekday slots partitioned the audience by activity: `--drop` took
 * "was NOT here yesterday" (`away >= 2`) and `--daily` took "was here EXACTLY yesterday"
 * (`away === 1`). Disjoint, and between them they looked like they covered everyone. They did not
 * cover `away === 0` — a player who opens the game EVERY day, which is to say the best players
 * there are. All four live subscribers sat exactly there, and from the day the split shipped every
 * scheduled run reported `4 opted in · 4 held back · 0 due` and sent nothing at all. Nothing
 * errored. The run was green, the log line read like a healthy quiet state, and the vault note from
 * the session that shipped it recorded "0 sends is the CORRECT quiet state" in good faith.
 *
 * The lesson is that an audience defined by a RANGE has to be checked for the values that fall
 * outside every range, and the value that fell outside was the one belonging to the most engaged
 * players. `pushcadence.test.ts` now asserts the total property directly — a daily-active player
 * must match at least one weekday mode — so the same hole cannot be reopened by tuning a bound.
 *
 * The gates, and why each is drawn where it is:
 *   · `drop` (morning gift) — anyone who has not ALREADY been here today. It used to be `>= 2`.
 *     Yesterday's player is exactly who a gift is for; only somebody who has opened the app since
 *     midnight needs no invitation to it.
 *   · `quests` (afternoon) — ONLY somebody here today with unfinished quests. The one mode that
 *     requires presence rather than absence: a checklist half-done is a reason to come back and
 *     finish, and an untouched one belongs to the morning slot that already spoke to them.
 *   · `daily` (evening board) — anyone with real news: on today's board, a streak about to break, a
 *     jackpot wheel within reach, or simply not here yet today. Someone already playing, off the
 *     board and with no personal hook gets NOTHING, because "the board closes soon" is not news to
 *     a person holding the phone.
 *   · `laststand` (late) — a streak that dies at midnight and has not been secured. Nothing else.
 *     The narrowest gate in the sender and the most valuable sentence it can say.
 *   · `week` (season) — everyone, unchanged. A summary silenced for whoever drifted off mid-week is
 *     silent for exactly the people it is for.
 *
 * Pure and ctx-shaped rather than reading a subscriber row, so every branch is testable without a
 * network, a clock or a save blob.
 */
export function dueForMode(mode, ctx = {}) {
  const { away = null, streakDays = null, questsOpen = null, onBoard = false, winsAway = null } = ctx
  switch (mode) {
    case 'drop':
      // `null` is UNKNOWN, not "here today" — a player who turned events off must not be silently
      // dropped from the one slot that never needed to know where they had been.
      return away === null || away >= 1
    case 'quests':
      return away === 0 && questsOpen !== null && questsOpen > 0
    case 'daily':
      return onBoard || streakDays !== null || winsAway !== null || away === null || away >= 1
    case 'laststand':
      return streakDays !== null
    case 'week':
      return true
    default:
      return false
  }
}

/**
 * Whether the absence backoff applies to this mode.
 *
 * The two BROAD modes decay with absence, because somebody who has ignored seven of them will
 * ignore the eighth. The two NARROW ones do not: both are gated on a specific, time-critical fact
 * about this player today — an unfinished quest slate, a streak hours from breaking — and throttling
 * those on the grounds that the player has been quiet is throttling the only messages that could
 * change that. `week` is exempt for the reason in `dueForMode`.
 */
export function backoffApplies(mode) {
  return mode === 'drop' || mode === 'daily'
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
      const q = d.quests && typeof d.quests === 'object' ? d.quests : null
      out.set(row.user_id, {
        streak: Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0,
        lastSpinDate: typeof d.lastSpinDate === 'string' ? d.lastSpinDate : null,
        jackpotMeter: Number.isFinite(meter) ? Math.max(0, Math.floor(meter)) : 0,
        // Only the two fields the nudge can act on. `progress` is deliberately dropped on the
        // floor: how far into a goal somebody is says nothing this message needs, and the less of
        // a player's save this function carries out, the less there is to leak into a public log.
        quests: q
          ? { day: typeof q.day === 'string' ? q.day : '', claimed: Array.isArray(q.claimed) ? q.claimed : [] }
          : null,
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
 * THE QUEST SLATE'S SHAPE — src/core/quests.ts QUEST_COUNT / ALL_CLEAR_ID / ALL_CLEAR_CHIPS /
 * ALL_CLEAR_SPINS, and nothing else from that module.
 *
 * ⚠️ THE CATALOG IS DELIBERATELY NOT DUPLICATED HERE, unlike `dayKey`, `weekKey` and the house
 * gift's roll. Those three had to be copied because the sender must compute the SAME answer the app
 * computes. This one must not be, because the copy never names a goal: "two of three done" is true
 * whichever three the day drew, whereas "win two levels" is a specific claim that would become a LIE
 * the first time the catalog was retuned and this copy was not — and quests.ts's own header warns
 * that reordering the catalog silently re-rolls every day's draw. Four small constants can be pinned
 * against the app's copies in a test; forty lines of catalog drifting silently cannot.
 */
export const QUEST_COUNT = 3
export const ALL_CLEAR_ID = 'all'
export const ALL_CLEAR_CHIPS = 20
export const ALL_CLEAR_SPINS = 1

/**
 * How many of today's quests this player has NOT finished — 0…QUEST_COUNT, or null when unknowable.
 *
 * A slate whose `day` is not today has not rolled over on that player's device yet, which means they
 * have done nothing on today's slate: all of them are open. That is the common case for this hook,
 * since the afternoon slot fires for people who opened the app without yet tripping a quest signal.
 *
 * ⚠️ `ALL_CLEAR_ID` is filtered out of the claimed list. It is the all-three bonus, not a fourth
 * goal, and counting it would make a finished slate report -1 open — which `dueForMode` would read
 * as "nothing due" by luck rather than by rule, and which would print "4 of 3 done" the day
 * somebody wrote the inverse copy.
 *
 * Null on a signed-out subscriber, a missing save row or a malformed blob: a missing
 * personalisation must never cost a notification, and here it costs only this mode's send — which
 * is correct, because this mode is ENTIRELY about the slate.
 */
export function questsOpen(info, today) {
  const q = info && info.quests
  if (!q) return null
  if (q.day !== today) return QUEST_COUNT
  const claimed = Array.isArray(q.claimed) ? q.claimed.filter(id => id !== ALL_CLEAR_ID).length : 0
  return Math.max(0, QUEST_COUNT - claimed)
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
const PRIVATE_HOOKS = new Set(['streak', 'jackpot', 'quests', 'laststand'])

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
 * THE AFTERNOON QUEST NUDGE (`--quests`) — for somebody who is already playing today and has an
 * unfinished slate.
 *
 * The whole value of a quest slate is that it ENDS (src/core/quests.ts: "what is new is that a
 * finite amount of play now has an end, and the end is visible from the start"), and a checklist
 * with two of three ticked is the most closable thing this sender can point at. That is why this is
 * the one mode gated on PRESENCE rather than absence — it finishes something already started.
 *
 * ⚠️ NEVER NAMES A GOAL, only counts them. See `questsOpen`'s note: the catalog is not duplicated
 * into this file, so a named goal here would be a claim this script cannot verify and would go
 * stale silently the first time the catalog was retuned.
 *
 * ⚠️ The bonus is named from the constants, never spelled inline. `ALL_CLEAR_CHIPS`/`ALL_CLEAR_SPINS`
 * are pinned against the app's copies for the reason every duplicated constant in this file is: a
 * drift makes the notification promise a payout the game does not hand over.
 */
function messageForQuests(open) {
  const done = QUEST_COUNT - open
  const bonus = `all ${QUEST_COUNT} pays a ${ALL_CLEAR_CHIPS}-chip bonus and a free spin`
  if (done === 0) {
    return {
      hook: 'quests',
      title: `📋 Today's ${QUEST_COUNT} quests are still open`,
      body: `A short list, drawn fresh this morning — and clearing ${bonus}.`,
    }
  }
  return {
    hook: 'quests',
    title: `📋 ${done} of ${QUEST_COUNT} quests done`,
    body:
      open === 1
        ? `One left on today's slate — and finishing ${bonus}.`
        : `${open} left on today's slate — and finishing ${bonus}.`,
  }
}

/**
 * THE LATE STREAK RESCUE (`--laststand`) — the narrowest send in the file and the most valuable
 * sentence it can say.
 *
 * `streakAtRisk` has already established the streak is alive, at least two days deep and NOT yet
 * secured today, so every word here is true at composition time. The ladder it indexes pays real
 * purses at 3/7/14/30/60/100 consecutive days (core/daily.ts STREAK_REWARDS), and unlike every other
 * hook the thing at stake is lost PERMANENTLY at a known hour — which is what earns it a slot of its
 * own three hours before that hour rather than a branch inside the evening send.
 *
 * ⚠️ Quotes the deadline from the real clock like every other message, so a cron GitHub ran late
 * reports a smaller number rather than saying anything untrue.
 */
function messageForLastStand(streakDays, hrs) {
  const when = hrs <= 1 ? 'in under an hour' : `in ${hrs} hours`
  return {
    hook: 'laststand',
    title: `🔥 Last call — your ${streakDays}-day streak`,
    body: `It ends at midnight, ${when}. One pull on LUCKY SLOTS keeps it alive.`,
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
 * — one permission ask per install, a handful of notifications per device per race day — the only
 * one with no
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
  // different things. Two flags together would silently run as whichever `parseMode` saw first while
  // every mode-gated branch below still believed it was the other job.
  if (MODE_CONFLICT) {
    console.error(`these are different sends; pass one: ${MODES_PICKED.join(', ')}`)
    process.exit(1)
  }
  const now = new Date()
  const clock = homeClock(now)

  // ── GUARD 0: the clock ───────────────────────────────────────────────────────────────────────
  // Under `--auto` the home clock picks the mode, and the quiet hours pick nothing — that decision
  // is made BEFORE requireConfig so a run in the quiet hours costs no secrets and no round trips.
  // An explicit mode is held to its slot too: the whole reason the slots exist is that "which cron
  // fired" stopped meaning "what time it is", and a manual `--laststand` at 2 AM would say the same
  // untrue sentence a late cron did. `--dry-run` may look at any mode at any hour (it sends nothing,
  // and being able to audit the audience at 10 AM is the point of it); a real send outside its slot
  // needs `--force`, and refusing it is a red run rather than a quiet one so it gets noticed.
  if (AUTO) {
    const pick = modeForClock(now)
    if (!pick) {
      console.log(`auto · ${clock.label} at home · quiet hours — no slot is open, nothing to send`)
      return
    }
    selectMode(pick.mode)
  } else if (!windowOpen(MODE, now)) {
    const slot = slotFor(MODE)
    const where = slot ? `${slotLabel(slot)} at home` : 'no slot'
    if (DRY) {
      console.warn(`--${MODE} runs ${where}; it is ${clock.label} — a dry run proceeds, a real send would not`)
    } else if (!FORCE) {
      console.error(`--${MODE} runs ${where}; it is ${clock.label} — refusing to send outside its slot (pass --force to override)`)
      process.exit(1)
    } else {
      console.warn(`--${MODE} runs ${where}; it is ${clock.label} — sending anyway under --force`)
    }
  }
  requireConfig()
  const today = dayKey(now)
  const key = MODE === 'week' ? weekKey(now) : today
  const hrs = hoursLeft(now)
  const mode = MODE
  const slot = slotFor(mode)
  const gift = dropForDay(today)

  // The audience: opted in to THIS category, and not a known corpse. Each predicate matches a
  // partial index — `week_race` from 0011, `daily_play` from 0025.
  //
  // ⚠️ THE THREE PLAY-SIDE SENDS ALL RIDE `daily_play`, AND NO NEW CATEGORY COLUMN WAS ADDED.
  // Settings offers two switches (race / daily play) and they still partition every send: the
  // morning gift, the afternoon quest nudge and the late streak rescue are all "your game, today",
  // which is exactly what somebody switching `daily_play` off is switching off. A third column would
  // be a third switch for a distinction no player is asking to make, and every subscriber who ever
  // opted in would land in it by default anyway.
  //
  // ⚠️ A 400 here on a `daily_play` mode almost certainly means migration 0025 has not been applied:
  // PostgREST answers a filter on a missing column with a 400, and exiting loudly is intended. The
  // alternative — silently falling back to the `week_race` audience — would blast every race
  // subscriber with a message they never opted into. See 0025's header.
  const column = mode === 'daily' || mode === 'week' ? 'week_race' : 'daily_play'
  const BASE_COLS = 'endpoint,p256dh,auth,user_id,device_id,created_at,last_sent_at'
  const query = cols => `push_subscriptions?select=${cols}&${column}=is.true&failure_count=lt.5`

  // 0028's columns, with a fallback that keeps the run alive if the migration has not landed yet.
  // The retry is what distinguishes the two 400s: if dropping `sends_day,sends_count` fixes it, it
  // was 0028; if it does not, it is 0025 (or something else) and we exit loudly as before.
  let legacyBudget = false
  let subsRes = await rest(query(`${BASE_COLS},sends_day,sends_count`))
  if (!subsRes.ok && subsRes.status === 400) {
    const retry = await rest(query(BASE_COLS))
    if (retry.ok) {
      legacyBudget = true
      console.warn(
        'migration 0028 (sends_day/sends_count) is not applied — falling back to one notification ' +
          'per device per race day. The run still delivers; it just under-sends until 0028 lands.'
      )
      subsRes = retry
    }
  }
  if (!subsRes.ok) {
    console.error(`could not read subscriptions: ${subsRes.status} ${await subsRes.text()}`)
    if (column === 'daily_play') {
      console.error(`a 400 on --${mode} usually means migration 0025 (daily_play) is not applied yet`)
    }
    process.exit(1)
  }
  const all = await subsRes.json()

  // ── GUARD 1: the day's send budget, before anything else is read ─────────────────────────────
  // The cap and the gap together (see `budgetAllows`). Ordered first because it costs nothing and
  // the reads below cost round trips.
  // Then the slot latch: a device this slot has already reached today is done with it, whatever
  // the budget says — that is what lets the hourly cron land in one slot several times over.
  const budgetOf = s =>
    !budgetAllows(s, today, now, { legacy: legacyBudget })
      ? 'over budget'
      : sentInSlot(s, slot, now)
        ? 'had this slot'
        : null
  const eligible = all.filter(s => budgetOf(s) === null)
  const overBudget = all.filter(s => budgetOf(s) === 'over budget').length
  const slotDone = all.length - eligible.length - overBudget

  // ── GUARD 2: the activity read — how long since this device was last here ────────────────────
  //
  // ⚠️ THE MODES FAIL IN DIFFERENT DIRECTIONS, DELIBERATELY.
  //   --drop and --quests FAIL CLOSED. Both define their audience in terms of the answer (`drop`
  //     wants people not here yet today, `quests` wants people who ARE here), so without it they
  //     degrade to blasting everyone. Sending nothing is strictly better.
  //   --daily FAILS OPEN. It has been shipping since 0011 and its activity term is a refinement
  //     rather than its premise — it also fires on a board row, a streak or a jackpot meter, none
  //     of which need this read. Losing an evening to a transient failure would be a regression.
  //   --laststand and --week read no activity at all: one is gated purely on the save, the other
  //     goes to everyone.
  //
  // ⚠️ The guard is per ENDPOINT, and a device can briefly hold two rows — the push service rotates
  // an endpoint and `register_push_subscription` inserts the new one while the old lingers. That is
  // not deduped here on purpose: picking one row per device would pick the DEAD one half the time,
  // dropping the notification AND leaving the corpse un-retired. The old endpoint answers 410 on the
  // next send and is deleted, so exactly one message lands either way.
  const needsActivity = mode === 'drop' || mode === 'quests' || mode === 'daily'
  const deviceIds = [...new Set(eligible.map(s => s.device_id))]
  const lastSeen = !needsActivity || !eligible.length ? new Map() : await fetchLastSeen(deviceIds, now)
  if (!lastSeen) {
    if (DROP || QUESTS) {
      console.error(`could not read activity — sending nothing rather than guessing at --${mode}'s audience`)
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

  // ── The personalisation reads, BEFORE the audience filter ────────────────────────────────────
  // They moved ahead of the filter when `dueForMode` started consulting them: the evening send now
  // fires on a board row, a live streak or a wheel within reach, and the afternoon send is defined
  // entirely by the quest slate, so "who is due" cannot be answered until these are in hand.
  //
  // The cost is that the private save read now covers every subscriber inside the day's budget
  // rather than only the ones already selected. That is the same service-role read over the same
  // opted-in rows, and nothing new leaves this process — `fetchPlayerFacts` keeps three fields and
  // drops the rest of the blob on the floor, and PRIVATE_HOOKS still withholds anything built on
  // them from the log.
  //
  // The standings, best first — the SAME ordering the app's fetchDailyBoard / fetchWeeklyBoard use,
  // so a rank computed here matches the rank the player sees in the app. The weekly rows come from
  // the endless_weekly_totals VIEW and rank on `total`, so they are normalised to `score` on the way
  // in and everything downstream treats one shape.
  //
  // Skipped for the three sends that never mention a board: reading a leaderboard to compose a
  // message that cannot quote one is a round trip for nothing.
  let board = []
  if ((DAILY || mode === 'week') && eligible.length) {
    const boardRes = await rest(
      DAILY
        ? `endless_daily_scores?select=user_id,display_name,score&day_key=eq.${key}&order=score.desc,scored_at.asc`
        : `endless_weekly_totals?select=user_id,display_name,total,days_played&week_key=eq.${key}&order=total.desc,days_played.desc,last_scored_at.asc`
    )
    const raw = boardRes.ok ? await boardRes.json() : []
    board = DAILY ? raw : raw.map(r => ({ ...r, score: r.total }))
    if (!boardRes.ok) console.warn(`could not read the board: ${boardRes.status} — sending the impersonal copy`)
  }

  // The save-blob facts (streak, jackpot meter and quest slate — all PRIVATE) and the level ladder
  // (public). The weekly season reads neither: it is a summary, not a nudge.
  const signedIn = mode === 'week' ? [] : [...new Set(eligible.filter(s => s.user_id).map(s => s.user_id))]
  const facts = signedIn.length ? await fetchPlayerFacts(signedIn) : new Map()
  const cleared = signedIn.length ? await fetchCleared(signedIn) : new Map()
  /** The level to name for this subscriber, or null when unknown or past the ladder's end. */
  const nextLevelOf = sub => {
    const won = sub.user_id ? cleared.get(sub.user_id) : undefined
    return won && won + 1 <= LEVEL_COUNT ? won + 1 : null
  }
  const onBoardOf = sub => !!sub.user_id && board.some(r => r.user_id === sub.user_id)

  // ── GUARD 3: does this mode have anything to say to this subscriber ──────────────────────────
  /** The whole decision for one subscriber, and the reason — which is what `--explain` prints. */
  const decide = sub => {
    const away = awayOf(sub)
    const info = facts.get(sub.user_id)
    const ctx = {
      away,
      streakDays: mode === 'daily' || mode === 'laststand' ? streakAtRisk(info, today) : null,
      questsOpen: mode === 'quests' ? questsOpen(info, today) : null,
      onBoard: onBoardOf(sub),
      winsAway: mode === 'daily' ? jackpotWinsAway(info) : null,
    }
    if (!dueForMode(mode, ctx)) return { due: false, reason: `no ${mode} news`, away, ctx }
    if (backoffApplies(mode) && !backoffAllows(sub, away, now)) {
      return { due: false, reason: 'backoff', away, ctx }
    }
    return { due: true, reason: 'due', away, ctx }
  }

  const decisions = new Map(eligible.map(sub => [sub.endpoint, decide(sub)]))
  const subs = eligible.filter(sub => decisions.get(sub.endpoint).due)
  const heldBack = eligible.length - subs.length

  // ── THE DIAGNOSTIC ───────────────────────────────────────────────────────────────────────────
  // The away histogram prints on EVERY run, scheduled or not, and exists because of how the
  // 2026-08-25 outage hid: `4 opted in · 4 held back · 0 due` is equally consistent with a healthy
  // quiet evening and with the entire audience being permanently unreachable, and telling those two
  // apart needed a number nobody was printing. `away 0:4` on a run that held everyone back says at
  // a glance that every subscriber was here today — which is either the correct quiet state or the
  // bug, but is no longer invisible either way. Buckets, never per-device counts, so a scheduled
  // run's public log stays aggregate.
  //
  // ⚠️ Only printed by the modes that actually READ activity. `--laststand` and `--week` never do,
  // so every device would bucket as `unknown` and the line would read exactly like the symptom of a
  // broken device-id join — a diagnostic that manufactures its own false positive is worse than no
  // diagnostic at all.
  const hist = { 0: 0, 1: 0, '2-6': 0, '7+': 0, unknown: 0 }
  for (const sub of needsActivity ? eligible : []) {
    const a = decisions.get(sub.endpoint).away
    if (a === null) hist.unknown++
    else if (a === 0) hist[0]++
    else if (a === 1) hist[1]++
    else if (a <= 6) hist['2-6']++
    else hist['7+']++
  }
  const histLine = Object.entries(hist)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}:${n}`)
    .join(' ')

  console.log(
    `${mode} ${key} · ${clock.label} at home${slot ? ` (slot ${slotLabel(slot)})` : ''} · ends in ${hrs}h · ` +
      `${all.length} opted in · ${overBudget} over budget · ${slotDone} had this slot · ` +
      `${heldBack} held back · ${subs.length} due` +
      (DROP ? ` · today's gift: ${gift.id}` : DAILY || mode === 'week' ? ` · ${board.length} on the board` : '') +
      (histLine ? ` · away ${histLine}` : '') +
      // On the summary line, not only in stderr: this fallback ran for eight days unnoticed
      // (2026-08-26 → 09-03) because the warning above was the one line nobody grepped for.
      (legacyBudget ? ' · ⚠️ 0028 NOT APPLIED — one-a-day fallback' : '')
  )

  // `--explain` prints the per-device decision — the thing that would have made the outage obvious
  // in one run. Opt-in rather than always-on because it is per-device where the histogram is
  // aggregate; it names the same truncated device id the dry-run block does and never the endpoint,
  // which is a bearer capability, nor any private number behind the reason.
  if (EXPLAIN) {
    for (const s2 of eligible) {
      const d = decisions.get(s2.endpoint)
      const who = s2.user_id ? `user:${s2.user_id.slice(0, 8)}` : 'anon'
      console.log(
        `  [why] device ${String(s2.device_id).slice(0, 8)} ${who} · ` +
          `away ${!needsActivity ? 'not read' : (d.away ?? 'unknown')} · ` +
          `sent today ${sendsToday(s2, today)}/${DAILY_SEND_CAP} · ${d.due ? 'DUE' : `held (${d.reason})`}`
      )
    }
    for (const s2 of all.filter(x => !decisions.has(x.endpoint))) {
      const who = s2.user_id ? `user:${s2.user_id.slice(0, 8)}` : 'anon'
      console.log(
        `  [why] device ${String(s2.device_id).slice(0, 8)} ${who} · ${budgetOf(s2)} ` +
          `(${sendsToday(s2, today)}/${DAILY_SEND_CAP} today, last ${s2.last_sent_at ?? 'never'})`
      )
    }
  }

  if (!subs.length) return

  let sent = 0
  let retired = 0
  let failed = 0
  /** Composed messages per hook — the run's only per-branch observability outside `--dry-run`. */
  const hooks = {}

  for (const sub of subs) {
    // Every personal fact was already resolved by `decide` — reusing its ctx rather than
    // recomputing keeps the message and the reason the subscriber was selected in lockstep. A
    // second, drifting derivation here is exactly how a player gets a notification whose copy
    // disagrees with the rule that chose them.
    const ctx = decisions.get(sub.endpoint).ctx
    const msg = DROP
      ? messageForDrop(gift, ctx.away, jackpotWinsAway(facts.get(sub.user_id)), nextLevelOf(sub))
      : QUESTS
        ? messageForQuests(ctx.questsOpen)
        : LASTSTAND
          ? messageForLastStand(ctx.streakDays, hrs)
          : messageFor(sub, board, hrs, ctx.streakDays, ctx.winsAway, DAILY ? nextLevelOf(sub) : null)
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
      // The day's accounting, written in the same PATCH as `last_sent_at` so a device can never be
      // marked sent without its counter moving. `sendsToday` reads the row as it was fetched at the
      // top of this run, and each endpoint is sent at most once per run, so +1 is exact — the
      // workflow's `concurrency: endless-push` group is what keeps a second run from interleaving.
      const patch = { last_sent_at: new Date().toISOString(), failure_count: 0 }
      if (!legacyBudget) {
        patch.sends_day = today
        patch.sends_count = sendsToday(sub, today) + 1
      }
      await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
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

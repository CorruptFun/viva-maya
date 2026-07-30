import { mulberry32 } from './rng'
import type { Rng } from './rng'
import { loadSave, persistSave } from './save'
import type { SaveData } from './save'

/**
 * Endless "daily race" — pure logic (no Phaser). Unlocks after ENDLESS_UNLOCK_LEVEL. Everyone on the
 * same calendar DAY plays the SAME board (seeded off the day key), a fixed move budget, no
 * objectives: just rack up the biggest score. Each day the board — and the daily leaderboard —
 * resets, and the day's top score is crowned.
 *
 * The WEEK is the season on top of that: a week's standing is the SUM of your daily bests across its
 * seven boards, so the weekly crown goes to whoever showed up AND scored, not to whoever had one
 * lucky run. Miss a day and you bank a zero for it — which is the whole point.
 *
 * This replaced a single frozen weekly board (one seed, one best, seven days to grind it). That
 * design paid the player who memorised one layout and punished anyone who arrived on Saturday; the
 * board they'd inherit was already picked over, and there was nothing to come back FOR the next day.
 *
 * Boosts are deliberately NOT applied in endless: planting specials would change the board and
 * break the "same board for everyone" fairness of the race.
 */

/** Fixed move budget for the daily score-attack board — equal for all, so BEST scores compare fairly. */
export const ENDLESS_MOVES = 30

/** Endless opens after this many numbered levels are cleared — a fixed milestone, independent of
 * the total level count (so raising LEVEL_COUNT doesn't push the unlock out of reach). Lowered
 * 30 → 20 so the race (and the leaderboards it feeds) is reachable earlier. */
export const ENDLESS_UNLOCK_LEVEL = 20

/** Boards in a week — the denominator of the "N of 7 days" readout, and of a perfect week. */
export const DAYS_PER_WEEK = 7

/**
 * How many days of daily bests the save keeps. The current ISO week needs 7, and the previous week
 * must stay computable until its coronation has been claimed — 16 covers both with slack, and keeps
 * the blob that rides every cloud push small.
 */
const DAY_HISTORY = 16

/** The shape every day key has — pinned here because the leaderboard column CHECKs the same thing. */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * The race's HOME TIMEZONE — the boards flip at midnight on THIS clock, for everyone at once.
 *
 * The anchor used to be UTC, which put the flip at 6 PM on the home crowd's clock: the player who
 * was told "the board closes at midnight and crowns a winner" looked up at 11 PM and saw NINETEEN
 * HOURS on the countdown, because a new board had quietly opened while they were at dinner
 * (owner report, 2026-07-30). Midnight has to mean midnight to the people actually racing.
 *
 * This is a FIXED zone, not the device's local one — that distinction is load-bearing, and it is
 * the lesson of 2026-07-26 (see the dayKey doc below). One instant still maps to one board for
 * every player on earth; a racer in another timezone just sees the handover at a different
 * wall-clock hour, exactly as the whole world once saw it at 00:00 UTC.
 *
 * Mirrored server-side by `public.race_day_key()` (migration 0013) and by the sender copies in
 * scripts/send-push.mjs — change one, change all three, and move the crons in
 * .github/workflows/endless-push.yml to match.
 */
export const RACE_TZ = 'America/Edmonton'

/**
 * One cached formatter — construction is the expensive part (~ms), reads are microseconds.
 * `hourCycle: 'h23'` pins midnight to "00": an 'h24'-style "24" would silently corrupt the
 * offset arithmetic in `raceOffsetMs`. Constructed eagerly: an environment without IANA data
 * should fail LOUDLY at load, not quietly race a different day than everyone else.
 */
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

/** What RACE_TZ's wall clock reads at `at` — the pieces every key below derives from. */
function raceWallClock(at: Date): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const v: Record<string, number> = {}
  for (const part of raceClock.formatToParts(at)) {
    if (part.type !== 'literal') v[part.type] = Number(part.value)
  }
  return { y: v.year, mo: v.month, d: v.day, h: v.hour % 24, mi: v.minute, s: v.second }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** RACE_TZ's UTC offset at `at`, in ms — negative when behind UTC (Mountain is −6h/−7h). */
function raceOffsetMs(at: Date): number {
  const w = raceWallClock(at)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - at.getTime()
}

/** Calendar arithmetic on a day key — DST-free, because keys are dates and not instants. */
function shiftDayKey(key: string, days: number): string {
  const d = new Date(Date.parse(`${key}T00:00:00Z`) + days * 86400000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * The instant RACE_TZ's clocks strike midnight opening `key` — the wall-clock→instant conversion
 * both "ends at" functions stand on. The offset AT the answer is what converts, but the answer is
 * what we're solving for: guess with the offset at the naive UTC-midnight instant, then correct
 * once with the offset at the guess. Mountain's DST switches happen at 02:00 local, never at
 * midnight, so the second pass always lands exactly.
 */
function raceMidnight(key: string): Date {
  const naive = Date.parse(`${key}T00:00:00Z`)
  let t = naive - raceOffsetMs(new Date(naive))
  t = naive - raceOffsetMs(new Date(t))
  return new Date(t)
}

/**
 * Calendar day key "YYYY-MM-DD" on the RACE_TZ clock — the board seed and the daily leaderboard
 * partition. Midnight-to-midnight in America/Edmonton, so the board turns over at midnight for the
 * home crowd, DST included (one 23-hour board each March, one 25-hour board each November — the
 * same board for everyone either way).
 *
 * A FIXED zone, not the device's local one, and that is the whole point (the lesson the week key
 * learned on 2026-07-26). The key drives THREE things at once: the board SEED everyone is racing
 * on, the partition a score is written to, and the partition read back to build the standings.
 * Derive it from the device's local calendar and two friends a few timezones apart play different
 * boards and each see a leaderboard containing only themselves, with nothing on screen to explain
 * why — and a device clock set forward jumps into tomorrow's board early.
 *
 * Deliberately NOT `daily.ts todayKey()`, which is LOCAL by design: that one gates the daily bonus
 * spin and the free-spin earn cap, where "my day" should mean the player's own midnight. A shared
 * race has to mean the same day for everyone racing it, so the two stay separate on purpose.
 */
export function dayKey(now = new Date()): string {
  const w = raceWallClock(now)
  return `${w.y}-${pad2(w.mo)}-${pad2(w.d)}`
}

/**
 * The instant today's board closes — the next midnight in RACE_TZ. Exposed so a surface can tell
 * the player when the board resets instead of leaving a bare date to be decoded, and so tests can
 * pin the edge.
 */
export function dayEndsAt(now = new Date()): Date {
  return raceMidnight(shiftDayKey(dayKey(now), 1))
}

/**
 * The day key BEFORE `now`'s — i.e. the board that most recently closed (whose winner is crowned).
 * Derived from the key, not from `now − 24h`: on the 25-hour fall-back day the last hour lies more
 * than 24h after the previous midnight, so the subtraction trick would name the day ITSELF here.
 */
export function previousDayKey(now = new Date()): string {
  return shiftDayKey(dayKey(now), -1)
}

/** ISO-8601 week "YYYY-Www" of a day key — pure calendar math on the key itself (Thursday-anchored). */
function isoWeekOf(key: string): string {
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
 * ISO-8601 week key "YYYY-Www" of the RACE_TZ calendar (weeks start Monday). Same week → same key →
 * the same seven daily boards, and the same weekly-total partition. The season resets at Monday
 * midnight in RACE_TZ, for EVERYONE at once — by construction the exact instant Sunday's board
 * closes, so the day and the season always hand over together.
 *
 * A fixed zone rather than the device's local one, for exactly the reasons spelled out on `dayKey`
 * above. The local-calendar version quietly split the race in two on 2026-07-26: a player whose
 * local date had already ticked over to Monday got a different key, so their scores landed in a
 * week nobody else was in.
 */
export function weekKey(now = new Date()): string {
  return isoWeekOf(dayKey(now))
}

/**
 * The week key BEFORE `now`'s — i.e. the most recently CLOSED season, whose champion is crowned.
 * Seven days back on the CALENDAR (via the key), not 7×24h back on the clock, for the same
 * fall-back-day reason as `previousDayKey`.
 */
export function previousWeekKey(now = new Date()): string {
  return isoWeekOf(shiftDayKey(dayKey(now), -7))
}

/**
 * The instant this week's season closes — Monday midnight in RACE_TZ. Exposed so a surface can tell
 * the player when the totals reset instead of leaving "2026-W30" to be decoded, and so tests can
 * pin the edge.
 */
export function weekEndsAt(now = new Date()): Date {
  const key = dayKey(now)
  const dow = (new Date(Date.parse(`${key}T00:00:00Z`)).getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  return raceMidnight(shiftDayKey(key, 7 - dow))
}

/**
 * Which week a day key belongs to — the ONE place the daily→weekly rollup is defined client-side,
 * and the mirror of `public.iso_week_of_day()` in migration 0012 (day→week is pure calendar math,
 * so the 0013 timezone re-anchor did not touch it). Null for a malformed key, so a corrupt save
 * entry drops out of the total instead of poisoning it with NaN.
 */
export function weekKeyOfDay(day: string): string | null {
  if (!DAY_RE.test(day)) return null
  const t = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(t) ? null : isoWeekOf(day)
}

/**
 * Coarse "time left", for panel subtitles: days+hours, then hours+minutes, then minutes. Deliberately
 * not `lives.formatCountdown` (m:ss) — that's built for a 20-minute timer and would read as an absurd
 * "3421:07" across a week. Serves both races: the day board ("5h 12m") and the season ("2d 5h").
 */
export function formatRaceRemaining(ms: number): string {
  const mins = Math.floor(Math.max(0, ms) / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return m > 0 ? `${m}m` : 'under a minute'
}

/** Deterministic 32-bit seed for a key — same key → same seed → same board for everyone. */
export function seedForKey(key: string): number {
  let h = 0x811c9dc5 >>> 0 // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/** RNG for a specific day's board — identical for everyone playing that day. */
export function endlessRngForDay(day: string): Rng {
  return mulberry32(seedForKey(day))
}

/** Best for a specific day key; 0 if that board was never played (or the entry is junk). */
export function endlessBestForDay(save: SaveData, day: string): number {
  const n = save.endlessDays?.[day]
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Today's best — for display surfaces (Home/LevelSelect) where read-time day is correct. */
export function endlessBestToday(save: SaveData, now = new Date()): number {
  return endlessBestForDay(save, dayKey(now))
}

/** A week's standing: the summed daily bests, and how many of its boards were actually played. */
export interface WeekStanding {
  total: number
  days: number
}

/**
 * The save's own weekly standing — the SUM of its daily bests inside `wk`, and the day count behind
 * it. PURE (no network, no clock beyond the default arg), so it is unit-testable and is the single
 * client-side definition of "how did my week go", shared by the local readouts and by the fallback
 * lines the strips paint when signed out or offline.
 *
 * Junk entries are skipped rather than coerced: `endlessDays` is restored shape-tolerantly straight
 * from storage, and one NaN in the sum would make the whole readout meaningless.
 */
export function endlessWeekStanding(save: SaveData, wk = weekKey()): WeekStanding {
  let total = 0
  let days = 0
  for (const [day, score] of Object.entries(save.endlessDays ?? {})) {
    if (typeof score !== 'number' || !Number.isFinite(score) || score <= 0) continue
    if (weekKeyOfDay(day) !== wk) continue
    total += Math.floor(score)
    days += 1
  }
  return { total, days }
}

/** The right-hand readout for a weekly row: the total, then the turnout that earned it. */
export function formatWeekStanding(s: WeekStanding): string {
  return `${s.total.toLocaleString()} · ${s.days}d`
}

/** Endless unlocks once the player has cleared ENDLESS_UNLOCK_LEVEL numbered levels. */
export function endlessUnlocked(save: SaveData): boolean {
  return save.unlocked > ENDLESS_UNLOCK_LEVEL
}

/** Drop all but the newest DAY_HISTORY days. Keys are YYYY-MM-DD, so a plain string sort is chronological. */
function pruneDays(save: SaveData): void {
  const keys = Object.keys(save.endlessDays).sort()
  for (const stale of keys.slice(0, Math.max(0, keys.length - DAY_HISTORY))) delete save.endlessDays[stale]
}

/**
 * Record an endless run against the day key the board was SEEDED with (captured at board creation,
 * NOT re-read here — a run that crosses the midnight boundary must still be attributed to the board
 * it was actually played on). Keeps the max for that day and leaves every other day untouched, so
 * the week's total only ever grows. Returns the day's (new) best, whether it beat it, and the
 * resulting weekly standing.
 */
export function recordEndless(
  score: number,
  day: string
): { best: number; isRecord: boolean; week: WeekStanding } {
  const save = loadSave()
  const prev = endlessBestForDay(save, day)
  const isRecord = score > prev
  if (isRecord) save.endlessDays[day] = Math.floor(score)
  // Endless score can still be a personal all-time BEST across the whole game.
  if (score > save.best) save.best = score
  pruneDays(save)
  persistSave(save)
  return {
    best: endlessBestForDay(save, day),
    isRecord,
    week: endlessWeekStanding(save, weekKeyOfDay(day) ?? weekKey()),
  }
}

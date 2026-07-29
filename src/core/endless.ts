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
 * Calendar day key "YYYY-MM-DD" in **UTC** — the board seed and the daily leaderboard partition.
 *
 * UTC, not local time, and that is the whole point (the same lesson the week key learned on
 * 2026-07-26). The key drives THREE things at once: the board SEED everyone is racing on, the
 * partition a score is written to, and the partition read back to build the standings. Derive it
 * from the device's local calendar and two friends a few timezones apart play different boards and
 * each see a leaderboard containing only themselves, with nothing on screen to explain why — and a
 * device clock set forward jumps into tomorrow's board early.
 *
 * Deliberately NOT `daily.ts todayKey()`, which is LOCAL by design: that one gates the daily bonus
 * spin and the free-spin earn cap, where "my day" should mean the player's own midnight. A shared
 * race has to mean the same day for everyone on earth, so the two stay separate on purpose.
 */
export function dayKey(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}`
}

/**
 * The instant today's board closes — the next 00:00 UTC. Exposed so a surface can tell the player
 * when the board resets instead of leaving a bare date to be decoded, and so tests can pin the edge.
 */
export function dayEndsAt(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() + 1)
  return d
}

/** The day key BEFORE `now`'s — i.e. the board that most recently closed (whose winner is crowned). */
export function previousDayKey(now = new Date()): string {
  return dayKey(new Date(now.getTime() - 86400000))
}

/**
 * ISO-8601 week key "YYYY-Www" in **UTC** (Thursday-anchored, weeks start Monday). Same week → same
 * key → the same seven daily boards, and the same weekly-total partition. The season resets at
 * Monday 00:00 UTC, for EVERYONE at once.
 *
 * UTC, not local time, for exactly the reasons spelled out on `dayKey` above. This used to read the
 * device's local calendar date, which quietly split the race in two: a player whose local date had
 * already ticked over to Monday got a different key, so their scores landed in a week nobody else
 * was in. One instant now maps to one week for every player on earth, whatever their timezone or
 * clock offset. The visible trade is that the rollover is a fixed moment worldwide rather than local
 * midnight — Monday 00:00 UTC is Sunday evening in the Americas.
 */
export function weekKey(now = new Date()): string {
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

/** The week key BEFORE `now`'s — i.e. the most recently CLOSED season, whose champion is crowned. */
export function previousWeekKey(now = new Date()): string {
  return weekKey(new Date(now.getTime() - 7 * 86400000))
}

/**
 * The instant this week's season closes — Monday 00:00 UTC. Exposed so a surface can tell the player
 * when the totals reset instead of leaving "2026-W30" to be decoded, and so tests can pin the edge.
 */
export function weekEndsAt(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const dow = (d.getUTCDay() + 6) % 7 // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() + (7 - dow)) // next Monday, 00:00 UTC
  return d
}

/**
 * Which week a day key belongs to — the ONE place the daily→weekly rollup is defined client-side,
 * and the mirror of `public.iso_week_of_day()` in migration 0012. Null for a malformed key, so a
 * corrupt save entry drops out of the total instead of poisoning it with NaN.
 */
export function weekKeyOfDay(day: string): string | null {
  if (!DAY_RE.test(day)) return null
  const t = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(t) ? null : weekKey(new Date(t))
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

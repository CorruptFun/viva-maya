import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudSession, isCloudConfigured, sbClient } from './cloud'
import { dayKey, endlessBestForDay, formatWeekStanding, previousDayKey, previousWeekKey, weekKey } from './endless'
import type { SaveData } from './save'

/**
 * Endless-race leaderboard client — the read/submit surface over `public.endless_daily_scores` and
 * the `public.endless_weekly_totals` view it rolls up into (see supabase/migrations/0012_endless_daily.sql).
 *
 * THREE BOARDS, ONE MODULE:
 *   · DAILY   — today's shared board, ranked by score. Resets at 00:00 UTC; the day's #1 is crowned.
 *   · WEEKLY  — the season. Ranked by the SUM of a player's daily bests, so it rewards turning up:
 *               a missed day is a zero you cannot make back with one big run.
 *   · LEVELS  — the all-time campaign ladder (public.level_progress, migration 0007).
 *
 * Design contract (mirrors core/cloud.ts exactly):
 *   - DORMANT until configured + signed in: every export no-ops / returns empty when
 *     VITE_SUPABASE_* is absent or the player is signed out. Nothing here may ever
 *     throw into the game.
 *   - The save stays AUTHORITATIVE for the player's own bests (save.endlessDays — see
 *     core/endless.ts). This module only MIRRORS today's best out to the shared table
 *     (submit) and reads other players' mirrored rows (fetch). Losing the network loses
 *     nothing but freshness.
 *   - Submission piggybacks the cloud-save push (core/cloud.ts calls `maybeSubmitEndless`
 *     after each successful save upsert), so there is no new traffic path and no per-frame
 *     cost. A (day, score) memo skips redundant upserts; the server trigger keeps scores
 *     monotonic per (user, day) anyway.
 *   - The WEEKLY board is never submitted to. It is derived server-side from the daily rows,
 *     so there is exactly one number to keep honest and the total can never disagree with the
 *     days that made it.
 *
 * Privacy: only user id, a sanitized display name, the day key, and the score ever leave the
 * device. The display name defaults to the Google account's email local-part, and the RACE
 * NAME picker (cloud modal → setHandle) overrides it: the chosen handle is persisted in its own
 * shape-tolerant localStorage key (theme.ts's storage pattern — no save-schema coupling), wins
 * inside `preferredName()`, and a rename immediately UPDATEs display_name on every leaderboard
 * row the player owns (all days — RLS permits updating own rows), so a real name can be scrubbed
 * from history, not just from future submissions. Set the handle BEFORE first sign-in and the
 * email local-part never reaches the table at all.
 */

/**
 * One leaderboard row, ready for display. `you` marks the signed-in player's row.
 *
 * `score` is the sort key and the default right-hand readout. `valueText` overrides only the
 * READOUT — the level board ranks on a level number but wants to show "47 · ★118", and the weekly
 * board ranks on a total but wants to show "18,204 · 5d". Letting the row supply the string keeps
 * the panel from having to know which board it is rendering.
 */
export interface LeaderboardEntry {
  rank: number
  name: string
  score: number
  you: boolean
  /** Display override for the right-hand value. Daily rows leave it undefined (score formats itself). */
  valueText?: string
}

/** Result of a board fetch: the top rows plus (when signed in) the player's own rank. */
export interface RaceBoard {
  /** What this board IS — a day key, a week key, or 'ALL TIME'. Drives the panel's subtitle. */
  key: string
  entries: LeaderboardEntry[]
  /** The signed-in player's rank (1-based) even when outside the top rows; null when absent/signed out. */
  myRank: number | null
  /** The signed-in player's mirrored score; null when they have no row on this board. */
  myScore: number | null
  /** Display override for the footer's own-rank readout — the row-level `valueText`'s counterpart. */
  myValueText?: string
}

// Supabase client access is lazy + optional, exactly like core/cloud.ts: cloud.ts owns the
// lazy singleton and `sbClient()` hands out the same instance — never a second connection.
async function client(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured() || !cloudSession()) return null
  return sbClient()
}

/** Strip an email local-part / arbitrary text down to a friendly 24-char handle. */
export function sanitizeName(raw: string | null | undefined): string {
  const base = (raw ?? '').split('@')[0].replace(/[^\p{L}\p{N} _.\-]/gu, '').trim()
  return (base || 'player').slice(0, 24)
}

// --- Race name (chosen handle) ----------------------------------------------
// Own shape-tolerant localStorage key, mirroring theme.ts: decoupled from the
// save schema (no migration, no merge semantics) and read synchronously.
const HANDLE_KEY = 'viva-maya:handle'

/** The persisted chosen handle (already sanitized), or null when none is set. */
export function getHandle(): string | null {
  try {
    const raw = localStorage.getItem(HANDLE_KEY)
    if (raw === null || raw.trim() === '') return null
    return sanitizeName(raw)
  } catch {
    return null // storage blocked (private mode / no DOM) — behave as unset
  }
}

/**
 * Set (or clear, with null/empty) the chosen race name. Persists the sanitized
 * handle, then — when signed in — immediately renames EVERY leaderboard row the
 * player owns (all days, fire-and-forget), so the old name disappears from
 * current and past boards without waiting for the next score submission.
 * Returns the sanitized handle that was stored (null when cleared).
 */
export function setHandle(raw: string | null): string | null {
  const clean = raw === null || raw.trim() === '' ? null : sanitizeName(raw)
  try {
    if (clean === null) localStorage.removeItem(HANDLE_KEY)
    else localStorage.setItem(HANDLE_KEY, clean)
  } catch {
    // storage blocked — the rename below still applies for this session
  }
  void renameEverywhere()
  return clean
}

/**
 * UPDATE display_name on all of the signed-in player's rows (RLS: own rows only).
 *
 * EVERY board the player appears on, not just today's — the whole point of the rename is that a real
 * name can be scrubbed from history, and a name left behind on the level ladder (which never rolls
 * over, so the row is permanent) would defeat that completely. Add a table here whenever a new board
 * starts carrying `display_name`.
 *
 * The weekly board needs no entry: it is a VIEW over the daily rows, so renaming those renames it.
 * `endless_scores` is the frozen weekly-board-era table (pre-0012) — still renamed, because rows a
 * player left there are exactly the history this feature exists to scrub.
 */
async function renameEverywhere(): Promise<void> {
  try {
    const s = cloudSession()
    const c = await client()
    if (!s || !c) return
    const name = preferredName()
    await Promise.all([
      c.from('endless_daily_scores').update({ display_name: name }).eq('user_id', s.userId),
      c.from('endless_scores').update({ display_name: name }).eq('user_id', s.userId),
      c.from('level_progress').update({ display_name: name }).eq('user_id', s.userId),
    ])
  } catch {
    // offline / transient — the next score submission still carries the new name
  }
}

/** The display name submissions carry — the chosen race name, else the email local-part. */
export function preferredName(): string {
  return getHandle() ?? sanitizeName(cloudSession()?.email)
}

// (day, score) memo: skip an upsert we've already sent this page-load. The server-side
// monotonic trigger makes redundant sends harmless — this just avoids pointless requests.
let lastSent: { day: string; score: number } | null = null

/**
 * Mirror the save's best for TODAY'S board to the leaderboard — called by core/cloud.ts after each
 * successful cloud-save push (the save is already authoritative by then). No-ops when dormant, when
 * today has no score yet, or when this exact (day, score) was already sent. Never throws; a transient
 * failure simply retries on the next save push.
 *
 * Only today is ever submitted, deliberately. The server refuses any other day (migration 0012's
 * guard, one hour of grace past midnight), so walking the whole `endlessDays` map would just generate
 * rejected requests — and every earlier day was already mirrored on the push that recorded it.
 */
export async function maybeSubmitEndless(save: SaveData, now = new Date()): Promise<void> {
  try {
    const s = cloudSession()
    if (!s) return
    const day = dayKey(now)
    const score = endlessBestForDay(save, day)
    if (score <= 0) return
    if (lastSent && lastSent.day === day && lastSent.score >= score) return
    const c = await client()
    if (!c) return
    const { error } = await c.from('endless_daily_scores').upsert(
      {
        user_id: s.userId,
        day_key: day,
        score,
        display_name: preferredName(),
      },
      { onConflict: 'user_id,day_key' }
    )
    if (!error) lastSent = { day, score }
  } catch {
    // offline / transient — the next save push retries; the race loses only freshness
  }
}

/**
 * Fetch a DAY's board: the top `limit` rows plus the signed-in player's own rank (computed with a
 * cheap count-greater-than query when they fall outside the top). Defaults to today's board.
 * Returns an empty board when dormant — callers can render "sign in to join the race".
 */
export async function fetchDailyBoard(limit = 25, now = new Date()): Promise<RaceBoard> {
  return fetchBoardForDay(dayKey(now), limit)
}

/**
 * The same fetch for ANY day, open or closed. Split out so the result recap can read the board that
 * just closed with the identical ranking rules the player watched all day — a recap that computed
 * rank differently from the board would be worse than no recap.
 */
async function fetchBoardForDay(day: string, limit: number): Promise<RaceBoard> {
  const empty: RaceBoard = { key: day, entries: [], myRank: null, myScore: null }
  try {
    const c = await client()
    if (!c) return empty
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_daily_scores')
      .select('user_id, display_name, score')
      .eq('day_key', day)
      .order('score', { ascending: false })
      .order('scored_at', { ascending: true })
      .limit(limit)
    if (error || !data) return empty
    const rows = data as Array<{ user_id: string; display_name: string; score: number }>
    const entries: LeaderboardEntry[] = rows.map((r, i) => ({
      rank: i + 1,
      name: sanitizeName(r.display_name),
      score: r.score,
      you: !!s && r.user_id === s.userId,
    }))
    let myRank: number | null = null
    let myScore: number | null = null
    const mine = entries.find(e => e.you)
    if (mine) {
      myRank = mine.rank
      myScore = mine.score
    } else if (s) {
      // Outside the top rows (or absent): read own row, then count how many beat it.
      const own = await c
        .from('endless_daily_scores')
        .select('score')
        .eq('day_key', day)
        .eq('user_id', s.userId)
        .maybeSingle()
      const score = (own.data as { score: number } | null)?.score
      if (typeof score === 'number') {
        myScore = score
        const { count } = await c
          .from('endless_daily_scores')
          .select('user_id', { count: 'exact', head: true })
          .eq('day_key', day)
          .gt('score', score)
        myRank = typeof count === 'number' ? count + 1 : null
      }
    }
    return { key: day, entries, myRank, myScore }
  } catch {
    return empty
  }
}

/** One row of the weekly-totals view — the season's grain. */
interface WeeklyRow {
  user_id: string
  display_name: string
  total: number
  days_played: number
}

// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSITION WEEK — settling a race that was already being run.
//
// The daily format shipped MID-WEEK, on Wednesday 2026-07-29, into a 2026-W31 weekly race that had
// been running since Monday. That was a mistake in the rollout, not in the format: players had spent
// two and a half days battling a single shared weekly board, and the moment the new code went live
// their scores stopped counting toward the week they were earned in. `endless_weekly_totals` is built
// from the DAILY rows, and the first daily board did not exist until Wednesday — so W31's champion
// would have been decided by the five days after the switch, with the battle everyone actually
// fought excluded from its own week. Nobody would have been told; the crown would just have gone to
// the wrong player, and the people who raced Monday to Wednesday would have got nothing for it.
//
// So every week up to and including the cutover is settled the OLD way: top score on the shared
// weekly board, straight out of `endless_scores`, exactly as those players were promised when they
// set the score. The summed-daily season starts clean at the next week boundary. Daily boards and
// daily purses are unaffected and run from the switch onward — they take nothing from anyone.
//
// This is a DATED, SELF-EXPIRING branch. Once the cutover week is in the past it only serves the
// crown row and any late claim, and it can be deleted outright when `endless_scores` is retired.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The last week decided by the pre-daily weekly board. Weeks at or before this read `endless_scores`;
 * later weeks read the summed-daily view. Week keys are zero-padded 'YYYY-Www', so they compare
 * lexicographically in true chronological order, across year boundaries included.
 */
export const LEGACY_WEEK_CUTOVER = '2026-W31'

/** Is this week one the old single-board rules still settle? */
export function isLegacyWeek(week: string): boolean {
  return week <= LEGACY_WEEK_CUTOVER
}

/** One week's standings off the frozen weekly board — the pre-0012 ranking, unchanged. */
async function fetchLegacyWeekBoard(week: string, limit: number): Promise<RaceBoard> {
  const empty: RaceBoard = { key: week, entries: [], myRank: null, myScore: null }
  try {
    const c = await client()
    if (!c) return empty
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_scores')
      .select('user_id, display_name, score')
      .eq('week_key', week)
      .order('score', { ascending: false })
      .order('scored_at', { ascending: true })
      .limit(limit)
    if (error || !data) return empty
    const rows = data as Array<{ user_id: string; display_name: string; score: number }>
    const entries: LeaderboardEntry[] = rows.map((r, i) => ({
      rank: i + 1,
      name: sanitizeName(r.display_name),
      score: r.score,
      you: !!s && r.user_id === s.userId,
    }))
    let myRank: number | null = null
    let myScore: number | null = null
    const mine = entries.find(e => e.you)
    if (mine) {
      myRank = mine.rank
      myScore = mine.score
    } else if (s) {
      const own = await c
        .from('endless_scores')
        .select('score')
        .eq('week_key', week)
        .eq('user_id', s.userId)
        .maybeSingle()
      const score = (own.data as { score: number } | null)?.score
      if (typeof score === 'number') {
        myScore = score
        const { count } = await c
          .from('endless_scores')
          .select('user_id', { count: 'exact', head: true })
          .eq('week_key', week)
          .gt('score', score)
        myRank = typeof count === 'number' ? count + 1 : null
      }
    }
    return { key: week, entries, myRank, myScore }
  } catch {
    return empty
  }
}

/** The champion of a legacy week — top score, earliest to reach it. */
async function fetchLegacyWeekChampion(week: string): Promise<Champion | null> {
  try {
    const c = await client()
    if (!c) return null
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_scores')
      .select('user_id, display_name, score')
      .eq('week_key', week)
      .order('score', { ascending: false })
      .order('scored_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { user_id: string; display_name: string; score: number }
    return { key: week, name: sanitizeName(row.display_name), score: row.score, you: !!s && row.user_id === s.userId }
  } catch {
    return null
  }
}

/**
 * Fetch a WEEK's season standings from `public.endless_weekly_totals` — the summed daily bests.
 * Defaults to the current week.
 *
 * Ordering is (total desc, days_played desc, last_scored_at asc). The middle term is the interesting
 * one: when two players land on the same total, the one who spread it over MORE boards wins, because
 * that is the behaviour this whole format exists to reward. The last term is the same
 * first-to-reach-it tiebreak the daily board uses, so a dead heat still resolves deterministically.
 *
 * Own-rank when outside the top rows is therefore a COMPOSITE comparison, not a single `.gt()` —
 * a player is beaten by anyone with a bigger total, OR by anyone level on the total with more days.
 */
export async function fetchWeeklyBoard(limit = 25, now = new Date()): Promise<RaceBoard> {
  const week = weekKey(now)
  if (isLegacyWeek(week)) return fetchLegacyWeekBoard(week, limit)
  const empty: RaceBoard = { key: week, entries: [], myRank: null, myScore: null }
  try {
    const c = await client()
    if (!c) return empty
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_weekly_totals')
      .select('user_id, display_name, total, days_played')
      .eq('week_key', week)
      .order('total', { ascending: false })
      .order('days_played', { ascending: false })
      .order('last_scored_at', { ascending: true })
      .limit(limit)
    if (error || !data) return empty
    const rows = data as WeeklyRow[]
    const entries: LeaderboardEntry[] = rows.map((r, i) => ({
      rank: i + 1,
      name: sanitizeName(r.display_name),
      score: r.total,
      you: !!s && r.user_id === s.userId,
      valueText: formatWeekStanding({ total: r.total, days: r.days_played }),
    }))
    let myRank: number | null = null
    let myScore: number | null = null
    let myValueText: string | undefined
    const mine = entries.find(e => e.you)
    if (mine) {
      myRank = mine.rank
      myScore = mine.score
      myValueText = mine.valueText
    } else if (s) {
      const own = await c
        .from('endless_weekly_totals')
        .select('total, days_played')
        .eq('week_key', week)
        .eq('user_id', s.userId)
        .maybeSingle()
      const row = own.data as { total: number; days_played: number } | null
      if (row) {
        myScore = row.total
        myValueText = formatWeekStanding({ total: row.total, days: row.days_played })
        // Strictly ahead on the total...
        const higher = await c
          .from('endless_weekly_totals')
          .select('user_id', { count: 'exact', head: true })
          .eq('week_key', week)
          .gt('total', row.total)
        // ...or level with them and ahead on turnout.
        const tied = await c
          .from('endless_weekly_totals')
          .select('user_id', { count: 'exact', head: true })
          .eq('week_key', week)
          .eq('total', row.total)
          .gt('days_played', row.days_played)
        if (typeof higher.count === 'number' && typeof tied.count === 'number') {
          myRank = higher.count + tied.count + 1
        }
      }
    }
    return { key: week, entries, myRank, myScore, myValueText }
  } catch {
    return empty
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL RACE — the all-time campaign ladder (public.level_progress, migration 0007).
//
// Same contract as the race boards above: dormant until configured + signed in, the SAVE stays
// authoritative, this only mirrors out and reads back, and submission piggybacks the cloud-save push
// so there is no new traffic path.
//
// It reuses RaceBoard/LeaderboardEntry deliberately rather than growing a parallel pair of types:
// the panel then renders any board with no branching, and the level rows just carry `valueText`.
// ─────────────────────────────────────────────────────────────────────────────

/** The two numbers the level ladder ranks on, derived from a save. */
export interface LevelStanding {
  /** Highest level number CLEARED (0 when none). */
  cleared: number
  /** Total stars banked across every cleared level. */
  stars: number
}

/**
 * Derive the ladder position from a save. PURE — no network, no clock — so it is unit-testable and
 * is the single definition of "how far have they got", shared by the submit path and the local
 * strip readout.
 *
 * `unlocked` is the highest level the player MAY ATTEMPT, so the highest CLEARED is one below it
 * (a fresh save sits at unlocked 1 → cleared 0). Stars are summed defensively: the record is a
 * shape-tolerant `Record<number, number>` restored straight from storage, so a corrupt or
 * hand-edited entry must not produce NaN and poison the submitted row.
 */
export function levelStanding(save: SaveData): LevelStanding {
  const cleared = Math.max(0, Math.floor(save.unlocked) - 1)
  let stars = 0
  for (const [lvl, n] of Object.entries(save.stars ?? {})) {
    // Ignore stars recorded above the cleared mark — the server clamps to 3×cleared anyway, and
    // sending a row the guard has to correct just hides a real bug behind a silent fixup.
    if (Number(lvl) > cleared) continue
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) stars += Math.min(3, Math.floor(n))
  }
  return { cleared, stars }
}

/** The right-hand readout for a level row: the rung, then the mastery that breaks ties on it. */
export function formatStanding(s: LevelStanding): string {
  return `${s.cleared} · ★${s.stars}`
}

// (cleared, stars) memo — same purpose as `lastSent` above: skip an upsert already sent this
// page-load. The server trigger keeps both counters monotonic regardless.
let lastLevels: LevelStanding | null = null

/**
 * Mirror the save's campaign progress to the level ladder — called by core/cloud.ts after each
 * successful cloud-save push. No-ops when dormant, when nothing has been cleared yet, or when this
 * exact standing was already sent. Never throws.
 */
export async function maybeSubmitLevels(save: SaveData): Promise<void> {
  try {
    const s = cloudSession()
    if (!s) return
    const stand = levelStanding(save)
    if (stand.cleared <= 0) return // nothing to show on the ladder yet
    if (lastLevels && lastLevels.cleared >= stand.cleared && lastLevels.stars >= stand.stars) return
    const c = await client()
    if (!c) return
    const { error } = await c.from('level_progress').upsert(
      {
        user_id: s.userId,
        cleared: stand.cleared,
        stars: stand.stars,
        display_name: preferredName(),
      },
      { onConflict: 'user_id' }
    )
    if (!error) lastLevels = stand
  } catch {
    // offline / transient — the next save push retries; the ladder loses only freshness
  }
}

/**
 * Fetch the level ladder: the top `limit` rows plus the signed-in player's own rank.
 *
 * Ordering mirrors the `level_progress_ladder` index exactly (cleared desc, stars desc, reached_at
 * asc) — keep the two in step or the index stops being used.
 *
 * Own-rank when outside the top rows is a COMPOSITE comparison, not a single `.gt()`: a player is
 * beaten by anyone on a higher rung, OR by anyone on the same rung with more stars. Collapsing that
 * to "cleared >" would report every tied player as joint-first, which is exactly the pile-up the
 * star tiebreak exists to prevent.
 */
export async function fetchLevelBoard(limit = 25): Promise<RaceBoard> {
  const empty: RaceBoard = { key: 'ALL TIME', entries: [], myRank: null, myScore: null }
  try {
    const c = await client()
    if (!c) return empty
    const s = cloudSession()
    const { data, error } = await c
      .from('level_progress')
      .select('user_id, display_name, cleared, stars')
      .order('cleared', { ascending: false })
      .order('stars', { ascending: false })
      .order('reached_at', { ascending: true })
      .limit(limit)
    if (error || !data) return empty
    const rows = data as Array<{ user_id: string; display_name: string; cleared: number; stars: number }>
    const entries: LeaderboardEntry[] = rows.map((r, i) => ({
      rank: i + 1,
      name: sanitizeName(r.display_name),
      score: r.cleared,
      you: !!s && r.user_id === s.userId,
      valueText: formatStanding({ cleared: r.cleared, stars: r.stars }),
    }))
    let myRank: number | null = null
    let myScore: number | null = null
    let myValueText: string | undefined
    const mine = entries.find(e => e.you)
    if (mine) {
      myRank = mine.rank
      myScore = mine.score
      myValueText = mine.valueText
    } else if (s) {
      const own = await c
        .from('level_progress')
        .select('cleared, stars')
        .eq('user_id', s.userId)
        .maybeSingle()
      const row = own.data as { cleared: number; stars: number } | null
      if (row) {
        myScore = row.cleared
        myValueText = formatStanding(row)
        // Strictly ahead on the rung...
        const higher = await c
          .from('level_progress')
          .select('user_id', { count: 'exact', head: true })
          .gt('cleared', row.cleared)
        // ...or level with them and ahead on stars.
        const tied = await c
          .from('level_progress')
          .select('user_id', { count: 'exact', head: true })
          .eq('cleared', row.cleared)
          .gt('stars', row.stars)
        if (typeof higher.count === 'number' && typeof tied.count === 'number') {
          myRank = higher.count + tied.count + 1
        }
      }
    }
    return { key: 'ALL TIME', entries, myRank, myScore, myValueText }
  } catch {
    return empty
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAMPIONS — the prizes for winning a closed board.
//
// TWO CADENCES, DELIBERATELY DIFFERENT SIZES. The daily purse is the reason to come back tomorrow;
// the weekly purse is the reason to come back every day. A great level win pays ~30-60 chips and the
// priciest boost is 120, so one day's crown (150) is a real prize without being a windfall, and the
// season's (1,000) stays the fat one worth chasing all week. Seven daily winners plus one champion is
// ~2,050 chips a week entering the economy across up to eight different players — the same order as
// the single 1,000 purse it replaces, and still bounded by construction: fixed prizes, fixed cadence,
// no scaling with player count (docs/SOCIAL_AND_ECONOMY.md iron rule #1).
// ─────────────────────────────────────────────────────────────────────────────

/** Chip purse awarded to a closed week's #1 — the season crown. Tunable in one place. */
export const CHAMPION_PURSE = 1000

/** Chip purse awarded to a closed DAY's #1. Tunable in one place. */
export const DAILY_PURSE = 150

/** Which cadence a crown belongs to — the one thing every champion/prize path forks on. */
export type RaceScope = 'day' | 'week'

/** A closed board's winner, ready for display (crown row / coronation). */
export interface Champion {
  /** The day or week key that closed. */
  key: string
  name: string
  score: number
  /** True when the signed-in player is the champion. */
  you: boolean
  /** Right-hand readout override — the weekly crown shows "18,204 · 5d"; daily shows the score. */
  valueText?: string
}

/**
 * Fetch the winner of a closed DAY — the top row by score, ties broken by who scored FIRST
 * (scored_at asc). Null when dormant, the day had no rows, or the network fails. Safe to call
 * opportunistically; never throws.
 */
export async function fetchDailyChampion(day: string = previousDayKey()): Promise<Champion | null> {
  try {
    const c = await client()
    if (!c) return null
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_daily_scores')
      .select('user_id, display_name, score')
      .eq('day_key', day)
      .order('score', { ascending: false })
      .order('scored_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    const row = data as { user_id: string; display_name: string; score: number }
    return { key: day, name: sanitizeName(row.display_name), score: row.score, you: !!s && row.user_id === s.userId }
  } catch {
    return null
  }
}

/**
 * Fetch the champion of a closed WEEK — the top season total, ordered exactly as `fetchWeeklyBoard`
 * ranks (total desc, days_played desc, last_scored_at asc), so the crown and the board can never
 * disagree about who won. Null when dormant / empty / offline; never throws.
 */
export async function fetchWeeklyChampion(week: string = previousWeekKey()): Promise<Champion | null> {
  if (isLegacyWeek(week)) return fetchLegacyWeekChampion(week)
  try {
    const c = await client()
    if (!c) return null
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_weekly_totals')
      .select('user_id, display_name, total, days_played')
      .eq('week_key', week)
      .order('total', { ascending: false })
      .order('days_played', { ascending: false })
      .order('last_scored_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (error || !data) return null
    const row = data as WeeklyRow
    return {
      key: week,
      name: sanitizeName(row.display_name),
      score: row.total,
      you: !!s && row.user_id === s.userId,
      valueText: formatWeekStanding({ total: row.total, days: row.days_played }),
    }
  } catch {
    return null
  }
}

/**
 * Prize tiers for a closed board, ordered best-first — a DATA table so scaling the reward structure
 * as the player base grows (top-3 purses, percentile tiers, league brackets) is adding rows here + UI,
 * never new plumbing. Today: winner-takes-all on both cadences (owner call, 2026-07-21).
 * The claim latches (save.championWeeks / save.championDays) are per-KEY, not per-tier, so they
 * already cover any future shape: you claim whatever your rank earned, once per board.
 *
 * Future-tier examples (commented until wanted):
 *   { maxRank: 3, chips: 250, title: 'PODIUM' },
 *   { maxRank: 10, chips: 60, title: 'TOP 10' },
 */
export interface PrizeTier {
  /** Highest (worst) rank this tier covers; tiers are checked best-first. */
  maxRank: number
  chips: number
  title: string
}

export const PRIZE_TIERS: PrizeTier[] = [
  { maxRank: 1, chips: CHAMPION_PURSE, title: 'WEEKLY CHAMPION' },
]

export const DAILY_PRIZE_TIERS: PrizeTier[] = [
  { maxRank: 1, chips: DAILY_PURSE, title: 'DAILY WINNER' },
]

/** The tier a final rank earned on a given ladder, or null when it earned nothing. */
export function prizeForRank(rank: number, tiers: PrizeTier[] = PRIZE_TIERS): PrizeTier | null {
  for (const tier of tiers) if (rank <= tier.maxRank) return tier
  return null
}

/** A pending, unclaimed prize → the caller runs the celebration, then awards. */
export interface RacePrizeWin {
  /** Which cadence closed — picks the claim latch and the copy. */
  scope: RaceScope
  /** The day or week key that closed. */
  key: string
  rank: number
  /** The winning number: a day's best score, or a week's summed total. */
  score: number
  tier: PrizeTier
}

/**
 * Did the signed-in player earn an UNCLAIMED prize for the DAY that just closed? Reads their row for
 * that day, computes competition rank (1 + count of strictly better scores), disambiguates a shared
 * top score via `fetchDailyChampion` (the scored_at tiebreak — only the true first-scorer takes the
 * crown; a tied runner-up falls to rank 2), then looks the rank up in DAILY_PRIZE_TIERS. Null when
 * dormant / no row / out of the money / already claimed. Read-only: awarding happens in
 * save.claimDailyWin AFTER the celebration, so a crash mid-ceremony re-offers it.
 */
export async function checkDailyPrize(
  claimedDays: readonly string[],
  now = new Date()
): Promise<RacePrizeWin | null> {
  try {
    const day = previousDayKey(now)
    if (claimedDays.includes(day)) return null
    const c = await client()
    if (!c) return null
    const s = cloudSession()
    if (!s) return null
    const own = await c
      .from('endless_daily_scores')
      .select('score')
      .eq('day_key', day)
      .eq('user_id', s.userId)
      .maybeSingle()
    const score = (own.data as { score: number } | null)?.score
    if (typeof score !== 'number' || score <= 0) return null
    const { count } = await c
      .from('endless_daily_scores')
      .select('user_id', { count: 'exact', head: true })
      .eq('day_key', day)
      .gt('score', score)
    if (typeof count !== 'number') return null
    let rank = count + 1
    // Shared top score → only the FIRST to reach it (scored_at) takes the day.
    if (rank === 1) {
      const champ = await fetchDailyChampion(day)
      if (champ && !champ.you) rank = 2
    }
    const tier = prizeForRank(rank, DAILY_PRIZE_TIERS)
    if (!tier) return null
    return { scope: 'day', key: day, rank, score, tier }
  } catch {
    return null
  }
}

/**
 * The season's counterpart to `checkDailyPrize`: did the player earn an UNCLAIMED prize for the WEEK
 * that just closed? Same shape, one rung up — rank comes from the summed totals, and the tie is
 * broken by turnout first (more days played) before falling back to the champion query's
 * first-to-reach-it rule. Null when dormant / no row / out of the money / already claimed.
 */
export async function checkWeeklyPrize(
  claimedWeeks: readonly string[],
  now = new Date()
): Promise<RacePrizeWin | null> {
  try {
    const week = previousWeekKey(now)
    if (claimedWeeks.includes(week)) return null
    const c = await client()
    if (!c) return null
    const s = cloudSession()
    if (!s) return null
    // The transition weeks pay out on the board they were actually raced on. Without this the crown
    // for the week the switch landed in goes to whoever won the days AFTER it, and the players who
    // spent that week battling the old shared board are simply skipped.
    if (isLegacyWeek(week)) return checkLegacyWeekPrize(week, s.userId, c)
    const own = await c
      .from('endless_weekly_totals')
      .select('total, days_played')
      .eq('week_key', week)
      .eq('user_id', s.userId)
      .maybeSingle()
    const row = own.data as { total: number; days_played: number } | null
    if (!row || row.total <= 0) return null
    const higher = await c
      .from('endless_weekly_totals')
      .select('user_id', { count: 'exact', head: true })
      .eq('week_key', week)
      .gt('total', row.total)
    const tied = await c
      .from('endless_weekly_totals')
      .select('user_id', { count: 'exact', head: true })
      .eq('week_key', week)
      .eq('total', row.total)
      .gt('days_played', row.days_played)
    if (typeof higher.count !== 'number' || typeof tied.count !== 'number') return null
    let rank = higher.count + tied.count + 1
    // Level on total AND on turnout → only the first to have got there wears the crown.
    if (rank === 1) {
      const champ = await fetchWeeklyChampion(week)
      if (champ && !champ.you) rank = 2
    }
    const tier = prizeForRank(rank, PRIZE_TIERS)
    if (!tier) return null
    return { scope: 'week', key: week, rank, score: row.total, tier }
  } catch {
    return null
  }
}

/**
 * The legacy weekly payout: competition rank on the shared weekly board, ties to whoever reached the
 * score FIRST — byte-for-byte the rule those players were racing under before the format changed.
 * Takes the already-resolved client + user id so the caller's dormancy checks are not repeated.
 */
async function checkLegacyWeekPrize(
  week: string,
  userId: string,
  c: SupabaseClient
): Promise<RacePrizeWin | null> {
  const own = await c
    .from('endless_scores')
    .select('score')
    .eq('week_key', week)
    .eq('user_id', userId)
    .maybeSingle()
  const score = (own.data as { score: number } | null)?.score
  if (typeof score !== 'number' || score <= 0) return null
  const { count } = await c
    .from('endless_scores')
    .select('user_id', { count: 'exact', head: true })
    .eq('week_key', week)
    .gt('score', score)
  if (typeof count !== 'number') return null
  let rank = count + 1
  if (rank === 1) {
    const champ = await fetchLegacyWeekChampion(week)
    if (champ && !champ.you) rank = 2
  }
  const tier = prizeForRank(rank, PRIZE_TIERS)
  if (!tier) return null
  return { scope: 'week', key: week, rank, score, tier }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULT RECAP — what the other players get.
//
// Only #1 earns a coronation, which means on a small board almost nobody sees anything at all when a
// day closes. That is a hole in the format, not just a missing nicety: the game tells players "a new
// board every day, each day crowns a winner" and then, for everyone who is not the winner, produces
// no evidence that any of it happened. The daily rhythm has to be visible to the people living it.
//
// So everyone who RACED gets their result: where they finished, who took it, and how close the next
// place up was. The gap is the part that does the work — "527 behind chipqueen" is a reason to open
// today's board; "you came 4th" is a fact.
// ─────────────────────────────────────────────────────────────────────────────

/** Yesterday's result for a player who raced it and didn't win it. */
export interface RaceRecap {
  /** The day key that closed. */
  day: string
  rank: number
  /** Players on that board — a FLOOR, not a census: the fetch caps at `limit` rows. */
  total: number
  score: number
  winnerName: string
  winnerScore: number
  /** The player one place above, when they were inside the fetched rows; null when out of reach. */
  aheadName: string | null
  /** How far behind `aheadName` — 0 when unknown. The most motivating number on the card. */
  gap: number
}

/**
 * Yesterday's result, or null when there is nothing to say: dormant, signed out, already shown,
 * didn't race, or WON — the winner gets the coronation instead and must never get both. Never throws.
 */
export async function fetchRaceRecap(
  seenDays: readonly string[],
  now = new Date()
): Promise<RaceRecap | null> {
  try {
    const day = previousDayKey(now)
    if (seenDays.includes(day)) return null
    const c = await client()
    if (!c) return null
    if (!cloudSession()) return null
    const board = await fetchBoardForDay(day, 25)
    if (board.myRank === null || board.myScore === null) return null // didn't race it
    if (board.myRank === 1) return null // the crown, not the recap
    const top = board.entries[0]
    if (!top) return null
    // The player directly above, when the player's own row was inside the fetched top. Outside it we
    // know the rank (counted server-side) but not who is immediately ahead, so the gap is withheld
    // rather than guessed — an invented "behind X" on the card would be a lie about a real person.
    const mine = board.entries.findIndex(e => e.you)
    const ahead = mine > 0 ? board.entries[mine - 1] : null
    return {
      day,
      rank: board.myRank,
      total: Math.max(board.entries.length, board.myRank),
      score: board.myScore,
      winnerName: top.name,
      winnerScore: top.score,
      aheadName: ahead ? ahead.name : null,
      gap: ahead ? Math.max(0, ahead.score - board.myScore) : 0,
    }
  } catch {
    return null
  }
}

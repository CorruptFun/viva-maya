import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudSession, flushCloudSaveNow, isCloudConfigured, sbClient } from './cloud'
import { dayKey, endlessBestForDay, formatWeekStanding, previousDayKey, previousWeekKey, weekKey } from './endless'
import { cachedSalt, playedRealBoard } from './racesalt'
import { loadSave, persistSave, type SaveData } from './save'
import { chaptersCompleted, chaptersFromCleared } from './trophies'

/**
 * Endless-race leaderboard client — the read/submit surface over `public.endless_daily_scores` and
 * the `public.endless_weekly_totals` view it rolls up into (see supabase/migrations/0012_endless_daily.sql).
 *
 * THREE BOARDS, ONE MODULE:
 *   · DAILY   — today's shared board, ranked by score. Resets at midnight America/Edmonton
 *               (core/endless.ts RACE_TZ); the day's #1 is crowned.
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
 * Privacy — THE INVARIANT: nothing derived from the player's email address may ever reach a
 * public board. Only the user id, a sanitized display name, the day key and the score leave
 * the device.
 *
 * The public name is `preferredName()`: the chosen RACE NAME if there is one, else
 * `anonName(userId)` — never the email. It used to fall back to the email local-part, which for
 * a Google account is very often a real name (`jane.doe`), so every player who had not found the
 * name picker was publishing one. `anonName` discloses nothing new, being derived from the user
 * id that is already on every row.
 *
 * The chosen handle is persisted TWICE, on purpose:
 *   - its own shape-tolerant localStorage key (theme.ts's pattern), for synchronous reads on the
 *     submit path;
 *   - and in the SAVE (`save.handle`), so it rides cloud sync. Storage-only was the reason
 *     players had to re-enter their name after clearing a browser or moving to a new phone: the
 *     cloud restored their progress but had never been told their name, so the boards silently
 *     reverted to the default.
 * `adoptHandle` closes the loop on the way back in, and `reconcileName` repairs rows a previous
 * build already published.
 *
 * A rename UPDATEs display_name on every row the player owns (all days — RLS permits updating own
 * rows), so a name can be scrubbed from history, not just from future submissions.
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
  /**
   * Chapters this player has completed — the trophy-tier badge worn beside the name
   * (core/trophies.ts trophyTier; below the first rung the panel draws nothing). DERIVED, never
   * submitted: the levels board computes it from its own `cleared` column, the race boards from one
   * batch read of `level_progress` (world-readable, monotonic-guarded — migration 0007). Absent when
   * that read failed or the player has no ladder row; the board renders unbadged, never blocks.
   */
  chapters?: number
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
  /** The player's OWN chapters completed, read from the local save — the footer badge needs no fetch. */
  myChapters?: number
}

// Supabase client access is lazy + optional, exactly like core/cloud.ts: cloud.ts owns the
// lazy singleton and `sbClient()` hands out the same instance — never a second connection.
async function client(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured() || !cloudSession()) return null
  return sbClient()
}

/**
 * Decorate board rows with their trophy-tier data — PURE, so the panel's badge logic is testable
 * without a network. `userIds` runs parallel to `entries` (the ids never leave this module — an
 * entry carries no id, only the derived count), `clearedById` maps user id → `level_progress.cleared`.
 * A miss leaves `chapters` undefined and the row renders unbadged.
 */
export function applyChapterTiers(
  entries: LeaderboardEntry[],
  userIds: ReadonlyArray<string>,
  clearedById: ReadonlyMap<string, number>
): void {
  entries.forEach((e, i) => {
    const cleared = clearedById.get(userIds[i])
    if (typeof cleared === 'number') e.chapters = chaptersFromCleared(cleared)
  })
}

/**
 * One batch read of `level_progress.cleared` for the rows on a race board (≤ the board's limit, so
 * one `.in()` query). The table is world-readable and its guard keeps `cleared` monotonic — the same
 * data the levels ladder already publishes, so this adds NO new exposure. Any failure returns an
 * empty map: the board renders unbadged rather than late or not at all.
 */
async function fetchClearedFor(c: SupabaseClient, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) return out
  try {
    const { data, error } = await c.from('level_progress').select('user_id, cleared').in('user_id', ids)
    if (error || !data) return out
    for (const r of data as Array<{ user_id: string; cleared: number }>) {
      if (typeof r.cleared === 'number') out.set(r.user_id, r.cleared)
    }
  } catch {
    // Unbadged board — never block the standings on the decoration.
  }
  return out
}

/** Strip an email local-part / arbitrary text down to a friendly 24-char handle. */
export function sanitizeName(raw: string | null | undefined): string {
  const base = (raw ?? '').split('@')[0].replace(/[^\p{L}\p{N} _.\-]/gu, '').trim()
  return (base || 'player').slice(0, 24)
}

/**
 * The public name for a player who has not chosen one — stable, anonymous, and derived from the
 * account's own user id, which is ALREADY on every board row, so it reveals nothing that reading the
 * board did not. Four hex digits keep the boards legible (twenty rows of "player" tells you nothing)
 * without pretending to be a real handle.
 *
 * MUST stay byte-identical to `public.anon_display_name` in
 * supabase/migrations/0017_display_name_never_email.sql. That migration substitutes this exact string
 * server-side when a submission would publish the account's email name — including from an old cached
 * client that still has the removed fallback — so a divergent formula here would show the player one
 * name in the app and the board another. The migration self-checks the shared case ('7f3a91b2-…' →
 * 'Player 7F3A') and refuses to apply if it drifts; the matching assertion is in leaderboard.test.ts.
 */
export function anonName(userId: string | null | undefined): string {
  const hex = (userId ?? '').replace(/-/g, '').slice(0, 4).toUpperCase()
  return /^[0-9A-F]{4}$/.test(hex) ? `Player ${hex}` : 'player'
}

// --- Race name (chosen handle) ----------------------------------------------
// Persisted in its own shape-tolerant localStorage key (theme.ts's pattern) for synchronous reads on
// the submit path, AND mirrored into the save so it rides cloud sync — see the module header.
const HANDLE_KEY = 'viva-maya:handle'

/**
 * The chosen handle (sanitized), or null when none is set.
 *
 * Falls back to the save's copy when the dedicated key is missing, so a device that still has its
 * save but lost the key keeps its name. Both are localStorage reads, so this stays synchronous.
 */
export function getHandle(): string | null {
  try {
    const raw = localStorage.getItem(HANDLE_KEY)
    if (raw !== null && raw.trim() !== '') return sanitizeName(raw)
  } catch {
    // storage blocked (private mode / no DOM) — fall through to the save
  }
  try {
    const fromSave = loadSave().handle
    return fromSave && fromSave.trim() !== '' ? sanitizeName(fromSave) : null
  } catch {
    return null // no storage at all — behave as unset
  }
}

/**
 * Set (or clear, with null/empty) the chosen race name. Persists the sanitized handle to BOTH homes
 * (the key and the save — the save write is what pushes it to the cloud via the persist listener),
 * then, when signed in, immediately renames EVERY leaderboard row the player owns (all days,
 * fire-and-forget), so the old name disappears from current and past boards without waiting for the
 * next score submission. Returns the sanitized handle that was stored (null when cleared).
 */
export function setHandle(raw: string | null): string | null {
  const clean = raw === null || raw.trim() === '' ? null : sanitizeName(raw)
  try {
    if (clean === null) localStorage.removeItem(HANDLE_KEY)
    else localStorage.setItem(HANDLE_KEY, clean)
  } catch {
    // storage blocked — the save write and the rename below still apply for this session
  }
  try {
    const save = loadSave()
    save.handle = clean
    save.handleSetAt = Date.now() // stamped so the newest rename wins the cross-device merge
    persistSave(save)
  } catch {
    // best-effort: the name still applies locally and to the rename below
  }
  // Skip the save-push debounce. Setting a name is a deliberate one-off the player expects to have
  // stuck, and "set the name, close the browser" — the exact flow this bug was reported from — fits
  // inside the 1.5s window, which would strand the name on this device only. Fire-and-forget: the
  // debounced push still stands behind it, so a failure here costs nothing.
  void flushCloudSaveNow()
  void renameEverywhere()
  return clean
}

/**
 * Adopt a (merged) save's race name into this device's mirror — the recovery half of the bridge.
 *
 * core/cloud.ts calls this right after a sync persists the merge winner. This is what makes a name
 * survive a cleared browser and follow the player to a new phone: the cloud save carries the handle,
 * mergeSaves picks the most recently set one, and this writes it over whatever this device had.
 *
 * Deliberately does NOT re-stamp `handleSetAt` — an adopted name would then look freshly chosen and
 * win every future merge, so the oldest device to sync would start dictating the name. And it does
 * not push a rename; the caller does that once, via reconcileName.
 */
export function adoptHandle(save: SaveData): void {
  try {
    const cloud = save.handle && save.handle.trim() !== '' ? sanitizeName(save.handle) : null
    if (cloud === null) return // nothing chosen anywhere — leave this device's state alone
    if (localStorage.getItem(HANDLE_KEY) === cloud) return
    localStorage.setItem(HANDLE_KEY, cloud)
  } catch {
    // storage blocked — getHandle's save fallback still returns the adopted name
  }
}

// One repair per page-load. Cheap, but there is no reason to repeat it.
let reconciled = false

/**
 * Repair the player's own board rows once per session, after a sign-in/sync.
 *
 * Two things need it, both invisible until someone reads the board:
 *   - rows an OLDER BUILD published under the email fallback. They are only ever rewritten when the
 *     owner next submits, and for a closed day that is never — so without this they would keep a
 *     real name on the boards permanently.
 *   - a name just adopted from the cloud on a device whose rows have never carried it.
 *
 * Idempotent and fire-and-forget: RLS-scoped UPDATEs that can only touch this player's own rows.
 */
export async function reconcileName(): Promise<void> {
  if (reconciled) return
  reconciled = true
  await renameEverywhere()
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

/**
 * The display name submissions carry — the chosen race name, else the anonymous default.
 *
 * The email is deliberately unreachable from here: this function is the ONLY thing that decides what
 * becomes public, so keeping `cloudSession().email` out of it is what makes the privacy invariant in
 * the module header hold by construction rather than by discipline.
 */
export function preferredName(): string {
  return getHandle() ?? anonName(cloudSession()?.userId)
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
    // A run played on the OFFLINE FALLBACK board is not a race entry. On a salted day the board is
    // seeded from the server's salt (core/racesalt.ts); without it the client builds the original
    // unsalted layout, which nobody else is playing. Migration 0024's guard refuses such a score
    // anyway — this just declines to ask, so a fallback run does not spend a request per save push
    // getting rejected for the rest of the day.
    if (!playedRealBoard(day)) return
    if (lastSent && lastSent.day === day && lastSent.score >= score) return
    const c = await client()
    if (!c) return
    const { error } = await c.from('endless_daily_scores').upsert(
      {
        user_id: s.userId,
        day_key: day,
        score,
        display_name: preferredName(),
        // What board this was actually played on. Null before SALT_ACTIVE_FROM, which is exactly
        // what the guard expects for an unsalted day.
        board_salt: cachedSalt(day),
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
    applyChapterTiers(entries, rows.map(r => r.user_id), await fetchClearedFor(c, rows.map(r => r.user_id)))
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
    return { key: day, entries, myRank, myScore, myChapters: chaptersCompleted(loadSave().unlocked) }
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
// The first repair read the cutover week ONLY from `endless_scores`, which fixed that victim and
// created the mirror of it: from Wednesday to Sunday every daily board a player won added NOTHING to
// the week on screen. The season readout sat frozen on a board nothing writes to any more, so the
// game spent five days telling players their daily scores counted toward a total that could not
// move. Reported from production on 2026-07-31 — the daily board had reset, ten players were on it,
// and not one of their scores had reached the week.
//
// BOTH HALVES COUNT. A transition week's total is the frozen shared-board score PLUS the summed
// daily bests — everything that player actually earned inside the week, under whichever rules were
// live when they earned it. Neither cohort loses anything: the Monday-to-Wednesday racers keep the
// score they set under the promise they set it under, and every daily board from Wednesday on adds
// to the week exactly as the game says it does. Only the ONE purse is paid, as always.
//
// The merge is client-side on purpose. `endless_scores` is frozen (0012 stopped writing it; 0006's
// guard refuses anything but the current week), so its half cannot change under us, and a view that
// UNIONs a dead table would outlive the fortnight it is for by years.
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

/** A row of the frozen pre-daily weekly board (`public.endless_scores`) — one best run per player. */
export interface LegacyWeekRow {
  user_id: string
  display_name: string
  score: number
  scored_at: string
}

/** A row of the summed-daily view (`public.endless_weekly_totals`) — the post-switch half. */
export interface DailyWeekRow {
  user_id: string
  display_name: string
  total: number
  days_played: number
  last_scored_at: string
}

/** One player's whole transition week: both halves added, ready to rank. */
export interface TransitionWeekRow {
  user_id: string
  display_name: string
  /** Shared-board score + summed daily bests — everything earned inside the week. */
  total: number
  /** Daily boards raced. The shared-board half has no per-day grain, so it contributes none. */
  days_played: number
  /** Latest activity across both halves — the final tiebreak. */
  last_scored_at: string
}

/** Timestamp → ms, tolerant of a missing or malformed value (treated as the epoch, i.e. earliest). */
function atMs(ts: string | null | undefined): number {
  const t = Date.parse(ts ?? '')
  return Number.isNaN(t) ? 0 : t
}

/**
 * Add a transition week's two halves together and rank the result — PURE, so the rule that decides
 * a 1,000-chip payout is unit-testable without a network.
 *
 * Ranking is the season's own: total desc, then turnout, then first-to-get-there. Turnout counts
 * only the daily half because that is the only half with days in it; a shared-board-only player
 * therefore sits behind a daily player they are exactly level with, which is the behaviour the whole
 * format exists to reward.
 *
 * The NAME follows the most recent activity, matching `endless_weekly_totals`' own "most recent day"
 * rule — so a player who renamed after the switch shows their new name here too.
 *
 * Non-positive scores are dropped from both halves (the view already filters them; a hand-crafted
 * zero must not buy a row on the board either).
 */
export function mergeTransitionWeek(
  legacy: readonly LegacyWeekRow[],
  daily: readonly DailyWeekRow[]
): TransitionWeekRow[] {
  const byUser = new Map<string, TransitionWeekRow>()

  const fold = (
    userId: string,
    displayName: string,
    total: number,
    days: number,
    at: string
  ): void => {
    if (!userId || !Number.isFinite(total) || total <= 0) return
    const cur = byUser.get(userId)
    if (!cur) {
      byUser.set(userId, {
        user_id: userId,
        display_name: displayName,
        total: Math.floor(total),
        days_played: days,
        last_scored_at: at,
      })
      return
    }
    cur.total += Math.floor(total)
    cur.days_played += days
    // The newer half owns the name and the tiebreak timestamp.
    if (atMs(at) > atMs(cur.last_scored_at)) {
      cur.last_scored_at = at
      cur.display_name = displayName
    }
  }

  for (const r of legacy) fold(r.user_id, r.display_name, r.score, 0, r.scored_at)
  for (const r of daily) fold(r.user_id, r.display_name, r.total, r.days_played, r.last_scored_at)

  return [...byUser.values()].sort(
    (a, b) =>
      b.total - a.total ||
      b.days_played - a.days_played ||
      atMs(a.last_scored_at) - atMs(b.last_scored_at)
  )
}

/**
 * How many rows to pull from each half. Ranking a client-side merge means reading the WHOLE week —
 * a top-N of each half cannot be ranked against each other, and cannot place a player who is outside
 * both. The real boards are tens of rows and this branch dies at the cutover, so a cap this generous
 * is a runaway guard, not a limit anyone reaches.
 */
const TRANSITION_ROW_CAP = 500

/**
 * Every player's transition-week standing, already ranked — the ONE source the board, the crown row
 * and the payout all read, so they cannot disagree about who won.
 *
 * Returns null when the read FAILED, empty when the week genuinely has nobody on it. The callers
 * need that apart: a half-read merge would rank people against scores it never saw, and paying the
 * 1,000 on it would be worse than paying it a day late.
 */
async function fetchTransitionWeekRows(week: string): Promise<TransitionWeekRow[] | null> {
  try {
    const c = await client()
    if (!c) return null
    const [legacy, daily] = await Promise.all([
      c
        .from('endless_scores')
        .select('user_id, display_name, score, scored_at')
        .eq('week_key', week)
        .limit(TRANSITION_ROW_CAP),
      c
        .from('endless_weekly_totals')
        .select('user_id, display_name, total, days_played, last_scored_at')
        .eq('week_key', week)
        .limit(TRANSITION_ROW_CAP),
    ])
    if (legacy.error || daily.error) return null
    return mergeTransitionWeek(
      (legacy.data ?? []) as LegacyWeekRow[],
      (daily.data ?? []) as DailyWeekRow[]
    )
  } catch {
    return null
  }
}

/**
 * A transition week's standings. No `valueText`: "· 5d" would describe the daily half only, and
 * putting it beside a total that also contains a shared-board score would be a smaller lie than the
 * one this whole branch exists to stop, but a lie all the same. The bare total is the honest readout.
 */
async function fetchTransitionWeekBoard(week: string, limit: number): Promise<RaceBoard> {
  const empty: RaceBoard = { key: week, entries: [], myRank: null, myScore: null }
  const rows = await fetchTransitionWeekRows(week)
  if (!rows) return empty
  const s = cloudSession()
  const entries: LeaderboardEntry[] = rows.slice(0, limit).map((r, i) => ({
    rank: i + 1,
    name: sanitizeName(r.display_name),
    score: r.total,
    you: !!s && r.user_id === s.userId,
  }))
  // Own rank comes from the FULL merged list, not the page above: the merge is client-side, so the
  // count-greater-than query the other boards lean on has nothing server-side to count against.
  const mine = s ? rows.findIndex(r => r.user_id === s.userId) : -1
  return {
    key: week,
    entries,
    myRank: mine >= 0 ? mine + 1 : null,
    myScore: mine >= 0 ? rows[mine].total : null,
  }
}

/** The champion of a transition week — the top merged total, ranked exactly as the board ranks. */
async function fetchTransitionWeekChampion(week: string): Promise<Champion | null> {
  const rows = await fetchTransitionWeekRows(week)
  const top = rows?.[0]
  if (!top) return null
  const s = cloudSession()
  return {
    key: week,
    name: sanitizeName(top.display_name),
    score: top.total,
    you: !!s && top.user_id === s.userId,
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
  if (isLegacyWeek(week)) return fetchTransitionWeekBoard(week, limit)
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
    applyChapterTiers(entries, rows.map(r => r.user_id), await fetchClearedFor(c, rows.map(r => r.user_id)))
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
    return { key: week, entries, myRank, myScore, myValueText, myChapters: chaptersCompleted(loadSave().unlocked) }
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
      // The ladder already carries `cleared` — the badge costs this board no extra read.
      chapters: chaptersFromCleared(r.cleared),
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
    return { key: 'ALL TIME', entries, myRank, myScore, myValueText, myChapters: chaptersCompleted(loadSave().unlocked) }
  } catch {
    return empty
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CHASE — who is just ahead of you, and who is just behind.
//
// `fetchLevelBoard` answers "who is winning", which is the wrong question for almost everyone on it.
// At the measured population (15 players, deepest 125, median 42) the top of that board is eighty
// levels away from the median player, so the ladder's own readout gives most of the game a target it
// will not reach this year. The owner reports players chasing each other up the ladder anyway — the
// behaviour is already there and the code simply never showed it a number.
//
// So this is a WINDOW, not a board: the two players immediately above you and the two immediately
// below, read straight off `level_progress` with two small range queries. Same table, same ordering,
// same guards — a chase line can never disagree with the ladder it is a view of, because it IS the
// ladder, sliced around one row instead of from the top.
//
// EVERYTHING HERE DEGRADES TO SILENCE. Signed out, dormant, offline, nobody above, nobody at all —
// the fetch returns null and the caller draws NOTHING. Never an error, never an empty frame: a
// social feature with no other players in it must be invisible, not apologetic.
// ─────────────────────────────────────────────────────────────────────────────

/** One player in the window around you. Carries no user id — see `chaseKey` for why the cache does. */
export interface ChaseNeighbour {
  /** The public name — `preferredName`'s rules as published, never anything email-derived. */
  name: string
  /** Their rung. */
  cleared: number
  /** Levels between you and them, always positive — the direction is which list they are in. */
  gap: number
  /** Opaque stable identity for the overtake diff. Never displayed. */
  key: string
}

/** The window around the player: at most two either side, each list ordered NEAREST FIRST. */
export interface ChaseWindow {
  /** The rung the window was cut around. */
  mine: number
  /** The players you are chasing. Empty = top of the ladder. */
  above: ChaseNeighbour[]
  /** The players chasing you. Empty = nobody behind you yet. */
  below: ChaseNeighbour[]
}

/** How deep the window looks either way. Two is enough to name a target and a pursuer, and it keeps
 *  both reads inside one index scan. */
const CHASE_DEPTH = 2

/**
 * An opaque, stable, non-reversible handle for one account — the identity the overtake cache diffs on.
 *
 * It is NOT the user id, deliberately. Ids never leave this module (see `applyChapterTiers`), and the
 * overtake cache is DURABLE storage on a device that may be shared, so writing other players' account
 * uuids into it would put identifiers on disk that nothing in the game needs to read back. A 32-bit
 * FNV-1a of the id is stable across sessions, collides at a rate no friends-scale board will ever
 * reach, and identifies nobody on its own.
 *
 * Names cannot do this job: two players may pick the same handle, and a rename would silently re-key
 * a row mid-chase. (A rename is still SAFE either way — it drops out of both sides of the diff and
 * produces silence rather than a false pass — but silence-by-accident is not an invariant.)
 */
function chaseKey(userId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A `level_progress` row as the window reads it. */
interface LadderRow {
  user_id: string
  display_name: string
  cleared: number
}

/**
 * The two players above and the two below, or null when there is nothing to say.
 *
 * ── THE RUNG THE WINDOW IS CUT AROUND ───────────────────────────────────────────────────────
 * `mine` is the HIGHER of the player's mirrored row and their local save, not the server's copy
 * alone. Mirroring piggybacks the cloud-save push, so for a few seconds after a win the table still
 * holds the old rung — and a window cut around it would list someone the player has just beaten as
 * still being ahead of them, which is precisely the moment this feature exists to get right. The
 * guard trigger keeps `cleared` monotonic, so the server can only ever be catching up to the save.
 *
 * ── TIES ────────────────────────────────────────────────────────────────────────────────────
 * `cleared > mine` / `cleared < mine` are STRICT, so a player level with you is neither chasing nor
 * chased — which is the honest reading, and it keeps the player's own row out of the window even in
 * the window above where their mirrored rung is stale. (Their row is excluded by user id as well;
 * the invariant is worth having structurally rather than as a consequence.)
 *
 * Within a rung the order is `stars desc, reached_at asc` — the LADDER's own tiebreak
 * (`level_progress_ladder`), not a second definition of "near". The chase must never name a
 * neighbour the board would rank somewhere else.
 */
/**
 * DEV: force a window (`?chase=<variant>`), in the spirit of `devSeedRaceLine` right below the strip
 * it feeds. Every surface of this feature needs a signed-in session AND other players on the ladder,
 * which no local build has — so without a seed the only way to see the line at all is to ship it.
 * `import.meta.env.DEV` gates both the setter and the read, so nothing here survives a prod build.
 */
let devChase: ChaseWindow | null | undefined
export function devSeedChase(variant: string | null): void {
  const near = (name: string, gap: number, dir: 1 | -1): ChaseNeighbour => ({
    name,
    cleared: 42 + dir * gap,
    gap,
    key: chaseKey(name),
  })
  if (variant === null) return
  if (variant === 'one') devChase = { mine: 42, above: [near('Maya', 1, 1)], below: [near('Rae', 3, -1)] }
  else if (variant === 'top') devChase = { mine: 42, above: [], below: [near('Rae', 2, -1)] }
  else if (variant === 'alone') devChase = null
  else if (variant === 'long')
    devChase = { mine: 42, above: [near('Neon_Ghost-77_Extra', 12, 1)], below: [near('Wilhelmina', 4, -1)] }
  else devChase = { mine: 42, above: [near('Sam', 5, 1)], below: [near('Rae', 2, -1)] }
}

/** DEV: has `?chase=` seeded a window? The strips skip their refresh when signed out (no session, no
 *  request), which would otherwise make the seed unreachable on exactly the surface it exists for. */
export function devChaseSeeded(): boolean {
  return import.meta.env.DEV && devChase !== undefined
}

export async function fetchLevelNeighbours(): Promise<ChaseWindow | null> {
  if (import.meta.env.DEV && devChase !== undefined) return devChase
  try {
    const s = cloudSession()
    if (!s) return null
    const c = await client()
    if (!c) return null
    // The save is authoritative for the player's own progress; the table may not have caught up yet.
    const own = await c.from('level_progress').select('cleared').eq('user_id', s.userId).maybeSingle()
    const mirrored = (own.data as { cleared: number } | null)?.cleared
    const local = levelStanding(loadSave()).cleared
    const mine = Math.max(typeof mirrored === 'number' ? mirrored : 0, local)
    if (mine <= 0) return null // not on the ladder yet — there is no window to cut
    const [aboveQ, belowQ] = await Promise.all([
      c
        .from('level_progress')
        .select('user_id, display_name, cleared')
        .neq('user_id', s.userId)
        .gt('cleared', mine)
        .order('cleared', { ascending: true })
        .order('stars', { ascending: false })
        .order('reached_at', { ascending: true })
        .limit(CHASE_DEPTH),
      c
        .from('level_progress')
        .select('user_id, display_name, cleared')
        .neq('user_id', s.userId)
        .lt('cleared', mine)
        .order('cleared', { ascending: false })
        .order('stars', { ascending: false })
        .order('reached_at', { ascending: true })
        .limit(CHASE_DEPTH),
    ])
    // A HALF-READ IS NO READ. Ranking a chase off one successful query and one failed one would
    // silently claim "nobody is ahead of you" on a dropped packet — the single most misleading thing
    // this line could say. Both or neither.
    if (aboveQ.error || belowQ.error) return null
    const toNeighbour = (r: LadderRow): ChaseNeighbour => ({
      name: sanitizeName(r.display_name),
      cleared: r.cleared,
      gap: Math.abs(r.cleared - mine),
      key: chaseKey(r.user_id),
    })
    const above = ((aboveQ.data ?? []) as LadderRow[]).map(toNeighbour)
    const below = ((belowQ.data ?? []) as LadderRow[]).map(toNeighbour)
    if (above.length === 0 && below.length === 0) return null // alone on the ladder — say nothing
    return { mine, above, below }
  } catch {
    return null
  }
}

// ── The copy ─────────────────────────────────────────────────────────────────
// Pure, and shared by every surface that shows a chase, so Home and LevelSelect cannot end up
// phrasing the same window two different ways.

/**
 * A long handle must not push the line under the strip's chevron. 14 is `LEADER_NAME_MAX`'s
 * discipline, applied to the same 21px face — the panel behind the strip shows the full name.
 */
const CHASE_NAME_MAX = 14

function shortChaseName(n: string): string {
  return n.length > CHASE_NAME_MAX ? `${n.slice(0, CHASE_NAME_MAX - 1)}…` : n
}

/** How a gap reads. The singular is spelled out; see the warning on `chaseCopy`. */
function levelsWord(gap: number): string {
  return gap === 1 ? 'one level' : `${gap} levels`
}

/**
 * A chase window as words. Four fields because there are four shapes of hole to fill, and each has
 * exactly one consumer — which is the point: two surfaces phrasing one window two ways is how a
 * feature starts contradicting itself.
 */
export interface ChaseCopy {
  /** Who you are chasing, in full. Null when you are top of the ladder. */
  ahead: string | null
  /** Who is chasing you, in full — the quieter half. Null when nobody is behind you. */
  behind: string | null
  /** What a one-line STRIP prints (LevelSelect's marquee). Never empty. */
  line: string
  /** The compact form for a shared sub-line (Home, where the chase is one segment of three). */
  tag: string
}

/**
 * Turn a window into copy.
 *
 * ⚠️ THE SINGULAR CASE IS THE POINT. "one level ahead" is the whole difference between a ladder and
 * a race, and it is the string a median player is most likely to see at fifteen players — so it is
 * special-cased everywhere rather than left to a bare `1 levels`. It carries its own test.
 *
 * ── WHY THE STRIP LINE NEVER CARRIES BOTH HALVES ────────────────────────────────────────────
 * It does not fit, and the arithmetic is worth writing down so the next person does not re-derive
 * it by shipping an overlap. The marquee's line sits between the badge (x −258) and the drifting
 * chevron (x +268), centred at −14, so the badge side binds it to ~460px; at 21px/900 that is about
 * forty glyphs. `chasing Neon_Ghost-7…  ·  5 levels ahead` is already forty. Appending a pursuer
 * would put a real player's name under the chevron.
 *
 * So the line LEADS WITH THE PLAYER AHEAD and falls back to the pursuit only when there is nobody
 * to chase. That is not only a space decision — it is the feature's ethic in one branch. The chase
 * PULLS. `behind` stays available for any surface with room, and it says how far back someone is,
 * never that they are gaining, and (see `chaseOvertakes`) never that they have passed you.
 */
export function chaseCopy(w: ChaseWindow): ChaseCopy {
  const a = w.above[0]
  const b = w.below[0]
  const ahead = a ? `chasing ${shortChaseName(a.name)}  ·  ${levelsWord(a.gap)} ahead` : null
  const behind = b ? `${shortChaseName(b.name)} is ${levelsWord(b.gap)} behind you` : null
  // Top of the ladder — the sparse-population case that fires constantly at friends scale. Said as
  // an achievement with the pursuit behind it, never as an empty frame and never as an apology.
  if (!a) {
    const crown = b ? `top of the ladder  ·  ${shortChaseName(b.name)} ${b.gap} behind` : 'top of the ladder'
    return { ahead, behind, line: crown, tag: 'top of the ladder' }
  }
  return {
    ahead,
    behind,
    line: ahead!,
    tag: `chasing ${shortChaseName(a.name)}, ${a.gap === 1 ? 'one level ahead' : `${a.gap} ahead`}`,
  }
}

// ── The overtake moment ──────────────────────────────────────────────────────
// The reason the chase is emotional rather than informational: the win card names the player you
// just went past.
//
// The last-seen window lives in LOCALSTORAGE and must stay there. It is ephemeral SOCIAL state about
// other people, not progress — riding the save would push it through a cloud merge and a device
// restore, where a stale snapshot from another phone would produce a fabricated pass on a device
// that never saw the overtake happen. There is no save field for it and there must not be one.
//
// ⚠️ NEVER ANNOUNCE BEING PASSED. The chase pulls; it must not punish. Someone climbing over you
// changes the line the next time you look at it, and that is all — the same discipline the lose card
// already keeps about broken streaks.

const CHASE_CACHE_KEY = 'viva-maya:chase'

/** What the device remembers of the last window it saw. Only the fields the diff reads. */
export interface ChaseSnapshot {
  mine: number
  above: Array<{ key: string; name: string }>
}

/** Shrink a live window to the snapshot the diff needs — the only thing that is ever persisted. */
export function chaseSnapshot(w: ChaseWindow): ChaseSnapshot {
  return { mine: w.mine, above: w.above.map(n => ({ key: n.key, name: n.name })) }
}

/** The remembered window, or null when there is none (fresh install, cleared storage, junk). */
export function loadChaseSnapshot(): ChaseSnapshot | null {
  try {
    const raw = localStorage.getItem(CHASE_CACHE_KEY)
    if (raw === null) return null
    const v = JSON.parse(raw) as Partial<ChaseSnapshot> | null
    if (!v || typeof v.mine !== 'number' || !Array.isArray(v.above)) return null
    // Shape-tolerant, theme.ts style: a hand-edited or half-written entry reads as "no cache", which
    // costs one silent overtake and can never fabricate one.
    const above = v.above
      .filter((n): n is { key: string; name: string } => !!n && typeof n.key === 'string' && typeof n.name === 'string')
      .map(n => ({ key: n.key, name: n.name }))
    return { mine: v.mine, above }
  } catch {
    return null
  }
}

/** Remember this window as the baseline for the next diff. Best-effort; storage may be blocked. */
export function saveChaseSnapshot(w: ChaseWindow): void {
  try {
    localStorage.setItem(CHASE_CACHE_KEY, JSON.stringify(chaseSnapshot(w)))
  } catch {
    // private mode / no DOM — the chase line still renders, it just cannot announce a pass
  }
}

/**
 * Who did the player just go past? PURE — this is the rule that decides whether a card beat fires,
 * so it is unit-testable without a network, a save or a clock.
 *
 * Fires for a neighbour that was in the remembered ABOVE set and is now in the fresh BELOW set.
 * Both halves are required on purpose:
 *   · using the remembered rung alone would claim a pass whenever they were merely *close*, and
 *   · matching against the fresh window means a neighbour who ALSO advanced (and is still ahead)
 *     correctly produces nothing.
 *
 * Three silences, each deliberate:
 *   · no cache → nothing. A fresh install would otherwise announce a dozen passes at once for
 *     progress the player made before the device ever looked at the ladder.
 *   · `next.mine <= prev.mine` → nothing. That is a REPLAY: no rung advanced, so nobody was passed,
 *     and the guard lives here rather than at the call site so it cannot be forgotten by a second one.
 *   · a neighbour who fell further than `CHASE_DEPTH` below is not in the fresh window, so they go
 *     unnamed. A miss, never a lie — the same rule `fetchRaceRecap` keeps about a gap it cannot see.
 *
 * Returned NEAREST FIRST, because `below` is ordered nearest-first and this preserves it. The card
 * shows one name; passing two people in one win is a rare, good problem and the ladder speaks for
 * the rest.
 */
export function chaseOvertakes(prev: ChaseSnapshot | null, next: ChaseWindow): ChaseNeighbour[] {
  if (!prev) return []
  if (next.mine <= prev.mine) return []
  const wasAhead = new Set(prev.above.map(n => n.key))
  return next.below.filter(n => wasAhead.has(n.key))
}

/**
 * The whole overtake check in one call, in the one order that is correct: read the baseline, take a
 * fresh window, diff, THEN re-baseline. Splitting these across a caller is how the snapshot gets
 * overwritten before it is read, so the sequence is not offered separately.
 *
 * Returns the nearest player passed, or null — dormant, offline, no advance, cold cache and
 * "genuinely passed nobody" all resolve to the same silence, which is exactly what the card wants.
 */
export async function checkChaseOvertake(): Promise<ChaseNeighbour | null> {
  const prev = loadChaseSnapshot()
  const next = await fetchLevelNeighbours()
  if (!next) return null
  const passed = chaseOvertakes(prev, next)
  saveChaseSnapshot(next)
  return passed[0] ?? null
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
  if (isLegacyWeek(week)) return fetchTransitionWeekChampion(week)
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
    // A transition week pays on BOTH boards it was raced on, added — the crown cannot skip the
    // players who spent Monday to Wednesday on the shared board, nor the ones who won the daily
    // boards after the switch. Ranked by the same merge the board and the crown row read.
    if (isLegacyWeek(week)) return checkTransitionWeekPrize(week, s.userId)
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
 * The transition-week payout: rank straight off the merged standings, so the chips can never go to
 * someone the board did not show winning. Null when the read failed (retried on the next open), when
 * the player raced neither half, or when their rank is out of the money.
 *
 * No separate tiebreak pass is needed — `mergeTransitionWeek` has already broken ties by turnout and
 * then by who got there first, so position in the list IS the rank.
 */
async function checkTransitionWeekPrize(week: string, userId: string): Promise<RacePrizeWin | null> {
  const rows = await fetchTransitionWeekRows(week)
  if (!rows) return null
  const idx = rows.findIndex(r => r.user_id === userId)
  if (idx === -1) return null
  const tier = prizeForRank(idx + 1, PRIZE_TIERS)
  if (!tier) return null
  return { scope: 'week', key: week, rank: idx + 1, score: rows[idx].total, tier }
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

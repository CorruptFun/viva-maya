import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudSession, isCloudConfigured, sbClient } from './cloud'
import { weekKey } from './endless'
import type { SaveData } from './save'

/**
 * Weekly endless-race leaderboard client — the read/submit surface over
 * `public.endless_scores` (see supabase/migrations/0002_endless_leaderboard.sql).
 *
 * Design contract (mirrors core/cloud.ts exactly):
 *   - DORMANT until configured + signed in: every export no-ops / returns empty when
 *     VITE_SUPABASE_* is absent or the player is signed out. Nothing here may ever
 *     throw into the game.
 *   - The save stays AUTHORITATIVE for the player's own best (save.endlessWeek /
 *     save.endlessBest — see core/endless.ts). This module only MIRRORS that best
 *     out to the shared table (submit) and reads other players' mirrored bests
 *     (fetch). Losing the network loses nothing but freshness.
 *   - Submission piggybacks the cloud-save push (core/cloud.ts calls
 *     `maybeSubmitEndless` after each successful save upsert), so there is no new
 *     traffic path and no per-frame cost. A (week, score) memo skips redundant
 *     upserts; the server trigger keeps scores monotonic per (user, week) anyway.
 *
 * Privacy: only user id, a sanitized display name, the ISO week key, and the score
 * ever leave the device. The display name defaults to the Google account's email
 * local-part, and the RACE NAME picker (cloud modal → setHandle) overrides it: the
 * chosen handle is persisted in its own shape-tolerant localStorage key (theme.ts's
 * storage pattern — no save-schema coupling), wins inside `preferredName()`, and a
 * rename immediately UPDATEs display_name on every leaderboard row the player owns
 * (all weeks — RLS permits updating own rows), so a real name can be scrubbed from
 * history, not just from future submissions. Set the handle BEFORE first sign-in
 * and the email local-part never reaches the table at all.
 */

/**
 * One leaderboard row, ready for display. `you` marks the signed-in player's row.
 *
 * `score` is the sort key and the default right-hand readout. `valueText` overrides only the
 * READOUT — the level board ranks on a level number but wants to show "47 · ★118", and letting it
 * supply the string keeps the panel from having to know which board it is rendering.
 */
export interface LeaderboardEntry {
  rank: number
  name: string
  score: number
  you: boolean
  /** Display override for the right-hand value. Weekly rows leave it undefined (score formats itself). */
  valueText?: string
}

/** Result of a weekly fetch: the top rows plus (when signed in) the player's own rank. */
export interface WeeklyBoard {
  week: string
  entries: LeaderboardEntry[]
  /** The signed-in player's rank (1-based) even when outside the top rows; null when absent/signed out. */
  myRank: number | null
  /** The signed-in player's mirrored score; null when they have no row this week. */
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
 * player owns (all weeks, fire-and-forget), so the old name disappears from
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
 * EVERY board the player appears on, not just the weekly one — the whole point of the rename is that
 * a real name can be scrubbed from history, and a name left behind on the level ladder (which never
 * rolls over, so the row is permanent) would defeat that completely. Add a table here whenever a new
 * board starts carrying `display_name`.
 */
async function renameEverywhere(): Promise<void> {
  try {
    const s = cloudSession()
    const c = await client()
    if (!s || !c) return
    const name = preferredName()
    await Promise.all([
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

// (week, score) memo: skip an upsert we've already sent this page-load. The server-side
// monotonic trigger makes redundant sends harmless — this just avoids pointless requests.
let lastSent: { week: string; score: number } | null = null

/**
 * Mirror the save's weekly best to the leaderboard — called by core/cloud.ts after each
 * successful cloud-save push (the save is already authoritative by then). No-ops when
 * dormant, when this week has no score yet, or when this exact (week, score) was already
 * sent. Never throws; a transient failure simply retries on the next save push.
 */
export async function maybeSubmitEndless(save: SaveData): Promise<void> {
  try {
    const s = cloudSession()
    if (!s || !save.endlessWeek || save.endlessBest <= 0) return
    if (lastSent && lastSent.week === save.endlessWeek && lastSent.score >= save.endlessBest) return
    const c = await client()
    if (!c) return
    const { error } = await c.from('endless_scores').upsert(
      {
        user_id: s.userId,
        week_key: save.endlessWeek,
        score: save.endlessBest,
        display_name: preferredName(),
      },
      { onConflict: 'user_id,week_key' }
    )
    if (!error) lastSent = { week: save.endlessWeek, score: save.endlessBest }
  } catch {
    // offline / transient — the next save push retries; the race loses only freshness
  }
}

/**
 * Fetch this week's race: the top `limit` rows plus the signed-in player's own rank
 * (computed with a cheap count-greater-than query when they fall outside the top).
 * Returns an empty board when dormant — callers can render "sign in to join the race".
 */
export async function fetchWeeklyBoard(limit = 25, now = new Date()): Promise<WeeklyBoard> {
  const week = weekKey(now)
  const empty: WeeklyBoard = { week, entries: [], myRank: null, myScore: null }
  try {
    const c = await client()
    if (!c) return empty
    const s = cloudSession()
    const { data, error } = await c
      .from('endless_scores')
      .select('user_id, display_name, score')
      .eq('week_key', week)
      .order('score', { ascending: false })
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
    return { week, entries, myRank, myScore }
  } catch {
    return empty
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL RACE — the all-time campaign ladder (public.level_progress, migration 0007).
//
// Same contract as the weekly board above: dormant until configured + signed in, the SAVE stays
// authoritative, this only mirrors out and reads back, and submission piggybacks the cloud-save push
// so there is no new traffic path.
//
// It reuses WeeklyBoard/LeaderboardEntry deliberately rather than growing a parallel pair of types:
// the panel then renders either board with no branching, and the level rows just carry `valueText`.
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
export async function fetchLevelBoard(limit = 25): Promise<WeeklyBoard> {
  const empty: WeeklyBoard = { week: 'ALL TIME', entries: [], myRank: null, myScore: null }
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
    return { week: 'ALL TIME', entries, myRank, myScore, myValueText }
  } catch {
    return empty
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly CHAMPION — the fat prize for winning a closed week's race.
// The purse is deliberately huge relative to the economy (a great level win pays
// ~30-60 chips; the priciest boost is 120): one champion per week keeps it from
// inflating anything, and the size is what makes the race worth chasing.
// ─────────────────────────────────────────────────────────────────────────────

/** Chip purse awarded to a closed week's #1. Tunable in one place. */
export const CHAMPION_PURSE = 1000

/** The week key for the week BEFORE `now` — i.e. the most recently CLOSED race. */
export function previousWeekKey(now = new Date()): string {
  return weekKey(new Date(now.getTime() - 7 * 86400000))
}

/** A closed week's winner, ready for display (crown row / coronation). */
export interface Champion {
  week: string
  name: string
  score: number
  /** True when the signed-in player is the champion. */
  you: boolean
}

/**
 * Fetch the champion of a closed week — the top row by score, ties broken by who scored
 * FIRST (scored_at asc; see migration 0003). Null when dormant, the week had no rows,
 * or the network fails. Safe to call opportunistically; never throws.
 */
export async function fetchChampion(week: string = previousWeekKey()): Promise<Champion | null> {
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
    return { week, name: sanitizeName(row.display_name), score: row.score, you: !!s && row.user_id === s.userId }
  } catch {
    return null
  }
}

/**
 * Prize tiers for a closed week, ordered best-first — a DATA table so scaling the reward
 * structure as the player base grows (top-3 purses, percentile tiers, league brackets) is
 * adding rows here + UI, never new plumbing. Today: winner-takes-all (owner call, 2026-07-21).
 * The claim latch (save.championWeeks) is per-WEEK, not per-tier, so it already covers any
 * future shape: you claim whatever your rank earned, once per week.
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

/** The tier a final rank earned, or null when it earned nothing. */
export function prizeForRank(rank: number): PrizeTier | null {
  for (const tier of PRIZE_TIERS) if (rank <= tier.maxRank) return tier
  return null
}

/** A pending, unclaimed weekly prize → the caller runs the celebration, then awards. */
export interface WeeklyPrizeWin {
  week: string
  rank: number
  score: number
  tier: PrizeTier
}

/**
 * Did the signed-in player earn an UNCLAIMED prize for the most recently closed week?
 * Reads the player's closed-week row, computes competition rank (1 + count of strictly
 * better scores), disambiguates a shared top score via `fetchChampion` (the scored_at
 * tiebreak — only the true first-scorer takes the champion tier; a tied runner-up falls
 * to rank 2), then looks the rank up in PRIZE_TIERS. Null when dormant / no row / rank
 * out of the money / already claimed. Read-only: awarding happens in
 * save.claimChampionship AFTER the celebration, so a crash mid-coronation re-offers it.
 */
export async function checkWeeklyPrize(
  claimedWeeks: readonly string[],
  now = new Date()
): Promise<WeeklyPrizeWin | null> {
  try {
    const week = previousWeekKey(now)
    if (claimedWeeks.includes(week)) return null
    const c = await client()
    if (!c) return null
    const s = cloudSession()
    if (!s) return null
    const own = await c
      .from('endless_scores')
      .select('score')
      .eq('week_key', week)
      .eq('user_id', s.userId)
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
    // Shared top score → only the FIRST to reach it (scored_at) wears the crown.
    if (rank === 1) {
      const champ = await fetchChampion(week)
      if (champ && !champ.you) rank = 2
    }
    const tier = prizeForRank(rank)
    if (!tier) return null
    return { week, rank, score, tier }
  } catch {
    return null
  }
}

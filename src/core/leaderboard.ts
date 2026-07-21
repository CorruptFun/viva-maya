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
 * local-part; `preferredName()` is the single place a future name-picker overrides.
 */

/** One leaderboard row, ready for display. `you` marks the signed-in player's row. */
export interface LeaderboardEntry {
  rank: number
  name: string
  score: number
  you: boolean
}

/** Result of a weekly fetch: the top rows plus (when signed in) the player's own rank. */
export interface WeeklyBoard {
  week: string
  entries: LeaderboardEntry[]
  /** The signed-in player's rank (1-based) even when outside the top rows; null when absent/signed out. */
  myRank: number | null
  /** The signed-in player's mirrored score; null when they have no row this week. */
  myScore: number | null
}

// Supabase client access is lazy + optional, exactly like core/cloud.ts: cloud.ts owns the
// lazy singleton and `sbClient()` hands out the same instance — never a second connection.
async function client(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured() || !cloudSession()) return null
  return sbClient()
}

/** Strip an email local-part / arbitrary text down to a friendly 24-char handle. */
function sanitizeName(raw: string | null | undefined): string {
  const base = (raw ?? '').split('@')[0].replace(/[^\p{L}\p{N} _.\-]/gu, '').trim()
  return (base || 'player').slice(0, 24)
}

/** The display name submissions carry — email local-part today, name-picker override later. */
export function preferredName(): string {
  return sanitizeName(cloudSession()?.email)
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
 * adding rows here + UI, never new plumbing. Today: winner-takes-all (Austin, 2026-07-21).
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

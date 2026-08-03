import { sbClient } from './cloud'
import { daySaltApplies } from './endless'

/**
 * THE DAY'S BOARD SALT — fetched from the server, cached locally, read synchronously.
 *
 * The salt is the random string the server mints when a race day opens and refuses to hand out
 * before then (migration 0023). Mixed into the board seed, it is what stops tomorrow's board from
 * being computable — and solvable — today. See `endlessRngForDay` for the seed itself and
 * `SALT_ACTIVE_FROM` for why this ships dormant.
 *
 * ── WHY A SYNCHRONOUS CACHE AND NOT AN AWAIT ────────────────────────────────────────────────────
 * GameScene builds the board inside `create()`, which is synchronous — there is no point in that
 * call chain where a promise can be awaited without restructuring the scene's whole entry. So the
 * salt is PREFETCHED (at boot, and whenever a race surface is opened) into localStorage, and the
 * board build does a synchronous `cachedSalt()` read. In practice the fetch has resolved long before
 * anyone reaches the board; when it hasn't, the fallback below is the honest one.
 *
 * ── THE FALLBACK IS DELIBERATE ──────────────────────────────────────────────────────────────────
 * No salt → `endlessRngForDay` builds the ORIGINAL unsalted board and the run is not submitted. The
 * player still gets a real board and still keeps a local best; what they lose is the leaderboard,
 * which is the thing that was never available offline anyway. Refusing to open the mode instead
 * would take a whole game mode away from someone whose only mistake was being on a plane.
 *
 * Not stored in the cloud save on purpose. This is public, per-day, server-owned data that every
 * player on a given day shares — putting it in the synced blob would grow every cloud push forever
 * to carry something any client can re-fetch in one call.
 */

const KEY = 'vm.racesalt'

/** Days kept in the cache. Two is enough: today, plus yesterday for the one-hour post-midnight grace. */
const KEEP = 2

type SaltMap = Record<string, string>

/** In-memory mirror, so the hot path (a board build) never touches localStorage twice. */
let memo: SaltMap | null = null

function read(): SaltMap {
  if (memo) return memo
  memo = {}
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      // Shape-tolerant, like every other restore in this codebase: a corrupt entry must degrade to
      // "no salt" (which is a supported state) rather than throw on the path that builds the board.
      if (parsed && typeof parsed === 'object') {
        for (const [day, salt] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof salt === 'string' && salt.length > 0) memo[day] = salt
        }
      }
    }
  } catch {
    // private mode / disabled storage — the in-memory map still works for this session
  }
  return memo
}

function write(map: SaltMap): void {
  memo = map
  try {
    localStorage.setItem(KEY, JSON.stringify(map))
  } catch {
    // storage blocked — the memo above still serves this session
  }
}

/** The cached salt for `day`, or null. Synchronous: this is what the board build calls. */
export function cachedSalt(day: string): string | null {
  return read()[day] ?? null
}

/**
 * Ensure `day`'s salt is cached, fetching it if it isn't. Safe to call repeatedly and safe to
 * ignore the result — callers that only want the prefetch can `void` it.
 *
 * No-ops for days before SALT_ACTIVE_FROM: those boards are unsalted by definition, so asking would
 * mint a salt server-side for a day nothing will ever use it on.
 *
 * Never throws. Dormant cloud, offline, signed out, or a day the server says has not opened yet all
 * land on the same answer — null — and the same behaviour: the unsalted board, unranked.
 */
export async function ensureSalt(day: string): Promise<string | null> {
  if (!daySaltApplies(day)) return null
  const hit = cachedSalt(day)
  if (hit) return hit
  try {
    const c = await sbClient()
    if (!c) return null
    const { data, error } = await c.rpc('race_salt', { p_day: day })
    if (error || typeof data !== 'string' || data.length === 0) return null
    const map = { ...read(), [day]: data }
    // Prune oldest first — keys are YYYY-MM-DD, so a plain string sort is chronological.
    const days = Object.keys(map).sort()
    for (const stale of days.slice(0, Math.max(0, days.length - KEEP))) delete map[stale]
    write(map)
    return data
  } catch {
    return null
  }
}

/**
 * Did this run happen on the board the day actually dealt? False means the board was built from the
 * offline fallback, so the score must not be submitted — the server would refuse it anyway once
 * migration 0024 is live, and posting a score from a board nobody else played is the exact thing
 * this whole mechanism exists to prevent.
 */
export function playedRealBoard(day: string): boolean {
  return !daySaltApplies(day) || cachedSalt(day) !== null
}

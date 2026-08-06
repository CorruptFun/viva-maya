import type { BoardSnapshot } from './board'
import type { SymbolType } from './types'

/**
 * MID-LEVEL RESUME — a level in progress survives the page going away.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────
 * Everything else in the save is between-levels state: unlocks, stars, chips, lives. The level you
 * are actually PLAYING lived only in GameScene's fields, so anything that reloaded the page threw it
 * away — and on a phone that is not rare:
 *
 *  - core/resumeguard reloads deliberately as its last resort out of a frozen loop. Its docstring
 *    calls the cost "at most the current level's in-flight state", which was true and is now nearly
 *    nothing.
 *  - iOS discards a backgrounded PWA's web view under memory pressure; coming back is a cold load.
 *  - The service worker update toast reloads into the new build.
 *  - Any crash.
 *
 * Level 104 is a 64-move level. Losing 54 moves of it to an app switch is the difference between a
 * game you keep on your phone and one you delete.
 *
 * ── The rule that keeps this from being an exploit ──────────────────────────────
 * ⚠️ A snapshot is written ONLY on a settled, idle board, and CLEARED the moment a move is spent.
 * So the only thing a player can ever restore into is a position they had already legitimately
 * reached and stopped at. Force-quitting mid-cascade to re-roll a Plinko drop or an unlucky refill
 * finds no snapshot at all and loses the level exactly as it does today — strictly no better than
 * before, while a crash on a resting board now costs nothing. Any future call site that snapshots
 * mid-resolve would quietly turn this file into a rewind button; don't add one.
 *
 * ── Deliberately NOT covered ────────────────────────────────────────────────────
 * Endless. It seeds from the daily race board and posts a score, so a resumable run would add a new
 * surface to the thing CLAUDE.md's score-defence note exists to protect, in exchange for very little:
 * an endless run is a free, unlimited-retry 30-move sprint measured in a couple of minutes, not the
 * hour a numbered level can take. `saveLevelSnapshot` is simply never called for it.
 *
 * Storage is its own localStorage key, NOT a field on SaveData: a half-played board is device-local
 * by nature, and routing it through `persistSave` would push it to the cloud on every move and let
 * it land on a second device as a level someone else is mid-way through.
 */

const KEY = 'viva-maya:level'

/**
 * How long a stored level stays resumable. Long enough to cover a night's sleep with the phone in a
 * pocket, short enough that a board abandoned across days doesn't ambush someone who has moved on.
 * A snapshot is single-slot anyway — starting any other level replaces it — so this mostly matters
 * for the player who quit the app mid-level and came back much later.
 */
const TTL_MS = 24 * 60 * 60 * 1000

/** The shape written to storage. `v` is checked on read; bump it whenever a field's meaning moves. */
export interface LevelSnapshot {
  v: 1
  /** Numbered level only — endless is never stored (see the header). */
  level: number
  moves: number
  score: number
  objectives: { symbol: SymbolType; remaining: number; total: number }[]
  /** The sweep denominator, captured at level start — coats already cleared are gone from the board. */
  coatsTotal: number
  /** Carried so a resumed level still costs a life if it is then quit, exactly as it would have. */
  moveMade: boolean
  /** §G4 per-level bomb cap — resuming must not hand back a fresh allowance. */
  bombsUsed: number
  /** Helper-purchased moves, so the win card still reports the level honestly. */
  purchasedMoves: number
  /** The bonus drop is once per level; a resume must not re-arm it. */
  plinkoUsed: boolean
  /**
   * THE MARKER's stake riding this level, 0 for none.
   *
   * ⚠️ The one field here that is real money. `placeMarker` spends the chips on the spot and the
   * level's ending settles them (`settleMarkerWin` / `settleMarkerLoss`) — so a resume that dropped
   * this would take a player's 500 chips and then quietly never pay the hand out. It cannot be
   * re-placed or backed out on restore either: both gate on `moveMade`, which is restored with it.
   */
  markerStake: number
  /** HOUSE MINIMUM's one-shot "MET ✓" flip, so a resumed level doesn't re-announce a plaque it passed. */
  minPlaqueMet: boolean
  board: BoardSnapshot
  /** Wall clock at write, for the TTL above. */
  at: number
}

/** What GameScene hands over; `v` and `at` are this module's to stamp. */
export type LevelSnapshotInput = Omit<LevelSnapshot, 'v' | 'at'>

/**
 * Store the level in progress, replacing any previous one.
 *
 * Single-slot on purpose: the player is in exactly one level at a time, and a per-level map would
 * grow without bound and let someone bank a favourable board on every level in the game.
 */
export function saveLevelSnapshot(snap: LevelSnapshotInput): void {
  try {
    const payload: LevelSnapshot = { ...snap, v: 1, at: Date.now() }
    localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    // private mode / quota — resuming is a bonus, never a requirement
  }
}

/**
 * The stored level, if there is one and it is for `level`.
 *
 * Returns null for anything at all suspicious — wrong version, wrong level, expired, malformed —
 * because the fallback (a fresh board) is always playable, and this input is user-editable. The
 * board's own fields are validated separately and more strictly by `Board.restoreSnapshot`.
 */
export function loadLevelSnapshot(level: number): LevelSnapshot | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as LevelSnapshot
    if (!snap || snap.v !== 1 || snap.level !== level) return null
    if (typeof snap.at !== 'number' || Date.now() - snap.at > TTL_MS) return null
    if (typeof snap.moves !== 'number' || snap.moves <= 0) return null
    if (typeof snap.score !== 'number' || !Number.isFinite(snap.score) || snap.score < 0) return null
    if (!Array.isArray(snap.objectives)) return null
    if (!snap.board) return null
    return snap
  } catch {
    return null
  }
}

/** Drop the stored level. Called on every ending, and on the first move of every turn. */
export function clearLevelSnapshot(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // as above
  }
}

/** True when a resumable level is waiting — for a map/menu that wants to say so. */
export function pendingResumeLevel(): number | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const snap = JSON.parse(raw) as LevelSnapshot
    if (!snap || snap.v !== 1 || typeof snap.level !== 'number') return null
    if (typeof snap.at !== 'number' || Date.now() - snap.at > TTL_MS) return null
    return snap.level
  } catch {
    return null
  }
}

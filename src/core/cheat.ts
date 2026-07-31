/**
 * The endless-race cheat code — the secret swipe pattern and the recogniser behind it.
 *
 * A hidden strip of dead space under the endless board (nothing is drawn there — endless has no
 * helper shelf, that being a numbered-levels-only surface) reads swipes. Enter the pattern below and
 * the board erupts into a MEGA WIN: a free, move-less blast that pays at a multiplied rate, so the
 * score can be run up as far as patience allows.
 *
 * Kept here, PURE, rather than inline in GameScene for the usual reason this codebase splits logic
 * out: a gesture recogniser is exactly the kind of thing that is miserable to verify by hand on a
 * phone and trivial to pin in a test. The scene owns the strip's geometry and the spectacle; this
 * file owns "was that the code?".
 *
 * FAIRNESS. A run that fires this is UNRANKED — see `recordEndless`'s `ranked` option, which is the
 * one place that is enforced. Two independent reasons, and the second stands even if the mega win
 * paid nothing at all:
 *
 *   1. The daily race's entire premise is that one day key means one board for everyone, scored on
 *      a fixed 30-move budget (core/endless.ts). A free blast is not that budget.
 *   2. The blast plants specials and detonates through the board's own RNG — the stream seeded from
 *      the shared day key. From the first fire onward the refills diverge, so the run is physically
 *      on a board no one else is playing. There is nothing left to compare it to.
 *
 * So the cheat is a toy for the player's own screen, and the leaderboard never hears about it.
 */

/** The four axis-aligned swipes the strip can read. */
export type SwipeDir = 'left' | 'right' | 'up' | 'down'

/** The pattern. Seven swipes, no repeats-in-a-row except the deliberate double-up. */
export const CHEAT_CODE: readonly SwipeDir[] = ['left', 'right', 'up', 'up', 'down', 'right', 'left']

/**
 * Travel (design px) a strip gesture must cover before it counts as a swipe. Well above the board's
 * own DRAG_THRESHOLD (CELL·0.3 = 24): a board swipe is aimed at a tile the player is already
 * touching, whereas this one has to be deliberate enough that thumb drift on a dead strip never
 * starts feeding the recogniser.
 */
export const CHEAT_SWIPE_MIN = 44

/**
 * Longest pause allowed BETWEEN two swipes of the code.
 *
 * Sized for the player READING the code off a note for the first time, not for the one who already
 * has it in their thumbs — deliberately, because the timeout is not really a security boundary and
 * pretending otherwise buys nothing. Seven specific swipes in a dead strip is already unreachable by
 * accident at any timeout; all this actually defends against is a half-entry lying in wait for the
 * rest of a run, and four seconds ends that just as well as one would. Too TIGHT, meanwhile, has a
 * real cost: a hesitant entry, or a stutter on a low-end phone, silently rewinds a code the player
 * is entering correctly, with nothing on screen to say why.
 */
export const CHEAT_GAP_MS = 4000

/**
 * Classify a gesture by its dominant axis, or null if it never travelled far enough.
 *
 * The dominant-axis rule (and its horizontal tie-break) is deliberately the SAME one the board uses
 * for swap swipes, rather than a stricter "must be axis-aligned within N degrees" of its own: the
 * player's muscle memory for what counts as a "left" in this game is set by the board, and a strip
 * that disagreed with it would feel broken in a way no one could diagnose.
 */
export function swipeDir(dx: number, dy: number, minDist = CHEAT_SWIPE_MIN): SwipeDir | null {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < minDist) return null
  if (ax > ay) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}

/**
 * Rolling-window matcher for CHEAT_CODE. Feed it one swipe at a time; it returns true on the swipe
 * that completes the pattern.
 *
 * A ROLLING WINDOW, not an index that resets to 0 on a wrong swipe. The naive index is subtly wrong
 * whenever the code can overlap itself — this one starts and ends with `left`, so a fumbled entry
 * ending in an extra `left` has in fact already begun the next attempt, and an index-reset would
 * swallow it and leave the player swiping a code that "doesn't work" for reasons invisible to them.
 * Comparing the last CHEAT_CODE.length swipes gets every such case right for free.
 */
export class CheatSwipeCode {
  private recent: SwipeDir[] = []
  private lastAt = 0

  /**
   * Record a swipe at scene-clock time `atMs`; true means the code just completed (and the window
   * is cleared, so the whole pattern must be entered again for a second fire). A gap longer than
   * CHEAT_GAP_MS since the previous swipe drops the window first — a stale half-entry never
   * survives to be completed by an unrelated gesture later in the run.
   */
  feed(dir: SwipeDir, atMs: number): boolean {
    if (this.recent.length > 0 && atMs - this.lastAt > CHEAT_GAP_MS) this.recent.length = 0
    this.lastAt = atMs
    this.recent.push(dir)
    if (this.recent.length > CHEAT_CODE.length) this.recent.splice(0, this.recent.length - CHEAT_CODE.length)
    if (this.recent.length < CHEAT_CODE.length) return false
    if (!this.recent.every((d, i) => d === CHEAT_CODE[i])) return false
    this.recent.length = 0
    return true
  }

  /** Forget any partial entry — the scene calls this when the board stops being the player's. */
  reset(): void {
    this.recent.length = 0
    this.lastAt = 0
  }
}

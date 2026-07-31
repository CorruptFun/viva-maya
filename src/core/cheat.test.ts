import { describe, expect, it } from 'vitest'
import { CHEAT_CODE, CHEAT_GAP_MS, CHEAT_SWIPE_MIN, CheatSwipeCode, swipeDir } from './cheat'
import type { SwipeDir } from './cheat'

/**
 * The cheat strip is a gesture surface with no visible affordance, so every failure mode here is
 * invisible from the outside: a code that silently won't fire, or one that fires when nobody asked.
 * These pin both directions.
 */

/** Enter a run of swipes on a clock that ticks well inside CHEAT_GAP_MS; returns the fire count. */
function enter(code: CheatSwipeCode, dirs: SwipeDir[], step = 300, from = 1000): number {
  let fires = 0
  dirs.forEach((d, i) => {
    if (code.feed(d, from + i * step)) fires++
  })
  return fires
}

describe('swipeDir', () => {
  it('reads the four axes by their dominant component', () => {
    expect(swipeDir(-80, 4)).toBe('left')
    expect(swipeDir(80, -4)).toBe('right')
    expect(swipeDir(3, -80)).toBe('up')
    expect(swipeDir(-3, 80)).toBe('down')
  })

  it('ignores anything that has not travelled far enough to be deliberate', () => {
    expect(swipeDir(CHEAT_SWIPE_MIN - 1, 0)).toBeNull()
    expect(swipeDir(0, -(CHEAT_SWIPE_MIN - 1))).toBeNull()
    // Diagonal drift: neither component clears the bar, so the gesture is not a swipe at all —
    // it must not be rescued by its combined length.
    expect(swipeDir(40, 40)).toBeNull()
    expect(swipeDir(CHEAT_SWIPE_MIN, 0)).toBe('right')
  })

  it('breaks a perfect diagonal toward the vertical, exactly as the board does', () => {
    // The tie-break itself matters less than that it MATCHES the board's swap rule (`|dx| > |dy|`
    // → horizontal): one game, one idea of what a "left" is.
    expect(swipeDir(80, 80)).toBe('down')
    expect(swipeDir(-80, -80)).toBe('up')
  })
})

describe('CheatSwipeCode', () => {
  it('fires on the swipe that completes the pattern, and not before', () => {
    const code = new CheatSwipeCode()
    const partial = CHEAT_CODE.slice(0, -1) as SwipeDir[]
    expect(enter(code, partial)).toBe(0)
    expect(code.feed(CHEAT_CODE[CHEAT_CODE.length - 1], 2800)).toBe(true)
  })

  it('needs the whole pattern again for a second mega win', () => {
    const code = new CheatSwipeCode()
    expect(enter(code, [...CHEAT_CODE] as SwipeDir[])).toBe(1)
    // The trailing `left` of the first entry is NOT allowed to double as the leading `left` of the
    // next — a completed code clears the window, so stacking wins costs seven fresh swipes each.
    expect(enter(code, CHEAT_CODE.slice(1) as SwipeDir[], 300, 20000)).toBe(0)
    expect(enter(code, [...CHEAT_CODE] as SwipeDir[], 300, 40000)).toBe(1)
  })

  it('ignores ordinary swiping around the strip', () => {
    const code = new CheatSwipeCode()
    const noise: SwipeDir[] = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right', 'down', 'up']
    expect(enter(code, noise)).toBe(0)
  })

  it('re-anchors on a fumbled entry instead of swallowing the restart', () => {
    const code = new CheatSwipeCode()
    // Wrong second swipe, then a clean run from the top. The stray `down` is simply carried out of
    // the rolling window by the seven that follow. An index-reset recogniser passes this too...
    expect(enter(code, ['left', 'down', ...CHEAT_CODE] as SwipeDir[])).toBe(1)
  })

  it('lets the code overlap its own tail — the case an index-reset gets wrong', () => {
    const code = new CheatSwipeCode()
    // ...but not this one. The pattern starts AND ends with `left`, so a fumble whose last swipe is
    // that `left` has already begun the next attempt: only six more are owed, not seven.
    expect(enter(code, ['up', 'right', 'left'] as SwipeDir[])).toBe(0)
    expect(enter(code, CHEAT_CODE.slice(1) as SwipeDir[], 300, 3000)).toBe(1)
  })

  it('drops a half-entry once the player has clearly moved on', () => {
    const code = new CheatSwipeCode()
    const head = CHEAT_CODE.slice(0, -1) as SwipeDir[]
    expect(enter(code, head)).toBe(0)
    // The final swipe lands after the gap — the run is stale, so this is a fresh first swipe, not a
    // completion. Without the timeout, half a code entered early in a run would lie in wait.
    const stale = 1000 + head.length * 300 + CHEAT_GAP_MS + 1
    expect(code.feed(CHEAT_CODE[CHEAT_CODE.length - 1], stale)).toBe(false)
  })

  it('measures the gap between consecutive swipes, not from the first', () => {
    const code = new CheatSwipeCode()
    // Seven unhurried swipes, each just inside the window: total elapsed far exceeds CHEAT_GAP_MS,
    // which must not matter. A total-elapsed timeout would make the code unenterable one-handed.
    expect(enter(code, [...CHEAT_CODE] as SwipeDir[], CHEAT_GAP_MS - 100)).toBe(1)
  })

  it('forgets a partial entry on reset', () => {
    const code = new CheatSwipeCode()
    expect(enter(code, CHEAT_CODE.slice(0, -1) as SwipeDir[])).toBe(0)
    code.reset()
    expect(code.feed(CHEAT_CODE[CHEAT_CODE.length - 1], 3000)).toBe(false)
  })
})

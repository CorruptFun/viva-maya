/**
 * GAME-LOOP LIFECYCLE — the anti-drain sleep, and every signal that has to undo it.
 *
 * The game stops its own `requestAnimationFrame` while backgrounded (`loop.sleep()`), which is the
 * single biggest battery win available to it: nothing renders, tweens, or steps until the app is
 * visible again. The whole mechanism is safe only if EVERY way back to the foreground wakes it, and
 * that is what this file exists to guarantee.
 *
 * ── THE BUG THIS FIXES (measured, not theorised) ────────────────────────────────
 * `visibilitychange` used to be the only wake trigger. It is not enough. Between 2026-08-04 and
 * 2026-08-06, `resume_stall` fired 41 times across 3 devices and EVERY single one reported
 * `running: false` — a loop that was still asleep, on a page the watchdog had already confirmed
 * visible. `running` is only ever cleared by `sleep()`, so those events say exactly one thing: the
 * app came back to the foreground and the wake never ran.
 *
 * The owner hit it three times inside one 54-minute session on level 104 and reported the game as
 * "not letting me" play — which is what a frozen board looks like from the other side of the glass.
 *
 * ⚠️ `focus` is a FIRST-CLASS resume signal, not a nicety. Android returns focus without always
 * firing a visibility change (the notification shade, split screen, some launchers), and an
 * installed iOS PWA coming back through the app switcher is unreliable about it too. core/resumeguard
 * already knew this — it has listened to `focus` since the day it was written, for exactly this
 * reason — but it is a WATCHDOG: it can only notice the freeze ~900ms later, and only report and
 * nudge. The loop needs to not freeze in the first place, and that means the thing that put it to
 * sleep has to listen to every signal the watchdog listens to.
 *
 * ── THE TWO RULES ───────────────────────────────────────────────────────────────
 *  1. **Never wake a hidden page.** Android fires `focus` on pages that are still hidden, and the
 *     whole point of the sleep is that a backgrounded game costs nothing. Every wake path
 *     re-confirms `document.hidden` AT THE MOMENT IT RUNS, exactly as the watchdog does.
 *  2. **Only ever sleep on a genuine hide.** `blur` is deliberately NOT a sleep trigger: a page can
 *     lose focus while fully visible (another window on top, a system prompt), and sleeping there
 *     would freeze a game the player is looking at — the very failure this file is fixing.
 *
 * A loop that is already running is left alone. `running === true` with a dead RAF is a real state,
 * but recovering THAT needs frame-counter evidence before it is worth restarting the loop over, and
 * core/resumeguard owns it (it calls `sleep()` first to force the flag down, which is the only thing
 * that makes Phaser's `wake()` take effect on such a loop).
 */

/** The slice of Phaser's TimeStep this needs. `sleeping` is deliberately absent — see below. */
export interface LoopLike {
  /** Phaser's TimeStep: false while asleep. NOTE 3.90 has no `sleeping` flag; only this one is real. */
  running?: boolean
  sleep(): void
  wake(seamless?: boolean): void
}

export interface LoopGameLike {
  loop?: LoopLike
}

/** Resume signals, in the order they are least-to-most likely to be the only one a platform sends. */
const WAKE_EVENTS = ['focus', 'pageshow'] as const

/**
 * Own the backgrounded-game sleep and every path out of it.
 *
 * ⚠️ Call this BEFORE `installResumeGuard`. Listeners fire in registration order, so the wake has
 * already run by the time the watchdog starts timing — a watchdog that measured first would be
 * timing a loop nobody had tried to restart yet and would report a stall on every single resume.
 *
 * Never throws, and does nothing at all on a browser without these APIs.
 */
export function installLoopSleep(game: LoopGameLike): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  /** Rule 1: the page must be visible RIGHT NOW, not merely have been when the event was queued. */
  const wake = (): void => {
    try {
      if (document.hidden) return
      const loop = game.loop
      // Already alive → leave it be. A running-but-dead loop is resumeguard's job, not this one's.
      if (!loop || loop.running !== false) return
      loop.wake()
    } catch {
      // loop torn down mid-teardown — the watchdog covers the symptom
    }
  }

  /** Rule 2: only a genuine hide sleeps. Never `blur`. */
  const sleep = (): void => {
    try {
      if (document.hidden) game.loop?.sleep()
    } catch {
      // as above
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sleep()
    else wake()
  })
  for (const type of WAKE_EVENTS) window.addEventListener(type, wake)
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installLoopSleep } from './apploop'

/**
 * These are the regression tests for the freeze reported 2026-08-06 on level 104. The load-bearing
 * one is `wakes on focus alone` — the exact path 41 measured `resume_stall` events took, all of them
 * reporting a loop still asleep on a visible page. The rest guard the two ways this fix could make
 * things WORSE than the bug: waking a hidden page (kills the battery win) and sleeping a visible one
 * (freezes a game the player is looking at).
 */

type Listener = () => void

let docListeners: Record<string, Listener[]>
let winListeners: Record<string, Listener[]>
let hidden: boolean

/** Phaser 3.90's TimeStep, faithfully: `sleep()` only clears `running`, `wake()` no-ops if running. */
function makeGame(running = true) {
  const loop = {
    running,
    sleepCalls: 0,
    wakeCalls: 0,
    sleep(): void {
      loop.sleepCalls++
      if (loop.running) loop.running = false
    },
    wake(): void {
      loop.wakeCalls++
      if (loop.running) return
      loop.running = true
    },
  }
  return { loop }
}

const fire = (map: Record<string, Listener[]>, type: string): void => (map[type] ?? []).forEach(fn => fn())

beforeEach(() => {
  docListeners = {}
  winListeners = {}
  hidden = false
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: (t: string, fn: Listener) => void ((docListeners[t] ??= []).push(fn)),
    get hidden() {
      return hidden
    },
  }
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: (t: string, fn: Listener) => void ((winListeners[t] ??= []).push(fn)),
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).window
})

describe('loop sleep — the anti-drain half', () => {
  it('sleeps the loop when the page hides', () => {
    const game = makeGame()
    installLoopSleep(game)

    hidden = true
    fire(docListeners, 'visibilitychange')

    expect(game.loop.running).toBe(false)
  })

  /**
   * ⚠️ `blur` must NEVER sleep. A page can lose focus while fully visible (another window on top, a
   * system permission prompt), and sleeping there freezes a game the player is looking at — which is
   * the exact failure this file exists to fix, just triggered from the other side.
   */
  it('does not sleep on blur, only on a genuine hide', () => {
    const game = makeGame()
    installLoopSleep(game)

    fire(winListeners, 'blur') // not even registered, but assert the outcome not the wiring
    expect(game.loop.running).toBe(true)
    expect(game.loop.sleepCalls).toBe(0)
  })
})

describe('loop sleep — every path back to the foreground', () => {
  it('wakes on visibilitychange, the path that always worked', () => {
    const game = makeGame()
    installLoopSleep(game)

    hidden = true
    fire(docListeners, 'visibilitychange')
    hidden = false
    fire(docListeners, 'visibilitychange')

    expect(game.loop.running).toBe(true)
  })

  /**
   * ⚠️ THE REGRESSION. This is the shape of all 41 measured stalls: the app came back, only `focus`
   * fired, and the loop stayed asleep on a visible page. Before this fix the assertion below was
   * `false` and the board was frozen until the watchdog noticed ~900ms later — or, when the player
   * moved again inside that window and cancelled the watchdog's escalation, until they gave up.
   */
  it('wakes on focus alone, with no visibilitychange at all', () => {
    const game = makeGame()
    installLoopSleep(game)

    hidden = true
    fire(docListeners, 'visibilitychange') // backgrounded → asleep
    expect(game.loop.running).toBe(false)

    hidden = false // the app is foreground again...
    fire(winListeners, 'focus') // ...and this is the ONLY event the platform sent

    expect(game.loop.running).toBe(true)
  })

  it('wakes on pageshow, for a restore out of the back/forward cache', () => {
    const game = makeGame()
    installLoopSleep(game)

    hidden = true
    fire(docListeners, 'visibilitychange')
    hidden = false
    fire(winListeners, 'pageshow')

    expect(game.loop.running).toBe(true)
  })

  /**
   * ⚠️ THE DANGEROUS DIRECTION. Android fires `focus` on pages that are still hidden (split screen,
   * the notification shade, launcher overlays). Waking there would run the game — rendering, tweening,
   * burning battery — behind the player's back, throwing away the entire reason the sleep exists.
   */
  it('refuses to wake a page that is still hidden', () => {
    const game = makeGame()
    installLoopSleep(game)

    hidden = true
    fire(docListeners, 'visibilitychange')
    fire(winListeners, 'focus') // focus while STILL hidden
    fire(winListeners, 'pageshow')

    expect(game.loop.running).toBe(false)
  })

  /**
   * A healthy loop is left completely alone. Restarting requestAnimationFrame on every focus would
   * churn Phaser's fps accounting for nothing, and a running-but-dead loop needs frame-counter
   * evidence before it is worth a restart — which is core/resumeguard's job, not this file's.
   */
  it('never touches a loop that is already running', () => {
    const game = makeGame()
    installLoopSleep(game)

    fire(winListeners, 'focus')
    fire(winListeners, 'pageshow')
    fire(docListeners, 'visibilitychange')

    expect(game.loop.wakeCalls).toBe(0)
    expect(game.loop.sleepCalls).toBe(0)
    expect(game.loop.running).toBe(true)
  })

  it('survives repeated background/foreground cycles', () => {
    const game = makeGame()
    installLoopSleep(game)

    for (let i = 0; i < 5; i++) {
      hidden = true
      fire(docListeners, 'visibilitychange')
      expect(game.loop.running).toBe(false)
      hidden = false
      fire(winListeners, 'focus') // the unreliable-platform path, every time
      expect(game.loop.running).toBe(true)
    }
  })
})

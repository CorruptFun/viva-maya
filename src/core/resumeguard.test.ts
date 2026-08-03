import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installResumeGuard } from './resumeguard'

/**
 * The guard is event- and timer-driven and reloads the page as a last resort, so it is tested
 * against stubbed globals with fake timers. The property that matters most here is the NEGATIVE
 * one: a guard that reloads a healthy game would be far worse than the freeze it exists to fix.
 */

type Listener = () => void

let docListeners: Record<string, Listener[]>
let winListeners: Record<string, Listener[]>
let canvasListeners: Record<string, Array<(e: { preventDefault(): void }) => void>>
let reloads: number
let hidden: boolean

/**
 * A faithful stub of Phaser's TimeStep. `frame` is a GETTER derived from the clock while alive, so a
 * revived loop keeps advancing across the guard's wait exactly as a real requestAnimationFrame does.
 * Modelling it as a one-shot `frame += 10` on wake was wrong and made a recovering loop look dead.
 */
function makeGame(opts: { frame?: number; running?: boolean; advanceOnWake?: boolean } = {}) {
  let alive = false
  let base = opts.frame ?? 0
  let aliveSince = 0
  const loop = {
    get frame(): number {
      return alive ? base + Math.floor((Date.now() - aliveSince) / 16) : base
    },
    set frame(v: number) {
      base = v
      alive = false
    },
    running: opts.running ?? true,
    sleeping: false,
    sleepCalls: 0,
    wakeCalls: 0,
    sleep(): void {
      loop.sleepCalls++
      loop.running = false
      base = loop.frame
      alive = false
    },
    wake(): void {
      loop.wakeCalls++
      // Mirror Phaser: wake() is a NO-OP when `running` is already true.
      if (loop.running) return
      loop.running = true
      if (opts.advanceOnWake) {
        alive = true
        aliveSince = Date.now()
      }
    },
  }
  return {
    loop,
    renderer: { contextLost: false, type: 1 },
    canvas: {
      addEventListener: (t: string, fn: (e: { preventDefault(): void }) => void) => {
        ;(canvasListeners[t] ??= []).push(fn)
      },
    } as unknown as HTMLCanvasElement,
    scene: { getScenes: () => [{ scene: { key: 'game' } }] },
  }
}

const fire = (map: Record<string, Listener[]>, type: string): void => (map[type] ?? []).forEach(fn => fn())

beforeEach(() => {
  vi.useFakeTimers()
  docListeners = {}
  winListeners = {}
  canvasListeners = {}
  reloads = 0
  hidden = false
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: (t: string, fn: Listener) => void ((docListeners[t] ??= []).push(fn)),
    get hidden() {
      return hidden
    },
    body: { dataset: {} },
  }
  ;(globalThis as Record<string, unknown>).window = {
    addEventListener: (t: string, fn: Listener) => void ((winListeners[t] ??= []).push(fn)),
    setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as unknown,
    clearTimeout: ((id: number) => clearTimeout(id)) as unknown,
    location: {
      reload: () => {
        reloads++
      },
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).document
  delete (globalThis as Record<string, unknown>).window
})

describe('resume guard — must never punish a healthy game', () => {
  it('does nothing when frames advance after a resume', () => {
    const game = makeGame({ frame: 100, running: true })
    installResumeGuard(game)

    fire(docListeners, 'visibilitychange')
    game.loop.frame = 160 // the loop is clearly alive
    vi.advanceTimersByTime(1000)
    game.loop.frame = 220
    vi.advanceTimersByTime(4000)

    expect(reloads).toBe(0)
    expect(game.loop.wakeCalls).toBe(0) // never touched a working loop
  })

  /**
   * ⚠️ THE DANGEROUS CASE. main.ts stops the loop on purpose while the page is hidden, so a hidden
   * page has a frozen frame counter BY DESIGN. `focus` fires on a still-hidden page in real Android
   * situations (split screen, the notification shade, launcher overlays). If the guard treated that
   * as a stall it would reload a game that was working perfectly — strictly worse than the bug.
   */
  it('ignores a focus event while the page is still hidden', () => {
    hidden = true
    const game = makeGame({ frame: 0, running: true })
    installResumeGuard(game)

    fire(winListeners, 'focus')
    vi.advanceTimersByTime(5000)

    expect(reloads).toBe(0)
    expect(game.loop.wakeCalls).toBe(0)
  })

  it('does not reload if the page is backgrounded again mid-check', () => {
    const game = makeGame({ frame: 0, running: false })
    installResumeGuard(game)

    fire(docListeners, 'visibilitychange') // visible, loop stalled
    hidden = true // player leaves again before the check completes
    vi.advanceTimersByTime(5000)

    expect(reloads).toBe(0)
  })
})

describe('resume guard — recovering a genuinely wedged loop', () => {
  /**
   * The state observed on 2026-08-03: `running === true` while the frame counter is pinned. Phaser's
   * `wake()` opens with `if (this.running) return`, so calling it alone can never recover this —
   * which is exactly why the guard calls `sleep()` first to force the flag down.
   */
  it('sleeps before waking, so a running-but-dead loop actually restarts', () => {
    const game = makeGame({ frame: 0, running: true, advanceOnWake: true })
    installResumeGuard(game)

    fire(docListeners, 'visibilitychange')
    vi.advanceTimersByTime(1000) // past the first check

    expect(game.loop.sleepCalls).toBe(1)
    expect(game.loop.wakeCalls).toBe(1)
    expect(game.loop.frame).toBeGreaterThan(0) // the nudge genuinely restarted it
  })

  it('does not reload once the nudge has revived the loop', () => {
    const game = makeGame({ frame: 0, running: true, advanceOnWake: true })
    installResumeGuard(game)

    fire(docListeners, 'visibilitychange')
    vi.advanceTimersByTime(5000)

    expect(reloads).toBe(0)
  })

  it('reloads only when the loop is still dead after the nudge', () => {
    const game = makeGame({ frame: 0, running: true, advanceOnWake: false })
    installResumeGuard(game)

    fire(docListeners, 'visibilitychange')
    vi.advanceTimersByTime(5000)

    expect(reloads).toBe(1)
  })
})

describe('resume guard — WebGL context loss', () => {
  it('calls preventDefault on contextlost, which is what makes a restore possible at all', () => {
    const game = makeGame()
    installResumeGuard(game)

    let prevented = false
    canvasListeners['webglcontextlost']?.forEach(fn => fn({ preventDefault: () => (prevented = true) }))
    expect(prevented).toBe(true)
    expect(reloads).toBe(0) // losing the context alone does not reload; the restore does
  })

  it('reloads on restore, because every texture here is baked at runtime with no file to reload', () => {
    const game = makeGame()
    installResumeGuard(game)

    canvasListeners['webglcontextrestored']?.forEach(fn => fn({ preventDefault: () => {} }))
    expect(reloads).toBe(1)
  })
})

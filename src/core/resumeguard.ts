import { EVENTS, track } from './analytics'

/**
 * RESUME GUARD — the game must never come back from the app switcher frozen.
 *
 * Reported 2026-08-03 by a player on a Galaxy S25: leave the game for another app, come back, the
 * game is frozen and the only way out is force-quitting and reopening. That is the worst possible
 * failure for a phone game, because switching away is not an edge case — it is what phones are.
 *
 * ── Why this is a WATCHDOG and not a fix for one bug ─────────────────────────
 * Three different failures produce that exact symptom, and from here they are indistinguishable:
 *
 *  1. **WebGL context loss.** Android — Samsung especially — reclaims GPU contexts from backgrounded
 *     apps under memory pressure. Phaser marks `renderer.contextLost` and stops drawing. This game is
 *     *unusually* exposed: it ships zero binary assets and bakes EVERY texture at runtime (emoji
 *     symbols, button faces, chip icons, marquee nodes). There is no source file to re-upload, so a
 *     restored context comes back with empty textures even if Phaser rebinds it.
 *  2. **A wedged RAF.** main.ts stops the loop with `game.loop.sleep()` while hidden (a real battery
 *     win) and restarts it with `wake()`. `wake()` early-returns when `running` is already true, so
 *     any path that leaves `running` set while requestAnimationFrame is actually dead is a permanent
 *     stall — the loop believes it is running and nothing ever steps.
 *  3. **A hung await in the resolve loop.** GameScene's cascade awaits tween completions; a tween
 *     killed or stranded across a background/foreground cycle never resolves its promise, and the
 *     board sits in `resolving` forever. This codebase has had that shape of bug before.
 *
 * Rather than guess which one an S25 hits, this watches the ONE symptom all three share — the game
 * loop stops advancing after a resume — and both reports it and recovers. The telemetry is what
 * turns the next occurrence into a diagnosis instead of another report.
 *
 * ⚠️ Every timer here is `window.setTimeout`, never a Phaser `scene.time` call. Phaser timers are
 * driven BY the game loop, which is precisely the thing suspected of being wedged — a watchdog
 * scheduled on the loop it is watching would never fire in exactly the case it exists for.
 *
 * Never throws, and does nothing at all on a browser without these APIs.
 */

/** How long to give a resume before deciding the loop is genuinely wedged. */
const FIRST_CHECK_MS = 900
/** After a nudge, how long before escalating to the last resort. */
const SECOND_CHECK_MS = 1200

interface LoopLike {
  frame: number
  running?: boolean
  sleeping?: boolean
  wake(seamless?: boolean): void
  sleep(): void
}

interface GameLike {
  loop: LoopLike
  renderer?: { contextLost?: boolean; type?: number }
  canvas?: HTMLCanvasElement
  scene?: { getScenes(isActive: boolean): Array<{ scene: { key: string } }> }
}

/** Snapshot of everything worth knowing when a stall is reported. Cheap and side-effect free. */
function diagnostics(game: GameLike): Record<string, unknown> {
  let scenes = ''
  try {
    scenes = (game.scene?.getScenes(true) ?? []).map(s => s.scene.key).join(',')
  } catch {
    scenes = '?'
  }
  let boardState = ''
  try {
    // GameScene mirrors its state machine here for DEV debugging; on a stall it is the single most
    // useful field, because `resolving` points straight at cause 3 and `idle` rules it out.
    const raw = document.body?.dataset?.vegas
    boardState = raw ? String(JSON.parse(raw).state ?? '') : ''
  } catch {
    boardState = '?'
  }
  return {
    contextLost: game.renderer?.contextLost === true,
    running: game.loop?.running === true,
    sleeping: game.loop?.sleeping === true,
    scenes,
    boardState,
  }
}

/**
 * Watch every resume; if the loop has not advanced a single frame shortly after, nudge it, and if
 * that fails, reload.
 *
 * The reload is a deliberate last resort, not a shrug. Progress lives in localStorage and is
 * persisted on every change, so a reload costs at most the current level's in-flight state — which
 * a frozen game has already cost, plus the force-quit. `location.reload()` is strictly better than
 * what the player is doing manually today.
 */
export function installResumeGuard(game: GameLike): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  let pending = 0
  const clear = (): void => {
    if (pending) {
      window.clearTimeout(pending)
      pending = 0
    }
  }

  /**
   * ⚠️ THE FALSE-POSITIVE GUARD, and the most important line in this file. main.ts deliberately
   * stops the loop while the page is hidden, so a hidden page has a frozen frame counter BY DESIGN.
   * Every check must therefore re-confirm visibility at the moment it runs, not just when it was
   * scheduled — `focus` can fire while the page is still hidden (Android split screen, the
   * notification shade, a launcher overlay), and the page can be backgrounded again inside the
   * check window. Without this, a correctly sleeping game reads as a stall and the guard reloads a
   * game that was working perfectly. That would be far worse than the bug it exists to fix.
   */
  const asleepOnPurpose = (): boolean => document.hidden

  const check = (): void => {
    if (asleepOnPurpose()) return
    const before = game.loop?.frame ?? 0
    pending = window.setTimeout(() => {
      if (asleepOnPurpose()) return
      // Advanced → healthy resume, the overwhelmingly common case. Nothing is sent; a heartbeat on
      // every app switch would be the noisiest event in the table and would tell us nothing.
      if ((game.loop?.frame ?? 0) > before) return

      const diag = diagnostics(game)
      track(EVENTS.RESUME_STALL, { ...diag, stage: 'detected' })

      // Nudge: the cheap recovery, no visible interruption when it works.
      //
      // ⚠️ `sleep()` FIRST, and this is the whole trick. Phaser's `wake()` opens with
      // `if (this.running) { return }` — so on a loop whose `running` flag is true while
      // requestAnimationFrame is actually dead, `wake()` is a silent no-op and the game stays frozen
      // forever no matter how many times it is called. That state is real and reachable: a page that
      // loads already-hidden boots with `running === true` and a frame counter pinned at 0 (observed
      // directly, 2026-08-03). `sleep()` sets `running = false` and cancels the (already dead) frame
      // request, which is exactly what lets the following `wake()` genuinely restart the loop.
      try {
        game.loop.sleep()
        game.loop.wake()
      } catch {
        // renderer/loop already torn down — the escalation below is the answer
      }

      const after = game.loop?.frame ?? 0
      pending = window.setTimeout(() => {
        if (asleepOnPurpose()) return // backgrounded again mid-recovery — never reload behind their back
        if ((game.loop?.frame ?? 0) > after) {
          track(EVENTS.RESUME_STALL, { ...diag, stage: 'recovered_by_wake' })
          return
        }
        // Still dead. A lost GPU context can never be nursed back from here — with every texture
        // baked at runtime there is nothing to re-upload — so stop trying to be clever.
        track(EVENTS.RESUME_STALL, { ...diagnostics(game), stage: 'reloading' })
        try {
          window.location.reload()
        } catch {
          // nothing further we can do
        }
      }, SECOND_CHECK_MS)
    }, FIRST_CHECK_MS)
  }

  document.addEventListener('visibilitychange', () => {
    clear()
    if (!document.hidden) check()
  })
  // Android returns focus without always firing a visibility change (notification shade, split
  // screen, some launchers), so focus is a second, independent trigger for the same check. `check`
  // re-confirms visibility itself, so a focus event on a still-hidden page correctly does nothing.
  window.addEventListener('focus', () => {
    clear()
    check()
  })

  // ── WebGL context loss, handled explicitly on the MAIN canvas ──
  // view3d/stage.ts already guards the 3D layer; nothing guarded the game itself. Calling
  // preventDefault() is what makes the browser promise a `webglcontextrestored` at all — without it
  // the context is gone for good and the canvas stays frozen until the app is killed.
  try {
    const canvas = game.canvas
    if (canvas) {
      canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault()
        track(EVENTS.CONTEXT_LOST, { phase: 'lost', ...diagnostics(game) })
      })
      canvas.addEventListener('webglcontextrestored', () => {
        // Reload rather than resume. Phaser rebinds the context, but every texture in this game is
        // generated at boot with no file behind it, so a "restored" game renders blank or garbage —
        // which looks identical to the freeze we are fixing and is harder to explain.
        track(EVENTS.CONTEXT_LOST, { phase: 'restored_reloading' })
        try {
          window.location.reload()
        } catch {
          // nothing further we can do
        }
      })
    }
  } catch {
    // no canvas / no addEventListener — the visibility watchdog above still covers the symptom
  }
}

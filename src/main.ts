import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_W, restScrollY, updateWorldH, worldH } from './config'
import { BootScene } from './scenes/BootScene'
import { DailyBonusScene } from './scenes/DailyBonusScene'
import { GameScene } from './scenes/GameScene'
import { HomeScene } from './scenes/HomeScene'
import { LevelSelectScene } from './scenes/LevelSelectScene'
import { StoreScene } from './scenes/StoreScene'
import { installQualityGovernor, quality } from './view/quality'
import { applyPageChrome, getTheme } from './view/theme'

registerSW({ immediate: true })

// Paint the body background + <meta theme-color> to match the active theme at boot,
// so the page chrome behind the canvas matches the wash (Golden Hour = unchanged).
applyPageChrome(getTheme())

if (import.meta.env.DEV) {
  // On-screen error surface — devtools aren't always reachable (phones, embedded panes).
  const show = (msg: string) => {
    let el = document.getElementById('err') as HTMLPreElement | null
    if (!el) {
      el = document.createElement('pre')
      el.id = 'err'
      el.style.cssText =
        'position:fixed;left:0;bottom:0;right:0;margin:0;padding:8px;background:#400;color:#f88;font:12px monospace;z-index:9;white-space:pre-wrap'
      document.body.appendChild(el)
    }
    el.textContent += msg + '\n'
  }
  window.addEventListener('error', e =>
    show(`${e.message} @ ${(e.filename || '').split('/').pop()}:${e.lineno}`)
  )
  window.addEventListener('unhandledrejection', e => show(`unhandled rejection: ${e.reason}`))
}

// --- Hi-DPI crispness --------------------------------------------------------
// Phaser's FIT mode renders the 720×1280 world into a 720×1280 canvas BACKING
// store and CSS-upscales it to the physical screen — soft on a DPR 2–3 phone.
// We keep the LOGICAL world (and pointer coords, and every scene's 720×1280
// layout) exactly as-is, and instead enlarge the canvas backing + WebGL viewport
// to renderScale× so the GPU renders at device resolution. The projection stays
// at the base size (pipelines read renderer.projectionWidth, which the Scale
// Manager pins to 720×1280), so nothing moves in world space; only the per-camera
// scissor is rescaled to the larger buffer. Capped at 2× to bound fill-rate; the
// quality governor drops it to 1× on the 'low' tier.
const DPR_CAP = 2

/** Live render scale, read by the Text factory (below) at text-creation time. */
const renderScaleRef = { value: Math.max(1, Math.min(window.devicePixelRatio || 1, DPR_CAP)) }

function targetRenderScale(): number {
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, DPR_CAP))
  return quality.tier() === 'low' ? 1 : dpr
}

/**
 * Give every Phaser Text a higher internal resolution by default (≈ min(DPR, 2)) so glyphs are
 * rasterised at device density instead of 1× — without editing any call site. Text.width/height
 * stay resolution-independent, so layout/centering is unchanged; only the backing canvas gets more
 * texels. Installed before the game boots so all `add.text` / `make.text` calls are covered.
 */
function installTextResolution(): void {
  const factory = Phaser.GameObjects.GameObjectFactory.prototype as unknown as {
    text: (x: number, y: number, text: unknown, style?: Record<string, unknown>) => unknown
  }
  const creator = Phaser.GameObjects.GameObjectCreator.prototype as unknown as {
    text: (config?: { style?: Record<string, unknown> }, addToScene?: boolean) => unknown
  }
  const origAdd = factory.text
  factory.text = function (x, y, text, style) {
    const s = style ?? {}
    if (s.resolution === undefined) s.resolution = renderScaleRef.value
    return origAdd.call(this, x, y, text, s)
  }
  const origMake = creator.text
  creator.text = function (config, addToScene) {
    const c = config ?? {}
    c.style = c.style ?? {}
    if (c.style.resolution === undefined) c.style.resolution = renderScaleRef.value
    return origMake.call(this, c, addToScene)
  }
}

/**
 * Wire the canvas backing / viewport / scissor to the render scale by making the WebGL renderer
 * itself DPR-aware. WebGL only (the Canvas fallback keeps the default backing).
 *
 * Why this replaces the old "override renderer.width + re-apply on the RESIZE event" approach:
 * Phaser's `WebGLRenderer.onResize` compares `baseSize` (the logical 720×1280) against
 * `renderer.width`. The previous code pushed `renderer.width` to the enlarged 2× backing, so that
 * comparison was ALWAYS unequal — every Scale Manager RESIZE (window/URL-bar resize, orientation,
 * the periodic re-check, background→foreground) made Phaser call `renderer.resize(720, 1280)`, which
 * reset `gl.viewport` to the LOGICAL 1× size against a still-2× backing store. That renders the whole
 * world into one quarter of the buffer (the "canvas collapses to ¼, anchored in a corner" bug). A
 * separate re-apply on the RESIZE event tried to patch the viewport back to 2×, but it was a race:
 * any frame that drew before the patch — or a governor tier flip landing at the wrong moment — got
 * stuck collapsed.
 *
 * The fix: override `renderer.resize` so the backing + viewport are ALWAYS the logical size × render
 * scale, while the PROJECTION stays logical (720×1280) so world coords, pointer mapping, and every
 * scene's 720×1280 layout are byte-for-byte unchanged. Now Phaser's own resize path — the exact call
 * that used to break us — produces the correct, self-consistent enlarged state atomically, so the
 * backing and viewport can never desync. No re-apply, no race, robust across resize / orientation /
 * governor tier change / background→foreground.
 */
function installHiDpi(game: Phaser.Game): void {
  const setup = (): void => {
    const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer
    const gl = renderer.gl
    if (!gl) return // Canvas renderer fallback — leave the default backing.

    type WGL = Phaser.Renderer.WebGL.WebGLRenderer

    // Cameras stay in the LOGICAL 720×1280 space, so their scissor rects (logical coords) are scaled
    // up to the enlarged backing here, with the y-flip using the real buffer height. Every gl.scissor
    // funnels through setScissor / resetScissor, so overriding both is sufficient.
    const scissor = (x: number, y: number, w: number, h: number): void => {
      const s = renderScaleRef.value
      gl.scissor(
        Math.round(x * s),
        Math.round(renderer.drawingBufferHeight - (y + h) * s),
        Math.round(w * s),
        Math.round(h * s)
      )
    }
    renderer.setScissor = function (this: WGL, x: number, y: number, width: number, height: number) {
      const current = this.currentScissor
      let doSet = width > 0 && height > 0
      if (current && doSet) {
        doSet = current[0] !== x || current[1] !== y || current[2] !== width || current[3] !== height
      }
      if (doSet) {
        this.flush()
        scissor(x, y, width, height)
      }
      return this
    } as typeof renderer.setScissor
    renderer.resetScissor = function (this: WGL) {
      gl.enable(gl.SCISSOR_TEST)
      const c = this.currentScissor
      if (c && c[2] > 0 && c[3] > 0) scissor(c[0], c[1], c[2], c[3])
      return this
    } as typeof renderer.resetScissor

    // The DPR-aware resize. Phaser calls this with the LOGICAL base size (720×1280) on every resize /
    // orientation change / refresh; the governor calls it (no args) on a tier change. We render the
    // backing + viewport at logical × renderScale, but pin the projection to the logical size so the
    // world is unchanged. This is the whole fix — everything the old `apply()` did, but now it IS the
    // resize, so nothing can re-run the stock 1× path behind our back.
    renderer.resize = function (this: WGL, width?: number, height?: number) {
      const base = game.scale.baseSize
      const logicalW = width ?? base.width
      const logicalH = height ?? base.height
      const s = targetRenderScale()
      const bw = Math.max(1, Math.round(logicalW * s))
      const bh = Math.max(1, Math.round(logicalH * s))
      const canvas = game.canvas
      if (canvas.width !== bw) canvas.width = bw
      if (canvas.height !== bh) canvas.height = bh
      // renderer.width/height drive the viewport + any framebuffer/mask restore paths, so they point
      // at the enlarged backing; the projection is set to the LOGICAL size, so world coordinates
      // (and pointer hit-testing, which uses the Scale Manager, not this) are unchanged.
      this.width = bw
      this.height = bh
      this.setProjectionMatrix(logicalW, logicalH)
      gl.viewport(0, 0, bw, bh)
      // drawingBufferHeight / defaultScissor are not in the public typings but are the real fields
      // the scissor + framebuffer paths read; keep them in step with the enlarged buffer.
      const internals = this as unknown as { drawingBufferHeight: number; defaultScissor: number[] }
      internals.drawingBufferHeight = gl.drawingBufferHeight
      gl.scissor(0, gl.drawingBufferHeight - bh, bw, bh)
      internals.defaultScissor[2] = bw
      internals.defaultScissor[3] = bh
      renderScaleRef.value = s
      this.emit(Phaser.Renderer.Events.RESIZE, bw, bh)
      return this
    } as typeof renderer.resize

    // Seed the enlarged backing now (boot already ran the stock resize at 1×).
    renderer.resize()
  }

  if (game.isBooted) setup()
  else game.events.once(Phaser.Core.Events.READY, setup)

  // Governor-driven scale change: when the target render scale changes (tier → 'low' drops to 1×, or
  // promotes back to the capped DPR), re-run the DPR-aware resize so the backing follows. Cheap
  // per-step comparison; the actual backing/viewport change only runs on a real transition.
  game.events.on(Phaser.Core.Events.POST_STEP, () => {
    if (renderScaleRef.value !== targetRenderScale()) {
      ;(game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).resize()
    }
  })
}

installTextResolution()

// Seed the world height from the device aspect BEFORE boot so the very first layout fills the screen
// (width stays 720; the height grows to kill the FIT letterbox on tall phones). See config.worldH.
updateWorldH(window.innerWidth, window.innerHeight)

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: DESIGN_W,
  height: worldH(),
  backgroundColor: '#f6f3ec',
  disableContextMenu: true,
  render: { antialias: true },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, HomeScene, LevelSelectScene, DailyBonusScene, StoreScene, GameScene],
})

// Keep the flexible world height matched to the live viewport aspect: on a real resize / orientation
// change, recompute worldH and (only if it changed) resize the game + re-centre every live scene's
// camera on the design box. Guarded so the setGameSize-triggered refresh doesn't recurse (worldH is
// then stable → updateWorldH returns false). The hi-DPI renderer.resize override keeps the backing +
// viewport correct through this automatically.
game.scale.on(Phaser.Scale.Events.RESIZE, () => {
  const parent = game.scale.parentSize
  if (!updateWorldH(parent.width, parent.height)) return
  game.scale.setGameSize(DESIGN_W, worldH())
  for (const scene of game.scene.getScenes(true)) {
    scene.cameras?.main?.setScroll(scene.cameras.main.scrollX, restScrollY())
  }
})

// Adaptive quality governor (E2): ticks every frame off the game loop and samples
// frame time to auto-adjust a quality tier. Read-only for now — consumers land in
// later phases. Ticking pauses automatically while the loop is asleep (below).
installQualityGovernor(game)

// Render the canvas backing at device pixel ratio (capped 2×) for crisp hi-DPI output. Seeded from
// the governor tier, so a Save-Data / low-tier device degrades to 1×. Runs after the governor so
// the seeded tier is available.
installHiDpi(game)

// Anti-drain: fully stop the game loop while the app is backgrounded — the biggest
// battery win. `sleep()` halts requestAnimationFrame, so NOTHING renders, tweens,
// or steps until the tab is visible again; `wake()` resumes it. Wall-clock logic
// (daily spin / lives) reads Date.now() on demand, so it self-corrects on resume;
// SFX are transient one-shots whose AudioContext resumes on the next input.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) game.loop?.sleep()
    else game.loop?.wake()
  })
}

// DEV-only game handle: expose the Phaser game on `window.__vm` so an in-browser UI audit can pump
// frames manually (`game.step(t, dt)`) when the preview pane throttles requestAnimationFrame — the
// only way to settle entrance/idle tweens for a screenshot in that environment. Stripped from prod.
if (import.meta.env.DEV) (window as any).__vm = game

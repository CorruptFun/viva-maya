import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_H, DESIGN_W } from './config'
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
 * Wire the canvas backing / viewport / scissor to the render scale. WebGL only (the Canvas fallback
 * keeps the default backing). Re-applies on every renderer resize and whenever the governor changes
 * the target scale.
 */
function installHiDpi(game: Phaser.Game): void {
  const apply = (): void => {
    const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer
    const gl = renderer.gl
    if (!gl) return
    const s = targetRenderScale()
    const base = game.scale.baseSize
    const bw = Math.max(1, Math.round(base.width * s))
    const bh = Math.max(1, Math.round(base.height * s))
    const canvas = game.canvas
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh
    // renderer.width/height drive the WebGL viewport + framebuffer/mask paths, so point them at the
    // backing; projectionWidth/Height stay at the base size (set by the Scale Manager's resize), so
    // world coordinates are unchanged. drawingBufferHeight tracks the real (enlarged) buffer.
    renderer.width = bw
    renderer.height = bh
    ;(renderer as unknown as { drawingBufferHeight: number }).drawingBufferHeight = gl.drawingBufferHeight
    gl.viewport(0, 0, bw, bh)
    renderScaleRef.value = s
  }

  const setup = (): void => {
    const renderer = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer
    const gl = renderer.gl
    if (!gl) return // Canvas renderer fallback — leave the default backing.

    // Cameras stay 720×1280, so their scissor rects (in world/base space) must be scaled up to the
    // enlarged backing, with the y-flip using the real buffer height. Every gl.scissor call funnels
    // through setScissor / resetScissor, so overriding both is sufficient.
    const scissor = (x: number, y: number, w: number, h: number): void => {
      const s = renderScaleRef.value
      gl.scissor(Math.round(x * s), Math.round(renderer.drawingBufferHeight - (y + h) * s), Math.round(w * s), Math.round(h * s))
    }
    type WGL = Phaser.Renderer.WebGL.WebGLRenderer
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

    apply()
    renderer.on(Phaser.Renderer.Events.RESIZE, apply)
  }

  if (game.isBooted) setup()
  else game.events.once(Phaser.Core.Events.READY, setup)

  // Governor-driven degrade: re-apply when the target scale changes (e.g. a weak device drops to the
  // 'low' tier → 1×). Cheap per-step comparison; the actual backing resize only runs on a real change.
  game.events.on(Phaser.Core.Events.POST_STEP, () => {
    if (renderScaleRef.value !== targetRenderScale()) apply()
  })
}

installTextResolution()

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'app',
  width: DESIGN_W,
  height: DESIGN_H,
  backgroundColor: '#f6f3ec',
  disableContextMenu: true,
  render: { antialias: true },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [BootScene, HomeScene, LevelSelectScene, DailyBonusScene, StoreScene, GameScene],
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

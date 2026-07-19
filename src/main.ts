import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_W, restScrollY, updateWorldH, worldH } from './config'
import { BootScene } from './scenes/BootScene'
import { DailyBonusScene } from './scenes/DailyBonusScene'
import { GameScene } from './scenes/GameScene'
import { HomeScene } from './scenes/HomeScene'
import { LevelSelectScene } from './scenes/LevelSelectScene'
import { StoreScene } from './scenes/StoreScene'
import { installQualityGovernor } from './view/quality'
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

// --- Scaling: stock Phaser FIT ----------------------------------------------
// We deliberately use Phaser's default FIT + CENTER_BOTH scaling with NO custom hi-DPI / DPR backing
// override. The canvas backing store is exactly the game size (720 × worldH) and the browser
// CSS-upscales it to the physical screen. This is slightly softer on a DPR 2–3 phone than rendering
// at device resolution, but it is Phaser's battle-tested resize path — the backing and gl.viewport
// can never desync, so the game-breaking "canvas collapses to ¼, corner-anchored" bug (caused by a
// prior custom 2× backing subsystem that patched renderer.resize / scissor internals and fought
// Phaser's own resize on every orientation / URL-bar / governor tier change) is now impossible.
// Crispness will be restored later via a properly device-verified approach.

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
// then stable → updateWorldH returns false). Stock Phaser FIT keeps the canvas backing + viewport
// correct through this automatically.
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

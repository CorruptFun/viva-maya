import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_W, restScrollY, updateWorldH, worldH } from './config'
import { bootstrapCloud, pushCloudSave } from './core/cloud'
import { captureRefFromUrl } from './core/referrals'
import { setPersistListener } from './core/save'
import { BootScene } from './scenes/BootScene'
import { DailyBonusScene } from './scenes/DailyBonusScene'
import { GameScene } from './scenes/GameScene'
import { HomeScene } from './scenes/HomeScene'
import { LevelSelectScene } from './scenes/LevelSelectScene'
import { StoreScene } from './scenes/StoreScene'
import { installQualityGovernor } from './view/quality'
import { applyPageChrome, getTheme } from './view/theme'

// PWA updates: 'prompt' mode (vite.config) surfaces a visible "new version — refresh" toast the
// player taps, instead of a silent update that lands a launch late. Progress lives in localStorage,
// which the refresh never touches, so updating can't lose a game.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    showUpdateToast(() => void updateSW(true))
  },
})

// Ask the browser NOT to evict our localStorage (the save) under storage pressure — a real durability
// win for an installed PWA. Fire-and-forget; browsers without the API just skip it.
try {
  void navigator.storage?.persist?.()
} catch {
  // unsupported — no-op
}

// Cloud save (dormant unless VITE_SUPABASE_* is configured): mirror every local persist to the cloud.
// Registered here so save.ts stays backend-agnostic; no-ops entirely when signed out / unconfigured.
setPersistListener(pushCloudSave)

// Referral capture: stash a ?ref=CODE invite before anything can navigate it away (local-only,
// never overwrites an earlier invite; registration happens after sign-in — core/referrals.ts).
captureRefFromUrl()

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

// Seed the world height from the device aspect BEFORE boot so the very first layout fills the screen
// (width stays 720; the height grows to kill the FIT letterbox on tall phones). See config.worldH.
updateWorldH(window.innerWidth, window.innerHeight)

// Reconcile with the cloud BEFORE the first scene reads the save (bounded so a slow/offline network
// can never stall boot), THEN start Phaser. Resolves instantly when cloud is unconfigured / signed out.
void bootstrapCloud().then(startGame)

function startGame(): void {
  // --- Scaling: stock Phaser FIT --------------------------------------------
  // We deliberately use Phaser's default FIT + CENTER_BOTH scaling with NO custom hi-DPI / DPR backing
  // override. The canvas backing store is exactly the game size (720 × worldH) and the browser
  // CSS-upscales it to the physical screen. This is slightly softer on a DPR 2–3 phone than rendering
  // at device resolution, but it is Phaser's battle-tested resize path — the backing and gl.viewport
  // can never desync, so the game-breaking "canvas collapses to ¼, corner-anchored" bug (caused by a
  // prior custom 2× backing subsystem that patched renderer.resize / scissor internals and fought
  // Phaser's own resize on every orientation / URL-bar / governor tier change) is now impossible.
  // Crispness will be restored later via a properly device-verified approach.
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

  // Adaptive quality governor (E2): ticks every frame off the game loop and samples frame time to
  // auto-adjust a quality tier. Ticking pauses automatically while the loop is asleep (below).
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
  // frames manually (`game.step(t, dt)`) when the preview pane throttles requestAnimationFrame. Stripped from prod.
  if (import.meta.env.DEV) (window as unknown as { __vm: Phaser.Game }).__vm = game
}

/**
 * A small warm "new version available" banner (bottom, above the safe-area) with a Refresh button
 * that applies the waiting service worker + reloads. Pure DOM so it works before any scene is up;
 * guarded against duplicates. Progress is in localStorage, so the reload is always safe.
 */
function showUpdateToast(onRefresh: () => void): void {
  if (document.getElementById('vm-update-toast')) return
  const bar = document.createElement('div')
  bar.id = 'vm-update-toast'
  bar.style.cssText =
    'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:2147483647;' +
    'display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:16px;max-width:calc(100vw - 32px);' +
    'background:#fffdf8;color:#3a352b;font:600 15px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'box-shadow:0 8px 28px rgba(120,90,30,.28);border:2px solid #f2c14e'
  const label = document.createElement('span')
  label.textContent = 'New version available'
  const btn = document.createElement('button')
  btn.textContent = 'Refresh'
  btn.style.cssText =
    'appearance:none;border:0;cursor:pointer;padding:9px 18px;border-radius:12px;min-height:44px;' +
    'background:#c9930a;color:#fff;font:700 15px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'
  btn.onclick = () => {
    bar.remove()
    onRefresh()
  }
  bar.append(label, btn)
  document.body.appendChild(bar)
}

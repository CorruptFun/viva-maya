import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_W, restScrollY, setSafeTopInset, updateWorldH, worldH } from './config'
import { EVENTS, initAnalytics, track } from './core/analytics'
import { bootstrapCloud, cloudAccessToken, cloudUserId, pushCloudSave } from './core/cloud'
import { endlessBoardRng } from './core/boardpick'
import { dayKey } from './core/endless'
import { ensureSalt } from './core/racesalt'
import { captureRefFromUrl } from './core/referrals'
import { setPersistListener } from './core/save'
import { BootScene } from './scenes/BootScene'
import { GameScene } from './scenes/GameScene'
import { HomeScene } from './scenes/HomeScene'
import { LevelSelectScene } from './scenes/LevelSelectScene'
import { SlotScene } from './scenes/SlotScene'
import { StoreScene } from './scenes/StoreScene'
import { installQualityGovernor } from './view/quality'
import { applyPageChrome, getTheme } from './view/theme'
import { attachStage, prepareStage } from './view3d/stage'

// PWA updates: 'prompt' mode (vite.config) surfaces a visible "new version — refresh" toast the
// player taps, instead of a silent update that lands a launch late. Progress lives in localStorage,
// which the refresh never touches, so updating can't lose a game.
//
// ⚠️ STALE-BUILD TRAP (found + reproduced 2026-07-25, both live and against `vite preview`):
// `onNeedRefresh` only fires when a worker enters the WAITING state during THIS page's lifetime.
// If the new worker finished installing on an earlier visit that the player closed without tapping
// Refresh, it is already waiting at load — no event, no toast, and the player is pinned to the old
// build FOREVER (every later visit repeats the same silent no-op). Observed exactly that: a live
// registration reporting `waiting: true` with no toast, serving the previous bundle indefinitely.
// So we also probe for an already-waiting worker at registration time, below.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    showUpdateToast(applyUpdate)
  },
  onRegisteredSW(_swUrl, registration) {
    // The missed case above: a worker that was ALREADY waiting before this page even loaded.
    if (registration?.waiting) showUpdateToast(applyUpdate)
  },
})

/**
 * Apply a waiting service worker and reload into it.
 *
 * Drives the waiting worker DIRECTLY (`SKIP_WAITING` → `controllerchange` → reload) rather than
 * relying on `updateSW(true)`, because the plugin helper was observed dismissing the toast without
 * ever activating the worker — leaving no prompt and no update. Messaging the registration's own
 * `waiting` instance is the path that was verified to work. `updateSW(true)` stays as the fallback
 * for the case where nothing is waiting yet.
 */
async function applyUpdate(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration?.waiting) {
      // Reload the moment the new worker takes control, so the next paint is the new build.
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
        once: true,
      })
      registration.waiting.postMessage({ type: 'SKIP_WAITING' })
      return
    }
  } catch {
    // no SW support / registration lookup blocked — fall through to the plugin helper
  }
  void updateSW(true)
}

// PWA install funnel (install_shown → install_accepted). Registered at module scope because
// `beforeinstallprompt` fires within moments of load — anything sequenced behind the cloud
// bootstrap below would miss it. Firing before initAnalytics() is fine and deliberate: track()
// mints the session id, and initAnalytics uses `??=` so the event keeps the session it opened,
// exactly as the update toast already does.
//
// ⚠️ BOTH LISTENERS ARE PASSIVE — do NOT call preventDefault() on beforeinstallprompt here. That
// suppresses the browser's own install affordance, and with no in-game install button to replace
// it, capturing the prompt would delete the very thing this funnel exists to measure. Measuring a
// UI must not become changing it.
//
// ⚠️ CHROMIUM ONLY, and that shapes how the funnel reads. Safari fires neither event, so on iOS —
// where installing is a manual Share → "Add to Home Screen" gesture — this funnel is blind, and its
// counts are a floor, never a total. `install_accepted` can also EXCEED `install_shown`, because
// appinstalled fires for an install started from the browser's own menu on a visit where the prompt
// never surfaced. The cross-platform answer to "does installing predict retention" is app_open's
// `standalone` prop (core/analytics.ts), which every client reports on every open; this pair is the
// narrower question of whether players who are offered the install take it.
window.addEventListener('beforeinstallprompt', () => track(EVENTS.INSTALL_SHOWN))
// Ground truth: the install actually completed. It fires in the page the player installed FROM, so
// it carries the same device_id as the install_shown that preceded it.
window.addEventListener('appinstalled', () => track(EVENTS.INSTALL_ACCEPTED))

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
// Seed the top safe-area inset too, so the very first scene anchors its content the right distance below
// the notch / Dynamic Island instead of flashing centred then jumping. See config.contentOffsetY.
pushSafeTop(window.innerWidth)

// Reconcile with the cloud BEFORE the first scene reads the save (bounded so a slow/offline network
// can never stall boot), THEN start Phaser. Resolves instantly when cloud is unconfigured / signed out.
// The 3D stage (view3d/stage.ts) prepares in parallel: it feature-detects WebGL2, dynamically imports
// its own precached three.js chunk and stands the renderer up — or resolves inactive, in which case
// background.ts paints the 2D backdrop exactly as before. Deciding BEFORE boot keeps every scene's
// create() a simple synchronous branch (no mid-scene "the room just arrived" repaint case).
void Promise.all([bootstrapCloud(), prepareStage()]).then(() => {
  // Analytics starts AFTER the cloud bootstrap so app_open already carries the restored session's
  // user id — starting it earlier would file every returning signed-in player's first event as
  // anonymous and understate the signed-in cohort in exactly the funnel it exists to measure.
  // Dormant (no-op) when VITE_SUPABASE_* isn't configured, like every other network path here.
  initAnalytics(cloudUserId, cloudAccessToken)
  warmRaceBoard()
  // ⚠️ AND AGAIN ON EVERY RESUME — the boot call alone is not enough.
  //
  // A phone keeps this app alive in the background for days, so a session can easily still be the
  // one that opened yesterday. `warmRaceBoard` reads `dayKey()` at call time, but nothing was
  // re-reading it: a run started after the midnight handover (00:00 RACE_TZ — 1 AM Central) found no
  // salt cached for the NEW day, fell back to the unsalted board, and had its score silently refused
  // by the guard. Silent, because `maybeSubmitEndless` swallows submit errors — the player would just
  // never appear on the board.
  //
  // `visibilitychange` is the right hook rather than a timer: the handover matters exactly when
  // someone picks the phone up to play, and a resume is precisely that moment. Cheap to over-call —
  // `ensureSalt` returns the cache on a hit and the board pick is memoised, so a same-day resume
  // does no work at all.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) warmRaceBoard()
  })
  startGame()
})

/**
 * Warm the current race day's board so GameScene's synchronous build finds it cached.
 *
 * Two steps, in order. The SALT (core/racesalt.ts) decides which board today is and cannot be known
 * before the day opens; the board PICK (core/boardpick.ts) then runs up to two dozen 30-move
 * simulations to choose a board inside the quality band — cheap once, and very noticeable if it
 * lands on a scene transition instead.
 *
 * Fire-and-forget by design: this must never be able to delay boot, and GameScene recomputes
 * synchronously if it somehow has to. Both halves no-op entirely before SALT_ACTIVE_FROM.
 */
function warmRaceBoard(): void {
  const day = dayKey()
  void ensureSalt(day).then(salt => {
    endlessBoardRng(day, salt)
  })
}

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
    backgroundColor: '#fff9ec',
    disableContextMenu: true,
    render: { antialias: true },
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: [BootScene, HomeScene, LevelSelectScene, StoreScene, SlotScene, GameScene],
  })

  // Stand the 3D room up on Phaser's OWN canvas + WebGL context (view3d/stage.ts): its sim ticks off
  // POST_STEP and its draw runs inside each scene's display list via an Extern hook, so it sleeps
  // with the game loop when the tab hides — the same anti-drain guarantee as everything else. No-op
  // when three didn't load (Save-Data / import failure) or Phaser fell back to the Canvas renderer;
  // the 2D backdrop then paints exactly as before.
  attachStage(game)

  // Keep the flexible world height matched to the live viewport aspect: on a real resize / orientation
  // change, recompute worldH and (only if it changed) resize the game + re-centre every live scene's
  // camera on the design box. Guarded so the setGameSize-triggered refresh doesn't recurse (worldH is
  // then stable → updateWorldH returns false). Stock Phaser FIT keeps the canvas backing + viewport
  // correct through this automatically.
  game.scale.on(Phaser.Scale.Events.RESIZE, () => {
    const parent = game.scale.parentSize
    // Re-read both the world height AND the top safe-area inset (either can shift on an orientation
    // change / URL-bar resize). Re-centre every live scene's camera if EITHER changed.
    const insetChanged = pushSafeTop(parent.width)
    const sizeChanged = updateWorldH(parent.width, parent.height)
    if (!insetChanged && !sizeChanged) return
    if (sizeChanged) game.scale.setGameSize(DESIGN_W, worldH())
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
 * Read the top safe-area inset (env(safe-area-inset-top)) in CSS px from #safeprobe and feed it to the
 * layout (config.setSafeTopInset), so a tall phone anchors content a comfortable gap below the notch /
 * Dynamic Island. `appWidthPx` is the CSS width the 720-wide design maps onto (portrait insets are 0, so
 * innerWidth / parentSize.width are exact). DEV `?sat=<px>` forces a value so headless checks can drive
 * the notch / Dynamic Island / no-notch cases (desktop Chromium always reports a 0 inset). Returns true
 * when the world-space inset changed.
 */
function pushSafeTop(appWidthPx: number): boolean {
  const dev = import.meta.env.DEV ? new URLSearchParams(location.search).get('sat') : null
  const px =
    dev != null && Number.isFinite(Number(dev))
      ? Math.max(0, Number(dev))
      : (document.getElementById('safeprobe')?.getBoundingClientRect().height ?? 0)
  return setSafeTopInset(px, appWidthPx)
}

/**
 * A small warm "new version available" banner (bottom, above the safe-area) with a Refresh button
 * that applies the waiting service worker + reloads. Pure DOM so it works before any scene is up;
 * guarded against duplicates. Progress is in localStorage, so the reload is always safe.
 */
function showUpdateToast(onRefresh: () => void): void {
  if (document.getElementById('vm-update-toast')) return
  // Shown-vs-applied is the measurement of the stale-build trap documented above: a wide gap means
  // players are seeing the prompt and not taking it, which pins them to an old bundle.
  track(EVENTS.UPDATE_SHOWN)
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
    track(EVENTS.UPDATE_APPLIED)
    onRefresh()
  }
  bar.append(label, btn)
  document.body.appendChild(bar)
}

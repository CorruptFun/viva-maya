import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_H, DESIGN_W } from './config'
import { BootScene } from './scenes/BootScene'
import { DailyBonusScene } from './scenes/DailyBonusScene'
import { GameScene } from './scenes/GameScene'
import { HomeScene } from './scenes/HomeScene'
import { LevelSelectScene } from './scenes/LevelSelectScene'
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
  scene: [BootScene, HomeScene, LevelSelectScene, DailyBonusScene, GameScene],
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

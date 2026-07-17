import Phaser from 'phaser'
import { registerSW } from 'virtual:pwa-register'
import { DESIGN_H, DESIGN_W } from './config'
import { BootScene } from './scenes/BootScene'
import { GameScene } from './scenes/GameScene'
import { LevelSelectScene } from './scenes/LevelSelectScene'

registerSW({ immediate: true })

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

new Phaser.Game({
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
  scene: [BootScene, LevelSelectScene, GameScene],
})

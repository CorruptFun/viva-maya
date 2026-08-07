import Phaser from 'phaser'
import { createAllTextures, warmPieceTextures } from '../view/textures'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  create(): void {
    createAllTextures(this)
    // Front-load the special-piece overlays + cascade particles the first deal-in would bake lazily,
    // so a cold PWA's opening cascade never hitches (BT2). Generate-once guarded — a few ms, no
    // visible boot change (BootScene stays hard/instant).
    warmPieceTextures(this)
    // DEV shortcuts: ?level=N jumps into a level, ?endless=1 into the weekly race, ?lightninground=1
    // into the ⚡ storm (automated checks). Lightning is tested FIRST because it also sets `endless`
    // inside GameScene.init — routing on `endless` first would drop the mode and open the race.
    const params = new URLSearchParams(location.search)
    const level = import.meta.env.DEV && params.has('level') ? Number(params.get('level')) : null
    if (import.meta.env.DEV && params.has('lightninground')) this.scene.start('game', { lightning: true })
    else if (import.meta.env.DEV && params.has('endless')) this.scene.start('game', { endless: true })
    else if (level && Number.isFinite(level)) this.scene.start('game', { level })
    else if (import.meta.env.DEV && params.get('scene')) this.scene.start(params.get('scene')!)
    else this.scene.start('home')
  }
}

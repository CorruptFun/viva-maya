import Phaser from 'phaser'
import { createAllTextures } from '../view/textures'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  create(): void {
    createAllTextures(this)
    // DEV shortcut: ?level=N jumps straight into a level (used by automated checks).
    const params = new URLSearchParams(location.search)
    const level = import.meta.env.DEV && params.has('level') ? Number(params.get('level')) : null
    if (level && Number.isFinite(level)) this.scene.start('game', { level })
    else this.scene.start('levelselect')
  }
}

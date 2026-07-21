import Phaser from 'phaser'
import { createAllTextures } from '../view/textures'

export class BootScene extends Phaser.Scene {
  constructor() {
    super('boot')
  }

  preload(): void {
    // Load high-quality 1:1 transparent PNG assets for Telegram custom stickers
    this.load.image('cherry_asset', 'assets/cherry.png')
    this.load.image('seven_asset', 'assets/seven.png')
    this.load.image('diamond_asset', 'assets/diamond.png')
    this.load.image('bell_asset', 'assets/bell.png')
    this.load.image('clover_asset', 'assets/clover.png')
    this.load.image('bar_asset', 'assets/bar.png')
  }

  create(): void {
    createAllTextures(this)
    // DEV shortcuts: ?level=N jumps into a level, ?endless=1 into the weekly race (automated checks).
    const params = new URLSearchParams(location.search)
    const level = import.meta.env.DEV && params.has('level') ? Number(params.get('level')) : null
    if (import.meta.env.DEV && params.has('endless')) this.scene.start('game', { endless: true })
    else if (level && Number.isFinite(level)) this.scene.start('game', { level })
    else if (import.meta.env.DEV && params.get('scene')) this.scene.start(params.get('scene')!)
    else this.scene.start('home')
  }
}

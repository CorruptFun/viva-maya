import Phaser from 'phaser'
import { DESIGN_W } from '../config'
import { LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { FONT, addMarquee } from '../view/ui'

const GRID_COLS = 5
const CHIP = 108
const GAP = 18

export class LevelSelectScene extends Phaser.Scene {
  constructor() {
    super('levelselect')
  }

  create(): void {
    const save = loadSave()
    addMarquee(this, DESIGN_W / 2, 96)

    const gridW = GRID_COLS * CHIP + (GRID_COLS - 1) * GAP
    const startX = (DESIGN_W - gridW) / 2
    const startY = 210

    for (let n = 1; n <= LEVEL_COUNT; n++) {
      const row = Math.floor((n - 1) / GRID_COLS)
      const col = (n - 1) % GRID_COLS
      const cx = startX + col * (CHIP + GAP) + CHIP / 2
      const cy = startY + row * (CHIP + GAP) + CHIP / 2
      this.addChip(n, cx, cy, save.unlocked, save.stars[n] ?? 0)
    }

    this.add
      .text(DESIGN_W / 2, 1030, `BEST  ${save.best.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: '#c9930a',
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
    this.add
      .text(DESIGN_W / 2, 1076, 'Collect the goal symbols before moves run out', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
        color: '#9a927e',
      })
      .setOrigin(0.5)
    const dedication = this.add
      .text(DESIGN_W / 2, 1126, 'made with ♥ for Maya', {
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: '24px',
        fontStyle: 'italic',
        color: '#d3304f',
      })
      .setOrigin(0.5)
      .setAlpha(0.85)
    this.tweens.add({ targets: dedication, alpha: 1, duration: 900, yoyo: true, repeat: -1 })
  }

  private addChip(n: number, cx: number, cy: number, unlocked: number, stars: number): void {
    const playable = n <= unlocked
    const current = n === unlocked
    const container = this.add.container(cx, cy)
    const g = this.add.graphics()
    if (playable) {
      g.fillStyle(0x8a7a52, 0.12)
      g.fillRoundedRect(-CHIP / 2 + 2, -CHIP / 2 + 5, CHIP, CHIP, 20)
      g.fillStyle(0xffffff, 1)
      g.fillRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
      g.lineStyle(current ? 4 : 2, current ? 0xf2b234 : 0xe8dfc9, 1)
      g.strokeRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
    } else {
      g.fillStyle(0xefe8da, 1)
      g.fillRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
    }
    container.add(g)

    if (playable) {
      const hasStars = stars > 0
      container.add(
        this.add
          .text(0, hasStars ? -14 : 0, String(n), {
            fontFamily: FONT,
            fontSize: '40px',
            fontStyle: '900',
            color: current ? '#c9930a' : '#2a2732',
          })
          .setOrigin(0.5)
      )
      for (let i = 0; i < stars; i++) {
        const star = this.add.image((i - (stars - 1) / 2) * 30, 30, 'star')
        star.setDisplaySize(26, 26)
        container.add(star)
      }
      const zone = this.add.rectangle(0, 0, CHIP, CHIP, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
      zone.on('pointerdown', () => container.setScale(0.94))
      zone.on('pointerout', () => container.setScale(1))
      zone.on('pointerup', () => this.scene.start('game', { level: n }))
      container.add(zone)
      if (current) {
        this.tweens.add({
          targets: container,
          scale: 1.06,
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        })
      }
    } else {
      const lock = this.add.image(0, 0, 'lock').setAlpha(0.55)
      lock.setDisplaySize(36, 36)
      container.add(lock)
    }
  }
}

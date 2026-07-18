import Phaser from 'phaser'
import { DESIGN_W } from '../config'
import { spinAvailable } from '../core/daily'
import { endlessBestThisWeek, endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import { FONT, GHOST_PILL, GOLD_PILL, ROSE_PILL, addMarquee, addPillButton, addStreakBadge } from '../view/ui'

export class HomeScene extends Phaser.Scene {
  constructor() {
    super('home')
  }

  create(): void {
    const save = loadSave()
    const currentLevel = Math.min(save.unlocked, LEVEL_COUNT)

    addCasinoBackdrop(this, 'home')

    // Daily-spin streak flame — a warm "welcome back" hook up top (hidden at streak 0).
    addStreakBadge(this, DESIGN_W / 2, 150, save.streak)

    // Big heart emblem with a heartbeat pulse.
    const heart = this.add.image(DESIGN_W / 2, 300, 'heart')
    heart.setDisplaySize(190, 190)
    const base = heart.scaleX
    this.tweens.add({
      targets: heart,
      scale: base * 1.09,
      duration: 620,
      yoyo: true,
      repeat: -1,
      repeatDelay: 340,
      ease: 'Sine.easeInOut',
    })
    // A couple of tiny satellites to make the emblem feel alive.
    for (const [dx, dy, size, delay] of [
      [-130, -60, 30, 0],
      [138, -30, 24, 500],
      [110, 84, 20, 900],
    ]) {
      const mini = this.add.image(DESIGN_W / 2 + dx, 300 + dy, 'heart').setAlpha(0.5)
      mini.setDisplaySize(size, size)
      this.tweens.add({
        targets: mini,
        y: 300 + dy - 14,
        alpha: 0.25,
        duration: 1600,
        delay,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }

    addMarquee(this, DESIGN_W / 2, 500)
    this.add
      .text(DESIGN_W / 2, 560, 'cascades  ·  power-ups  ·  jackpots', {
        fontFamily: FONT,
        fontSize: '24px',
        color: '#9a927e',
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)

    const play = addPillButton(this, DESIGN_W / 2, 720, 340, 96, 'PLAY', GOLD_PILL, () =>
      this.scene.start('game', { level: currentLevel })
    )
    this.tweens.add({
      targets: play,
      scale: 1.04,
      duration: 800,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
    const sub =
      save.best > 0
        ? `Level ${currentLevel}  ·  best ${save.best.toLocaleString()}`
        : `Level ${currentLevel}  ·  swipe to match 3`
    this.add
      .text(DESIGN_W / 2, 790, sub, { fontFamily: FONT, fontSize: '22px', color: '#9a927e' })
      .setOrigin(0.5)

    addPillButton(this, DESIGN_W / 2, 872, 280, 64, 'LEVELS', GHOST_PILL, () =>
      this.scene.start('levelselect')
    )

    // Daily bonus entry: glowing when the spin is ready, quiet when claimed.
    // NOTE: no emoji in pill labels — addPillButton's letterSpacing splits
    // surrogate pairs in Phaser's glyph renderer (renders tofu).
    const ready = spinAvailable(save)
    const label = ready ? 'DAILY BONUS' : `SPUN · DAY ${Math.max(1, save.streak)}`
    const daily = addPillButton(this, DESIGN_W / 2, 986, 340, 76, label, ready ? GOLD_PILL : GHOST_PILL, () =>
      this.scene.start('daily')
    )
    if (ready) {
      this.tweens.add({ targets: daily, scale: 1.05, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    if (save.pendingBoosts.length > 0) {
      this.add
        .text(DESIGN_W / 2, 1044, `🎁 boost ready for your next level`, { fontFamily: FONT, fontSize: '20px', color: '#c9930a' })
        .setOrigin(0.5)
    }

    // Endless weekly race — unlocks once the last numbered level is cleared.
    if (endlessUnlocked(save, LEVEL_COUNT)) {
      const wkBest = endlessBestThisWeek(save)
      addPillButton(this, DESIGN_W / 2, 1108, 340, 72, 'ENDLESS', ROSE_PILL, () =>
        this.scene.start('game', { endless: true })
      )
      this.add
        .text(
          DESIGN_W / 2,
          1158,
          wkBest > 0 ? `this week's board  ·  best ${wkBest.toLocaleString()}` : `new weekly board  ·  set the pace`,
          { fontFamily: FONT, fontSize: '20px', color: '#9a927e' }
        )
        .setOrigin(0.5)
    }
  }
}

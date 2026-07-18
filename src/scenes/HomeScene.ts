import Phaser from 'phaser'
import { DESIGN_W } from '../config'
import { spinAvailable } from '../core/daily'
import { endlessBestThisWeek, endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { refreshLives } from '../core/lives'
import { loadSave } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import {
  FONT,
  GHOST_PILL,
  GOLD_PILL,
  ROSE_PILL,
  addChipPill,
  addHelpChip,
  addLivesHud,
  addMarquee,
  addPillButton,
  addSoundChip,
  addStreakBadge,
  openHelpPanel,
  openSoundPanel,
} from '../view/ui'

export class HomeScene extends Phaser.Scene {
  constructor() {
    super('home')
  }

  create(): void {
    const save = loadSave()
    const currentLevel = Math.min(save.unlocked, LEVEL_COUNT)
    const reduced = this.prefersReducedMotion()
    // Stacked pill buttons that fade + slide up into place on entrance (see below).
    const menuButtons: Phaser.GameObjects.Container[] = []

    addCasinoBackdrop(this, 'home')

    // How-to-play / FAQ, tucked in the top-left corner.
    addHelpChip(this, 60, 44)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('help')) openHelpPanel(this)

    // Move-sound picker, mirrored in the top-right corner.
    addSoundChip(this, 676, 44)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('sound')) openSoundPanel(this)

    // Persistent chip balance (earned reward token) — top-center, between the ? and ♪ corner
    // chips and above the lives pool. A read-out only; chips are never spent in Phase 1.
    addChipPill(this, DESIGN_W / 2, 44)

    // Top status: lives pool (with a live "next life" countdown) above the streak flame.
    const livesHud = addLivesHud(this, DESIGN_W / 2, 100, { size: 32 })
    const refreshLivesHud = (): void => livesHud.update(refreshLives())
    refreshLivesHud()
    this.time.addEvent({ delay: 1000, loop: true, callback: refreshLivesHud })
    // Daily-spin streak flame — hidden at streak 0.
    addStreakBadge(this, DESIGN_W / 2, 176, save.streak)

    // Big heart emblem with a heartbeat pulse.
    const emblemY = 330
    const heart = this.add.image(DESIGN_W / 2, emblemY, 'heart')
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
      const mini = this.add.image(DESIGN_W / 2 + dx, emblemY + dy, 'heart').setAlpha(0.5)
      mini.setDisplaySize(size, size)
      this.tweens.add({
        targets: mini,
        y: emblemY + dy - 14,
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

    // Soft gold halo behind PLAY — rendered underneath the button, breathing in
    // time with its scale pulse. Uses the runtime 'bgglow' texture from the backdrop.
    const glow = this.add.image(DESIGN_W / 2, 720, 'bgglow')
    glow.setTint(0xf2b234).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(460, 240)
    const glowSX = glow.scaleX
    const glowSY = glow.scaleY
    glow.setAlpha(reduced ? 0.28 : 0)
    if (!reduced) {
      // Fade in alongside PLAY, then keep breathing between ~0.22 and ~0.4.
      this.tweens.add({
        targets: glow,
        alpha: 0.22,
        duration: 260,
        ease: 'Sine.easeOut',
        onComplete: () => {
          this.tweens.add({
            targets: glow,
            alpha: 0.4,
            scaleX: glowSX * 1.04,
            scaleY: glowSY * 1.04,
            duration: 1400,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          })
        },
      })
    }

    const play = addPillButton(this, DESIGN_W / 2, 720, 340, 96, 'PLAY', GOLD_PILL, () =>
      this.scene.start('game', { level: currentLevel })
    )
    menuButtons.push(play)
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

    const levels = addPillButton(this, DESIGN_W / 2, 872, 280, 64, 'LEVELS', GHOST_PILL, () =>
      this.scene.start('levelselect')
    )
    menuButtons.push(levels)

    // Daily bonus entry: glowing when the spin is ready, quiet when claimed.
    // NOTE: no emoji in pill labels — addPillButton's letterSpacing splits
    // surrogate pairs in Phaser's glyph renderer (renders tofu).
    const ready = spinAvailable(save)
    const label = ready ? 'DAILY BONUS' : `SPUN · DAY ${Math.max(1, save.streak)}`
    const daily = addPillButton(this, DESIGN_W / 2, 986, 340, 76, label, ready ? GOLD_PILL : GHOST_PILL, () =>
      this.scene.start('daily')
    )
    menuButtons.push(daily)
    if (ready) {
      this.tweens.add({ targets: daily, scale: 1.05, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    if (save.pendingBoosts.length > 0) {
      this.add
        .text(DESIGN_W / 2, 1044, `🎁 boost ready for your next level`, { fontFamily: FONT, fontSize: '20px', color: '#c9930a' })
        .setOrigin(0.5)
    }

    // Endless weekly race — unlocks after level 30.
    if (endlessUnlocked(save)) {
      const wkBest = endlessBestThisWeek(save)
      const endless = addPillButton(this, DESIGN_W / 2, 1108, 340, 72, 'ENDLESS', ROSE_PILL, () =>
        this.scene.start('game', { endless: true })
      )
      menuButtons.push(endless)
      this.add
        .text(
          DESIGN_W / 2,
          1158,
          wkBest > 0 ? `this week's board  ·  best ${wkBest.toLocaleString()}` : `new weekly board  ·  set the pace`,
          { fontFamily: FONT, fontSize: '20px', color: '#9a927e' }
        )
        .setOrigin(0.5)
    }

    // Entrance stagger: the stacked pill buttons fade + slide up 12px into place,
    // ~60ms apart (PLAY, LEVELS, DAILY, ENDLESS). The scale pulses on PLAY/DAILY
    // tween a different property, so they coexist with these y/alpha tweens.
    // Reduced motion keeps every button in its final alpha=1 / final-y resting state.
    if (!reduced) {
      menuButtons.forEach((btn, i) => {
        const finalY = btn.y
        btn.setAlpha(0)
        btn.y = finalY + 12
        this.tweens.add({
          targets: btn,
          y: finalY,
          alpha: 1,
          duration: 260,
          delay: i * 60,
          ease: 'Back.easeOut',
        })
      })
    }
  }

  private prefersReducedMotion(): boolean {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  }
}

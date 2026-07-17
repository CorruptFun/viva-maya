import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W } from '../config'
import { performSpin, spinAvailable, todayKey } from '../core/daily'
import { mulberry32 } from '../core/rng'
import { loadSave } from '../core/save'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { ensurePieceTexture } from '../view/textures'
import { FONT, GHOST_PILL, GOLD_PILL, addPillButton } from '../view/ui'

const REEL_W = 150
const REEL_H = 210
const STRIP_LEN = 14

/**
 * The daily bonus: a 3-reel slot machine that ALWAYS lands the prize
 * (three-of-a-kind). Prize + streak are computed and persisted BEFORE the
 * animation runs, so the celebration is pure presentation.
 */
export class DailyBonusScene extends Phaser.Scene {
  private spinning = false

  constructor() {
    super('daily')
  }

  private prizeTexture(kind: string): string {
    const asPiece = (symbol: (typeof SYMBOLS)[number], k: PieceKind): Piece => ({ id: -1, symbol, kind: k })
    switch (kind) {
      case 'wildReel':
        return ensurePieceTexture(this, asPiece('seven', 'wildReelRow'))
      case 'diceBomb':
        return ensurePieceTexture(this, asPiece('bell', 'diceBomb'))
      case 'jackpot':
        return 'jackpot'
      case 'extraMoves':
        return 'clover'
      default:
        return 'diamond'
    }
  }

  create(): void {
    addCasinoBackdrop(this, 'home')
    const save = loadSave()
    const params = new URLSearchParams(location.search)
    const forced = import.meta.env.DEV && params.has('spin')
    const available = spinAvailable(save) || forced
    if (import.meta.env.DEV) {
      const turbo = Number(params.get('turbo'))
      if (turbo > 0) {
        this.tweens.timeScale = turbo
        this.time.timeScale = turbo
      }
    }

    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => {
      if (!this.spinning) this.scene.start('home')
    })
    this.add
      .text(DESIGN_W / 2, 130, 'DAILY BONUS', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: '#ffffff' })
      .setOrigin(0.5)
      .setLetterSpacing(4)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
      .setTint(0xffd75e, 0xffd75e, 0xc9930a, 0xc9930a)
    const streakText = this.add
      .text(DESIGN_W / 2, 186, save.streak > 0 ? `🔥 day ${save.streak}` : 'one free spin, every day', {
        fontFamily: FONT,
        fontSize: '26px',
        color: '#9a927e',
      })
      .setOrigin(0.5)

    // Machine cabinet.
    const g = this.add.graphics()
    const cabW = 560
    const cabH = 340
    const cabX = (DESIGN_W - cabW) / 2
    const cabY = 280
    g.fillStyle(0x8a7a52, 0.14)
    g.fillRoundedRect(cabX + 4, cabY + 8, cabW, cabH, 30)
    g.fillStyle(0xfffdf8, 1)
    g.fillRoundedRect(cabX, cabY, cabW, cabH, 30)
    g.lineStyle(3, 0xf2c14e, 0.9)
    g.strokeRoundedRect(cabX, cabY, cabW, cabH, 30)
    const slotGap = (cabW - 3 * REEL_W) / 4
    const windows: { x: number; y: number }[] = []
    for (let i = 0; i < 3; i++) {
      const wx = cabX + slotGap + i * (REEL_W + slotGap)
      const wy = cabY + (cabH - REEL_H) / 2
      windows.push({ x: wx, y: wy })
      g.fillStyle(0xf3ece0, 1)
      g.fillRoundedRect(wx, wy, REEL_W, REEL_H, 18)
      g.lineStyle(2, 0xe8dfc9, 1)
      g.strokeRoundedRect(wx, wy, REEL_W, REEL_H, 18)
    }

    if (!available) {
      this.add
        .text(DESIGN_W / 2, 720, '⏳  come back tomorrow', { fontFamily: FONT, fontSize: '30px', color: '#9a927e' })
        .setOrigin(0.5)
      for (const w of windows) {
        this.add.image(w.x + REEL_W / 2, w.y + REEL_H / 2, SYMBOLS[Math.floor(Math.random() * 6)]).setDisplaySize(96, 96).setAlpha(0.5)
      }
      addPillButton(this, DESIGN_W / 2, 830, 280, 72, 'HOME', GOLD_PILL, () => this.scene.start('home'))
      return
    }

    // Idle reels before the spin.
    const idle: Phaser.GameObjects.Image[] = windows.map(w =>
      this.add.image(w.x + REEL_W / 2, w.y + REEL_H / 2, SYMBOLS[Math.floor(Math.random() * 6)]).setDisplaySize(96, 96)
    )

    const doSpin = () => {
      if (this.spinning) return
      this.spinning = true
      spinBtn.setVisible(false)
      // Award first, animate second — closing mid-spin can't lose the prize.
      const result = performSpin(loadSave(), mulberry32((Math.random() * 2 ** 31) | 0))
      streakText.setText(`🔥 day ${result.streak}`)
      idle.forEach(img => img.destroy())
      this.runReels(windows, result.prizes.map(p => p.type), () =>
        this.celebrate(result.prizes.map(p => p.label), result.prizes.map(p => p.blurb))
      )
    }
    const spinBtn = addPillButton(this, DESIGN_W / 2, 740, 300, 92, 'SPIN', GOLD_PILL, doSpin)
    this.tweens.add({ targets: spinBtn, scale: 1.05, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    if (import.meta.env.DEV && params.has('autospin')) this.time.delayedCall(300, doSpin)
  }

  /** Scroll each reel through a strip of symbols and settle on the prize texture. */
  private runReels(windows: { x: number; y: number }[], prizeKinds: string[], onDone: () => void): void {
    const prizeTex = this.prizeTexture(prizeKinds[0])
    let settled = 0
    windows.forEach((w, i) => {
      const maskG = this.make.graphics({ x: 0, y: 0 }, false)
      maskG.fillStyle(0xffffff)
      maskG.fillRect(w.x, w.y, REEL_W, REEL_H)
      const strip = this.add.container(w.x + REEL_W / 2, w.y + REEL_H / 2)
      strip.setMask(maskG.createGeometryMask())
      for (let s = 0; s < STRIP_LEN; s++) {
        const tex = s === STRIP_LEN - 1 ? prizeTex : SYMBOLS[Math.floor(Math.random() * 6)]
        const img = this.add.image(0, -s * REEL_H, tex).setDisplaySize(96, 96)
        strip.add(img)
      }
      sfx.reelSweep()
      this.tweens.add({
        targets: strip,
        y: strip.y + (STRIP_LEN - 1) * REEL_H,
        duration: 900 + i * 380,
        ease: 'Cubic.easeOut',
        onComplete: () => {
          sfx.invalidThud()
          this.cameras.main.shake(60, 0.004)
          settled++
          if (settled === windows.length) onDone()
        },
      })
    })
  }

  private celebrate(labels: string[], blurbs: string[]): void {
    sfx.winFanfare()
    if (labels.includes('JACKPOT CHIP')) sfx.jackpotStrike()
    const hearts = this.add
      .particles(0, 0, 'heart', {
        speed: { min: 140, max: 420 },
        angle: { min: 220, max: 320 },
        scale: { start: 0.5, end: 0.12 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 700, max: 1300 },
        gravityY: 500,
        rotate: { min: -120, max: 120 },
        emitting: false,
      })
      .setDepth(45)
    hearts.explode(24, DESIGN_W / 2, 300)
    this.time.delayedCall(1600, () => hearts.destroy())

    const title = this.add
      .text(DESIGN_W / 2, 700, labels.join('  +  '), {
        fontFamily: FONT,
        fontSize: labels.length > 1 ? '34px' : '44px',
        fontStyle: '900',
        color: '#c9930a',
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
      .setScale(0)
    this.tweens.add({ targets: title, scale: 1, duration: 300, ease: 'Back.easeOut' })
    this.add
      .text(DESIGN_W / 2, 760, blurbs.join('\n'), { fontFamily: FONT, fontSize: '22px', color: '#9a927e', align: 'center' })
      .setOrigin(0.5)
    addPillButton(this, DESIGN_W / 2, 880, 300, 80, 'CLAIM', GOLD_PILL, () => this.scene.start('home'))
    this.spinning = false
    this.add
      .text(DESIGN_W / 2, 960, `come back tomorrow — ${todayKey()} claimed`, { fontFamily: FONT, fontSize: '18px', color: '#b3ab97' })
      .setOrigin(0.5)
  }
}

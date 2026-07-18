import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W } from '../config'
import { performSpin, spinAvailable, todayKey } from '../core/daily'
import { occasionFor, pendingOccasion } from '../core/maya'
import { mulberry32 } from '../core/rng'
import { loadSave, markOccasionSeen } from '../core/save'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { getTheme, hapticsOff, prefersReducedMotion } from '../view/theme'
import { ensurePieceTexture } from '../view/textures'
import { FONT, GHOST_PILL, GOLD_PILL, addPillButton, startScene } from '../view/ui'

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
  /** §E4 guard — the Heartbloom (heart of light + Maya leitmotif) fires at most ONCE per claim. */
  private heartbloomFired = false

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
    this.heartbloomFired = false // §E4 — reset per scene entry (scene.start reuses the instance)
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    addCasinoBackdrop(this, 'home')
    const save = loadSave()
    const params = new URLSearchParams(location.search)
    const forced = import.meta.env.DEV && params.has('spin')
    const available = spinAvailable(save) || forced
    const reduced = this.prefersReducedMotion()
    const T = getTheme()
    if (import.meta.env.DEV) {
      const turbo = Number(params.get('turbo'))
      if (turbo > 0) {
        this.tweens.timeScale = turbo
        this.time.timeScale = turbo
      }
    }

    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => {
      if (!this.spinning) startScene(this,'home')
    })
    this.add
      .text(DESIGN_W / 2, 130, 'DAILY BONUS', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: '#ffffff' })
      .setOrigin(0.5)
      .setLetterSpacing(4)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
      .setTint(T.goldBright, T.goldBright, T.goldDeep, T.goldDeep)
    const streakText = this.add
      .text(DESIGN_W / 2, 186, save.streak > 0 ? `🔥 day ${save.streak}` : 'one free spin, every day', {
        fontFamily: FONT,
        fontSize: '26px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)

    // Machine cabinet.
    const g = this.add.graphics()
    const cabW = 560
    const cabH = 340
    const cabX = (DESIGN_W - cabW) / 2
    const cabY = 280
    g.fillStyle(T.shadow, 0.14)
    g.fillRoundedRect(cabX + 4, cabY + 8, cabW, cabH, 30)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(cabX, cabY, cabW, cabH, 30)
    g.lineStyle(3, T.goldBezel, 0.9)
    g.strokeRoundedRect(cabX, cabY, cabW, cabH, 30)
    const slotGap = (cabW - 3 * REEL_W) / 4
    const windows: { x: number; y: number }[] = []
    for (let i = 0; i < 3; i++) {
      const wx = cabX + slotGap + i * (REEL_W + slotGap)
      const wy = cabY + (cabH - REEL_H) / 2
      windows.push({ x: wx, y: wy })
      g.fillStyle(T.cardFillAlt, 1)
      g.fillRoundedRect(wx, wy, REEL_W, REEL_H, 18)
      g.lineStyle(2, T.border, 1)
      g.strokeRoundedRect(wx, wy, REEL_W, REEL_H, 18)
    }

    // Gold PAYLINE across the center row of the three reels (static art, always shows).
    const plLeft = windows[0].x - 6
    const plRight = windows[2].x + REEL_W + 6
    const plCenterY = windows[0].y + REEL_H / 2
    const plBand = 16
    g.fillStyle(T.gold, 0.08)
    g.fillRoundedRect(plLeft, plCenterY - plBand / 2, plRight - plLeft, plBand, plBand / 2)
    g.lineStyle(2.5, T.gold, 0.9)
    g.strokeRoundedRect(plLeft, plCenterY - plBand / 2, plRight - plLeft, plBand, plBand / 2)

    // Marquee bulbs framing the cabinet top & bottom edges.
    const bulbCols = 9
    for (const by of [cabY, cabY + cabH]) {
      for (let i = 0; i < bulbCols; i++) {
        const bx = cabX + (cabW * i) / (bulbCols - 1)
        const bulb = this.add
          .image(bx, by, 'bulb')
          .setDisplaySize(16, 16)
          .setTint(i % 2 === 0 ? T.gold : T.rose)
        if (reduced) {
          bulb.setAlpha(0.85)
        } else {
          bulb.setAlpha(0.5)
          this.tweens.add({
            targets: bulb,
            alpha: 1,
            duration: 650,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
            delay: (i % 5) * 200,
          })
        }
      }
    }

    // §E9 special-date dress-up (signature moment #5) — DORMANT unless an occasion is configured for
    // today. Dress the subtitle up with the occasion greeting, and once per day fire a heart-shower.
    const occToday = occasionFor(todayKey().slice(5))
    if (occToday) {
      streakText.setText(occToday.label)
      if (pendingOccasion(todayKey(), save.occasionsSeen)) {
        markOccasionSeen(todayKey())
        sfx.starDing(2)
        if (!reduced) {
          const hearts = this.add
            .particles(0, 0, 'heart', {
              speed: { min: 130, max: 400 },
              angle: { min: 220, max: 320 },
              scale: { start: 0.55, end: 0.14 },
              alpha: { start: 1, end: 0 },
              lifespan: { min: 800, max: 1500 },
              gravityY: 420,
              rotate: { min: -120, max: 120 },
              emitting: false,
            })
            .setDepth(45)
          hearts.explode(24, DESIGN_W / 2, 300)
          this.time.delayedCall(1700, () => hearts.destroy())
        }
      }
    }

    if (!available) {
      this.add
        .text(DESIGN_W / 2, 720, '⏳  come back tomorrow', { fontFamily: FONT, fontSize: '30px', color: T.onBackdropMuted })
        .setOrigin(0.5)
      for (const w of windows) {
        this.add.image(w.x + REEL_W / 2, w.y + REEL_H / 2, SYMBOLS[Math.floor(Math.random() * 6)]).setDisplaySize(96, 96).setAlpha(0.5)
      }
      addPillButton(this, DESIGN_W / 2, 830, 280, 72, 'HOME', GOLD_PILL, () => startScene(this,'home'))
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
    // SPIN breathe — gated (§E8): reduced motion leaves it at its resting scale.
    if (!reduced) {
      this.tweens.add({ targets: spinBtn, scale: 1.05, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    if (import.meta.env.DEV && params.has('autospin')) this.time.delayedCall(300, doSpin)
  }

  /** Scroll each reel through a strip of symbols and settle on the prize texture. */
  private runReels(windows: { x: number; y: number }[], prizeKinds: string[], onDone: () => void): void {
    const prizeTex = this.prizeTexture(prizeKinds[0])
    const reduced = this.prefersReducedMotion()
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
          // §E3/B14: a mechanical reel-landing clunk, panned by reel (left/centre/right) so the three
          // stops read across the stereo field. A light haptic partners each detent (a11y-gated).
          sfx.reelClunk((i - 1) * 0.6)
          if (!hapticsOff() && 'vibrate' in navigator) navigator.vibrate?.(12)
          // Reel-settle kick routed through the reduced-motion gate (§E8) — the sound still lands.
          if (!reduced) this.cameras.main.shake(60, 0.004)
          // Soft gold glow behind the settled winning symbol (separate object → not clipped by the reel mask).
          const glow = this.add
            .image(w.x + REEL_W / 2, w.y + REEL_H / 2, 'bgglow')
            .setTint(getTheme().goldBezel)
            .setBlendMode(Phaser.BlendModes.ADD)
            .setDisplaySize(150, 150)
            .setAlpha(reduced ? 0.3 : 0.16)
          if (!reduced) {
            this.tweens.add({
              targets: glow,
              alpha: 0.4,
              scale: glow.scale * 1.12,
              duration: 900,
              yoyo: true,
              repeat: -1,
              ease: 'Sine.easeInOut',
            })
          }
          settled++
          if (settled === windows.length) onDone()
        },
      })
    })
  }

  private celebrate(labels: string[], blurbs: string[]): void {
    // §E4 — the daily prize claim is one of the three Heartbloom beats. Layered UNDER the existing
    // fanfare/jackpot/hearts/sparks/confetti celebration; the Maya leitmotif rings only here + PERFECT/jackpot.
    this.heartbloom(DESIGN_W / 2, 450) // the cabinet's center, where the reels just settled
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

    // Prize-reveal spark burst + confetti rain (skipped under reduced motion).
    if (!this.prefersReducedMotion()) {
      const sparks: Phaser.GameObjects.Particles.ParticleEmitter = this.add
        .particles(0, 0, 'spark', {
          speed: { min: 150, max: 450 },
          angle: { min: 0, max: 360 },
          scale: { start: 0.5, end: 0 },
          alpha: { start: 0.95, end: 0 },
          lifespan: { min: 700, max: 1100 },
          gravityY: 120,
          tint: 0xf2b234,
          emitting: false,
        })
        .setDepth(46)
      sparks.explode(16, DESIGN_W / 2, 300)
      this.time.delayedCall(1600, () => sparks.destroy())

      const confetti: Phaser.GameObjects.Particles.ParticleEmitter = this.add
        .particles(0, 0, 'confetti', {
          x: { min: 200, max: 520 },
          y: 260,
          speed: { min: 40, max: 140 },
          angle: { min: 80, max: 100 },
          gravityY: 220,
          rotate: { min: -180, max: 180 },
          lifespan: 1400,
          tint: [0xf2b234, 0xd3304f, 0x26304d, 0xfffdf8],
          emitting: false,
        })
        .setDepth(44)
      confetti.explode(24)
      this.time.delayedCall(1600, () => confetti.destroy())
    }

    const title = this.add
      .text(DESIGN_W / 2, 700, labels.join('  +  '), {
        fontFamily: FONT,
        fontSize: labels.length > 1 ? '34px' : '44px',
        fontStyle: '900',
        color: getTheme().goldText,
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
      .setScale(0)
    this.tweens.add({ targets: title, scale: 1, duration: 300, ease: 'Back.easeOut' })
    this.add
      .text(DESIGN_W / 2, 760, blurbs.join('\n'), { fontFamily: FONT, fontSize: '22px', color: getTheme().onBackdropMuted, align: 'center' })
      .setOrigin(0.5)
    addPillButton(this, DESIGN_W / 2, 880, 300, 80, 'CLAIM', GOLD_PILL, () => startScene(this,'home'))
    this.spinning = false
    this.add
      .text(DESIGN_W / 2, 960, `come back tomorrow — ${todayKey()} claimed`, { fontFamily: FONT, fontSize: '18px', color: getTheme().inkFaint })
      .setOrigin(0.5)
  }

  /**
   * The HEARTBLOOM (§E4, signature moment #3) — the same ownable hero beat as a PERFECT game win, fired
   * on the daily prize claim. A giant translucent heart of light (`heartglow`, ADD, theme `bloom` tint)
   * blooms from the cabinet center, BEATS TWICE (lub-DUB) on a cadence inspired by Home's ~620/340
   * emblem heartbeat, and streams heart-particles up from its apex — under `sfx.mayaMotif()`, the 3-note
   * leitmotif heard NOWHERE else. Reduced motion: a single STATIC heart of light (no double-beat, no
   * stream) + the motif. One ADD sprite + a capped heart plume; self-guards to one fire per claim.
   */
  private heartbloom(cx: number, cy: number): void {
    if (this.heartbloomFired) return
    this.heartbloomFired = true
    sfx.mayaMotif() // the leitmotif rings in BOTH motion modes — audio is never "motion"
    const glow = this.add
      .image(cx, cy, 'heartglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(47) // above the cabinet/reels, beneath the CLAIM title (this scene has no higher layer)
      .setTint(getTheme().bloom)
      .setDisplaySize(520, 520)
    const base = glow.scaleX

    if (this.prefersReducedMotion()) {
      // Static heart of light: a single soft appear + hold + fade. No double-beat, no strobing, no stream.
      glow.setScale(base).setAlpha(0)
      this.tweens.add({
        targets: glow,
        alpha: 0.4,
        duration: 220,
        ease: 'Quad.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: glow, alpha: 0, delay: 300, duration: 340, onComplete: () => glow.destroy() }),
      })
      return
    }

    // Bloom open, then a lub-DUB doublet (two Back.easeOut swells), then relax + fade out.
    glow.setScale(base * 0.4).setAlpha(0)
    this.tweens.chain({
      targets: glow,
      tweens: [
        { scale: base, alpha: 0.5, duration: 230, ease: 'Back.easeOut' }, // bloom open
        { scale: base * 1.12, duration: 150, ease: 'Back.easeOut' }, // lub
        { scale: base * 0.99, duration: 90, ease: 'Sine.easeInOut' }, // brief diastole
        { scale: base * 1.2, alpha: 0.56, duration: 160, ease: 'Back.easeOut' }, // DUB (the bigger beat)
        { scale: base * 1.06, alpha: 0, delay: 40, duration: 320, ease: 'Quad.easeIn' }, // relax + fade
      ],
      onComplete: () => glow.destroy(),
    })

    // Heart-particles STREAM up from the bloom's apex — a short capped plume (~12 live) timed to the beat.
    const stream = this.add
      .particles(cx, cy - 150, 'heart', {
        speed: { min: 130, max: 300 },
        angle: { min: 250, max: 290 }, // a narrow upward plume (270 = straight up)
        scale: { start: 0.5, end: 0.12 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 600, max: 1000 },
        gravityY: 360,
        rotate: { min: -90, max: 90 },
        quantity: 1,
        frequency: 45, // ~12 emits over the 560ms window → capped live count
        emitting: true,
      })
      .setDepth(47)
    this.time.delayedCall(560, () => stream.active && stream.stop())
    this.time.delayedCall(1700, () => stream.active && stream.destroy())
  }

  /** Reduced-motion (OS query OR in-app override) — delegates to the shared theme authority (§E8). */
  private prefersReducedMotion(): boolean {
    return prefersReducedMotion()
  }
}

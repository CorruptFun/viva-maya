import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { performSpin, spinAvailable, todayKey } from '../core/daily'
import { occasionFor, pendingOccasion } from '../core/maya'
import { mulberry32 } from '../core/rng'
import { loadSave, markOccasionSeen } from '../core/save'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { OVERSHOOT, backOut } from '../view/motion'
import { getTheme, hapticsOff, prefersReducedMotion } from '../view/theme'
import { ensurePieceTexture } from '../view/textures'
import { FONT, GHOST_PILL, GOLD_PILL, addPillButton, startScene } from '../view/ui'

const REEL_W = 150
const REEL_H = 210
const STRIP_LEN = 14

/**
 * §D1 — absolute epoch-ms of the next daily rollover: LOCAL midnight, the exact boundary that
 * todayKey()/spinAvailable flip on (both read local Y-M-D). new Date(y, m, d + 1) normalises any
 * month/year wrap for us. Captured ONCE per scene entry so the countdown targets a FIXED instant
 * (the same fixed-target model the lives HUD counts down to), not a "tomorrow" that recedes each tick.
 */
function nextRolloverMs(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime()
}

/**
 * "H:MM:SS" remaining — core/lives' formatCountdown style (ceil to whole seconds, zero-padded)
 * widened to hours, since a wait for the next rollover can span most of a day and that helper only
 * renders M:SS. Clamped at 0 so it rests cleanly on "0:00:00".
 */
function formatDailyCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

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
    this.cameras.main.setScroll(0, restScrollY()) // centre the design box in the taller world
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
      // §D1 — a LIVE "next spin in H:MM:SS" countdown replaces the old static "come back tomorrow"
      // dead-end, giving the same return-hook clarity the lives HUD already gives. The target is the
      // next LOCAL-midnight rollover (fixed at entry), and one 1s timer repaints the remaining span.
      const rolloverAt = nextRolloverMs() // fixed target — matches todayKey()'s local-day boundary
      const countdown = this.add
        .text(DESIGN_W / 2, 720, '', { fontFamily: FONT, fontSize: '30px', color: T.onBackdropMuted })
        .setOrigin(0.5)
      const tick = (): void => {
        const remaining = rolloverAt - Date.now()
        countdown.setText(`next spin in  ${formatDailyCountdown(remaining)}`)
        // At/after rollover the spin unlocks — re-enter so create() re-evaluates spinAvailable and
        // shows the reels. The format already rests at "0:00:00", so a missed frame never crashes.
        if (remaining <= 0) this.scene.restart()
      }
      tick() // paint immediately — don't wait a second for the first label
      // One looping timer, created ONLY in this unavailable branch. Phaser auto-removes scene timers
      // on shutdown (incl. the restart above); the local ref never outlives the scene, so no leak.
      this.time.addEvent({ delay: 1000, loop: true, callback: tick })
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
        this.celebrate(result.prizes.map(p => p.label), result.prizes.map(p => p.blurb), result.streak)
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
    const last = windows.length - 1
    let settled = 0
    const finish = (): void => {
      settled++
      if (settled === windows.length) onDone()
    }
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
      const finalY = strip.y + (STRIP_LEN - 1) * REEL_H // exact payline lock — the result is fixed here
      const land = (): void => {
        this.landReel(w, i, reduced)
        finish()
      }

      // §E8/E15: reduced motion → instant, correct settle. No spin travel, no suspense wobble; the
      // clunk (audio is never "motion") still lands via landReel.
      if (reduced) {
        strip.y = finalY
        land()
        return
      }

      sfx.reelSweep()
      if (i === last) {
        // §E15 third-reel suspense — the classic slot dopamine beat, on the daily return hook: a
        // longer decel that dips just PAST the payline, then a small near-miss shimmy springs it up
        // into lock. The chain ENDS exactly on finalY, so the (pre-computed) result is unchanged.
        const over = REEL_H * 0.14
        this.tweens.chain({
          targets: strip,
          tweens: [
            { y: finalY + over, duration: 1500, ease: 'Cubic.easeOut' }, // long, suspenseful decel
            { y: finalY, duration: 300, ease: backOut(OVERSHOOT.pop) }, // shimmy up into the detent
          ],
          onComplete: land,
        })
      } else {
        this.tweens.add({
          targets: strip,
          y: finalY,
          duration: 900 + i * 380,
          ease: 'Cubic.easeOut',
          onComplete: land,
        })
      }
    })
  }

  /** The per-reel landing beat: panned clunk + haptic + settle-kick + a soft gold glow behind the win. */
  private landReel(w: { x: number; y: number }, i: number, reduced: boolean): void {
    // §E3/B14: a mechanical reel-landing clunk, panned by reel (left/centre/right) so the three stops
    // read across the stereo field. A light haptic partners each detent (a11y-gated).
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
  }

  private celebrate(labels: string[], blurbs: string[], streak: number): void {
    // §E4 — the daily prize claim is one of the three Heartbloom beats. Layered UNDER the existing
    // fanfare/jackpot/hearts/sparks/confetti celebration; the Maya leitmotif rings only here + PERFECT/jackpot.
    this.heartbloom(DESIGN_W / 2, 450) // the cabinet's center, where the reels just settled
    this.streakMilestone(streak) // §E15 — a tiered flourish layered on when the streak hits 7 / 30 / 100
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
   * STREAK MILESTONE (§E15) — a tiered flourish when the streak hits 7 / 30 / 100 days: a
   * congratulatory line + a bigger heart/spark burst, layered on TOP of the ordinary daily
   * celebration (ordinary days are unchanged — this returns early). Reuses the existing heart/spark
   * emitters + gold tokens. Reduced motion → the static congrats line only, no burst.
   */
  private streakMilestone(streak: number): void {
    const tier =
      streak === 100
        ? { line: '100 DAYS — LEGENDARY', hearts: 52, sparks: 26 }
        : streak === 30
          ? { line: '30-DAY STREAK!', hearts: 40, sparks: 18 }
          : streak === 7
            ? { line: 'ONE-WEEK STREAK!', hearts: 30, sparks: 12 }
            : null
    if (!tier) return // ordinary day — unchanged

    const reduced = this.prefersReducedMotion()
    const T = getTheme()
    // Congratulatory line just under the reels (above the prize title). Depth 49 so it clears the
    // Heartbloom's glow (depth 47) and stays crisply readable.
    const banner = this.add
      .text(DESIGN_W / 2, 636, `🔥  ${tier.line}`, {
        fontFamily: FONT,
        fontSize: '32px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setShadow(0, 2, 'rgba(0,0,0,0.18)', 5, false, true)
      .setDepth(49)

    if (reduced) return // static congrats, no burst

    banner.setScale(0)
    this.tweens.add({ targets: banner, scale: 1, duration: 340, ease: 'Back.easeOut' })

    // A bigger heart burst — tiered by milestone (reuses the heart texture / celebrate's emitter shape).
    const hearts = this.add
      .particles(0, 0, 'heart', {
        speed: { min: 160, max: 480 },
        angle: { min: 210, max: 330 },
        scale: { start: 0.6, end: 0.12 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 800, max: 1500 },
        gravityY: 480,
        rotate: { min: -160, max: 160 },
        emitting: false,
      })
      .setDepth(46)
    hearts.explode(tier.hearts, DESIGN_W / 2, 430)
    this.time.delayedCall(1800, () => hearts.destroy())

    // A gold spark ring accenting the milestone.
    const sparks = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 200, max: 520 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.6, end: 0 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 700, max: 1200 },
        gravityY: 100,
        tint: T.gold,
        emitting: false,
      })
      .setDepth(46)
    sparks.explode(tier.sparks, DESIGN_W / 2, 430)
    this.time.delayedCall(1600, () => sparks.destroy())
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

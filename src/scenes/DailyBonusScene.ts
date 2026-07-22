import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { performFreeSpin, performSpin, spinAvailable, todayKey } from '../core/daily'
import { occasionFor, pendingOccasion } from '../core/maya'
import { mulberry32 } from '../core/rng'
import { loadSave, markOccasionSeen } from '../core/save'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { D, E, OVERSHOOT, backOut, fadeRise, popIn } from '../view/motion'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from '../view/theme'
import { ensurePieceTexture } from '../view/textures'
import { FONT, GHOST_PILL, GOLD_PILL, addPillButton, applyEntrance, goldFace, startScene } from '../view/ui'

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
 * The daily bonus: a 3-reel slot machine that ALWAYS lands the prize (three-of-a-kind). Prize +
 * streak are computed and persisted BEFORE the animation runs, so the celebration is pure
 * presentation.
 *
 * R4 · FREE SPINS mode: banked bonus spins (save.freeSpins, earned by MEGA cascades in numbered
 * levels) make this cabinet worth visiting ANY day. While the bank holds spins the machine is
 * playable even after (or without) today's daily spin — a "FREE SPINS ×N" ticket chip on the cabinet
 * shows the bank, and claimed prizes CHAIN: the cabinet stays lit, the bulb chase accelerates per
 * consecutive spin, and SPIN re-arms until the bank empties (performFreeSpin — the daily latch and
 * streak are never touched). With an empty bank, every daily-gated behaviour is exactly as before.
 */
export class DailyBonusScene extends Phaser.Scene {
  private spinning = false
  /** §E4 guard — the Heartbloom (heart of light + Maya leitmotif) fires at most ONCE per claim. */
  private heartbloomFired = false

  // --- R4 free-spins chaining state (reset per scene entry — scene.start reuses the instance) ---
  /** Consecutive spins claimed this visit — drives the accelerating bulb chase. */
  private chainCount = 0
  /** The marquee bulbs framing the cabinet — re-choreographed (faster chase) per chained spin. */
  private bulbs: Phaser.GameObjects.Image[] = []
  /** The three reel-window rects (absolute design coords), captured for re-arms. */
  private windows: { x: number; y: number }[] = []
  /** The machine cabinet container (frame + windows + payline + bulbs + idle symbols). */
  private cabinet!: Phaser.GameObjects.Container
  /** "FREE SPINS ×N" ticket chip riding the cabinet's top-right shoulder; undefined when bank is 0. */
  private freeChip?: { root: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text }
  /** The active claim celebration (title/blurb/buttons) — torn down when a chained spin re-arms. */
  private celebration?: Phaser.GameObjects.Container
  /** Spin leftovers (reel strips, masks, landing glows, the spent SPIN button) — cleared on re-arm. */
  private spinTrash: Phaser.GameObjects.GameObject[] = []
  /** DEV ?spin — force the FIRST spin down the daily path even when already claimed today. */
  private devForce = false
  /** The "🔥 day N" streak line — repainted by DAILY pulls only (free pulls pass it by untouched). */
  private streakLine?: Phaser.GameObjects.Text
  /** Repaints the §D3 week strip from a streak count — bound in create, used by daily pulls only. */
  private streakPaint: (streak: number) => void = () => {}

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
    this.chainCount = 0
    this.bulbs = []
    this.windows = []
    this.freeChip = undefined
    this.celebration = undefined
    this.spinTrash = []
    this.spinning = false
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    this.cameras.main.setScroll(0, restScrollY()) // centre the design box in the taller world
    applyEntrance(this) // §E10 directional push-in + §F2 light-wipe (no-ops under reduced motion)
    addCasinoBackdrop(this, 'home')
    const save = loadSave()
    const params = new URLSearchParams(location.search)
    this.devForce = import.meta.env.DEV && params.has('spin')
    const available = spinAvailable(save) || this.devForce
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

    // §D3 — a small 7-dot "week" streak strip under the streak line. Earned days light gold, upcoming
    // days ghost, and the 5th dot is crowned with a star as the DOUBLE-PRIZE milestone (daily.ts pays a
    // SECOND prize every 5th streak day), so the streak's payoff structure is visible and worth coming
    // back for. Built here — before the branch below — so it rides EVERY state (the available reels, D1's
    // already-spun countdown, the post-claim screen). It sits high above both the cabinet and D1's
    // countdown, disturbing neither. Baked `bulb`/`star` + gold tokens only, no new assets.
    const DOT_STEP = 32
    const DOT_MID = 4 // 0-based index of the 5th dot — the double-prize day
    const dotY = 236
    const dot0X = DESIGN_W / 2 - (DOT_STEP * 6) / 2 // centre the 7-dot row on the design axis
    // This week's earned days, capped at a 7-day week: streak 1..7 → 1..7 filled; streak 8 wraps to a
    // fresh week (1 filled), 14 → 7, … — always the CURRENT week's progress, matching the streak line.
    const weekDots = (streak: number): number => (streak <= 0 ? 0 : ((streak - 1) % 7) + 1)
    const streakDots: Phaser.GameObjects.Image[] = []
    for (let i = 0; i < 7; i++) {
      const s = i === DOT_MID ? 22 : 18 // the milestone dot rides a touch larger under its star
      streakDots.push(this.add.image(dot0X + i * DOT_STEP, dotY, 'bulb').setDisplaySize(s, s))
    }
    // The double-prize badge: a small star crowning the 5th dot, ALWAYS shown so the reward advertises
    // itself even on day 1 (it just brightens once that day is actually earned).
    const milestoneStar = this.add.image(streakDots[DOT_MID].x, dotY - 20, 'star').setDisplaySize(18, 18)
    // Repaint earned(lit-gold)/upcoming(ghosted) from a streak count — reused when today's spin lands.
    const paintStreak = (streak: number): void => {
      const earned = weekDots(streak)
      streakDots.forEach((dot, i) => {
        const lit = i < earned
        dot.setTint(lit ? T.gold : T.goldDeep).setAlpha(lit ? 1 : 0.4) // lit matches the cabinet marquee
      })
      milestoneStar.setAlpha(earned >= DOT_MID + 1 ? 1 : 0.5) // full once the double-day is banked
    }
    paintStreak(save.streak)
    this.streakLine = streakText
    this.streakPaint = paintStreak
    // One gentle pop on TODAY's dot — the day about to be claimed (spin available) or the one just
    // claimed (already spun). Gated (§E8): reduced motion leaves the strip fully static, no steady
    // cost. Delayed past the dot-by-dot entrance below so the two scale tweens never overlap.
    if (!reduced) {
      const earnedNow = weekDots(save.streak)
      const today = streakDots[Phaser.Math.Clamp(available ? earnedNow : earnedNow - 1, 0, 6)]
      const base = today.scaleX
      this.tweens.add({ targets: today, scale: base * 1.22, duration: 260, delay: 720, yoyo: true, ease: 'Sine.easeInOut' })
    }
    // D5 · entrance choreography: the week strip pops in dot-by-dot, left→right, with the milestone
    // star arriving just after its dot — so the streak's payoff structure announces itself on entry.
    // popIn collapses to an instant resting state under reduced motion (§E8).
    streakDots.forEach((sd, i) => popIn(this, sd, { from: 0.3, delay: 90 + i * 40, overshoot: OVERSHOOT.gentle }))
    popIn(this, milestoneStar, { from: 0.3, delay: 90 + DOT_MID * 40 + 70 })

    // Machine cabinet — frame, reel windows, payline, bulbs and (below) the idle symbols all live in
    // one container so the D5 entrance can rise the whole machine into place as a single unit. It
    // rests at (0,0), so every child keeps its absolute design-space coords, and the reel-spin strips
    // (scene-level, built at rest) still align with the windows exactly.
    const cabinet = this.add.container(0, 0)
    this.cabinet = cabinet
    const g = this.add.graphics()
    cabinet.add(g)
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
    for (let i = 0; i < 3; i++) {
      const wx = cabX + slotGap + i * (REEL_W + slotGap)
      const wy = cabY + (cabH - REEL_H) / 2
      this.windows.push({ x: wx, y: wy })
      g.fillStyle(T.cardFillAlt, 1)
      g.fillRoundedRect(wx, wy, REEL_W, REEL_H, 18)
      g.lineStyle(2, T.border, 1)
      g.strokeRoundedRect(wx, wy, REEL_W, REEL_H, 18)
    }
    const windows = this.windows

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
        cabinet.add(bulb)
        this.bulbs.push(bulb)
        if (reduced) {
          bulb.setAlpha(0.85)
        } else {
          // The steady twinkle (unchanged): a slow phase-spread alpha breathe once the bulb is lit.
          const twinkle = (): void => {
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
          if (reduceFlashing()) {
            // Flash-averse (§E8): no power-on chase — the bulbs start lit and just breathe, as today.
            bulb.setAlpha(0.5)
            twinkle()
          } else {
            // D5 · power-on chase: each bulb fades up in sequence around the frame (top edge leads,
            // bottom follows a beat later) before settling into its twinkle — the cabinet "switching
            // on" as the scene arrives. Gentle staggered fades, not strobes.
            bulb.setAlpha(0)
            this.tweens.add({
              targets: bulb,
              alpha: 0.5,
              duration: D.base,
              delay: 140 + i * 45 + (by === cabY ? 0 : 40),
              ease: E.settle,
              onComplete: twinkle,
            })
          }
        }
      }
    }
    // D5 · entrance choreography — the whole cabinet rises softly into place as one unit while the
    // bulbs chase on over it. fadeRise collapses instantly under reduced motion (§E8), so the calm
    // path still opens at rest.
    fadeRise(this, cabinet, { rise: 18, duration: D.pop, ease: backOut(OVERSHOOT.gentle) })

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

    // R4 — the banked free spins advertise themselves on the cabinet before anything else moves.
    if (save.freeSpins > 0) this.ensureFreeChip(save.freeSpins)

    // R4 gate: the "come back tomorrow" countdown dead-end only stands when there is truly nothing to
    // pull — no daily spin AND an empty free-spin bank. A banked spin lights the cabinet any day.
    if (!available && save.freeSpins === 0) {
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
      // D5: the ghosted reels pop in left→right and the countdown/HOME settle in a beat later, so
      // even the "come back tomorrow" state composes in instead of snapping flat (§E8-safe helpers).
      windows.forEach((w, i) => {
        const ghost = this.add
          .image(w.x + REEL_W / 2, w.y + REEL_H / 2, SYMBOLS[Math.floor(Math.random() * 6)])
          .setDisplaySize(96, 96)
          .setAlpha(0.5)
        cabinet.add(ghost)
        popIn(this, ghost, { from: 0.55, delay: 200 + i * 80, overshoot: OVERSHOOT.gentle })
      })
      fadeRise(this, countdown, { rise: 12, delay: 200 })
      const homeBtn = addPillButton(this, DESIGN_W / 2, 830, 280, 72, 'HOME', GOLD_PILL, () => startScene(this,'home'))
      popIn(this, homeBtn, { from: 0.75, delay: 280, overshoot: OVERSHOOT.gentle })
      return
    }

    // The streak line + week strip belong to the DAILY rhythm; the free-spin path leaves them alone.
    this.armSpin(available)
    if (import.meta.env.DEV && params.has('autospin')) this.time.delayedCall(300, () => this.spinBtnPress?.())
  }

  /** The live SPIN handler for DEV ?autospin (rebound on every re-arm so it always hits the fresh button). */
  private spinBtnPress?: () => void

  /**
   * R4 — arm (or RE-arm) the machine: idle symbols on the reels + the hero SPIN button. `daily` picks
   * which pull this arm performs — today's daily spin (streak + latch, exactly the old behaviour) or
   * a banked free spin (performFreeSpin: bank − 1, NO latch/streak writes). Chained re-arms pass the
   * streak handles through untouched so the daily row never repaints on a free pull.
   */
  private armSpin(daily: boolean): void {
    const reduced = this.prefersReducedMotion()
    const windows = this.windows
    const rearming = this.chainCount > 0

    // Idle reels before the spin.
    const idle: Phaser.GameObjects.Image[] = windows.map(w =>
      this.add.image(w.x + REEL_W / 2, w.y + REEL_H / 2, SYMBOLS[Math.floor(Math.random() * 6)]).setDisplaySize(96, 96)
    )
    idle.forEach(img => this.cabinet.add(img)) // ride the cabinet's D5 entrance as part of the machine
    // §D2 baselines — every symbol bakes into the same TEX_SIZE² frame and every reel window shares one
    // y, so all three idle symbols rest at an identical scale + y. Captured here so the idle bob and the
    // SPIN wind-up (below) can spring the whole group back to one exact resting transform. (Captured
    // BEFORE the entrance pop below shrinks the live scale — popIn lands back on this exact rest.)
    const idleBase = idle[0].scaleX
    const idleRestY = windows[0].y + REEL_H / 2
    // D5 · entrance choreography: each idle symbol pops onto its reel with a small left→right stagger
    // once the cabinet is up (a snappier stagger on chained re-arms — the machine is already warm).
    idle.forEach((img, i) => popIn(this, img, { from: 0.4, delay: (rearming ? 60 : 220) + i * (rearming ? 50 : 90) }))

    // §D2 pre-spin tease — a subtle vertical BOB so the idle reels breathe instead of sitting dead,
    // staggered per reel so the three symbols float out of lockstep. Gated (§E8): reduced motion leaves
    // them at their resting y. Transform only; retired by killTweensOf the instant SPIN winds up (below).
    if (!reduced) {
      idle.forEach((img, i) =>
        this.tweens.add({
          targets: img,
          y: idleRestY - 7,
          duration: 1100,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
          delay: i * 160,
        })
      )
    }

    const doSpin = (): void => {
      if (this.spinning) return
      this.spinning = true
      spinBtn.setVisible(false)
      // Award first, animate second — closing mid-spin can't lose the prize. Decide the pull at press
      // time from the live save: daily while today's spin stands (or DEV-forced on the first pull),
      // else a banked free spin. performFreeSpin never touches lastSpinDate/streak by contract.
      const save = loadSave()
      const rng = mulberry32((Math.random() * 2 ** 31) | 0)
      const useDaily = spinAvailable(save) || (this.devForce && this.chainCount === 0)
      let prizes: { type: string; label: string; blurb: string }[]
      let streakForCeleb: number | null
      // Daily check-in chips ride the DAILY pull only; a banked free spin never pays them (it bypasses
      // the latch/streak by contract), so it leaves this at 0 and the celebration shows no chip beat.
      let chipsForCeleb = 0
      if (useDaily) {
        const result = performSpin(save, rng)
        this.streakLine?.setText(`🔥 day ${result.streak}`)
        this.streakPaint(result.streak) // §D3 — advance the week strip in step with the streak line
        prizes = result.prizes
        streakForCeleb = result.streak
        chipsForCeleb = result.chips
      } else {
        const result = performFreeSpin(save, rng)
        if (!result) {
          // Bank raced to empty (can't double-spend by contract) — quietly stand the machine down.
          this.spinning = false
          spinBtn.setVisible(true)
          return
        }
        this.ensureFreeChip(result.remaining) // retally the ticket chip the moment the spin is spent
        prizes = result.prizes
        streakForCeleb = null
      }
      // Hand the FIXED result to the reels once the pre-spin wind-up (if any) has cleared the idle symbols.
      const launch = (): void => {
        idle.forEach(img => img.destroy())
        this.runReels(windows, prizes.map(p => p.type), () =>
          this.celebrate(prizes.map(p => p.label), prizes.map(p => p.blurb), streakForCeleb, chipsForCeleb)
        )
      }
      // §D2 wind-up (E6 charge language): the idle symbols CROUCH — dip down + squash (anticipation,
      // Quad.easeIn) — then SPRING back through rest (release, backOut), and the reels LAUNCH on that
      // release, so the beat reads charge→release before the spin. Reduced motion (§E8) → straight to
      // launch: the existing instant path is untouched. Transforms only; the result is unaffected either way.
      if (reduced) {
        launch()
        return
      }
      this.tweens.killTweensOf(idle) // retire the idle bob so it doesn't fight the wind-up
      this.tweens.chain({
        targets: idle,
        tweens: [
          { scaleX: idleBase * 1.06, scaleY: idleBase * 0.86, y: idleRestY + 8, duration: 100, ease: 'Quad.easeIn' }, // charge — crouch + squash
          { scaleX: idleBase, scaleY: idleBase, y: idleRestY, duration: 150, ease: backOut(OVERSHOOT.pop) }, // release — spring back into rest
        ],
        onComplete: launch,
      })
    }
    this.spinBtnPress = doSpin
    // SPIN — the scene's hero, so it takes the shared hero treatment (`juice`: breathing glow ring +
    // periodic sheen from buildPressable) on top of its own anticipation breathe below. A free-spin
    // arm names the pull honestly ("FREE SPIN") so the player knows the daily gift isn't being spent.
    const spinBtn = addPillButton(this, DESIGN_W / 2, 740, 300, 92, daily ? 'SPIN' : 'FREE SPIN', GOLD_PILL, doSpin, { juice: true })
    this.spinTrash.push(spinBtn) // the spent button is swept on the next re-arm
    // D5 · SPIN entrance + breathe — the hero pops in after the cabinet settles, THEN starts its
    // breathe, so the two scale tweens never fight. Gated (§E8): reduced motion rests at scale 1.
    if (!reduced) {
      spinBtn.setScale(0.7).setAlpha(0)
      this.tweens.add({
        targets: spinBtn,
        scale: 1,
        alpha: 1,
        duration: D.pop,
        delay: rearming ? 120 : 300,
        ease: backOut(OVERSHOOT.pop),
        onComplete: () => {
          this.tweens.add({ targets: spinBtn, scale: 1.05, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
        },
      })
    }
  }

  /**
   * R4 — the "FREE SPINS ×N" bank ticket riding the cabinet's top-right shoulder: a mini golden
   * ticket (goldFace slab + perforation rule + punched end notches — the same silhouette as the
   * in-level award ticket, so earn and spend visibly rhyme). Created lazily, retallied in place,
   * retired with a soft fade when the bank empties.
   */
  private ensureFreeChip(n: number): void {
    if (n <= 0) {
      this.retireFreeChip()
      return
    }
    if (!this.freeChip) {
      const T = getTheme()
      const root = this.add.container(548, 250).setDepth(30)
      const g = this.add.graphics()
      const w = 190
      const h = 42
      const r = 10
      g.fillStyle(T.shadow, 0.25)
      g.fillRoundedRect(-w / 2 + 2, -h / 2 + 4, w, h, r)
      goldFace(g, -w / 2, -h / 2, w, h, T, r)
      g.lineStyle(2, T.goldDeep, 0.85)
      g.strokeRoundedRect(-w / 2 + 6, -h / 2 + 6, w - 12, h - 12, r * 0.5)
      g.fillStyle(T.goldDarkest, 0.4)
      g.fillCircle(-w / 2, 0, h * 0.15)
      g.fillCircle(w / 2, 0, h * 0.15)
      const label = this.add
        .text(0, 0, '', { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: css(T.goldDarkest) })
        .setOrigin(0.5)
      root.add([g, label])
      this.freeChip = { root, label }
      popIn(this, root, { from: 0.4, delay: 240 })
    }
    this.freeChip.label.setText(`FREE SPINS ×${n}`)
  }

  /** Fade + drop the bank ticket when the last free spin is spent (instant removal under reduced motion). */
  private retireFreeChip(): void {
    const chip = this.freeChip
    if (!chip) return
    this.freeChip = undefined
    this.tweens.killTweensOf(chip.root)
    if (this.prefersReducedMotion()) {
      chip.root.destroy(true)
      return
    }
    this.tweens.add({ targets: chip.root, alpha: 0, y: chip.root.y - 14, duration: 280, ease: E.exit, onComplete: () => chip.root.destroy(true) })
  }

  /**
   * R4 — accelerate the marquee: each chained spin re-choreographs the bulb chase faster and tighter,
   * so the cabinet audibly-visibly "heats up" the longer the free-spin run goes. Reduced motion keeps
   * the bulbs statically lit; reduce-flashing clamps the cycle ≥520ms and softens the swing (a
   * quickening breathe, never a strobe).
   */
  private accelerateBulbs(): void {
    if (this.prefersReducedMotion()) return
    const soft = reduceFlashing()
    const cycle = Math.max(soft ? 520 : 240, 650 - this.chainCount * 120)
    const step = Math.max(soft ? 90 : 45, 200 - this.chainCount * 40)
    this.bulbs.forEach((bulb, i) => {
      if (!bulb.active) return
      this.tweens.killTweensOf(bulb)
      bulb.setAlpha(soft ? 0.55 : 0.4)
      this.tweens.add({
        targets: bulb,
        alpha: soft ? 0.9 : 1,
        duration: cycle,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: (i % 5) * step,
      })
    })
  }

  /**
   * R4 — tear down the previous pull (celebration card, spent reel strips/masks/glows/button) and
   * re-arm the machine for the next banked spin. Every kill precedes its destroy (Phaser 3.90 never
   * sweeps tweens for destroyed targets). The daily streak handles pass through untouched — a chained
   * pull can never repaint the daily row.
   */
  private rearm(): void {
    const cel = this.celebration
    if (cel) {
      const walk = (obj: Phaser.GameObjects.GameObject): void => {
        this.tweens.killTweensOf(obj)
        if (obj instanceof Phaser.GameObjects.Container) obj.list.forEach(walk)
      }
      walk(cel)
      cel.destroy(true)
      this.celebration = undefined
    }
    for (const o of this.spinTrash) {
      if (!o.active) continue
      this.tweens.killTweensOf(o)
      if (o instanceof Phaser.GameObjects.Container) {
        o.list.forEach(child => this.tweens.killTweensOf(child))
        o.clearMask(true) // reel strips carry geometry masks — freed with the strip
      }
      o.destroy()
    }
    this.spinTrash = []
    this.accelerateBulbs() // the chase quickens — the run is heating up
    sfx.charge(Math.min(4, this.chainCount + 1)) // rising re-arm cue, a step per consecutive spin
    this.armSpin(false)
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
      this.spinTrash.push(strip, maskG) // swept (mask freed) when a chained spin re-arms
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
    this.spinTrash.push(glow) // its looping breathe is killed + the glow swept on re-arm
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

  /**
   * The claim celebration. `streak` is the freshly-advanced daily streak, or NULL for a banked free
   * spin (whose pull must never read as a daily event — no milestone flourish, no claimed-date line
   * unless today's daily really was claimed). R4 chaining: while the bank still holds spins the
   * machine stays hot — SPIN AGAIN re-arms in place instead of exiting home.
   */
  private celebrate(labels: string[], blurbs: string[], streak: number | null, chips = 0): void {
    this.chainCount++
    // §E4 — the daily prize claim is one of the three Heartbloom beats. Layered UNDER the existing
    // fanfare/jackpot/hearts/sparks/confetti celebration; the Maya leitmotif rings only here + PERFECT/jackpot.
    this.heartbloom(DESIGN_W / 2, 450) // the cabinet's center, where the reels just settled
    if (streak !== null) this.streakMilestone(streak) // §E15 — 7/30/100-day flourish (daily pulls only)
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

    // Everything durable about this claim lives in ONE container so a chained re-arm can sweep it.
    const cel = this.add.container(0, 0).setDepth(48)
    this.celebration = cel

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
    cel.add(title)
    this.tweens.add({ targets: title, scale: 1, duration: 300, ease: 'Back.easeOut' })
    if (this.prefersReducedMotion()) title.setScale(1)
    cel.add(
      this.add
        .text(DESIGN_W / 2, 760, blurbs.join('\n'), { fontFamily: FONT, fontSize: '22px', color: getTheme().onBackdropMuted, align: 'center' })
        .setOrigin(0.5)
    )

    // Daily check-in chip beat — the streak-scaled reward banked by performSpin (rose to read as chips,
    // matching the jackpot wheel's payout line). Free spins pass chips=0, so this whole beat is skipped
    // and the layout below rests exactly as before. When it DOES show, the lower cluster shifts down by
    // `chipShift` so the "+N CHIPS" line can never crowd the bank line / buttons.
    const chipShift = chips > 0 ? 56 : 0
    if (chips > 0) {
      const chipLine = this.add
        .text(DESIGN_W / 2, 806, `+${chips.toLocaleString()} CHIPS`, {
          fontFamily: FONT,
          fontSize: '34px',
          fontStyle: '900',
          color: css(getTheme().roseLight),
        })
        .setOrigin(0.5)
        .setShadow(0, 2, 'rgba(0,0,0,0.15)', 5, false, true)
      cel.add(chipLine)
      if (this.prefersReducedMotion()) {
        chipLine.setScale(1)
      } else {
        chipLine.setScale(0)
        this.tweens.add({ targets: chipLine, scale: 1, duration: 300, delay: 120, ease: 'Back.easeOut' })
      }
    }

    const bankLeft = loadSave().freeSpins
    if (bankLeft > 0) {
      // R4 · THE CHAIN — the bank still holds spins: the cabinet stays lit, the bulbs quicken, and
      // the hero re-arms. performFreeSpin (next pull) spends the bank without touching the daily latch.
      this.ensureFreeChip(bankLeft)
      cel.add(
        this.add
          .text(DESIGN_W / 2, 812 + chipShift, `${bankLeft} free spin${bankLeft === 1 ? '' : 's'} still banked`, {
            fontFamily: FONT,
            fontSize: '20px',
            fontStyle: '700',
            color: getTheme().onBackdropMuted,
          })
          .setOrigin(0.5)
      )
      const again = addPillButton(this, DESIGN_W / 2, 880 + chipShift, 300, 80, 'SPIN AGAIN', GOLD_PILL, () => this.rearm(), { juice: true })
      cel.add(again)
      popIn(this, again, { from: 0.7, delay: 200 })
    } else {
      this.retireFreeChip() // the run is over — the ticket chip bows out with the last spin
      cel.add(addPillButton(this, DESIGN_W / 2, 880 + chipShift, 300, 80, 'CLAIM', GOLD_PILL, () => startScene(this,'home')))
      if (loadSave().lastSpinDate === todayKey()) {
        cel.add(
          this.add
            .text(DESIGN_W / 2, 960 + chipShift, `come back tomorrow — ${todayKey()} claimed`, { fontFamily: FONT, fontSize: '18px', color: getTheme().inkFaint })
            .setOrigin(0.5)
        )
      }
    }
    this.spinning = false
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
    this.celebration?.add(banner) // rides the claim card — swept together on a chained re-arm

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

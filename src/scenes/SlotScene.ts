import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_H, DESIGN_W, restScrollY, viewportCenterY, worldH } from '../config'
import { EVENTS, track } from '../core/analytics'
import { spinAvailable, todayKey } from '../core/daily'
import { LEVEL_COUNT } from '../core/levels'
import { occasionFor, pendingOccasion } from '../core/maya'
import { mulberry32 } from '../core/rng'
import { loadSave, markOccasionSeen } from '../core/save'
import {
  JACKPOT_GOAL,
  SCATTER_REELS,
  SLOT_BETS,
  SLOT_CHARM,
  SLOT_MAX_ROWS,
  SLOT_MIN_RUN,
  SLOT_PAYS,
  SLOT_REELS,
  SLOT_SCATTER_NEEDED,
  SLOT_STRIPS,
  SLOT_STRIP_LEN,
  charmChance,
} from '../core/slots'
import type { SlotBet, SlotSpin, SlotSymbol } from '../core/slots'
import { BOOST_ITEMS, buySpin, freeSlotSpin } from '../core/store'
import type { FreeSlotKind, FreeSlotSpinResult, SlotPurchase } from '../core/store'
import { addCasinoBackdrop } from '../view/background'
import { vibratePattern } from '../view/haptics'
import { addJackpotMeter } from '../view/jackpot'
import type { JackpotMeter } from '../view/jackpot'
import { D, E, OVERSHOOT, backOut, fadeRise, popIn } from '../view/motion'
import { quality } from '../view/quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing, rgbMarquee } from '../view/theme'
import { attachRgbChase, type RgbChase } from '../view/rgbmarquee'
import { ensureGlyphTexture } from '../view/textures'
import type { ChipPill } from '../view/ui'
import { FONT, GHOST_PILL, GOLD_PILL, addChipPill, addPillButton, applyEntrance, startScene } from '../view/ui'

/**
 * LUCKY SLOTS — the purchased spin, and the first machine in this game the player can reach for.
 *
 * A destination scene, sibling to DailyBonusScene and StoreScene: warm cross-fade in, back to the Gift
 * Store it is entered from. The machine itself (strips, paytable, prices, odds) lives in core/slots.ts
 * and the spend + banking in core/store.ts `buySpin`; this file is presentation only.
 *
 * ── THE CABINET IS ALWAYS FOUR ROWS TALL ─────────────────────────────────────
 * Your bet buys PAYLINES, and the cabinet shows what you did and did not buy: rows within the bet are
 * lit and read left→right for wins, rows beyond it sit behind a scrim with their lamp dark. They still
 * spin, because a machine whose screen changes size between bets stops reading as one machine — but
 * nothing in an unlit row is ever counted, the lamps say which rows are live, and the PAYS panel spells
 * out both. The player is never shown a line that might have paid and quietly didn't.
 *
 * ── THE REELS ARE THE REAL STRIPS ────────────────────────────────────────────
 * Each reel renders SLOT_STRIP_LEN + SLOT_MAX_ROWS cells whose faces are `strip[j % len]`, so the
 * content is PERIODIC in the strip length. Scrolling is then a single virtual position in cells, wrapped
 * with a modulo — the wrap is invisible precisely because the content repeats, which buys an endlessly
 * spinning reel for 29 sprites instead of rebuilding a fresh strip on every pull. What is on screen is
 * the strip core/slots.ts rolled, at the position it rolled.
 *
 * ── AWARD-FIRST ──────────────────────────────────────────────────────────────
 * `buySpin` settles and banks everything before the first reel moves (the same contract as the daily
 * spin, the jackpot wheel, the plinko drop and the Lucky Deal). Every animation below is replaying a
 * result already in the save, so closing the app mid-spin cannot lose a prize — and the back button is
 * simply latched shut while the reels run rather than having to undo anything.
 */

// ── cabinet geometry ─────────────────────────────────────────────────────────
const CAB_X = 26
const CAB_W = 668
const CAB_Y = 292
const CAB_R = 30
/** One reel-window cell — the whole cabinet is built off this. */
const CELL_H = 104
const REEL_W = 110
const REEL_GAP = 10
/** Left edge of reel 1. The gutter left of it (CAB_X → here) holds the payline lamps. */
const REELS_X = 80
const REELS_TOP = CAB_Y + 24
const REELS_W = SLOT_REELS * REEL_W + (SLOT_REELS - 1) * REEL_GAP
const WINDOW_H = SLOT_MAX_ROWS * CELL_H
const CAB_H = WINDOW_H + 48
/** Centre-x of the payline lamp column. */
const LAMP_X = 53
const SYMBOL_SIZE = 84

// ── controls ─────────────────────────────────────────────────────────────────
const BET_Y = 824
const BET_W = 152
const BET_STEP = 164
const SPIN_Y = 950
const METER_Y = 1032
/** Top of the result block — the win headline sits a touch above it, the copy below. */
const RESULT_Y = 1094

/** Scatter face art. The Lucky Deal's HEART card is the game's other charm source, so the two rhyme. */
const CHARM_TEX = 'slotcharm'

/** Reel travel: the first reel's spin time, and what each reel to its right adds. */
const SPIN_MS = 850
const SPIN_STEP_MS = 260

interface Reel {
  strip: Phaser.GameObjects.Container
  mask: Phaser.GameObjects.Graphics
  cells: Phaser.GameObjects.Image[]
  /** Virtual position in cells. `pos % SLOT_STRIP_LEN` is the strip index showing in row 1. */
  pos: number
}

export class SlotScene extends Phaser.Scene {
  private balance!: ChipPill
  private balanceX = DESIGN_W / 2
  private balanceY = 240
  private meter!: JackpotMeter
  private reels: Reel[] = []
  private rows: number = SLOT_MAX_ROWS
  private spinning = false
  private betPills: Phaser.GameObjects.Container[] = []
  private spinBtn?: Phaser.GameObjects.Container
  /** The bet row + hero button. Rebuilt whenever the bet or the balance moves. */
  private controlLayer!: Phaser.GameObjects.Container
  /** Everything painted for ONE result — paylines, scatter rings, prize copy. Swept at the next pull. */
  private resultLayer!: Phaser.GameObjects.Container
  private rowScrims: Phaser.GameObjects.Rectangle[] = []
  private rowLamps: { ring: Phaser.GameObjects.Graphics; label: Phaser.GameObjects.Text }[] = []
  /** The cabinet container — the landing detent kicks the whole machine, not just a strip. */
  private cabinet!: Phaser.GameObjects.Container
  /** The marquee bulbs ringing the cabinet, in CLOCKWISE ring order so a chase can lap the frame. */
  private bulbs: Phaser.GameObjects.Image[] = []
  /** Each bulb's resting tint (alternating gold/rose) — restored when a HEAT pass turns them all rose. */
  private bulbTints: number[] = []
  /** Which choreography currently owns the bulb ring — guards delayed mode handoffs (win → idle). */
  private marqueeMode: 'idle' | 'spin' | 'heat' | 'win' = 'idle'
  /** The RGB chase driving the ring (§RGB), or undefined when the player has it switched off. */
  private rgb?: RgbChase
  /** The LCD attract-loop timer (a periodic shine across the glass) — killed the moment a pull starts. */
  private attractTimer?: Phaser.Time.TimerEvent
  /** Transients of the HEAT beat (the pending-reel glow) — swept by the final reel's landing. */
  private heatFx: Phaser.GameObjects.GameObject[] = []
  /** The subtitle under the title — repainted as the free-pull state moves (daily → banked → paid). */
  private subtitle!: Phaser.GameObjects.Text
  /** DEV `?seed=<n>` — force the next pull's rng stream, so charm/heat beats can be staged on demand. */
  private devSeed: number | null = null

  constructor() {
    super('slots')
  }

  create(): void {
    // Scenes are reused via scene.start — clear every per-entry ref before anything can read a stale one.
    this.reels = []
    this.betPills = []
    this.rowScrims = []
    this.rowLamps = []
    this.spinBtn = undefined
    this.spinning = false
    this.bulbs = []
    this.bulbTints = []
    // §RGB — unhook the old ring's clock before the refs above are dropped, or a re-entered scene
    // leaves it painting destroyed bulbs (and a second clock fighting the new one).
    this.rgb?.destroy()
    this.rgb = undefined
    this.marqueeMode = 'idle'
    this.attractTimer = undefined
    this.heatFx = []

    this.cameras.main.setScroll(0, restScrollY())
    this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    applyEntrance(this)
    addCasinoBackdrop(this, 'home')
    ensureGlyphTexture(this, CHARM_TEX, '❤️', 104, 128)
    const T = getTheme()
    const params = new URLSearchParams(location.search)
    const seedParam = Number(params.get('seed'))
    this.devSeed = import.meta.env.DEV && Number.isFinite(seedParam) && params.has('seed') ? seedParam : null

    // Home is the front door now (the LUCKY SLOTS pill), so back goes home; the Gift Store's shelf
    // card still routes here too, and going "back" to Home from a store entry is never wrong.
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => {
      if (!this.spinning) startScene(this, 'home', undefined, 'back')
    })
    this.add
      .text(DESIGN_W / 2, 130, 'LUCKY SLOTS', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: '#ffffff' })
      .setOrigin(0.5)
      .setLetterSpacing(4)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
      .setTint(T.goldBright, T.goldBright, T.goldDeep, T.goldDeep)
    this.subtitle = this.add
      .text(DESIGN_W / 2, 184, '', {
        fontFamily: FONT,
        fontSize: '23px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)
    this.paintSubtitle()

    // §E9 special-date dress-up — DORMANT unless an occasion is configured for today (ported from the
    // retired daily cabinet: the ritual moved here, so its birthday hearts move with it). The subtitle
    // wears the greeting, and once per day a heart-shower marks the arrival.
    const occToday = occasionFor(todayKey().slice(5))
    if (occToday) {
      this.subtitle.setText(occToday.label)
      if (pendingOccasion(todayKey(), loadSave().occasionsSeen)) {
        markOccasionSeen(todayKey())
        sfx.starDing(2)
        if (!prefersReducedMotion()) {
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

    this.balance = addChipPill(this, this.balanceX, this.balanceY)
    popIn(this, this.balance.container, { from: 0.7, delay: 60, overshoot: OVERSHOOT.gentle })
    // PAYS sits where the Gift Store's ENTER CODE does, on the balance row. A machine that hides its
    // paytable is the one thing a slot must never do, so it gets a permanent control, not a footnote.
    addPillButton(this, 600, this.balanceY, 176, 52, 'PAYS', GHOST_PILL, () => this.openPaytable())

    this.buildCabinet()

    // Controls and the per-result copy are separate layers so a pull can repaint one without touching
    // (or re-tweening) the other — and so a win the player is still reading survives a control refresh.
    this.controlLayer = this.add.container(0, 0)
    this.resultLayer = this.add.container(0, 0)

    const save = loadSave()
    // A FREE pull (the daily, or a banked spin) always plays the FULL cabinet — the gift is the
    // machine at its best odds — so it opens with all four rows lit. Otherwise open on the best bet
    // the balance can actually cover — the machine's designed shape and its best odds — falling back
    // to the full cabinet when nothing is affordable, so a broke player still sees what they are
    // working toward rather than a collapsed one-row stub.
    if (this.pullSource() !== 'paid') {
      this.rows = SLOT_MAX_ROWS
    } else {
      const affordable = SLOT_BETS.filter(b => save.chips >= b.price)
      this.rows = affordable.length > 0 ? affordable[affordable.length - 1].rows : SLOT_MAX_ROWS
    }
    this.paintRowLamps()

    // The meter is on this screen because jackpot points are one of the three things a spin pays, and a
    // prize whose destination is on another screen doesn't read as a prize.
    this.meter = addJackpotMeter(this, DESIGN_W / 2, METER_Y, { width: 340, compact: true })
    this.meter.update(save.jackpotMeter, false)

    this.renderControls(true)
    this.showIdleCopy()

    this.add
      .text(DESIGN_W / 2, DESIGN_H - 60, 'Chips are earned by winning — in-game only, no cash value.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)

    // Geometry masks are made off the display list (`make.graphics(..., false)`), so scene shutdown
    // does not sweep them — a scene the player re-enters would leak one per reel, every time.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const reel of this.reels) {
        reel.strip.clearMask(true)
        reel.mask.destroy()
      }
      this.reels = []
    })

    this.armAttract()

    // `free` says what the cabinet is offering on open — the daily, banked spins, or paid rows only —
    // so the funnel can tell a ritual visit from a shopping trip (a new PROP on the existing event;
    // old dashboards simply ignore it).
    track(EVENTS.SLOTS_OPENED, { chips: save.chips, rows: this.rows, free: this.pullSource() })
  }

  /** Which pull the hero currently offers: the daily gift first, then the bank, then the bet ladder. */
  private pullSource(): FreeSlotKind | 'paid' {
    const save = loadSave()
    if (spinAvailable(save)) return 'daily'
    if (save.freeSpins > 0) return 'banked'
    return 'paid'
  }

  /** Repaint the line under the title from the live free-pull state. */
  private paintSubtitle(): void {
    const source = this.pullSource()
    const save = loadSave()
    // Once today's gift is claimed, the streak receipt HOLDS the line for the rest of the visit —
    // the ritual's "see you tomorrow" — instead of snapping straight back to sales copy.
    this.subtitle.setText(
      source === 'daily'
        ? 'your free daily spin is ready'
        : source === 'banked'
          ? `${save.freeSpins} free spin${save.freeSpins === 1 ? '' : 's'} banked — on the house`
          : save.lastSpinDate === todayKey() && save.streak > 0
            ? `🔥 day ${save.streak} — free spin again tomorrow`
            : 'Buy rows — every row is another payline'
    )
  }

  /**
   * LCD attract loop — every few seconds a soft shine glides across the four rows of glass, so an
   * armed machine invites instead of sitting dead (the Vegas screen never rests). One transient ADD
   * sprite per pass that destroys itself; killed the moment a pull starts and re-armed with the next
   * rearm. Reduced motion: no loop. Reduce-flashing: slower and dimmer — a glide, nothing pulses.
   */
  private armAttract(): void {
    this.attractTimer?.remove(false)
    if (prefersReducedMotion()) return
    const soft = reduceFlashing()
    const sweepOnce = (): void => {
      if (this.spinning) return
      const shine = this.add
        .image(REELS_X - 60, REELS_TOP + WINDOW_H / 2, 'sweep')
        .setDisplaySize(64, WINDOW_H + 30)
        .setAngle(10)
        .setTint(getTheme().glossHi)
        .setAlpha(soft ? 0.09 : 0.14)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(7)
      this.tweens.add({
        targets: shine,
        x: REELS_X + REELS_W + 60,
        duration: soft ? 900 : 640,
        ease: 'Sine.easeInOut',
        onComplete: () => shine.destroy(),
      })
    }
    this.attractTimer = this.time.addEvent({ delay: 4200, startAt: 1600, loop: true, callback: sweepOnce })
  }

  /**
   * The marquee choreographer — ONE authority over the bulb ring, so modes can never stack (every
   * entry kills the ring's tweens first). Four looks:
   *   idle — the slow phase-spread twinkle the cabinet has always worn;
   *   spin — a travelling wave laps the ring clockwise while the reels run;
   *   heat — the tension beat: the lap quickens and every bulb burns rose;
   *   win  — the classic alternating-parity flip-flop over the payout's opening bars.
   * Reduced motion pins the ring statically lit. Reduce-flashing clamps every cycle ≥520ms and
   * floors the alpha swing — a breathe, never a strobe.
   */
  private setMarquee(mode: 'idle' | 'spin' | 'heat' | 'win'): void {
    this.marqueeMode = mode
    // §RGB — the chase implements all four looks itself (see PROFILES in view/rgbmarquee.ts), so the
    // choreographer just re-rates one clock instead of rebuilding 32 tweens. It stays the SINGLE
    // authority either way: `marqueeMode` is still set above, so the delayed win → idle handoff
    // guards identically, and the chase's own mode is a pure restatement of it.
    if (this.rgb) {
      this.rgb.setMode(mode)
      return
    }
    const reduced = prefersReducedMotion()
    const soft = reduceFlashing()
    const n = this.bulbs.length
    const rose = getTheme().rose
    this.bulbs.forEach((bulb, i) => {
      if (!bulb.active) return
      this.tweens.killTweensOf(bulb)
      bulb.setTint(mode === 'heat' ? rose : this.bulbTints[i])
      if (reduced) {
        bulb.setAlpha(0.85)
        return
      }
      if (mode === 'idle') {
        bulb.setAlpha(soft ? 0.55 : 0.45)
        this.tweens.add({
          targets: bulb,
          alpha: soft ? 0.85 : 1,
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
          delay: (i % 5) * 190,
        })
      } else if (mode === 'spin' || mode === 'heat') {
        // Travelling wave — the ring-index phase spread makes one lap of brightness run clockwise
        // round the frame (the Home-marquee chase recipe, on the full ring).
        const period = mode === 'heat' ? (soft ? 900 : 460) : soft ? 1200 : 760
        bulb.setAlpha(soft ? 0.55 : 0.35)
        this.tweens.add({
          targets: bulb,
          alpha: 1,
          duration: period / 2,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
          delay: (i / n) * period,
        })
      } else {
        // win — even bulbs start bright while odd start dim and each yoyos to the other pole, so
        // the ring flip-flops in strict alternation: the payout marquee.
        const period = soft ? 1040 : 500
        const hi = 1
        const lo = soft ? 0.55 : 0.3
        bulb.setAlpha(i % 2 === 0 ? hi : lo)
        this.tweens.add({
          targets: bulb,
          alpha: i % 2 === 0 ? lo : hi,
          duration: period / 2,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        })
      }
    })
  }

  // ────────────────────────────────────────────────────────────────── cabinet

  /** X of reel `i`'s left edge. */
  private reelX(i: number): number {
    return REELS_X + i * (REEL_W + REEL_GAP)
  }

  /** Y of row `r`'s centre. */
  private rowY(r: number): number {
    return REELS_TOP + r * CELL_H + CELL_H / 2
  }

  private buildCabinet(): void {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const cabinet = this.add.container(0, 0)
    this.cabinet = cabinet
    const g = this.add.graphics()
    cabinet.add(g)
    g.fillStyle(T.shadow, 0.16)
    g.fillRoundedRect(CAB_X + 4, CAB_Y + 8, CAB_W, CAB_H, CAB_R)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(CAB_X, CAB_Y, CAB_W, CAB_H, CAB_R)
    g.lineStyle(3, T.goldBezel, 0.9)
    g.strokeRoundedRect(CAB_X, CAB_Y, CAB_W, CAB_H, CAB_R)

    // Reel wells — one recessed slot per reel, drawn behind the strips.
    for (let i = 0; i < SLOT_REELS; i++) {
      g.fillStyle(T.cardFillAlt, 1)
      g.fillRoundedRect(this.reelX(i), REELS_TOP, REEL_W, WINDOW_H, 16)
      g.lineStyle(2, T.border, 1)
      g.strokeRoundedRect(this.reelX(i), REELS_TOP, REEL_W, WINDOW_H, 16)
    }

    for (let i = 0; i < SLOT_REELS; i++) this.reels.push(this.buildReel(i))

    // Payline lamps down the left gutter, and the "you didn't buy this row" scrim over the reels. The
    // scrim is drawn OVER (depth 6, above the strips at 4) so an unlit row reads as switched off rather
    // than merely dim — it must never be mistakable for a line that might have paid.
    for (let r = 0; r < SLOT_MAX_ROWS; r++) {
      const ring = this.add.graphics()
      const label = this.add
        .text(LAMP_X, this.rowY(r), String(r + 1), { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.inkMuted })
        .setOrigin(0.5)
      cabinet.add([ring, label])
      this.rowLamps.push({ ring, label })
      this.rowScrims.push(
        this.add.rectangle(REELS_X + REELS_W / 2, this.rowY(r), REELS_W, CELL_H, T.shadow, 0.55).setDepth(6)
      )
    }

    // Marquee bulbs — a FULL ring around the cabinet frame (top run, right column, bottom run, left
    // column), pushed in CLOCKWISE order so the chase choreography (setMarquee) can lap the frame
    // like a real casino sign. Each run spans only the STRAIGHT part of its edge, inset past the
    // corner radius so every bulb sits centred on the stroke instead of floating off a curved corner
    // (cookbook §2b-ii); the side columns seat at INTERIOR fractions of their run so the corners
    // never double-stud. 11+5+11+5 = 32 bulbs — an even count, so the alternating gold/rose tinting
    // stays alternating across the ring's wrap-around.
    const bulbCols = 11
    const bulbRows = 5
    const run = CAB_W - CAB_R * 2
    const sideRun = CAB_H - CAB_R * 2
    const topX = (i: number): number => CAB_X + CAB_R + (run * i) / (bulbCols - 1)
    const sideY = (i: number): number => CAB_Y + CAB_R + (sideRun * i) / (bulbRows + 1)
    const ring: { x: number; y: number }[] = []
    for (let i = 0; i < bulbCols; i++) ring.push({ x: topX(i), y: CAB_Y }) // top edge, L→R
    for (let i = 1; i <= bulbRows; i++) ring.push({ x: CAB_X + CAB_W, y: sideY(i) }) // right edge, T→B
    for (let i = bulbCols - 1; i >= 0; i--) ring.push({ x: topX(i), y: CAB_Y + CAB_H }) // bottom edge, R→L
    for (let i = bulbRows; i >= 1; i--) ring.push({ x: CAB_X, y: sideY(i) }) // left edge, B→T
    const rgb = rgbMarquee()
    ring.forEach((p, i) => {
      const tint = i % 2 === 0 ? T.gold : T.rose
      const bulb = this.add.image(p.x, p.y, 'bulb').setDisplaySize(15, 15).setTint(tint)
      cabinet.add(bulb)
      this.bulbs.push(bulb)
      this.bulbTints.push(tint)
      // §RGB — the chase owns tint + alpha, including the power-on: it lands the ring lit on its
      // first frame, so the staggered light-up below would only fight it. `bulbTints` is still
      // recorded because the HEAT pass reads it back when the player switches RGB off.
      if (rgb) return
      if (reduced) {
        bulb.setAlpha(0.85)
        return
      }
      // The steady twinkle — the same numbers setMarquee('idle') runs, so the power-on hands off
      // into exactly the resting choreography.
      const twinkle = (): void => {
        this.tweens.add({
          targets: bulb,
          alpha: reduceFlashing() ? 0.85 : 1,
          duration: 700,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
          delay: (i % 5) * 190,
        })
      }
      if (reduceFlashing()) {
        // Flash-averse (§E8): no power-on chase — the bulbs start lit and just breathe.
        bulb.setAlpha(0.55)
        twinkle()
      } else {
        // Power-on chase: the light-up laps the ring clockwise from the top-left corner — the
        // cabinet "switching on" as the scene arrives. Gentle staggered fades, not strobes.
        bulb.setAlpha(0)
        this.tweens.add({
          targets: bulb,
          alpha: 0.45,
          duration: D.base,
          delay: 140 + i * 28,
          ease: E.settle,
          onComplete: twinkle,
        })
      }
    })
    // One clock for the whole 32-bulb ring, replacing 32 per-bulb tweens. (The previous entry's
    // clock is already unhooked in create()'s per-entry reset.)
    if (rgb) this.rgb = attachRgbChase(this, this.bulbs, { mode: this.marqueeMode })
    fadeRise(this, cabinet, { rise: 18, duration: D.pop, ease: backOut(OVERSHOOT.gentle) })
  }

  /**
   * One reel: SLOT_STRIP_LEN + SLOT_MAX_ROWS cells whose faces are `strip[j % len]`, masked to the
   * window. Because the content is periodic in the strip length, scrolling is a single wrapped offset
   * and the reel spins forever without ever being rebuilt.
   */
  private buildReel(i: number): Reel {
    const strip = SLOT_STRIPS[i]
    const mask = this.make.graphics({ x: 0, y: 0 }, false)
    mask.fillStyle(0xffffff)
    mask.fillRect(this.reelX(i), REELS_TOP, REEL_W, WINDOW_H)
    const container = this.add.container(this.reelX(i) + REEL_W / 2, 0).setDepth(4)
    container.setMask(mask.createGeometryMask())
    const cells: Phaser.GameObjects.Image[] = []
    for (let j = 0; j < SLOT_STRIP_LEN + SLOT_MAX_ROWS; j++) {
      const img = this.add
        .image(0, j * CELL_H + CELL_H / 2, this.faceTexture(strip[j % SLOT_STRIP_LEN]))
        .setDisplaySize(SYMBOL_SIZE, SYMBOL_SIZE)
      container.add(img)
      cells.push(img)
    }
    const reel: Reel = { strip: container, mask, cells, pos: Math.floor(Math.random() * SLOT_STRIP_LEN) }
    this.seatReel(reel)
    return reel
  }

  /** Board symbols are their own texture keys; the scatter is the baked heart. */
  private faceTexture(face: SlotSymbol): string {
    return face === SLOT_CHARM ? CHARM_TEX : face
  }

  /** Park a reel at its current virtual position. The modulo is what makes the wrap invisible. */
  private seatReel(reel: Reel): void {
    reel.strip.y = REELS_TOP - this.stripIndex(reel) * CELL_H
  }

  /** The strip index showing in row 1 of a reel — its position wrapped into [0, SLOT_STRIP_LEN). */
  private stripIndex(reel: Reel): number {
    return ((reel.pos % SLOT_STRIP_LEN) + SLOT_STRIP_LEN) % SLOT_STRIP_LEN
  }

  /** The cell image showing in `row` of a resting reel — the target for a win pop. */
  private cellAt(reel: Reel, row: number): Phaser.GameObjects.Image {
    return reel.cells[this.stripIndex(reel) + row]
  }

  /** Light the lamps and lift the scrims for the rows the current bet bought. */
  private paintRowLamps(): void {
    const T = getTheme()
    this.rowLamps.forEach(({ ring, label }, r) => {
      const live = r < this.rows
      ring.clear()
      ring.fillStyle(live ? T.gold : T.cardFillAlt, live ? 1 : 0.8)
      ring.fillCircle(LAMP_X, this.rowY(r), 17)
      ring.lineStyle(2.5, live ? T.goldDeep : T.border, 1)
      ring.strokeCircle(LAMP_X, this.rowY(r), 17)
      label.setColor(live ? css(T.goldDarkest) : T.inkFaint).setAlpha(live ? 1 : 0.7)
    })
    this.rowScrims.forEach((scrim, r) => scrim.setVisible(r >= this.rows))
  }

  // ─────────────────────────────────────────────────────────────── the controls

  private renderControls(animate = false): void {
    this.killLayerTweens(this.controlLayer)
    this.controlLayer.removeAll(true)
    this.betPills = []
    const T = getTheme()
    const chips = loadSave().chips
    const bet = SLOT_BETS[this.rows - 1]
    const source = this.pullSource()

    // A free pull owns the cabinet: all four rows lit, and the row-buying decision stands down until
    // the gifts are spent (chooseBet says so aloud if tapped).
    if (source !== 'paid' && this.rows !== SLOT_MAX_ROWS) {
      this.rows = SLOT_MAX_ROWS
      this.paintRowLamps()
    }

    // The bet row. Every tier stays TAPPABLE even when it can't be afforded: the payline count and the
    // odds are what the player is choosing between, and hiding the top bet behind the balance would make
    // the one decision this screen offers invisible to exactly whoever most needs to see it. During a
    // free pull the whole row rests dimmed — the choice returns with the paid ladder.
    SLOT_BETS.forEach((b, i) => {
      const x = DESIGN_W / 2 + (i - (SLOT_BETS.length - 1) / 2) * BET_STEP
      const selected = b.rows === this.rows
      const afford = chips >= b.price
      const pill = addPillButton(
        this,
        x,
        BET_Y,
        BET_W,
        62,
        b.rows === 1 ? '1 ROW' : `${b.rows} ROWS`,
        selected ? GOLD_PILL : GHOST_PILL,
        () => this.chooseBet(b)
      )
      if (source !== 'paid') pill.setAlpha(0.5)
      this.controlLayer.add(pill)
      this.betPills.push(pill)
      this.controlLayer.add(
        this.add.image(x - 26, BET_Y + 46, 'chip').setDisplaySize(24, 24).setAlpha(afford ? 1 : 0.4)
      )
      this.controlLayer.add(
        this.add
          .text(x + 2, BET_Y + 46, String(b.price), {
            fontFamily: FONT,
            fontSize: '21px',
            fontStyle: '900',
            color: afford ? T.goldText : T.inkFaint,
          })
          .setOrigin(0, 0.5)
      )
    })

    // The hero. The FREE pulls outrank the ladder — the daily gift first, then the bank — and each
    // names itself so a gift can never be mistaken for a spend. On the paid ladder the price is
    // always on the cap — a spend is never one tap away from being a surprise. Flat broke (with no
    // free pull standing) swaps the whole button for the way OUT of the dead end rather than leaving
    // a wall of ghosted controls with nothing behind them (the Gift Store's S3 rule).
    const broke = chips < SLOT_BETS[0].price
    const afford = chips >= bet.price
    const level = Math.min(loadSave().unlocked, LEVEL_COUNT)
    const bank = loadSave().freeSpins
    const spin =
      source === 'daily'
        ? addPillButton(this, DESIGN_W / 2, SPIN_Y, 320, 96, 'FREE DAILY SPIN', GOLD_PILL, () => this.pull(), { juice: true })
        : source === 'banked'
          ? addPillButton(this, DESIGN_W / 2, SPIN_Y, 320, 96, `FREE SPIN · ×${bank}`, GOLD_PILL, () => this.pull(), { juice: true })
          : broke
            ? addPillButton(this, DESIGN_W / 2, SPIN_Y, 320, 96, 'PLAY', GOLD_PILL, () => startScene(this, 'game', { level }))
            : addPillButton(
                this,
                DESIGN_W / 2,
                SPIN_Y,
                320,
                96,
                afford ? `SPIN · ${bet.price}` : `NEED ${(bet.price - chips).toLocaleString()} MORE`,
                afford ? GOLD_PILL : GHOST_PILL,
                () => (afford ? this.pull() : this.denied()),
                afford ? { juice: true } : {}
              )
    this.controlLayer.add(spin)
    this.spinBtn = spin
    if (animate && !prefersReducedMotion()) {
      spin.setScale(0.8).setAlpha(0)
      this.tweens.add({ targets: spin, scale: 1, alpha: 1, duration: D.pop, delay: 260, ease: backOut(OVERSHOOT.pop) })
      this.betPills.forEach((p, i) => popIn(this, p, { from: 0.7, delay: 140 + i * 60, overshoot: OVERSHOOT.gentle }))
    }
  }

  private chooseBet(bet: SlotBet): void {
    if (this.spinning || bet.rows === this.rows) return
    if (this.pullSource() !== 'paid') {
      // The gift plays the whole cabinet — the ladder is a paid-pull decision.
      this.toast('Free spins play all 4 rows')
      return
    }
    this.rows = bet.rows
    sfx.uiPress()
    this.paintRowLamps()
    this.renderControls()
    this.showIdleCopy()
  }

  /** Kill every tween a rebuildable layer started, recursing into containers (Phaser 3.90 won't). */
  private killLayerTweens(layer: Phaser.GameObjects.Container): void {
    const walk = (obj: Phaser.GameObjects.GameObject): void => {
      this.tweens.killTweensOf(obj)
      if (obj instanceof Phaser.GameObjects.Container) obj.list.forEach(walk)
    }
    layer.list.forEach(walk)
  }

  /** The resting line under the machine: what THIS bet is playing for. */
  private showIdleCopy(): void {
    this.killLayerTweens(this.resultLayer)
    this.resultLayer.removeAll(true)
    const T = getTheme()
    const chips = loadSave().chips
    if (this.pullSource() !== 'paid') {
      // A free pull stands armed — even a broke player has this one, which is the whole point of it.
      const one = Math.round(1 / charmChance(SLOT_MAX_ROWS))
      this.resultLayer.add(
        this.add
          .text(DESIGN_W / 2, RESULT_Y, `all ${SLOT_MAX_ROWS} paylines on the house  ·  charm odds 1 in ${one.toLocaleString()}`, {
            fontFamily: FONT,
            fontSize: '21px',
            color: T.onBackdropMuted,
          })
          .setOrigin(0.5)
      )
      return
    }
    if (chips < SLOT_BETS[0].price) {
      this.resultLayer.add(
        this.add
          .text(DESIGN_W / 2, RESULT_Y, 'Not enough chips — win a level to earn more 💛', {
            fontFamily: FONT,
            fontSize: '23px',
            fontStyle: '900',
            color: T.onBackdropInk,
          })
          .setOrigin(0.5)
      )
      return
    }
    const one = Math.round(1 / charmChance(this.rows))
    this.resultLayer.add(
      this.add
        .text(
          DESIGN_W / 2,
          RESULT_Y,
          `${this.rows} payline${this.rows > 1 ? 's' : ''}  ·  charm odds 1 in ${one.toLocaleString()}`,
          { fontFamily: FONT, fontSize: '21px', color: T.onBackdropMuted }
        )
        .setOrigin(0.5)
    )
  }

  private denied(): void {
    sfx.invalidThud()
    this.toast('Not enough chips')
    const btn = this.spinBtn
    if (prefersReducedMotion() || !btn) return
    const x0 = btn.x
    this.tweens.add({ targets: btn, x: x0 - 6, duration: 50, yoyo: true, repeat: 3, onComplete: () => btn.setX(x0) })
  }

  // ─────────────────────────────────────────────────────────────────── the pull

  private pull(): void {
    if (this.spinning) return
    const source = this.pullSource()
    const rng = mulberry32(this.devSeed ?? (Math.random() * 2 ** 31) | 0)
    this.devSeed = null // one staged pull per ?seed — the next one rolls honestly

    // AWARD-FIRST: the whole result is settled and banked here, before a single reel moves. The
    // source is re-decided from the live save at press time, and the FREE paths can never charge:
    // a raced-away gift simply re-arms the controls on whatever is actually available now.
    let spin: SlotSpin
    let purchase: SlotPurchase | undefined
    let free: FreeSlotSpinResult | undefined
    let price = 0
    if (source === 'paid') {
      const bet = SLOT_BETS[this.rows - 1]
      const res = buySpin(bet.rows, rng)
      if (!res.ok) {
        this.denied()
        return
      }
      purchase = res.purchase
      spin = purchase.spin
      price = bet.price
    } else {
      const res = freeSlotSpin(source, rng)
      if (!res) {
        this.rearm() // the gift raced away (double-tap / midnight edge) — recompute the offer honestly
        return
      }
      free = res
      spin = res.spin
    }
    this.spinning = true
    // {rows, price} against {lines, boosts, points, charm} is the question the whole bet ladder rests
    // on: whether players actually climb it, and whether the tier they settle on is the one paying
    // them. `free` marks the gift pulls ('daily' | 'banked') so the funnel can split ritual from spend.
    track(EVENTS.SLOTS_SPUN, {
      rows: spin.bet.rows,
      price,
      free: source === 'paid' ? undefined : source,
      lines: spin.lines.length,
      boosts: spin.boosts.length,
      points: spin.points,
      charm: spin.charm,
    })

    this.killLayerTweens(this.resultLayer)
    this.resultLayer.removeAll(true)
    this.spinBtn?.setVisible(false)
    this.betPills.forEach(p => p.setAlpha(0.45))
    if (purchase) this.balance.update(purchase.balance) // a free pull moves no chips until its receipts land
    this.paintSubtitle()

    // The machine answers the press instantly: the attract loop stands down, the whole marquee snaps
    // into its travelling spin chase, and a light-wipe sweeps the glass as the reels take off.
    this.attractTimer?.remove(false)
    this.attractTimer = undefined
    this.setMarquee('spin')
    if (!prefersReducedMotion() && quality.tier() !== 'low') {
      const wipe = this.add
        .image(REELS_X - 70, REELS_TOP + WINDOW_H / 2, 'sweep')
        .setDisplaySize(80, WINDOW_H + 40)
        .setAngle(10)
        .setTint(getTheme().goldBright)
        .setAlpha(0.3)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(7)
      this.tweens.add({
        targets: wipe,
        x: REELS_X + REELS_W + 70,
        duration: 340,
        ease: 'Sine.easeInOut',
        onComplete: () => wipe.destroy(),
      })
    }

    this.runReels(spin, () => {
      if (purchase) this.settle(purchase)
      else if (free) this.settleFree(source as FreeSlotKind, free)
    })
  }

  /** Scroll every reel to its rolled stop, left→right, and call `onDone` when the last one detents. */
  private runReels(spin: SlotSpin, onDone: () => void): void {
    const reduced = prefersReducedMotion()
    const stretch = !reduced && quality.tier() !== 'low'
    // THE HEAT — read off the already-settled result, never rolled for: does this spin carry a
    // tension story for the final reels? Three honest triggers, best first: the charm actually hit
    // (all three hearts — the last reel's crawl gets the full show); two hearts landed on reels 1+3
    // with the 5th still spinning (a real near-miss in flight, resolved however it was rolled); or a
    // settled line runs 4+ deep (the crawl completes a big run). Pure theatre over a banked result.
    const twoHearts = spin.scatters.some(([, r]) => r === 0) && spin.scatters.some(([, r]) => r === 2)
    const heat = spin.charm || twoHearts || spin.lines.some(l => l.run >= 4)
    let landed = 0
    const finish = (): void => {
      landed++
      // The heat ignites the moment the third reel locks — hearts 1+3 (or the long run) are on the
      // glass and everything now rides the last two columns.
      if (landed === 3 && heat && !reduced) this.igniteHeat()
      if (landed === SLOT_REELS) onDone()
    }
    if (!reduced) sfx.reelSweep()

    this.reels.forEach((reel, i) => {
      // Travel: whatever it takes to reach the rolled stop, plus (i + 1) whole strips — so reels to the
      // right run further as well as longer, and the row stops in a left-to-right ripple.
      const delta = (((spin.stops[i] - reel.pos) % SLOT_STRIP_LEN) + SLOT_STRIP_LEN) % SLOT_STRIP_LEN
      const target = reel.pos + delta + (i + 1) * SLOT_STRIP_LEN
      const isLast = i === SLOT_REELS - 1
      // A heat spin gives the final reel a longer, tick-counted crawl — the machine leaning in.
      const travel = SPIN_MS + i * SPIN_STEP_MS + (isLast && heat ? 620 : 0)
      const land = (): void => {
        reel.pos = target
        this.seatReel(reel)
        this.landReel(i, isLast, reduced)
        finish()
      }
      // §E8: reduced motion settles instantly and correctly — no travel, no suspense wobble. The
      // detent audio still lands (sound is never "motion").
      if (reduced) {
        land()
        return
      }
      // Fake motion blur: the strip rides slightly stretched while it travels and relaxes into rest
      // on the same deceleration curve, so the symbols visibly "unsmear" as the reel slows. Transform
      // only — the geometry mask keeps everything inside the glass, and the stretch ends exactly with
      // the travel, so the detent seats at scale 1.
      if (stretch) {
        reel.strip.scaleY = 1.05
        this.tweens.add({ targets: reel.strip, scaleY: 1, duration: travel, ease: 'Cubic.easeOut' })
      }
      const state = { p: reel.pos }
      const apply = (): void => {
        reel.pos = state.p
        this.seatReel(reel)
      }
      if (isLast) {
        // The classic suspense beat on the final reel: a long decel that overshoots the detent under
        // a crawl of decelerating detent ticks, then a short spring back into it. The chain ENDS on
        // `target`, so the settled result is untouched.
        for (const at of heat ? [180, 400, 650, 930, 1240, 1580, 1950, 2250] : [150, 340, 560, 810, 1090, 1400]) {
          this.time.delayedCall(at, () => sfx.scoreTick()) // audio only — never gated on flashing
        }
        this.tweens.chain({
          targets: state,
          tweens: [
            { p: target + 0.35, duration: travel, ease: 'Cubic.easeOut', onUpdate: apply },
            { p: target, duration: 280, ease: backOut(OVERSHOOT.pop), onUpdate: apply },
          ],
          onComplete: land,
        })
      } else {
        this.tweens.add({
          targets: state,
          p: target,
          duration: travel,
          ease: 'Cubic.easeOut',
          onUpdate: apply,
          onComplete: land,
        })
      }
    })
  }

  /**
   * The HEAT beat — fired the instant the third reel locks with tension still in flight, living only
   * until the last reel lands (landReel sweeps heatFx). The whole ring burns rose and quickens, a
   * charge cue rises twice, and the final column ignites under a breathing rose glow so every eye is
   * on the reel that's still crawling. Never runs under reduced motion (caller-gated); reduce-flashing
   * slows the glow's breathe ≥520ms and shrinks its swing.
   */
  private igniteHeat(): void {
    const T = getTheme()
    const soft = reduceFlashing()
    this.setMarquee('heat')
    sfx.charge(2)
    this.time.delayedCall(650, () => {
      if (this.marqueeMode === 'heat') sfx.charge(3) // second lift only while the crawl still runs
    })
    const lastX = this.reelX(SLOT_REELS - 1) + REEL_W / 2
    const glow = this.add
      .image(lastX, REELS_TOP + WINDOW_H / 2, 'bgglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.rose)
      .setDisplaySize(REEL_W * 2.1, WINDOW_H * 1.15)
      .setAlpha(soft ? 0.16 : 0.1)
      .setDepth(7)
    this.heatFx.push(glow)
    this.tweens.add({
      targets: glow,
      alpha: soft ? 0.28 : 0.38,
      duration: soft ? 520 : 300,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  /** Per-reel detent: a panned clunk, a haptic, a settle kick — and the cabinet takes the hit. */
  private landReel(i: number, isLast: boolean, reduced: boolean): void {
    sfx.reelClunk(((i - (SLOT_REELS - 1) / 2) / SLOT_REELS) * 1.2)
    if (!hapticsOff()) vibratePattern(isLast ? [12, 36, 16] : 10)
    // The final land retires the HEAT transients — the crawl is over, the answer is on the glass.
    if (isLast) {
      for (const fx of this.heatFx.splice(0)) {
        this.tweens.killTweensOf(fx)
        fx.destroy()
      }
    }
    if (reduced) return
    this.cameras.main.shake(isLast ? 80 : 50, isLast ? 0.005 : 0.003)
    // Mechanical detent: the cabinet frame takes a 3px kick that springs straight back, so every
    // stop lands in the furniture, not just the strip. Kill-then-zero keeps rapid stops from
    // compounding the offset.
    this.tweens.killTweensOf(this.cabinet)
    this.cabinet.y = 0
    this.tweens.chain({
      targets: this.cabinet,
      tweens: [
        { y: 3, duration: 45, ease: 'Quad.easeOut' },
        { y: 0, duration: 110, ease: backOut(OVERSHOOT.gentle) },
      ],
    })
    if (quality.tier() !== 'low') {
      const T = getTheme()
      // Detent shockwave — a gold ring bursts off the column that just locked (bigger on the final).
      const wave = this.add
        .image(this.reelX(i) + REEL_W / 2, REELS_TOP + WINDOW_H / 2, 'shockwave')
        .setDisplaySize(110, 110)
        .setTint(T.goldBright)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(0.7)
        .setDepth(7)
      this.tweens.add({
        targets: wave,
        scale: wave.scale * (isLast ? 2.6 : 2.0),
        alpha: 0,
        duration: 340,
        ease: E.settle,
        onComplete: () => wave.destroy(),
      })
      if (isLast && !reduceFlashing()) {
        // One soft glass bloom across the window as the machine locks (a bloom, not a strobe — and
        // skipped entirely for flash-averse players).
        const flash = this.add
          .image(REELS_X + REELS_W / 2, REELS_TOP + WINDOW_H / 2, 'bgglow')
          .setTint(0xffffff)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(REELS_W * 1.15, WINDOW_H * 1.1)
          .setAlpha(0.26)
          .setDepth(7)
        this.tweens.add({ targets: flash, alpha: 0, duration: 170, ease: 'Quad.easeOut', onComplete: () => flash.destroy() })
      }
    }
  }

  // ──────────────────────────────────────────────────────────────── the result

  private settle(purchase: SlotPurchase): void {
    this.presentResult(purchase.spin, {
      meter: purchase.meter,
      charmAward: purchase.charm,
      extraParts: [],
    })
  }

  /**
   * A FREE pull's settle — the same presentation spine as a paid one, with the gift receipts on top:
   * the GIFT FLOOR and the day-5 double join the prize list, and a DAILY pull banks its check-in
   * chips with a rose "+N CHIPS" beat, repaints the streak into the subtitle, and blooms the
   * Heartbloom (ported from the retired daily cabinet — the ritual's signature moment lives with the
   * ritual). A free pull with the floor can never reach showMiss: it always has something to say.
   */
  private settleFree(kind: FreeSlotKind, res: FreeSlotSpinResult): void {
    const extraParts: string[] = []
    if (res.milestone) extraParts.push(`DAY-5 DOUBLE: ${res.milestone.label}`)
    if (res.comp) extraParts.push(`ON THE HOUSE: ${res.comp.label}`)
    this.presentResult(res.spin, {
      meter: res.meter,
      charmAward: res.charm,
      extraParts,
      onShown: () => {
        if (kind !== 'daily') return
        const T = getTheme()
        // The ritual's receipts: the heart of light over the cabinet, then the chips (the streak
        // line itself is paintSubtitle's job — it holds "🔥 day N" for the rest of the visit).
        this.heartbloom(REELS_X + REELS_W / 2, REELS_TOP + WINDOW_H / 2)
        if (res.checkinChips && res.checkinChips > 0) {
          sfx.coinCount()
          this.balance.update(loadSave().chips)
          const chipLine = this.add
            .text(DESIGN_W / 2, RESULT_Y + 104, `+${res.checkinChips.toLocaleString()} CHIPS · day ${res.streak}`, {
              fontFamily: FONT,
              fontSize: '28px',
              fontStyle: '900',
              color: css(T.roseLight),
            })
            .setOrigin(0.5)
            .setShadow(0, 2, 'rgba(0,0,0,0.15)', 5, false, true)
          this.resultLayer.add(chipLine)
          if (!prefersReducedMotion()) {
            chipLine.setScale(0)
            this.tweens.add({ targets: chipLine, scale: 1, duration: 300, delay: 140, ease: 'Back.easeOut' })
          }
        }
      },
    })
  }

  /**
   * The shared payout spine: meter, line-by-line light-up, scatter pops, prize copy, celebration
   * scale, charm reveal, re-arm. `extraParts` joins the prize list (gift receipts); `onShown` fires
   * with the prize copy so a caller can layer its own receipts on the same beat.
   */
  private presentResult(
    spin: SlotSpin,
    opts: { meter: number; charmAward?: SlotPurchase['charm']; extraParts: string[]; onShown?: () => void }
  ): void {
    this.meter.update(opts.meter, spin.points > 0)

    if (spin.lines.length === 0 && !spin.charm && opts.extraParts.length === 0) {
      this.showMiss()
      this.rearm()
      return
    }

    // The machine takes the payout: the marquee flips to the alternating WIN chase for the opening
    // bars, then relaxes back to idle (unless a chained pull has already re-armed it elsewhere).
    this.setMarquee('win')
    this.time.delayedCall(2600, () => {
      if (this.marqueeMode === 'win') this.setMarquee('idle')
    })

    // Lines light one after another, topmost row first, so a multi-line win is read rather than dumped
    // on screen all at once. The prize copy lands after the last of them.
    spin.lines.forEach((line, i) => {
      this.time.delayedCall(i * 260, () => {
        if (!this.scene.isActive()) return
        this.showLine(line.row, line.run)
        sfx.starDing(Math.min(3, i + 1))
      })
    })
    if (spin.charm) {
      this.time.delayedCall(spin.lines.length * 260, () => {
        if (this.scene.isActive()) this.popScatters(spin)
      })
    }

    this.time.delayedCall(spin.lines.length * 260 + (spin.charm ? 420 : 140), () => {
      if (!this.scene.isActive()) return
      this.showPrizes(spin, opts.extraParts)
      opts.onShown?.()
      const paid = spin.boosts.length + opts.extraParts.length
      if (spin.lines.some(l => l.run >= SLOT_REELS) || paid >= 3) {
        sfx.winFanfare()
        this.confetti()
      } else if (spin.lines.length > 0 || paid > 0) {
        sfx.coinCount()
      }
      // COIN FOUNTAIN — any real payout erupts off the cabinet and rains back down (governor-scaled;
      // a single small line keeps its quieter dignity).
      if (!prefersReducedMotion() && quality.tier() !== 'low' && (paid >= 2 || spin.charm)) {
        const coins = this.add
          .particles(0, 0, 'chip', {
            speed: { min: 300, max: 620 },
            angle: { min: 245, max: 295 },
            scale: { start: 0.75, end: 0.5 },
            alpha: { start: 1, end: 0.85 },
            lifespan: { min: 900, max: 1400 },
            gravityY: 1050,
            rotate: { min: -240, max: 240 },
            emitting: false,
          })
          .setDepth(43)
        coins.explode(quality.count(14), REELS_X + REELS_W / 2, REELS_TOP + WINDOW_H / 2)
        this.time.delayedCall(1700, () => coins.destroy())
      }
      // The charm reveal owns the re-arm: the machine comes back when the player dismisses the card.
      if (opts.charmAward) this.revealCharm(opts.charmAward)
      else this.rearm()
    })
  }

  /**
   * The HEARTBLOOM (§E4) — the daily claim's signature: a giant translucent heart of light blooms
   * from the cabinet, BEATS TWICE (lub-DUB), under the Maya leitmotif. Ported intact from the retired
   * daily cabinet. Reduced motion: a single static heart of light + the motif.
   */
  private heartbloom(cx: number, cy: number): void {
    sfx.mayaMotif() // the leitmotif rings in BOTH motion modes — audio is never "motion"
    const glow = this.add
      .image(cx, cy, 'heartglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(47)
      .setTint(getTheme().bloom)
      .setDisplaySize(520, 520)
    const base = glow.scaleX
    if (prefersReducedMotion()) {
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
  }

  /** Put the machine back in the player's hands: bet row live, hero back, offer + copy refreshed. */
  private rearm(): void {
    this.spinning = false
    this.renderControls()
    this.paintSubtitle()
    this.armAttract()
  }

  /** Draw the gold payline bar over a winning run, sweep a win beam down it, and pop its symbols. */
  private showLine(row: number, run: number): void {
    const T = getTheme()
    const x0 = this.reelX(0)
    const x1 = this.reelX(run - 1) + REEL_W
    const y = this.rowY(row)
    const g = this.add.graphics().setDepth(8)
    g.fillStyle(T.gold, 0.14)
    g.fillRoundedRect(x0 - 5, y - CELL_H / 2 + 6, x1 - x0 + 10, CELL_H - 12, 18)
    g.lineStyle(3.5, T.gold, 0.95)
    g.strokeRoundedRect(x0 - 5, y - CELL_H / 2 + 6, x1 - x0 + 10, CELL_H - 12, 18)
    this.resultLayer.add(g)
    if (prefersReducedMotion()) return
    this.tweens.add({ targets: g, alpha: 0.55, duration: 620, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    if (quality.tier() !== 'low') {
      // WIN BEAM — one gold shine rides the paying line left→right, reading the win out. Transient.
      const beam = this.add
        .image(x0 - 50, y, 'sweep')
        .setDisplaySize(56, CELL_H + 26)
        .setTint(T.goldBright)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(0.5)
        .setDepth(9)
      this.tweens.add({
        targets: beam,
        x: x1 + 50,
        duration: 400,
        ease: 'Sine.easeInOut',
        onComplete: () => beam.destroy(),
      })
    }
    for (let reel = 0; reel < run; reel++) {
      const img = this.cellAt(this.reels[reel], row)
      const base = img.scaleX
      this.tweens.add({
        targets: img,
        scale: base * 1.18,
        duration: 180,
        delay: reel * 55,
        yoyo: true,
        ease: E.settle,
        onComplete: () => img.setScale(base),
      })
    }
  }

  /** Ring and pop each heart. The scatter pays by position rather than by line, so it gets its own beat. */
  private popScatters(spin: SlotSpin): void {
    const T = getTheme()
    for (const [row, reel] of spin.scatters) {
      const g = this.add.graphics().setDepth(8)
      g.lineStyle(4, T.rose, 0.95)
      g.strokeCircle(this.reelX(reel) + REEL_W / 2, this.rowY(row), CELL_H * 0.42)
      this.resultLayer.add(g)
      if (prefersReducedMotion()) continue
      this.tweens.add({ targets: g, alpha: 0.4, duration: 480, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      const img = this.cellAt(this.reels[reel], row)
      const base = img.scaleX
      this.tweens.add({
        targets: img,
        scale: base * 1.25,
        duration: 220,
        yoyo: true,
        ease: E.settle,
        onComplete: () => img.setScale(base),
      })
    }
    sfx.jackpotStrike()
  }

  private showMiss(): void {
    const T = getTheme()
    const text = this.add
      .text(DESIGN_W / 2, RESULT_Y, 'No line this time', {
        fontFamily: FONT,
        fontSize: '24px',
        fontStyle: '900',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)
    this.resultLayer.add(text)
    // More rows is the honest answer to a miss, so say it — but only while there is a row left to buy.
    if (this.rows < SLOT_MAX_ROWS) {
      this.resultLayer.add(
        this.add
          .text(DESIGN_W / 2, RESULT_Y + 34, `${SLOT_MAX_ROWS} rows plays ${SLOT_MAX_ROWS} paylines`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '18px',
            color: T.onBackdropMuted,
          })
          .setOrigin(0.5)
      )
    }
    if (!prefersReducedMotion()) fadeRise(this, text, { rise: 12, duration: D.base, ease: E.settle })
  }

  /** The payout readout: what went into the boost pile, onto the meter — and any gift receipts. */
  private showPrizes(spin: SlotSpin, extraParts: string[] = []): void {
    const T = getTheme()
    const parts: string[] = []
    // Grouped by boost type, so "WILD REEL ×2" reads as one prize rather than two identical lines.
    for (const item of BOOST_ITEMS) {
      const n = spin.boosts.filter(b => b === item.type).length
      if (n > 0) parts.push(n > 1 ? `${item.label} ×${n}` : item.label)
    }
    if (spin.points > 0) parts.push(`+${spin.points} JACKPOT`)
    // The charm is listed here as well as celebrated on its own card, so the readout still says what
    // the spin paid once that card is dismissed — a scatter with no line behind it would otherwise
    // leave the machine looking like it had just missed.
    if (spin.charm) parts.push('A CHARM')
    parts.push(...extraParts) // gift receipts (the house floor / the day-5 double) join the same list
    if (parts.length === 0) return

    const headline =
      spin.charm ? 'A CHARM!'
      : spin.lines.some(l => l.run >= SLOT_REELS) ? 'BIG WIN!'
      : spin.lines.length > 0 ? 'WIN!'
      : 'A GIFT!' // the floor / milestone paid while the reels themselves missed
    const title = this.add
      .text(DESIGN_W / 2, RESULT_Y - 16, headline, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
    const body = this.add
      .text(DESIGN_W / 2, RESULT_Y + 24, parts.join('  ·  '), {
        fontFamily: FONT,
        fontSize: '22px',
        color: T.onBackdropInk,
        align: 'center',
        wordWrap: { width: 620 },
        lineSpacing: 4,
      })
      .setOrigin(0.5)
    // Where the prize actually went — only claimed when a boost really was banked, so a points-only or
    // charm-only spin never promises a power-up that isn't there.
    const note = this.add
      .text(
        DESIGN_W / 2,
        RESULT_Y + 68,
        spin.boosts.length > 0 ? 'Power-ups are waiting for your next level' : 'Banked — the wheel fires on your next win',
        { fontFamily: 'Arial, sans-serif', fontSize: '17px', color: T.onBackdropMuted }
      )
      .setOrigin(0.5)
      .setVisible(spin.boosts.length > 0 || spin.points > 0)
    this.resultLayer.add([title, body, note])
    if (prefersReducedMotion()) return
    popIn(this, title, { from: 0.5, overshoot: OVERSHOOT.pop })
    fadeRise(this, body, { rise: 14, duration: D.base, ease: E.settle, delay: 90 })
    if (note.visible) fadeRise(this, note, { rise: 10, duration: D.base, ease: E.settle, delay: 170 })
  }

  private confetti(): void {
    if (prefersReducedMotion() || reduceFlashing()) return
    const n = quality.count(30)
    if (n === 0) return
    const p = this.add
      .particles(0, 0, 'confetti', {
        speed: { min: 180, max: 460 },
        angle: { min: 230, max: 310 },
        scale: { start: 1.1, end: 0.4 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 700, max: 1400 },
        gravityY: 420,
        rotate: { min: -180, max: 180 },
        emitting: false,
      })
      .setDepth(45)
    p.explode(n, DESIGN_W / 2, CAB_Y + CAB_H / 2)
    this.time.delayedCall(1700, () => p.destroy())
  }

  // ──────────────────────────────────────────────────────────────── the charm

  /**
   * The scatter's payoff, as its own full-screen moment.
   *
   * Already banked by `buySpin` before the reels moved — this is a reveal, not a grant, so tapping away
   * cannot cost anything. A duplicate (an album already full) is celebrated on its own terms rather than
   * shown as a failure: it paid chips, and that is what the card says.
   */
  private revealCharm(award: NonNullable<SlotPurchase['charm']>): void {
    const T = getTheme()
    const layer = this.add.container(0, 0).setDepth(70)
    const cy = viewportCenterY()
    const cardW = 560
    const cardH = 520
    const scrim = this.add.rectangle(DESIGN_W / 2, cy, DESIGN_W, worldH(), T.scrim, 0.72).setInteractive()
    layer.add(scrim)

    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.2)
    g.fillRoundedRect(DESIGN_W / 2 - cardW / 2 + 4, cy - cardH / 2 + 10, cardW, cardH, 30)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(DESIGN_W / 2 - cardW / 2, cy - cardH / 2, cardW, cardH, 30)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(DESIGN_W / 2 - cardW / 2, cy - cardH / 2, cardW, cardH, 30)
    layer.add(g)

    layer.add(
      this.add
        .text(DESIGN_W / 2, cy - cardH / 2 + 56, `${SLOT_SCATTER_NEEDED} HEARTS`, {
          fontFamily: FONT,
          fontSize: '21px',
          fontStyle: '900',
          color: T.inkMuted,
        })
        .setOrigin(0.5)
        .setLetterSpacing(3)
    )
    layer.add(
      this.add
        .text(DESIGN_W / 2, cy - cardH / 2 + 106, award.kind === 'charm' ? 'A CHARM!' : 'ALBUM FULL', {
          fontFamily: FONT,
          fontSize: '46px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
    )

    const glyph = this.add
      .text(DESIGN_W / 2, cy - 20, award.kind === 'charm' ? award.charm.emoji : '💛', {
        fontFamily: 'sans-serif',
        fontSize: '128px',
      })
      .setOrigin(0.5)
    layer.add(glyph)

    const blurb =
      award.kind === 'charm'
        ? award.completed
          ? `${award.charm.label} completes the album — +${award.purse.toLocaleString()} chips, and a fresh series begins`
          : `${award.charm.label} joins your album — ${award.owned}/9`
        : `Every charm is already yours, so the hearts paid ${award.chips} chips instead`
    layer.add(
      this.add
        .text(DESIGN_W / 2, cy + 106, blurb, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '23px',
          color: T.inkSoft,
          align: 'center',
          wordWrap: { width: cardW - 80 },
          lineSpacing: 5,
        })
        .setOrigin(0.5)
    )

    const close = (): void => {
      this.killLayerTweens(layer)
      layer.destroy(true)
      // A duplicate or a completed series pays chips, so the pill has to re-read the save, not the
      // pre-award balance the spin returned.
      this.balance.update(loadSave().chips)
      this.rearm()
    }
    layer.add(addPillButton(this, DESIGN_W / 2, cy + cardH / 2 - 62, 260, 68, 'LOVELY', GOLD_PILL, close))
    scrim.on('pointerup', close)

    sfx.mayaMotif()
    if (!prefersReducedMotion()) {
      popIn(this, glyph, { from: 0.2, overshoot: OVERSHOOT.pop })
      this.confetti()
    }
  }

  // ─────────────────────────────────────────────────────────────── the paytable

  /**
   * What the machine pays, in full.
   *
   * Not a nicety. Every claim this screen makes — "more rows is better odds", "three hearts is a charm",
   * "a run of five pays four power-ups" — is checkable here, and a machine that asks for earned currency
   * owes the player that. Every number is read from core/slots.ts rather than retyped, so the panel
   * cannot drift away from the machine it describes.
   */
  private openPaytable(): void {
    const T = getTheme()
    const layer = this.add.container(0, 0).setDepth(72)
    const cy = viewportCenterY()
    const cardW = 640
    const cardH = 940
    const left = DESIGN_W / 2 - cardW / 2
    const top = cy - cardH / 2

    const scrim = this.add.rectangle(DESIGN_W / 2, cy, DESIGN_W, worldH(), T.scrim, 0.68).setInteractive()
    layer.add(scrim)
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.2)
    g.fillRoundedRect(left + 4, top + 10, cardW, cardH, 30)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(left, top, cardW, cardH, 30)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(left, top, cardW, cardH, 30)
    layer.add(g)
    // Swallow taps on the card so a mis-hit inside it doesn't dismiss through to the scrim.
    layer.add(this.add.rectangle(DESIGN_W / 2, cy, cardW, cardH, 0xffffff, 0.001).setInteractive())

    layer.add(
      this.add
        .text(DESIGN_W / 2, top + 54, 'WHAT IT PAYS', {
          fontFamily: FONT,
          fontSize: '34px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2)
    )
    layer.add(
      this.add
        .text(DESIGN_W / 2, top + 96, `${SLOT_MIN_RUN}+ matching from reel 1, on a LIT payline. Dark rows never pay.`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '18px',
          color: T.inkSoft,
          align: 'center',
          wordWrap: { width: cardW - 70 },
        })
        .setOrigin(0.5)
    )

    const colX = [left + 320, left + 440, left + 560]
    ;['×3', '×4', '×5'].forEach((h, i) =>
      layer.add(
        this.add
          .text(colX[i], top + 144, h, { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.inkMuted })
          .setOrigin(0.5)
      )
    )

    const rowTop = top + 186
    const rowH = 68
    SLOT_PAYS.forEach((pay, i) => {
      const y = rowTop + i * rowH
      layer.add(this.add.image(left + 56, y, this.faceTexture(pay.symbol)).setDisplaySize(50, 50))
      layer.add(
        this.add
          .text(left + 92, y, BOOST_ITEMS.find(b => b.type === pay.boost)?.label ?? pay.boost, {
            fontFamily: FONT,
            fontSize: '19px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0, 0.5)
      )
      pay.runs.forEach((run, r) =>
        layer.add(
          this.add
            .text(colX[r], y, run.points > 0 ? `${run.boosts} +${run.points}` : String(run.boosts), {
              fontFamily: FONT,
              fontSize: '20px',
              fontStyle: '900',
              color: T.goldText,
            })
            .setOrigin(0.5)
        )
      )
    })

    const legendY = rowTop + SLOT_PAYS.length * rowH + 4
    layer.add(
      this.add
        .text(DESIGN_W / 2, legendY, 'number = power-ups  ·  +n = jackpot points', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    // The scatter gets its own block: it is the only prize that ignores paylines entirely, and the only
    // one whose odds move with the bet — which is the whole argument for buying rows.
    const scatterY = legendY + 44
    layer.add(this.add.image(left + 56, scatterY + 22, CHARM_TEX).setDisplaySize(50, 50))
    layer.add(
      this.add
        .text(left + 92, scatterY, `${SLOT_SCATTER_NEEDED} HEARTS ANYWHERE = A CHARM`, {
          fontFamily: FONT,
          fontSize: '19px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0, 0.5)
    )
    layer.add(
      this.add
        .text(
          left + 92,
          scatterY + 20,
          `Hearts land on reels ${SCATTER_REELS.map(r => r + 1).join(', ')} only, and pay wherever they fall on a lit row.`,
          { fontFamily: 'Arial, sans-serif', fontSize: '16px', color: T.inkSoft, wordWrap: { width: cardW - 150 }, lineSpacing: 3 }
        )
        .setOrigin(0, 0)
    )

    // The odds ladder, spelled out — the exact claim the bet row makes, so the exact claim that has to
    // be checkable. Two per line, so the whole ladder is one glance instead of a column to scan.
    const oddsY = scatterY + 96
    const odds = SLOT_BETS.map(
      b => `${b.rows} row${b.rows > 1 ? 's' : ''} · 1 in ${Math.round(1 / charmChance(b.rows)).toLocaleString()}`
    )
    layer.add(
      this.add
        .text(DESIGN_W / 2, oddsY, 'CHARM ODDS', { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: T.inkMuted })
        .setOrigin(0.5)
        .setLetterSpacing(2)
    )
    layer.add(
      this.add
        .text(DESIGN_W / 2, oddsY + 26, `${odds[0]}      ${odds[1]}\n${odds[2]}      ${odds[3]}`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '17px',
          color: T.inkSoft,
          align: 'center',
          lineSpacing: 6,
        })
        .setOrigin(0.5, 0)
    )

    layer.add(
      this.add
        .text(DESIGN_W / 2, top + cardH - 100, `Jackpot points charge the wheel — ${JACKPOT_GOAL} fires it on your next win.`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '17px',
          color: T.inkFaint,
          align: 'center',
          wordWrap: { width: cardW - 80 },
        })
        .setOrigin(0.5)
    )

    const close = (): void => {
      this.killLayerTweens(layer)
      layer.destroy(true)
    }
    layer.add(addPillButton(this, DESIGN_W / 2, top + cardH - 50, 240, 64, 'GOT IT', GOLD_PILL, close))
    scrim.on('pointerup', close)
    sfx.whoosh()
    if (!prefersReducedMotion()) {
      layer.setAlpha(0)
      this.tweens.add({ targets: layer, alpha: 1, duration: D.base, ease: E.settle })
    }
  }

  // ───────────────────────────────────────────────────────────────────── juice

  private toast(msg: string): void {
    const T = getTheme()
    const t = this.add
      .text(DESIGN_W / 2, DESIGN_H - 120, msg, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.warn })
      .setOrigin(0.5)
      .setDepth(75)
    if (prefersReducedMotion()) {
      this.time.delayedCall(1100, () => t.destroy())
      return
    }
    t.setAlpha(0).setY(t.y + 12)
    this.tweens.add({ targets: t, alpha: 1, y: DESIGN_H - 120, duration: 180, ease: 'Back.easeOut' })
    this.tweens.add({ targets: t, alpha: 0, delay: 950, duration: 320, onComplete: () => t.destroy() })
  }
}

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_H, DESIGN_W, restScrollY, viewportCenterY, worldH } from '../config'
import { EVENTS, track } from '../core/analytics'
import { LEVEL_COUNT } from '../core/levels'
import { mulberry32 } from '../core/rng'
import { loadSave } from '../core/save'
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
import { BOOST_ITEMS, buySpin } from '../core/store'
import type { SlotPurchase } from '../core/store'
import { addCasinoBackdrop } from '../view/background'
import { vibratePattern } from '../view/haptics'
import { addJackpotMeter } from '../view/jackpot'
import type { JackpotMeter } from '../view/jackpot'
import { D, E, OVERSHOOT, backOut, fadeRise, popIn } from '../view/motion'
import { quality } from '../view/quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from '../view/theme'
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

    this.cameras.main.setScroll(0, restScrollY())
    this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    applyEntrance(this)
    addCasinoBackdrop(this, 'home')
    ensureGlyphTexture(this, CHARM_TEX, '❤️', 104, 128)
    const T = getTheme()

    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => {
      if (!this.spinning) startScene(this, 'store', undefined, 'back')
    })
    this.add
      .text(DESIGN_W / 2, 130, 'LUCKY SLOTS', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: '#ffffff' })
      .setOrigin(0.5)
      .setLetterSpacing(4)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
      .setTint(T.goldBright, T.goldBright, T.goldDeep, T.goldDeep)
    this.add
      .text(DESIGN_W / 2, 184, 'Buy rows — every row is another payline', {
        fontFamily: FONT,
        fontSize: '23px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)

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
    // Open on the best bet the balance can actually cover — the machine's designed shape and its best
    // odds — falling back to the full cabinet when nothing is affordable, so a broke player still sees
    // what they are working toward rather than a collapsed one-row stub.
    const affordable = SLOT_BETS.filter(b => save.chips >= b.price)
    this.rows = affordable.length > 0 ? affordable[affordable.length - 1].rows : SLOT_MAX_ROWS
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

    track(EVENTS.SLOTS_OPENED, { chips: save.chips, rows: this.rows })
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

    // Marquee bulbs along the top and bottom edges, inset past the corner radius so every bulb sits
    // centred on the stroke instead of floating off a curved corner (the same rule as Daily's cabinet).
    const bulbCols = 11
    const run = CAB_W - CAB_R * 2
    for (const by of [CAB_Y, CAB_Y + CAB_H]) {
      for (let i = 0; i < bulbCols; i++) {
        const bulb = this.add
          .image(CAB_X + CAB_R + (run * i) / (bulbCols - 1), by, 'bulb')
          .setDisplaySize(15, 15)
          .setTint(i % 2 === 0 ? T.gold : T.rose)
        cabinet.add(bulb)
        if (reduced) {
          bulb.setAlpha(0.85)
          continue
        }
        bulb.setAlpha(reduceFlashing() ? 0.55 : 0.45)
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
    }
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

    // The bet row. Every tier stays TAPPABLE even when it can't be afforded: the payline count and the
    // odds are what the player is choosing between, and hiding the top bet behind the balance would make
    // the one decision this screen offers invisible to exactly whoever most needs to see it.
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

    // The hero. Three states, and the price is always on the cap — a spend is never one tap away from
    // being a surprise. Flat broke swaps the whole button for the way OUT of the dead end rather than
    // leaving a wall of ghosted controls with nothing behind them (the Gift Store's S3 rule).
    const broke = chips < SLOT_BETS[0].price
    const afford = chips >= bet.price
    const level = Math.min(loadSave().unlocked, LEVEL_COUNT)
    const spin = broke
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
    const bet = SLOT_BETS[this.rows - 1]
    // AWARD-FIRST: the whole result is settled and banked here, before a single reel moves.
    const res = buySpin(bet.rows, mulberry32((Math.random() * 2 ** 31) | 0))
    if (!res.ok) {
      this.denied()
      return
    }
    this.spinning = true
    const { purchase } = res
    // {rows, price} against {lines, boosts, points, charm} is the question the whole bet ladder rests
    // on: whether players actually climb it, and whether the tier they settle on is the one paying them.
    track(EVENTS.SLOTS_SPUN, {
      rows: bet.rows,
      price: bet.price,
      lines: purchase.spin.lines.length,
      boosts: purchase.spin.boosts.length,
      points: purchase.spin.points,
      charm: purchase.spin.charm,
    })

    this.killLayerTweens(this.resultLayer)
    this.resultLayer.removeAll(true)
    this.spinBtn?.setVisible(false)
    this.betPills.forEach(p => p.setAlpha(0.45))
    this.balance.update(purchase.balance)

    this.runReels(purchase.spin, () => this.settle(purchase))
  }

  /** Scroll every reel to its rolled stop, left→right, and call `onDone` when the last one detents. */
  private runReels(spin: SlotSpin, onDone: () => void): void {
    const reduced = prefersReducedMotion()
    let landed = 0
    const finish = (): void => {
      landed++
      if (landed === SLOT_REELS) onDone()
    }
    if (!reduced) sfx.reelSweep()

    this.reels.forEach((reel, i) => {
      // Travel: whatever it takes to reach the rolled stop, plus (i + 1) whole strips — so reels to the
      // right run further as well as longer, and the row stops in a left-to-right ripple.
      const delta = (((spin.stops[i] - reel.pos) % SLOT_STRIP_LEN) + SLOT_STRIP_LEN) % SLOT_STRIP_LEN
      const target = reel.pos + delta + (i + 1) * SLOT_STRIP_LEN
      const land = (): void => {
        reel.pos = target
        this.seatReel(reel)
        this.landReel(i, reduced)
        finish()
      }
      // §E8: reduced motion settles instantly and correctly — no travel, no suspense wobble. The
      // detent audio still lands (sound is never "motion").
      if (reduced) {
        land()
        return
      }
      const state = { p: reel.pos }
      const apply = (): void => {
        reel.pos = state.p
        this.seatReel(reel)
      }
      if (i === SLOT_REELS - 1) {
        // The classic suspense beat on the final reel: a long decel that overshoots the detent, then a
        // short spring back into it. The chain ENDS on `target`, so the settled result is untouched.
        this.tweens.chain({
          targets: state,
          tweens: [
            { p: target + 0.35, duration: SPIN_MS + i * SPIN_STEP_MS, ease: 'Cubic.easeOut', onUpdate: apply },
            { p: target, duration: 280, ease: backOut(OVERSHOOT.pop), onUpdate: apply },
          ],
          onComplete: land,
        })
      } else {
        this.tweens.add({
          targets: state,
          p: target,
          duration: SPIN_MS + i * SPIN_STEP_MS,
          ease: 'Cubic.easeOut',
          onUpdate: apply,
          onComplete: land,
        })
      }
    })
  }

  /** Per-reel detent: a panned clunk, a light haptic, and a settle kick. */
  private landReel(i: number, reduced: boolean): void {
    sfx.reelClunk(((i - (SLOT_REELS - 1) / 2) / SLOT_REELS) * 1.2)
    if (!hapticsOff()) vibratePattern(10)
    if (!reduced) this.cameras.main.shake(50, 0.003)
  }

  // ──────────────────────────────────────────────────────────────── the result

  private settle(purchase: SlotPurchase): void {
    const { spin } = purchase
    this.meter.update(purchase.meter, spin.points > 0)

    if (spin.lines.length === 0 && !spin.charm) {
      this.showMiss()
      this.rearm()
      return
    }

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
      this.showPrizes(spin)
      if (spin.lines.some(l => l.run >= SLOT_REELS) || spin.boosts.length >= 3) {
        sfx.winFanfare()
        this.confetti()
      } else if (spin.lines.length > 0) {
        sfx.coinCount()
      }
      // The charm reveal owns the re-arm: the machine comes back when the player dismisses the card.
      if (purchase.charm) this.revealCharm(purchase.charm)
      else this.rearm()
    })
  }

  /** Put the machine back in the player's hands: bet row live, hero back, affordability refreshed. */
  private rearm(): void {
    this.spinning = false
    this.renderControls()
  }

  /** Draw the gold payline bar over a winning run, and pop the symbols under it. */
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

  /** The payout readout: what went into the boost pile, and what went onto the meter. */
  private showPrizes(spin: SlotSpin): void {
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
    if (parts.length === 0) return

    const headline = spin.charm ? 'A CHARM!' : spin.lines.some(l => l.run >= SLOT_REELS) ? 'BIG WIN!' : 'WIN!'
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

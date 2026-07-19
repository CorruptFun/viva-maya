import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_H, DESIGN_W, restScrollY } from '../config'
import { loadSave } from '../core/save'
import { BOOST_ITEMS, buyBoost } from '../core/store'
import type { BoostStoreItem } from '../core/store'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { stagger } from '../view/motion'
import { getTheme, prefersReducedMotion } from '../view/theme'
import { ensurePieceTexture } from '../view/textures'
import type { ChipPill } from '../view/ui'
import { FONT, GHOST_PILL, GOLD_PILL, addChipPill, addPillButton, applyEntrance, startScene } from '../view/ui'

const CARD_X = 36
const CARD_W = 648
const LIST_TOP = 336
const ROW_H = 104
const CTRL_CX = 596 // center-x of the right-hand buy control

/**
 * The Gift Store — the closed-loop sink where earned chips buy consumable boosts
 * that apply to the next level (like the daily spin). A destination scene, sibling
 * to DailyBonusScene: warm cross-fade in, back to Home. Everything is in-game only —
 * chips are earned by winning and have no cash value. Catalogue + spend logic live in
 * core/store.ts; this scene is pure presentation. Themes are NOT sold here (they stay
 * free + progress-unlocked in the theme picker).
 */
export class StoreScene extends Phaser.Scene {
  private balance!: ChipPill
  private balanceX = DESIGN_W / 2
  private balanceY = 240
  private listLayer!: Phaser.GameObjects.Container
  private activeToast?: Phaser.GameObjects.Text

  constructor() {
    super('store')
  }

  create(): void {
    this.activeToast = undefined // scenes are reused via scene.start — clear the stale per-entry ref
    // Warm cream fade-in + directional rise (the receiving half of startScene's cross-fade).
    this.cameras.main.setScroll(0, restScrollY()) // centre the design box (reduced-motion path skips applyEntrance)
    this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    applyEntrance(this)
    addCasinoBackdrop(this, 'home')
    const T = getTheme()

    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this, 'home'))

    this.add
      .text(DESIGN_W / 2, 130, 'GIFT STORE', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: '#ffffff' })
      .setOrigin(0.5)
      .setLetterSpacing(4)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
      .setTint(T.goldBright, T.goldBright, T.goldDeep, T.goldDeep)
    this.add
      .text(DESIGN_W / 2, 184, 'Treat yourself — boosts for your next level', {
        fontFamily: FONT,
        fontSize: '23px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)

    // Live balance read-out — the same pill Home/HUD use; update() pops it on each spend.
    this.balance = addChipPill(this, this.balanceX, this.balanceY)

    this.listLayer = this.add.container(0, 0)
    this.renderList(true) // stagger the cards in on first paint; purchase refreshes rebuild silently

    this.add
      .text(DESIGN_W / 2, DESIGN_H - 60, 'Chips are earned by winning — in-game only, no cash value.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)
  }

  // ------------------------------------------------------------------- list

  /** Reparent a freshly-created object into the (rebuildable) list layer. */
  private hold<G extends Phaser.GameObjects.GameObject>(o: G): G {
    this.listLayer.add(o)
    return o
  }

  private renderList(animate = false): void {
    this.listLayer.removeAll(true)
    const rows = BOOST_ITEMS.map((item, i) => this.boostRow(item, LIST_TOP + i * ROW_H))
    // Entrance beat: stagger the cards up into place ~60ms apart, top-to-bottom, so the Store
    // composes in like every other scene instead of snapping flat. `stagger` is reduced-motion-
    // aware (it lands each row at its resting alpha/y instantly). Adopts the shared motion helpers
    // (item C2). Only on first paint — post-purchase affordability refreshes rebuild silently.
    if (animate) stagger(this, rows, 60)
  }

  private boostRow(item: BoostStoreItem, cy: number): Phaser.GameObjects.Container {
    // Cream card frame with a gold bezel + soft drop shadow (matches the help/sound panels). Cards stay
    // cream on every theme, so route through tokens: identical on the light themes, and it fixes the
    // drop-shadow tint on the dark themes (T.shadow is near-black there, not the warm literal).
    // The whole card lives in one row container so the entrance stagger moves it as a single unit —
    // children keep their absolute coords; the container rests at y=0 and fadeRise nudges only that.
    const T = getTheme()
    const row = this.hold(this.add.container(0, 0))
    const g = this.add.graphics()
    const h = 88
    const y = cy - h / 2
    g.fillStyle(T.shadow, 0.16)
    g.fillRoundedRect(CARD_X + 3, y + 6, CARD_W, h, 24)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(CARD_X, y, CARD_W, h, 24)
    g.lineStyle(2.5, T.goldBezel, 0.9)
    g.strokeRoundedRect(CARD_X, y, CARD_W, h, 24)
    row.add(g)

    row.add(this.add.image(80, cy, this.boostIcon(item.type)).setDisplaySize(58, 58))
    row.add(
      this.add.text(124, cy - 30, item.label, { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.ink }).setOrigin(0, 0)
    )
    row.add(
      this.add
        .text(124, cy + 4, item.blurb, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '17px',
          color: T.inkSoft,
          wordWrap: { width: 360 },
          lineSpacing: 2,
        })
        .setOrigin(0, 0)
    )

    // Chip icon + price pill (gold when affordable, ghost when not). Returns the pill for shake feedback.
    const afford = loadSave().chips >= item.price
    row.add(this.add.image(CTRL_CX - 58, cy, 'chip').setDisplaySize(34, 34).setAlpha(afford ? 1 : 0.4))
    const btn = addPillButton(this, CTRL_CX + 20, cy, 108, 60, item.price.toLocaleString(), afford ? GOLD_PILL : GHOST_PILL, () =>
      this.attemptBuy(item, btn)
    )
    row.add(btn)

    return row
  }

  // --------------------------------------------------------------- purchase

  private attemptBuy(item: BoostStoreItem, btn: Phaser.GameObjects.Container): void {
    const res = buyBoost(item)
    if (!res.ok) {
      this.denied(btn)
      return
    }
    sfx.coinCount()
    this.flyChip(btn.x, btn.y)
    this.toast(`${item.label} added — applies next level`, 'good')
    this.renderList() // refresh affordability across the list
  }

  /** Not-enough-chips feedback: a thud, a red nudge, and a shake of the tapped button. */
  private denied(btn: Phaser.GameObjects.Container): void {
    sfx.invalidThud()
    this.toast('Not enough chips', 'bad')
    if (prefersReducedMotion()) return
    const x0 = btn.x
    this.tweens.add({ targets: btn, x: x0 - 6, duration: 50, yoyo: true, repeat: 3, onComplete: () => btn.setX(x0) })
  }

  // ------------------------------------------------------------------ juice

  private toast(msg: string, tone: 'good' | 'bad'): void {
    this.activeToast?.destroy()
    const T = getTheme()
    const t = this.add
      .text(DESIGN_W / 2, DESIGN_H - 120, msg, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: tone === 'bad' ? T.warn : T.ok })
      .setOrigin(0.5)
      .setDepth(70)
    this.activeToast = t
    if (prefersReducedMotion()) {
      this.time.delayedCall(1100, () => t.destroy())
      return
    }
    t.setAlpha(0).setY(t.y + 12)
    this.tweens.add({ targets: t, alpha: 1, y: DESIGN_H - 120, duration: 180, ease: 'Back.easeOut' })
    this.tweens.add({ targets: t, alpha: 0, delay: 950, duration: 320, onComplete: () => t.destroy() })
  }

  /** A single chip arcs from the buy button into the balance pill, which pops when it lands. */
  private flyChip(fromX: number, fromY: number): void {
    if (prefersReducedMotion()) {
      this.balance.update(loadSave().chips)
      return
    }
    const c = this.add.image(fromX, fromY, 'chip').setDisplaySize(40, 40).setDepth(65)
    this.tweens.add({
      targets: c,
      x: this.balanceX,
      y: this.balanceY,
      scale: c.scale * 0.5,
      duration: 420,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        c.destroy()
        this.balance.update(loadSave().chips)
      },
    })
  }

  /** Boost → board-piece texture, mirroring DailyBonusScene.prizeTexture. */
  private boostIcon(type: string): string {
    const asPiece = (symbol: (typeof SYMBOLS)[number], k: PieceKind): Piece => ({ id: -1, symbol, kind: k })
    switch (type) {
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
}

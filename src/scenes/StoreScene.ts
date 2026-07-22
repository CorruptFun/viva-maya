import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_H, DESIGN_W, restScrollY } from '../config'
import { LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { BOOST_ITEMS, buyBoost } from '../core/store'
import type { BoostStoreItem } from '../core/store'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { INVITE_CARD_H, addInviteCard, maybeShowWelcome } from '../view/invite'
import { isCloudConfigured } from '../core/cloud'
import { rewardLabel } from '../core/promo'
import { openPromoModal } from '../view/promomodal'
import { D, E, OVERSHOOT, backOut, fadeRise, popIn, stagger } from '../view/motion'
import { quality } from '../view/quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from '../view/theme'
import { ensurePieceTexture } from '../view/textures'
import type { ChipPill } from '../view/ui'
import { FONT, GHOST_PILL, GOLD_PILL, addChipPill, addPillButton, applyEntrance, startScene } from '../view/ui'

const CARD_X = 36
const CARD_W = 648
/** Top of the INVITE FRIENDS card — it EARNS chips, so it leads the shelf above every purchasable. */
const INVITE_TOP = 292
const LIST_TOP = INVITE_TOP + INVITE_CARD_H + 60 // = 504; the boost shelf seats below the invite row
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

    // ENTER CODE — redeem a promo/reward code you were handed (existing-user rewards; new users use
    // the invite LINK). Cloud-gated: hidden on dormant/local-only builds where redemption can't work.
    // DEV ?code force-shows it + auto-opens the modal for preview.
    const codeFixture = import.meta.env.DEV && new URLSearchParams(location.search).has('code')
    if (isCloudConfigured() || codeFixture) {
      // On the balance row (right of the centred chip pill), NOT the title row — at y=84 it collided
      // with the wide "GIFT STORE" title. (A fuller top-band rework is docs/TOP_LAYOUT_PLAN.md.)
      addPillButton(this, 600, this.balanceY, 176, 52, 'ENTER CODE', GHOST_PILL, () => this.openCodeEntry())
    }
    if (codeFixture) this.time.delayedCall(400, () => this.openCodeEntry())

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
    // Entrance: the balance pops in just ahead of the card stagger, so the "what can I afford"
    // read-out leads the shelf. popIn is §E8-aware — reduced motion rests it instantly.
    popIn(this, this.balance.container, { from: 0.7, delay: 60, overshoot: OVERSHOOT.gentle })

    // INVITE FRIENDS leads the shelf (it EARNS chips; everything below spends them). Built once per
    // entry — it manages its own async states (mint shimmer / stats), so purchase refreshes must
    // never rebuild it. It takes the first beat of the entrance; the boost stagger follows.
    const invite = addInviteCard(this, INVITE_TOP, { toast: msg => this.toast(msg, 'good') })
    fadeRise(this, invite, { rise: 26, duration: D.pop, ease: backOut(OVERSHOOT.gentle), delay: 40 })

    this.listLayer = this.add.container(0, 0)
    this.renderList(true) // stagger the cards in on first paint; purchase refreshes rebuild silently

    // Referee welcome moment ("welcome gift · +150") — claims + celebrates if pending, chip-flying
    // into the balance pill. Delayed a beat so the entrance choreography lands first.
    maybeShowWelcome(this, {
      balanceX: this.balanceX,
      balanceY: this.balanceY,
      onBalance: chips => {
        this.balance.update(chips)
        this.renderList() // +150 may wake ghosted rows — silent affordability refresh, like a purchase
      },
      delay: 650,
    })

    this.add
      .text(DESIGN_W / 2, DESIGN_H - 60, 'Chips are earned by winning — in-game only, no cash value.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)
  }

  /** Open the "enter a code" modal; on a successful redeem, pop the balance + toast + refresh rows. */
  private openCodeEntry(): void {
    openPromoModal({
      onRedeemed: (reward, balance) => {
        if (!this.scene.isActive()) return // player left the Store while the modal was up
        this.balance.update(balance) // chip rewards move the balance; hearts/boost leave it as-is
        this.toast(`${rewardLabel(reward)} added!`, 'good')
        this.renderList() // a chip reward may wake ghosted rows — affordability refresh
      },
    })
  }

  // ------------------------------------------------------------------- list

  /** Reparent a freshly-created object into the (rebuildable) list layer. */
  private hold<G extends Phaser.GameObjects.GameObject>(o: G): G {
    this.listLayer.add(o)
    return o
  }

  private renderList(animate = false): void {
    // Stop the previous list's looping tweens (icon bobs + any first-affordable glow) BEFORE their
    // targets are destroyed: Phaser 3.90 doesn't auto-remove tweens when a GameObject is destroyed
    // (its TweenManager only sweeps on scene shutdown), so a silent post-purchase rebuild would leak
    // them. Cheap + fully additive — no behaviour change to the spend path.
    this.killListTweens()
    this.listLayer.removeAll(true)
    // S2 · first-affordable highlight: BOOST_ITEMS is priced cheapest → most powerful, so the FIRST
    // affordable row IS the cheapest one to reach for — that's the pill we breathe to guide a first
    // buy. -1 (nothing affordable) means even the cheapest is out of reach → the S3 empty state below.
    const chips = loadSave().chips
    const firstAffordable = BOOST_ITEMS.findIndex((item) => chips >= item.price)
    const rows = BOOST_ITEMS.map((item, i) => this.boostRow(item, LIST_TOP + i * ROW_H, i === firstAffordable))
    // Entrance beat: stagger the cards up into place ~70ms apart, top-to-bottom, with a longer rise
    // and a gentle Back overshoot so each card lands with a little spring instead of drifting flat.
    // `stagger` is reduced-motion-aware (it lands each row at its resting alpha/y instantly). Adopts
    // the shared motion helpers (item C2). Only on first paint — purchase refreshes rebuild silently.
    // (delay 110 seats the boost rows one beat behind the invite card's fadeRise, one entrance arc.)
    if (animate) stagger(this, rows, 70, { rise: 26, duration: D.pop, ease: backOut(OVERSHOOT.gentle), delay: 110 })
    // S3 · "play to earn" empty state: when nothing is affordable the list is all ghosted pills with
    // no next step, so point the broke player back into the earn loop (rebuilt in/out with the list).
    if (firstAffordable < 0) this.renderEmptyState()
  }

  /** Kill every looping tween the current list layer started, recursing into row/button containers. */
  private killListTweens(): void {
    const walk = (obj: Phaser.GameObjects.GameObject): void => {
      this.tweens.killTweensOf(obj)
      if (obj instanceof Phaser.GameObjects.Container) obj.list.forEach(walk)
    }
    this.listLayer.list.forEach(walk)
  }

  /**
   * S3 · "play to earn" empty state (rendered by renderList only when even the cheapest boost is out of
   * reach). A wall of ghosted pills dead-ends a broke player, so add a warm encouragement line + a
   * single PLAY shortcut that drops them into their current level to earn more chips — closing the loop.
   * Static + theme-tokened (no motion); reuses `addPillButton` + `startScene` exactly like Home's PLAY,
   * and is held in listLayer so the next affordability refresh rebuilds it away once chips can buy again.
   */
  private renderEmptyState(): void {
    const T = getTheme()
    const currentLevel = Math.min(loadSave().unlocked, LEVEL_COUNT) // same target Home's PLAY uses
    this.hold(
      this.add
        .text(DESIGN_W / 2, 1030, 'Win a level to earn more chips 💛', {
          fontFamily: FONT,
          fontSize: '25px',
          fontStyle: '900',
          color: T.onBackdropInk,
        })
        .setOrigin(0.5)
    )
    this.hold(
      addPillButton(this, DESIGN_W / 2, 1112, 300, 72, 'PLAY', GOLD_PILL, () => startScene(this, 'game', { level: currentLevel }))
    )
  }

  private boostRow(item: BoostStoreItem, cy: number, highlight: boolean): Phaser.GameObjects.Container {
    // Cream card frame with a gold bezel + soft drop shadow (matches the help/sound panels). Cards stay
    // cream on every theme, so route through tokens: identical on the light themes, and it fixes the
    // drop-shadow tint on the dark themes (T.shadow is near-black there, not the warm literal).
    // The whole card lives in one row container so the entrance stagger moves it as a single unit —
    // children keep their absolute coords; the container rests at y=0 and fadeRise nudges only that.
    const T = getTheme()
    // Affordability decides the whole row's posture (pill style, icon life, disabled-state clarity),
    // so read it once up front — one loadSave per row, reused everywhere below.
    const chips = loadSave().chips
    const afford = chips >= item.price
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

    // S2 · idle bob — each icon drifts a few px up-and-back on the shared breathing ease so the shelf
    // reads as alive, not a static price list. Reduced motion → no tween (the icon simply rests at cy).
    // Pure transform on one existing sprite (no ADD sprites); phase-spread by row so the icons don't
    // bob in mechanical lockstep. Cleaned up on any rebuild by killListTweens.
    // Disabled-state clarity: an unaffordable row's icon dims AND rests still — only goods you can
    // actually reach for look alive on the shelf.
    const icon = this.add.image(80, cy, this.boostIcon(item.type)).setDisplaySize(58, 58).setAlpha(afford ? 1 : 0.55)
    row.add(icon)
    if (afford && !prefersReducedMotion()) {
      this.tweens.add({
        targets: icon,
        y: cy - 5,
        duration: D.breath,
        delay: ((cy - LIST_TOP) / ROW_H) * 150, // ≈ row index × 150ms → a gentle per-row phase offset
        yoyo: true,
        repeat: -1,
        ease: E.hero,
      })
    }
    row.add(
      this.add
        .text(124, cy - 30, item.label, { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.ink })
        .setOrigin(0, 0)
        .setAlpha(afford ? 1 : 0.66)
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
        .setAlpha(afford ? 1 : 0.66)
    )

    // Chip icon + price pill (gold when affordable, ghost when not). Returns the pill for shake feedback.
    // S2 · first-affordable highlight: the cheapest reachable pill (`highlight`, only ever set on an
    // affordable gold pill) gets the shared button `juice` breathing glow — one ADD `bgglow` sprite
    // behind the cap (governor-safe; reduced motion → static, no breath) — to draw the eye to the
    // easiest first purchase.
    row.add(this.add.image(CTRL_CX - 58, cy, 'chip').setDisplaySize(34, 34).setAlpha(afford ? 1 : 0.4))
    // Disabled-state clarity: an unaffordable pill shrinks a size and rides up a hair, making room
    // inside the card for a plain-words "need N more" caption — so the inert ghost state (and the
    // earn loop) is unmistakable, and the affordable gold pills stand a full size taller beside it.
    const btn = addPillButton(
      this,
      CTRL_CX + 20,
      afford ? cy : cy - 5,
      afford ? 108 : 100,
      afford ? 60 : 48,
      item.price.toLocaleString(),
      afford ? GOLD_PILL : GHOST_PILL,
      () => this.attemptBuy(item, btn),
      highlight ? { juice: true } : {}
    )
    row.add(btn)
    // The shortfall caption — rebuilt with the list on every affordability refresh, so it disappears
    // the moment the row wakes up.
    if (!afford) {
      row.add(
        this.add
          .text(CTRL_CX + 20, cy + 33, `need ${(item.price - chips).toLocaleString()} more`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '12px',
            color: T.inkFaint,
          })
          .setOrigin(0.5)
      )
    }

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
    this.purchaseFlash(btn.x, btn.y)
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

  /**
   * S5 · purchase pop — the instant a buy commits, one transient gold ring blooms out of the tapped
   * button so the spend lands with a visible "yes" beyond the pill's own tap-flash. A single ADD
   * sprite that destroys itself; skipped under reduced motion / reduced flashing / the LOW tier
   * (the chip-fly + pill pop still carry the confirmation there).
   */
  private purchaseFlash(x: number, y: number): void {
    if (prefersReducedMotion() || reduceFlashing() || quality.tier() === 'low') return
    const ring = this.add
      .image(x, y, 'ring')
      .setDisplaySize(74, 74)
      .setTint(getTheme().gold)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.9)
      .setDepth(66)
    this.tweens.add({ targets: ring, scale: ring.scale * 2.1, alpha: 0, duration: D.pop, ease: E.settle, onComplete: () => ring.destroy() })
  }

  /**
   * A single chip arcs from the buy button into the balance pill, which pops when it lands. The x and
   * y travel are eased separately (x glides out early, y accelerates late) so the chip carves a curve
   * into the pill instead of beelining, and a lazy spin sells the coin in flight.
   */
  private flyChip(fromX: number, fromY: number): void {
    if (prefersReducedMotion()) {
      this.balance.update(loadSave().chips)
      return
    }
    const c = this.add.image(fromX, fromY, 'chip').setDisplaySize(40, 40).setDepth(65)
    this.tweens.add({ targets: c, x: this.balanceX, duration: 420, ease: E.arc })
    this.tweens.add({ targets: c, angle: -300, duration: 420, ease: E.settle })
    this.tweens.add({
      targets: c,
      y: this.balanceY,
      scale: c.scale * 0.5,
      duration: 420,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        c.destroy()
        this.balance.update(loadSave().chips)
        this.landSpark()
      },
    })
  }

  /**
   * S5 · landing sparkle — a tiny governor-scaled spark burst where the flown chip melts into the
   * balance pill, so the deposit reads as an arrival, not a vanish. Transient emitter, destroys
   * itself; skipped under reduced motion and on the LOW tier (counts scale with the governor).
   */
  private landSpark(): void {
    if (prefersReducedMotion() || quality.tier() === 'low') return
    const n = quality.count(8)
    if (n === 0) return
    const spark = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 60, max: 190 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.4, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 280, max: 520 },
        emitting: false,
      })
      .setDepth(66)
    spark.explode(n, this.balanceX, this.balanceY)
    this.time.delayedCall(650, () => spark.destroy())
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

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_H, DESIGN_W, restScrollY } from '../config'
import {
  CASE_FROM,
  buyCosmetic,
  equip,
  equipped,
  owns,
  shelf,
  shelfOpen,
  starBalance,
} from '../core/boutique'
import type { Cosmetic } from '../core/boutique'
import { loadSave } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import { chaseBlurb, swatch } from '../view/cosmetics'
import { addScreenGloss } from '../view/fx'
import { D, E, OVERSHOOT, backOut, popIn, stagger } from '../view/motion'
import { bakePanel } from '../view/platekit'
import { quality } from '../view/quality'
import { ensureChipFace } from '../view/textures'
import { getTheme, prefersReducedMotion, reduceFlashing } from '../view/theme'
import {
  FONT,
  GHOST_PILL,
  GOLD_PILL,
  addGoldWordmark,
  addPillButton,
  applyEntrance,
  inkShadow,
  startScene,
} from '../view/ui'

/**
 * THE BOUTIQUE — where stars become a look.
 *
 * A destination scene rather than a panel, and the Gift Store's sibling by design: it has a balance
 * to read out, a shelf of priced rows, an affordability posture per row and an owned/worn state, and
 * that is precisely the shape StoreScene already proved. What it does NOT share is the currency —
 * chips buy things that change a level, stars buy things that change nothing but the view. Keeping
 * them in two rooms is what stops "spend" meaning two different bargains on one screen.
 *
 * ── THE ONE THING THIS SCREEN MUST GET RIGHT ────────────────────────────────────────────────────
 * A player arrives here having earned stars for months with nothing to do with them. So the balance
 * leads, every price is legible against it, and the shelf is ordered cheapest-first — the first row
 * you see should be the one you can most nearly afford. The HIGH-ROLLER CASE below it is drawn as
 * SILHOUETTES rather than hidden: "there is more upstairs" is the honest reading of a locked shelf,
 * and hiding it would make Act II's own goods invisible to the player climbing toward them.
 *
 * ── EQUIPPING RESTARTS THE SCENE ────────────────────────────────────────────────────────────────
 * A chip face is BAKED into the shared `'chip'` texture (view/textures.ts ensureChipFace), so
 * wearing one means re-baking a texture other display objects hold. The restart is what makes that
 * safe: `create()` re-bakes at the top, before it builds anything, with the previous display list
 * already torn down. Everything else here would repaint fine without it — one rule for all four
 * slots beats three cheap paths and one careful one.
 */

const CARD_X = 36
const CARD_W = 648
const ROW_H = 108
const CTRL_CX = 590

export class BoutiqueScene extends Phaser.Scene {
  private listLayer!: Phaser.GameObjects.Container
  private balanceText!: Phaser.GameObjects.Text
  private activeToast?: Phaser.GameObjects.Text
  private scrollY = 0
  private scrollMax = 0
  private dragMoved = false

  constructor() {
    super('boutique')
  }

  create(): void {
    // ⚠️ FIRST, before a single display object exists. Re-baking `'chip'` destroys the old texture,
    // so it is only safe while nothing is holding it — which is true here and nowhere else.
    ensureChipFace(this)
    this.activeToast = undefined // scenes are reused via scene.start — clear the stale per-entry ref
    this.scrollY = 0
    this.dragMoved = false
    this.cameras.main.setScroll(0, restScrollY())
    this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    applyEntrance(this, undefined, { zoomSettle: true })
    addCasinoBackdrop(this, 'home')
    addScreenGloss(this)
    const T = getTheme()

    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this, 'levelselect'))
    addGoldWordmark(this, DESIGN_W / 2, 130, 'THE BOUTIQUE')
    this.add
      .text(DESIGN_W / 2, 184, 'Your stars, spent on how the table looks', {
        fontFamily: FONT,
        fontSize: '23px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)

    this.buildBalance()
    this.listLayer = this.add.container(0, 0)
    this.renderList(true)
    this.attachScroll()
  }

  // ------------------------------------------------------------------ balance

  /** The star balance, in the seat the Gift Store gives its chip pill — the "what can I afford" line. */
  private buildBalance(): void {
    const T = getTheme()
    const w = 220
    const h = 58
    const cy = 244
    const plate = this.add.image(
      DESIGN_W / 2,
      cy,
      bakePanel(this, `boutique:bal:${T.id}:${w}x${h}`, w, h, h / 2 - 1, {
        bezel: T.goldBezel,
        bezelWidth: 2.5,
        shadowDist: 4,
      })
    )
    this.add.image(DESIGN_W / 2 - w / 2 + 40, cy, 'star').setDisplaySize(34, 34)
    this.balanceText = this.add
      .text(DESIGN_W / 2 + 18, cy + 1, starBalance(loadSave()).toLocaleString(), {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
    popIn(this, plate, { from: 0.7, delay: 60, overshoot: OVERSHOOT.gentle })
  }

  private refreshBalance(): void {
    this.balanceText.setText(starBalance(loadSave()).toLocaleString())
  }

  // --------------------------------------------------------------------- list

  private hold<G extends Phaser.GameObjects.GameObject>(o: G): G {
    this.listLayer.add(o)
    return o
  }

  /**
   * The shelf. Two sections, both always drawn: THE COUNTER (open the moment the door is) and THE
   * HIGH-ROLLER CASE, which renders as silhouettes until the act opens.
   */
  private renderList(animate = false): void {
    this.killListTweens()
    this.listLayer.removeAll(true)
    const save = loadSave()
    const rows: Phaser.GameObjects.Container[] = []
    let y = 320

    y = this.sectionHeader(y, 'THE COUNTER', 'Open to everyone. Wear whichever you like.')
    for (const item of shelf('counter')) {
      rows.push(this.goodRow(item, y + ROW_H / 2, true))
      y += ROW_H
    }

    const caseOpen = shelfOpen(save, 'case')
    y += 22
    y = this.sectionHeader(
      y,
      'THE HIGH-ROLLER CASE',
      caseOpen ? 'The floors upstairs, brought down to the counter.' : `Unlocks on level ${CASE_FROM}`
    )
    for (const item of shelf('case')) {
      rows.push(this.goodRow(item, y + ROW_H / 2, caseOpen))
      y += ROW_H
    }

    // The honesty line rides INSIDE the list, at its foot. Pinned to the bottom of the screen it
    // was a fixed caption with a scrolling shelf passing underneath it — the case's own header ran
    // straight through it the moment anything moved.
    this.hold(
      this.add
        .text(DESIGN_W / 2, y + 46, 'Stars are earned by clearing levels. Everything here is a look, nothing more.', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '17px',
          color: getTheme().onBackdropMuted,
          wordWrap: { width: 600 },
          align: 'center',
          lineSpacing: 3,
        })
        .setOrigin(0.5, 0)
    )

    // The scroll budget: how far the shelf overhangs the bottom of the screen. The list is short
    // enough today that a tall phone may not scroll at all, which is why this is derived rather
    // than a constant — a shelf that scrolled past its own end would read as broken.
    this.scrollMax = Math.max(0, y + 120 - DESIGN_H)
    if (animate) stagger(this, rows, 55, { rise: 24, duration: D.pop, ease: backOut(OVERSHOOT.gentle), delay: 100 })
  }

  private sectionHeader(y: number, title: string, sub: string): number {
    const T = getTheme()
    this.hold(
      inkShadow(
        this.add
          .text(CARD_X + 6, y, title, {
            fontFamily: FONT,
            fontSize: '25px',
            fontStyle: '900',
            color: T.onBackdropInk,
          })
          .setOrigin(0, 0)
          .setLetterSpacing(2)
      )
    )
    this.hold(
      this.add
        .text(CARD_X + 6, y + 32, sub, { fontFamily: 'Arial, sans-serif', fontSize: '17px', color: T.onBackdropMuted })
        .setOrigin(0, 0)
    )
    return y + 62
  }

  /**
   * One good. Four postures, and the row's whole job is that they are never confusable:
   *   · LOCKED  — the case below 301: a silhouette, no price, no control.
   *   · OWNED   — a WEAR pill, or a still "WORN" collar when it is already on.
   *   · AFFORD  — a gold price pill.
   *   · SHORT   — a ghost price pill plus a plain-words shortfall, exactly as the Gift Store does it.
   */
  private goodRow(item: Cosmetic, cy: number, unlocked: boolean): Phaser.GameObjects.Container {
    const T = getTheme()
    const save = loadSave()
    const held = owns(save, item.id)
    const worn = equipped(save, item.slot) === item.id
    const balance = starBalance(save)
    const afford = balance >= item.price
    const row = this.hold(this.add.container(0, 0))
    const h = 92
    const live = unlocked && (held || afford)

    row.add(
      this.add.image(CARD_X + CARD_W / 2, cy + 8, 'softshadow').setDisplaySize(CARD_W + 48, h + 48).setAlpha(0.2)
    )
    row.add(
      this.add.image(
        CARD_X + CARD_W / 2,
        cy,
        bakePanel(this, `boutique:row:${T.id}:${CARD_W}x${h}`, CARD_W, h, 24, {
          bezel: T.goldBezel,
          bezelWidth: 2.5,
          shadowDist: 6,
        })
      )
    )

    // The swatch: two arcs of one disc, so a table felt reads as its own checkerboard pair and a
    // chip face as its rim-and-ring. A locked good gets the SILHOUETTE of the same disc instead —
    // the shape of a thing you cannot see yet, which is the whole point of leaving it on the shelf.
    const [a, b] = unlocked ? swatch(item.id, T) : [T.shadow, T.shadow]
    const g = this.add.graphics()
    const sx = 82
    g.fillStyle(0x000000, 0.14)
    g.fillCircle(sx, cy + 3, 30)
    g.fillStyle(a, unlocked ? 1 : 0.34)
    g.slice(sx, cy, 28, Phaser.Math.DegToRad(90), Phaser.Math.DegToRad(270), false)
    g.fillPath()
    g.fillStyle(b, unlocked ? 1 : 0.34)
    g.slice(sx, cy, 28, Phaser.Math.DegToRad(270), Phaser.Math.DegToRad(90), false)
    g.fillPath()
    g.lineStyle(2.5, T.goldBezel, unlocked ? 0.9 : 0.4)
    g.strokeCircle(sx, cy, 28)
    row.add(g)

    row.add(
      inkShadow(
        this.add
          .text(132, cy - 28, unlocked ? item.name : '? ? ? ? ?', {
            fontFamily: FONT,
            fontSize: '25px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0, 0)
          .setAlpha(live || !unlocked ? (unlocked ? 1 : 0.4) : 0.66)
      )
    )
    // A chase has no colour of its own, so its row says what the pattern DOES. Everything else keeps
    // the catalogue's own line.
    const blurb = item.slot === 'chase' ? `${item.blurb}  ·  ${chaseBlurb(item.id)}` : item.blurb
    row.add(
      this.add
        .text(132, cy + 4, unlocked ? blurb : 'Opens with the high-roller floors', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '16px',
          color: T.inkSoft,
          wordWrap: { width: 320 },
          lineSpacing: 2,
        })
        .setOrigin(0, 0)
        .setAlpha(unlocked ? (live ? 1 : 0.66) : 0.4)
    )

    if (!unlocked) {
      row.add(this.add.image(CTRL_CX + 20, cy, 'lock').setDisplaySize(36, 36).setAlpha(0.32))
      return row
    }

    if (worn) {
      // Already on. A flat gold collar rather than a pressable — there is nothing left to do here,
      // and a disabled-looking button would read as a control that stopped working.
      const collar = this.add.graphics()
      collar.fillStyle(T.goldBezel, 1)
      collar.fillRoundedRect(CTRL_CX - 46, cy - 20, 132, 40, 20)
      row.add(collar)
      row.add(
        this.add
          .text(CTRL_CX + 20, cy, 'WORN', { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: '#fffdf7' })
          .setOrigin(0.5)
          .setLetterSpacing(2)
      )
      return row
    }

    if (held) {
      row.add(
        addPillButton(this, CTRL_CX + 20, cy, 132, 56, 'WEAR', GHOST_PILL, () => this.wear(item))
      )
      return row
    }

    row.add(this.add.image(CTRL_CX - 54, cy, 'star').setDisplaySize(30, 30).setAlpha(afford ? 1 : 0.4))
    const btn = addPillButton(
      this,
      CTRL_CX + 22,
      afford ? cy : cy - 5,
      afford ? 108 : 100,
      afford ? 58 : 48,
      item.price.toLocaleString(),
      afford ? GOLD_PILL : GHOST_PILL,
      () => this.attemptBuy(item, btn)
    )
    row.add(btn)
    if (!afford) {
      row.add(
        this.add
          .text(CTRL_CX + 22, cy + 31, `need ${(item.price - balance).toLocaleString()} more`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '12px',
            color: T.inkFaint,
          })
          .setOrigin(0.5)
      )
    }
    return row
  }

  private killListTweens(): void {
    const walk = (obj: Phaser.GameObjects.GameObject): void => {
      this.tweens.killTweensOf(obj)
      if (obj instanceof Phaser.GameObjects.Container) obj.list.forEach(walk)
    }
    this.listLayer.list.forEach(walk)
  }

  // ----------------------------------------------------------------- scrolling

  /**
   * A drag on the shelf scrolls it. The whole list rides ONE container's `y`, so this is a single
   * assignment per frame rather than a mask plus a windowed rebuild — the shelf is a dozen rows,
   * not three hundred, and LevelSelect's windowing exists for a list this one will never be.
   *
   * ⚠️ The rows arm on `pointerdown` and only fire if the finger never travelled (`dragMoved`), the
   * same guard the LevelSelect chips use. A control sitting on a scroll surface that fired on
   * `pointerup` would buy a cushion at the end of a flick.
   */
  private attachScroll(): void {
    this.input.on('pointerdown', () => {
      this.dragMoved = false
    })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown || this.scrollMax <= 0) return
      if (Math.abs(p.y - p.downY) > 6) this.dragMoved = true
      this.scrollY = Phaser.Math.Clamp(this.scrollY + (p.y - p.prevPosition.y), -this.scrollMax, 0)
      this.listLayer.setY(this.scrollY)
    })
  }

  // ---------------------------------------------------------------- purchase

  private attemptBuy(item: Cosmetic, btn: Phaser.GameObjects.Container): void {
    if (this.dragMoved) return
    const balance = buyCosmetic(item.id)
    if (balance === null) {
      sfx.invalidThud()
      this.toast('Not enough stars', 'bad')
      if (!prefersReducedMotion()) {
        const x0 = btn.x
        this.tweens.add({ targets: btn, x: x0 - 6, duration: 50, yoyo: true, repeat: 3, onComplete: () => btn.setX(x0) })
      }
      return
    }
    sfx.coinCount()
    this.purchaseFlash(btn.x, btn.y + this.scrollY)
    this.refreshBalance()
    // Bought is WORN, immediately. Nobody buys a look in order to not put it on, and a purchase
    // that needed a second tap to do anything is a purchase that appears to have done nothing.
    if (equip(loadSave(), item.id)) {
      this.toast(`${item.name} — on the table`, 'good')
      this.restartInto()
      return
    }
    this.toast(`${item.name} — bought`, 'good')
    this.renderList()
  }

  private wear(item: Cosmetic): void {
    if (this.dragMoved) return
    if (!equip(loadSave(), item.id)) return
    sfx.uiTap()
    this.toast(`${item.name} — on the table`, 'good')
    this.restartInto()
  }

  /**
   * Repaint the whole scene so the new look takes hold — deferred a frame, because the tap that
   * asked for it is still being dispatched and rebuilding inside a pointer handler drops a fresh
   * scene under the very event that is running (the panel self-close trap).
   */
  private restartInto(): void {
    this.time.delayedCall(prefersReducedMotion() ? 60 : 420, () => this.scene.restart())
  }

  // -------------------------------------------------------------------- juice

  private toast(msg: string, tone: 'good' | 'bad'): void {
    this.activeToast?.destroy()
    const T = getTheme()
    const t = this.add
      .text(DESIGN_W / 2, DESIGN_H - 130, msg, {
        fontFamily: FONT,
        fontSize: '24px',
        fontStyle: '900',
        color: tone === 'bad' ? T.warn : T.ok,
      })
      .setOrigin(0.5)
      .setDepth(70)
    this.activeToast = t
    if (prefersReducedMotion()) {
      this.time.delayedCall(1100, () => t.destroy())
      return
    }
    t.setAlpha(0).setY(t.y + 12)
    this.tweens.add({ targets: t, alpha: 1, y: DESIGN_H - 130, duration: 180, ease: 'Back.easeOut' })
    this.tweens.add({ targets: t, alpha: 0, delay: 950, duration: 320, onComplete: () => t.destroy() })
  }

  /** One transient gold ring out of the tapped price — the Gift Store's purchase pop, same gates. */
  private purchaseFlash(x: number, y: number): void {
    if (prefersReducedMotion() || reduceFlashing() || quality.tier() === 'low') return
    const ring = this.add
      .image(x, y, 'ring')
      .setDisplaySize(74, 74)
      .setTint(getTheme().gold)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.9)
      .setDepth(66)
    this.tweens.add({
      targets: ring,
      scale: ring.scale * 2.1,
      alpha: 0,
      duration: D.pop,
      ease: E.settle,
      onComplete: () => ring.destroy(),
    })
  }
}

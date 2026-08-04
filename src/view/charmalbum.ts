import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W } from '../config'
import type { CharmExchangeItem } from '../core/charms'
import { CHARMS, CHARM_EXCHANGE, LUCK_CAP, SERIES_SIZE, canAfford, luckOf, redeemCharms, seriesLabel } from '../core/charms'
import { todayKey } from '../core/daily'
import { loadSave } from '../core/save'
import { openDeal } from './deal'
import { backOut, E, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { css, getTheme, prefersReducedMotion } from './theme'
import { ensureGlyphTexture } from './textures'
import { addPillButton, addRoundChip, FONT, GHOST_PILL, GOLD_PILL } from './ui'

/**
 * The Home corner chip that opens the album — a charm glyph with a live "N/9" collar.
 *
 * The collar is the whole reason this is a chip and not a menu item. A count sitting on the top bar
 * next to the chip balance turns the collection into ambient state the player passes every session,
 * so the gap between what they have and nine is visible without anyone opening anything — which is
 * exactly the pull an album is supposed to exert, and it costs one 52px chip.
 */
export function addCharmChip(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size = 52,
  opts: CharmAlbumOpts = {}
): Phaser.GameObjects.Container {
  const T = getTheme()
  const save = loadSave()
  const have = CHARMS.filter(c => save.charms.includes(c.id)).length
  const { container } = addRoundChip(
    scene,
    x,
    y,
    size,
    '🍀',
    { fontFamily: 'sans-serif', fontSize: `${Math.round(size * 0.48)}px` },
    () => {
      sfx.uiTap()
      sfx.whoosh() // the airy sweep that partners every panel opening
      openCharmAlbum(scene, opts)
    }
  )
  // Collar: a rose count badge on the chip's lower-right, outside the face so the press sink carries
  // the glyph without dragging the number off the chip.
  const badge = scene.add.container(size * 0.36, size * 0.34)
  const label = scene.add
    .text(0, 0, `${have}/${SERIES_SIZE}`, { fontFamily: FONT, fontSize: '15px', fontStyle: '900', color: T.onRose })
    .setOrigin(0.5)
  const bw = label.width + 14
  const bg = scene.add.graphics()
  bg.fillStyle(have === SERIES_SIZE ? T.gold : T.rose, 1)
  bg.fillRoundedRect(-bw / 2, -11, bw, 22, 11)
  bg.lineStyle(2, T.cardFill, 0.9)
  bg.strokeRoundedRect(-bw / 2, -11, bw, 22, 11)
  badge.add([bg, label])
  container.add(badge)
  return container
}

export interface CharmAlbumOpts {
  /**
   * Fired when the host needs to refresh its own HUD after a redemption — ON CLOSE, not per purchase.
   *
   * The host's refresh is a scene restart (a purchase can move the chip collar, the hearts pool, the
   * free-spin badge and the chip balance at once), and a restart destroys this panel. Firing it per
   * purchase therefore threw the player out of the album the instant they bought anything, and — far
   * worse — tore down the Lucky Deal that DEAL NOW had just opened, so the player paid three charms
   * and got a blank screen. Deferring it to close is what lets someone buy twice in one visit.
   */
  onChanged?: () => void
  /** Internal — skip the entrance when the panel is repainting itself after a purchase. */
  instant?: boolean
  /** Internal — carried across repaints so CLOSE knows whether the host still needs refreshing. */
  dirty?: boolean
}

/**
 * THE CHARM ALBUM — where the collection lives, and where it gets spent.
 *
 * A collectible with nowhere to be looked at is not a collection, it is a log line. Nine slots, the
 * ones you have filled in and the ones you have not sitting there in silhouette, so the gap is a
 * thing you can see rather than a number you have to remember. That visible gap is the entire
 * retention mechanic — it is why the genre's albums work, and it costs one screen.
 *
 * Below the grid sits the EXCHANGE (core/charms.ts): charms are a currency, not just a keepsake, and
 * this is the shelf you spend them at. It sells only things the CHIP economy cannot — a wheel pull, a
 * heart refill, a Deal on demand — so it never competes with the completion purse on the same axis.
 * The tension it creates is the good kind: bank something now, or hold the set for the payday.
 *
 * Everything else here is READ-ONLY. Nothing is claimable for free; the album is a shelf, not a
 * faucet, and every charm still arrives from exactly one place (the HEART card in the Lucky Deal),
 * which the panel says in as many words.
 *
 * Same panel idiom as `openHelpPanel` / the theme picker (scrim + card + tap-outside-to-close), so it
 * opens from Home without a scene swap and cannot strand the player anywhere.
 */
export function openCharmAlbum(scene: Phaser.Scene, opts: CharmAlbumOpts = {}): void {
  const T = getTheme()
  const reduced = prefersReducedMotion() || opts.instant === true
  const save = loadSave()
  const owned = new Set(save.charms)
  const luck = luckOf(save)
  const W = DESIGN_W
  const layer = scene.add.container(0, 0).setDepth(60)

  const close = (): void => {
    sfx.whoosh()
    layer.destroy()
    // Only when something actually changed — otherwise merely peeking at the album would replay
    // Home's whole entrance choreography on the way out.
    if (opts.dirty) opts.onChanged?.()
  }
  /**
   * Rebuild the panel in place after a purchase — destroy and re-open rather than hunting down every
   * slot, readout and price plate that a spend just invalidated. This is the cookbook's "apply by
   * repaint, not live re-tint" rule (§7): enumerate-and-mutate is high-surface-area for something
   * that happens a handful of times per album, and a rebuild is bulletproof. `instant` suppresses the
   * entrance so a repaint doesn't replay the slot cascade every time you buy something.
   */
  const repaint = (): void => {
    layer.destroy()
    openCharmAlbum(scene, { ...opts, instant: true, dirty: true })
  }

  const scrimKit = addFocusScrim(scene, { alpha: 0.62 })
  const scrim = scrimKit.hit.setInteractive()
  scrim.on('pointerup', close)

  // ── Layout, derived from the grid so the card can never crop it ──
  const CELL = 132
  const GAP = 16
  const GRID_W = CELL * 3 + GAP * 2 // 428
  const GRID_H = CELL * 3 + GAP * 2
  const px = 40
  const pw = W - 80
  const pyTop = 118
  const HEAD = 148 // title + series plate above the first row
  /**
   * Readouts + the exchange shelf + the button, below the last row.
   *
   * Budgeted against the shelf, which is the tallest thing down here: the cards are seated at
   * `footTop + 162` and stand CARD_H tall, so this has to clear their bottom edge plus the CLOSE
   * button's own half-height with air between. At 332 it did not, and the button sat squarely on top
   * of the three price plates. If a fourth exchange slot is ever added, this grows with it.
   */
  const FOOT = 378
  const ph = HEAD + GRID_H + FOOT
  const gridTop = pyTop + HEAD
  const footTop = gridTop + GRID_H + 14

  const g = scene.add.graphics()
  panelPlate(g, px, pyTop, pw, ph, 30)

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'CHARMS', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: T.goldText })
    .setOrigin(0.5)
    .setLetterSpacing(4)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)

  // Series plate — a rose lozenge, because a completed album ROLLS OVER into a new series and the
  // number is the only thing on screen that says the collection keeps going after the ninth charm.
  const seriesText = `SERIES ${seriesLabel(save.charmSeries)}`
  const plate = scene.add.graphics()
  const plateW = 40 + seriesText.length * 15
  plate.fillStyle(T.rose, 1)
  plate.fillRoundedRect(W / 2 - plateW / 2, pyTop + 90, plateW, 36, 18)
  const seriesLabelText = scene.add
    .text(W / 2, pyTop + 108, seriesText, { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: T.onRose })
    .setOrigin(0.5)
    .setLetterSpacing(2)

  layer.add([scrim, ...scrimKit.art, g, block, title, plate, seriesLabelText])

  // ── The nine slots ──
  const slots: Phaser.GameObjects.Container[] = []
  CHARMS.forEach((charm, i) => {
    const cx = W / 2 - GRID_W / 2 + CELL / 2 + (i % 3) * (CELL + GAP)
    const cy = gridTop + CELL / 2 + Math.floor(i / 3) * (CELL + GAP)
    const has = owned.has(charm.id)
    const c = scene.add.container(cx, cy)
    const tile = scene.add.graphics()
    const S = CELL - 10
    if (has) {
      // Owned: a warm lit plate with a gold bezel — the same "this is yours" language the star
      // milestones and the chip balance use.
      tile.fillStyle(T.goldDeep, 1)
      tile.fillRoundedRect(-S / 2, -S / 2, S, S, 20)
      tile.fillStyle(T.cardFillWarm, 1)
      tile.fillRoundedRect(-S / 2 + 4, -S / 2 + 4, S - 8, S - 8, 17)
      tile.lineStyle(3, T.gold, 1)
      tile.strokeRoundedRect(-S / 2 + 2, -S / 2 + 2, S - 4, S - 4, 18)
      tile.fillStyle(0xffffff, 0.4)
      tile.fillRoundedRect(-S / 2 + 10, -S / 2 + 8, S - 20, S * 0.3, 12)
    } else {
      // Locked: a recessed empty socket. Flat and cool, so a filled album reads as lit up next to it.
      tile.fillStyle(T.border, 0.5)
      tile.fillRoundedRect(-S / 2, -S / 2, S, S, 20)
      tile.fillStyle(T.cardFillAlt, 1)
      tile.fillRoundedRect(-S / 2 + 3, -S / 2 + 3, S - 6, S - 6, 18)
      tile.lineStyle(2, T.border, 0.8)
      tile.strokeRoundedRect(-S / 2 + 3, -S / 2 + 3, S - 6, S - 6, 18)
    }
    c.add(tile)

    const key = ensureGlyphTexture(scene, `charm:${charm.id}`, charm.emoji, 96, 128)
    const icon = scene.add.image(0, has ? -8 : 0, key).setDisplaySize(66, 66)
    if (!has) {
      // Silhouette, not a blank: the player can see WHICH charm is missing, which is the difference
      // between "five of nine" and "I still need the butterfly".
      //
      // Tinted NAVY rather than the border colour — a border-tinted glyph at half alpha sits about
      // two shades off the cream tile it is drawn on, which turned the ladybug and the ribbon into
      // featureless blobs and cost the slot the only job it has. Navy at ~a third alpha keeps it
      // clearly unowned while leaving the shape identifiable.
      icon.setTintFill(T.navy).setAlpha(0.34).setDisplaySize(56, 56)
    }
    c.add(icon)

    if (has) {
      c.add(
        scene.add
          .text(0, S / 2 - 20, charm.label, { fontFamily: FONT, fontSize: '13px', fontStyle: '900', color: T.inkSoft })
          .setOrigin(0.5)
          .setLetterSpacing(1)
      )
    }
    layer.add(c)
    slots.push(c)
  })

  // ── Readouts ──
  const have = CHARMS.filter(c => owned.has(c.id)).length

  layer.add(
    scene.add
      .text(W / 2, footTop + 12, `${have} OF ${SERIES_SIZE} COLLECTED`, {
        fontFamily: FONT,
        fontSize: '24px',
        fontStyle: '900',
        color: have === SERIES_SIZE ? css(T.rose) : T.ink,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )

  // What a charm DOES, stated plainly. The luck line is the reason to care about the ninth slot
  // rather than the eighth, so it never gets buried in a tooltip.
  layer.add(
    scene.add
      .text(
        W / 2,
        footTop + 42,
        luck >= LUCK_CAP ? `LUCK ${luck} · MAXED — the best odds in the Deal` : `LUCK ${luck} · richer cards in the LUCKY DEAL`,
        { fontFamily: 'Arial, sans-serif', fontSize: '18px', color: luck > 0 ? T.goldText : T.inkMuted }
      )
      .setOrigin(0.5)
  )
  layer.add(
    scene.add
      .text(W / 2, footTop + 68, 'Turn three HEARTS in the Lucky Deal to win a charm.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
        color: T.inkMuted,
      })
      .setOrigin(0.5)
  )

  // ── THE EXCHANGE ──
  const rule = scene.add.graphics()
  rule.fillStyle(T.border, 0.7)
  rule.fillRect(px + 60, footTop + 92, pw - 120, 2)
  layer.add(rule)
  layer.add(
    scene.add
      .text(W / 2, footTop + 116, 'EXCHANGE CHARMS', { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setLetterSpacing(3)
  )
  // Stated where the spending happens, because it is the fact that makes the shelf safe to use: a
  // purchase can set back the ninth slot, and that is ALL it can do. `flash` borrows this exact slot
  // for its confirmation line — one line of subtitle, showing whichever of the two is useful now.
  const safetyLine = scene.add
    .text(W / 2, footTop + 138, 'Spending never costs you luck.', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '15px',
      color: T.inkFaint,
    })
    .setOrigin(0.5)
  layer.add(safetyLine)

  /** Two-tap arming state — which item is currently waiting for its confirming second tap. */
  let armed: CharmExchangeItem | null = null
  let disarm: Phaser.Time.TimerEvent | null = null

  const buy = (item: CharmExchangeItem): void => {
    const out = redeemCharms(item, todayKey())
    if (!out) {
      // Only reachable for a FREE SPIN whose bank filled up — the pill is already ghosted when the
      // album can't afford something, so an affordable item refusing means the reward, not the price.
      sfx.invalidThud()
      flash('YOUR SPIN BANK IS FULL')
      return
    }
    sfx.coinCount()
    if (item.kind === 'deal') {
      // The one item this module fulfils itself: close the album and deal a hand on the spot. The
      // Deal overlay is scene-agnostic (it borrows whatever scene hosts it, exactly as it does over
      // the win card), so this works from Home with no scene swap.
      //
      // `onChanged` fires on the Deal's CLAIM, never before it — the host refresh is a scene restart,
      // and calling it here would destroy the overlay on the frame it opened. Claim is the right
      // moment anyway: by then the hand has banked its own winnings, so one refresh covers the
      // charms spent AND whatever they bought.
      layer.destroy()
      sfx.whoosh()
      openDeal(scene, { onClaim: () => opts.onChanged?.() })
      return
    }
    flash(item.kind === 'hearts' ? 'HEARTS REFILLED' : '+1 FREE SPIN')
    // Repaint after the flash has been read, so the spent slots visibly empty rather than blinking.
    // The panel STAYS OPEN — the host is refreshed on close, so a second purchase is one tap away.
    scene.time.delayedCall(reduced ? 0 : 620, repaint)
  }

  /** A short confirmation line over the shelf — cheaper than a toast system for three outcomes. */
  const flash = (text: string): void => {
    safetyLine.setVisible(false) // it owns this slot; two lines stacked here would collide
    const t = scene.add
      .text(W / 2, footTop + 138, text, { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: css(T.rose) })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    layer.add(t)
    if (reduced) {
      scene.time.delayedCall(900, () => {
        t.destroy()
        if (safetyLine.active) safetyLine.setVisible(true)
      })
      return
    }
    t.setScale(0.7)
    scene.tweens.add({ targets: t, scale: 1, duration: 260, ease: backOut(OVERSHOOT.pop) })
    scene.tweens.add({
      targets: t,
      alpha: 0,
      y: footTop + 126,
      duration: 320,
      delay: 700,
      ease: E.exit,
      onComplete: () => {
        t.destroy()
        // Only for a refusal — a successful buy repaints the whole panel before this lands.
        if (safetyLine.active) safetyLine.setVisible(true)
      },
    })
  }

  const CARD_W = 196
  const CARD_H = 104
  const CARD_GAP = 12
  CHARM_EXCHANGE.forEach((item, i) => {
    const cx = W / 2 + (i - (CHARM_EXCHANGE.length - 1) / 2) * (CARD_W + CARD_GAP)
    const cy = footTop + 162 + CARD_H / 2
    const affordable = canAfford(save, item)
    const c = scene.add.container(cx, cy)
    const plateG = scene.add.graphics()
    const paint = (confirming: boolean): void => {
      plateG.clear()
      plateG.fillStyle(T.shadow, 0.16)
      plateG.fillRoundedRect(-CARD_W / 2, -CARD_H / 2 + 4, CARD_W, CARD_H, 18)
      plateG.fillStyle(confirming ? T.rose : affordable ? T.gold : T.cardFillAlt, 1)
      plateG.fillRoundedRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 18)
      plateG.lineStyle(3, confirming ? T.roseDeep : affordable ? T.goldDeep : T.border, 1)
      plateG.strokeRoundedRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 18)
      plateG.fillStyle(0xffffff, confirming ? 0.16 : affordable ? 0.28 : 0.4)
      plateG.fillRoundedRect(-CARD_W / 2 + 8, -CARD_H / 2 + 5, CARD_W - 16, CARD_H * 0.34, 12)
    }
    paint(false)
    const ink = (): string => (armed === item ? T.onRose : affordable ? T.goldPillText : T.inkFaint)
    const label = scene.add
      .text(0, -30, item.label, { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: ink() })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    const blurb = scene.add
      .text(0, -2, item.blurb, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '13px',
        color: affordable ? T.goldPillText : T.inkFaint,
        wordWrap: { width: CARD_W - 24 },
        align: 'center',
      })
      .setOrigin(0.5)
    const priceText = `${item.price} CHARM${item.price === 1 ? '' : 'S'}`
    const price = scene.add
      .text(0, 34, priceText, { fontFamily: FONT, fontSize: '16px', fontStyle: '900', color: ink() })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    c.add([plateG, label, blurb, price])

    if (affordable) {
      // Hit-rect grown to the ≥44pt floor (cookbook §9); the visual plate keeps its authored size.
      c.setSize(Math.max(CARD_W, 84), Math.max(CARD_H, 84)).setInteractive({ useHandCursor: true })
      c.on('pointerdown', () => {
        if (armed === item) {
          disarm?.remove(false)
          buy(item)
          return
        }
        // ARM, don't buy. Charms are the one thing in the game you cannot re-earn quickly, so a
        // mis-tap that spent two of them would be the single worst accident the UI allows. A second
        // deliberate tap costs nothing and removes the whole class of regret.
        sfx.uiTap()
        armed = item
        paint(true)
        label.setText('TAP TO CONFIRM').setColor(T.onRose)
        price.setColor(T.onRose)
        disarm?.remove(false)
        disarm = scene.time.delayedCall(2600, () => {
          if (armed !== item || !c.active) return
          armed = null
          paint(false)
          label.setText(item.label).setColor(T.goldPillText)
          price.setColor(T.goldPillText)
        })
      })
    }
    layer.add(c)
  })

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 50, 240, 64, 'CLOSE', affordableAny() ? GHOST_PILL : GOLD_PILL, close))

  if (save.charmsAllTime > SERIES_SIZE) {
    layer.add(
      scene.add
        .text(px + pw - 22, pyTop + 26, `${save.charmsAllTime} all time`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '15px',
          color: T.inkFaint,
        })
        .setOrigin(1, 0.5)
    )
  }

  /** True when at least one shelf item is buyable — the CLOSE button steps back to GHOST if so, so the
   *  gold on screen belongs to the thing worth tapping rather than to the way out. */
  function affordableAny(): boolean {
    return CHARM_EXCHANGE.some(i => canAfford(save, i))
  }

  // ── Entrance: the card pops, then the slots fill in reading order ──
  if (!reduced) {
    layer.setAlpha(0)
    scene.tweens.add({ targets: layer, alpha: 1, duration: 200, ease: E.press })
    slots.forEach((s, i) => {
      s.setScale(0)
      scene.tweens.add({ targets: s, scale: 1, duration: 300, delay: 90 + i * 36, ease: backOut(OVERSHOOT.pop) })
    })
  }
}

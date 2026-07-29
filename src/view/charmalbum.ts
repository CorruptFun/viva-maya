import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { CHARMS, LUCK_CAP, SERIES_SIZE, luckOf, seriesLabel } from '../core/charms'
import { loadSave } from '../core/save'
import { backOut, E, OVERSHOOT } from './motion'
import { css, getTheme, prefersReducedMotion } from './theme'
import { ensureGlyphTexture } from './textures'
import { addPillButton, addRoundChip, FONT, GOLD_PILL } from './ui'

/**
 * The Home corner chip that opens the album — a charm glyph with a live "N/9" collar.
 *
 * The collar is the whole reason this is a chip and not a menu item. A count sitting on the top bar
 * next to the chip balance turns the collection into ambient state the player passes every session,
 * so the gap between what they have and nine is visible without anyone opening anything — which is
 * exactly the pull an album is supposed to exert, and it costs one 52px chip.
 */
export function addCharmChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
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
      openCharmAlbum(scene)
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

/**
 * THE CHARM ALBUM — where the collection lives.
 *
 * A collectible with nowhere to be looked at is not a collection, it is a log line. This panel is
 * the whole point of charms existing: nine slots, the ones you have filled in and the ones you have
 * not sitting there in silhouette, so the gap is a thing you can see rather than a number you have
 * to remember. That visible gap is the entire retention mechanic — it is why the genre's albums
 * work, and it costs one screen.
 *
 * Deliberately READ-ONLY. Nothing here is claimable, spendable or tappable-for-reward: it is a
 * shelf, not another faucet. Every charm arrives from exactly one place (the HEART card in the Lucky
 * Deal), and the panel says so in as many words, because a collection whose source is a mystery
 * reads as something you are being teased with rather than something you are playing for.
 *
 * Same panel idiom as `openHelpPanel` / the theme picker (scrim + card + tap-outside-to-close), so it
 * opens from Home without a scene swap and cannot strand the player anywhere.
 */
export function openCharmAlbum(scene: Phaser.Scene): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const save = loadSave()
  const owned = new Set(save.charms)
  const luck = luckOf(save)
  const W = DESIGN_W
  const layer = scene.add.container(0, 0).setDepth(60)

  const close = (): void => {
    sfx.whoosh()
    layer.destroy()
  }

  const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH() + 400, T.scrim, 0.62).setInteractive()
  scrim.on('pointerup', close)

  // ── Layout, derived from the grid so the card can never crop it ──
  const CELL = 148
  const GAP = 18
  const GRID_W = CELL * 3 + GAP * 2 // 480
  const GRID_H = CELL * 3 + GAP * 2
  const px = 40
  const pw = W - 80
  const pyTop = 132
  const HEAD = 152 // title + series plate above the first row
  const FOOT = 214 // progress, luck, source line and the button below the last row
  const ph = HEAD + GRID_H + FOOT
  const gridTop = pyTop + HEAD

  const g = scene.add.graphics()
  // Drop shadow — three stacked copies nudged straight down, all agreeing with the one key light.
  for (let i = 0; i < 3; i++) {
    g.fillStyle(T.shadow, 0.06)
    g.fillRoundedRect(px - i, pyTop + 6 + i * 4, pw + i * 2, ph, 30)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, T.goldBezel, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 58, 'CHARMS', { fontFamily: FONT, fontSize: '48px', fontStyle: '900', color: T.goldText })
    .setOrigin(0.5)
    .setLetterSpacing(4)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)

  // Series plate — a rose lozenge, because a completed album ROLLS OVER into a new series and the
  // number is the only thing on screen that says the collection keeps going after the ninth charm.
  const seriesText = `SERIES ${seriesLabel(save.charmSeries)}`
  const plate = scene.add.graphics()
  const plateW = 40 + seriesText.length * 15
  plate.fillStyle(T.rose, 1)
  plate.fillRoundedRect(W / 2 - plateW / 2, pyTop + 92, plateW, 38, 19)
  const seriesLabelText = scene.add
    .text(W / 2, pyTop + 111, seriesText, { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: T.onRose })
    .setOrigin(0.5)
    .setLetterSpacing(2)

  layer.add([scrim, g, block, title, plate, seriesLabelText])

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
      tile.fillRoundedRect(-S / 2, -S / 2, S, S, 22)
      tile.fillStyle(T.cardFillWarm, 1)
      tile.fillRoundedRect(-S / 2 + 4, -S / 2 + 4, S - 8, S - 8, 19)
      tile.lineStyle(3, T.gold, 1)
      tile.strokeRoundedRect(-S / 2 + 2, -S / 2 + 2, S - 4, S - 4, 20)
      tile.fillStyle(0xffffff, 0.4)
      tile.fillRoundedRect(-S / 2 + 10, -S / 2 + 8, S - 20, S * 0.3, 14)
    } else {
      // Locked: a recessed empty socket. Flat and cool, so a filled album reads as lit up next to it.
      tile.fillStyle(T.border, 0.5)
      tile.fillRoundedRect(-S / 2, -S / 2, S, S, 22)
      tile.fillStyle(T.cardFillAlt, 1)
      tile.fillRoundedRect(-S / 2 + 3, -S / 2 + 3, S - 6, S - 6, 20)
      tile.lineStyle(2, T.border, 0.8)
      tile.strokeRoundedRect(-S / 2 + 3, -S / 2 + 3, S - 6, S - 6, 20)
    }
    c.add(tile)

    const key = ensureGlyphTexture(scene, `charm:${charm.id}`, charm.emoji, 96, 128)
    const icon = scene.add.image(0, has ? -8 : 0, key).setDisplaySize(74, 74)
    if (!has) {
      // Silhouette, not a blank: the player can see WHICH charm is missing, which is the difference
      // between "five of nine" and "I still need the butterfly".
      //
      // Tinted NAVY rather than the border colour — a border-tinted glyph at half alpha sits about
      // two shades off the cream tile it is drawn on, which turned the ladybug and the ribbon into
      // featureless blobs and cost the slot the only job it has. Navy at ~a third alpha keeps it
      // clearly unowned while leaving the shape identifiable.
      icon.setTintFill(T.navy).setAlpha(0.34).setDisplaySize(62, 62)
    }
    c.add(icon)

    if (has) {
      c.add(
        scene.add
          .text(0, S / 2 - 22, charm.label, { fontFamily: FONT, fontSize: '15px', fontStyle: '900', color: T.inkSoft })
          .setOrigin(0.5)
          .setLetterSpacing(1)
      )
    }
    layer.add(c)
    slots.push(c)
  })

  // ── Readouts ──
  const have = CHARMS.filter(c => owned.has(c.id)).length
  const footTop = gridTop + GRID_H + 18

  const progress = scene.add
    .text(W / 2, footTop + 14, `${have} OF ${SERIES_SIZE} COLLECTED`, {
      fontFamily: FONT,
      fontSize: '26px',
      fontStyle: '900',
      color: have === SERIES_SIZE ? css(T.rose) : T.ink,
    })
    .setOrigin(0.5)
    .setLetterSpacing(2)

  // What a charm DOES, stated plainly. The luck line is the reason to care about the ninth slot
  // rather than the eighth, so it never gets buried in a tooltip.
  const luckLine =
    luck >= LUCK_CAP
      ? `LUCK ${luck} · MAXED — the best odds in the Deal`
      : `LUCK ${luck} · richer cards in the LUCKY DEAL`
  const luckText = scene.add
    .text(W / 2, footTop + 52, luckLine, {
      fontFamily: 'Arial, sans-serif',
      fontSize: '19px',
      color: luck > 0 ? T.goldText : T.inkMuted,
    })
    .setOrigin(0.5)

  const source = scene.add
    .text(W / 2, footTop + 84, 'Turn three HEARTS in the Lucky Deal to win a charm.', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '18px',
      color: T.inkMuted,
      wordWrap: { width: pw - 80 },
      align: 'center',
    })
    .setOrigin(0.5)

  layer.add([progress, luckText, source])

  if (save.charmsAllTime > SERIES_SIZE) {
    layer.add(
      scene.add
        .text(W / 2, footTop + 112, `${save.charmsAllTime} collected all time`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '16px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 54, 240, 68, 'CLOSE', GOLD_PILL, close))

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

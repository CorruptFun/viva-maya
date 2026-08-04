import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { EVENTS, track } from '../core/analytics'
import { CHAPTER_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { TROPHIES } from '../core/trophies'
import { backOut, OVERSHOOT } from './motion'
import { css, getTheme, prefersReducedMotion } from './theme'
import { ensureGlyphTexture } from './textures'
import { addPillButton, FONT, GHOST_PILL } from './ui'

/**
 * THE SHOWROOM — the trophy case. One overlay panel (charmalbum's idiom: scrim + cream card, no
 * scene swap), showing all thirty chapter trophies on plinths: owned ones lit on warm gold plates,
 * the rest as navy silhouettes in recessed sockets — same "you can see WHICH one is missing"
 * language as the album, and the same silhouette-legibility constraint on the emoji (see
 * core/trophies.ts TROPHIES).
 *
 * The hero strip is the GRAND PRIZE podium: chapter 30's car under a spotlight, visible as a
 * silhouette from the very first open — the thing the whole ladder is a drive toward. Its name
 * stays hidden until it is won; the shape is the tease.
 *
 * Perf: the thirty slots share exactly TWO baked plinth-tile textures (owned/locked, theme-keyed)
 * plus glyph textures — thirty Images batch into a handful of draw calls, where thirty Graphics
 * would each break the batch (the N-Graphics rule).
 *
 * Read-only by design: nothing here spends or claims, so there is no repaint loop (and none of the
 * album's rebuild-inside-pointerup hazard — anyone adding per-plinth interaction later: defer any
 * rebuild with scene.time.delayedCall(0), see charmalbum.repaint).
 */

export interface ShowroomOpts {
  /** Pulse a ring around this chapter's plinth on open (the ribbon door passes its own chapter). */
  focusChapter?: number
  /** DEV fixture (?showroom=N): treat chapters 1..N as owned — presentation only, ignored in prod. */
  ownedOverride?: number
}

const COLS = 5
const CELL = 112
const GAP = 8
const GRID_W = COLS * CELL + (COLS - 1) * GAP // 592

/** Bake one plinth tile (owned or locked) per theme — the grid's two shared textures. */
function plinthTile(scene: Phaser.Scene, owned: boolean): string {
  const T = getTheme()
  const key = `showroom:tile:${T.id}:${owned ? 'owned' : 'locked'}`
  if (scene.textures.exists(key)) return key
  const S = CELL - 6
  const g = scene.add.graphics()
  if (owned) {
    // The album's "this is yours" recipe: warm lit plate, gold bezel, gloss band.
    g.fillStyle(T.goldDeep, 1)
    g.fillRoundedRect(0, 0, S, S, 18)
    g.fillStyle(T.cardFillWarm, 1)
    g.fillRoundedRect(4, 4, S - 8, S - 8, 15)
    g.lineStyle(3, T.gold, 1)
    g.strokeRoundedRect(2, 2, S - 4, S - 4, 16)
    g.fillStyle(0xffffff, 0.4)
    g.fillRoundedRect(9, 7, S - 18, S * 0.28, 10)
    // The plinth shelf the trophy stands on.
    g.fillStyle(T.gold, 1)
    g.fillRoundedRect(12, S - 26, S - 24, 10, 4)
  } else {
    // Recessed cool socket, so an earned shelf reads as lit up next to it.
    g.fillStyle(T.border, 0.5)
    g.fillRoundedRect(0, 0, S, S, 18)
    g.fillStyle(T.cardFillAlt, 1)
    g.fillRoundedRect(3, 3, S - 6, S - 6, 16)
    g.lineStyle(2, T.border, 0.8)
    g.strokeRoundedRect(3, 3, S - 6, S - 6, 16)
    g.fillStyle(T.border, 0.6)
    g.fillRoundedRect(12, S - 26, S - 24, 10, 4)
  }
  g.generateTexture(key, S, S)
  g.destroy()
  return key
}

/** Open the trophy case. Scrim tap or CLOSE dismisses; nothing here mutates the save. */
export function openShowroom(scene: Phaser.Scene, opts: ShowroomOpts = {}): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const W = DESIGN_W
  const save = loadSave()
  const override = import.meta.env.DEV && opts.ownedOverride ? Math.floor(opts.ownedOverride) : 0
  const owned = override
    ? new Set(Array.from({ length: Math.min(override, CHAPTER_COUNT) }, (_, i) => i + 1))
    : new Set(save.chapterRewards)
  const ownedCount = TROPHIES.filter(t => owned.has(t.chapter)).length
  const car = TROPHIES[CHAPTER_COUNT - 1]
  const hasCar = owned.has(car.chapter)

  track(EVENTS.SHOWROOM_OPEN, { trophies: ownedCount })

  const layer = scene.add.container(0, 0).setDepth(60)
  const close = (): void => {
    sfx.whoosh()
    layer.destroy()
  }
  const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH() + 400, T.scrim, 0.62).setInteractive()
  scrim.on('pointerup', close)
  layer.add(scrim)

  // ── Layout, derived from the grid so the card can never crop it ──
  const px = 40
  const pw = W - 80
  /**
   * The card's top edge must land in CLEAN air on its host, and the two hosts stack their chrome
   * at different heights — so one seat cannot serve both. A half-covered control reads as BROKEN,
   * where fully-visible-then-dimmed and fully-covered both read as "a modal is open".
   *
   * HOME: the chip rail is centred at y=44 (52px art → bottom ≈70, press pedestal ≈74). A top edge
   * at 56 sliced all six chips through the middle (owner screenshot, 2026-08-04) → seat 84, below
   * the rail. Bottom stays clear: 84 + ph(1156) = 1240 of 1280.
   *
   * LEVELSELECT keeps 56, and it is a compromise, not clean air: the header row (back 56–112,
   * stash door 60–108, wordmark 59–119) is covered whole, but the mute chip at (676, 40) spans
   * x 650–702 — PAST the card's right edge at 680 — so no seat can cover it: 56 grazes its
   * bottom-left with only the corner arc (a crescent a few px deep, verified invisible in
   * practice), while ≤14 would run the card's right edge straight through it and 84 would slice
   * the entire header row. If the mute chip ever moves inboard (x ≤ ~648), drop this seat to 12
   * and the compromise disappears.
   */
  const pyTop = scene.scene.key === 'home' ? 84 : 56
  const HEAD = 118 // title + tally
  const HERO = 168 // the grand-prize podium strip
  const ROWS = Math.ceil(CHAPTER_COUNT / COLS)
  const GRID_H = ROWS * CELL + (ROWS - 1) * GAP
  const FOOT = 132 // provenance line + CLOSE, with clear air between them (92 sat the button on the text)
  const ph = HEAD + HERO + GRID_H + FOOT + 26
  const heroTop = pyTop + HEAD
  const gridTop = heroTop + HERO + 12

  const g = scene.add.graphics()
  for (let i = 0; i < 3; i++) {
    g.fillStyle(T.shadow, 0.06)
    g.fillRoundedRect(px - i, pyTop + 6 + i * 4, pw + i * 2, ph, 30)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, T.goldBezel, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)
  layer.add(g)
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()
  layer.add(block)

  const title = scene.add
    .text(W / 2, pyTop + 52, 'THE SHOWROOM', { fontFamily: FONT, fontSize: '44px', fontStyle: '900', color: T.goldText })
    .setOrigin(0.5)
    .setLetterSpacing(4)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  layer.add(title)
  layer.add(
    scene.add
      .text(W / 2, pyTop + 94, `${ownedCount} OF ${CHAPTER_COUNT} TROPHIES`, {
        fontFamily: FONT,
        fontSize: '19px',
        fontStyle: '900',
        color: css(T.rose),
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )

  // ── The GRAND PRIZE podium ──
  const heroCy = heroTop + HERO / 2
  const hero = scene.add.graphics()
  // A dark stage recess, so the spotlight has a room to light.
  hero.fillStyle(T.navy, hasCar ? 0.14 : 0.22)
  hero.fillRoundedRect(px + 18, heroTop, pw - 36, HERO - 8, 22)
  hero.lineStyle(2, hasCar ? T.gold : T.border, 0.9)
  hero.strokeRoundedRect(px + 18, heroTop, pw - 36, HERO - 8, 22)
  // The podium: a wide two-step plinth, centre stage.
  hero.fillStyle(0x000000, 0.16)
  hero.fillEllipse(W / 2, heroTop + HERO - 26, 250, 22)
  hero.fillStyle(T.goldDeep, 1)
  hero.fillRoundedRect(W / 2 - 96, heroTop + HERO - 58, 192, 34, 9)
  hero.fillStyle(T.gold, 1)
  hero.fillRoundedRect(W / 2 - 108, heroTop + HERO - 68, 216, 14, 7)
  hero.fillStyle(0xffffff, 0.28)
  hero.fillRoundedRect(W / 2 - 100, heroTop + HERO - 66, 200, 5, 2)
  layer.add(hero)
  // Spotlight cone (baked glow, additive) — skipped when the host scene never baked it.
  if (scene.textures.exists('bgglow')) {
    layer.add(
      scene.add
        .image(W / 2, heroCy - 8, 'bgglow')
        .setTint(hasCar ? T.goldBright : T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(360, HERO + 60)
        .setAlpha(hasCar ? 0.34 : 0.18)
    )
  }
  const carKey = ensureGlyphTexture(scene, `trophy:${car.chapter}`, car.emoji, 96, 128)
  const carIcon = scene.add.image(W / 2, heroTop + HERO - 106, carKey).setDisplaySize(92, 92)
  if (!hasCar) carIcon.setTintFill(T.navy).setAlpha(0.38)
  layer.add(carIcon)
  layer.add(
    scene.add
      .text(W / 2 - 0, heroTop + 22, 'GRAND PRIZE · CHAPTER 30', {
        fontFamily: FONT,
        fontSize: '15px',
        fontStyle: '900',
        color: hasCar ? T.goldText : T.inkMuted,
      })
      .setOrigin(0.5)
      .setLetterSpacing(3)
  )
  if (hasCar) {
    layer.add(
      scene.add
        .text(W / 2, heroTop + HERO - 44, car.label, {
          fontFamily: FONT,
          fontSize: '20px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
        .setLetterSpacing(3)
        .setStroke('#ffffff', 4)
    )
  }

  // ── The thirty plinths ──
  const ownedTile = plinthTile(scene, true)
  const lockedTile = plinthTile(scene, false)
  const slots: Phaser.GameObjects.Container[] = []
  let focusSlot: Phaser.GameObjects.Container | null = null
  TROPHIES.forEach((trophy, i) => {
    const cx = W / 2 - GRID_W / 2 + CELL / 2 + (i % COLS) * (CELL + GAP)
    const cy = gridTop + CELL / 2 + Math.floor(i / COLS) * (CELL + GAP)
    const has = owned.has(trophy.chapter)
    const c = scene.add.container(cx, cy)
    c.add(scene.add.image(0, 0, has ? ownedTile : lockedTile))
    const key = ensureGlyphTexture(scene, `trophy:${trophy.chapter}`, trophy.emoji, 96, 128)
    const icon = scene.add.image(0, has ? -10 : -6, key).setDisplaySize(60, 60)
    if (!has) {
      // Silhouette, not a blank — the same rule as the album's missing charms (and the reason every
      // TROPHIES glyph must keep a readable outline).
      icon.setTintFill(T.navy).setAlpha(0.34).setDisplaySize(52, 52)
    }
    c.add(icon)
    c.add(
      scene.add
        .text(0, CELL / 2 - 18, `CH ${trophy.chapter}`, {
          fontFamily: FONT,
          fontSize: '12px',
          fontStyle: '900',
          color: has ? T.inkSoft : T.inkFaint,
        })
        .setOrigin(0.5)
        .setLetterSpacing(1)
    )
    layer.add(c)
    slots.push(c)
    if (opts.focusChapter === trophy.chapter) focusSlot = c
  })

  layer.add(
    scene.add
      .text(W / 2, gridTop + GRID_H + 30, 'Close a chapter to add its trophy — and bank its purse.', {
        fontFamily: FONT,
        fontSize: '16px',
        color: T.inkFaint,
      })
      .setOrigin(0.5)
  )
  const closeBtn = addPillButton(scene, W / 2, pyTop + ph - 52, 200, 52, 'CLOSE', GHOST_PILL, close)
  layer.add(closeBtn)

  // ── Entrance ──
  if (!reduced) {
    layer.setAlpha(0)
    scene.tweens.add({ targets: layer, alpha: 1, duration: 200, ease: 'Sine.easeOut' })
    slots.forEach((slot, i) => {
      slot.setScale(0.6).setAlpha(0)
      scene.tweens.add({
        targets: slot,
        scale: 1,
        alpha: 1,
        duration: 240,
        delay: 120 + i * 20,
        ease: backOut(OVERSHOOT.gentle),
      })
    })
  }
  // The ribbon door passes its chapter: one gold ring pulse says "this is the one you tapped".
  if (focusSlot && !reduced) {
    const target: Phaser.GameObjects.Container = focusSlot
    const ring = scene.add.graphics()
    ring.lineStyle(4, T.gold, 1)
    ring.strokeRoundedRect(target.x - CELL / 2 + 2, target.y - CELL / 2 + 2, CELL - 4, CELL - 4, 18)
    ring.setAlpha(0)
    layer.add(ring)
    scene.tweens.add({
      targets: ring,
      alpha: 1,
      duration: 260,
      delay: 120 + slots.indexOf(target) * 20 + 240,
      yoyo: true,
      hold: 420,
      repeat: 1,
      ease: 'Sine.easeInOut',
      onComplete: () => ring.destroy(),
    })
  }
}

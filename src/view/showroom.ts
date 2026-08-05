import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { EVENTS, track } from '../core/analytics'
import { CHAPTER_LEVELS } from '../core/levels'
import { loadSave } from '../core/save'
import { TROPHY_WINGS, WING_CHAPTERS, trophyFor, wingForChapter } from '../core/trophies'
import type { TrophyWing } from '../core/trophies'
import { backOut, OVERSHOOT } from './motion'
import { css, getTheme, prefersReducedMotion } from './theme'
import { ensureGlyphTexture } from './textures'
import { addPillButton, FONT, GHOST_PILL } from './ui'

/**
 * THE SHOWROOM — the trophy case. One overlay panel (charmalbum's idiom: scrim + cream card, no
 * scene swap), showing chapter trophies on plinths: owned ones lit on warm gold plates, the rest as
 * navy silhouettes in recessed sockets — same "you can see WHICH one is missing" language as the
 * album, and the same silhouette-legibility constraint on the emoji (see core/trophies.ts TROPHIES).
 *
 * The hero strip is the GRAND PRIZE podium, visible as a silhouette from the very first open — the
 * thing the whole ladder is a drive toward. Its name stays hidden until it is won; the shape is the
 * tease.
 *
 * ── WHY THERE ARE WINGS ─────────────────────────────────────────────────────────────────────
 * At forty chapters one grid is eight rows and runs straight off the bottom of the 720×1280 design
 * box. Growing the card was never an option: its height is 1156 because that is what fits under
 * BOTH host seats (Home's 84, LevelSelect's 56 — see the seat note below), and both were fought for.
 *
 * So the card gained a TAB RAIL instead, one tab per act, each wing exactly `WING_CHAPTERS` wide.
 * That keeps the grid at six rows forever, however far the ladder runs, and `ph` below still
 * evaluates to the same 1156 it always did. Only the ACTIVE wing builds — switching rebuilds one
 * sub-container and leaves the scrim, the card and the rail alone.
 *
 * A wing shows its whole ACT, including chapters the catalogue has not reached yet; those render as
 * empty sockets. That is deliberate tease-don't-leak: the floor plan says there is more up here
 * without describing a single unshipped prize.
 *
 * Perf: every slot shares exactly TWO baked plinth-tile textures (owned/locked, theme-keyed) plus
 * glyph textures — thirty Images batch into a handful of draw calls, where thirty Graphics would
 * each break the batch (the N-Graphics rule).
 *
 * Read-only by design: nothing here spends or claims. The tab rail is the one interactive thing, and
 * it rebuilds only `wingLayer` — never the scrim — so it cannot reproduce charmalbum's
 * rebuild-inside-pointerup self-close. It still defers with `delayedCall(0)`, because the cheapest
 * moment to respect that rule is before you have a reason to.
 */

export interface ShowroomOpts {
  /** Pulse a ring around this chapter's plinth on open (the ribbon door passes its own chapter).
   *  Also picks the WING: tapping chapter 33's ribbon must not land you on the main floor. */
  focusChapter?: number
  /** DEV fixture (?showroom=N): treat chapters 1..N as owned — presentation only, ignored in prod. */
  ownedOverride?: number
}

const COLS = 5
const CELL = 112
const GAP = 8
const GRID_W = COLS * CELL + (COLS - 1) * GAP // 592
/** Rows per wing. `WING_CHAPTERS / COLS` = 6 — the number the card's height was budgeted around. */
const ROWS = WING_CHAPTERS / COLS
const TAB_H = 42
const TAB_GAP = 10

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

/** Bake one tab face per state — two textures, so the rail costs no per-frame Graphics either. */
function tabPlate(scene: Phaser.Scene, w: number, active: boolean): string {
  const T = getTheme()
  const key = `showroom:tab:${T.id}:${w}:${active ? 'on' : 'off'}`
  if (scene.textures.exists(key)) return key
  const g = scene.add.graphics()
  const r = TAB_H / 2 - 1 // §2c — never exactly half, or the cap reads as a lozenge
  if (active) {
    g.fillStyle(T.goldDeep, 1)
    g.fillRoundedRect(0, 0, w, TAB_H, r)
    g.fillStyle(T.gold, 1)
    g.fillRoundedRect(1, 1, w - 2, TAB_H - 3, r)
    g.fillStyle(0xffffff, 0.32)
    g.fillRoundedRect(6, 4, w - 12, TAB_H * 0.34, r * 0.6)
  } else {
    g.fillStyle(T.cardFillAlt, 1)
    g.fillRoundedRect(0, 0, w, TAB_H, r)
    g.lineStyle(2, T.border, 0.85)
    g.strokeRoundedRect(1, 1, w - 2, TAB_H - 2, r)
  }
  g.generateTexture(key, w, TAB_H)
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
    ? new Set(Array.from({ length: override }, (_, i) => i + 1))
    : new Set(save.chapterRewards)
  const ownedCount = owned.size
  /** How many of THIS wing's chapters are on the shelf — what its tab counts. */
  const wingOwned = (wing: TrophyWing): number => {
    let n = 0
    for (let c = wing.chapterFrom; c <= wing.chapterTo; c++) if (owned.has(c)) n++
    return n
  }

  /**
   * Which tab opens. In order: the chapter the door named (a ribbon on floor 1 must not land you on
   * the main floor), else the act the player is actually progressing through — the wing you would
   * have scrolled to. `unlocked` is the highest ATTEMPTABLE level, so the chapter in play is
   * `floor((unlocked - 1) / CHAPTER_LEVELS) + 1`.
   */
  const playingChapter = Math.floor((Math.max(1, save.unlocked) - 1) / CHAPTER_LEVELS) + 1
  let wing = wingForChapter(opts.focusChapter ?? (override || playingChapter))

  track(EVENTS.SHOWROOM_OPEN, { trophies: ownedCount, wing: wing.id })

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
  /**
   * HEAD is UNCHANGED at 118 — the wing rail moved in, it did not push the card taller. The band now
   * carries the title (up from y+52 to y+38, one size down) and the tab rail at y+90; the global
   * "N OF 40 TROPHIES" tally that used to sit at y+94 became the per-wing count printed inside each
   * tab, which says more in less room. Everything below `ph` is byte-identical arithmetic, and it
   * still lands on 1156 — the one number in this file that may never move.
   */
  const HEAD = 118 // title + the wing rail
  const HERO = 168 // the grand-prize podium strip
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
    .text(W / 2, pyTop + 38, 'THE SHOWROOM', { fontFamily: FONT, fontSize: '40px', fontStyle: '900', color: T.goldText })
    .setOrigin(0.5)
    .setLetterSpacing(4)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  layer.add(title)

  // ── The wing rail ──
  // Persistent: tapping a tab repaints `wingLayer` and re-dresses these plates in place. Rebuilding
  // the rail would destroy the very object the pointer event is still travelling through.
  const railCy = pyTop + 90
  const tabW = Math.floor((pw - 44 - TAB_GAP * (TROPHY_WINGS.length - 1)) / TROPHY_WINGS.length)
  const railW = tabW * TROPHY_WINGS.length + TAB_GAP * (TROPHY_WINGS.length - 1)
  const tabs = TROPHY_WINGS.map((w, i) => {
    const cx = W / 2 - railW / 2 + tabW / 2 + i * (tabW + TAB_GAP)
    const c = scene.add.container(cx, railCy)
    const plate = scene.add.image(0, 0, tabPlate(scene, tabW, false))
    const label = scene.add
      .text(0, -7, w.tab, { fontFamily: FONT, fontSize: '15px', fontStyle: '900', color: T.ink })
      .setOrigin(0.5)
      .setLetterSpacing(2)
    const count = scene.add
      .text(0, 11, `${wingOwned(w)} / ${WING_CHAPTERS}`, { fontFamily: FONT, fontSize: '12px', fontStyle: '900', color: css(T.rose) })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    c.add([plate, label, count])
    c.setSize(tabW, TAB_H).setInteractive({ useHandCursor: true })
    layer.add(c)
    return { wing: w, tab: c, plate, label, count }
  })
  const dressTabs = (): void => {
    for (const t of tabs) {
      const on = t.wing.id === wing.id
      t.plate.setTexture(tabPlate(scene, tabW, on))
      t.label.setColor(on ? T.goldPillText : T.inkMuted)
      t.count.setColor(on ? T.goldPillText : T.inkFaint)
      t.count.setAlpha(on ? 0.9 : 1)
    }
  }

  // ── The wing content: podium + plinths + provenance, all repainted on a tab switch ──
  const ownedTile = plinthTile(scene, true)
  const lockedTile = plinthTile(scene, false)
  let wingLayer = scene.add.container(0, 0)
  layer.add(wingLayer)

  const paintWing = (animate: boolean): void => {
    wingLayer.destroy(true)
    wingLayer = scene.add.container(0, 0)
    // addAt(…, 1) keeps it directly above the scrim and BELOW everything already built (card, rail,
    // CLOSE), so a repaint can never end up drawing the grid over its own tabs.
    layer.addAt(wingLayer, 1)

    const hero = wing.hero
    const hasHero = owned.has(hero.chapter)

    // ── The GRAND PRIZE podium ──
    const heroCy = heroTop + HERO / 2
    const stage = scene.add.graphics()
    // A dark stage recess, so the spotlight has a room to light.
    stage.fillStyle(T.navy, hasHero ? 0.14 : 0.22)
    stage.fillRoundedRect(px + 18, heroTop, pw - 36, HERO - 8, 22)
    stage.lineStyle(2, hasHero ? T.gold : T.border, 0.9)
    stage.strokeRoundedRect(px + 18, heroTop, pw - 36, HERO - 8, 22)
    // The podium: a wide two-step plinth, centre stage.
    stage.fillStyle(0x000000, 0.16)
    stage.fillEllipse(W / 2, heroTop + HERO - 26, 250, 22)
    stage.fillStyle(T.goldDeep, 1)
    stage.fillRoundedRect(W / 2 - 96, heroTop + HERO - 58, 192, 34, 9)
    stage.fillStyle(T.gold, 1)
    stage.fillRoundedRect(W / 2 - 108, heroTop + HERO - 68, 216, 14, 7)
    stage.fillStyle(0xffffff, 0.28)
    stage.fillRoundedRect(W / 2 - 100, heroTop + HERO - 66, 200, 5, 2)
    wingLayer.add(stage)
    // Spotlight cone (baked glow, additive) — skipped when the host scene never baked it.
    if (scene.textures.exists('bgglow')) {
      wingLayer.add(
        scene.add
          .image(W / 2, heroCy - 8, 'bgglow')
          .setTint(hasHero ? T.goldBright : T.gold)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(360, HERO + 60)
          .setAlpha(hasHero ? 0.34 : 0.18)
      )
    }
    const heroKey = ensureGlyphTexture(scene, `trophy:${hero.chapter}`, hero.emoji, 96, 128)
    const heroIcon = scene.add.image(W / 2, heroTop + HERO - 106, heroKey).setDisplaySize(92, 92)
    // Unwon — INCLUDING "not built yet", and deliberately the same treatment. The car was a shape
    // long before it was a car; a prize an act above you has earned exactly that silhouette.
    if (!hasHero) heroIcon.setTintFill(T.navy).setAlpha(0.38)
    wingLayer.add(heroIcon)
    wingLayer.add(
      scene.add
        .text(W / 2, heroTop + 22, hero.caption, {
          fontFamily: FONT,
          fontSize: '15px',
          fontStyle: '900',
          color: hasHero ? T.goldText : T.inkMuted,
        })
        .setOrigin(0.5)
        .setLetterSpacing(3)
    )
    if (hasHero) {
      wingLayer.add(
        scene.add
          .text(W / 2, heroTop + HERO - 44, hero.label, {
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

    // ── This wing's plinths ──
    const slots: Phaser.GameObjects.Container[] = []
    let focusSlot: Phaser.GameObjects.Container | null = null
    for (let i = 0; i < WING_CHAPTERS; i++) {
      const chapter = wing.chapterFrom + i
      const cx = W / 2 - GRID_W / 2 + CELL / 2 + (i % COLS) * (CELL + GAP)
      const cy = gridTop + CELL / 2 + Math.floor(i / COLS) * (CELL + GAP)
      const trophy = trophyFor(chapter)
      const has = owned.has(chapter)
      const c = scene.add.container(cx, cy)
      c.add(scene.add.image(0, 0, has ? ownedTile : lockedTile))
      if (trophy) {
        const key = ensureGlyphTexture(scene, `trophy:${chapter}`, trophy.emoji, 96, 128)
        const icon = scene.add.image(0, has ? -10 : -6, key).setDisplaySize(60, 60)
        if (!has) {
          // Silhouette, not a blank — the same rule as the album's missing charms (and the reason
          // every TROPHIES glyph must keep a readable outline).
          icon.setTintFill(T.navy).setAlpha(0.34).setDisplaySize(52, 52)
        }
        c.add(icon)
      }
      // An EMPTY SOCKET — a chapter the catalogue has not reached — shows the plate and its number
      // and nothing else. Not a placeholder glyph: any shape here is a promise about a prize nobody
      // has designed, which is exactly the leak the tease exists to avoid. The provenance line below
      // explains the whole block at once, so a bare plinth cannot read as a missing asset.
      c.add(
        scene.add
          .text(0, CELL / 2 - 18, `CH ${chapter}`, {
            fontFamily: FONT,
            fontSize: '12px',
            fontStyle: '900',
            color: has ? T.inkSoft : T.inkFaint,
          })
          .setOrigin(0.5)
          .setLetterSpacing(1)
      )
      wingLayer.add(c)
      slots.push(c)
      if (opts.focusChapter === chapter) focusSlot = c
    }

    const complete = trophyFor(wing.chapterTo) !== null
    wingLayer.add(
      scene.add
        .text(
          W / 2,
          gridTop + GRID_H + 30,
          complete
            ? 'Close a chapter to add its trophy — and bank its purse.'
            : 'The floors above this one are still being built.',
          { fontFamily: FONT, fontSize: '16px', color: T.inkFaint }
        )
        .setOrigin(0.5)
    )

    if (animate && !reduced) {
      slots.forEach((slot, i) => {
        // ⚠️ These are CONTAINERS, which carry no display size — tweening `scale` to 1 is correct
        // here. The bug this resembles (a `scale: 1` tween landing an Image back at its NATIVE
        // texture size, silently discarding setDisplaySize) applies to the icons inside, and those
        // are never tweened. Keep it that way.
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
    if (focusSlot && animate && !reduced) {
      const target: Phaser.GameObjects.Container = focusSlot
      const ring = scene.add.graphics()
      ring.lineStyle(4, T.gold, 1)
      ring.strokeRoundedRect(target.x - CELL / 2 + 2, target.y - CELL / 2 + 2, CELL - 4, CELL - 4, 18)
      ring.setAlpha(0)
      wingLayer.add(ring)
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

  const closeBtn = addPillButton(scene, W / 2, pyTop + ph - 52, 200, 52, 'CLOSE', GHOST_PILL, close)
  layer.add(closeBtn)

  dressTabs()
  paintWing(true)

  for (const t of tabs) {
    t.tab.on('pointerup', () => {
      if (t.wing.id === wing.id) return
      sfx.uiTap()
      wing = t.wing
      dressTabs()
      // Deferred by a frame. Repainting inline inside the handler that is still dispatching is the
      // charmalbum hazard; this rebuild never touches the scrim, so it cannot self-close, but the
      // rule costs nothing to keep and the next person to add a rebuild here should find it kept.
      scene.time.delayedCall(0, () => paintWing(true))
    })
  }

  // ── Entrance ──
  if (!reduced) {
    layer.setAlpha(0)
    scene.tweens.add({ targets: layer, alpha: 1, duration: 200, ease: 'Sine.easeOut' })
  }
}

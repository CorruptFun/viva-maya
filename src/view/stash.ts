import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { BOOST_ORDER, hasSurplus, stash, stashTotal, usingNextCount } from '../core/inventory'
import type { StashEntry } from '../core/inventory'
import { loadSave, promoteBoost } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GOLD_PILL } from './ui'

/**
 * YOUR STASH — the boosts you own, what goes in next, and how to change that.
 *
 * Built 2026-08-03 in answer to a player: *"When you win stuff in Lucky Slots where does it go?
 * Where do you see your stash? And most importantly how do you use it? I'm still getting charged
 * coins for using perks I've won."*
 *
 * Every one of those had the same cause. Winnings went into `save.pendingBoosts`, which had NO user
 * interface — Home showed a single line reading "boost ready for your next level" that named neither
 * what nor how many — and were then spent automatically at the next level's start, announced by a
 * gold toast that faded. So the player's whole experience of owning something was: a prize screen,
 * then nothing, then a level that felt slightly easier for reasons never stated.
 *
 * The "charged coins" part is a false alarm, and worth being precise about because the game caused
 * it. A won boost is applied FREE — `GameScene.applyBoosts` deducts nothing and no code path has
 * ever charged for one. What the player was seeing is the in-level HELPER shelf, which sits under
 * the board for the whole level captioned "SPEND CHIPS TO WIN THIS LEVEL" and used to sell an item
 * called "BOMB" for 35 chips while DICE BOMB was a prize they had just won for nothing. Same word,
 * two economies. (The shelf item is now BLAST — core/store.ts.) This panel is the other half of the
 * fix: ownership you can actually look at.
 *
 * Renders core/inventory.ts, exactly as view/charmalbum.ts renders core/charms.ts, and follows the
 * same repaint-on-change discipline (destroy + reopen `instant`) rather than hunting down every
 * tile a promotion invalidated.
 */

export interface StashOpts {
  /** Suppress the entrance — used by the internal repaint so promoting doesn't replay the cascade. */
  instant?: boolean
  /** Set once something changed, so the caller only refreshes Home when it actually needs to. */
  dirty?: boolean
  onChanged?: () => void
}

/** Live badge count for the Home entry point. */
export function stashBadgeCount(): number {
  return stashTotal(loadSave())
}

export function openStash(scene: Phaser.Scene, opts: StashOpts = {}): void {
  const T = getTheme()
  const reduced = prefersReducedMotion() || opts.instant === true
  const save = loadSave()
  const rows = stash(save)
  const total = stashTotal(save)
  const nextCount = usingNextCount(save)
  const surplus = hasSurplus(save)
  const W = DESIGN_W
  const layer = scene.add.container(0, 0).setDepth(60)

  const close = (): void => {
    sfx.whoosh()
    layer.destroy()
    if (opts.dirty) opts.onChanged?.()
  }
  const repaint = (): void => {
    layer.destroy()
    openStash(scene, { ...opts, instant: true, dirty: true })
  }

  const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH() + 400, T.scrim, 0.62).setInteractive()
  scrim.on('pointerup', close)
  layer.add(scrim)

  // ── Layout ──
  const CELL_W = 196
  const CELL_H = 128
  const GAP = 14
  const COLS = 3
  const gridW = CELL_W * COLS + GAP * (COLS - 1)
  const rowsNeeded = Math.ceil(BOOST_ORDER.length / COLS)
  const px = 40
  const pw = W - 80
  const pyTop = 150
  const HEAD = 196
  /**
   * Footer budget: the count line, the surplus explainer BELOW it, and DONE — with air between.
   * ⚠️ Sized against the surplus state, which is the tall one. At 150 the explainer sat at ph-74 and
   * DONE's 60px cap started at ph-64, so the button landed directly on the text; the overlap only
   * appears when a player owns more than `boostApplyMax`, which is exactly the state the explainer
   * exists for and therefore exactly the state nobody sees while building. Keep the three seats and
   * this constant in step.
   */
  const FOOT = 186
  const ph = HEAD + rowsNeeded * CELL_H + (rowsNeeded - 1) * GAP + FOOT

  const g = scene.add.graphics()
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, T.goldBezel, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)
  layer.add(g)

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

  layer.add(
    scene.add
      .text(W / 2, pyTop + 52, 'YOUR STASH', {
        fontFamily: FONT,
        fontSize: '44px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )

  // THE SENTENCE THE WHOLE PANEL EXISTS FOR. A player who thinks they are being billed for their own
  // winnings needs to be told they are not, in the place they came looking. Everything else here is
  // decoration around this line.
  const blurb = total
    ? 'You won these. They cost nothing — the top row goes in automatically when you start your next level.'
    : 'Boosts you win in Lucky Slots and the Jackpot Wheel land here. They are free to use.'
  layer.add(
    scene.add
      .text(W / 2, pyTop + 108, blurb, {
        fontFamily: FONT,
        fontSize: '20px',
        color: T.inkMuted,
        align: 'center',
        wordWrap: { width: pw - 72 },
      })
      .setOrigin(0.5)
  )

  const gridTop = pyTop + HEAD
  const gridX0 = W / 2 - gridW / 2 + CELL_W / 2

  const tiles: Phaser.GameObjects.Container[] = []
  rows.forEach((entry, i) => {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const cx = gridX0 + col * (CELL_W + GAP)
    const cy = gridTop + row * (CELL_H + GAP) + CELL_H / 2
    tiles.push(buildTile(scene, layer, entry, cx, cy, CELL_W, CELL_H, repaint))
  })

  // ── The footer line: what happens next, in plain words ──
  let footText: string
  if (total === 0) footText = 'Nothing in the stash yet'
  else if (surplus) footText = `${nextCount} going in next level  ·  ${total - nextCount} kept for later`
  else footText = nextCount === 1 ? '1 going in next level' : `${nextCount} going in next level`
  layer.add(
    scene.add
      .text(W / 2, pyTop + ph - 146, footText, { fontFamily: FONT, fontSize: '21px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
  )
  // The surplus explanation. Without it, owning five boosts and seeing three used reads as two of
  // them having gone missing — which is precisely the kind of silent loss this panel exists to deny.
  if (surplus) {
    layer.add(
      scene.add
        .text(W / 2, pyTop + ph - 112, 'Nothing is lost — tap a spare to move it to the front', {
          fontFamily: FONT,
          fontSize: '18px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )
  }

  const doneBtn = addPillButton(scene, W / 2, pyTop + ph - 46, 240, 60, 'DONE', GOLD_PILL, close)
  layer.add(doneBtn)

  if (!reduced) {
    tiles.forEach((t, i) => {
      t.setScale(0.86)
      t.setAlpha(0)
      scene.tweens.add({ targets: t, scale: 1, alpha: 1, duration: 260, delay: 40 + i * 40, ease: backOut(OVERSHOOT.pop) })
    })
  }
}

/**
 * One boost tile. Three states, and they have to be distinguishable at a glance because the whole
 * panel is an answer to "what do I actually have":
 *   owned + going in next → gold face, "NEXT" collar
 *   owned + banked        → plain face, tappable to promote
 *   none                  → ghosted, inert, but still present so the grid reads as a set with gaps
 */
function buildTile(
  scene: Phaser.Scene,
  layer: Phaser.GameObjects.Container,
  entry: StashEntry,
  cx: number,
  cy: number,
  w: number,
  h: number,
  repaint: () => void
): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(cx, cy)
  const owned = entry.count > 0
  const going = entry.usingNext > 0

  const g = scene.add.graphics()
  const fill = going ? T.cardFillWarm : T.cardFill
  g.fillStyle(fill, owned ? 1 : 0.45)
  g.fillRoundedRect(-w / 2, -h / 2, w, h, 18)
  g.lineStyle(going ? 3 : 2, going ? T.goldBezel : T.goldDeep, owned ? 1 : 0.35)
  g.strokeRoundedRect(-w / 2, -h / 2, w, h, 18)
  c.add(g)

  const icon = scene.add.text(0, -h / 2 + 34, entry.meta.icon, { fontSize: '34px' }).setOrigin(0.5)
  icon.setAlpha(owned ? 1 : 0.32)
  c.add(icon)

  const label = scene.add
    .text(0, 6, entry.meta.label, {
      fontFamily: FONT,
      fontSize: '17px',
      fontStyle: '900',
      color: owned ? T.goldText : T.inkFaint,
      align: 'center',
      wordWrap: { width: w - 18 },
    })
    .setOrigin(0.5)
  c.add(label)

  const countText = owned ? `×${entry.count}` : '—'
  c.add(
    scene.add
      .text(0, h / 2 - 26, countText, {
        fontFamily: FONT,
        fontSize: owned ? '22px' : '18px',
        fontStyle: '900',
        color: owned ? T.ink : T.inkFaint,
      })
      .setOrigin(0.5)
  )

  if (going) {
    // The collar reads as a state, not a button — it is the panel's answer to "which ones am I
    // about to use", and it must not look tappable when tapping it would do nothing.
    const collar = scene.add.graphics()
    collar.fillStyle(T.goldBezel, 1)
    collar.fillRoundedRect(-34, -h / 2 - 9, 68, 22, 11)
    c.add(collar)
    c.add(
      scene.add
        .text(0, -h / 2 + 2, entry.usingNext > 1 ? `NEXT ×${entry.usingNext}` : 'NEXT', {
          fontFamily: FONT,
          fontSize: '13px',
          fontStyle: '900',
          color: '#fffdf7',
        })
        .setOrigin(0.5)
    )
  }

  // Only a BANKED boost is worth tapping — promoting something already going in is a no-op, and an
  // affordance that does nothing is worse than none.
  if (owned && !going) {
    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
    hit.on('pointerup', () => {
      if (promoteBoost(entry.type)) {
        sfx.uiTap()
        repaint()
      }
    })
    c.add(hit)
  }

  layer.add(c)
  return c
}

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W } from '../config'
import { BOOST_ORDER, hasSurplus, stash, stashTotal, usingNextCount } from '../core/inventory'
import type { StashEntry } from '../core/inventory'
import { loadSave, promoteBoost, toggleHoldBoost } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, addRoundChip, FONT, GOLD_PILL, inkShadow } from './ui'

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

/**
 * The STASH CHIP — a second door, for LevelSelect.
 *
 * Home's text line was the only way in, which meant a player who reached a level from the LEVELS
 * grid never passed the stash at all: the "choose what goes in before you play" step was entirely
 * skippable without ever knowing it existed. This is the same idea `addCharmChip` already ships —
 * a glyph chip with a live count collar that opens its panel — so the two read as siblings rather
 * than as two unrelated inventions.
 *
 * Seated in the 125px gap the LEVELS title row leaves between the back button (right edge 118) and
 * the wordmark (left edge 243). Measured, not guessed; re-measure if either moves.
 */
export function addStashChip(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size = 52,
  opts: StashOpts = {}
): Phaser.GameObjects.Container {
  const T = getTheme()
  const n = stashTotal(loadSave())
  const { container } = addRoundChip(
    scene,
    x,
    y,
    size,
    '🎁',
    { fontFamily: 'sans-serif', fontSize: `${Math.round(size * 0.46)}px` },
    () => {
      sfx.uiTap()
      sfx.whoosh()
      openStash(scene, opts)
    }
  )
  // Collar mirrors the charm chip's: a count badge on the lower-right, outside the face so the press
  // sink carries the glyph without dragging the number off the chip. Muted at zero — an empty stash
  // is still worth a door (it is the only place that explains where winnings go), but it must not
  // shout for attention it hasn't earned.
  const badge = scene.add.container(size * 0.36, size * 0.34)
  const label = scene.add
    .text(0, 0, String(n), { fontFamily: FONT, fontSize: '15px', fontStyle: '900', color: n > 0 ? T.onRose : T.inkSoft })
    .setOrigin(0.5)
  const bw = Math.max(label.width + 14, 24)
  const bg = scene.add.graphics()
  bg.fillStyle(n > 0 ? T.rose : T.cardFillAlt, 1)
  bg.fillRoundedRect(-bw / 2, -11, bw, 22, 11)
  bg.lineStyle(2, T.cardFill, 0.9)
  bg.strokeRoundedRect(-bw / 2, -11, bw, 22, 11)
  badge.add([bg, label])
  container.add(badge)
  return container
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
  /**
   * Rebuild in place after a tap — destroy and reopen rather than hunting down every tile, collar
   * and readout the change invalidated (view/charmalbum.ts §7, "apply by repaint, not live re-tint").
   *
   * ⚠️ DEFERRED BY A TICK, and it must stay that way. Rebuilding inline inside the `pointerup`
   * handler drops a brand-new interactive scrim under the finger while Phaser is still dispatching
   * that very event — the new scrim takes the same tap, calls `close()`, and the panel you just
   * rebuilt vanishes and repaints Home behind it. Observed exactly that (2026-08-03): the hold
   * toggle wrote the right save and then closed the stash. charmalbum's own repaint is deferred
   * through `scene.time.delayedCall` for the same reason.
   */
  const repaint = (): void => {
    scene.time.delayedCall(0, () => {
      layer.destroy()
      openStash(scene, { ...opts, instant: true, dirty: true })
    })
  }

  const scrimKit = addFocusScrim(scene, { alpha: 0.62 })
  const scrim = scrimKit.hit.setInteractive()
  scrim.on('pointerup', close)
  layer.add([scrim, ...scrimKit.art])

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
  panelPlate(g, px, pyTop, pw, ph, 30)
  layer.add(g)

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

  layer.add(
    inkShadow(
      scene.add
        .text(W / 2, pyTop + 52, 'YOUR STASH', {
          fontFamily: FONT,
          fontSize: '44px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2),
      'title'
    )
  )

  // THE SENTENCE THE WHOLE PANEL EXISTS FOR. A player who thinks they are being billed for their own
  // winnings needs to be told they are not, in the place they came looking. Everything else here is
  // decoration around this line.
  const blurb = total
    ? 'You won these — they cost nothing. Whatever is marked NEXT goes in when you start your next level.'
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
  // Must account for HELD as well as surplus, or a player who set everything aside reads
  // "0 going in next level" with no explanation and assumes the panel is broken.
  let footText: string
  if (total === 0) footText = 'Nothing in the stash yet'
  else if (nextCount === 0) footText = 'Nothing goes in next level'
  else if (surplus) footText = `${nextCount} going in next level  ·  ${total - nextCount} kept back`
  else footText = nextCount === 1 ? '1 going in next level' : `${nextCount} going in next level`
  layer.add(
    scene.add
      .text(W / 2, pyTop + ph - 146, footText, { fontFamily: FONT, fontSize: '21px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
  )
  // Teaches the gesture, and denies the silent-loss reading: owning five and seeing three used looks
  // like two went missing unless the panel says otherwise. Shown whenever the player owns anything,
  // because the tap is now the point of the screen rather than a surplus-only affordance.
  if (total > 0) {
    layer.add(
      scene.add
        .text(W / 2, pyTop + ph - 112, 'Nothing is ever lost — tap one to use it or set it aside', {
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
 * One boost tile. Four states, distinguishable at a glance because the panel is an answer to "what
 * do I actually have and what is about to happen to it":
 *   owned + going in next → warm face, gold "NEXT" collar
 *   owned + HELD          → plain face, muted "HELD" collar — set aside, never consumed
 *   owned + banked        → plain face, no collar (a surplus waiting its turn)
 *   none                  → ghosted, inert, but still present so the grid reads as a set with gaps
 *
 * ONE GESTURE, ONE MEANING: a tap always flips whether this type goes in next level.
 *   NEXT   → hold it (take it out of the next level)
 *   HELD   → release AND promote (put it in, now — releasing without promoting would leave the
 *            player tapping a tile and seeing nothing change whenever a surplus is queued ahead)
 *   banked → promote (put it in)
 *
 * ⚠️ Holding is per-TYPE, not per-instance. "Save my Jackpot Chips for a hard level" is the real
 * intent; per-instance holding would need a second inventory kept in sync with the first through
 * every grant, spend and device merge.
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
  const held = entry.held && owned

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

  // The collar states what is about to happen to this type. HELD is deliberately muted rather than
  // gold: it is the absence of an action, and it must never compete with NEXT for the eye.
  const collarText = held ? 'HELD' : going ? (entry.usingNext > 1 ? `NEXT ×${entry.usingNext}` : 'NEXT') : ''
  if (collarText) {
    const cw = collarText.length > 6 ? 84 : 68
    const collar = scene.add.graphics()
    collar.fillStyle(held ? T.border : T.goldBezel, 1)
    collar.fillRoundedRect(-cw / 2, -h / 2 - 9, cw, 22, 11)
    c.add(collar)
    c.add(
      scene.add
        .text(0, -h / 2 + 2, collarText, {
          fontFamily: FONT,
          fontSize: '13px',
          fontStyle: '900',
          color: held ? T.inkSoft : '#fffdf7',
        })
        .setOrigin(0.5)
    )
  }

  // Every OWNED tile is tappable now — the gesture flips participation, so there is no owned state
  // where a tap does nothing. (An unowned tile stays inert: there is nothing to flip.)
  if (owned) {
    const hit = scene.add.rectangle(0, 0, w, h, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
    hit.on('pointerup', () => {
      sfx.uiTap()
      if (held) {
        toggleHoldBoost(entry.type) // release …
        promoteBoost(entry.type) // … and put it in, so the tap visibly does something
      } else if (going) {
        toggleHoldBoost(entry.type) // set aside
      } else {
        promoteBoost(entry.type) // surplus → bring it forward
      }
      repaint()
    })
    c.add(hit)
  }

  layer.add(c)
  return c
}

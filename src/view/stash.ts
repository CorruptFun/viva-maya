import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_H, DESIGN_W } from '../config'
import { BOOST_ORDER, hasSurplus, stash, stashTotal, usingNextCount } from '../core/inventory'
import type { StashEntry } from '../core/inventory'
import { loadSave, promoteBoost, toggleHoldBoost } from '../core/save'
import { backOut, D, E, OVERSHOOT } from './motion'
import { addFocusScrim } from './platekit'
import { quality } from './quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from './theme'
import { addPillButton, addPressablePlate, FONT, GHOST_PILL, GOLD_PILL, goldFace } from './ui'

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
 *
 * ── The 2026-08-04 dressing pass ─────────────────────────────────────────────
 * The first cut was correct and plain: flat `fillRoundedRect` card, flat tiles, bare emoji, bare
 * text. Next to the race marquee, the jackpot deck and the chunky 3-D pills it read as a debug
 * readout in a casino (owner: *"the inventory ui is very dull and doesn't fit our impressive
 * ui/ux"*), which quietly undercut the point — a shelf that looks unfinished does not read as
 * *treasure you own*. So every surface here is now baked to the house material law: stacked
 * one-key-light shadows (§E7), gloss bands, gold bezels, dark-theme accent rims, and `goldFace`
 * real-metal for anything that is meant to look like winnings.
 *
 * Two changes are content, not paint, and they are the ones that matter:
 *   • the 3×2 tile grid became FIVE FULL-WIDTH ROWS, which is what bought room for
 *   • `BOOST_META.blurb` — every boost now says what it actually does. The model has carried that
 *     sentence since the module was written and no screen had ever shown it, so "DICE BOMB" was a
 *     name with no meaning attached anywhere in the game.
 * An unowned row is drawn as an empty SOCKET (the jackpot meter's §V1 language) rather than a
 * ghosted tile: the same "here is the goal, it is not lit yet" read, in the same visual grammar.
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

/** Texture-bake padding so baked drop shadows aren't clipped. */
const PAD = 12

/**
 * The door's art box. EXPORTED because LevelSelect budgets its header band against it — the strip
 * below has to clear this, and the whole reason that band went wrong once already is that the door's
 * true reach was implicit. See `addStashDoor`.
 */
export const STASH_DOOR_W = 124
export const STASH_DOOR_H = 48

/** Bake once, keyed by theme + size, and share it across every open. */
function bake(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (g: Phaser.GameObjects.Graphics) => void
): string {
  if (scene.textures.exists(key)) return key
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  draw(g)
  g.generateTexture(key, w + PAD * 2, h + PAD * 2)
  g.destroy()
  return key
}

/** Relative luminance of a packed RGB — tells the two dark washes from the two cream ones. */
function isDarkWash(): boolean {
  const c = getTheme().washBottom
  return 0.2126 * (((c >> 16) & 0xff) / 255) + 0.7152 * (((c >> 8) & 0xff) / 255) + 0.0722 * ((c & 0xff) / 255) < 0.4
}

/**
 * THE STASH DOOR, second of two (Home's line is the first).
 *
 * ⚠️ WAS A ROUND CHIP WITH AN OVERHANGING COUNT BADGE, and that is exactly what broke. The badge
 * hung off the chip's lower-right at +18,+18 with an 11px radius, so a 52px chip seated at y=92
 * actually reached y≈121 — and LevelSelect's LEVEL RACE marquee starts at y=122. One design pixel.
 * The count sat on the leaderboard's top edge (owner screenshot, 2026-08-04) and no amount of
 * nudging the chip fixes the CLASS of bug, because the badge's whole job is to stick out.
 *
 * So the count came inside. The door is now a counted pill — glyph, then the number, on the chunky
 * 3-D cap every other control here wears — which has a real bounding box, mirrors the ★ tally
 * across the wordmark, and answers "how many" without a second object hanging into the neighbours.
 * When the stash has something in it the pill also breathes (`juice`), which is the house cue for
 * "there is something here for you" and is reduced-motion gated for free.
 */
export function addStashDoor(
  scene: Phaser.Scene,
  x: number,
  y: number,
  opts: StashOpts = {}
): Phaser.GameObjects.Container {
  const T = getTheme()
  const n = stashTotal(loadSave())
  const w = STASH_DOOR_W
  const h = STASH_DOOR_H
  const { container, face } = addPressablePlate(
    scene,
    x,
    y,
    w,
    h,
    GHOST_PILL,
    () => {
      sfx.uiTap()
      sfx.whoosh()
      openStash(scene, opts)
    },
    // A slow specular sweep whenever there IS something inside — the house "this one is alive" cue.
    // Deliberately `sheen` and not `juice`: the sheen is masked to the cap, while juice's breathing
    // halo reaches ~2× the pill's height and this door has a leaderboard strip for a neighbour.
    { sheen: n > 0 }
  )
  container.setDepth(50)

  // The glyph is its own Text, never a pill label: `addPillButton`'s letterSpacing splits the emoji's
  // surrogate pair and Phaser renders tofu (see the note in HomeScene).
  const glyph = scene.add.text(-w / 2 + 30, 1, '🎁', { fontFamily: 'sans-serif', fontSize: '25px' }).setOrigin(0.5)
  const count = scene.add
    .text(w / 2 - 26, 1, String(n), {
      fontFamily: FONT,
      fontSize: '25px',
      fontStyle: '900',
      color: n > 0 ? T.goldText : T.inkFaint,
    })
    .setOrigin(1, 0.5)
  face.add([glyph, count])
  return container
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

/** Card geometry — 40px side gutters, like every other full-width overlay card. Rows are full-width
 *  because that is exactly what buys the room for a blurb. */
const CARD_W = DESIGN_W - 80
const ROW_W = CARD_W - 52
const ROW_H = 100
const ROW_GAP = 11
/** Left edge of the name + blurb column — clear of the 64px icon medallion at the row's left end. */
const TEXT_X = -ROW_W / 2 + 102
/**
 * The right cluster (count coin over state tab) is centred this far in from the row's right edge,
 * and `CLUSTER_GUTTER` is what the text column gives up for it. Budgeted against the WIDEST tab —
 * 'NOT WON YET' measures ~118px of plate at 13px — so a two-line blurb and a full-width lozenge
 * still leave ~20px of air between them.
 */
const CLUSTER_INSET = 70
const CLUSTER_GUTTER = 152
const BLURB_W = ROW_W - 102 - CLUSTER_GUTTER
/** Title, the it-cost-you-nothing sentence, and the NEXT-LEVEL summary deck above the first row. */
const HEAD = 228
/** The teaching line + DONE below the last row, with air between (the button used to land on text). */
const FOOT = 148

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

  const ph = HEAD + BOOST_ORDER.length * ROW_H + (BOOST_ORDER.length - 1) * ROW_GAP + FOOT
  // Centred in the design box rather than pinned to a measured top, so adding a sixth boost grows the
  // card symmetrically instead of walking it off the bottom edge. (920 tall today → 180…1100.)
  const pyTop = Math.round((DESIGN_H - ph) / 2)

  layer.add(scene.add.image(W / 2, pyTop + ph / 2, ensureCardPlate(scene, ph)))

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, CARD_W, ph, 0xffffff, 0.001).setInteractive())

  // ── Header ──────────────────────────────────────────────────────────────────
  // Gold-gradient wordmark, the same treatment the LEVELS / GIFT STORE titles wear, with the gift
  // glyph seated off the MEASURED title width so it stays pinned however the copy changes.
  const titleY = pyTop + 58
  const title = scene.add
    .text(W / 2 + 18, titleY, 'YOUR STASH', { fontFamily: FONT, fontSize: '42px', fontStyle: '900', color: '#ffffff' })
    .setOrigin(0.5)
    .setLetterSpacing(3)
    .setShadow(0, 3, 'rgba(90,70,20,0.28)', 6, false, true)
    .setTint(T.goldBright, T.goldBright, T.goldDeep, T.goldDeep)
  layer.add(title)
  layer.add(
    scene.add.text(title.x - title.width / 2 - 30, titleY + 1, '🎁', { fontFamily: 'sans-serif', fontSize: '30px' }).setOrigin(0.5)
  )

  // THE SENTENCE THE WHOLE PANEL EXISTS FOR. A player who thinks they are being billed for their own
  // winnings needs to be told they are not, in the place they came looking. Everything else here is
  // decoration around this line.
  const blurb = total
    ? 'You won these — they cost nothing. Whatever is marked NEXT goes in when you start your next level.'
    : 'Boosts you win in Lucky Slots and the Jackpot Wheel land here. They are free to use.'
  layer.add(
    scene.add
      .text(W / 2, pyTop + 122, blurb, {
        fontFamily: FONT,
        fontSize: '19px',
        color: T.inkMuted,
        align: 'center',
        lineSpacing: 4,
        wordWrap: { width: CARD_W - 84 },
      })
      .setOrigin(0.5)
  )

  // ── The NEXT-LEVEL deck ─────────────────────────────────────────────────────
  // What happens when you press PLAY, on its own lit strip instead of as a caption. Must account for
  // HELD as well as surplus, or a player who set everything aside reads "0 going in next level" with
  // no explanation and assumes the panel is broken.
  let deckText: string
  if (total === 0) deckText = 'NOTHING IN THE STASH YET'
  else if (nextCount === 0) deckText = 'NOTHING GOES IN NEXT LEVEL'
  else if (surplus) deckText = `${nextCount} GOING IN  ·  ${total - nextCount} KEPT BACK`
  else deckText = nextCount === 1 ? '1 GOING IN NEXT LEVEL' : `${nextCount} GOING IN NEXT LEVEL`
  layer.add(addDeck(scene, W / 2, pyTop + 188, deckText, nextCount > 0))

  const gridTop = pyTop + HEAD
  const built: Phaser.GameObjects.Container[] = []
  rows.forEach((entry, i) => {
    const cy = gridTop + i * (ROW_H + ROW_GAP) + ROW_H / 2
    built.push(buildRow(scene, layer, entry, W / 2, cy, repaint))
  })

  // Teaches the gesture, and denies the silent-loss reading: owning five and seeing three used looks
  // like two went missing unless the panel says otherwise. Shown whenever the player owns anything,
  // because the tap is now the point of the screen rather than a surplus-only affordance.
  if (total > 0) {
    layer.add(
      scene.add
        .text(W / 2, pyTop + ph - 114, 'Nothing is ever lost — tap one to use it or set it aside', {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 52, 240, 64, 'DONE', GOLD_PILL, close))

  if (!reduced) {
    built.forEach((t, i) => {
      t.setScale(0.94)
      t.setAlpha(0)
      t.y += 14
      scene.tweens.add({
        targets: t,
        scale: 1,
        alpha: 1,
        y: t.y - 14,
        duration: 260,
        delay: 40 + i * 40,
        ease: backOut(OVERSHOOT.pop),
      })
    })
  }
}

/**
 * The card: three stacked one-key-light shadows, a cream face, the falling-height gloss bands every
 * plate in the app wears, a 4px gold bezel and (dark washes only) a lit accent rim along the top
 * inner edge. Baked, so five opens cost one texture.
 */
function ensureCardPlate(scene: Phaser.Scene, ph: number): string {
  const T = getTheme()
  return bake(scene, `stash:card:${T.id}:${CARD_W}x${ph}`, CARD_W, ph, g => {
    const x = PAD
    const y = PAD
    const r = 32
    for (let i = 3; i >= 1; i--) {
      g.fillStyle(T.shadow, 0.07)
      g.fillRoundedRect(x, y + i * 3, CARD_W, ph, r)
    }
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(x, y, CARD_W, ph, r)
    for (let i = 0; i < 3; i++) {
      const bh = 150 * (0.5 - i * 0.14)
      g.fillStyle(T.glossHi, 0.14)
      g.fillRoundedRect(x + 5, y + 3, CARD_W - 10, bh, Math.min(r - 3, bh / 2))
    }
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(x, y, CARD_W, ph, r)
    if (isDarkWash()) {
      g.fillStyle(T.accent, 0.8)
      g.fillRoundedRect(x + r, y + 4, CARD_W - r * 2, 2, 1)
    }
  })
}

/**
 * The NEXT-LEVEL deck — a warm capsule carrying the one sentence that answers "what am I about to
 * spend". Lit (gold bezel + gold ink) when something is actually queued, quiet when nothing is, so
 * the state is legible before the words are read.
 */
function addDeck(scene: Phaser.Scene, x: number, y: number, label: string, lit: boolean): Phaser.GameObjects.Container {
  const T = getTheme()
  const w = ROW_W
  const h = 48
  const key = bake(scene, `stash:deck:${T.id}:${lit ? 'lit' : 'off'}:${w}x${h}`, w, h, g => {
    const px = PAD
    const py = PAD
    const r = h / 2
    g.fillStyle(T.shadow, 0.1)
    g.fillRoundedRect(px, py + 3, w, h, r)
    g.fillStyle(lit ? T.cardFillWarm : T.cardFillAlt, 1)
    g.fillRoundedRect(px, py, w, h, r)
    g.fillStyle(T.glossHi, 0.45)
    g.fillRoundedRect(px + 5, py + 3, w - 10, h * 0.34, r * 0.6)
    g.lineStyle(2, lit ? T.goldBezel : T.border, 1)
    g.strokeRoundedRect(px, py, w, h, r)
  })
  const c = scene.add.container(x, y)
  c.add(scene.add.image(0, 0, key))
  c.add(
    scene.add
      .text(0, 1, label, {
        fontFamily: FONT,
        fontSize: '20px',
        fontStyle: '900',
        color: lit ? T.goldText : T.inkMuted,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )
  return c
}

/** Which face a row wears — one bake each, shared by every row that wears it. */
type RowState = 'next' | 'held' | 'banked' | 'empty'

/**
 * A row plate. `next` is the only warm, gold-bezelled one: it is the row that is about to DO
 * something, and nothing else on the panel is allowed to compete with it for the eye. `empty` is
 * drawn as a recessed SOCKET, the jackpot meter's §V1 "a slot waiting to be charged" idea — but
 * INVERTED for this surface. The meter's sockets are dark wells because the meter sits on the dark
 * backdrop; a dark slab on a cream card reads as *disabled*, not as *empty*, which is the opposite
 * of what an unwon prize should say. So the hole here is cut out of the card instead: a shade of
 * shadow over the whole footprint, a floor dropped 3px so a lit rim shows along the top edge (the
 * one key light comes from above, §E7), and a faint gold outline.
 */
function ensureRowPlate(scene: Phaser.Scene, state: RowState): string {
  const T = getTheme()
  return bake(scene, `stash:row:${T.id}:${state}:${ROW_W}x${ROW_H}`, ROW_W, ROW_H, g => {
    const x = PAD
    const y = PAD
    const r = 22
    if (state === 'empty') {
      g.fillStyle(T.shadow, 0.13)
      g.fillRoundedRect(x, y, ROW_W, ROW_H, r)
      g.fillStyle(T.cardFillAlt, 0.55)
      g.fillRoundedRect(x + 2, y + 4, ROW_W - 4, ROW_H - 6, r - 2)
      g.lineStyle(2, T.goldDeep, 0.28)
      g.strokeRoundedRect(x, y, ROW_W, ROW_H, r)
      return
    }
    for (let i = 2; i >= 1; i--) {
      g.fillStyle(T.shadow, 0.08)
      g.fillRoundedRect(x, y + i * 2, ROW_W, ROW_H, r)
    }
    g.fillStyle(state === 'next' ? T.cardFillWarm : T.cardFillAlt, 1)
    g.fillRoundedRect(x, y, ROW_W, ROW_H, r)
    // One quiet top gloss band — enough to read as a raised, pressable surface, far short of the
    // three-band bevelled cap the real buttons wear.
    g.fillStyle(T.glossHi, state === 'next' ? 0.5 : 0.34)
    g.fillRoundedRect(x + 6, y + 4, ROW_W - 12, ROW_H * 0.3, 14)
    g.lineStyle(state === 'next' ? 3 : 2, state === 'next' ? T.goldBezel : T.border, 1)
    g.strokeRoundedRect(x, y, ROW_W, ROW_H, r)
    if (state === 'next' && isDarkWash()) {
      g.fillStyle(T.accent, 0.75)
      g.fillRoundedRect(x + r, y + 4, ROW_W - r * 2, 2, 1)
    }
  })
}

/**
 * The icon medallion — a recessed disc with a gold ring, so the emoji sits IN something instead of
 * floating on the plate. Lit for an owned boost, sunk and unlit for an empty socket.
 */
function ensureMedallion(scene: Phaser.Scene, lit: boolean): string {
  const T = getTheme()
  const d = 64
  return bake(scene, `stash:med:${T.id}:${lit ? 'lit' : 'off'}:${d}`, d, d, g => {
    const c = PAD + d / 2
    const rr = d / 2
    g.fillStyle(T.shadow, 0.16)
    g.fillCircle(c, c + 2, rr)
    if (lit) {
      // A metal ring, a warm well cut out of it, then a crescent of light along the well's TOP edge —
      // two overlapping circles, the upper one gloss and the lower one the well colour again, which
      // is the one-key-light law (§E7) drawn with fills instead of a gradient.
      goldFace(g, PAD, PAD, d, d, T, rr)
      g.fillStyle(T.cardFill, 1)
      g.fillCircle(c, c, rr - 7)
      g.fillStyle(T.glossHi, 0.45)
      g.fillCircle(c, c - 3, rr - 9)
      g.fillStyle(T.cardFill, 1)
      g.fillCircle(c, c + 4, rr - 9)
    } else {
      // The unlit twin — the same hole cut out of the card that the empty row plate uses, so an
      // unwon prize reads as a socket at both scales instead of as two different kinds of "off".
      g.fillStyle(T.shadow, 0.14)
      g.fillCircle(c, c, rr)
      g.fillStyle(T.cardFillAlt, 0.6)
      g.fillCircle(c, c + 2, rr - 3)
      g.lineStyle(2, T.goldDeep, 0.3)
      g.strokeCircle(c, c, rr - 1)
    }
  })
}

/** The ×N count coin — real metal when owned, so a stack of five reads as winnings, not as a label. */
function ensureCountCoin(scene: Phaser.Scene, w: number): string {
  const T = getTheme()
  const h = 34
  return bake(scene, `stash:coin:${T.id}:${w}x${h}`, w, h, g => {
    g.fillStyle(T.shadow, 0.16)
    g.fillRoundedRect(PAD, PAD + 3, w, h, h / 2)
    goldFace(g, PAD, PAD, w, h, T, h / 2)
    g.lineStyle(2, T.goldDeep, 0.9)
    g.strokeRoundedRect(PAD, PAD, w, h, h / 2)
  })
}

/**
 * One boost row. Four states, distinguishable at a glance because the panel is an answer to "what
 * do I actually have and what is about to happen to it":
 *   owned + going in next → warm plate, gold bezel, gold "NEXT" tab, soft halo
 *   owned + HELD          → quiet plate, muted "HELD" tab — set aside, never consumed
 *   owned + banked        → quiet plate, no tab (a surplus waiting its turn)
 *   none                  → an unlit SOCKET, inert, but still present so the shelf reads as a set
 *                           with gaps and still names what it is you would be winning
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
function buildRow(
  scene: Phaser.Scene,
  layer: Phaser.GameObjects.Container,
  entry: StashEntry,
  cx: number,
  cy: number,
  repaint: () => void
): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(cx, cy)
  const owned = entry.count > 0
  const going = entry.usingNext > 0
  const held = entry.held && owned
  const state: RowState = !owned ? 'empty' : held ? 'held' : going ? 'next' : 'banked'

  // A soft gold bloom under the row that is actually going in — the cheapest way to say "this one"
  // across a stack of five. Finish only, so it follows the flashing + quality gates.
  if (state === 'next' && !reduceFlashing() && quality.tier() !== 'low' && scene.textures.exists('bgglow')) {
    c.add(
      scene.add
        .image(0, 0, 'bgglow')
        .setTint(T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(ROW_W + 80, ROW_H + 46)
        .setAlpha(0.22)
    )
  }

  c.add(scene.add.image(0, 0, ensureRowPlate(scene, state)))

  const medX = -ROW_W / 2 + 56
  c.add(scene.add.image(medX, 0, ensureMedallion(scene, owned)))
  const icon = scene.add.text(medX, 1, entry.meta.icon, { fontFamily: 'sans-serif', fontSize: '31px' }).setOrigin(0.5)
  icon.setAlpha(owned ? 1 : 0.3)
  c.add(icon)

  c.add(
    scene.add
      .text(TEXT_X, -20, entry.meta.label, { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.goldText })
      .setOrigin(0, 0.5)
      .setLetterSpacing(1)
      // An unwon boost keeps its gold NAME — dimmed, not greyed. It is still a prize; the socket
      // under it is what says you haven't got one yet.
      .setAlpha(owned ? 1 : 0.5)
  )
  // The blurb the model has always carried and no screen had ever shown. Wrapped short of the count
  // cluster so a two-line description can never run under it.
  c.add(
    scene.add
      .text(TEXT_X, 18, entry.meta.blurb, {
        fontFamily: FONT,
        fontSize: '15px',
        color: owned ? T.inkMuted : T.inkFaint,
        lineSpacing: 2,
        wordWrap: { width: BLURB_W },
      })
      .setOrigin(0, 0.5)
      .setAlpha(owned ? 1 : 0.7)
  )

  // ── The right cluster: how many, and what happens to them ──
  const clusterX = ROW_W / 2 - CLUSTER_INSET
  if (owned) {
    const coin = scene.add
      .text(clusterX, -17, `×${entry.count}`, { fontFamily: FONT, fontSize: '21px', fontStyle: '900', color: T.goldPillText })
      .setOrigin(0.5)
      .setShadow(0, 1, 'rgba(255,240,200,0.45)', 1, false, true)
    c.add(scene.add.image(clusterX, -18, ensureCountCoin(scene, Math.max(64, Math.ceil(coin.width) + 30))))
    c.add(coin) // above its own plate — the image is added first so the text lands on top
  } else {
    c.add(
      scene.add
        .text(clusterX, -18, '—', { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.inkFaint })
        .setOrigin(0.5)
        .setAlpha(0.6)
    )
  }

  // The tab states what is about to happen to this type. HELD is deliberately muted rather than
  // gold: it is the absence of an action, and it must never compete with NEXT for the eye. An
  // unowned row says where the thing comes from instead, because that is its only useful answer.
  //
  // MEASURED, not estimated from the character count: 'NOT WON YET' and 'NEXT ×2' differ by half a
  // plate at 13px Arial Black, and a guessed width is how a lozenge ends up with its own label
  // hanging out of it.
  const tab = held ? 'HELD' : going ? (entry.usingNext > 1 ? `NEXT ×${entry.usingNext}` : 'NEXT') : owned ? 'TAP TO USE' : 'NOT WON YET'
  const tabWrap = scene.add.container(clusterX, 22)
  const tabLabel = scene.add
    .text(0, 0, tab, {
      fontFamily: FONT,
      fontSize: '13px',
      fontStyle: '900',
      color: going ? T.goldPillText : held ? T.inkSoft : owned ? T.inkMuted : T.inkFaint,
    })
    .setOrigin(0.5)
    .setLetterSpacing(1)
  const tabW = Math.max(74, Math.ceil(tabLabel.width) + 24)
  const tabG = scene.add.graphics()
  if (going) goldFace(tabG, -tabW / 2, -13, tabW, 26, T, 13)
  else {
    tabG.fillStyle(held ? T.border : T.cardFill, owned ? 1 : 0.18)
    tabG.fillRoundedRect(-tabW / 2, -13, tabW, 26, 13)
    tabG.lineStyle(1, owned ? T.goldDeep : T.goldBright, owned ? 0.5 : 0.3)
    tabG.strokeRoundedRect(-tabW / 2, -13, tabW, 26, 13)
  }
  tabWrap.add([tabG, tabLabel])
  c.add(tabWrap)

  // Every OWNED row is tappable — the gesture flips participation, so there is no owned state where
  // a tap does nothing. (An unowned row stays inert: there is nothing to flip.) The press sinks the
  // whole row a couple of pixels, which is the acknowledgement the flat tiles never had.
  if (owned) {
    const hit = scene.add.rectangle(0, 0, ROW_W, ROW_H, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
    const still = prefersReducedMotion()
    const press = (down: boolean): void => {
      if (still) {
        c.setY(cy + (down ? 2 : 0))
        return
      }
      scene.tweens.add({ targets: c, y: cy + (down ? 2 : 0), duration: down ? D.micro : D.settle, ease: down ? E.press : E.settle })
    }
    hit.on('pointerdown', () => {
      sfx.uiPress()
      press(true)
    })
    hit.on('pointerout', () => press(false))
    hit.on('pointerup', () => {
      press(false)
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

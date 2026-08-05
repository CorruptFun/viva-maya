import Phaser from 'phaser'
import { getThemeId } from './theme'
import type { ThemeId } from './theme'
import { activeFloor } from './floormood'
import type { HazardKind } from '../core/difficulty'

/**
 * How a hazard LOOKS, kept strictly apart from what it DOES.
 *
 * `src/core/` names hazards behaviourally — `coat`, `blocker`, `lock` — and never says felt, crate
 * or ice. Appearance lives here, keyed off the theme the player has chosen and the FLOOR they are
 * standing on. That split is the whole point: a future seasonal pack ("Winter") can render the
 * blocker as a block of ice by adding one skin object and one theme entry, with ZERO changes to the
 * board rules, the hazard planner, the difficulty tuning or any test. Ice is an APPEARANCE of
 * `blocker`, not a fourth mechanic — and so is a chip rack.
 *
 * To add a theme pack you write exactly two things:
 *   1. a `ThemeId` + `Theme` + `THEME_META` entry in `theme.ts` (the existing documented pattern);
 *   2. a `HazardSkin` here, registered in `HAZARD_SKINS` under that id.
 * An Act II FLOOR is the same two steps with `FLOOR_HAZARD_SKINS` as the register.
 * Nothing below `src/view/` needs to know either happened.
 *
 * House rules this file inherits:
 *  - ZERO binary assets. Everything is drawn procedurally into a DynamicTexture at runtime.
 *  - Textures are baked LAZILY (see `ensureHazardTexture`), never in `createAllTextures`, because
 *    boot textures are deliberately not re-baked when the theme changes — a skin swap must be able
 *    to mint fresh art under a fresh key rather than mutate art that is already on screen.
 *  - Every key is skin-scoped, so two skins can coexist in the texture cache without collision.
 */
export interface HazardSkin {
  /** Unique per skin — namespaces every texture key it bakes. */
  id: string
  /** Player-facing name for the intro card and HUD. */
  label: Record<HazardKind, string>
  /**
   * The coat as a lower-case MASS NOUN, for the one place the game talks about it in a sentence —
   * the standing brief under the board ("Goals, felt, and the house minimum"). `label.coat` is a
   * heading and cannot be dropped into prose; a skin that renamed the coat and left the brief saying
   * "felt" would have the board and the sentence describing it disagree, which is the exact failure
   * the copy-comes-from-the-skin rule exists to prevent.
   */
  coatNoun: string
  /** One sentence explaining the rule, shown once when the mechanic first appears. */
  blurb: Record<HazardKind, string>
  /** Draws the obstacle at `hp` of `maxHp` into a TEX_SIZE² texture (authored on a 128 grid). */
  drawBlocker: (g: Phaser.GameObjects.Graphics, size: number, hp: number, maxHp: number) => void
  /** Draws the lock furniture OVER a piece, same authoring grid. */
  drawLock: (g: Phaser.GameObjects.Graphics, size: number) => void
  /** Draws `layers` of coating on the cell FLOOR, under the pieces. */
  drawCoat: (g: Phaser.GameObjects.Graphics, size: number, layers: number) => void
  /** Particle colour for the break/strip burst. */
  burstTint: Record<HazardKind, number>
}

/**
 * The default skin, and the one every current theme resolves to. Deliberately casino furniture —
 * a felt table, a cash lockbox, a clamp bar — rather than anything seasonal, so the winter pack
 * has somewhere distinct to go.
 */
const casinoVault: HazardSkin = {
  id: 'casinoVault',
  label: { coat: 'FELT', blocker: 'LOCKBOX', lock: 'CLAMP' },
  coatNoun: 'felt',
  blurb: {
    coat: 'Some squares are covered in felt. Make a match on top of one to sweep it clean — clear every last square to win the level.',
    blocker: "Lockboxes don't match and can't be moved. Break one by clearing a square right next to it.",
    lock: 'A clamped piece still matches, but it will not move. Clear a square beside it to pop the clamp off.',
  },
  burstTint: { coat: 0x4e8f71, blocker: 0xffb01c, lock: 0xffd76a },

  /**
   * A navy cash lockbox with gold banding and corner rivets. At 2 hp the banding is whole; at 1 the
   * lid is sprung and a crack runs across it, so "one more hit" is legible without reading a number.
   */
  drawBlocker: (g, size, hp, maxHp) => {
    const m = size * 0.11
    const w = size - m * 2
    const r = size * 0.1
    const cracked = hp < maxHp

    g.fillStyle(0x0d1428, 0.55)
    g.fillRoundedRect(m + size * 0.02, m + size * 0.04, w, w, r)
    g.fillStyle(cracked ? 0x2b3a63 : 0x223056, 1)
    g.fillRoundedRect(m, m, w, w, r)
    g.lineStyle(Math.max(2, size * 0.022), 0xffb01c, cracked ? 0.7 : 1)
    g.strokeRoundedRect(m, m, w, w, r)

    // Banding: a vertical strap and the lid seam.
    g.fillStyle(0xffb01c, cracked ? 0.55 : 0.85)
    g.fillRect(size / 2 - size * 0.045, m, size * 0.09, w)
    g.fillRect(m, size * 0.42, w, size * 0.055)

    // Lock plate.
    g.fillStyle(0xf7e6bd, cracked ? 0.6 : 0.95)
    g.fillRoundedRect(size / 2 - size * 0.08, size * 0.46, size * 0.16, size * 0.14, size * 0.03)
    g.fillStyle(0x223056, 1)
    g.fillCircle(size / 2, size * 0.53, size * 0.025)

    // Corner rivets.
    g.fillStyle(0xffd76a, cracked ? 0.5 : 0.9)
    for (const [dx, dy] of [
      [0.2, 0.2],
      [0.8, 0.2],
      [0.2, 0.8],
      [0.8, 0.8],
    ]) {
      g.fillCircle(size * dx, size * dy, size * 0.022)
    }

    if (cracked) {
      g.lineStyle(Math.max(2, size * 0.018), 0x0d1428, 0.8)
      g.beginPath()
      g.moveTo(size * 0.24, size * 0.3)
      g.lineTo(size * 0.44, size * 0.5)
      g.lineTo(size * 0.34, size * 0.62)
      g.lineTo(size * 0.6, size * 0.78)
      g.strokePath()
    }
  },

  /**
   * A gold clamp bar with a padlock, drawn OVER the piece. Deliberately narrow — the symbol beneath
   * must stay readable, because a clamped piece still matches and the player has to plan around it.
   */
  drawLock: (g, size) => {
    const cx = size / 2
    const barH = size * 0.15

    // Diagonal strap. Rotating about the centre keeps it clear of the BAR symbol's horizontal
    // pill, which is the one shape on this board it could otherwise be mistaken for.
    g.save()
    g.translateCanvas(cx, cx)
    g.rotateCanvas(-Math.PI / 4)
    g.fillStyle(0x0d1428, 0.38)
    g.fillRoundedRect(-size * 0.46, -barH / 2 + size * 0.025, size * 0.92, barH, barH / 2)
    g.fillStyle(0x8d6a2a, 1)
    g.fillRoundedRect(-size * 0.46, -barH / 2, size * 0.92, barH, barH / 2)
    g.fillStyle(0xffb01c, 1)
    g.fillRoundedRect(-size * 0.46, -barH / 2, size * 0.92, barH * 0.72, barH / 2)
    g.fillStyle(0xffd76a, 0.85)
    g.fillRect(-size * 0.42, -barH * 0.28, size * 0.84, barH * 0.16)
    g.restore()

    // Padlock at the crossing point, upright so it reads as furniture rather than decoration.
    g.fillStyle(0x0d1428, 0.35)
    g.fillCircle(cx, cx + size * 0.03, size * 0.135)
    g.lineStyle(Math.max(2, size * 0.032), 0xf7e6bd, 1)
    g.beginPath()
    g.arc(cx, cx - size * 0.035, size * 0.062, Math.PI, 0)
    g.strokePath()
    g.fillStyle(0xf7e6bd, 1)
    g.fillRoundedRect(cx - size * 0.085, cx - size * 0.03, size * 0.17, size * 0.16, size * 0.035)
    g.fillStyle(0x223056, 1)
    g.fillCircle(cx, cx + size * 0.045, size * 0.024)
  },

  /**
   * Green baize filling the cell floor, with a stitched edge. A second layer is a deeper felt with
   * a chip-rail border so "this one needs two" reads at a glance without a number.
   */
  drawCoat: (g, size, layers) => {
    const deep = layers >= 2
    const pad = size * 0.02
    const w = size - pad * 2
    const r = size * 0.13

    // Muted, desaturated baize. The first pass used a bright emerald that fought the warm gold
    // board and read as another game's candy; a deep table green sits under the pieces and lets
    // the gold furniture stay the loudest thing on screen.
    g.fillStyle(deep ? 0x143b2a : 0x1e5340, 1)
    g.fillRoundedRect(pad, pad, w, w, r)

    // Inset: dark at the top, a faint lift at the base, so the square reads RECESSED — covered —
    // rather than like a tile that happens to be painted green.
    g.fillStyle(0x000000, 0.22)
    g.fillRoundedRect(pad, pad, w, size * 0.16, { tl: r, tr: r, bl: 0, br: 0 })
    g.fillStyle(0x4e8f71, 0.16)
    g.fillRoundedRect(pad, size - pad - size * 0.13, w, size * 0.13, { tl: 0, tr: 0, bl: r, br: r })

    // Stitched edge, quiet.
    g.lineStyle(Math.max(1, size * 0.012), 0x7fbf9e, deep ? 0.22 : 0.3)
    g.strokeRoundedRect(pad + size * 0.055, pad + size * 0.055, w - size * 0.11, w - size * 0.11, r * 0.7)

    if (deep) {
      // Chip rail marks the second layer — gold, because gold is what this board uses to say
      // "there is more here", and it needs no number to be understood.
      g.lineStyle(Math.max(2, size * 0.02), 0xffb01c, 0.42)
      g.strokeRoundedRect(pad + size * 0.115, pad + size * 0.115, w - size * 0.23, w - size * 0.23, r * 0.5)
    }
  },

}

/**
 * FLOOR 1 · THE HIGH-LIMIT ROOM — brass and baize. The same three obstacles as downstairs, made of
 * better things: the cloth is a proper baize with a brass rule stitched into it, the lockbox is a
 * dealer's CHIP RACK, and the clamp is the brass thumbscrew that holds a card down on a live table.
 *
 * The rule copy is word-for-word the default's with the nouns swapped, and that is deliberate: a
 * player who learned "clear a square next to it" at level 86 must not be able to read a re-dressed
 * obstacle as a new mechanic. The room changed; the game did not.
 */
const highLimitRoom: HazardSkin = {
  id: 'highLimit',
  label: { coat: 'BAIZE', blocker: 'CHIP RACK', lock: "DEALER'S CLAMP" },
  coatNoun: 'baize',
  blurb: {
    coat: 'Some squares are laid with baize. Make a match on top of one to sweep it clean — clear every last square to win the level.',
    blocker: "Chip racks don't match and can't be moved. Break one by clearing a square right next to it.",
    lock: 'A clamped piece still matches, but it will not move. Clear a square beside it to back the clamp off.',
  },
  burstTint: { coat: 0x2f9b78, blocker: 0xe8c27a, lock: 0xc79a4a },

  /**
   * A brass-railed rack of chips standing in a walnut tray. At 2 hp the rail runs the full width on
   * both posts and the stacks are square; at 1 the right post has let go, the rail hangs short, and
   * the stacks have dropped — so "one more hit" reads from the furniture rather than from a number,
   * the same contract the default lockbox's cracked lid signs.
   *
   * Composed FULL-BLEED on purpose. The first pass stacked chips up from the tray floor and left the
   * top 40% of the cell empty dark walnut, which at 76px on a phone read as a hole in the board
   * rather than as an object standing in it (browser, level 301). The rail now caps the composition
   * at the top and the stacks fill the space beneath it.
   */
  drawBlocker: (g, size, hp, maxHp) => {
    const m = size * 0.09
    const w = size - m * 2
    const r = size * 0.08
    const sprung = hp < maxHp

    // Walnut tray + its shadow. Lighter than a true walnut so the chips have something to sit ON —
    // a dark tray plus dark gaps between stacks is a silhouette, not a rack.
    g.fillStyle(0x140d06, 0.5)
    g.fillRoundedRect(m + size * 0.02, m + size * 0.05, w, w, r)
    g.fillStyle(sprung ? 0x63482c : 0x513921, 1)
    g.fillRoundedRect(m, m, w, w, r)
    g.lineStyle(Math.max(2, size * 0.022), sprung ? 0x7d5a22 : 0xc79a4a, 1)
    g.strokeRoundedRect(m, m, w, w, r)

    // The two rail posts, running the height of the tray, drawn BEHIND the chips.
    const railY = size * (sprung ? 0.42 : 0.32)
    for (const px of [0.19, 0.81]) {
      g.fillStyle(0x7d5a22, 1)
      g.fillRect(size * px - size * 0.024, railY, size * 0.048, size * 0.56)
    }

    // Chip stacks: three columns of fat discs filling the tray from the floor up to just under the
    // rail. A sprung rack keeps two-thirds of each and spills one flat.
    const chipCols: [number, number][] = [
      [0.31, 4],
      [0.5, 5],
      [0.69, 3],
    ]
    const chipInk = [0xf2ead6, 0x9a2233, 0x1f6b52]
    const floorY = size * 0.79
    const discH = size * 0.105
    const step = discH * 0.78
    chipCols.forEach(([cx, tall], ci) => {
      const count = Math.max(1, sprung ? Math.round(tall * 0.6) : tall)
      for (let k = 0; k < count; k++) {
        const y = floorY - k * step
        g.fillStyle(0x0a0703, 0.4)
        g.fillEllipse(size * cx, y + size * 0.014, size * 0.24, discH)
        g.fillStyle(chipInk[ci], 1)
        g.fillEllipse(size * cx, y, size * 0.24, discH)
        // The chip's edge stripe — the one detail that makes a column of discs read as CHIPS.
        g.fillStyle(0xffffff, k % 2 === 0 ? 0.55 : 0.26)
        g.fillRect(size * (cx - 0.062), y - discH * 0.2, size * 0.124, discH * 0.2)
      }
    })
    if (sprung) {
      // A chip on its side on the tray floor — the rack has spilled.
      g.fillStyle(0xf2ead6, 0.92)
      g.fillEllipse(size * 0.35, size * 0.86, size * 0.2, size * 0.06)
    }

    // The brass rail across the front, capping the composition. Sprung: it has come off the right
    // post and hangs short of it.
    g.fillStyle(sprung ? 0x7d5a22 : 0xc79a4a, 1)
    g.fillRoundedRect(size * 0.16, railY - size * 0.03, size * (sprung ? 0.44 : 0.68), size * 0.062, size * 0.031)
    g.fillStyle(0xe8c27a, sprung ? 0.45 : 0.9)
    g.fillRect(size * 0.19, railY - size * 0.018, size * (sprung ? 0.38 : 0.62), size * 0.016)
  },

  /**
   * A brass strap with a knurled THUMBSCREW where the default wears a padlock — the fixture a dealer
   * actually uses. Mirrored to +45° so the two clamps are told apart at a glance even at cell size,
   * and diagonal for the same reason the default is: a horizontal bar reads as the BAR symbol's pill.
   */
  drawLock: (g, size) => {
    const cx = size / 2
    const barH = size * 0.125

    g.save()
    g.translateCanvas(cx, cx)
    g.rotateCanvas(Math.PI / 4)
    g.fillStyle(0x140d06, 0.36)
    g.fillRoundedRect(-size * 0.46, -barH / 2 + size * 0.024, size * 0.92, barH, barH / 2)
    g.fillStyle(0x7d5a22, 1)
    g.fillRoundedRect(-size * 0.46, -barH / 2, size * 0.92, barH, barH / 2)
    g.fillStyle(0xc79a4a, 1)
    g.fillRoundedRect(-size * 0.46, -barH / 2, size * 0.92, barH * 0.7, barH / 2)
    g.fillStyle(0xe8c27a, 0.8)
    g.fillRect(-size * 0.42, -barH * 0.3, size * 0.84, barH * 0.15)
    g.restore()

    // The thumbscrew: a knurled brass head, drawn as a ring of short radial teeth around a domed
    // centre with a driver slot. Reads as "screwed down" rather than "locked", which is the point.
    g.fillStyle(0x140d06, 0.34)
    g.fillCircle(cx, cx + size * 0.028, size * 0.145)
    g.fillStyle(0x7d5a22, 1)
    g.fillCircle(cx, cx, size * 0.145)
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2
      g.fillStyle(0xe8c27a, 0.75)
      g.fillCircle(cx + Math.cos(a) * size * 0.128, cx + Math.sin(a) * size * 0.128, size * 0.019)
    }
    g.fillStyle(0xc79a4a, 1)
    g.fillCircle(cx, cx, size * 0.105)
    g.fillStyle(0xe8c27a, 0.65)
    g.fillCircle(cx - size * 0.025, cx - size * 0.028, size * 0.05)
    g.fillStyle(0x3b2a18, 0.9)
    g.fillRect(cx - size * 0.072, cx - size * 0.014, size * 0.144, size * 0.028)
  },

  /**
   * Bottle-green baize with a brass rule stitched a hair in from the edge. Deeper and bluer than the
   * main floor's felt on purpose — upstairs is the better cloth, and the two have to be different
   * greens rather than the same green twice. Second layer doubles the rule.
   */
  drawCoat: (g, size, layers) => {
    const deep = layers >= 2
    const pad = size * 0.02
    const w = size - pad * 2
    const r = size * 0.13

    g.fillStyle(deep ? 0x0c2f27 : 0x14493c, 1)
    g.fillRoundedRect(pad, pad, w, w, r)

    // Recessed read — dark at the top, a faint lift at the base. Same idiom as the default coat,
    // because it is what says COVERED rather than "a tile that happens to be green".
    g.fillStyle(0x000000, 0.24)
    g.fillRoundedRect(pad, pad, w, size * 0.16, { tl: r, tr: r, bl: 0, br: 0 })
    g.fillStyle(0x2f9b78, 0.14)
    g.fillRoundedRect(pad, size - pad - size * 0.13, w, size * 0.13, { tl: 0, tr: 0, bl: r, br: r })

    // A whisper of nap: two long diagonal strokes, so the cloth has a direction.
    g.lineStyle(Math.max(1, size * 0.01), 0x3fbf95, 0.09)
    g.beginPath()
    g.moveTo(size * 0.14, size * 0.86)
    g.lineTo(size * 0.86, size * 0.14)
    g.moveTo(size * 0.14, size * 0.56)
    g.lineTo(size * 0.56, size * 0.14)
    g.strokePath()

    // The brass rule.
    g.lineStyle(Math.max(1, size * 0.014), 0xc79a4a, deep ? 0.4 : 0.5)
    g.strokeRoundedRect(pad + size * 0.06, pad + size * 0.06, w - size * 0.12, w - size * 0.12, r * 0.7)
    if (deep) {
      g.lineStyle(Math.max(2, size * 0.018), 0xe8c27a, 0.45)
      g.strokeRoundedRect(pad + size * 0.125, pad + size * 0.125, w - size * 0.25, w - size * 0.25, r * 0.5)
    }
  },
}

/**
 * FLOOR 2 · THE SPEAKEASY — candlelight, oxblood and walnut. The obstacles are what is actually in
 * the room behind the room: wax pooled where a candle has been burning all night, a barrel nobody
 * has moved since it was rolled in, and a chain someone put on because there is no security here.
 *
 * Same discipline as floor 1: the rules read word-for-word the same, only the nouns change. And the
 * silhouettes are deliberately unlike floor 1's — a barrel is round where a chip rack is square, and
 * a chain crosses the cell where the clamp lies along one diagonal — because the two floors are seen
 * a few minutes apart and "a different room" has to survive being remembered.
 */
const speakeasy: HazardSkin = {
  id: 'speakeasy',
  label: { coat: 'CANDLE WAX', blocker: 'OAK BARREL', lock: 'PADLOCK & CHAIN' },
  coatNoun: 'wax',
  blurb: {
    coat: 'Some squares are under a night of candle wax. Make a match on top of one to scrape it clean — clear every last square to win the level.',
    blocker: "Oak barrels don't match and can't be moved. Break one by clearing a square right next to it.",
    lock: 'A chained piece still matches, but it will not move. Clear a square beside it to snap the chain.',
  },
  burstTint: { coat: 0xf0c98a, blocker: 0xa9743c, lock: 0x9aa3ad },

  /**
   * A cask on its side, iron-hooped, seen end-on-ish so the staves read. At 2 hp it is sound; at 1 a
   * stave has sprung, the top hoop has slipped and it is leaking — which is the same "one more hit"
   * grammar as the sprung chip rack and the cracked lockbox, told in this room's furniture.
   */
  drawBlocker: (g, size, hp, maxHp) => {
    const cx = size / 2
    const cy = size / 2
    const sprung = hp < maxHp
    const rw = size * 0.4 // half-width at the belly
    const rh = size * 0.42 // half-height

    // Shadow, then the barrel body: a fat ellipse, which is the shape no other obstacle on the
    // tower has.
    g.fillStyle(0x140b05, 0.45)
    g.fillEllipse(cx + size * 0.02, cy + size * 0.05, rw * 2, rh * 2)
    g.fillStyle(sprung ? 0x6b4620 : 0x59381a, 1)
    g.fillEllipse(cx, cy, rw * 2, rh * 2)

    // Staves: vertical light/dark bands, tapering with the belly so it reads as a curved surface.
    for (let k = -2; k <= 2; k++) {
      const x = cx + k * size * 0.145
      const h = Math.sqrt(Math.max(0, 1 - (k * size * 0.145 / rw) ** 2)) * rh
      g.fillStyle(k % 2 === 0 ? 0x7a5228 : 0x4a2e15, 0.9)
      g.fillRect(x - size * 0.062, cy - h, size * 0.124, h * 2)
    }

    // Two iron hoops. Sprung: the top one has slipped off true and sits at an angle.
    for (const [k, off] of [
      [-0.6, sprung ? size * 0.03 : 0],
      [0.6, 0],
    ]) {
      const h = Math.sqrt(Math.max(0, 1 - k * k)) * rh
      g.fillStyle(sprung && k < 0 ? 0x6a6f76 : 0x9aa3ad, 1)
      g.fillRect(cx - rw * Math.sqrt(1 - k * k) - size * 0.01, cy + k * rh - size * 0.035 + off, rw * 2 * Math.sqrt(1 - k * k) + size * 0.02, size * 0.07)
      g.fillStyle(0xd6dde4, sprung && k < 0 ? 0.3 : 0.55)
      g.fillRect(cx - rw * Math.sqrt(1 - k * k), cy + k * rh - size * 0.028 + off, rw * 2 * Math.sqrt(1 - k * k), size * 0.018)
      void h
    }

    // The bung, and — once sprung — the trickle out of it.
    g.fillStyle(0x2a1a0b, 1)
    g.fillCircle(cx, cy, size * 0.062)
    g.fillStyle(0x8a5c2a, 0.9)
    g.fillCircle(cx - size * 0.012, cy - size * 0.014, size * 0.038)
    if (sprung) {
      g.fillStyle(0x5a1420, 0.85)
      g.fillRoundedRect(cx - size * 0.022, cy + size * 0.05, size * 0.044, size * 0.3, size * 0.022)
      g.fillStyle(0x8a2230, 0.7)
      g.fillEllipse(cx, size * 0.87, size * 0.22, size * 0.07)
    }
  },

  /**
   * A chain laid across the piece with a heavy iron padlock at the crossing. Vertical-ish rather
   * than diagonal, so it is never mistaken for floor 1's brass strap — and iron rather than brass,
   * because down here the fixture was bought, not fitted.
   */
  drawLock: (g, size) => {
    const cx = size / 2

    // The chain: interlocking links marching down the cell, drawn as rings so the shape is unmistakable.
    for (let k = 0; k < 6; k++) {
      const y = size * 0.13 + k * size * 0.15
      const wide = k % 2 === 0
      g.fillStyle(0x14100a, 0.35)
      g.fillEllipse(cx + size * 0.012, y + size * 0.018, size * (wide ? 0.2 : 0.13), size * (wide ? 0.13 : 0.2))
      g.fillStyle(0x767e88, 1)
      g.fillEllipse(cx, y, size * (wide ? 0.2 : 0.13), size * (wide ? 0.13 : 0.2))
      g.fillStyle(0x3a3f46, 1)
      g.fillEllipse(cx, y, size * (wide ? 0.13 : 0.07), size * (wide ? 0.07 : 0.13))
      g.fillStyle(0xd6dde4, 0.4)
      g.fillEllipse(cx - size * (wide ? 0.07 : 0.045), y - size * 0.03, size * 0.035, size * 0.02)
    }

    // The padlock, hanging where the chain crosses the middle.
    g.fillStyle(0x14100a, 0.4)
    g.fillRoundedRect(cx - size * 0.15, size * 0.44, size * 0.3, size * 0.26, size * 0.05)
    g.lineStyle(Math.max(2, size * 0.036), 0x9aa3ad, 1)
    g.beginPath()
    g.arc(cx, size * 0.44, size * 0.085, Math.PI, 0)
    g.strokePath()
    g.fillStyle(0x5c636c, 1)
    g.fillRoundedRect(cx - size * 0.145, size * 0.43, size * 0.29, size * 0.25, size * 0.05)
    g.fillStyle(0x868e98, 1)
    g.fillRoundedRect(cx - size * 0.145, size * 0.43, size * 0.29, size * 0.11, size * 0.05)
    g.fillStyle(0x1c1f24, 1)
    g.fillCircle(cx, size * 0.56, size * 0.032)
    g.fillRect(cx - size * 0.014, size * 0.56, size * 0.028, size * 0.07)
  },

  /**
   * A pool of candle wax gone hard on the square, ivory over amber, with drips off the near edge.
   * The second layer is a night's more of it: deeper, warmer, and running further down.
   */
  drawCoat: (g, size, layers) => {
    const deep = layers >= 2
    const pad = size * 0.02
    const w = size - pad * 2
    const r = size * 0.13

    // The stained square under the wax. Deeper than the wax by a clear margin: a coated cell has to
    // read as COVERED at a glance against the cream tiles either side of it, and a pale pool on a
    // pale ground is the one way this skin could fail where the baize upstairs cannot.
    g.fillStyle(deep ? 0x8f5f22 : 0xbb8434, 1)
    g.fillRoundedRect(pad, pad, w, w, r)

    // Recessed read — the same idiom every coat uses, so "covered" means the same thing on all
    // three floors even though the material does not.
    g.fillStyle(0x3a2408, 0.26)
    g.fillRoundedRect(pad, pad, w, size * 0.16, { tl: r, tr: r, bl: 0, br: 0 })
    g.fillStyle(0xffe9bd, 0.18)
    g.fillRoundedRect(pad, size - pad - size * 0.13, w, size * 0.13, { tl: 0, tr: 0, bl: r, br: r })

    /**
     * The wax itself: ONE opaque pool that covers most of the square, with a lumpy lower edge and a
     * few runs hanging off it.
     *
     * Built as a slab plus overlapping discs along its bottom, all in the SAME opaque colour — the
     * groove chain in `rgbmarquee.ts` takes the same approach for the same reason: opaque pieces
     * union seamlessly, where semi-opaque ones compound into lumps at every overlap. The first pass
     * drew the pool AS separate translucent blobs and it read as foliage rather than as wax
     * (browser, level 351): a pool has one outline, not four.
     */
    const wax = deep ? 0xe8cf96 : 0xf6e3b8
    const top = deep ? 0.16 : 0.22
    const bottom = deep ? 0.72 : 0.66
    g.fillStyle(wax, 1)
    g.fillRect(size * 0.13, size * top, size * 0.74, size * (bottom - top))
    // Lumpy edges: discs along the bottom lip and one at each shoulder, so the outline is a set
    // thing rather than a rectangle.
    for (const [bx, br] of deep
      ? ([[0.24, 0.13], [0.44, 0.16], [0.64, 0.14], [0.82, 0.11]] as [number, number][])
      : ([[0.3, 0.12], [0.52, 0.14], [0.72, 0.11]] as [number, number][])) {
      g.fillCircle(size * bx, size * bottom, size * br)
    }
    g.fillCircle(size * 0.15, size * (top + 0.06), size * 0.075)
    g.fillCircle(size * 0.85, size * (top + 0.08), size * 0.065)

    // Runs off the lip — the detail that says WAX rather than "a pale tile". Tapered: a wide neck
    // out of the pool down to a heavy bead, which is the shape a run actually sets in.
    for (const [dx, len, wdt] of deep
      ? ([[0.28, 0.24, 0.075], [0.52, 0.17, 0.065], [0.76, 0.2, 0.06]] as [number, number, number][])
      : ([[0.36, 0.16, 0.07], [0.66, 0.12, 0.055]] as [number, number, number][])) {
      const tip = bottom + len
      g.fillRect(size * (dx - wdt / 2), size * (bottom - 0.04), size * wdt, size * (len + 0.04))
      g.fillCircle(size * dx, size * tip, size * (wdt * 0.72))
    }

    // Where it caught the light while it was still running.
    g.fillStyle(0xffffff, deep ? 0.2 : 0.3)
    g.fillRoundedRect(size * 0.2, size * (top + 0.05), size * 0.26, size * 0.05, size * 0.025)
    g.fillStyle(0x8f5f22, deep ? 0.32 : 0.22)
    g.fillRoundedRect(size * 0.2, size * (bottom - 0.1), size * 0.5, size * 0.045, size * 0.022)

    if (deep) {
      // A second night of it sets in visible strata — one ridge where the first pool ended.
      g.lineStyle(Math.max(2, size * 0.018), 0x8f5f22, 0.5)
      g.beginPath()
      g.moveTo(size * 0.16, size * 0.46)
      g.lineTo(size * 0.84, size * 0.42)
      g.strokePath()
    }
  },
}

/**
 * Skin per theme. Every current theme uses the default; a theme may override later without any
 * change here beyond one entry. `default` is required and is the fallback for unknown ids.
 */
export const HAZARD_SKINS: Partial<Record<ThemeId, HazardSkin>> & { default: HazardSkin } = {
  default: casinoVault,
}

/**
 * Skin per Act II FLOOR — the room's own furniture, which outranks the theme's because the floor
 * owns the room (`floormood.ts`'s standing rule). A floor with no entry here simply falls through to
 * the theme, so a new floor can ship its levels before its art without a hole in the board.
 */
export const FLOOR_HAZARD_SKINS: Readonly<Record<number, HazardSkin>> = {
  1: highLimitRoom,
  2: speakeasy,
}

/**
 * The skin to draw with, resolved FLOOR → THEME → default.
 *
 * `activeFloor()` is null in Act I, in endless and with floor moods switched off, so every level at
 * or below 300 resolves exactly as it did before Act II existed — which is the whole reason the
 * lookup is an override chain rather than a replacement. Texture keys are skin-scoped
 * (`hazardTextureKey`), so a floor's art and the main floor's coexist in the cache without collision
 * and a player walking downstairs gets the right furniture back with no re-bake.
 */
export function hazardSkin(): HazardSkin {
  const floor = activeFloor()
  if (floor !== null) {
    const skin = FLOOR_HAZARD_SKINS[floor]
    if (skin) return skin
  }
  return HAZARD_SKINS[getThemeId()] ?? HAZARD_SKINS.default
}

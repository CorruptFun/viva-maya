import Phaser from 'phaser'
import { getThemeId } from './theme'
import type { ThemeId } from './theme'
import type { HazardKind } from '../core/difficulty'

/**
 * How a hazard LOOKS, kept strictly apart from what it DOES.
 *
 * `src/core/` names hazards behaviourally — `coat`, `blocker`, `lock` — and never says felt, crate
 * or ice. Appearance lives here, keyed off the theme the player has chosen. That split is the whole
 * point: a future seasonal pack ("Winter") can render the blocker as a block of ice by adding one
 * skin object and one theme entry, with ZERO changes to the board rules, the hazard planner, the
 * difficulty tuning or any test. Ice is an APPEARANCE of `blocker`, not a fourth mechanic.
 *
 * To add a theme pack you write exactly two things:
 *   1. a `ThemeId` + `Theme` + `THEME_META` entry in `theme.ts` (the existing documented pattern);
 *   2. a `HazardSkin` here, registered in `HAZARD_SKINS` under that id.
 * Nothing below `src/view/` needs to know it happened.
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
 * Skin per theme. Every current theme uses the default; a theme may override later without any
 * change here beyond one entry. `default` is required and is the fallback for unknown ids.
 */
export const HAZARD_SKINS: Partial<Record<ThemeId, HazardSkin>> & { default: HazardSkin } = {
  default: casinoVault,
}

/** The skin for the player's current theme. */
export function hazardSkin(): HazardSkin {
  return HAZARD_SKINS[getThemeId()] ?? HAZARD_SKINS.default
}

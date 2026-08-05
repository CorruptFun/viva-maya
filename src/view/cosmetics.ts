import { DEFAULT_COSMETICS, equipped } from '../core/boutique'
import type { CosmeticSlot } from '../core/boutique'
import { loadSave } from '../core/save'
import { getTheme } from './theme'
import type { Theme } from './theme'

/**
 * THE BOUTIQUE's appearance half. `core/boutique.ts` names and prices the goods; this decides what
 * each one LOOKS like — the same split `view/hazardskins.ts` keeps, and for the same reason: a price
 * is game logic and a hex value is not, and only one of the two belongs in a Vitest `node` run.
 *
 * ── EVERY TABLE IS KEYED BY CATALOGUE ID, AND MUST BE TOTAL ─────────────────────────────────────
 * A good with no look is a purchase that does nothing, so `cosmetics.test.ts` asserts every id in
 * `COSMETICS` resolves here. Resolution always falls back to the house's own set rather than
 * throwing — a save from a newer client can name a cosmetic this build has never heard of, and the
 * honest answer to that is "the default", not a crash on the board build.
 *
 * ── WHAT A COSMETIC MAY NOT DO ─────────────────────────────────────────────────────────────────
 *  · It may never change a RATE, a price, a reward or a difficulty knob. Nothing here is read by
 *    anything in `core/` except through the ids above.
 *  · A CHASE pattern moves the marquee's crest count and lap time. It may NOT move a hue: the
 *    per-theme arcs are that theme's identity, `core/rgb.test.ts` guards them, and Neon Vegas has
 *    about five degrees of headroom before its arc reaches a hue it must never show. Patterns are
 *    the only part of that ring that is safe to sell.
 *  · A CUSHION never wins over HIGH CONTRAST. The a11y pair exists because the default pair is a
 *    near-invisible whisper, and a bought look that could re-hide the grid would make an
 *    accessibility switch purchasable-away. `cushionTints` reads the switch first and returns before
 *    it ever looks at what is equipped.
 */

// ─────────────────────────────────────────────────────────────────────────────
// CUSHIONS — the board's checkerboard tint pair.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 8×8 tint pair, [A, B]. Kept LIGHT on purpose: the cushions are the ground every symbol is
 * read against, the baked `tile` texture fakes its whole form with black-alpha shading over a pure
 * white body (so a dark tint eats the gloss and the seated-base AO together), and the well floor
 * underneath is a deep warm tan the pair has to stay clear of. Each pair carries a stronger
 * A/B separation than the default whisper — that difference is most of what makes a bought table
 * read as a different table at a glance.
 */
const CUSHIONS: Record<string, [number, number]> = {
  'cushion.claret': [0xf6dde0, 0xecccd2],
  'cushion.emerald': [0xdceade, 0xcadfd1],
  'cushion.oxblood': [0xe8c9ca, 0xd9b4b8],
  'cushion.penthouse': [0xfdf7ea, 0xf1e5cd],
}

/**
 * What the board should tint its cushions, this build, right now.
 *
 * HIGH CONTRAST WINS, unconditionally and first. Everything below that line is a preference between
 * looks that are all legible; the a11y pair is the one that exists because a look was NOT.
 *
 * `hc` is PASSED IN rather than read from `ui.hcBoard()` here, for two reasons that happen to
 * agree: GameScene has already resolved the switch into `this.hc` and a second read would be a
 * second source of truth, and it keeps this module clear of `view/ui.ts` — which drags Phaser into
 * a Vitest `node` run that only wanted to check a colour table.
 */
export function cushionTints(T: Theme, hc: boolean): [number, number] {
  if (hc) return [T.tileHcA, T.tileHcB]
  const id = equipped(loadSave(), 'cushion')
  return CUSHIONS[id] ?? [T.tileA, T.tileB]
}

// ─────────────────────────────────────────────────────────────────────────────
// CHIP FACES — the casino token baked into the `chip` texture.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One token's colour scheme. `makeChip` stacks these into its rim bevel / edge spots / inner ring /
 * dished face / centre pip, and every one of those forms is faked by LIGHTNESS ORDER — so a face
 * only reads correctly while `deep < main < light` holds within each triple. That is the same
 * invariant `textures.ts`'s palette note states for the baked props generally; break it and the
 * bevels invert into something that looks like a rendering bug rather than a different chip.
 */
export interface ChipFace {
  /** Rim bevel, darkest → lightest. */
  rimDeep: number
  rimMain: number
  rimLight: number
  /** The eight edge spots. */
  spot: number
  /** Inner ring bevel, darkest → lightest. */
  ringDeep: number
  ringMain: number
  ringLight: number
  /** The dished face the pip sits in. */
  face: number
  /** Centre pip dome, darkest → lightest. */
  pipDeep: number
  pipMain: number
  pipLight: number
}

/**
 * The house token, transcribed from `makeChip`'s original literals — so `chip.house` is not
 * "roughly today's chip", it IS today's chip, and a player who buys nothing sees no change at all.
 * (The values come off `THEMES.golden` for the same reason every baked prop does: the boot textures
 * carry the default theme's warmth permanently and are read against all four washes.)
 */
function houseFace(T: Theme): ChipFace {
  return {
    rimDeep: T.roseDeep,
    rimMain: 0xc4223e,
    rimLight: T.roseLight,
    spot: T.cardFillWarm,
    ringDeep: T.goldDeep,
    ringMain: T.gold,
    ringLight: T.goldBright,
    face: T.cardFillWarm,
    pipDeep: T.roseDeep,
    pipMain: T.rose,
    pipLight: T.roseLight,
  }
}

const CHIP_FACES: Record<string, (T: Theme) => ChipFace> = {
  // Cream edge, gold ring, rose pip — the quiet token. The rim is the only thing that moves far.
  'chip.ivory': T => ({
    ...houseFace(T),
    rimDeep: 0xb59a63,
    rimMain: 0xe8d6ac,
    rimLight: 0xfaefd2,
    spot: 0xb08a4a,
    pipDeep: 0x8e1f31,
    pipMain: T.rose,
    pipLight: T.roseLight,
  }),
  // Navy edge, silver ring — late-table stock, and the one face that is cool all the way through.
  'chip.midnight': T => ({
    ...houseFace(T),
    rimDeep: 0x11203a,
    rimMain: 0x27406b,
    rimLight: 0x4463a0,
    spot: 0xe6ecf7,
    ringDeep: 0x8792a5,
    ringMain: 0xc4cede,
    ringLight: 0xeef3fb,
    face: 0xeef1f8,
    pipDeep: 0x1b2c4c,
    pipMain: 0x38578c,
    pipLight: 0x6f8dc4,
  }),
  // Black edge, gold everything. The high-limit token — the face goes dark too, which is why the
  // pip flips to gold: a rose dome on near-black loses its own bevel.
  'chip.obsidian': T => ({
    rimDeep: 0x090909,
    rimMain: 0x1d1c1b,
    rimLight: 0x3b3833,
    spot: T.goldBright,
    ringDeep: T.goldDarkest,
    ringMain: T.gold,
    ringLight: T.goldBright,
    face: 0x272522,
    pipDeep: T.goldDarkest,
    pipMain: T.gold,
    pipLight: T.goldBright,
  }),
}

/** The token to bake. Falls back to the house face for an unknown or unowned id. */
export function chipFace(T: Theme = getTheme()): ChipFace {
  const id = equipped(loadSave(), 'chip')
  return (CHIP_FACES[id] ?? houseFace)(T)
}

/**
 * A cache-busting suffix for the baked `chip` texture key, so equipping re-bakes instead of
 * silently keeping the old art. Empty for the house face — which keeps the key literally `'chip'`
 * for every player who has bought nothing, so no call site anywhere changes for them.
 */
export function chipFaceSuffix(): string {
  const id = equipped(loadSave(), 'chip')
  return id === DEFAULT_COSMETICS.chip ? '' : `:${id}`
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAILS — what the board throws off itself on a win.
// ─────────────────────────────────────────────────────────────────────────────

export interface WinTrail {
  /** The two textures the burst alternates between. Both must already be baked at boot. */
  tokens: [string, string]
  /**
   * The RESTING scale of each token, paired with `tokens`.
   *
   * Carried per token rather than derived, because the baked art is not one size: `chip` is 48px,
   * `card` 40×56, `glint` 48, `medallion` 112 and `star` 128. A single shared scale would throw a
   * 109px star across the board next to a 41px chip. The house pair's 0.85/0.85 is the burst's
   * original literal, transcribed — so buying nothing changes nothing.
   *
   * ⚠️ These are SCALES, not display sizes. The burst tweens `scale`, and a `scale:` tween on an
   * image sized with `setDisplaySize` lands at the native texture size instead (the trophy-pile
   * bug) — so the scale is what has to be authored here.
   */
  scales: [number, number]
  /** Tint applied to every token, or null to leave the art as drawn (the house trail). */
  tint: number | null
}

const HOUSE_TRAIL: WinTrail = { tokens: ['chip', 'card'], scales: [0.85, 0.85], tint: null }

const TRAILS: Record<string, WinTrail> = {
  'trail.goldrush': { tokens: ['chip', 'medallion'], scales: [0.85, 0.45], tint: 0xffd98a },
  'trail.rosefall': { tokens: ['card', 'star'], scales: [0.85, 0.34], tint: 0xff9fb4 },
  'trail.champagne': { tokens: ['star', 'glint'], scales: [0.34, 0.92], tint: 0xfff3d6 },
}

/** What the win burst throws. The house trail is today's exact chip/card pair, untinted. */
export function winTrail(): WinTrail {
  return TRAILS[equipped(loadSave(), 'trail')] ?? HOUSE_TRAIL
}

// ─────────────────────────────────────────────────────────────────────────────
// CHASE — the marquee's PATTERN. Never its colour.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An override for the RGB ring's `idle` profile: how many bright crests travel the frame, and how
 * long one lap takes. Deliberately only these two fields — the hue arc, the saturation and the
 * band's brightness floor are all off-limits (see this file's header).
 */
export interface ChasePattern {
  /** Bright crests riding the ring at once. */
  waves: number
  /** ms for one full lap. */
  lapMs: number
}

const CHASES: Record<string, ChasePattern> = {
  'chase.twincrest': { waves: 2, lapMs: 2400 },
  'chase.runner': { waves: 3, lapMs: 1500 },
}

/** The equipped chase, or null for the house pattern (which is the ring's own shipped `idle`). */
export function chasePattern(): ChasePattern | null {
  return CHASES[equipped(loadSave(), 'chase')] ?? null
}

/** The house's own resting pattern, transcribed from `rgbmarquee.ts`'s `idle` profile — so the
 *  boutique can print what you already have next to what it is selling. */
export const HOUSE_CHASE: ChasePattern = { waves: 1, lapMs: 3600 }

/** A chase in words: what a shelf row says under the name, since a still swatch cannot show motion. */
export function chaseBlurb(id: string): string {
  const p = CHASES[id] ?? HOUSE_CHASE
  const crests = p.waves === 1 ? '1 light' : `${p.waves} lights`
  const pace = p.lapMs >= 3000 ? 'slow lap' : p.lapMs >= 2000 ? 'brisk lap' : 'fast lap'
  return `${crests} · ${pace}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview — one swatch per good, for the shop shelf.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two colours that stand for a good on a price tag, whatever its slot. The boutique paints a small
 * two-tone chip from these rather than rendering a live board / marquee / win burst per row: a
 * shelf of a dozen working previews is a dozen running clocks, and the point of the row is "which
 * one is this", which two colours answer.
 *
 * ⚠️ NO TWO GOODS MAY PAINT THE SAME SWATCH — two rows that look identical are two rows a player
 * cannot choose between. `boutique.test.ts` walks the whole catalogue and asserts it, which is what
 * caught the CHASE patterns (all gold, because a pattern has no colour of its own) and the two
 * defaults that both fell through to the same fallback. The chases below are therefore given an
 * explicit calm→hot ramp, and the row prints `chaseBlurb` under the name to carry the real
 * difference in words.
 */
const SWATCHES: Record<string, (T: Theme) => [number, number]> = {
  'chase.house': T => [T.goldDeep, T.gold],
  'chase.twincrest': T => [T.gold, T.goldBright],
  'chase.runner': T => [T.goldBright, 0xfff3d6],
  'trail.house': T => [0xc4223e, T.cardFillWarm],
  'chip.house': T => [0xc4223e, T.gold],
}

export function swatch(id: string, T: Theme = getTheme()): [number, number] {
  const explicit = SWATCHES[id]
  if (explicit) return explicit(T)
  const cushion = CUSHIONS[id]
  if (cushion) return cushion
  const face = CHIP_FACES[id]
  if (face) {
    const f = face(T)
    return [f.rimMain, f.ringMain]
  }
  const trail = TRAILS[id]
  if (trail) return [trail.tint ?? T.gold, T.cardFillWarm]
  if (id === DEFAULT_COSMETICS.cushion) return [T.tileA, T.tileB]
  return [T.gold, T.cardFillWarm]
}

/** Every slot's display name, for the shelf headers. */
export const SLOT_NAMES: Record<CosmeticSlot, string> = {
  cushion: 'TABLE FELT',
  chip: 'CHIP FACE',
  trail: 'WIN TRAIL',
  chase: 'MARQUEE CHASE',
}

import Phaser from 'phaser'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { getTheme } from './theme'
import type { Theme } from './theme'
import { ensureBandTexture } from './background'

// ─────────────────────────────────────────────────────────────────────────────
// The plate kit — the material + lighting law (E7), promoted out of ui.ts so every
// surface in the game (HUD cards, overlay cards, panels, cabinets, shelves) can
// reach the exact same finishes the buttons and leaderboard plates already wear:
// ONE key light, straight-down soft shadows, falling-height gloss bands, the
// dark-theme lit accent rim, and the canonical real-metal gold face.
//
// ⚠️ Never import './ui' from here. ui.ts imports this module (and re-exports the
// legacy names), so a platekit → ui edge would close a require cycle — the same
// trap the help panel's lazy leaderboard import exists to dodge.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Radius clamped to just UNDER half the smallest side. Phaser's `fillRoundedRect`/`strokeRoundedRect`
 * spike at the corners when the radius equals exactly half a side (a perfect semicircle end): the arc
 * tessellation overshoots the tangent and bakes a sharp "ear" into the texture. Staying 1px under the
 * half keeps a hair of straight edge at each end so the arcs never degenerate — visually identical,
 * artifact-free at every DPR.
 */
export function safeR(r: number, w: number, h: number): number {
  return Math.max(1, Math.min(r, w / 2 - 1, h / 2 - 1))
}

/** The one key light for the whole UI (design-space, above-centre). Every surface casts away from it. */
export const LIGHT = { x: 360, y: -200 }

/**
 * Soft drop-shadow for a rounded-rect surface (top-left x,y · size w×h). Because LIGHT sits above
 * the scene, every surface casts straight DOWN; a few falling-offset copies build a soft penumbra.
 * Routing the baked UI shadows through this is what makes them all agree on one light direction.
 */
export function dropShadow(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: number,
  opts: { alpha?: number; dist?: number; layers?: number } = {}
): void {
  const alpha = opts.alpha ?? 0.08
  const dist = opts.dist ?? 6
  const layers = opts.layers ?? 3
  for (let i = 1; i <= layers; i++) {
    g.fillStyle(color, alpha)
    g.fillRoundedRect(x, y + (dist * i) / layers, w, h, r)
  }
}

/** Relative luminance (0..1) of a packed RGB — used to tell the dark themes from the cream ones. */
function luma(color: number): number {
  const r = ((color >> 16) & 0xff) / 255
  const g = ((color >> 8) & 0xff) / 255
  const b = (color & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Dark themes (Rose Midnight / Neon Vegas) have a near-black wash; the cream themes don't. */
export function isDarkTheme(T: Theme = getTheme()): boolean {
  return luma(T.washBottom) < 0.4
}

/**
 * Dark-theme-only lit accent rim along the TOP inner edge of a cream card/pill. A coloured lit rim
 * is what makes neon read expensive; on Golden Hour / Maya's Heart this is a no-op (cost + look
 * unchanged). Draw AFTER the fill/bezel so the rim sits on top of the top edge.
 */
export function accentRimTop(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  r: number,
  opts: { thickness?: number; alpha?: number; inset?: number } = {}
): void {
  const T = getTheme()
  if (!isDarkTheme(T)) return
  const th = opts.thickness ?? 2
  const inset = opts.inset ?? 3
  g.fillStyle(T.accent, opts.alpha ?? 0.85)
  g.fillRoundedRect(x + r, y + inset, w - r * 2, th, th / 2)
}

/** The gold tokens `goldFace` reads — a subset every Theme already provides. */
export type GoldTokens = Pick<Theme, 'goldBright' | 'gold' | 'goldDeep' | 'goldDarkest' | 'glossHi'>

/**
 * Canonical real-metal gold face (E7): stacked flat-alpha rounded rects from a bright crown down to
 * a deep belly, plus one thin `glossHi` specular band at ~40% height. Reads as curved metal instead
 * of flat "yellow plastic". Baked into a Graphics — shared so the champion plate, payline, win-card
 * tab and marquee lozenge all wear the exact same material.
 *
 * ⚠️ EVERY BAND IS INSET, and that is the whole difference between metal and a shape with ears.
 * A band shorter than the silhouette's corner radius cannot wear that radius (`safeR` clamps it to
 * the band's own half-height), and a smaller radius is a SQUARER corner — so an un-inset 2px crown
 * band pokes its near-right-angle corners straight out through an arc that has barely opened yet,
 * and they read as light gold "ears" hanging off the shape. `ensureFaceTexture` (ui.ts) learned
 * this early on the 3-D button caps and has carried the guard ever since; this function never got
 * it, so every `goldFace` surface in the game has quietly worn a set — invisible on a wide gold
 * pill, where the ear is gold-on-gold inside the cap's own corner, and unmissable the moment the
 * material was asked to be a 64px medallion RING, where it sprouted four (owner, 2026-08-04).
 *
 * Insetting by `r - (the band's own radius)` puts the band's corner exactly back on the silhouette's
 * arc at the corner point and inside it everywhere else.
 *
 * The BELLY falloff is why the whole stack is now laid down darkest-first. It used to be painted on
 * afterwards as a bottom-anchored strip with `{bl: r, br: r}` corners — degenerate whenever `r`
 * exceeds the strip's own height, which it always does at `0.28 * h`, so it poked DARK ears out of
 * the underside. And it cannot simply be inset like the crown bands: a band's radius is capped by
 * its own height, so the inset that keeps its bottom corners inside the arc is exact only AT those
 * corners and wildly over-conservative above them — which turns the falloff into a dark BAR floating
 * across the middle of the shape (measured: a 34px coin's belly narrowed by 24px). So the darkest
 * metal is the base, and the lighter metal is stacked over it TOP-anchored like everything else. The
 * falloff is then whatever the top-anchored bands fail to reach, which follows the bottom arc
 * exactly, for free, at every radius.
 */
export function goldFace(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  tokens: GoldTokens = getTheme(),
  radius?: number
): void {
  const r = safeR(radius ?? Math.min(h / 2, 18), w, h)
  /** Top-anchored band of height `bh`, inset so its squarer corners stay inside the silhouette's arc. */
  const band = (bh: number, colour: number, alpha: number): void => {
    const rb = safeR(r, w, bh)
    const ins = Math.max(0, r - rb)
    if (w - ins * 2 <= 0 || bh <= 0) return
    g.fillStyle(colour, alpha)
    g.fillRoundedRect(x + ins, y, w - ins * 2, bh, rb)
  }
  // Darkest metal underneath the lot — the belly falloff is the rim this leaves uncovered.
  g.fillStyle(tokens.goldDarkest, 1)
  g.fillRoundedRect(x, y, w, h, r)
  band(h * 0.97, tokens.goldDeep, 0.5)
  band(h * 0.9, tokens.goldDeep, 1)
  // Bright crown → gold → deep belly: top-anchored falling-height bands (a gradient without a live fill).
  const bands = 8
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1)
    band(h * (0.86 - 0.8 * t), t < 0.5 ? tokens.goldBright : tokens.gold, 0.16)
  }
  // One thin specular gloss band at ~40% height (the crown highlight of real metal).
  const glossH = Math.max(2, h * 0.09)
  g.fillStyle(tokens.glossHi, 0.5)
  g.fillRoundedRect(x + r * 0.5, y + h * 0.36, w - r, glossH, safeR(glossH / 2, w, glossH))
}

/**
 * Top-lit gloss — the falling-height highlight bands the button caps and leaderboard plates use,
 * as one call. Each band is inset 4px and 2px down so it can never touch the corner arcs (§2a
 * "ears"), and its radius is clamped against its OWN height (§2b same-radius rule) — the exact
 * math `ensureModulePlate` shipped with.
 */
export function glossBands(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  opts: { bands?: number; alpha?: number; color?: number } = {}
): void {
  const bands = opts.bands ?? 3
  const alpha = opts.alpha ?? 0.16
  const color = opts.color ?? getTheme().glossHi
  for (let i = 0; i < bands; i++) {
    const bh = h * (0.42 - i * 0.12)
    if (bh < 3) break
    g.fillStyle(color, alpha)
    g.fillRoundedRect(x + 4, y + 2, w - 8, bh, Math.min(r - 2, bh / 2))
  }
}

/**
 * The full rich-plate finish in one call — soft down-cast shadow, card fill, top-lit gloss, gold
 * bezel, dark-theme accent rim. This is the leaderboard module plate's recipe generalised, so a
 * panel painted here is indistinguishable in material from the plates the player already ranks as
 * "expensive". Draw-once surfaces (a panel opening) may call it live; anything that repaints
 * should go through `bakePanel` instead.
 */
export function panelPlate(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  opts: {
    fill?: number
    bezel?: number
    bezelWidth?: number
    shadowAlpha?: number
    shadowDist?: number
    gloss?: boolean
    glossAlpha?: number
    rimAlpha?: number
  } = {}
): void {
  const T = getTheme()
  const rr = safeR(r, w, h)
  dropShadow(g, x, y, w, h, rr, T.shadow, { alpha: opts.shadowAlpha ?? 0.12, dist: opts.shadowDist ?? 9 })
  g.fillStyle(opts.fill ?? T.cardFill, 1)
  g.fillRoundedRect(x, y, w, h, rr)
  if (opts.gloss !== false) glossBands(g, x, y, w, h, rr, { alpha: opts.glossAlpha })
  g.lineStyle(opts.bezelWidth ?? 4, opts.bezel ?? T.goldBezel, 1)
  g.strokeRoundedRect(x, y, w, h, rr)
  accentRimTop(g, x, y, w, rr, { alpha: opts.rimAlpha ?? 0.9 })
}

/** Bake padding around a `bakePanel` plate — must clear the shadow throw (dist 9 + feather). */
export const PLATE_PAD = 12

/**
 * Bake a `panelPlate` into the global TextureManager and return the key. Ten identical cards then
 * cost ten quads of one texture instead of ten live Graphics re-tessellating per frame.
 *
 * ⚠️ The key MUST embed `getTheme().id` (the `race:{kind}:{themeId}:{w}x{h}` precedent) — plates
 * are theme-token paint, textures outlive a theme-swap `scene.restart()`, and a theme-blind key
 * would hand the new theme the old theme's plate.
 */
export function bakePanel(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  r: number,
  opts: Parameters<typeof panelPlate>[6] = {}
): string {
  if (scene.textures.exists(key)) return key
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  panelPlate(g, PLATE_PAD, PLATE_PAD, w, h, r, opts)
  g.generateTexture(key, w + PLATE_PAD * 2, h + PLATE_PAD * 2)
  g.destroy()
  return key
}

export interface FocusScrim {
  /** The full-screen rectangle — the piece call sites make interactive (tap-to-close / tap-swallow). */
  hit: Phaser.GameObjects.Rectangle
  /** The four static edge-fade bands. Never interactive — they must not eat the hit rect's taps. */
  art: Phaser.GameObjects.Image[]
}

/**
 * A modal scrim that reads as a SPOTLIGHT instead of a flat ink wall: a slightly lighter full-screen
 * wash plus four inward-fading edge bands (the backdrop vignette's geometry, tinted `scrim` ink), so
 * the card above it sits in a pool of light. Net vs the old flat rectangle at the same `alpha`: the
 * centre is ~0.1 lighter, the edges ~0.15 darker. All NORMAL blend, warm scrim ink (never black),
 * fully static — zero tweens, so it needs no motion/flash gates.
 *
 * Interactivity stays at the call site: every panel wires its own `pointerup` close (or tap-swallow)
 * on `hit`, exactly as the flat rectangles did.
 */
export function addFocusScrim(
  scene: Phaser.Scene,
  opts: { alpha?: number; depth?: number; ink?: number } = {}
): FocusScrim {
  ensureBandTexture(scene)
  const T = getTheme()
  const a = opts.alpha ?? 0.5
  const ink = opts.ink ?? T.scrim
  const W = DESIGN_W
  const H = worldH()
  const cy = viewportCenterY()
  const vt = cy - H / 2 // visible top edge (matches the flat scrims' cover geometry)
  // +400 overscan (the stash/charm scrims' convention) so a camera nudged by shake trauma or a
  // grown world can never expose a bare edge behind a modal.
  const hit = scene.add.rectangle(W / 2, cy, W, H + 400, ink, a * 0.8)
  const band = (x: number, y: number, w: number, h: number, alpha: number, angle: number): Phaser.GameObjects.Image =>
    // displaySize is pre-rotation: the texture's fade axis (its height) spans the band's fade extent.
    scene.add.image(x, y, 'bgband').setDisplaySize(w, h).setAngle(angle).setTint(ink).setAlpha(alpha)
  const art = [
    band(W / 2, vt + 170, W, 340, a * 0.5, 0), // top (fades down)
    band(W / 2, vt + H - 190, W, 380, a * 0.6, 180), // bottom (fades up)
    band(100, cy, H, 200, a * 0.45, -90), // left (fades right)
    band(W - 100, cy, H, 200, a * 0.45, 90), // right (fades left)
  ]
  if (opts.depth !== undefined) {
    hit.setDepth(opts.depth)
    for (const img of art) img.setDepth(opts.depth)
  }
  return { hit, art }
}

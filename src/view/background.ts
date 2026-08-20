import Phaser from 'phaser'
import { BOARD_W, BOARD_Y, contentOffsetY, DESIGN_H, DESIGN_W, worldH } from '../config'
import { setStageMood } from '../view3d/stage'
import { activeFloorMood } from './floormood'
import type { FloorFlourish } from './floormood'
import { D, E } from './motion'
import { quality } from './quality'
import { css, getTheme, getThemeId, prefersReducedMotion } from './theme'

/**
 * Atmospheric warm-light backdrop for the empty margins (§3b of the visual
 * overhaul). Fakes volumetric lounge depth with a stack of translucent ADD light
 * planes between the flat wash and the opaque gameplay — spotlight cone, drifting
 * god-rays, blurred bokeh, a warm board light-bleed, a warm vignette that focuses
 * the eye inward, and a chasing marquee. Everything is procedural + baked once and
 * animated ONLY with transforms/alpha (no per-frame graphics redraw).
 *
 * Three guarantees keep the board readable and the GPU cool:
 *  1. Every light plane lives at NEGATIVE depth, so the opaque gold tray + tiles
 *     (depth ≥ 0) mechanically occlude anything over the board rect 40–680×300–940.
 *  2. Alpha ceilings — board-adjacent ≤ 0.10, margin-confined ≤ 0.20; all light is
 *     ADD, the vignette is the single NORMAL darkener (warm, never black).
 *  3. Per-variant intensity + the adaptive quality governor keep steady-state
 *     blended overdraw within the §5 fill-rate budget (≤ 3.0 FSE menu, ≤ 2.0 game).
 */
export type BackdropVariant = 'home' | 'menu' | 'game'

/**
 * How far the opaque wash is painted BEYOND the visible world, on all four sides.
 *
 * ⚠️ THE HORIZONTAL HALF IS LOAD-BEARING, and it was missing until 2026-08-11. `Camera.shake`
 * translates the camera MATRIX by up to `intensity × camera.width` (Phaser's Shake effect), and
 * `GameScene.update`'s trauma rattle scrolls the camera outright — so every reel detent, blast and
 * thunderclap slides the whole scene sideways for a few frames. The wash was filled at exactly
 * `0 → DESIGN_W`, so those frames exposed a bare strip of the game's CLEAR colour down the FULL
 * height of the screen. That colour is `#fff9ec` (main.ts) — Golden Hour's `washTop`, and a warm
 * cream on every theme — so on the two dark themes it read as a white line tearing off the side of
 * the cabinet on each hit (owner video 2026-08-11, measured at 5–6 device px against a Neon Vegas
 * wash, alternating sides with the shake's direction). Nothing else could cover for it: the wash is
 * the only opaque layer down there, and the 3D room — which happens to hide this on the devices that
 * run it — is exactly the layer that is absent on the hardware taking the 2D path.
 *
 * 60 is the geometry the vertical pad has always had, kept deliberately: the wash is a GRADIENT, and
 * the rect it fills is what the stops are mapped onto, so this is not a free knob — growing it
 * re-maps the ramp slightly. It is ~4× the loudest horizontal excursion in the game (GameScene's
 * trauma peaks at ±14 world px; lightning's `shake(300, 0.011)` reaches ±8) and it also covers the
 * zoom-settle entrance, whose `Back.easeOut` dips the camera below 1× on its way home. Widen the
 * budget rather than this constant if a future effect needs more.
 */
const WASH_BLEED = 60

/** Explicit negative depth ladder (§3b) — the mechanical no-cross-the-board guarantee. */
const Z = {
  wash: -60,
  aurora: -56,
  bleed: -54,
  spotHot: -52,
  spotBlade: -50,
  godray: -50,
  bokehMid: -48,
  bokehCorner: -46,
  suits: -44,
  sparkle: -42,
  flourish: -40, // per-theme margin accent (A1) — above the sparkle dust, below the vignette
  vignette: -34,
  marquee: -30,
  proscenium: -28, // the shared frame molding — frontmost backdrop layer, still behind gameplay (≥0)
} as const

// Ambient tween durations, derived from the motion vocabulary's breath token so the
// backdrop stays slow + coherent rather than sprinkled with magic numbers.
const T_AURORA = D.breath * 3 // slow aurora pulse
const T_BLEED = D.breath * 1.6 // board light-bleed pulse
const T_HOT = D.breath * 1.8 // spotlight hotspot breathe
const T_SWAY = D.breath * 2.4 // ray / cone sway
const T_TWINKLE = D.breath * 2.6 // bokeh twinkle
const T_DRIFT = D.breath * 4 // sparkle drift
const T_MARQUEE = D.breath * 1.9 // marquee chase loop
const T_FLICKER = D.breath * 1.4 // per-theme neon sign-bulb flicker (A1)

// Board centre (the opaque tray occludes negative-depth light across the board rect).
const BOARD_MID_X = DESIGN_W / 2
const BOARD_MID_Y = BOARD_Y + BOARD_W / 2 // 620

type SuitSpec = [glyph: string, x: number, y: number, size: number, angle: number, alpha: number]

const SUITS_BOTTOM: SuitSpec[] = [
  ['♥', 96, 1078, 64, -18, 0.09],
  ['♣', 250, 1160, 44, 12, 0.07],
  ['♦', 420, 1096, 52, -8, 0.08],
  ['♠', 580, 1170, 60, 16, 0.07],
  ['♥', 660, 1060, 38, 24, 0.06],
]

const SUITS_TOP: SuitSpec[] = [
  ['♦', 52, 44, 40, -14, 0.07],
  ['♣', 668, 52, 46, 10, 0.06],
]

const SUITS_MID: SuitSpec[] = [
  ['♥', 40, 640, 54, -20, 0.07],
  ['♠', 684, 560, 48, 14, 0.06],
  ['♦', 34, 900, 40, 10, 0.06],
  ['♣', 690, 860, 42, -12, 0.06],
]

/**
 * Bake the shared edge-fade band ('bgband'): a white strip whose ALPHA falls 1 → 0
 * top-to-bottom, drawn through the 2D-canvas gradient API (not Graphics
 * fillGradientStyle). Consumed by the backdrop vignette and fx.ts's screen gloss.
 *
 * Why it exists: with the game canvas now transparent (the 3D room lives behind
 * it), Phaser's WebGL GRADIENT fills leave a broken alpha channel wherever they
 * land on unpainted canvas — the browser then mis-composites them into pale
 * hard-edged rectangles (observed on every fillGradientStyle band; plain fills,
 * text and texture draws are unaffected). Textured images go through the
 * premultiplied texture pipeline and composite correctly on every path, so the
 * bands are now tinted images of this strip instead.
 */
export function ensureBandTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists('bgband')) return
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 256
  const ctx = c.getContext('2d')
  if (!ctx) return
  const grad = ctx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 32, 256)
  scene.textures.addCanvas('bgband', c)
}

function ensureTextures(scene: Phaser.Scene): void {
  ensureBandTexture(scene)
  if (!scene.textures.exists('bgdot')) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    g.fillStyle(0xffffff, 0.35)
    g.fillCircle(8, 8, 7)
    g.fillStyle(0xffffff, 0.8)
    g.fillCircle(8, 8, 4)
    g.fillStyle(0xffffff, 1)
    g.fillCircle(8, 8, 2)
    g.generateTexture('bgdot', 16, 16)
    g.destroy()
  }
  if (!scene.textures.exists('bgglow')) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    for (let i = 10; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.028 * (11 - i))
      g.fillCircle(64, 64, (64 * i) / 10)
    }
    g.generateTexture('bgglow', 128, 128)
    g.destroy()
  }
}

// --- small shared builders --------------------------------------------------

/** A soft ADD glow (the pre-blurred `bgglow`), display-sized in px, tinted + placed. */
function addGlow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  tint: number,
  alpha: number,
  depth: number
): Phaser.GameObjects.Image {
  return scene.add
    .image(x, y, 'bgglow')
    .setDisplaySize(w, h)
    .setTint(tint)
    .setAlpha(alpha)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDepth(depth)
}

/**
 * Slow alpha yoyo — the canonical "breathing light" pulse. Static when `!animate`.
 * Returns the tween (or `undefined` when static) so an idle throttle (A2) can slow it.
 */
function breatheAlpha(
  scene: Phaser.Scene,
  obj: Phaser.GameObjects.GameObject & { setAlpha(a: number): unknown },
  lo: number,
  hi: number,
  dur: number,
  animate: boolean,
  delay = 0
): Phaser.Tweens.Tween | undefined {
  if (!animate) {
    obj.setAlpha((lo + hi) / 2)
    return undefined
  }
  obj.setAlpha(lo)
  return scene.tweens.add({ targets: obj, alpha: hi, duration: dur, delay, yoyo: true, repeat: -1, ease: E.hero })
}

/** Gentle ± rotation of a rig container so a whole cone / ray pair sways as one tween. */
function sway(scene: Phaser.Scene, rig: Phaser.GameObjects.Container, deg: number, dur: number, animate: boolean): void {
  if (!animate) {
    rig.setAngle(0)
    return
  }
  rig.setAngle(-deg)
  scene.tweens.add({ targets: rig, angle: deg, duration: dur, yoyo: true, repeat: -1, ease: E.hero })
}

/** One `raybeam` blade, pivoting at its top (the light source). */
function blade(
  scene: Phaser.Scene,
  x: number,
  angle: number,
  scaleX: number,
  scaleY: number,
  tint: number,
  alpha: number
): Phaser.GameObjects.Image {
  return scene.add
    .image(x, 0, 'raybeam')
    .setOrigin(0.5, 0)
    .setAngle(angle)
    .setScale(scaleX, scaleY)
    .setTint(tint)
    .setAlpha(alpha)
    .setBlendMode(Phaser.BlendModes.ADD)
}

// --- layer helpers (§3b) ----------------------------------------------------

/** L1 (−60, NORMAL): the flat warm wash. Static — never tweened. */
function washBase(scene: Phaser.Scene): void {
  const T = getTheme()
  const OFF = contentOffsetY()
  const wash = scene.add.graphics().setDepth(Z.wash)
  wash.fillGradientStyle(T.washTop, T.washTop, T.washBottom, T.washBottom, 1)
  // Fill the full letterbox-free visible world (design box + reclaimed top/bottom margins), so the
  // margins read as warm wash instead of cream void. Height is the WHOLE world (not DESIGN_H + 2·OFF —
  // the box is anchored, not centred, so the margins are asymmetric). `WASH_BLEED` then carries the
  // fill past all FOUR visible edges: it absorbs live-resize growth vertically, and horizontally it is
  // the reason a screen-shake cannot tear a strip of the clear colour off the side (see the constant).
  wash.fillRect(-WASH_BLEED, -OFF - WASH_BLEED, DESIGN_W + WASH_BLEED * 2, worldH() + WASH_BLEED * 2)
}

/**
 * L2 (−56, ADD): breathing aurora glows. Game keeps them small + in the margins. The glows live in
 * one container at Z.aurora so the idle throttle (A2) can DIM them via the container's alpha without
 * fighting the per-glow breathe tweens; returns that loop (or `undefined` when nothing animates).
 */
function aurora(scene: Phaser.Scene, variant: BackdropVariant): AmbientLoop | undefined {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const low = quality.tier() === 'low'
  const animate = !reduced && !low
  const container = scene.add.container(0, 0).setDepth(Z.aurora)
  const tweens: Phaser.Tweens.Tween[] = []
  const glow = (x: number, y: number, w: number, h: number, tint: number, a: number, lo: number, hi: number, delay = 0): void => {
    const g = addGlow(scene, x, y, w, h, tint, a, Z.aurora)
    container.add(g)
    const tw = breatheAlpha(scene, g, lo, hi, T_AURORA, animate, delay)
    if (tw) tweens.push(tw)
  }

  if (variant === 'game') {
    // Two small (<400px) margin glows: one above the board, one below. Both are
    // clamped so their bright cores never leave the top / bottom margins.
    glow(210, 132, 320, 320, T.washGlowWarm, 0.1, 0.08, 0.1)
    glow(512, 1150, 320, 320, T.washGlowCool, 0.09, 0.07, 0.09, T_AURORA * 0.5)
  } else {
    // home / menu: two full warm+cool auroras drifting in the upper + lower thirds.
    glow(220, 420, 560, 560, T.washGlowWarm, 0.11, 0.08, 0.11)
    // On the low tier we keep only the single warm aurora.
    if (!low) glow(520, 860, 540, 540, T.washGlowCool, 0.1, 0.07, 0.1, T_AURORA * 0.5)
  }

  return animate ? { container, tweens } : undefined
}

/**
 * L7 (−54, ADD): warm board light-bleed (game only). Sits UNDER the opaque tray +
 * GameScene's existing rose cabinetGlow — only its edges escape the bezel as a gold
 * halo ("the machine is powered on"). Together they read as a two-tone bleed.
 */
function boardBleed(scene: Phaser.Scene, variant: BackdropVariant): void {
  if (variant !== 'game') return
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const bleed = addGlow(scene, BOARD_MID_X, BOARD_MID_Y, BOARD_W + 90, BOARD_W + 90, T.bleedWarm, 0.08, Z.bleed)
  breatheAlpha(scene, bleed, 0.06, 0.1, T_BLEED, !reduced)
}

/**
 * L3 (−52 hotspot/pool, −50 blades, ADD): the top spotlight. A warm hotspot at the
 * source, fanned `raybeam` cone blades, and a floor pool. Game gets a faint hotspot
 * + a single blade clamped to y ≤ 260 (above the board), no pool.
 */
function spotlight(scene: Phaser.Scene, variant: BackdropVariant): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const low = quality.tier() === 'low'
  const animate = !reduced && !low

  const cfg =
    variant === 'home'
      ? { sy: 40, hot: 600, hotA: 0.16, poolA: 0.05, blades: 2, bladeA: 0.08, bladeSY: 1, swayDeg: 3 }
      : variant === 'menu'
        ? { sy: 34, hot: 550, hotA: 0.13, poolA: 0.05, blades: 2, bladeA: 0.08, bladeSY: 1, swayDeg: 3 }
        : { sy: 24, hot: 360, hotA: 0.08, poolA: 0, blades: 1, bladeA: 0.07, bladeSY: 0.34, swayDeg: 1.5 }

  // Hotspot — the bright spotlight source, clamped into the top margin.
  const hot = addGlow(scene, BOARD_MID_X, cfg.sy + 40, cfg.hot, cfg.hot * 0.9, T.washGlowWarm, cfg.hotA, Z.spotHot)
  breatheAlpha(scene, hot, cfg.hotA * 0.72, cfg.hotA, T_HOT, animate)

  // Floor pool — a wide, low warm wash at the very bottom (home / menu only).
  if (cfg.poolA > 0 && !low) {
    addGlow(scene, BOARD_MID_X, DESIGN_H - 70, 720, 300, T.washGlowWarm, cfg.poolA, Z.spotHot)
  }

  // Cone blades — a rig at the source so the whole cone sways with ONE tween.
  if (!low) {
    const rig = scene.add.container(BOARD_MID_X, cfg.sy).setDepth(Z.spotBlade)
    if (cfg.blades === 1) {
      rig.add(blade(scene, 0, 0, 1.1, cfg.bladeSY, T.rayTint, cfg.bladeA))
    } else {
      rig.add(blade(scene, 0, -13, 1, cfg.bladeSY, T.rayTint, cfg.bladeA))
      rig.add(blade(scene, 0, 13, 1, cfg.bladeSY, T.rayTint, cfg.bladeA))
    }
    sway(scene, rig, cfg.swayDeg, T_SWAY, animate)
  }
}

/**
 * L4 (−50, ADD): drifting god-rays — the big diagonal light shafts. Two crossed on
 * home (gold + rose), one on menu, NONE on game (the cabinet bulbs already carry the
 * game's motion; keeps the HUD uncluttered — §7 open decision #5).
 */
function godRays(scene: Phaser.Scene, variant: BackdropVariant): void {
  if (variant === 'game') return
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const low = quality.tier() === 'low'
  if (low) return // rays are the first thing dropped on weak hardware
  const animate = !reduced

  const rig = scene.add.container(BOARD_MID_X, -60).setDepth(Z.godray)
  rig.add(blade(scene, -170, 20, 1.1, 1.4, T.rayTint, 0.09))
  if (variant === 'home') {
    rig.add(blade(scene, 175, -20, 0.95, 1.3, T.rayTintCool, 0.06))
  }
  sway(scene, rig, 2.5, T_SWAY * 1.15, animate)
}

/**
 * L5 (−48 mid / −46 corner, ADD): blurred bokeh. Corner bokeh live in the corners
 * (margin-confined); mid-field bokeh (home / menu only) add depth in the side gutters.
 * Each tier shares ONE twinkle tween.
 */
function bokeh(scene: Phaser.Scene, variant: BackdropVariant): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const low = quality.tier() === 'low'
  const animate = !reduced && !low

  const cornerScale = variant === 'game' ? 218 : 300
  const cornerA = variant === 'game' ? 0.09 : 0.1
  const corners: Array<[number, number, number]> = [
    [-30, 170, T.bokehWarm],
    [DESIGN_W + 20, 320, T.bokehCool],
    [50, DESIGN_H - 150, T.bokehCool],
    [DESIGN_W - 40, DESIGN_H - 250, T.bokehWarm],
  ]
  // On low, keep just the two warm corners.
  const cornerSet = low ? [corners[0], corners[3]] : corners
  const cornerImgs = cornerSet.map(([x, y, tint]) =>
    addGlow(scene, x, y, cornerScale, cornerScale, tint, cornerA, Z.bokehCorner)
  )
  if (animate && cornerImgs.length) {
    scene.tweens.add({
      targets: cornerImgs,
      alpha: cornerA + 0.03,
      duration: T_TWINKLE,
      yoyo: true,
      repeat: -1,
      ease: E.hero,
    })
  }

  if (variant === 'game' || low) return

  // Mid-field bokeh in the side gutters (home 3, menu 1).
  const mids: Array<[number, number, number]> =
    variant === 'home'
      ? [
          [60, 640, T.bokehWarm],
          [664, 560, T.bokehCool],
          [360, DESIGN_H - 120, T.bokehWarm],
        ]
      : [[664, 600, T.bokehCool]]
  const midImgs = mids.map(([x, y, tint]) => addGlow(scene, x, y, 260, 260, tint, 0.08, Z.bokehMid))
  if (animate) {
    scene.tweens.add({
      targets: midImgs,
      alpha: 0.11,
      duration: T_TWINKLE * 1.2,
      delay: T_TWINKLE * 0.4,
      yoyo: true,
      repeat: -1,
      ease: E.hero,
    })
  }
}

/** L9 (−44, NORMAL): faint card-suit watermarks in the margins. Static dressing. */
function suits(scene: Phaser.Scene, variant: BackdropVariant): void {
  const T = getTheme()
  const color = css(T.suitWatermark)
  const specs: SuitSpec[] =
    variant === 'game'
      ? [...SUITS_TOP, ...SUITS_BOTTOM]
      : variant === 'menu'
        ? [...SUITS_TOP, ...SUITS_BOTTOM, ...SUITS_MID.slice(0, 2)]
        : [...SUITS_TOP, ...SUITS_BOTTOM, ...SUITS_MID]
  for (const [glyph, x, y, size, angle, alpha] of specs) {
    scene.add
      .text(x, y, glyph, { fontFamily: 'Arial, sans-serif', fontSize: `${size}px`, color })
      .setOrigin(0.5)
      .setAngle(angle)
      .setAlpha(alpha)
      .setDepth(Z.suits)
  }
}

/**
 * L9 (−42, ADD): drifting sparkle dust. Menus + home only (never over the board),
 * capped + scaled by the quality governor, and dropped entirely under reduced motion
 * or on the low tier (it is a "falling particle").
 */
function sparkle(scene: Phaser.Scene, variant: BackdropVariant): void {
  if (variant === 'game') return
  if (prefersReducedMotion() || quality.tier() === 'low') return
  const T = getTheme()

  const base = variant === 'home' ? 8 : 6
  const n = Math.max(3, quality.count(base))
  const spots: Array<[number, number]> = [
    [90, 420],
    [640, 380],
    [180, 760],
    [560, 700],
    [340, 980],
    [80, 1000],
    [660, 950],
    [420, 300],
  ]
  for (let i = 0; i < n; i++) {
    const [x, y] = spots[i % spots.length]
    const scale = 0.5 + (i % 3) * 0.2
    const mote = scene.add
      .image(x, y, 'bgdot')
      .setTint(T.sparkleTint)
      .setAlpha(0.35)
      .setScale(scale)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.sparkle)
    scene.tweens.add({
      targets: mote,
      y: y + 78,
      alpha: 0.1,
      duration: T_DRIFT + i * 420,
      delay: i * 300,
      yoyo: true,
      repeat: -1,
      ease: E.hero,
    })
  }
}

/**
 * L6 (−34, NORMAL): the warm vignette — four edge fade bands whose overlap darkens
 * corners more than sides, in warm `vignetteInk` (NEVER black). Sits above the light
 * stack (contains the glow) but below the marquee + gameplay. Drawn as tinted images
 * of the baked `bgband` strip, NOT fillGradientStyle — WebGL gradient fills leave a
 * broken alpha channel on the now-transparent canvas (see ensureBandTexture).
 */
function vignette(scene: Phaser.Scene): void {
  const T = getTheme()
  const ink = T.vignetteInk
  const W = DESIGN_W
  // Anchor the vignette to the VISIBLE world edges (design box + reclaimed margins), so the inward
  // focus still lands at the true screen edges on flexible-height screens.
  const OFF = contentOffsetY()
  const VT = -OFF // top visible edge
  const VH = worldH() // full visible height (asymmetric margins → NOT DESIGN_H + 2·OFF)
  const Vt = 0.1
  const Vb = 0.16
  const Vs = 0.12
  const bandT = 340
  const bandB = 380
  const bandS = 200
  const band = (x: number, y: number, w: number, h: number, alpha: number, angle: number): void => {
    // displaySize is pre-rotation: the texture's fade axis (its height) must span the band's
    // fade extent, so the side bands swap w/h and rotate into place.
    scene.add.image(x, y, 'bgband').setDisplaySize(w, h).setAngle(angle).setTint(ink).setAlpha(alpha).setDepth(Z.vignette)
  }
  band(W / 2, VT + bandT / 2, W, bandT, Vt, 0) // top (fades down)
  band(W / 2, VT + VH - bandB / 2, W, bandB, Vb, 180) // bottom (fades up)
  band(bandS / 2, VT + VH / 2, VH, bandS, Vs, -90) // left (fades right)
  band(W - bandS / 2, VT + VH / 2, VH, bandS, Vs, 90) // right (fades left)
}

/**
 * L8 (−30, NORMAL): the chasing marquee. A travelling brightness wave along the edges,
 * driven by ONE proxy tween (not one-per-dot). Home lights all four edges; menu + game
 * light the top + bottom only. Reduced-motion / low tier → flat mid-alpha, no chase.
 *
 * The dots live in one container at Z.marquee so the idle throttle (A2) can DIM the whole
 * chase via the container's alpha; returns that loop (or `undefined` in the flat state).
 */
function marquee(scene: Phaser.Scene, variant: BackdropVariant): AmbientLoop | undefined {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const flat = reduced || quality.tier() === 'low'

  const container = scene.add.container(0, 0).setDepth(Z.marquee)
  const dots: Phaser.GameObjects.Image[] = []
  const line = (from: number, to: number, fixed: number, horizontal: boolean, count: number): void => {
    for (let i = 0; i < count; i++) {
      const t = from + (i * (to - from)) / (count - 1)
      const x = horizontal ? t : fixed
      const y = horizontal ? fixed : t
      const dot = scene.add.image(x, y, 'bgdot').setTint(T.marqueeBright).setAlpha(0.32)
      container.add(dot)
      dots.push(dot)
    }
  }
  // Run the marquee along the VISIBLE world edges so the chasing frame reaches the true screen edges.
  const OFF = contentOffsetY()
  const VT = -OFF // top visible edge
  const VB = worldH() - OFF // bottom visible edge (asymmetric margins → NOT DESIGN_H + OFF)
  line(24, DESIGN_W - 24, VT + 26, true, 15)
  line(24, DESIGN_W - 24, VB - 26, true, 15)
  if (variant === 'home') {
    line(VT + 120, VB - 120, 26, false, 11)
    line(VT + 120, VB - 120, DESIGN_W - 26, false, 11)
  }

  if (flat) {
    dots.forEach(d => d.setAlpha(0.42))
    return undefined
  }
  const proxy = { p: 0 }
  const tw = scene.tweens.add({
    targets: proxy,
    p: 1,
    duration: T_MARQUEE,
    repeat: -1,
    ease: 'Linear',
    onUpdate: () => {
      const ph = proxy.p * Math.PI * 2
      for (let i = 0; i < dots.length; i++) {
        dots[i].setAlpha(0.26 + 0.22 * (0.5 + 0.5 * Math.sin(ph + i * 0.6)))
      }
    },
  })
  return { container, tweens: [tw] }
}

// --- Idle ambient throttle + per-theme flourish (A1 / A2) -------------------

/** An ambient breathing loop the idle throttle can calm: a container to DIM (its alpha
 *  multiplies the children) plus the tween(s) to SLOW (their `timeScale`). */
interface AmbientLoop {
  container: Phaser.GameObjects.Container
  tweens: Phaser.Tweens.Tween[]
}

const IDLE_TIMESCALE = 0.6 // slow the breathing a notch once the app is left open
const IDLE_DIM = 0.7 // and pull the ambient alpha down a notch — battery on a left-open PWA

/**
 * A2 — consume `quality.idle()` (flips true after IDLE_MS of no input, quality.ts). Once the app is
 * left open, ease the two heaviest ambient loops (aurora glows + the marquee chase) to a calmer,
 * dimmer profile, and restore the instant input resumes (`quality.noteActivity()` clears idle). It
 * polls on a light 400ms timer rather than every frame — idle flips are coarse (6s) and the timer
 * sleeps with the game loop on tab-blur. No-op when nothing animates: reduced motion / low tier are
 * already static, so `loops` arrives empty and we never even arm the timer.
 */
function installIdleThrottle(scene: Phaser.Scene, loops: AmbientLoop[]): void {
  if (!loops.length) return
  let idle = quality.idle()
  const apply = (on: boolean): void => {
    for (const loop of loops) {
      scene.tweens.killTweensOf(loop.container) // only the dim tween ever targets the container
      scene.tweens.add({ targets: loop.container, alpha: on ? IDLE_DIM : 1, duration: D.breath, ease: E.hero })
      for (const tw of loop.tweens) tw.timeScale = on ? IDLE_TIMESCALE : 1
    }
  }
  if (idle) apply(true) // honour an already-idle governor at create() (unlikely, but correct)
  scene.time.addEvent({
    delay: 400,
    loop: true,
    callback: () => {
      const now = quality.idle()
      if (now === idle) return
      idle = now
      apply(now)
    },
  })
}

/**
 * A1 — one tasteful, theme-specific ambient accent so the themes read as different ROOMS (not
 * just recolours) in the MARGINS beyond colour. Strictly additive and guaranteed off the board:
 * negative depth (Z.flourish), ≤ 0.20 α, ADD blend, and confined to the top / bottom margins so it
 * never crosses the 40–680 × 300–940 board rect. Count is capped by `quality.count()` (and to one on
 * the budget-tight game variant); the whole layer drops under reduced motion / low tier — the accent
 * IS motion, and colour already differs everywhere else. Reuses baked `bgdot` / `bgglow`, theme
 * tokens only:
 *   • Neon Vegas    → faint cyan sign-bulbs buzzing (one proxy tween, layered-sine flicker, not a strobe)
 *   • Rose Midnight → 1–2 slow warm "stars" drifting on the velvet dark
 *   • Golden Hour   → a single warm dust mote loafing low in the floor light
 *   • Maya's Heart  → a pair of soft rose motes drifting aloft
 *   • Rune Realm    → wall torches guttering in the top margin (one proxy tween, layered-sine flame)
 */
function themeFlourish(scene: Phaser.Scene, variant: BackdropVariant): void {
  if (prefersReducedMotion() || quality.tier() === 'low') return
  // An Act II floor brings its own accent and takes the theme's place for the duration — the floor
  // owns the ROOM (floormood.ts). It arrives INSIDE the a11y/tier gates above, so a floor can never
  // reintroduce motion a player switched off, and it inherits the same margin + depth + alpha law.
  const floorAccent = activeFloorMood()?.flourish
  if (floorAccent) {
    floorFlourish(scene, floorAccent)
    return
  }
  const T = getTheme()
  // Governor-capped count, clamped to ONE on the budget-tight game variant.
  const pick = (len: number): number =>
    Math.min(variant === 'game' ? 1 : len, Math.max(1, quality.count(len)))

  // Shared slow drift (star / mote): move + alpha yoyo, ADD, negative depth, margin-placed.
  const drift = (
    x: number,
    y: number,
    scale: number,
    tex: string,
    tint: number,
    loA: number,
    hiA: number,
    dur: number,
    dx: number,
    dy: number,
    delay = 0
  ): void => {
    const m = scene.add
      .image(x, y, tex)
      .setTint(tint)
      .setAlpha(loA)
      .setScale(scale)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.flourish)
    scene.tweens.add({ targets: m, x: x + dx, y: y + dy, alpha: hiA, duration: dur, delay, yoyo: true, repeat: -1, ease: E.hero })
  }

  switch (getThemeId()) {
    case 'neonVegas': {
      // Faint cyan sign-bulbs in the top margin; a single proxy tween drives an irregular
      // (layered-sine) flicker so it reads neon, never a strobe (α ≤ 0.18).
      const spots: Array<[number, number]> = [
        [64, 150],
        [656, 196],
      ]
      const bulbs = spots.slice(0, pick(spots.length)).map(([x, y]) =>
        scene.add
          .image(x, y, 'bgglow')
          .setDisplaySize(150, 150)
          .setTint(T.accentAlt)
          .setAlpha(0.1)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(Z.flourish)
      )
      const proxy = { p: 0 }
      scene.tweens.add({
        targets: proxy,
        p: 1,
        duration: T_FLICKER,
        repeat: -1,
        ease: 'Linear',
        onUpdate: () => {
          const t = proxy.p * Math.PI * 2
          for (let i = 0; i < bulbs.length; i++) {
            const buzz = 0.5 + 0.32 * Math.sin(t * 3 + i * 2.1) + 0.18 * Math.sin(t * 7.3 + i)
            bulbs[i].setAlpha(0.05 + 0.13 * Phaser.Math.Clamp(buzz, 0, 1))
          }
        },
      })
      break
    }
    case 'roseMidnight': {
      // 1–2 slow warm stars drifting on the velvet dark (bright-cored bgdot = pinpoint).
      const spots: Array<[number, number]> = [
        [112, 170],
        [604, 214],
      ]
      spots
        .slice(0, pick(spots.length))
        .forEach(([x, y], i) => drift(x, y, 0.62, 'bgdot', T.sparkleTint, 0.1, 0.18, T_DRIFT * 1.3, 14, 52, i * T_DRIFT * 0.5))
      break
    }
    case 'mayaHeart': {
      // A pair of tender rose motes drifting aloft in the top margin.
      const spots: Array<[number, number]> = [
        [150, 190],
        [572, 150],
      ]
      spots
        .slice(0, pick(spots.length))
        .forEach(([x, y], i) => drift(x, y, 0.8, 'bgglow', T.moteTint, 0.07, 0.14, T_DRIFT * 1.15, -20, 36, i * T_DRIFT * 0.4))
      break
    }
    case 'runescape': {
      // Wall torches guttering in the top margin — this room's own light source, which is the whole
      // reason its accent is FIRE rather than another drifting mote. Each torch is two layers (a
      // wide pool + a small hot core) driven by ONE proxy tween, the neonVegas pattern: a flame is
      // one thing breathing, not two motes that happen to overlap. The rates are deliberately
      // incommensurate (2.3 / 5.9) and offset per torch, so neither torch lands on a beat and the
      // pair never gutter together — an even pulse reads as a strobe, which is exactly what this
      // layer's ≤0.20 α / ADD / margins law exists to keep out.
      // Seated so the POOL's own box (230×200) still clears the 300px board rect with room to
      // spare — same air the neonVegas bulbs leave, and the reason this layer can promise it never
      // crosses the board.
      const spots: Array<[number, number]> = [
        [72, 156],
        [648, 176],
      ]
      const torches = spots.slice(0, pick(spots.length)).map(([x, y]) => {
        const pool = scene.add
          .image(x, y, 'bgglow')
          .setDisplaySize(230, 200)
          .setTint(T.washGlowWarm)
          .setAlpha(0.1)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(Z.flourish)
        const core = scene.add
          .image(x, y - 8, 'bgdot')
          .setDisplaySize(30, 46)
          .setTint(T.sparkleTint)
          .setAlpha(0.14)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(Z.flourish)
        // setDisplaySize IS a setScale, so the flame's stretch has to ride the baked scale rather
        // than replace it — a bare setScale here would snap the core back to its 16px texture size.
        return { pool, core, coreScaleY: core.scaleY }
      })
      const proxy = { p: 0 }
      scene.tweens.add({
        targets: proxy,
        p: 1,
        duration: T_FLICKER * 1.6,
        repeat: -1,
        ease: 'Linear',
        onUpdate: () => {
          const t = proxy.p * Math.PI * 2
          for (let i = 0; i < torches.length; i++) {
            const flame = 0.5 + 0.3 * Math.sin(t * 2.3 + i * 1.7) + 0.2 * Math.sin(t * 5.9 + i * 3.1)
            const a = Phaser.Math.Clamp(flame, 0, 1)
            torches[i].pool.setAlpha(0.06 + 0.1 * a)
            torches[i].core.setAlpha(0.09 + 0.09 * a)
            torches[i].core.scaleY = torches[i].coreScaleY * (0.9 + 0.2 * a)
          }
        },
      })
      break
    }
    default: {
      // Golden Hour — a single warm dust mote loafing low in the floor light (bottom margin).
      drift(120, 1054, 0.9, 'bgglow', T.moteTint, 0.06, 0.12, T_DRIFT * 1.4, 26, -34)
    }
  }
}

/**
 * An Act II FLOOR's margin accent, standing in for the theme's while the player is on that floor.
 *
 * Same law as `themeFlourish`, inherited by construction (it is only ever called from inside it):
 * `Z.flourish`, ADD blend, α ≤ 0.20, margins only, and already past the reduced-motion / low-tier
 * gate. The one thing it deliberately does NOT inherit is the theme's colour — a floor's whole job is
 * to look like a different room, and the accent is light, which is the half of the picture a mood is
 * allowed to own.
 *
 * Both accents are driven by ONE proxy tween each, the `neonVegas` pattern, rather than a tween per
 * sprite: a lamp is one object with two layers (pool + filament), not two ambient motes.
 */
function floorFlourish(scene: Phaser.Scene, kind: FloorFlourish): void {
  if (kind === 'tableLamp') {
    // FLOOR 1 — a brass banker's lamp burning in the bottom-left CORNER: the side table just out of
    // frame. The pool is wide and dim, the filament small and warm, and the whole thing breathes on
    // a very slow cycle so it reads as a filament settling rather than as a pulse.
    //
    // Cornered on purpose. Additive light needs somewhere dark to land, and the middle of the bottom
    // margin on the default (cream) theme is the brightest ground on the screen — the first placement
    // sat there and the lamp was invisible at any alpha this layer is allowed to use (browser, level
    // 301). The vignette (Z.vignette, one layer in FRONT of this one) darkens the corners, so the
    // corner is the one part of the margin where a legal alpha still reads.
    const x = 74
    const y = 1152
    const pool = scene.add
      .image(x, y, 'bgglow')
      .setDisplaySize(340, 250)
      .setTint(0xffa733)
      .setAlpha(0.12)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.flourish)
    const filament = scene.add
      .image(x + 14, y - 40, 'bgdot')
      .setDisplaySize(58, 58)
      .setTint(0xffdca0)
      .setAlpha(0.18)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.flourish)
    const proxy = { p: 0 }
    scene.tweens.add({
      targets: proxy,
      p: 1,
      duration: T_DRIFT * 1.8,
      repeat: -1,
      ease: 'Linear',
      onUpdate: () => {
        // Two sines an octave apart — a lamp on a mains supply never breathes on one clean period.
        const t = proxy.p * Math.PI * 2
        const w = 0.5 + 0.36 * Math.sin(t) + 0.14 * Math.sin(t * 2.3)
        const k = Phaser.Math.Clamp(w, 0, 1)
        pool.setAlpha(0.08 + 0.07 * k)
        filament.setAlpha(0.13 + 0.07 * k)
      },
    })
  }

  if (kind === 'securityBeam') {
    // FLOOR 3 — the vault's one moving light: a cold beam sweeping the bottom margin, the way a
    // camera-mounted floodlight rakes a wall. ONE pool translating on a slow sine — no rotation,
    // because a rotating shaft long enough to read would have to cross the board, and this layer's
    // law is margins only.
    //
    // Brightest at the ENDS of its travel, dimmest mid-sweep — deliberately backwards from a naive
    // spotlight. The vignette darkens the corners, so the corners are where a legal alpha still
    // reads (the tableLamp lesson, one floor up); and a beam that flares as it rakes into the
    // corner then slides off reads as SWEEPING PAST rather than as a blob commuting.
    const y = 1126
    const midX = 360
    const ampX = 230
    const pool = scene.add
      .image(midX, y, 'bgglow')
      .setDisplaySize(250, 120)
      .setTint(0x8fb4dc)
      .setAlpha(0.06)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.flourish)
    const proxy = { p: 0 }
    scene.tweens.add({
      targets: proxy,
      p: 1,
      duration: T_DRIFT * 1.6,
      repeat: -1,
      ease: 'Linear',
      onUpdate: () => {
        const t = proxy.p * Math.PI * 2
        pool.setX(midX + ampX * Math.sin(t))
        // cos(2t) peaks exactly at the sweep's two ends (t = π/2, 3π/2), bottoms mid-travel.
        const k = 0.5 - 0.5 * Math.cos(2 * t)
        pool.setAlpha(0.045 + 0.085 * k)
      },
    })
  }

  if (kind === 'lampPools') {
    // FLOOR 4 — two green-shaded lamps just out of frame, pooling on the bottom margin: amber where
    // the light lands, a sliver of green where the shade glows through. The green is confined to
    // that sliver on purpose — the mood's whole colour story is warm light from green fixtures, and
    // a green POOL would read as felt, which is a hazard's word on this board.
    //
    // One proxy tween breathes both lamps out of phase (a card room's lamps share a supply, not a
    // filament) — the tableLamp's two-sine settle, twice, offset.
    const lamps = [
      { x: 92, y: 1146 },
      { x: 628, y: 1146 },
    ].map(({ x, y }) => {
      const pool = scene.add
        .image(x, y, 'bgglow')
        .setDisplaySize(250, 175)
        .setTint(0xffb648)
        .setAlpha(0.1)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(Z.flourish)
      // The shade's rim: a squashed glow, green, sitting where the pool's ceiling would be.
      const rim = scene.add
        .image(x, y - 82, 'bgglow')
        .setDisplaySize(96, 30)
        .setTint(0x2f9b78)
        .setAlpha(0.1)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(Z.flourish)
      return { pool, rim }
    })
    const proxy = { p: 0 }
    scene.tweens.add({
      targets: proxy,
      p: 1,
      duration: T_DRIFT * 1.7,
      repeat: -1,
      ease: 'Linear',
      onUpdate: () => {
        const t = proxy.p * Math.PI * 2
        lamps.forEach(({ pool, rim }, i) => {
          const w = 0.5 + 0.36 * Math.sin(t + i * 2.6) + 0.14 * Math.sin(t * 2.3 + i)
          const k = Phaser.Math.Clamp(w, 0, 1)
          pool.setAlpha(0.07 + 0.06 * k)
          rim.setAlpha(0.07 + 0.05 * k)
        })
      },
    })
  }

  if (kind === 'filamentBulb') {
    // FLOOR 2 — a bare bulb on a cord in the top margin, swinging just enough to notice. The cord is
    // a baked rectangle ROTATED about its top end, so the whole pendulum is transform-only and this
    // file's no-per-frame-graphics-redraw rule holds; the bulb is positioned from the same angle, so
    // it stays on the end of its own cord rather than drifting off it.
    const px = 604 // pivot, in the top-right margin — clear of the score row's own furniture
    const py = 26
    const len = 132
    const cord = scene.add
      .rectangle(px, py, 2, len, 0xffcf8a, 0.16)
      .setOrigin(0.5, 0)
      .setDepth(Z.flourish)
    const halo = scene.add
      .image(px, py + len, 'bgglow')
      .setDisplaySize(190, 190)
      .setTint(0xffa733)
      .setAlpha(0.11)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.flourish)
    const bulb = scene.add
      .image(px, py + len, 'bgdot')
      .setDisplaySize(44, 44)
      .setTint(0xffe6b8)
      .setAlpha(0.2)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(Z.flourish)
    const proxy = { p: 0 }
    scene.tweens.add({
      targets: proxy,
      p: 1,
      duration: T_DRIFT * 1.1,
      repeat: -1,
      ease: 'Linear',
      onUpdate: () => {
        const t = proxy.p * Math.PI * 2
        const a = 0.075 * Math.sin(t) // ~4.3° either side — a draught, not a shove
        cord.setRotation(a)
        const bx = px + Math.sin(a) * len
        const by = py + Math.cos(a) * len
        halo.setPosition(bx, by)
        bulb.setPosition(bx, by)
        // The filament dips as the bulb swings out, the way a real one browns at the ends of a sag.
        const glow = 0.5 + 0.5 * Math.cos(t * 2)
        halo.setAlpha(0.08 + 0.06 * glow)
        bulb.setAlpha(0.15 + 0.07 * glow)
      },
    })
  }
}

// --- Proscenium frame (E15) -------------------------------------------------

/** Points tracing a small heart (cusp up, tip down), centred on (cx,cy); `r` ≈ half-width. */
function heartPolygon(cx: number, cy: number, r: number): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = []
  const steps = 40
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI * 2 * i) / steps
    const hx = 16 * Math.pow(Math.sin(t), 3)
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    pts.push(new Phaser.Geom.Point(cx + (hx / 16) * r, cy - (hy / 16) * r))
  }
  return pts
}

/** A shallow molding arc (parabola peaking at centre), sampled as points for `strokePoints`. */
function crownArc(cx: number, halfW: number, apexY: number, drop: number): Phaser.Geom.Point[] {
  const pts: Phaser.Geom.Point[] = []
  const N = 40
  for (let i = 0; i <= N; i++) {
    const u = i / N
    const k = (u - 0.5) * 2 // −1..1
    pts.push(new Phaser.Geom.Point(cx - halfW + 2 * halfW * u, apexY + drop * k * k))
  }
  return pts
}

/**
 * The PROSCENIUM (§E15) — a slim shared arched crown with the heart as KEYSTONE across the top
 * margin, plus a matched console lip at the bottom, drawn at IDENTICAL coords on every scene so all
 * four read as one machine. Baked once, margin-confined, negative depth (frontmost backdrop layer,
 * still behind all gameplay/HUD at depth ≥ 0), and fully STATIC — a frame, never a motion beat, so
 * reduced-motion needs no special path. Warm gold on all four themes (gold/bezel tokens), zero new
 * textures (graphics + the shared `bgglow`).
 *
 * RESTRAINT is the priority: a whisper of molding + a small heart keystone, kept to the extreme
 * top/bottom edges. The crown lives ABOVE the LEVEL pill / score row (y ≤ 50) and the console lip at
 * the very bottom (y ≈ 1250), so it never crowds the HUD and never touches the 40–680×300–940 board.
 */
export function addProscenium(scene: Phaser.Scene): void {
  const T = getTheme()
  const cx = DESIGN_W / 2
  const halfW = 176
  // Frame the VISIBLE world edges: lift the crown into the reclaimed top margin and drop the console
  // lip into the reclaimed bottom margin, so the shared molding reaches the true screen edges.
  const OFF = contentOffsetY()

  // A faint warm keystone glow first (behind the molding): the "powered-on" whisper, margin-confined.
  addGlow(scene, cx, 22 - OFF, 96, 78, T.bleedWarm, 0.09, Z.proscenium - 1)

  const g = scene.add.graphics().setDepth(Z.proscenium)

  // ---- Crown: a shallow double-reveal molding arc, confined to the top edge ----
  const apexY = 34 - OFF
  const drop = 15
  g.lineStyle(2.5, T.gold, 0.5)
  g.strokePoints(crownArc(cx, halfW, apexY, drop), false)
  g.lineStyle(1.5, T.goldBezel, 0.32)
  g.strokePoints(crownArc(cx, halfW, apexY + 5, drop), false)
  // Small drop-serifs capping each end of the crown.
  g.lineStyle(2.5, T.gold, 0.5)
  for (const ex of [cx - halfW, cx + halfW]) g.lineBetween(ex, apexY + drop, ex, apexY + drop + 9)

  // ---- Heart keystone at the apex — the shared signature ----
  const keyY = 17 - OFF
  const keyR = 15
  g.fillStyle(T.goldDeep, 0.35) // soft under-shadow for a hint of depth
  g.fillPoints(heartPolygon(cx, keyY + 2, keyR), true)
  g.fillStyle(T.gold, 0.82)
  g.fillPoints(heartPolygon(cx, keyY, keyR), true)
  g.lineStyle(1.5, T.goldBright, 0.7)
  g.strokePoints(heartPolygon(cx, keyY, keyR), true)

  // ---- Console lip: a thin matched molding mirroring the crown, at the very bottom edge ----
  const lipY = worldH() - OFF - 30 // 30 above the bottom visible edge (asymmetric → NOT 1250 + OFF)
  g.lineStyle(2.5, T.gold, 0.45)
  g.lineBetween(cx - halfW, lipY, cx + halfW, lipY)
  g.lineStyle(1.5, T.goldBezel, 0.28)
  g.lineBetween(cx - halfW + 10, lipY + 5, cx + halfW - 10, lipY + 5)
  g.lineStyle(2.5, T.gold, 0.45)
  for (const ex of [cx - halfW, cx + halfW]) g.lineBetween(ex, lipY, ex, lipY - 9)
}

/**
 * Compose the atmospheric backdrop for a scene. Layers are added back-to-front; each
 * helper reads the active theme + reduced-motion + quality tier itself and sets its
 * own explicit negative depth, so ordering here is for readability only.
 *
 * §3D-3 — when the three.js LIVING STAGE mounts for this scene (view3d/stage.ts —
 * an Extern draw hook at depth −59, just above the wash), the room provides every
 * faked volumetric (aurora, board bleed, spotlight, god-rays, bokeh, sparkle dust)
 * with REAL depth, so those layers are skipped here — painting them too would
 * double the light and hide the room. The wash STAYS on every path: it is the
 * opaque base under the room (first-frame cover, and the live fallback if the
 * stage ever dies mid-scene). The GRAPHIC identity stays 2D on every path too:
 * suit watermarks, the per-theme flourish, the vignette, the marquee chase and the
 * proscenium frame are drawn by Phaser regardless, so the brand reads identically
 * with or without the room. When the stage is unavailable (Save-Data, Canvas
 * renderer, context loss, LOW tier) this function paints byte-for-byte what it
 * always painted — the 2D stack IS the fallback.
 */
export function addCasinoBackdrop(scene: Phaser.Scene, variant: BackdropVariant): void {
  ensureTextures(scene)

  // The floor UNDER the floor, and the one layer a shake provably cannot move: the renderer fills the
  // camera's background over its viewport rect in SCREEN space, before the display list, untouched by
  // scroll, shake or zoom. The wash's bleed above is the real fix — it continues the gradient past the
  // edge, so a nudged camera shows more of the same room. This is what is left if some future layer
  // slips out from under one anyway, and it costs a fill nothing else was already paying for (the
  // wash covers the same pixels opaquely). Pointing it at the theme means the colour behind everything
  // finally agrees with the page chrome and `<meta theme-color>`, which have tracked the theme since
  // applyPageChrome landed, instead of being pinned to one theme's cream (main.ts `backgroundColor`).
  scene.cameras.main.setBackgroundColor(getTheme().washTop)

  washBase(scene)
  const room3d = setStageMood(scene, variant)

  let auroraLoop: AmbientLoop | undefined
  if (!room3d) {
    auroraLoop = aurora(scene, variant)
    boardBleed(scene, variant)
    spotlight(scene, variant)
    godRays(scene, variant)
    bokeh(scene, variant)
  }
  suits(scene, variant)
  if (!room3d) sparkle(scene, variant) // the room's GPU dust motes replace the 2D sparkle
  themeFlourish(scene, variant) // A1 — one theme-specific margin accent so themes read as different rooms
  vignette(scene)
  const marqueeLoop = marquee(scene, variant)
  addProscenium(scene) // §E15 — the shared frame, identical coords on every scene (frontmost backdrop)

  // A2 — throttle the heaviest ambient loops (aurora + marquee) while the PWA is left open (idle).
  // (The 3D room reads quality.idle() itself and dims/halves its own frame rate to match.)
  const loops: AmbientLoop[] = []
  if (auroraLoop) loops.push(auroraLoop)
  if (marqueeLoop) loops.push(marqueeLoop)
  installIdleThrottle(scene, loops)
}

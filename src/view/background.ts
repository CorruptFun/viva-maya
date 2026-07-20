import Phaser from 'phaser'
import { BOARD_W, BOARD_Y, contentOffsetY, DESIGN_H, DESIGN_W } from '../config'
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

function ensureTextures(scene: Phaser.Scene): void {
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
  // margins read as warm wash instead of cream void. Extra pad absorbs minor live-resize growth.
  wash.fillRect(0, -OFF - 60, DESIGN_W, DESIGN_H + 2 * OFF + 120)
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
 * L6 (−34, NORMAL): the warm vignette — four edge gradient bands (reliable per-corner
 * alpha via `fillGradientStyle` on `fillRect`) whose overlap darkens corners more than
 * sides. One static object in warm `vignetteInk` (NEVER black). Sits above the light
 * stack (contains the glow) but below the marquee + gameplay.
 */
function vignette(scene: Phaser.Scene): void {
  const T = getTheme()
  const ink = T.vignetteInk
  const g = scene.add.graphics().setDepth(Z.vignette)
  const W = DESIGN_W
  // Anchor the vignette to the VISIBLE world edges (design box + reclaimed margins), so the inward
  // focus still lands at the true screen edges on flexible-height screens.
  const OFF = contentOffsetY()
  const VT = -OFF
  const VH = DESIGN_H + 2 * OFF
  const Vt = 0.1
  const Vb = 0.16
  const Vs = 0.12
  const bandT = 340
  const bandB = 380
  const bandS = 200
  // top (fades down)
  g.fillGradientStyle(ink, ink, ink, ink, Vt, Vt, 0, 0)
  g.fillRect(0, VT, W, bandT)
  // bottom (fades up)
  g.fillGradientStyle(ink, ink, ink, ink, 0, 0, Vb, Vb)
  g.fillRect(0, VT + VH - bandB, W, bandB)
  // left (fades right)
  g.fillGradientStyle(ink, ink, ink, ink, Vs, 0, Vs, 0)
  g.fillRect(0, VT, bandS, VH)
  // right (fades left)
  g.fillGradientStyle(ink, ink, ink, ink, 0, Vs, 0, Vs)
  g.fillRect(W - bandS, VT, bandS, VH)
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
  const VT = -OFF
  const VB = DESIGN_H + OFF
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
 * A1 — one tasteful, theme-specific ambient accent so the four themes read as different ROOMS (not
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
 */
function themeFlourish(scene: Phaser.Scene, variant: BackdropVariant): void {
  if (prefersReducedMotion() || quality.tier() === 'low') return
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
    default: {
      // Golden Hour — a single warm dust mote loafing low in the floor light (bottom margin).
      drift(120, 1054, 0.9, 'bgglow', T.moteTint, 0.06, 0.12, T_DRIFT * 1.4, 26, -34)
    }
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
  const lipY = 1250 + OFF
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
 */
export function addCasinoBackdrop(scene: Phaser.Scene, variant: BackdropVariant): void {
  ensureTextures(scene)

  washBase(scene)
  const auroraLoop = aurora(scene, variant)
  boardBleed(scene, variant)
  spotlight(scene, variant)
  godRays(scene, variant)
  bokeh(scene, variant)
  suits(scene, variant)
  sparkle(scene, variant)
  themeFlourish(scene, variant) // A1 — one theme-specific margin accent so themes read as different rooms
  vignette(scene)
  const marqueeLoop = marquee(scene, variant)
  addProscenium(scene) // §E15 — the shared frame, identical coords on every scene (frontmost backdrop)

  // A2 — throttle the heaviest ambient loops (aurora + marquee) while the PWA is left open (idle).
  const loops: AmbientLoop[] = []
  if (auroraLoop) loops.push(auroraLoop)
  if (marqueeLoop) loops.push(marqueeLoop)
  installIdleThrottle(scene, loops)
}

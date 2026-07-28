/**
 * The LIVING STAGE (§3D-2) — a real three.js room rendered BEHIND the gameplay,
 * replacing the 2D backdrop's faked volumetrics with the things alpha-planes can
 * never fake: true volumetric spotlight cones with drifting haze, dust motes
 * floating in the light, a bokeh field with real depth separation, and a camera
 * that breathes and parallaxes — so the lounge reads as a PLACE the machine sits
 * in, not a wallpaper behind it.
 *
 * Architecture — ONE canvas, ONE WebGL context, shared with Phaser:
 *   The room does NOT live on a second DOM canvas behind a transparent game
 *   canvas. That layered approach was built first and rejected on evidence: with
 *   the game canvas transparent, every translucent Phaser draw that lands on
 *   unpainted canvas (vignette bands, glow leaks, watermark text…) picks up a
 *   corrupted alpha channel and the browser composites it into pale hard-edged
 *   ghosts. Instead, three.js renders INTO Phaser's own WebGL context through a
 *   `Phaser.GameObjects.Extern` hook placed at depth −59 in each scene — above
 *   the opaque 2D wash (−60, which doubles as first-frame cover and fallback),
 *   below every other layer. Phaser wraps the hook with `pipelines.clear()` /
 *   `pipelines.rebind()`, and three re-applies its own cached state via
 *   `resetState()`, so the two renderers interleave safely. One canvas means the
 *   browser composites exactly what it always composited — the whole class of
 *   cross-canvas alpha bugs is structurally impossible.
 *
 *   This is also why the pinned three version is 0.162: Phaser 3 creates a
 *   WebGL1 context, and r163+ dropped WebGL1. Everything here is era-stable
 *   tech (raw ShaderMaterials, Points, InstancedMesh) — nothing needs GL2.
 *
 * Division of labour (the seam that keeps this safe):
 *   - three.js owns the ROOM: sky wash, light volumes, atmosphere, depth.
 *   - Phaser owns the GAME and its graphic identity: board, HUD, vignette,
 *     suit watermarks, marquee, proscenium — drawn over the room on every path.
 *   - background.ts asks `setStageMood(scene, variant)` per scene create: TRUE →
 *     the 2D fake-light stack (aurora/spot/rays/bokeh/sparkle/bleed) is skipped
 *     and the room provides it with real depth; FALSE → the 2D stack paints
 *     byte-for-byte as before. The 2D stack IS the fallback, forever.
 *
 * Alignment: view3d/space.ts solves an axis-aligned perspective camera whose Z=0
 * plane coincides exactly with Phaser's world coordinates (unit-tested). With
 * the shared canvas the mapping input is simply the world box itself, so all
 * fixtures are placed in familiar world units with one extra Z (≤ 0 = deeper
 * into the room). No camera rotation ever → every quad is a free billboard and
 * the game plane can never shear.
 *
 * Discipline (inherits background.ts's guarantees):
 *  1. Board-safe: the room draws at depth −59; the opaque tray occludes it
 *     across the board rect mechanically. Exposed-margin intensities mirror the
 *     2D stack's alpha ceilings (game ≤ ~0.10 board-adjacent, ≤ 0.20 margins).
 *  2. Battery: the sim ticks off POST_STEP and the draw happens inside Phaser's
 *     render pass, so everything sleeps with the game loop when the tab hides;
 *     `quality.idle()` dims the room; reduced motion freezes the clock (a still,
 *     fully-lit room — no per-frame animation work); the LOW tier skips the room
 *     entirely and keeps the cheaper 2D stack.
 *  3. Fail-soft: Save-Data / no WebGL renderer / construction failure / context
 *     loss → `setStageMood` returns false and every scene paints the 2D path at
 *     its next create. Nothing here can take the game down with it.
 *
 * three.js is loaded via dynamic import (its own precached chunk — see
 * vite.config manualChunks), awaited in main.ts alongside the cloud bootstrap,
 * so by first scene create the decision (room vs 2D) is already made.
 */
import type Phaser from 'phaser'
import type * as THREE from 'three'
import { BOARD_W, DESIGN_W, restScrollY, worldH } from '../config'
import type { BackdropVariant } from '../view/background'
import { quality } from '../view/quality'
import { getTheme, getThemeId, prefersReducedMotion, reduceFlashing } from '../view/theme'
import { computeStageView, frustumHeightAt, frustumWidthAt, type StageView } from './space'

type ThreeNS = typeof import('three')

// --- Tuning ------------------------------------------------------------------
/** Extern depth: above the opaque 2D wash (−60), below every other backdrop layer. */
const STAGE_DEPTH = -59
/** Snappy gameplay-energy decay (ms to fall to 1/e). Matches the punch/settle feel. */
const ENERGY_TAU = 520
/** Slow celebratory swell decay — the warm afterglow of a flare. */
const FLARE_TAU = 1300
/** Idle dimming target + approach time (quality.idle() → left-open PWA calm). */
const IDLE_DIM = 0.72
const DIM_TAU = 900
/** Pointer parallax: max camera offset in world units (opposite the pointer). */
const PARALLAX_X = 8
const PARALLAX_Y = 5
const PARALLAX_TAU = 300
/** Camera breathing (always-on life): amplitude world px / period seconds. */
const BREATHE_AX = 3.6
const BREATHE_AY = 2.6
const BREATHE_TX = 8.4
const BREATHE_TY = 12.7

// --- Module state ------------------------------------------------------------
let T: ThreeNS | null = null
let renderer: THREE.WebGLRenderer | null = null
let scene3: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let game: Phaser.Game | null = null
/** three module loaded + renderer standing on Phaser's context. */
let active = false

/** What the current room was built for — rebuild when any of it changes. */
let builtSig = ''
let view: StageView | null = null
let variant: BackdropVariant = 'home'

/** Clock + reactive light state. */
let timeS = 0
let energy = 0 // snappy gameplay pulses (0..1)
let flare = 0 // slow celebratory swell (0..1)
let dim = 1 // idle dimmer (eases toward IDLE_DIM when idle)
let staticMode = false // reduced motion → frozen clock, no pulses
let parallaxTX = 0
let parallaxTY = 0
let parallaxX = 0
let parallaxY = 0

/** Live handles into the built room (per-frame JS updates + disposal). */
interface RoomPart {
  update?: (t: number) => void
  dispose: () => void
}
let parts: RoomPart[] = []
/** Uniforms shared by every material in the room (single source of truth). */
const shared = {
  uTime: { value: 0 },
  uEnergy: { value: 0 },
  uFlare: { value: 0 },
  uDim: { value: 1 },
}

// --- Colour helpers (bypass three's colour management on purpose) ------------
// Every material here is a raw ShaderMaterial: what we write is what lands in the
// framebuffer, exactly like Phaser's own sRGB maths — so the room and the game
// grade identically. Hence hex → vec3 by plain division, never THREE.Color.
function vec3(n: number): [number, number, number] {
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Relative luminance (cheap, sRGB-weighted) — picks the dark-room dressing. */
function lum(n: number): number {
  const [r, g, b] = vec3(n)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Deterministic tiny LCG so rebuilt rooms are stable per (theme, variant). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

// --- Shaders -----------------------------------------------------------------
// GLSL1-style on purpose (WebGL1 context — see the header). All additive
// materials output vec4(color, alpha) under SRC_ALPHA/ONE (three's
// AdditiveBlending), mirroring Phaser's ADD blend the 2D stack used. No explicit
// `precision` lines: three injects a matching header into BOTH stages (a
// self-declared mediump was observed failing program validation against three's
// highp vertex uniforms).

const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`

const SKY_FRAG = /* glsl */ `
varying vec2 vUv;
uniform vec3 uTop, uBottom, uGlow;
uniform float uGlowAmt, uFlare, uDim;
void main() {
  vec3 c = mix(uBottom, uTop, vUv.y);
  // Warm centre-light: the room's "powered on" radiance; swells softly on flares.
  float r = distance(vUv, vec2(0.5, 0.58));
  float boost = smoothstep(0.78, 0.0, r) * (uGlowAmt + uFlare * 0.10) * uDim;
  c += uGlow * boost;
  gl_FragColor = vec4(c, 1.0);
}`

const GLOW_VERT = SKY_VERT

const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
uniform vec3 uColor;
uniform float uAlpha, uPhase, uBreathe, uEnergyGain, uTime, uEnergy, uFlare, uDim;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float fall = pow(max(0.0, 1.0 - d), 2.3);
  float breathe = 1.0 + uBreathe * sin(uTime * 0.45 + uPhase);
  float a = uAlpha * fall * breathe * (1.0 + (uEnergy + uFlare * 0.6) * uEnergyGain) * uDim;
  gl_FragColor = vec4(uColor, a);
}`

const BEAM_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal, vView;
void main() {
  vUv = uv;
  vNormal = normalMatrix * normal;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`

const BEAM_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal, vView;
uniform vec3 uColor;
uniform float uAlpha, uTime, uEnergy, uFlare, uDim, uTailStart;
void main() {
  // Distance down the beam from the source (geometry puts the source at v=1).
  float axial = 1.0 - vUv.y;
  float tip = smoothstep(0.0, 0.16, axial);
  float tail = 1.0 - smoothstep(uTailStart, 1.0, axial);
  // Soft silhouette: brightest looking THROUGH the cone, feathering at the rim.
  float rim = pow(abs(dot(normalize(vNormal), normalize(vView))), 1.7);
  // Slow layered haze drifting down the shaft — the volumetric tell.
  float haze = 0.78
    + 0.16 * sin(axial * 9.0 - uTime * 0.55 + sin(axial * 23.0 - uTime * 1.07) * 0.8)
    + 0.06 * sin(axial * 41.0 - uTime * 1.9);
  float a = uAlpha * tip * tail * rim * haze * (1.0 + uEnergy * 0.9 + uFlare * 0.5) * uDim;
  gl_FragColor = vec4(uColor, a);
}`

const DUST_VERT = /* glsl */ `
attribute vec4 aSeed;  // xy: wander radii scalars, z: phase, w: speed
attribute float aSize;
varying float vTwinkle;
uniform float uTime, uPointScale;
void main() {
  vec3 p = position;
  float t = uTime * aSeed.w + aSeed.z * 6.2831;
  p.x += sin(t * 0.90) * (9.0 + aSeed.x * 15.0);
  p.y += sin(t * 0.63 + 1.7) * (7.0 + aSeed.y * 13.0) + sin(uTime * 0.06 * aSeed.w + aSeed.z * 9.0) * 26.0;
  p.z += cos(t * 0.71) * 9.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = aSize * uPointScale / max(1.0, -mv.z);
  vTwinkle = 0.55 + 0.45 * sin(t * 1.31 + aSeed.z * 12.0);
  gl_Position = projectionMatrix * mv;
}`

const DUST_FRAG = /* glsl */ `
varying float vTwinkle;
uniform vec3 uColor;
uniform float uAlpha, uEnergy, uFlare, uDim;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float body = smoothstep(1.0, 0.15, d);
  float core = pow(smoothstep(1.0, 0.0, d), 4.0) * 0.8;
  float a = uAlpha * (body * 0.65 + core) * vTwinkle * (1.0 + (uEnergy + uFlare * 0.4) * 1.6) * uDim;
  gl_FragColor = vec4(uColor, a);
}`

const BOKEH_VERT = /* glsl */ `
attribute vec3 aTint;
attribute float aPhase;
attribute float aAmp;
varying vec2 vUv;
varying vec3 vTint;
varying float vPhase;
uniform float uTime;
void main() {
  vUv = uv;
  vTint = aTint;
  vPhase = aPhase;
  vec4 ip = instanceMatrix * vec4(position, 1.0);
  ip.x += sin(uTime * 0.11 + aPhase * 6.2831) * aAmp;
  ip.y += sin(uTime * 0.083 + aPhase * 9.42) * aAmp * 0.8;
  gl_Position = projectionMatrix * modelViewMatrix * ip;
}`

const BOKEH_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vTint;
varying float vPhase;
uniform float uAlpha, uTime, uEnergy, uFlare, uDim;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float fall = pow(max(0.0, 1.0 - d), 2.0);
  float tw = 0.78 + 0.22 * sin(uTime * 0.5 + vPhase * 6.2831);
  float a = uAlpha * fall * tw * (1.0 + (uEnergy * 0.5 + uFlare * 0.35)) * uDim;
  gl_FragColor = vec4(vTint, a);
}`

const STAR_VERT = /* glsl */ `
attribute float aPhase;
attribute float aSize;
varying float vTw;
uniform float uTime, uPointScale;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uPointScale / max(1.0, -mv.z);
  vTw = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * (0.6 + aPhase) + aPhase * 40.0), 2.0);
  gl_Position = projectionMatrix * mv;
}`

const STAR_FRAG = /* glsl */ `
varying float vTw;
uniform vec3 uColor;
uniform float uAlpha, uDim;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = uAlpha * smoothstep(1.0, 0.0, d) * vTw * uDim;
  gl_FragColor = vec4(uColor, a);
}`

// --- Public API --------------------------------------------------------------

/**
 * Feature-gate + dynamically import three. Resolves always (never throws); on
 * any failure the app simply keeps its 2D backdrop. Called from main.ts in
 * parallel with the cloud bootstrap, before Phaser boots. The renderer itself
 * is stood up later, in attachStage, once Phaser's context exists.
 */
export async function prepareStage(): Promise<void> {
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    // Respect Save-Data: don't even download the three chunk (the governor seeds
    // LOW for these users anyway — the 2D path is their intended experience).
    const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection
    if (conn?.saveData) return
    T = await import('three')
  } catch {
    T = null
  }
}

/**
 * Stand the three renderer up on Phaser's OWN canvas + WebGL context and wire
 * the sim to the game loop. Call once from main.ts after `new Phaser.Game`.
 * No-ops (leaving the 2D path in charge) when three didn't load or Phaser fell
 * back to the Canvas renderer.
 */
export function attachStage(g: Phaser.Game): void {
  if (!T) return
  try {
    const gl = (g.renderer as { gl?: WebGLRenderingContext }).gl
    if (!gl || !g.canvas) return
    game = g
    renderer = new T.WebGLRenderer({ canvas: g.canvas, context: gl })
    // Phaser owns the frame: it already cleared and painted the wash below us.
    renderer.autoClear = false
    scene3 = new T.Scene()
    camera = new T.PerspectiveCamera(55, 1, 60, 3000)
    camera.rotation.set(0, 0, 0) // axis-aligned forever — the alignment contract

    // A lost context kills both renderers' GPU state; Phaser restores itself,
    // but three's caches would be stale — fail soft to the 2D path instead.
    g.canvas.addEventListener('webglcontextlost', () => teardown(), { once: true })

    // Pointer parallax feed (passive; the game's own input is untouched).
    window.addEventListener(
      'pointermove',
      e => {
        parallaxTX = (e.clientX / Math.max(1, window.innerWidth) - 0.5) * 2
        parallaxTY = (e.clientY / Math.max(1, window.innerHeight) - 0.5) * 2
      },
      { passive: true }
    )

    g.events.on('poststep', (_t: number, dt: number) => frame(dt))
    g.scale.on('resize', () => applyView())
    applyView()
    active = true
  } catch {
    teardown()
  }
}

/**
 * Aim the room at a scene variant and mount its draw hook into the scene
 * (called by addCasinoBackdrop from every scene's create). Returns TRUE when
 * the room is live for this scene — the caller then skips the 2D fake-light
 * stack. Returns FALSE (2D path) when inactive or on the LOW quality tier,
 * where the fixed-cost 2D stack is the cheaper citizen.
 */
export function setStageMood(scene: Phaser.Scene, v: BackdropVariant): boolean {
  if (!active || !T || !renderer) return false
  if (quality.tier() === 'low') return false
  variant = v
  staticMode = prefersReducedMotion()
  const sig = [getThemeId(), v, quality.tier(), staticMode].join('|')
  applyView()
  if (sig !== builtSig) {
    builtSig = sig
    buildRoom()
  }

  // The scene-owned draw hook: Phaser calls this mid-display-list (depth −59),
  // wrapping it with pipelines.clear()/rebind(); resetState() re-applies three's
  // cached GL state after Phaser's mutations. Dies with the scene — each create
  // mounts a fresh one.
  const extern = scene.add.extern() as Phaser.GameObjects.Extern & { render: () => void }
  extern.setDepth(STAGE_DEPTH).setScrollFactor(0)
  extern.render = () => {
    if (!active || !renderer || !scene3 || !camera || !game) return
    shared.uTime.value = timeS
    shared.uEnergy.value = energy
    shared.uFlare.value = flare
    shared.uDim.value = dim
    renderer.resetState()
    // Phaser's backing buffer is the world box at 1×; keep three's viewport
    // pinned to it (cheap, and immune to any pipeline viewport changes).
    renderer.setViewport(0, 0, game.canvas.width, game.canvas.height)
    renderer.render(scene3, camera)
  }
  return true
}

/**
 * Gameplay beat → the room's light surges and decays (beams, dust, underglow).
 * `strength` 0..1. Respects reduce-flashing (halved) and reduced motion (skipped).
 */
export function stagePulse(strength: number): void {
  if (!active || staticMode) return
  const s = Math.max(0, Math.min(1, strength)) * (reduceFlashing() ? 0.55 : 1)
  energy = Math.max(energy, s)
}

/** Celebration → a slow warm swell on top of a full pulse (wins, jackpots, megas). */
export function stageFlare(): void {
  if (!active || staticMode) return
  const cap = reduceFlashing() ? 0.5 : 1
  energy = Math.max(energy, 0.85 * cap)
  flare = Math.max(flare, cap)
}

// --- Lifecycle internals -----------------------------------------------------

function teardown(): void {
  active = false
  disposeParts()
  try {
    renderer?.dispose()
  } catch {
    // context already gone — nothing to release
  }
  renderer = null
  scene3 = null
  camera = null
  builtSig = ''
}

function disposeParts(): void {
  for (const p of parts) p.dispose()
  parts = []
}

/**
 * Recompute the camera from the live world box. With the shared canvas the
 * mapping input is the world box itself (no DOM rects): the canvas IS 720 ×
 * worldH design units, scrolled by restScrollY.
 */
function applyView(): void {
  if (!camera) return
  const next = computeStageView({
    viewportW: DESIGN_W,
    viewportH: worldH(),
    canvasLeft: 0,
    canvasTop: 0,
    canvasWidth: DESIGN_W,
    designW: DESIGN_W,
    scrollY: restScrollY(),
  })
  const changed =
    !view ||
    Math.abs(next.worldH - view.worldH) > 1 ||
    Math.abs(next.camY - view.camY) > 1
  view = next
  camera.fov = next.fovDeg
  camera.aspect = next.aspect
  camera.near = Math.max(60, next.dist * 0.35)
  camera.far = next.dist + 1600
  camera.updateProjectionMatrix()
  placeCamera()
  // A real world-box change (orientation, URL-bar regrow) → refit the fixtures.
  if (changed && builtSig) buildRoom()
}

/** Camera = solved centre + breathing + eased pointer parallax (world units). */
function placeCamera(): void {
  if (!camera || !view) return
  const still = staticMode
  const bx = still ? 0 : Math.sin((timeS / BREATHE_TX) * Math.PI * 2) * BREATHE_AX
  const by = still ? 0 : Math.sin((timeS / BREATHE_TY) * Math.PI * 2 + 1.3) * BREATHE_AY
  const px = still ? 0 : parallaxX * -PARALLAX_X
  const py = still ? 0 : parallaxY * -PARALLAX_Y
  camera.position.set(view.camX + bx + px, -(view.camY + by + py), view.dist)
}

// --- Per-frame sim (from Phaser POST_STEP — sleeps with the loop) ------------
// Rendering happens later in the same frame, inside the scene's Extern hook.

function frame(deltaMs: number): void {
  if (!active || !view) return
  const dt = Math.max(0, Math.min(100, deltaMs))

  // Idle: dim the room — ambience for a left-open PWA. (Draws still happen with
  // the game's own frames; the dim is the battery-facing gesture we control.)
  const dimTarget = quality.idle() ? IDLE_DIM : 1
  dim += (dimTarget - dim) * (1 - Math.exp(-dt / DIM_TAU))

  if (staticMode) return // frozen clock: a still, fully-lit room

  timeS += dt / 1000
  energy *= Math.exp(-dt / ENERGY_TAU)
  flare *= Math.exp(-dt / FLARE_TAU)
  if (energy < 0.004) energy = 0
  if (flare < 0.004) flare = 0

  const k = 1 - Math.exp(-dt / PARALLAX_TAU)
  parallaxX += (parallaxTX - parallaxX) * k
  parallaxY += (parallaxTY - parallaxY) * k

  placeCamera()
  for (const p of parts) p.update?.(timeS)
}

// --- Room construction -------------------------------------------------------

interface GlowSpec {
  x: number
  y: number
  z: number
  w: number
  h: number
  color: number
  alpha: number
  breathe: number
  energyGain: number
  phase: number
}

interface BeamSpec {
  x: number
  y: number
  z: number
  tiltDeg: number
  len: number
  rTop: number
  rBottom: number
  color: number
  alpha: number
  swayDeg: number
  swayT: number
  tailStart: number
}

/** (Re)build every fixture for the current theme × variant × tier × view. */
function buildRoom(): void {
  if (!T || !scene3 || !view) return
  disposeParts()
  const Th = getTheme()
  const dark = lum(Th.washTop) < 0.45
  const tier = quality.tier()
  const countScale = tier === 'high' ? 1 : 0.66
  const v = view
  const rng = makeRng(
    [...getThemeId()].reduce((a, c) => a + c.charCodeAt(0), 0) * 31 + variant.length
  )

  // Visible world box + a parallax margin.
  const wt = v.worldTop
  const wb = v.worldBottom
  const wl = v.worldLeft
  const wr = v.worldRight
  const H = v.worldH
  const cx = v.camX

  // ---- Sky: the wash, now with real depth behind it ----
  buildSky(Th, dark, variant === 'game' ? 0.055 : variant === 'menu' ? 0.075 : 0.095)

  // ---- Aurora / pools / underglow ----
  const glows: GlowSpec[] = []
  if (variant === 'game') {
    // Board underglow — replaces 2D boardBleed; reacts hardest to gameplay energy.
    glows.push({ x: DESIGN_W / 2, y: 620, z: -55, w: BOARD_W + 260, h: BOARD_W + 260, color: Th.bleedWarm, alpha: 0.1, breathe: 0.18, energyGain: 1.2, phase: 0 })
    // Spot source bloom in the top margin + a modest floor pool below the board.
    glows.push({ x: cx, y: wt + 100, z: -90, w: 470, h: 330, color: Th.washGlowWarm, alpha: 0.075, breathe: 0.22, energyGain: 0.7, phase: 1.9 })
    glows.push({ x: cx + 90, y: wb - 70, z: -60, w: 640, h: 260, color: Th.washGlowCool, alpha: 0.05, breathe: 0.2, energyGain: 0.5, phase: 3.6 })
  } else {
    const rich = variant === 'home'
    glows.push({ x: cx - 150, y: wt + H * 0.32, z: -470, w: 700, h: 700, color: Th.washGlowWarm, alpha: rich ? 0.115 : 0.095, breathe: 0.2, energyGain: 0.5, phase: 0.4 })
    glows.push({ x: cx + 170, y: wt + H * 0.66, z: -560, w: 660, h: 660, color: Th.washGlowCool, alpha: rich ? 0.1 : 0.08, breathe: 0.2, energyGain: 0.5, phase: 2.7 })
    glows.push({ x: cx, y: wb - 80, z: -50, w: v.worldW * 1.15, h: 320, color: Th.washGlowWarm, alpha: rich ? 0.085 : 0.06, breathe: 0.16, energyGain: 0.6, phase: 4.4 })
  }
  for (const g of glows) buildGlow(g)

  // ---- Volumetric beams ----
  const beams: BeamSpec[] = []
  const beamLen = H * 0.98
  if (variant === 'home') {
    beams.push({ x: cx - 150, y: wt - 50, z: -80, tiltDeg: 10.5, len: beamLen, rTop: 26, rBottom: 300, color: Th.rayTint, alpha: 0.1, swayDeg: 2.6, swayT: 6.7, tailStart: 0.55 })
    beams.push({ x: cx + 155, y: wt - 40, z: -110, tiltDeg: -9, len: beamLen * 0.92, rTop: 22, rBottom: 260, color: Th.rayTintCool, alpha: 0.08, swayDeg: 2.2, swayT: 8.1, tailStart: 0.52 })
  } else if (variant === 'menu') {
    beams.push({ x: cx - 70, y: wt - 40, z: -90, tiltDeg: 7, len: beamLen * 0.94, rTop: 24, rBottom: 280, color: Th.rayTint, alpha: 0.085, swayDeg: 2.2, swayT: 7.3, tailStart: 0.52 })
  } else {
    // Game: one narrow shaft onto the machine — it passes BEHIND the opaque board
    // and re-emerges at the floor pool, which is the whole depth trick.
    beams.push({ x: DESIGN_W / 2, y: wt - 40, z: -70, tiltDeg: 0, len: beamLen, rTop: 20, rBottom: 235, color: Th.rayTint, alpha: 0.068, swayDeg: 1.3, swayT: 8.9, tailStart: 0.6 })
  }
  for (const b of beams) buildBeam(b)

  // ---- Dust in the light ----
  const dustBase = variant === 'home' ? 190 : variant === 'menu' ? 150 : 130
  buildDust(Math.round(dustBase * countScale), { x0: wl - 30, x1: wr + 30, y0: wt - 20, y1: wb + 20, z0: -260, z1: -40 }, Th.sparkleTint, dark ? 0.5 : 0.42, rng)

  // ---- Bokeh depth field ----
  const bokehBase = variant === 'home' ? 22 : variant === 'menu' ? 15 : 11
  buildBokeh(Math.max(6, Math.round(bokehBase * countScale)), Th, dark, rng)

  // ---- Stars for the dark rooms ----
  if (dark) {
    const starBase = variant === 'home' ? 140 : variant === 'menu' ? 115 : 90
    buildStars(Math.round(starBase * Math.max(0.6, countScale)), Th.sparkleTint, rng)
  }
}

function buildSky(Th: ReturnType<typeof getTheme>, dark: boolean, glowAmt: number): void {
  if (!T || !scene3 || !view) return
  const z = -950
  const w = frustumWidthAt(view, z) * 1.35
  const h = frustumHeightAt(view, z) * 1.35
  const geo = new T.PlaneGeometry(1, 1)
  const mat = new T.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: {
      uTop: { value: vec3(Th.washTop) },
      uBottom: { value: vec3(Th.washBottom) },
      uGlow: { value: vec3(dark ? Th.washGlowWarm : Th.bloom) },
      uGlowAmt: { value: glowAmt },
      uFlare: shared.uFlare,
      uDim: shared.uDim,
    },
    depthWrite: false,
    depthTest: false,
  })
  const mesh = new T.Mesh(geo, mat)
  mesh.scale.set(w, h, 1)
  mesh.position.set(view.camX, -view.camY, z)
  mesh.renderOrder = -10
  mesh.frustumCulled = false
  scene3.add(mesh)
  parts.push({
    dispose: () => {
      scene3?.remove(mesh)
      geo.dispose()
      mat.dispose()
    },
  })
}

function buildGlow(spec: GlowSpec): void {
  if (!T || !scene3) return
  const geo = new T.PlaneGeometry(1, 1)
  const mat = new T.ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uColor: { value: vec3(spec.color) },
      uAlpha: { value: spec.alpha },
      uPhase: { value: spec.phase },
      uBreathe: { value: spec.breathe },
      uEnergyGain: { value: spec.energyGain },
      uTime: shared.uTime,
      uEnergy: shared.uEnergy,
      uFlare: shared.uFlare,
      uDim: shared.uDim,
    },
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  })
  const mesh = new T.Mesh(geo, mat)
  mesh.scale.set(spec.w, spec.h, 1)
  mesh.position.set(spec.x, -spec.y, spec.z)
  mesh.renderOrder = 2
  mesh.frustumCulled = false
  scene3.add(mesh)
  parts.push({
    dispose: () => {
      scene3?.remove(mesh)
      geo.dispose()
      mat.dispose()
    },
  })
}

function buildBeam(spec: BeamSpec): void {
  if (!T || !scene3) return
  const geo = new T.CylinderGeometry(spec.rTop, spec.rBottom, spec.len, 28, 1, true)
  // Source at the local origin (+y end), shaft extending down −y, so the group
  // pivots at the source when it sways — same rig trick as the 2D blades.
  geo.translate(0, -spec.len / 2, 0)
  const mat = new T.ShaderMaterial({
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    uniforms: {
      uColor: { value: vec3(spec.color) },
      uAlpha: { value: spec.alpha },
      uTailStart: { value: spec.tailStart },
      uTime: shared.uTime,
      uEnergy: shared.uEnergy,
      uFlare: shared.uFlare,
      uDim: shared.uDim,
    },
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    side: T.DoubleSide,
  })
  const mesh = new T.Mesh(geo, mat)
  mesh.frustumCulled = false
  const group = new T.Group()
  group.position.set(spec.x, -spec.y, spec.z)
  group.add(mesh)
  const baseTilt = (spec.tiltDeg * Math.PI) / 180
  const swayAmp = (spec.swayDeg * Math.PI) / 180
  group.rotation.z = baseTilt
  group.renderOrder = 3
  mesh.renderOrder = 3
  scene3.add(group)
  parts.push({
    update: t => {
      group.rotation.z = baseTilt + Math.sin((t / spec.swayT) * Math.PI * 2) * swayAmp
    },
    dispose: () => {
      scene3?.remove(group)
      geo.dispose()
      mat.dispose()
    },
  })
}

interface DustBox {
  x0: number
  x1: number
  y0: number
  y1: number
  z0: number
  z1: number
}

function buildDust(count: number, box: DustBox, color: number, alpha: number, rng: () => number): void {
  if (!T || !scene3 || count <= 0) return
  const pos = new Float32Array(count * 3)
  const seed = new Float32Array(count * 4)
  const size = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = box.x0 + rng() * (box.x1 - box.x0)
    pos[i * 3 + 1] = -(box.y0 + rng() * (box.y1 - box.y0))
    pos[i * 3 + 2] = box.z0 + rng() * (box.z1 - box.z0)
    seed[i * 4] = rng()
    seed[i * 4 + 1] = rng()
    seed[i * 4 + 2] = rng()
    seed[i * 4 + 3] = 0.5 + rng() * 0.9
    size[i] = 3 + rng() * 8
  }
  const geo = new T.BufferGeometry()
  geo.setAttribute('position', new T.BufferAttribute(pos, 3))
  geo.setAttribute('aSeed', new T.BufferAttribute(seed, 4))
  geo.setAttribute('aSize', new T.BufferAttribute(size, 1))
  const mat = new T.ShaderMaterial({
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    uniforms: {
      uColor: { value: vec3(color) },
      uAlpha: { value: alpha },
      uPointScale: { value: pointScale() },
      uTime: shared.uTime,
      uEnergy: shared.uEnergy,
      uFlare: shared.uFlare,
      uDim: shared.uDim,
    },
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  })
  const pts = new T.Points(geo, mat)
  pts.frustumCulled = false // wander in the vertex shader escapes the static bounds
  pts.renderOrder = 5
  scene3.add(pts)
  parts.push({
    update: () => {
      const u = mat.uniforms.uPointScale as { value: number }
      u.value = pointScale()
    },
    dispose: () => {
      scene3?.remove(pts)
      geo.dispose()
      mat.dispose()
    },
  })
}

/** Perspective point-size factor: device px per world unit at unit depth. */
function pointScale(): number {
  if (!game || !camera) return 1
  const h = game.canvas.height // Phaser's backing buffer = world units at 1×
  return h / (2 * Math.tan((camera.fov * Math.PI) / 360))
}

function buildBokeh(count: number, Th: ReturnType<typeof getTheme>, dark: boolean, rng: () => number): void {
  if (!T || !scene3 || !view || count <= 0) return
  const v = view
  const geo = new T.PlaneGeometry(1, 1)
  const tint = new Float32Array(count * 3)
  const phase = new Float32Array(count)
  const amp = new Float32Array(count)
  const mesh = new T.InstancedMesh(
    geo,
    new T.ShaderMaterial({
      vertexShader: BOKEH_VERT,
      fragmentShader: BOKEH_FRAG,
      uniforms: {
        uAlpha: { value: dark ? 0.11 : 0.095 },
        uTime: shared.uTime,
        uEnergy: shared.uEnergy,
        uFlare: shared.uFlare,
        uDim: shared.uDim,
      },
      transparent: true,
      blending: T.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
    count
  )
  const m = new T.Matrix4()
  const gameVariant = variant === 'game'
  for (let i = 0; i < count; i++) {
    const warm = rng() < 0.55
    const c = vec3(warm ? Th.bokehWarm : Th.bokehCool)
    tint[i * 3] = c[0]
    tint[i * 3 + 1] = c[1]
    tint[i * 3 + 2] = c[2]
    phase[i] = rng()
    amp[i] = 10 + rng() * 26
    const z = -(140 + rng() * 610)
    // Game keeps bokeh margin-biased (top/bottom thirds); menus roam the field.
    const y = gameVariant
      ? rng() < 0.5
        ? v.worldTop + rng() * 270
        : v.worldBottom - rng() * 300
      : v.worldTop + rng() * v.worldH
    const x = v.worldLeft + rng() * v.worldW
    const s = (90 + rng() * 290) * (1 - z / 1400) // deeper → a touch larger, softer field
    m.makeTranslation(x, -y, z)
    m.elements[0] = s
    m.elements[5] = s
    mesh.setMatrixAt(i, m)
  }
  geo.setAttribute('aTint', new T.InstancedBufferAttribute(tint, 3))
  geo.setAttribute('aPhase', new T.InstancedBufferAttribute(phase, 1))
  geo.setAttribute('aAmp', new T.InstancedBufferAttribute(amp, 1))
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false
  mesh.renderOrder = 4
  scene3.add(mesh)
  parts.push({
    dispose: () => {
      scene3?.remove(mesh)
      geo.dispose()
      ;(mesh.material as THREE.Material).dispose()
      mesh.dispose()
    },
  })
}

function buildStars(count: number, color: number, rng: () => number): void {
  if (!T || !scene3 || !view || count <= 0) return
  const v = view
  const pos = new Float32Array(count * 3)
  const phase = new Float32Array(count)
  const size = new Float32Array(count)
  const z0 = -880
  for (let i = 0; i < count; i++) {
    const z = z0 + rng() * 160
    const w = frustumWidthAt(v, z) * 1.2
    const h = frustumHeightAt(v, z) * 1.2
    pos[i * 3] = v.camX - w / 2 + rng() * w
    pos[i * 3 + 1] = -(v.camY - h / 2 + rng() * h)
    pos[i * 3 + 2] = z
    phase[i] = rng()
    size[i] = 2.2 + rng() * 3.6
  }
  const geo = new T.BufferGeometry()
  geo.setAttribute('position', new T.BufferAttribute(pos, 3))
  geo.setAttribute('aPhase', new T.BufferAttribute(phase, 1))
  geo.setAttribute('aSize', new T.BufferAttribute(size, 1))
  const mat = new T.ShaderMaterial({
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    uniforms: {
      uColor: { value: vec3(color) },
      uAlpha: { value: 0.5 },
      uPointScale: { value: pointScale() },
      uTime: shared.uTime,
      uDim: shared.uDim,
    },
    transparent: true,
    blending: T.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  })
  const pts = new T.Points(geo, mat)
  pts.frustumCulled = false
  pts.renderOrder = 1
  scene3.add(pts)
  parts.push({
    update: () => {
      const u = mat.uniforms.uPointScale as { value: number }
      u.value = pointScale()
    },
    dispose: () => {
      scene3?.remove(pts)
      geo.dispose()
      mat.dispose()
    },
  })
}

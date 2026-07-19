import Phaser from 'phaser'
import { SWAP_SOUNDS, SWAP_SOUND_LABELS, sfx } from '../audio/sfx'
import { LIVES_MAX, restScrollY, worldH } from '../config'
import { formatCountdown } from '../core/lives'
import type { LivesState } from '../core/lives'
import { loadSave } from '../core/save'
import type { SaveData } from '../core/save'
import {
  THEME_META,
  THEME_ORDER,
  THEMES,
  css,
  getTheme,
  getThemeId,
  hapticsOff,
  prefersReducedMotion,
  reduceFlashing,
  setHapticsOff,
  setReduceFlashing,
  setReduceMotion,
  setTheme,
  themeUnlocked,
} from './theme'
import type { Theme, ThemeId } from './theme'

export const FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif'

// ─────────────────────────────────────────────────────────────────────────────
// High-Contrast board flag (§E12). Kept OUT of theme.ts (owned by that module's a11y block) but
// following the same shape-tolerant one-key pattern: a self-contained localStorage flag the
// settings panel flips and GameScene reads at create(). Default OFF → the board's warm look is
// untouched until Maya opts in. No save-schema coupling (mirrors theme/sfx storage).
// ─────────────────────────────────────────────────────────────────────────────

const HC_BOARD_KEY = 'viva-maya:hcBoard'

function readHcBoard(): boolean {
  try {
    return localStorage.getItem(HC_BOARD_KEY) === '1'
  } catch {
    return false
  }
}

let _hcBoard = readHcBoard()

/** In-app High-Contrast board switch (§E12) — GameScene reads this at create(). Default OFF. */
export function hcBoard(): boolean {
  return _hcBoard
}

/** Set + persist the High-Contrast board switch (the settings panel's toggle). */
export function setHcBoard(v: boolean): void {
  _hcBoard = v
  try {
    localStorage.setItem(HC_BOARD_KEY, v ? '1' : '0')
  } catch {
    // storage blocked (private mode / no DOM) — the choice just won't persist
  }
}

/**
 * Raw in-app Reduce-Motion pref for the settings TOGGLE display (§E8) — read straight from the a11y
 * key so the switch reflects exactly what Maya set, independent of the OS query. Writes still go
 * through theme.ts's `setReduceMotion` (single source of truth); the effective motion state
 * (`prefersReducedMotion`) still OR's the OS setting. Shape-tolerant: any bad/absent value → false.
 */
function rawReduceMotionPref(): boolean {
  try {
    const raw = localStorage.getItem('viva-maya:a11y')
    if (raw === null) return false
    return (JSON.parse(raw) as { reduceMotion?: unknown }).reduceMotion === true
  } catch {
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Directional scene grammar (§E10). Beyond the flat cream fade, a scene now ENTERS with a subtle
// 24px push/pop so the app gains spatial memory: going DEEPER (Home→Game/LevelSelect/Daily) rises
// the destination up into place, going BACK settles it down — each with an E.release/Back settle.
// The direction is queued by `startScene` into a module var and consumed by the destination's
// `applyEntrance(scene)` in its create(); scenes that never call it just keep the flat fade, so the
// mechanism adds nothing other scenes must adopt to compile. Reduced-motion → no offset (flat fade).
// ─────────────────────────────────────────────────────────────────────────────

/** Direction a scene ENTERS from (§E10): 'deeper' rises up into place, 'back' settles down. */
export type SceneDir = 'deeper' | 'back'

/** Subtle push/pop travel for the directional entrance (design px). Deliberately small. */
const ENTRANCE_OFFSET = 24

/** Pending entrance direction for the NEXT scene's create(), set by startScene, read by applyEntrance. */
let nextEntrance: SceneDir = 'deeper'

/** Count of in-app scene navigations this page-load — lets Home tell a true BootScene→Home open apart. */
let sceneNavigations = 0

/** True once any in-app `startScene` navigation has happened (i.e. we're past the initial Boot→Home open). */
export function hasNavigated(): boolean {
  return sceneNavigations > 0
}

/**
 * Warm cream cross-fade between scenes (§3d). Locks input during the fade (which doubles as an
 * anti-double-tap guard), fades the camera to brand cream (#fffdf8 — NEVER black), and starts
 * the destination scene once the fade-out completes. Each scene's create() pairs this with a
 * matching `this.cameras.main.fadeIn(...)` at the top. Reduced-motion shortens the fade.
 *
 * §E10: the optional `dir` sets the destination's directional entrance. Explicit dir wins; otherwise
 * returning to Home reads as 'back' (settles down) and going anywhere else reads as 'deeper' (rises
 * in). Back-compatible — the existing 3-arg call sites keep working with `dir` left undefined.
 */
export function startScene(from: Phaser.Scene, key: string, data?: object, dir?: SceneDir): void {
  if (!from.input.enabled) return // already transitioning
  from.input.enabled = false
  sfx.whoosh() // §E3 B14: a short airy sweep partners the cream cross-fade
  nextEntrance = dir ?? (key === 'home' ? 'back' : 'deeper')
  sceneNavigations += 1
  const dur = prefersReducedMotion() ? 90 : 180
  const cam = from.cameras.main
  cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => from.scene.start(key, data))
  cam.fadeOut(dur, 255, 253, 248)
}

/** Read + clear the pending directional entrance (defaults 'deeper' when nothing is queued). */
export function consumeEntrance(): SceneDir {
  const dir = nextEntrance
  nextEntrance = 'deeper'
  return dir
}

/**
 * §E10 directional entrance: nudge a freshly-created scene's CAMERA so the destination pushes in with
 * a subtle 24px travel + an E.release/Back settle — 'deeper' rises up into place, 'back' settles down —
 * then resolves to a flat view. Consumes the direction queued by the triggering `startScene`. A scene
 * MAY call this once in create() after its `fadeIn`; scenes that don't just get today's flat cream
 * fade. Reduced-motion → no offset. Returns the resolved direction.
 */
export function applyEntrance(scene: Phaser.Scene, dir: SceneDir = consumeEntrance()): SceneDir {
  if (prefersReducedMotion()) return dir
  const cam = scene.cameras.main
  // Rest at the centring scroll (restScrollY), not 0, so the entrance nudge settles onto the
  // vertically-centred design box instead of yanking it back to the top on flexible-height screens.
  const rest = restScrollY()
  cam.setScroll(cam.scrollX, rest + (dir === 'deeper' ? -ENTRANCE_OFFSET : ENTRANCE_OFFSET))
  scene.tweens.add({ targets: cam, scrollY: rest, duration: 340, ease: 'Back.easeOut' })
  return dir
}

export interface LivesHud {
  container: Phaser.GameObjects.Container
  /** Repaint hearts + countdown from a fresh LivesState (call on a per-second timer). */
  update: (state: LivesState) => void
}

/**
 * Row of ❤️ hearts (filled = available, faded = spent) with a "next life mm:ss"
 * countdown underneath. The energy pool for the lose-only lives system.
 */
export function addLivesHud(
  scene: Phaser.Scene,
  centerX: number,
  y: number,
  opts: { size?: number; gap?: number; showTimer?: boolean; timerColor?: string } = {}
): LivesHud {
  const size = opts.size ?? 34
  const gap = opts.gap ?? 10
  const showTimer = opts.showTimer ?? true
  const container = scene.add.container(centerX, y)
  const totalW = LIVES_MAX * size + (LIVES_MAX - 1) * gap
  const hearts: Phaser.GameObjects.Image[] = []
  for (let i = 0; i < LIVES_MAX; i++) {
    const heart = scene.add
      .image(-totalW / 2 + size / 2 + i * (size + gap), 0, 'heart')
      .setDisplaySize(size, size)
    hearts.push(heart)
    container.add(heart)
  }
  let timer: Phaser.GameObjects.Text | undefined
  if (showTimer) {
    timer = scene.add
      .text(0, size / 2 + 14, '', { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: opts.timerColor ?? '#9a927e' })
      .setOrigin(0.5)
    container.add(timer)
  }
  // ── H2 · lives-regen "heart fills" micro-beat ──────────────────────────────────────────────────
  // Remember the last displayed filled-count so an INCREASE (a life quietly regenerated while the
  // player was away) can pop + warm-flash the exact pip(s) that just filled — turning invisible regen
  // into a felt "you got a life back." Reduced motion keeps today's instant fill (gated in update).
  // Visual only; the paired soft "life restored" chime lands in C5.
  let prevFilled = -1
  const white = Phaser.Display.Color.ValueToColor(0xffffff)
  const flash = Phaser.Display.Color.ValueToColor(getTheme().rose)
  const popPip = (heart: Phaser.GameObjects.Image): void => {
    const base = heart.scaleX
    const POP = 0.34
    scene.tweens.add({
      targets: heart,
      scaleX: base * (1 + POP),
      scaleY: base * (1 + POP),
      duration: 170,
      yoyo: true,
      ease: 'Quad.easeOut',
      onUpdate: () => {
        // Warm rose glint strongest at the peak of the pop, easing back to normal as the pip settles —
        // derived from the live scale so the colour tracks the yoyo with no extra tween bookkeeping.
        const amt = Phaser.Math.Clamp((heart.scaleX / base - 1) / POP, 0, 1)
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(white, flash, 100, Math.round(amt * 100))
        heart.setTint(Phaser.Display.Color.GetColor(c.r, c.g, c.b))
      },
      onComplete: () => heart.clearTint(),
    })
  }
  const update = (state: LivesState): void => {
    const filledCount = Phaser.Math.Clamp(state.lives, 0, LIVES_MAX)
    hearts.forEach((heart, i) => {
      const filled = i < state.lives
      heart.setAlpha(filled ? 1 : 0.24)
      if (filled) heart.clearTint()
      else heart.setTint(0x7a7266)
    })
    if (timer) timer.setText(state.full ? '' : `next life  ${formatCountdown(state.nextInMs)}`)
    // Celebrate only a genuine increase in filled hearts — never the first paint (prevFilled seeded to
    // -1) and never under reduced motion, where the fill stays instant exactly as before.
    if (prevFilled >= 0 && filledCount > prevFilled && !prefersReducedMotion()) {
      for (let i = prevFilled; i < filledCount; i++) popPip(hearts[i])
    }
    prevFilled = filledCount
  }
  return { container, update }
}

/** Handle to the marquee title so a caller (Home's boot) can choreograph the power-on reveal. */
export interface Marquee {
  viva: Phaser.GameObjects.Text
  maya: Phaser.GameObjects.Text
  heart: Phaser.GameObjects.Image
  /** Marquee-frame bulbs above the wordmark (empty unless `opts.bulbs`). */
  bulbs: Phaser.GameObjects.Image[]
  /**
   * Power-on reveal (Signature #1): the wordmark darks IMMEDIATELY (call synchronously so it never
   * flashes visible first), then after `leadIn` ms a single gold sweep glides VIVA→MAYA lighting the
   * words as it passes, the marquee bulbs cascade-light left→right in its wake, and the heart flourish
   * pops in last. Returns roughly when the reveal finishes (ms) so the caller can chain the glow bloom
   * + button stagger. Under reduced motion everything is simply left statically lit.
   */
  powerOn: (scene: Phaser.Scene, leadIn?: number) => number
}

/**
 * Two-tone marquee title with a heart flourish, centered. Returns a {@link Marquee} handle (callers
 * that ignore it — e.g. LevelSelect — are unaffected). `opts.bulbs` adds a subtle row of marquee
 * bulbs above the wordmark (used on Home so the power-on has something to cascade-light).
 */
export function addMarquee(scene: Phaser.Scene, centerX: number, y: number, opts: { bulbs?: boolean } = {}): Marquee {
  const viva = scene.add
    .text(0, y, 'VIVA', { fontFamily: FONT, fontSize: '58px', fontStyle: '900', color: '#ffffff' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(4)
    .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
  viva.setTint(0xffd75e, 0xffd75e, 0xc9930a, 0xc9930a)
  const maya = scene.add
    .text(0, y, 'MAYA', { fontFamily: FONT, fontSize: '58px', fontStyle: '900', color: '#ffffff' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(4)
    .setShadow(0, 3, 'rgba(90,20,15,0.25)', 6, false, true)
  maya.setTint(0xff7a85, 0xff7a85, 0xd3304f, 0xd3304f)
  const gap = 18
  const heartW = 34
  const total = viva.width + gap + maya.width + 12 + heartW
  viva.setX(centerX - total / 2)
  maya.setX(viva.x + viva.width + gap)
  const spanLeft = viva.x
  const spanRight = maya.x + maya.width
  const heart = scene.add.image(maya.x + maya.width + 12 + heartW / 2, y - 14, 'heart')
  heart.setDisplaySize(heartW, heartW)
  const heartBase = heart.scaleX
  // Heart-flourish heartbeat — extracted so the power-on can restart it after the heart pops in.
  const beatHeart = (): void => {
    if (prefersReducedMotion()) return
    scene.tweens.add({
      targets: heart,
      scale: heartBase * 1.18,
      duration: 700,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }
  beatHeart()

  // Optional marquee-frame bulbs above the wordmark (Home only) — a subtle alternating gold/accent
  // row that reads as the top edge of a cabinet sign and gives the power-on a light to cascade.
  const bulbs: Phaser.GameObjects.Image[] = []
  if (opts.bulbs) {
    const T = getTheme()
    const by = y - 44
    const n = 9
    for (let i = 0; i < n; i++) {
      const bx = spanLeft + ((spanRight - spanLeft) * i) / (n - 1)
      const bulb = scene.add
        .image(bx, by, 'bulb')
        .setDisplaySize(13, 13)
        .setTint(i % 2 === 0 ? T.gold : T.accent)
        .setAlpha(0.62)
      bulbs.push(bulb)
    }
  }

  // Slow light-sweep shine: a masked cream gloss that periodically glides VIVA→MAYA. Each word
  // gets its own streak clipped to its glyphs (bitmap mask), and the two share one tween value so
  // the highlight reads as a single continuous band travelling across the whole wordmark. Skipped
  // under reduced motion.
  if (!prefersReducedMotion()) {
    const streakW = 46
    const shineFor = (word: Phaser.GameObjects.Text): Phaser.GameObjects.Image => {
      const shine = scene.add
        .image(spanLeft - streakW, y, 'sweep')
        .setDisplaySize(streakW, 84)
        .setAngle(18)
        .setTint(0xfffdf8)
        .setAlpha(0.5)
        .setBlendMode(Phaser.BlendModes.ADD)
      shine.setMask(word.createBitmapMask())
      return shine
    }
    scene.tweens.add({
      targets: [shineFor(viva), shineFor(maya)],
      x: spanRight + streakW,
      duration: 1400,
      ease: 'Sine.easeInOut',
      repeat: -1,
      repeatDelay: 2600,
    })
  }

  const powerOn = (s: Phaser.Scene, leadIn = 0): number => {
    if (prefersReducedMotion()) return 0 // static reveal — everything already sits lit
    // Dark the wordmark + heart flourish, dim the bulbs NOW (synchronous — no visible-then-dark flash).
    viva.setAlpha(0)
    maya.setAlpha(0)
    s.tweens.killTweensOf(heart)
    heart.setScale(0)
    for (const b of bulbs) b.setAlpha(0.12)

    // A single bright gold sweep glides across the wordmark and reveals it as it passes.
    const streakW = 60
    const sweep = s.add
      .image(spanLeft - streakW, y, 'sweep')
      .setDisplaySize(streakW, 96)
      .setAngle(16)
      .setTint(getTheme().goldBright)
      .setAlpha(0)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(60)
    s.time.delayedCall(leadIn, () => sfx.whoosh()) // §E3 the airy sweep partners the gold light passing
    s.tweens.add({ targets: sweep, alpha: 0.9, duration: 140, yoyo: true, hold: 460, delay: leadIn, ease: 'Sine.easeInOut' })
    s.tweens.add({
      targets: sweep,
      x: spanRight + streakW,
      duration: 720,
      delay: leadIn,
      ease: 'Sine.easeInOut',
      onComplete: () => sweep.destroy(),
    })
    // Words fade in tracking the sweep's passage.
    s.tweens.add({ targets: viva, alpha: 1, duration: 240, delay: leadIn + 150, ease: 'Quad.easeOut' })
    s.tweens.add({ targets: maya, alpha: 1, duration: 240, delay: leadIn + 380, ease: 'Quad.easeOut' })
    // Bulbs cascade-light left→right in the sweep's wake.
    bulbs.forEach((b, i) => {
      s.tweens.add({
        targets: b,
        alpha: 0.85,
        duration: 200,
        delay: leadIn + 300 + i * 55,
        yoyo: true,
        hold: 90,
        ease: 'Sine.easeInOut',
        onComplete: () => b.setAlpha(0.62),
      })
    })
    // Heart flourish pops in last, then resumes its heartbeat.
    s.tweens.add({
      targets: heart,
      scale: heartBase,
      duration: 300,
      delay: leadIn + 620,
      ease: 'Back.easeOut',
      onComplete: beatHeart,
    })
    return leadIn + 920
  }

  return { viva, maya, heart, bulbs, powerOn }
}

/**
 * Warm flame pill announcing the daily-spin streak — a return hook shown on the
 * home screen when streak > 0. The 🔥 lives in its own text object (no letterSpacing)
 * because letterSpacing splits emoji surrogate pairs in Phaser's glyph renderer.
 * Returns null when there's no streak to show.
 */
export function addStreakBadge(
  scene: Phaser.Scene,
  centerX: number,
  y: number,
  streak: number
): Phaser.GameObjects.Container | null {
  if (streak <= 0) return null
  const container = scene.add.container(centerX, y)
  const flame = scene.add.text(0, 0, '🔥', { fontFamily: 'sans-serif', fontSize: '32px' }).setOrigin(0.5)
  const label = scene.add
    .text(0, 0, `${streak} DAY STREAK`, { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(2)
  const gap = 8
  const padX = 26
  const h = 54
  const w = flame.width + gap + label.width + padX * 2
  const g = scene.add.graphics()
  drawPillFace(g, -w / 2, -h / 2, w, h, READOUT_STYLE)
  flame.setPosition(-w / 2 + padX + flame.width / 2, 0)
  label.setPosition(flame.x + flame.width / 2 + gap, 0)
  container.add([g, flame, label])
  // A little flame flicker so it reads as "alive" / on fire.
  scene.tweens.add({
    targets: flame,
    scaleX: 1.16,
    scaleY: 1.12,
    duration: 480,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  })
  return container
}

export interface PillStyle {
  fill: number
  border?: number
  textColor: string
  /** Stable texture-cache id (keeps `btnface:{id}:{w}x{h}` keys short + shared across scenes). */
  id?: string
  /** Art-direction overrides for the chunky-3D bake (all optional — derived from fill/border when omitted). */
  top?: number
  bottom?: number
  pedestal?: number
  pedestalDeep?: number
  well?: number
  outline?: number
  rim?: number
  spec?: number
  emboss?: string
}

export const GOLD_PILL: PillStyle = { id: 'gold', fill: 0xf2b234, border: 0xc9930a, textColor: '#4a3305' }
export const GHOST_PILL: PillStyle = { id: 'ghost', fill: 0xffffff, border: 0xe8dfc9, textColor: '#8a8577' }
/** Rose "special mode" pill — sets the endless weekly race apart from the gold progression buttons. */
export const ROSE_PILL: PillStyle = { id: 'rose', fill: 0xd3304f, border: 0xa8213c, textColor: '#ffffff' }

// ─────────────────────────────────────────────────────────────────────────────
// Chunky 3D pressable controls (visual-overhaul §3a / §4).
//
// Every button/chip is a glossy beveled CAP (`btnface:*`) seated on a darker
// PEDESTAL (`btnbase:*` — dark interior well up top, lit 3D lip at the bottom,
// soft contact shadow beneath). On press the inner `face` container sinks into
// the base and squashes, revealing the well; the OUTER container never moves, so
// caller breathing/entrance tweens and `.setDepth(...)` compose cleanly. Both
// textures are baked once via generateTexture and cached in the global
// TextureManager keyed `{id}:{w}x{h}`, so identical buttons batch to one draw.
// ─────────────────────────────────────────────────────────────────────────────

const TEX_PAD = 12

/**
 * Light guarded press haptic (§E14 haptic unify) — the tactile partner to `sfx.uiPress()` on every
 * button depress. Respects the a11y Haptics-off switch and no-ops where the Vibration API is absent
 * (desktop / iOS Safari), so it never throws. Deliberately tiny — a tap, not a buzz.
 */
function pressHaptic(): void {
  if (hapticsOff()) return
  try {
    if ('vibrate' in navigator) navigator.vibrate?.(8)
  } catch {
    // no Vibration API — silent no-op
  }
}

/**
 * Minimum interactive edge in DESIGN pixels for every pressable's INVISIBLE hit-zone (§E8 touch
 * targets). 84 design-px ≈ 44pt at this design scale — the WCAG floor. The hit rectangle grows to
 * this minimum in each axis while the baked cap/pedestal art keeps its authored size, so the corner
 * chips (52²) and the short back pills (84×56) become comfortably tappable with zero visual change.
 */
const MIN_HIT = 84

/** Mix a colour toward white (t > 0) or black (t < 0) by |t| ∈ [0,1]. */
function shade(color: number, t: number): number {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  const to = t >= 0 ? 255 : 0
  const a = Math.min(1, Math.abs(t))
  const mix = (c: number): number => Math.round(c + (to - c) * a)
  return (mix(r) << 16) | (mix(g) << 8) | mix(b)
}

/**
 * Radius clamped to just UNDER half the smallest side. Phaser's `fillRoundedRect`/`strokeRoundedRect`
 * spike at the corners when the radius equals exactly half a side (a perfect semicircle end): the arc
 * tessellation overshoots the tangent and bakes a sharp "ear" into the texture. Staying 1px under the
 * half keeps a hair of straight edge at each end so the arcs never degenerate — visually identical,
 * artifact-free at every DPR.
 */
function safeR(r: number, w: number, h: number): number {
  return Math.max(1, Math.min(r, w / 2 - 1, h / 2 - 1))
}

// ─────────────────────────────────────────────────────────────────────────────
// Material + lighting law (E7). ONE key light so every baked shadow agrees where the
// light is (disagreeing shadows are the tell of cheap UI); a canonical real-metal gold
// face; and a dark-theme-only lit accent rim. All baked, zero runtime cost — the light
// themes (Golden Hour / Maya's Heart) are visually untouched.
// ─────────────────────────────────────────────────────────────────────────────

/** The one key light for the whole UI (design-space, above-centre). Every surface casts away from it. */
export const LIGHT = { x: 360, y: -200 }

/**
 * Soft drop-shadow for a rounded-rect surface (top-left x,y · size w×h). Because LIGHT sits above
 * the scene, every surface casts straight DOWN; a few falling-offset copies build a soft penumbra.
 * Routing the baked UI shadows through this is what makes them all agree on one light direction.
 */
function dropShadow(
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
function isDarkTheme(T: Theme = getTheme()): boolean {
  return luma(T.washBottom) < 0.4
}

/**
 * Dark-theme-only lit accent rim along the TOP inner edge of a cream card/pill. A coloured lit rim
 * is what makes neon read expensive; on Golden Hour / Maya's Heart this is a no-op (cost + look
 * unchanged). Draw AFTER the fill/bezel so the rim sits on top of the top edge.
 */
function accentRimTop(
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
 * of flat "yellow plastic". Baked into a Graphics — exported so later phases (payline, win-card tab,
 * marquee lozenge, pills) share the exact same material.
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
  // Deep belly base.
  g.fillStyle(tokens.goldDeep, 1)
  g.fillRoundedRect(x, y, w, h, r)
  // Bright crown → gold → deep belly: top-anchored falling-height bands (a gradient without a live fill).
  const bands = 8
  for (let i = 0; i < bands; i++) {
    const t = i / (bands - 1)
    const bh = h * (0.96 - 0.9 * t)
    g.fillStyle(t < 0.5 ? tokens.goldBright : tokens.gold, 0.16)
    g.fillRoundedRect(x, y, w, bh, safeR(r, w, bh))
  }
  // Deepen the very bottom for a metal belly falloff.
  g.fillStyle(tokens.goldDarkest, 0.22)
  g.fillRoundedRect(x, y + h * 0.72, w, h * 0.28, { tl: 0, tr: 0, bl: r, br: r })
  // One thin specular gloss band at ~40% height (the crown highlight of real metal).
  const glossH = Math.max(2, h * 0.09)
  g.fillStyle(tokens.glossHi, 0.5)
  g.fillRoundedRect(x + r * 0.5, y + h * 0.36, w - r, glossH, safeR(glossH / 2, w, glossH))
}

interface PillTokens {
  top: number
  bottom: number
  pedestal: number
  pedestalDeep: number
  well: number
  outline: number
  rim: number
  spec: number
  shadow: number
  emboss: string
}

/** Resolve a PillStyle's depth tokens: explicit fields win, else derive from fill/border + theme gloss. */
function resolvePillTokens(style: PillStyle): PillTokens {
  const T = getTheme()
  const F = style.fill
  const B = style.border ?? shade(F, -0.35)
  return {
    top: style.top ?? shade(F, 0.24),
    bottom: style.bottom ?? shade(F, -0.16),
    pedestal: style.pedestal ?? shade(F, -0.36),
    pedestalDeep: style.pedestalDeep ?? shade(F, -0.54),
    well: style.well ?? shade(F, -0.68),
    outline: style.outline ?? B,
    rim: style.rim ?? T.rim,
    spec: style.spec ?? T.glossHi,
    shadow: T.shadow,
    emboss: style.emboss ?? css(shade(F, -0.5)),
  }
}

/** height-derived geometry (so 56→96 all read right): pedestal depth, sink distance, corner radius. */
function pillGeom(h: number): { ext: number; press: number; r: number } {
  const ext = Math.max(5, Math.min(13, Math.round(h * 0.12)))
  return { ext, press: Math.round(ext * 0.7), r: h / 2 }
}

function pillId(style: PillStyle, w: number, h: number): string {
  const id = style.id ?? `${(style.fill & 0xffffff).toString(16)}-${((style.border ?? 0) & 0xffffff).toString(16)}`
  return `${id}:${w}x${h}`
}

/** Bake the STATIC pedestal texture (`btnbase:*`): contact shadow + 3D lip + dark top well. */
function ensureBaseTexture(scene: Phaser.Scene, key: string, w: number, h: number, tok: PillTokens): void {
  if (scene.textures.exists(key)) return
  const { ext, press, r } = pillGeom(h)
  const H = h + ext
  const texW = w + TEX_PAD * 2
  const texH = H + TEX_PAD * 2
  const ox = TEX_PAD
  const oy = TEX_PAD
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Soft contact shadow — a couple of footprint copies nudged straight down (only the bottom edge peeks out).
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(tok.shadow, 0.07)
    g.fillRoundedRect(ox, oy + i * 1.5, w, H, safeR(r, w, h))
  }
  // Pedestal: darkest outer rim (the thickness) → mid inner wall.
  g.fillStyle(tok.pedestalDeep, 1)
  g.fillRoundedRect(ox, oy, w, H, safeR(r, w, h))
  g.fillStyle(tok.pedestal, 1)
  g.fillRoundedRect(ox + 2, oy + 2, w - 4, H - 4, safeR(r - 2, w - 4, h - 4))
  // Dark interior well at the top (revealed as the cap sinks); its rounded bottom stays hidden under the cap.
  const wellH = Math.round(h * 0.6)
  // The well strips sit at the pedestal's TOP edge, so — exactly like the cap's gloss bands above —
  // each MUST be inset by its (radius − height-clamped-radius) shortfall. A short strip clamps to a
  // small radius, so its near-square top corners would poke past the cap's ROUNDED top corners as dark
  // "horns" (hidden on the dark themes where dark-on-dark masks them, obvious on the light ones). The
  // inset slides those corners inward to follow the pedestal's corner curve, tucking them under the cap.
  const wellRb = safeR(r - 4, w - 8, wellH)
  const wellIns = Math.max(0, r - 4 - wellRb)
  g.fillStyle(tok.well, 1)
  g.fillRoundedRect(ox + 4 + wellIns, oy + 3, w - 8 - wellIns * 2, wellH, wellRb)
  const wellHiH = Math.max(3, Math.round(press * 0.7))
  const hiRb = safeR(r - 4, w - 8, wellHiH)
  const hiIns = Math.max(0, r - 4 - hiRb)
  g.fillStyle(shade(tok.well, -0.35), 1)
  g.fillRoundedRect(ox + 4 + hiIns, oy + 3, w - 8 - hiIns * 2, wellHiH, hiRb)
  g.generateTexture(key, texW, texH)
  g.destroy()
}

/** Bake the glossy CAP texture (`btnface:*`): top-lit gradient + specular sheen + rim bevel + outline. */
function ensureFaceTexture(scene: Phaser.Scene, key: string, w: number, h: number, tok: PillTokens): void {
  if (scene.textures.exists(key)) return
  const r = safeR(h / 2, w, h)
  const texW = w + TEX_PAD * 2
  const texH = h + TEX_PAD * 2
  const ox = TEX_PAD
  const oy = TEX_PAD
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Base (darker bottom colour).
  g.fillStyle(tok.bottom, 1)
  g.fillRoundedRect(ox, oy, w, h, r)
  // Top-lit gradient — stacked falling-alpha `top` bands anchored to the top edge (gradient without a live fill).
  // Each short band is INSET so its (necessarily smaller-radius) top corners can't poke past the face's
  // rounded corners — otherwise the near-square corners of the short top bands read as light "ears".
  const bands = 9
  for (let i = 0; i < bands; i++) {
    const bh = h * (0.94 - 0.82 * (i / (bands - 1)))
    const rb = safeR(r, w, bh)
    const ins = Math.max(0, r - rb)
    g.fillStyle(tok.top, 0.15)
    g.fillRoundedRect(ox + ins, oy, w - ins * 2, bh, rb)
  }
  // Specular sheen, concentrated over the top ~45% (same inset guard so the sheen stays inside the cap).
  for (let i = 0; i < 5; i++) {
    const bh = h * (0.46 - i * 0.09)
    if (bh < 3) break
    const rb = safeR(r, w - 6, bh)
    const ins = Math.max(3, r - rb)
    g.fillStyle(tok.spec, 0.1)
    g.fillRoundedRect(ox + ins, oy + 2, w - ins * 2, bh, rb)
  }
  // Crisp outline + a top-biased inner rim-light (the bevel).
  g.lineStyle(2, tok.outline, 1)
  g.strokeRoundedRect(ox + 1, oy + 1, w - 2, h - 2, safeR(r - 1, w - 2, h - 2))
  g.lineStyle(1.5, tok.rim, 0.5)
  g.strokeRoundedRect(ox + 3, oy + 2, w - 6, h - 5, safeR(r - 3, w - 6, h - 5))
  g.generateTexture(key, texW, texH)
  g.destroy()
}

/** Shared shallow glossy face (NON-pressable) for read-outs — the balance pill + streak badge. */
function drawPillFace(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, style: PillStyle): void {
  const tok = resolvePillTokens(style)
  const r = safeR(h / 2, w, h)
  dropShadow(g, x, y, w, h, r, tok.shadow, { alpha: 0.08, dist: 5 })
  g.fillStyle(tok.bottom, 1)
  g.fillRoundedRect(x, y, w, h, r)
  for (let i = 0; i < 7; i++) {
    const bh = h * (0.9 - 0.8 * (i / 6))
    const rb = safeR(r, w, bh)
    const ins = Math.max(0, r - rb)
    g.fillStyle(tok.top, 0.14)
    g.fillRoundedRect(x + ins, y, w - ins * 2, bh, rb)
  }
  for (let i = 0; i < 3; i++) {
    const bh = h * (0.42 - i * 0.1)
    if (bh < 3) break
    const rb = safeR(r, w - 6, bh)
    const ins = Math.max(3, r - rb)
    g.fillStyle(tok.spec, 0.09)
    g.fillRoundedRect(x + ins, y + 2, w - ins * 2, bh, rb)
  }
  g.lineStyle(Math.max(2, Math.round(h * 0.05)), tok.outline, 1)
  g.strokeRoundedRect(x, y, w, h, r)
  g.lineStyle(1.5, tok.rim, 0.5)
  g.strokeRoundedRect(x + 2, y + 2, w - 4, h - 4, safeR(r - 2, w - 4, h - 4))
  accentRimTop(g, x, y, w, r)
}

/** Cream + gold gloss face shared by the balance read-out and the streak badge (non-pressable). */
const READOUT_STYLE: PillStyle = { id: 'readout', fill: 0xfff3d6, border: 0xf2c14e, textColor: '#4a3305' }

/** Opt-in extras for a pressable control (additive — every call site works without passing this). */
export interface PillOpts {
  /** Hero flag (PLAY / SPIN): a soft breathing glow ring behind the pedestal. */
  juice?: boolean
  /** Start dimmed + inert; toggle later via the returned container's `setDisabled`. */
  disabled?: boolean
}

/** A pressable container that also exposes `setDisabled` (Daily's spin button dims mid-spin). */
export interface PressablePill extends Phaser.GameObjects.Container {
  setDisabled?: (v: boolean) => void
}

/**
 * Core pressable: stacks glow(optional) → static base → moving `face` → hit-zone, wires the
 * press/depress on the inner `face` (never the outer container), and returns both so the caller
 * can seat its own label/icon inside `face` (so the glyph sinks with the cap).
 */
function buildPressable(
  scene: Phaser.Scene,
  x: number,
  y: number,
  w: number,
  h: number,
  style: PillStyle,
  onPress: () => void,
  opts: PillOpts = {}
): { container: PressablePill; face: Phaser.GameObjects.Container } {
  const reduced = prefersReducedMotion()
  const tok = resolvePillTokens(style)
  const { ext, press } = pillGeom(h)
  const id = pillId(style, w, h)
  ensureBaseTexture(scene, `btnbase:${id}`, w, h, tok)
  ensureFaceTexture(scene, `btnface:${id}`, w, h, tok)

  // Seat the CAP a touch above the container origin so the whole cap+pedestal composite is roughly
  // centred on (x,y) — keeps the pedestal's downward footprint close to the old flat button's, so
  // caller-positioned sub-labels underneath don't get clipped by the new 3D thickness.
  const capY = -Math.round(ext / 2)

  const container = scene.add.container(x, y) as PressablePill

  if (opts.juice && scene.textures.exists('bgglow')) {
    const glow = scene.add
      .image(0, capY, 'bgglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(shade(style.fill, 0.12))
      .setDisplaySize(w * 1.16, h * 1.95)
      .setAlpha(0.24)
    container.add(glow)
    if (!reduced) {
      scene.tweens.add({
        targets: glow,
        alpha: 0.42,
        scaleX: glow.scaleX * 1.08,
        scaleY: glow.scaleY * 1.08,
        duration: 1100,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
  }

  const baseImg = scene.add.image(0, capY + ext / 2, `btnbase:${id}`)
  const face = scene.add.container(0, capY)
  face.add(scene.add.image(0, 0, `btnface:${id}`))
  // Hit-zone grows to the ≥44pt minimum in each axis (visual art unchanged) — §E8 touch targets.
  const zone = scene.add
    .rectangle(0, capY, Math.max(w, MIN_HIT), Math.max(h, MIN_HIT), 0xffffff, 0.001)
    .setInteractive({ useHandCursor: true })
  container.add([baseImg, face, zone])

  let disabled = opts.disabled ?? false
  if (disabled) face.setAlpha(0.5)
  let pressTween: Phaser.Tweens.Tween | undefined
  const animate = (toY: number, sy: number, sx: number, dur: number, ease: string): void => {
    pressTween?.stop()
    if (reduced) {
      face.setY(toY).setScale(sx, sy)
      return
    }
    pressTween = scene.tweens.add({ targets: face, y: toY, scaleY: sy, scaleX: sx, duration: dur, ease })
  }
  const sink = (): void => {
    if (disabled) return
    animate(capY + press, 0.95, 1.02, 60, 'Quad.easeOut')
  }
  const rise = (): void => animate(capY, 1, 1, 200, 'Back.easeOut')
  // §E3 B14: the down-thock + light haptic partner the press itself (distinct from the pointerup
  // `uiTap` on release). Skipped when disabled so an inert control stays silent. Mute/haptics-gated.
  const onDown = (): void => {
    if (disabled) return
    sfx.uiPress()
    pressHaptic()
    sink()
  }
  zone.on('pointerdown', onDown)
  zone.on('pointerout', rise)
  zone.on('pointerup', () => {
    rise()
    if (disabled) return
    onPress()
  })

  container.setDisabled = (v: boolean): void => {
    disabled = v
    face.setAlpha(v ? 0.5 : 1)
    if (v) rise()
  }

  return { container, face }
}

/**
 * Pre-bake the most common button/chip signatures so the first Boot→Home paint doesn't hitch on
 * generateTexture. Optional — every helper lazily bakes on demand; this just front-loads it.
 */
export function warmButtonTextures(scene: Phaser.Scene): void {
  const sigs: Array<[PillStyle, number, number]> = [
    [GOLD_PILL, 340, 96],
    [GOLD_PILL, 300, 72],
    [GOLD_PILL, 240, 68],
    [GHOST_PILL, 280, 64],
    [GHOST_PILL, 300, 60],
    [GHOST_PILL, 84, 56],
    [GHOST_PILL, 52, 52],
    [ROSE_PILL, 340, 72],
  ]
  for (const [style, w, h] of sigs) {
    const tok = resolvePillTokens(style)
    const id = pillId(style, w, h)
    ensureBaseTexture(scene, `btnbase:${id}`, w, h, tok)
    ensureFaceTexture(scene, `btnface:${id}`, w, h, tok)
  }
}

export interface ChipPill {
  container: Phaser.GameObjects.Container
  /** Set the displayed balance, with a small scale-pop (used when a win payout lands). */
  update: (chips: number) => void
}

/**
 * Persistent chip-balance pill — the gold `chip` token + the running count (read from the save
 * on build). Chips are an earned-only reward token, so this is a read-out, never a spend button.
 * The win payout flies a chip into it and calls update() to bump the total. `compact` shrinks it
 * for the in-game HUD; the roomier default suits the Home status row.
 */
export function addChipPill(
  scene: Phaser.Scene,
  x: number,
  y: number,
  opts: { compact?: boolean } = {}
): ChipPill {
  const compact = opts.compact ?? false
  const h = compact ? 44 : 52
  const iconSize = Math.round(h * 0.66)
  const padX = compact ? 15 : 18
  const gap = compact ? 7 : 9
  const container = scene.add.container(x, y).setDepth(50)
  const g = scene.add.graphics()
  const icon = scene.add.image(0, 0, 'chip').setDisplaySize(iconSize, iconSize)
  const label = scene.add
    .text(0, 1, '', { fontFamily: FONT, fontSize: `${Math.round(h * 0.44)}px`, fontStyle: '900', color: '#4a3305' })
    .setOrigin(0, 0.5)
  container.add([g, icon, label])

  // Self-sizing: the pill background is rebuilt to fit the current count so it never clips as the
  // balance grows (cream fill + gold bezel — the "gold ghost" look, matching the streak badge).
  const redraw = (chips: number): void => {
    label.setText(chips.toLocaleString())
    const w = padX + iconSize + gap + label.width + padX
    g.clear()
    drawPillFace(g, -w / 2, -h / 2, w, h, READOUT_STYLE)
    icon.setPosition(-w / 2 + padX + iconSize / 2, 0)
    label.setPosition(icon.x + iconSize / 2 + gap, 1)
  }
  redraw(loadSave().chips)

  const update = (chips: number): void => {
    redraw(chips)
    scene.tweens.add({ targets: container, scaleX: 1.14, scaleY: 1.14, duration: 130, yoyo: true, ease: 'Quad.easeOut' })
  }

  return { container, update }
}

/**
 * Chunky, beveled, tactile button that visibly DEPRESSES into its pedestal on press. Signature is
 * unchanged (an optional trailing `opts` is additive) so every call site keeps working; `opts.juice`
 * gives PLAY/SPIN-type heroes a breathing glow ring. Returns the outer container (safe to
 * `.setDepth`/`.setVisible`/tween scale — the press animates an inner face, never this container).
 */
export function addPillButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  style: PillStyle,
  onTap: () => void,
  opts: PillOpts = {}
): Phaser.GameObjects.Container {
  const tok = resolvePillTokens(style)
  const { container, face } = buildPressable(
    scene,
    x,
    y,
    width,
    height,
    style,
    () => {
      sfx.uiTap()
      onTap()
    },
    opts
  )
  const text = scene.add
    .text(0, 0, label, { fontFamily: FONT, fontSize: `${Math.round(height * 0.42)}px`, fontStyle: '900', color: style.textColor })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, tok.emboss, 2, false, true)
  face.add(text)
  return container
}

/**
 * Shared round-chip builder — a GHOST-subtle circular twin of the pill button (same beveled
 * cap on a pedestal, same press/depress). A round chip is literally a square pill (w = h = size),
 * so it reuses the exact bake path; the glyph is seated in the moving `face` so it sinks on press.
 */
function addRoundChip(
  scene: Phaser.Scene,
  x: number,
  y: number,
  size: number,
  glyph: string,
  glyphStyle: Phaser.Types.GameObjects.Text.TextStyle,
  onPress: (icon: Phaser.GameObjects.Text) => void
): { container: Phaser.GameObjects.Container; icon: Phaser.GameObjects.Text } {
  let icon!: Phaser.GameObjects.Text
  const { container, face } = buildPressable(scene, x, y, size, size, GHOST_PILL, () => onPress(icon))
  container.setDepth(50)
  icon = scene.add.text(0, 1, glyph, glyphStyle).setOrigin(0.5)
  face.add(icon)
  return { container, icon }
}

/**
 * Round mute-toggle chip (🔊 / 🔇) styled like GHOST_PILL. Toggles + persists the
 * sfx mute flag; plays a tap only when re-enabling sound. Returns the container.
 */
export function addMuteChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const { container } = addRoundChip(
    scene,
    x,
    y,
    size,
    sfx.muted ? '🔇' : '🔊',
    { fontFamily: 'sans-serif', fontSize: `${Math.round(size * 0.5)}px` },
    (icon) => {
      const muted = sfx.toggleMuted()
      icon.setText(muted ? '🔇' : '🔊')
      if (!muted) sfx.uiTap()
    }
  )
  return container
}

/** Round "?" help chip styled like GHOST_PILL — opens the how-to-play panel. */
export function addHelpChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const { container } = addRoundChip(
    scene,
    x,
    y,
    size,
    '?',
    { fontFamily: FONT, fontSize: `${Math.round(size * 0.56)}px`, fontStyle: '900', color: GHOST_PILL.textColor },
    () => {
      sfx.uiTap()
      sfx.whoosh() // §E3 B14: airy sweep partners the panel opening
      openHelpPanel(scene)
    }
  )
  return container
}

interface HelpSection {
  icon: string
  title: string
  body: string
}

const HELP_SECTIONS: HelpSection[] = [
  { icon: 'clover', title: 'THE GOAL', body: 'Match 3+ of the same symbol in a row. Collect the goal symbols up top before your moves run out.' },
  { icon: 'diamond', title: 'MAKE A MOVE', body: 'Swipe a symbol into a neighbour, or tap two that touch, to swap. A swap only sticks if it makes a match.' },
  { icon: 'jackpot', title: 'POWER-UPS', body: 'Match 4 → Wild Reel (clears a line). L or T → Dice Bomb (3×3). Match 5 → Jackpot Chip (clears a colour).' },
  { icon: 'heart', title: 'LIVES', body: 'Losing a level costs a heart — winning is free. Out of hearts? One returns every 8 minutes.' },
  { icon: 'chip', title: 'DAILY BONUS', body: 'Spin once a day for a free boost. Come back daily to grow your streak.' },
  { icon: 'star', title: 'STARS', body: 'Finish with moves to spare for up to 3 stars. Every 10th level is a milestone.' },
  { icon: 'card', title: 'ENDLESS', body: 'After Level 30, race the weekly board — same for everyone. Beat your best score!' },
]

/**
 * How-to-play / FAQ overlay: a scrim + tall card of sections (icon + title + blurb), a GOT IT
 * button, and tap-outside-to-close. A transparent blocker over the card stops panel taps from
 * closing it. Everything lives in one container destroyed on close.
 */
export function openHelpPanel(scene: Phaser.Scene): void {
  const W = 720
  const H = 1280
  const layer = scene.add.container(0, 0).setDepth(60)

  const scrim = scene.add.rectangle(W / 2, H / 2, W, worldH(), 0x2a2417, 0.6).setInteractive()
  scrim.on('pointerup', () => { sfx.whoosh(); layer.destroy() }) // §E3 B14: tap-outside close partner

  const px = 40
  const pw = W - 80
  const pyTop = 118
  const ph = 1046
  const g = scene.add.graphics()
  dropShadow(g, px, pyTop, pw, ph, 30, getTheme().shadow, { alpha: 0.12, dist: 9 })
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)
  accentRimTop(g, px, pyTop, pw, 30, { alpha: 0.9 })

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'HOW TO PLAY', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  layer.add([scrim, g, block, title])

  const textX = px + 116
  const wrap = pw - (textX - px) - 34
  let y = pyTop + 116
  const rowH = 118
  for (const s of HELP_SECTIONS) {
    layer.add(scene.add.image(px + 66, y + 32, s.icon).setDisplaySize(52, 52))
    layer.add(
      scene.add
        .text(textX, y, s.title, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: '#2a2732' })
        .setOrigin(0, 0)
        .setLetterSpacing(1)
    )
    layer.add(
      scene.add
        .text(textX, y + 34, s.body, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '20px',
          color: '#6a6459',
          wordWrap: { width: wrap },
          lineSpacing: 4,
        })
        .setOrigin(0, 0)
    )
    y += rowH
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 72, 240, 68, 'GOT IT', GOLD_PILL, () => { sfx.whoosh(); layer.destroy() }))
  layer.add(
    scene.add
      .text(W / 2, pyTop + ph - 26, '© 2026 CorruptFun LLC · All rights reserved', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
        color: getTheme().inkFaint,
      })
      .setOrigin(0.5)
  )
}

/** Round "♪" sound chip styled like GHOST_PILL — opens the move-sound picker. */
export function addSoundChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const { container } = addRoundChip(
    scene,
    x,
    y,
    size,
    '♪',
    { fontFamily: FONT, fontSize: `${Math.round(size * 0.56)}px`, fontStyle: '900', color: GHOST_PILL.textColor },
    () => {
      sfx.uiTap()
      sfx.whoosh() // §E3 B14: airy sweep partners the panel opening
      openSoundPanel(scene)
    }
  )
  return container
}

/**
 * Move-sound picker overlay: a scrim + cream card titled "MOVE SOUND" with one
 * full-width pill per selectable swap sound. Tapping a row auditions it and
 * persists the choice, re-rendering so the gold highlight follows the selection.
 * A transparent blocker over the card stops panel taps from closing it, and a
 * DONE button (or a tap on the scrim) dismisses. Everything lives in one
 * container rebuilt on each pick and destroyed on close — mirrors openHelpPanel.
 */
export function openSoundPanel(scene: Phaser.Scene): void {
  const W = 720
  const H = 1280
  const layer = scene.add.container(0, 0).setDepth(60)

  const scrim = scene.add.rectangle(W / 2, H / 2, W, worldH(), 0x2a2417, 0.6).setInteractive()
  scrim.on('pointerup', () => { sfx.whoosh(); layer.destroy() }) // §E3 B14: tap-outside close partner

  const px = 40
  const pw = W - 80
  const ph = 640
  const pyTop = (H - ph) / 2
  const g = scene.add.graphics()
  dropShadow(g, px, pyTop, pw, ph, 30, getTheme().shadow, { alpha: 0.12, dist: 9 })
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)
  accentRimTop(g, px, pyTop, pw, 30, { alpha: 0.9 })

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'MOVE SOUND', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  const subtitle = scene.add
    .text(W / 2, pyTop + 104, 'Tap to hear — pick your favourite.', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '22px',
      color: '#6a6459',
    })
    .setOrigin(0.5)
  layer.add([scrim, g, block, title, subtitle])

  let y = pyTop + 176
  const rowH = 96
  for (const s of SWAP_SOUNDS) {
    const selected = s === sfx.swapSound
    layer.add(
      addPillButton(scene, W / 2, y, pw - 80, 72, SWAP_SOUND_LABELS[s], selected ? GOLD_PILL : GHOST_PILL, () => {
        sfx.previewSwap(s) // audition
        sfx.setSwapSound(s) // persist
        // Rebuild so the gold highlight moves to the tapped row.
        layer.destroy()
        openSoundPanel(scene)
      })
    )
    y += rowH
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 72, 240, 68, 'DONE', GOLD_PILL, () => { sfx.whoosh(); layer.destroy() }))
}

/**
 * A compact preview of a theme drawn purely from ITS OWN tokens: a soft wash gradient with a warm
 * glow smudge and a few signature accent dots (gold / accent / accentAlt). Used both as the theme
 * chip's icon (the active theme) and inside each picker row (that row's TARGET theme), so every
 * swatch reads accurately for the look it represents. Returns a Graphics centred on its own origin
 * (seat it in a container / pressable `face`). Cards/bezel are never previewed — those stay cream.
 */
function makeThemeSwatch(scene: Phaser.Scene, T: Theme, w: number, h: number, accents = 3): Phaser.GameObjects.Graphics {
  const g = scene.add.graphics()
  const r = Math.max(3, Math.min(12, h * 0.24))
  const x = -w / 2
  const y = -h / 2
  // Wash: solid bottom colour, then falling-height top-colour bands blend up toward the top edge
  // (same top-lit technique as the button gloss) — reads as a soft vertical wash, light OR dark.
  g.fillStyle(T.washBottom, 1)
  g.fillRoundedRect(x, y, w, h, r)
  const bands = 7
  for (let i = 0; i < bands; i++) {
    const bh = Math.max(1, h * (0.94 - 0.86 * (i / (bands - 1))))
    g.fillStyle(T.washTop, 0.16)
    g.fillRoundedRect(x, y, w, bh, safeR(r, w, bh))
  }
  // Warm glow smudge near the top — the wash's warm glow token, for a little life.
  g.fillStyle(T.washGlowWarm, 0.5)
  g.fillCircle(x + w * 0.32, y + h * 0.34, h * 0.14)
  // Signature accent dots along the lower third (the theme's colour swing).
  const dots = [T.gold, T.accent, T.accentAlt]
  const n = Math.max(1, Math.min(accents, dots.length))
  const dr = h * 0.14
  const gap = dr * 2.7
  const startX = -((n - 1) * gap) / 2
  for (let i = 0; i < n; i++) {
    g.fillStyle(dots[i], 1)
    g.fillCircle(startX + i * gap, h * 0.24, dr)
    g.lineStyle(1, T.washTop, 0.4)
    g.strokeCircle(startX + i * gap, h * 0.24, dr)
  }
  // Gold bezel frame — the swatch reads as a little framed screen.
  g.lineStyle(Math.max(1.5, h * 0.05), T.goldBezel, 0.9)
  g.strokeRoundedRect(x, y, w, h, r)
  return g
}

/**
 * One picker row: a full-width pressable pill carrying the theme's swatch preview + name + feel.
 * The active theme is a GOLD_PILL highlight; unlocked-inactive is GHOST_PILL; locked renders at
 * α 0.55 with the baked `lock` texture + "Reach Level N" and only nudges on tap (no apply). Tapping
 * an unlocked, inactive row fires `onPick`. Built via `buildPressable` so the whole face sinks as a
 * tactile cap.
 */
function buildThemeRow(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  w: number,
  h: number,
  id: ThemeId,
  save: SaveData,
  reduced: boolean,
  onPick: () => void
): Phaser.GameObjects.Container {
  const unlocked = themeUnlocked(id, save)
  const active = id === getThemeId()
  const T = THEMES[id]
  const meta = THEME_META[id]
  const style = active ? GOLD_PILL : GHOST_PILL

  const { container, face } = buildPressable(scene, cx, cy, w, h, style, () => {
    sfx.uiTap()
    if (!unlocked) {
      // Gentle "locked" nudge — no theme change.
      if (!reduced) {
        scene.tweens.add({ targets: face, x: 6, duration: 55, yoyo: true, repeat: 3, ease: 'Sine.easeInOut', onComplete: () => face.setX(0) })
      }
      return
    }
    if (active) return // already the active theme — no-op
    onPick()
  })

  const padX = 26
  const swW = h * 0.72
  const swatch = makeThemeSwatch(scene, T, swW, swW, 3)
  swatch.setPosition(-w / 2 + padX + swW / 2, 0)
  face.add(swatch)

  const textX = -w / 2 + padX + swW + 22
  const name = scene.add
    .text(textX, -14, meta.name, { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: active ? '#4a3305' : '#2a2732' })
    .setOrigin(0, 0.5)
    .setLetterSpacing(1)
  const feel = scene.add
    .text(textX, 20, meta.feel, { fontFamily: 'Arial, sans-serif', fontSize: '20px', color: active ? '#7a5a12' : '#6a6459' })
    .setOrigin(0, 0.5)
  face.add([name, feel])

  const rightX = w / 2 - padX
  if (!unlocked) {
    const lock = scene.add.image(rightX - 8, -12, 'lock').setDisplaySize(34, 34)
    const req = scene.add
      .text(rightX, 22, `Reach Level ${meta.unlockLevel}`, { fontFamily: FONT, fontSize: '18px', fontStyle: '900', color: '#a8213c' })
      .setOrigin(1, 0.5)
    face.add([lock, req])
    face.setAlpha(0.55)
  } else if (active) {
    const badge = scene.add
      .text(rightX, 0, 'ACTIVE', { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: '#4a3305' })
      .setOrigin(1, 0.5)
      .setLetterSpacing(1)
    face.add(badge)
  }

  return container
}

/**
 * Round theme-picker chip styled like GHOST_PILL, but its "glyph" is a live tri-colour swatch of
 * the ACTIVE theme (wash + gold + accent) so the chip itself previews the current look. Opens the
 * picker on tap. Built via `buildPressable` directly (not `addRoundChip`) so the icon can be a
 * Graphics swatch instead of text.
 */
export function addThemeChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const { container, face } = buildPressable(scene, x, y, size, size, GHOST_PILL, () => {
    sfx.uiTap()
    sfx.whoosh() // §E3 B14: airy sweep partners the panel opening
    openThemePanel(scene)
  })
  container.setDepth(50)
  face.add(makeThemeSwatch(scene, getTheme(), size * 0.52, size * 0.52, 2))
  return container
}

/**
 * Theme-picker overlay (§3e): a scrim + cream card titled "THEME" with one row per theme in
 * `THEME_ORDER`. Each row shows the theme's name + feel and an accurate swatch drawn from THAT
 * theme's own tokens. The active row is a gold highlight; locked rows render dim (α 0.55) with a
 * lock icon + "Reach Level N" and only nudge on tap. Picking an unlocked theme persists it
 * (`setTheme`) and rebuilds the panel in place so the highlight + swatches follow the choice.
 *
 * Apply model (§2.4): the theme id at FIRST open is threaded through rebuilds via `openingThemeId`;
 * on CLOSE, if it changed, the calling scene restarts so its art repaints in the new wash — no live
 * re-tint (boot textures are never re-baked and read fine on every theme). Mirrors `openSoundPanel`.
 */
export function openThemePanel(scene: Phaser.Scene, openingThemeId: ThemeId = getThemeId()): void {
  const W = 720
  const H = 1280
  const reduced = prefersReducedMotion()
  const save = loadSave()
  const layer = scene.add.container(0, 0).setDepth(60)

  const px = 40
  const pw = W - 80
  const ph = 792
  const pyTop = (H - ph) / 2

  const scrim = scene.add.rectangle(W / 2, H / 2, W, worldH(), 0x2a2417, 0.6).setInteractive()
  const close = (): void => {
    sfx.whoosh() // §E3 B14: airy sweep partners the panel closing
    const changed = getThemeId() !== openingThemeId
    layer.destroy()
    if (changed) scene.scene.restart()
  }
  scrim.on('pointerup', close)

  const g = scene.add.graphics()
  dropShadow(g, px, pyTop, pw, ph, 30, getTheme().shadow, { alpha: 0.12, dist: 9 })
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)
  accentRimTop(g, px, pyTop, pw, 30, { alpha: 0.9 })

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'THEME', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  const subtitle = scene.add
    .text(W / 2, pyTop + 104, "Dress up the room — every look's on the house.", {
      fontFamily: 'Arial, sans-serif',
      fontSize: '22px',
      color: '#6a6459',
    })
    .setOrigin(0.5)
  layer.add([scrim, g, block, title, subtitle])

  const rowW = pw - 80
  const rowH = 116
  let y = pyTop + 194
  for (const id of THEME_ORDER) {
    layer.add(
      buildThemeRow(scene, W / 2, y, rowW, rowH, id, save, reduced, () => {
        setTheme(id) // persist + repaint page chrome now; art repaints on close-if-changed
        // Rebuild so the gold highlight + chip swatch follow the pick (openingThemeId preserved).
        layer.destroy()
        openThemePanel(scene, openingThemeId)
      })
    )
    y += 128
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 66, 240, 68, 'DONE', GOLD_PILL, close))
}

/** Round "⚙" settings chip styled like GHOST_PILL — opens the accessibility settings panel. */
export function addSettingsChip(scene: Phaser.Scene, x: number, y: number, size = 52): Phaser.GameObjects.Container {
  const { container } = addRoundChip(
    scene,
    x,
    y,
    size,
    '⚙',
    { fontFamily: 'sans-serif', fontSize: `${Math.round(size * 0.52)}px`, color: GHOST_PILL.textColor },
    () => {
      sfx.uiTap()
      sfx.whoosh() // §E3 B14: airy sweep partners the panel opening
      openSettingsPanel(scene)
    }
  )
  return container
}

interface ToggleConfig {
  label: string
  sub: string
  /** Read the CURRENT displayed state (ON = true). */
  get: () => boolean
  /** Persist a new state via the matching authority (theme.ts a11y setters / setHcBoard). */
  set: (v: boolean) => void
}

/**
 * One settings toggle row: a soft cream card with a label + sub-descriptor on the left and a pill
 * slider on the right (gold + knob-right + "ON" when enabled, grey + knob-left + "OFF" when off). A
 * transparent hit-zone over the whole row flips it — persisting via `cfg.set` and re-skinning the
 * slider in place (no panel rebuild). The knob glide is reduced-motion gated (static snap otherwise).
 */
function buildToggleRow(
  scene: Phaser.Scene,
  layer: Phaser.GameObjects.Container,
  cx: number,
  cy: number,
  w: number,
  h: number,
  cfg: ToggleConfig,
  reduced: boolean
): void {
  const T = getTheme()

  const bg = scene.add.graphics()
  bg.fillStyle(T.cardFillAlt, 1)
  bg.fillRoundedRect(cx - w / 2, cy - h / 2, w, h, 22)
  bg.lineStyle(2, T.border, 1)
  bg.strokeRoundedRect(cx - w / 2, cy - h / 2, w, h, 22)
  layer.add(bg)

  const lx = cx - w / 2 + 30
  layer.add(
    scene.add
      .text(lx, cy - 13, cfg.label, { fontFamily: FONT, fontSize: '27px', fontStyle: '900', color: T.ink })
      .setOrigin(0, 0.5)
  )
  layer.add(
    scene.add.text(lx, cy + 19, cfg.sub, { fontFamily: 'Arial, sans-serif', fontSize: '18px', color: T.inkMuted }).setOrigin(0, 0.5)
  )

  // Pill slider on the right edge of the row.
  const tw = 92
  const th = 46
  const tx = cx + w / 2 - 30 - tw / 2 // track centre
  const knobR = 18
  const knobOnX = tx + tw / 2 - knobR - 5
  const knobOffX = tx - tw / 2 + knobR + 5

  const track = scene.add.graphics()
  const stateText = scene.add.text(tx, cy, '', { fontFamily: FONT, fontSize: '16px', fontStyle: '900' }).setOrigin(0.5)
  const knob = scene.add.circle(knobOffX, cy, knobR, 0xffffff).setStrokeStyle(2, T.border, 1)
  layer.add([track, stateText, knob])

  let state = cfg.get()
  const paint = (animate: boolean): void => {
    track.clear()
    track.fillStyle(state ? GOLD_PILL.fill : 0xd8cfba, 1)
    track.fillRoundedRect(tx - tw / 2, cy - th / 2, tw, th, th / 2)
    track.lineStyle(2, state ? getTheme().goldDeep : T.border, 1)
    track.strokeRoundedRect(tx - tw / 2, cy - th / 2, tw, th, th / 2)
    stateText.setText(state ? 'ON' : 'OFF')
    stateText.setColor(state ? '#4a3305' : css(0x8a8577))
    stateText.setX(state ? tx - 15 : tx + 16)
    const kx = state ? knobOnX : knobOffX
    if (animate && !reduced) {
      scene.tweens.add({ targets: knob, x: kx, duration: 130, ease: 'Quad.easeOut' })
    } else {
      knob.setX(kx)
    }
  }
  paint(false)

  const zone = scene.add.rectangle(cx, cy, w, h, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  zone.on('pointerup', () => {
    sfx.uiTap()
    state = !state
    cfg.set(state)
    paint(true)
  })
  layer.add(zone)
}

/**
 * Settings / Accessibility overlay (§E8): a scrim + cream card titled "SETTINGS" with five labelled
 * ON/OFF toggle rows — Reduce Motion, Reduce Flashing, Haptics, High-Contrast Board, Ambient sound.
 * Each row reads its live pref and persists on tap via the shared authority. Restart-affecting toggles (Reduce
 * Motion + High-Contrast Board change the CURRENT paint) are snapshotted at open; on CLOSE, if either
 * changed, the calling scene restarts so its art repaints — mirroring the theme picker's pattern.
 * Reduce Flashing / Haptics are read live at effect time, so they need no restart.
 */
export function openSettingsPanel(scene: Phaser.Scene): void {
  const W = 720
  const H = 1280
  const reduced = prefersReducedMotion()
  const layer = scene.add.container(0, 0).setDepth(60)

  const px = 40
  const pw = W - 80
  // Height sized for FIVE toggle rows above DONE: rows start pyTop+176, step 104 → last row centre
  // pyTop+592 (bottom pyTop+637); DONE at pyTop+ph-62 (top edge pyTop+ph-96) clears it with ph=800.
  const ph = 800
  const pyTop = (H - ph) / 2 // stays vertically centred: (1280-800)/2 = 240px margins

  // Snapshot the restart-affecting prefs at open (raw in-app reduce-motion + HC board).
  const startedRM = rawReduceMotionPref()
  const startedHC = hcBoard()

  const scrim = scene.add.rectangle(W / 2, H / 2, W, worldH(), 0x2a2417, 0.6).setInteractive()
  const close = (): void => {
    sfx.whoosh() // §E3 B14: airy sweep partners the panel closing
    const changed = rawReduceMotionPref() !== startedRM || hcBoard() !== startedHC
    layer.destroy()
    if (changed) scene.scene.restart()
  }
  scrim.on('pointerup', close)

  const g = scene.add.graphics()
  dropShadow(g, px, pyTop, pw, ph, 30, getTheme().shadow, { alpha: 0.12, dist: 9 })
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)
  accentRimTop(g, px, pyTop, pw, 30, { alpha: 0.9 })

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(W / 2, pyTop + 56, 'SETTINGS', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  const subtitle = scene.add
    .text(W / 2, pyTop + 104, 'Make it comfortable to play.', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '22px',
      color: '#6a6459',
    })
    .setOrigin(0.5)
  layer.add([scrim, g, block, title, subtitle])

  const rows: ToggleConfig[] = [
    { label: 'Reduce Motion', sub: 'Calm the animations', get: rawReduceMotionPref, set: setReduceMotion },
    { label: 'Reduce Flashing', sub: 'Soften flashes & impacts', get: reduceFlashing, set: setReduceFlashing },
    { label: 'Haptics', sub: 'Vibrate on big moments', get: () => !hapticsOff(), set: v => setHapticsOff(!v) },
    { label: 'High-Contrast Board', sub: 'Bolder tiles & outlines', get: hcBoard, set: setHcBoard },
    // §E3-A2 — unlock the built-but-unreached ambient bed. Default OFF (sfx.ambience); toggling it
    // starts/stops the warm per-theme lounge pad and persists exactly like mute.
    { label: 'Ambient sound', sub: 'Warm lounge music', get: () => sfx.ambience, set: () => sfx.toggleAmbience() },
  ]
  const rowW = pw - 80
  const rowH = 90
  let y = pyTop + 176
  for (const cfg of rows) {
    buildToggleRow(scene, layer, W / 2, y, rowW, rowH, cfg, reduced)
    y += 104
  }

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 62, 240, 68, 'DONE', GOLD_PILL, close))
}

/**
 * First-run onboarding (§E14): a gentle, dismissible teach-card ("Swipe two neighbours to line up 3
 * or more") shown ONCE for a truly-new player — the caller owns the `seenIntro`/`unlocked` gate and
 * marks it seen. A soft cream+gold card (help-panel recipe) with a three-in-a-row example, a GOT IT
 * button, and tap-outside-to-close. Pops in with a Back overshoot unless reduced motion (then static).
 * `onClose` lets the caller (GameScene) drop its input guard when the card is dismissed.
 */
export function openOnboarding(scene: Phaser.Scene, onClose?: () => void): void {
  const W = 720
  const H = 1280
  const reduced = prefersReducedMotion()
  const layer = scene.add.container(0, 0).setDepth(65)

  const cx = W / 2
  const cy = 560
  const cardW = 600
  const cardH = 520

  const scrim = scene.add.rectangle(W / 2, H / 2, W, worldH(), 0x2a2417, 0.6).setInteractive()
  const close = (): void => {
    layer.destroy()
    onClose?.()
  }
  scrim.on('pointerup', close)

  const g = scene.add.graphics()
  dropShadow(g, cx - cardW / 2, cy - cardH / 2, cardW, cardH, 30, getTheme().shadow, { alpha: 0.14, dist: 9 })
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, 30)
  accentRimTop(g, cx - cardW / 2, cy - cardH / 2, cardW, 30, { alpha: 0.9 })

  // Blocker so taps on the card don't fall through to the scrim (which closes).
  const block = scene.add.rectangle(cx, cy, cardW, cardH, 0xffffff, 0.001).setInteractive()

  const title = scene.add
    .text(cx, cy - cardH / 2 + 66, 'HOW TO PLAY', { fontFamily: FONT, fontSize: '44px', fontStyle: '900', color: '#c9930a' })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)

  // A three-in-a-row example so the goal reads at a glance (uses the baked icon textures).
  const iconSize = 78
  const gap = 22
  const row = ['diamond', 'diamond', 'diamond']
  const rowW = row.length * iconSize + (row.length - 1) * gap
  const startX = cx - rowW / 2 + iconSize / 2
  const iconY = cy - 44
  const icons: Phaser.GameObjects.Image[] = []
  row.forEach((k, i) => {
    icons.push(scene.add.image(startX + i * (iconSize + gap), iconY, k).setDisplaySize(iconSize, iconSize))
  })

  const body = scene.add
    .text(cx, cy + 64, 'Swipe two neighbours to line up 3 or more of the same symbol. Clear the goals up top before your moves run out.', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '23px',
      color: '#6a6459',
      align: 'center',
      wordWrap: { width: cardW - 96 },
      lineSpacing: 6,
    })
    .setOrigin(0.5)

  layer.add([scrim, g, block, title, ...icons, body])
  layer.add(addPillButton(scene, cx, cy + cardH / 2 - 58, 260, 68, 'GOT IT', GOLD_PILL, close))

  if (!reduced) {
    layer.setScale(0.9).setAlpha(0)
    scene.tweens.add({ targets: layer, scale: 1, alpha: 1, duration: 300, ease: 'Back.easeOut' })
  }
}

import Phaser from 'phaser'
import { SWAP_SOUNDS, SWAP_SOUND_LABELS, sfx } from '../audio/sfx'
import { LIVES_MAX } from '../config'
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
  prefersReducedMotion,
  setTheme,
  themeUnlocked,
} from './theme'
import type { Theme, ThemeId } from './theme'

export const FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif'

/**
 * Warm cream cross-fade between scenes (§3d). Locks input during the fade (which doubles as an
 * anti-double-tap guard), fades the camera to brand cream (#fffdf8 — NEVER black), and starts
 * the destination scene once the fade-out completes. Each scene's create() pairs this with a
 * matching `this.cameras.main.fadeIn(...)` at the top. Reduced-motion shortens the fade.
 */
export function startScene(from: Phaser.Scene, key: string, data?: object): void {
  if (!from.input.enabled) return // already transitioning
  from.input.enabled = false
  const dur = prefersReducedMotion() ? 90 : 180
  const cam = from.cameras.main
  cam.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => from.scene.start(key, data))
  cam.fadeOut(dur, 255, 253, 248)
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
  const update = (state: LivesState): void => {
    hearts.forEach((heart, i) => {
      const filled = i < state.lives
      heart.setAlpha(filled ? 1 : 0.24)
      if (filled) heart.clearTint()
      else heart.setTint(0x7a7266)
    })
    if (timer) timer.setText(state.full ? '' : `next life  ${formatCountdown(state.nextInMs)}`)
  }
  return { container, update }
}

/** Two-tone marquee title with a heart flourish, centered. */
export function addMarquee(scene: Phaser.Scene, centerX: number, y: number): void {
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
  const heart = scene.add.image(maya.x + maya.width + 12 + heartW / 2, y - 14, 'heart')
  heart.setDisplaySize(heartW, heartW)
  scene.tweens.add({
    targets: heart,
    scale: heart.scaleX * 1.18,
    duration: 700,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
  })

  // Slow light-sweep shine: a masked cream gloss that periodically glides VIVA→MAYA. Each word
  // gets its own streak clipped to its glyphs (bitmap mask), and the two share one tween value so
  // the highlight reads as a single continuous band travelling across the whole wordmark. Skipped
  // under reduced motion.
  if (!prefersReducedMotion()) {
    const spanLeft = viva.x
    const spanRight = maya.x + maya.width
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

/** Radius clamped to never exceed half the smallest side (avoids Phaser arc artifacts). */
function safeR(r: number, w: number, h: number): number {
  return Math.max(1, Math.min(r, w / 2, h / 2))
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
    g.fillRoundedRect(ox, oy + i * 1.5, w, H, r)
  }
  // Pedestal: darkest outer rim (the thickness) → mid inner wall.
  g.fillStyle(tok.pedestalDeep, 1)
  g.fillRoundedRect(ox, oy, w, H, r)
  g.fillStyle(tok.pedestal, 1)
  g.fillRoundedRect(ox + 2, oy + 2, w - 4, H - 4, safeR(r - 2, w - 4, H - 4))
  // Dark interior well at the top (revealed as the cap sinks); its rounded bottom stays hidden under the cap.
  const wellH = Math.round(h * 0.6)
  g.fillStyle(tok.well, 1)
  g.fillRoundedRect(ox + 4, oy + 3, w - 8, wellH, safeR(r - 4, w - 8, wellH))
  g.fillStyle(shade(tok.well, -0.35), 1)
  g.fillRoundedRect(ox + 4, oy + 3, w - 8, Math.max(3, Math.round(press * 0.7)), safeR(r - 4, w - 8, wellH))
  g.generateTexture(key, texW, texH)
  g.destroy()
}

/** Bake the glossy CAP texture (`btnface:*`): top-lit gradient + specular sheen + rim bevel + outline. */
function ensureFaceTexture(scene: Phaser.Scene, key: string, w: number, h: number, tok: PillTokens): void {
  if (scene.textures.exists(key)) return
  const r = h / 2
  const texW = w + TEX_PAD * 2
  const texH = h + TEX_PAD * 2
  const ox = TEX_PAD
  const oy = TEX_PAD
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Base (darker bottom colour).
  g.fillStyle(tok.bottom, 1)
  g.fillRoundedRect(ox, oy, w, h, r)
  // Top-lit gradient — stacked falling-alpha `top` bands anchored to the top edge (gradient without a live fill).
  const bands = 9
  for (let i = 0; i < bands; i++) {
    const bh = h * (0.94 - 0.82 * (i / (bands - 1)))
    g.fillStyle(tok.top, 0.15)
    g.fillRoundedRect(ox, oy, w, bh, safeR(r, w, bh))
  }
  // Specular sheen, concentrated over the top ~45%.
  for (let i = 0; i < 5; i++) {
    const bh = h * (0.46 - i * 0.09)
    if (bh < 3) break
    g.fillStyle(tok.spec, 0.1)
    g.fillRoundedRect(ox + 3, oy + 2, w - 6, bh, safeR(r, w - 6, bh))
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
  const r = h / 2
  g.fillStyle(tok.shadow, 0.18)
  g.fillRoundedRect(x, y + 4, w, h, r)
  g.fillStyle(tok.bottom, 1)
  g.fillRoundedRect(x, y, w, h, r)
  for (let i = 0; i < 7; i++) {
    const bh = h * (0.9 - 0.8 * (i / 6))
    g.fillStyle(tok.top, 0.14)
    g.fillRoundedRect(x, y, w, bh, safeR(r, w, bh))
  }
  for (let i = 0; i < 3; i++) {
    const bh = h * (0.42 - i * 0.1)
    if (bh < 3) break
    g.fillStyle(tok.spec, 0.09)
    g.fillRoundedRect(x + 3, y + 2, w - 6, bh, safeR(r, w - 6, bh))
  }
  g.lineStyle(Math.max(2, Math.round(h * 0.05)), tok.outline, 1)
  g.strokeRoundedRect(x, y, w, h, r)
  g.lineStyle(1.5, tok.rim, 0.5)
  g.strokeRoundedRect(x + 2, y + 2, w - 4, h - 4, safeR(r - 2, w - 4, h - 4))
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
  const zone = scene.add.rectangle(0, capY, w, h, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
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
  zone.on('pointerdown', sink)
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

  const scrim = scene.add.rectangle(W / 2, H / 2, W, H, 0x2a2417, 0.6).setInteractive()
  scrim.on('pointerup', () => layer.destroy())

  const px = 40
  const pw = W - 80
  const pyTop = 118
  const ph = 1046
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.3)
  g.fillRoundedRect(px + 4, pyTop + 8, pw, ph, 30)
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)

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

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 72, 240, 68, 'GOT IT', GOLD_PILL, () => layer.destroy()))
  layer.add(
    scene.add
      .text(W / 2, pyTop + ph - 26, '© 2026 CorruptFun LLC · All rights reserved', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
        color: '#b3ab97',
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

  const scrim = scene.add.rectangle(W / 2, H / 2, W, H, 0x2a2417, 0.6).setInteractive()
  scrim.on('pointerup', () => layer.destroy())

  const px = 40
  const pw = W - 80
  const ph = 640
  const pyTop = (H - ph) / 2
  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.3)
  g.fillRoundedRect(px + 4, pyTop + 8, pw, ph, 30)
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)

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

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 72, 240, 68, 'DONE', GOLD_PILL, () => layer.destroy()))
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

  const scrim = scene.add.rectangle(W / 2, H / 2, W, H, 0x2a2417, 0.6).setInteractive()
  const close = (): void => {
    const changed = getThemeId() !== openingThemeId
    layer.destroy()
    if (changed) scene.scene.restart()
  }
  scrim.on('pointerup', close)

  const g = scene.add.graphics()
  g.fillStyle(0x8a7a52, 0.3)
  g.fillRoundedRect(px + 4, pyTop + 8, pw, ph, 30)
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(px, pyTop, pw, ph, 30)
  g.lineStyle(4, 0xf2c14e, 1)
  g.strokeRoundedRect(px, pyTop, pw, ph, 30)

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

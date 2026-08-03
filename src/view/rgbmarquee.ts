/**
 * RGB marquee ring (§RGB) — the fluid, pulsing band of light that runs the perimeter of the
 * game-board and Lucky Slots cabinets, replacing the discrete red/gold and gold/rose bulb chases
 * those frames used to wear.
 *
 * IT IS A TUBE, NOT LAMPS. That distinction drives the whole build. The ring is laid out as dozens
 * of `rgbnode` light atoms sampled along the bezel path at roughly HALF their own radius and blended
 * ADDITIVELY, so their falloffs sum into one continuous bar — at no point is an individual node
 * visible as a bead. `core/rgb.ts` samples the path at even ARC LENGTH (not a fixed count per edge),
 * which is what keeps the tube's brightness uniform through the corners instead of clumping there
 * the way the old bulb ring did.
 *
 * IT LIGHTS THE GOLD, rather than sitting on top of it. Three stacked layers give the border real
 * depth: a dark GROOVE baked once into the bezel (the channel the light sits down inside), a wide
 * soft HALO spilling onto the gold either side of it, and a narrow hot CORE — the filament itself.
 * The halo is what makes the gold frame read as *lit by* the ring rather than merely adjacent to it.
 *
 * WHY THIS SHAPE (perf). The old chases spent one looping tween PER BULB — 48 on the board, 32 on
 * the slots. Everything here is driven from ONE `UPDATE` hook that walks the node array and writes
 * tint + alpha, so the app runs 80 fewer tweens than before this feature existed. The node count is
 * scaled by the quality governor and tint writes are thinned on demoted devices, so a low-tier phone
 * draws a coarser tube rather than a slower one.
 *
 * WHY NO SHADER. The game is `Phaser.AUTO` and ships no custom pipelines, so a fragment shader would
 * strand the Canvas fallback entirely. Additive sprite accumulation gets the same fluid gradient on
 * both renderers, and three.js is fenced to `view3d/stage.ts` by design.
 *
 * COLOUR IS PER THEME, not one global rainbow. `rgbHueFrom` / `rgbHueSpan` / `rgbSat` come off the
 * active theme, and NO theme takes the full wheel — every arc is cut to that theme's own accents, so
 * the ring can never put a green section on the valentine wash. Measured 2026-08-03, and each arc
 * spans exactly the two colours the theme already uses:
 *
 *   Golden Hour   345° → 55°  (span  70, sat 0.80)   crimson → red → orange → gold
 *   Maya's Heart  310° → 20°  (span  70, sat 0.72)   magenta → rose → coral
 *   Rose Midnight 340° → 50°  (span  70, sat 0.85)   crimson → orange → gold
 *   Neon Vegas    185° → 340° (span 155, sat 0.95)   cyan → blue → violet → magenta
 *
 * A sub-360 arc ping-pongs rather than wrapping, so the ring closes with no seam; the `span >= 360`
 * branch in `ringHue` is the wrapping path and is currently unused by every theme. The theme is read
 * at ATTACH time, so a theme swap only repaints because the picker restarts the scene (ui.ts's
 * close-if-changed) — a live re-tint would need this to re-read `getTheme()`.
 *
 * ACCESSIBILITY. Reduced motion paints the arc ONCE and never ticks — you keep the colour, you lose
 * the travel (a hue gradient is not vestibular motion). Reduce-flashing clamps the lap slow and
 * floors the brightness swing, so it breathes instead of strobing. Both are checked live per attach.
 *
 * The colour + path maths lives in `core/rgb.ts`, Phaser-free and unit-tested (`core/rgb.test.ts`) —
 * importing Phaser into a Vitest `node` run dies on `window`, and the ring's load-bearing properties
 * (a seamless closed loop, an arc that never leaves its band, even arc-length spacing) are pure.
 */
import Phaser from 'phaser'
import { frac, hsvToInt, ringAlpha, ringHue, roundedRectPath } from '../core/rgb'
import { quality, type QualityTier } from './quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from './theme'

/** What the ring is currently doing. The slots drive all four; the board lives in `idle` + surges. */
export type RgbMode = 'idle' | 'spin' | 'heat' | 'win'

// ---------------------------------------------------------------------------
// Mode profiles
// ---------------------------------------------------------------------------

interface ModeProfile {
  /** ms for one full lap of the ring. */
  lapMs: number
  /** floor / ceiling of the travelling brightness wave. */
  lo: number
  hi: number
  /** bright crests riding the ring at once. */
  waves: number
  /** multiplier on the theme's hue span — `heat` narrows it so the whole ring burns one family. */
  spanScale: number
}

const PROFILES: Record<RgbMode, ModeProfile> = {
  // `lo`/`hi` are the HALO's swing, not the band's — see BAND_MIN. The halo can swing hard because
  // it is additive glow: at its floor it simply stops spilling onto the gold, which reads as the
  // light being further away rather than as the tube going out.
  //
  // The resting cabinet: one slow swell travelling the frame, colour drifting the whole way round.
  idle: { lapMs: 3600, lo: 0.3, hi: 1, waves: 1, spanScale: 1 },
  // Reels running — the lap roughly doubles and a second crest joins it.
  spin: { lapMs: 1500, lo: 0.24, hi: 1, waves: 2, spanScale: 1 },
  // The tension beat: fastest lap, and the arc collapses to ~45% so the ring stops sweeping its
  // whole range and burns one hot colour — the same job the old all-rose HEAT pass did.
  heat: { lapMs: 780, lo: 0.2, hi: 1, waves: 2, spanScale: 0.45 },
  // Payout: three crests at speed, full arc — the ring reads as celebrating rather than working.
  win: { lapMs: 900, lo: 0.18, hi: 1, waves: 3, spanScale: 1 },
}

/** Reduce-flashing (§E8) floors: no lap quicker than this, and never a swing below this alpha. */
const FLASH_MIN_LAP = 1600
const FLASH_MIN_LO = 0.72

/**
 * How often tints are actually WRITTEN, per quality tier. The phase keeps advancing off real delta
 * either way — this only thins the writes, so a demoted device gets a slightly chunkier colour
 * gradient rather than a slower or stuttering ring. `high` writes every frame.
 */
const TIER_STEP_MS: Record<QualityTier, number> = { high: 0, med: 24, low: 50 }

/**
 * Spacing between light nodes, as a fraction of the tube's thickness, per tier.
 *
 * Node spacing does NOT set smoothness here — `ALONG_OVERLAP` does, because each node is stretched
 * along the path rather than left circular. That separation is the whole trick: a circular node has
 * to be packed at well under its own radius to avoid scalloping into beads, which on the board's
 * ~2 580px perimeter meant north of 400 sprites. Stretching instead lets the spacing triple with
 * the overlap held constant, so these values buy back sprite count at zero visual cost.
 */
const TIER_SPACING: Record<QualityTier, number> = { high: 1.3, med: 1.7, low: 2.3 }

/**
 * How far each node is stretched ALONG the path, as a multiple of the spacing. At 2.4 every point on
 * the tube is covered by more than two nodes' soft bodies, which is what keeps the band continuous
 * and its edges clean. Lower this and the beading in the tube's skirt comes straight back.
 */
const ALONG_OVERLAP = 2.4

/** Idle governor (A2): a left-open PWA slows the lap and dims the ring rather than burning battery. */
const IDLE_LAP_SCALE = 1.7
const IDLE_DIM = 0.72

/** How long a `surge()` takes to decay back to the resting profile. */
const SURGE_MS = 900

/** Longest frame the lap will advance by — caps a tab-resume spike without stalling a slow device. */
const MAX_STEP_MS = 100

/**
 * Floor on the BAND's tint value. Deliberately high, and the pulse is carried by the halo instead.
 *
 * The band's brightness IS its tint value, so swinging it wide drags every hue down its value ramp —
 * and a dark yellow is not "dim gold", it is olive. The gold half of the warm themes' arcs turned to
 * mud on the dim side of the wave. Holding the band between 0.86 and 1 keeps every hue reading as
 * the colour it is, while the additive halo swings the full range and does the visible pulsing.
 */
const BAND_MIN = 0.86

/** One node lights this many times its own spacing on the halo layer — the spill onto the gold. */
const HALO_EVERY = 3

/** The milled channel's own colour — a dark warm brown, never black, so it stays in the gold family. */
const GROOVE_INK = 0x241804

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/** Geometry of the light channel: the rounded rect its CENTRELINE follows. */
export interface RgbRingGeom {
  x: number
  y: number
  w: number
  h: number
  /** Corner radius of the centreline (i.e. the bezel's radius less however far you inset). */
  r: number
  /** Thickness of the hot core — the visible width of the tube. */
  thickness?: number
  /**
   * Total width of the glow ACROSS the tube. This is the number that decides whether the ring stays
   * inside its frame: the halo reaches `haloWidth / 2` either side of the centreline, and anything
   * it reaches, it lights. Callers must size it against whatever sits just inside the bezel — board
   * tiles, payline lamps — because nothing here clips it. Defaults to a generous 3.8× thickness,
   * which is right for a frame with room to spare and far too wide for a tight one.
   */
  haloWidth?: number
}

export interface RgbRingOpts {
  mode?: RgbMode
  /** Container to parent every layer into (the slots cabinet is a container that gets tweened). */
  container?: Phaser.GameObjects.Container
  /** Depth for the layers when there is no container. */
  depth?: number
  /**
   * Draw the dark channel the light sits inside. On by default — it is what turns a glow laid over
   * the bezel into a groove cut through it. Pass false where the frame already has a recess.
   */
  groove?: boolean
}

/** Handle returned by `attachRgbRing` — the scene's only surface onto the ring. */
export interface RgbRing {
  /** Swap choreography. Cheap: no tween churn, it only re-rates the existing clock. */
  setMode(mode: RgbMode): void
  /**
   * Punch the ring for a win. `strength` 0..3 scales how hard and how long it burns; the surge
   * decays on its own, so callers never have to reset it.
   */
  surge(strength?: number): void
  /** Current mode — lets a caller guard a delayed handoff (win → idle) the way the slots do. */
  mode(): RgbMode
  /** Unhook the per-frame drive and destroy every layer. Safe to call twice. */
  destroy(): void
}

/**
 * Build a fluid RGB light ring around `geom` and start it running.
 *
 * Callers are expected to have checked `rgbMarquee()` first; this does not check it, so a scene can
 * also use the ring for a non-optional surface later without inheriting the player's toggle.
 */
export function attachRgbRing(
  scene: Phaser.Scene,
  geom: RgbRingGeom,
  opts: RgbRingOpts = {}
): RgbRing {
  const T = getTheme()
  const hueFrom = T.rgbHueFrom
  const hueSpan = T.rgbHueSpan
  const sat = T.rgbSat
  const thickness = geom.thickness ?? 12
  const tier = quality.tier()

  const spacing = thickness * TIER_SPACING[tier]
  const pts = roundedRectPath(geom.x, geom.y, geom.w, geom.h, geom.r, spacing)
  const n = pts.length

  // Each node is an ELLIPSE: `thickness` across the tube, but stretched along the path so
  // neighbours overlap generously without needing to be packed tightly. `rgbnode` is radial, so
  // scaling its two axes independently and rotating to the path tangent gives exactly that.
  const bandSize = thickness * 1.6
  const haloSize = geom.haloWidth ?? thickness * 3.8
  const bandAlong = spacing * ALONG_OVERLAP
  const haloAlong = spacing * HALO_EVERY * ALONG_OVERLAP
  /**
   * Additive nodes STACK: with the stretch above, any point is lit by exactly `ALONG_OVERLAP` of
   * them, so the halo's per-node alpha is divided by that. Without it the sum clips at white and the
   * gold underneath vanishes. The numerator is the intended SUM at a brightness crest — well under 1
   * so the halo reads as spill ON the gold rather than as a second tube. Derived, so retuning the
   * overlap re-normalises the brightness instead of silently blowing it out.
   */
  const haloGain = Math.min(1, 0.55 / ALONG_OVERLAP)

  const own: Phaser.GameObjects.GameObject[] = []
  const place = <O extends Phaser.GameObjects.GameObject>(o: O): O => {
    if (opts.container) opts.container.add(o)
    else if (opts.depth !== undefined) (o as unknown as { setDepth(d: number): void }).setDepth(opts.depth)
    own.push(o)
    return o
  }

  // --- Layer 1: the groove. Static — set once, never touched by the per-frame paint. It turns "a
  // glow drawn over the bezel" into "a channel milled through it", and it does colour work too:
  // additive light on a bright gold ground desaturates straight to white, so the light needs
  // something DARK behind it before a saturated hue can read at all. Depth and colour are one fix.
  //
  // Drawn as an explicit CAPSULE CHAIN — a disc at every path sample plus a quad bridging each pair
  // — rather than by any of the obvious routes, both of which failed visibly:
  //   • a thick `strokeRoundedRect` tessellates badly where the corner arc meets the straights, and
  //     threw a dark serration into all four corners;
  //   • stretched nodes (what the band uses) cannot follow the corner, because an ellipse long
  //     enough to bridge the halo spacing is far longer than the corner radius, so it juts out
  //     tangentially as a pair of dark wings.
  // Discs have no rotation and no joins, so the corners are exact. Every fill is OPAQUE and one flat
  // colour, which is what lets the pieces overlap freely: the union is seamless, where semi-opaque
  // fills would compound into lumps at every overlap. It bakes into a SINGLE Graphics — one display
  // object, no per-frame cost, since the channel itself never animates.
  if (opts.groove !== false) {
    const hw = (thickness * 2.05) / 2
    const g = scene.add.graphics()
    g.fillStyle(GROOVE_INK, 1)
    for (let i = 0; i < n; i++) {
      const a = pts[i]
      const bnext = pts[(i + 1) % n] // wraps, so the chain closes
      g.fillCircle(a.x, a.y, hw)
      const dx = bnext.x - a.x
      const dy = bnext.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const nx = (-dy / len) * hw
      const ny = (dx / len) * hw
      g.fillPoints(
        [
          { x: a.x + nx, y: a.y + ny },
          { x: bnext.x + nx, y: bnext.y + ny },
          { x: bnext.x - nx, y: bnext.y - ny },
          { x: a.x - nx, y: a.y - ny },
        ],
        true
      )
    }
    place(g)
  }

  // --- Layer 2: the halo. Sparse (every HALO_EVERY-th node) but very wide — a low-frequency spill,
  // so it costs a third of the writes while doing most of the "the gold is lit" work.
  const halo: Phaser.GameObjects.Image[] = []
  const haloIdx: number[] = []
  for (let i = 0; i < n; i += HALO_EVERY) {
    const p = pts[i]
    halo.push(
      place(
        scene.add
          .image(p.x, p.y, 'rgbnode')
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(haloAlong, haloSize)
          .setRotation(p.angle)
      )
    )
    haloIdx.push(i)
  }

  // --- Layer 3: the band. One node per sample — the tube you actually read as the light. NORMAL
  // blend, not additive: an opaque band of colour holds its hue against the gold, where an additive
  // one washes to pastel. Brightness is therefore carried by the tint's VALUE rather than by alpha,
  // which is what lets the ring pulse dark→brilliant without ever going milky.
  const band: Phaser.GameObjects.Image[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    band.push(
      place(scene.add.image(p.x, p.y, 'rgbnode').setDisplaySize(bandAlong, bandSize).setRotation(p.angle))
    )
  }

  let mode: RgbMode = opts.mode ?? 'idle'
  let phase = 0
  let sinceWrite = 0
  let surgeMs = 0
  let surgePeak = 0
  let dead = false

  /** Paint the whole ring at the current phase. */
  const paint = (dim: number): void => {
    const p = PROFILES[mode]
    const soft = reduceFlashing()
    // A surge rides on top of the profile: brighter floor, for as long as it has left.
    const s = surgeMs > 0 ? (surgeMs / SURGE_MS) * surgePeak : 0
    const lo = Math.min(1, Math.max(soft ? FLASH_MIN_LO : p.lo, p.lo + s * 0.5))
    const span = hueSpan * p.spanScale
    for (let i = 0; i < n; i++) {
      // The normalised 0..1 travelling wave; each layer maps it into its own range below.
      const w = ringAlpha(i, n, phase, 0, 1, p.waves)
      // Band brightness rides the tint's VALUE, held in a narrow band (see BAND_MIN). Alpha stays
      // pinned at 1 so the band never turns translucent and lets the groove wash through as grey.
      // `dim` is deliberately NOT applied here: the idle throttle calms the ring through the halo
      // alone, because pulling the band's value down is the same move that turns gold into olive.
      band[i].setTint(hsvToInt(ringHue(i, n, phase, hueFrom, span), sat, BAND_MIN + (1 - BAND_MIN) * w))
    }
    for (let k = 0; k < halo.length; k++) {
      const i = haloIdx[k]
      const w = ringAlpha(i, n, phase, 0, 1, p.waves)
      halo[k].setTint(hsvToInt(ringHue(i, n, phase, hueFrom, span), sat, 1))
      halo[k].setAlpha((lo + (p.hi - lo) * w) * dim * haloGain)
    }
  }

  // --- Reduced motion: paint the arc once, never tick. Colour stays; travel goes. ---
  if (prefersReducedMotion()) {
    paint(1)
    const noop = (): void => {}
    return {
      setMode: (m: RgbMode): void => {
        mode = m
      },
      surge: noop,
      mode: (): RgbMode => mode,
      destroy: () => destroyAll(),
    }
  }

  const onUpdate = (_time: number, delta: number): void => {
    if (dead) return
    // CLAMP long frames rather than discarding them. Discarding bounds a background-resume spike
    // just as well, but it also freezes the ring outright on any device slow enough to miss the
    // threshold every frame — the failure mode is a dead marquee exactly where the game is already
    // struggling. Clamping keeps it moving (slowly) there while still stopping a resumed tab from
    // jumping half a lap in one step.
    const dt = delta > 0 ? Math.min(delta, MAX_STEP_MS) : 0
    if (!dt) return

    const p = PROFILES[mode]
    const soft = reduceFlashing()
    const idle = quality.idle()
    // A surge briefly quickens the lap on top of whatever the mode was already doing.
    const surgeRate = surgeMs > 0 ? 1 + (surgeMs / SURGE_MS) * surgePeak * 1.6 : 1
    let lap = p.lapMs / surgeRate
    if (soft) lap = Math.max(lap, FLASH_MIN_LAP)
    if (idle) lap *= IDLE_LAP_SCALE

    phase = frac(phase + dt / lap)
    if (surgeMs > 0) surgeMs = Math.max(0, surgeMs - dt)

    const step = TIER_STEP_MS[quality.tier()]
    sinceWrite += dt
    if (step > 0 && sinceWrite < step) return
    sinceWrite = 0

    paint(idle ? IDLE_DIM : 1)
  }

  function destroyAll(): void {
    if (dead) return
    dead = true
    scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate)
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, destroyAll)
    scene.events.off(Phaser.Scenes.Events.DESTROY, destroyAll)
    for (const o of own) o.destroy()
    own.length = 0
  }

  scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate)
  // A scene restart (the theme picker + the a11y toggles both restart) must not leave the drive
  // hooked to dead nodes — Phaser reuses the Scene object across restarts, so the listener would
  // survive and paint destroyed Images.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, destroyAll)
  scene.events.once(Phaser.Scenes.Events.DESTROY, destroyAll)

  paint(1) // land lit on the first frame rather than dark for a beat

  return {
    setMode: (m: RgbMode): void => {
      mode = m
    },
    surge: (strength = 0): void => {
      const s = Math.max(0, Math.min(3, strength))
      // Flash-averse players get the colour-and-speed surge without the brightness spike.
      surgePeak = reduceFlashing() ? 0.25 : 0.45 + s * 0.18
      surgeMs = SURGE_MS
    },
    mode: (): RgbMode => mode,
    destroy: destroyAll,
  }
}

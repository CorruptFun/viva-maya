/**
 * RGB marquee chase (§RGB) — the dynamic rainbow ring that laps the game-board and Lucky Slots
 * cabinets, replacing the fixed red/gold and gold/rose bulb chases those frames used to wear.
 *
 * WHY THIS SHAPE. The obvious build (a hue tween per bulb) is the one thing that cannot ship: the
 * board already spent 48 tweens on its old chase and the slots 32, and per-bulb colour tweening
 * would have kept every one of them while adding a second animated channel to each. This module
 * drives the whole ring from ONE clock instead — the `background.ts` marquee recipe — so the RGB
 * upgrade *removes* 80 tweens from the app rather than adding to them. That is what buys the 60fps
 * target on a mid-range phone; it is not a micro-optimisation bolted on afterward.
 *
 * WHY NO SHADER / NO THREE.JS. Neither is needed. `textures.ts` bakes the `bulb` texture with an
 * ALPHA-ONLY structure precisely so `setTint` stays hue-true, which means a per-bulb colour is a
 * plain tint write against a texture that already exists. A Phaser pipeline would buy nothing here
 * and would strand the Canvas fallback path, and three.js is fenced to `view3d/stage.ts` by design.
 *
 * COLOUR IS PER THEME, not one global rainbow. `rgbHueFrom` / `rgbHueSpan` / `rgbSat` come off the
 * active theme: Golden Hour and Neon Vegas take the full wheel, while Maya's Heart and Rose Midnight
 * sweep a narrow arc built from their own accents, so the ring never puts a green bulb on the
 * valentine wash. A sub-360 arc ping-pongs rather than wrapping, so the ring closes with no seam.
 *
 * ACCESSIBILITY. Reduced motion paints the arc ONCE and never ticks — you keep the colour, you lose
 * the travel (a hue gradient is not vestibular motion). Reduce-flashing clamps the lap slow and
 * floors the brightness swing, so it breathes instead of strobing. Both are checked live per attach.
 *
 * The colour maths itself lives in `core/rgb.ts`, Phaser-free and unit-tested (`core/rgb.test.ts`) —
 * importing Phaser into a Vitest `node` run dies on `window`, and the ring's two load-bearing
 * properties (a seamless closed loop, an arc that never leaves its band) are pure functions anyway.
 */
import Phaser from 'phaser'
import { frac, hsvToInt, ringAlpha, ringHue } from '../core/rgb'
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
  // The resting cabinet: one slow crest walking the frame, colour drifting the whole way round.
  idle: { lapMs: 3600, lo: 0.42, hi: 1, waves: 1, spanScale: 1 },
  // Reels running — the lap roughly doubles and a second crest joins it.
  spin: { lapMs: 1500, lo: 0.34, hi: 1, waves: 2, spanScale: 1 },
  // The tension beat: fastest lap, and the arc collapses to ~45% so the ring stops being a rainbow
  // and becomes one hot colour sweeping — the same job the old all-rose HEAT pass did.
  heat: { lapMs: 780, lo: 0.3, hi: 1, waves: 2, spanScale: 0.45 },
  // Payout: three crests at speed, full arc — the ring reads as celebrating rather than working.
  win: { lapMs: 900, lo: 0.28, hi: 1, waves: 3, spanScale: 1 },
}

/** Reduce-flashing (§E8) floors: no lap quicker than this, and never a swing below this alpha. */
const FLASH_MIN_LAP = 1600
const FLASH_MIN_LO = 0.6

/**
 * How often tints are actually WRITTEN, per quality tier. The phase keeps advancing off real delta
 * either way — this only thins the writes, so a demoted device gets a slightly chunkier colour
 * gradient rather than a slower or stuttering chase. `high` writes every frame.
 */
const TIER_STEP_MS: Record<QualityTier, number> = { high: 0, med: 24, low: 50 }

/** Idle governor (A2): a left-open PWA slows the lap and dims the ring rather than burning battery. */
const IDLE_LAP_SCALE = 1.7
const IDLE_DIM = 0.72

/** How long a `surge()` takes to decay back to the resting profile. */
const SURGE_MS = 900

// ---------------------------------------------------------------------------
// The chase
// ---------------------------------------------------------------------------

/** Handle returned by `attachRgbChase` — the scene's only surface onto the ring. */
export interface RgbChase {
  /** Swap choreography. Cheap: no tween churn, it only re-rates the existing clock. */
  setMode(mode: RgbMode): void
  /**
   * Punch the ring for a win. `strength` 0..3 scales how hard and how long it burns; the surge
   * decays on its own, so callers never have to reset it.
   */
  surge(strength?: number): void
  /** Current mode — lets a caller guard a delayed handoff (win → idle) the way the slots do. */
  mode(): RgbMode
  /** Unhook the per-frame drive. Safe to call twice. */
  destroy(): void
}

/**
 * Attach a chase to an already-positioned ring of bulbs.
 *
 * `bulbs` MUST be in ring order (the slots push clockwise; the board walks top → right → bottom →
 * left) — the chase derives every bulb's phase offset from its index, so out-of-order bulbs produce
 * a scatter rather than a lap. Positioning, sizing and depth stay entirely the caller's business.
 *
 * Callers are expected to have checked `rgbMarquee()` first; this does not check it, so a scene can
 * also use the chase for a non-optional surface later without inheriting the player's toggle.
 */
export function attachRgbChase(
  scene: Phaser.Scene,
  bulbs: Phaser.GameObjects.Image[],
  opts: { mode?: RgbMode } = {}
): RgbChase {
  const T = getTheme()
  const hueFrom = T.rgbHueFrom
  const hueSpan = T.rgbHueSpan
  const sat = T.rgbSat
  const n = bulbs.length

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
    // A surge rides on top of the profile: brighter floor, wider arc, for as long as it has left.
    const s = surgeMs > 0 ? (surgeMs / SURGE_MS) * surgePeak : 0
    const lo = Math.min(1, Math.max(soft ? FLASH_MIN_LO : p.lo, p.lo + s * 0.5))
    const span = hueSpan * p.spanScale
    for (let i = 0; i < n; i++) {
      const bulb = bulbs[i]
      if (!bulb.active) continue
      bulb.setTint(hsvToInt(ringHue(i, n, phase, hueFrom, span), sat, 1))
      bulb.setAlpha(Math.min(1, ringAlpha(i, n, phase, lo, p.hi, p.waves) * dim))
    }
  }

  // --- Reduced motion: paint the arc once, never tick. Colour stays; travel goes. ---
  if (prefersReducedMotion()) {
    for (let i = 0; i < n; i++) {
      const bulb = bulbs[i]
      if (!bulb.active) continue
      bulb.setTint(hsvToInt(ringHue(i, n, 0, hueFrom, hueSpan), sat, 1))
      bulb.setAlpha(0.85)
    }
    return {
      setMode: (m: RgbMode): void => {
        mode = m
      },
      surge: (): void => {},
      mode: (): RgbMode => mode,
      destroy: (): void => {},
    }
  }

  const onUpdate = (_time: number, delta: number): void => {
    if (dead) return
    // Ignore hitches / background-resume spikes so a returning tab never jumps the ring a half-lap.
    const dt = delta > 0 && delta < 100 ? delta : 0
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

  scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate)

  const destroy = (): void => {
    if (dead) return
    dead = true
    scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate)
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, destroy)
    scene.events.off(Phaser.Scenes.Events.DESTROY, destroy)
  }
  // A scene restart (the theme picker + the a11y toggles both restart) must not leave the drive
  // hooked to dead bulbs — Phaser reuses the Scene object across restarts, so the listener would
  // survive and paint destroyed Images.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, destroy)
  scene.events.once(Phaser.Scenes.Events.DESTROY, destroy)

  paint(1) // land lit on the first frame rather than at whatever alpha the caller left behind

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
    destroy,
  }
}

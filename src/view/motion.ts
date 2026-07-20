/**
 * Motion language for Viva Maya — the timing/easing sibling of `theme.ts` (E1).
 *
 * Where `theme.ts` centralises COLOUR, this module centralises MOTION: a small
 * named vocabulary of durations (`D`), brand easing curves (`E`), and combined
 * beats (`M` = ease + ms), plus a handful of composable, reduced-motion-aware
 * helpers (`popIn` / `breathe` / `fadeRise` / `stagger`) and one shared
 * `heartbeat` clock every hero breather can phase-lock to.
 *
 * Design rules:
 *   - Dependency-light + framework-thin: tokens are plain data; helpers are thin
 *     wrappers over `scene.tweens.add`; the heartbeat reads a global wall-clock so
 *     every consumer that samples on the same frame is automatically in phase.
 *   - Reduced motion is a first-class path: `reduced()` is the canonical guard
 *     (re-exported from `theme.ts`), and every helper collapses to an instant
 *     resting state when it is true.
 *   - Zero visual diff on migration: the duration/ease tokens are chosen to equal
 *     the magic numbers already scattered across the scenes (60/180/260/620/1400…),
 *     so later phases can route existing tweens through them without changing look.
 *
 * This module has no side effects and needs no per-frame tick — the heartbeat is
 * derived from `performance.now()` on read.
 */
import Phaser from 'phaser'
import { prefersReducedMotion } from './theme'

/** Canonical reduced-motion guard. The single home for every motion opt-out. */
export const reduced = prefersReducedMotion

// ---------------------------------------------------------------------------
// Token vocabulary
// ---------------------------------------------------------------------------

/** Duration tokens (ms). Names describe intent, values match today's magic numbers. */
export const D = {
  /** imperceptible correction / instant-ish settle */
  micro: 90,
  /** button press-down, quick acknowledgements */
  quick: 140,
  /** default scene fade / most UI transitions */
  base: 180,
  /** spring-back / entrance settle */
  settle: 260,
  /** pop-in, celebratory scale punches */
  pop: 340,
  /** one heartbeat pulse (Home emblem beat) */
  pulse: 620,
  /** slow ambient breathing loop (halo / cabinet glow) */
  breath: 1400,
} as const

/** Named brand easing curves. Strings Phaser resolves directly as a tween `ease`. */
export const E = {
  /** snappy descent — presses, sinks */
  press: 'Quad.easeOut',
  /** spring back with a little overshoot — releases, settles */
  release: 'Back.easeOut',
  /** confident overshoot — pop-ins, births */
  pop: 'Back.easeOut',
  /** the breathing curve — hero idle life */
  hero: 'Sine.easeInOut',
  /** smooth two-sided glide — scene pushes, sweeps */
  glide: 'Cubic.easeInOut',
  /** eased arc — collect-fly, travelling copies */
  arc: 'Sine.easeInOut',
  /** quiet exit — fades away */
  exit: 'Quad.easeIn',
  /** soft one-sided settle */
  settle: 'Sine.easeOut',
} as const

/**
 * Combined beats — the small "ease + ms" vocabulary. Spread into a tween config:
 *   scene.tweens.add({ targets, scale: 1.1, duration: M.pop.ms, ease: M.pop.ease })
 */
export const M = {
  snappy: { ease: E.press, ms: D.quick },
  settle: { ease: E.release, ms: D.settle },
  pop: { ease: E.pop, ms: D.pop },
  breathe: { ease: E.hero, ms: D.breath },
} as const

/** Calibrated overshoot amounts for `backOut()` — deliberate, not one anonymous `Back`. */
export const OVERSHOOT = {
  /** gentle nudge back into place */
  gentle: 1.2,
  /** the default release spring */
  release: 1.6,
  /** an eager, bouncy pop */
  pop: 1.8,
} as const

/**
 * A Back.easeOut ease function with a chosen overshoot. Returns a function usable
 * directly as a tween `ease` (Phaser accepts a function there), so callers can dial
 * the spring instead of settling for the single default `Back.easeOut`.
 */
export function backOut(overshoot: number = 1.70158): (v: number) => number {
  return (v: number): number => Phaser.Math.Easing.Back.Out(v, overshoot)
}

// ---------------------------------------------------------------------------
// Composable helpers (all reduced-motion-aware)
// ---------------------------------------------------------------------------

/**
 * Anything the helpers move: the full transform surface + a single-value alpha. Sprites, Images,
 * Text AND Containers all satisfy this. We can't use `Components.Alpha` directly because a Container's
 * one-arg `setAlpha(value)` is narrower than the component's 4-corner signature — so we require only
 * the alpha surface the helpers actually touch, which every entrance target (containers included) has.
 */
type MotionTarget = Phaser.GameObjects.Components.Transform & {
  alpha: number
  setAlpha(value?: number): unknown
}

export interface PopInOpts {
  /** starting scale factor relative to the resting scale (default 0.6). */
  from?: number
  /** resting scale to land on (default: the target's current `scale`). */
  to?: number
  duration?: number
  delay?: number
  /** Back overshoot amount (default `OVERSHOOT.pop`). */
  overshoot?: number
  onComplete?: () => void
}

/** Spring / pop-in: scale up from small with a calibrated overshoot. */
export function popIn(
  scene: Phaser.Scene,
  target: MotionTarget,
  opts: PopInOpts = {}
): Phaser.Tweens.Tween | null {
  const to = opts.to ?? target.scale
  if (reduced()) {
    target.setScale(to)
    opts.onComplete?.()
    return null
  }
  target.setScale(to * (opts.from ?? 0.6))
  return scene.tweens.add({
    targets: target,
    scale: to,
    duration: opts.duration ?? D.pop,
    delay: opts.delay ?? 0,
    ease: backOut(opts.overshoot ?? OVERSHOOT.pop),
    onComplete: () => opts.onComplete?.(),
  })
}

export interface BreatheOpts {
  /** peak scale delta (default 0.06 → breathes to 1.06×). */
  amount?: number
  /** half-cycle duration (default `D.breath`). */
  duration?: number
  /** pause at the resting end of each cycle. */
  repeatDelay?: number
  delay?: number
}

/**
 * Breathe loop: a slow yoyo scale pulse for hero idle life. Returns the tween so
 * the caller can pause/kill it. No-op (static resting state) under reduced motion.
 */
export function breathe(
  scene: Phaser.Scene,
  target: MotionTarget,
  opts: BreatheOpts = {}
): Phaser.Tweens.Tween | null {
  if (reduced()) return null
  const base = target.scale
  return scene.tweens.add({
    targets: target,
    scale: base * (1 + (opts.amount ?? 0.06)),
    duration: opts.duration ?? D.breath,
    delay: opts.delay ?? 0,
    repeatDelay: opts.repeatDelay ?? 0,
    yoyo: true,
    repeat: -1,
    ease: E.hero,
  })
}

export interface FadeRiseOpts {
  /** pixels to travel up into place (default 12). */
  rise?: number
  duration?: number
  delay?: number
  ease?: string | ((v: number) => number)
  onComplete?: () => void
}

/**
 * Fade + rise: the entrance beat — start transparent + below, settle up to the
 * object's current `y` at full alpha. Under reduced motion the object is placed
 * at its final state instantly.
 */
export function fadeRise(
  scene: Phaser.Scene,
  target: MotionTarget,
  opts: FadeRiseOpts = {}
): Phaser.Tweens.Tween | null {
  const finalY = target.y
  if (reduced()) {
    target.setAlpha(1)
    target.setY(finalY)
    opts.onComplete?.()
    return null
  }
  target.setAlpha(0)
  target.setY(finalY + (opts.rise ?? 12))
  return scene.tweens.add({
    targets: target,
    y: finalY,
    alpha: 1,
    duration: opts.duration ?? D.settle,
    delay: opts.delay ?? 0,
    ease: opts.ease ?? E.release,
    onComplete: () => opts.onComplete?.(),
  })
}

/** Run `fadeRise` across a list with a per-item delay — the staggered entrance. */
export function stagger(
  scene: Phaser.Scene,
  targets: MotionTarget[],
  step: number = 60,
  opts: FadeRiseOpts = {}
): void {
  const base = opts.delay ?? 0
  targets.forEach((t, i) => fadeRise(scene, t, { ...opts, delay: base + i * step }))
}

// ---------------------------------------------------------------------------
// Shared heartbeat clock
// ---------------------------------------------------------------------------

/** ~68bpm resting pulse. One "lub-DUB" cycle per period. */
const BEAT_PERIOD = 60000 / 68

/** Global monotonic clock (falls back to Date.now where performance is absent). */
function clock(): number {
  try {
    return performance.now()
  } catch {
    return Date.now()
  }
}

/** Raised-cosine bump in [0,1], peaking `1` at `center`, `0` beyond `± width`. */
function bump(t: number, center: number, width: number): number {
  const d = Math.abs(t - center)
  if (d >= width) return 0
  return 0.5 * (1 + Math.cos((d / width) * Math.PI))
}

/**
 * The single shared heartbeat other systems phase off of. Because `amp()` is
 * derived from a global wall-clock, every hero breather that reads it on the same
 * frame moves together — the machine "breathes as one organism" for free, with no
 * cross-tween wiring. Read it in an `update()`:
 *
 *   emblem.setScale(base * (1 + heartbeat.amp() * 0.09))
 */
export const heartbeat = {
  /** Length of one full lub-DUB cycle, in ms. */
  period: BEAT_PERIOD,
  /** Linear phase through the current cycle, 0..1. */
  phase(now: number = clock()): number {
    const p = (now % BEAT_PERIOD) / BEAT_PERIOD
    return p < 0 ? p + 1 : p
  },
  /**
   * Beat amplitude 0..1 with a lub-DUB double-pulse envelope: a smaller first
   * pulse (lub) then a stronger second (DUB), then rest. Suitable to scale a
   * breathing transform or drive a glow alpha.
   */
  amp(now: number = clock()): number {
    const p = this.phase(now)
    const lub = 0.62 * bump(p, 0.08, 0.1)
    const dub = 1.0 * bump(p, 0.3, 0.12)
    return Math.min(1, lub + dub)
  },
}

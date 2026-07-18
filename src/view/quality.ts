/**
 * Adaptive quality governor for Viva Maya (E2) — the perf keystone that turns
 * §5's fixed fill-rate budgets into adaptive ones, so full juice can ship on the
 * owner's iPhone 16 Pro Max AND stay 60fps on old hardware from one build.
 *
 * It is a single read-only source of truth that effect code (later phases) will
 * consult to right-size itself:
 *   - `tier()`   → 'high' | 'med' | 'low' coarse quality bucket
 *   - `scale()`  → 0..1 multiplier for particle counts / optional-layer alpha
 *   - `count(n)` → convenience: `n` scaled + rounded for spawn loops
 *   - `idle()`   → true after IDLE_MS of no pointer input (ambient can throttle)
 *   - `fps()`    → smoothed frames-per-second (for a future dev HUD)
 *
 * How it adapts: it samples the per-frame delta into an exponential moving average
 * and steps the tier DOWN when frame time is sustainedly bad and back UP when there
 * is sustained headroom. Hysteresis (asymmetric sustain windows + a cooldown +
 * a neutral dead-band) keeps it from oscillating on the boundary.
 *
 * It ticks off the Phaser game loop (`POST_STEP`), so it naturally stops sampling
 * while the loop is asleep (backgrounded) — no resume spike counts against quality.
 * This phase only WIRES and TICKS the governor; consumption lands in later phases.
 */
import Phaser from 'phaser'

export type QualityTier = 'high' | 'med' | 'low'

/** Immutable read-out of the governor's current state. */
export interface QualitySnapshot {
  readonly tier: QualityTier
  readonly scale: number
  readonly fps: number
  readonly idle: boolean
}

/** Effect-count / alpha multiplier per tier. `high` is a no-op (full richness). */
const TIER_SCALE: Record<QualityTier, number> = {
  high: 1,
  med: 0.66,
  low: 0.4,
}

/** Low → high; index arithmetic drives one-step demotion / promotion. */
const TIER_ORDER: readonly QualityTier[] = ['low', 'med', 'high']

// --- Tuning constants (ms) ---------------------------------------------------
/** EMA smoothing factor for frame delta (higher = more reactive). */
const EMA_ALPHA = 0.1
/** Frames slower than this (≈ < 50fps) count toward a demotion. */
const DEMOTE_MS = 20
/** Frames faster than this (≈ > 58fps) count toward a promotion; the gap to
 *  DEMOTE_MS is a neutral dead-band where neither counter advances. */
const PROMOTE_MS = 17.2
/** Sustained bad time before stepping down — quick to protect the framerate. */
const DEMOTE_SUSTAIN = 1200
/** Sustained good time before stepping up — slow, so we don't ping-pong. */
const PROMOTE_SUSTAIN = 4000
/** Quiet window after any tier change before the next is allowed. */
const COOLDOWN = 1500
/** No-input time before `idle()` flips true. */
const IDLE_MS = 6000
/** Frames longer than this are treated as hitches/resumes and ignored entirely. */
const MAX_SANE_DELTA = 100

class QualityGovernor {
  private _tier: QualityTier = 'high'
  private ema = 1000 / 60 // seed at a healthy 60fps
  private badMs = 0
  private goodMs = 0
  private cooldownMs = 0
  private idleMs = 0
  private _idle = false
  private seeded = false

  // --- Read-only API (safe for any consumer, any phase) ---

  /** Current coarse quality bucket. */
  tier(): QualityTier {
    return this._tier
  }

  /** 0..1 multiplier for particle counts / optional-layer alpha. */
  scale(): number {
    return TIER_SCALE[this._tier]
  }

  /** Scale a base count by the current tier and round — for spawn loops. */
  count(base: number): number {
    return Math.max(0, Math.round(base * this.scale()))
  }

  /** Smoothed frames-per-second (for a dev HUD / diagnostics). */
  fps(): number {
    return this.ema > 0 ? Math.round(1000 / this.ema) : 0
  }

  /** True after IDLE_MS of no pointer input; resets on the next input. */
  idle(): boolean {
    return this._idle
  }

  /** Immutable snapshot of the whole state. */
  snapshot(): QualitySnapshot {
    return { tier: this._tier, scale: this.scale(), fps: this.fps(), idle: this._idle }
  }

  // --- Drive points (called by the installer / tests) ---

  /**
   * Seed the starting tier from cheap device hints. Defaults to HIGH (start rich);
   * only Save-Data or a reduced-transparency preference pull the initial tier down.
   * Idempotent — only the first call takes effect.
   */
  seed(): void {
    if (this.seeded) return
    this.seeded = true
    try {
      const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection
      if (conn?.saveData) {
        this._tier = 'low'
        return
      }
      if (
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-transparency: reduce)').matches
      ) {
        this._tier = 'med'
      }
    } catch {
      // no navigator / matchMedia — keep the HIGH default
    }
  }

  /** Advance the governor by one frame. `deltaMs` is the frame time in ms. */
  tick(deltaMs: number): void {
    // Ignore non-positive deltas and hitches / background-resume spikes so a single
    // long frame never demotes quality.
    if (!(deltaMs > 0) || deltaMs > MAX_SANE_DELTA) return

    this.ema += (deltaMs - this.ema) * EMA_ALPHA

    // Idle accounting (input resets via noteActivity()).
    this.idleMs += deltaMs
    if (!this._idle && this.idleMs >= IDLE_MS) this._idle = true

    if (this.cooldownMs > 0) this.cooldownMs -= deltaMs

    // Accumulate sustained pressure in one direction; the dead-band resets both.
    if (this.ema > DEMOTE_MS) {
      this.badMs += deltaMs
      this.goodMs = 0
    } else if (this.ema < PROMOTE_MS) {
      this.goodMs += deltaMs
      this.badMs = 0
    } else {
      this.badMs = 0
      this.goodMs = 0
    }

    if (this.cooldownMs > 0) return

    if (this.badMs >= DEMOTE_SUSTAIN) {
      this.step(-1)
    } else if (this.goodMs >= PROMOTE_SUSTAIN) {
      this.step(1)
    }
  }

  /** Register pointer/keyboard activity — clears the idle state. */
  noteActivity(): void {
    this.idleMs = 0
    this._idle = false
  }

  private step(dir: 1 | -1): void {
    const i = TIER_ORDER.indexOf(this._tier)
    const next = TIER_ORDER[i + dir]
    if (!next) return // already at the ceiling / floor
    this._tier = next
    this.badMs = 0
    this.goodMs = 0
    this.cooldownMs = COOLDOWN
  }
}

/** The process-wide governor singleton. Read from anywhere; ticked from `main.ts`. */
export const quality = new QualityGovernor()

/**
 * Wire the governor to the running game: tick it every frame off `POST_STEP`, and
 * reset the idle timer on any pointer/keyboard/wheel/touch input. Seeds the initial
 * tier from device hints. Returns a disposer that unhooks everything.
 */
export function installQualityGovernor(game: Phaser.Game): () => void {
  quality.seed()

  const onStep = (_time: number, delta: number): void => quality.tick(delta)
  game.events.on(Phaser.Core.Events.POST_STEP, onStep)

  const onActivity = (): void => quality.noteActivity()
  const activityEvents = ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'touchstart']
  const listenerOpts: AddEventListenerOptions = { passive: true, capture: true }
  if (typeof window !== 'undefined') {
    for (const name of activityEvents) window.addEventListener(name, onActivity, listenerOpts)
  }

  return (): void => {
    game.events.off(Phaser.Core.Events.POST_STEP, onStep)
    if (typeof window !== 'undefined') {
      for (const name of activityEvents) window.removeEventListener(name, onActivity, listenerOpts)
    }
  }
}

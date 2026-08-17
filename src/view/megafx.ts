/**
 * MEGA-FX for Viva Maya — the "whole phone erupts" celebration kit (§X1).
 *
 * Where `fx.ts` is the quietest layer in the app, this module is the loudest: the screen-owning
 * vocabulary a big casino win speaks in. Five tools, all cut from the same reference footage
 * (a slots ad whose win escalates from reel-blaze → screen-wide light rays → a burning frame →
 * the symbols bursting OUT of the board past the screen edges in a shower of gold):
 *
 *   - `rakeRays`       — diagonal blades of light sweeping the WHOLE screen (the god-ray rake)
 *   - `igniteVignette` — a sustained burning frame hugging all four screen edges, with a live
 *                        flicker, returned as a handle the owner must extinguish (auto-timed out
 *                        as a backstop so an abandoned handle can never burn forever)
 *   - `emberField`     — soft embers drifting up across the screen for a bounded window
 *   - `coinBurst`      — a torrential fountain of chips/coins tumbling out and raining past the
 *                        bottom edge (ballistic arcs + coin-flip spin, all plain tweens)
 *   - `eruptPieces`    — THE signature: ghost copies of the winning symbols blast outward past
 *                        the screen edges, scaling up 5–7× as they fly "past the camera" while a
 *                        momentary scrim drops the board behind them
 *   - `flashBloom`     — one warm full-screen bloom pop (the golden impact frame, never white)
 *
 * Discipline (the four house rules every effect here obeys):
 *  1. **No shaders, no pipelines.** Everything is baked textures (`sweep`, `bgglow`, `spark`,
 *     `glint`, `chip`, `medallion`, `shockwave`) under ADD blend — the game is `Phaser.AUTO` and
 *     the Canvas fallback must render every one of these.
 *  2. **Transient by construction.** Every object is created at fire time and destroys itself;
 *     the one sustained effect (the vignette) carries its own auto-extinguish deadline. Nothing
 *     here ticks per-frame — motion is tweens and capped particle emitters only.
 *  3. **A11y-gated at the door.** `reduced()` skips motion entirely (a transient's resting state
 *     is nothing), `reduceFlashing()` swaps pops for dim slow swells, and every count/alpha runs
 *     through the `quality` governor so the LOW tier sheds the whole layer.
 *  4. **Camera-safe.** Full-screen layers are `scrollFactor(0)` so the trauma rattle can't slide
 *     them off an edge, and nothing here touches camera zoom or scroll — zoom punches stay owned
 *     by the scenes (which only ever zoom IN; see the WASH_BLEED note in CLAUDE.md).
 *
 * Depth contract: callers pass the depth band that fits their scene (GameScene uses 37–39 —
 * above board + HUD at ≤34, below every overlay scrim at 40+). Defaults sit in that band.
 */
import Phaser from 'phaser'
import { DESIGN_W, restScrollY, worldH } from '../config'
import { E, reduced } from './motion'
import { quality } from './quality'
import { getTheme, reduceFlashing } from './theme'

/** Default depth band: above the scene's board/HUD, below overlay scrims (GameScene contract). */
const FX_DEPTH = 38

/** The screen rect in scrollFactor-0 space: (0,0)–(DESIGN_W, worldH()) covers the whole viewport. */
function screenSize(): { w: number; h: number } {
  return { w: DESIGN_W, h: worldH() }
}

/** The visible viewport in WORLD space (for world-anchored effects like the piece eruption). */
function worldView(): { left: number; top: number; right: number; bottom: number } {
  const top = restScrollY()
  return { left: 0, top, right: DESIGN_W, bottom: top + worldH() }
}

// ---------------------------------------------------------------------------
// stageDim — the dark ground additive light burns against
// ---------------------------------------------------------------------------

export interface StageDimOpts {
  /** Peak darkness (default 0.3; hard-capped 0.5 — a stage dim, never a blackout). */
  alpha?: number
  /** Total dwell in ms (default 700): fast drop in, hold, slow release. */
  ms?: number
  depth?: number
}

/**
 * A momentary full-screen ink wash UNDER a burst of additive light — the trick that makes the kit
 * read on the LIGHT themes. ADD-blend gold over Golden Hour's cream wash barely registers (the same
 * physics the RGB marquee note records: additive light needs a dark ground doing colour work), and
 * the reference footage's fire reads precisely because it burns against a dark void. So the big
 * payoffs drop the house lights for a beat and let the rays/coins/ghosts own the screen.
 * Deliberately a DARKENING, never a flash; reduce-flashing slows and softens it further.
 * Gates: reduced motion / LOW tier → none (its partner effects are gone there too).
 */
export function stageDim(scene: Phaser.Scene, opts: StageDimOpts = {}): void {
  if (reduced() || quality.tier() === 'low') return
  const soft = reduceFlashing()
  const { w: W, h: H } = screenSize()
  const ms = (opts.ms ?? 700) * (soft ? 1.4 : 1)
  const ink = scene.add
    .rectangle(W / 2, H / 2, W * 1.2, H * 1.2, getTheme().vignetteInk, 1)
    .setScrollFactor(0)
    .setDepth(opts.depth ?? FX_DEPTH - 1)
    .setAlpha(0)
  scene.tweens.chain({
    targets: ink,
    tweens: [
      { alpha: Math.min(0.5, opts.alpha ?? 0.3) * (soft ? 0.7 : 1), duration: ms * 0.2, ease: E.press },
      { alpha: 0, delay: ms * 0.35, duration: ms * 0.45, ease: E.exit },
    ],
    onComplete: () => ink.destroy(),
  })
}

// ---------------------------------------------------------------------------
// rakeRays — the god-ray sweep
// ---------------------------------------------------------------------------

export interface RakeRaysOpts {
  /** Blade count before governor scaling (default 4). */
  blades?: number
  /** Tint multiplied onto the gold `sweep` texture (default warm white = keep its gold). */
  tint?: number
  /** One blade's travel time in ms (default 620); the rake staggers blades ~90ms apart. */
  ms?: number
  /** Peak alpha per blade (default 0.3 — ambient light, not a foreground streak). */
  alpha?: number
  /**
   * Where the rake sits. Prefer a depth BEHIND the scene's playfield (owner feedback 2026-08-17:
   * blades crossing OVER the pieces read as out of place) — GameScene passes a negative depth so
   * the light sweeps the room between the backdrop ladder and the cabinet, and the overlays seat
   * it between their scrim and their board. The default is the over-scene band for callers with
   * nothing behind their content to sweep.
   */
  depth?: number
  /** Rake angle in degrees (default -32 — the reference's down-right diagonal). */
  angle?: number
  /** Flip the travel direction (default sweeps toward bottom-right). */
  mirror?: boolean
  /** Drop a `stageDim` under the rake so the light has dark to burn against (the payoff rakes). */
  dim?: boolean
}

/**
 * Diagonal blades of light sweeping across the WHOLE screen — the reference's "god-ray rake" over
 * a big win, tuned as AMBIENT ROOM LIGHT rather than a foreground effect: thin, quiet blades that
 * read as light moving through the lounge, seated behind the playfield wherever the scene has one
 * (see `depth` above). Each blade is one stretched `sweep` texture (ADD) travelling along its own
 * normal, so the light crosses the screen rather than pivoting in place. Transient; screen-space.
 * Gates: reduced motion → none; LOW tier → none; reduce-flashing → dimmer, slower (a glide of
 * light, never a strobe); blade count runs through `quality.count`.
 */
export function rakeRays(scene: Phaser.Scene, opts: RakeRaysOpts = {}): void {
  if (reduced() || quality.tier() === 'low') return
  if (!scene.textures.exists('sweep')) return
  const soft = reduceFlashing()
  const blades = quality.count(opts.blades ?? 4)
  if (blades <= 0) return
  const { w: W, h: H } = screenSize()
  const diag = Math.hypot(W, H)
  const angle = opts.angle ?? -32
  const rad = Phaser.Math.DegToRad(angle)
  // Unit vector ALONG the blade (its long axis) and its normal (the travel direction).
  const ux = Math.cos(rad)
  const uy = Math.sin(rad)
  const nx = -uy
  const ny = ux
  const dir = opts.mirror ? -1 : 1
  const span = diag * 0.62 // travel distance either side of centre — enters and exits fully
  const ms = (opts.ms ?? 620) * (soft ? 1.6 : 1)
  const peak = (opts.alpha ?? 0.3) * (soft ? 0.5 : 1) * quality.scale()
  if (opts.dim) stageDim(scene, { ms: ms + blades * 90, depth: (opts.depth ?? FX_DEPTH) - 1 })
  const cx = W / 2
  const cy = H / 2
  for (let i = 0; i < blades; i++) {
    // Blades are individuals, not a picket fence: jittered thickness, slide (along the blade) and
    // start offset, so the rake reads as living light instead of a screen wipe.
    const thick = Phaser.Math.Between(60, 130)
    const slide = Phaser.Math.Between(-160, 160)
    const startOff = -dir * span + Phaser.Math.Between(-80, 80)
    const blade = scene.add
      .image(cx + nx * startOff + ux * slide, cy + ny * startOff + uy * slide, 'sweep')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(opts.depth ?? FX_DEPTH)
      .setScrollFactor(0)
      .setAngle(angle)
      .setDisplaySize(diag * 1.3, thick)
      .setAlpha(0)
    if (opts.tint !== undefined) blade.setTint(opts.tint)
    const delay = i * 90
    // Travel: one straight glide across the screen along the normal.
    scene.tweens.add({
      targets: blade,
      x: blade.x + nx * dir * span * 2,
      y: blade.y + ny * dir * span * 2,
      delay,
      duration: ms,
      ease: 'Sine.easeInOut',
      onComplete: () => blade.destroy(),
    })
    // Brightness: fade in fast, hold through the middle, gone before the exit.
    scene.tweens.add({
      targets: blade,
      alpha: peak,
      delay,
      duration: ms * 0.3,
      hold: ms * 0.25,
      yoyo: true,
      ease: E.settle,
    })
  }
}

// ---------------------------------------------------------------------------
// igniteVignette — the burning frame
// ---------------------------------------------------------------------------

export interface VignetteHandle {
  /** Fade the frame out and free everything. Safe to call twice; safe after scene teardown. */
  extinguish(): void
  /** True until extinguished (by the owner or the auto-deadline). */
  readonly live: boolean
}

/** The do-nothing handle returned when a gate declined to light the frame. */
const DEAD_VIGNETTE: VignetteHandle = { extinguish() {}, live: false }

export interface VignetteOpts {
  /** Heat 1..3, mirroring the combo tiers: gold → bright amber → rose. */
  heat?: 1 | 2 | 3
  depth?: number
  /**
   * Auto-extinguish deadline (default 6500ms). The frame is meant to be owned — ignited on a MEGA
   * tier, extinguished when the chain settles — but a burning frame with a lost owner would be the
   * one non-transient thing in the kit, so it always carries its own way out.
   */
  maxMs?: number
}

/**
 * The burning screen frame: soft additive heat hugging all four edges plus hot corner pools,
 * flickering gently while it lives — the sustained version of GameScene's one-shot
 * `cascadeEdgeTick`, for the stretch where a chain has gone MEGA and the whole phone should read
 * as alight. Screen-space; the flicker is a handful of slow yoyo tweens (zero per-frame work).
 * Gates: reduced motion / LOW tier → dead handle (nothing to rest); reduce-flashing → dimmer with
 * a slower, calmer flicker; alphas run through `quality.scale()`.
 */
export function igniteVignette(scene: Phaser.Scene, opts: VignetteOpts = {}): VignetteHandle {
  if (reduced() || quality.tier() === 'low') return DEAD_VIGNETTE
  if (!scene.textures.exists('bgglow')) return DEAD_VIGNETTE
  const T = getTheme()
  const soft = reduceFlashing()
  const heat = opts.heat ?? 1
  const depth = opts.depth ?? FX_DEPTH
  const tint = heat >= 3 ? T.roseLight : heat === 2 ? T.goldBright : T.gold
  const peak = Math.min(0.42, 0.18 + heat * 0.06) * (soft ? 0.6 : 1) * quality.scale()
  const { w: W, h: H } = screenSize()
  const th = 88 + heat * 30 // edge band thickness grows with the heat
  const pieces: Phaser.GameObjects.Image[] = []
  const make = (x: number, y: number, w: number, h: number, a: number, blend: Phaser.BlendModes, pieceTint: number): void => {
    pieces.push(
      scene.add
        .image(x, y, 'bgglow')
        .setTint(pieceTint)
        .setBlendMode(blend)
        .setDepth(depth)
        .setScrollFactor(0)
        .setDisplaySize(w, h)
        .setAlpha(0)
        .setData('peak', a)
    )
  }
  const frame = (band: number, a: number, blend: Phaser.BlendModes, pieceTint: number): void => {
    // Four edge bands, radial cores ON the edges so the bright half bleeds inward…
    make(W / 2, 0, W * 1.15, band, a, blend, pieceTint)
    make(W / 2, H, W * 1.15, band, a, blend, pieceTint)
    make(0, H / 2, band, H * 1.15, a, blend, pieceTint)
    make(W, H / 2, band, H * 1.15, a, blend, pieceTint)
    // …and four corner pools a notch hotter, where the reference's frame visibly burns brightest.
    const corner = band * 2.1
    make(0, 0, corner, corner, a * 1.35, blend, pieceTint)
    make(W, 0, corner, corner, a * 1.35, blend, pieceTint)
    make(0, H, corner, corner, a * 1.35, blend, pieceTint)
    make(W, H, corner, corner, a * 1.35, blend, pieceTint)
  }
  // The dark groove first, then the fire: a NORMAL-blend ink under-frame gives the additive heat a
  // dark ground to burn against — without it the frame is invisible on the light themes (the same
  // rule the RGB marquee's baked groove records: additive light needs darkness doing colour work).
  frame(th * 1.5, Math.min(0.26, 0.12 + heat * 0.045), Phaser.BlendModes.NORMAL, T.vignetteInk)
  frame(th, peak, Phaser.BlendModes.ADD, tint)

  let live = true
  const tweens: Phaser.Tweens.Tween[] = []
  pieces.forEach((img, i) => {
    // Ignite, then flicker: each piece breathes between its peak and ~72% on its own period, so the
    // frame shimmers like firelight instead of pulsing like a strobe.
    const a = img.getData('peak') as number
    tweens.push(
      scene.tweens.add({
        targets: img,
        alpha: a,
        duration: soft ? 460 : 240,
        delay: i * 24,
        ease: E.settle,
        onComplete: () => {
          if (!live || !img.active) return
          tweens.push(
            scene.tweens.add({
              targets: img,
              alpha: a * 0.72,
              duration: (soft ? 640 : 420) + i * 60,
              yoyo: true,
              repeat: -1,
              ease: E.hero,
            })
          )
        },
      })
    )
  })

  const extinguish = (): void => {
    if (!live) return
    live = false
    deadline.remove(false)
    for (const t of tweens) t.stop()
    for (const img of pieces) {
      if (!img.active) continue
      scene.tweens.add({ targets: img, alpha: 0, duration: 380, ease: E.exit, onComplete: () => img.destroy() })
    }
  }
  // The backstop: a lost owner (a demoted tier mid-chain, an early scene exit) can never leave the
  // frame burning — it puts itself out.
  const deadline = scene.time.delayedCall(opts.maxMs ?? 6500, extinguish)

  return {
    extinguish,
    get live(): boolean {
      return live
    },
  }
}

// ---------------------------------------------------------------------------
// emberField — rising embers
// ---------------------------------------------------------------------------

export interface EmberFieldOpts {
  /** How long the field emits (default 2400ms); embers alive at the cutoff finish their drift. */
  ms?: number
  depth?: number
  /** Ember tints (default warm fire golds). */
  tints?: number[]
  /** Live-ember target before governor scaling (default 22). */
  count?: number
}

/**
 * Soft embers drifting up across the whole screen for a bounded window — the reference's floating
 * fire-fleck field during its eruption. One capped particle emitter in screen space, emitting from
 * the lower two-thirds so flecks rise THROUGH the scene; stops at the deadline and frees itself
 * once the last ember dies. Gates: reduced motion / LOW tier → none; count via `quality.count`.
 */
export function emberField(scene: Phaser.Scene, opts: EmberFieldOpts = {}): void {
  if (reduced() || quality.tier() === 'low') return
  if (!scene.textures.exists('spark')) return
  const T = getTheme()
  const { w: W, h: H } = screenSize()
  const ms = opts.ms ?? 2400
  const target = quality.count(opts.count ?? 22)
  if (target <= 0) return
  const life = 1500
  const field = scene.add
    .particles(0, 0, 'spark', {
      emitZone: {
        type: 'random' as const,
        // A plain RandomZoneSource rather than a Geom.Rectangle (whose generic getRandomPoint
        // signature doesn't satisfy the callback type): embers spawn across the lower two-thirds.
        source: {
          getRandomPoint: (point: Phaser.Types.Math.Vector2Like): void => {
            point.x = Math.random() * W
            point.y = H * (0.3 + Math.random() * 0.7)
          },
        },
      },
      speedY: { min: -150, max: -50 },
      speedX: { min: -28, max: 28 },
      scale: { start: 0.55, end: 0 },
      alpha: { start: 0.85, end: 0 },
      lifespan: { min: life * 0.6, max: life * 1.2 },
      tint: opts.tints ?? [T.gold, T.goldBright, 0xffb01c],
      quantity: 1,
      frequency: Math.max(24, life / target), // steady-state live count ≈ target
      emitting: true,
    })
    .setDepth(opts.depth ?? FX_DEPTH)
    .setScrollFactor(0)
  scene.time.delayedCall(ms, () => field.active && field.stop())
  scene.time.delayedCall(ms + life * 1.3, () => field.active && field.destroy())
}

// ---------------------------------------------------------------------------
// coinBurst — the gold fountain
// ---------------------------------------------------------------------------

export interface CoinBurstOpts {
  /** Token count before governor scaling (default 16). */
  count?: number
  /** Launch power multiplier (default 1). */
  power?: number
  depth?: number
  /** Spread half-angle from straight up, in degrees (default 52). */
  spreadDeg?: number
}

/**
 * The torrential payout: a fountain of chips and gold coins launched up and out, tumbling with a
 * coin-flip spin, pulled back down past the bottom of the screen. Ballistic arcs from plain
 * tweens (rise Quad.easeOut → fall Quad.easeIn), the flip a yoyo on `scaleX` — no physics, no
 * per-frame code. World-space (launch it from the board/cabinet the win came from).
 * Gates: reduced motion → none (the win card's own receipts carry the information); count via
 * `quality.count`, so the LOW tier throws a handful instead of a shower.
 */
export function coinBurst(scene: Phaser.Scene, x: number, y: number, opts: CoinBurstOpts = {}): void {
  if (reduced()) return
  if (!scene.textures.exists('chip')) return
  const T = getTheme()
  const n = quality.count(opts.count ?? 16)
  if (n <= 0) return
  const power = opts.power ?? 1
  const spread = Phaser.Math.DegToRad(opts.spreadDeg ?? 52)
  const depth = opts.depth ?? FX_DEPTH
  const floor = worldView().bottom + 100
  const useMedallion = scene.textures.exists('medallion')
  for (let i = 0; i < n; i++) {
    // 1-in-3 tokens are the chunky minted coin (the medallion face tinted gold), the rest chips.
    const coin = useMedallion && i % 3 === 0
    const size = coin ? Phaser.Math.Between(46, 68) : Phaser.Math.Between(36, 54)
    const token = scene.add
      .image(x + Phaser.Math.Between(-24, 24), y + Phaser.Math.Between(-16, 16), coin ? 'medallion' : 'chip')
      .setDepth(depth)
      .setDisplaySize(size, size)
      .setAngle(Phaser.Math.Between(-180, 180))
    if (coin) token.setTint(T.goldBright)
    // Ballistic arc: angle off vertical picks the lateral drift; power picks the apex.
    const a = -Math.PI / 2 + Phaser.Math.FloatBetween(-spread, spread)
    const v = Phaser.Math.FloatBetween(0.55, 1) * power
    const rise = Phaser.Math.Between(170, 420) * v
    const upMs = Phaser.Math.Between(280, 400)
    const downMs = Phaser.Math.Between(520, 780)
    // Lateral drift follows the launch angle's horizontal component (a = -PI/2 is straight up).
    const drift = Math.cos(a) * rise * Phaser.Math.FloatBetween(1.6, 2.6)
    scene.tweens.chain({
      targets: token,
      tweens: [
        { y: token.y - rise, duration: upMs, ease: 'Quad.easeOut' },
        { y: floor, duration: downMs, ease: 'Quad.easeIn' },
      ],
      onComplete: () => token.destroy(),
    })
    scene.tweens.add({ targets: token, x: token.x + drift, duration: upMs + downMs, ease: 'Sine.easeOut' })
    scene.tweens.add({ targets: token, angle: token.angle + Phaser.Math.Between(-340, 340), duration: upMs + downMs })
    // The coin-flip: scaleX narrows and recovers on a loop — reads as the disc tumbling in 3D.
    // Shallow on purpose (≥42% width, slowish cycles): collapse it further and a screenshot-worth
    // of any moment shows slivers instead of coins.
    scene.tweens.add({
      targets: token,
      scaleX: token.scaleX * 0.42,
      duration: Phaser.Math.Between(150, 210),
      yoyo: true,
      repeat: 2,
      ease: 'Sine.easeInOut',
    })
    // Late fade so the rain vanishes before it stacks on the floor.
    scene.tweens.add({ targets: token, alpha: 0, delay: upMs + downMs - 180, duration: 180, ease: E.exit })
  }
  // A few star glints riding the top of the fountain — the light the gold throws off.
  if (scene.textures.exists('glint') && quality.count(1) > 0) {
    const glints = Math.min(5, Math.ceil(n / 4))
    for (let i = 0; i < glints; i++) {
      const gx = x + Phaser.Math.Between(-130, 130)
      const gy = y - Phaser.Math.Between(60, 240)
      const star = scene.add
        .image(gx, gy, 'glint')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(depth + 1)
        .setTint(T.goldBright)
        .setScale(0)
        .setAngle(Phaser.Math.Between(-30, 30))
      scene.tweens.add({
        targets: star,
        scale: Phaser.Math.FloatBetween(0.5, 0.9),
        angle: star.angle + 40,
        delay: i * 110,
        duration: 200,
        yoyo: true,
        hold: 60,
        ease: E.settle,
        onComplete: () => star.destroy(),
      })
    }
  }
}

// ---------------------------------------------------------------------------
// eruptPieces — the board bursts out of the screen
// ---------------------------------------------------------------------------

/** One winning symbol to erupt: its world position and the baked texture it flies as. */
export interface EruptionSeed {
  x: number
  y: number
  key: string
  tint?: number
}

export interface EruptOpts {
  /** Blast origin (default: the centroid of the seeds). */
  cx?: number
  cy?: number
  depth?: number
  /** Flight time in ms (default 640). */
  ms?: number
  /** Ghost cap before governor scaling (default 9). */
  cap?: number
  /** Starting display size of a ghost (default 74 — piece-sized). */
  size?: number
}

/**
 * THE signature moment, translated from the reference's 3D pillar burst: ghost copies of the
 * winning symbols blast outward from the board, scaling up 5–7× as they accelerate past the
 * screen edges — the symbols flying "past the camera", out of the phone. Behind them a momentary
 * scrim drops the board into shadow so the ghosts own the screen for the beat; a soft glow rides
 * under each ghost so they read as objects of light, not stickers. Everything is transient and
 * world-space; the ghosts are brand-new images, so the board's own sprite map is never touched
 * (see the `this.sprites` ghost-invariant note in CLAUDE.md — this kit mints its OWN sprites and
 * destroys every one).
 * Gates: reduced motion / LOW tier → none; MED thins the cap via `quality.count`;
 * reduce-flashing dims the scrim + glows (the flight itself is motion, already gated above).
 */
export function eruptPieces(scene: Phaser.Scene, seeds: EruptionSeed[], opts: EruptOpts = {}): void {
  if (reduced() || quality.tier() === 'low') return
  if (seeds.length === 0) return
  const soft = reduceFlashing()
  const cap = Math.max(0, Math.min(seeds.length, quality.count(opts.cap ?? 9)))
  if (cap <= 0) return
  // Spread the picks across the list so one corner of the board never supplies every ghost.
  const picked: EruptionSeed[] = []
  const step = seeds.length / cap
  for (let i = 0; i < cap; i++) picked.push(seeds[Math.min(seeds.length - 1, Math.floor(i * step))])
  const cx = opts.cx ?? picked.reduce((s, p) => s + p.x, 0) / picked.length
  const cy = opts.cy ?? picked.reduce((s, p) => s + p.y, 0) / picked.length
  const depth = opts.depth ?? FX_DEPTH + 1
  const ms = opts.ms ?? 640
  const view = worldView()
  const exit = Math.hypot(view.right - view.left, view.bottom - view.top) * 0.72

  // The board recedes: a momentary shadow between the scene and the flying symbols — deep enough
  // that the ghosts and their glows read as light against dark even on the cream themes.
  const scrim = scene.add
    .rectangle(DESIGN_W / 2, worldH() / 2, DESIGN_W * 1.2, worldH() * 1.2, getTheme().vignetteInk, 1)
    .setScrollFactor(0)
    .setDepth(depth - 1)
    .setAlpha(0)
  scene.tweens.add({
    targets: scrim,
    alpha: soft ? 0.26 : 0.42,
    duration: 130,
    hold: ms * 0.45,
    yoyo: true,
    ease: E.press,
    onComplete: () => scrim.destroy(),
  })

  picked.forEach((seed, i) => {
    if (!scene.textures.exists(seed.key)) return
    // Direction: outward from the blast origin, with jitter; a seed AT the origin picks its own way.
    let dx = seed.x - cx
    let dy = seed.y - cy
    if (Math.hypot(dx, dy) < 4) {
      const a = (i / cap) * Math.PI * 2
      dx = Math.cos(a)
      dy = Math.sin(a)
    }
    const len = Math.hypot(dx, dy) || 1
    const jitter = Phaser.Math.FloatBetween(-0.22, 0.22)
    const ca = Math.cos(jitter)
    const sa = Math.sin(jitter)
    const ux = (dx / len) * ca - (dy / len) * sa
    const uy = (dx / len) * sa + (dy / len) * ca
    const size = opts.size ?? 74
    // Ghost + its underglow travel as one container so a single tween drives the pair.
    const glow = scene.add
      .image(0, 0, 'bgglow')
      .setTint(getTheme().goldBright)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(size * 2.1, size * 2.1)
      .setAlpha(soft ? 0.28 : 0.52)
    const ghost = scene.add.image(0, 0, seed.key).setDisplaySize(size, size)
    if (seed.tint !== undefined) ghost.setTint(seed.tint)
    const root = scene.add.container(seed.x, seed.y, [glow, ghost]).setDepth(depth)
    const scaleTo = Phaser.Math.FloatBetween(5, 7)
    const delay = i * 26 // a ripple of departures, not one frame of eight launches
    // A touch of instant growth on launch, then Quad (not Cubic) acceleration: the ghost visibly
    // swells from its very first frames instead of hiding its whole flight in the final beats.
    root.setScale(1.2)
    scene.tweens.add({
      targets: root,
      x: seed.x + ux * exit,
      y: seed.y + uy * exit,
      scale: scaleTo,
      rotation: Phaser.Math.FloatBetween(-0.5, 0.5),
      delay,
      duration: ms,
      ease: 'Quad.easeIn', // accelerating AT the camera — the fly-past read
      onComplete: () => root.destroy(),
    })
    // Hold solid through most of the flight, then vanish while still moving — past us, not popped.
    scene.tweens.add({
      targets: root,
      alpha: 0,
      delay: delay + ms * 0.68,
      duration: ms * 0.32,
      ease: E.exit,
    })
  })
}

// ---------------------------------------------------------------------------
// flashBloom — the golden impact frame
// ---------------------------------------------------------------------------

export interface FlashBloomOpts {
  tint?: number
  /** Peak alpha (default 0.4 — a bloom, deliberately capped well under a white-out). */
  alpha?: number
  depth?: number
  ms?: number
}

/**
 * One warm full-screen bloom pop — the golden alternative to `cameras.flash`'s flat white, for
 * the frame where a jackpot-grade hit should light the whole phone. Kept under reduced motion
 * like the scenes' own impact frames (a single allowed flash), but honouring reduce-flashing by
 * swapping the pop for a long dim swell; alpha is hard-capped (photosensitivity is area ×
 * luminance change, and this covers the whole screen).
 */
export function flashBloom(scene: Phaser.Scene, opts: FlashBloomOpts = {}): void {
  if (!scene.textures.exists('bgglow')) return
  const soft = reduceFlashing()
  const { w: W, h: H } = screenSize()
  const bloom = scene.add
    .image(W / 2, H / 2, 'bgglow')
    .setTint(opts.tint ?? getTheme().goldBright)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDepth(opts.depth ?? FX_DEPTH + 1)
    .setScrollFactor(0)
    .setDisplaySize(W * 1.5, H * 1.5)
    .setAlpha(0)
  const peak = Math.min(0.5, opts.alpha ?? 0.4) * (soft ? 0.45 : 1) * quality.scale()
  const ms = opts.ms ?? 90
  scene.tweens.add({
    targets: bloom,
    alpha: peak,
    duration: soft ? 320 : ms,
    yoyo: true,
    hold: soft ? 120 : 40,
    ease: E.press,
    onComplete: () => bloom.destroy(),
  })
}

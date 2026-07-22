import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { JACKPOT_GOAL, WHEEL_PRIZES, rollWheelIndex } from '../core/jackpot'
import { mulberry32 } from '../core/rng'
import { addChips, addPendingBoost, loadSave } from '../core/save'
import type { BoostType } from '../core/types'
import { backOut, E, heartbeat, OVERSHOOT } from './motion'
import { quality } from './quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
import type { Theme } from './theme'
import { addPillButton, FONT, GOLD_PILL, goldFace } from './ui'

// ─────────────────────────────────────────────────────────────────────────────
// Jackpot Wheel — the "it fills as you play, then explodes into a spin" moment.
//
// Two exports:
//   • addJackpotMeter() — the slot-console charge meter for the HUD (fills one notch per level win).
//   • openJackpotWheel() — the wheel-of-fortune overlay (auto-spins, pays chips, on CLAIM continues).
//
// Both are built ENTIRELY from the shared toolkit (goldFace, theme tokens, motion eases, sfx cues,
// baked textures) so they read as native Golden-Hour art and restyle across all four themes for free.
// The overlay is an in-scene container (NOT a Scene) so it can burst over the live board after a win
// with no heavy scene-swap. Everything is reduced-motion / reduce-flashing / haptics aware.
// ─────────────────────────────────────────────────────────────────────────────

const deg = Phaser.Math.DegToRad

// ── HUD meter ────────────────────────────────────────────────────────────────

export interface JackpotMeter {
  container: Phaser.GameObjects.Container
  /** Light the meter to `meter`/JACKPOT_GOAL notches; pops the newly-lit notch when `animate`. */
  update(meter: number, animate?: boolean): void
}

/**
 * A slot-console JACKPOT charge meter: a gold "JACKPOT" label over a recessed track of JACKPOT_GOAL
 * pip cells that light gold as level wins charge it. When full the whole widget breathes to signal
 * "ready to spin". Read-only display — SaveData.jackpotMeter is the source of truth; call `update()`
 * after a bump. Returns a container safe to `.setDepth`/position. Theme-driven + reduced-motion aware.
 */
export function addJackpotMeter(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  opts: { width?: number; compact?: boolean } = {}
): JackpotMeter {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const width = opts.width ?? 300
  const compact = opts.compact ?? false
  const trackH = compact ? 24 : 26
  // Compact (Home HUD): the "JACKPOT" caption sits INLINE to the left of the track; otherwise above it.
  const labelW = compact ? 98 : 0
  const trackX0 = -width / 2 + labelW
  const trackW = width - labelW
  const container = scene.add.container(cx, cy)

  // Recessed track well (dark, so lit gold pips read as raised light).
  const well = scene.add.graphics()
  well.fillStyle(T.shadow, 0.28)
  well.fillRoundedRect(trackX0, -trackH / 2 + 2, trackW, trackH, trackH / 2)
  well.fillStyle(0x2a2417, 0.55)
  well.fillRoundedRect(trackX0, -trackH / 2, trackW, trackH, trackH / 2)
  well.lineStyle(2, T.goldDeep, 0.9)
  well.strokeRoundedRect(trackX0, -trackH / 2, trackW, trackH, trackH / 2)
  container.add(well)

  // Gold "JACKPOT" caption — above the track (default) or inline to its left (compact).
  const cap = scene.add
    .text(compact ? -width / 2 + labelW / 2 : 0, compact ? 0 : -trackH / 2 - 15, 'JACKPOT', {
      fontFamily: FONT,
      fontSize: '15px',
      fontStyle: '900',
      color: css(T.goldBright),
    })
    .setOrigin(0.5)
    .setLetterSpacing(compact ? 1 : 4)
    .setShadow(0, 1, 'rgba(80,50,10,0.5)', 2, false, true)
  container.add(cap)

  // Pip cells — one per notch. Each holds a pre-baked gold face, hidden until lit so it can pop in.
  const gap = 6
  const pad = 7
  const pipW = (trackW - pad * 2 - gap * (JACKPOT_GOAL - 1)) / JACKPOT_GOAL
  const pipH = trackH - pad
  const pips: Phaser.GameObjects.Container[] = []
  const pipX = (i: number): number => trackX0 + pad + pipW / 2 + i * (pipW + gap)
  for (let i = 0; i < JACKPOT_GOAL; i++) {
    const pip = scene.add.container(pipX(i), 0)
    const face = scene.add.graphics()
    goldFace(face, -pipW / 2, -pipH / 2, pipW, pipH, T, Math.min(pipH / 2, 7))
    pip.add(face)
    pip.setScale(0).setAlpha(0)
    container.add(pip)
    pips.push(pip)
  }

  // Soft "ready" halo behind the whole meter — hidden until near-full/full, then it lives (below).
  const halo = scene.add
    .image(0, 0, 'bgglow')
    .setTint(T.gold)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDisplaySize(width + 80, trackH + (compact ? 44 : 70))
    .setAlpha(0)
  container.addAt(halo, 0)
  let haloTween: Phaser.Tweens.Tween | null = null

  // ── Shared ember (one parked ADD emitter, pulsed by timers) ─────────────────
  // Used by BOTH the full-meter Home teaser (H4) and the R4 near-full "one win away" tease, so the
  // widget only ever owns a single emitter. Added to the container so it rides the transform and is
  // torn down with it; created once, then reused across state flips.
  let ember: Phaser.GameObjects.Particles.ParticleEmitter | null = null
  const emberLift = (): void => {
    const count = quality.count(1) // 1 on high/med, 0 on low → the ember self-gates off the low tier
    if (count <= 0) return
    if (!ember) {
      ember = scene.add.particles(0, 0, 'spark', {
        speed: { min: 24, max: 60 },
        angle: { min: 250, max: 290 }, // up off the track, with a little spread
        scale: { start: 0.42, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 620, max: 980 },
        tint: T.gold,
        blendMode: 'ADD',
        emitting: false,
      })
      container.add(ember)
    }
    ember.explode(count, trackX0 + Phaser.Math.Between(pad, trackW - pad), -trackH / 2)
  }

  // ── H4 · "ready to spin" teaser (Home hero meter only) ──────────────────────
  // A full meter should read as ARMED at a glance on Home. Over the breathing halo we lift a single
  // ember off the track every couple of seconds and glide a soft light-sweep across the "JACKPOT"
  // caption. SCOPED to the compact (Home) meter — the in-game HUD is the non-compact variant, so the
  // teaser never fires there and distracts play. Skipped whole under reduced motion (the lit halo alone
  // carries "ready" — today's look). Everything here is lazy: nothing exists until full on Home.
  let teaseTimer: Phaser.Time.TimerEvent | null = null
  let shimmer: Phaser.GameObjects.Image | null = null
  let shimmerTween: Phaser.Tweens.Tween | null = null

  const startTease = (): void => {
    // One ember every ~2.2s — off-phase from the halo breathe so the two never lock into a
    // mechanical beat — lifted from a random spot along the lit track so repeats don't stamp one place.
    teaseTimer = scene.time.addEvent({ delay: 2200, loop: true, callback: emberLift })

    // Caption shimmer — the wordmark's masked-gloss idiom (ui.ts): a cream `sweep` clipped to the
    // "JACKPOT" glyphs, gliding across on a slow loop with a long rest between passes.
    shimmer = scene.add
      .image(cap.x - labelW / 2, cap.y, 'sweep')
      .setDisplaySize(30, trackH + 4)
      .setTint(0xfffdf8)
      .setAlpha(0.5)
      .setBlendMode(Phaser.BlendModes.ADD)
    shimmer.setMask(cap.createBitmapMask())
    container.add(shimmer)
    shimmerTween = scene.tweens.add({
      targets: shimmer,
      x: cap.x + labelW / 2,
      duration: 1200,
      ease: 'Sine.easeInOut',
      repeat: -1,
      repeatDelay: 2400,
    })
  }

  const endTease = (): void => {
    teaseTimer?.remove()
    teaseTimer = null
    shimmerTween?.remove()
    shimmerTween = null
    shimmer?.clearMask(true) // frees the bitmap mask; leaves `cap` itself untouched
    shimmer?.destroy()
    shimmer = null
    // The parked ember emitter is cheap and reused across state flips, so it's kept in place;
    // it dies with the container on scene teardown.
  }

  // ── R4 · near-full tease (BOTH variants) ────────────────────────────────────
  // One notch from full is the "one win away" moment — the meter's glow phase-locks to the shared
  // heartbeat clock (motion.ts) so it pulses in time with every other hero breather on screen, and an
  // occasional ember lifts off the lit track. Reduced motion collapses to a STATIC soft halo (the
  // "almost there" signal survives, the pulse doesn't). The heartbeat drive is an update-loop read,
  // detached the moment the meter leaves the near-full state and on container destroy.
  let nearOn = false
  let nearTimer: Phaser.Time.TimerEvent | null = null
  const nearTick = (): void => {
    halo.setAlpha(0.07 + heartbeat.amp() * 0.26)
  }
  const startNear = (): void => {
    nearOn = true
    if (reduced) {
      halo.setAlpha(0.16) // static soft "almost" glow — no pulse, no sparks
      return
    }
    scene.events.on(Phaser.Scenes.Events.UPDATE, nearTick)
    nearTimer = scene.time.addEvent({ delay: 2600, loop: true, callback: emberLift })
  }
  const endNear = (): void => {
    if (!nearOn) return
    nearOn = false
    scene.events.off(Phaser.Scenes.Events.UPDATE, nearTick)
    nearTimer?.remove()
    nearTimer = null
  }
  container.once(Phaser.GameObjects.Events.DESTROY, () => {
    endNear()
    teaseTimer?.remove()
    teaseTimer = null
  })

  let lit = -1
  const update = (meter: number, animate = true): void => {
    const n = Math.max(0, Math.min(JACKPOT_GOAL, Math.floor(meter)))
    for (let i = 0; i < JACKPOT_GOAL; i++) {
      const on = i < n
      const pip = pips[i]
      if (on && (i > lit || !animate)) {
        // Newly lit (or a non-animated rebuild): pop it in.
        if (animate && !reduced) {
          pip.setScale(0).setAlpha(1)
          scene.tweens.add({ targets: pip, scale: 1, duration: 260, ease: backOut(OVERSHOOT.pop) })
          // R4 fill-tick glint: a thin cream gleam sweeps across the freshly-lit segment as it pops —
          // the "coin dropped into the slot" acknowledgement. Transient, self-destroying.
          const glint = scene.add
            .image(pipX(i) - pipW / 2, 0, 'sweep')
            .setDisplaySize(12, trackH - 4)
            .setTint(0xfffdf8)
            .setAlpha(0)
            .setBlendMode(Phaser.BlendModes.ADD)
          container.add(glint)
          scene.tweens.add({ targets: glint, alpha: 0.9, duration: 130, delay: 120, yoyo: true, ease: E.hero })
          scene.tweens.add({
            targets: glint,
            x: pipX(i) + pipW / 2,
            duration: 260,
            delay: 120,
            ease: E.settle,
            onComplete: () => glint.destroy(),
          })
        } else {
          pip.setScale(1).setAlpha(1)
        }
      } else if (!on) {
        pip.setScale(0).setAlpha(0)
      }
    }
    lit = n - 1
    // Halo state machine: full → breathing "armed" glow; one-from-full → heartbeat tease; else dark.
    const full = n >= JACKPOT_GOAL
    const near = n === JACKPOT_GOAL - 1
    haloTween?.remove()
    haloTween = null
    endNear()
    if (full) {
      halo.setAlpha(reduced ? 0.32 : 0.18)
      if (!reduced) {
        haloTween = scene.tweens.add({ targets: halo, alpha: 0.42, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
    } else if (near) {
      startNear()
    } else {
      halo.setAlpha(0)
    }
    // H4 · layer the Home "ready to spin" teaser over the lit halo — compact (Home) meter only, and
    // never under reduced motion. Cleared first so a re-fill or a drop back below full never stacks it.
    endTease()
    if (full && compact && !reduced) startTease()
  }

  return { container, update }
}

// ── Wheel overlay ────────────────────────────────────────────────────────────

export interface WheelResult {
  kind: 'chips' | 'boost'
  /** Chips won (0 for a boost prize). */
  chips: number
  /** Boost won, or null for a chip prize (banked to pendingBoosts, applies to the next level). */
  boost: BoostType | null
  /** Display name of a boost prize ('' for chips). */
  name: string
  jackpot: boolean
  /** Chip balance after banking (unchanged for a boost). */
  newTotal: number
}

export interface WheelOpenOpts {
  onClaim: (result: WheelResult) => void
  /**
   * Optional graded-freeze hook — GameScene passes its `hitstop` so the wheel's detent punch rides the
   * game's single freeze authority (created-under-the-freeze FX hold at peak and release together).
   * When absent (a host without a hitstop system) the beat simply plays unfrozen.
   */
  hitstop?: (ms: number) => void
  /**
   * Optional chip-fountain landing target — the host's balance readout, in the SAME camera space as
   * this scene. When set (and the prize is chips, full motion), the payoff arcs a governor-scaled
   * fountain of chips physically into it; `onLand(landed, total)` fires per landing so the host can
   * tick its displayed balance up in step. Never called under reduced motion (the claim handler's
   * final update is the readout's source of truth either way).
   */
  chipFlyTo?: { x: number; y: number; onLand?: (landed: number, total: number) => void }
}

const WEDGES = WHEEL_PRIZES.length // 8

/**
 * Studded cast-cabinet jackpot-wheel bezel drawn into `g`, centred on (cx,cy) radius R: a DEEP dish (6
 * graded tonal bands, lit outer lip → shaded inner groove) bracketed by two fine milled tracks (both lit
 * BY ANGLE — bright at the crown, dark at the base) with a ring of 24 raised STUDS marching between them,
 * then a bright inner lip ring where it meets the wedge disc, and a crown light-pool + gloss crescent.
 * Everything stays inside R+16, clear of the rim bulbs at R+20. Theme-token drawn (restyles per theme).
 * Exported so the dev atlas ('wheel' page) can render the real bezel — no drift.
 */
export function drawWheelBezel(
  g: Phaser.GameObjects.Graphics,
  cx: number,
  cy: number,
  R: number,
  T: Theme = getTheme()
): void {
  const TAU = Math.PI * 2
  // Deep cast belly — the widest band the whole dish is turned into.
  g.lineStyle(26, T.goldDeep, 1)
  g.strokeCircle(cx, cy, R)
  // Dished cross-section (6 tonal bands): lit outer lip → bezel wall → crown band (studs seat here) →
  // shaded lower wall → dark dish-bottom groove → inner wall rising back toward the lip.
  g.lineStyle(4, T.goldBright, 0.9)
  g.strokeCircle(cx, cy, R + 9)
  g.lineStyle(5, T.goldBezel, 1)
  g.strokeCircle(cx, cy, R + 4)
  g.lineStyle(6, T.gold, 1)
  g.strokeCircle(cx, cy, R - 1)
  g.lineStyle(7, T.goldDeep, 1)
  g.strokeCircle(cx, cy, R - 8)
  g.lineStyle(5, T.goldDarkest, 0.9)
  g.strokeCircle(cx, cy, R - 14)
  g.lineStyle(3, T.goldDeep, 0.8)
  g.strokeCircle(cx, cy, R - 18)
  // Outer milled track (R+11→R+16), tooth tone lit BY ANGLE; stays inside the rim bulbs at R+20.
  const oTeeth = 60
  for (let i = 0; i < oTeeth; i++) {
    const a = (i / oTeeth) * TAU
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const top = -sa
    const c = top > 0.45 ? T.goldBright : top > -0.15 ? T.gold : top > -0.6 ? T.goldDeep : T.goldDarkest
    g.lineStyle(i % 2 === 0 ? 2 : 1.2, c, i % 2 === 0 ? 0.9 : 0.6)
    g.lineBetween(cx + ca * (R + 11), cy + sa * (R + 11), cx + ca * (R + 16), cy + sa * (R + 16))
  }
  // Inner milled track (R-9→R-4) — the second rail the studs march between.
  const iTeeth = 54
  for (let i = 0; i < iTeeth; i++) {
    const a = (i / iTeeth) * TAU
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const top = -sa
    const c = top > 0.45 ? T.goldBright : top > -0.15 ? T.gold : top > -0.6 ? T.goldDeep : T.goldDarkest
    g.lineStyle(1.4, c, 0.7)
    g.lineBetween(cx + ca * (R - 9), cy + sa * (R - 9), cx + ca * (R - 4), cy + sa * (R - 4))
  }
  // Ring of 24 raised STUDS at R+3 between the tracks — the cabinet-rivet signature (offset-disc dome:
  // a pressed seat → a deep base → an angle-lit cap offset up → a specular).
  const studs = 24
  for (let i = 0; i < studs; i++) {
    const a = (i / studs) * TAU
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    const sx = cx + ca * (R + 3)
    const sy = cy + sa * (R + 3)
    const top = -sa
    g.fillStyle(0x000000, 0.22)
    g.fillCircle(sx, sy + 1.4, 5.4)
    g.fillStyle(T.goldDeep, 1)
    g.fillCircle(sx, sy, 4.6)
    const cap = top > 0.3 ? T.goldBright : top > -0.4 ? T.gold : T.goldDeep
    g.fillStyle(cap, 1)
    g.fillCircle(sx, sy - 1.3, 3.2)
    g.fillStyle(0xffffff, top > 0 ? 0.6 : 0.28)
    g.fillCircle(sx - 0.9, sy - 1.9, 1.1)
  }
  // Bright inner LIP ring where the bezel meets the wedge disc, seated by a dark shadow line just inside.
  g.lineStyle(3, T.goldBright, 0.85)
  g.strokeCircle(cx, cy, R - 19)
  g.lineStyle(2, T.goldDarkest, 0.7)
  g.strokeCircle(cx, cy, R - 22)
  // Warm crown light-pool + a broad gloss crescent across the upper bezel + a hard specular pip.
  g.fillStyle(T.glossHi, 0.12)
  g.fillEllipse(cx, cy - R, 60, 16)
  g.fillStyle(T.cardFill, 0.06)
  g.fillEllipse(cx, cy - R + 4, 120, 26)
  g.fillStyle(0xffffff, 0.55)
  g.fillCircle(cx, cy - R - 2, 2.5)
}

/**
 * Beveled cast-metal wheel pointer (the clacker) drawn into `g` in LOCAL space (origin 0,0 = the base
 * pivot; apex points DOWN toward the wheel). The silhouette matches the old flat triangle exactly —
 * (−26,−20)(26,−20)(0,30) — plus the +3 seat shadow, so the ±9° flex/spring the spin drives stays
 * unchanged; everything else is relief carved on top: a full cast bevel split on the centre spine (dark
 * right facet, lit left facet), a bright spine crest + specular, a chamfered lit tip, and a bigger domed
 * pivot rivet with a Phillips cross-slot. Exported for the dev atlas ('wheel' page).
 */
export function drawWheelPointer(g: Phaser.GameObjects.Graphics, T: Theme = getTheme()): void {
  // Seat drop shadow (offset +3 down — identical to v1).
  g.fillStyle(T.shadow, 0.3)
  g.fillTriangle(-26, -17, 26, -17, 0, 33)
  // Cast silhouette — footprint corners preserved EXACTLY → inset gold flank leaving the cast edge.
  g.fillStyle(T.goldDeep, 1)
  g.fillTriangle(-26, -20, 26, -20, 0, 30)
  g.fillStyle(T.gold, 1)
  g.fillTriangle(-20, -16, 20, -16, 0, 24)
  // Full cast bevel split on the centre spine: dark RIGHT facet, lit LEFT facet.
  g.fillStyle(T.goldDeep, 0.85)
  g.fillTriangle(0, -16, 20, -16, 0, 24)
  g.fillStyle(T.goldBezel, 1)
  g.fillTriangle(-20, -16, 0, -16, 0, 24)
  // Raised centre spine crest + a specular sliver.
  g.fillStyle(T.goldBright, 1)
  g.fillTriangle(-6, -16, 6, -16, 0, 26)
  g.fillStyle(T.glossHi, 0.5)
  g.fillTriangle(-2.5, -14, 2.5, -14, 0, 22)
  // Chamfered lit tip + a white spec at the apex.
  g.fillStyle(T.goldBright, 0.8)
  g.fillTriangle(-3.5, 19, 3.5, 19, 0, 30)
  g.fillStyle(0xffffff, 0.7)
  g.fillCircle(0, 26, 1.4)
  // Bigger domed pivot rivet with a Phillips CROSS-SLOT (offset-disc dome stack).
  g.fillStyle(0x000000, 0.2)
  g.fillEllipse(0, -6, 22, 8)
  g.fillStyle(T.goldDeep, 1)
  g.fillCircle(0, -11, 9)
  g.lineStyle(1.5, T.goldDarkest, 0.6)
  g.strokeCircle(0, -11, 9)
  g.lineStyle(1, T.goldBright, 0.5)
  g.strokeCircle(0, -11, 7.6)
  g.fillStyle(T.gold, 1)
  g.fillCircle(0, -12.5, 7)
  g.fillStyle(T.goldBright, 1)
  g.fillCircle(0, -13.5, 4)
  g.fillStyle(T.rim, 0.6)
  g.fillCircle(0, -14, 2.3)
  g.lineStyle(1.6, T.goldDarkest, 0.7)
  g.lineBetween(-4.5, -12, 4.5, -12)
  g.lineBetween(0, -16.5, 0, -8.5)
  g.lineStyle(1, T.goldBright, 0.45)
  g.lineBetween(-4.5, -12.8, 4.5, -12.8)
  g.fillStyle(0xffffff, 0.9)
  g.fillCircle(-1, -15, 1.2)
}

/**
 * Fire the Jackpot Wheel as a self-contained overlay on top of `scene` (above every gameplay/HUD
 * depth), NOT a new Scene. AWARD-FIRST: the winning wedge is chosen and the chips banked immediately,
 * then the wheel is rigged to land on that wedge — so quitting mid-spin can never lose the prize. The
 * wheel auto-spins (the "explosion" IS the trigger — no button to press), celebrates, and on CLAIM
 * calls `onClaim(result)` and tears everything down. A tap during the spin skips to the landed result.
 * Reduced-motion snaps straight to the result (audio still plays — sound is never "motion").
 *
 * R4 spin arc (full motion): wind-up crouch → acceleration under blur streaks → a LONG deceleration
 * whose per-wedge ticks space out naturally → an almost-stop on the wedge BEFORE the winner (the
 * near-miss beat) → a slow creep over the boundary → detent spring + graded hitstop → payoff
 * (screen-wide gold burst — a slow golden swell under reduce-flashing — chip fountain into the
 * balance readout, marquee letter-punch typography on a JACKPOT, camera breath).
 */
export function openJackpotWheel(scene: Phaser.Scene, opts: WheelOpenOpts): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const flashOff = reduceFlashing()

  // 1) AWARD-FIRST — decide + bank before a single pixel moves. Chips add to the balance; boosts bank
  // to pendingBoosts (applied when the next level starts, exactly like the daily spin).
  let idx = rollWheelIndex(mulberry32((Math.random() * 2 ** 31) | 0))
  if (import.meta.env.DEV) {
    // ?wedge=N — pin the winning wedge so automated checks can exercise every payoff deterministically.
    const w = Number(new URLSearchParams(location.search).get('wedge'))
    if (Number.isInteger(w) && w >= 0 && w < WHEEL_PRIZES.length) idx = w
  }
  const prize = WHEEL_PRIZES[idx]
  const isBoost = prize.kind === 'boost'
  const isJackpot = prize.kind === 'chips' && !!prize.jackpot
  if (prize.kind === 'boost') addPendingBoost(prize.boost)
  const newTotal = prize.kind === 'chips' ? addChips(prize.chips) : loadSave().chips
  const result: WheelResult = {
    kind: prize.kind,
    chips: prize.kind === 'chips' ? prize.chips : 0,
    boost: prize.kind === 'boost' ? prize.boost : null,
    name: prize.kind === 'boost' ? prize.name : '',
    jackpot: isJackpot,
    newTotal,
  }

  const cx = DESIGN_W / 2
  const cy = 566
  const R = 232

  // Everything created here is tracked so a single teardown removes it all. Teardown kills each
  // part's tweens FIRST (Phaser 3.90 never sweeps tweens for destroyed targets) and rests the camera.
  const parts: Phaser.GameObjects.GameObject[] = []
  const timers: Phaser.Time.TimerEvent[] = []
  const track = <G extends Phaser.GameObjects.GameObject>(o: G): G => (parts.push(o), o)
  const at = (ms: number, cb: () => void): void => {
    timers.push(scene.time.delayedCall(ms, cb))
  }
  const cam = scene.cameras.main
  const teardown = (): void => {
    for (const t of timers) t.remove(false)
    for (const p of parts) {
      if (p.active) {
        scene.tweens.killTweensOf(p)
        p.destroy()
      }
    }
    scene.tweens.killTweensOf(cam)
    cam.setZoom(1) // the payoff camera breath must never outlive the overlay
  }

  // 2) Scrim — firmly dim the board + HUD (so the wheel + title read as the sole focus) and swallow
  // taps meant for the board underneath.
  const scrim = track(
    scene.add.rectangle(cx, viewportCenterY(), DESIGN_W, worldH() + 400, T.scrim, reduced ? 0.82 : 0.001).setDepth(60).setInteractive()
  )
  if (!reduced) scene.tweens.add({ targets: scrim, fillAlpha: 0.82, duration: 200, ease: 'Quad.easeOut' })

  // 3) Title — seated in the gap between the HUD and the wheel bezel so it never fights the HUD.
  const title = track(
    scene.add
      .text(cx, 286, 'JACKPOT', { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(6)
      .setStroke(css(T.goldDarkest), 8)
      .setShadow(0, 4, 'rgba(70,45,10,0.5)', 8, false, true)
  )

  // 4) Rim bulbs (fixed cabinet frame) — alternating gold/rose, breathing like the marquee.
  const rim = track(scene.add.container(cx, cy).setDepth(61))
  const BULBS = 24
  const rimBulbs: Phaser.GameObjects.Image[] = []
  for (let i = 0; i < BULBS; i++) {
    const a = (i / BULBS) * Math.PI * 2
    const b = scene.add
      .image(Math.cos(a) * (R + 20), Math.sin(a) * (R + 20), 'bulb')
      .setDisplaySize(20, 20)
      .setTint(i % 2 === 0 ? T.goldBright : T.roseLight)
      .setAlpha(reduced ? 0.85 : 0.5)
    rim.add(b)
    rimBulbs.push(b)
    if (!reduced) {
      scene.tweens.add({
        targets: b,
        alpha: 1,
        duration: 620,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
        delay: (i % 6) * 150,
      })
    }
  }

  // 5) The wheel disc (this is what rotates). Precompute each wedge's fill + text colour: boosts are
  // navy (distinct "special" slots), the JACKPOT is rose, and the chip wedges alternate gold/cream.
  const wheel = track(scene.add.container(cx, cy).setDepth(61))
  const wedgeDeg = 360 / WEDGES
  let chipTone = 0
  const wedgeStyle = WHEEL_PRIZES.map(p => {
    if (p.kind === 'boost') return { fill: T.navy, text: css(T.goldBright) }
    if (p.jackpot) return { fill: T.rose, text: css(T.cardFillWarm) }
    const gold = chipTone++ % 2 === 0
    return { fill: gold ? T.gold : T.cardFill, text: gold ? T.navyText : css(T.goldDarkest) }
  })
  const disc = scene.add.graphics()
  for (let i = 0; i < WEDGES; i++) {
    const start = deg(i * wedgeDeg)
    const end = deg((i + 1) * wedgeDeg)
    disc.fillStyle(wedgeStyle[i].fill, 1)
    disc.slice(0, 0, R, start, end, false)
    disc.fillPath()
    // Crisp separator between wedges.
    disc.lineStyle(3, T.goldDeep, 0.9)
    disc.slice(0, 0, R, start, end, false)
    disc.strokePath()
  }
  wheel.add(disc)
  // Wedge labels — radiating outward from the hub, coloured for contrast on their wedge.
  for (let i = 0; i < WEDGES; i++) {
    const p = WHEEL_PRIZES[i]
    const rad = deg(i * wedgeDeg + wedgeDeg / 2)
    const big = p.kind === 'chips' && !p.jackpot
    const label = scene.add
      .text(Math.cos(rad) * R * 0.6, Math.sin(rad) * R * 0.6, p.label, {
        fontFamily: FONT,
        fontSize: big ? '34px' : p.kind === 'boost' ? '28px' : '26px',
        fontStyle: '900',
        color: wedgeStyle[i].text,
        align: 'center',
      })
      .setOrigin(0.5)
      .setRotation(rad + Math.PI / 2)
    if (p.kind === 'chips' && p.jackpot) label.setWordWrapWidth(120)
    wheel.add(label)
  }

  // 5b) R4 blur streaks — a ring of tangential additive gleams that fade in as the wheel winds up to
  // full speed and counter-spin fast, selling motion blur without any shader. Governor-scaled count
  // (0 on the LOW tier → the layer simply never shows) and torn down with everything else.
  const streaks = track(scene.add.container(cx, cy).setDepth(61).setAlpha(0))
  const nStreaks = quality.count(5)
  for (let i = 0; i < nStreaks; i++) {
    const a = (i / nStreaks) * Math.PI * 2
    const s = scene.add
      .image(Math.cos(a) * R * 0.72, Math.sin(a) * R * 0.72, 'sweep')
      .setDisplaySize(96, 26)
      .setTint(T.goldBright)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setRotation(a + Math.PI / 2)
      .setAlpha(0.4 + (i % 2) * 0.3)
    streaks.add(s)
  }

  // 6) Dished-metal bezel ring (over the disc rim) + hub cap + beveled cast pointer.
  const bezel = track(scene.add.graphics().setDepth(61))
  drawWheelBezel(bezel, cx, cy, R, T)

  const hub = track(scene.add.image(cx, cy, 'jackpot').setDisplaySize(96, 96).setDepth(62))

  // Pointer in a CONTAINER pivoting at its base so passing wedge pegs can flex it (the classic
  // clacker). Geometry matches the old fixed graphic exactly when at rest (angle 0).
  const py = cy - R - 6
  const pointerC = track(scene.add.container(cx, py).setDepth(62))
  const pointerG = scene.add.graphics()
  drawWheelPointer(pointerG, T)
  pointerC.add(pointerG)

  // Entrance pop for the whole rig (wheel + rim + bezel + hub).
  const rig: Phaser.GameObjects.GameObject[] = [wheel, rim, bezel, hub]
  if (!reduced) {
    for (const o of rig) (o as unknown as { setScale: (s: number) => void }).setScale(0.6)
    ;(title as Phaser.GameObjects.Text).setScale(0)
    scene.tweens.add({ targets: rig, scale: 1, duration: 420, ease: backOut(OVERSHOOT.gentle) })
    scene.tweens.add({ targets: title, scale: 1, duration: 340, delay: 120, ease: 'Back.easeOut' })
  }

  // ── Landing geometry (award-first rig) ──────────────────────────────────────
  // Wedge i spans [i·wedgeDeg, (i+1)·wedgeDeg] clockwise from EAST at rotation 0; its centre sits at
  // i·wedgeDeg + wedgeDeg/2. The fixed pointer is at the TOP (−90° from east). To bring wedge `idx`
  // under the pointer: wheel rotation ≡ −90 − (idx·wedgeDeg + wedgeDeg/2)  (mod 360). Add whole spins
  // for drama. Landing on this exact angle is what makes the pre-chosen result honest.
  const centerDeg = idx * wedgeDeg + wedgeDeg / 2
  const landDeg = ((-90 - centerDeg) % 360 + 360) % 360
  const SPINS = 5
  const targetDeg = SPINS * 360 + landDeg

  let settled = false

  // DEV-only rig probe (stripped from prod) — lets an automated check assert the wheel lands on the
  // pre-chosen wedge (that the spin is honest) and that the payout matches.
  const dev = import.meta.env.DEV ? { idx, chips: result.chips, jackpot: isJackpot, boost: result.boost, newTotal, landed: false, rotationDeg: 0 } : null
  if (dev) (window as unknown as { __wheel?: unknown }).__wheel = dev

  // ── Payoff layers (celebrate composes these) ────────────────────────────────

  /**
   * Screen-wide gold light burst — the payoff's room-filling flash. Reduce-flashing swaps the bright
   * pop for a SLOW GOLDEN SWELL (a glow that breathes up and back down, never a strobe). Skipped
   * whole under reduced motion (the celebration is snapped-to-rest there).
   */
  const goldBurst = (): void => {
    if (reduced) return
    const burst = track(
      scene.add
        .image(cx, cy, 'bgglow')
        .setTint(T.goldBright)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(63)
        .setDisplaySize(DESIGN_W * 2.6, worldH() * 1.7)
    )
    if (flashOff) {
      burst.setAlpha(0)
      scene.tweens.add({
        targets: burst,
        alpha: isJackpot ? 0.34 : 0.24,
        duration: 640,
        yoyo: true,
        hold: 220,
        ease: 'Sine.easeInOut',
        onComplete: () => burst.destroy(),
      })
    } else {
      burst.setAlpha(isJackpot ? 0.9 : 0.7)
      scene.tweens.add({ targets: burst, alpha: 0, duration: 620, ease: 'Quad.easeOut', onComplete: () => burst.destroy() })
    }
  }

  /**
   * Chip fountain — the prize physically pours into the balance readout. Each chip launches UP out of
   * the hub on its own arc (staggered), hangs, then dives into `chipFlyTo` with a landing spark +
   * a per-landing tick so the host's readout climbs in step. Governor-scaled count; every piece is
   * tracked + self-destroying; chip prizes only.
   */
  const chipFountain = (): void => {
    const fly = opts.chipFlyTo
    if (reduced || isBoost || !fly) return
    const n = Math.max(1, quality.count(isJackpot ? 14 : Math.min(10, 5 + Math.floor(result.chips / 100))))
    const landSparks = track(
      scene.add
        .particles(0, 0, 'spark', {
          speed: { min: 40, max: 160 },
          angle: { min: 0, max: 360 },
          scale: { start: 0.5, end: 0 },
          alpha: { start: 0.9, end: 0 },
          lifespan: { min: 240, max: 420 },
          tint: T.goldBright,
          blendMode: 'ADD',
          emitting: false,
        })
        .setDepth(64)
    )
    let landed = 0
    sfx.coinCount()
    for (let i = 0; i < n; i++) {
      const c = track(
        scene.add
          .image(cx, cy - 16, 'chip')
          .setDepth(63)
          .setDisplaySize(44, 44)
          .setAlpha(0)
      )
      const delay = 90 + i * 70
      const apexX = cx + Phaser.Math.Between(-190, 190)
      const apexY = cy - Phaser.Math.Between(210, 340)
      const spin = Phaser.Math.Between(140, 300) * (Math.random() < 0.5 ? -1 : 1)
      // Launch: alpha snaps on, x drifts linearly while y rises on an ease-out — a believable arc apex.
      scene.tweens.add({ targets: c, alpha: 1, duration: 60, delay, ease: 'Quad.easeOut' })
      scene.tweens.add({ targets: c, x: apexX, angle: spin, duration: 400, delay, ease: 'Sine.easeOut' })
      scene.tweens.add({
        targets: c,
        y: apexY,
        duration: 400,
        delay,
        ease: 'Quad.easeOut',
        onComplete: () => {
          // Dive: a gravity-flavoured plunge into the readout, shrinking as it "enters" the pill.
          scene.tweens.add({
            targets: c,
            x: fly.x,
            y: fly.y,
            angle: spin * 2,
            displayWidth: 20,
            displayHeight: 20,
            duration: 440,
            ease: 'Cubic.easeIn',
            onComplete: () => {
              landed++
              landSparks.explode(quality.count(3), fly.x, fly.y)
              sfx.scoreTick()
              fly.onLand?.(landed, n)
              c.destroy()
            },
          })
        },
      })
    }
  }

  /**
   * Marquee-grade "JACKPOT!" typography — each letter punches in on its own eager overshoot with a
   * tiny random cant, then a cream gleam sweeps the whole word. Jackpot payoffs only, full motion
   * (reduced motion / lesser prizes keep the single static headline).
   */
  const marqueeHeadline = (): void => {
    const word = 'JACKPOT!'
    const size = 64
    const letterW = 44
    const x0 = cx - ((word.length - 1) * letterW) / 2
    const letters: Phaser.GameObjects.Text[] = []
    for (let i = 0; i < word.length; i++) {
      const L = track(
        scene.add
          .text(x0 + i * letterW, 856, word[i], { fontFamily: FONT, fontSize: `${size}px`, fontStyle: '900', color: css(T.goldBright) })
          .setOrigin(0.5)
          .setDepth(63)
          .setStroke(css(T.goldDarkest), 9)
          .setShadow(0, 5, 'rgba(70,45,10,0.55)', 9, false, true)
          .setScale(0)
          .setAngle(Phaser.Math.Between(-8, 8))
      )
      letters.push(L)
      scene.tweens.add({ targets: L, scale: 1, angle: 0, duration: 300, delay: i * 55, ease: backOut(OVERSHOOT.pop) })
    }
    // Amount readout under the marquee word.
    const amount = track(
      scene.add
        .text(cx, 920, `+${result.chips.toLocaleString()} CHIPS`, { fontFamily: FONT, fontSize: '34px', fontStyle: '900', color: css(T.roseLight) })
        .setOrigin(0.5)
        .setDepth(63)
        .setStroke(css(T.goldDarkest), 6)
        .setScale(0)
    )
    scene.tweens.add({ targets: amount, scale: 1, duration: 300, delay: word.length * 55 + 80, ease: backOut(OVERSHOOT.pop) })
    // One cream gleam gliding across the word once the letters have landed.
    const gleam = track(
      scene.add
        .image(x0 - letterW, 856, 'sweep')
        .setDisplaySize(46, size + 26)
        .setTint(0xfffdf8)
        .setAlpha(0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(63)
        .setAngle(12)
    )
    const sweepDelay = word.length * 55 + 240
    scene.tweens.add({ targets: gleam, x: x0 + word.length * letterW, duration: 340, delay: sweepDelay, ease: E.glide, onComplete: () => gleam.destroy() })
    scene.tweens.add({ targets: gleam, alpha: 0.7, duration: 170, delay: sweepDelay, yoyo: true, ease: E.hero })
    // The rim answers: every bulb pops bright in a fast chase (a soft lift under reduce-flashing).
    rimBulbs.forEach((b, i) => {
      scene.tweens.killTweensOf(b)
      scene.tweens.add({
        targets: b,
        alpha: 1,
        scale: b.scale * (flashOff ? 1.15 : 1.5),
        duration: flashOff ? 420 : 150,
        delay: i * (flashOff ? 30 : 18),
        yoyo: true,
        ease: 'Quad.easeOut',
      })
    })
  }

  const celebrate = (): void => {
    if (settled) return
    settled = true
    scene.tweens.killTweensOf(wheel)
    wheel.setRotation(deg(targetDeg))
    // A skip during the entrance pop kills the SHARED rig tween (it targets the wheel), which would
    // freeze rim/bezel/hub mid-scale and shatter the payoff geometry — snap the rig to its rest
    // (scale 1 is the entrance tween's exact end state; under reduced motion it never scaled down).
    if (!reduced) for (const o of rig) (o as unknown as { setScale: (s: number) => void }).setScale(1)
    // Retire the blur-streak ring + rest the pointer (a skip can arrive mid-spin, mid-flex).
    scene.tweens.killTweensOf(streaks)
    streaks.setAlpha(0)
    scene.tweens.killTweensOf(pointerC)
    pointerC.setAngle(0)
    if (dev) {
      dev.landed = true
      dev.rotationDeg = Phaser.Math.RadToDeg(wheel.rotation)
    }

    // Graded freeze at the detent — created-under-the-freeze FX below hold at peak and release
    // together (the host's single freeze authority; absent host → plays unfrozen).
    opts.hitstop?.(isJackpot ? 90 : 60)

    // Winner spotlight: a gold glow pinned over the winning wedge (now at the top pointer).
    const glow = track(
      scene.add
        .image(cx, cy - R * 0.62, 'bgglow')
        .setTint(isJackpot ? T.rose : T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(220, 220)
        .setDepth(61)
        .setAlpha(0)
    )
    if (reduced) glow.setAlpha(0.5)
    else scene.tweens.add({ targets: glow, alpha: 0.5, duration: 240, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })

    // Detent + punch.
    sfx.reelClunk(0)
    if (!hapticsOff()) navigator.vibrate?.(isJackpot ? [20, 40, 30] : 16)
    if (!reduced) scene.cameras.main.shake(isJackpot ? 260 : 120, isJackpot ? 0.008 : 0.004)

    // R4 payoff: the room floods gold (slow swell when flash-averse) and the screen takes one breath.
    goldBurst()
    if (!reduced) {
      cam.setZoom(1)
      scene.tweens.add({ targets: cam, zoom: isJackpot ? 1.016 : 1.01, duration: 150, yoyo: true, hold: 60, ease: 'Quad.easeOut', onComplete: () => cam.setZoom(1) })
    }

    // Burst FX (shockwave + sparks + confetti; a heart bloom crowns a jackpot).
    if (!reduced) {
      const shock = track(
        scene.add.image(cx, cy, 'shockwave').setBlendMode(Phaser.BlendModes.ADD).setDepth(62).setDisplaySize(120, 120).setAlpha(0.9)
      )
      scene.tweens.add({
        targets: shock,
        displayWidth: 620,
        displayHeight: 620,
        alpha: 0,
        duration: 620,
        ease: 'Cubic.easeOut',
        onComplete: () => shock.destroy(),
      })
      const sparks = track(
        scene.add
          .particles(cx, cy, 'spark', {
            speed: { min: 160, max: 460 },
            angle: { min: 0, max: 360 },
            scale: { start: 1, end: 0 },
            alpha: { start: 1, end: 0 },
            lifespan: { min: 400, max: 800 },
            blendMode: 'ADD',
            emitting: false,
          })
          .setDepth(62)
      )
      sparks.explode(quality.count(isJackpot ? 40 : 22))
      const confetti = track(
        scene.add
          .particles(cx, cy - 40, 'confetti', {
            speed: { min: 180, max: 460 },
            angle: { min: 200, max: 340 },
            scale: { start: 1.4, end: 0.3 },
            alpha: { start: 1, end: 0 },
            lifespan: { min: 900, max: 1600 },
            gravityY: 620,
            rotate: { min: -180, max: 180 },
            tint: [T.gold, T.goldBright, T.rose, T.roseLight, T.cardFillWarm],
            emitting: false,
          })
          .setDepth(62)
      )
      confetti.explode(quality.count(isJackpot ? 60 : 30))
      if (isJackpot) {
        const bloom = track(
          scene.add.image(cx, cy, 'heartglow').setTint(T.bloom).setBlendMode(Phaser.BlendModes.ADD).setDepth(61).setDisplaySize(200, 200).setAlpha(0)
        )
        scene.tweens.add({ targets: bloom, alpha: 0.5, displayWidth: 520, displayHeight: 520, duration: 520, ease: 'Back.easeOut', yoyo: true, hold: 200 })
      }
    }

    // Reward voice.
    if (isJackpot) {
      sfx.jackpotStrike()
      sfx.mayaMotif()
    } else {
      sfx.winFanfare()
    }

    // Prize readout — a JACKPOT gets the marquee letter-punch moment; chips/boosts keep the single
    // headline ("+N CHIPS" / "WILD REEL!" + a hint that it applies to the next level).
    if (isJackpot && !reduced) {
      marqueeHeadline()
    } else {
      const headline = isBoost ? `${result.name}!` : isJackpot ? `JACKPOT!  +${result.chips.toLocaleString()}` : `+${result.chips.toLocaleString()} CHIPS`
      const prizeText = track(
        scene.add
          .text(cx, isBoost ? 856 : 872, headline, { fontFamily: FONT, fontSize: isJackpot ? '48px' : '44px', fontStyle: '900', color: css(isJackpot ? T.roseLight : T.goldBright) })
          .setOrigin(0.5)
          .setDepth(62)
          .setStroke(css(T.goldDarkest), 7)
          .setShadow(0, 4, 'rgba(70,45,10,0.5)', 8, false, true)
      )
      if (isBoost) {
        track(
          scene.add
            .text(cx, 898, 'applies to your next level', { fontFamily: FONT, fontSize: '20px', fontStyle: '700', color: css(T.cardFillWarm) })
            .setOrigin(0.5)
            .setDepth(62)
        )
      }
      if (reduced) {
        prizeText.setScale(1)
      } else {
        prizeText.setScale(0)
        scene.tweens.add({ targets: prizeText, scale: 1, duration: 340, ease: backOut(OVERSHOOT.pop) })
      }
    }
    if (!isBoost) sfx.coinCount()

    // The fountain pours after the burst peaks — the prize physically enters the balance readout.
    at(reduced ? 0 : 260, chipFountain)

    // CLAIM — the only exit. Fades the overlay, then hands control back to the caller.
    const claim = track(
      addPillButton(scene, cx, 992, 300, 84, 'CLAIM', GOLD_PILL, () => {
        const gone: Phaser.GameObjects.GameObject[] = []
        for (const p of parts) if (p.active) gone.push(p)
        scene.tweens.add({
          targets: gone,
          alpha: 0,
          duration: reduced ? 90 : 220,
          ease: 'Quad.easeIn',
          onComplete: () => {
            teardown()
            opts.onClaim(result)
          },
        })
      }, { juice: true }).setDepth(64)
    )
    if (reduced) {
      claim.setScale(1)
    } else {
      claim.setScale(0)
      scene.tweens.add({ targets: claim, scale: 1, duration: 300, delay: 240, ease: 'Back.easeOut' })
    }
  }

  // ── Spin ────────────────────────────────────────────────────────────────────
  const startSpin = (): void => {
    if (settled) return // an early tap already skipped to the payoff — never re-spin under it
    if (reduced) {
      celebrate()
      return
    }
    sfx.charge()
    // A quick launch flash from the hub, then the reel sweep as it winds up.
    const flash = track(
      scene.add.image(cx, cy, 'fireball').setBlendMode(Phaser.BlendModes.ADD).setDepth(62).setDisplaySize(120, 120).setAlpha(0.9)
    )
    scene.tweens.add({ targets: flash, displayWidth: 340, displayHeight: 340, alpha: 0, duration: 360, ease: 'Cubic.easeOut', onComplete: () => flash.destroy() })
    sfx.reelSweep()

    // Tick per wedge crossing under the pointer — throttled so the fast early spin doesn't machine-gun,
    // spacing out naturally as it decelerates (the satisfying "tick..tick.tick.tick" settle). Each tick
    // also FLEXES the pointer off its rest and springs it back — the clacker dragging over a peg.
    let lastTick = -1
    let lastTickAt = 0
    const onUpdate = (): void => {
      const passed = Math.floor((wheel.rotation / (Math.PI * 2)) * WEDGES)
      const now = scene.time.now
      if (passed !== lastTick && now - lastTickAt >= 45) {
        lastTick = passed
        lastTickAt = now
        sfx.reelClunk(0)
        if (pointerC.active) {
          scene.tweens.killTweensOf(pointerC)
          pointerC.setAngle(9) // kicked in the wheel's spin direction…
          scene.tweens.add({ targets: pointerC, angle: 0, duration: 140, ease: backOut(OVERSHOOT.release) }) // …springs back
        }
      }
    }

    // Blur-streak ring: fades up as the wheel approaches full speed, counter-spins hard, and bleeds
    // away as the deceleration begins — pure motion-blur suggestion, no shader. The whole in-hold-out
    // envelope is ONE alpha chain (tween clock, not a timer) so it can never race its own fade-in.
    if (nStreaks > 0) {
      scene.tweens.add({ targets: streaks, rotation: -Math.PI * 10, duration: 2400, ease: 'Sine.easeOut' })
      scene.tweens.chain({
        targets: streaks,
        tweens: [
          { alpha: 0.55, delay: 260, duration: 420, ease: 'Quad.easeIn' }, // up with the wind-up
          { alpha: 0, delay: 650, duration: 900, ease: 'Quad.easeOut' }, // bleeds off into the decel
        ],
      })
    }

    // R4 spin arc: crouch → accelerate → long tick-slowing decel → NEAR-MISS almost-stop on the wedge
    // BEFORE the winner → slow creep over the boundary (one last reluctant tick) → detent spring.
    // Every segment ends inside the same chain, and the chain ends on `targetDeg` exactly — the
    // award-first rig stays honest through all the theatre.
    const nearStopDeg = targetDeg - wedgeDeg * 0.62 // all but stopped on the LOSING neighbour…
    const creepDeg = targetDeg + wedgeDeg * 0.16 // …then barely crawls past the boundary tick
    scene.tweens.chain({
      targets: wheel,
      onComplete: celebrate,
      tweens: [
        { rotation: deg(-14), duration: 240, ease: 'Quad.easeOut' }, // anticipation crouch (counter-wind)
        { rotation: deg(targetDeg * 0.42), duration: 760, ease: 'Quad.easeIn', onUpdate }, // wind up to full speed
        { rotation: deg(nearStopDeg), duration: 2500, ease: 'Cubic.easeOut', onUpdate }, // the long spend-down
        { rotation: deg(creepDeg), delay: 170, duration: 720, ease: 'Sine.easeInOut', onUpdate }, // near-miss creep
        { rotation: deg(targetDeg), duration: 300, ease: backOut(OVERSHOOT.pop) }, // detent spring
      ],
    })
  }

  // Tap-to-skip during the spin jumps straight to the landed celebration.
  scene.input.once('pointerdown', () => {
    if (settled) return
    scene.tweens.killTweensOf(wheel)
    celebrate()
  })

  // Kick it off after the entrance settles (the "explosion" into a spin).
  at(reduced ? 60 : 560, startSpin)
}

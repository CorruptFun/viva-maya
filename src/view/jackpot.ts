import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, worldH } from '../config'
import { JACKPOT_GOAL, WHEEL_PRIZES, rollWheelIndex } from '../core/jackpot'
import { mulberry32 } from '../core/rng'
import { addChips, addPendingBoost, loadSave } from '../core/save'
import type { BoostType } from '../core/types'
import { backOut, OVERSHOOT } from './motion'
import { quality } from './quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
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
  for (let i = 0; i < JACKPOT_GOAL; i++) {
    const px = trackX0 + pad + pipW / 2 + i * (pipW + gap)
    const pip = scene.add.container(px, 0)
    const face = scene.add.graphics()
    goldFace(face, -pipW / 2, -pipH / 2, pipW, pipH, T, Math.min(pipH / 2, 7))
    pip.add(face)
    pip.setScale(0).setAlpha(0)
    container.add(pip)
    pips.push(pip)
  }

  // Soft "ready" halo behind the whole meter — hidden until full, then breathes.
  const halo = scene.add
    .image(0, 0, 'bgglow')
    .setTint(T.gold)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDisplaySize(width + 80, trackH + (compact ? 44 : 70))
    .setAlpha(0)
  container.addAt(halo, 0)
  let haloTween: Phaser.Tweens.Tween | null = null

  // ── H4 · "ready to spin" teaser (Home hero meter only) ──────────────────────
  // A full meter should read as ARMED at a glance on Home. Over the breathing halo we lift a single
  // ember off the track every couple of seconds and glide a soft light-sweep across the "JACKPOT"
  // caption. SCOPED to the compact (Home) meter — the in-game HUD is the non-compact variant, so the
  // teaser never fires there and distracts play. Skipped whole under reduced motion (the lit halo alone
  // carries "ready" — today's look). The ember is quality.count()-capped, thinning to nothing on the low
  // tier. Everything here is lazy: nothing exists until the meter is actually full on Home.
  let teaseSpark: Phaser.GameObjects.Particles.ParticleEmitter | null = null
  let teaseTimer: Phaser.Time.TimerEvent | null = null
  let shimmer: Phaser.GameObjects.Image | null = null
  let shimmerTween: Phaser.Tweens.Tween | null = null

  const startTease = (): void => {
    // One shared ADD ember emitter, parked (emitting:false) and pulsed only by the timer. Added to the
    // container so it rides the widget's transform + is torn down with it; created once, then reused.
    if (!teaseSpark) {
      teaseSpark = scene.add.particles(0, 0, 'spark', {
        speed: { min: 24, max: 60 },
        angle: { min: 250, max: 290 }, // up off the track, with a little spread
        scale: { start: 0.42, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 620, max: 980 },
        tint: T.gold,
        blendMode: 'ADD',
        emitting: false,
      })
      container.add(teaseSpark)
    }
    // One ember every ~2.2s — off-phase from the 1.8s halo breathe so the two never lock into a
    // mechanical beat — lifted from a random spot along the lit track so repeats don't stamp one place.
    teaseTimer = scene.time.addEvent({
      delay: 2200,
      loop: true,
      callback: () => {
        const count = quality.count(1) // 1 on high/med, 0 on low → the ember self-gates off the low tier
        if (count > 0) teaseSpark?.explode(count, trackX0 + Phaser.Math.Between(pad, trackW - pad), -trackH / 2)
      },
    })

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
    // The parked ember emitter is cheap and reused across full↔not-full toggles, so it's kept in place;
    // it dies with the container on scene teardown.
  }

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
        } else {
          pip.setScale(1).setAlpha(1)
        }
      } else if (!on) {
        pip.setScale(0).setAlpha(0)
      }
    }
    lit = n - 1
    // Full → light the halo + a gentle breathe; otherwise keep it dark.
    const full = n >= JACKPOT_GOAL
    haloTween?.remove()
    haloTween = null
    if (full) {
      halo.setAlpha(reduced ? 0.32 : 0.18)
      if (!reduced) {
        haloTween = scene.tweens.add({ targets: halo, alpha: 0.42, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
      }
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

const WEDGES = WHEEL_PRIZES.length // 8

/**
 * Fire the Jackpot Wheel as a self-contained overlay on top of `scene` (above every gameplay/HUD
 * depth), NOT a new Scene. AWARD-FIRST: the winning wedge is chosen and the chips banked immediately,
 * then the wheel is rigged to land on that wedge — so quitting mid-spin can never lose the prize. The
 * wheel auto-spins (the "explosion" IS the trigger — no button to press), celebrates, and on CLAIM
 * calls `onClaim(result)` and tears everything down. A tap during the spin skips to the landed result.
 * Reduced-motion snaps straight to the result (audio still plays — sound is never "motion").
 */
export function openJackpotWheel(scene: Phaser.Scene, opts: { onClaim: (result: WheelResult) => void }): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const flashOff = reduceFlashing()

  // 1) AWARD-FIRST — decide + bank before a single pixel moves. Chips add to the balance; boosts bank
  // to pendingBoosts (applied when the next level starts, exactly like the daily spin).
  const idx = rollWheelIndex(mulberry32((Math.random() * 2 ** 31) | 0))
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

  // Everything created here is tracked so a single teardown removes it all.
  const parts: Phaser.GameObjects.GameObject[] = []
  const timers: Phaser.Time.TimerEvent[] = []
  const track = <G extends Phaser.GameObjects.GameObject>(o: G): G => (parts.push(o), o)
  const at = (ms: number, cb: () => void): void => {
    timers.push(scene.time.delayedCall(ms, cb))
  }
  const teardown = (): void => {
    for (const t of timers) t.remove(false)
    for (const p of parts) if (p.active) p.destroy()
  }

  // 2) Scrim — firmly dim the board + HUD (so the wheel + title read as the sole focus) and swallow
  // taps meant for the board underneath.
  const scrim = track(
    scene.add.rectangle(cx, 640, DESIGN_W, worldH() + 400, T.scrim, reduced ? 0.82 : 0.001).setDepth(60).setInteractive()
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
  for (let i = 0; i < BULBS; i++) {
    const a = (i / BULBS) * Math.PI * 2
    const b = scene.add
      .image(Math.cos(a) * (R + 20), Math.sin(a) * (R + 20), 'bulb')
      .setDisplaySize(20, 20)
      .setTint(i % 2 === 0 ? T.goldBright : T.roseLight)
      .setAlpha(reduced ? 0.85 : 0.5)
    rim.add(b)
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

  // 6) Metallic bezel ring (over the disc rim) + hub cap + fixed top pointer.
  const bezel = track(scene.add.graphics().setDepth(61))
  bezel.lineStyle(14, T.goldDeep, 1)
  bezel.strokeCircle(cx, cy, R)
  bezel.lineStyle(8, T.gold, 1)
  bezel.strokeCircle(cx, cy, R)
  bezel.lineStyle(3, T.goldBright, 0.9)
  bezel.strokeCircle(cx, cy, R - 4)

  const hub = track(scene.add.image(cx, cy, 'jackpot').setDisplaySize(96, 96).setDepth(62))

  const pointer = track(scene.add.graphics().setDepth(62))
  const py = cy - R - 6
  pointer.fillStyle(T.shadow, 0.3)
  pointer.fillTriangle(cx - 26, py - 20 + 3, cx + 26, py - 20 + 3, cx, py + 30 + 3)
  pointer.fillStyle(T.goldDeep, 1)
  pointer.fillTriangle(cx - 26, py - 20, cx + 26, py - 20, cx, py + 30)
  pointer.fillStyle(T.goldBright, 1)
  pointer.fillTriangle(cx - 17, py - 14, cx + 17, py - 14, cx, py + 18)

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
  const overshootDeg = wedgeDeg * 0.4 // spins ~0.4 wedge past, then springs back into the detent

  let settled = false

  // DEV-only rig probe (stripped from prod) — lets an automated check assert the wheel lands on the
  // pre-chosen wedge (that the spin is honest) and that the payout matches.
  const dev = import.meta.env.DEV ? { idx, chips: result.chips, jackpot: isJackpot, boost: result.boost, newTotal, landed: false, rotationDeg: 0 } : null
  if (dev) (window as unknown as { __wheel?: unknown }).__wheel = dev

  const celebrate = (): void => {
    if (settled) return
    settled = true
    wheel.setRotation(deg(targetDeg))
    if (dev) {
      dev.landed = true
      dev.rotationDeg = Phaser.Math.RadToDeg(wheel.rotation)
    }

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
    scene.tweens.add({ targets: glow, alpha: 0.5, duration: 240, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })

    // Detent + punch.
    sfx.reelClunk(0)
    if (!hapticsOff()) navigator.vibrate?.(isJackpot ? [20, 40, 30] : 16)
    if (!reduced) scene.cameras.main.shake(isJackpot ? 260 : 120, isJackpot ? 0.008 : 0.004)
    if (!flashOff && isJackpot) scene.cameras.main.flash(220, 255, 240, 210)

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
      sparks.explode(isJackpot ? 40 : 22)
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
      confetti.explode(isJackpot ? 60 : 30)
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

    // Prize readout — chips ("+N CHIPS" / "JACKPOT! +1000") or a boost ("WILD REEL!" + a hint that
    // it applies to the next level). Coins only roll for a chip payout.
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
    if (!isBoost) sfx.coinCount()

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
      }, { juice: true }).setDepth(62)
    )
    claim.setScale(0)
    scene.tweens.add({ targets: claim, scale: 1, duration: 300, delay: reduced ? 0 : 240, ease: 'Back.easeOut' })
  }

  // ── Spin ────────────────────────────────────────────────────────────────────
  const startSpin = (): void => {
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
    // spacing out naturally as it decelerates (the satisfying "tick..tick.tick.tick" settle).
    let lastTick = -1
    let lastTickAt = 0
    const onUpdate = (): void => {
      const passed = Math.floor((wheel.rotation / (Math.PI * 2)) * WEDGES)
      const now = scene.time.now
      // One clunk per wedge crossing, but throttled so the fast early spin doesn't machine-gun; as
      // the wheel decelerates the crossings space past the throttle and every wedge ticks — the
      // satisfying "tick..tick.tick.tick" settle.
      if (passed !== lastTick && now - lastTickAt >= 45) {
        lastTick = passed
        lastTickAt = now
        sfx.reelClunk(0)
      }
    }

    // Long decel that overshoots the detent, then a short spring back onto the exact landing angle
    // (mirrors the daily reel-2 suspense beat). Chain ends on `targetDeg`, so the rig stays honest.
    scene.tweens.chain({
      targets: wheel,
      onComplete: celebrate,
      tweens: [
        { rotation: deg(targetDeg + overshootDeg), duration: 2600, ease: 'Cubic.easeOut', onUpdate },
        { rotation: deg(targetDeg), duration: 340, ease: backOut(OVERSHOOT.pop) },
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

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { todayKey } from '../core/daily'
import { PLINKO_ROWS, PLINKO_SLOTS, dropPath, rollSlotIndex } from '../core/plinko'
import { mulberry32 } from '../core/rng'
import { addFreeSpins } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { quality } from './quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
import { addPillButton, FONT, GOLD_PILL, goldFace } from './ui'

// ─────────────────────────────────────────────────────────────────────────────
// Plinko bonus drop — the "a SUPER MEGA chain buys you a ball drop" moment.
//
// One export: openPlinko() — an in-scene overlay container (NOT a Scene), so it bursts over the live
// board mid-level with no scene-swap and hands the board straight back on CLAIM. Built entirely from
// the shared toolkit (goldFace, theme tokens, motion eases, sfx cues, the baked chip/bulb/shockwave
// textures) so it reads as native Golden-Hour art and restyles across all four themes for free. No
// new baked textures. Reduced-motion / reduce-flashing / quality-governor / haptics aware throughout.
//
// AWARD-FIRST (core/plinko.ts): the slot is rolled and a ticket prize BANKED before a pixel moves,
// then core's `dropPath` synthesises a bounce sequence guaranteed to arrive there. The physics is
// theatre over a settled result — quitting mid-drop can never lose the prize.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlinkoResult {
  kind: 'mult' | 'ticket'
  /** Slot index the ball landed in (0..PLINKO_ROWS). */
  slot: number
  /** Multiplier won (0 for a ticket prize). */
  mult: number
  /** Points to award — chainPoints × mult (0 for a ticket prize). */
  points: number
  /** Free spins ACTUALLY banked (0 for a multiplier prize) — already persisted. */
  spins: number
}

export interface PlinkoOpenOpts {
  /** Points the triggering chain scored. A 'mult' slot pays chainPoints × mult. */
  chainPoints: number
  /**
   * Whether a free-spin ticket can actually be honoured right now (false in endless, or when the
   * daily/bank caps are full). When false the ticket slots are rolled out of the pool entirely, so
   * the ball can never land on a prize the player won't be paid.
   */
  allowTickets: boolean
  /** Called once, on CLAIM, after the overlay has torn itself down. The host resumes play here. */
  onClaim: (result: PlinkoResult) => void
  /** Optional graded-freeze hook — GameScene passes its `hitstop` so the landing rides one authority. */
  hitstop?: (ms: number) => void
}

// ── Layout ───────────────────────────────────────────────────────────────────
// Every position below is DERIVED from the pitch and the row count (cookbook §2b-iii): the pegs, the
// ball's bounce and the slot centres are all the same maths, so they cannot drift apart.
const SLOTS = PLINKO_SLOTS.length // 9
const PITCH = 64 // horizontal distance between adjacent slot centres = one bounce, doubled
const SPAN = PITCH * (SLOTS - 1) // 512 — first slot centre to last
const PEG_TOP = 372
const ROW_GAP = 42
const SLOT_TOP = PEG_TOP + PLINKO_ROWS * ROW_GAP + 12 // just under the last bounce
const SLOT_H = 76
const BALL_REST_Y = 20 // ball centre, up from the slot's bottom edge
const WIN_LABEL_Y = 22 // winning label centre, down from the slot's top edge
const BALL = 34

/** Slot centre x for slot index s. */
const slotX = (cx: number, s: number): number => cx + (s - (SLOTS - 1) / 2) * PITCH

export function openPlinko(scene: Phaser.Scene, opts: PlinkoOpenOpts): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const flashOff = reduceFlashing()
  const cx = DESIGN_W / 2

  // 1) AWARD-FIRST — decide the slot and bank anything persisted before a single pixel moves.
  const rng = mulberry32((Math.random() * 2 ** 31) | 0)
  let slot = rollSlotIndex(rng, opts.allowTickets)
  if (import.meta.env.DEV) {
    // ?slot=N — pin the landing slot so automated checks can exercise every payoff deterministically.
    const s = Number(new URLSearchParams(location.search).get('slot'))
    if (Number.isInteger(s) && s >= 0 && s < SLOTS) slot = s
  }
  const prize = PLINKO_SLOTS[slot]
  const points = prize.kind === 'mult' ? Math.round(opts.chainPoints * prize.mult) : 0
  // Tickets are persisted state, so they bank NOW; `granted` is what actually stuck under the caps,
  // so the celebration below is sized honestly (a capped player is never lied to). Points are scene
  // state and are paid by the host in onClaim, which is the same instant from the player's side.
  const spins = prize.kind === 'ticket' ? addFreeSpins(prize.spins, todayKey()) : 0
  const result: PlinkoResult = {
    kind: prize.kind,
    slot,
    mult: prize.kind === 'mult' ? prize.mult : 0,
    points,
    spins,
  }
  const path = dropPath(rng, slot)

  // 2) Tracked teardown — one call removes everything. Kills each part's tweens FIRST (Phaser 3.90
  // never sweeps tweens for destroyed targets).
  const parts: Phaser.GameObjects.GameObject[] = []
  const timers: Phaser.Time.TimerEvent[] = []
  const track = <G extends Phaser.GameObjects.GameObject>(o: G): G => (parts.push(o), o)
  const teardown = (): void => {
    for (const t of timers) t.remove(false)
    for (const p of parts) {
      if (p.active) {
        scene.tweens.killTweensOf(p)
        p.destroy()
      }
    }
  }

  // 3) Scrim — dims the board and swallows taps meant for it.
  const scrim = track(
    scene.add
      .rectangle(cx, viewportCenterY(), DESIGN_W, worldH() + 400, T.scrim, reduced ? 0.86 : 0.001)
      .setDepth(60)
      .setInteractive()
  )
  if (!reduced) scene.tweens.add({ targets: scrim, fillAlpha: 0.86, duration: 200, ease: 'Quad.easeOut' })

  // 4) Title + the stake — naming the chain's points makes the multiplier mean something.
  track(
    scene.add
      .text(cx, 250, 'BONUS DROP', { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(6)
      .setStroke(css(T.goldDarkest), 8)
      .setShadow(0, 4, 'rgba(70,45,10,0.5)', 8, false, true)
  )
  track(
    scene.add
      .text(cx, 300, `${opts.chainPoints.toLocaleString()} PTS ON THE LINE`, {
        fontFamily: FONT,
        fontSize: '22px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(2)
  )

  // 5) The cabinet: a framed peg field over the slot row.
  const frameW = SPAN + PITCH + 28
  const frameTop = PEG_TOP - 54
  const frameH = SLOT_TOP + SLOT_H + 18 - frameTop
  const g = track(scene.add.graphics().setDepth(61))
  g.fillStyle(T.shadow, 0.3)
  g.fillRoundedRect(cx - frameW / 2 + 4, frameTop + 8, frameW, frameH, 28)
  g.fillStyle(T.cardFillAlt, 0.96)
  g.fillRoundedRect(cx - frameW / 2, frameTop, frameW, frameH, 28)
  g.lineStyle(3, T.goldBezel, 0.95)
  g.strokeRoundedRect(cx - frameW / 2, frameTop, frameW, frameH, 28)

  // Slot wells + faces. The winning slot is repainted in gold on landing, so build them plain here.
  const slotLabels: Phaser.GameObjects.Text[] = []
  for (let s = 0; s < SLOTS; s++) {
    const x = slotX(cx, s)
    const isTicket = PLINKO_SLOTS[s].kind === 'ticket'
    g.fillStyle(T.shadow, 0.22)
    g.fillRoundedRect(x - PITCH / 2 + 3, SLOT_TOP, PITCH - 6, SLOT_H, 12)
    g.lineStyle(2, isTicket ? T.roseLight : T.goldDeep, 0.9)
    g.strokeRoundedRect(x - PITCH / 2 + 3, SLOT_TOP, PITCH - 6, SLOT_H, 12)
    slotLabels.push(
      track(
        scene.add
          .text(x, SLOT_TOP + SLOT_H / 2, PLINKO_SLOTS[s].label, {
            fontFamily: FONT,
            fontSize: isTicket ? '17px' : '24px',
            fontStyle: '900',
            color: isTicket ? css(T.roseLight) : T.goldText,
          })
          .setOrigin(0.5)
          .setDepth(62)
      )
    )
  }

  // Pegs — row r holds r+1 of them, at exactly the x's the ball can occupy. Same maths as the drop.
  const pegs: Phaser.GameObjects.Image[] = []
  for (let r = 0; r < PLINKO_ROWS; r++) {
    for (let k = 0; k <= r; k++) {
      const peg = track(
        scene.add
          .image(cx + (2 * k - r) * (PITCH / 2), PEG_TOP + r * ROW_GAP, 'bulb')
          .setDisplaySize(13, 13)
          .setTint(T.gold)
          .setAlpha(0.75)
          .setDepth(61)
      )
      pegs.push(peg)
    }
  }

  // 6) The ball, resting in the chute INSIDE the frame — outside it, it collided with the stake line.
  const ball = track(scene.add.image(cx, PEG_TOP - 32, 'chip').setDisplaySize(BALL, BALL).setDepth(63))

  const prizeText = track(
    scene.add
      .text(cx, SLOT_TOP + SLOT_H + 66, '', { fontFamily: FONT, fontSize: '40px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(63)
      .setLetterSpacing(3)
      .setStroke(css(T.goldDarkest), 6)
      .setAlpha(0)
  )

  const dev = import.meta.env.DEV ? { slot, kind: prize.kind, mult: result.mult, points, spins, landed: false, ballSlot: -1 } : null
  if (dev) (window as unknown as { __plinko?: unknown }).__plinko = dev

  let settled = false
  let dropping = false

  // ── Payoff ─────────────────────────────────────────────────────────────────
  const celebrate = (): void => {
    if (settled) return
    settled = true
    scene.tweens.killTweensOf(ball)
    // Snap the rig to its rest state — a skip must never leave the ball mid-flight (cookbook rule).
    ball.setPosition(slotX(cx, slot), SLOT_TOP + SLOT_H - BALL_REST_Y)
    if (dev) {
      dev.landed = true
      dev.ballSlot = Math.round((ball.x - cx) / PITCH + (SLOTS - 1) / 2)
    }

    // The winning slot lights up in real gold.
    const win = track(scene.add.graphics().setDepth(62))
    goldFace(win, slotX(cx, slot) - PITCH / 2 + 3, SLOT_TOP, PITCH - 6, SLOT_H, T, 12)
    // Lift the winning label clear of the ball — parked in the middle it read as a blank gold well.
    slotLabels[slot].setColor(T.goldPillText).setY(SLOT_TOP + WIN_LABEL_Y).setDepth(63)
    ball.setDepth(64)

    opts.hitstop?.(flashOff ? 40 : 70)
    sfx.reelClunk((slotX(cx, slot) - cx) / (SPAN / 2))
    if (prize.kind === 'ticket') sfx.starDing(1)
    else if (prize.mult >= 10) sfx.jackpotStrike()
    else sfx.winFanfare()
    if (!hapticsOff()) navigator.vibrate?.(prize.kind === 'mult' && prize.mult >= 10 ? [60, 40, 140] : 40)

    if (!reduced) {
      // Landing ring + sparks, governor-scaled. Under reduce-flashing the ring swells instead of popping.
      const ring = track(
        scene.add
          .image(ball.x, ball.y, 'shockwave')
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(63)
          .setDisplaySize(60, 60)
          .setAlpha(flashOff ? 0.35 : 0.8)
      )
      scene.tweens.add({
        targets: ring,
        displayWidth: 260,
        displayHeight: 260,
        alpha: 0,
        duration: flashOff ? 620 : 380,
        ease: 'Cubic.easeOut',
      })
      if (quality.count(1) > 0) {
        const glow = track(
          scene.add
            .image(ball.x, ball.y, 'bgglow')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setTint(prize.kind === 'ticket' ? T.roseLight : T.goldBright)
            .setDepth(62)
            .setDisplaySize(180, 180)
            .setAlpha(0)
        )
        scene.tweens.add({ targets: glow, alpha: flashOff ? 0.3 : 0.55, duration: 220, yoyo: true, repeat: 1 })
      }
    }

    // Prize readout — the honest number, sized by what was actually won.
    prizeText.setText(
      prize.kind === 'ticket'
        ? spins > 0
          ? `+${spins} FREE SPIN${spins > 1 ? 'S' : ''}`
          : 'FREE SPINS FULL'
        : `+${points.toLocaleString()} PTS`
    )
    if (prize.kind === 'ticket') prizeText.setColor(css(T.roseLight))
    if (reduced) {
      prizeText.setAlpha(1)
    } else {
      prizeText.setScale(0.6)
      scene.tweens.add({ targets: prizeText, alpha: 1, scale: 1, duration: 320, ease: backOut(OVERSHOOT.pop) })
    }

    // CLAIM — the only exit.
    const claim = track(
      addPillButton(
        scene,
        cx,
        SLOT_TOP + SLOT_H + 150,
        300,
        84,
        'CLAIM',
        GOLD_PILL,
        () => {
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
        },
        { juice: true }
      ).setDepth(64)
    )
    if (reduced) {
      claim.setScale(1)
    } else {
      claim.setScale(0)
      scene.tweens.add({ targets: claim, scale: 1, duration: 300, delay: 200, ease: 'Back.easeOut' })
    }
  }

  // ── The drop ───────────────────────────────────────────────────────────────
  const drop = (): void => {
    if (dropping || settled) return
    dropping = true
    dropBtn.destroy()
    if (reduced) {
      celebrate()
      return
    }
    sfx.whoosh(0)

    /** Ping the peg the ball is currently resting on: a bright flare that decays back to rest. */
    const strikePeg = (row: number): void => {
      const peg = pegs.find(p => Math.abs(p.y - (PEG_TOP + row * ROW_GAP)) < 1 && Math.abs(p.x - ball.x) < 2)
      if (!peg) return
      scene.tweens.killTweensOf(peg)
      const base = 13
      peg.setAlpha(1).setDisplaySize(base * 1.5, base * 1.5)
      scene.tweens.add({ targets: peg, displayWidth: base, displayHeight: base, alpha: 0.75, duration: 240, ease: 'Quad.easeOut' })
    }

    const pan = (): number => (ball.x - cx) / (SPAN / 2)

    // The chute drop onto the first peg, then one hop per row replaying core's rigged path — each a
    // half-pitch across and one row down, pinging the peg it strikes. The tink climbs as it descends
    // and is panned to where you see it, so the sound tracks the ball.
    const chain: Phaser.Types.Tweens.TweenBuilderConfig[] = [
      {
        targets: ball,
        x: cx,
        y: PEG_TOP,
        duration: 200,
        ease: 'Quad.easeIn',
      } as Phaser.Types.Tweens.TweenBuilderConfig,
    ]
    path.forEach((d, i) => {
      chain.push({
        targets: ball,
        x: `+=${d * (PITCH / 2)}`,
        y: PEG_TOP + (i + 1) * ROW_GAP,
        duration: 130,
        ease: 'Quad.easeIn',
        onStart: () => {
          sfx.clearTink(Math.min(i + 1, 6), pan())
          strikePeg(i)
        },
      } as Phaser.Types.Tweens.TweenBuilderConfig)
    })
    // ...then a final settle from the last peg into the slot well.
    chain.push({
      targets: ball,
      y: SLOT_TOP + SLOT_H - BALL_REST_Y,
      duration: 160,
      ease: 'Quad.easeIn',
      onStart: () => sfx.land(1, pan()),
    } as Phaser.Types.Tweens.TweenBuilderConfig)

    scene.tweens.chain({ targets: ball, tweens: chain, onComplete: celebrate })
  }

  // 7) DROP — the player's one input. Tapping anywhere during the fall skips to the payoff.
  const dropBtn = track(
    addPillButton(scene, cx, SLOT_TOP + SLOT_H + 150, 300, 84, 'DROP', GOLD_PILL, () => drop(), { juice: true }).setDepth(64)
  )
  if (reduced) {
    dropBtn.setScale(1)
  } else {
    dropBtn.setScale(0)
    scene.tweens.add({ targets: dropBtn, scale: 1, duration: 320, delay: 260, ease: backOut(OVERSHOOT.pop) })
  }

  scene.input.once('pointerdown', () => {
    if (settled || !dropping) return // not started yet — the DROP button owns the first tap
    scene.tweens.killTweensOf(ball)
    celebrate()
  })
}

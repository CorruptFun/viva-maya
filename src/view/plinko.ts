import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { todayKey } from '../core/daily'
import type { PlinkoPrize } from '../core/plinko'
import { PLINKO_ROWS, PLINKO_SLOTS, dropPath, plinkoSlots, rollSlotIndex } from '../core/plinko'
import { mulberry32 } from '../core/rng'
import { addFreeSpins } from '../core/save'
import { backOut, E, OVERSHOOT } from './motion'
import { quality } from './quality'
import type { Theme } from './theme'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
import { addPillButton, FONT, GOLD_PILL, goldFace } from './ui'
import { vibratePattern } from './haptics'

// ─────────────────────────────────────────────────────────────────────────────
// Plinko bonus drop — the "a SUPER MEGA chain buys you a ball drop" moment.
//
// One export for the host: openPlinko() — an in-scene overlay container (NOT a Scene), so it bursts
// over the live board mid-level with no scene-swap and hands the board straight back on CLAIM. Built
// from the shared toolkit (goldFace, theme tokens, motion eases, sfx cues, the baked chip/bulb/
// shockwave/bgglow textures) so it reads as native Golden-Hour art and restyles across all four
// themes for free. Reduced-motion / reduce-flashing / quality-governor / haptics aware throughout.
//
// AWARD-FIRST (core/plinko.ts): the slot is rolled and a ticket prize BANKED before a pixel moves,
// then core's `dropPath` synthesises a bounce sequence guaranteed to arrive there. The physics is
// theatre over a settled result — quitting mid-drop can never lose the prize.
//
// ── The fall (2026-07 rebuild) ───────────────────────────────────────────────
// v1 replayed the rigged path as a tween CHAIN: one `Quad.easeIn` per row. Every ease-in starts from
// zero velocity, so the ball came to a dead stop on each peg and re-accelerated — eight little stalls
// that read as "slow and janky" no matter how short the segments were. The fix is to stop animating
// positions and start integrating MOTION:
//
//   • Each row is a real BALLISTIC HOP, solved closed-form at build time — the ball leaves a peg with
//     an upward kick, arcs, and arrives at the next peg already moving. Vertical velocity is now
//     continuous across every contact, so there is nothing left to stutter.
//   • Restitution RAMPS DOWN row by row (0.42 → 0.15), so each hop is shorter than the last and the
//     drop visibly gathers pace instead of pattering at one tempo. ~1.9s end to end, but it reads
//     faster than v1's 1.4s because it accelerates.
//   • Horizontal travel is constant-velocity within a hop (what a real ballistic arc does) and lands
//     on the exact half-pitch, so the AWARD-FIRST rig stays honest to the pixel — see `buildFall`.
//   • The drop is driven by ONE scene UPDATE handler evaluating a parabola (no per-frame redraw, no
//     allocation): squash-and-stretch on impact, spin carrying the deflection direction, a pooled
//     ghost trail and a velocity smear. It ends on the well floor with two damped rattles, and the
//     payoff fires on the FLOOR hit — the slot lights while the chip is still wobbling.
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
   * spin BANK is full). When false the ticket slots are rolled out of the pool entirely, so the ball
   * can never land on a prize the player won't be paid. The daily earn cap deliberately does NOT
   * gate this — see save.FreeSpinSource for why plinko answers to the bank cap alone.
   */
  allowTickets: boolean
  /**
   * Whether this drop belongs to an ENDLESS run. Picks the weight table (`PLINKO_ENDLESS_SLOTS` —
   * fatter ×10 edges, because endless is the raced mode), NOT the ticket substitution. Deliberately
   * separate from `allowTickets`: endless always implies allowTickets false, but a numbered-level
   * player with a full spin bank ALSO has allowTickets false and must keep the numbered odds.
   */
  endless: boolean
  /** Called once, on CLAIM, after the overlay has torn itself down. The host resumes play here. */
  onClaim: (result: PlinkoResult) => void
  /** Optional graded-freeze hook — GameScene passes its `hitstop` so the landing rides one authority. */
  hitstop?: (ms: number) => void
}

// ── Layout ───────────────────────────────────────────────────────────────────
// Every position below is DERIVED from the pitch and the row count (cookbook §2b-iii): the pegs, the
// ball's bounce, the slot centres and the well floor are all the same maths, so they cannot drift.
//
// The cabinet lives in a CONTAINER anchored at (cx, BOARD_CY), so vertical positions inside it are
// LOCAL (design-Y minus BOARD_CY, via `ly`). That is what lets the whole rig pop/scale about its own
// middle on entrance instead of sliding in from the top of the world.

const SLOTS = PLINKO_SLOTS.length // 9
const PITCH = 64 // horizontal distance between adjacent slot centres = one bounce, doubled
const HALF = PITCH / 2 // one bounce
const SPAN = PITCH * (SLOTS - 1) // 512 — first slot centre to last
const PLAY_W = PITCH * SLOTS // 576 — the playfield spans the slot row exactly
const BEZEL = 17 // cast-frame thickness around the playfield
const FRAME_W = PLAY_W + BEZEL * 2 // 610
const FRAME_R = 30 // outer frame corner radius (inner radii stay concentric: FRAME_R − inset)

/** Design-space Y of the cabinet's centre — the board container's anchor (frame spans ±291 locally). */
const BOARD_CY = 592
const ly = (designY: number): number => designY - BOARD_CY

const ROW_GAP = 42 // vertical distance between peg rows
const PEG_TOP = ly(424) // first peg row (a single peg on the centre line)
const CHUTE_Y = ly(364) // the chip's parked centre in the release gate
const PLAY_TOP = ly(318) // playfield inner top edge
const SLOT_TOP = PEG_TOP + PLINKO_ROWS * ROW_GAP + 10 // just under the last bounce
const SLOT_H = 84
const PLATE_H = 34 // the value plate at the top of each slot (the ball rests below it)
const PLATE_Y = SLOT_TOP + 3
const FLOOR_Y = SLOT_TOP + SLOT_H - 26 // ball centre at rest on the well floor
const WELL_MOUTH_Y = SLOT_TOP - 4 // lateral travel finishes HERE, clear of the divider pins
const PLAY_BOT = SLOT_TOP + SLOT_H + 12
const FRAME_TOP = PLAY_TOP - BEZEL
const FRAME_BOT = PLAY_BOT + BEZEL
const FRAME_H = FRAME_BOT - FRAME_TOP
const BALL = 38

// Design-space furniture outside the cabinet container.
const TITLE_Y = 238
const STAKE_Y = 284
const PRIZE_Y = 928
const BUTTON_Y = 1008

/** Slot centre x (container-local) for slot index s. */
const slotX = (s: number): number => (s - (SLOTS - 1) / 2) * PITCH
/** Peg row r's y (container-local). Row r holds r+1 pegs at x = (2k − r)·HALF. */
const pegY = (r: number): number => PEG_TOP + r * ROW_GAP

/**
 * Radius clamped to just UNDER half the smallest side (cookbook §2c) — Phaser's rounded-rect arc
 * tessellation spikes into corner "ears" at exactly half. The "−1" is load-bearing.
 */
const safeR = (r: number, w: number, h: number): number => Math.max(1, Math.min(r, w / 2 - 1, h / 2 - 1))

// ── Ballistics ───────────────────────────────────────────────────────────────

/** Gravity, px/s². Tuned so the whole drop lands at ~1.6s with a punchy finish. */
const G = 4800
/**
 * Restitution off the FIRST peg row — a visible pop that shows the ball has weight. Deliberately
 * LOW: measured per-frame, a 0.42 bounce lifted the chip 10px over a 42px row gap and left four
 * near-stationary frames hanging at every apex — physically true, but eight little hangs is exactly
 * the "slow" feel this rebuild exists to kill. At 0.26 the pop is ~4px and reads as a bounce while
 * gravity stays in charge.
 */
const REST_TOP = 0.26
/** Restitution off the LAST peg row — almost none, so the ball is racing by the bottom. */
const REST_BOTTOM = 0.1
/** Restitution on the slot's well floor — two quick rattles then rest. */
const REST_FLOOR = 0.3

type Contact =
  /** the segment ends on a peg */
  | 'peg'
  /** the segment ends nowhere — a bookkeeping split, motion continues unbroken */
  | 'none'
  /** the segment ends on the well floor (the landing) */
  | 'floor'
  /** the segment is one damped rattle in the well */
  | 'settle'

interface Seg {
  /** container-local x at the start; x travels `dx` at CONSTANT speed across the segment */
  x0: number
  dx: number
  y0: number
  y1: number
  /** vertical velocity leaving the previous contact (negative = an upward bounce) */
  vy0: number
  /** segment duration, seconds */
  T: number
  contact: Contact
  /** peg row struck at the END of this segment (−1 when the end is not a peg) */
  row: number
  /** deflection sign that produced this segment (0 for pure falls) */
  dir: -1 | 0 | 1
  /** vertical speed on arrival — sizes the impact FX */
  vEnd: number
}

/**
 * Time to fall `dy` starting at `vy0` (negative = upward), under G. The positive root of
 * dy = vy0·t + ½G·t², so a segment that first arcs UP still resolves to the moment it arrives.
 * `dy = 0` (a rattle that returns to the same height) correctly yields −2·vy0/G.
 */
const solveT = (vy0: number, dy: number): number => (-vy0 + Math.sqrt(vy0 * vy0 + 2 * G * dy)) / G

/**
 * THE RIG, MADE PHYSICAL. Turns core's ±1 bounce sequence into a list of closed-form ballistic
 * segments: the chute release, one hop per rigged decision, the run into the well and two damped
 * rattles. Because horizontal travel is constant-velocity per hop and every hop moves exactly
 * `±HALF`, the accumulated x lands on `slotX(targetSlot)` to the pixel — the award-first promise
 * survives all the theatre. Solved once, up front: the update loop only evaluates parabolas.
 */
function buildFall(path: readonly (-1 | 1)[]): Seg[] {
  const segs: Seg[] = []
  let x = 0
  let y = CHUTE_Y
  let vy0 = 0 // released from rest in the chute

  const add = (dx: number, y1: number, contact: Contact, row: number, dir: -1 | 0 | 1): void => {
    const T = solveT(vy0, y1 - y)
    const vEnd = vy0 + G * T
    // A degenerate segment (a rattle whose energy has run out) would divide by zero below — skip it;
    // it moves nothing, so the running x/y/velocity bookkeeping is unaffected.
    if (T > 0.004) segs.push({ x0: x, dx, y0: y, y1, vy0, T, contact, row, dir, vEnd })
    x += dx
    y = y1
    vy0 = vEnd // the next segment inherits this speed unless a bounce overrides it
  }

  // 1) The chute release, straight down onto the single peg of row 0.
  add(0, pegY(0), 'peg', 0, 0)

  // 2) One ballistic hop per rigged decision. The bounce off the peg just struck kicks the ball back
  // up, and the restitution that sets that kick ramps DOWN with depth — so the hops shorten as the
  // ball descends and the fall reads as gathering pace rather than a metronome.
  const rows = path.length
  for (let i = 0; i < rows; i++) {
    const t = rows > 1 ? i / (rows - 1) : 0
    vy0 = -(REST_TOP + (REST_BOTTOM - REST_TOP) * t) * vy0
    const last = i === rows - 1
    // The last deflection finishes its lateral travel at the well MOUTH, so the ball is already
    // centred between two divider pins before it reaches them (it leaves the final peg sitting
    // directly above one). Nothing is struck there — the fall continues unbroken into the well.
    add(path[i] * HALF, last ? WELL_MOUTH_Y : pegY(i + 1), last ? 'none' : 'peg', last ? -1 : i + 1, path[i])
  }

  // 3) Down the well onto the floor — the landing beat, and the fastest the ball ever moves.
  add(0, FLOOR_Y, 'floor', -1, 0)

  // 4) Two damped rattles in the well, then it rests. These play UNDER the payoff (the slot lights on
  // the floor hit), which is what makes the landing feel like an object arriving rather than a cut.
  for (let b = 0; b < 2; b++) {
    vy0 = -REST_FLOOR * vy0
    add(0, FLOOR_Y, 'settle', -1, 0)
  }

  return segs
}

// ── Baked art ────────────────────────────────────────────────────────────────

/**
 * The peg: a raised cast-metal dome, baked once per theme. Same offset-disc recipe as the jackpot
 * wheel's rivets (seat shadow → deep base → angle-lit cap offset UP toward the one key light →
 * specular pip), so the two cabinets read as the same machine shop. Baked at 2× its 15px display
 * size so it stays crisp on hi-DPI (cookbook §5.4), and keyed by theme id because the tones are
 * baked in — a theme switch restarts the scene and must not reuse the old palette's dome.
 */
function ensurePegTexture(scene: Phaser.Scene, T: Theme): string {
  const key = `plinkopeg:${T.id}`
  if (scene.textures.exists(key)) return key
  const S = 32
  const c = S / 2
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0x000000, 0.3)
  g.fillCircle(c, c + 2.2, 11) // seat shadow — the light is above, so it casts straight down
  g.fillStyle(T.goldDarkest, 1)
  g.fillCircle(c, c, 11)
  g.fillStyle(T.goldDeep, 1)
  g.fillCircle(c, c, 9.6)
  g.fillStyle(T.gold, 1)
  g.fillCircle(c, c - 1.4, 7.6)
  g.fillStyle(T.goldBezel, 1)
  g.fillCircle(c, c - 2.2, 5.4)
  g.fillStyle(T.goldBright, 1)
  g.fillCircle(c, c - 2.8, 3.4)
  g.fillStyle(0xffffff, 0.85)
  g.fillCircle(c - 1.6, c - 4.2, 1.6) // specular
  g.generateTexture(key, S, S)
  g.destroy()
  return key
}

/** The five plate materials, ordered outward — a value ladder you can read at a glance. */
type SlotTone = 'cream' | 'goldDim' | 'gold' | 'special' | 'top'

/**
 * Plate material for a prize. The ramp runs cream (×2, the commonest) → dim gold (×3) → real gold
 * (×5) → NAVY for the free-spin tickets → rose-under-gold for the ×10 edges. Navy for "a different
 * currency" and rose for "the richest" are lifted straight from the jackpot wheel's wedge language,
 * so a player already knows what they mean.
 */
const toneOf = (p: PlinkoPrize): SlotTone =>
  p.kind === 'ticket' ? 'special' : p.mult >= 10 ? 'top' : p.mult >= 5 ? 'gold' : p.mult >= 3 ? 'goldDim' : 'cream'

/** Text ink for each plate material — mirrors the wheel's wedge inks so contrast is already proven. */
const inkOf = (tone: SlotTone, T: Theme): string =>
  tone === 'top' ? css(T.cardFillWarm) : tone === 'special' ? css(T.goldBright) : tone === 'cream' ? T.goldText : T.goldPillText

/** One value plate. Every stacked shape stays concentric (radius shrinks with the inset — §2b). */
function paintPlate(g: Phaser.GameObjects.Graphics, x: number, y: number, w: number, h: number, tone: SlotTone, T: Theme): void {
  const r = safeR(9, w, h)
  g.fillStyle(T.shadow, 0.34)
  g.fillRoundedRect(x, y + 3, w, h, r) // seat shadow, straight down under the one key light
  if (tone === 'top') {
    g.fillStyle(T.roseDeep, 1)
    g.fillRoundedRect(x, y, w, h, r)
    g.fillStyle(T.rose, 1)
    g.fillRoundedRect(x + 2, y + 2, w - 4, h - 4, safeR(r - 2, w - 4, h - 4))
    g.fillStyle(T.roseLight, 0.45)
    g.fillRoundedRect(x + 3, y + 3, w - 6, h * 0.36, safeR(r - 3, w - 6, h * 0.36))
    g.lineStyle(2.5, T.goldBright, 0.95) // the gold bezel is the tell: this is the richest slot
    g.strokeRoundedRect(x, y, w, h, r)
  } else if (tone === 'special') {
    g.fillStyle(T.navy, 1)
    g.fillRoundedRect(x, y, w, h, r)
    g.fillStyle(T.rim, 0.12)
    g.fillRoundedRect(x + 3, y + 3, w - 6, h * 0.38, safeR(r - 3, w - 6, h * 0.38))
    g.lineStyle(2, T.roseLight, 0.9)
    g.strokeRoundedRect(x, y, w, h, r)
  } else if (tone === 'cream') {
    g.fillStyle(T.cardFillWarm, 1)
    g.fillRoundedRect(x, y, w, h, r)
    g.fillStyle(T.glossHi, 0.5)
    g.fillRoundedRect(x + 3, y + 3, w - 6, h * 0.34, safeR(r - 3, w - 6, h * 0.34))
    g.lineStyle(2, T.goldDeep, 0.9)
    g.strokeRoundedRect(x, y, w, h, r)
  } else {
    goldFace(g, x, y, w, h, T, r)
    if (tone === 'goldDim') {
      g.fillStyle(T.goldDarkest, 0.2) // one wash back off full metal, so ×5 still out-shines ×3
      g.fillRoundedRect(x, y, w, h, r)
    }
    g.lineStyle(1.5, T.goldDeep, 0.85)
    g.strokeRoundedRect(x, y, w, h, r)
  }
}

/**
 * The whole static cabinet, drawn into `g` in the board container's LOCAL space: contact shadow →
 * cast gold frame plate (the canonical `goldFace` metal) → milled knurl along the straight edges →
 * bezel rivets → recessed playfield well with a warm light-pool from above → the release gate at the
 * top → the slot row (wells, divider pins, value plates).
 *
 * Exported so the dev atlas can render the real cabinet at scale — no second copy to drift.
 *
 * `slots` is the EFFECTIVE table (see core `plinkoSlots`) — it decides each value plate's TONE, so a
 * drop where tickets can't be paid gets gold ×5 plates where the navy SPIN ones would have been.
 * Defaults to the base table so the atlas and any future caller keep the canonical face.
 */
export function drawPlinkoCabinet(
  g: Phaser.GameObjects.Graphics,
  T: Theme = getTheme(),
  slots: PlinkoPrize[] = PLINKO_SLOTS
): void {
  const fx = -FRAME_W / 2
  const fy = FRAME_TOP

  // --- Contact shadow: a few falling copies at low alpha, all agreeing on the one key light (§4).
  for (const [dy, a] of [
    [16, 0.1],
    [10, 0.13],
    [5, 0.16],
  ]) {
    g.fillStyle(T.shadow, a)
    g.fillRoundedRect(fx, fy + dy, FRAME_W, FRAME_H, FRAME_R)
  }

  // --- The cast frame plate: real metal, bright crown falling to a deep belly.
  goldFace(g, fx, fy, FRAME_W, FRAME_H, T, FRAME_R)

  // --- Machined lip: a bright inner line just under the top edge and a dark one just above the
  // bottom, so the plate reads as a turned edge rather than a printed rectangle. Both are inset by
  // the same amount with the radius stepped to match, keeping every corner concentric (§2b).
  g.lineStyle(2, T.goldBright, 0.55)
  g.strokeRoundedRect(fx + 4, fy + 4, FRAME_W - 8, FRAME_H - 8, safeR(FRAME_R - 4, FRAME_W - 8, FRAME_H - 8))
  g.lineStyle(2, T.goldDarkest, 0.4)
  g.strokeRoundedRect(fx + 7, fy + 7, FRAME_W - 14, FRAME_H - 14, safeR(FRAME_R - 7, FRAME_W - 14, FRAME_H - 14))

  // --- Bezel rivets: the cabinet-hardware signature, marching down both side walls.
  const rivet = (x: number, y: number): void => {
    g.fillStyle(0x000000, 0.24)
    g.fillCircle(x, y + 1.4, 5.2)
    g.fillStyle(T.goldDeep, 1)
    g.fillCircle(x, y, 4.6)
    g.fillStyle(T.gold, 1)
    g.fillCircle(x, y - 1.2, 3.2)
    g.fillStyle(T.goldBright, 1)
    g.fillCircle(x, y - 1.8, 1.8)
    g.fillStyle(0xffffff, 0.6)
    g.fillCircle(x - 0.8, y - 2.4, 1)
  }
  const rivets = 7
  for (let i = 0; i < rivets; i++) {
    const y = fy + FRAME_R + ((FRAME_H - FRAME_R * 2) * i) / (rivets - 1)
    rivet(fx + BEZEL / 2, y)
    rivet(fx + FRAME_W - BEZEL / 2, y)
  }

  // --- The recessed playfield. Inner radius = FRAME_R − BEZEL keeps it concentric with the frame.
  const px = -PLAY_W / 2
  const pw = PLAY_W
  const ph = PLAY_BOT - PLAY_TOP
  const pr = safeR(FRAME_R - BEZEL, pw, ph)
  g.fillStyle(T.scrim, 1) // the theme's own deep ground, so lit gold reads as light on it
  g.fillRoundedRect(px, PLAY_TOP, pw, ph, pr)
  // A warm light-pool falling from above — stacked falling-height rounded rects, because
  // fillGradientStyle mis-triangulates on rounded shapes (§3). Many thin bands at a very low alpha:
  // at 6 bands × 0.035 each band's lower edge read as a visible SHELF across the playfield.
  const bands = 16
  for (let i = 0; i < bands; i++) {
    const bh = ph * (0.62 - 0.56 * (i / (bands - 1)))
    g.fillStyle(T.goldBright, 0.014)
    g.fillRoundedRect(px, PLAY_TOP, pw, bh, safeR(pr, pw, bh))
  }
  // Side deflector rails hugging the playfield walls — a real cabinet feature (a ball can rebound off
  // them), and they give the peg triangle's empty upper corners an edge to be empty AGAINST.
  for (const s of [-1, 1]) {
    const rx = s * (pw / 2 - 7)
    g.lineStyle(5, T.goldDarkest, 0.75)
    g.lineBetween(rx, PLAY_TOP + 16, rx, SLOT_TOP - 6)
    g.lineStyle(2, s < 0 ? T.goldBezel : T.goldDeep, 0.7) // lit on the light side, shaded on the other
    g.lineBetween(rx - s * 1.2, PLAY_TOP + 16, rx - s * 1.2, SLOT_TOP - 6)
  }
  // Recess: dark stroke on the outer edge, a lit inner line just inside — a well, not a panel.
  g.lineStyle(3, T.goldDarkest, 0.6)
  g.strokeRoundedRect(px, PLAY_TOP, pw, ph, pr)
  g.lineStyle(1.5, T.goldBright, 0.22)
  g.strokeRoundedRect(px + 2.5, PLAY_TOP + 2.5, pw - 5, ph - 5, safeR(pr - 2.5, pw - 5, ph - 5))

  // --- Release gate at the top centre: a dark chute mouth with a cast gold surround, over a recessed
  // drop shaft leading to the first peg. This is what makes the chip look LOADED rather than parked.
  const gw = 132
  const gh = 46
  const gy = CHUTE_Y - gh / 2 - 4
  g.fillStyle(T.goldDeep, 1)
  g.fillRoundedRect(-gw / 2 - 6, gy - 10, gw + 12, gh + 16, 18)
  // Lit crown band on the gate's top lip — INSET past the corner arcs so it can never poke out as a
  // light "ear" (§2a), and thin enough that its radius stays well under half its height (§2c).
  g.fillStyle(T.goldBright, 0.5)
  g.fillRoundedRect(-gw / 2 + 2, gy - 7, gw - 4, 5, 2.5)
  g.fillStyle(T.vignetteInk, 0.96)
  g.fillRoundedRect(-gw / 2, gy, gw, gh, 12)
  g.lineStyle(2, T.goldDarkest, 0.7)
  g.strokeRoundedRect(-gw / 2, gy, gw, gh, 12)
  // Drop shaft: a darker recessed channel from the gate down to just above the first peg, with a lit
  // left wall and a shaded right one. Reads as the chute the chip falls through, and costs no vertical
  // budget — there is no room between the gate and peg row 0 for real funnel walls at this pitch.
  const shaftTop = gy + gh + 6
  const shaftH = pegY(0) - 14 - shaftTop
  if (shaftH > 6) {
    g.fillStyle(T.goldDarkest, 0.5)
    g.fillRoundedRect(-HALF, shaftTop, PITCH, shaftH, 8)
    g.lineStyle(1.5, T.goldBright, 0.3)
    g.lineBetween(-HALF + 1, shaftTop + 4, -HALF + 1, shaftTop + shaftH - 4)
    g.lineStyle(1.5, T.goldDarkest, 0.6)
    g.lineBetween(HALF - 1, shaftTop + 4, HALF - 1, shaftTop + shaftH - 4)
  }

  // --- The slot row: a recessed well per slot, gold divider pins between them, a value plate on top.
  for (let s = 0; s < SLOTS; s++) {
    const x = slotX(s)
    const wx = x - HALF + 4
    const ww = PITCH - 8
    g.fillStyle(T.vignetteInk, 0.9)
    g.fillRoundedRect(wx, SLOT_TOP, ww, SLOT_H, 12)
    g.lineStyle(2, T.goldDarkest, 0.55)
    g.strokeRoundedRect(wx, SLOT_TOP, ww, SLOT_H, 12)
    g.lineStyle(1.2, T.goldBright, 0.16)
    g.strokeRoundedRect(wx + 2, SLOT_TOP + 2, ww - 4, SLOT_H - 4, 10)
    paintPlate(g, x - (PITCH - 10) / 2, PLATE_Y, PITCH - 10, PLATE_H, toneOf(slots[s]), T)
  }
  // Divider pins — a cast wall between neighbouring slots, capped with a dome. The last peg row sits
  // directly above these, so the ball always leaves a peg on a divider and lands on a slot centre.
  for (let s = 0; s < SLOTS - 1; s++) {
    const x = slotX(s) + HALF
    g.fillStyle(T.goldDarkest, 1)
    g.fillRoundedRect(x - 3.5, SLOT_TOP - 2, 7, SLOT_H + 2, 3.5)
    g.fillStyle(T.goldDeep, 1)
    g.fillRoundedRect(x - 2.5, SLOT_TOP - 2, 5, SLOT_H + 2, 2.5)
    g.fillStyle(T.gold, 0.85)
    g.fillRoundedRect(x - 1.2, SLOT_TOP, 2.4, SLOT_H - 6, 1.2)
    rivet(x, SLOT_TOP - 3) // the pin's domed cap, same hardware as the bezel
  }
}

export function openPlinko(scene: Phaser.Scene, opts: PlinkoOpenOpts): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const flashOff = reduceFlashing()
  const lowTier = quality.tier() === 'low'
  const hasGlow = scene.textures.exists('bgglow')
  const cx = DESIGN_W / 2

  // 1) AWARD-FIRST — decide the slot and bank anything persisted before a single pixel moves.
  const rng = mulberry32((Math.random() * 2 ** 31) | 0)
  // The EFFECTIVE table for this drop — when a spin can't be paid the two ticket wells arrive here
  // already restruck as ×5, so paint, labels and payout all read from ONE source and cannot disagree.
  const slots = plinkoSlots(opts.allowTickets, opts.endless)
  let slot = rollSlotIndex(rng, opts.allowTickets, opts.endless)
  if (import.meta.env.DEV) {
    // ?slot=N — pin the landing slot so automated checks can exercise every payoff deterministically.
    const s = Number(new URLSearchParams(location.search).get('slot'))
    if (Number.isInteger(s) && s >= 0 && s < SLOTS) slot = s
  }
  const prize = slots[slot]
  const points = prize.kind === 'mult' ? Math.round(opts.chainPoints * prize.mult) : 0
  // Tickets are persisted state, so they bank NOW; `granted` is what actually stuck under the caps,
  // so the celebration below is sized honestly (a capped player is never lied to). Points are scene
  // state and are paid by the host in onClaim, which is the same instant from the player's side.
  // 'plinko' — the SAME source GameScene asked freeSpinRoom about when it set allowTickets, so a
  // well the board painted as SPIN is always a well this can actually pay (see save.FreeSpinSource).
  const spins = prize.kind === 'ticket' ? addFreeSpins(prize.spins, todayKey(), 'plinko') : 0
  const result: PlinkoResult = {
    kind: prize.kind,
    slot,
    mult: prize.kind === 'mult' ? prize.mult : 0,
    points,
    spins,
  }
  const isTop = prize.kind === 'mult' && prize.mult >= 10
  const segs = buildFall(dropPath(rng, slot))

  // 2) Tracked teardown — one call removes everything. Kills each part's tweens FIRST (Phaser 3.90
  // never sweeps tweens for destroyed targets), unhooks the drop loop and rests the camera.
  const parts: Phaser.GameObjects.GameObject[] = []
  const timers: Phaser.Time.TimerEvent[] = []
  const track = <O extends Phaser.GameObjects.GameObject>(o: O): O => (parts.push(o), o)
  const at = (ms: number, cb: () => void): void => {
    timers.push(scene.time.delayedCall(ms, cb))
  }
  const cam = scene.cameras.main
  /**
   * Kill every tween targeting a container and its descendants. Destroying a container destroys its
   * children, but Phaser 3.90 never sweeps tweens for destroyed targets — and the bulb chase is
   * `repeat: -1`, so without this each drop would leak a dozen immortal tweens writing to dead images.
   */
  const killDeep = (c: Phaser.GameObjects.Container): void => {
    for (const child of c.list) {
      if (child instanceof Phaser.GameObjects.Container) killDeep(child)
      else scene.tweens.killTweensOf(child)
    }
    scene.tweens.killTweensOf(c)
  }
  const teardown = (): void => {
    stopFall()
    scene.input.off('pointerdown', onSkip)
    for (const t of timers) t.remove(false)
    killDeep(board)
    for (const p of parts) {
      if (p.active) {
        scene.tweens.killTweensOf(p)
        p.destroy()
      }
    }
    scene.tweens.killTweensOf(cam)
    cam.setZoom(1) // the landing camera breath must never outlive the overlay
  }

  // 3) Scrim — dims the board and swallows taps meant for it.
  const scrim = track(
    scene.add
      .rectangle(cx, viewportCenterY(), DESIGN_W, worldH() + 400, T.scrim, reduced ? 0.86 : 0.001)
      .setDepth(60)
      .setInteractive()
  )
  if (!reduced) scene.tweens.add({ targets: scrim, fillAlpha: 0.86, duration: 200, ease: E.press })

  // 4) Title + the stake — naming the chain's points makes the multiplier mean something.
  const title = track(
    scene.add
      .text(cx, TITLE_Y, 'BONUS DROP', { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(6)
      .setStroke(css(T.goldDarkest), 8)
      .setShadow(0, 4, 'rgba(70,45,10,0.5)', 8, false, true)
  )
  const stake = track(
    scene.add
      .text(cx, STAKE_Y, `${opts.chainPoints.toLocaleString()} PTS ON THE LINE`, {
        fontFamily: FONT,
        fontSize: '22px',
        fontStyle: '900',
        color: css(T.goldBright),
      })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(2)
      .setShadow(0, 2, 'rgba(70,45,10,0.55)', 4, false, true)
  )

  // 5) THE CABINET. One container anchored on the rig's own centre, so the entrance can pop the whole
  // machine about its middle. Layer order inside it IS the depth order (containers ignore setDepth):
  // cabinet art → glow/win light → slot labels → pegs → impact FX → the ball and its trail.
  const board = track(scene.add.container(cx, BOARD_CY).setDepth(61))
  const cab = scene.add.graphics()
  drawPlinkoCabinet(cab, T, slots)
  const glowLayer = scene.add.container(0, 0)
  const labelLayer = scene.add.container(0, 0)
  const pegLayer = scene.add.container(0, 0)
  const fxLayer = scene.add.container(0, 0)
  const ballLayer = scene.add.container(0, 0)
  board.add([cab, glowLayer, labelLayer, pegLayer, fxLayer, ballLayer])

  // Crown + apron bulbs, along the straight edge runs only. Alternating gold/rose on a travelling
  // chase — the marquee idiom (ui.addMarquee), so this cabinet blinks like every other sign in the app.
  const bulbs: Phaser.GameObjects.Image[] = []
  const BULB_RUN = 11
  for (const edgeY of [FRAME_TOP + BEZEL / 2, FRAME_BOT - BEZEL / 2]) {
    for (let i = 0; i < BULB_RUN; i++) {
      const bx = -FRAME_W / 2 + FRAME_R + ((FRAME_W - FRAME_R * 2) * i) / (BULB_RUN - 1)
      const b = scene.add
        .image(bx, edgeY, 'bulb')
        .setDisplaySize(13, 13)
        .setTint(i % 2 === 0 ? T.goldBright : T.roseLight)
        .setAlpha(reduced ? 0.85 : 0.45)
      glowLayer.add(b)
      bulbs.push(b)
    }
  }
  const CHASE = 1500
  if (!reduced) {
    bulbs.forEach((b, i) => {
      scene.tweens.add({
        targets: b,
        alpha: 1,
        duration: CHASE / 2,
        yoyo: true,
        repeat: -1,
        delay: ((i % BULB_RUN) / BULB_RUN) * CHASE,
        ease: E.hero,
      })
    })
  }

  // Armed playfield light: a soft warm glow loafing down the peg field, so an untouched board reads
  // as plugged-in rather than switched off. `bgglow` is a radial falloff sized to sit inside the well,
  // so it fades out on its own at every edge and needs no mask (same trick as the jackpot meter).
  if (!lowTier && hasGlow) {
    const sweep = scene.add
      .image(0, pegY(1), 'bgglow')
      .setTint(T.goldBright)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(PLAY_W * 0.86, 150)
      .setAlpha(reduced ? 0.07 : 0.11)
    glowLayer.add(sweep)
    if (!reduced) {
      scene.tweens.add({
        targets: sweep,
        y: pegY(PLINKO_ROWS - 2),
        duration: 3200,
        yoyo: true,
        repeat: -1,
        repeatDelay: 500,
        hold: 300,
        ease: E.hero,
      })
    }
  }

  // Slot labels — parked at the TOP of each well (on the value plate) so the resting ball can never
  // sit on top of the number. They stagger in from the centre outward on entrance.
  const slotLabels: Phaser.GameObjects.Text[] = []
  for (let s = 0; s < SLOTS; s++) {
    const tone = toneOf(slots[s])
    const label = scene.add
      .text(slotX(s), PLATE_Y + PLATE_H / 2, slots[s].label, {
        fontFamily: FONT,
        fontSize: slots[s].kind === 'ticket' ? '16px' : '25px',
        fontStyle: '900',
        color: inkOf(tone, T),
      })
      .setOrigin(0.5)
      .setLetterSpacing(1)
      .setShadow(0, 1, 'rgba(0,0,0,0.35)', 2, false, true)
    labelLayer.add(label)
    slotLabels.push(label)
  }

  // Pegs — row r holds r+1 of them, at exactly the x's the ball can occupy. Same maths as the drop,
  // stored by row so an impact finds its peg in O(1) instead of scanning with a float tolerance.
  const pegKey = ensurePegTexture(scene, T)
  const PEG_SIZE = 17
  const pegRows: Phaser.GameObjects.Image[][] = []
  for (let r = 0; r < PLINKO_ROWS; r++) {
    const row: Phaser.GameObjects.Image[] = []
    for (let k = 0; k <= r; k++) {
      const peg = scene.add.image((2 * k - r) * HALF, pegY(r), pegKey).setDisplaySize(PEG_SIZE, PEG_SIZE).setAlpha(0.92)
      pegLayer.add(peg)
      row.push(peg)
    }
    pegRows.push(row)
  }
  /**
   * The peg's resting SCALE, not its pixel size. The dome is baked at 2× (§5.4), so `setDisplaySize`
   * leaves a sub-1 scale — every peg tween below must therefore return to THIS, never to `scale: 1`,
   * or the entrance would settle the pegs at their full 32px texture size.
   */
  const PEG_BASE = pegRows[0][0].scaleX

  // 6) The chip, loaded in the release gate. A soft halo rides with it so it reads as lit metal, and
  // a velocity smear stretches behind it once it is moving (cheap motion blur — no shader).
  const halo = hasGlow
    ? scene.add.image(0, CHUTE_Y, 'bgglow').setTint(T.goldBright).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(BALL * 1.9, BALL * 1.9).setAlpha(0.3)
    : null
  const smear =
    !lowTier && hasGlow
      ? scene.add.image(0, CHUTE_Y, 'bgglow').setTint(T.goldBright).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(BALL * 0.8, BALL * 0.8).setAlpha(0)
      : null
  // Ghost trail: a fixed pool stamped along the flight path and faded out — zero allocation per frame.
  const GHOSTS = lowTier ? 0 : quality.count(5)
  const ghosts: Phaser.GameObjects.Image[] = []
  for (let i = 0; i < GHOSTS; i++) {
    const gh = scene.add.image(0, CHUTE_Y, 'chip').setDisplaySize(BALL, BALL).setAlpha(0)
    ballLayer.add(gh)
    ghosts.push(gh)
  }
  const ball = scene.add.image(0, CHUTE_Y, 'chip').setDisplaySize(BALL, BALL)
  const BASE_SCALE = ball.scaleX
  if (halo) ballLayer.add(halo)
  if (smear) ballLayer.add(smear)
  ballLayer.add(ball)

  const prizeText = track(
    scene.add
      .text(cx, PRIZE_Y, '', { fontFamily: FONT, fontSize: '44px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(63)
      .setLetterSpacing(3)
      .setStroke(css(T.goldDarkest), 7)
      .setShadow(0, 4, 'rgba(70,45,10,0.5)', 8, false, true)
      .setAlpha(0)
  )

  const dev = import.meta.env.DEV ? { slot, kind: prize.kind, mult: result.mult, points, spins, landed: false, ballSlot: -1 } : null
  if (dev) (window as unknown as { __plinko?: unknown }).__plinko = dev

  let settled = false
  let dropping = false

  // ── Impact FX pools ────────────────────────────────────────────────────────
  // A peg strike fires up to four layers; each is pooled or governor-gated so eight strikes in under
  // two seconds cost nothing measurable. Flares are recycled (impacts are ~180ms apart, the flare
  // lasts ~240ms, so at most two overlap).
  const FLARES = lowTier || !hasGlow ? 0 : 3
  const flares: Phaser.GameObjects.Image[] = []
  for (let i = 0; i < FLARES; i++) {
    const f = scene.add.image(0, 0, 'bgglow').setTint(T.goldBright).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(34, 34).setAlpha(0)
    fxLayer.add(f)
    flares.push(f)
  }
  let flareIdx = 0
  let sparks: Phaser.GameObjects.Particles.ParticleEmitter | null = null

  /** Ping the peg the ball just struck: the dome flashes bright and swells, then decays back to rest. */
  const pegHit = (row: number, x: number, speed: number, dir: -1 | 0 | 1): void => {
    const k = Math.round((x / HALF + row) / 2)
    const peg = pegRows[row]?.[k]
    const py = pegY(row)
    if (peg) {
      scene.tweens.killTweensOf(peg)
      peg.setAlpha(1).setScale(PEG_BASE * 1.55)
      scene.tweens.add({ targets: peg, scale: PEG_BASE, alpha: 0.92, duration: 260, ease: E.press })
    }
    if (FLARES > 0) {
      const f = flares[flareIdx]
      flareIdx = (flareIdx + 1) % FLARES
      scene.tweens.killTweensOf(f)
      f.setPosition(x, py).setDisplaySize(30, 30).setAlpha(flashOff ? 0.24 : 0.5)
      scene.tweens.add({ targets: f, displayWidth: 82, displayHeight: 82, alpha: 0, duration: flashOff ? 360 : 240, ease: 'Cubic.easeOut' })
    }
    if (!lowTier) {
      const ring = scene.add.image(x, py, 'shockwave').setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(16, 16).setAlpha(flashOff ? 0.28 : 0.5)
      fxLayer.add(ring)
      scene.tweens.add({
        targets: ring,
        displayWidth: 54,
        displayHeight: 54,
        alpha: 0,
        duration: 300,
        ease: 'Cubic.easeOut',
        onComplete: () => ring.destroy(),
      })
    }
    sparks?.explode(quality.count(2), x, py)
    // The chip answers: a vertical squash spring, and its spin flips to carry the new deflection.
    kick(0.26, dir * Math.min(340, speed * 0.62))
    sfx.clearTink(Math.min(row + 1, 6), pan())
  }

  // ── The drop loop ──────────────────────────────────────────────────────────
  // ONE update handler. It evaluates the current segment's parabola (closed form — no integration
  // drift), carries any leftover frame time across a contact so the motion never micro-stalls, and
  // snaps to the segment's exact end on every contact so the rigged landing stays pixel-honest.
  let falling = false
  let segIdx = 0
  let segT = 0
  let spin = 0 // deg/s
  let sqAmp = 0 // squash amplitude, decaying
  let sqPhase = 0 // squash spring phase
  let ghostClock = 0
  let ghostIdx = 0

  const pan = (): number => Phaser.Math.Clamp(ball.x / (SPAN / 2), -1, 1)

  /** Impact response: kick off a squash spring and set the spin the contact imparted. */
  const kick = (amp: number, spinTo: number): void => {
    sqAmp = amp
    sqPhase = 0
    spin = spinTo
  }

  function stopFall(): void {
    if (!falling) return
    falling = false
    scene.events.off(Phaser.Scenes.Events.UPDATE, onFall)
    scene.events.off(Phaser.Scenes.Events.SHUTDOWN, stopFall)
    if (smear) smear.setAlpha(0)
    for (const gh of ghosts) gh.setAlpha(0)
  }

  /** Park the chip in its slot at rest — the state a skip must always leave the rig in. */
  const restBall = (): void => {
    ball.setPosition(slotX(slot), FLOOR_Y).setAngle(0).setScale(BASE_SCALE)
    halo?.setPosition(ball.x, ball.y)
  }

  function onFall(_time: number, deltaMs: number): void {
    if (!falling) return
    if (!ball.active) {
      stopFall()
      return
    }
    // Clamp a hitch (or a background-resume spike) so the chip can never teleport past a peg.
    const dts = Math.min(deltaMs, 50) / 1000
    let dt = dts

    // Advance through however many segments this frame spans, firing each contact as it is reached.
    while (segIdx < segs.length) {
      const s = segs[segIdx]
      const rem = s.T - segT
      if (dt < rem) {
        segT += dt
        dt = 0
        break
      }
      dt -= rem
      segIdx++
      segT = 0
      ball.setPosition(s.x0 + s.dx, s.y1)
      if (s.contact === 'peg') pegHit(s.row, ball.x, s.vEnd, s.dir)
      else if (s.contact === 'floor') floorHit(s.vEnd)
      else if (s.contact === 'settle') kick(0.13, spin * 0.4)
    }

    if (segIdx >= segs.length) {
      // Every rattle spent — the chip is already sitting exactly on the rigged slot centre.
      stopFall()
      restBall()
      if (dev) dev.ballSlot = Math.round(ball.x / PITCH + (SLOTS - 1) / 2)
      return
    }

    const s = segs[segIdx]
    const p = s.T > 0 ? segT / s.T : 1
    ball.setPosition(s.x0 + s.dx * p, s.y0 + s.vy0 * segT + 0.5 * G * segT * segT)

    // Spin + squash. The squash is a decaying spring so contacts land with weight instead of a pop.
    ball.angle += spin * dts
    if (sqAmp > 0.001) {
      sqPhase += dts * 34
      sqAmp *= Math.exp(-dts * 9)
      const sq = sqAmp * Math.cos(sqPhase)
      ball.setScale(BASE_SCALE * (1 + sq * 0.85), BASE_SCALE * (1 - sq * 0.85))
    } else if (ball.scaleX !== BASE_SCALE) {
      ball.setScale(BASE_SCALE)
    }

    // Velocity smear + ghost trail — the two layers that read as smoothness at speed.
    const vy = s.vy0 + G * segT
    const speed = Math.abs(vy)
    if (smear) {
      const len = Math.min(64, speed * 0.06)
      smear.setPosition(ball.x, ball.y - len * 0.3).setDisplaySize(BALL * 0.78, BALL * 0.78 + len)
      smear.setAlpha(Math.min(1, speed / 1300) * 0.32)
    }
    if (GHOSTS > 0) {
      for (const gh of ghosts) if (gh.alpha > 0) gh.setAlpha(Math.max(0, gh.alpha - dts * 3.2))
      ghostClock += dts * 1000
      if (ghostClock >= 26) {
        ghostClock = 0
        const gh = ghosts[ghostIdx]
        ghostIdx = (ghostIdx + 1) % GHOSTS
        gh.setPosition(ball.x, ball.y).setAngle(ball.angle).setScale(ball.scaleX * 0.9, ball.scaleY * 0.9).setAlpha(0.28)
      }
    }
    halo?.setPosition(ball.x, ball.y)
  }

  // ── Payoff ─────────────────────────────────────────────────────────────────

  /** The floor strike: the loudest beat of the drop, and where the payoff starts. */
  function floorHit(speed: number): void {
    kick(Math.min(0.46, speed / 2400), spin * 0.3) // a harder arrival squashes deeper
    sfx.land(1, pan())
    celebrate(false)
  }

  /**
   * Letter-punch prize typography for the two headline outcomes (a ×10 edge or a free-spin ticket):
   * each glyph pops in on its own overshoot with a small cant, then a cream gleam sweeps the word.
   * Lesser prizes keep the single scaled headline. Same idiom as the wheel's JACKPOT moment.
   */
  const punchHeadline = (text: string, tint: string): void => {
    const size = 46
    // Lay the glyphs out on their MEASURED widths, not a fixed step. A uniform step is fine for a word
    // like the wheel's "JACKPOT!", but these headlines carry digits, commas and spaces — "+24,800 PTS"
    // on a fixed step collides the digits while the space around "PTS" gapes.
    const chars = [...text]
    const glyphs: Array<{ text: Phaser.GameObjects.Text | null; w: number }> = chars.map(ch => {
      if (ch === ' ') return { text: null, w: size * 0.26 }
      const L = track(
        scene.add
          .text(0, PRIZE_Y, ch, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: '900', color: tint })
          .setOrigin(0.5)
          .setDepth(63)
          .setStroke(css(T.goldDarkest), 7)
          .setShadow(0, 4, 'rgba(70,45,10,0.55)', 8, false, true)
          .setScale(0)
          .setAngle(Phaser.Math.Between(-7, 7))
      )
      return { text: L, w: L.width }
    })
    const total = glyphs.reduce((sum, gl) => sum + gl.w, 0)
    let x = cx - total / 2
    glyphs.forEach((gl, i) => {
      if (gl.text) {
        gl.text.setX(x + gl.w / 2)
        scene.tweens.add({ targets: gl.text, scale: 1, angle: 0, duration: 300, delay: i * 42, ease: backOut(OVERSHOOT.pop) })
      }
      x += gl.w
    })
    if (!scene.textures.exists('sweep')) return
    const x0 = cx - total / 2
    const gleam = track(
      scene.add
        .image(x0 - 40, PRIZE_Y, 'sweep')
        .setDisplaySize(44, size + 26)
        .setTint(0xfffdf8)
        .setAlpha(0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(63)
        .setAngle(12)
    )
    const d = chars.length * 42 + 180
    scene.tweens.add({ targets: gleam, x: x0 + total + 40, duration: 330, delay: d, ease: E.glide, onComplete: () => gleam.destroy() })
    scene.tweens.add({ targets: gleam, alpha: 0.7, duration: 165, delay: d, yoyo: true, ease: E.hero })
  }

  function celebrate(snap: boolean): void {
    if (settled) return
    settled = true
    scene.input.off('pointerdown', onSkip)
    scene.tweens.killTweensOf(ball)
    // A skip must never leave the chip mid-flight (cookbook rule) — but a natural landing lets the
    // rattles finish under the celebration, which is what makes the arrival feel physical.
    if (snap) {
      stopFall()
      restBall()
    }
    if (dev) {
      dev.landed = true
      dev.ballSlot = Math.round((snap ? slotX(slot) : ball.x) / PITCH + (SLOTS - 1) / 2)
    }
    if (smear) smear.setAlpha(0)
    for (const gh of ghosts) gh.setAlpha(0)

    // The winning slot lights up: the whole well is repainted in lit metal, the label is relit over it,
    // and a glow pools behind the plate. ROSE for the two premium outcomes (a ticket or a ×10 edge) —
    // painting a ×10 gold made the slot you just won read as LESS special than its unwon rose twin.
    const roseWin = prize.kind === 'ticket' || isTop
    const win = scene.add.graphics()
    glowLayer.add(win)
    const wx = slotX(slot) - HALF + 4
    const ww = PITCH - 8
    if (roseWin) {
      win.fillStyle(T.roseDeep, 1)
      win.fillRoundedRect(wx, SLOT_TOP, ww, SLOT_H, 12)
      win.fillStyle(T.rose, 1)
      win.fillRoundedRect(wx + 2, SLOT_TOP + 2, ww - 4, SLOT_H - 4, 10)
      win.fillStyle(T.roseLight, 0.4)
      win.fillRoundedRect(wx + 3, SLOT_TOP + 3, ww - 6, SLOT_H * 0.3, 8)
      win.lineStyle(2.5, T.goldBright, 0.95)
      win.strokeRoundedRect(wx, SLOT_TOP, ww, SLOT_H, 12)
    } else {
      goldFace(win, wx, SLOT_TOP, ww, SLOT_H, T, 12)
      win.lineStyle(2.5, T.goldBright, 0.9)
      win.strokeRoundedRect(wx, SLOT_TOP, ww, SLOT_H, 12)
    }
    const winLabel = slotLabels[slot]
    winLabel.setColor(roseWin ? css(T.cardFillWarm) : T.goldPillText)
    labelLayer.bringToTop(winLabel)
    if (!reduced) {
      winLabel.setScale(1.3)
      scene.tweens.add({ targets: winLabel, scale: 1, duration: 320, ease: backOut(OVERSHOOT.pop) })
    }

    opts.hitstop?.(flashOff ? 40 : 70)
    sfx.reelClunk(pan())
    if (prize.kind === 'ticket') sfx.starDing(1)
    else if (isTop) sfx.jackpotStrike()
    else sfx.winFanfare()
    if (!hapticsOff()) vibratePattern(isTop || prize.kind === 'ticket' ? [60, 40, 140] : 40)

    if (!reduced) {
      // Landing ring + spark spray + a light pool under the slot, governor-scaled. Under
      // reduce-flashing the ring SWELLS slowly instead of popping, and nothing strobes.
      const ring = scene.add
        .image(ball.x, FLOOR_Y, 'shockwave')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(60, 60)
        .setAlpha(flashOff ? 0.35 : 0.85)
      fxLayer.add(ring)
      scene.tweens.add({
        targets: ring,
        displayWidth: 300,
        displayHeight: 300,
        alpha: 0,
        duration: flashOff ? 640 : 400,
        ease: 'Cubic.easeOut',
      })
      if (hasGlow) {
        const pool = scene.add
          .image(slotX(slot), SLOT_TOP + SLOT_H / 2, 'bgglow')
          .setBlendMode(Phaser.BlendModes.ADD)
          .setTint(roseWin ? T.roseLight : T.goldBright)
          .setDisplaySize(190, 190)
          .setAlpha(0)
        glowLayer.addAt(pool, 0)
        scene.tweens.add({ targets: pool, alpha: flashOff ? 0.32 : 0.6, duration: 240, yoyo: true, repeat: 1, ease: E.hero })
      }
      // World-space bursts, seated on the landing point (the board container is back at scale 1 by now).
      const landX = cx + slotX(slot)
      const burst = track(
        scene.add
          .particles(landX, BOARD_CY + FLOOR_Y, 'spark', {
            speed: { min: 120, max: 340 },
            angle: { min: 200, max: 340 },
            scale: { start: 0.8, end: 0 },
            alpha: { start: 1, end: 0 },
            lifespan: { min: 320, max: 620 },
            tint: roseWin ? T.roseLight : T.goldBright,
            blendMode: 'ADD',
            emitting: false,
          })
          .setDepth(63)
      )
      burst.explode(quality.count(isTop || prize.kind === 'ticket' ? 26 : 14))
      if (isTop || prize.kind === 'ticket') {
        const confetti = track(
          scene.add
            .particles(landX, BOARD_CY + FLOOR_Y - 30, 'confetti', {
              speed: { min: 180, max: 420 },
              angle: { min: 210, max: 330 },
              scale: { start: 1.3, end: 0.3 },
              alpha: { start: 1, end: 0 },
              lifespan: { min: 900, max: 1500 },
              gravityY: 620,
              rotate: { min: -180, max: 180 },
              tint: [T.gold, T.goldBright, T.rose, T.roseLight, T.cardFillWarm],
              emitting: false,
            })
            .setDepth(63)
        )
        confetti.explode(quality.count(40))
      }
      // One camera breath, exactly as the wheel's detent takes — reset in teardown.
      cam.setZoom(1)
      scene.tweens.add({ targets: cam, zoom: isTop ? 1.016 : 1.01, duration: 150, yoyo: true, hold: 60, ease: E.press, onComplete: () => cam.setZoom(1) })
      // The cabinet answers: every bulb pops bright in a fast chase (a soft lift when flash-averse).
      bulbs.forEach((b, i) => {
        scene.tweens.killTweensOf(b)
        scene.tweens.add({
          targets: b,
          alpha: 1,
          scale: b.scale * (flashOff ? 1.12 : 1.45),
          duration: flashOff ? 420 : 150,
          delay: (i % BULB_RUN) * (flashOff ? 30 : 18),
          yoyo: true,
          ease: E.press,
        })
      })
    }

    // Prize readout — the honest number, sized by what was actually won.
    const headline =
      prize.kind === 'ticket'
        ? spins > 0
          ? `+${spins} FREE SPIN${spins > 1 ? 'S' : ''}`
          : 'FREE SPINS FULL'
        : `+${points.toLocaleString()} PTS`
    const ink = css(prize.kind === 'ticket' ? T.roseLight : T.goldBright)
    // The two headline outcomes earn the letter punch; everything else keeps the single pop.
    if (!reduced && (isTop || (prize.kind === 'ticket' && spins > 0))) {
      punchHeadline(headline, ink)
    } else {
      prizeText.setText(headline).setColor(ink)
      if (reduced) {
        prizeText.setAlpha(1)
      } else {
        prizeText.setScale(0.6)
        scene.tweens.add({ targets: prizeText, alpha: 1, scale: 1, duration: 320, ease: backOut(OVERSHOOT.pop) })
      }
    }
    if (prize.kind === 'mult') sfx.coinCount()

    // CLAIM — the only exit.
    const claim = track(
      addPillButton(
        scene,
        cx,
        BUTTON_Y,
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
            ease: E.exit,
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
  const startFall = (): void => {
    if (settled) return
    sfx.whoosh(0)
    // A release flash out of the gate — the chip is launched, not merely dropped.
    if (!reduced && !flashOff && scene.textures.exists('fireball')) {
      const flash = scene.add.image(0, CHUTE_Y, 'fireball').setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(90, 90).setAlpha(0.85)
      fxLayer.add(flash)
      scene.tweens.add({
        targets: flash,
        displayWidth: 240,
        displayHeight: 240,
        alpha: 0,
        duration: 340,
        ease: 'Cubic.easeOut',
        onComplete: () => flash.destroy(),
      })
    }
    if (!lowTier) {
      // Parked in the FX layer, so the container-local peg coords handed to `explode` land correctly
      // and the whole spray is torn down with the cabinet.
      sparks = track(
        scene.add.particles(0, 0, 'spark', {
          speed: { min: 40, max: 150 },
          angle: { min: 0, max: 360 },
          scale: { start: 0.45, end: 0 },
          alpha: { start: 0.9, end: 0 },
          lifespan: { min: 220, max: 420 },
          tint: T.goldBright,
          blendMode: 'ADD',
          emitting: false,
        })
      )
      fxLayer.add(sparks)
    }
    falling = true
    segIdx = 0
    segT = 0
    scene.events.on(Phaser.Scenes.Events.UPDATE, onFall)
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, stopFall)
  }

  const drop = (): void => {
    if (dropping || settled) return
    dropping = true
    scene.tweens.add({ targets: dropBtn, alpha: 0, scale: 0.8, duration: 160, ease: E.exit, onComplete: () => dropBtn.destroy() })
    if (reduced) {
      celebrate(true)
      return
    }
    // Anticipation: the chip crouches UP against the gate before it falls. The single cheapest thing
    // that makes a drop read as deliberate rather than dumped (the wheel's wind-up crouch, in miniature).
    sfx.charge(1)
    scene.tweens.add({
      targets: ball,
      y: CHUTE_Y - 11,
      scaleX: BASE_SCALE * 1.1,
      scaleY: BASE_SCALE * 0.86,
      duration: 115,
      yoyo: true,
      ease: E.press,
      onUpdate: () => halo?.setPosition(ball.x, ball.y),
      onComplete: () => {
        ball.setPosition(0, CHUTE_Y).setScale(BASE_SCALE)
        startFall()
      },
    })
  }

  // 7) DROP — the player's one input. Tapping anywhere during the fall skips to the payoff.
  const dropBtn = track(
    addPillButton(scene, cx, BUTTON_Y, 300, 84, 'DROP', GOLD_PILL, () => drop(), { juice: true }).setDepth(64)
  )

  // A live `on` (not `once`): the pill fires on pointerUP, so a `once` listener was being consumed by
  // the DROP press itself and tap-to-skip never actually reached the fall.
  function onSkip(): void {
    if (settled || !dropping) return // not started yet — the DROP button owns the first tap
    celebrate(true)
  }
  scene.input.on('pointerdown', onSkip)

  // 8) Entrance — the cabinet pops about its own centre, the pegs cascade in row by row, and the slot
  // plates light from the middle outward. Reduced motion places everything at rest instantly.
  if (reduced) {
    board.setScale(1)
    dropBtn.setScale(1)
  } else {
    title.setScale(0)
    stake.setAlpha(0)
    board.setScale(0.66).setAlpha(0)
    dropBtn.setScale(0)
    scene.tweens.add({ targets: board, scale: 1, alpha: 1, duration: 420, ease: backOut(OVERSHOOT.gentle) })
    scene.tweens.add({ targets: title, scale: 1, duration: 340, delay: 90, ease: 'Back.easeOut' })
    scene.tweens.add({ targets: stake, alpha: 1, duration: 260, delay: 220, ease: E.press })
    for (let r = 0; r < PLINKO_ROWS; r++) {
      for (const peg of pegRows[r]) {
        peg.setScale(0)
        scene.tweens.add({ targets: peg, scale: PEG_BASE, duration: 260, delay: 180 + r * 32, ease: backOut(OVERSHOOT.pop) })
      }
    }
    slotLabels.forEach((label, s) => {
      label.setAlpha(0)
      scene.tweens.add({ targets: label, alpha: 1, duration: 220, delay: 260 + Math.abs(s - (SLOTS - 1) / 2) * 44, ease: E.press })
    })
    // The chip lands in its gate last, so the eye finishes on the thing about to move.
    ball.setAlpha(0)
    halo?.setAlpha(0)
    scene.tweens.add({ targets: ball, alpha: 1, duration: 200, delay: 520, ease: E.press })
    if (halo) scene.tweens.add({ targets: halo, alpha: 0.3, duration: 200, delay: 520, ease: E.press })
    scene.tweens.add({ targets: dropBtn, scale: 1, duration: 320, delay: 640, ease: backOut(OVERSHOOT.pop) })
    at(560, () => sfx.reelClunk(0)) // the chip seating in its gate — the machine is loaded
  }
}

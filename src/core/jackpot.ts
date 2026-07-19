import type { Rng } from './rng'

/**
 * Jackpot Wheel — pure logic (no Phaser). A meter charges one notch per numbered-level win;
 * when it fills it "explodes" into a wheel-of-fortune spin that pays out chips. Like the daily
 * spin, the machine ALWAYS pays (it's a reward, not gambling) and is AWARD-FIRST: the winning
 * wedge is decided + the chips banked BEFORE any animation, then the wheel is rigged to land on
 * it — so quitting mid-celebration can never lose the prize (mirrors core/daily.ts).
 */

/** Level wins needed to charge the meter to full (one wheel spin). */
export const JACKPOT_GOAL = 5

/** A wheel wedge: a chip payout with a spawn weight (small values common, jackpot rare). */
export interface WheelPrize {
  chips: number
  label: string
  jackpot?: boolean
  weight: number
}

/**
 * The 8 wedges in clockwise order (wedge 0 spans from the 12-o'clock pointer, going clockwise).
 * Values are interleaved high/low so the wheel reads varied and exciting rather than sorted;
 * weights favour the small payouts so the big ones stay a genuine thrill. Weights sum to 100, so
 * each weight reads directly as a percentage. Expected value ≈ 156 chips — a meaningful bonus on
 * top of the ~40–55 chips a level win already banks.
 */
export const WHEEL_PRIZES: WheelPrize[] = [
  { chips: 100, label: '100', weight: 18 },
  { chips: 500, label: '500', weight: 5 },
  { chips: 75, label: '75', weight: 20 },
  { chips: 200, label: '200', weight: 11 },
  { chips: 50, label: '50', weight: 22 },
  { chips: 1000, label: 'JACKPOT', jackpot: true, weight: 2 },
  { chips: 150, label: '150', weight: 14 },
  { chips: 300, label: '300', weight: 8 },
]

/** True once enough level wins have charged the meter to fire the wheel. */
export function jackpotReady(meter: number): boolean {
  return meter >= JACKPOT_GOAL
}

/** Meter fill fraction 0..1 for the HUD (clamped). */
export function jackpotFraction(meter: number): number {
  return Math.max(0, Math.min(1, meter / JACKPOT_GOAL))
}

/**
 * Weighted wedge pick — returns the winning index into WHEEL_PRIZES via cumulative-weight
 * selection (identical shape to core/daily.ts `rollPrize`). The caller rigs the spin to land the
 * pointer on this index.
 */
export function rollWheelIndex(rng: Rng): number {
  const total = WHEEL_PRIZES.reduce((sum, p) => sum + p.weight, 0)
  let roll = rng() * total
  for (let i = 0; i < WHEEL_PRIZES.length; i++) {
    roll -= WHEEL_PRIZES[i].weight
    if (roll < 0) return i
  }
  return 0
}

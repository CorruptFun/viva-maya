import type { Rng } from './rng'
import type { BoostType } from './types'

/**
 * Jackpot Wheel — pure logic (no Phaser). A meter charges one notch per numbered-level win;
 * when it fills it "explodes" into a wheel-of-fortune spin. Like the daily spin, the machine ALWAYS
 * pays (it's a reward, not gambling) and is AWARD-FIRST: the winning wedge is decided + the prize
 * banked BEFORE any animation, then the wheel is rigged to land on it — so quitting mid-celebration
 * can never lose the prize (mirrors core/daily.ts).
 */

/** Level wins needed to charge the meter to full (one wheel spin). */
export const JACKPOT_GOAL = 5

/**
 * A wheel wedge is EITHER a chip payout or a boost (a power-up applied to the next level, exactly
 * like the daily spin's prizes). `label` is the short text shown on the wedge; boosts also carry a
 * fuller `name` for the reveal readout. `weight` is the spawn weight (relative probability).
 */
export type WheelPrize =
  | { kind: 'chips'; chips: number; label: string; jackpot?: boolean; weight: number }
  | { kind: 'boost'; boost: BoostType; label: string; name: string; weight: number }

/**
 * The 8 wedges in clockwise order, chips and boosts interleaved so the wheel reads varied. Odds are
 * the weights (they sum to 100, so each reads directly as a percentage): value ∝ 1/frequency, so
 * cheap consolation prizes are common and the JACKPOT is a ~2% thrill. Boosts sit in the middle tiers
 * — in Gift-Store terms they're mid-value (~50–80 chips) — for a ~36% boost / ~64% chip split. The
 * mildest boost (+5 moves) is the most common; the board-changers (wild reel, dice bomb) are rarer.
 */
export const WHEEL_PRIZES: WheelPrize[] = [
  { kind: 'chips', chips: 50, label: '50', weight: 24 },
  { kind: 'boost', boost: 'wildReel', label: 'WILD', name: 'WILD REEL', weight: 10 },
  { kind: 'chips', chips: 100, label: '100', weight: 18 },
  { kind: 'boost', boost: 'extraMoves', label: '+5', name: '+5 MOVES', weight: 16 },
  { kind: 'chips', chips: 200, label: '200', weight: 12 },
  { kind: 'boost', boost: 'diceBomb', label: 'BOMB', name: 'DICE BOMB', weight: 10 },
  { kind: 'chips', chips: 500, label: '500', weight: 8 },
  { kind: 'chips', chips: 1000, label: 'JACKPOT', jackpot: true, weight: 2 },
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
 * Weighted wedge pick — returns the winning index into WHEEL_PRIZES via cumulative-weight selection
 * (identical shape to core/daily.ts `rollPrize`). The caller rigs the spin to land on this index.
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

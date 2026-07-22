import type { BoostType } from './types'
import type { SaveData } from './save'
import { FREE_SPIN_BANK_CAP, FREE_SPIN_DAILY_CAP, persistSave } from './save'
import type { Rng } from './rng'

/**
 * Daily bonus spin — pure logic (no Phaser). One spin per local calendar day.
 * The machine ALWAYS pays out (it's a gift, not gambling): a weighted prize
 * applied as a boost to the next level started. Consecutive days build a
 * streak; every 5th streak day the spin pays double.
 */
export interface Prize {
  type: BoostType
  label: string
  blurb: string
  weight: number
}

export const PRIZES: Prize[] = [
  { type: 'wildReel', label: 'WILD REEL', blurb: 'Next level starts with a Wild Reel on the board', weight: 30 },
  { type: 'diceBomb', label: 'DICE BOMB', blurb: 'Next level starts with a Dice Bomb on the board', weight: 25 },
  { type: 'extraMoves', label: '+5 MOVES', blurb: 'Five bonus moves on your next level', weight: 20 },
  { type: 'doubleScore', label: 'DOUBLE SCORE', blurb: 'Everything scores 2x on your next level', weight: 15 },
  { type: 'jackpot', label: 'JACKPOT CHIP', blurb: 'Next level starts with a Jackpot Chip!', weight: 10 },
]

export function todayKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** Whole days between two YYYY-MM-DD keys (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

export function spinAvailable(save: SaveData, now = new Date()): boolean {
  return save.lastSpinDate !== todayKey(now)
}

// ─────────────────────────────────────────────────────────────────────────────
// FREE SPINS — bonus wheel pulls earned by spectacular in-level play. A big
// cascade banks extra spins (save.freeSpins via save.addFreeSpins) that BYPASS
// the once-a-day latch: performFreeSpin below spends the bank and never touches
// lastSpinDate / streak, so the daily gift keeps its own rhythm.
// ─────────────────────────────────────────────────────────────────────────────

/** Re-exported caps (defined beside the save fields they clamp — see core/save.ts). */
export { FREE_SPIN_BANK_CAP, FREE_SPIN_DAILY_CAP }

export interface FreeSpinAward {
  /** Smallest cascade chain (consecutive match waves) that earns this tier. */
  minCascade: number
  spins: number
}

/** Cascade → free-spin award tiers, ordered best-first (awardFreeSpinsFor takes the first hit). */
export const FREE_SPIN_AWARDS: FreeSpinAward[] = [
  { minCascade: 6, spins: 6 },
  { minCascade: 4, spins: 3 },
]

/** Spins a cascade chain of `cascade` waves earns (0 when below every tier). Caps apply at banking
 *  time — save.addFreeSpins clamps to the daily earn cap and the bank cap and reports what stuck. */
export function awardFreeSpinsFor(cascade: number): number {
  for (const tier of FREE_SPIN_AWARDS) if (cascade >= tier.minCascade) return tier.spins
  return 0
}

/** Can the player pull the wheel AT ALL right now — today's daily spin, or a banked free spin? */
export function hasAnySpin(save: SaveData, now = new Date()): boolean {
  return spinAvailable(save, now) || save.freeSpins > 0
}

export function rollPrize(rng: Rng): Prize {
  const total = PRIZES.reduce((sum, p) => sum + p.weight, 0)
  let roll = rng() * total
  for (const prize of PRIZES) {
    roll -= prize.weight
    if (roll < 0) return prize
  }
  return PRIZES[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY CHECK-IN CHIPS — the "occasionally chips" faucet the economy diagram
// promises (docs/SOCIAL_AND_ECONOMY.md), made a dependable part of every daily
// pull. A 7-day ladder ramps the reward small→big across a streak week and RESETS
// with the week, indexed by ((streak - 1) % 7) — the exact model the D3 week strip
// already draws (weekDots), so the "payday" lands the day the 7th dot lights and
// starts over with a fresh week. Because the payout is a FIXED amount per day it is
// inflation-safe by construction regardless of player count (iron rule #1's spirit:
// every faucet is a fixed-size gift). Steady-state ≈ 56 chips/day — a meaningful
// supplement to level-win income (~33/day) that never eclipses the Gift Store sinks
// (boosts 40–120) or the weekly champion purse (1,000). This table IS the knob: raise
// the day-7 cap or flatten the curve here and nothing else needs to move.
// ─────────────────────────────────────────────────────────────────────────────

/** Chips a daily check-in pays on each day of a streak week (day 1 → day 7); repeats every 7 days. */
export const CHECKIN_CHIPS = [10, 15, 25, 40, 60, 90, 150] as const

/**
 * Chips today's daily check-in awards for a 1-based streak day. Indexes CHECKIN_CHIPS by
 * ((streak - 1) % 7) so the reward ramps across the week and the day-7 payday recurs weekly in
 * lockstep with the streak strip; returns 0 for a non-positive streak (never-spun / defensive).
 */
export function checkinChipsFor(streak: number): number {
  if (streak < 1) return 0
  return CHECKIN_CHIPS[(streak - 1) % CHECKIN_CHIPS.length]
}

/**
 * Perform today's spin: updates streak, awards prize(s) into pendingBoosts, banks the streak-scaled
 * daily check-in chips, stamps the date, and persists — all BEFORE any animation, so closing the app
 * mid-celebration can't lose the prize. Returns the chips awarded so the caller can size the "+N CHIPS"
 * beat honestly.
 */
export function performSpin(save: SaveData, rng: Rng, now = new Date()): { prizes: Prize[]; streak: number; chips: number } {
  const today = todayKey(now)
  save.streak = save.lastSpinDate && daysBetween(save.lastSpinDate, today) === 1 ? save.streak + 1 : 1
  save.lastSpinDate = today
  const prizes = [rollPrize(rng)]
  if (save.streak > 0 && save.streak % 5 === 0) prizes.push(rollPrize(rng))
  save.pendingBoosts.push(...prizes.map(p => p.type))
  // Bank the check-in chips onto the SAME save object this persists below — never via addChips(), whose
  // fresh loadSave()→persist would be clobbered by the persistSave() here (and lose the boosts/streak).
  const chips = checkinChipsFor(save.streak)
  save.chips += chips
  persistSave(save)
  return { prizes, streak: save.streak, chips }
}

/**
 * Spend one BANKED free spin — the daily latch's sibling. Decrements save.freeSpins, awards a single
 * prize into pendingBoosts, and persists BEFORE any animation (same crash-safety as performSpin).
 * Deliberately does NOT touch lastSpinDate or streak (free spins ride alongside the daily rhythm,
 * they never substitute for it) and never pays the streak double. Returns null when the bank is
 * empty — the save is left untouched, so a caller can never double-spend a race.
 */
export function performFreeSpin(save: SaveData, rng: Rng): { prizes: Prize[]; remaining: number } | null {
  if (save.freeSpins <= 0) return null
  save.freeSpins -= 1
  const prizes = [rollPrize(rng)]
  save.pendingBoosts.push(...prizes.map(p => p.type))
  persistSave(save)
  return { prizes, remaining: save.freeSpins }
}

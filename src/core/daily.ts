import { BOOST_META } from './inventory'
import type { BoostType } from './types'
import type { SaveData } from './save'
import { FREE_SPIN_BANK_CAP, FREE_SPIN_DAILY_CAP } from './save'
import type { Rng } from './rng'

/**
 * The daily check-in — pure logic (no Phaser). One free pull per local calendar day, taken on the
 * LUCKY SLOTS cabinet (core/store.ts freeSlotSpin; SlotScene presents it). A free pull is a gift,
 * not gambling — the GIFT FLOOR in freeSlotSpin guarantees it never pays nothing, with this module's
 * classic PRIZES table as the floor. Consecutive days build a streak; the streak scales the check-in
 * chips (CHECKIN_CHIPS) and every 5th day pays a double prize (milestoneDue).
 */
export interface Prize {
  type: BoostType
  label: string
  blurb: string
  weight: number
}

/**
 * Spawn weights, richest rarest. ⚠️ THE ORDER OF THIS LIST IS LOAD-BEARING — `rollPrize` walks it
 * accumulating weights, so reordering it changes which prize a given RNG roll returns and silently
 * rewrites every seeded test. Display order is a separate, deliberately different list
 * (`BOOST_ORDER` in core/inventory.ts); do not conflate them.
 */
const PRIZE_WEIGHTS: ReadonlyArray<readonly [BoostType, number]> = [
  ['wildReel', 30],
  ['diceBomb', 25],
  ['extraMoves', 20],
  ['doubleScore', 15],
  ['jackpot', 10],
]

/**
 * Labels and blurbs come from `BOOST_META` (core/inventory.ts) rather than being written here. This
 * table and the Gift Store's `BOOST_ITEMS` used to each carry their own copy of every name, which is
 * how one object ends up with two names — and a player who wins "+5 MOVES" and is then shown a
 * differently-worded version of the same thing has no way to know they are the same item.
 */
export const PRIZES: Prize[] = PRIZE_WEIGHTS.map(([type, weight]) => ({
  type,
  label: BOOST_META[type].label,
  blurb: BOOST_META[type].blurb,
  weight,
}))

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
 * Advance the daily check-in ritual on the passed save: streak (consecutive-day +1, else back to 1),
 * the `lastSpinDate` latch, and the streak-scaled check-in chips — banked onto the SAME save object
 * (never via addChips(), whose fresh loadSave()→persist would clobber the caller's own persist).
 *
 * Deliberately does NOT persist and does NOT roll a prize: it is the RITUAL half of the daily spin,
 * extracted so exactly one definition of "what a daily check-in does" exists now that the spin
 * itself lives on the Lucky Slots cabinet (core/store.ts freeSlotSpin — which persists once, after
 * banking everything). Returns what it advanced so the caller can present it honestly.
 *
 * The 5th-streak-day DOUBLE PRIZE is the caller's to pay (milestoneDue below) — this half only ever
 * moves the calendar and the chips.
 */
export function advanceDailyRitual(save: SaveData, now = new Date()): { streak: number; chips: number } {
  const today = todayKey(now)
  save.streak = save.lastSpinDate && daysBetween(save.lastSpinDate, today) === 1 ? save.streak + 1 : 1
  save.lastSpinDate = today
  const chips = checkinChipsFor(save.streak)
  save.chips += chips
  return { streak: save.streak, chips }
}

/** True on the streak days the daily spin pays DOUBLE (every 5th day — the week strip's starred dot). */
export function milestoneDue(streak: number): boolean {
  return streak > 0 && streak % 5 === 0
}

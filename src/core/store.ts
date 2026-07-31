import { grantCharm } from './charms'
import type { CharmAward } from './charms'
import { loadSave, persistSave } from './save'
import { betFor, spinSlots } from './slots'
import type { SlotSpin } from './slots'
import type { Rng } from './rng'
import type { BoostType } from './types'

/**
 * Gift Store — the closed-loop sink for earned chips (no Phaser, no cash value).
 * Chips are banked from level wins (GameScene.finishWin); here they buy consumable
 * boosts that drop into the SAME pendingBoosts pile the daily spin feeds, so they
 * apply to the next numbered level. Pure logic so it stays unit-testable and mirrors
 * core/daily.ts. Themes are intentionally NOT sold here — they stay free and
 * progress-unlocked via the theme picker (see view/theme.ts `themeUnlocked`).
 */

export interface BoostStoreItem {
  type: BoostType
  label: string
  blurb: string
  price: number
}

/** Boost catalogue, cheapest → most powerful. Priced against the ~25–45 chips a win pays. */
export const BOOST_ITEMS: BoostStoreItem[] = [
  { type: 'extraMoves', label: '+5 MOVES', blurb: 'Five extra moves on your next level', price: 40 },
  { type: 'wildReel', label: 'WILD REEL', blurb: 'Start your next level with a Wild Reel', price: 60 },
  { type: 'diceBomb', label: 'DICE BOMB', blurb: 'Start your next level with a Dice Bomb', price: 75 },
  { type: 'doubleScore', label: 'DOUBLE SCORE', blurb: 'Everything scores 2× on your next level', price: 90 },
  { type: 'jackpot', label: 'JACKPOT CHIP', blurb: 'Start your next level with a Jackpot Chip', price: 120 },
]

// ─────────────────────────────────────────────────────────────────────────────
// In-level helpers (the mid-level "power bar" below the jackpot meter). Unlike the Gift Store
// above — which queues a boost for the NEXT level via pendingBoosts — these apply to the level
// being PLAYED right now: top up moves so you don't run out, or drop a bomb to clear a spot.
// Same closed-loop economy (earned chips only, no cash value); the SPEND is atomic (save.spendChips),
// the EFFECT is applied live by GameScene (it owns the board + move counter). Catalogue only here so
// it stays pure + unit-testable, mirroring BOOST_ITEMS.
// ─────────────────────────────────────────────────────────────────────────────

/** An in-level helper kind: a +1 move top-up, a +5 move top-up, or a targeted 3×3 bomb. */
export type PowerType = 'move1' | 'moves5' | 'bomb'

export interface PowerItem {
  type: PowerType
  label: string
  blurb: string
  price: number
  /** Moves granted by a top-up item (absent for the bomb). */
  moves?: number
}

/**
 * The in-level helper shelf, cheapest → priciest. Priced against the ~25–45 chips a win pays
 * (GameScene.finishWin: stars*8 + earnedLeftover*2): a single move is a cheap nudge, the +5 bundle
 * is better value per move ("don't run out"), and the bomb is the priciest, most decisive help.
 */
export const POWER_ITEMS: PowerItem[] = [
  { type: 'move1', label: '+1 MOVE', blurb: 'One more swap', price: 8, moves: 1 },
  { type: 'moves5', label: '+5 MOVES', blurb: "Don't run out", price: 30, moves: 5 },
  { type: 'bomb', label: 'BOMB', blurb: 'Blast a 3×3', price: 35 },
]

/**
 * §G10 · what one heart costs at the lives wall.
 *
 * The wall used to be a dead end: 0 lives showed a countdown and nothing else, so a player who
 * wanted to keep playing had exactly one option — close the app for up to 20 minutes. That is the
 * genre's standard shape too, but every benchmark pairs it with a way THROUGH (gems, an ad, or
 * asking a friend), and this build already had the currency and an unused `grantLife` sitting
 * there with zero callers.
 *
 * Priced ABOVE a single win's payout (a win banks ~25-45 chips) so a refill is a real decision and
 * cannot outrun the faucet, but low enough that a couple of good levels buys one. The whole
 * economy is closed-loop and earned-only — there is no cash purchase behind this.
 */
export const LIFE_REFILL_PRICE = 50

export type PurchaseResult = { ok: true; balance: number } | { ok: false; reason: 'insufficient' }

/**
 * Buy a boost: deduct chips and queue it for the next numbered level. Single
 * load→mutate→persist (like daily.ts performSpin) so the spend and the grant
 * can never tear apart. Returns the new balance, or an `insufficient` result
 * that leaves the save untouched.
 */
export function buyBoost(item: BoostStoreItem): PurchaseResult {
  const save = loadSave()
  if (save.chips < item.price) return { ok: false, reason: 'insufficient' }
  save.chips -= item.price
  save.pendingBoosts.push(item.type)
  persistSave(save)
  return { ok: true, balance: save.chips }
}

// ─────────────────────────────────────────────────────────────────────────────
// LUCKY SLOTS — the purchased spin (see core/slots.ts for the machine itself).
//
// The catalogue above sells CERTAINTY: pay the price, get the boost. This sells a SHOT at more than
// you paid for, at an expected return below the ticket (core/slots.ts documents why that edge has to
// exist for both surfaces to stay worth using). It lives here rather than in slots.ts so that module
// stays pure and Rng-testable — the same split daily.ts/DailyBonusScene and plinko.ts/view use.
// ─────────────────────────────────────────────────────────────────────────────

/** A spin that was actually paid for: the settled reels, what got banked, and the new balance. */
export interface SlotPurchase {
  spin: SlotSpin
  balance: number
  /** Jackpot notches that landed on the meter, and where the meter now stands. */
  meter: number
  /** The charm award, when the scatter hit — a new charm, a completed series, or a duplicate payout. */
  charm?: CharmAward
}

export type SlotSpinResult = { ok: true; purchase: SlotPurchase } | { ok: false; reason: 'insufficient' }

/**
 * Buy and settle one spin. AWARD-FIRST, exactly like the daily spin, the jackpot wheel and the plinko
 * drop: everything is banked here, before the caller animates a single reel, so closing the app
 * mid-spin cannot lose a prize.
 *
 * ORDERING — the charm is granted BEFORE the chips are taken, and the price is re-checked afterwards
 * (`grantCharm` re-reads the save, so that is the one point another writer could have moved the
 * balance underneath us). This mirrors charms.redeemCharms and picks the same direction of error: the
 * only crash window leaves a player holding the charm AND the chips rather than neither. Every other
 * prize — boosts, jackpot points, the debit itself — rides ONE load→mutate→persist, so they can never
 * tear apart from each other.
 *
 * Returns `insufficient` with the save completely untouched when the bet can't be afforded.
 */
export function buySpin(rows: number, rng: Rng): SlotSpinResult {
  const bet = betFor(rows)
  if (loadSave().chips < bet.price) return { ok: false, reason: 'insufficient' }

  const spin = spinSlots(rng, bet.rows)
  const charm = spin.charm ? grantCharm(rng) : undefined

  const save = loadSave()
  if (save.chips < bet.price) return { ok: false, reason: 'insufficient' }
  save.chips -= bet.price
  save.pendingBoosts.push(...spin.boosts)
  save.jackpotMeter += spin.points
  persistSave(save)

  return { ok: true, purchase: { spin, balance: save.chips, meter: save.jackpotMeter, charm } }
}

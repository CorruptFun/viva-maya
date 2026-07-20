import { loadSave, persistSave } from './save'
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

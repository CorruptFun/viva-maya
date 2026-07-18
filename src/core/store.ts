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

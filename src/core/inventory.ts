import { splitPendingBoosts } from './save'
import type { SaveData } from './save'
import type { BoostType } from './types'

/**
 * THE STASH — a view over the boosts a player owns. Pure logic (no Phaser); view/stash.ts renders it,
 * mirroring core/daily.ts ↔ SlotScene and core/charms.ts ↔ view/charmalbum.ts.
 *
 * ── Why this exists (a real player asked, 2026-08-03) ────────────────────────
 *   "When you win stuff in Lucky Slots where does it go? Where do you see your stash? And most
 *    importantly how do you use it? I'm still getting charged coins for using perks I've won."
 *
 * All three questions had the same root, and the last one is a false alarm worth understanding
 * because it is the game's fault, not the player's. Winnings land in `save.pendingBoosts` and are
 * applied FREE at the next numbered level's start — `GameScene.applyBoosts` deducts nothing, and
 * there has never been a code path that charges for a won boost. But:
 *
 *   • the stash had NO user interface anywhere. Home showed one line, "boost ready for your next
 *     level", which named neither what nor how many.
 *   • the only sign a boost was spent was a gold toast at level start that then faded.
 *   • meanwhile the in-level HELPER shelf sits under the board for the whole level, captioned
 *     "SPEND CHIPS TO WIN THIS LEVEL", and used to offer an item called "+5 MOVES" for 30 chips —
 *     the *identical name* to a prize the player had just won for free. The Gift Store sells one
 *     under that name too, at 40.
 *
 * So a player won a thing, watched it vanish, and was then quoted a price for something with the
 * same name. Concluding you are being charged for your own winnings is the only reasonable reading.
 * The fix is ownership made visible everywhere the name appears — this module is the model for that.
 *
 * ── Canonical names live HERE ────────────────────────────────────────────────
 * `BOOST_META` is the single source of truth for what a boost is CALLED. core/daily.ts (the free
 * prize table) and core/store.ts (the paid one) previously each carried their own copy of every
 * label, which is exactly how a rename drifts into two names for one object.
 */

export interface BoostMeta {
  /** Display name — the one canonical spelling, used by the prize table, the store and the stash. */
  label: string
  /** What it does, phrased for someone deciding whether to spend it. */
  blurb: string
  /** Emoji shown on the stash tile. NOT usable in Phaser pill labels — see the note in HomeScene. */
  icon: string
}

/**
 * Canonical order, richest last. The stash renders in this order rather than in queue order so the
 * grid never reshuffles under the player's thumb when a boost is promoted.
 */
export const BOOST_ORDER: readonly BoostType[] = ['extraMoves', 'wildReel', 'diceBomb', 'doubleScore', 'jackpot']

export const BOOST_META: Record<BoostType, BoostMeta> = {
  extraMoves: { label: '+5 MOVES', blurb: 'Start the level with five extra moves', icon: '👟' },
  wildReel: { label: 'WILD REEL', blurb: 'Start with a Wild Reel already on the board', icon: '🎰' },
  diceBomb: { label: 'DICE BOMB', blurb: 'Start with a Dice Bomb already on the board', icon: '🎲' },
  doubleScore: { label: 'DOUBLE SCORE', blurb: 'Everything scores 2× for the whole level', icon: '✨' },
  jackpot: { label: 'JACKPOT CHIP', blurb: 'Start with a Jackpot Chip already on the board', icon: '🍀' },
}

/** One row of the stash: a boost type, how many are owned, and how many go in next level. */
export interface StashEntry {
  type: BoostType
  meta: BoostMeta
  /** Total owned. */
  count: number
  /** How many of this type the NEXT numbered level will consume (0 when it stays banked). */
  usingNext: number
  /** True when the player has set this type aside — none of them go in, however many are owned. */
  held: boolean
}

/**
 * The full stash, in `BOOST_ORDER`, including zero-count rows so the grid keeps a stable shape and
 * reads as a collection with gaps rather than a list that grows and shrinks.
 *
 * `usingNext` comes from `splitPendingBoosts` — the SAME function the level start consumes with — so
 * the panel's "using next level" promise cannot drift from what actually happens. See its doc.
 */
export function stash(save: SaveData): StashEntry[] {
  const pending = save.pendingBoosts ?? []
  const held = save.heldBoosts ?? []
  const { take } = splitPendingBoosts(pending, held)
  return BOOST_ORDER.map(type => ({
    type,
    meta: BOOST_META[type],
    count: pending.filter(b => b === type).length,
    usingNext: take.filter(b => b === type).length,
    held: held.includes(type),
  }))
}

/** Total boosts owned — the badge number, and the gate for showing the stash entry at all. */
export function stashTotal(save: SaveData): number {
  return (save.pendingBoosts ?? []).length
}

/** How many boosts the next numbered level will consume. Never exceeds `boostApplyMax`. */
export function usingNextCount(save: SaveData): number {
  return splitPendingBoosts(save.pendingBoosts ?? [], save.heldBoosts ?? []).take.length
}

/**
 * ── USING A STASHED BOOST INSTEAD OF PAYING ──────────────────────────────────
 * Which owned boost, if any, delivers the same thing an in-level HELPER shelf item sells. Returns
 * null when nothing the player owns is genuinely equivalent.
 *
 * ⚠️ EXACTLY ONE mapping is honest, and the temptation to add more should be resisted:
 *
 *   moves5 (+5 MOVES, 30 chips) ← extraMoves.  Identical effect — five more swaps. The only
 *       difference is timing, and timing is precisely what this feature hands to the player.
 *
 *   move1 (+1 MOVE, 8 chips)    ← nothing. No boost grants one move, and quietly burning a +5 for
 *       a +1 would be a worse deal than the 8 chips it "saved".
 *
 *   bomb (BLAST, 35 chips)      ← NOT diceBomb, despite the names. A Dice Bomb is a PIECE planted
 *       on the board that you then have to match; BLAST is an immediate 3×3 you aim. Same-sounding
 *       names for different mechanics is the exact confusion this whole change set exists to undo
 *       (see the header of view/stash.ts) — offering one as the other would re-create it one layer
 *       deeper, where it would be even harder to explain.
 *
 * The single mapping is also the one the player who reported this actually hit: they owned "+5
 * MOVES" and were looking at "+5 MOVES" with a price on it.
 */
export function freeSourceFor(powerType: string): BoostType | null {
  return powerType === 'moves5' ? 'extraMoves' : null
}

/** How many owned boosts could stand in for this shelf item. 0 when none, or when none can. */
export function freeStockFor(save: SaveData, powerType: string): number {
  const src = freeSourceFor(powerType)
  if (!src) return 0
  return (save.pendingBoosts ?? []).filter(b => b === src).length
}

/**
 * True when the player owns more than the next level can take — the one state the stash has to
 * explain, because a surplus is invisible otherwise and looks like a boost went missing.
 *
 * The surplus is NOT lost: `takePendingBoosts` keeps it banked in order (that was already true
 * before this module; the old behaviour of draining the whole bank into one level was fixed by
 * DIFFICULTY.economy.boostApplyMax). This flag exists so the UI can say so out loud.
 */
export function hasSurplus(save: SaveData): boolean {
  const pending = save.pendingBoosts ?? []
  return pending.length > splitPendingBoosts(pending, save.heldBoosts ?? []).take.length
}

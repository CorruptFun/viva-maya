import { addChips, addFreeSpins, bumpJackpotMeter, loadSave, persistSave, spendChips } from './save'

/**
 * THE MARKER — an opt-in side bet with the House, on numbered levels from `MARKER_FROM` (Slice 0,
 * 2026-08-04).
 *
 * The stake is SPENT when you slide the marker across — the House keeps it win or lose, exactly
 * like the helper shelf spends chips on a BLAST. Winning the level pays a non-chip kicker: jackpot
 * pips, or a free spin at the top stake. That shape is load-bearing for iron rule #1 (chips are
 * earned-only and every faucet is a fixed-size gift): a stake-returned-plus-kicker wager becomes a
 * rate faucet for any player whose win rate is high — and mid-game win rates ARE high — because
 * pips mint chips downstream through the wheel. Stake spent + kicker provably worth LESS than the
 * stake = a strict sink at every possible win rate. `marker.rate.test.ts` proves the value bound
 * from the shipped prize tables; re-derive it there if the wheel or the slots ever retune.
 *
 * Mercy: opt-in only, one per level, never offered on an every-5th breather, backing out before
 * the first move refunds it — and the first busted marker each day is COMPED (returned), latched
 * by `markerCompDay` (freeSpinsDay's sibling; winner's-record on merge).
 */

export const MARKER_FROM = 151
export const MARKER_STAKES = [50, 100, 250] as const
export type MarkerStake = (typeof MARKER_STAKES)[number]

/** The kicker each stake pays on a WIN. The top stake's spin degrades to pips when the free-spin
 *  caps refuse it (the Plinko SPIN→×8 restrike philosophy — never a dead payout). */
export const MARKER_KICKERS: Record<MarkerStake, { pips: number; spin: boolean }> = {
  50: { pips: 1, spin: false },
  100: { pips: 2, spin: false },
  250: { pips: 0, spin: true },
}

/** Degraded kicker when the spin can't be banked (bank full or daily earn cap spent). */
export const MARKER_SPIN_FALLBACK_PIPS = 2

/** Whether the start-of-level offer shows at all. Endless never sees it (boost-free constitution);
 *  breathers stay pressure-free; and an offer the player cannot take is just a taunt. */
export function markerOfferable(level: number, endless: boolean, chips: number): boolean {
  if (endless || level < MARKER_FROM) return false
  if (level % 5 === 0) return false
  return chips >= MARKER_STAKES[0]
}

/** Slide the marker: the stake is spent on the spot (helper-shelf semantics — atomic
 *  load→check→deduct→persist inside spendChips). Returns the new balance, or null = can't afford. */
export function placeMarker(stake: MarkerStake): number | null {
  return spendChips(stake)
}

/** Backing out before the first move is free — the hand was never dealt. Returns the new balance. */
export function refundMarker(stake: MarkerStake): number {
  return addChips(stake)
}

/**
 * The level was WON: pay the kicker. Returns what was actually paid (spins may degrade to pips)
 * plus the meter after any pips, so the HUD can re-read arming in one place.
 */
export function settleMarkerWin(stake: MarkerStake, dayKey: string): { pips: number; spins: number; meter: number } {
  const kicker = MARKER_KICKERS[stake]
  let pips = kicker.pips
  let spins = 0
  if (kicker.spin) {
    spins = addFreeSpins(1, dayKey, 'mega')
    if (spins === 0) pips = MARKER_SPIN_FALLBACK_PIPS
  }
  let meter = loadSave().jackpotMeter
  for (let i = 0; i < pips; i++) meter = bumpJackpotMeter()
  return { pips, spins, meter }
}

/**
 * The level was LOST (or quit after playing a move): the House keeps the stake — unless today's
 * comp is unused, in which case the marker slides back ("the first one's on the house"). One
 * atomic load→latch→refund→persist so a crash can neither double-comp nor half-comp.
 */
export function settleMarkerLoss(stake: MarkerStake, dayKey: string): { comped: boolean; balance: number } {
  const save = loadSave()
  if (save.markerCompDay === dayKey) return { comped: false, balance: save.chips }
  save.markerCompDay = dayKey
  save.chips += stake
  persistSave(save)
  return { comped: true, balance: save.chips }
}

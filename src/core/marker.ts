import { DIFFICULTY } from './difficulty'
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
export const MARKER_STAKES = [50, 100, 250, 500] as const
export type MarkerStake = (typeof MARKER_STAKES)[number]

/**
 * THE HIGH-ROLLER'S MARKER — the fourth rung, band-scoped to AFTER DARK (Slice 3).
 *
 * Not a level type and not a new system: the same opt-in, the same sink proof, one more rung on a
 * ladder that already existed. That is the whole reason it belongs in the 200s — the band's brief is
 * recombinations of shipped things, and widening an existing choice is the cheapest possible way to
 * say "the stakes are higher after dark" without spending a verb Act II needs.
 */
export const HIGH_ROLLER_STAKE = 500

/** The kicker each stake pays on a WIN. The top stakes' spin degrades to pips when the free-spin
 *  caps refuse it (the Plinko SPIN→×8 restrike philosophy — never a dead payout). */
export const MARKER_KICKERS: Record<MarkerStake, { pips: number; spin: boolean }> = {
  50: { pips: 1, spin: false },
  100: { pips: 2, spin: false },
  250: { pips: 0, spin: true },
  // The high-roller rung pays the spin AND a fistful of pips — twice the stake wants visibly more
  // than the same prize. Still provably under the stake (`marker.rate.test.ts` re-derives it from
  // the shipped prize tables), which is the only property this ladder is allowed to have.
  500: { pips: 3, spin: true },
}

/**
 * Which rungs this level offers. The high-roller rung appears only from `afterDark.markerStart`, so
 * the ladder a player sees at 151 is byte-identical to the one that shipped in Slice 0.
 */
export function markerStakesFor(level: number): MarkerStake[] {
  const { afterDark } = DIFFICULTY
  const high = afterDark.enabled && afterDark.marker && level >= afterDark.markerStart
  return MARKER_STAKES.filter(s => high || s !== HIGH_ROLLER_STAKE)
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
    // ADDS to the rung's own pips rather than replacing them. Identical to the shipped behaviour at
    // 250 (whose base is 0), and the only correct answer at 500: a refused spin must not also
    // confiscate the three pips the rung pays regardless of it.
    if (spins === 0) pips += MARKER_SPIN_FALLBACK_PIPS
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

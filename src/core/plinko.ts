import type { Rng } from './rng'

/**
 * Plinko bonus drop — pure logic (no Phaser). A SUPER-MEGA-grade cascade can hand the board off to a
 * ball drop: the ball rattles down a peg triangle into one of PLINKO_SLOTS, paying either a
 * multiplier on the chain that earned it or a free-spin ticket.
 *
 * AWARD-FIRST, like the wheel and the daily spin: `rollSlotIndex` decides the winning slot and the
 * caller banks the prize BEFORE any animation, then `dropPath` synthesises a bounce sequence that is
 * GUARANTEED to arrive there — so quitting mid-drop can never lose the prize, and the physics is
 * theatre over an honest, already-settled result (mirrors core/jackpot.ts).
 *
 * On frequency — measured, not guessed. A headless sweep of the real board core (see
 * plinko.rate.test.ts) found the x4 "MEGA" bar is nowhere near as rare as it feels: ~1 chain/level
 * for a passive player and ~1.9 for one playing normally, so triggering at x4 would have shown a
 * drop in 60–84% of levels. x5 is the bar that keeps it a treat without making it a unicorn —
 * roughly 1 level in 8 played passively, 1 in 5 played well. Those two constants are the whole
 * tuning surface; change them and re-run the rate guard.
 */

/** Peg rows the ball falls through. Rows + 1 = slots, because each row is one left/right decision. */
export const PLINKO_ROWS = 8

/** Chain depth that can offer a drop — one past the x4 MEGA bar, short of x6 SUPER MEGA. */
export const PLINKO_MIN_CASCADE = 5

/** Chance a qualifying chain actually offers the drop. GameScene caps it at one per level on top. */
export const PLINKO_CHANCE = 0.5

/**
 * ENDLESS runs its own pair, because the numbered-level tuning above is calibrated against a board
 * endless never plays. A numbered level has hazards (felt sweeps and lockboxes deepen chains) and a
 * per-level move budget; endless has NEITHER — no hazards at all, a flat ENDLESS_MOVES of 30. Reusing
 * x5/0.5 there quietly halved the drop rate: measured at 5.4% of runs for a passive player and 11.1%
 * for a typical one, against the ~15%/~22% the same constants buy on the numbered curve.
 *
 * x4 + a certain roll restores it to ~27% of runs passive, ~59% typical — the once-per-run latch in
 * GameScene is what keeps that from becoming "every chain". The bar can drop to the MEGA line here
 * precisely because the thing that made x4 too generous on numbered levels (~1-1.9 qualifying chains
 * per level) does not hold without hazards: endless yields ~0.36 passive, ~0.92 typical.
 *
 * Endless also pays BETTER per drop — `allowTickets` is false there, so the two SPIN slots leave the
 * pool and every landing is a multiplier (~3.4x on the triggering chain). That is the whole point:
 * the weekly race is scored on one number, so the drop has to be reachable to matter.
 *
 * Guarded by the endless half of plinko.rate.test.ts. Re-run it if you touch these.
 */
export const PLINKO_ENDLESS_MIN_CASCADE = 4
export const PLINKO_ENDLESS_CHANCE = 1

/**
 * An UNREAL-grade chain ALWAYS offers the drop, in either mode — no roll. At x8 the chance gate is
 * pure salt: the chain is already rare enough (~1 run in 67 for a typical endless player, rarer for
 * a passive one) that losing a coin flip on top reads as the game welching on the best thing that
 * happens in it. Costs almost nothing in rate terms (~+0.7pp in endless) and buys the guarantee.
 *
 * Matches the UNREAL band in GameScene.megaTier — keep the two in step if that renames.
 */
export const PLINKO_GUARANTEED_CASCADE = 8

/**
 * A slot pays EITHER a multiplier on the triggering chain's points or a free-spin ticket.
 * `label` is the short face text painted on the slot.
 */
export type PlinkoPrize =
  | { kind: 'mult'; mult: number; label: string; weight: number }
  | { kind: 'ticket'; spins: number; label: string; weight: number }

/**
 * The 9 slots, left to right. Symmetric, with value rising OUTWARD and the weights shaped like the
 * binomial a real peg board would produce — the centre is where a fair ball usually lands, so it is
 * both the commonest (30%) and the cheapest (×2), and the ×10 edges are a ~2% thrill apiece. That
 * shape is what lets the rigged landing still read as honest: the ball ends up where a ball tends to
 * end up. Weights sum to 100, so each reads directly as a percentage.
 *
 * The two TICKET slots sit just inside the edges — a different currency (a free wheel pull) rather
 * than a bigger number, so they punctuate the ×2→×3→×5→×10 ramp without breaking it.
 */
export const PLINKO_SLOTS: PlinkoPrize[] = [
  { kind: 'mult', mult: 10, label: '×10', weight: 2 },
  { kind: 'ticket', spins: 1, label: 'SPIN', weight: 6 },
  { kind: 'mult', mult: 5, label: '×5', weight: 10 },
  { kind: 'mult', mult: 3, label: '×3', weight: 17 },
  { kind: 'mult', mult: 2, label: '×2', weight: 30 },
  { kind: 'mult', mult: 3, label: '×3', weight: 17 },
  { kind: 'mult', mult: 5, label: '×5', weight: 10 },
  { kind: 'ticket', spins: 1, label: 'SPIN', weight: 6 },
  { kind: 'mult', mult: 10, label: '×10', weight: 2 },
]

/** True once a settled chain is deep enough to roll for a drop. Endless uses the lower bar. */
export function plinkoQualifies(cascade: number, endless = false): boolean {
  return cascade >= (endless ? PLINKO_ENDLESS_MIN_CASCADE : PLINKO_MIN_CASCADE)
}

/**
 * Weighted slot pick — cumulative-weight selection (identical shape to core/jackpot.ts
 * `rollWheelIndex`). The caller rigs the drop to land on this index.
 *
 * `allowTickets` false zeroes the ticket slots — endless mode has no wheel to spend a spin on, and a
 * player already at the daily/bank cap cannot be paid one. Their weight simply leaves the pool, so
 * the remaining slots re-normalise and nobody is ever shown a prize that can't be honoured.
 */
export function rollSlotIndex(rng: Rng, allowTickets: boolean): number {
  const weightOf = (p: PlinkoPrize): number => (p.kind === 'ticket' && !allowTickets ? 0 : p.weight)
  const total = PLINKO_SLOTS.reduce((sum, p) => sum + weightOf(p), 0)
  let roll = rng() * total
  for (let i = 0; i < PLINKO_SLOTS.length; i++) {
    roll -= weightOf(PLINKO_SLOTS[i])
    if (roll < 0) return i
  }
  return PLINKO_SLOTS.length >> 1 // defensive (float drift): the centre slot always exists
}

/**
 * THE RIG. A ball that breaks right `r` times out of `rows` bounces ends in slot `r` — so landing in
 * `targetSlot` is exactly "break right `targetSlot` times, in any order". Build that multiset and
 * shuffle it (Fisher-Yates, on the caller's seeded stream) for a bounce sequence that looks random
 * and is provably correct. The view replays the returned ±1s one peg row at a time.
 */
export function dropPath(rng: Rng, targetSlot: number, rows: number = PLINKO_ROWS): (-1 | 1)[] {
  const rights = Math.max(0, Math.min(rows, Math.round(targetSlot)))
  const path: (-1 | 1)[] = Array.from({ length: rows }, (_, i) => (i < rights ? 1 : -1))
  for (let i = rows - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[path[i], path[j]] = [path[j], path[i]]
  }
  return path
}

/**
 * Roll whether a settled chain offers the drop. GameScene owns the once-per-level latch, so this
 * only answers "is THIS chain worth a drop" — never "has one already been spent".
 *
 * An UNREAL chain short-circuits without drawing from `rng`; that is deliberate, not an oversight.
 */
export function shouldOfferPlinko(cascade: number, rng: Rng, endless = false): boolean {
  if (cascade >= PLINKO_GUARANTEED_CASCADE) return true
  if (!plinkoQualifies(cascade, endless)) return false
  return rng() < (endless ? PLINKO_ENDLESS_CHANCE : PLINKO_CHANCE)
}

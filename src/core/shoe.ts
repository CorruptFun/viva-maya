import { randInt } from './rng'
import type { Rng } from './rng'
import { SYMBOLS } from './types'
import type { SymbolType } from './types'
import type { RefillSource } from './board'

/**
 * THE COUNTING SHOE — floor 3's rule, and Act II's first piece of OPEN INFORMATION.
 *
 * Card counting, made legal: on shoe levels every refill is dealt from a finite, visible shoe
 * instead of an unlimited uniform stream. Watching the bells run out while bells are your goal is
 * new dread; knowing the next stretch of refills holds no clovers is new power. The House shows you
 * exactly what it is holding — reading it is the skill.
 *
 * ── WHAT CHANGES, MECHANICALLY ──────────────────────────────────────────────────────────────
 * Only where refill symbols COME FROM. Matching, gravity, specials, hazards, scoring, the win
 * condition — all untouched. The shoe is `Board`'s optional `RefillSource`; absent, the board's
 * refill path is bit-for-bit what it always was, which is what keeps endless (never given one) and
 * every level outside the band exactly as shipped.
 *
 * ── WHAT IT COSTS — MEASURED, AND NOT WHAT THE DESIGN GUESSED ───────────────────────────────
 * The intuition was "attention, not win rate": a full shoe is the uniform distribution in
 * expectation. Measured (banker, 40 seeds, 2026-08-11), drawing WITHOUT replacement costs 7–13pp
 * on floor 3's plain levels (38/35/33 → 30/28/20 at 409/423/444) — a goal-chaser drains its own
 * symbols from the shoe, so refills run lean on exactly what it wants; and the thinner right tail
 * (anti-streak refills starve monster cascades) is why the plaque band posts a RELIEVED minimum
 * (`SHOE_PLAQUE_RELIEF` in levels.ts — the completer MEAN did not move, 86–89 pts/goal against
 * the no-shoe 89, but the plaque's Act II fraction priced the tail). Both are upper bounds: the
 * banker cannot count, and buying moves back by counting is the whole skill this floor sells.
 * That measured cost is also why the pair's hazard-cell ramp ships OFF (DIFFICULTY.act2.ramp) —
 * the shoe IS floors 3–4's climb.
 *
 * ── COMPOSITION: UNIFORM, DELIBERATELY — FOR NOW ────────────────────────────────────────────
 * Every shoe holds `SHOE_COPIES` of each live symbol. Uniform composition is the safe opening bid:
 * it is difficulty-neutral in expectation, so the feasibility gates certify the BAND rather than
 * re-certifying every level, and the count display stays honest without a per-level legend. The
 * lever this leaves deliberately unpulled is a per-level LEAN — a shoe seeded light on one goal
 * symbol, so "the shoe runs thin" becomes an authored beat on chosen levels. Pulling it means
 * per-level feasibility measurement (a lean against a goal is a real difficulty knob), its own RNG
 * stream keyed off the level (the 0xc0ffee lesson), and golden pins. Do not add it casually.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────────────────────
 * Contents per level: deterministic (uniform — trivially so). Draw order per attempt: random, on
 * the rng the caller hands in — Math.random-backed in the scene, seeded in the sim, exactly the
 * hazard plan's learnability contract (the table looks the same next try; the cards fall fresh).
 * The shoe draws from its OWN rng, never the board's: with a source attached the board's refill
 * stream is simply not consulted, and no code path both consults and skips it.
 *
 * ── THE RESHUFFLE ───────────────────────────────────────────────────────────────────────────
 * An empty shoe refills itself to full composition and keeps dealing — inside `draw`, so a refill
 * wave that outruns the last card can never stall the cascade pipeline waiting on ceremony. The
 * view is TOLD (`onReshuffle`) rather than asked, and plays its theatrical beat when the board
 * settles; the count display snapping back to full is already the honest signal. A shoe can
 * therefore never soft-lock a level: every symbol always comes back.
 */

/** Cards of each live symbol in a full shoe. 8 × 6 symbols = 48 cards ≈ ten moves of refills —
 *  short enough that the count moves visibly every move, long enough that reading it pays. */
export const SHOE_COPIES = 8

export class Shoe implements RefillSource {
  /** Cards left of each symbol in the CURRENT shoe, indexed as `symbols` is. */
  private remaining: number[]
  private left = 0
  /** Reshuffles dealt this attempt — the view's theatrical-beat counter. */
  private reshuffled = 0
  private onReshuffle: (() => void) | null = null

  constructor(
    readonly symbols: readonly SymbolType[],
    private rng: Rng,
    readonly copies: number = SHOE_COPIES
  ) {
    this.remaining = symbols.map(() => copies)
    this.left = symbols.length * copies
  }

  /** The view's hook for the reshuffle beat. One listener — the scene that owns the level. */
  setOnReshuffle(fn: (() => void) | null): void {
    this.onReshuffle = fn
  }

  /** Deal one card. Reshuffles first when the shoe is empty — a draw can never fail. */
  draw(): SymbolType {
    if (this.left <= 0) {
      this.remaining = this.symbols.map(() => this.copies)
      this.left = this.symbols.length * this.copies
      this.reshuffled++
      this.onReshuffle?.()
    }
    // Weighted by what is actually left — drawing the k-th remaining card, not the k-th symbol.
    let k = randInt(this.rng, this.left)
    for (let i = 0; i < this.remaining.length; i++) {
      k -= this.remaining[i]
      if (k < 0) {
        this.remaining[i]--
        this.left--
        return this.symbols[i]
      }
    }
    // Unreachable while `left` and `remaining` agree; the last symbol is the honest fallback.
    this.remaining[this.remaining.length - 1] = Math.max(0, this.remaining[this.remaining.length - 1] - 1)
    this.left = Math.max(0, this.left - 1)
    return this.symbols[this.symbols.length - 1]
  }

  /** Cards left of one symbol in the current shoe — what the count panel prints. */
  countOf(symbol: SymbolType): number {
    const i = this.symbols.indexOf(symbol)
    return i >= 0 ? this.remaining[i] : 0
  }

  /** Cards left in the current shoe — what the HUD chip prints. */
  cardsLeft(): number {
    return this.left
  }

  /** Full-shoe size, for the chip's `n/48` read. */
  capacity(): number {
    return this.symbols.length * this.copies
  }

  /** Reshuffles dealt so far this attempt. */
  reshuffles(): number {
    return this.reshuffled
  }

  /** The live counts as a plain array (symbol order), for the level-resume snapshot. */
  toCounts(): number[] {
    return [...this.remaining]
  }

  /**
   * Adopt counts read back out of a level-resume snapshot, or refuse and stay full. Same contract
   * as `Board.restoreSnapshot`: localStorage is user-editable and version-skewed, so a snapshot may
   * be garbage and must never crash a level open — a refused restore costs a reshuffle, nothing.
   */
  restoreCounts(counts: unknown): boolean {
    if (!Array.isArray(counts) || counts.length !== this.symbols.length) return false
    if (counts.some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > this.copies)) return false
    const left = (counts as number[]).reduce((s, v) => s + v, 0)
    // An all-empty snapshot would make the next draw reshuffle instantly — legal, but it means the
    // stored state was the moment BEFORE a reshuffle, and restoring to full says the same thing.
    this.remaining = [...(counts as number[])]
    this.left = left
    return true
  }
}

/** The shoe a fresh attempt at a shoe level deals from: uniform, over the level's live palette. */
export function buildShoe(symbolCount: number, rng: Rng): Shoe {
  return new Shoe(SYMBOLS.slice(0, symbolCount), rng)
}

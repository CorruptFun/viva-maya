export const SYMBOLS = ['cherry', 'seven', 'diamond', 'bell', 'clover', 'bar'] as const
export type SymbolType = (typeof SYMBOLS)[number]

/**
 * Phase 4 hook: special pieces created by match shapes.
 * wildReelRow/Col = match-4 line blast, diceBomb = L/T match 3x3 blast,
 * jackpotChip = match-5 color bomb.
 *
 * `blocker` is not a symbol at all — it is an obstacle occupying a cell (see core/hazards.ts). It
 * never matches, never swaps, never falls and never chains a blast; it is broken by clears landing
 * next to it. It lives in the grid as a Piece (rather than as a null cell plus a side table) so the
 * view's whole sprite lifecycle — create, id map, destroy via `ClearWave.cleared` — works unchanged
 * and the board.test.ts model/view fuzz invariant keeps holding for free.
 */
export type PieceKind = 'normal' | 'wildReelRow' | 'wildReelCol' | 'diceBomb' | 'jackpot' | 'blocker'

export interface Piece {
  readonly id: number
  symbol: SymbolType
  kind: PieceKind
  /**
   * Hazard: this piece still MATCHES normally but cannot be SWAPPED until a clear lands next to it.
   * Rides on the Piece rather than on the cell so it survives gravity and jackpot conversion with
   * no extra plumbing. Undefined everywhere hazards are off.
   */
  locked?: boolean
  /** Remaining hits for a `blocker`. Undefined on every other kind. */
  hp?: number
}

/** True when a piece takes part in symbol matching. Blockers are inert; jackpots match nothing. */
export const isMatchable = (p: Piece | null): p is Piece =>
  p !== null && p.kind !== 'jackpot' && p.kind !== 'blocker'

export interface Coord {
  row: number
  col: number
}

/** A straight run of >=3 identical symbols. Runs sharing a cell form L/T shapes (Phase 4). */
export interface RunMatch {
  symbol: SymbolType
  horizontal: boolean
  cells: Coord[]
}

export interface FallMove {
  piece: Piece
  from: Coord
  to: Coord
}

export interface Spawn {
  piece: Piece
  at: Coord
  /** How many cells above its target the piece starts, so refills drop in as a stack. */
  dropCells: number
}

export const key = (c: Coord): string => `${c.row},${c.col}`

/** Daily-spin prizes; applied as head-start boosts to the next level played. */
export type BoostType = 'wildReel' | 'diceBomb' | 'jackpot' | 'extraMoves' | 'doubleScore'

/** Promo/reward-code payload (core/promo.ts). 'chips' → amount chips · 'hearts' → full lives refill
 *  · 'boost' → `amount` copies of `boostType` queued for the next level. Mirrors 0005_promo_codes.sql. */
export type PromoKind = 'chips' | 'hearts' | 'boost'
export interface PromoReward {
  kind: PromoKind
  amount: number
  boostType?: BoostType
}

/** One "collect N of symbol X" goal inside a level. */
export interface LevelObjective {
  symbol: SymbolType
  count: number
}

export interface LevelSpec {
  level: number
  moves: number
  symbolCount: number
  objectives: LevelObjective[]
  /**
   * HOUSE MINIMUM (Slice 0): win additionally requires `score >= scoreTarget`. Present only on
   * minimum-cadence levels (core/levels.ts isMinimumLevel); absent everywhere else, so every
   * pre-existing spec is byte-identical. The plaque REPLACES the third collect objective — the
   * move budget is still derived from the full 3-objective demand (see levelSpec).
   */
  scoreTarget?: number
  /**
   * THE REEL PULL (Act II, Slice 1): this level's board carries the slot-arm rail — a column can be
   * pulled one notch downward, the bottom piece wrapping to the top, at the cost of one move.
   * Present only on Act II levels with the flag live (core/actII.ts); absent everywhere else, so
   * every Act I spec is byte-identical and endless — which never calls `levelSpec` — cannot see it.
   */
  pull?: boolean
  /**
   * HOT TABLE (AFTER DARK, Slice 3): every wave scores at `cascade + 1` instead of `cascade`, so the
   * whole table runs one notch hot — against a trimmed move budget. Present only on hot-table
   * levels (core/levels.ts isHotTable); absent everywhere else, and endless never calls `levelSpec`.
   */
  hot?: boolean
  /**
   * THE COUNTING SHOE (Act II, floor 3): this level's refills draw from a finite, visible shoe
   * (core/shoe.ts) instead of an unlimited uniform stream. Present only on shoe-band levels with
   * the flag live (core/actII.ts shoeLevel); absent everywhere else, so every other spec is
   * byte-identical — and endless, which never calls `levelSpec`, structurally cannot see it.
   */
  shoe?: boolean
  /**
   * The COLLECT DEMAND the move budget was derived from, when `objectives` no longer represents it.
   *
   * Set only on POINTS NIGHT, where `objectives` is empty and the level's whole demand is asked for
   * in points. Star grading reads a demand RATE (`starThresholds`), and an empty objective list
   * makes that rate zero — which clamps the 3★ bar to half the move budget, a bar the curve's own
   * notes call harder than perfect play. So a pure-minimum level carries the number its budget was
   * actually built from, and grades exactly like the 3-objective sibling it is the same size as.
   *
   * ⚠️ Deliberately NOT set on ordinary plaque levels, whose `objectives` sum to two thirds of their
   * demand for the same reason. That bar has been live since Slice 0 and every plaque level's stars
   * are recorded against it; correcting it would silently re-grade levels people have already
   * played. This field fixes an UNDEFINED case, it does not re-open a settled one.
   */
  demand?: number
}

/** Choreography instructions emitted by the core for the view to render. */
export type BlastEvent =
  | { type: 'reel'; at: Coord; horizontal: boolean }
  | { type: 'bomb'; at: Coord; radius: number }
  | { type: 'jackpot'; at: Coord; symbol: SymbolType | null }

/** One clear step: everything removed, specials created, and effects to play. */
export interface ClearWave {
  cleared: { piece: Piece; at: Coord }[]
  transformed: { at: Coord; from: Piece; to: Piece }[]
  events: BlastEvent[]
  /** What this wave did to the level's hazards. Absent when the board carries none. */
  hazards?: HazardEffects
}

/** What a wave did to the hazards, for the view to animate and the scene to score. */
export interface HazardEffects {
  coatsStripped: { at: Coord; remaining: number }[]
  blockersDamaged: { at: Coord; hp: number }[]
  blockersBroken: { piece: Piece; at: Coord }[]
  unlocked: Coord[]
}

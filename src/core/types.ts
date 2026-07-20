export const SYMBOLS = ['cherry', 'seven', 'diamond', 'bell', 'clover', 'bar'] as const
export type SymbolType = (typeof SYMBOLS)[number]

/**
 * Phase 4 hook: special pieces created by match shapes.
 * wildReelRow/Col = match-4 line blast, diceBomb = L/T match 3x3 blast,
 * jackpotChip = match-5 color bomb.
 */
export type PieceKind = 'normal' | 'wildReelRow' | 'wildReelCol' | 'diceBomb' | 'jackpot'

export interface Piece {
  readonly id: number
  symbol: SymbolType
  kind: PieceKind
}

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
}

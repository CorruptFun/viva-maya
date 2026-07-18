import type { SymbolType } from './core/types'

export const DESIGN_W = 720
export const DESIGN_H = 1280

export const ROWS = 8
export const COLS = 8
export const SYMBOL_COUNT = 6

export const CELL = 80
export const BOARD_W = COLS * CELL
export const BOARD_X = (DESIGN_W - BOARD_W) / 2
export const BOARD_Y = 300
export const PIECE_SIZE = CELL * 0.92

export const POINTS_PER_PIECE = 20
export const MOVES_BONUS = 60

// Lives / energy: a generous pool that only a LOSS (or mid-level quit) drains — wins are free.
// One life regenerates every 8 min (wall clock); an empty pool fully refills in ~80 min, and
// a single life comes back after a short break. Kept forgiving so a learning player rarely stalls.
export const LIVES_MAX = 10
export const LIFE_REGEN_MS = 8 * 60 * 1000

export const SWAP_MS = 130
export const INVALID_MS = 150
export const CLEAR_MS = 130
export const FALL_BASE_MS = 100
export const FALL_PER_CELL_MS = 50

export const SYMBOL_COLORS: Record<SymbolType, number> = {
  cherry: 0xd3302f,
  seven: 0xe0312e,
  diamond: 0x3d9df0,
  bell: 0xe8a91d,
  clover: 0x2fae4c,
  bar: 0x26304d,
}

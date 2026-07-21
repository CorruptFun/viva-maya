import type { SymbolType } from './core/types'

export const DESIGN_W = 720
export const DESIGN_H = 1280

// --- Flexible-height viewport (fill-the-screen) -------------------------------
// The board + HUD are laid out in a fixed 720×1280 "design box". On a tall portrait phone (~0.46
// aspect) FIT would letterbox that box with cream "void" bands top + bottom. Instead we grow the
// WORLD height to match the device aspect (width stays 720, so nothing horizontal moves and the board
// is untouched), which lets the FIT canvas fill the screen edge-to-edge with no letterbox. The
// 720×1280 design box is then centred in the taller world via a camera scroll (see restScrollY), and
// the atmospheric backdrop is extended to fill the reclaimed margins. `worldH` is DESIGN_H on short /
// landscape screens (letterbox as before) and up to WORLD_H_MAX on tall ones.
const WORLD_H_MAX = Math.round(DESIGN_H * 1.4) // 1792 — bounds extreme (foldable / ultra-tall) aspects

const viewportState = { worldH: DESIGN_H }

/** Current world height (≥ DESIGN_H). Read by the scale config, backdrop, camera centring + scrims. */
export function worldH(): number {
  return viewportState.worldH
}

/** Vertical padding added above (and below) the DESIGN_H box to centre it in the taller world. */
export function contentOffsetY(): number {
  return Math.round((viewportState.worldH - DESIGN_H) / 2)
}

/** The camera scrollY that vertically centres the 720×1280 design box in the world (0 when no growth). */
export function restScrollY(): number {
  return -contentOffsetY()
}

/**
 * Recompute `worldH` from a device viewport aspect (CSS px). Grows the world to the device aspect so
 * a width-locked FIT fills vertically with no letterbox, clamped to [DESIGN_H, WORLD_H_MAX]. Returns
 * true if the value changed (so the caller can resize the game + re-centre live scenes).
 */
export function updateWorldH(cssW: number, cssH: number): boolean {
  const target = cssW > 0 && cssH > 0 ? Math.round(DESIGN_W * (cssH / cssW)) : DESIGN_H
  const next = Math.max(DESIGN_H, Math.min(WORLD_H_MAX, target))
  if (next === viewportState.worldH) return false
  viewportState.worldH = next
  return true
}

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

// Lives / energy: a pool that only a LOSS (or mid-level quit) drains — wins are always free.
// Tuned 2026-07-21 (was 10 hearts / 8 min — effectively infinite; the owner never hit zero):
// 5 hearts, one regenerating every 20 min (empty → full in ~100 min). Still gentler than the
// genre-standard 5/30. Beginners are protected by LIVES_GRACE_LEVELS instead of pool size, so
// scarcity only exists once a player is invested — and heart-refill rewards actually mean something.
export const LIVES_MAX = 5
export const LIFE_REGEN_MS = 20 * 60 * 1000
// Losses on levels BELOW this never cost a heart (the learning ramp) — see lives.spendLifeFor.
export const LIVES_GRACE_LEVELS = 10

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

// Progressive jackpot "GROWING POT" settings
export const POT_SEED = 100
export const POT_PER_CLEAR = 2
export const POT_WIN_PCT = 0.3
export const POT_TARGET_MIN = 500
export const POT_TARGET_MAX = 900


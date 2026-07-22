import type { SymbolType } from './core/types'

export const DESIGN_W = 720
export const DESIGN_H = 1280

// --- Flexible-height viewport (fill-the-screen) -------------------------------
// The board + HUD are laid out in a fixed 720×1280 "design box". On a tall portrait phone (~0.46
// aspect) FIT would letterbox that box with cream "void" bands top + bottom. Instead we grow the
// WORLD height to match the device aspect (width stays 720, so nothing horizontal moves and the board
// is untouched), which lets the FIT canvas fill the screen edge-to-edge with no letterbox. The
// 720×1280 design box is then positioned in the taller world via a camera scroll (see restScrollY,
// contentOffsetY) and the atmospheric backdrop is extended to fill the reclaimed margins. `worldH` is
// DESIGN_H on short / landscape screens (letterbox as before) and up to WORLD_H_MAX on tall ones.
//
// Vertical anchoring (contentOffsetY): a tall phone's reclaimed height is NOT split evenly top/bottom.
// Centring the box left a wasted band under the notch / Dynamic Island while the HUD felt crammed. So
// on a tall NOTCHED phone we anchor the box a small, consistent gap below the top safe-area inset (fed
// in from CSS env() via main.ts → setSafeTopInset) and let the reclaimed space pool toward the bottom
// (which already read well). We only ever pull the box UP from centre — never down — so the board +
// bottom can only gain room. No inset (no-notch) or non-tall (tablet / landscape / short) → exactly
// today's centred / letterboxed look.
const WORLD_H_MAX = Math.round(DESIGN_H * 1.4) // 1792 — bounds extreme (foldable / ultra-tall) aspects

// Comfortable gap (design px) held between the top safe-area inset and the design box's top edge on tall
// notched phones. Small on purpose — enough to breathe under the notch, small enough to close the band.
const TOP_ANCHOR_GAP = 18

const viewportState = { worldH: DESIGN_H }

// Top safe-area inset (env(safe-area-inset-top)) in WORLD units — 0 until measured / on a no-notch device.
let safeTopWorld = 0

/** Current world height (≥ DESIGN_H). Read by the scale config, backdrop, camera centring + scrims. */
export function worldH(): number {
  return viewportState.worldH
}

/**
 * Vertical offset of the 720×1280 design box's top edge from the world's top (i.e. the top margin).
 * 0 when the world hasn't grown (non-tall: centred / letterboxed exactly as before). On a grown world we
 * anchor the box a consistent gap below the top safe-area inset when one is known, else keep it centred;
 * clamped so the box is only ever pulled UP toward the top (never pushed below centre → never regresses).
 */
export function contentOffsetY(): number {
  const centred = Math.round((viewportState.worldH - DESIGN_H) / 2)
  if (centred <= 0) return 0 // non-tall — no reclaimed height to redistribute
  if (safeTopWorld <= 0) return centred // no usable inset → keep today's centred look
  return Math.min(safeTopWorld + TOP_ANCHOR_GAP, centred)
}

/** The camera scrollY that positions the 720×1280 design box in the world (0 when no growth). */
export function restScrollY(): number {
  return -contentOffsetY()
}

/**
 * World-Y of the visible viewport's vertical centre. Full-bleed scrims / washes / backdrop layers that
 * must cover the WHOLE screen key off this instead of a hard-coded DESIGN_H/2 (640), so they still cover
 * once the box is anchored upward. Equals 640 whenever the box is centred (every non-tall / no-notch
 * screen), so swapping a literal 640 for this is a no-op there.
 */
export function viewportCenterY(): number {
  return restScrollY() + viewportState.worldH / 2
}

/**
 * Record the top safe-area inset (env(safe-area-inset-top), CSS px) so contentOffsetY can anchor content
 * a fixed distance below the notch / Dynamic Island. Converted to world units via the width-locked FIT
 * scale (DESIGN_W design px span appWidthPx CSS px). Called from main.ts at boot + on resize. Returns
 * true if the world-space inset changed (so the caller can re-centre live scenes).
 */
export function setSafeTopInset(insetPx: number, appWidthPx: number): boolean {
  const next = insetPx > 0 && appWidthPx > 0 ? Math.round((insetPx * DESIGN_W) / appWidthPx) : 0
  if (next === safeTopWorld) return false
  safeTopWorld = next
  return true
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

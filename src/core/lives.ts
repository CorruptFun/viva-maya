import { LIFE_REGEN_MS, LIVES_MAX } from '../config'
import { loadSave, persistSave } from './save'
import type { SaveData } from './save'

/**
 * Lives / energy — pure logic (no Phaser). A small pool that only a LOSS (or a
 * mid-level quit) drains; wins are free. One life regenerates every LIFE_REGEN_MS
 * of wall-clock time (device clock trusted — offline toy, same as the daily spin),
 * so progress survives closing the app.
 *
 * Storage: save.lives (current count) + save.livesAnchor (epoch ms when the CURRENT
 * regen cycle started; the next life lands at anchor + LIFE_REGEN_MS). Anchor is
 * irrelevant while the pool is full.
 */
export interface LivesState {
  lives: number
  max: number
  full: boolean
  /** ms until the next life regenerates (0 when full). */
  nextInMs: number
  /** ms until the pool is completely full (0 when already full). */
  fullInMs: number
}

/** Bank any wall-clock regen into save.lives/livesAnchor. Mutates; returns whether anything changed. */
function applyRegen(save: SaveData, now: number): boolean {
  if (save.lives >= LIVES_MAX) {
    if (save.livesAnchor === 0) return false
    save.livesAnchor = 0
    return true
  }
  // No anchor yet, or a clock that jumped backwards → (re)start the cycle from now.
  if (save.livesAnchor <= 0 || now < save.livesAnchor) {
    save.livesAnchor = now
    return true
  }
  const gained = Math.floor((now - save.livesAnchor) / LIFE_REGEN_MS)
  if (gained <= 0) return false
  save.lives = Math.min(LIVES_MAX, save.lives + gained)
  save.livesAnchor = save.lives >= LIVES_MAX ? 0 : save.livesAnchor + gained * LIFE_REGEN_MS
  return true
}

/** Read-only lives state for a save that has already had regen applied. */
function stateOf(save: SaveData, now: number): LivesState {
  const lives = save.lives
  const full = lives >= LIVES_MAX
  const nextInMs = full ? 0 : Math.max(0, save.livesAnchor + LIFE_REGEN_MS - now)
  const fullInMs = full ? 0 : nextInMs + (LIVES_MAX - lives - 1) * LIFE_REGEN_MS
  return { lives, max: LIVES_MAX, full, nextInMs, fullInMs }
}

/** Current lives with regen banked. Persists only when regen actually changed something
 * (so per-second HUD ticks don't hammer localStorage). */
export function refreshLives(now = Date.now()): LivesState {
  const save = loadSave()
  if (applyRegen(save, now)) persistSave(save)
  return stateOf(save, now)
}

export function hasLife(now = Date.now()): boolean {
  return refreshLives(now).lives > 0
}

/** Spend one life (a loss or a mid-level quit). Starts the regen clock if the pool was full. */
export function spendLife(now = Date.now()): LivesState {
  const save = loadSave()
  applyRegen(save, now)
  const wasFull = save.lives >= LIVES_MAX
  save.lives = Math.max(0, save.lives - 1)
  if (wasFull) save.livesAnchor = now // pool just dropped below max → begin regen
  persistSave(save)
  return stateOf(save, now)
}

/** Grant one life (capped at max) — e.g. an earned bonus. Clears the clock once full. */
export function grantLife(now = Date.now()): LivesState {
  const save = loadSave()
  applyRegen(save, now)
  save.lives = Math.min(LIVES_MAX, save.lives + 1)
  if (save.lives >= LIVES_MAX) save.livesAnchor = 0
  persistSave(save)
  return stateOf(save, now)
}

/** DEV only (?lives=N): force the pool to N, anchoring the regen clock at `now`. */
export function devSetLives(n: number, now = Date.now()): void {
  const save = loadSave()
  save.lives = Math.max(0, Math.min(LIVES_MAX, Math.floor(n)))
  save.livesAnchor = save.lives >= LIVES_MAX ? 0 : now
  persistSave(save)
}

/** "1:04" / "12:30" style mm:ss for a countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

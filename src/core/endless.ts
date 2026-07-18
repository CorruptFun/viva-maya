import { mulberry32 } from './rng'
import type { Rng } from './rng'
import { loadSave, persistSave } from './save'
import type { SaveData } from './save'

/**
 * Endless "weekly race" — pure logic (no Phaser). Unlocks after the last numbered
 * level. Everyone in the same calendar week plays the SAME board (seeded off the
 * week key), a fixed move budget, no objectives: just rack up the biggest score.
 * Each week the board — and the leaderboard-of-one BEST — resets.
 *
 * Boosts are deliberately NOT applied in endless: planting specials would change
 * the board and break the "same board for everyone" fairness of the race.
 */

/** Fixed move budget for the weekly score-attack board — equal for all, so BEST scores compare fairly. */
export const ENDLESS_MOVES = 30

/**
 * ISO-8601 week key "YYYY-Www" in LOCAL time (Thursday-anchored, weeks start
 * Monday). Same week → same key → same board; the race resets when it rolls over.
 */
export function weekKey(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dow = (d.getDay() + 6) % 7 // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow + 3) // hop to this week's Thursday
  const year = d.getFullYear()
  const firstThu = new Date(year, 0, 4)
  const firstDow = (firstThu.getDay() + 6) % 7
  firstThu.setDate(firstThu.getDate() - firstDow + 3)
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000))
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Deterministic 32-bit seed for a week key — same key → same seed → same board for everyone. */
export function seedForWeek(kkey: string): number {
  let h = 0x811c9dc5 >>> 0 // FNV-1a
  for (let i = 0; i < kkey.length; i++) {
    h = Math.imul(h ^ kkey.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/** RNG for a specific week's board — identical for everyone playing that week. */
export function endlessRngForWeek(wk: string): Rng {
  return mulberry32(seedForWeek(wk))
}

/** Best for a specific week key; 0 if that week hasn't been played (or a different week is stored). */
export function endlessBestForWeek(save: SaveData, wk: string): number {
  return save.endlessWeek === wk ? save.endlessBest : 0
}

/** This week's best — for display surfaces (Home/LevelSelect) where read-time week is correct. */
export function endlessBestThisWeek(save: SaveData, now = new Date()): number {
  return endlessBestForWeek(save, weekKey(now))
}

/** Endless unlocks once the player has cleared the last numbered level (unlocked past it). */
export function endlessUnlocked(save: SaveData, levelCount: number): boolean {
  return save.unlocked > levelCount
}

/**
 * Record an endless run against the week key the board was SEEDED with (captured at
 * board creation, NOT re-read here — a run that crosses the local week boundary must
 * still be attributed to the board it was actually played on). Rolls best over to 0
 * on a genuine week change, then keeps the max. Returns the (new) best and whether it beat it.
 */
export function recordEndless(score: number, wk: string): { best: number; isRecord: boolean } {
  const save = loadSave()
  if (save.endlessWeek !== wk) {
    save.endlessWeek = wk
    save.endlessBest = 0
  }
  const isRecord = score > save.endlessBest
  if (isRecord) save.endlessBest = score
  // Endless score can still be a personal all-time BEST across the whole game.
  if (score > save.best) save.best = score
  persistSave(save)
  return { best: save.endlessBest, isRecord }
}

import type { BoostType } from './types'

export interface SaveData {
  v: 4
  best: number
  /** Highest level the player may attempt (1-based). */
  unlocked: number
  /** Earned stars per completed level (1–3). */
  stars: Record<number, number>
  /** YYYY-MM-DD (local) of the last daily spin, or null if never spun. */
  lastSpinDate: string | null
  /** Consecutive-day spin streak (1 = first day). */
  streak: number
  /** Prizes waiting to be applied to the next level started. */
  pendingBoosts: BoostType[]
  /** Week key ("YYYY-Www") the endless best belongs to; null if never played. */
  endlessWeek: string | null
  /** Best endless score for endlessWeek's board; resets when the week rolls over. */
  endlessBest: number
}

const KEY = 'viva-maya:v1'

const DEFAULTS: SaveData = {
  v: 4,
  best: 0,
  unlocked: 1,
  stars: {},
  lastSpinDate: null,
  streak: 0,
  pendingBoosts: [],
  endlessWeek: null,
  endlessBest: 0,
}

function fresh(): SaveData {
  return { ...DEFAULTS, stars: {}, pendingBoosts: [] }
}

/** localStorage can throw (private mode, storage full) — never let that kill the game. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh()
    const data = JSON.parse(raw) as Partial<SaveData> & { best?: number }
    const base = fresh()
    // v1 was {best}; v2 added unlocked/stars; v3 added daily-spin fields; v4 added endless race.
    base.best = typeof data.best === 'number' ? data.best : 0
    base.unlocked = typeof data.unlocked === 'number' ? Math.max(1, data.unlocked) : 1
    base.stars = data.stars && typeof data.stars === 'object' ? data.stars : {}
    base.lastSpinDate = typeof data.lastSpinDate === 'string' ? data.lastSpinDate : null
    base.streak = typeof data.streak === 'number' ? data.streak : 0
    base.pendingBoosts = Array.isArray(data.pendingBoosts) ? data.pendingBoosts : []
    base.endlessWeek = typeof data.endlessWeek === 'string' ? data.endlessWeek : null
    base.endlessBest = typeof data.endlessBest === 'number' ? data.endlessBest : 0
    return base
  } catch {
    return fresh()
  }
}

export function persistSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // best-effort only
  }
}

/** Record a finished level; returns the updated save. */
export function recordResult(level: number, stars: number, score: number): SaveData {
  const save = loadSave()
  save.best = Math.max(save.best, score)
  save.unlocked = Math.max(save.unlocked, level + 1)
  save.stars[level] = Math.max(save.stars[level] ?? 0, stars)
  persistSave(save)
  return save
}

export function recordScore(score: number): SaveData {
  const save = loadSave()
  if (score > save.best) {
    save.best = score
    persistSave(save)
  }
  return save
}

/** Consume all pending boosts (they apply to the level being started, win or lose). */
export function takePendingBoosts(): BoostType[] {
  const save = loadSave()
  const boosts = save.pendingBoosts
  if (boosts.length > 0) {
    save.pendingBoosts = []
    persistSave(save)
  }
  return boosts
}

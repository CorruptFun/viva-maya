export interface SaveData {
  v: 2
  best: number
  /** Highest level the player may attempt (1-based). */
  unlocked: number
  /** Earned stars per completed level (1–3). */
  stars: Record<number, number>
}

const KEY = 'viva-maya:v1'

const DEFAULTS: SaveData = { v: 2, best: 0, unlocked: 1, stars: {} }

/** localStorage can throw (private mode, storage full) — never let that kill the game. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS, stars: {} }
    const data = JSON.parse(raw) as Partial<SaveData> & { best?: number }
    if (data.v === 2) {
      return {
        v: 2,
        best: typeof data.best === 'number' ? data.best : 0,
        unlocked: typeof data.unlocked === 'number' ? Math.max(1, data.unlocked) : 1,
        stars: data.stars && typeof data.stars === 'object' ? data.stars : {},
      }
    }
    // v1 payload was `{ best }` — migrate.
    return { ...DEFAULTS, stars: {}, best: typeof data.best === 'number' ? data.best : 0 }
  } catch {
    return { ...DEFAULTS, stars: {} }
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

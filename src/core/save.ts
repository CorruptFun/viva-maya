import { LIVES_MAX } from '../config'
import type { BoostType } from './types'

export interface SaveData {
  v: 8
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
  /** Current lives in the energy pool. */
  lives: number
  /** Epoch ms the current life-regen cycle started (0 when the pool is full). */
  livesAnchor: number
  /** Earned chip balance — a closed-loop reward token banked from level wins and spent in the Gift Store. */
  chips: number
  // --- v7 personal-warmth fields (§E9). All default EMPTY/OFF; read shape-tolerantly below. ---
  /** YYYY-MM-DD (local) of the very first app open; null until the first Home entry stamps it. */
  firstPlayDate: string | null
  /** YYYY-MM-DD (local) of the most recent app open. */
  lastOpenDate: string | null
  /** Full 'YYYY-MM-DD' keys of special-date dress-ups already fired (once-a-day gate; recurs yearly). */
  occasionsSeen: string[]
  /** Latch for the one-time ALL CLEAR (level 100) grand finale. */
  finaleSeen: boolean
  /** Latch for a future first-run onboarding intro. */
  seenIntro: boolean
  // --- v8 Jackpot Wheel field. Defaults to 0; read shape-tolerantly below. ---
  /** Jackpot meter charge — notches filled by level wins; at JACKPOT_GOAL the wheel fires, then resets. */
  jackpotMeter: number
}

const KEY = 'viva-maya:v1'

const DEFAULTS: SaveData = {
  v: 8,
  best: 0,
  unlocked: 1,
  stars: {},
  lastSpinDate: null,
  streak: 0,
  pendingBoosts: [],
  endlessWeek: null,
  endlessBest: 0,
  lives: LIVES_MAX,
  livesAnchor: 0,
  chips: 0,
  firstPlayDate: null,
  lastOpenDate: null,
  occasionsSeen: [],
  finaleSeen: false,
  seenIntro: false,
  jackpotMeter: 0,
}

function fresh(): SaveData {
  // Re-init every mutable reference type so a fresh save never aliases DEFAULTS' arrays/objects.
  return { ...DEFAULTS, stars: {}, pendingBoosts: [], occasionsSeen: [] }
}

/** localStorage can throw (private mode, storage full) — never let that kill the game. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh()
    const data = JSON.parse(raw) as Partial<SaveData> & { best?: number }
    const base = fresh()
    // v1 {best}; v2 +unlocked/stars; v3 +daily-spin; v4 +endless race; v5 +lives/energy.
    base.best = typeof data.best === 'number' ? data.best : 0
    base.unlocked = typeof data.unlocked === 'number' ? Math.max(1, data.unlocked) : 1
    base.stars = data.stars && typeof data.stars === 'object' ? data.stars : {}
    base.lastSpinDate = typeof data.lastSpinDate === 'string' ? data.lastSpinDate : null
    base.streak = typeof data.streak === 'number' ? data.streak : 0
    base.pendingBoosts = Array.isArray(data.pendingBoosts) ? data.pendingBoosts : []
    base.endlessWeek = typeof data.endlessWeek === 'string' ? data.endlessWeek : null
    base.endlessBest = typeof data.endlessBest === 'number' ? data.endlessBest : 0
    // Pre-v5 saves had no lives → start them full rather than locked out.
    base.lives =
      typeof data.lives === 'number' ? Math.max(0, Math.min(LIVES_MAX, Math.floor(data.lives))) : LIVES_MAX
    base.livesAnchor = typeof data.livesAnchor === 'number' ? data.livesAnchor : 0
    // Earned chip balance (Phase 1 reward token). Absent in pre-chip saves → 0.
    base.chips = typeof data.chips === 'number' ? Math.max(0, Math.floor(data.chips)) : 0
    // v7 personal-warmth fields (§E9) — absent in pre-v7 saves → the empty/off defaults. Read
    // shape-tolerantly like everything above so a malformed blob can never throw or leak a bad shape.
    base.firstPlayDate = typeof data.firstPlayDate === 'string' ? data.firstPlayDate : null
    base.lastOpenDate = typeof data.lastOpenDate === 'string' ? data.lastOpenDate : null
    base.occasionsSeen = Array.isArray(data.occasionsSeen)
      ? data.occasionsSeen.filter((x): x is string => typeof x === 'string')
      : []
    base.finaleSeen = data.finaleSeen === true
    base.seenIntro = data.seenIntro === true
    // v8 Jackpot Wheel meter — absent in pre-v8 saves → 0.
    base.jackpotMeter = typeof data.jackpotMeter === 'number' ? Math.max(0, Math.floor(data.jackpotMeter)) : 0
    // v6 grace refill: the pool grew (3→10) and the break got much shorter — top EVERYONE up to
    // full on upgrade so nobody is left stranded at the old, stingier count (e.g. mid-session).
    const storedVersion = typeof data.v === 'number' ? (data.v as number) : 1
    if (storedVersion < 6) {
      base.lives = LIVES_MAX
      base.livesAnchor = 0
    }
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

/** Bank earned chips (a win payout). Clamps to a non-negative integer; returns the new total. */
export function addChips(n: number): number {
  const save = loadSave()
  save.chips += Math.max(0, Math.floor(n))
  persistSave(save)
  return save.chips
}

/** Charge the jackpot meter by one notch (a level win); persists and returns the new meter value. */
export function bumpJackpotMeter(): number {
  const save = loadSave()
  save.jackpotMeter += 1
  persistSave(save)
  return save.jackpotMeter
}

/** Empty the jackpot meter after the wheel has fired, so it recharges from zero. */
export function resetJackpotMeter(): void {
  const save = loadSave()
  if (save.jackpotMeter !== 0) {
    save.jackpotMeter = 0
    persistSave(save)
  }
}

/**
 * Stamp the app-open dates (§E9). Sets `firstPlayDate` once (the very first open) and refreshes
 * `lastOpenDate` every call. `dateKey` is 'YYYY-MM-DD' (local). Never touches any other field.
 */
export function touchOpen(dateKey: string): SaveData {
  const save = loadSave()
  if (!save.firstPlayDate) save.firstPlayDate = dateKey
  save.lastOpenDate = dateKey
  persistSave(save)
  return save
}

/** Mark a special-date dress-up as fired for the day (`key` = 'YYYY-MM-DD'), so it fires once/day. */
export function markOccasionSeen(key: string): void {
  const save = loadSave()
  if (!save.occasionsSeen.includes(key)) {
    save.occasionsSeen.push(key)
    persistSave(save)
  }
}

/** Latch the one-time ALL CLEAR (level 100) grand finale so it only ever plays once. */
export function markFinaleSeen(): void {
  const save = loadSave()
  if (!save.finaleSeen) {
    save.finaleSeen = true
    persistSave(save)
  }
}

/** Grant a boost (e.g. a Jackpot Wheel prize) — banked to apply on the next level started. */
export function addPendingBoost(type: BoostType): void {
  const save = loadSave()
  save.pendingBoosts.push(type)
  persistSave(save)
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

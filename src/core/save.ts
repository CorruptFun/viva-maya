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
  /** Week keys ("YYYY-Www") whose weekly-race CHAMPION purse has been claimed (once-per-week gate;
   *  rides the cloud-synced save so a second device can never double-award). Absent in older saves → []. */
  championWeeks: string[]
  // --- Referral / free-spin fields. All default EMPTY/OFF; read shape-tolerantly below. ---
  /** The invite code this player arrived through — a UI mirror of the 'viva-maya:ref' stash
   *  (core/referrals.ts owns registration; the stash stays authoritative). Null when organic. */
  referredByCode: string | null
  /** Latch for the one-time referee welcome grant (core/referrals.ts claimWelcome). */
  referralWelcomeClaimed: boolean
  /** Banked bonus spins for the prize wheel — earned by big cascades, spendable any day. */
  freeSpins: number
  /** YYYY-MM-DD (local) the daily free-spin earn counter belongs to; null until the first earn. */
  freeSpinsDay: string | null
  /** Free spins earned on freeSpinsDay — enforces the per-day earn cap. */
  freeSpinsEarnedToday: number
}

/** Most free spins the bank ever holds — earning past this is quietly forfeited. */
export const FREE_SPIN_BANK_CAP = 12
/** Most free spins earnable per local calendar day (keeps a marathon session from minting a hoard). */
export const FREE_SPIN_DAILY_CAP = 6

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
  championWeeks: [],
  referredByCode: null,
  referralWelcomeClaimed: false,
  freeSpins: 0,
  freeSpinsDay: null,
  freeSpinsEarnedToday: 0,
}

function fresh(): SaveData {
  // Re-init every mutable reference type so a fresh save never aliases DEFAULTS' arrays/objects.
  return { ...DEFAULTS, stars: {}, pendingBoosts: [], occasionsSeen: [], championWeeks: [] }
}

/**
 * Shape-tolerant coercion of a raw parsed blob into a valid SaveData — never throws, always returns a
 * complete save. Shared by loadSave (localStorage), importSave (backup code), and cloud pull, so every
 * ingress path normalises identically and a malformed/foreign blob can never leak a bad shape.
 */
export function coerceSave(raw: unknown): SaveData {
  const base = fresh()
  if (!raw || typeof raw !== 'object') return base
  const data = raw as Partial<SaveData> & { best?: number }
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
    // Weekly-race champion claims — absent in older saves → none claimed.
    base.championWeeks = Array.isArray(data.championWeeks)
      ? data.championWeeks.filter((x): x is string => typeof x === 'string')
      : []
    // Referral / free-spin fields — absent in older saves → the empty/off defaults.
    base.referredByCode = typeof data.referredByCode === 'string' ? data.referredByCode : null
    base.referralWelcomeClaimed = data.referralWelcomeClaimed === true
    base.freeSpins =
      typeof data.freeSpins === 'number'
        ? Math.max(0, Math.min(FREE_SPIN_BANK_CAP, Math.floor(data.freeSpins)))
        : 0
    base.freeSpinsDay = typeof data.freeSpinsDay === 'string' ? data.freeSpinsDay : null
    base.freeSpinsEarnedToday =
      typeof data.freeSpinsEarnedToday === 'number'
        ? Math.max(0, Math.min(FREE_SPIN_DAILY_CAP, Math.floor(data.freeSpinsEarnedToday)))
        : 0
    // v6 grace refill: the pool grew (3→10) and the break got much shorter — top EVERYONE up to
    // full on upgrade so nobody is left stranded at the old, stingier count (e.g. mid-session).
    const storedVersion = typeof data.v === 'number' ? (data.v as number) : 1
    if (storedVersion < 6) {
      base.lives = LIVES_MAX
      base.livesAnchor = 0
    }
    return base
}

/** localStorage can throw (private mode, storage full) — never let that kill the game. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? coerceSave(JSON.parse(raw)) : fresh()
  } catch {
    return fresh()
  }
}

/**
 * Optional side-channel invoked after every persist (e.g. cloud sync). Kept as a registered hook so
 * this module stays backend-agnostic + dependency-free — the cloud layer registers itself at boot.
 */
let persistListener: ((data: SaveData) => void) | null = null
export function setPersistListener(fn: ((data: SaveData) => void) | null): void {
  persistListener = fn
}

export function persistSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // best-effort only
  }
  // A cloud hiccup must NEVER break the authoritative local save.
  try {
    persistListener?.(data)
  } catch {
    // best-effort only
  }
}

/**
 * A portable backup code — base64(JSON) of the current save. `escape/unescape` bridge btoa's Latin-1
 * limit so any UTF-8 in the blob survives the round-trip. Paste into importSave to restore.
 */
export function exportSave(): string {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(loadSave()))))
  } catch {
    return ''
  }
}

/** Restore from an exportSave code: decode → coerce → persist (overwrites local). Returns success. */
export function importSave(code: string): boolean {
  try {
    const json = decodeURIComponent(escape(atob(code.trim())))
    persistSave(coerceSave(JSON.parse(json)))
    return true
  } catch {
    return false
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

/**
 * Claim the weekly-race CHAMPION purse for a week — atomic load→check→award→persist. Returns the new
 * chip balance, or null when that week was already claimed (this device or any synced one), leaving
 * the save untouched. The claimed-week latch rides the save, so cloud sync makes the gate global.
 */
export function claimChampionship(week: string, purse: number): number | null {
  const save = loadSave()
  if (save.championWeeks.includes(week)) return null
  save.championWeeks.push(week)
  // Only the most recently CLOSED week is ever checked, so the latch list needn't grow for
  // years — keep a generous tail (12 weeks) and let older entries age out of the save.
  if (save.championWeeks.length > 12) save.championWeeks = save.championWeeks.slice(-12)
  save.chips += Math.max(0, Math.floor(purse))
  persistSave(save)
  return save.chips
}

/**
 * Spend chips on an in-level helper (the mid-level power bar). Atomic load→check→deduct→persist
 * (mirrors store.ts buyBoost) so a spend can never tear apart from the balance. Returns the NEW
 * balance on success, or null when the player can't afford it — leaving the save untouched.
 * Unlike buyBoost this does NOT queue a pendingBoost; the caller applies the effect to the live level.
 */
export function spendChips(price: number): number | null {
  const cost = Math.max(0, Math.floor(price))
  const save = loadSave()
  if (save.chips < cost) return null
  save.chips -= cost
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

/**
 * Bank earned free spins under BOTH caps — at most FREE_SPIN_DAILY_CAP earned per local day and at
 * most FREE_SPIN_BANK_CAP held at once. `dayKey` is 'YYYY-MM-DD' (daily.todayKey()); a new day resets
 * the earn counter. Atomic load→cap→persist; returns how many spins were ACTUALLY granted (0..n) so
 * the caller can size the celebration honestly.
 */
export function addFreeSpins(n: number, dayKey: string): number {
  const want = Math.max(0, Math.floor(n))
  if (want === 0) return 0
  const save = loadSave()
  if (save.freeSpinsDay !== dayKey) {
    save.freeSpinsDay = dayKey
    save.freeSpinsEarnedToday = 0
  }
  const granted = Math.min(
    want,
    FREE_SPIN_DAILY_CAP - save.freeSpinsEarnedToday,
    FREE_SPIN_BANK_CAP - save.freeSpins
  )
  if (granted <= 0) return 0
  save.freeSpins += granted
  save.freeSpinsEarnedToday += granted
  persistSave(save)
  return granted
}

/**
 * Spend one banked free spin — atomic load→check→dec→persist. Returns the REMAINING bank on success,
 * or null when the bank was empty (save untouched), so a caller can never double-spend.
 */
export function spendFreeSpin(): number | null {
  const save = loadSave()
  if (save.freeSpins <= 0) return null
  save.freeSpins -= 1
  persistSave(save)
  return save.freeSpins
}

/**
 * Grant the referrer's reward for `count` freshly-claimed referrals — chips per head PLUS a full
 * lives refill — in ONE atomic load→grant→persist so a crash can never award half. Called by
 * core/referrals.ts claimReferralRewards AFTER the cloud rows are stamped. Returns the new balance.
 */
export function grantReferralRewards(count: number, chipsEach: number): number {
  const save = loadSave()
  save.chips += Math.max(0, Math.floor(count)) * Math.max(0, Math.floor(chipsEach))
  save.lives = LIVES_MAX
  save.livesAnchor = 0
  persistSave(save)
  return save.chips
}

/**
 * One-time referee welcome grant — atomic check→flag→grant→persist. Returns the new chip balance, or
 * null when already claimed (save untouched). The latch rides the cloud-synced save, so a second
 * device can never double-award. Constants live in core/referrals.ts; this just applies them.
 */
export function claimReferralWelcome(chips: number): number | null {
  const save = loadSave()
  if (save.referralWelcomeClaimed) return null
  save.referralWelcomeClaimed = true
  save.chips += Math.max(0, Math.floor(chips))
  persistSave(save)
  return save.chips
}

/**
 * Mirror the captured invite code into the save for UI ("invited by ...") — set-once; the
 * 'viva-maya:ref' localStorage stash (core/referrals.ts) stays authoritative for registration.
 */
export function setReferredByCode(code: string): void {
  const save = loadSave()
  if (save.referredByCode === null) {
    save.referredByCode = code
    persistSave(save)
  }
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

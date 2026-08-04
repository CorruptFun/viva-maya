import { LIVES_MAX } from '../config'
import { DIFFICULTY } from './difficulty'
import { JACKPOT_GOAL } from './jackpot'
import type { BoostType, PromoReward } from './types'

export interface SaveData {
  v: 13
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
  /**
   * Best endless score per DAILY board, keyed by race day ("YYYY-MM-DD" — core/endless.ts dayKey,
   * midnight-to-midnight in RACE_TZ).
   * The week's standing is the sum of the entries inside it, so this map is the local half of both
   * races at once. Pruned to the newest ~16 days by recordEndless; `{}` until the first run.
   */
  endlessDays: Record<string, number>
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
  /** Hazard intro cards already shown, by kind — so each new rule is taught exactly once. */
  hazardIntros: string[]
  /** §G11 teach-once latch per SPECIAL PIECE group ('wildReel' | 'diceBomb' | 'jackpot'). */
  specialIntros: string[]
  /** Latch for the one-time ALL CLEAR (level 100) grand finale. */
  finaleSeen: boolean
  /** Latch for a future first-run onboarding intro. */
  seenIntro: boolean
  /** Latch for the one-time DAILY RACE UNLOCKED reveal, shown on Home once endless opens. */
  seenRaceUnlock: boolean
  /**
   * Boost TYPES the player has set aside — none of these are consumed at level start, however many
   * are owned. A set of types rather than a count, because "hold my Jackpot Chips for a hard level"
   * is the actual intent and per-instance holding would need a second inventory kept in sync with
   * the first through every grant, spend and device merge.
   */
  heldBoosts: BoostType[]
  // --- v8 Jackpot Wheel field. Defaults to 0; read shape-tolerantly below. ---
  /** Jackpot meter charge — notches filled by level wins; at JACKPOT_GOAL the wheel fires, then resets. */
  jackpotMeter: number
  /** Week keys ("YYYY-Www") whose weekly-race CHAMPION purse has been claimed (once-per-week gate;
   *  rides the cloud-synced save so a second device can never double-award). Absent in older saves → []. */
  championWeeks: string[]
  /** Day keys ("YYYY-MM-DD") whose DAILY-winner purse has been claimed — championWeeks' per-day
   *  twin, same once-per-key gate and same cloud-synced double-award protection. */
  championDays: string[]
  /** Day keys whose RESULT RECAP card has been shown. A "has seen" latch, not a claim: it grants
   *  nothing, it just stops yesterday's result greeting you twice. Rides the synced save so a second
   *  device doesn't re-show it either. */
  raceRecapDays: string[]
  /**
   * Chapter numbers (1-based) whose completion reward has been claimed — the permanent trophy list
   * AND the once-per-chapter purse latch in one field (core/trophies.ts owns the claim; keeping the
   * two meanings in one list is what lets the retro back-fill and the win-flow grant never disagree).
   * NEVER trimmed, unlike championWeeks: the showroom displays every entry forever, and the list is
   * bounded at CHAPTER_COUNT (30) by construction. Rides the cloud-synced save; unioned on merge so
   * a second device can neither re-claim a purse nor lose a trophy.
   */
  chapterRewards: number[]
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
  // --- v10 Lucky Deal / charms fields. All default EMPTY/OFF; read shape-tolerantly below. ---
  /** Charm ids collected in the CURRENT series (core/charms.ts CHARMS); emptied when a series completes. */
  charms: string[]
  /** 1-based series number — bumps each time an album is completed. */
  charmSeries: number
  /** All-time charms collected across every series. Never reset; drives LUCK (core/charms.ts luckOf). */
  charmsAllTime: number
  /** Consecutive numbered-level WINS. Every DEAL_STREAK of them deals the Lucky Deal; a loss resets it. */
  winStreak: number
  // --- v13 identity fields. Default to "never chosen"; read shape-tolerantly below. ---
  /**
   * The player's chosen PUBLIC race name, or null when they haven't picked one.
   *
   * Lives in the save — not just in its own localStorage key — because it is the one piece of
   * identity the cloud has to carry: a cleared browser or a new phone otherwise loses the name and
   * the boards fall back to a default, which is exactly the "I have to set my name again" report.
   * core/leaderboard.ts owns the sanitising rules and the localStorage mirror; this field is the
   * copy that travels. Stored as written by that module (already sanitized), length-capped here only.
   */
  handle: string | null
  /**
   * Epoch ms the handle was last set (0 = never). The merge tiebreak: without it a rename on the
   * phone would be silently undone by a tablet that happens to be further progressed.
   */
  handleSetAt: number
  /** YYYY-MM-DD (local) whose daily MARKER comp has been used — the once-a-day "first busted
   *  marker is on the house" latch (core/marker.ts). freeSpinsDay's sibling: plain
   *  winner's-record on merge, no union needed (a stale value only ever re-offers one comp). */
  markerCompDay: string | null
}

/** Most free spins the bank ever holds — earning past this is quietly forfeited. */
export const FREE_SPIN_BANK_CAP = 12
/** Most free spins earnable per local calendar day (keeps a marathon session from minting a hoard). */
export const FREE_SPIN_DAILY_CAP = 6

/**
 * Who is trying to bank a spin — the two earners answer to DIFFERENT caps.
 *
 * - `'mega'` (default): a MEGA-grade cascade on a numbered level. Bounded by both caps; this is the
 *   farmable source the daily cap exists to bound.
 * - `'plinko'`: a SPIN well on the bonus board. **Bank cap only.** These two coexist badly under one
 *   budget: a drop needs an x5+ chain, and that same chain has ALREADY banked its 'mega' award
 *   (x4+ → 3, x6+ → 6) moments earlier in the same resolve. So the daily allowance is spent by the
 *   very chain that earned the drop — an x6+ chain empties all 6 on its own — and the board it
 *   bought would then have to restrike both SPIN wells as ×8, every single time. Exempting the
 *   ticket is what keeps SPIN on the numbered-level board at all.
 *
 *   It stays honest because it is not a loophole worth farming: at most one drop per level, and the
 *   ticket wells are 12 of 100 weight, so it adds ~0.02 spins per level played — and the bank cap
 *   still hard-stops it. Endless never reaches here (its tickets are off by contract).
 */
export type FreeSpinSource = 'mega' | 'plinko'

/** Headroom for one source. `save` must already have had the day rolled if it is being written. */
function freeSpinHeadroom(save: SaveData, dayKey: string, source: FreeSpinSource): number {
  const bankRoom = FREE_SPIN_BANK_CAP - save.freeSpins
  if (source === 'plinko') return Math.max(0, bankRoom)
  const earnedToday = save.freeSpinsDay === dayKey ? save.freeSpinsEarnedToday : 0
  return Math.max(0, Math.min(FREE_SPIN_DAILY_CAP - earnedToday, bankRoom))
}

const KEY = 'viva-maya:v1'

const DEFAULTS: SaveData = {
  v: 13,
  best: 0,
  unlocked: 1,
  stars: {},
  lastSpinDate: null,
  streak: 0,
  pendingBoosts: [],
  endlessDays: {},
  lives: LIVES_MAX,
  livesAnchor: 0,
  chips: 0,
  firstPlayDate: null,
  lastOpenDate: null,
  occasionsSeen: [],
  hazardIntros: [],
  specialIntros: [],
  finaleSeen: false,
  seenIntro: false,
  seenRaceUnlock: false,
  heldBoosts: [],
  jackpotMeter: 0,
  championWeeks: [],
  championDays: [],
  raceRecapDays: [],
  chapterRewards: [],
  referredByCode: null,
  referralWelcomeClaimed: false,
  freeSpins: 0,
  freeSpinsDay: null,
  freeSpinsEarnedToday: 0,
  charms: [],
  charmSeries: 1,
  charmsAllTime: 0,
  winStreak: 0,
  handle: null,
  handleSetAt: 0,
  markerCompDay: null,
}

function fresh(): SaveData {
  // Re-init every mutable reference type so a fresh save never aliases DEFAULTS' arrays/objects.
  return {
    ...DEFAULTS,
    stars: {},
    pendingBoosts: [],
    occasionsSeen: [],
    hazardIntros: [],
    specialIntros: [],
    championWeeks: [],
    championDays: [],
    raceRecapDays: [],
    chapterRewards: [],
    endlessDays: {},
    charms: [],
  }
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
  // v1 {best}; v2 +unlocked/stars; v3 +daily-spin; v4 +endless race; v5 +lives/energy;
  // v9 +hazardIntros (the teach-once latch for each new board mechanic);
  // v10 +Lucky Deal / charms; v11 endless goes DAILY (endlessWeek/endlessBest → endlessDays;
  // +championDays); v12 +raceRecapDays (the seen-latch for yesterday's result card).
  base.best = typeof data.best === 'number' ? data.best : 0
    base.unlocked = typeof data.unlocked === 'number' ? Math.max(1, data.unlocked) : 1
    base.stars = data.stars && typeof data.stars === 'object' ? data.stars : {}
    base.lastSpinDate = typeof data.lastSpinDate === 'string' ? data.lastSpinDate : null
    base.streak = typeof data.streak === 'number' ? data.streak : 0
    base.pendingBoosts = Array.isArray(data.pendingBoosts) ? data.pendingBoosts : []
    // v11: per-DAY bests. Sanitised on the way in — every reader treats this map as trusted, and it
    // is summed into a public weekly total, so a junk entry must never reach the sum.
    //
    // The pre-v11 pair (endlessWeek + endlessBest) is deliberately NOT carried across: it held a best
    // for a WEEK-long board that no longer exists, and filing it under any day would credit a score
    // nobody could have earned on that day's layout. Nothing is lost that matters — `best` (all-time)
    // already absorbed it, and the leaderboard rows it produced stay in `endless_scores` as history.
    base.endlessDays = {}
    if (data.endlessDays && typeof data.endlessDays === 'object') {
      for (const [day, n] of Object.entries(data.endlessDays as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) base.endlessDays[day] = Math.floor(n)
      }
    }
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
    // v9: hazard intro latches. Shape-tolerant like every other array field, so a v8 save loads
    // clean and a v9 save read back by a rolled-back build is simply ignored by coerceSave.
    base.hazardIntros = Array.isArray(data.hazardIntros)
      ? data.hazardIntros.filter((x): x is string => typeof x === 'string')
      : []
    // §G11 special-piece intro latches. Same shape-tolerant treatment as hazardIntros above, so an
    // older save loads clean and a rolled-back build simply ignores the field.
    base.specialIntros = Array.isArray(data.specialIntros)
      ? data.specialIntros.filter((x): x is string => typeof x === 'string')
      : []
    base.occasionsSeen = Array.isArray(data.occasionsSeen)
      ? data.occasionsSeen.filter((x): x is string => typeof x === 'string')
      : []
    base.finaleSeen = data.finaleSeen === true
    base.seenIntro = data.seenIntro === true
    base.seenRaceUnlock = data.seenRaceUnlock === true
    // Absent in older saves → nothing held → today's behaviour exactly.
    base.heldBoosts = Array.isArray(data.heldBoosts)
      ? data.heldBoosts.filter((x): x is BoostType => typeof x === 'string')
      : []
    // v8 Jackpot Wheel meter — absent in pre-v8 saves → 0.
    base.jackpotMeter = typeof data.jackpotMeter === 'number' ? Math.max(0, Math.floor(data.jackpotMeter)) : 0
    // Race champion claims (weekly season + daily board) — absent in older saves → none claimed.
    base.championWeeks = Array.isArray(data.championWeeks)
      ? data.championWeeks.filter((x): x is string => typeof x === 'string')
      : []
    base.championDays = Array.isArray(data.championDays)
      ? data.championDays.filter((x): x is string => typeof x === 'string')
      : []
    base.raceRecapDays = Array.isArray(data.raceRecapDays)
      ? data.raceRecapDays.filter((x): x is string => typeof x === 'string')
      : []
    // Chapter trophy/purse latch — absent in older saves → none claimed (the Home catch-up sweep
    // back-fills once). Positive integers only, deduped; NOT validated against CHAPTER_COUNT here
    // (this module stays dependency-light — core/trophies.ts imports IT, and its claim guard is what
    // enforces the range; a stray high number simply never renders, like an unknown charm id).
    base.chapterRewards = Array.isArray(data.chapterRewards)
      ? Array.from(
          new Set(
            data.chapterRewards.filter(
              (x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0
            )
          )
        )
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
    // v10 Lucky Deal / charms — absent in older saves → an empty first album and a cold streak.
    // Charm ids are filtered to strings but deliberately NOT validated against the CHARMS catalogue:
    // this module stays dependency-free (core/charms.ts imports IT, not the reverse), and an unknown
    // id is harmless — every reader looks charms up BY catalogue, so a stale id simply never renders.
    base.charms = Array.isArray(data.charms) ? data.charms.filter((x): x is string => typeof x === 'string') : []
    base.charmSeries = typeof data.charmSeries === 'number' ? Math.max(1, Math.floor(data.charmSeries)) : 1
    base.charmsAllTime = typeof data.charmsAllTime === 'number' ? Math.max(0, Math.floor(data.charmsAllTime)) : 0
    base.winStreak = typeof data.winStreak === 'number' ? Math.max(0, Math.floor(data.winStreak)) : 0
    // v13 identity — absent in older saves → "never chosen", which reads as the anonymous default.
    // Only shape + length are enforced here: the NAME RULES live in core/leaderboard.ts (sanitizeName),
    // and importing them would close a cycle (leaderboard → cloud → save), so getHandle sanitizes on
    // read instead. A blank string is normalised to null so "" and null can't mean different things.
    base.handle =
      typeof data.handle === 'string' && data.handle.trim() !== '' ? data.handle.trim().slice(0, 24) : null
    base.handleSetAt =
      typeof data.handleSetAt === 'number' && Number.isFinite(data.handleSetAt)
        ? Math.max(0, Math.floor(data.handleSetAt))
        : 0
    // Slice 0 Marker comp latch — absent in older saves → today's comp unused.
    base.markerCompDay = typeof data.markerCompDay === 'string' ? data.markerCompDay : null
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
 * Claim the weekly-season CHAMPION purse for a week — atomic load→check→award→persist. Returns the
 * new chip balance, or null when that week was already claimed (this device or any synced one),
 * leaving the save untouched. The claimed-week latch rides the save, so cloud sync makes the gate
 * global.
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
 * Claim the DAILY-winner purse for a day — `claimChampionship`'s twin, with the same once-per-key
 * atomicity and the same cloud-synced double-award gate. Returns the new chip balance, or null when
 * that day was already claimed. The tail is longer than the weekly one only because days arrive
 * seven times as fast: 14 still covers far more than the one closed day ever checked.
 */
export function claimDailyWin(day: string, purse: number): number | null {
  const save = loadSave()
  if (save.championDays.includes(day)) return null
  save.championDays.push(day)
  if (save.championDays.length > 14) save.championDays = save.championDays.slice(-14)
  save.chips += Math.max(0, Math.floor(purse))
  persistSave(save)
  return save.chips
}

/**
 * Latch yesterday's RESULT RECAP as shown, so it greets the player exactly once. Deliberately NOT a
 * claim (nothing is granted), and deliberately marked BEFORE the card animates rather than after:
 * a coronation that dies mid-ceremony should re-offer, because a purse is owed — a recap that dies
 * mid-ceremony should not, because re-showing yesterday's result on the next open is just noise.
 * Trimmed to a short tail; only the single most recently closed day is ever looked up.
 */
export function markRaceRecapSeen(day: string): void {
  const save = loadSave()
  if (save.raceRecapDays.includes(day)) return
  save.raceRecapDays.push(day)
  if (save.raceRecapDays.length > 14) save.raceRecapDays = save.raceRecapDays.slice(-14)
  persistSave(save)
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

/**
 * Spend one wheel's worth of charge after the wheel has fired; returns what is LEFT on the meter.
 *
 * Deducts JACKPOT_GOAL rather than zeroing. For level wins the two are identical — the meter fires the
 * instant it reaches the goal, so it is always exactly full when this runs — but Lucky Slots pays
 * jackpot POINTS in batches (core/store.ts buySpin), and a meter sitting at 8 must fire a wheel and
 * keep 3, not fire a wheel and throw 3 away. The slots deliberately do not cap what they charge, so
 * this is what makes an over-full meter queue the next wheel instead of evaporating.
 */
export function spendJackpotCharge(): number {
  const save = loadSave()
  const left = Math.max(0, save.jackpotMeter - JACKPOT_GOAL)
  if (save.jackpotMeter !== left) {
    save.jackpotMeter = left
    persistSave(save)
  }
  return left
}

/**
 * Advance the HOT STREAK by one win; persists and returns the new streak. Called only for a
 * FIRST clear — replays deliberately leave it alone (see GameScene.finishWin), for the same reason the
 * jackpot meter only charges on progress: a streak you can build by re-clearing level 1 in ten seconds
 * measures patience with the retry button, not a run of wins.
 */
export function bumpWinStreak(): number {
  const save = loadSave()
  save.winStreak += 1
  persistSave(save)
  return save.winStreak
}

/**
 * Break the streak — a loss, or a mid-level quit after ≥1 move (the same two events that cost a life,
 * so "what broke my streak" never needs a second rule to explain).
 *
 * Returns the streak that was BROKEN (0 when there was nothing to lose), so the caller can decide
 * whether the moment is worth showing: silently zeroing a streak of 1 is noise, but a player who just
 * dropped a run of four has earned being told.
 */
export function resetWinStreak(): number {
  const save = loadSave()
  const had = save.winStreak
  if (had !== 0) {
    save.winStreak = 0
    persistSave(save)
  }
  return had
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

/**
 * Latch the DAILY RACE UNLOCKED reveal so it can only ever play once.
 *
 * Absent in every save written before 2026-08-03, which coerces to false — so players who were
 * ALREADY past the unlock get the reveal on their next visit rather than never seeing it. That is
 * the intended behaviour: the gate moved to level 10 the same day, so "already unlocked" describes
 * a lot of people who have never had the race explained to them.
 */
export function markRaceUnlockSeen(): void {
  const save = loadSave()
  if (!save.seenRaceUnlock) {
    save.seenRaceUnlock = true
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
 * Bank earned free spins under the caps that apply to `source` (see FreeSpinSource — 'mega' answers
 * to the daily earn cap AND the bank cap, 'plinko' to the bank cap alone). `dayKey` is 'YYYY-MM-DD'
 * (daily.todayKey()); a new day resets the earn counter. Atomic load→cap→persist; returns how many
 * spins were ACTUALLY granted (0..n) so the caller can size the celebration honestly.
 *
 * Every grant is recorded in freeSpinsEarnedToday, clamped to the daily cap — so a plinko spin
 * SPENDS the day's 'mega' allowance (the total daily flow stays bounded) without ever being blocked
 * by it, and the persisted counter stays inside the range coerceSave enforces on load.
 */
export function addFreeSpins(n: number, dayKey: string, source: FreeSpinSource = 'mega'): number {
  const want = Math.max(0, Math.floor(n))
  if (want === 0) return 0
  const save = loadSave()
  if (save.freeSpinsDay !== dayKey) {
    save.freeSpinsDay = dayKey
    save.freeSpinsEarnedToday = 0
  }
  const granted = Math.min(want, freeSpinHeadroom(save, dayKey, source))
  if (granted <= 0) return 0
  save.freeSpins += granted
  save.freeSpinsEarnedToday = Math.min(FREE_SPIN_DAILY_CAP, save.freeSpinsEarnedToday + granted)
  persistSave(save)
  return granted
}

/**
 * How many free spins `source` could bank RIGHT NOW — a read-only peek at exactly what `addFreeSpins`
 * would grant for the same source, with the same day-rollover rule. Nothing is written.
 *
 * Exists so a reward can decline to OFFER a free spin it couldn't pay: Plinko rolls its ticket slots
 * out of the pool when this is 0, rather than landing the ball on SPIN and awarding nothing. Same
 * honesty rule as the ticket celebration itself — a capped-out player is never lied to. Pass the
 * SAME source the payment will use, or the board can advertise a well the banking then refuses.
 */
export function freeSpinRoom(dayKey: string, source: FreeSpinSource = 'mega'): number {
  return freeSpinHeadroom(loadSave(), dayKey, source)
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
 * Grant a redeemed promo/reward-code payload (core/promo.ts) in ONE atomic load→grant→persist so a
 * crash can never award half: chips → add · hearts → full lives refill · boost → queue N copies for
 * the next level (capped). Returns the resulting chip balance (unchanged for non-chip rewards).
 */
export function grantPromoReward(reward: PromoReward): number {
  const save = loadSave()
  if (reward.kind === 'chips') {
    save.chips += Math.max(0, Math.floor(reward.amount))
  } else if (reward.kind === 'hearts') {
    save.lives = LIVES_MAX
    save.livesAnchor = 0
  } else if (reward.kind === 'boost' && reward.boostType) {
    const n = Math.max(1, Math.min(20, Math.floor(reward.amount || 1)))
    for (let i = 0; i < n; i++) save.pendingBoosts.push(reward.boostType)
  }
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

/**
 * Consume the boosts that apply to the level being started (win or lose).
 *
 * §G4 — takes at most `DIFFICULTY.economy.boostApplyMax`, and at most `jackpotBoostPerLevel` of the
 * board-clearing jackpot chips. Both constants were written as the guard for exactly this and had no
 * reader: the old code drained the ENTIRE bank into one level, so a player who had banked a fortnight
 * of daily spins opened a level with ~13 boosts — roughly +13 moves and eight pre-planted specials,
 * which trivialises any level and then leaves the bank empty for the levels that actually needed it.
 *
 * The surplus STAYS BANKED, which is strictly better for the player than the old behaviour: it used
 * to evaporate on whatever level happened to be next. Ordering is preserved so the oldest prizes are
 * spent first, and jackpots that don't fit this level keep their place in the queue.
 */
/**
 * The pure split behind `takePendingBoosts` — which of a pending queue the NEXT level would take,
 * and what stays banked. Exported and side-effect-free so the stash panel (view/stash.ts) can SHOW
 * the upcoming selection without consuming it.
 *
 * ⚠️ This function existing is the point: the stash tells the player "these three are going in next
 * level", and that promise is only true if the preview and the consumption run the SAME code. Two
 * implementations of this rule would drift the first time a cap changed, and the symptom would be a
 * player watching a boost they were promised silently not appear.
 */
export function splitPendingBoosts(
  pending: readonly BoostType[],
  held: readonly BoostType[] = []
): { take: BoostType[]; keep: BoostType[] } {
  const take: BoostType[] = []
  const keep: BoostType[] = []
  let jackpots = 0
  for (const b of pending) {
    // A HELD type is never taken and never counts against the cap — holding a Jackpot Chip must make
    // room for the next boost in the queue, not silently waste one of the three slots.
    if (held.includes(b)) {
      keep.push(b)
      continue
    }
    const room = take.length < DIFFICULTY.economy.boostApplyMax
    const jackpotOk = b !== 'jackpot' || jackpots < DIFFICULTY.economy.jackpotBoostPerLevel
    if (room && jackpotOk) {
      if (b === 'jackpot') jackpots++
      take.push(b)
    } else {
      keep.push(b)
    }
  }
  return { take, keep }
}

/**
 * Toggle whether a boost TYPE is set aside. Returns the new held state.
 *
 * Holding is per-type rather than per-instance on purpose. "Save my Jackpot Chips for a hard level"
 * is the real intent, and a per-instance hold would need a second inventory kept consistent with the
 * first through every grant, spend and cross-device merge — the same trap `promoteBoost` avoids by
 * reordering rather than adding an `armedBoosts` array.
 */
export function toggleHoldBoost(type: BoostType): boolean {
  const save = loadSave()
  const at = save.heldBoosts.indexOf(type)
  if (at >= 0) save.heldBoosts.splice(at, 1)
  else save.heldBoosts.push(type)
  persistSave(save)
  return at < 0
}

export function takePendingBoosts(exclusions: readonly BoostType[] = []): BoostType[] {
  const save = loadSave()
  if (save.pendingBoosts.length === 0) return []
  // ⚠️ `heldBoosts` MUST be passed here. The stash previews the selection with the same call, so
  // omitting it would make the panel promise one thing and the level do another — the exact drift
  // `splitPendingBoosts` was extracted to prevent.
  //
  // `exclusions` are the LEVEL's own refusals (core/levels.ts levelBoostExclusions — a HOUSE
  // MINIMUM level declines DOUBLE SCORE). They ride the held path deliberately: skipped, never
  // consumed, never charged a slot — and the stash preview passes the same exclusions for the
  // level it is previewing, so the promise and the consumption still run one rule.
  const { take, keep } = splitPendingBoosts(save.pendingBoosts, [...save.heldBoosts, ...exclusions])
  save.pendingBoosts = keep
  persistSave(save)
  return take
}

/**
 * Move one instance of `type` to the FRONT of the pending queue — how the stash lets a player choose
 * what goes into their next level.
 *
 * Reordering IS the mechanism, deliberately: `takePendingBoosts` already consumes from the front, so
 * "arming" a boost needs no new save field, no migration, and nothing added to the blob that rides
 * every cloud push. A separate `armedBoosts` array would have to be kept consistent with this one
 * through every grant, spend and device merge — a whole class of desync for no gain.
 *
 * Returns false when there is nothing of that type to promote, so the UI can no-op quietly.
 */
/**
 * Spend ONE owned boost outright, outside the level-start path — how the in-level helper shelf lets
 * a player use something they already own instead of paying chips for it.
 *
 * Deliberately removes the FIRST match rather than the last, so it drains the same end of the queue
 * `takePendingBoosts` does and a player can never be left holding a stale prize forever behind
 * newer ones. Returns false when they own none, so the caller can fall through to the paid path.
 */
export function consumeBoost(type: BoostType): boolean {
  const save = loadSave()
  const at = save.pendingBoosts.indexOf(type)
  if (at < 0) return false
  save.pendingBoosts.splice(at, 1)
  persistSave(save)
  return true
}

export function promoteBoost(type: BoostType): boolean {
  const save = loadSave()
  const at = save.pendingBoosts.indexOf(type)
  if (at < 0) return false
  if (at > 0) {
    save.pendingBoosts.splice(at, 1)
    save.pendingBoosts.unshift(type)
    persistSave(save)
  }
  return true
}

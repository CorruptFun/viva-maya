import { BOOST_META } from './inventory'
import type { BoostType } from './types'
import type { SaveData } from './save'
import { FREE_SPIN_BANK_CAP, FREE_SPIN_DAILY_CAP } from './save'
import type { Rng } from './rng'

/**
 * The daily check-in — pure logic (no Phaser). One free pull per local calendar day, taken on the
 * LUCKY SLOTS cabinet (core/store.ts freeSlotSpin; SlotScene presents it). A free pull is a gift,
 * not gambling — the GIFT FLOOR in freeSlotSpin guarantees it never pays nothing, with this module's
 * classic PRIZES table as the floor. Consecutive days build a streak; the streak scales the check-in
 * chips (CHECKIN_CHIPS), every 5th day pays a double prize (milestoneDue), and the STREAK REWARDS
 * ladder below pays a one-off purse at 3 / 7 / 14 / 30 / 60 / 100 consecutive days.
 *
 * ⚠️ TWO different things in here are called a milestone, so they are named apart on purpose:
 * `milestoneDue` is the DAY-5 DOUBLE (a recurring every-5th-day bonus prize off the classic table),
 * and `streakRewardFor` is the STREAK REWARD (the 3/7/14/30/60/100 ladder). Keep the two names
 * distinct at every call site — this codebase already has a scar from three different things being
 * called "+5 MOVES" (see the BOOST_META note in core/inventory.ts).
 */
export interface Prize {
  type: BoostType
  label: string
  blurb: string
  weight: number
}

/**
 * Spawn weights, richest rarest. ⚠️ THE ORDER OF THIS LIST IS LOAD-BEARING — `rollPrize` walks it
 * accumulating weights, so reordering it changes which prize a given RNG roll returns and silently
 * rewrites every seeded test. Display order is a separate, deliberately different list
 * (`BOOST_ORDER` in core/inventory.ts); do not conflate them.
 */
const PRIZE_WEIGHTS: ReadonlyArray<readonly [BoostType, number]> = [
  ['wildReel', 30],
  ['diceBomb', 25],
  ['extraMoves', 20],
  ['doubleScore', 15],
  ['jackpot', 10],
]

/**
 * Labels and blurbs come from `BOOST_META` (core/inventory.ts) rather than being written here. This
 * table and the Gift Store's `BOOST_ITEMS` used to each carry their own copy of every name, which is
 * how one object ends up with two names — and a player who wins "+5 MOVES" and is then shown a
 * differently-worded version of the same thing has no way to know they are the same item.
 */
export const PRIZES: Prize[] = PRIZE_WEIGHTS.map(([type, weight]) => ({
  type,
  label: BOOST_META[type].label,
  blurb: BOOST_META[type].blurb,
  weight,
}))

export function todayKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** Whole days between two YYYY-MM-DD keys (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

export function spinAvailable(save: SaveData, now = new Date()): boolean {
  return save.lastSpinDate !== todayKey(now)
}

// ─────────────────────────────────────────────────────────────────────────────
// FREE SPINS — bonus wheel pulls earned by spectacular in-level play. A big
// cascade banks extra spins (save.freeSpins via save.addFreeSpins) that BYPASS
// the once-a-day latch: performFreeSpin below spends the bank and never touches
// lastSpinDate / streak, so the daily gift keeps its own rhythm.
// ─────────────────────────────────────────────────────────────────────────────

/** Re-exported caps (defined beside the save fields they clamp — see core/save.ts). */
export { FREE_SPIN_BANK_CAP, FREE_SPIN_DAILY_CAP }

export interface FreeSpinAward {
  /** Smallest cascade chain (consecutive match waves) that earns this tier. */
  minCascade: number
  spins: number
}

/** Cascade → free-spin award tiers, ordered best-first (awardFreeSpinsFor takes the first hit). */
export const FREE_SPIN_AWARDS: FreeSpinAward[] = [
  { minCascade: 6, spins: 6 },
  { minCascade: 4, spins: 3 },
]

/** Spins a cascade chain of `cascade` waves earns (0 when below every tier). Caps apply at banking
 *  time — save.addFreeSpins clamps to the daily earn cap and the bank cap and reports what stuck. */
export function awardFreeSpinsFor(cascade: number): number {
  for (const tier of FREE_SPIN_AWARDS) if (cascade >= tier.minCascade) return tier.spins
  return 0
}

/** Can the player pull the wheel AT ALL right now — today's daily spin, or a banked free spin? */
export function hasAnySpin(save: SaveData, now = new Date()): boolean {
  return spinAvailable(save, now) || save.freeSpins > 0
}

export function rollPrize(rng: Rng): Prize {
  const total = PRIZES.reduce((sum, p) => sum + p.weight, 0)
  let roll = rng() * total
  for (const prize of PRIZES) {
    roll -= prize.weight
    if (roll < 0) return prize
  }
  return PRIZES[0]
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY CHECK-IN CHIPS — the "occasionally chips" faucet the economy diagram
// promises (docs/SOCIAL_AND_ECONOMY.md), made a dependable part of every daily
// pull. A 7-day ladder ramps the reward small→big across a streak week and RESETS
// with the week, indexed by ((streak - 1) % 7) — the exact model the D3 week strip
// already draws (weekDots), so the "payday" lands the day the 7th dot lights and
// starts over with a fresh week. Because the payout is a FIXED amount per day it is
// inflation-safe by construction regardless of player count (iron rule #1's spirit:
// every faucet is a fixed-size gift). Steady-state ≈ 56 chips/day — a meaningful
// supplement to level-win income (~33/day) that never eclipses the Gift Store sinks
// (boosts 40–120) or the weekly champion purse (1,000). This table IS the knob: raise
// the day-7 cap or flatten the curve here and nothing else needs to move.
// ─────────────────────────────────────────────────────────────────────────────

/** Chips a daily check-in pays on each day of a streak week (day 1 → day 7); repeats every 7 days. */
export const CHECKIN_CHIPS = [10, 15, 25, 40, 60, 90, 150] as const

/**
 * Chips today's daily check-in awards for a 1-based streak day. Indexes CHECKIN_CHIPS by
 * ((streak - 1) % 7) so the reward ramps across the week and the day-7 payday recurs weekly in
 * lockstep with the streak strip; returns 0 for a non-positive streak (never-spun / defensive).
 */
export function checkinChipsFor(streak: number): number {
  if (streak < 1) return 0
  return CHECKIN_CHIPS[(streak - 1) % CHECKIN_CHIPS.length]
}

// ─────────────────────────────────────────────────────────────────────────────
// STREAK REWARDS — the payoff for KEEPING a streak, as opposed to for showing
// up today.
//
// CHECKIN_CHIPS above resets every seventh day, which means it answers "how many
// days into this week are you?" and nothing else: day 8 pays exactly what day 1
// pays, so a thirty-day streak was worth no more than a two-day one and the
// number on the flame badge was decoration. This ladder is the missing half —
// a named, escalating purse that lands ON the day you reach a milestone.
//
// ── REPEATABLE, ONCE PER RUN (owner call) ────────────────────────────────────
// Break a streak, climb back to day 7, and day 7 pays again. That is the whole
// retention argument: a ladder you can only climb once is dead the day it breaks,
// and the player who most needs a reason to come back tomorrow is exactly the one
// who just lost a long streak. It cannot be farmed, because the CHECK-IN ladder
// already punishes the reset — deliberately breaking a streak forfeits the
// 60/90/150 end of the week (300 chips) to re-reach a 50-chip day 3. Re-farming
// is strictly loss-making at every rung, so no anti-abuse rule is needed and none
// is added.
//
// ── WHY THERE IS NO CLAIM LATCH ──────────────────────────────────────────────
// Unlike chapterRewards / championWeeks / installRewardClaimed, this grants real
// chips and a boost with NO latch in the save, and that is correct rather than an
// oversight: the payment is made inside `advanceDailyRitual`, in the same
// statement block that writes `lastSpinDate`. The day latch IS the claim latch.
// Adding a second one would be a second definition of "already paid today" to
// keep in sync with the first. ⚠️ The corollary is that this MUST NOT be lifted
// out to a caller — see the warning on advanceDailyRitual.
//
// ── THE BUDGET (this table is the knob; re-derive these three numbers) ───────
// Over a perfect 100-day run: 50 + 150 + 250 + 400 + 500 + 600 = 1,950 chips,
// i.e. ~19.5/day against the check-in ladder's ~55.7/day — a ~35% supplement,
// deliberately a SIDE dish and not a second main. Every rung stays under the
// weekly champion purse (1,000), which nothing repeatable may top (the rule is
// written down in core/trophies.ts CHAPTER_PURSES). Escalation past day 30 is
// carried by free spins and by the JACKPOT CHIP rather than by chips, for the
// reason Act II's flat purse ladder gives: chips are a lifetime budget, and a
// slope that keeps climbing reprices the whole Gift Store without a single price
// changing.
//
// ── CADENCE ──────────────────────────────────────────────────────────────────
// 3 / 7 / 14 / 30 / 60 / 100. Day 3 is deliberately early and cheap — it is the
// hook, landing before the point most daily streaks are abandoned, and it is the
// one rung whose job is to teach that the ladder exists at all. This runs out of
// phase with the every-5-day double (milestoneDue) on purpose; they first collide
// on day 30, and a day that pays both is simply a very good day.
// ─────────────────────────────────────────────────────────────────────────────

/** One rung of the streak ladder — what reaching `day` consecutive days pays. */
export interface StreakReward {
  /** Consecutive-day streak this rung lands on, exactly (not "at least"). */
  day: number
  /** ALL-CAPS short name — the headline on the reveal card. */
  label: string
  /** Chips paid ON TOP of the day's CHECKIN_CHIPS. */
  chips: number
  /** Boost banked to pendingBoosts for the next numbered level, or null. */
  boost: BoostType | null
  /** Bonus wheel pulls banked, or 0. */
  freeSpins: number
  /** The card's hero glyph. Must be a FULLY-QUALIFIED emoji — see the BOOST_META icon note. */
  emoji: string
}

/**
 * The ladder, ascending. ⚠️ MUST stay sorted by `day` — `nextStreakReward` walks it front-to-back
 * and returns the first rung ahead of the player, so an out-of-order entry silently makes the
 * countdown point at the wrong prize. `daily.test.ts` pins the ordering.
 *
 * Boost types are BOOST_META keys (the canonical names) and every grant rides `pendingBoosts` like
 * every other boost source, so the stash panel, the level-start consumption and the endless
 * exclusion all apply unchanged — and iron rule 2 (the daily race stays boost-free) is untouched,
 * because endless never consumes pendingBoosts.
 */
export const STREAK_REWARDS: readonly StreakReward[] = [
  { day: 3, label: 'THREE DAYS', chips: 50, boost: null, freeSpins: 0, emoji: '🔥' },
  { day: 7, label: 'ONE WEEK', chips: 150, boost: 'wildReel', freeSpins: 0, emoji: '⭐' },
  { day: 14, label: 'TWO WEEKS', chips: 250, boost: 'diceBomb', freeSpins: 2, emoji: '🌟' },
  { day: 30, label: 'ONE MONTH', chips: 400, boost: 'jackpot', freeSpins: 3, emoji: '💎' },
  { day: 60, label: 'TWO MONTHS', chips: 500, boost: 'jackpot', freeSpins: 4, emoji: '👑' },
  // The top rung, and it stays a rung rather than becoming a wall: a player past 100 keeps every
  // daily faucet (check-in chips, the day-5 double, the gift floor) and simply has no rung left to
  // reach. Adding one is a one-line edit here and nothing else.
  { day: 100, label: 'ONE HUNDRED DAYS', chips: 600, boost: 'jackpot', freeSpins: 5, emoji: '🏆' },
]

/** The rung landing on EXACTLY this streak day, or null on an ordinary day. */
export function streakRewardFor(streak: number): StreakReward | null {
  if (!Number.isFinite(streak) || streak < 1) return null
  return STREAK_REWARDS.find(r => r.day === streak) ?? null
}

/**
 * The next rung AHEAD of `streak`, or null once the ladder is topped out.
 *
 * This is the half of the feature that actually changes behaviour. A reward the player only
 * discovers by receiving it cannot incentivise anything — it is the `install_offer_shown` lesson
 * and the `seenSlotsIntro` one over again ("the door was never hidden; what was hidden was the
 * offer"). The countdown this feeds — on the Home flame badge and the cabinet's subtitle — is what
 * turns a streak from a readout into something worth protecting tonight.
 */
export function nextStreakReward(streak: number): StreakReward | null {
  const at = Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0
  return STREAK_REWARDS.find(r => r.day > at) ?? null
}

/** Days from `streak` to the next rung, or null when the ladder is topped out. Always ≥ 1. */
export function daysToNextStreakReward(streak: number): number | null {
  const next = nextStreakReward(streak)
  if (!next) return null
  const at = Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0
  return next.day - at
}

/** What a streak reward actually paid, so the reveal card can be sized honestly. */
export interface StreakRewardGrant {
  reward: StreakReward
  /** Chips banked — always `reward.chips` (chips have no cap). */
  chips: number
  /** Free spins that actually STUCK, after the bank cap. May be less than `reward.freeSpins`. */
  freeSpins: number
  /** The boost banked to pendingBoosts, or null. */
  boost: BoostType | null
  /** Chip balance AFTER the grant. */
  balance: number
  /**
   * True when this player has reached this rung BEFORE — i.e. a streak was broken and rebuilt past
   * it. Read off `save.bestStreak` as it stood before this advance, so it is a fact about history
   * rather than a second latch. Carried on the analytics event, where it is the number the
   * repeatable-per-run decision is judged by; the card itself does not currently change for it.
   */
  repeat: boolean
}

/**
 * Bank the rung landing on `streak` onto `save` IN PLACE. Returns null on an ordinary day, leaving
 * the save untouched. The caller persists — this is called from inside `advanceDailyRitual`, which
 * is itself inside freeSlotSpin's single load→check→grant→persist, so the whole ritual is one write.
 *
 * ⚠️ Free spins are banked by direct mutation rather than through `addFreeSpins`, for two reasons
 * that both matter:
 *  1. `addFreeSpins` does its own loadSave()→persist, which would clobber the caller's in-flight
 *     save object — the exact trap `advanceDailyRitual` already records about `addChips`.
 *  2. It deliberately answers to the BANK cap only, not FREE_SPIN_DAILY_CAP. That daily cap exists
 *     to bound the one FARMABLE source (a marathon session banking mega-cascade awards); a rung
 *     that can be reached at most once per streak-run is not that, and letting a day's cascades
 *     silently eat a 100-day reward would be the ugliest possible way to pay it. Same carve-out,
 *     and the same reasoning, as the 'plinko' source in core/save.ts FreeSpinSource.
 * The BANK cap is still honoured, so an already-full bank forfeits the overflow — and the grant
 * reports what actually stuck, so the card never claims spins the player did not receive.
 */
export function grantStreakReward(save: SaveData, streak: number): StreakRewardGrant | null {
  const reward = streakRewardFor(streak)
  if (!reward) return null
  // Read BEFORE the caller bumps bestStreak — see the field's doc. On the first climb the record is
  // still behind this rung, so `repeat` is false; on a rebuild it has already passed it.
  const repeat = reward.day <= (save.bestStreak || 0)
  save.chips += reward.chips
  if (reward.boost) save.pendingBoosts.push(reward.boost)
  const room = Math.max(0, FREE_SPIN_BANK_CAP - (save.freeSpins || 0))
  const freeSpins = Math.min(reward.freeSpins, room)
  if (freeSpins > 0) save.freeSpins = (save.freeSpins || 0) + freeSpins
  return { reward, chips: reward.chips, freeSpins, boost: reward.boost, balance: save.chips, repeat }
}

/**
 * Advance the daily check-in ritual on the passed save: streak (consecutive-day +1, else back to 1),
 * the `lastSpinDate` latch, the streak-scaled check-in chips, and any STREAK REWARD that lands on
 * the new streak day — all banked onto the SAME save object (never via addChips()/addFreeSpins(),
 * whose fresh loadSave()→persist would clobber the caller's own persist).
 *
 * Deliberately does NOT persist and does NOT roll a prize: it is the RITUAL half of the daily spin,
 * extracted so exactly one definition of "what a daily check-in does" exists now that the spin
 * itself lives on the Lucky Slots cabinet (core/store.ts freeSlotSpin — which persists once, after
 * banking everything). Returns what it advanced so the caller can present it honestly.
 *
 * The 5th-streak-day DOUBLE PRIZE is the caller's to pay (milestoneDue below) — it needs an Rng and
 * this half deliberately takes none.
 *
 * ⚠️ THE STREAK REWARD IS PAID HERE, INSIDE THE STREAK ADVANCE, AND THAT IS THE WHOLE SAFETY
 * ARGUMENT. It is by far the largest thing the ritual pays, and it carries NO claim latch of its own
 * — it does not need one, because the streak can only advance past a milestone on a day
 * `spinAvailable` still allows, and `lastSpinDate` is written in the same statement block. One day,
 * one advance, one payment. Move this grant OUT to the caller and that guarantee is gone: a caller
 * that runs twice (a retry, a double-tap, a re-entered scene) pays the purse twice while the streak
 * moves once. See core/store.ts freeSlotSpin for the load→check→grant→persist wrapper this sits in.
 */
export function advanceDailyRitual(
  save: SaveData,
  now = new Date()
): { streak: number; chips: number; reward: StreakRewardGrant | null } {
  const today = todayKey(now)
  save.streak = save.lastSpinDate && daysBetween(save.lastSpinDate, today) === 1 ? save.streak + 1 : 1
  save.lastSpinDate = today
  const chips = checkinChipsFor(save.streak)
  save.chips += chips
  // ⚠️ ORDER IS LOAD-BEARING: the grant reads `bestStreak` to decide whether this rung is a REPEAT,
  // so the record must be bumped strictly after it. Bump first and every rung reports repeat: true,
  // including the very first one a player ever reaches.
  const reward = grantStreakReward(save, save.streak)
  save.bestStreak = Math.max(save.bestStreak || 0, save.streak)
  return { streak: save.streak, chips, reward }
}

/**
 * True on the streak days the daily spin pays DOUBLE — every 5th day, a second roll off the classic
 * PRIZES table on top of whatever the reels did.
 *
 * ⚠️ NOT the STREAK REWARDS ladder (`streakRewardFor`), which is the 3/7/14/30/60/100 purse. This
 * one recurs every five days forever and pays a random boost; that one lands on named milestones and
 * pays a fixed, escalating purse. They are deliberately out of phase, and a day that pays both
 * (day 30 is the first) is simply a very good day — see the cadence note on STREAK_REWARDS.
 */
export function milestoneDue(streak: number): boolean {
  return streak > 0 && streak % 5 === 0
}

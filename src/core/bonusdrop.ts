import { dayKey, seedForKey } from './endless'
import { BOOST_META } from './inventory'
import { mulberry32 } from './rng'
import { FREE_SPIN_BANK_CAP, loadSave, persistSave } from './save'
import type { SaveData } from './save'
import type { BoostType } from './types'

/**
 * THE HOUSE GIFT — one surprise bonus a day, waiting on the cabinet whether or not you earned it.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every reward in the game is CONDITIONAL: win the level, hold the streak, take the board, clear the
 * chapter. That is correct for a reward and useless as a REASON TO OPEN — a player who is not
 * already playing cannot reach any of it. The one unconditional thing (the daily spin) announces
 * itself only by a pill being gold rather than grey, which is the exact failure `seenSlotsIntro`
 * records: the door was never hidden, the OFFER was.
 *
 * This is a gift that can be NAMED before it is opened. That is the whole design: the reminder
 * (scripts/send-push.mjs `--drop`) says what is on the table today — "a JACKPOT CHIP is waiting" —
 * and the player finds exactly that when they arrive. "Come back" is a request; "your Jackpot Chip
 * is on the table" is an appointment.
 *
 * ── SEEDED BY THE DAY ALONE, AND THAT IS LOAD-BEARING ────────────────────────
 * `dropForDay` takes the race day key and nothing else, so every player on earth gets the same gift
 * on the same day. Three things fall out of that, and all three are the point:
 *
 *  1. **The sender can name it.** The notification is composed ONCE, server-side, from the same
 *     table — no per-subscriber roll, no save read, nothing to get out of step. The message a player
 *     receives and the card they open are provably the same gift (`bonusdrop.test.ts` pins the
 *     sender's copy of the roll against this one, exactly as `analytics.test.ts` pins `weekKey`).
 *  2. **Two devices agree.** A phone and a tablet seeded on a device id would show one player two
 *     different gifts on one day, and the notification would have named only one of them.
 *  3. **It is predictable, and here that is harmless.** Anyone can compute next Tuesday's gift from
 *     the bundle. ⚠️ That would be a serious bug on the RACE BOARD — foreknowledge there is a
 *     competitive advantage, which is why `core/racesalt.ts` exists — and it is a non-event here: a
 *     gift is not a contest, knowing Thursday pays a Jackpot Chip beats nobody, and "Thursday is
 *     Vault day" is a reason to be here on Thursday. **Do not reach for the race salt to 'fix' this.**
 *     Salting it would cost the one property the feature is built on (naming the gift in advance)
 *     to close a hole that does not exist.
 *
 * The RACE day key (midnight America/Edmonton) rather than `daily.ts todayKey` (device-local) for
 * the same reason: the sender runs in CI with no idea what a player's local calendar says, and a
 * gift named on one clock and claimed on another is a gift that sometimes arrives as a different
 * gift. The daily SPIN keeps its local day — it is not announced in advance, so it does not need to
 * agree with a server.
 *
 * ── THE BUDGET (this table is the knob) ──────────────────────────────────────
 * Expected value per day, derived from the weights below: ~23 chips, ~0.37 free spins, ~0.32 boosts.
 * Against the existing faucets — the check-in ladder at ~56 chips/day (core/daily.ts CHECKIN_CHIPS),
 * the streak ladder at ~19.5, level wins at ~33 — that is a ~21% supplement to daily chip income
 * and deliberately a SIDE dish, the same posture STREAK_REWARDS took and for the same reason: chips
 * are a lifetime budget, and a new faucet that moves the total materially reprices every Gift Store
 * sink without a single price changing.
 *
 * ⚠️ It is weighted toward things you cannot spend without PLAYING — free spins send you to the
 * cabinet, a boost is inert until you start a level — and away from raw chips, which is what keeps
 * a "reason to open" from quietly becoming a "reason not to play". Retune by moving weights, not by
 * adding a richer row: the three expected values above are the contract, and `bonusdrop.test.ts`
 * pins them.
 */

/** One entry on the gift table — what a given day pays. */
export interface BonusDrop {
  /** Stable id. Analytics prop and test fixture key; never shown to a player. */
  id: string
  /** ALL-CAPS headline on the card and in the notification title. */
  label: string
  /** One line of flavour, sized for the card's body and the notification's body. */
  blurb: string
  /** Hero glyph. Must be a FULLY-QUALIFIED emoji — see the BOOST_META icon note. */
  emoji: string
  /** Chips paid outright. */
  chips: number
  /** Bonus wheel pulls banked (bank cap applies; the daily EARN cap deliberately does not). */
  freeSpins: number
  /** Boost banked to pendingBoosts for the next numbered level, or null. */
  boost: BoostType | null
  /** Spawn weight. Only ratios matter; they need not sum to anything in particular. */
  weight: number
}

/**
 * The table, commonest first.
 *
 * ⚠️ THE ORDER OF THIS LIST IS LOAD-BEARING, exactly as `PRIZE_WEIGHTS` in core/daily.ts is:
 * `dropForDay` walks it accumulating weights, so reordering it changes which gift a given day pays.
 * A reorder is not a refactor — it silently re-rolls every future day and desynchronises any client
 * still on the old bundle from the notification the server sends (see the deploy note below).
 *
 * ⚠️ Boost-bearing rows carry a boost TYPE and never a boost NAME. `BOOST_META` (core/inventory.ts)
 * is the only place a boost is called anything, and this table getting its own copy of "+5 MOVES" is
 * precisely the drift that made a player believe he was being charged for his own winnings. The card
 * and the sender both resolve the name through `dropBoostLabel` below.
 */
const DROP_TABLE: readonly BonusDrop[] = [
  {
    id: 'chips_small',
    label: 'HOUSE CHIPS',
    blurb: 'A little something from the floor manager.',
    emoji: '🪙',
    chips: 20,
    freeSpins: 0,
    boost: null,
    weight: 26,
  },
  {
    id: 'chips_stack',
    label: 'A STACK',
    blurb: 'Somebody left this on the table with your name on it.',
    emoji: '💰',
    chips: 45,
    freeSpins: 0,
    boost: null,
    weight: 18,
  },
  {
    id: 'free_pull',
    label: 'A FREE PULL',
    blurb: 'One extra turn on the LUCKY SLOTS wheel, on the house.',
    emoji: '🎰',
    chips: 0,
    freeSpins: 1,
    boost: null,
    weight: 16,
  },
  {
    id: 'boost_moves',
    label: 'ON THE HOUSE',
    blurb: 'Banked for your next level.',
    emoji: '♟️',
    chips: 10,
    freeSpins: 0,
    boost: 'extraMoves',
    weight: 12,
  },
  {
    id: 'boost_dice',
    label: 'ON THE HOUSE',
    blurb: 'Banked for your next level.',
    emoji: '🎲',
    chips: 10,
    freeSpins: 0,
    boost: 'diceBomb',
    weight: 10,
  },
  {
    id: 'double_pull',
    label: 'A DOUBLE PULL',
    blurb: 'Two extra turns on the LUCKY SLOTS wheel.',
    emoji: '🎟️',
    chips: 0,
    freeSpins: 2,
    boost: null,
    weight: 8,
  },
  {
    id: 'boost_wild',
    label: 'ON THE HOUSE',
    blurb: 'Banked for your next level.',
    emoji: '🃏',
    chips: 15,
    freeSpins: 0,
    boost: 'wildReel',
    weight: 6,
  },
  {
    id: 'high_roller',
    label: 'HIGH ROLLER',
    blurb: 'The good table. Chips, a pull and a boost.',
    emoji: '💎',
    chips: 150,
    freeSpins: 1,
    boost: 'doubleScore',
    weight: 3,
  },
  {
    id: 'the_vault',
    label: 'THE VAULT',
    blurb: 'The best day the house gives away. Take all of it.',
    emoji: '🏆',
    chips: 250,
    freeSpins: 2,
    boost: 'jackpot',
    weight: 1,
  },
]

/** The gift table, read-only. Exported for the card, the sender's parity test and nothing else. */
export const BONUS_DROPS: readonly BonusDrop[] = DROP_TABLE

/**
 * The canonical NAME of a gift's boost, or null when it carries none. The single reason this exists
 * is so no caller is ever tempted to write the boost's name down a second time — see the warning on
 * DROP_TABLE.
 */
export function dropBoostLabel(drop: BonusDrop): string | null {
  return drop.boost ? BOOST_META[drop.boost].label : null
}

/**
 * The gift a given race day pays. Pure, total and deterministic: same key in, same row out, on the
 * client and in the sender alike.
 *
 * ⚠️ MUST STAY BEHAVIOURALLY IDENTICAL TO `dropForDay()` IN scripts/send-push.mjs, which carries its
 * own copy because that file runs in CI as plain Node with no TypeScript step. `bonusdrop.test.ts`
 * pins the two against each other across a long span of days. A drift there is not a cosmetic bug:
 * the notification would name a gift the game does not hand over, which is worse than sending no
 * notification at all.
 */
export function dropForDay(day: string): BonusDrop {
  // `#gift` namespaces this off the board seed. Without it the gift and the day's board would be
  // drawn from the same 32-bit seed, so the two would correlate forever — Vault day would always be
  // the same board — and any future change to one would silently move the other.
  const rng = mulberry32(seedForKey(`${day}#gift`))
  const total = DROP_TABLE.reduce((sum, d) => sum + d.weight, 0)
  let roll = rng() * total
  for (const drop of DROP_TABLE) {
    roll -= drop.weight
    if (roll < 0) return drop
  }
  // Unreachable while every weight is positive; a defensive floor rather than an exception, because
  // this runs inside a scene build and inside a CI send, and neither may ever throw.
  return DROP_TABLE[0]
}

/** Today's gift, on the race calendar. */
export function todaysDrop(now = new Date()): BonusDrop {
  return dropForDay(dayKey(now))
}

/** Whether today's gift is still on the table for this save. */
export function bonusDropDue(save: SaveData, now = new Date()): boolean {
  return save.bonusDropDay !== dayKey(now)
}

/** What a gift actually paid, so the card can be honest about it. */
export interface BonusDropGrant {
  drop: BonusDrop
  /** The race day claimed — the latch that was written. */
  day: string
  /** Chips banked — always `drop.chips`; chips have no cap. */
  chips: number
  /** Free spins that actually STUCK, after the bank cap. May be less than `drop.freeSpins`. */
  freeSpins: number
  /** The boost banked, or null. */
  boost: BoostType | null
  /** Chip balance AFTER the grant. */
  balance: number
}

/**
 * Bank today's gift onto `save` IN PLACE and latch the day. Returns null when it was already taken
 * (this device or any synced one), leaving the save untouched.
 *
 * Free spins are banked by direct mutation rather than through `addFreeSpins`, for the two reasons
 * `grantStreakReward` spells out: that helper does its own loadSave()→persist, which would clobber
 * an in-flight save object, and it answers to FREE_SPIN_DAILY_CAP — a cap that exists to bound the
 * one FARMABLE source (a marathon session banking cascade awards), which a once-a-day gift is not.
 * The BANK cap is still honoured and the grant reports what actually stuck, so the card can never
 * name spins the player did not receive.
 */
export function grantBonusDrop(save: SaveData, now = new Date()): BonusDropGrant | null {
  const day = dayKey(now)
  if (save.bonusDropDay === day) return null
  const drop = dropForDay(day)
  // The latch is written in the SAME statement block as the payment, exactly as `advanceDailyRitual`
  // pays the streak purse beside `lastSpinDate`. There is no second definition of "already taken
  // today" to keep in sync with this one, and a caller that runs twice is inert rather than paying
  // twice — see the warning on claimBonusDrop.
  save.bonusDropDay = day
  save.chips += drop.chips
  if (drop.boost) save.pendingBoosts.push(drop.boost)
  const room = Math.max(0, FREE_SPIN_BANK_CAP - (save.freeSpins || 0))
  const freeSpins = Math.min(drop.freeSpins, room)
  if (freeSpins > 0) save.freeSpins = (save.freeSpins || 0) + freeSpins
  return { drop, day, chips: drop.chips, freeSpins, boost: drop.boost, balance: save.chips }
}

/**
 * Take today's gift: one atomic load→check→award→persist. Returns null when there was nothing to
 * take, leaving the save untouched.
 *
 * AWARD-FIRST per the economy's iron rule 4, like `claimChapterCatchUp` and `claimInstallReward`:
 * the chips are banked and the latch written BEFORE the card opens, so a force-quit mid-card loses
 * nothing and a re-open re-offers nothing. ⚠️ The claim latch is the ONLY latch — never gate the
 * card on its own "have I shown this" flag as well, or the two will disagree and a player will
 * watch a gift they were already paid be offered again.
 */
export function claimBonusDrop(now = new Date()): BonusDropGrant | null {
  const save = loadSave()
  const grant = grantBonusDrop(save, now)
  if (!grant) return null
  persistSave(save)
  return grant
}

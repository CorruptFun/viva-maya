import { LIVES_MAX } from '../config'
import type { SaveData } from './save'
import { addFreeSpins, freeSpinRoom, loadSave, persistSave } from './save'

/**
 * CHARMS — the collectible. Pure logic (no Phaser), mirroring core/daily.ts and core/store.ts.
 *
 * Everything the game gives out so far is CONSUMED: chips are spent, boosts are burned on the next
 * level, free spins are pulled. Nothing accumulates into something you OWN. A charm is the first
 * reward that just… stays. You collect a SERIES of nine, the album fills in, and completing it pays a
 * purse and opens the next series.
 *
 * Charms come from exactly one place — the HEART card in the Lucky Deal (core/deal.ts) — which is
 * what keeps the faucet bounded and legible: one source, one rarity weight, no second path to audit.
 *
 * ── What a charm DOES (why this isn't just a sticker album) ───────────────────
 * Every charm you own is +1 LUCK, and luck reweights the Lucky Deal's own prize table toward the
 * richer cards (see core/deal.ts `luckWeights`). So the collection compounds: the more charms you
 * have, the better the game that hands out charms gets.
 *
 * That loop is deliberately SELF-CONTAINED. Luck touches the Deal's prize roll and NOTHING else — not
 * the board, not the level curve, not scoring, not endless. So it cannot drift level difficulty, and
 * it cannot reach the weekly race (whose whole constitution is that every player gets the same board
 * with no boosts — SOCIAL_AND_ECONOMY.md iron rule #2). A collection that buffed the board would have
 * had to be argued against that rule forever; one that buffs only its own mini game never does.
 *
 * ── Why the luck cap, and why it counts ALL-TIME ─────────────────────────────
 * Luck reads `charmsAllTime`, not the current album, and is capped at LUCK_CAP. Two reasons:
 *
 *  • Counting the CURRENT album would make completing a series feel like a punishment — the purse
 *    lands and your luck instantly drops to zero as the album resets. Monotone all-time counting means
 *    finishing a series is pure upside.
 *  • The cap is what stops it running away. Uncapped, a long-term player's table would drift until
 *    the cheap cards effectively vanish, which quietly turns a fixed-size faucet into a growing one —
 *    the exact failure iron rule #1 exists to prevent. LUCK_CAP is one series' worth, so the ceiling
 *    is reached at a legible milestone ("complete the first album") and never moves again.
 */

/** One collectible charm — the emoji IS the art (system emoji, like the board symbols). */
export interface Charm {
  id: string
  emoji: string
  /** Display name, shown in the album and on the reveal card. */
  label: string
}

/**
 * The nine charms of a series, in album order (reads left→right, top→bottom in a 3×3 grid — the same
 * shape as the Deal's card grid, so the two screens rhyme).
 *
 * Chosen as TRINKETS, deliberately NOT reusing the six board symbols (🍒 7 💎 🔔 🍀 bar). A charm has
 * to read as a keepsake you own rather than a game piece you cleared — if the album were full of the
 * same cherries the board is full of, it would look like a stats screen instead of a bracelet. The
 * heart lands last because it is the game's own emblem (the Maya motif the marquee and the ♥ watermarks
 * already carry), which makes the ninth slot the one you actually chase.
 */
export const CHARMS: Charm[] = [
  { id: 'clover', emoji: '🍀', label: 'CLOVER' },
  { id: 'ladybug', emoji: '🐞', label: 'LADYBUG' },
  { id: 'star', emoji: '🌟', label: 'STAR' },
  { id: 'key', emoji: '🗝️', label: 'KEY' },
  { id: 'moon', emoji: '🌙', label: 'MOON' },
  { id: 'ribbon', emoji: '🎀', label: 'RIBBON' },
  { id: 'butterfly', emoji: '🦋', label: 'BUTTERFLY' },
  // A mushroom, not the nazar eye it replaced: the album draws every UNOWNED charm as a flat-tinted
  // silhouette so the player can see WHICH one is still missing, and 🧿 silhouettes to a featureless
  // circle — the one slot in the grid that told you nothing. Any charm added here has to survive that
  // treatment, so pick glyphs with an outline (a Glückspilz is a real luck charm and has one).
  { id: 'mushroom', emoji: '🍄', label: 'MUSHROOM' },
  { id: 'heart', emoji: '❤️', label: 'HEART' },
]

/** Charms in one series — the album is a 3×3 grid, so this is CHARMS.length by construction. */
export const SERIES_SIZE = CHARMS.length

/**
 * Chips a DUPLICATE charm pays instead.
 *
 * A collectible whose duplicate is a blank is the genre's oldest self-inflicted wound: the rarest card
 * in the deck lands, the album says "already yours", and the best outcome in the game becomes the
 * worst feeling in it. Priced at roughly a level win (~25–45) so a dupe is a genuinely good result on
 * its own terms — you wanted the charm, but you were not robbed.
 *
 * It also cannot be farmed into a problem: a dupe needs a HEART card (3 weight of the Deal's table),
 * which needs a Deal, which needs a three-win streak. Bounded by the trigger, not by a special case.
 */
export const DUPLICATE_CHIPS = 40

/**
 * The purse for completing a nine-charm series.
 *
 * Sized between the referral reward (300) and the weekly champion purse (1,000): completing an album
 * should be one of the game's real paydays without touching the champion's status as the biggest
 * single prize. It is a FIXED grant behind a nine-charm wall, so it stays inflation-safe regardless
 * of player count — the same property every faucet in SOCIAL_AND_ECONOMY.md holds.
 */
export const SERIES_PURSE = 500

/**
 * Ceiling on LUCK. One full series' worth, so the cap is reached exactly when the first album
 * completes — a milestone the player can see coming, rather than an invisible plateau.
 */
export const LUCK_CAP = SERIES_SIZE

// ─────────────────────────────────────────────────────────────────────────────
// THE EXCHANGE — spending charms.
//
// The album on its own gives a charm one payoff (LUCK) and one goal (the ninth slot), both of them
// slow. The exchange adds a near-term one: charms are a CURRENCY, and there is a small shelf you can
// dip into any time. That turns a collection you passively watch fill into a thing you make decisions
// about — bank a reward now, or hold the set for the purse.
//
// ── What it sells, and why not chips ─────────────────────────────────────────
// Only things the CHIP economy cannot sell: a bonus-wheel pull, an instant heart refill, and a Deal
// on demand. Chips already have a shop (the Gift Store) and a completed series already pays chips, so
// putting chips on this shelf too would put the exchange in direct competition with completing the
// album — the player would just be picking the better chips-per-charm rate, and one of the two would
// always be strictly wrong. Selling a different KIND of thing keeps both worth doing: the exchange is
// "I want something now", completing is "I want the payday and a fresh album".
//
// ── Spending never costs you luck ────────────────────────────────────────────
// Prices come out of the CURRENT album (`save.charms`), never out of `charmsAllTime` — so LUCK, which
// reads all-time, is untouched by anything you spend. That is the property that makes the shelf safe
// to use: the worst a purchase can do is set back the ninth slot, and it can never make the Deal
// stingier than it was this morning. The panel says so out loud.
// ─────────────────────────────────────────────────────────────────────────────

/** What an exchange slot hands over. 'deal' is the only one the caller (not this module) fulfils. */
export type CharmExchangeKind = 'spin' | 'hearts' | 'deal'

export interface CharmExchangeItem {
  kind: CharmExchangeKind
  label: string
  blurb: string
  /** Charms it costs, taken from the current album. */
  price: number
}

/**
 * The shelf, cheapest → priciest.
 *
 * Priced against how fast charms actually arrive (~2.5 per 100 wins — see the HEART note in
 * core/deal.ts): one charm is a couple of hours of play, so a 1–3 charm ladder is a shelf you can
 * reach within a session or two rather than a wall. Deliberately shallow — nine charms buy the
 * SERIES_PURSE, so nothing here may cost enough to make completing an album feel like the mug's game.
 */
export const CHARM_EXCHANGE: CharmExchangeItem[] = [
  { kind: 'spin', label: 'FREE SPIN', blurb: 'One pull of the bonus wheel', price: 1 },
  { kind: 'hearts', label: 'FULL HEARTS', blurb: 'Refill your lives right now', price: 2 },
  { kind: 'deal', label: 'DEAL NOW', blurb: 'Play a Lucky Deal — no streak needed', price: 3 },
]

/** What a redemption actually did, so the caller can celebrate it honestly. */
export interface CharmRedemption {
  item: CharmExchangeItem
  /** Charm ids taken out of the album — the slots the panel should empty. */
  spent: string[]
  /** Charms left in the album afterwards. */
  charmsLeft: number
  /** Free spins ACTUALLY banked (0 for every other kind). */
  spins: number
}

/** True when the album can currently afford this item. Cheap enough to call while painting. */
export function canAfford(save: SaveData, item: CharmExchangeItem): boolean {
  return save.charms.length >= item.price
}

/**
 * Redeem an exchange item: take its price out of the album and hand over the goods.
 *
 * `dayKey` is daily.todayKey() — passed IN rather than imported so this module stays dependency-light
 * (charms.ts is imported by core/deal.ts, and reaching back into daily.ts from here would tangle the
 * three for one string).
 *
 * Returns null and leaves the save completely untouched when the album can't afford it, or when the
 * reward can't be honoured — a spin whose bank is already full REFUSES rather than quietly eating the
 * charms, the same "never advertise what you can't pay" rule the BELL and the plinko wells follow.
 *
 * ORDERING: the reward is granted BEFORE the charms are taken. Each call re-reads the save so they
 * compose, and doing it this way means the only crash window leaves the player holding the reward AND
 * the charms rather than neither — the same direction of error the champion purse and the free-spin
 * bank already choose (worst case a player is over-paid; never under-paid).
 *
 * Charms are spent NEWEST-FIRST (`slice(-price)` over the acquisition-ordered array), so the ones you
 * have held longest are the ones that survive.
 */
export function redeemCharms(item: CharmExchangeItem, dayKey: string): CharmRedemption | null {
  if (!canAfford(loadSave(), item)) return null
  if (item.kind === 'spin' && freeSpinRoom(dayKey) <= 0) return null

  let spins = 0
  if (item.kind === 'spin') {
    spins = addFreeSpins(1, dayKey)
    if (spins <= 0) return null // the bank filled between the check and the grant — charge nothing
  }

  const save = loadSave()
  // Re-check after the grant: `addFreeSpins` re-read the save, so this is the one place a concurrent
  // write could have moved the album underneath us.
  if (save.charms.length < item.price) return null
  const spent = save.charms.slice(save.charms.length - item.price)
  save.charms = save.charms.slice(0, save.charms.length - item.price)
  if (item.kind === 'hearts') {
    save.lives = LIVES_MAX
    save.livesAnchor = 0
  }
  persistSave(save)
  return { item, spent, charmsLeft: save.charms.length, spins }
}

/** Charms owned in the CURRENT series, in album order (locked slots omitted). */
export function ownedCharms(save: SaveData): Charm[] {
  return CHARMS.filter(c => save.charms.includes(c.id))
}

/** True when this charm is already in the current album. */
export function hasCharm(save: SaveData, id: string): boolean {
  return save.charms.includes(id)
}

/** Charms still missing from the current album, in album order. */
export function missingCharms(save: SaveData): Charm[] {
  return CHARMS.filter(c => !save.charms.includes(c.id))
}

/** True once every charm in the current series is collected. */
export function seriesComplete(save: SaveData): boolean {
  return missingCharms(save).length === 0
}

/**
 * LUCK — the compounding reward for collecting, read by core/deal.ts to reweight the prize table.
 * Monotone in all-time charms and hard-capped at LUCK_CAP (see the header for why both).
 */
export function luckOf(save: SaveData): number {
  return Math.max(0, Math.min(LUCK_CAP, Math.floor(save.charmsAllTime)))
}

/**
 * Which charm a HEART card pays.
 *
 * ALWAYS a charm the player is missing, drawn uniformly from the gaps — never a blind roll over all
 * nine. A blind roll would make the last slot of an album take ~9 hearts to fill on average (the
 * coupon-collector tail), so the closer you got to completing a series the worse the game would treat
 * you. Drawing from the gaps means every heart is progress and the ninth charm is as reachable as the
 * first, which is what makes the album feel finishable rather than rigged against you.
 *
 * Returns null only when the album is already full — the caller (grantCharm) turns that into the
 * duplicate payout, which is the one case a heart cannot advance the collection.
 */
export function rollCharm(save: SaveData, rng: () => number): Charm | null {
  const gaps = missingCharms(save)
  if (gaps.length === 0) return null
  return gaps[Math.min(gaps.length - 1, Math.floor(rng() * gaps.length))]
}

/** What a HEART card actually paid, so the celebration can be sized honestly. */
export type CharmAward =
  /** A new charm went into the album. `completed` is set when it was the ninth. */
  | { kind: 'charm'; charm: Charm; owned: number; series: number; completed: false }
  | { kind: 'charm'; charm: Charm; owned: number; series: number; completed: true; purse: number; balance: number }
  /** The album was already full and the heart paid chips instead. */
  | { kind: 'duplicate'; chips: number; balance: number }

/**
 * Award a charm — ONE atomic load→grant→persist, like save.claimChampionship and store.buyBoost, so a
 * crash can never bank half of a completion (the charm without the purse, or the purse without the
 * series roll-over).
 *
 * AWARD-FIRST, per iron rule #4: the caller banks this BEFORE the reveal animation, so closing the app
 * mid-celebration keeps the charm. The view is replaying a settled result, exactly like the plinko
 * drop and the jackpot wheel.
 *
 * Completing the ninth slot does three things in the same write: pays SERIES_PURSE, clears the album,
 * and advances `charmSeries`. `charmsAllTime` is never cleared — it is the all-time count LUCK reads,
 * so a completed series leaves the player strictly better off than before it (see the header).
 */
export function grantCharm(rng: () => number): CharmAward {
  const save = loadSave()
  const charm = rollCharm(save, rng)
  if (!charm) {
    save.chips += DUPLICATE_CHIPS
    persistSave(save)
    return { kind: 'duplicate', chips: DUPLICATE_CHIPS, balance: save.chips }
  }
  save.charms.push(charm.id)
  save.charmsAllTime += 1
  const series = save.charmSeries
  if (save.charms.length >= SERIES_SIZE) {
    save.chips += SERIES_PURSE
    save.charms = []
    save.charmSeries += 1
    persistSave(save)
    return { kind: 'charm', charm, owned: SERIES_SIZE, series, completed: true, purse: SERIES_PURSE, balance: save.chips }
  }
  persistSave(save)
  return { kind: 'charm', charm, owned: save.charms.length, series, completed: false }
}

/** Roman numeral for a 1-based series number — the album's "SERIES III" plate. Falls back past XX. */
export function seriesLabel(n: number): string {
  const numerals: [number, string][] = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let left = Math.max(1, Math.floor(n))
  if (left > 39) return String(left)
  let out = ''
  for (const [value, glyph] of numerals) {
    while (left >= value) {
      out += glyph
      left -= value
    }
  }
  return out
}

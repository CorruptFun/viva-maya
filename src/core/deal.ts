import { rollPrize } from './daily'
import type { Rng } from './rng'
import type { SaveData } from './save'
import { LUCK_CAP } from './charms'
import type { BoostType } from './types'

/**
 * LUCKY DEAL — the card pick'em. Pure logic (no Phaser), like core/plinko.ts and core/jackpot.ts.
 *
 * Nine cards face-down. Tap to turn one; every card pays a small chip pip, and the moment a THIRD
 * card of the same face turns over, that face pays its headline prize and the round ends.
 *
 * ── Why this and not a fourth spectacle ──────────────────────────────────────
 * The build already had three casino set-pieces — the daily slot cabinet, the jackpot wheel, and the
 * plinko drop — and all three are things you WATCH. You arm them by playing well, press one button,
 * and the machine performs. There was no reward anywhere in the game where the player's hand chose
 * anything. The Deal is that: you pick the cards, in your order, and you can read the board as the
 * pairs pile up.
 *
 * ── THE RIG, and why the choice is still real ────────────────────────────────
 * AWARD-FIRST like every other prize surface here (iron rule #4): `rollFace` picks the winning face
 * and the caller banks the prize BEFORE a single card turns. What makes that compatible with genuine
 * picking is the deck construction in `buildDeck`:
 *
 *   the deck holds EXACTLY THREE of the winning face, and AT MOST TWO of every other.
 *
 * So the winner is the only face that CAN reach three. Whatever order the player turns cards in, the
 * first face to hit three is the face that was rolled before they touched anything — no reveal ever
 * has to be quietly rewritten to steer the result, which is the trick a naive implementation reaches
 * for and the reason those always eventually feel crooked. Every card shown is the card that was
 * dealt. This is exactly the discipline plinko's `dropPath` uses: settle the outcome, then synthesise
 * a presentation that is PROVABLY consistent with it.
 *
 * It also buys the tension for free. Turn two hearts and no third can exist unless hearts is the
 * winner — so a pair is a live question rather than decoration, and the last unturned card in a deck
 * of eight knowns is a genuine held breath.
 *
 * ── Pace ─────────────────────────────────────────────────────────────────────
 * With three winners among nine cards the third one lands on the 7.5th flip on average, so a round is
 * about seven taps and a few seconds. Every tap pays a pip, which is what keeps a seven-tap round
 * feeling fast rather than long: there is no such thing as a dead card.
 */

/** The seven card faces. Six are the board's own symbols; HEART is the game's emblem and the rare one. */
export type DealFaceId = 'cherry' | 'clover' | 'bell' | 'bar' | 'diamond' | 'seven' | 'heart'

/** What a face pays when three of it turn over. */
export type DealPrize =
  | { kind: 'chips'; chips: number }
  | { kind: 'spin'; spins: number }
  | { kind: 'boost' }
  | { kind: 'charm' }

export interface DealFace {
  id: DealFaceId
  label: string
  /** Chips paid just for turning this card over — the "no dead taps" trickle. */
  pip: number
  prize: DealPrize
  /** Weight at LUCK 0. The base and lucky tables each sum to 100, so a weight reads as a percentage. */
  weight: number
  /** Weight at LUCK_CAP. `luckWeights` lerps between the two. */
  luckyWeight: number
}

/**
 * The card table, cheapest → richest.
 *
 * Both weight columns sum to 100 — the same property PLINKO_SLOTS holds, and worth keeping for the
 * same reason: every number in the table reads directly as "how often this happens", so tuning it
 * never needs a calculator and a typo is visible on inspection.
 *
 * Values are priced against a level win (~25–45 chips): the two commonest cards pay about one win,
 * the rare ones pay several, and the HEART pays the only thing in the game you keep.
 */
export const DEAL_FACES: DealFace[] = [
  { id: 'cherry', label: 'CHERRY', pip: 1, prize: { kind: 'chips', chips: 25 }, weight: 19, luckyWeight: 9 },
  { id: 'clover', label: 'CLOVER', pip: 1, prize: { kind: 'chips', chips: 40 }, weight: 22, luckyWeight: 16 },
  { id: 'bell', label: 'BELL', pip: 2, prize: { kind: 'spin', spins: 1 }, weight: 16, luckyWeight: 16 },
  { id: 'bar', label: 'BAR', pip: 2, prize: { kind: 'chips', chips: 60 }, weight: 14, luckyWeight: 16 },
  { id: 'diamond', label: 'DIAMOND', pip: 2, prize: { kind: 'boost' }, weight: 12, luckyWeight: 13 },
  { id: 'seven', label: 'SEVEN', pip: 3, prize: { kind: 'chips', chips: 120 }, weight: 7, luckyWeight: 12 },
  { id: 'heart', label: 'HEART', pip: 4, prize: { kind: 'charm' }, weight: 10, luckyWeight: 18 },
]

/**
 * ── Why the HEART is 10% and not the 3% it shipped at ────────────────────────
 *
 * At 3% the card was priced as a lottery, which was right when a charm was only a keepsake with a
 * passive luck bonus attached — rare, delightful, no hurry. Charms are now a SPENDABLE currency (the
 * exchange in core/charms.ts), and a currency has to arrive at a rate you can plan around or the shop
 * it buys from is decoration.
 *
 * The arithmetic: a Deal needs three consecutive wins, so a player winning steadily sees roughly one
 * Deal per 3–4 wins, call it ~25 Deals per 100 levels cleared once losses are taken into account. At
 * 3% that is well under one charm per 100 wins — several hours of play per charm, and a nine-charm
 * album measured in months. An exchange whose cheapest item costs a charm would have been unreachable
 * for weeks, which is worse than not shipping one.
 *
 * At 10% (18% at full luck) it lands near 2.5 charms per 100 wins: an exchange item every couple of
 * hours of play, a first album over a few weeks. Still the rarest thing the Deal can pay — the SEVEN
 * at 7% is the only card below it — and still the top of the value ladder.
 *
 * The weight came off the CHERRY (26 → 19), the cheapest card on the table, so the chip EV of a hand
 * barely moves and the change costs the economy nothing.
 */

/** Cards on the table — a 3×3 grid, the same shape as the charm album so the two screens rhyme. */
export const DEAL_CARDS = 9

/** Copies of the winning face in the deck. THE invariant: no other face may reach this count. */
export const DEAL_MATCH = 3

/** Consecutive numbered-level wins that deal a hand. */
export const DEAL_STREAK = 3

/**
 * Turn the third match in this many flips or fewer and the deal pays a FAST DEAL bonus on top.
 *
 * The three winners sit uniformly among the nine cards, so the chance of all three landing inside the
 * first four is C(4,3)/C(9,3) = 4/84 ≈ 4.8% — rare enough to be a genuine "did that just happen",
 * cheap enough (≈2.4 chips of expected value) that it cannot matter to the economy. It is pure luck
 * with no way to play for it, which is the point: it is the table's own applause.
 */
export const FAST_DEAL_FLIPS = 4
export const FAST_DEAL_CHIPS = 50

/**
 * What the BELL is restruck as when a free spin cannot be paid (the spin bank is full).
 *
 * Same rule plinko's ticket wells answer to, and adopted here for the same reason: a face the player
 * can see has to be a face the player can win. Blanking the weight instead would leave a BELL sitting
 * on the table advertising a prize that could never land, with nothing on screen saying so. Priced
 * between the CLOVER and the BAR either side of it so the ladder still climbs left to right.
 */
export const BELL_SUBSTITUTE_CHIPS = 50

/**
 * The EFFECTIVE face table. `allowSpins` false → the BELL pays chips instead, keeping its weight, so
 * the table still sums to 100 and every face on the table is winnable.
 */
export function dealFaces(allowSpins: boolean): DealFace[] {
  if (allowSpins) return DEAL_FACES
  return DEAL_FACES.map(f =>
    f.prize.kind === 'spin' ? { ...f, prize: { kind: 'chips', chips: BELL_SUBSTITUTE_CHIPS } as DealPrize } : f
  )
}

/**
 * The face table reweighted by LUCK — a straight lerp from each face's `weight` to its `luckyWeight`,
 * by `luck / LUCK_CAP`.
 *
 * Lerping between two hand-authored tables (rather than applying a multiplier per tier) is what makes
 * this safe to own: the result can never leave the interval between two tables that were both checked
 * by eye, it is monotone in luck by construction, and because both endpoints sum to 100 so does every
 * point between them. At full luck the HEART goes 3% → 8% and the CHERRY 26% → 14% — the collection
 * visibly pays for itself without the cheap cards ever disappearing.
 */
export function luckWeights(faces: DealFace[], luck: number): number[] {
  const t = Math.max(0, Math.min(1, luck / LUCK_CAP))
  return faces.map(f => f.weight + (f.luckyWeight - f.weight) * t)
}

/**
 * Weighted pick of the winning face — cumulative-weight selection, the same shape as
 * plinko.rollSlotIndex and jackpot.rollWheelIndex. The caller banks this face's prize, then
 * `buildDeck` lays out a deck in which only this face can reach three.
 */
export function rollFace(rng: Rng, allowSpins: boolean, luck = 0): DealFace {
  const faces = dealFaces(allowSpins)
  const weights = luckWeights(faces, luck)
  const total = weights.reduce((sum, w) => sum + w, 0)
  let roll = rng() * total
  for (let i = 0; i < faces.length; i++) {
    roll -= weights[i]
    if (roll < 0) return faces[i]
  }
  return faces[0] // defensive (float drift): the table is never empty
}

/** Fisher-Yates on the caller's seeded stream — shared by the deck fill and the final shuffle. */
function shuffle<T>(rng: Rng, items: T[]): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * How often the filler prefers to lay a PAIR of a decoy face rather than a single.
 *
 * Not a cosmetic knob. A deck padded with six different singletons has no tension in it at all — the
 * player turns six cards that visibly cannot go anywhere and then the winner arrives on schedule.
 * Pairs are what make a turn matter: a second CHERRY poses a real question (is cherry the face that
 * has three?) that the deck genuinely answers. Biasing toward pairs at ~0.6 gives a typical hand two
 * or three live decoys.
 */
const PAIR_BIAS = 0.62

/**
 * THE DECK. Three of `winner`, at most two of anything else, shuffled — the construction the whole
 * award-first design rests on (see the header).
 *
 * The filler walks the shuffled decoy faces taking one or two of each until the six remaining slots
 * are full, and takes two whenever there are more slots left than faces left. That guard is
 * load-bearing: without it a run of singles can strand the fill needing three cards from one face,
 * and the ≤2 invariant — the thing that makes the winner the only face able to reach three — would
 * have to be broken to finish the deck. With it, feasibility is guaranteed at every step (six slots,
 * six decoy faces, capacity two each), so the invariant holds for every seed. Both properties are
 * asserted over a fuzz sweep in deal.test.ts.
 */
export function buildDeck(rng: Rng, winner: DealFaceId, faces: DealFace[] = DEAL_FACES): DealFaceId[] {
  const deck: DealFaceId[] = Array.from({ length: DEAL_MATCH }, () => winner)
  const decoys = shuffle(
    rng,
    faces.filter(f => f.id !== winner).map(f => f.id)
  )
  let slots = DEAL_CARDS - DEAL_MATCH
  for (let i = 0; i < decoys.length && slots > 0; i++) {
    const facesLeft = decoys.length - i
    const mustPair = slots > facesLeft // singles from here can't fill the deck — take two
    const take = Math.min(slots, mustPair || rng() < PAIR_BIAS ? 2 : 1)
    for (let k = 0; k < take; k++) deck.push(decoys[i])
    slots -= take
  }
  return shuffle(rng, deck)
}

/** A dealt hand: the settled winning face and the face-down deck that proves it. */
export interface DealHand {
  face: DealFace
  deck: DealFaceId[]
  /** LUCK the hand was rolled at — shown on the cabinet so the collection's effect is visible. */
  luck: number
}

/**
 * Deal a hand: roll the winner over the luck-weighted table, then build a deck only that face can
 * win. Nothing is banked here — the caller pays `hand.face.prize` (award-first) before animating.
 */
export function dealHand(rng: Rng, allowSpins: boolean, luck = 0): DealHand {
  const faces = dealFaces(allowSpins)
  const face = rollFace(rng, allowSpins, luck)
  return { face, deck: buildDeck(rng, face.id, faces), luck }
}

/**
 * Index of the card that COMPLETES the match — the flip at which the round ends, given the player
 * turned cards in `order`. Returns -1 if the order never completes it (only possible for a partial
 * order, since a full deck always contains three of the winner).
 *
 * The view uses this to know when to stop accepting taps; the tests use it to assert that EVERY
 * possible pick order resolves to the rolled face and no other.
 */
export function matchAt(deck: DealFaceId[], order: number[], winner: DealFaceId): number {
  let seen = 0
  for (let i = 0; i < order.length; i++) {
    if (deck[order[i]] === winner) seen++
    if (seen >= DEAL_MATCH) return i
  }
  return -1
}

/** Chips the pips paid across `flips` turned cards. */
export function pipTotal(deck: DealFaceId[], order: number[], flips: number, faces: DealFace[] = DEAL_FACES): number {
  let total = 0
  for (let i = 0; i < Math.min(flips, order.length); i++) {
    const face = faces.find(f => f.id === deck[order[i]])
    if (face) total += face.pip
  }
  return total
}

/** True when the hand matched fast enough to earn the FAST DEAL bonus. `flips` is 1-based. */
export function fastDeal(flips: number): boolean {
  return flips > 0 && flips <= FAST_DEAL_FLIPS
}

/** Everything a finished round paid, so the caller banks once and the view celebrates honestly. */
export interface DealPayout {
  face: DealFace
  /** Chips from the headline prize (0 when it paid a spin/boost/charm). */
  prizeChips: number
  /** Chips from the pips on every turned card. */
  pipChips: number
  /** The FAST DEAL bonus, or 0. */
  fastChips: number
  /** Total chips to bank. */
  chips: number
  /** Free spins to bank (0 unless the BELL paid and spins were allowed). */
  spins: number
  /** The boost the DIAMOND rolled, or null. */
  boost: BoostType | null
  /** True when the HEART paid — the caller grants the charm (core/charms.ts grantCharm). */
  charm: boolean
  /** Flips the player took to complete the match (1-based). */
  flips: number
  fast: boolean
}

/**
 * Total up a finished round. Pure — banks nothing; the caller applies it in one atomic write so a
 * crash can never pay half a hand.
 *
 * The DIAMOND's boost is rolled from the DAILY prize table rather than being a fixed type, so the
 * card stays a small surprise of its own and there is exactly one boost-weighting table in the build
 * to keep tuned (core/daily.ts PRIZES).
 */
export function settleDeal(hand: DealHand, order: number[], flips: number, rng: Rng): DealPayout {
  const prize = hand.face.prize
  const prizeChips = prize.kind === 'chips' ? prize.chips : 0
  // DEAL_FACES, not the effective table: the BELL substitution rewrites a face's PRIZE and nothing
  // else, so pips are identical in both and the base table is always the right one to price them from.
  const pipChips = pipTotal(hand.deck, order, flips)
  const fast = fastDeal(flips)
  const fastChips = fast ? FAST_DEAL_CHIPS : 0
  return {
    face: hand.face,
    prizeChips,
    pipChips,
    fastChips,
    chips: prizeChips + pipChips + fastChips,
    spins: prize.kind === 'spin' ? prize.spins : 0,
    boost: prize.kind === 'boost' ? rollPrize(rng).type : null,
    charm: prize.kind === 'charm',
    flips,
    fast,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HOT STREAK — the trigger.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True when this streak deals a hand — every DEAL_STREAK consecutive wins.
 *
 * A new axis on purpose. Plinko keys off CASCADE DEPTH (how well you played one board), the wheel off
 * TOTAL WINS (how much you have played), the daily spin off the CALENDAR (that you came back). None
 * of them care whether you keep winning, so nothing in the game was ever riding on the next level in
 * particular. A streak is the one trigger a loss can take away from you, which is what finally gives
 * losing a cost — and it costs you momentum, never anything you had already earned. That distinction
 * is what keeps it inside the game's mercy rule rather than around it.
 */
export function dealReady(streak: number): boolean {
  return streak > 0 && streak % DEAL_STREAK === 0
}

/** Wins still needed for the next deal — the "2 MORE WINS" readout on Home and the win card. */
export function winsToDeal(streak: number): number {
  const into = Math.max(0, Math.floor(streak)) % DEAL_STREAK
  return DEAL_STREAK - into
}

/** LUCK the next hand will roll at, read straight from the save (core/charms.ts owns the cap). */
export function dealLuck(save: SaveData): number {
  return Math.max(0, Math.min(LUCK_CAP, Math.floor(save.charmsAllTime)))
}

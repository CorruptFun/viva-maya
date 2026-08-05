import type { BoostType } from './types'
import { CHAPTER_COUNT, CHAPTER_LEVELS } from './levels'
import { loadSave, persistSave, type SaveData } from './save'

/**
 * CHAPTER TROPHIES — the reward for finishing a chapter. Pure logic (no Phaser), mirroring
 * core/charms.ts and core/daily.ts.
 *
 * Chapters existed for a month as labels that paid nothing: the level map draws a ribbon every ten
 * levels and the win flow plays a text splash, and neither grants a thing. This module makes a
 * chapter close mean something, three ways at once:
 *
 *  • a TROPHY — a permanent keepsake on a plinth in THE SHOWROOM (view/showroom.ts). Charms are the
 *    game's collectible you can spend; trophies are the one thing you can only EARN and never lose.
 *  • a PURSE — a one-time chip grant per chapter (CHAPTER_PURSES). Thirty fixed grants per player
 *    lifetime, so the faucet is bounded by construction — the same inflation-safety argument as the
 *    referral reward and the charm-series purse, sized between them.
 *  • on milestone chapters, a BOOST for the next numbered level (CHAPTER_BOOSTS → pendingBoosts;
 *    endless never consumes pendingBoosts, so the race's boost-free constitution is untouched).
 *
 * The claim latch is `save.chapterRewards` — the SAME list the showroom renders. One field carrying
 * both meanings is the whole design: the win-flow grant (GameScene.finishWin) and the Home catch-up
 * sweep (claimChapterCatchUp) can never disagree about what has been paid, and a crash between the
 * two is self-healing because the sweep claims whatever the win flow missed.
 *
 * AWARD-FIRST, per the iron rule every surface here follows: callers bank the grant BEFORE the
 * ceremony animates, so the reveal replays a settled result and a mid-celebration crash leaves the
 * player holding the prize.
 *
 * ── The showroom car ─────────────────────────────────────────────────────────
 * The catalogue escalates from prize-counter trinkets to the casino showroom floor, and chapter 30
 * is THE CAR — the grand prize on the rotating plinth, visible (as a silhouette) from the first time
 * the showroom opens. Chapter 29 pays the wheels. The owner's brief was "it should feel like winning
 * a car"; here it literally is one.
 */

/** One showroom trophy — like a Charm, the emoji IS the art (system emoji, baked to textures). */
export interface ChapterTrophy {
  /** 1-based chapter this trophy is the prize for. */
  chapter: number
  emoji: string
  /** Display name, ALL-CAPS short, shown on the plinth caption and the ceremony card. */
  label: string
}

/**
 * The thirty trophies, chapter order. Every glyph must survive the showroom's locked treatment — a
 * flat navy silhouette (the same rule that swapped the charms' nazar eye for a mushroom): pick
 * shapes with an outline, and verify any change under the `?showroom` fixture before shipping it.
 * Deliberately reuses NO board symbol, charm, boost icon, or rank glyph (👑 is the race champion's,
 * 🥉🥈🥇🏆🏎️ are the leaderboard tier ladder below).
 */
export const TROPHIES: readonly ChapterTrophy[] = [
  // Not a coin: 🪙 silhouettes to a featureless disc — the one failure mode the locked treatment
  // cannot survive (verified under ?showroom). A piñata keeps chapter 1 celebratory and keeps its shape.
  { chapter: 1, emoji: '🪅', label: 'PARTY PIÑATA' },
  { chapter: 2, emoji: '🎯', label: 'GOLD DART' },
  { chapter: 3, emoji: '🛎️', label: 'VIP BELL' },
  { chapter: 4, emoji: '🍹', label: 'HOUSE COCKTAIL' },
  // Not a playing card: every card emoji silhouettes to a blank rectangle (same rule as chapter 1).
  { chapter: 5, emoji: '🎳', label: 'GOLD PIN' },
  { chapter: 6, emoji: '🎟️', label: 'GOLDEN TICKET' },
  { chapter: 7, emoji: '🧸', label: 'PRIZE BEAR' },
  { chapter: 8, emoji: '🎺', label: 'BRASS HORN' },
  { chapter: 9, emoji: '🎪', label: 'BIG TOP' },
  { chapter: 10, emoji: '🏅', label: 'GOLD MEDAL' },
  { chapter: 11, emoji: '🎸', label: 'GOLD GUITAR' },
  { chapter: 12, emoji: '🎤', label: 'SHOWTIME MIC' },
  { chapter: 13, emoji: '🎩', label: 'TOP HAT' },
  { chapter: 14, emoji: '🦩', label: 'NEON FLAMINGO' },
  { chapter: 15, emoji: '💰', label: 'MONEY BAG' },
  { chapter: 16, emoji: '⌚', label: 'GOLD WATCH' },
  { chapter: 17, emoji: '🕶️', label: 'STAR SHADES' },
  { chapter: 18, emoji: '💼', label: 'SILVER CASE' },
  { chapter: 19, emoji: '🛵', label: 'CITY SCOOTER' },
  { chapter: 20, emoji: '💍', label: 'DIAMOND RING' },
  { chapter: 21, emoji: '🥂', label: 'CRYSTAL FLUTES' },
  // Not a rosette: 🏵️ silhouettes to a fuzzy disc (the chapter-1 coin failure again).
  { chapter: 22, emoji: '🏮', label: 'GRAND LANTERN' },
  { chapter: 23, emoji: '🎠', label: 'CAROUSEL HORSE' },
  { chapter: 24, emoji: '🦚', label: 'PALACE PEACOCK' },
  { chapter: 25, emoji: '👜', label: 'DESIGNER BAG' },
  { chapter: 26, emoji: '🔮', label: 'CRYSTAL ORB' },
  // Not a piano: 🎹 silhouettes to a filled square — the keys only exist in colour.
  { chapter: 27, emoji: '🎻', label: 'GOLD VIOLIN' },
  { chapter: 28, emoji: '⛲', label: 'MARBLE FOUNTAIN' },
  // The wheels arrive one chapter before the car — the showroom's own near-miss tease.
  { chapter: 29, emoji: '🛞', label: 'SHOWROOM WHEELS' },
  { chapter: 30, emoji: '🏎️', label: 'THE CAR' },

  // ── ACT II · FLOOR 1 — THE HIGH-LIMIT ROOM (chapters 31–35) ────────────────────────────────
  // The escalation changes KIND here, not just size. Act I's shelf is prizes you were HANDED at a
  // counter; from 31 the shelf is the room itself — you are not winning trinkets any more, you are
  // furnishing the floor you play on. That is why chapter 31 is a chair: the whole fantasy of the
  // high-limit room is being allowed to sit down.
  { chapter: 31, emoji: '🪑', label: 'THE PRIVATE SEAT' },
  // The brass table lamp is also the floor's own mood flourish (view/floormood.ts) — the trophy is
  // literally the thing lighting your table.
  { chapter: 32, emoji: '🪔', label: 'THE BRASS LAMP' },
  { chapter: 33, emoji: '🪞', label: 'THE GILDED MIRROR' },
  { chapter: 34, emoji: '🍾', label: 'VINTAGE MAGNUM' },
  // FLOOR CLOSE — a crown piece. The crest is what the room hangs above its own door: proof you
  // belong to it, not another object inside it.
  { chapter: 35, emoji: '⚜️', label: 'THE CLUB CREST' },

  // ── ACT II · FLOOR 2 — THE SPEAKEASY (chapters 36–40) ──────────────────────────────────────
  // Not a coin, not a card, not a disco ball: 🪩 silhouettes to the same featureless circle the
  // chapter-1 note rejects. Every glyph below was checked under `?showroom=N`.
  { chapter: 36, emoji: '🍸', label: 'THE MARTINI' },
  { chapter: 37, emoji: '🎷', label: 'MIDNIGHT SAX' },
  { chapter: 38, emoji: '🎭', label: 'THE MASKS' },
  // The near-miss tease, exactly as the wheels precede the car: a candle at the end of a corridor is
  // a door you cannot see yet.
  { chapter: 39, emoji: '🕯️', label: 'THE BACK-ROOM CANDLE' },
  // FLOOR CLOSE — a crown piece.
  { chapter: 40, emoji: '🚪', label: 'THE HIDDEN DOOR' },
]

/** The trophy for a 1-based chapter, or null off the map (a merge from a newer build, garbage). */
export function trophyFor(chapter: number): ChapterTrophy | null {
  return TROPHIES[chapter - 1] ?? null
}

/**
 * One-time chip purse per chapter, chapter order. An escalating ladder with a step on every 5th
 * (the milestone chapters), sized against the game's fixed faucets: a level win pays ~25–45, the
 * referral reward is 300, a charm album 500, the weekly champion 1,000. Early chapters (a sitting
 * or two of play) pay a few wins' worth; the late-game grinds pay 300–400; chapter 30 pays a
 * champion purse exactly once per lifetime, so the weekly crown stays the biggest REPEATABLE prize.
 *
 * The lifetime total (CHAPTER_PURSE_TOTAL, 8,200) is what the economy actually grants a player who
 * finishes the game — fixed, one-time, identical for everyone, and therefore inflation-safe
 * regardless of player count. trophies.test.ts pins every value and the sum; retune them there.
 */
export const CHAPTER_PURSES: readonly number[] = [
  100, 100, 100, 100, 150, // ch 1–5
  150, 150, 150, 150, 250, // ch 6–10
  200, 200, 200, 200, 300, // ch 11–15
  250, 250, 250, 250, 400, // ch 16–20
  300, 300, 300, 300, 500, // ch 21–25
  400, 400, 400, 400, 1000, // ch 26–30
  // ── ACT II — FLAT WITH CROWNS, and the step DOWN at chapter 31 is deliberate ───────────────
  // Act I's ladder climbs because chips are the only currency it has. Act II stops climbing on
  // purpose: 250 flat, 400 on a floor close. Three reasons, in order of weight.
  //
  //  1. The chip faucet is a LIFETIME budget, not a per-chapter reward rate. Act I already grants
  //     8,200; continuing its slope through thirty more chapters would roughly double every price
  //     in the store's meaning without a single price changing.
  //  2. Nothing repeatable may top the weekly crown (1,000). Chapter 30's champion purse is a
  //     once-per-lifetime exception; a second ladder climbing toward it would make it ordinary.
  //  3. The act's real reward currency is arriving later — chips recede here so STARS can take
  //     over as the thing you spend upstairs. A flat chip line is what makes room for that.
  //
  // So the "never steps down across a band boundary" rule in trophies.test.ts is an ACT-LOCAL rule,
  // and the test says so. A step down BETWEEN acts is the design; a step down inside one is a bug.
  250, 250, 250, 250, 400, // ch 31–35  (F1 · THE HIGH-LIMIT ROOM, crown on the floor close)
  250, 250, 250, 250, 400, // ch 36–40  (F2 · THE SPEAKEASY, crown on the floor close)
]

/** Sum of the ladder — the whole feature's lifetime chip injection per player. Pinned by test. */
export const CHAPTER_PURSE_TOTAL: number = CHAPTER_PURSES.reduce((sum, n) => sum + n, 0)

/**
 * Milestone chapters also bank one boost for the next numbered level. Types are BOOST_META keys —
 * the canonical names — and the grant goes through `pendingBoosts` like every other boost source,
 * so the stash, the level-start consumption and the endless exclusion all apply unchanged.
 */
export const CHAPTER_BOOSTS: Readonly<Partial<Record<number, BoostType>>> = {
  5: 'extraMoves',
  10: 'wildReel',
  15: 'diceBomb',
  20: 'doubleScore',
  25: 'jackpot',
  30: 'jackpot',
  // Act II keeps the every-5th cadence. The ladder has TOPPED OUT rather than gone flat by
  // accident: `BOOST_META` holds five types and `jackpot` is the strongest of them, so the only
  // honest way to escalate further is a new boost type, not a bigger label on this one. (⚠️ And the
  // in-level HELPER shelf is not a boost — see the BOOST_META note in core/inventory.ts.)
  35: 'jackpot',
  40: 'jackpot',
}

// ─────────────────────────────────────────────────────────────────────────────
// LEADERBOARD TIERS — how the trophy shelf reads at 20px next to a race name.
//
// Thirty distinct glyphs cannot be legible in a board row, so the boards wear a five-step ladder
// instead. It starts at FIVE chapters deliberately: rows stay uncluttered while a board is mostly
// new players, and the first badge lands as an event (level 50) rather than furniture. The showroom
// itself shows every trophy from chapter 1.
// ─────────────────────────────────────────────────────────────────────────────

export interface TrophyTier {
  /** Minimum chapters completed to wear this badge. */
  min: number
  emoji: string
  label: string
}

/**
 * Descending, so the first match in order is the tier worn.
 *
 * ⚠️ A new rung is a ZERO-MIGRATION change, and that is not luck — it is why the ladder is derived
 * from `level_progress.cleared` instead of a badge column. A client running yesterday's bundle
 * simply saturates at the highest rung IT knows (a 40-chapter player wears 🏎️ on an old client and
 * 🎖️ on a new one); nothing is written, so nothing can disagree. Adding a rung upstairs therefore
 * needs no server work at all — which is the entire argument against a writable "flair" column.
 */
export const TROPHY_TIERS: readonly TrophyTier[] = [
  // ACT II opens the case up. The whole of Act I now fits under one rung, which is the point: at
  // forty chapters you are not a player who finished the game, you are a player who went upstairs.
  { min: 40, emoji: '🎖️', label: 'HIGH-ROLLER CASE' },
  { min: 30, emoji: '🏎️', label: 'THE CAR' },
  { min: 20, emoji: '🏆', label: 'CHAMPION CASE' },
  { min: 15, emoji: '🥇', label: 'GOLD CASE' },
  { min: 10, emoji: '🥈', label: 'SILVER CASE' },
  { min: 5, emoji: '🥉', label: 'BRONZE CASE' },
]

// ─────────────────────────────────────────────────────────────────────────────
// THE SHOWROOM'S WINGS — one per act.
//
// At forty chapters a single grid is eight rows and overflows the 720×1280 design box, so the
// showroom grew a tab rail instead of a taller card (its height is pinned at 1156 by the seats it
// has to fit under on Home and LevelSelect). One wing per ACT, each exactly `WING_CHAPTERS` wide,
// which keeps the grid at six rows forever however far the ladder runs.
//
// The wing also owns its own PODIUM PIECE, and that is where the car precedent is written down: the
// grand prize has always been visible from the first time the showroom opened, as a navy
// silhouette. A wing's hero may therefore name a chapter beyond the shipped catalogue — a prize you
// cannot reach yet is the same tease one act up, and it is the only honest way to answer "what is
// all this climbing FOR?" while the floors above are still being built.
// ─────────────────────────────────────────────────────────────────────────────

/** Chapters per wing — one act's worth. Six rows of five in the showroom grid, by construction. */
export const WING_CHAPTERS = 30

export interface TrophyWing {
  /** Stable id (analytics, default-tab logic). */
  id: 'main' | 'highRoller'
  /** Tab label on the showroom's header rail. */
  tab: string
  /** First and last chapter this wing displays — including ones the catalogue has not reached yet,
   *  which render as empty sockets. A floor plan of the act, with no design leaked. */
  chapterFrom: number
  chapterTo: number
  /** The act's grand prize on the podium. `chapter` may exceed `CHAPTER_COUNT` (see above); when it
   *  does NOT, `emoji`/`label` must match `trophyFor(chapter)` — pinned by test so the podium and
   *  the shelf can never tell two different stories about the same prize. */
  hero: { chapter: number; emoji: string; label: string; caption: string }
}

export const TROPHY_WINGS: readonly TrophyWing[] = [
  {
    id: 'main',
    tab: 'MAIN FLOOR',
    chapterFrom: 1,
    chapterTo: WING_CHAPTERS,
    hero: { chapter: 30, emoji: '🏎️', label: 'THE CAR', caption: 'GRAND PRIZE · CHAPTER 30' },
  },
  {
    id: 'highRoller',
    tab: 'HIGH-ROLLER WING',
    chapterFrom: WING_CHAPTERS + 1,
    chapterTo: WING_CHAPTERS * 2,
    hero: { chapter: 60, emoji: '🏛️', label: 'THE DEED', caption: 'GRAND PRIZE · CHAPTER 60' },
  },
]

/** The wing a 1-based chapter belongs to — what the LevelSelect ribbon doors use to pick a tab. */
export function wingForChapter(chapter: number): TrophyWing {
  return TROPHY_WINGS.find(w => chapter >= w.chapterFrom && chapter <= w.chapterTo) ?? TROPHY_WINGS[0]
}

/** Chapters whose trophy is an ACT's grand prize. The tier ladder is allowed to wear one of these
 *  (🏎️ at thirty chapters means "the car is yours" — wearing it IS owning it) and nothing else. */
export const GRAND_PRIZE_CHAPTERS: readonly number[] = TROPHY_WINGS.map(w => w.hero.chapter)

/** The badge worn at N chapters completed, or null below the first rung. */
export function trophyTier(chaptersDone: number): TrophyTier | null {
  if (!Number.isFinite(chaptersDone)) return null
  for (const tier of TROPHY_TIERS) if (chaptersDone >= tier.min) return tier
  return null
}

/**
 * Chapters fully completed at an `unlocked` value. `unlocked` is the highest ATTEMPTABLE level
 * (1-based), so chapter N is complete once level N×10 has been cleared, i.e. unlocked > N×10.
 * unlocked 10 → 0 chapters (level 10 not yet won), 11 → 1, 301 → 30. Clamped and garbage-safe
 * because this also runs on merged/foreign saves.
 */
export function chaptersCompleted(unlocked: number): number {
  if (!Number.isFinite(unlocked)) return 0
  return Math.max(0, Math.min(CHAPTER_COUNT, Math.floor((unlocked - 1) / CHAPTER_LEVELS)))
}

/**
 * Chapters completed from a `level_progress.cleared` value — the server-side twin of
 * `chaptersCompleted` (cleared = highest level WON, so no −1). This is the ONE place the
 * leaderboard's tier badges couple to the meaning of `cleared`: migration 0007's monotonic guard is
 * what makes a derived badge trustworthy, and a change to `cleared`'s semantics moves every badge.
 */
export function chaptersFromCleared(cleared: number): number {
  if (!Number.isFinite(cleared)) return 0
  return Math.max(0, Math.min(CHAPTER_COUNT, Math.floor(cleared / CHAPTER_LEVELS)))
}

/**
 * Chapters completed but not yet claimed, ascending — the catch-up sweep's work list. Non-empty for
 * exactly two kinds of player: anyone who was already past a boundary when this feature shipped
 * (the one-time back-fill), and anyone whose win-flow grant was lost to a crash or a merge race
 * (the self-healing net). Empty forever after for everyone else.
 */
export function unclaimedChapters(save: SaveData): number[] {
  const done = chaptersCompleted(save.unlocked)
  const claimed = new Set(save.chapterRewards)
  const out: number[] = []
  for (let c = 1; c <= done; c++) if (!claimed.has(c)) out.push(c)
  return out
}

/** What one chapter claim actually paid, so the ceremony can be sized honestly. */
export interface ChapterGrant {
  chapter: number
  trophy: ChapterTrophy
  purse: number
  /** The milestone boost banked to pendingBoosts, or null on a plain chapter. */
  boost: BoostType | null
  /** Chip balance AFTER the grant. */
  balance: number
}

/** Mutate `save` in place with chapter `c`'s full grant. Callers persist. */
function grantInto(save: SaveData, c: number): ChapterGrant {
  const trophy = trophyFor(c) as ChapterTrophy
  const purse = CHAPTER_PURSES[c - 1] ?? 0
  // Callers have already bounded `c` by CHAPTER_COUNT, and `trophies.test.ts` pins the catalogue to
  // exactly that length — so this cannot fire. It is here because the ONE way it could is the
  // failure mode the whole client-atomicity rule exists to prevent: a LEVEL_COUNT bump shipping
  // ahead of its catalogue. Better a chapter that quietly refuses to pay than a crash mid-ceremony.
  const boost = CHAPTER_BOOSTS[c] ?? null
  save.chapterRewards.push(c)
  save.chips += purse
  if (boost) save.pendingBoosts.push(boost)
  return { chapter: c, trophy, purse, boost, balance: save.chips }
}

/**
 * Claim one chapter's reward — ONE atomic load→check→grant→persist, like grantCharm and
 * claimChampionship, so a crash can never bank half of it (the trophy without the purse, or the
 * purse without the latch that stops it paying twice).
 *
 * Returns null — leaving the save completely untouched — when the chapter is off the map, already
 * claimed (this device or any synced one), or NOT ACTUALLY COMPLETED. That last guard is what makes
 * the latch safe under merges: a claim can only ever ride an `unlocked` that proves it, so no
 * device state can mint an unearned trophy.
 */
export function claimChapter(chapter: number): ChapterGrant | null {
  if (!Number.isInteger(chapter) || chapter < 1 || chapter > CHAPTER_COUNT) return null
  if (!trophyFor(chapter)) return null
  const save = loadSave()
  if (save.chapterRewards.includes(chapter)) return null
  if (chapter > chaptersCompleted(save.unlocked)) return null
  const grant = grantInto(save, chapter)
  persistSave(save)
  return grant
}

/** What the catch-up sweep paid, for the one summed card that presents it. */
export interface ChapterCatchUp {
  /** Every chapter granted by this sweep, ascending. */
  grants: ChapterGrant[]
  totalPurse: number
  /** Chip balance after the whole sweep. */
  balance: number
}

/**
 * Claim EVERY unclaimed completed chapter in one write — the Home-screen back-fill for players who
 * were already past boundaries when the feature shipped, and the recovery net thereafter. One load,
 * one persist: a crash mid-sweep grants either everything or nothing, never a partial page of
 * trophies. Returns null when there is nothing to claim (the everyday case).
 */
export function claimChapterCatchUp(): ChapterCatchUp | null {
  const save = loadSave()
  const pending = unclaimedChapters(save)
  if (pending.length === 0) return null
  const grants = pending.map(c => grantInto(save, c))
  persistSave(save)
  return {
    grants,
    totalPurse: grants.reduce((sum, g) => sum + g.purse, 0),
    balance: save.chips,
  }
}

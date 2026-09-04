import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { SERIES_SIZE, ownedCharms } from '../core/charms'
import { activeChipEvent, eventRemaining } from '../core/chipevent'
import { daysToNextStreakReward, nextStreakReward, spinAvailable } from '../core/daily'
import { endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { questState, type QuestGoal } from '../core/quests'
import type { SaveData } from '../core/save'
import { openCharmAlbum } from './charmalbum'
import { getTheme } from './theme'
import { FONT, GHOST_PILL, addPressablePlate, startScene } from './ui'

// ─────────────────────────────────────────────────────────────────────────────
// WHAT'S LIVE NOW — the one rotating card on Home, and the ordered list that fills it.
//
// Home used to carry five notices at once: the streak line, the ×N free-spins tab on the LUCKY
// SLOTS pill, the charm collar's 0/9, the stash's "boost ready" line and the race strip's "new
// board today". Each of them was individually right and the set was worthless — when five things
// are urgent, none of them is, and the eye has nowhere to land. So the notices collapse into ONE
// slot and the list below decides who gets it.
//
// Two rules keep that honest, and both are why this is a LIST rather than a chain of ifs:
//   · FIRST NON-NULL WINS. Exactly one item is ever on screen, so a new source of urgency cannot
//     quietly become a sixth notice — it has to earn a rank against the ones already here.
//   · A PROVIDER IS PURE. It reads the save (plus the one flag Home already computes) and returns
//     copy + a destination; it never touches the scene. That is what lets `pickLiveNow` be called
//     before anything is built, and what makes inserting a provider a one-line edit.
//
// Deliberately NOT analytics-instrumented: this surface is assembled from facts the save already
// carries and every destination it routes to fires its own events.
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a provider is allowed to look at. Pure — no scene, no network, no clock of its own. */
export interface LiveCtx {
  save: SaveData
  /**
   * Home's own progressive-reveal gate (one finished level OR one banked chip). A destination that
   * can do nothing for this player yet is DEFERRED rather than shown greyed-out, and the card obeys
   * the same rule — passed in rather than re-derived, because two copies of that expression would
   * drift the first time the gate moved. See HomeScene's `preFirstWin`.
   */
  preFirstWin: boolean
  /**
   * Home's wholesale repaint. A panel opened from this card (the stash, the charm album) can move
   * the chip balance, the hearts pool and this very card at once, so the host repaints rather than
   * reaching into four widgets — the same "apply by repaint" rule the theme picker follows.
   */
  refresh: () => void
  /**
   * The instant Home painted, for the one provider whose fact is a WINDOW rather than a save field
   * (a chip event). Passed in, never read from `Date` inside a provider, so `pickLiveNow` stays a
   * pure function of its argument and a test can put the clock anywhere.
   */
  now: Date
}

/** One thing worth saying, in the shape the card paints. */
export interface LiveNow {
  /** Stable id — for the caller's own bookkeeping (and readable in a debugger). Never shown. */
  id: string
  /** Left-end badge. A bare emoji Text: never a pill label, whose letterSpacing splits the pair. */
  glyph: string
  /** The small gold deck above the line — names the surface so the line never has to. */
  heading: string
  /** The sentence. Shrinks to fit rather than overflowing (see `addLiveCard`). */
  line: string
  /**
   * Where a tap goes. ABSENT = the card is a signpost, not a door — it paints dimmed and inert,
   * exactly as the ENDLESS hero does below its unlock.
   */
  open?: (scene: Phaser.Scene, ctx: LiveCtx) => void
}

export type LiveProvider = (ctx: LiveCtx) => LiveNow | null

// The `stashWaiting` provider — "YOUR STASH · next level: +5 MOVES · DOUBLE SCORE", once rank 1
// here — is GONE (owner call, 2026-08-26): with the rail's badged 🎁 STASH door on the same screen
// it was a second stash button, and the slot it monopolised (any save with a non-empty stash saw
// nothing else) is where the ENDLESS hero now stands. The naming-not-counting line it carried moved
// back into the stash panel itself, one tap behind the door.

/**
 * Where a quest sends you. Keyed by the goal's SIGNAL rather than its id, because that vocabulary is
 * closed (core/quests.ts) and a `Record` over it is checked for completeness: a catalog row whose
 * activity nothing here can open is a COMPILE error, where a switch on the open-string `id` would just
 * fall through to nothing at run time — the same silent-forever failure the signal type exists to stop.
 *
 * Every entry is a navigation Home already performs: the level PLAY starts, the rail's SLOTS door, the
 * ENDLESS hero's run. PLAY's launch bloom and its shared-element focus are deliberately NOT copied — those
 * belong to the 460×150 hero, and a 78px card that swells the whole screen would be claiming to be one.
 */
const QUEST_ROUTES: Record<QuestGoal['signal'], (scene: Phaser.Scene, save: SaveData) => void> = {
  // Exactly HomeScene's PLAY target — the `Math.min(unlocked, LEVEL_COUNT)` StoreScene's PLAY copies
  // too, so all three doors into a numbered level open the same one.
  level_win: (scene, save) => startScene(scene, 'game', { level: Math.min(save.unlocked, LEVEL_COUNT) }),
  slots_spun: scene => startScene(scene, 'slots'),
  endless_end: scene => startScene(scene, 'game', { endless: true }),
}

/**
 * 0 · A CHIP EVENT is running — every numbered level pays ×N until the season resets.
 *
 * Outranks the quest slate for the length of the window, and only then: a promo is the one entry
 * here that a player cannot discover from the game itself (a quest is on the slate, a spin is in the
 * bank, a streak is on the flame), so an unadvertised weekend would pay out silently and bring
 * nobody back for Saturday. The countdown is the race panels' own coarse form ("2d 5h"), and the
 * end it counts to is `weekEndsAt` — the exact instant the endless board resets (core/chipevent.ts).
 *
 * Tap = PLAY's target, the level the event pays on. Not gated on `preFirstWin`: level 1 is a level,
 * and doubling a first clear is the friendliest possible hello.
 */
const chipEventLive: LiveProvider = ({ now }) => {
  const ev = activeChipEvent(now)
  if (!ev) return null
  return {
    id: `event:${ev.id}`,
    glyph: '💰',
    heading: ev.label,
    line: `every level pays ×${ev.mult} chips  ·  ${eventRemaining(ev, now)} left`,
    open: (scene, ctx) => QUEST_ROUTES.level_win(scene, ctx.save),
  }
}

/**
 * 1 · Today's quest slate is open — how far in, and what the next row asks for.
 *
 * Ranked here, above a banked spin, by what ignoring it costs: a spin keeps forever, while a slate is
 * gone at midnight AND wants a real session to finish (up to three activities, one of them a whole race
 * run). Everything below this line either keeps or can still be done at 23:50.
 *
 * ⚠️ There is no completed-but-unclaimed rank for a quest and there never can be — the insertion note
 * this replaces ranked one alongside the old stash provider, and that state is unreachable. `advanceQuests`
 * (core/quests.ts) banks the chips and writes the claim latch in the SAME statement block, award-first
 * ("THE CLAIM LATCH IS THE ONLY LATCH"), so a goal is paid the instant it is finished and a slate is
 * only ever in progress or finished-and-paid. A finished slate therefore yields NOTHING: closing the
 * loop is the whole feature, and a victory lap parked in Home's single live slot would push out a
 * notice the player can still act on. The one merge-transient exception proves it — a device can arrive
 * holding all three claims and not yet the all-clear bonus, and that bonus pays itself on the player's
 * next signal, so there is nothing to tap there either.
 *
 * ⚠️ The endless gate is THIS SURFACE'S, deliberately not the core's. `questsForDay` hands every player
 * on earth the same three goals and that global agreement is the point — but `run_board` needs the
 * race, so before the race unlocks the slate cannot be finished at all, and a checklist carrying a
 * permanently unreachable row teaches the player that the list is decoration (the catalog's own
 * INTENT-COMPLETABLE rule, aimed at exactly that failure). So the surface hides what the core still
 * computes, using the same predicate the ENDLESS hero reads for its locked state — never a level
 * number of its own.
 */
const questsOpen: LiveProvider = ({ save }) => {
  if (!endlessUnlocked(save)) return null
  const slate = questState(save)
  // The first row still unpaid — and the only exit a finished slate needs, since "no unclaimed row" IS
  // `allClear`. It also covers `questsForDay`'s defensive floor (a catalog too small to fill a slate
  // yields what it has): no next goal means nothing to name and nowhere to send a tap.
  const next = slate.goals.find(row => !row.claimed)
  if (!next) return null
  const done = slate.goals.filter(row => row.claimed).length
  const total = slate.goals.length
  return {
    id: 'quests',
    // The next goal's OWN glyph, straight off the catalog row: the card is pointing at one activity,
    // and choosing a second emoji for that activity here is the BOOST_META scar in miniature.
    glyph: next.goal.emoji,
    heading: 'DAILY QUESTS',
    // The label comes from the goal and never from here, for the same reason. The count is `total` —
    // what today's draw actually returned — rather than a literal 3, which is what a day ASKS for
    // (QUEST_COUNT); a card that can only ever be right is worth the one extra read.
    line:
      done === 0
        ? `${total} to do today  ·  first: ${next.goal.label}`
        : `${done} of ${total} done  ·  next: ${next.goal.label}`,
    open: (scene, ctx) => QUEST_ROUTES[next.goal.signal](scene, ctx.save),
  }
}

/** 2 · Banked free spins — an owned asset, so only tonight's slate outranks it. */
const freeSpinsWaiting: LiveProvider = ({ save }) => {
  if (save.freeSpins <= 0) return null
  return {
    id: 'spins',
    glyph: '🎰',
    heading: 'LUCKY SLOTS',
    // The words, not just the count. The badge this replaces spent a year rendering only for BANKED
    // spins and saying nothing about them — "gold is unlearnable" (see HomeScene's retired
    // buildFreeSpinsBadge), and the rail's badge is now the count while this is the offer.
    line: `${save.freeSpins} free spin${save.freeSpins === 1 ? '' : 's'} banked  ·  pull them any time`,
    open: scene => startScene(scene, 'slots'),
  }
}

// The `boardNotRun` provider ("a new board today · you haven't raced it yet") went with the stash
// one: the ENDLESS hero is a PERMANENT row saying "new board today" in its own sub-line with the
// run one tap away, so a card repeating it would be the two-notices problem this file exists to end.

/**
 * 3 · The streak is alive and tonight's pull is still unspent.
 *
 * ⚠️ The rung today's pull LANDS ON is the one at `streak + 1`, never `streak` — promising a prize a
 * day early is the single worst thing this copy could do. `streakBadgeLabel` (view/ui.ts) is the
 * tested authority on that off-by-one and this mirrors its guard exactly; the flame chip near PLAY
 * keeps the compact form, and the full sentence lives here.
 */
const streakAtRisk: LiveProvider = ({ save }) => {
  if (!spinAvailable(save)) return null
  if (save.streak <= 0) {
    return {
      id: 'streak',
      glyph: '🎰',
      heading: 'FREE SPIN TODAY',
      line: 'one pull on the house  ·  start a streak',
      open: scene => startScene(scene, 'slots'),
    }
  }
  const landing = nextStreakReward(save.streak)
  const away = daysToNextStreakReward(save.streak)
  const line =
    landing && landing.day === save.streak + 1
      ? `spin today and this streak pays ${landing.label}`
      : landing && away !== null
        ? `day ${save.streak}  ·  ${away} more to ${landing.label}`
        : `day ${save.streak}  ·  spin today to keep it alive`
  return { id: 'streak', glyph: '🔥', heading: 'YOUR STREAK', line, open: scene => startScene(scene, 'slots') }
}

/** 4 · The charm series is nearly closed. Only ever "nearly": a set 6 short is a collection, not news. */
const charmsNearDone: LiveProvider = ({ save }) => {
  const have = ownedCharms(save).length
  const missing = SERIES_SIZE - have
  if (have === 0 || missing === 0 || missing > 2) return null
  return {
    id: 'charms',
    glyph: '🍀',
    heading: 'CHARM ALBUM',
    line: `${have} of ${SERIES_SIZE}  ·  ${missing} more to complete the set`,
    open: (scene, ctx) => {
      sfx.whoosh()
      openCharmAlbum(scene, { onChanged: ctx.refresh })
    },
  }
}

// The `raceLocked` floor ("DAILY RACE · unlocks at level N", the one signpost entry) is gone too:
// the ENDLESS hero paints that exact sentence on its own locked plate from the first win onward, a
// PERMANENT seat instead of one that vanished whenever any other notice had something to say.

/**
 * The list, in priority order. Highest first; the first provider to return non-null owns the slot.
 *
 * Ranked by what the player LOSES by ignoring it: a chip event dies with the season and pays on
 * every level until then, a quest slate dies at midnight and wants a whole session, a banked spin keeps, a streak dies at midnight but is one sitting, and a collection never
 * expires at all. (The stash, the unraced board and the locked race left this list on 2026-08-26 —
 * each is now said permanently by the ENDLESS hero or the rail's stash door; see the notes above.)
 */
export const LIVE_PROVIDERS: readonly LiveProvider[] = [
  chipEventLive,
  questsOpen,
  freeSpinsWaiting,
  streakAtRisk,
  charmsNearDone,
]

/** The single most urgent thing right now, or null when Home genuinely has nothing to say. */
export function pickLiveNow(ctx: LiveCtx): LiveNow | null {
  for (const provider of LIVE_PROVIDERS) {
    const item = provider(ctx)
    if (item) return item
  }
  return null
}

/**
 * The card's art box. EXPORTED because Home budgets its band against it — the rail below and the
 * hero above both clear this, and the whole reason LevelSelect's header band went wrong once was a
 * control whose true reach was implicit (see `STASH_DOOR_W`, same reasoning).
 *
 * 560×78 against PLAY's 460×150: deliberately WIDER and much SHORTER. The card has to carry a
 * sentence, so it needs the width; it must not compete with the primary action, so it gives up the
 * height and wears the ghost cap rather than gold. PLAY still owns ~1.6× its area and the only
 * saturated face on the screen.
 */
export const LIVE_CARD_W = 560
export const LIVE_CARD_H = 78

/** Floor for the shrink-to-fit below — under this a sentence stops being legible on a phone. */
const MIN_LINE_FONT = 14

/**
 * Paint one `LiveNow` as Home's live card: the chunky-3D ghost cap every other control here wears,
 * a glyph at the left end, a small gold heading deck over the sentence, and a chevron at the right.
 * Same bracketing grammar as the standings strip directly below it, so the two read as one family.
 *
 * Composed from `addPressablePlate` rather than `addPillButton` because it seats four children, and
 * because an emoji inside a pill LABEL renders as tofu (addPillButton's letterSpacing splits the
 * surrogate pair). The press, the ≥44pt hit zone, the tap flash and the release shine all come with
 * the plate, so this adds no per-frame cost of its own.
 *
 * ⚠️ Plain `pointerup`, like every other control on this screen. The pointerdown-ARMING guard the
 * race strip carries exists because that strip abuts the endless board — a SWIPE surface — and a
 * drag that ends on a control fires it from any distance. Home has no swipe surface, and widening
 * that guard to every button in the app is a far larger blast radius than the bug it fixes.
 */
export function addLiveCard(
  scene: Phaser.Scene,
  x: number,
  y: number,
  item: LiveNow,
  ctx: LiveCtx
): Phaser.GameObjects.Container {
  const T = getTheme()
  const tappable = item.open !== undefined
  const { container, face } = addPressablePlate(
    scene,
    x,
    y,
    LIVE_CARD_W,
    LIVE_CARD_H,
    GHOST_PILL,
    () => {
      sfx.uiTap()
      item.open?.(scene, ctx)
    },
    // `sheen` (not `juice`): a specular sweep masked to the cap says "this one is alive" without
    // juice's breathing halo, which reaches ~2× the card's height and would wash the rail below.
    // A signpost gets neither, and `disabled` is what makes it dim AND inert in one flag.
    { sheen: tappable, disabled: !tappable }
  )

  // The glyph is its own Text so the emoji survives (see the note above), seated at the same inset
  // the standings strip's badge uses so the two left ends line up.
  face.add(scene.add.text(-LIVE_CARD_W / 2 + 40, 0, item.glyph, { fontFamily: 'sans-serif', fontSize: '28px' }).setOrigin(0.5))
  face.add(
    scene.add
      .text(-10, -15, item.heading, { fontFamily: FONT, fontSize: '13px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setLetterSpacing(3)
  )
  // Body ink, not the interactive gold: gold on this warm cap measures ~4.1:1 and this line carries
  // real data. The cap and the chevron say "tappable" on their own, exactly as a settings row does.
  let size = 20
  const line = scene.add
    .text(-10, 12, item.line, { fontFamily: FONT, fontSize: `${size}px`, fontStyle: '900', color: T.inkSoft })
    .setOrigin(0.5)
  // SHRINK TO FIT — the stash preview is the long one ("next level: +5 MOVES · DOUBLE SCORE"), and
  // a provider added later has no way to know its own budget. Re-rendering at a smaller font rather
  // than scaling the Text keeps the glyphs crisp; the same treatment `addPillButton` gives a label.
  const inner = LIVE_CARD_W - 132 // clear of the glyph's column at one end and the chevron at the other
  if (line.width > inner) {
    size = Math.max(MIN_LINE_FONT, Math.floor((size * inner) / line.width))
    line.setFontSize(size)
    while (line.width > inner && size > MIN_LINE_FONT) line.setFontSize(--size)
  }
  face.add(line)

  if (tappable) {
    // Static, deliberately: the standings strip below carries the DRIFTING chevron, and two of them
    // in one band is noise rather than a stronger cue.
    face.add(
      scene.add
        .text(LIVE_CARD_W / 2 - 30, -1, '›', { fontFamily: FONT, fontSize: '32px', fontStyle: '900', color: T.goldText })
        .setOrigin(0.5)
    )
  }
  return container
}

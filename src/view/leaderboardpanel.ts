/**
 * RACE leaderboard panel — the display surface over `core/leaderboard.ts`.
 *
 * Renders THREE boards through one card: TODAY (the daily board, which closes at midnight Mountain
 * time — core/endless.ts RACE_TZ),
 * THIS WEEK (the season — every day's best added up), and the all-time LEVEL ladder. The first two
 * are TABS of one another, because the second is literally the first summed across seven boards and
 * a player has to be able to see both to understand either.
 *
 * Visually a sibling of the ui.ts overlays (openHelpPanel / openSettingsPanel): same warm scrim,
 * same cream card with the gold bezel, same depth band (60+), same tap-outside / CLOSE dismissal.
 * What's new is the CHOREOGRAPHY: the card pops in, the ranked rows stagger up top-down, the three
 * podium rows land with calibrated Back pops, a one-shot gold sweep crosses the #1 row (the same
 * release-shine light language the pressables speak), and the signed-in player's own row breathes
 * on the shared heartbeat clock — one organism with the rest of the app.
 *
 * Discipline (the three house guarantees):
 *  1. Reduced motion: every beat collapses to a complete, static resting state (popIn/fadeRise
 *     already collapse; the sweep, shimmer and heartbeat-breathe are skipped outright). The bright
 *     #1 sweep additionally respects reduceFlashing() — there it becomes a slow soft swell.
 *  2. Theme tokens only: the card is cream on all four themes (like every panel), so on-card inks
 *     come from the Theme's on-cream text tokens and all fills/strokes from its number tokens.
 *  3. 60fps: row plates are baked ONCE per (theme, size) into cached textures (identical rows batch
 *     to one draw), transients (the sweep) destroy themselves, tweens are killed before their
 *     targets are destroyed on every state swap, and the only per-frame work is one heartbeat read.
 *
 * Data contract: `core/leaderboard.ts` is read-only API — every fetch never throws and returns an
 * EMPTY board when dormant, so the states resolve as:
 *   signed out (no cloudSession)         → warm "sign in to join" invite
 *   signed in + empty entries            → "be the first on today's board"
 *   fetch slower than the patience window → quiet error card with RETRY
 *   entries                              → the podium + ranked rows
 * `opts.boardOverride` short-circuits straight to the board state with caller data (screenshots /
 * audits); `opts.simulate` freezes the loading shimmer or forces the error card (DEV harness).
 */
import Phaser from 'phaser'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { sfx } from '../audio/sfx'
import { cloudSession } from '../core/cloud'
import {
  DAYS_PER_WEEK,
  ENDLESS_UNLOCK_LEVEL,
  dayEndsAt,
  dayKey,
  endlessBestToday,
  endlessWeekStanding,
  formatRaceRemaining,
  previousDayKey,
  previousWeekKey,
  weekKey,
  weekEndsAt,
} from '../core/endless'
import { endlessWeekBounds } from '../core/endlessramp'
import {
  CHAMPION_PURSE,
  DAILY_PURSE,
  fetchDailyBoard,
  isLegacyWeek,
  fetchDailyChampion,
  fetchLevelBoard,
  fetchWeeklyBoard,
  fetchWeeklyChampion,
  levelStanding,
} from '../core/leaderboard'
import type { Champion, LeaderboardEntry, RaceBoard } from '../core/leaderboard'
import { LEVEL_COUNT } from '../core/levels'
import { chaptersFromCleared, trophyTier } from '../core/trophies'
import type { SaveData } from '../core/save'
import { openCloudModal } from './cloudmodal'
import { D, E, OVERSHOOT, backOut, fadeRise, heartbeat, popIn } from './motion'
import { quality } from './quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from './theme'
import { FONT, GHOST_PILL, GOLD_PILL, ROSE_PILL, addPillButton, addRoundChip, goldFace, startScene } from './ui'
import { accentRimTop } from './platekit'

// ─────────────────────────────────────────────────────────────────────────────
// Geometry — one fixed, generous card so EVERY state (board, invite, empty, loading, error) lives
// in the same silhouette and the panel never "jumps size" when a fetch resolves.
// ─────────────────────────────────────────────────────────────────────────────

const W = DESIGN_W
const H = 1280
const CARD_W = 640
const CARD_H = 1000
/** Row width inside the card (the card's 36px inner gutters). */
const ROW_W = 568
/** Podium row heights: #1 biggest, #2/#3 matched smaller. */
const POD1_H = 104
const POD23_H = 86
/** Plain ranked-row height + vertical step. */
const ROW_H = 54
const ROW_STEP = 60
/** Content top edge, relative to the card centre (title + week label live above this). */
const CONTENT_TOP = -350
/** How long we wait on the network before quietly offering RETRY (ms, game clock). */
const FETCH_PATIENCE = 8000
/** Texture-bake padding so baked drop shadows aren't clipped. */
const PAD = 10

export interface RacePanelOpts {
  /** Render THIS board instead of fetching — deterministic rich data for screenshots/audits. */
  boardOverride?: RaceBoard
  /** With boardOverride: the crown-row champion (null = the closed board had none). Live opens fetch it. */
  championOverride?: Champion | null
  /** DEV/testing hook: hold the loading shimmer forever, or open straight onto the error card. */
  simulate?: 'loading' | 'error'
  /**
   * WHICH board to open on. All three render through this one panel — same plates, medals,
   * medallions, loading shimmer, error/RETRY and own-rank footer — because the only real differences
   * are the heading, the subtitle, where the rows come from, and whether a crown row applies. Forking
   * a second thousand-line panel to change four things would guarantee the two drift apart.
   */
  mode?: BoardMode
}

/** The three boards this panel can render. TODAY and THIS WEEK are tabs of one another. */
export type BoardMode = 'daily' | 'weekly' | 'levels'

/** The tabbed pair — the two halves of the endless race. The level ladder is reached its own way. */
const RACE_TABS: BoardMode[] = ['daily', 'weekly']

/**
 * Per-board copy + data source. The crown belongs to boards that CLOSE — today's board hands over at
 * midnight and the season on Monday, so both crown a winner; the level ladder never closes, so it has
 * none.
 *
 * EVERY player-visible string the boards disagree on lives here, including the ones on the loading /
 * signed-out / empty states. Those are easy to forget because they render identically either way, and
 * a level board that says "sign in to join the daily race" is worse than one with no copy at all.
 * Same for the data source: `fetch` and `champion` sit here so `load()` has no idea which board it is
 * resolving, which is what stops a new board needing new plumbing.
 */
interface BoardSpec {
  /** Heading — used only by boards outside the tabbed pair (the tabs are their own heading). */
  title: string
  tab: string
  subtitle: (b: RaceBoard) => string
  /** Crown-row lead-in ("yesterday's winner"), or null for a board that never closes. */
  crownLabel: string | null
  loading: string
  signedOut: string
  signedOutSub: string
  empty: string
  emptySub: string
  fetch: (limit: number) => Promise<RaceBoard>
  champion: () => Promise<Champion | null>
}

const BOARDS: Record<BoardMode, BoardSpec> = {
  daily: {
    title: 'DAILY RACE',
    tab: 'TODAY',
    // The date key stays (it is what let us spot two friends on DIFFERENT boards from two
    // screenshots) but the half a player actually wants is when this board hands over.
    subtitle: b => `${b.key}  ·  ends in ${formatRaceRemaining(dayEndsAt().getTime() - Date.now())}`,
    crownLabel: 'yesterday’s winner',
    loading: 'fetching today’s board…',
    signedOut: 'sign in to join today’s race',
    signedOutSub: 'a new shared board every day —\neveryone gets the same deal.',
    empty: 'be the first on today’s board',
    emptySub: 'finish an endless run and your best lands here.',
    fetch: limit => fetchDailyBoard(limit),
    champion: () => fetchDailyChampion(previousDayKey()),
  },
  weekly: {
    title: 'WEEKLY RACE',
    tab: 'THIS WEEK',
    // Says the ranking rule out loud, because it is not guessable from the numbers: this board is
    // every day's best ADDED UP, so a player looking at a total bigger than any run they have ever
    // had should be able to see why without asking.
    // The transition week counts BOTH boards it was raced on — the frozen shared board plus the
    // daily bests since the switch (core/leaderboard.ts LEGACY_WEEK_CUTOVER). It must say so: naming
    // only one half would tell players mid-race that half their week doesn't count, which is the
    // exact confusion this branch exists to end. Self-expires with the cutover.
    subtitle: b =>
      `${b.key}  ·  ${isLegacyWeek(b.key) ? 'shared board + daily bests' : 'daily bests added up'}  ·  ${formatRaceRemaining(weekEndsAt().getTime() - Date.now())} left`,
    crownLabel: 'last week’s champion',
    loading: 'adding up this week’s boards…',
    signedOut: 'sign in to join the weekly race',
    signedOutSub: `every day’s best, added up across ${DAYS_PER_WEEK} boards —\nturning up is the strategy.`,
    empty: 'be the first on this week’s board',
    emptySub: 'race a daily board and your week starts here.',
    fetch: limit => fetchWeeklyBoard(limit),
    champion: () => fetchWeeklyChampion(previousWeekKey()),
  },
  levels: {
    // Named for what it measures, not for the screen it opens from — this is the campaign ladder.
    title: 'LEVEL RACE',
    tab: 'LEVELS',
    // Says the ranking rule out loud: ties on a rung are the NORMAL case here, so a player who sees
    // themselves below someone on the same level should be able to tell why without asking.
    subtitle: () => 'all time  ·  stars break ties',
    crownLabel: null,
    loading: 'fetching the ladder…',
    signedOut: 'sign in to join the level race',
    signedOutSub: 'one ladder, all time —\nhow far has everyone got?',
    empty: 'be the first onto the ladder',
    emptySub: 'clear a level and your climb lands here.',
    fetch: limit => fetchLevelBoard(limit),
    champion: () => Promise.resolve(null),
  },
}

/** Crown-row height + gap under it (the "last week's champion" strip above the podium). */
const CROWN_H = 48
const CROWN_GAP = 12

// ─────────────────────────────────────────────────────────────────────────────
// Baked row plates. Each signature bakes once per (theme, kind) into the global TextureManager, so
// ten ranked rows cost ten quads of the same texture — and the #1 plate being an IMAGE is what lets
// the gold sweep ride a bitmap mask of its exact silhouette (the pressables' release-shine recipe).
// ─────────────────────────────────────────────────────────────────────────────

type PlateKind = 'gold' | 'podium' | 'row'

function plateKey(kind: PlateKind, w: number, h: number): string {
  return `race:${kind}:${getTheme().id}:${w}x${h}`
}

/** Bake one row plate: soft down-cast shadow + face + bezel (+ dark-theme accent rim). */
function ensurePlate(scene: Phaser.Scene, kind: PlateKind, w: number, h: number): string {
  const key = plateKey(kind, w, h)
  if (scene.textures.exists(key)) return key
  const T = getTheme()
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = PAD
  const y = PAD
  const r = kind === 'row' ? 14 : 20
  // Shadow falls straight DOWN (the one key light sits above the scene — ui.ts §E7).
  for (let i = 2; i >= 1; i--) {
    g.fillStyle(T.shadow, kind === 'row' ? 0.05 : 0.08)
    g.fillRoundedRect(x, y + i * 2, w, h, r)
  }
  if (kind === 'gold') {
    // The champion's plate is the canonical real-metal gold face (shared with the payline/win tab).
    goldFace(g, x, y, w, h, T, r)
    g.lineStyle(3, T.goldDeep, 1)
    g.strokeRoundedRect(x, y, w, h, r)
  } else {
    // Podium 2/3: warm cream with the gold bezel; plain rows: the quiet alt-card face.
    g.fillStyle(kind === 'podium' ? T.cardFillWarm : T.cardFillAlt, 1)
    g.fillRoundedRect(x, y, w, h, r)
    // Top-lit gloss — a couple of falling-height highlight bands, same trick as the button caps.
    for (let i = 0; i < 3; i++) {
      const bh = h * (0.4 - i * 0.11)
      if (bh < 3) break
      g.fillStyle(T.glossHi, kind === 'podium' ? 0.2 : 0.12)
      g.fillRoundedRect(x + 4, y + 2, w - 8, bh, Math.min(r - 2, bh / 2))
    }
    g.lineStyle(kind === 'podium' ? 3 : 2, kind === 'podium' ? T.goldBezel : T.border, 1)
    g.strokeRoundedRect(x, y, w, h, r)
  }
  // Dark-theme-only lit accent rim along the top inner edge (the neon tell — no-op on cream washes).
  accentRimTop(g, x, y, w, r, { alpha: 0.7 })
  g.generateTexture(key, w + PAD * 2, h + PAD * 2)
  g.destroy()
  return key
}

/**
 * Rank medallion: a STRUCK-MINTED rank coin — a milled/reeded rim, a recessed engraved numeral field,
 * belly falloff, and a specular pip, so it reads pressed-not-printed. #1 gets the full bright-gold
 * material; #2/#3 are the quieter cream-gold. Theme-token drawn, so it recolours on every theme for
 * free. Exported so the dev atlas ('medals' page) can render #1/#2/#3 at their true row sizes.
 */
export function makeMedal(scene: Phaser.Scene, rank: number, r: number): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const g = scene.add.graphics()
  const g1 = rank === 1
  // Per-rank metal (light falls from the top): #1 hot gold, #2/#3 the quieter cream-gold.
  const rimBase = g1 ? T.goldDeep : T.goldBezel
  const rimLit = T.goldBright
  const rimDark = g1 ? T.goldDarkest : T.goldDeep
  const domeBase = g1 ? T.goldDeep : T.goldBezel
  const domeLit = g1 ? T.gold : T.cardFillWarm
  const domeCrown = g1 ? T.goldBright : T.glossHi
  // Seated contact shadow → coin blank (a deep base offset DOWN so the shaded underside shows low) → rim metal.
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(0, r * 0.96, r * 1.4, r * 0.4)
  g.fillStyle(rimDark, 1)
  g.fillCircle(0, r * 0.05, r)
  g.fillStyle(rimBase, 1)
  g.fillCircle(0, 0, r)
  // Milled/reeded rim — 20 alternating lit/shadowed radial teeth (chunky enough to survive r=26).
  const teeth = 20
  const inR = r * 0.84
  const outR = r * 0.99
  const tw = Math.max(1.4, r * 0.075)
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 - Math.PI / 2
    const lit = i % 2 === 0
    g.lineStyle(tw, lit ? rimLit : rimDark, lit ? 0.9 : 0.7)
    g.lineBetween(Math.cos(a) * inR, Math.sin(a) * inR, Math.cos(a) * outR, Math.sin(a) * outR)
  }
  // Dark rim groove — the recessed channel between the milled rim and the raised face.
  g.lineStyle(Math.max(1.6, r * 0.055), rimDark, 0.65)
  g.strokeCircle(0, 0, r * 0.8)
  // RAISED DOMED FACE — a deep base, then a lit face offset UP toward the light (offset-disc dome), a
  // warm crown light-pool, and a brighter core high on the dome.
  g.fillStyle(domeBase, 1)
  g.fillCircle(0, r * 0.02, r * 0.76)
  g.fillStyle(domeLit, 1)
  g.fillCircle(0, -r * 0.05, r * 0.71)
  g.fillStyle(domeCrown, g1 ? 0.5 : 0.62)
  g.fillCircle(0, -r * 0.16, r * 0.46)
  g.fillStyle(domeCrown, 0.5)
  g.fillCircle(0, -r * 0.22, r * 0.24)
  // Belly falloff — the lower dome sinks into shadow (kept inside the dome so it never bleeds past the rim).
  g.fillStyle(0x000000, g1 ? 0.13 : 0.08)
  g.fillEllipse(0, r * 0.34, r * 1.05, r * 0.52)
  // Dome bevel: a dark edge ring + a lit inner ring → the face reads raised and minted.
  g.lineStyle(Math.max(1.2, r * 0.04), rimDark, 0.5)
  g.strokeCircle(0, 0, r * 0.75)
  g.lineStyle(Math.max(1, r * 0.03), rimLit, 0.5)
  g.strokeCircle(0, 0, r * 0.7)
  // Engraved numeral cartouche — a pressed recess (dark disc + an inner-top shadow lip + a lit lower
  // bounce) so the numeral sits struck INTO the dome.
  g.fillStyle(rimDark, g1 ? 0.14 : 0.09)
  g.fillCircle(0, r * 0.04, r * 0.44)
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(0, -r * 0.15, r * 0.64, r * 0.24)
  g.fillStyle(domeCrown, 0.22)
  g.fillEllipse(0, r * 0.24, r * 0.54, r * 0.18)
  // Beaded inner ring — 12 tiny relief dots framing the field (a dark seat + a lit cap offset up).
  const beads = 12
  const bR = r * 0.63
  const bd = Math.max(1, r * 0.05)
  for (let i = 0; i < beads; i++) {
    const ba = (i / beads) * Math.PI * 2 - Math.PI / 2
    const bx = Math.cos(ba) * bR
    const by = Math.sin(ba) * bR
    g.fillStyle(rimDark, 0.5)
    g.fillCircle(bx, by + bd * 0.5, bd + 0.4)
    g.fillStyle(rimLit, g1 ? 0.85 : 0.9)
    g.fillCircle(bx, by - bd * 0.3, bd)
  }
  // Signature: two raised laurel sprigs flanking the numeral (dark seat + a lit cap offset up = relief).
  const lw = Math.max(1.2, r * 0.05)
  const leafLen = r * 0.15
  for (const s of [-1, 1]) {
    const leaves: Array<[number, number]> = [
      [s * r * 0.4, r * 0.28],
      [s * r * 0.44, r * 0.06],
      [s * r * 0.4, -r * 0.16],
    ]
    for (const [lx, ly] of leaves) {
      const ex = lx - s * leafLen * 0.7
      const ey = ly - leafLen * 0.72
      g.lineStyle(lw, T.goldDarkest, 0.5)
      g.lineBetween(lx, ly, ex, ey)
      g.lineStyle(Math.max(1, lw * 0.7), T.goldBright, 0.7)
      g.lineBetween(lx, ly - 0.6, ex, ey - 0.6)
    }
  }
  // Top gloss crescent, a crisp dark outer edge, and a hard specular glint upper-left.
  g.fillStyle(0xffffff, g1 ? 0.13 : 0.16)
  g.fillEllipse(0, -r * 0.42, r * 0.95, r * 0.36)
  g.lineStyle(2, rimDark, 0.75)
  g.strokeCircle(0, 0, r)
  g.fillStyle(0xffffff, 0.7)
  g.fillCircle(-r * 0.28, -r * 0.4, r * 0.09)
  c.add(g)
  const num = scene.add
    .text(0, 1, String(rank), {
      fontFamily: FONT,
      fontSize: `${Math.round(r * (rank === 1 ? 1.05 : 0.95))}px`,
      fontStyle: '900',
      color: rank === 1 ? T.goldPillText : T.goldText,
    })
    .setOrigin(0.5)
  c.add(num)
  return c
}

/** Small rose "YOU" tag pill — the signed-in player's marker on their own row. */
function makeYouTag(scene: Phaser.Scene): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const tw = 58
  const th = 28
  const g = scene.add.graphics()
  g.fillStyle(T.roseDeep, 1)
  g.fillRoundedRect(-tw / 2, -th / 2 + 2, tw, th, th / 2)
  g.fillStyle(T.rose, 1)
  g.fillRoundedRect(-tw / 2, -th / 2, tw, th, th / 2)
  c.add(g)
  c.add(
    scene.add
      .text(0, 0, 'YOU', { fontFamily: FONT, fontSize: '16px', fontStyle: '900', color: T.onRose })
      .setOrigin(0.5)
      .setLetterSpacing(1)
  )
  return c
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a leaderboard overlay — the WEEKLY RACE by default, or the all-time LEVEL RACE with
 * `{ mode: 'levels' }`. Fetches the board (unless `opts.boardOverride` supplies one) and renders
 * whichever state the data lands in — every state dressed to the same standard.
 *
 * Safe against double-open (a module latch, mirroring the secret-note guard) and against late
 * fetches racing a closed panel (an `alive` flag checked before any state swap). The latch is
 * deliberately SHARED across modes: two of these cards stacked on one another would be a mess, and
 * "one leaderboard at a time" is the behaviour a player expects anyway.
 */
/** Double-open latch (module-scoped, mirrors HomeScene's `noteOpen` guard). */
let raceOpen = false

/** Open the all-time LEVEL RACE ladder — `openRacePanel` in levels mode, one panel, one latch. */
export function openLevelRacePanel(scene: Phaser.Scene, opts: RacePanelOpts = {}): void {
  openRacePanel(scene, { ...opts, mode: 'levels' })
}

export function openRacePanel(scene: Phaser.Scene, opts: RacePanelOpts = {}): void {
  if (raceOpen) return
  raceOpen = true
  const T = getTheme()
  const still = prefersReducedMotion()
  const layer = scene.add.container(0, 0).setDepth(60)

  // ── Shell: scrim + cream card + title + CLOSE (shared by every state) ──────────────────────
  const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH(), T.scrim, 0.6).setInteractive()
  let alive = true
  const close = (): void => {
    if (!alive) return
    alive = false
    raceOpen = false
    sfx.whoosh() // §E3 B14: the airy sweep partners every panel close
    layer.destroy()
  }
  scrim.on('pointerup', close)
  layer.add(scrim)
  // The scene can be torn down under us (theme restart / navigation) — release the latch + flag.
  layer.once(Phaser.GameObjects.Events.DESTROY, () => {
    alive = false
    raceOpen = false
  })

  // Everything card-shaped lives in cardRoot (origin = card centre) so the pop-in scales from the
  // middle like a dealt card, not from the screen corner.
  const cardRoot = scene.add.container(W / 2, H / 2)
  layer.add(cardRoot)

  const g = scene.add.graphics()
  const cx = -CARD_W / 2
  const cy = -CARD_H / 2
  // Card shadow falls straight down from the one key light (three-pass penumbra, ui.ts recipe).
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(T.shadow, 0.08)
    g.fillRoundedRect(cx, cy + i * 3, CARD_W, CARD_H, 30)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(cx, cy, CARD_W, CARD_H, 30)
  g.lineStyle(4, T.goldBezel, 1)
  g.strokeRoundedRect(cx, cy, CARD_W, CARD_H, 30)
  accentRimTop(g, cx, cy, CARD_W, 30, { alpha: 0.85 })
  cardRoot.add(g)

  // Blocker so taps on the card never fall through to the scrim (which closes).
  cardRoot.add(scene.add.rectangle(0, 0, CARD_W, CARD_H, 0xffffff, 0.001).setInteractive())

  let mode: BoardMode = opts.mode ?? 'daily'
  let spec = BOARDS[mode]

  /** The key a board is showing right now — its own partition, or the ladder's stand-in label. */
  const currentKey = (m: BoardMode): string =>
    m === 'levels' ? 'ALL TIME' : m === 'weekly' ? weekKey() : dayKey()

  // Header + subtitle. The header is either a plain heading (the level ladder) or the TODAY /
  // THIS WEEK tab pair, and it lives in ONE container that is rebuilt in place on a switch — so the
  // card's child order, and therefore the index every body state is inserted at, never moves.
  const header = scene.add.container(0, 0)
  const subtitle = scene.add
    .text(0, cy + 112, '', { fontFamily: 'Arial, sans-serif', fontSize: '22px', color: T.inkMuted })
    .setOrigin(0.5)
  cardRoot.add([header, subtitle])
  const setKey = (key: string): void => {
    subtitle.setText(spec.subtitle({ key, entries: [], myRank: null, myScore: null }))
  }

  /**
   * The two halves of the endless race are TABS, not two panels. A player has to be able to answer
   * "am I winning today?" and "am I winning the week?" in the same breath — the second is the sum of
   * the first across seven boards, and splitting them across two entry points would hide exactly the
   * relationship the format is built on. The active tab wears the gold cap; the other is a ghost.
   * The level ladder keeps a plain heading: it is a different race, not a third tab of this one.
   */
  const renderHeader = (): void => {
    header.removeAll(true)
    if (!RACE_TABS.includes(mode)) {
      header.add(
        scene.add
          .text(0, cy + 58, spec.title, { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: T.goldText })
          .setOrigin(0.5)
          .setLetterSpacing(2)
          .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
      )
      return
    }
    RACE_TABS.forEach((m, i) => {
      const active = m === mode
      const tab = addPillButton(
        scene,
        i === 0 ? -120 : 120,
        cy + 62,
        228,
        60,
        BOARDS[m].tab,
        active ? GOLD_PILL : GHOST_PILL,
        () => {
          if (m !== mode) switchTo(m)
        }
      )
      header.add(tab)
    })
  }

  /** Flip to the other race board: re-dress the header, re-label, re-resolve. */
  const switchTo = (m: BoardMode): void => {
    mode = m
    spec = BOARDS[m]
    renderHeader()
    setKey(currentKey(m))
    resolve(false)
  }

  renderHeader()
  setKey(opts.boardOverride?.key ?? currentKey(mode))

  // Bottom controls: the growth hook (a ghost "invite friends to race" chip — the invite row itself
  // lives in the Gift Store) beside CLOSE. Tracked so newBody() can insert every state UNDER them.
  const controls: Phaser.GameObjects.Container[] = []
  const invite = addPillButton(scene, -129, CARD_H / 2 - 70, 310, 56, 'INVITE FRIENDS', GHOST_PILL, () => {
    startScene(scene, 'store') // the panel dies with the scene; the layer DESTROY hook frees the latch
  })
  cardRoot.add(invite)
  controls.push(invite)
  const closePill = addPillButton(scene, 160, CARD_H / 2 - 70, 240, 68, 'CLOSE', GOLD_PILL, close)
  cardRoot.add(closePill)
  controls.push(closePill)

  // The `?` chip — the explainer, one tap from the board it explains. Deliberately HERE rather than
  // only in how-to-play: a player who is confused about the race is looking AT the race, and the
  // weekly board is the one screen where the numbers make no sense until someone says "these are
  // seven days added together". Pinned to the card's top-left, clear of the tabs and the subtitle.
  //
  // It hands over the CURRENT mode, read at tap time rather than captured at build time, so a tab
  // switch takes the explainer with it — and the ladder, which is not part of the endless race at
  // all, gets the rules of the board it is actually on.
  const rules = addRoundChip(
    scene,
    cx + 46,
    cy + 46,
    46,
    '?',
    { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.goldText },
    () => openRaceRulesPanel(scene, mode)
  )
  rules.container.setDepth(0) // rides the card's own stacking, not addRoundChip's default 50
  cardRoot.add(rules.container)
  controls.push(rules.container)

  // Card entrance: pop in from a dealt-card 0.92 with a gentle spring + a quick fade. Reduced
  // motion → popIn collapses instantly and the alpha is simply set.
  if (still) {
    cardRoot.setAlpha(1)
  } else {
    cardRoot.setAlpha(0)
    scene.tweens.add({ targets: cardRoot, alpha: 1, duration: D.base, ease: E.settle })
    popIn(scene, cardRoot, { from: 0.92, duration: D.pop, overshoot: OVERSHOOT.gentle })
  }

  // ── State machinery: one `body` container per state; tweens registered per-body so every swap
  // stops them BEFORE destroying targets (Phaser 3.90 does not sweep tweens for destroyed objects).
  let body: Phaser.GameObjects.Container | null = null
  let bodyTweens: Phaser.Tweens.Tween[] = []
  let bodyTick: (() => void) | null = null
  const tw = (t: Phaser.Tweens.Tween | null): void => {
    if (t) bodyTweens.push(t)
  }
  const clearBody = (): void => {
    for (const t of bodyTweens) t.stop()
    bodyTweens = []
    if (bodyTick) {
      scene.events.off(Phaser.Scenes.Events.UPDATE, bodyTick)
      bodyTick = null
    }
    body?.destroy()
    body = null
  }
  const newBody = (): Phaser.GameObjects.Container => {
    clearBody()
    body = scene.add.container(0, 0)
    // Insert under the INVITE + CLOSE pills so a landing row can never paint over the buttons.
    cardRoot.addAt(body, cardRoot.getIndex(controls[0]))
    return body
  }
  // The panel closing must also stop body tweens + the heartbeat tick (targets die with the layer).
  layer.once(Phaser.GameObjects.Events.DESTROY, clearBody)

  // The player's own row + halo, captured during buildRow for the heartbeat breathe.
  let youRow: Phaser.GameObjects.Container | null = null
  let youGlow: Phaser.GameObjects.Image | null = null

  // ── State: the ranked board ────────────────────────────────────────────────────────────────
  const showBoard = (board: RaceBoard, champ: Champion | null = null): void => {
    const b = newBody()
    setKey(board.key)
    const fancy = !still && quality.tier() !== 'low'
    const champYou = champ?.you === true

    // Round-3 audit fix: the own-row heartbeat tick below must NOT modulate scale while the row's
    // entrance pop is still in flight (the per-frame setScale was overwriting the Back tween when
    // YOU landed top-3). Flipped true by the you-row's LAST entrance tween completing.
    let youSettled = false

    // Does the player's own row land inside the visible rows, or does the footer carry it?
    // The crown row costs one plain rank so every state keeps the same card silhouette.
    const footerNeeded = board.myRank !== null && !board.entries.slice(0, champ ? 9 : 10).some(e => e.you)
    const plainMax = (footerNeeded ? 6 : 7) - (champ ? 1 : 0)
    const shown = board.entries.slice(0, 3 + plainMax)

    /** Build one row container (plate + medal/rank + name + score [+ YOU dressing]) at rest. */
    const buildRow = (e: LeaderboardEntry, y: number, kind: PlateKind, h: number): Phaser.GameObjects.Container => {
      const row = scene.add.container(0, y)
      // Rose halo UNDER the player's own plate — the heartbeat drives its glow (below).
      if (e.you && scene.textures.exists('bgglow')) {
        const halo = scene.add
          .image(0, 0, 'bgglow')
          .setDisplaySize(ROW_W * 1.12, h * 2.4)
          .setTint(T.rose)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(still ? 0.16 : 0.12)
        row.add(halo)
        youGlow = halo
        youRow = row
      }
      const plate = scene.add.image(0, 0, ensurePlate(scene, kind, ROW_W, h))
      row.add(plate)
      if (e.you) {
        // Rose accent ring — the highlight that says "this one is yours" on any plate kind.
        const ring = scene.add.graphics()
        ring.lineStyle(3, T.rose, 0.95)
        ring.strokeRoundedRect(-ROW_W / 2, -h / 2, ROW_W, h, kind === 'row' ? 14 : 20)
        row.add(ring)
      }
      const onGold = kind === 'gold'
      const nameColor = onGold ? T.goldPillText : e.you ? T.ink : kind === 'podium' ? T.ink : T.inkSoft
      const nameSize = kind === 'gold' ? 30 : kind === 'podium' ? 26 : 23
      let nameX = -ROW_W / 2 + 40
      if (kind === 'row') {
        // Plain rows carry a quiet rank numeral instead of a medallion.
        row.add(
          scene.add
            .text(nameX, 0, `#${e.rank}`, { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: T.inkFaint })
            .setOrigin(0.5)
        )
        nameX += 44
      } else {
        const r = kind === 'gold' ? 32 : 26
        const med = makeMedal(scene, e.rank, r)
        med.setPosition(-ROW_W / 2 + 26 + r, 0)
        row.add(med)
        // Medal sub-pop: each coin lands a beat AFTER its plate for the layered two-beat entrance.
        if (fancy) {
          med.setScale(0)
          tw(
            scene.tweens.add({
              targets: med,
              scale: 1,
              duration: D.pop,
              delay: D.base + e.rank * 70 + 130,
              ease: backOut(OVERSHOOT.pop),
            })
          )
        }
        nameX = -ROW_W / 2 + 26 + r * 2 + 22
      }
      const name = scene.add
        .text(nameX, 0, e.name, { fontFamily: FONT, fontSize: `${nameSize}px`, fontStyle: '900', color: nameColor })
        .setOrigin(0, 0.5)
      // Emboss on the gold plate so the champion's name reads etched into the metal.
      if (onGold) name.setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      // Trophy-tier badge (core/trophies.ts ladder) — worn between the name and the YOU tag, the
      // slot the champion's crown established. Below the first rung there is no glyph at all, so a
      // board of new players looks exactly as it did before badges existed.
      const tier = typeof e.chapters === 'number' ? trophyTier(e.chapters) : null
      const BADGE_W = tier ? 34 : 0
      // ⚠️ The right side of the row is spoken for — the value text is right-pinned at ROW_W/2−26
      // and the widest boards render "18,204 · 5d" — so the name+badge+YOU+crown cluster must stop
      // short of it, and the NAME is the thing that gives: re-rendered with an ellipsis until the
      // cluster fits. A 24-char handle at 30px could already walk into the value before badges
      // existed; this budget closes that collision rather than adding to it.
      const valueReserve = kind === 'gold' ? 236 : 206
      const reserved = BADGE_W + (e.you ? 118 : 0) + (e.you && champYou ? 46 : 0)
      const nameLimit = ROW_W / 2 - valueReserve - nameX - reserved
      if (name.width > nameLimit && nameLimit > 24) {
        let text = e.name
        while (text.length > 1 && name.width > nameLimit) {
          text = text.slice(0, -1)
          name.setText(`${text}…`)
        }
      }
      row.add(name)
      if (tier) {
        row.add(
          scene.add
            .text(name.x + name.width + 10, 0, tier.emoji, { fontFamily: 'sans-serif', fontSize: '22px' })
            .setOrigin(0, 0.5)
        )
      }
      if (e.you) {
        const tag = makeYouTag(scene)
        tag.setPosition(name.x + name.width + BADGE_W + 40, 0)
        row.add(tag)
        // Reigning champion's own row wears a small crown beside the YOU tag (gold-crown YOUR row).
        if (champYou) {
          row.add(
            scene.add.text(tag.x + 46, 0, '👑', { fontFamily: 'sans-serif', fontSize: '22px' }).setOrigin(0.5)
          )
        }
      }
      row.add(
        scene.add
          // `valueText` lets a board render its own readout (the level ladder shows "47 · ★118"
          // and the season "18,204 · 5d", where the daily board shows a bare score). Undefined on
          // daily rows → the score formats itself.
          .text(ROW_W / 2 - 26, 0, e.valueText ?? e.score.toLocaleString(), {
            fontFamily: FONT,
            fontSize: `${kind === 'gold' ? 30 : kind === 'podium' ? 25 : 22}px`,
            fontStyle: '900',
            color: onGold ? T.goldPillText : T.goldText,
          })
          .setOrigin(1, 0.5)
      )
      b.add(row)
      return row
    }

    // Lay the rows out top-down: podium block (with its own breathing room), then the plain ranks.
    // `y` walks the TOP edge of each row; a row is centred at y + h/2 and advances y by h + gap.
    let y = CONTENT_TOP

    // Crown row — "yesterday's winner · NAME" (or last week's champion) above the podium. A quiet
    // honour strip on the warm podium plate; when the winner is YOU it lands on the full gold plate
    // with an embossed YOU.
    if (champ) {
      const crownRow = scene.add.container(0, y + CROWN_H / 2)
      crownRow.add(scene.add.image(0, 0, ensurePlate(scene, champYou ? 'gold' : 'podium', ROW_W, CROWN_H)))
      const glyph = scene.add
        .text(-ROW_W / 2 + 38, 1, '👑', { fontFamily: 'sans-serif', fontSize: '26px' })
        .setOrigin(0.5)
      crownRow.add(glyph)
      crownRow.add(
        scene.add
          .text(-ROW_W / 2 + 68, 0, spec.crownLabel ?? 'champion', {
            fontFamily: 'Arial, sans-serif',
            fontSize: '20px',
            color: champYou ? T.goldPillText : T.inkMuted,
          })
          .setOrigin(0, 0.5)
      )
      const champName = scene.add
        .text(ROW_W / 2 - 26, 0, champYou ? 'YOU' : champ.name, {
          fontFamily: FONT,
          fontSize: '24px',
          fontStyle: '900',
          color: champYou ? T.goldPillText : T.goldText,
        })
        .setOrigin(1, 0.5)
      if (champYou) champName.setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      crownRow.add(champName)
      b.add(crownRow)
      // The honour strip leads the cascade in, its crown popping a beat after the plate lands.
      tw(fadeRise(scene, crownRow, { rise: 10, delay: D.base - 40, duration: D.settle }))
      if (fancy) {
        glyph.setScale(0)
        tw(scene.tweens.add({ targets: glyph, scale: 1, duration: D.pop, delay: D.base + 220, ease: backOut(OVERSHOOT.pop) }))
      }
      y += CROWN_H + CROWN_GAP
    }
    const rows: Array<{ row: Phaser.GameObjects.Container; pod: boolean }> = []
    let goldPlateRow: Phaser.GameObjects.Container | null = null
    shown.forEach((e, i) => {
      const pod = i < 3
      const kind: PlateKind = i === 0 ? 'gold' : pod ? 'podium' : 'row'
      const h = i === 0 ? POD1_H : pod ? POD23_H : ROW_H
      const row = buildRow(e, y + h / 2, kind, h)
      if (i === 0) goldPlateRow = row
      rows.push({ row, pod })
      // Gaps: 10 inside the podium, 16 between podium and the list, 6 between plain rows.
      y += h + (i < 2 ? 10 : i === 2 ? 16 : ROW_STEP - ROW_H)
    })

    // Entrance: rows stagger-fadeRise top-down; podium rows ADD a Back pop (scale) on top of the
    // rise, biggest spring on #1 — layered, multi-beat, still only transform/alpha tweens.
    rows.forEach(({ row, pod }, i) => {
      const delay = D.base + i * 45
      const isYou = row === youRow
      const popToo = pod && fancy
      tw(
        fadeRise(scene, row, {
          rise: pod ? 16 : 12,
          delay,
          duration: D.settle,
          // The you-row's LAST entrance tween releases the heartbeat (audit fix): the pop below runs
          // longer than the rise when both play, so only the rise-only path hands over here.
          onComplete: isYou && !popToo ? (): void => { youSettled = true } : undefined,
        })
      )
      if (popToo) {
        row.setScale(0.86)
        tw(
          scene.tweens.add({
            targets: row,
            scale: 1,
            duration: D.pop,
            delay,
            ease: backOut(i === 0 ? OVERSHOOT.pop : OVERSHOOT.release),
            onComplete: isYou ? (): void => { youSettled = true } : undefined,
          })
        )
      }
    })

    // One-shot gold sweep across the #1 row — the pressables' release-shine, scaled up to crown the
    // champion. Masked to the gold plate's exact silhouette. reduceFlashing() swaps the travelling
    // bright band for a slow soft swell of warm light; reduced motion / low tier skip entirely.
    if (goldPlateRow !== null && fancy && scene.textures.exists('sweep')) {
      const host: Phaser.GameObjects.Container = goldPlateRow
      const plateImg = host.list.find(
        (o): o is Phaser.GameObjects.Image => o instanceof Phaser.GameObjects.Image && o.texture.key.startsWith('race:gold')
      )
      if (plateImg) {
        if (reduceFlashing()) {
          const swell = scene.add
            .image(0, 0, plateImg.texture.key)
            .setTint(0xffffff)
            .setBlendMode(Phaser.BlendModes.ADD)
            .setAlpha(0)
          host.add(swell)
          tw(
            scene.tweens.add({
              targets: swell,
              alpha: 0.16,
              duration: D.pulse,
              delay: D.base + 320,
              yoyo: true,
              ease: E.hero,
              onComplete: () => swell.destroy(),
            })
          )
        } else {
          const streakW = 96
          const shine = scene.add
            .image(-ROW_W / 2 - streakW, 0, 'sweep')
            .setDisplaySize(streakW, POD1_H * 1.5)
            .setAngle(14)
            .setTint(T.glossHi)
            .setAlpha(0.85)
            .setBlendMode(Phaser.BlendModes.ADD)
          shine.setMask(plateImg.createBitmapMask())
          host.add(shine)
          tw(
            scene.tweens.add({
              targets: shine,
              x: ROW_W / 2 + streakW,
              duration: 460,
              delay: D.base + 340,
              ease: E.glide,
              onComplete: () => {
                shine.clearMask(true)
                shine.destroy()
              },
            })
          )
        }
      }
    }

    // Footer: the player's own rank pinned under the list when they fall outside the shown rows.
    if (footerNeeded && board.myRank !== null) {
      const fh = 52
      const foot = scene.add.container(0, CARD_H / 2 - 136)
      const fg = scene.add.graphics()
      fg.fillStyle(T.cardFillWarm, 1)
      fg.fillRoundedRect(-ROW_W / 2, -fh / 2, ROW_W, fh, fh / 2)
      fg.lineStyle(2.5, T.rose, 0.9)
      fg.strokeRoundedRect(-ROW_W / 2, -fh / 2, ROW_W, fh, fh / 2)
      foot.add(fg)
      const tag = makeYouTag(scene)
      tag.setPosition(-ROW_W / 2 + 46, 0)
      foot.add(tag)
      const rankText = scene.add
        .text(-ROW_W / 2 + 86, 0, `your rank  ·  #${board.myRank}`, {
          fontFamily: FONT,
          fontSize: '22px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0, 0.5)
      foot.add(rankText)
      // The footer wears the same tier badge as a row — read from the LOCAL save (RaceBoard.myChapters),
      // so your own badge shows even when your board row was never fetched.
      const myTier = typeof board.myChapters === 'number' ? trophyTier(board.myChapters) : null
      if (myTier) {
        foot.add(
          scene.add
            .text(rankText.x + rankText.width + 10, 0, myTier.emoji, { fontFamily: 'sans-serif', fontSize: '20px' })
            .setOrigin(0, 0.5)
        )
      }
      if (board.myScore !== null) {
        foot.add(
          scene.add
            .text(ROW_W / 2 - 26, 0, board.myValueText ?? board.myScore.toLocaleString(), {
              fontFamily: FONT,
              fontSize: '22px',
              fontStyle: '900',
              color: T.goldText,
            })
            .setOrigin(1, 0.5)
        )
      }
      b.add(foot)
      tw(fadeRise(scene, foot, { delay: D.base + rows.length * 45 + 80, onComplete: (): void => { youSettled = true } }))
      youRow = youRow ?? foot // outside the top rows the FOOTER is "you" — it carries the breathe
    }

    // Own-row heartbeat breathe: one shared-clock read per frame, phase-locked with every hero
    // breather in the app. Skipped under reduced motion (halo already rests at a static warm alpha),
    // and GATED until the row's entrance tweens complete (`youSettled`) so the per-frame setScale
    // can never fight the podium pop mid-flight (Round-3 audit fix).
    if (youRow && !still) {
      const target = youRow
      const halo = youGlow
      bodyTick = (): void => {
        if (!youSettled) return
        const a = heartbeat.amp()
        target.setScale(1 + a * 0.012)
        halo?.setAlpha(0.12 + a * 0.14)
      }
      scene.events.on(Phaser.Scenes.Events.UPDATE, bodyTick)
    }
  }

  // ── State: loading shimmer ─────────────────────────────────────────────────────────────────
  const showLoading = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    // Ghost plates in the exact resting geometry of the board, so the loaded rows land where the
    // shimmer promised them. Soft alpha swell, staggered down the card — governor-gated: the low
    // tier (and reduced motion) hold them at a static mid-alpha instead.
    const heights = [POD1_H, POD23_H, POD23_H, ROW_H, ROW_H, ROW_H, ROW_H]
    const gaps = [10, 10, 16, 6, 6, 6, 6]
    let y = CONTENT_TOP
    heights.forEach((h, i) => {
      const plate = scene.add.image(0, y + h / 2, ensurePlate(scene, 'row', ROW_W, h)).setAlpha(0.55)
      b.add(plate)
      if (!still && quality.tier() !== 'low') {
        tw(
          scene.tweens.add({
            targets: plate,
            alpha: 0.9,
            duration: D.pulse,
            delay: i * 110,
            yoyo: true,
            repeat: -1,
            ease: E.hero,
          })
        )
      }
      y += h + gaps[i]
    })
    const cap = scene.add
      .text(0, y + 34, spec.loading, { fontFamily: 'Arial, sans-serif', fontSize: '21px', color: T.inkFaint })
      .setOrigin(0.5)
    b.add(cap)
    tw(fadeRise(scene, cap, { delay: D.base }))
  }

  // ── State: signed out — the warm invite ────────────────────────────────────────────────────
  const showSignedOut = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    const heroY = -160
    if (scene.textures.exists('bgglow')) {
      const halo = scene.add
        .image(0, heroY, 'bgglow')
        .setDisplaySize(360, 360)
        .setTint(T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(still ? 0.3 : 0.24)
      b.add(halo)
      if (!still) {
        tw(scene.tweens.add({ targets: halo, alpha: 0.4, scale: halo.scaleX * 1.08, duration: D.breath, yoyo: true, repeat: -1, ease: E.hero }))
      }
    }
    const trophy = scene.add.text(0, heroY, '🏆', { fontFamily: 'sans-serif', fontSize: '110px' }).setOrigin(0.5)
    b.add(trophy)
    tw(popIn(scene, trophy, { from: 0.5, delay: D.base, overshoot: OVERSHOOT.pop }))
    if (!still) {
      tw(scene.tweens.add({ targets: trophy, scale: 1.05, duration: D.breath, delay: D.pop + D.base, yoyo: true, repeat: -1, ease: E.hero }))
    }
    const head = scene.add
      .text(0, -10, spec.signedOut, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: T.ink,
        align: 'center',
        wordWrap: { width: CARD_W - 140 },
      })
      .setOrigin(0.5)
    const sub = scene.add
      .text(0, 52, spec.signedOutSub, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
        color: T.inkMuted,
        align: 'center',
        lineSpacing: 6,
      })
      .setOrigin(0.5)
    b.add([head, sub])
    tw(fadeRise(scene, head, { delay: D.base + 90 }))
    tw(fadeRise(scene, sub, { delay: D.base + 150 }))
    // NOTE: deliberately no `sheen` opt — its slow-shine timer would outlive a mid-scene close.
    const signIn = addPillButton(scene, 0, 190, 300, 80, 'SIGN IN', GOLD_PILL, () => {
      sfx.whoosh() // §E3 B14: the airy sweep partners the cloud modal opening
      openCloudModal()
    })
    b.add(signIn)
    tw(fadeRise(scene, signIn, { delay: D.base + 220 }))
  }

  // ── State: empty week ──────────────────────────────────────────────────────────────────────
  const showEmpty = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    // The open throne: the #1 gold plate rendered as a soft ghost — an invitation, not a list.
    const ghost = scene.add.container(0, -150)
    const plate = scene.add.image(0, 0, ensurePlate(scene, 'gold', ROW_W, POD1_H)).setAlpha(0.4)
    ghost.add(plate)
    const med = makeMedal(scene, 1, 32)
    med.setPosition(-ROW_W / 2 + 58, 0)
    med.setAlpha(0.55)
    ghost.add(med)
    ghost.add(
      scene.add
        .text(-ROW_W / 2 + 128, 0, 'this spot is open', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.inkFaint })
        .setOrigin(0, 0.5)
    )
    b.add(ghost)
    tw(fadeRise(scene, ghost, { rise: 16, delay: D.base, duration: D.settle }))
    if (!still && quality.tier() !== 'low') {
      ghost.setScale(0.9)
      tw(scene.tweens.add({ targets: ghost, scale: 1, duration: D.pop, delay: D.base, ease: backOut(OVERSHOOT.release) }))
    }
    const star = scene.add.image(0, 6, 'star').setDisplaySize(76, 76)
    b.add(star)
    tw(popIn(scene, star, { from: 0.4, delay: D.base + 160, overshoot: OVERSHOOT.pop }))
    const head = scene.add
      .text(0, 92, spec.empty, {
        fontFamily: FONT,
        fontSize: '29px',
        fontStyle: '900',
        color: T.ink,
        align: 'center',
        wordWrap: { width: CARD_W - 140 },
      })
      .setOrigin(0.5)
    const sub = scene.add
      .text(0, 148, spec.emptySub, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
        color: T.inkMuted,
        align: 'center',
        wordWrap: { width: CARD_W - 120 },
      })
      .setOrigin(0.5)
    b.add([head, sub])
    tw(fadeRise(scene, head, { delay: D.base + 220 }))
    tw(fadeRise(scene, sub, { delay: D.base + 280 }))
  }

  // ── State: fetch error — quiet, with RETRY ─────────────────────────────────────────────────
  const showError = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    const suit = scene.add.image(0, -140, 'suitDiamond').setDisplaySize(120, 120).setAlpha(0.28)
    b.add(suit)
    tw(popIn(scene, suit, { from: 0.6, delay: D.base, overshoot: OVERSHOOT.gentle }))
    const head = scene.add
      .text(0, -20, 'can’t reach the race right now', { fontFamily: FONT, fontSize: '28px', fontStyle: '900', color: T.inkSoft })
      .setOrigin(0.5)
    const sub = scene.add
      .text(0, 32, 'your best still counts — it syncs when you’re back.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '21px',
        color: T.inkFaint,
        align: 'center',
        wordWrap: { width: CARD_W - 140 },
      })
      .setOrigin(0.5)
    b.add([head, sub])
    tw(fadeRise(scene, head, { delay: D.base + 60 }))
    tw(fadeRise(scene, sub, { delay: D.base + 120 }))
    const retry = addPillButton(scene, 0, 140, 240, 72, 'RETRY', GHOST_PILL, () => load())
    b.add(retry)
    tw(fadeRise(scene, retry, { delay: D.base + 180 }))
  }

  // ── Resolve: override → instant board; signed out → invite; otherwise fetch with patience ──
  //
  // `loadSeq` is what makes the tabs safe. Two taps in quick succession leave two fetches in flight,
  // and without a generation counter the SLOWER one wins whenever it lands second — so a player who
  // tapped TODAY last could sit looking at the weekly board. Only the newest load may paint.
  let loadSeq = 0
  const load = (): void => {
    const seq = ++loadSeq
    const fresh = (): boolean => alive && seq === loadSeq
    showLoading()
    const timeout = new Promise<'timeout'>(resolve => {
      scene.time.delayedCall(FETCH_PATIENCE, () => resolve('timeout'))
    })
    // The crown row's winner rides the same patience window as the board (both never throw and
    // resolve null/empty when dormant), so the card composes ONCE with everything it will show.
    // The level ladder has no champion — it never closes — so it resolves null and skips the row.
    const at = spec // pin the spec this load is for; the tabs can move `spec` under us
    const fetches: Promise<[RaceBoard, Champion | null]> = Promise.all([at.fetch(25), at.champion()])
    void Promise.race([fetches, timeout])
      .then(result => {
        if (!fresh()) return
        if (result === 'timeout') showError()
        else if (result[0].entries.length > 0) showBoard(result[0], at.crownLabel ? result[1] : null)
        else showEmpty()
      })
      .catch(() => {
        if (fresh()) showError() // the fetches never throw; this guards the race plumbing itself
      })
  }

  /**
   * Pick the state a board should open in. Used for the FIRST paint and for every tab switch, which
   * is the point: without it a signed-out player who tapped THIS WEEK would leave the warm "sign in
   * to join" invite and land on "be the first on this week's board" — an empty board they are not
   * even eligible to be on, with the sign-in button gone.
   *
   * `boardOverride` / `simulate` deliberately apply to the FIRST paint only: they are one fixture for
   * one board, so a tab switch away from them goes to live data rather than re-rendering the daily
   * fixture under a weekly heading.
   */
  const resolve = (first: boolean): void => {
    if (first && opts.boardOverride) {
      if (opts.boardOverride.entries.length > 0) showBoard(opts.boardOverride, opts.championOverride ?? null)
      else showEmpty()
    } else if (first && opts.simulate === 'loading') {
      showLoading() // DEV: held forever, so the shimmer can be inspected/screenshotted
    } else if (first && opts.simulate === 'error') {
      showError()
    } else if (!cloudSession()) {
      showSignedOut() // dormant/signed-out is knowable synchronously — no loading flicker
    } else {
      load()
    }
  }
  resolve(true)
}

// ─────────────────────────────────────────────────────────────────────────────
// The Home DAILY RACE module — the full-width block that seats the ENDLESS play pill over a live
// standings line ("today #R of M · week N"), replacing the v1 trophy chip. One baked cream plate
// (cards stay light on every theme) so the race reads as a first-class destination on Home.
// ─────────────────────────────────────────────────────────────────────────────

/** Module plate geometry (design px) — full-width like the overlay cards (40px side gutters). */
const MODULE_W = 640
/**
 * 152, up from 132: the standings line used to be a bare caption crammed against the plate's bottom
 * edge, and nothing about it said "tap me" — it was the only interactive thing on Home with no
 * container of its own. It is now a proper strip (see `ensureRaceStrip`), and the extra 20px is the
 * breathing room that strip needs above and below. Home has ~80px of clear space under the module
 * (only backdrop glow lives there), so the block still clears the design box comfortably.
 */
const MODULE_H = 152
/**
 * The standings strip: a wide, FLAT warm-cream chip with a gold hairline. Deliberately flatter than
 * `GHOST_PILL` — no pedestal, no deep bevel — so it reads as a secondary tappable row rather than a
 * third button competing with the rose ENDLESS pill above it, while still being obviously pressable.
 */
const STRIP_W = MODULE_W - 44
const STRIP_H = 52
/**
 * The marquee variant (LevelSelect's header): 60, not the row's 52 — as tall as the title band
 * allows (the art's top edge meets the LEVELS wordmark's shadow around y=120) while staying clear
 * of the grid mask at 196. Prominence past that comes from structure, not pixels: badge, heading
 * deck, module-plate shadow and the 3px bezel.
 */
const MARQUEE_H = 60

/** Bake the module's cream plate: soft down-cast shadow + gloss bands + gold bezel (+ dark rim). */
function ensureModulePlate(scene: Phaser.Scene): string {
  const key = `race:module:${getTheme().id}:${MODULE_W}x${MODULE_H}`
  if (scene.textures.exists(key)) return key
  const T = getTheme()
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = PAD
  const y = PAD
  const r = 26
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(T.shadow, 0.07)
    g.fillRoundedRect(x, y + i * 2, MODULE_W, MODULE_H, r)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(x, y, MODULE_W, MODULE_H, r)
  // Top-lit gloss — the same falling-height highlight bands the button caps and row plates use.
  for (let i = 0; i < 3; i++) {
    const bh = MODULE_H * (0.42 - i * 0.12)
    if (bh < 3) break
    g.fillStyle(T.glossHi, 0.16)
    g.fillRoundedRect(x + 4, y + 2, MODULE_W - 8, bh, Math.min(r - 2, bh / 2))
  }
  g.lineStyle(3, T.goldBezel, 1)
  g.strokeRoundedRect(x, y, MODULE_W, MODULE_H, r)
  accentRimTop(g, x, y, MODULE_W, r, { alpha: 0.8 })
  g.generateTexture(key, MODULE_W + PAD * 2, MODULE_H + PAD * 2)
  g.destroy()
  return key
}

/**
 * Bake the standings strip's face — the affordance that was missing. A warm-cream fill (a shade
 * deeper than the plate it sits on, so it separates), ONE quiet top gloss band, a soft seat shadow
 * and a gold hairline. The single gloss band is the whole trick: enough to read as a raised, pressable
 * surface, far short of the three-band bevelled cap the real buttons wear, so the eye still ranks it
 * below the rose ENDLESS pill.
 */
function ensureRaceStrip(scene: Phaser.Scene): string {
  const T = getTheme()
  const key = `race:strip:${T.id}:${STRIP_W}x${STRIP_H}`
  if (scene.textures.exists(key)) return key
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = PAD
  const y = PAD
  const r = STRIP_H / 2
  g.fillStyle(T.shadow, 0.1)
  g.fillRoundedRect(x, y + 3, STRIP_W, STRIP_H, r)
  g.fillStyle(T.cardFillWarm, 1)
  g.fillRoundedRect(x, y, STRIP_W, STRIP_H, r)
  g.fillStyle(T.glossHi, 0.5)
  g.fillRoundedRect(x + 5, y + 3, STRIP_W - 10, STRIP_H * 0.34, r * 0.6)
  g.lineStyle(2, T.goldBezel, 1)
  g.strokeRoundedRect(x, y, STRIP_W, STRIP_H, r)
  g.generateTexture(key, STRIP_W + PAD * 2, STRIP_H + PAD * 2)
  g.destroy()
  return key
}

/**
 * The marquee face LevelSelect's ladder strip wears — same strip, louder clothes (owner call,
 * 2026-07-30: the header strip was still reading as a caption). Home's rows stay on
 * `ensureRaceStrip`: there the strip must rank BELOW the rose ENDLESS pill; here it is the header's
 * only control and the screen's whole subject, so it gets the button grammar the row deliberately
 * renounces — the module plate's stacked seat shadow and 3px bezel instead of a hairline.
 * The LIGHT `cardFill` face is load-bearing, not taste: `goldText` measures 4.53:1 on `cardFill`
 * (why that token exists) but only 4.13:1 on the row's warmer fill, and the marquee carries a
 * 13px gold heading that must pass AA at small-text size.
 */
function ensureRaceStripMarquee(scene: Phaser.Scene): string {
  const T = getTheme()
  const key = `race:stripmq:${T.id}:${STRIP_W}x${MARQUEE_H}`
  if (scene.textures.exists(key)) return key
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = PAD
  const y = PAD
  const r = MARQUEE_H / 2
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(T.shadow, 0.08)
    g.fillRoundedRect(x, y + i * 2, STRIP_W, MARQUEE_H, r)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(x, y, STRIP_W, MARQUEE_H, r)
  g.fillStyle(T.glossHi, 0.5)
  g.fillRoundedRect(x + 5, y + 3, STRIP_W - 10, MARQUEE_H * 0.34, r * 0.6)
  g.lineStyle(3, T.goldBezel, 1)
  g.strokeRoundedRect(x, y, STRIP_W, MARQUEE_H, r)
  accentRimTop(g, x, y, STRIP_W, r, { alpha: 0.8 })
  g.generateTexture(key, STRIP_W + PAD * 2, MARQUEE_H + PAD * 2)
  g.destroy()
  return key
}

// Module-level standings cache: the last live board summary, so a return to Home paints the live
// line instantly and a fetch only refreshes it. Keyed by DAY — a rolled-over board falls back.
interface RaceLineData {
  day: string
  myRank: number | null
  myScore: number | null
  /** Players on today's board (the fetched top rows — the whole board at friends scale). */
  total: number
}
let raceLineCache: RaceLineData | null = null

/** DEV: seed the standings-line cache with a deterministic fixture (`?raceline=<variant>`). */
export function devSeedRaceLine(variant: string | null): void {
  const d = dayKey()
  if (variant === 'out') raceLineCache = { day: d, myRank: 14, myScore: 1310, total: 25 }
  else if (variant === 'new') raceLineCache = { day: d, myRank: null, myScore: null, total: 7 }
  else raceLineCache = { day: d, myRank: 3, myScore: 7300, total: 12 }
}

/**
 * The live standings row — `today #R of M · week N` on its own strip, with a chevron — and the WHOLE
 * strip is a pressable that opens the race panel. Paints from the module cache instantly, refreshes
 * from `fetchDailyBoard` when signed in, and falls back to the save-local line when offline, dormant
 * or the board is still empty — never blank, never a spinner.
 *
 * BOTH halves of the race in one line, deliberately. The rank is today's, because that is the thing
 * that expires tonight; the `week` figure behind it is the season total the run just fed. Show only
 * the daily rank and the weekly board becomes invisible from Home — and the weekly board is the
 * reason to come back tomorrow rather than only today.
 *
 * The weekly figure is read from the SAVE (`endlessWeekStanding` — the player's own daily bests,
 * summed) rather than fetched. It is the same number the server would return, it is free, and it
 * survives being offline. A second device's runs are the one case it can lag, and the panel's THIS
 * WEEK tab shows the authoritative total a tap away.
 *
 * This used to be bare text with a small `›` glued on the end, and players did not read it as something
 * you could tap — it looked like a caption for the ENDLESS button above it. Three things fix that, in
 * the order they do the work: it now sits on its own **container** (`ensureRaceStrip`), the chevron is
 * a real affordance pinned at the strip's right edge instead of a punctuation mark inside the sentence,
 * and the press moves the strip itself rather than only fading the text. The label stays on body ink —
 * see the note at its declaration for why it deliberately did NOT move to the interactive gold.
 */
export function addDailyRaceStrip(scene: Phaser.Scene, x: number, y: number, save: SaveData): Phaser.GameObjects.Container {
  const week = endlessWeekStanding(save)
  /** The season tail — omitted entirely on a week with nothing in it, so a new player sees one idea. */
  const weekTail = week.total > 0 ? `  ·  week ${week.total.toLocaleString()}` : ''
  const lineFor = (data: RaceLineData | null): string => {
    if (data && data.myRank !== null) {
      const total = Math.max(data.total, data.myRank)
      return `today #${data.myRank} of ${total}${weekTail}`
    }
    if (data && data.total > 0) return `today · ${data.total} racing${weekTail || '  ·  set the pace'}`
    // Offline / dormant / empty board — the save-local line the module replaced (never blank).
    const best = endlessBestToday(save)
    if (best > 0) return `today’s best ${best.toLocaleString()}${weekTail}`
    return week.total > 0 ? `new board today${weekTail}` : `new board today  ·  set the pace`
  }
  const cached = raceLineCache && raceLineCache.day === dayKey() ? raceLineCache : null
  return addRaceStrip(scene, x, y, {
    initial: lineFor(cached),
    refresh: async () => {
      const board = await fetchDailyBoard(25)
      if (board.entries.length === 0) return null // dormant/empty → keep the fallback line + stale cache
      raceLineCache = { day: board.key, myRank: board.myRank, myScore: board.myScore, total: board.entries.length }
      return lineFor(raceLineCache)
    },
    open: () => openRacePanel(scene),
  })
}

/** Today's leader, cached across scene restarts the way `raceLineCache` caches your own standing. */
interface LeaderLineData {
  day: string
  name: string
  score: number
  /** The leader IS the signed-in player — the line says so rather than quoting their own name back. */
  you: boolean
}
let leaderCache: LeaderLineData | null = null

/** A long handle must not push the score under the chevron; the panel behind it shows the full name. */
const LEADER_NAME_MAX = 14

/**
 * TODAY'S LEADER — the top of the endless board, on the play screen, while the run is still live.
 *
 * `addDailyRaceStrip` answers "where am I", which is the right question on Home, where you are
 * choosing what to play. Mid-run players ask a different one out loud — "what do I have to beat" —
 * and until now the only way to answer it was to leave the run. So this strip leads with the score at
 * the top of the board and names who set it. Same component and the same panel on tap; only the line
 * differs, which is the point: two questions, one control, no second thing to keep in sync.
 *
 * It never opens as a spinner. The cached leader paints synchronously, the fetch replaces it if it
 * resolves, and signed-out / offline / dormant falls back to the save-local best exactly as the Home
 * strip does — a strip that blanked while the network thought about it would be worse than a slightly
 * stale one. The line is a SNAPSHOT taken when the scene builds, not a live poll: a run ends on the
 * results screen, so the next run rebuilds it, and polling mid-run would spend battery to move a
 * number the player cannot act on until they finish anyway.
 */
export function addEndlessLeaderStrip(
  scene: Phaser.Scene,
  x: number,
  y: number,
  save: SaveData
): Phaser.GameObjects.Container {
  const shortName = (n: string): string =>
    n.length > LEADER_NAME_MAX ? `${n.slice(0, LEADER_NAME_MAX - 1)}…` : n
  const lineFor = (d: LeaderLineData | null): string => {
    if (d) {
      return d.you
        ? `you lead  ·  ${d.score.toLocaleString()}`
        : `#1 ${shortName(d.name)}  ·  ${d.score.toLocaleString()}`
    }
    // Offline / signed out / nobody has posted yet — never blank, same ladder as the Home strip.
    const best = endlessBestToday(save)
    if (best > 0) return `today’s best ${best.toLocaleString()}`
    return 'new board today  ·  set the pace'
  }
  const cached = leaderCache && leaderCache.day === dayKey() ? leaderCache : null
  return addRaceStrip(scene, x, y, {
    initial: lineFor(cached),
    refresh: async () => {
      const board = await fetchDailyBoard(25)
      const top = board.entries[0]
      if (!top) return null // dormant/empty → keep the fallback line rather than blanking it
      leaderCache = { day: board.key, name: top.name, score: top.score, you: top.you }
      return lineFor(leaderCache)
    },
    open: () => openRacePanel(scene),
  })
}

/**
 * The LEVEL RACE standings row — the campaign ladder's counterpart to the weekly strip, and the same
 * physical component (one definition, so the two can never drift apart the way a copy would).
 *
 * Its fallback line is the interesting half: the weekly strip can fall back to a score the save
 * already knows, and so can this one — `levelStanding` is pure and reads straight off the save, so a
 * signed-out or offline player still sees exactly how far they have got. They just don't see who
 * else is on the ladder.
 */
export function addLevelRaceStrip(scene: Phaser.Scene, x: number, y: number, save: SaveData): Phaser.GameObjects.Container {
  const stand = levelStanding(save)
  const local =
    stand.cleared > 0 ? `your climb · level ${stand.cleared} · ★${stand.stars}` : `clear a level to join the ladder`
  return addRaceStrip(scene, x, y, {
    // Marquee, not the quiet row (owner call, 2026-07-30): on LevelSelect this strip is the header's
    // only control and the screen's subject, so it wears the loud face. The heading matches the
    // panel title it opens ('LEVEL RACE', BOARDS.levels) so the tap keeps its promise.
    marquee: { heading: 'LEVEL RACE', icon: '🏆' },
    initial: local,
    refresh: async () => {
      const b = await fetchLevelBoard(25)
      if (b.entries.length === 0) return null
      if (b.myRank === null) return `all time · ${b.entries.length} climbing · join them`
      const total = Math.max(b.entries.length, b.myRank)
      return `all time · #${b.myRank} of ${total} · level ${b.myScore ?? stand.cleared}`
    },
    open: () => openLevelRacePanel(scene),
  })
}

/** What a standings strip shows and does — the only things that differ between the two boards. */
interface StripSpec {
  /** The line painted immediately. Synchronous and never blank — a strip must never open as a spinner. */
  initial: string
  /**
   * Optional live refresh → the new line, or null to keep what's showing. Only called when signed
   * in; resolving null (dormant, empty board, offline) leaves the save-local fallback in place.
   */
  refresh?: () => Promise<string | null>
  /** What tapping the strip opens. */
  open: () => void
  /**
   * Present = the strip wears the marquee face (`ensureRaceStripMarquee`), a badge glyph at the left
   * end, and a small gold heading deck above the data line. The heading names the board so the data
   * line never has to — "your climb · level 21" alone never said LEADERBOARD, which is most of why
   * the plain strip still read as a caption even inside a container.
   */
  marquee?: { heading: string; icon: string }
}

/**
 * Shared standings-strip mechanics: the baked container plate, the pinned drifting chevron, the
 * whole-strip tap target and the sink-on-press. Both boards render through this, so a fix to the
 * affordance lands on both at once — which is the entire reason the weekly strip was extracted into
 * a component in the first place.
 */
function addRaceStrip(scene: Phaser.Scene, x: number, y: number, spec: StripSpec): Phaser.GameObjects.Container {
  const T = getTheme()
  const still = prefersReducedMotion()
  const mq = spec.marquee
  const stripH = mq ? MARQUEE_H : STRIP_H
  const container = scene.add.container(x, y)
  // Everything visible rides `face` so the press can sink it while the tap zone stays put — moving the
  // zone under a held finger is what makes a button flicker between over/out.
  const face = scene.add.container(0, 0)
  container.add(face)
  face.add(scene.add.image(0, 0, mq ? ensureRaceStripMarquee(scene) : ensureRaceStrip(scene)))
  if (mq) {
    // Badge left, chevron right — the same bracketing grammar a settings row uses, and it survives
    // any standings copy length (the widest line stays clear of both).
    face.add(scene.add.text(-STRIP_W / 2 + 40, 0, mq.icon, { fontFamily: FONT, fontSize: '26px' }).setOrigin(0.5))
    face.add(
      scene.add
        .text(-14, -14, mq.heading, { fontFamily: FONT, fontSize: '13px', fontStyle: '900', color: T.goldText })
        .setOrigin(0.5)
        .setLetterSpacing(3),
    )
  }
  // Nudged left of centre so the label sits optically centred against the pinned chevron. The label
  // deliberately stays on the high-contrast body ink (9:1) rather than moving to the interactive gold:
  // gold on this warm fill measures 4.13:1, which passes AA only because the text is large and heavy,
  // and this line carries real data — your rank, your best score. The strip and the chevron say
  // "tappable" on their own, exactly as a settings row does; the numbers should just stay readable.
  // (The marquee's small gold HEADING is the one exception, and it rides the lighter cardFill face
  // where goldText holds 4.53:1 — see ensureRaceStripMarquee.)
  const line = scene.add
    .text(-14, mq ? 10 : 0, '', { fontFamily: FONT, fontSize: mq ? '21px' : '20px', fontStyle: '900', color: T.inkSoft })
    .setOrigin(0.5)
  face.add(line)
  const chev = scene.add
    .text(STRIP_W / 2 - 30, -1, '›', { fontFamily: FONT, fontSize: '32px', fontStyle: '900', color: T.goldText })
    .setOrigin(0.5)
  face.add(chev)
  // A slow drift on the chevron — the same "there is more this way" cue the LevelSelect frontier
  // marker gives. One tween, off under reduced motion (§E8), where the strip alone carries the read.
  if (!still) {
    scene.tweens.add({ targets: chev, x: chev.x + 5, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
  }

  // No 🏆 prefix and no trailing `›`: the module already carries a trophy right above, and the
  // chevron is its own pinned object — both were doing their job badly inside the sentence.
  line.setText(spec.initial)

  // Refresh from the live board (dormant-safe: the fetches resolve empty and never throw).
  let alive = true
  container.once(Phaser.GameObjects.Events.DESTROY, () => {
    alive = false
  })
  if (spec.refresh && cloudSession()) {
    void spec.refresh().then(next => {
      if (alive && next !== null) line.setText(next)
    })
  }

  // The whole strip is the tap target (≥44pt tall) → its board's panel. Sized to the strip now,
  // not to the text, so the target no longer grows and shrinks as the standings copy changes.
  const zone = scene.add.rectangle(0, 0, STRIP_W, stripH, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  container.add(zone)
  // Press = the strip itself sinks and dims, the grammar every other control here uses. The old press
  // only faded the text, which is invisible on a surface players weren't reading as a control anyway.
  let pressTween: Phaser.Tweens.Tween | undefined
  const press = (down: boolean): void => {
    pressTween?.stop()
    if (still) {
      face.y = down ? 2 : 0
      face.setAlpha(down ? 0.85 : 1)
      return
    }
    pressTween = scene.tweens.add({
      targets: face,
      y: down ? 2 : 0,
      alpha: down ? 0.85 : 1,
      duration: down ? D.micro : D.settle,
      ease: down ? E.press : E.settle,
    })
  }
  /**
   * ⚠️ ARMED ON PRESS, not on release — the strip only opens if the gesture BEGAN on it.
   *
   * Phaser fires `pointerup` on whatever sits under the finger at release, regardless of where the
   * press started. In endless the strip sits directly above the board, which is a SWIPE surface, so
   * a player swiping up out of the top row released over the strip and had the standings panel open
   * on them mid-run (owner report, 2026-08-04). Raising ENDLESS_BOARD_DROP widened the gap, but
   * spacing alone cannot fix this: a drag ending on a control fires it from any distance.
   *
   * `pointerout` disarms, so dragging off and releasing elsewhere is a cancel — the same grammar
   * every platform's buttons use. A normal tap is unaffected: down and up on the same object.
   *
   * Deliberately fixed HERE rather than in ui.ts's `buildPressable`, which has the same bare
   * pointerup. Every other control in the game sits in a region where you TAP; this is the only one
   * pressed up against a surface where you SWIPE, so it is the only one that actually misfires.
   * Widening that change to every button in the app is a far larger blast radius than the bug.
   */
  let armed = false
  zone.on('pointerdown', () => {
    armed = true
    sfx.uiPress()
    press(true)
  })
  zone.on('pointerout', () => {
    armed = false
    press(false)
  })
  zone.on('pointerup', () => {
    press(false)
    if (!armed) return // the gesture started somewhere else — almost always a swipe off the board
    armed = false
    sfx.uiTap()
    sfx.whoosh() // §E3 B14: the airy sweep partners the panel opening
    spec.open()
  })
  return container
}

/**
 * Full-width DAILY RACE module for Home's ENDLESS block: the baked cream plate, the rose ENDLESS
 * play pill (via `onPlay` — Home owns the navigation), a trophy + "DAILY RACE" side dressing, and
 * the live tappable standings line underneath. Returns the container (joins Home's entrance stagger).
 *
 * "DAILY", not "WEEKLY", because the thing behind the pill is a board that expires tonight — that is
 * the promise the block has to make for a player to tap it today rather than on Sunday. The week is
 * still right there: the standings line carries its running total, and the panel opens on a TODAY /
 * THIS WEEK tab pair.
 */
export function addRaceModule(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  save: SaveData,
  onPlay: () => void
): Phaser.GameObjects.Container {
  const T = getTheme()
  const still = prefersReducedMotion()
  const container = scene.add.container(cx, cy)
  container.add(scene.add.image(0, 0, ensureModulePlate(scene)))
  // Side dressing flanking the pill: the race's trophy (left) + its name (right), quiet on the plate.
  const trophy = scene.add.text(-232, -32, '🏆', { fontFamily: 'sans-serif', fontSize: '34px' }).setOrigin(0.5)
  container.add(trophy)
  if (!still) {
    // A whisper of life on the trophy — slow hero breathe, phase-free (one tween, killed with the scene).
    scene.tweens.add({ targets: trophy, scale: 1.08, duration: D.breath, yoyo: true, repeat: -1, ease: E.hero })
  }
  container.add(
    scene.add
      .text(232, -32, 'DAILY\nRACE', {
        fontFamily: FONT,
        fontSize: '17px',
        fontStyle: '900',
        color: T.goldText,
        align: 'center',
        lineSpacing: 2,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )
  // The rose ENDLESS play pill stays the hero of the block (reparented into the module so the whole
  // block staggers in as one unit — addPillButton's press animates its inner face, so this is safe).
  // On the 152-tall plate (-76..76) the pill row sits at -32 → spans -68..4 with an 8px top margin,
  // and the strip at 42 → spans 16..68 with a matching 8px below: a 12px gutter between the two.
  container.add(addPillButton(scene, 0, -32, 340, 72, 'ENDLESS', ROSE_PILL, onPlay))
  container.add(addDailyRaceStrip(scene, 0, 42, save))
  return container
}

/**
 * The locked DAILY RACE module (below ENDLESS_UNLOCK_LEVEL): the same silhouette, dimmed and inert —
 * a quiet signpost ("something is coming right here"), deliberately non-interactive and flourish-free.
 */
export function addRaceLockedModule(scene: Phaser.Scene, cx: number, cy: number): Phaser.GameObjects.Container {
  const T = getTheme()
  const container = scene.add.container(cx, cy)
  container.add(scene.add.image(0, 0, ensureModulePlate(scene)).setAlpha(0.5))
  const lock = scene.textures.exists('lock')
    ? scene.add.image(-168, 0, 'lock').setDisplaySize(30, 37).setAlpha(0.5)
    : scene.add.text(-168, 0, '🔒', { fontFamily: 'sans-serif', fontSize: '30px' }).setOrigin(0.5).setAlpha(0.5)
  container.add(lock)
  container.add(
    scene.add
      .text(16, -16, 'DAILY RACE', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.inkFaint })
      .setOrigin(0.5)
      .setLetterSpacing(2)
      .setAlpha(0.8)
  )
  container.add(
    scene.add
      .text(16, 20, `unlocks at level ${ENDLESS_UNLOCK_LEVEL}`, { fontFamily: 'Arial, sans-serif', fontSize: '19px', color: T.inkFaint })
      .setOrigin(0.5)
      .setAlpha(0.8)
  )
  return container
}

// ─────────────────────────────────────────────────────────────────────────────
// DEV fixtures — deterministic boards for the `?race=<variant>` Home param, screenshots + audits.
// Names are invented handles (email local-part flavoured); nothing here ships to players (the Home
// call site is import.meta.env.DEV-gated, mirroring `?help`).
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fake ranked board: `youAt` marks a visible row as you; `myRank`/`myScore` place you outside. */
function fixtureBoard(youAt: number | null, myRank: number | null, myScore: number | null): RaceBoard {
  const names = [
    'goldrush', 'chipqueen', 'lucky.lou', 'marisol', 'dusty', 'sunburst',
    'cardshark', 'bellhop', 'renotwin', 'dulce', 'k-money', 'peachy',
  ]
  // Tier spread on purpose: the car, every medal rung, and several no-badge rows — so `?race=rich`
  // proves the whole ladder renders (and that a badge-less board still looks like it used to).
  const chapterSpread = [30, 21, 17, 12, 9, 4, 15, 7, 2, 5, 0, 10]
  const entries: LeaderboardEntry[] = names.map((name, i) => ({
    rank: i + 1,
    name,
    score: 9840 - i * 520 - (i * i) % 97, // descending with a little organic wobble
    you: youAt !== null && i + 1 === youAt,
    chapters: chapterSpread[i % chapterSpread.length],
  }))
  const mine = entries.find(e => e.you)
  return {
    key: dayKey(),
    entries,
    myRank: mine ? mine.rank : myRank,
    myScore: mine ? mine.score : myScore,
    myChapters: 12,
  }
}

/**
 * A fake SEASON board — the same 12 names carrying weekly totals and a turnout count, so the
 * `valueText` readout ("18,204 · 5d") and the rows it produces can be screenshotted. The turnout
 * deliberately does NOT descend in step with the total: #4 played all seven boards and still sits
 * behind #3 who played four, which is the exact shape a player needs to be able to read off the
 * board before they trust what the week is asking of them.
 */
function fixtureWeekBoard(youAt: number | null, myRank: number | null): RaceBoard {
  const rows: Array<[string, number, number]> = [
    ['goldrush', 42180, 7], ['chipqueen', 39640, 6], ['lucky.lou', 31220, 4],
    ['marisol', 30870, 7], ['dusty', 28450, 5], ['sunburst', 24110, 5],
    ['cardshark', 19980, 3], ['bellhop', 17640, 4], ['renotwin', 14300, 2],
    ['dulce', 11250, 3], ['k-money', 8120, 2], ['peachy', 4410, 1],
  ]
  const chapterSpread = [30, 20, 15, 10, 5, 8, 3, 12, 0, 6, 1, 25]
  const entries: LeaderboardEntry[] = rows.map(([name, total, days], i) => ({
    rank: i + 1,
    name,
    score: total,
    you: youAt !== null && i + 1 === youAt,
    valueText: `${total.toLocaleString()} · ${days}d`,
    chapters: chapterSpread[i % chapterSpread.length],
  }))
  const mine = entries.find(e => e.you)
  return {
    key: weekKey(),
    entries,
    myRank: mine ? mine.rank : myRank,
    myScore: mine ? mine.score : 9260,
    myValueText: mine ? mine.valueText : '9,260 · 2d',
    myChapters: 7,
  }
}

/** A deterministic crown-row winner for the fixtures — yesterday's, since the fixtures open on TODAY. */
function fixtureChampion(you: boolean): Champion {
  return { key: previousDayKey(), name: you ? 'dusty' : 'marisol', score: 11240, you }
}

/**
 * Map a `?race=<variant>` value to panel opts (DEV only). '' / unknown → live data path.
 *   rich     → 12 names, you at #5, yesterday's winner crown row (someone else)
 *   crownyou → 12 names, you at #2 — and YOU won yesterday (gold crown row + row crown)
 *   out      → 12 names, you at #14 (the pinned "your rank" footer), crown row present
 *   week     → the SEASON board: weekly totals with the "· 5d" turnout readout, you at #4
 *   weekout  → the season board with you at #19, outside the shown rows (footer in week units)
 *   empty    → a played-but-empty day ("be the first")
 *   loading  → the shimmer, held forever
 *   error    → the quiet RETRY card
 */
export function devRaceOpts(variant: string | null): RacePanelOpts {
  switch (variant) {
    case 'rich':
      return { boardOverride: fixtureBoard(5, null, null), championOverride: fixtureChampion(false) }
    case 'crownyou':
      return { boardOverride: fixtureBoard(2, null, null), championOverride: fixtureChampion(true) }
    case 'out':
      return { boardOverride: fixtureBoard(null, 14, 1310), championOverride: fixtureChampion(false) }
    case 'week':
      return {
        mode: 'weekly',
        boardOverride: fixtureWeekBoard(4, null),
        championOverride: { key: previousWeekKey(), name: 'marisol', score: 51330, you: false, valueText: '51,330 · 7d' },
      }
    case 'weekout':
      return { mode: 'weekly', boardOverride: fixtureWeekBoard(null, 19) }
    case 'empty':
      return { boardOverride: { key: dayKey(), entries: [], myRank: null, myScore: null } }
    case 'loading':
      return { simulate: 'loading' }
    case 'error':
      return { simulate: 'error' }
    default:
      return {}
  }
}

/**
 * A fake LEVEL ladder. Deliberately builds a board with TIES on the rung — three players sitting on
 * the same level, separated only by stars — because that is the normal shape of a level board and
 * the one case a fixture built from strictly-descending numbers would never show.
 */
function fixtureLevelBoard(youAt: number | null, myRank: number | null): RaceBoard {
  const rows: Array<[string, number, number]> = [
    ['goldrush', 300, 871], ['chipqueen', 300, 844], ['lucky.lou', 288, 802],
    ['marisol', 288, 771], ['dusty', 288, 749], ['sunburst', 241, 690],
    ['cardshark', 197, 540], ['bellhop', 152, 431], ['renotwin', 118, 330],
    ['dulce', 96, 244], ['k-money', 61, 158], ['peachy', 24, 57],
  ]
  const entries: LeaderboardEntry[] = rows.map(([name, cleared, stars], i) => ({
    rank: i + 1,
    name,
    score: cleared,
    you: youAt !== null && i + 1 === youAt,
    valueText: `${cleared} · ★${stars}`,
    // Derived exactly as production does — the ladder's badge IS its cleared column.
    chapters: chaptersFromCleared(cleared),
  }))
  const mine = entries.find(e => e.you)
  return {
    key: 'ALL TIME',
    entries,
    myRank: mine ? mine.rank : myRank,
    myScore: mine ? mine.score : 37,
    myValueText: mine ? mine.valueText : '37 · ★84',
    myChapters: 3,
  }
}

/**
 * Map a `?levels=<variant>` value to panel opts (DEV only) — the LEVEL RACE mirror of `devRaceOpts`.
 * Every variant forces `mode: 'levels'`, so the fixture proves the mode branch (title, subtitle, no
 * crown row, `valueText` readout) and not just the row layout.
 *   rich    → 12 climbers with tied rungs, you at #4
 *   out     → you at #17, outside the shown rows (the pinned footer, in level units)
 *   empty   → nobody on the ladder yet
 *   loading / error → the shared shimmer + RETRY states
 */
export function devLevelOpts(variant: string | null): RacePanelOpts {
  switch (variant) {
    case 'rich':
      return { mode: 'levels', boardOverride: fixtureLevelBoard(4, null) }
    case 'out':
      return { mode: 'levels', boardOverride: fixtureLevelBoard(null, 17) }
    case 'empty':
      return { mode: 'levels', boardOverride: { key: 'ALL TIME', entries: [], myRank: null, myScore: null } }
    case 'loading':
      return { mode: 'levels', simulate: 'loading' }
    case 'error':
      return { mode: 'levels', simulate: 'error' }
    default:
      return { mode: 'levels' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE EXPLAINERS — one card, two sets of rules.
//
// THE RACE. The format asks players to hold two ideas at once: today's board is its own contest, AND
// every day's best feeds a weekly total. That second half is the part nobody guesses. It is not
// visible in any single number on any screen — you only see it if you already know to look for it —
// and a player who doesn't know it reads the weekly board as "someone had an enormous run" rather
// than "someone showed up six days out of seven". Get that wrong and the whole reason to come back
// tomorrow is invisible.
//
// THE LADDER. Its unguessable half is the TIEBREAK. Ranked by level cleared, ties are not an edge
// case, they are the normal state of the board — a player who sees three names on level 47 and
// themselves third has no way to tell why from the numbers unless someone says "stars".
//
// So both are a DIAGRAM, not a paragraph. The week strip is the whole mental model in one glance:
// seven bars, one of them a hole where Wednesday should be, and a total underneath that is visibly
// the sum of the rest. The ladder strip is the same trick pointed at the other rule: three rows on an
// identical rung, so the only column that moves is the one doing the ranking. The missing bar and the
// unchanging rung do the teaching — you can see the rule without a sentence explaining it, which is
// the only way this lands for someone who is skimming. The three numbered beats above are the words
// for what the picture already showed.
//
// Which one opens is the caller's `mode`, because the ONE thing worse than no explainer is the wrong
// explainer: a player on the ladder tapping `?` and being told about midnight and weekly purses
// learns nothing about the board in front of them and mistrusts the next screen that offers help.
// ─────────────────────────────────────────────────────────────────────────────

/** Card geometry — its own, narrower than the board card: this is prose + a diagram, not a list of rows. */
const RULES_W = 640
const RULES_H = 1010

/**
 * The worked example. Deliberately a REALISTIC week, not a tidy one: the scores wobble, Thursday is
 * the best single day yet Thursday's player is not the story, and WEDNESDAY IS MISSING. A strip of
 * seven equal full bars would illustrate the arithmetic and none of the point.
 */
const WEEK_EXAMPLE: Array<{ day: string; score: number }> = [
  { day: 'M', score: 3150 },
  { day: 'T', score: 2980 },
  { day: 'W', score: 0 }, // skipped — the hole that does the teaching
  { day: 'T', score: 3400 },
  { day: 'F', score: 2760 },
  { day: 'S', score: 3010 },
  { day: 'S', score: 2904 },
]

/** One numbered beat: a struck rank coin, a heading, and one sentence. */
interface RuleBeat {
  n: number
  title: string
  body: string
}

/**
 * Every player-visible number here is READ FROM THE CONSTANT, never typed as a literal — the move
 * budget, both purses, the days in a week. A help screen that quietly disagrees with the game is
 * worse than no help screen, and this is exactly the copy that rots when a purse is retuned.
 */
function raceBeats(): RuleBeat[] {
  return [
    {
      n: 1,
      title: 'A NEW BOARD EVERY DAY',
      body: `Everyone in the world plays the SAME board each day — no goals, no boosts. Play it as many times as you like; your best score for the day is the one that counts.`,
    },
    {
      n: 2,
      title: 'THE WEEK TIGHTENS',
      body: `Monday opens easy: ${endlessWeekBounds().openMoves} moves on a clean board. Every day after that the board locks up a little more and the budget shortens — by Sunday you get ${endlessWeekBounds().finaleMoves} moves and up to ${endlessWeekBounds().maxLocks} locked squares. The same board for everyone, every day; it just stops being kind.`,
    },
    {
      n: 3,
      title: 'THE TOP SCORE WINS THE DAY',
      body: `At midnight the board closes and the highest score takes ${DAILY_PURSE.toLocaleString()} chips. Then a brand-new board opens and everyone starts level again.`,
    },
    {
      n: 4,
      title: 'YOUR DAYS ADD UP',
      body: `Each day's best is added to your week. Miss a day and you bank nothing for it — no single run can make that back. The biggest total when the week closes on Monday takes ${CHAMPION_PURSE.toLocaleString()} chips.`,
    },
  ]
}

/**
 * The week strip: seven bars on their own tracks, the skipped day left as an empty track, and the
 * running total underneath. Bars are drawn to scale against the best day so the wobble is real.
 *
 * Returns a container so the caller can stagger it in; the bars grow from the baseline under motion,
 * which is the one flourish here that carries meaning — you watch the total being built out of days.
 */
function buildWeekStrip(scene: Phaser.Scene, still: boolean): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const COL = 62
  const GAP = 12
  const TRACK_H = 104
  const total = WEEK_EXAMPLE.reduce((n, d) => n + d.score, 0)
  const played = WEEK_EXAMPLE.filter(d => d.score > 0).length
  const best = Math.max(...WEEK_EXAMPLE.map(d => d.score))
  const stripW = WEEK_EXAMPLE.length * COL + (WEEK_EXAMPLE.length - 1) * GAP
  const x0 = -stripW / 2 + COL / 2

  WEEK_EXAMPLE.forEach((d, i) => {
    const x = x0 + i * (COL + GAP)
    const g = scene.add.graphics()
    // The empty track behind every column — so a skipped day reads as a HOLE in something, rather
    // than as nothing at all. Without it Wednesday is just blank space and the eye skips it.
    g.fillStyle(T.cardFillAlt, 1)
    g.fillRoundedRect(x - COL / 2, -TRACK_H, COL, TRACK_H, 10)
    g.lineStyle(2, T.border, 0.8)
    g.strokeRoundedRect(x - COL / 2, -TRACK_H, COL, TRACK_H, 10)
    c.add(g)

    if (d.score > 0) {
      const h = Math.round(TRACK_H * (0.34 + 0.62 * (d.score / best)))
      const bar = scene.add.graphics()
      goldFace(bar, x - COL / 2 + 4, -h + 2, COL - 8, h - 4, T, 8)
      bar.lineStyle(2, T.goldDeep, 0.9)
      bar.strokeRoundedRect(x - COL / 2 + 4, -h + 2, COL - 8, h - 4, 8)
      const holder = scene.add.container(0, 0)
      holder.add(bar)
      c.add(holder)
      if (!still) {
        // Grow from the baseline: the bars ARE the days arriving, so they land left to right.
        holder.setScale(1, 0)
        holder.y = 0
        scene.tweens.add({ targets: holder, scaleY: 1, duration: D.settle, delay: D.base + 260 + i * 55, ease: E.settle })
      }
      c.add(
        scene.add
          .text(x, -h - 16, d.score.toLocaleString(), {
            fontFamily: FONT,
            fontSize: '15px',
            fontStyle: '900',
            color: T.inkSoft,
          })
          .setOrigin(0.5)
      )
    } else {
      // The hole, named. A bare gap reads as a rendering bug; "SKIPPED" reads as a decision.
      c.add(
        scene.add
          .text(x, -TRACK_H / 2, '—', { fontFamily: FONT, fontSize: '28px', fontStyle: '900', color: T.inkFaint })
          .setOrigin(0.5)
      )
      c.add(
        scene.add
          .text(x, -TRACK_H - 16, 'skipped', { fontFamily: 'Arial, sans-serif', fontSize: '14px', color: T.inkFaint })
          .setOrigin(0.5)
      )
    }

    c.add(
      scene.add
        .text(x, 20, d.day, {
          fontFamily: FONT,
          fontSize: '20px',
          fontStyle: '900',
          color: d.score > 0 ? T.inkMuted : T.inkFaint,
        })
        .setOrigin(0.5)
    )
  })

  // The sum, stated as a sum. "= 18,204 · 6 days" is the sentence the picture was making.
  c.add(
    scene.add
      .text(0, 58, `=  ${total.toLocaleString()}  ·  ${played} of ${DAYS_PER_WEEK} days`, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(1)
  )
  return c
}

/**
 * The ladder's worked example: three players on the SAME rung. Ties are the normal case on a board
 * ranked by level cleared, not a curiosity, so the fixture that teaches it has to be a tie — a strip
 * of three descending levels would illustrate "higher is better", which nobody needed telling.
 *
 * Star totals are kept legal against the rung (3 a level × 47 = 141 max) because a help screen that
 * shows an impossible row is teaching the wrong game.
 */
const LADDER_RUNG = 47 // the rung all three share — the constant the diagram is built around
const LADDER_EXAMPLE: Array<{ name: string; stars: number; you?: boolean }> = [
  { name: 'marisol', stars: 131 },
  { name: 'you', stars: 118, you: true }, // the middle row: one above to chase, one below to hold off
  { name: 'renotwin', stars: 104 },
]

/** The ladder's beats. Same discipline as `raceBeats`: every number comes from a constant. */
function ladderBeats(): RuleBeat[] {
  return [
    {
      n: 1,
      title: 'ONE LADDER, ALL TIME',
      body: `Everyone climbing the ${LEVEL_COUNT}-level campaign shares one board, ranked by the highest level they have CLEARED. It never closes and never resets.`,
    },
    {
      n: 2,
      title: 'STARS BREAK THE TIE',
      body: `Plenty of players share a rung, so your stars decide who sits higher — up to 3 a level, added up across every level you have cleared. Level on both? Whoever got there first.`,
    },
    {
      n: 3,
      title: 'YOUR CLIMB POSTS ITSELF',
      body: `Clear a level while signed in and your row moves on its own. No purse rides on this board — the chips are in the daily race; this one is the long climb.`,
    },
  ]
}

/**
 * The ladder strip: three rows on an identical rung, on the board's own plates and rank coins, with
 * the level column repeating and the star column falling. The repetition IS the diagram — the eye
 * finds the one thing that changes down the column, which is the tiebreak, without reading a word.
 *
 * Rendered in the real row grammar (baked plate, struck coin, rose ring on YOUR row) rather than as
 * an abstract sketch, so a player looks back at the board and recognises what they were just shown.
 */
function buildLadderStrip(scene: Phaser.Scene, still: boolean): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const RW = 476
  const RH = 50
  const STEP = 60
  LADDER_EXAMPLE.forEach((p, i) => {
    const row = scene.add.container(0, i * STEP)
    // #1 wears the podium plate, the rest the plain row — the board's own hierarchy, in miniature.
    row.add(scene.add.image(0, 0, ensurePlate(scene, i === 0 ? 'podium' : 'row', RW, RH)))
    if (p.you) {
      const ring = scene.add.graphics()
      ring.lineStyle(3, T.rose, 0.95)
      ring.strokeRoundedRect(-RW / 2, -RH / 2, RW, RH, 14)
      row.add(ring)
    }
    const med = makeMedal(scene, i + 1, 17)
    med.setPosition(-RW / 2 + 32, 0)
    row.add(med)
    row.add(
      scene.add
        .text(-RW / 2 + 62, 0, p.name, {
          fontFamily: FONT,
          fontSize: '20px',
          fontStyle: '900',
          color: p.you ? T.ink : T.inkSoft,
        })
        .setOrigin(0, 0.5)
    )
    // The rung — deliberately IDENTICAL on all three rows, and in the quietest ink on the card, so it
    // reads as the constant it is. Everything the ranking is doing happens to its right.
    row.add(
      scene.add
        .text(RW / 2 - 118, 0, `level ${LADDER_RUNG}`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '19px',
          color: T.inkFaint,
        })
        .setOrigin(1, 0.5)
    )
    row.add(
      scene.add
        .text(RW / 2 - 24, 0, `★${p.stars}`, { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.goldText })
        .setOrigin(1, 0.5)
    )
    c.add(row)
    // The rows arrive top-down, in ranking order — the same cascade the board itself lands in.
    if (!still) fadeRise(scene, row, { rise: 10, delay: D.base + 260 + i * 70, duration: D.settle })
  })
  // The sentence the picture was making — the ladder's counterpart to the week strip's "= total".
  c.add(
    scene.add
      .text(0, (LADDER_EXAMPLE.length - 1) * STEP + 52, 'same rung  ·  the stars decide', {
        fontFamily: FONT,
        fontSize: '22px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(1)
  )
  return c
}

/**
 * What one explainer is. Everything the two disagree on lives here — heading, beats, the exhibit and
 * where it sits on its shelf — so `openRaceRulesPanel` renders either without knowing which it holds,
 * the same arrangement `BOARDS` uses for the boards themselves.
 */
interface RulesSpec {
  title: string
  subtitle: string
  beats: () => RuleBeat[]
  /** Caption over the shelf — names the exhibit, so the diagram never has to caption itself. */
  exhibit: string
  diagram: (scene: Phaser.Scene, still: boolean) => Phaser.GameObjects.Container
  /** Where the diagram's origin lands between the shelf's edges — each strip hangs differently. */
  diagramY: (shelfTop: number, shelfBottom: number) => number
}

/**
 * The race explainer serves BOTH tabs. They are two halves of one format — the weekly board is the
 * daily one summed — so splitting them into two explainers would have to repeat half of each, and the
 * relationship is the thing that needs explaining.
 */
const RULES: Record<'race' | 'levels', RulesSpec> = {
  race: {
    title: 'HOW THE RACE WORKS',
    subtitle: 'two races, one run',
    beats: raceBeats,
    exhibit: 'A WEEK THAT MISSED A DAY',
    diagram: buildWeekStrip,
    // Baseline-anchored: the day letters and the total hang BELOW the bars' baseline.
    diagramY: (_top, bottom) => bottom - 96,
  },
  levels: {
    title: 'HOW THE LADDER WORKS',
    subtitle: 'one ladder, all time',
    beats: ladderBeats,
    exhibit: 'THREE PLAYERS, ONE RUNG',
    diagram: buildLadderStrip,
    // Top-anchored: the strip grows downward from its first row, so it hangs under the caption.
    diagramY: top => top + 82,
  },
}

/** Double-open latch — its own, so the rules can open OVER the board panel without fighting its latch. */
let rulesOpen = false

/**
 * Open the explainer for a board. Reachable from the board panel's `?` chip and from the how-to-play
 * panel's RACE RULES button, because the two audiences arrive from opposite directions: one is
 * already looking at a leaderboard they don't understand, the other is reading the manual.
 *
 * `mode` is the board being explained, so the `?` chip can hand over whichever board is on screen —
 * the two race tabs share the race explainer, the ladder gets its own. It defaults to the race for
 * the manual's door, which has no board in front of it and means the endless race when it says RACE.
 */
export function openRaceRulesPanel(scene: Phaser.Scene, mode: BoardMode = 'daily'): void {
  if (rulesOpen) return
  rulesOpen = true
  const R = RULES[mode === 'levels' ? 'levels' : 'race']
  const T = getTheme()
  const still = prefersReducedMotion()
  const layer = scene.add.container(0, 0).setDepth(70) // above the board panel (60) — it opens on top
  const close = (): void => {
    rulesOpen = false
    sfx.whoosh()
    layer.destroy()
  }
  layer.once(Phaser.GameObjects.Events.DESTROY, () => {
    rulesOpen = false
  })

  const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH(), T.scrim, 0.62).setInteractive()
  scrim.on('pointerup', close)
  layer.add(scrim)

  const root = scene.add.container(W / 2, H / 2)
  layer.add(root)
  const cx = -RULES_W / 2
  const cy = -RULES_H / 2
  const g = scene.add.graphics()
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(T.shadow, 0.08)
    g.fillRoundedRect(cx, cy + i * 3, RULES_W, RULES_H, 30)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(cx, cy, RULES_W, RULES_H, 30)
  g.lineStyle(4, T.goldBezel, 1)
  g.strokeRoundedRect(cx, cy, RULES_W, RULES_H, 30)
  accentRimTop(g, cx, cy, RULES_W, 30, { alpha: 0.85 })
  root.add(g)
  root.add(scene.add.rectangle(0, 0, RULES_W, RULES_H, 0xffffff, 0.001).setInteractive())

  root.add(
    scene.add
      .text(0, cy + 58, R.title, { fontFamily: FONT, fontSize: '38px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setLetterSpacing(2)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  )
  root.add(
    scene.add
      .text(0, cy + 100, R.subtitle, { fontFamily: 'Arial, sans-serif', fontSize: '21px', color: T.inkMuted })
      .setOrigin(0.5)
  )

  // The three beats. The coin numerals are the board's own rank medallions at a small radius — the
  // same struck-metal language, so the explainer reads as part of the race rather than as a document
  // about it.
  const beats = R.beats()
  let y = cy + 152
  const textX = cx + 104
  beats.forEach((b, i) => {
    const coin = makeMedal(scene, b.n, 24)
    coin.setPosition(cx + 56, y + 26)
    root.add(coin)
    const title = scene.add
      .text(textX, y, b.title, { fontFamily: FONT, fontSize: '23px', fontStyle: '900', color: T.ink })
      .setOrigin(0, 0)
      .setLetterSpacing(1)
    const body = scene.add
      .text(textX, y + 32, b.body, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '19px',
        color: T.inkMuted,
        wordWrap: { width: RULES_W - (textX - cx) - 44 },
        lineSpacing: 5,
      })
      .setOrigin(0, 0)
    root.add([title, body])
    if (!still) {
      fadeRise(scene, title, { delay: D.base + i * 70, rise: 10 })
      fadeRise(scene, body, { delay: D.base + i * 70 + 30, rise: 10 })
      popIn(scene, coin, { from: 0.4, delay: D.base + i * 70, overshoot: OVERSHOOT.pop })
    }
    y += 42 + body.height + 26
  })

  // The diagram, on its own warm shelf so it reads as an exhibit rather than more page.
  const shelfTop = y + 4
  const shelfBottom = cy + RULES_H - 118
  const shelf = scene.add.graphics()
  shelf.fillStyle(T.cardFillWarm, 1)
  shelf.fillRoundedRect(cx + 24, shelfTop, RULES_W - 48, shelfBottom - shelfTop, 22)
  shelf.lineStyle(2, T.goldBezel, 0.85)
  shelf.strokeRoundedRect(cx + 24, shelfTop, RULES_W - 48, shelfBottom - shelfTop, 22)
  root.add(shelf)
  root.add(
    scene.add
      .text(0, shelfTop + 26, R.exhibit, {
        fontFamily: FONT,
        fontSize: '17px',
        fontStyle: '900',
        color: T.inkFaint,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )
  const strip = R.diagram(scene, still)
  strip.setPosition(0, R.diagramY(shelfTop, shelfBottom))
  root.add(strip)

  root.add(addPillButton(scene, 0, cy + RULES_H - 62, 260, 68, 'GOT IT', GOLD_PILL, close))

  if (still) {
    root.setAlpha(1)
  } else {
    root.setAlpha(0)
    scene.tweens.add({ targets: root, alpha: 1, duration: D.base, ease: E.settle })
    popIn(scene, root, { from: 0.94, duration: D.pop, overshoot: OVERSHOOT.gentle })
  }
}

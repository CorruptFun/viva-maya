import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { endlessUnlocked } from '../core/endless'
import { levelStanding } from '../core/leaderboard'
import { CHAPTER_LEVELS, LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { trophyFor } from '../core/trophies'
import { openShowroom } from '../view/showroom'
import { ensureGlyphTexture } from '../view/textures'
import { addCasinoBackdrop } from '../view/background'
import { addScreenGloss } from '../view/fx'
import { RACE_MARQUEE_H, addLevelRaceStrip, addRaceModule } from '../view/leaderboardpanel'
import { D, E, OVERSHOOT, backOut } from '../view/motion'
import { quality } from '../view/quality'
import { addStashDoor } from '../view/stash'
import { getTheme, prefersReducedMotion, reduceFlashing } from '../view/theme'
import { FONT, GHOST_PILL, GOLD_PILL, addGoldWordmark, addMuteChip, addPillButton, applyEntrance, goldFace, startScene } from '../view/ui'

const GRID_COLS = 5
const CHIP = 108
const GAP = 18
const ROW_H = CHIP + GAP
const TOP_PAD = 10
/**
 * L6 · windowed grid. `LEVEL_COUNT` is 300, so building the whole ladder up front put ~1,400 Game
 * Objects on screen — 300 of them Graphics, and each Graphics breaks Phaser's sprite batch into its
 * own draw call — plus a single trail Graphics carrying ~2,400 tessellated dots. Measured on the dev
 * build that grid was ~100% of the frame cost (chips and trail roughly half each), which is the
 * scroll lag. Now only the rows the mask can actually show are built, plus `ROW_BUFFER` rows of
 * headroom either side so even a hard flick never scrolls into a hole; rows that leave the window are
 * destroyed. Live object count is flat in `LEVEL_COUNT` — the list stays smooth at 300 levels or 3,000.
 * Scroll BOUNDS still span the full ladder, so this is invisible to the player: no paging, no "show
 * more", the same one continuous scroll to level 300.
 */
const ROW_BUFFER = 2
/**
 * ── The header band, budgeted in one place ───────────────────────────────────
 * Three things share the top of this screen and they had drifted into each other: the title row
 * (back button, stash door, LEVELS wordmark, star tally), the LEVEL RACE marquee under it, and the
 * grid mask under that. The seats used to be four unrelated literals, and the arithmetic that kept
 * them apart lived only in comments — so when the stash door arrived with a count badge hanging
 * 29px below its own centre, it landed on the marquee's top edge with ONE design pixel to spare
 * (owner screenshot, 2026-08-04) and nothing in the code disagreed.
 *
 * Now the row seat and the strip seat are named, and everything below them is derived:
 *   title row  84 · door art 60–108, star tally 61–107, wordmark + shadow ≈ 59–119
 *   marquee   166 · art 136–196 (RACE_MARQUEE_H tall) → 17px under the wordmark's shadow
 *   grid mask 210 · strip bottom + HEADER_AIR
 * Costs the ladder 14px against the old 196 — about a ninth of a row — and buys every neighbour
 * real clearance instead of a rounding error. Move a seat and the mask follows on its own; add
 * anything else up here and budget it against these, not against a fresh literal.
 */
const HEADER_ROW_Y = 84
const RACE_STRIP_Y = 166
const HEADER_AIR = 14
/** L2: gold frame band width — a milestone chip's cream face insets this much so the baked `goldFace` rim shows as an ornamental border. */
const MILESTONE_FRAME = 7
/**
 * Grid entrance cascade: per (visible) row delay + a small per-column offset + pop duration, tuned so
 * the whole ripple lands under ~600ms. The column offset turns the old row-at-a-time drop into a
 * diagonal wave that sweeps the grid the way the journey trail reads (left→right, top→bottom).
 */
const CASCADE_STAGGER = 36
const CASCADE_COL_STAGGER = 13
const CASCADE_DURATION = 200
/**
 * L1 flick-scroll tuning. Velocity is carried as content-px per 60fps frame; on release the drag's
 * smoothed velocity is decayed by `FLICK_FRICTION` every update() frame — the exponential glide a
 * native list uses — reusing the drag's [minScroll,maxScroll] clamp so it can never fling off-screen.
 */
const FRAME_MS = 1000 / 60
const FLICK_FRICTION = 0.92 // per-frame velocity retention — sets the coast length / "native list" feel
const FLICK_MIN = 1.2 // min release speed (px/frame) that counts as a flick — a slow drag still stops dead
const FLICK_STOP = 0.4 // speed (px/frame) below which the coast snaps to rest
const FLICK_IDLE_MS = 90 // a release this long after the last move is a hold, not a flick → no throw
/**
 * L4 map-trail tuning. The "journey" line is baked as ONE Graphics of faint dots stamped every
 * `TRAIL_DOT_GAP` px between consecutive chip centres; travelled segments (up to the current chip)
 * glow at `TRAIL_LIT_ALPHA`, the run beyond sits muted at `TRAIL_DIM_ALPHA`. `TRAIL_RETURN_BOW` bows
 * each row-wrap "carriage return" downward so the path winds rather than cutting a hard diagonal.
 */
/**
 * L5 rubber-band edges. Dragging past a bound moves the grid at `EDGE_RESIST` of the finger (capped at
 * `EDGE_MAX` px of stretch) and springs back on release; a flick that slams a bound converts its
 * remaining speed into a small overshoot (≤ `EDGE_BOUNCE_MAX`) that springs back — the native-list
 * edge feel. Reduced motion (§E8) keeps today's hard clamp on both paths.
 */
const EDGE_RESIST = 0.3
const EDGE_MAX = 72
const EDGE_BOUNCE_MAX = 40
const TRAIL_DOT_GAP = 15
const TRAIL_DOT_R = 3.4
/** Polygon sides per trail dot — at r=3.4 an octagon is indistinguishable from a circle (see `dot`). */
const TRAIL_DOT_SIDES = 8
const TRAIL_LIT_ALPHA = 0.5
const TRAIL_DIM_ALPHA = 0.26
const TRAIL_RETURN_BOW = 16

/**
 * L7 · CHAPTERS — the structure a 300-rung ladder needs.
 *
 * Sixty rows of numbered chips is a list, not a map: nothing told you where in three hundred levels
 * you were standing. The game already speaks in decades — a milestone splash every 10th level, and
 * `MILESTONE_FRAME`'s gilded chip marking each one — so the decade is the grouping that was already
 * in the design's vocabulary, and it costs no new concept to promote it to a labelled chapter.
 *
 * The one structural gift: 10 levels ÷ `GRID_COLS` is exactly 2 rows, so a chapter boundary can only
 * ever fall on a row boundary. That keeps the block pitch a CONSTANT `CHAP_H`, which is the whole
 * reason the windowed grid's scroll→row inverse stays closed-form (see `rowIndexAt`) instead of
 * turning into a search — the layout change costs the hot path two extra divisions, nothing more.
 */
const CHAPTER_ROWS = CHAPTER_LEVELS / GRID_COLS
/** Ribbon plate height, and the band each chapter reserves above its first row for it. */
const RIBBON_H = 32
const CHAPTER_GAP = 48
/** Block pitch: a chapter's ribbon band plus its rows. Constant — see the note above. */
const CHAP_H = CHAPTER_ROWS * ROW_H + CHAPTER_GAP
/** Ribbon width — the grid's own width, so the chapter reads as a header FOR these chips. */
const GRID_W = GRID_COLS * CHIP + (GRID_COLS - 1) * GAP

/** Baked-face padding: room for the down-cast contact shadow so `generateTexture` can't clip it. */
const CHIP_PAD = 10
/** Chip corner radius — shared by the fill and every stroke on a plate (cookbook §2b). */
const CHIP_R = 20
/** The current chip's plate is drawn this much bigger than a cell, so "you are here" wins on SIZE too. */
const CURRENT_GROW = 8
/** Gold frame band on the current chip — deliberately wider than `MILESTONE_FRAME` so the two differ. */
const CURRENT_FRAME = 11

/**
 * Minimum interactive edge in DESIGN px (§E8 / cookbook §9) — 84 ≈ 44pt at this design scale. Mirrors
 * `ui.ts`'s private `MIN_HIT`, which already grows every pill and chip zone to it; the shared
 * standings strips are the one control that predates the rule (see `growTouchTarget`).
 */
const MIN_TOUCH = 84

/** Which face a chip wears. One baked texture per kind, shared by every chip that wears it. */
type ChipKind = 'cleared' | 'current' | 'milestone' | 'next' | 'locked' | 'lockedMilestone'

/** Content-local y of chapter `c`'s ribbon band (its top edge). */
function chapterTop(viewTop: number, chapter: number): number {
  return viewTop + TOP_PAD + chapter * CHAP_H
}

/**
 * Content-local y of row `row`'s TOP edge — the ONE source for row placement. The formula used to be
 * copy-pasted into buildRow, drawTrail, syncWindow and create()'s open-scroll; adding the chapter band
 * to four independent copies is exactly how a grid drifts out of step with its own hit areas.
 */
function rowTop(viewTop: number, row: number): number {
  return chapterTop(viewTop, Math.floor(row / CHAPTER_ROWS)) + CHAPTER_GAP + (row % CHAPTER_ROWS) * ROW_H
}

/**
 * Inverse of `rowTop`: the row whose BAND contains content-local `y`. A row's band runs from where it
 * may start drawing to where the next row does — so the ribbon gap belongs to the chapter's first row,
 * and the 18px gutter under a chip belongs to the chip above it. That makes the map monotone and
 * total, and makes it CONSERVATIVE at both ends: a y in a gutter names the row above rather than the
 * row below, so the span [rowIndexAt(top), rowIndexAt(bottom)] can never miss a visible row (it may
 * name one extra, which `ROW_BUFFER` was already paying for). Closed-form — no loop, no search.
 */
function rowIndexAt(viewTop: number, y: number): number {
  const rel = y - viewTop - TOP_PAD
  const chapter = Math.floor(rel / CHAP_H)
  const within = rel - chapter * CHAP_H
  return chapter * CHAPTER_ROWS + (within < CHAPTER_GAP + ROW_H ? 0 : 1)
}

export class LevelSelectScene extends Phaser.Scene {
  /** Largest pointer travel during the current press — a tap on a chip only fires below this. */
  private dragMoved = 0
  /** Beat 5: set when routed here straight from a win, so the newly-current chip celebrates. */
  private fromWin = false
  /** Beat 5 · L6: latches once the win arrival has been celebrated, so a row rebuild can't replay it. */
  private celebrated = false
  /** L1: masked level-grid container (its `y` is the scroll offset) — held so update() can coast it. */
  private scrollContent?: Phaser.GameObjects.Container
  /** L1: the drag clamp's bounds, captured so the fling reuses the exact same [min,max] limits. */
  private minScroll = 0
  private maxScroll = 0
  /** L1: flick velocity (content-px/frame); friction-decayed each update() after release, 0 at rest. */
  private scrollVel = 0
  /** L5: in-flight edge snap-back / bounce tween — stopped the instant a new touch grabs the list. */
  private edgeSpring?: Phaser.Tweens.Tween | Phaser.Tweens.TweenChain
  /** L8: in-flight RECALL glide (the "back to my level" tween) — likewise handed back on touch. */
  private scrollTween?: Phaser.Tweens.Tween
  /** C4: rising-edge latch for `quality.idle()` — true once the current idle beat has fired; re-armed on activity. */
  private wasIdle = false
  /** C4: the current-level chip + its steady "you are here" breathe — the idle beat pauses it for one nudge. */
  private currentChip?: Phaser.GameObjects.Container
  private currentChipPulse?: Phaser.Tweens.Tween
  /** L6: the live rows of the windowed grid, keyed by row index — the build/destroy ledger. */
  private rowNodes = new Map<number, Phaser.GameObjects.Container>()
  /** L6: the row span currently built (inclusive), so syncWindow() early-outs on an unchanged window. */
  private winFirst = -1
  private winLast = -1
  /** L8: the RECALL pill + its shown/hidden latch (see `updateScrollChrome`). */
  private recall?: Phaser.GameObjects.Container
  private recallShown = false
  /** L8: the scroll offset that frames the current level — where RECALL glides back to. */
  private homeScrollY = 0
  /** L8: the current level's row, so the visibility test is two adds instead of a search. */
  private currentRow = -1
  /** L8: scroll-rail thumb + the travel it maps the scroll range onto (undefined when the list fits). */
  private railThumb?: Phaser.GameObjects.Image
  private railTop = 0
  private railTravel = 0
  /** L8: last content.y the scroll chrome was painted for — the whole update is skipped when it hasn't moved. */
  private chromeY = Number.NaN
  /** L6: grid geometry + the save snapshot a row needs, captured once per create() for the row builder. */
  private grid?: {
    startX: number
    viewTop: number
    viewBottom: number
    rows: number
    unlocked: number
    stars: Record<number, number>
    content: Phaser.GameObjects.Container
    trail: Phaser.GameObjects.Graphics
  }

  constructor() {
    super('levelselect')
  }

  init(data: { fromWin?: boolean }): void {
    this.fromWin = data?.fromWin === true
    this.celebrated = false
  }

  create(): void {
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    this.cameras.main.setScroll(0, restScrollY()) // centre the design box in the taller world
    applyEntrance(this, undefined, { zoomSettle: true }) // §E10 push-in + §F2 light-wipe (no-op under RM)
    // C4: reset the idle-attract state per entry — Phaser reuses the scene instance across navigation, so
    // clear the latch + any stale current-chip/tween ref (e.g. from a visit that HAD a current chip) before
    // the grid rebuilds; startChipPulse re-captures the live chip once its entrance settles.
    this.wasIdle = false
    this.currentChip = undefined
    this.currentChipPulse = undefined
    this.edgeSpring = undefined // L5: stale tween refs die with the old grid — never resurrect one
    this.scrollTween = undefined // L8: ditto for the RECALL glide
    // L8: every scroll-chrome handle points at objects the previous visit's shutdown destroyed. Field
    // initializers do NOT re-run on restart (§11), so they are cleared here or the first update() nudges
    // a corpse; `chromeY` goes to NaN so the first frame always repaints rather than trusting a stale y.
    this.recall = undefined
    this.recallShown = false
    this.railThumb = undefined
    this.chromeY = Number.NaN
    // L6: the previous visit's rows died with its display list — drop the stale ledger so the first
    // syncWindow() rebuilds the window from scratch rather than trusting handles to destroyed rows.
    this.rowNodes.clear()
    this.winFirst = -1
    this.winLast = -1
    const save = loadSave()
    addCasinoBackdrop(this, 'menu')
    addScreenGloss(this) // same "inside the glass" finish as Home (tier-gated, static under RM)
    // Depth 50 puts the scene chrome above the scrolling grid for input as well as drawing — the same
    // rank addMuteChip already takes. The chip hit areas are clipped to the viewport (see buildChip),
    // so this is belt-and-braces: nothing in the list can outrank the way out of the screen.
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this, 'home')).setDepth(50)
    addMuteChip(this, 676, 40)

    // ── Header ────────────────────────────────────────────────────────────────────────────────────
    // The screen used to open under the VIVA MAYA marquee — Home's hero wordmark, repeated. It looked
    // like the front door and told you nothing about the room, which is half of why sixty rows of
    // numbered chips read as a settings list. A destination scene gets a destination TITLE here (the
    // pattern StoreScene already ships: gold gradient wordmark, letterspaced, one soft drop shadow),
    // and the word matches the button on Home that opens it, so the label carries across the transition.
    addGoldWordmark(this, DESIGN_W / 2, HEADER_ROW_Y, 'LEVELS', { size: 50 })
    // Total stars banked. The save has banked one on every win since launch and the all-time LEVEL RACE
    // ladder ranks on them, yet nothing in the app ever showed the number — an accumulated resource with
    // no read-out. It sits in the title row (right of the wordmark, clear of the mute chip's band) as a
    // pure readout, never interactive, so it cannot compete with the ‹ back button for a tap.
    // x=574 (was 596): the row moved up 8px to open the band below it, which walked the tally's
    // 140-wide plate into the mute chip's 52px art. Pulling it 22px left restores the gap in x, where
    // it does not cost the header any height.
    this.addStarTally(574, HEADER_ROW_Y, levelStanding(save).stars)

    // THE STASH DOOR, second of two. Home's line was the only way in, so a player who started a
    // level from this grid never passed the stash and never had the chance to choose what went in
    // with them. Seated in the gap this row leaves between the back button (ends 106) and the LEVELS
    // wordmark (starts ~243) — the 124-wide door spans 112–236 there, so the two margins are 6px and
    // 7px. A change repaints the scene, because the door's count and the grid's own chips both read
    // the save at build time.
    this.add.existing(addStashDoor(this, 174, HEADER_ROW_Y, { onChanged: () => this.scene.restart() }))

    const endless = endlessUnlocked(save)
    // Derived from the strip below the title row, never re-typed — see the HEADER_ROW_Y block.
    const viewTop = RACE_STRIP_Y + RACE_MARQUEE_H / 2 + HEADER_AIR
    // 1072 when ENDLESS is offered: the footer is now the SAME daily-race module Home seats its
    // ENDLESS pill in (plate + pill + standings strip), so the strip is visibly PART of the endless
    // block instead of a twin of the level strip. Without ENDLESS the footer is empty and the grid
    // takes the whole box. `viewBottom` is the single source for both the mask and the chip hit-area
    // clip, so they stay in lockstep for free.
    const viewBottom = endless ? 1072 : 1232

    // The LEVEL RACE strip, promoted out of the footer into the header — and since 2026-07-30 it
    // wears the MARQUEE face (badge + gold heading deck + button-grammar plate; see StripSpec) —
    // the owner's read was that the quiet row still looked like a caption up here. It measures THIS
    // screen's subject — your campaign climb — so at the top it doubles as the "where am I" line,
    // and the two standings strips stop being twins without being forked (one shared component,
    // shared with Home, which keeps its deliberately-subordinate row face).
    // Seated at RACE_STRIP_Y — art 136–196 — which is the band the header block above budgets.
    // Grown to the §E8 touch floor, art untouched: the 84px target reaches up to y=124, into the
    // bottom edge of the back button's and the stash door's own zones — deliberately the safe way
    // round, because both are depth 50 and win the overlap, and the strip additionally arms on
    // pointerDOWN (leaderboardpanel), so a press that starts on a neighbour can never open it.
    const climb = addLevelRaceStrip(this, DESIGN_W / 2, RACE_STRIP_Y, save)
    this.growTouchTarget(climb)

    // Scrollable grid of level chips.
    const content = this.add.container(0, 0)
    const startX = (DESIGN_W - GRID_W) / 2
    // L4 · map "journey" trail — a faint dotted, winding line threading the chip centres in level
    // order, lit gold up to the current chip and muted beyond. Added FIRST so it sits UNDER every chip
    // (rows are only ever appended after it, so that ordering survives the L6 window churn); it lives
    // in `content`, so it rides L1's scroll (content.y) + the existing geometry mask (no second mask).
    // Static → reduced motion unaffected. L6: redrawn per window, not once for all 300 levels.
    const trail = this.add.graphics()
    content.add(trail)
    const rows = Math.ceil(LEVEL_COUNT / GRID_COLS)
    const contentBottom = rowTop(viewTop, rows - 1) + CHIP + 24

    const maskG = this.make.graphics({ x: 0, y: 0 }, false)
    maskG.fillStyle(0xffffff)
    maskG.fillRect(0, viewTop, DESIGN_W, viewBottom - viewTop)
    content.setMask(maskG.createGeometryMask())

    // Scroll bounds + the container, held on the scene so update()'s L1 fling reuses the exact clamp.
    // The bounds span the FULL ladder even though only a window of it is built — the player still has
    // one uninterrupted scroll from level 1 to LEVEL_COUNT.
    this.scrollContent = content
    this.scrollVel = 0
    this.minScroll = Math.min(0, viewBottom - contentBottom)
    this.maxScroll = 0
    // Open scrolled so the current level sits mid-viewport. L8 keeps that offset: it is exactly where
    // RECALL puts you back, so "where the screen opened" and "where the button returns to" can't drift.
    this.currentRow = Math.floor((Math.min(save.unlocked, LEVEL_COUNT) - 1) / GRID_COLS)
    const curCy = rowTop(viewTop, this.currentRow) + CHIP / 2
    this.homeScrollY = Phaser.Math.Clamp((viewTop + viewBottom) / 2 - curCy, this.minScroll, this.maxScroll)
    content.y = this.homeScrollY

    // L6: everything a row needs to build itself, so syncWindow() can mint rows mid-scroll. Set AFTER
    // content.y is finalised, so the opening window (and its entrance cascade) tracks what the player
    // actually sees.
    this.grid = { startX, viewTop, viewBottom, rows, unlocked: save.unlocked, stars: save.stars, content, trail }
    this.syncWindow(true)

    // Drag to scroll (chip taps are suppressed once the press has travelled — see buildChip). While
    // the finger is down the grid tracks it 1:1; L1 adds a flick — the release velocity is smoothed
    // during the drag and, unless motion is reduced, committed to update() to coast under friction.
    const reduced = this.prefersReducedMotion()
    let dragging = false
    let startPointerY = 0
    let startContentY = 0
    let lastMoveAt = 0 // this.time.now of the previous pointermove — for the per-move velocity delta
    let flickVel = 0 // smoothed drag velocity (content-px/frame), committed to this.scrollVel on release
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      dragging = true
      startPointerY = p.y
      startContentY = content.y
      this.dragMoved = 0
      this.scrollVel = 0 // touching the list halts any in-flight coast (native feel)
      this.edgeSpring?.stop() // L5: grabbing mid-bounce hands the grid straight back to the finger
      this.edgeSpring = undefined
      this.scrollTween?.stop() // L8: …and grabbing mid-RECALL likewise — the finger always wins
      this.scrollTween = undefined
      flickVel = 0
      lastMoveAt = this.time.now
    })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!dragging || !p.isDown) return
      const dy = p.y - startPointerY
      this.dragMoved = Math.max(this.dragMoved, Math.abs(dy))
      const prevY = content.y
      const target = startContentY + dy
      const clamped = Phaser.Math.Clamp(target, this.minScroll, this.maxScroll)
      if (reduced) {
        content.y = clamped
        return // reduced motion (§E8): hard-clamped 1:1 drag only — never build a fling velocity
      }
      // L5 rubber-band: past a bound the grid follows at EDGE_RESIST of the finger (capped), so the
      // end of the list reads as stretch, not a wall; pointerup below springs any stretch back.
      const excess = target - clamped
      content.y = clamped + Math.sign(excess) * Math.min(Math.abs(excess) * EDGE_RESIST, EDGE_MAX)
      // Smoothed velocity: normalise this move's travel to a 60fps step and blend it into the running
      // estimate (newest weighted 0.6), so a fast release carries momentum and a slow one fades. A
      // clamp at a bound zeroes the step naturally, so momentum can't build while pinned to an end.
      const now = this.time.now
      const step = ((content.y - prevY) / Math.max(1, now - lastMoveAt)) * FRAME_MS
      flickVel = flickVel * 0.4 + step * 0.6
      lastMoveAt = now
    })
    this.input.on('pointerup', () => {
      dragging = false
      // L5: released while stretched past a bound → spring back to the clamp with a gentle overshoot
      // and never fling (the stretch already spent the gesture). Reduced motion can't reach here —
      // its drag path stays hard-clamped above.
      const snapped = Phaser.Math.Clamp(content.y, this.minScroll, this.maxScroll)
      if (content.y !== snapped) {
        this.scrollVel = 0
        this.edgeSpring = this.tweens.add({ targets: content, y: snapped, duration: D.settle, ease: backOut(OVERSHOOT.gentle) })
        return
      }
      // Hand the smoothed velocity to update()'s coast only for a genuine flick: motion allowed, above
      // the flick floor, and released promptly after the last move (a hold-then-lift stops dead, as today).
      if (!reduced && Math.abs(flickVel) >= FLICK_MIN && this.time.now - lastMoveAt <= FLICK_IDLE_MS) {
        this.scrollVel = flickVel
      }
    })

    // L8 · the two pieces of scroll chrome, both OUTSIDE `content` (they don't scroll, they report on
    // it) and both driven from one `updateScrollChrome` pass that early-outs when the grid hasn't moved.
    this.addScrollRail(viewTop, viewBottom, contentBottom)
    this.addRecallPill(viewBottom, Math.min(save.unlocked, LEVEL_COUNT))

    if (import.meta.env.DEV) {
      // ?showroom[=N] — open the trophy case on demand; N treats chapters 1..N as owned (presentation
      // only, no award). ?showroom=12 is the silhouette-legibility pass: every locked glyph must stay
      // identifiable as a flat navy shape, or its TROPHIES entry gets swapped (mushroom-not-nazar).
      const q = new URLSearchParams(location.search)
      if (q.has('showroom')) {
        const n = Math.floor(Number(q.get('showroom')))
        this.time.delayedCall(400, () => openShowroom(this, { ownedOverride: n >= 1 ? n : undefined }))
      }
    }

    // Fixed footer. This is the SAME module Home seats its ENDLESS block in — one definition of what
    // the endless race looks like, what it says and what it does, so the board is reachable from both
    // screens that offer ENDLESS and the two can never drift. Using the module rather than a bare pill
    // plus a loose strip is also what stops the race strip reading as a twin of the level strip: on
    // its own plate, under its own trophy, it is plainly the endless block's standings line.
    if (endless) {
      const module = addRaceModule(this, DESIGN_W / 2, 1160, save, () => startScene(this, 'game', { endless: true }))
      // §E8 floor for the strip inside it, biased DOWN by 12px: grown symmetrically its taller target
      // would reach 10px into the ENDLESS pill's own (already 84px) zone directly above, and the pill
      // is the hero of the block — the strip must not be able to swallow the bottom of it.
      this.growTouchTarget(module, 12)
    }
  }

  /**
   * L1 flick inertia: after a release with momentum, coast the masked grid under friction, reusing
   * the drag's exact [minScroll,maxScroll] clamp so it can't overrun the ends. Stops when the speed
   * decays past `FLICK_STOP` or a bound clamps the step. No-ops while the finger is down (pointerdown
   * zeroes the velocity) and under reduced motion (a fling velocity is never built) — pure transform
   * on the one masked container, no new draws.
   */
  update(): void {
    // C4 · idle attract — watch the governor's idle flag; a rising edge fires ONE gentle current-chip
    // pulse (the subtler LevelSelect counterpart to Home's H3 beat). Runs before the L1 coast's early
    // return so it ticks every frame regardless of scroll state; reduced motion is handled in the beat.
    this.updateIdleAttract()
    // L6 · keep the built row window in step with wherever the grid has landed. Runs BEFORE the coast's
    // early return because content.y also moves under the finger and under L5's edge springs, neither of
    // which sets scrollVel; syncWindow() is a few comparisons when the window hasn't turned over.
    this.syncWindow()
    // L8 · and the scroll chrome (rail thumb + RECALL visibility) for the same reason — it must track
    // the finger and the springs, not just the coast. One float compare when nothing has moved.
    this.updateScrollChrome()
    // L1 flick inertia (unchanged) — coast the masked grid under friction after a release with momentum.
    if (this.scrollVel === 0 || !this.scrollContent) return
    const raw = this.scrollContent.y + this.scrollVel
    const next = Phaser.Math.Clamp(raw, this.minScroll, this.maxScroll)
    this.scrollContent.y = next
    if (next !== raw) {
      // L5: a coasting flick that slams a bound converts its remaining speed into a tiny overshoot
      // that springs back — the native-list edge bounce. scrollVel only exists when motion is allowed
      // (reduced never builds one), so this path is implicitly §E8-safe; the guard is belt-and-braces.
      const vel = this.scrollVel
      this.scrollVel = 0 // the bound swallowed the step — the bounce (if any) takes over from here
      if (!this.prefersReducedMotion() && Math.abs(vel) > 2) {
        const over = Math.sign(vel) * Math.min(Math.abs(vel) * 3, EDGE_BOUNCE_MAX)
        this.edgeSpring = this.tweens.chain({
          targets: this.scrollContent,
          tweens: [
            { y: next + over, duration: D.micro, ease: E.settle },
            { y: next, duration: D.settle, ease: backOut(OVERSHOOT.gentle) },
          ],
        })
      }
      return
    }
    this.scrollVel *= FLICK_FRICTION
    if (Math.abs(this.scrollVel) < FLICK_STOP) this.scrollVel = 0
  }

  /**
   * L6 · the windowed grid's one moving part: bring the built rows in line with the current scroll.
   * Computes the row span the mask can show at `content.y`, pads it by `ROW_BUFFER` rows either side,
   * then destroys what fell out and builds what came in. The span is compared against the last one
   * first, so the common frame — scrolling within the rows already built — costs two divisions and an
   * equality test. `cascade` is the create() entry: it forces a build and gives the opening rows their
   * §L entrance ripple; rows minted later during a scroll appear at rest, since a chip popping in under
   * a moving finger would read as a stutter rather than a flourish.
   *
   * L7: the row span comes from `rowIndexAt` now that the chapter bands make the pitch non-uniform.
   * It is still closed-form (the block pitch is constant) and still conservative at both edges, so the
   * cost and the guarantee are exactly what they were.
   */
  private syncWindow(cascade = false): void {
    const grid = this.grid
    if (!grid) return
    // The mask shows content-local y ∈ [viewTop - content.y, viewBottom - content.y]; ask which rows
    // own those two y's and pad the span by the buffer either side.
    const y = grid.content.y
    const first = Phaser.Math.Clamp(rowIndexAt(grid.viewTop, grid.viewTop - y) - ROW_BUFFER, 0, grid.rows - 1)
    const last = Phaser.Math.Clamp(rowIndexAt(grid.viewTop, grid.viewBottom - y) + ROW_BUFFER, 0, grid.rows - 1)
    if (!cascade && first === this.winFirst && last === this.winLast) return
    this.winFirst = first
    this.winLast = last
    for (const row of [...this.rowNodes.keys()]) {
      if (row < first || row > last) this.destroyRow(row)
    }
    for (let row = first; row <= last; row++) {
      if (!this.rowNodes.has(row)) this.rowNodes.set(row, this.buildRow(row, cascade))
    }
    this.drawTrail(first, last)
  }

  /**
   * L6 · build one row of the ladder — its ≤5 chips, parented to a row container so the window can
   * retire them in one call. `cascade` gives the chips the create() entrance ripple (§L: on-screen row
   * sets the beat, the column offset tips it left→right into a diagonal wave); otherwise they start at
   * rest. Either way the current "you are here" chip picks its breathe back up — after the pop when
   * there is one, immediately when there isn't — so scrolling the frontier off screen and back doesn't
   * leave it inert. Reduced motion (§E8) takes neither the pop nor the breathe.
   *
   * L7: a row that OPENS a chapter also carries that chapter's ribbon. Hanging it off the row keeps
   * every per-chapter object inside the window's build/destroy ledger — nothing about the chapter
   * layer is built for the 297 levels you can't see. A chapter is two rows, so its ribbon can only
   * outlive its own visibility: for the ribbon's row to be retired while its partner row is still
   * built, the partner must already be at least `ROW_BUFFER` rows above the viewport.
   */
  private buildRow(row: number, cascade: boolean): Phaser.GameObjects.Container {
    const grid = this.grid!
    const reduced = this.prefersReducedMotion()
    const node = this.add.container(0, 0)
    if (row % CHAPTER_ROWS === 0) node.add(this.buildChapterRibbon(row / CHAPTER_ROWS))
    for (let col = 0; col < GRID_COLS; col++) {
      const n = row * GRID_COLS + col + 1
      if (n > LEVEL_COUNT) break
      const cx = grid.startX + col * (CHIP + GAP) + CHIP / 2
      const cy = rowTop(grid.viewTop, row) + CHIP / 2
      const chip = this.buildChip(n, cx, cy)
      node.add(chip)
      const startPulse = n === grid.unlocked && !reduced ? () => this.startChipPulse(chip) : undefined
      if (!cascade || reduced) {
        startPulse?.()
        continue
      }
      chip.setScale(0.55).setAlpha(0)
      const visRow = Phaser.Math.Clamp(Math.round((cy + grid.content.y - grid.viewTop) / ROW_H), 0, 10)
      this.tweens.add({
        targets: chip,
        scale: 1,
        alpha: 1,
        duration: CASCADE_DURATION,
        delay: visRow * CASCADE_STAGGER + col * CASCADE_COL_STAGGER,
        ease: backOut(OVERSHOOT.pop),
        onComplete: startPulse,
      })
    }
    grid.content.add(node)
    return node
  }

  /**
   * L7 · one chapter ribbon — the labelled gate between decades, seated in the band `rowTop` reserves
   * above each chapter's first row. Three states, because a chapter is only ever one of three things
   * to the player, and each answers a different question:
   *   now    — the chapter you are standing in: the real-metal `goldFace` plate, so the eye lands on
   *            your position the moment the screen paints, before you have read a single number.
   *   done   — behind you: a quiet cream plate carrying the mastery you took out of it (★ earned/max),
   *            which is the only reason to look back at a cleared decade.
   *   ahead  — not reached: dimmed, and it shows the LEVEL RANGE instead of a 0/30 tally, because
   *            "141–150" is what you want from a chapter flying past under a flick, and a zero score
   *            for a decade you were never offered is just a scolding.
   * One baked plate texture per (theme, state) — every ribbon on screen shares three of them — plus
   * two Texts. Static: no tween, so reduced motion needs no branch here.
   */
  private buildChapterRibbon(chapter: number): Phaser.GameObjects.Container {
    const grid = this.grid!
    const T = getTheme()
    const first = chapter * CHAPTER_LEVELS + 1
    const last = Math.min(LEVEL_COUNT, first + CHAPTER_LEVELS - 1)
    const state: 'now' | 'done' | 'ahead' = grid.unlocked > last ? 'done' : grid.unlocked >= first ? 'now' : 'ahead'
    const container = this.add.container(DESIGN_W / 2, chapterTop(grid.viewTop, chapter) + 5 + RIBBON_H / 2)
    const plate = this.add.image(0, 0, this.chapterPlate(state))
    if (state === 'ahead') plate.setAlpha(0.7)
    container.add(plate)
    const ink = state === 'now' ? T.goldPillText : state === 'done' ? T.goldText : T.inkFaint
    container.add(
      this.add
        .text(-GRID_W / 2 + 22, 0, `CHAPTER ${chapter + 1}`, { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: ink })
        .setOrigin(0, 0.5)
        .setLetterSpacing(2)
    )
    let earned = 0
    if (state !== 'ahead') {
      for (let n = first; n <= last; n++) earned += Math.min(3, grid.stars[n] ?? 0)
    }
    container.add(
      this.add
        .text(GRID_W / 2 - 22, 0, state === 'ahead' ? `${first}–${last}` : `★${earned}/${(last - first + 1) * 3}`, {
          fontFamily: FONT,
          fontSize: '19px',
          fontStyle: '900',
          color: ink,
        })
        .setOrigin(1, 0.5)
    )
    // A finished chapter wears its showroom trophy on the ribbon — the door's own advertisement.
    if (state === 'done') {
      const trophy = trophyFor(chapter + 1)
      if (trophy) {
        const key = ensureGlyphTexture(this, `trophy:${chapter + 1}`, trophy.emoji, 96, 128)
        container.add(this.add.image(-GRID_W / 2 + 168, 0, key).setDisplaySize(24, 24))
      }
    }
    // ⚠️ Every ribbon is a DOOR to the showroom, and it sits on the grid's swipe surface — so it
    // follows the level chips' exact guard, not a bare pointerup: the tap is ignored when the gesture
    // was really a scroll (dragMoved), and the hit area is clipped to the viewport band so a ribbon
    // scrolled under the header can never swallow a tap meant for the chrome above it (the same
    // "back only works if I scroll up first" bug the chip zones already solve).
    const ribbonCy = chapterTop(grid.viewTop, chapter) + 5 + RIBBON_H / 2
    const ZONE_H = RIBBON_H + 14
    const zone = this.add.rectangle(0, 0, GRID_W, ZONE_H, 0xffffff, 0.001).setInteractive({
      useHandCursor: true,
      hitArea: new Phaser.Geom.Rectangle(0, 0, GRID_W, ZONE_H),
      hitAreaCallback: (area: Phaser.Geom.Rectangle, hx: number, hy: number): boolean => {
        const pointerY = ribbonCy + grid.content.y + (hy - ZONE_H / 2)
        return pointerY >= grid.viewTop && pointerY <= grid.viewBottom && Phaser.Geom.Rectangle.Contains(area, hx, hy)
      },
    })
    zone.on('pointerup', () => {
      const screenY = ribbonCy + grid.content.y
      if (this.dragMoved >= 12 || screenY < grid.viewTop || screenY > grid.viewBottom) return
      sfx.uiTap()
      openShowroom(this, { focusChapter: chapter + 1 })
    })
    container.add(zone)
    return container
  }

  /**
   * L6 · retire a row that has scrolled out of the window. Tweens are killed down the whole subtree
   * first — a chip's pop, press-spring, frontier-chevron bob and win-halo all target objects nested
   * inside it, and a tween left ticking on a destroyed target is how you get a null-property crash
   * three frames later. The "you are here" refs are dropped with their chip so the C4 idle beat can
   * never nudge a corpse; the next build of that row hands them straight back.
   */
  private destroyRow(row: number): void {
    const node = this.rowNodes.get(row)
    if (!node) return
    if (this.currentChip && node.list.includes(this.currentChip)) {
      this.currentChipPulse?.stop()
      this.currentChip = undefined
      this.currentChipPulse = undefined
    }
    this.killTweensDeep(node)
    this.rowNodes.delete(row)
    node.destroy(true)
  }

  /** L6: kill every tween targeting `obj` or anything nested under it (see destroyRow). */
  private killTweensDeep(obj: Phaser.GameObjects.GameObject): void {
    this.tweens.killTweensOf(obj)
    const kids = (obj as Phaser.GameObjects.Container).list
    if (kids) for (const child of [...kids]) this.killTweensDeep(child)
  }

  /**
   * C4 · idle-attract edge detector (mirrors HomeScene). `quality.idle()` flips true after 6s of no input
   * and clears on the next input, so a rising edge fires the beat once per idle entry; tracking the raw
   * flag re-arms it only after activity. `playIdleBeat` is the single reduced-motion opt-out point.
   */
  private updateIdleAttract(): void {
    const idle = quality.idle()
    if (idle && !this.wasIdle) this.playIdleBeat()
    this.wasIdle = idle
  }

  /**
   * C4 · LevelSelect idle beat — the subtler, secondary counterpart to Home's H3: ONE gentle nudge of the
   * current "you are here" chip. Pauses its steady breathe, pulses a hair larger, then resumes from the
   * same scale (the yoyo returns to the paused value → seamless). A single transform tween, no new draws.
   * Reduced motion (§E8) → no beat at all; also needs a live current chip (absent once every level is done).
   */
  private playIdleBeat(): void {
    if (this.prefersReducedMotion() || !this.currentChip) return
    const chip = this.currentChip
    this.currentChipPulse?.pause()
    this.tweens.add({
      targets: chip,
      scale: 1.12,
      duration: 320,
      yoyo: true,
      ease: 'Sine.easeInOut',
      onComplete: () => this.currentChipPulse?.resume(),
    })
  }

  /** Reduced-motion (OS query OR in-app override) — delegates to the shared theme authority (§E8). */
  private prefersReducedMotion(): boolean {
    return prefersReducedMotion()
  }

  /** The current level's gentle "you are here" breathing pulse — started once its entrance pop settles. */
  private startChipPulse(container: Phaser.GameObjects.Container): void {
    // Held for the C4 idle beat: the attract nudge pauses this breathe, pulses once, then resumes it.
    this.currentChip = container
    this.currentChipPulse = this.tweens.add({ targets: container, scale: 1.06, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // Baked plates. Prime directive #1 (cookbook §1): a Graphics is NOT baked — Phaser re-tessellates
  // its whole command buffer every frame and hands it its own draw call, so the old one-Graphics-per-
  // chip grid paid ~35 tessellations + ~35 batch breaks every frame for art that never changes. There
  // are only six distinct chip faces and three ribbon faces on this screen, so each is drawn ONCE into
  // the global TextureManager and every chip that wears it is an Image sharing that texture — the
  // whole grid collapses into a handful of batched quads with zero per-frame geometry work.
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Bake `draw` into a cached texture (keyed by caller) and return the key. No-op once baked. */
  private bakeTexture(key: string, w: number, h: number, draw: (g: Phaser.GameObjects.Graphics) => void): string {
    if (this.textures.exists(key)) return key
    const g = this.make.graphics({ x: 0, y: 0 }, false)
    draw(g)
    g.generateTexture(key, w, h)
    g.destroy()
    return key
  }

  /**
   * One chip face. Every plate casts its contact shadow straight DOWN, because the whole UI has one
   * key light (cookbook §4) — disagreeing shadow directions are the tell of cheap UI. Radii are shared
   * between a plate's fill and its strokes (§2b): two stacked rounded shapes that meet at an edge must
   * agree, or the darker one pokes past the lighter one as a "horn" at every corner on a DPR-3 screen.
   */
  private chipFace(kind: ChipKind): string {
    const T = getTheme()
    // The current chip's plate is drawn CURRENT_GROW bigger so "you are here" wins on size as well as
    // colour; its hit zone deliberately stays one cell (the extra 4px a side is art overhang, and
    // growing the zone would mean special-casing the viewport clip that keeps chips off the back button).
    const w = CHIP + (kind === 'current' ? CURRENT_GROW : 0)
    const size = w + CHIP_PAD * 2
    return this.bakeTexture(`lvlchip:${T.id}:${kind}`, size, size, g => {
      const x = CHIP_PAD
      const y = CHIP_PAD
      const r = CHIP_R
      g.fillStyle(T.shadow, kind === 'locked' ? 0.07 : kind === 'current' ? 0.18 : 0.12)
      g.fillRoundedRect(x + 2, y + 5, w, w, r)
      if (kind === 'current') {
        // L9 · "you are here". A cleared chip and the current chip used to be the same white card with
        // a slightly thicker gold hairline — on a screen where every tenth chip already wears a full
        // gold frame, the milestone next door read as the more important one. So the current level is
        // the only GOLD-BODIED chip on the ladder: a real-metal frame (wider than MILESTONE_FRAME so
        // the two can't be confused), a warm lit face rather than the flat white of a cleared level,
        // and a bright inner rim. Size, colour and — with the halo and breathe buildChip adds — light
        // and motion all point at it.
        goldFace(g, x, y, w, w, T, r)
        const f = CURRENT_FRAME
        g.fillStyle(T.cardFillWarm, 1)
        g.fillRoundedRect(x + f, y + f, w - f * 2, w - f * 2, r - 6)
        g.fillStyle(T.glossHi, 0.5)
        g.fillRoundedRect(x + f + 4, y + f + 3, w - f * 2 - 8, (w - f * 2) * 0.34, r - 10)
        g.lineStyle(2.5, T.goldBright, 0.9)
        g.strokeRoundedRect(x + f - 1.5, y + f - 1.5, w - f * 2 + 3, w - f * 2 + 3, r - 5)
        g.lineStyle(4, T.goldDeep, 1)
        g.strokeRoundedRect(x, y, w, w, r)
      } else if (kind === 'milestone' || kind === 'lockedMilestone') {
        // L2: gilded landmark face — a baked `goldFace` frame (E7 real-metal, brightest along the top
        // crown) with a face inset so the gold reads as an ornamental border. A LOCKED landmark keeps
        // the gold (muted by the instance alpha buildChip sets) so upcoming waypoints stay visible on
        // the map — the "see where the journey leads" payoff. Static, theme-tokened.
        goldFace(g, x, y, w, w, T, r)
        g.fillStyle(kind === 'milestone' ? 0xffffff : 0xefe8da, 1)
        g.fillRoundedRect(x + MILESTONE_FRAME, y + MILESTONE_FRAME, w - MILESTONE_FRAME * 2, w - MILESTONE_FRAME * 2, 14)
        g.lineStyle(kind === 'milestone' ? 3 : 2, T.goldBezel, kind === 'milestone' ? 1 : 0.7)
        g.strokeRoundedRect(x, y, w, w, r)
      } else if (kind === 'cleared') {
        g.fillStyle(0xffffff, 1)
        g.fillRoundedRect(x, y, w, w, r)
        g.lineStyle(2, T.border, 1)
        g.strokeRoundedRect(x, y, w, w, r)
      } else if (kind === 'next') {
        // L9 · the ONE locked level you can actually reach next. It gets a warm, glossed, gold-bezelled
        // face — most of the way to a real card — so the run ahead opens with an invitation instead of
        // the wall of identical grey the rest of the locked ladder used to be.
        g.fillStyle(T.cardFillWarm, 1)
        g.fillRoundedRect(x, y, w, w, r)
        g.fillStyle(T.glossHi, 0.45)
        g.fillRoundedRect(x + 5, y + 4, w - 10, w * 0.32, r - 6)
        g.lineStyle(2.5, T.goldBezel, 0.95)
        g.strokeRoundedRect(x, y, w, w, r)
      } else {
        // L9 · locked: a RECESSED well rather than a dead flat square — a dark inner ring at the top
        // edge and a light bounce along the bottom, the cookbook §3 inner-shadow recipe. It costs two
        // strokes at bake time and it is the difference between "empty tile" and "socket waiting for a
        // chip", which is the read a locked rung on a journey map wants.
        g.fillStyle(0xefe8da, 1)
        g.fillRoundedRect(x, y, w, w, r)
        g.lineStyle(3, T.shadow, 0.1)
        g.strokeRoundedRect(x + 1.5, y + 1.5, w - 3, w - 3, r - 1.5)
        g.fillStyle(T.glossHi, 0.4)
        g.fillRoundedRect(x + 9, y + w - 9, w - 18, 4, 2)
        g.lineStyle(1.5, T.border, 0.9)
        g.strokeRoundedRect(x, y, w, w, r)
      }
    })
  }

  /** One chapter-ribbon plate per state — see `buildChapterRibbon` for what each state means. */
  private chapterPlate(state: 'now' | 'done' | 'ahead'): string {
    const T = getTheme()
    const r = RIBBON_H / 2 - 1 // §2c: never exactly half the smallest side
    return this.bakeTexture(`lvlchap:${T.id}:${state}`, GRID_W + CHIP_PAD * 2, RIBBON_H + CHIP_PAD * 2, g => {
      const x = CHIP_PAD
      const y = CHIP_PAD
      g.fillStyle(T.shadow, 0.09)
      g.fillRoundedRect(x, y + 3, GRID_W, RIBBON_H, r)
      if (state === 'now') {
        goldFace(g, x, y, GRID_W, RIBBON_H, T, r)
        g.lineStyle(2, T.goldDeep, 1)
      } else {
        g.fillStyle(state === 'done' ? T.cardFillWarm : T.cardFillAlt, 1)
        g.fillRoundedRect(x, y, GRID_W, RIBBON_H, r)
        g.fillStyle(T.glossHi, state === 'done' ? 0.45 : 0.25)
        g.fillRoundedRect(x + 5, y + 3, GRID_W - 10, RIBBON_H * 0.34, r * 0.6)
        g.lineStyle(1.5, state === 'done' ? T.goldBezel : T.border, 1)
      }
      g.strokeRoundedRect(x, y, GRID_W, RIBBON_H, r)
    })
  }

  /**
   * The banked-star read-out for the header — the cream/gold readout face the chip balance and streak
   * badge already wear, so the two accumulated resources in the app look like siblings. Deliberately
   * NOT interactive: it sits in the same band as the ‹ back button, and a readout that never claims a
   * tap can never take one from it.
   */
  private addStarTally(x: number, y: number, stars: number): void {
    const T = getTheme()
    const w = 140
    const h = 46
    const key = this.bakeTexture(`lvlstars:${T.id}:${w}x${h}`, w + CHIP_PAD * 2, h + CHIP_PAD * 2, g => {
      const px = CHIP_PAD
      const py = CHIP_PAD
      const r = h / 2 - 1
      g.fillStyle(T.shadow, 0.1)
      g.fillRoundedRect(px, py + 3, w, h, r)
      g.fillStyle(T.cardFillWarm, 1)
      g.fillRoundedRect(px, py, w, h, r)
      g.fillStyle(T.glossHi, 0.5)
      g.fillRoundedRect(px + 5, py + 3, w - 10, h * 0.34, r * 0.6)
      g.lineStyle(2, T.goldBezel, 1)
      g.strokeRoundedRect(px, py, w, h, r)
    })
    const container = this.add.container(x, y).setDepth(50)
    container.add(this.add.image(0, 0, key))
    container.add(this.add.image(-w / 2 + 28, 0, 'star').setDisplaySize(28, 28))
    container.add(
      this.add
        .text(w / 2 - 18, 1, stars.toLocaleString(), { fontFamily: FONT, fontSize: '25px', fontStyle: '900', color: T.goldText })
        .setOrigin(1, 0.5)
    )
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────────
  // L8 · scroll chrome — "how far through am I" and "put me back".
  // ───────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A slim rail + thumb pinned in the right margin (the grid is 612 wide in a 720 box, so this costs
   * nothing anyone was using). Sixty rows scroll past with no sense of scale otherwise; the thumb is
   * the only thing on the screen that answers "how much of three hundred levels is behind me". Two
   * Images off two baked textures, and the only per-frame work is one `y` assignment — a Graphics
   * would have re-tessellated a rounded rect every frame to draw six pixels of hairline.
   */
  private addScrollRail(viewTop: number, viewBottom: number, contentBottom: number): void {
    const view = viewBottom - viewTop
    const content = contentBottom - viewTop
    if (content <= view) return // the whole ladder fits — no rail to draw
    const T = getTheme()
    const w = 7
    const railH = view - 24
    const thumbH = Math.max(56, Math.round((railH * view) / content))
    const bake = (h: number): string =>
      this.bakeTexture(`lvlrail:${T.id}:${w}x${h}`, w, h, g => {
        g.fillStyle(0xffffff, 1)
        g.fillRoundedRect(0, 0, w, h, w / 2 - 0.5)
      })
    const x = DESIGN_W - 26
    this.railTop = viewTop + 12 + thumbH / 2
    this.railTravel = railH - thumbH
    this.add.image(x, viewTop + 12 + railH / 2, bake(railH)).setTint(T.border).setAlpha(0.55).setDepth(45)
    this.railThumb = this.add.image(x, this.railTop, bake(thumbH)).setTint(T.gold).setAlpha(0.9).setDepth(45)
  }

  /**
   * The RECALL pill — one tap back to where you actually are. Scrolling away from your level in a
   * 300-rung list used to be a one-way trip: the only way back was to drag until you spotted the gold
   * ring again, which on a fast flick means hunting through several chapters. It floats over the
   * bottom of the grid and only exists while the current chip is off screen, so it is never furniture.
   *
   * Depth 50 puts it in the scene-chrome band, above the grid for drawing AND for input, and its zone
   * comes from `addPillButton` already grown to the §E8 floor. While hidden it is `visible = false`,
   * which takes it out of Phaser's hit test entirely — an invisible button that still eats taps over
   * five level chips would be the same class of bug the chip hit-area clip exists to fix.
   */
  private addRecallPill(viewBottom: number, level: number): void {
    const pill = addPillButton(this, DESIGN_W / 2, viewBottom - 56, 268, 62, `BACK TO ${level}`, GOLD_PILL, () =>
      this.scrollToCurrent()
    )
    pill.setDepth(50).setVisible(false).setAlpha(0).setScale(0.8)
    this.recall = pill
    this.recallShown = false
  }

  /**
   * L8 · repaint the scroll chrome for wherever the grid has landed. Early-outs on an unchanged
   * `content.y`, which is the common frame (the list is at rest far more often than it is moving), so
   * a still screen pays one float compare. Pure transform + a latched visibility toggle: no draws.
   */
  private updateScrollChrome(): void {
    const grid = this.grid
    if (!grid) return
    const y = grid.content.y
    if (y === this.chromeY) return
    this.chromeY = y
    if (this.railThumb) {
      // content.y walks [minScroll, 0]; 0 is the top of the ladder, minScroll the bottom.
      this.railThumb.y = this.railTop + this.railTravel * (this.minScroll < 0 ? Phaser.Math.Clamp(y / this.minScroll, 0, 1) : 0)
    }
    if (this.recall) {
      // "Off screen" means the current chip's band has left the mask — the same [viewTop, viewBottom]
      // the mask and the chip hit-area clip use, with a small margin so a chip peeking in by a few
      // pixels doesn't flicker the button on and off at the edge.
      const top = rowTop(grid.viewTop, this.currentRow) + y
      this.setRecallVisible(top + CHIP < grid.viewTop + 24 || top > grid.viewBottom - 24)
    }
  }

  /**
   * Show/hide the RECALL pill, latched so the tween only fires on a real state change. It pops in with
   * the house eager overshoot and leaves quietly; reduced motion (§E8) gets the same two states with
   * no travel at all. Killing the previous tween first is what stops a fast flick past the frontier
   * from stacking a show and a hide on the same target.
   */
  private setRecallVisible(show: boolean): void {
    const pill = this.recall
    if (!pill || show === this.recallShown) return
    this.recallShown = show
    this.tweens.killTweensOf(pill)
    if (this.prefersReducedMotion()) {
      pill.setVisible(show).setAlpha(show ? 1 : 0).setScale(show ? 1 : 0.8)
      return
    }
    if (show) pill.setVisible(true)
    this.tweens.add({
      targets: pill,
      alpha: show ? 1 : 0,
      scale: show ? 1 : 0.8,
      duration: show ? D.pop : D.quick,
      ease: show ? backOut(OVERSHOOT.pop) : E.exit,
      onComplete: () => {
        if (!show) pill.setVisible(false)
      },
    })
  }

  /**
   * Glide the grid back to the offset the screen opened at — the one that frames the current level.
   * Both in-flight scroll animations are stopped first and the coast velocity is zeroed, so the glide
   * is the only thing writing `content.y`; `pointerdown` stops this tween in turn, so the finger can
   * always take the list back mid-flight. Reduced motion (§E8) jumps straight there.
   */
  private scrollToCurrent(): void {
    const content = this.scrollContent
    if (!content) return
    this.scrollVel = 0
    this.edgeSpring?.stop()
    this.edgeSpring = undefined
    this.scrollTween?.stop()
    if (this.prefersReducedMotion()) {
      content.y = this.homeScrollY
      this.scrollTween = undefined
      return
    }
    this.scrollTween = this.tweens.add({ targets: content, y: this.homeScrollY, duration: 420, ease: E.glide })
  }

  /**
   * §E8 / cookbook §9 touch-target floor, applied at the CALL SITE. `ui.ts` grows every pill and chip
   * zone to `MIN_HIT` (84 design px ≈ 44pt) when it builds them; the shared standings strips predate
   * that rule and are authored at their 52px art height (~28pt). They are one component shared with
   * Home, so the fix belongs on the handle they hand back rather than in a fork: walk the returned
   * tree and REPLACE any interactive rectangle shorter than the floor with a taller one — the
   * invisible hit rect grows, the art does not move a pixel (which is the whole recipe).
   *
   * A fresh `Geom.Rectangle` rather than an in-place edit, because a Shape's `input.hitArea` can be
   * the same object as the geometry it renders from, and quietly resizing the drawn strip would be a
   * very confusing bug to chase. `bias` pushes the grown rect down for a strip that sits under another
   * control (see the ENDLESS module).
   */
  private growTouchTarget(root: Phaser.GameObjects.GameObject, bias = 0, min = MIN_TOUCH): void {
    const input = root.input
    const area = input?.hitArea as unknown
    if (input && area instanceof Phaser.Geom.Rectangle && area.height < min) {
      input.hitArea = new Phaser.Geom.Rectangle(area.x, area.y - (min - area.height) / 2 + bias, area.width, min)
    }
    const kids = (root as Phaser.GameObjects.Container).list
    if (kids) for (const child of kids) this.growTouchTarget(child, bias, min)
  }

  /**
   * L5 · selection acknowledgement — the moment a chip tap commits, it springs up past rest with an
   * eager overshoot (a hair bigger on the current "you are here" chip) and, unless flashing is
   * reduced, one transient gold ring blooms from the chip and rides the outgoing cross-fade — the
   * departing half of the C6 "this chip opened into the board" story. The ring destroys itself (or
   * dies with the scene shutdown, which sweeps its tween); reduced motion (§E8) keeps today's plain
   * tap-through with zero added movement.
   */
  private acknowledgeChip(container: Phaser.GameObjects.Container, current: boolean): void {
    if (this.prefersReducedMotion()) return
    this.tweens.add({ targets: container, scale: current ? 1.14 : 1.1, duration: D.pop, ease: backOut(OVERSHOOT.pop) })
    if (reduceFlashing() || quality.tier() === 'low') return // the pop alone carries the acknowledgement
    const ring = this.add
      .image(container.x, container.y + (this.scrollContent?.y ?? 0), 'ring')
      .setDisplaySize(CHIP * 1.15, CHIP * 1.15)
      .setTint(getTheme().gold)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.85)
      .setDepth(40)
    this.tweens.add({ targets: ring, scale: ring.scale * 1.7, alpha: 0, duration: D.pop, ease: E.settle, onComplete: () => ring.destroy() })
  }

  /**
   * L3 frontier "keep going" marker: a soft gold chevron on the current chip aimed at the next
   * (locked) run — right when that level shares this row, else down to the next row's start — so a
   * returning player instantly reads which way the journey continues. Reduced motion (§E8): the
   * chevron rests static (no bob); otherwise it gives a gentle directional nudge. Baked Graphics
   * added INTO the chip container, so it scrolls + masks with the grid (L1's coast/mask untouched).
   */
  private addFrontierMarker(container: Phaser.GameObjects.Container, n: number): void {
    const T = getTheme()
    // Levels fill left→right, top→bottom: the next run is the same-row neighbour to the right, unless
    // this chip ends the row (col 4), in which case it wraps down to the next row's start.
    const nextRight = (n - 1) % GRID_COLS < GRID_COLS - 1
    // A single chevron baked around local (0,0) so a 90° turn re-aims it from "right" to "down".
    // Sized to CLEAR the gutter: stroke width included, the mark spans ~16px against an 18px gap. At
    // the old (-7,±12)→(9,0) with an 8px backing it measured ~20px and could not fit whatever it was
    // offset to, so some of it was always under the neighbouring chip.
    const pts = [new Phaser.Math.Vector2(-5, -10), new Phaser.Math.Vector2(6, 0), new Phaser.Math.Vector2(-5, 10)]
    const chev = this.add.graphics()
    chev.lineStyle(6, T.goldDarkest, 0.5) // soft dark backing so the cue stays legible on the cream face
    chev.strokePoints(pts, false)
    chev.lineStyle(4, T.goldBright, 0.95)
    chev.strokePoints(pts, false)
    // Seated in the GUTTER between cells (half of GAP past the chip edge) and bobbing only 4px, so it
    // reads as an arrow in clear air. At the old +13/+6 it started 4px inside the neighbouring chip and
    // the bob pushed it further under it — the cue was half-hidden behind the thing it pointed at.
    if (nextRight) chev.setPosition(CHIP / 2 + GAP / 2, 0)
    else chev.setPosition(0, CHIP / 2 + GAP / 2).setRotation(Math.PI / 2)
    container.add(chev)
    // Gentle "keep going" nudge toward the next chip — gated OFF under reduced motion (static arrow).
    if (this.prefersReducedMotion()) return
    this.tweens.add({
      targets: chev,
      x: chev.x + (nextRight ? 4 : 0),
      y: chev.y + (nextRight ? 0 : 4),
      duration: 640,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  /**
   * L4 · map "journey" trail. Threads the level chips into one winding dotted path so the grid reads
   * as a route, not a spreadsheet. Builds ONE Graphics: between each chip and the next (in level order)
   * it stamps faint dots — a straight run within a row, and a gently downward-bowed "carriage return"
   * quadratic where the grid wraps to the next row's left start. Two-tone — dots up to the current
   * unlocked chip glow `gold`, everything beyond is muted `suitWatermark` — so the lit trail terminates
   * exactly at the "you are here" chip. It draws into the Graphics create() puts FIRST into `content`,
   * so it sits UNDER every chip and rides L1's scroll + the existing geometry mask (no second mask).
   *
   * L6: only the rows in the live window are stamped (one row of margin either side, so a row entering
   * the window never arrives ahead of its path), and the whole thing is redrawn when the window turns
   * over. Stamping all 300 levels put ~2,400 filled circles in one Graphics — a single draw call, but
   * one whose geometry was re-tessellated every frame, and on its own about as costly as all 300 chips.
   *
   * L7: the wrap at a chapter boundary now falls the extra `CHAPTER_GAP`, and passes BEHIND the ribbon
   * (rows are added after the trail) — the path ducks under the signpost, which is what a map does.
   */
  private drawTrail(firstRow: number, lastRow: number): void {
    const grid = this.grid
    if (!grid) return
    const T = getTheme()
    const g = grid.trail
    g.clear()
    const { startX, viewTop, unlocked } = grid
    // Chip centre in content-local space — the exact cx/cy buildChip uses (GRID_COLS columns on a
    // CHIP+GAP pitch, rows placed by the shared `rowTop`), so the trail threads the real grid geometry.
    const centre = (n: number): Phaser.Math.Vector2 => {
      const row = Math.floor((n - 1) / GRID_COLS)
      const col = (n - 1) % GRID_COLS
      return new Phaser.Math.Vector2(startX + col * (CHIP + GAP) + CHIP / 2, rowTop(viewTop, row) + CHIP / 2)
    }
    // One faint dot; travelled dots glow gold, the rest sit muted (colour + alpha reset per stamp so a
    // single Graphics carries both tones). `fillEllipse` at TRAIL_DOT_SIDES rather than `fillCircle`,
    // which arcs at Phaser's default 32 segments: a 3.4px dot cannot show 32 sides, but it can pay for
    // them — a Graphics re-tessellates its whole command buffer every frame, so at ~600 dots that
    // default was tens of thousands of triangles per frame for pixels no one can resolve.
    const dot = (x: number, y: number, lit: boolean): void => {
      g.fillStyle(lit ? T.gold : T.suitWatermark, lit ? TRAIL_LIT_ALPHA : TRAIL_DIM_ALPHA)
      g.fillEllipse(x, y, TRAIL_DOT_R * 2, TRAIL_DOT_R * 2, TRAIL_DOT_SIDES)
    }
    // Walk the chips in level order, dotting each n → n+1 gap; endpoints (chip centres) are left
    // unstamped — they hide under the chips anyway and skipping them keeps shared vertices seam-free.
    const from = Math.max(1, (firstRow - 1) * GRID_COLS + 1)
    const to = Math.min(LEVEL_COUNT, (lastRow + 2) * GRID_COLS)
    for (let n = from; n < to; n++) {
      const a = centre(n)
      const b = centre(n + 1)
      // Lit once the destination chip is unlocked; the segment LEAVING the current chip stays dim, so
      // the gold trail ends precisely at "you are here" and "beyond" reads as unexplored (§L4).
      const lit = n + 1 <= unlocked
      if ((n - 1) % GRID_COLS < GRID_COLS - 1) {
        // Same-row hop: a straight dotted run whose dots peek through the gaps between neighbouring chips.
        const steps = Math.max(2, Math.round(a.distance(b) / TRAIL_DOT_GAP))
        for (let i = 1; i < steps; i++) dot(Phaser.Math.Linear(a.x, b.x, i / steps), a.y, lit)
      } else {
        // Row wrap: a downward-bowed quadratic "carriage return" sweeping from the row's right end back
        // to the next row's left start, so the journey winds instead of cutting a hard diagonal.
        const cpx = (a.x + b.x) / 2
        const cpy = (a.y + b.y) / 2 + TRAIL_RETURN_BOW
        const steps = Math.max(3, Math.round((a.distance(b) + TRAIL_RETURN_BOW) / TRAIL_DOT_GAP))
        for (let i = 1; i < steps; i++) {
          const t = i / steps
          const u = 1 - t
          dot(u * u * a.x + 2 * u * t * cpx + t * t * b.x, u * u * a.y + 2 * u * t * cpy + t * t * b.y, lit)
        }
      }
    }
  }

  private buildChip(n: number, cx: number, cy: number): Phaser.GameObjects.Container {
    const { unlocked, viewTop, viewBottom, content } = this.grid!
    const stars = this.grid!.stars[n] ?? 0
    const playable = n <= unlocked
    const current = n === unlocked
    const nextUp = n === unlocked + 1
    const milestone = n % CHAPTER_LEVELS === 0 // L2: every 10th level closes a chapter — a gilded landmark
    const T = getTheme()
    const container = this.add.container(cx, cy)
    // L9: a warm halo UNDER the current chip. Light is the cue that survives being read at a glance on
    // a field of 35 cream cards, and it costs one ADD quad off a texture the backdrop already baked.
    // It rides inside the container, so the breathe scales it with the chip for free. Governor-gated:
    // the low tier is the one place a full-size additive blend is worth skipping.
    if (current && quality.tier() !== 'low' && this.textures.exists('bgglow')) {
      container.add(
        this.add
          .image(0, 0, 'bgglow')
          .setDisplaySize(CHIP * 2, CHIP * 2)
          .setTint(T.gold)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.32)
      )
    }
    const kind: ChipKind = current
      ? 'current'
      : milestone
        ? playable
          ? 'milestone'
          : 'lockedMilestone'
        : playable
          ? 'cleared'
          : nextUp
            ? 'next'
            : 'locked'
    const face = this.add.image(0, 0, this.chipFace(kind))
    if (kind === 'lockedMilestone') face.setAlpha(0.78) // subordinate to the current chip — a landmark ahead
    container.add(face)

    if (playable) {
      const hasStars = stars > 0
      const numText = this.add
        // Milestones always carry a tally below, so their number rides high like a starred chip's. The
        // current chip has no stars yet and its number sits centred on the gold face.
        .text(0, milestone || hasStars ? -14 : 0, String(n), {
          fontFamily: FONT,
          fontSize: current ? '42px' : '40px',
          fontStyle: '900',
          color: current ? T.goldText : T.ink,
        })
        .setOrigin(0.5)
      container.add(numText)
      // Beat 5 echo: the freshly-unlocked current chip pops + sparkles + haloes on win arrival. L6: the
      // arrival is a one-shot, so it is latched — scrolling the frontier out of the window and back
      // rebuilds that chip, and the welcome should not be thrown a second time.
      if (current && this.fromWin && !this.celebrated) {
        this.celebrated = true
        this.celebrateCurrentChip(container, numText, cx, cy, content)
      }
      // L3: frontier "keep going" cue — a soft gold chevron on the current chip aimed at the next
      // (locked) run, so a returning player instantly reads which way the journey continues.
      if (current && n < LEVEL_COUNT) this.addFrontierMarker(container, n)
      if (milestone) {
        // L2: a full 3-slot star tally (earned bright, remaining ghosted) grades the landmark at a
        // glance — the "how far along am I" read a journey map wants. Baked + static.
        for (let i = 0; i < 3; i++) {
          const pip = this.add.image((i - 1) * 26, 32, 'star').setDisplaySize(24, 24).setAlpha(i < stars ? 1 : 0.26)
          container.add(pip)
        }
      } else {
        for (let i = 0; i < stars; i++) {
          const star = this.add.image((i - (stars - 1) / 2) * 30, 30, 'star')
          star.setDisplaySize(26, 26)
          container.add(star)
        }
      }
      // A geometry mask clips PIXELS, never input: Phaser's hit test walks the interactive list with no
      // idea a mask exists, so a chip scrolled up out of the viewport stayed tappable over the header —
      // and because `input.topOnly` hands the event to whichever candidate sits highest in the display
      // list, that invisible chip (added after the chrome) swallowed taps meant for the ‹ back button.
      // That is the "back only works if I scroll up first" bug: scrolling moved the offending row off
      // the button. So the hit area is clipped to the same band the mask draws — outside it the chip is
      // not a candidate at all, and the tap falls through to the button underneath. The local y Phaser
      // hands us is origin-normalised (0 = the zone's top edge), and `container.scaleY` folds in the
      // press/breathe scales, so this tracks the drawn pixels exactly.
      const zone = this.add.rectangle(0, 0, CHIP, CHIP, 0xffffff, 0.001).setInteractive({
        useHandCursor: true,
        hitArea: new Phaser.Geom.Rectangle(0, 0, CHIP, CHIP),
        hitAreaCallback: (area: Phaser.Geom.Rectangle, hx: number, hy: number): boolean => {
          const pointerY = cy + content.y + (hy - CHIP / 2) * container.scaleY
          return pointerY >= viewTop && pointerY <= viewBottom && Phaser.Geom.Rectangle.Contains(area, hx, hy)
        },
      })
      // L5 · springy press feel: the chip squashes on touch and springs back with a release overshoot —
      // the same physical grammar as the pill buttons. One reusable tween slot per chip so press/release
      // never stack; the current chip's breathe pulse is paused for the press so the two scale tweens
      // can't fight, and resumes once the spring settles. Reduced motion (§E8) keeps the instant snap.
      let pressTween: Phaser.Tweens.Tween | undefined
      const resumePulse = (): void => {
        if (container === this.currentChip) this.currentChipPulse?.resume()
      }
      zone.on('pointerdown', () => {
        if (container === this.currentChip) this.currentChipPulse?.pause()
        pressTween?.stop()
        if (this.prefersReducedMotion()) {
          container.setScale(0.94)
          return
        }
        pressTween = this.tweens.add({ targets: container, scale: 0.94, duration: D.micro, ease: E.press })
      })
      const springBack = (): void => {
        pressTween?.stop()
        if (this.prefersReducedMotion()) {
          container.setScale(1)
          resumePulse()
          return
        }
        pressTween = this.tweens.add({ targets: container, scale: 1, duration: D.settle, ease: backOut(OVERSHOOT.release), onComplete: resumePulse })
      }
      zone.on('pointerout', springBack)
      zone.on('pointerup', () => {
        // Ignore taps that were really a scroll, or land on a chip clipped outside the viewport.
        const screenY = cy + content.y
        if (this.dragMoved >= 12 || screenY < viewTop || screenY > viewBottom) {
          springBack()
          return
        }
        sfx.uiTap()
        pressTween?.stop()
        // L5 · selection acknowledgement — a confident overshoot pop + gold ring riding the cross-fade.
        this.acknowledgeChip(container, current)
        // C6 · opt-in shared-element bloom: hand the destination this chip's live on-screen centre
        // (cx, cy+scroll) + size so the board "opens" from the tapped chip. Additive — reduced motion
        // never queues it (gated in startScene), so the calm path keeps today's flat cross-fade.
        startScene(this, 'game', { level: n }, undefined, { x: cx, y: screenY, w: CHIP, h: CHIP, tint: getTheme().gold })
      })
      container.add(zone)
    } else {
      // L9 · a locked chip now says WHICH level it is. It never did: 250 of the 300 rungs were
      // anonymous grey squares, so "how far is 63 from here" was unanswerable and the run ahead had
      // nothing to aim at. The number is ghosted and the padlock shrinks under it — still plainly not
      // playable, but now part of the map. The one level you can reach next (and every landmark) takes
      // the gold ink, because those are the two things worth looking forward to.
      const num = this.add
        .text(0, -12, String(n), {
          fontFamily: FONT,
          fontSize: '34px',
          fontStyle: '900',
          color: nextUp || milestone ? T.goldText : T.inkFaint,
        })
        .setOrigin(0.5)
        .setAlpha(nextUp ? 1 : 0.78)
      container.add(num)
      const lock = this.add.image(0, 28, 'lock').setAlpha(nextUp ? 0.5 : 0.42)
      lock.setDisplaySize(24, 24)
      container.add(lock)
    }
    return container
  }

  /**
   * Beat 5 echo: the current chip's number pops (0→1.15→1), a gold glow-ring haloes it, and a
   * small unlock-sparkle bursts on it — a warm "here's where you are now" when arriving from a win.
   * The sparkle is deferred a tick so it can use the chip's settled screen position (content.y is
   * finalised right after the build loop).
   */
  private celebrateCurrentChip(
    container: Phaser.GameObjects.Container,
    numText: Phaser.GameObjects.Text,
    cx: number,
    cy: number,
    content: Phaser.GameObjects.Container
  ): void {
    const reduced = this.prefersReducedMotion()
    // Gold glow ring haloing the chip — static (no breathe loop) under reduced motion (§E8).
    const ring = this.add.image(0, 0, 'ring').setDisplaySize(CHIP + 34, CHIP + 34).setTint(getTheme().gold).setAlpha(reduced ? 0.6 : 0.85)
    container.addAt(ring, 0)
    if (!reduced) {
      this.tweens.add({ targets: ring, alpha: 0.35, scale: ring.scale * 1.08, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }

    // Number pop 0→1.15→1 (skipped under reduced motion — the number stays at rest).
    if (!reduced) {
      const base = numText.scale
      numText.setScale(0)
      this.tweens.add({ targets: numText, scale: base * 1.15, duration: 300, delay: 220, ease: 'Back.easeOut', onComplete: () =>
        this.tweens.add({ targets: numText, scale: base, duration: 160, ease: 'Sine.easeOut' }),
      })
    }

    // Deferred unlock sparkle at the chip's on-screen position (a one-shot burst — skipped when reduced).
    if (reduced) {
      sfx.starDing(1)
      return
    }
    this.time.delayedCall(240, () => {
      const spark = this.add
        .particles(0, 0, 'spark', {
          speed: { min: 90, max: 260 },
          angle: { min: 0, max: 360 },
          scale: { start: 0.6, end: 0 },
          alpha: { start: 0.95, end: 0 },
          lifespan: { min: 500, max: 900 },
          gravityY: 120,
          emitting: false,
        })
        .setDepth(40)
      spark.explode(14, cx, cy + content.y)
      this.time.delayedCall(1000, () => spark.destroy())
      sfx.starDing(1)
    })
  }
}

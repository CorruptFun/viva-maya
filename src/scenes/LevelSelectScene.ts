import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import { addLevelRaceStrip, addWeeklyRaceStrip } from '../view/leaderboardpanel'
import { D, E, OVERSHOOT, backOut } from '../view/motion'
import { quality } from '../view/quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from '../view/theme'
import { FONT, GHOST_PILL, ROSE_PILL, addMarquee, addMuteChip, addPillButton, applyEntrance, goldFace, startScene } from '../view/ui'

const GRID_COLS = 5
const CHIP = 108
const GAP = 18
const ROW_H = CHIP + GAP
const TOP_PAD = 32
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
    applyEntrance(this) // §E10 directional push-in + §F2 light-wipe (no-ops under reduced motion)
    // C4: reset the idle-attract state per entry — Phaser reuses the scene instance across navigation, so
    // clear the latch + any stale current-chip/tween ref (e.g. from a visit that HAD a current chip) before
    // the grid rebuilds; startChipPulse re-captures the live chip once its entrance settles.
    this.wasIdle = false
    this.currentChip = undefined
    this.currentChipPulse = undefined
    this.edgeSpring = undefined // L5: stale tween refs die with the old grid — never resurrect one
    // L6: the previous visit's rows died with its display list — drop the stale ledger so the first
    // syncWindow() rebuilds the window from scratch rather than trusting handles to destroyed rows.
    this.rowNodes.clear()
    this.winFirst = -1
    this.winLast = -1
    const save = loadSave()
    addCasinoBackdrop(this, 'menu')
    addMarquee(this, DESIGN_W / 2, 96)
    // Depth 50 puts the scene chrome above the scrolling grid for input as well as drawing — the same
    // rank addMuteChip already takes. The chip hit areas are clipped to the viewport (see buildChip),
    // so this is belt-and-braces: nothing in the list can outrank the way out of the screen.
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this, 'home')).setDepth(50)
    addMuteChip(this, 676, 40)

    const unlocked = endlessUnlocked(save)
    const viewTop = 156
    // 1060 when ENDLESS is offered (was 1092): the footer grew by the height of the weekly-race strip
    // that replaced the old one-line caption, and it buys that back from the grid rather than from the
    // bottom margin. Costs about a quarter of a row of chips. `viewBottom` is the single source for
    // both the mask and the chip hit-area clip, so they stay in lockstep for free.
    const viewBottom = unlocked ? 1060 : 1176

    // Scrollable grid of level chips.
    const content = this.add.container(0, 0)
    const gridW = GRID_COLS * CHIP + (GRID_COLS - 1) * GAP
    const startX = (DESIGN_W - gridW) / 2
    // L4 · map "journey" trail — a faint dotted, winding line threading the chip centres in level
    // order, lit gold up to the current chip and muted beyond. Added FIRST so it sits UNDER every chip
    // (rows are only ever appended after it, so that ordering survives the L6 window churn); it lives
    // in `content`, so it rides L1's scroll (content.y) + the existing geometry mask (no second mask).
    // Static → reduced motion unaffected. L6: redrawn per window, not once for all 300 levels.
    const trail = this.add.graphics()
    content.add(trail)
    const rows = Math.ceil(LEVEL_COUNT / GRID_COLS)
    const contentBottom = viewTop + TOP_PAD + rows * ROW_H + 24

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
    // Open scrolled so the current level sits mid-viewport.
    const curRow = Math.floor((Math.min(save.unlocked, LEVEL_COUNT) - 1) / GRID_COLS)
    const curCy = viewTop + TOP_PAD + curRow * ROW_H + CHIP / 2
    content.y = Phaser.Math.Clamp((viewTop + viewBottom) / 2 - curCy, this.minScroll, this.maxScroll)

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

    // Fixed footer. The weekly-race strip is the SAME component Home's module uses — one definition of
    // what the standings row looks like, what it says, and what it does, so the board is reachable from
    // both screens that offer ENDLESS. This slot used to be a dead caption ("weekly board · best N")
    // that looked tappable next to Home's live one but wasn't wired to anything; the strip also
    // upgrades the copy from save-local to the live standings when signed in.
    if (unlocked) {
      addPillButton(this, DESIGN_W / 2, 1104, 420, 68, 'ENDLESS', ROSE_PILL, () => startScene(this, 'game', { endless: true }))
      addWeeklyRaceStrip(this, DESIGN_W / 2, 1176, save)
    }
    // The LEVEL RACE strip takes the slot the static `BEST  N` caption held. That caption was the last
    // dead text on this screen — the exact problem the weekly strip was introduced to fix here — and
    // it was a DUPLICATE besides: HomeScene already prints `Level N · best X` from the same
    // `save.best`. The ladder is the more relevant number on the level screen anyway, and unlike the
    // weekly strip it renders whether or not ENDLESS is unlocked, because campaign progress is
    // something every player has from level one.
    addLevelRaceStrip(this, DESIGN_W / 2, 1240, save)
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
   */
  private syncWindow(cascade = false): void {
    const grid = this.grid
    if (!grid) return
    // Row `r` spans content-y [rowTop, rowTop + CHIP] where rowTop = viewTop + TOP_PAD + r*ROW_H; the
    // mask shows content-y [viewTop - y, viewBottom - y]. Solve that overlap for r, then pad.
    const y = grid.content.y
    const first = Phaser.Math.Clamp(Math.ceil((-y - TOP_PAD - CHIP) / ROW_H) - ROW_BUFFER, 0, grid.rows - 1)
    const last = Phaser.Math.Clamp(Math.floor((grid.viewBottom - grid.viewTop - TOP_PAD - y) / ROW_H) + ROW_BUFFER, 0, grid.rows - 1)
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
   */
  private buildRow(row: number, cascade: boolean): Phaser.GameObjects.Container {
    const grid = this.grid!
    const reduced = this.prefersReducedMotion()
    const node = this.add.container(0, 0)
    for (let col = 0; col < GRID_COLS; col++) {
      const n = row * GRID_COLS + col + 1
      if (n > LEVEL_COUNT) break
      const cx = grid.startX + col * (CHIP + GAP) + CHIP / 2
      const cy = grid.viewTop + TOP_PAD + row * ROW_H + CHIP / 2
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
    const pts = [new Phaser.Math.Vector2(-7, -12), new Phaser.Math.Vector2(9, 0), new Phaser.Math.Vector2(-7, 12)]
    const chev = this.add.graphics()
    chev.lineStyle(8, T.goldDarkest, 0.5) // soft dark backing so the cue stays legible on the cream face
    chev.strokePoints(pts, false)
    chev.lineStyle(5, T.goldBright, 0.95)
    chev.strokePoints(pts, false)
    if (nextRight) chev.setPosition(CHIP / 2 + 13, 0)
    else chev.setPosition(0, CHIP / 2 + 13).setRotation(Math.PI / 2)
    container.add(chev)
    // Gentle "keep going" nudge toward the next chip — gated OFF under reduced motion (static arrow).
    if (this.prefersReducedMotion()) return
    this.tweens.add({
      targets: chev,
      x: chev.x + (nextRight ? 6 : 0),
      y: chev.y + (nextRight ? 0 : 6),
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
   */
  private drawTrail(firstRow: number, lastRow: number): void {
    const grid = this.grid
    if (!grid) return
    const T = getTheme()
    const g = grid.trail
    g.clear()
    const { startX, viewTop, unlocked } = grid
    // Chip centre in content-local space — the exact cx/cy formula buildChip uses, so the trail threads
    // the real grid geometry (GRID_COLS columns on a CHIP+GAP pitch, ROW_H rows).
    const centre = (n: number): Phaser.Math.Vector2 => {
      const row = Math.floor((n - 1) / GRID_COLS)
      const col = (n - 1) % GRID_COLS
      return new Phaser.Math.Vector2(startX + col * (CHIP + GAP) + CHIP / 2, viewTop + TOP_PAD + row * ROW_H + CHIP / 2)
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
    const milestone = n % 10 === 0 // L2: every 10th level is a gilded "landmark" on the journey map
    const T = getTheme()
    const container = this.add.container(cx, cy)
    const g = this.add.graphics()
    if (playable) {
      g.fillStyle(T.shadow, 0.12)
      g.fillRoundedRect(-CHIP / 2 + 2, -CHIP / 2 + 5, CHIP, CHIP, 20)
      if (milestone) {
        // L2: gilded landmark face — a baked `goldFace` frame (E7 real-metal, brightest along the top
        // crown) with a cream face inset so the gold reads as an ornamental border. Static, theme-tokened.
        goldFace(g, -CHIP / 2, -CHIP / 2, CHIP, CHIP, T, 20)
        g.fillStyle(0xffffff, 1)
        g.fillRoundedRect(-CHIP / 2 + MILESTONE_FRAME, -CHIP / 2 + MILESTONE_FRAME, CHIP - MILESTONE_FRAME * 2, CHIP - MILESTONE_FRAME * 2, 14)
        g.lineStyle(current ? 4 : 3, current ? T.gold : T.goldBezel, 1)
      } else {
        g.fillStyle(0xffffff, 1)
        g.fillRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
        g.lineStyle(current ? 4 : 2, current ? T.gold : T.border, 1)
      }
      g.strokeRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
    } else if (milestone) {
      // L2: a locked landmark still reads gold (muted) so upcoming waypoints are visible on the map —
      // the "see where the journey leads" payoff. Cream face inset over a dimmed `goldFace` frame.
      goldFace(g, -CHIP / 2, -CHIP / 2, CHIP, CHIP, T, 20)
      g.fillStyle(0xefe8da, 1)
      g.fillRoundedRect(-CHIP / 2 + MILESTONE_FRAME, -CHIP / 2 + MILESTONE_FRAME, CHIP - MILESTONE_FRAME * 2, CHIP - MILESTONE_FRAME * 2, 14)
      g.lineStyle(2, T.goldBezel, 0.7)
      g.strokeRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
      g.setAlpha(0.75) // subordinate to the current chip — a landmark ahead, not yet reached
    } else {
      g.fillStyle(0xefe8da, 1)
      g.fillRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
    }
    container.add(g)

    if (playable) {
      const hasStars = stars > 0
      const numText = this.add
        // Milestones always carry a tally below, so their number rides high like a starred chip's.
        .text(0, milestone || hasStars ? -14 : 0, String(n), {
          fontFamily: FONT,
          fontSize: '40px',
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
      const lock = this.add.image(0, 0, 'lock').setAlpha(0.55)
      lock.setDisplaySize(36, 36)
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

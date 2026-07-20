import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { endlessBestThisWeek, endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import { quality } from '../view/quality'
import { getTheme, prefersReducedMotion } from '../view/theme'
import { FONT, GHOST_PILL, ROSE_PILL, addMarquee, addMuteChip, addPillButton, goldFace, startScene } from '../view/ui'

const GRID_COLS = 5
const CHIP = 108
const GAP = 18
const ROW_H = CHIP + GAP
/** L2: gold frame band width — a milestone chip's cream face insets this much so the baked `goldFace` rim shows as an ornamental border. */
const MILESTONE_FRAME = 7
/** Grid entrance cascade: per (visible) row delay + pop duration, tuned so the whole ripple lands under ~500ms. */
const CASCADE_STAGGER = 36
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
const TRAIL_DOT_GAP = 15
const TRAIL_DOT_R = 3.4
const TRAIL_LIT_ALPHA = 0.5
const TRAIL_DIM_ALPHA = 0.26
const TRAIL_RETURN_BOW = 16

export class LevelSelectScene extends Phaser.Scene {
  /** Largest pointer travel during the current press — a tap on a chip only fires below this. */
  private dragMoved = 0
  /** Beat 5: set when routed here straight from a win, so the newly-current chip celebrates. */
  private fromWin = false
  /** L1: masked level-grid container (its `y` is the scroll offset) — held so update() can coast it. */
  private scrollContent?: Phaser.GameObjects.Container
  /** L1: the drag clamp's bounds, captured so the fling reuses the exact same [min,max] limits. */
  private minScroll = 0
  private maxScroll = 0
  /** L1: flick velocity (content-px/frame); friction-decayed each update() after release, 0 at rest. */
  private scrollVel = 0
  /** C4: rising-edge latch for `quality.idle()` — true once the current idle beat has fired; re-armed on activity. */
  private wasIdle = false
  /** C4: the current-level chip + its steady "you are here" breathe — the idle beat pauses it for one nudge. */
  private currentChip?: Phaser.GameObjects.Container
  private currentChipPulse?: Phaser.Tweens.Tween

  constructor() {
    super('levelselect')
  }

  init(data: { fromWin?: boolean }): void {
    this.fromWin = data?.fromWin === true
  }

  create(): void {
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    this.cameras.main.setScroll(0, restScrollY()) // centre the design box in the taller world
    // C4: reset the idle-attract state per entry — Phaser reuses the scene instance across navigation, so
    // clear the latch + any stale current-chip/tween ref (e.g. from a visit that HAD a current chip) before
    // the grid rebuilds; startChipPulse re-captures the live chip once its entrance settles.
    this.wasIdle = false
    this.currentChip = undefined
    this.currentChipPulse = undefined
    const save = loadSave()
    addCasinoBackdrop(this, 'menu')
    addMarquee(this, DESIGN_W / 2, 96)
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this,'home'))
    addMuteChip(this, 676, 40)

    const unlocked = endlessUnlocked(save)
    const viewTop = 156
    const viewBottom = unlocked ? 1092 : 1176

    // Scrollable grid of level chips.
    const content = this.add.container(0, 0)
    const gridW = GRID_COLS * CHIP + (GRID_COLS - 1) * GAP
    const startX = (DESIGN_W - gridW) / 2
    const topPad = 32
    // L4 · map "journey" trail — a faint dotted, winding line threading the chip centres in level
    // order, lit gold up to the current chip and muted beyond. Added FIRST so it sits UNDER every chip;
    // it lives in `content`, so it rides L1's scroll (content.y) + the existing geometry mask (no
    // second mask). Static → reduced motion unaffected.
    content.add(this.buildPathTrail(startX, topPad, viewTop, save.unlocked))
    const reduced = this.prefersReducedMotion()
    const chipEntries: { container: Phaser.GameObjects.Container; cy: number; current: boolean }[] = []
    for (let n = 1; n <= LEVEL_COUNT; n++) {
      const row = Math.floor((n - 1) / GRID_COLS)
      const col = (n - 1) % GRID_COLS
      const cx = startX + col * (CHIP + GAP) + CHIP / 2
      const cy = viewTop + topPad + row * ROW_H + CHIP / 2
      const chip = this.buildChip(n, cx, cy, save.unlocked, save.stars[n] ?? 0, viewTop, viewBottom, content)
      content.add(chip)
      chipEntries.push({ container: chip, cy, current: n === save.unlocked })
    }
    const rows = Math.ceil(LEVEL_COUNT / GRID_COLS)
    const contentBottom = viewTop + topPad + rows * ROW_H + 24

    const maskG = this.make.graphics({ x: 0, y: 0 }, false)
    maskG.fillStyle(0xffffff)
    maskG.fillRect(0, viewTop, DESIGN_W, viewBottom - viewTop)
    content.setMask(maskG.createGeometryMask())

    // Scroll bounds + the container, held on the scene so update()'s L1 fling reuses the exact clamp.
    this.scrollContent = content
    this.scrollVel = 0
    this.minScroll = Math.min(0, viewBottom - contentBottom)
    this.maxScroll = 0
    // Open scrolled so the current level sits mid-viewport.
    const curRow = Math.floor((Math.min(save.unlocked, LEVEL_COUNT) - 1) / GRID_COLS)
    const curCy = viewTop + topPad + curRow * ROW_H + CHIP / 2
    content.y = Phaser.Math.Clamp((viewTop + viewBottom) / 2 - curCy, this.minScroll, this.maxScroll)

    // Grid entrance cascade: chips (with their star icons, nested in each container) scale + fade
    // in, rippling down by on-screen row. Runs after content.y is finalised so the stagger tracks
    // what the player actually sees; rows clipped by the mask fall out harmlessly at the clamped
    // ends. The current chip's idle pulse waits for its pop so the two scale tweens don't collide.
    for (const { container, cy, current } of chipEntries) {
      const startPulse = current ? () => this.startChipPulse(container) : undefined
      if (reduced) {
        // Reduced motion (§E8): skip the entrance pop AND the "you are here" breathing pulse —
        // the current chip is already distinguished by its gold border, so it rests static.
        continue
      }
      container.setScale(0.55).setAlpha(0)
      const visRow = Phaser.Math.Clamp(Math.round((cy + content.y - viewTop) / ROW_H), 0, 10)
      this.tweens.add({
        targets: container,
        scale: 1,
        alpha: 1,
        duration: CASCADE_DURATION,
        delay: visRow * CASCADE_STAGGER,
        ease: 'Back.easeOut',
        onComplete: startPulse,
      })
    }

    // Drag to scroll (chip taps are suppressed once the press has travelled — see buildChip). While
    // the finger is down the grid tracks it 1:1; L1 adds a flick — the release velocity is smoothed
    // during the drag and, unless motion is reduced, committed to update() to coast under friction.
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
      flickVel = 0
      lastMoveAt = this.time.now
    })
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!dragging || !p.isDown) return
      const dy = p.y - startPointerY
      this.dragMoved = Math.max(this.dragMoved, Math.abs(dy))
      const prevY = content.y
      content.y = Phaser.Math.Clamp(startContentY + dy, this.minScroll, this.maxScroll)
      if (reduced) return // reduced motion (§E8): 1:1 drag only — never build a fling velocity
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
      // Hand the smoothed velocity to update()'s coast only for a genuine flick: motion allowed, above
      // the flick floor, and released promptly after the last move (a hold-then-lift stops dead, as today).
      if (!reduced && Math.abs(flickVel) >= FLICK_MIN && this.time.now - lastMoveAt <= FLICK_IDLE_MS) {
        this.scrollVel = flickVel
      }
    })

    // Fixed footer.
    if (unlocked) {
      const wkBest = endlessBestThisWeek(save)
      addPillButton(this, DESIGN_W / 2, 1150, 420, 68, 'ENDLESS', ROSE_PILL, () => startScene(this,'game', { endless: true }))
      this.add
        .text(DESIGN_W / 2, 1196, wkBest > 0 ? `weekly board  ·  best ${wkBest.toLocaleString()}` : `new weekly board`, {
          fontFamily: FONT,
          fontSize: '19px',
          color: getTheme().onBackdropMuted,
        })
        .setOrigin(0.5)
    }
    this.add
      .text(DESIGN_W / 2, 1238, `BEST  ${save.best.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '900',
        color: getTheme().goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
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
    // L1 flick inertia (unchanged) — coast the masked grid under friction after a release with momentum.
    if (this.scrollVel === 0 || !this.scrollContent) return
    const raw = this.scrollContent.y + this.scrollVel
    const next = Phaser.Math.Clamp(raw, this.minScroll, this.maxScroll)
    this.scrollContent.y = next
    if (next !== raw) {
      this.scrollVel = 0 // a bound swallowed the step — halt at the end
      return
    }
    this.scrollVel *= FLICK_FRICTION
    if (Math.abs(this.scrollVel) < FLICK_STOP) this.scrollVel = 0
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
   * exactly at the "you are here" chip. Returned to create() to be added FIRST into `content`, so it
   * sits UNDER every chip and rides L1's scroll + the existing geometry mask (no second mask; static).
   */
  private buildPathTrail(startX: number, topPad: number, viewTop: number, unlocked: number): Phaser.GameObjects.Graphics {
    const T = getTheme()
    const g = this.add.graphics()
    // Chip centre in content-local space — the exact cx/cy formula buildChip uses, so the trail threads
    // the real grid geometry (GRID_COLS columns on a CHIP+GAP pitch, ROW_H rows).
    const centre = (n: number): Phaser.Math.Vector2 => {
      const row = Math.floor((n - 1) / GRID_COLS)
      const col = (n - 1) % GRID_COLS
      return new Phaser.Math.Vector2(startX + col * (CHIP + GAP) + CHIP / 2, viewTop + topPad + row * ROW_H + CHIP / 2)
    }
    // One faint dot; travelled dots glow gold, the rest sit muted (colour + alpha reset per stamp so a
    // single Graphics carries both tones).
    const dot = (x: number, y: number, lit: boolean): void => {
      g.fillStyle(lit ? T.gold : T.suitWatermark, lit ? TRAIL_LIT_ALPHA : TRAIL_DIM_ALPHA)
      g.fillCircle(x, y, TRAIL_DOT_R)
    }
    // Walk the chips in level order, dotting each n → n+1 gap; endpoints (chip centres) are left
    // unstamped — they hide under the chips anyway and skipping them keeps shared vertices seam-free.
    for (let n = 1; n < LEVEL_COUNT; n++) {
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
    return g
  }

  private buildChip(
    n: number,
    cx: number,
    cy: number,
    unlocked: number,
    stars: number,
    viewTop: number,
    viewBottom: number,
    content: Phaser.GameObjects.Container
  ): Phaser.GameObjects.Container {
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
      // Beat 5 echo: the freshly-unlocked current chip pops + sparkles + haloes on win arrival.
      if (current && this.fromWin) this.celebrateCurrentChip(container, numText, cx, cy, content)
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
      const zone = this.add.rectangle(0, 0, CHIP, CHIP, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
      zone.on('pointerdown', () => container.setScale(0.94))
      zone.on('pointerout', () => container.setScale(1))
      zone.on('pointerup', () => {
        container.setScale(1)
        // Ignore taps that were really a scroll, or land on a chip clipped outside the viewport.
        const screenY = cy + content.y
        if (this.dragMoved >= 12 || screenY < viewTop || screenY > viewBottom) return
        sfx.uiTap()
        startScene(this,'game', { level: n })
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

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { endlessBestThisWeek, endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { loadSave } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import { getTheme, prefersReducedMotion } from '../view/theme'
import { FONT, GHOST_PILL, ROSE_PILL, addMarquee, addMuteChip, addPillButton, startScene } from '../view/ui'

const GRID_COLS = 5
const CHIP = 108
const GAP = 18
const ROW_H = CHIP + GAP
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

  /** Reduced-motion (OS query OR in-app override) — delegates to the shared theme authority (§E8). */
  private prefersReducedMotion(): boolean {
    return prefersReducedMotion()
  }

  /** The current level's gentle "you are here" breathing pulse — started once its entrance pop settles. */
  private startChipPulse(container: Phaser.GameObjects.Container): void {
    this.tweens.add({ targets: container, scale: 1.06, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
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
    const T = getTheme()
    const container = this.add.container(cx, cy)
    const g = this.add.graphics()
    if (playable) {
      g.fillStyle(T.shadow, 0.12)
      g.fillRoundedRect(-CHIP / 2 + 2, -CHIP / 2 + 5, CHIP, CHIP, 20)
      g.fillStyle(0xffffff, 1)
      g.fillRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
      g.lineStyle(current ? 4 : 2, current ? T.gold : T.border, 1)
      g.strokeRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
    } else {
      g.fillStyle(0xefe8da, 1)
      g.fillRoundedRect(-CHIP / 2, -CHIP / 2, CHIP, CHIP, 20)
    }
    container.add(g)

    if (playable) {
      const hasStars = stars > 0
      const numText = this.add
        .text(0, hasStars ? -14 : 0, String(n), {
          fontFamily: FONT,
          fontSize: '40px',
          fontStyle: '900',
          color: current ? T.goldText : T.ink,
        })
        .setOrigin(0.5)
      container.add(numText)
      // Beat 5 echo: the freshly-unlocked current chip pops + sparkles + haloes on win arrival.
      if (current && this.fromWin) this.celebrateCurrentChip(container, numText, cx, cy, content)
      for (let i = 0; i < stars; i++) {
        const star = this.add.image((i - (stars - 1) / 2) * 30, 30, 'star')
        star.setDisplaySize(26, 26)
        container.add(star)
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

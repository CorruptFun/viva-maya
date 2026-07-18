import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import {
  BOARD_W,
  BOARD_X,
  BOARD_Y,
  CELL,
  CLEAR_MS,
  COLS,
  DESIGN_W,
  FALL_BASE_MS,
  FALL_PER_CELL_MS,
  INVALID_MS,
  MOVES_BONUS,
  PIECE_SIZE,
  POINTS_PER_PIECE,
  ROWS,
  SWAP_MS,
} from '../config'
import { Board } from '../core/board'
import { ENDLESS_MOVES, endlessBestForWeek, endlessRngForWeek, recordEndless, weekKey } from '../core/endless'
import { LEVEL_COUNT, levelSpec } from '../core/levels'
import { devSetLives, formatCountdown, refreshLives, spendLife } from '../core/lives'
import { mulberry32 } from '../core/rng'
import { addChips, loadSave, recordResult, recordScore, takePendingBoosts } from '../core/save'
import { SYMBOLS, key } from '../core/types'
import type { BoostType, ClearWave, Coord, FallMove, LevelSpec, Piece, Spawn, SymbolType } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { quality } from '../view/quality'
import { TEX_SIZE, ensurePieceTexture } from '../view/textures'
import { FONT, GHOST_PILL, GOLD_PILL, ROSE_PILL, addChipPill, addLivesHud, addMuteChip, addPillButton, startScene } from '../view/ui'
import type { ChipPill } from '../view/ui'

/**
 * Turn state machine:
 *
 *   idle --input--> swapping --activation?--> resolving (wave/fall/refill loop, cascades)
 *                      |  no                        |
 *                      v                            v
 *                 snap back --> idle    objectives met / moves out --> ended (overlay)
 *                                       no valid moves --> shuffling --> idle
 */
type GameState = 'idle' | 'swapping' | 'resolving' | 'shuffling' | 'ended'

interface ObjectiveState {
  symbol: SymbolType
  remaining: number
  total: number
  text?: Phaser.GameObjects.Text
  chip?: Phaser.GameObjects.Container
  /** Soft gold halo behind the chip that breathes while this objective is INCOMPLETE. */
  glow?: Phaser.GameObjects.Image
  /** The breathe tween on `glow` — stopped when the objective completes. */
  pulse?: Phaser.Tweens.Tween
}

const PIECE_SCALE = PIECE_SIZE / TEX_SIZE
const DRAG_THRESHOLD = CELL * 0.3

export class GameScene extends Phaser.Scene {
  private level = 1
  private spec!: LevelSpec
  private board!: Board
  private sprites = new Map<number, Phaser.GameObjects.Sprite>()
  private pieceLayer!: Phaser.GameObjects.Container
  private emitters!: Record<SymbolType, Phaser.GameObjects.Particles.ParticleEmitter>
  private sparkEmitter!: Phaser.GameObjects.Particles.ParticleEmitter
  /** Looping additive halo behind each on-board special sprite (the "armed/loaded" tell). */
  private armedGlows = new Map<number, Phaser.GameObjects.Image>()
  /**
   * Soft CREAM shimmer halo behind each on-board NORMAL piece whose symbol is still a needed
   * objective — the "collect me" tell. Deliberately cool/white and phase-shimmered (see update)
   * so it never reads as the specials' warm-gold armed glow. Keyed by piece id; position +
   * alpha are synced per-frame, so there are no per-piece tweens and no graphics redraws.
   */
  private goalGlows = new Map<number, Phaser.GameObjects.Image>()
  /** Cached prefers-reduced-motion — tones down detonation particle counts + the armed pulse. */
  private reducedMotion = false
  private cabinetBulbs: Phaser.GameObjects.Image[] = []
  private cabinetGlow?: Phaser.GameObjects.Image
  private state: GameState = 'idle'

  // --- P6 idle micro-life (all reduced-motion-gated, governor-capped) ---
  /** 3a: masked cream gloss that glides across the 8×8 while idle; paused off-idle (see update). */
  private boardShimmer?: Phaser.GameObjects.Image
  private boardShimmerTween?: Phaser.Tweens.Tween
  /** Tracks the shimmer's idle on/off edge so update() only toggles it on a state change. */
  private shimmerOn = false
  /** 3c: score-text punch tween — killed + restarted so overlapping chunky gains don't stack scale. */
  private scorePunchTween: Phaser.Tweens.Tween | null = null
  /** 3d: idle-hint nudge — armed on entering idle, disarmed on the first board touch / swap-start. */
  private hintTimer: Phaser.Time.TimerEvent | null = null
  private hintTween: Phaser.Tweens.Tween | null = null
  private hintTargets: Phaser.GameObjects.Sprite[] = []
  private hintRing?: Phaser.GameObjects.Image

  private movesLeft = 0
  private objectives: ObjectiveState[] = []
  private movesText!: Phaser.GameObjects.Text
  /** Looping "urgent" pulse on the moves number once movesLeft ≤ 3 (started once, cleared on level end). */
  private movesPulse: Phaser.Tweens.Tween | null = null

  private selected: Coord | null = null
  private selectedSprite: Phaser.GameObjects.Sprite | null = null
  private selectPulse: Phaser.Tweens.Tween | null = null
  private ring!: Phaser.GameObjects.Sprite

  private dragFrom: Coord | null = null
  private dragStartX = 0
  private dragStartY = 0
  private dragConsumed = false

  private score = 0
  private shownScore = 0
  private scoreTween: Phaser.Tweens.Tween | null = null
  private scoreText!: Phaser.GameObjects.Text

  /** Compact chip-balance pill in the HUD; the win payout flies a chip into it. */
  private chipHud?: ChipPill
  /** New chip total banked by the current win (set in finishWin, applied on the payout fly-in). */
  private chipBanked = 0

  /** Set while the win result card is animating in — a tap fast-forwards it to the settled state. */
  private overlaySettle: (() => void) | null = null

  private autoplay = false
  private autoplayDelay = 450
  private activeBoosts: BoostType[] = []
  private scoreMult = 1
  private endless = false
  private endlessBest = 0
  private endlessWeekKey = ''
  /** A move was consumed this level — so a mid-level quit costs a life (numbered levels only). */
  private moveMade = false
  private apSched = 0
  private apFired = 0
  private apMoved = 0
  private dbgStage = ''
  private sid = 0

  private log(...args: unknown[]): void {
    if (import.meta.env.DEV) console.log(`[vm ${this.sid}]`, ...args)
  }

  constructor() {
    super('game')
  }

  init(data: { level?: number; endless?: boolean }): void {
    // The ?endless URL fallback only applies when no explicit level was routed in — otherwise
    // it would stick across scene.start('game', {level}) (the SPA URL never changes in DEV).
    this.endless =
      data?.endless === true ||
      (import.meta.env.DEV && data?.level == null && new URLSearchParams(location.search).has('endless'))
    this.level = Math.max(1, data?.level ?? 1)
  }

  create(): void {
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    this.sid = Math.floor(Math.random() * 10000)
    this.log('create', location.search, this.endless ? 'ENDLESS' : `level ${this.level}`)
    this.moveMade = false

    // DEV: ?lives=N forces the pool before the gate check.
    if (import.meta.env.DEV) {
      const lv = new URLSearchParams(location.search).get('lives')
      if (lv !== null) devSetLives(Number(lv))
    }
    // Lives gate — a numbered level needs a life to enter (endless is never gated). Checked
    // BEFORE the board build / boost consume, so a gated entry never wastes a pending boost.
    if (!this.endless && refreshLives().lives <= 0) {
      this.showLivesGate()
      return
    }

    // Endless: a fixed-budget score attack on this WEEK's shared, seeded board (same for
    // everyone). No objectives, no boosts (planting specials would change the board and
    // break the race's fairness). Otherwise: the numbered level with a fresh random board.
    if (this.endless) {
      // Capture the week key ONCE so the run is scored against the board it was seeded from,
      // even if the local week boundary is crossed mid-run.
      this.endlessWeekKey = weekKey()
      this.spec = { level: 0, moves: ENDLESS_MOVES, symbolCount: SYMBOLS.length, objectives: [] }
      this.board = new Board(ROWS, COLS, SYMBOLS.length, endlessRngForWeek(this.endlessWeekKey))
      this.endlessBest = endlessBestForWeek(loadSave(), this.endlessWeekKey)
    } else {
      this.spec = levelSpec(this.level)
      this.board = new Board(ROWS, COLS, this.spec.symbolCount, mulberry32((Math.random() * 2 ** 31) | 0))
    }
    this.movesLeft = this.spec.moves
    this.objectives = this.spec.objectives.map(o => ({ symbol: o.symbol, remaining: o.count, total: o.count }))
    this.score = 0
    this.shownScore = 0
    this.state = 'idle'
    this.sprites.clear()
    this.armedGlows.clear()
    this.goalGlows.clear()
    this.reducedMotion = this.prefersReducedMotion()
    this.selected = null
    this.selectedSprite = null
    this.selectPulse = null
    this.dragFrom = null
    this.scoreMult = 1
    this.movesPulse = null
    this.activeBoosts = []
    this.autoplay = import.meta.env.DEV && new URLSearchParams(location.search).has('auto')
    if (!this.endless) this.applyBoosts(takePendingBoosts())

    if (import.meta.env.DEV) {
      // URL knobs for automated checks: ?goal=N ?moves=N ?auto=MS ?plant=1
      const params = new URLSearchParams(location.search)
      const goal = Number(params.get('goal'))
      if (goal > 0) this.objectives.forEach(o => ((o.remaining = goal), (o.total = goal)))
      const moves = Number(params.get('moves'))
      if (moves > 0) this.movesLeft = moves
      this.autoplayDelay = Number(params.get('auto')) || 450
      // The embedded-pane clock is starved by visibility pauses; turbo multiplies
      // tween/timer time so automated checks advance at a usable pace.
      const turbo = Number(params.get('turbo'))
      if (turbo > 0) {
        this.tweens.timeScale = turbo
        this.time.timeScale = turbo
      }
      if (params.has('plant')) {
        this.board.plant({ row: 6, col: 1 }, 'wildReelCol')
        this.board.plant({ row: 7, col: 1 }, 'diceBomb')
        this.board.plant({ row: 7, col: 2 }, 'jackpot')
      }
    }

    addCasinoBackdrop(this, 'game')
    this.buildBackdrop()
    this.buildCabinet()
    this.buildHud()
    this.buildPieceLayer()
    this.buildParticles()
    this.buildBoardShimmer()

    if (this.scoreMult > 1) {
      this.add
        .text(BOARD_X + BOARD_W - 128, 66, '×2', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: '#c9930a' })
        .setOrigin(1, 0)
    }
    if (this.activeBoosts.length > 0) this.showBoostBanner(this.activeBoosts)
    this.showGoalCallout()

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p))
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p))
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p))

    if (import.meta.env.DEV) {
      this.updateDebug()
      this.time.addEvent({ delay: 300, loop: true, callback: () => this.updateDebug() })
    }
    this.scheduleAutoplay()
    this.armHint()
  }

  /**
   * Out-of-lives screen (numbered levels only) — a warm "take a break" with a live
   * countdown to the next life. When one regenerates, a PLAY button appears. The
   * countdown is wall-clock based (refreshLives reads Date.now), so it stays correct
   * even if the timer tick is throttled while the tab is hidden.
   */
  private showLivesGate(): void {
    this.log('showLivesGate')
    addCasinoBackdrop(this, 'menu')
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this,'home'))
    addMuteChip(this, 676, 40)

    this.add
      .text(DESIGN_W / 2, 320, 'TAKE A BREAK', { fontFamily: FONT, fontSize: '56px', fontStyle: '900', color: '#c9930a' })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
    this.add
      .text(DESIGN_W / 2, 384, 'Out of lives — they refill on their own', { fontFamily: FONT, fontSize: '24px', color: '#9a927e' })
      .setOrigin(0.5)

    const emblem = this.add.image(DESIGN_W / 2, 560, 'heart').setDisplaySize(150, 150).setTint(0x8a7a52).setAlpha(0.4)
    this.tweens.add({ targets: emblem, alpha: 0.65, scale: emblem.scaleX * 1.05, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })

    const hud = addLivesHud(this, DESIGN_W / 2, 700, { size: 46, showTimer: false })
    const nextText = this.add
      .text(DESIGN_W / 2, 782, '', { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: '#2a2732' })
      .setOrigin(0.5)
    const fullText = this.add
      .text(DESIGN_W / 2, 828, '', { fontFamily: FONT, fontSize: '22px', color: '#9a927e' })
      .setOrigin(0.5)
    let playBtn: Phaser.GameObjects.Container | null = null

    const tick = (): void => {
      const st = refreshLives()
      hud.update(st)
      if (st.lives > 0) {
        nextText.setText('A life is ready!')
        fullText.setText('')
        if (!playBtn) {
          playBtn = addPillButton(this, DESIGN_W / 2, 924, 320, 88, 'PLAY', GOLD_PILL, () =>
            startScene(this,'game', { level: this.level })
          )
          this.tweens.add({ targets: playBtn, scale: 1.05, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
        }
      } else {
        nextText.setText(`Next life in  ${formatCountdown(st.nextInMs)}`)
        fullText.setText(`Full in  ${formatCountdown(st.fullInMs)}`)
      }
    }
    tick()
    this.time.addEvent({ delay: 1000, loop: true, callback: tick })
  }

  /**
   * In-game back button: a mid-level quit AFTER a move spends a life (numbered levels only).
   * Only when the board is settled (idle) — mid-resolve, finishWin/finishLose is the single
   * source of truth for the outcome, so we must not pre-charge a move that's about to WIN
   * (wins are free) or double-charge one that's about to lose.
   */
  private exitToLevels(): void {
    if (!this.endless && this.state === 'idle' && this.moveMade) spendLife()
    startScene(this,'levelselect')
  }

  /** DEV only: expose model state via DOM (dataset + visible strip) for external tooling. */
  private updateDebug(): void {
    if (!import.meta.env.DEV) return
    const hint = this.board.findFirstValidMove()
    const describe = (c: Coord) => `${this.board.get(c)?.symbol}@(${c.row},${c.col})`
    const obj = this.objectives.map(o => `${o.symbol}:${o.remaining}`).join(',')
    const text = `L${this.level} ${this.state} [${this.dbgStage}] mv=${this.movesLeft} sc=${this.score} obj=${obj} hint=${
      hint ? `${describe(hint.a)}->${describe(hint.b)}` : 'none'
    }`
    document.body.dataset.vegas = JSON.stringify({
      level: this.level,
      state: this.state,
      moves: this.movesLeft,
      score: this.score,
      objectives: this.objectives.map(o => ({ symbol: o.symbol, remaining: o.remaining })),
      hint,
    })
    let el = document.getElementById('dbg')
    if (!el) {
      el = document.createElement('div')
      el.id = 'dbg'
      el.style.cssText =
        'position:fixed;top:0;left:0;background:#000c;color:#0f0;font:12px monospace;padding:2px 6px;z-index:9;pointer-events:none'
      document.body.appendChild(el)
    }
    el.textContent = text
  }

  /** Daily-spin prizes: head starts applied to this level, consumed win or lose. */
  private applyBoosts(boosts: BoostType[]): void {
    if (boosts.length === 0) return
    this.activeBoosts = boosts
    const usedCells = new Set<string>()
    const plantAt = (kind: 'wildReelRow' | 'wildReelCol' | 'diceBomb' | 'jackpot') => {
      for (let tries = 0; tries < 20; tries++) {
        const at = { row: 3 + Math.floor(Math.random() * 5), col: Math.floor(Math.random() * COLS) }
        const cellKey = `${at.row},${at.col}`
        if (usedCells.has(cellKey)) continue
        usedCells.add(cellKey)
        this.board.plant(at, kind)
        return
      }
    }
    for (const boost of boosts) {
      if (boost === 'extraMoves') this.movesLeft += 5
      else if (boost === 'doubleScore') this.scoreMult = 2
      else if (boost === 'wildReel') plantAt(Math.random() < 0.5 ? 'wildReelRow' : 'wildReelCol')
      else if (boost === 'diceBomb') plantAt('diceBomb')
      else if (boost === 'jackpot') plantAt('jackpot')
    }
  }

  private boostLabel(boost: BoostType): string {
    switch (boost) {
      case 'extraMoves':
        return '+5 moves'
      case 'doubleScore':
        return '2x score'
      case 'wildReel':
        return 'Wild Reel planted'
      case 'diceBomb':
        return 'Dice Bomb planted'
      case 'jackpot':
        return 'Jackpot Chip planted'
    }
  }

  /**
   * Level-start banner announcing the daily-spin boosts. A self-sizing gold pill
   * that pops in over the top of the board, holds, then fades up — sits below the
   * HUD so it never collides with the moves/objective chips (the old flat toast at
   * BOARD_Y-44 overlapped that row). Scales down if the label runs wider than the board.
   */
  private showBoostBanner(boosts: BoostType[]): void {
    const banner = this.add.container(DESIGN_W / 2, BOARD_Y + 72).setDepth(31)
    const text = this.add
      .text(0, 0, `🎁  ${boosts.map(b => this.boostLabel(b)).join('   ·   ')}`, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '900',
        color: '#c9930a',
      })
      .setOrigin(0.5)
    const w = text.width + 56
    const h = 64
    const g = this.add.graphics()
    g.fillStyle(0x8a7a52, 0.2)
    g.fillRoundedRect(-w / 2 + 2, -h / 2 + 5, w, h, h / 2)
    g.fillStyle(0xfffdf8, 0.98)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.lineStyle(3, 0xf2c14e, 1)
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    banner.add([g, text])
    const fit = Math.min(1, (BOARD_W + 20) / w)
    banner.setScale(0)
    this.tweens.add({ targets: banner, scale: fit, duration: 320, ease: 'Back.easeOut' })
    this.tweens.add({
      targets: banner,
      alpha: 0,
      y: banner.y - 26,
      delay: 2400,
      duration: 500,
      onComplete: () => banner.destroy(),
    })
  }

  /**
   * Level-start "COLLECT" callout: a brief cream card over the board naming the goal symbol(s)
   * large the moment the level opens, then it pops in, holds, and fades up/out (~1.5s). Reuses the
   * showBoostBanner pattern; shown instantly (no pop, no fade) under reduced-motion. No-op in
   * endless / when there are no objectives.
   */
  private showGoalCallout(): void {
    if (this.endless || this.objectives.length === 0) return
    const cx = DESIGN_W / 2
    const cy = BOARD_Y + BOARD_W * 0.36
    const layer = this.add.container(cx, cy).setDepth(34)

    const header = this.add
      .text(0, -66, 'COLLECT', { fontFamily: FONT, fontSize: '32px', fontStyle: '900', color: '#c9930a' })
      .setOrigin(0.5)
      .setLetterSpacing(5)
      .setShadow(0, 3, 'rgba(90,70,20,0.22)', 5, false, true)
    const content: Phaser.GameObjects.GameObject[] = [header]

    const iconSize = 80
    const gap = 34
    const n = this.objectives.length
    const rowW = n * iconSize + (n - 1) * gap
    const startX = -rowW / 2 + iconSize / 2
    this.objectives.forEach((o, i) => {
      const ix = startX + i * (iconSize + gap)
      content.push(this.add.image(ix, 8, o.symbol).setDisplaySize(iconSize, iconSize))
      content.push(
        this.add
          .text(ix, 8 + iconSize / 2 + 22, `×${o.total}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: '#26304d' })
          .setOrigin(0.5)
      )
    })

    const w = Math.max(header.width, rowW) + 84
    const halfH = 96
    const g = this.add.graphics()
    g.fillStyle(0x8a7a52, 0.22)
    g.fillRoundedRect(-w / 2 + 3, -halfH + 8, w, halfH * 2, 30)
    g.fillStyle(0xfffdf8, 0.98)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 30)
    g.lineStyle(3, 0xf2c14e, 1)
    g.strokeRoundedRect(-w / 2, -halfH, w, halfH * 2, 30)
    layer.add(g)
    layer.add(content)

    const fit = Math.min(1, (BOARD_W + 16) / w)
    if (this.reducedMotion) {
      layer.setScale(fit)
      this.time.delayedCall(1400, () => layer.destroy())
      return
    }
    layer.setScale(0)
    this.tweens.add({ targets: layer, scale: fit, duration: 320, ease: 'Back.easeOut' })
    this.tweens.add({
      targets: layer,
      alpha: 0,
      y: cy - 30,
      delay: 1200,
      duration: 420,
      ease: 'Sine.easeIn',
      onComplete: () => layer.destroy(),
    })
  }

  /**
   * An objective just hit zero: retire its "target" emphasis. Stops + fades the chip's gold
   * breathe glow and drops every on-board goal halo for that symbol (the chip's green ✓ is set by
   * the caller and stays). New spawns of a completed symbol never re-highlight (createSprite gates
   * on remaining > 0).
   */
  private onObjectiveComplete(o: ObjectiveState): void {
    o.pulse?.stop()
    o.pulse = undefined
    if (o.glow) {
      const glow = o.glow
      o.glow = undefined
      this.tweens.add({
        targets: glow,
        alpha: 0,
        duration: 260,
        ease: 'Quad.easeOut',
        onComplete: () => glow.destroy(),
      })
    }
    for (const [id, halo] of this.goalGlows) {
      if (halo.getData('sym') === o.symbol) {
        halo.destroy()
        this.goalGlows.delete(id)
      }
    }
  }

  private scheduleAutoplay(): void {
    if (!this.autoplay) return
    this.apSched++
    this.time.delayedCall(this.autoplayDelay, () => {
      this.apFired++
      if (this.state !== 'idle') return
      const hint = this.board.findFirstValidMove()
      if (hint) {
        this.apMoved++
        void this.trySwap(hint.a, hint.b)
      }
    })
  }

  // ------------------------------------------------------------ idle micro-life (§3d)

  /**
   * 3a: a masked cream gloss that glides across the whole 8×8 every ~6s while the board is idle
   * (paused off-idle in update). One `sweep` sprite, ADD, α ≤ 0.16, geometry-masked to the board
   * rect at depth 3 so it catches light on tiles + pieces without crossing the bezel. Skipped
   * under reduced motion / on the weakest governor tier.
   */
  private buildBoardShimmer(): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const maskShape = this.make.graphics({ x: 0, y: 0 }, false)
    maskShape.fillStyle(0xffffff)
    maskShape.fillRect(BOARD_X, BOARD_Y, BOARD_W, BOARD_W)
    const sweep = this.add
      .image(BOARD_X - CELL * 1.5, BOARD_Y + BOARD_W / 2, 'sweep')
      .setDepth(3)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xfff6e8)
      .setAlpha(0.15)
      .setVisible(false)
    sweep.setDisplaySize(CELL * 2.2, BOARD_W + 40)
    sweep.setAngle(12)
    sweep.setMask(maskShape.createGeometryMask())
    this.boardShimmer = sweep
    // Travels off the left edge → off the right edge (mask clips the entry/exit); ~6s cadence.
    this.boardShimmerTween = this.tweens.add({
      targets: sweep,
      x: BOARD_X + BOARD_W + CELL * 1.5,
      duration: 1200,
      ease: 'Sine.easeInOut',
      repeat: -1,
      repeatDelay: 4800,
      paused: true,
    })
  }

  /** 3d: (re)arm the ~5s idle-hint timer. Idempotent — clears any pending/active nudge first. */
  private armHint(): void {
    this.disarmHint()
    if (this.state !== 'idle') return
    this.hintTimer = this.time.delayedCall(5000, () => this.showHint())
  }

  /**
   * 3d: after ~5s idle, gently pulse a valid pair (reusing the engine's findFirstValidMove). Under
   * reduced motion it's a single static ring on the pair — no loop. Disarmed the moment the player
   * touches the board (onDown) or a swap starts (trySwap).
   */
  private showHint(): void {
    this.hintTimer = null
    if (this.state !== 'idle') return
    const move = this.board.findFirstValidMove()
    if (!move) return
    const pa = this.board.get(move.a)
    const pb = this.board.get(move.b)
    if (!pa || !pb) return
    const sprites = [this.sprites.get(pa.id), this.sprites.get(pb.id)].filter(
      (s): s is Phaser.GameObjects.Sprite => !!s && s.active
    )
    if (sprites.length === 0) return
    this.hintTargets = sprites
    if (this.reducedMotion) {
      const pos = this.cellToXY(move.a)
      this.hintRing = this.add
        .image(pos.x, pos.y, 'ring')
        .setDisplaySize(CELL * 1.02, CELL * 1.02)
        .setTint(0xf2b234)
        .setAlpha(0.7)
      this.pieceLayer.add(this.hintRing)
      return
    }
    this.hintTween = this.tweens.add({
      targets: sprites,
      scale: PIECE_SCALE * 1.12,
      duration: 460,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  /** Retire the idle-hint nudge: cancel the timer, stop the pulse, settle the pair, drop the ring. */
  private disarmHint(): void {
    this.hintTimer?.remove(false)
    this.hintTimer = null
    this.hintTween?.stop()
    this.hintTween = null
    for (const s of this.hintTargets) if (s.active) s.setScale(PIECE_SCALE)
    this.hintTargets = []
    this.hintRing?.destroy()
    this.hintRing = undefined
  }

  /**
   * 3b: the objective-complete beat. The chip's green ✓ + pulse-stop are already handled by the
   * clarity pass (onObjectiveComplete) — this ADDS the celebration: a ✓ stamp punch over the chip,
   * a spark burst, an ascending ding + a haptic. Reduced motion: a static stamp, no spark, instant.
   */
  private objectiveStamp(o: ObjectiveState): void {
    const chip = o.chip
    if (!chip) return
    sfx.starDing(2)
    this.vibrate(40)
    const x = chip.x
    const y = chip.y
    if (!this.reducedMotion && quality.count(1) > 0) {
      this.sparkEmitter.explode(quality.count(10), x, y)
    }
    const stamp = this.add
      .text(x, y, '✓', { fontFamily: FONT, fontSize: '84px', fontStyle: '900', color: '#2fae4c' })
      .setOrigin(0.5)
      .setDepth(33)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(0,0,0,0.18)', 6, false, true)
    if (this.reducedMotion) {
      stamp.setScale(0.9)
      this.time.delayedCall(600, () => stamp.destroy())
      return
    }
    stamp.setScale(0).setAngle(-12)
    this.tweens.add({
      targets: stamp,
      scale: 1,
      angle: 0,
      duration: 300,
      ease: 'Back.easeOut',
      onComplete: () =>
        this.tweens.add({
          targets: stamp,
          alpha: 0,
          y: y - 30,
          delay: 240,
          duration: 320,
          ease: 'Sine.easeIn',
          onComplete: () => stamp.destroy(),
        }),
    })
  }

  /**
   * 3e: a quick gold `ring` implosion + spark when a piece is born into a special (wild reel / dice
   * bomb / jackpot). ADD, transient, depth 22 (above the pieces, below the HUD). Reduced motion: no-op.
   */
  private specialBirth(at: Coord): void {
    const pos = this.cellToXY(at)
    if (!this.reducedMotion && quality.count(1) > 0) {
      this.sparkEmitter.explode(quality.count(6), pos.x, pos.y)
    }
    if (this.reducedMotion) return
    const ring = this.add
      .image(pos.x, pos.y, 'ring')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xf2b234)
      .setDepth(22)
      .setDisplaySize(CELL * 2.2, CELL * 2.2)
      .setAlpha(0.7)
    this.tweens.add({
      targets: ring,
      alpha: 0,
      scaleX: ring.scaleX * 0.42,
      scaleY: ring.scaleY * 0.42,
      duration: 320,
      ease: 'Quad.easeIn',
      onComplete: () => ring.destroy(),
    })
  }

  // ---------------------------------------------------------------- layout

  private cellToXY(at: Coord): { x: number; y: number } {
    return {
      x: BOARD_X + at.col * CELL + CELL / 2,
      y: BOARD_Y + at.row * CELL + CELL / 2,
    }
  }

  private xyToCell(x: number, y: number): Coord | null {
    const col = Math.floor((x - BOARD_X) / CELL)
    const row = Math.floor((y - BOARD_Y) / CELL)
    if (row < 0 || col < 0 || row >= ROWS || col >= COLS) return null
    return { row, col }
  }

  // ----------------------------------------------------------------- build

  private buildBackdrop(): void {
    // Reddish "screen is on" glow behind the board — the opaque card covers its center, so only
    // a soft rose halo bleeds past the frame. Surges on a win (see celebrateBoard).
    this.cabinetGlow = this.add
      .image(DESIGN_W / 2, BOARD_Y + BOARD_W / 2, 'bgglow')
      .setTint(0xd3304f)
      .setAlpha(0.1)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.cabinetGlow.setDisplaySize(BOARD_W + 170, BOARD_W + 170)
    this.tweens.add({ targets: this.cabinetGlow, alpha: 0.18, duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })

    // Recessed gold TRAY: an opaque gold-bezel cabinet with a well floor DARKER than the tiles,
    // so the 64 raised glossy cushions pop out of a real 3-D setting. Baked once (static graphics),
    // footprint (pad 18 → x22/y282/size676) unchanged so the marquee bulbs stay aligned.
    const g = this.add.graphics()
    const pad = 18
    const x = BOARD_X - pad
    const y = BOARD_Y - pad
    const size = BOARD_W + pad * 2
    // Cabinet drop shadow.
    g.fillStyle(0x8a7a52, 0.1)
    g.fillRoundedRect(x + 3, y + 8, size, size, 28)
    g.fillStyle(0x8a7a52, 0.07)
    g.fillRoundedRect(x + 6, y + 13, size, size, 28)
    // Gold bezel frame (opaque) + a lit inner sheen and a dark outer edge for bevel depth.
    g.fillStyle(0xc9930a, 1)
    g.fillRoundedRect(x, y, size, size, 28)
    g.fillStyle(0xf2b234, 1)
    g.fillRoundedRect(x + 3, y + 3, size - 6, size - 6, 25)
    g.lineStyle(2, 0xffe6a8, 0.6)
    g.strokeRoundedRect(x + 3, y + 3, size - 6, size - 6, 25)
    g.lineStyle(2, 0x7a5a08, 0.5)
    g.strokeRoundedRect(x, y, size, size, 28)
    // Recessed well (floor deeper than the tiles so the cushions read as raised).
    const wi = 14
    const wx = x + wi
    const wy = y + wi
    const ws = size - wi * 2
    const wr = 20
    g.fillStyle(0xe4d8bd, 1)
    g.fillRoundedRect(wx, wy, ws, ws, wr)
    // Top inner-shadow (the recess): stacked dark bands from the top edge, rounded to the well.
    for (const [f, a] of [[0.18, 0.05], [0.12, 0.05], [0.06, 0.06]] as Array<[number, number]>) {
      g.fillStyle(0x000000, a)
      g.fillRoundedRect(wx, wy, ws, ws * f, { tl: wr, tr: wr, bl: 0, br: 0 })
    }
    // Lit bottom lip + a crisp inner rim to seal the recess.
    g.fillStyle(0xfff3d6, 0.08)
    g.fillRoundedRect(wx + 4, wy + ws - 12, ws - 8, 9, { tl: 0, tr: 0, bl: wr - 6, br: wr - 6 })
    g.lineStyle(2, 0x9a875f, 0.45)
    g.strokeRoundedRect(wx, wy, ws, ws, wr)

    // 64 raised glossy tiles — ONE white texture, per-cell tinted (checkerboard WHISPER for
    // row/col tracking, not a stripe). 64 same-texture Images batch to a single draw call; this
    // replaces the old flat one-graphics checkerboard at ≈ +1 persistent draw call.
    const TILE_A = 0xf4e7c6
    const TILE_B = 0xf7e3de
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.cellToXY({ row: r, col: c })
        this.add
          .image(p.x, p.y, 'tile')
          .setDisplaySize(CELL, CELL)
          .setTint((r + c) % 2 === 0 ? TILE_A : TILE_B)
      }
    }
  }

  /**
   * Slot-cabinet marquee: a ring of alternating red/gold bulbs on the board bezel, lit in a
   * traveling chase. Sits outside the 8×8 grid so it never covers a piece. Bulbs are stored so
   * a win can flash them (flashCabinet / celebrateBoard).
   */
  private buildCabinet(): void {
    this.cabinetBulbs = []
    const pad = 18
    const inset = 12
    const left = BOARD_X - pad + inset
    const right = BOARD_X - pad + (BOARD_W + pad * 2) - inset
    const top = BOARD_Y - pad + inset
    const bottom = BOARD_Y - pad + (BOARD_W + pad * 2) - inset
    const step = 56
    const pts: Array<{ x: number; y: number }> = []
    for (let x = left; x < right - 1; x += step) pts.push({ x, y: top })
    for (let y = top; y < bottom - 1; y += step) pts.push({ x: right, y })
    for (let x = right; x > left + 1; x -= step) pts.push({ x, y: bottom })
    for (let y = bottom; y > top + 1; y -= step) pts.push({ x: left, y })

    const period = 1500 // one lap of the chase
    pts.forEach((p, i) => {
      const bulb = this.add.image(p.x, p.y, 'bulb').setDisplaySize(13, 13).setDepth(2)
      bulb.setTint(i % 2 === 0 ? 0xff5a6a : 0xffd75e) // reddish / gold
      bulb.setAlpha(0.4)
      this.tweens.add({
        targets: bulb,
        alpha: 1,
        duration: period / 2,
        yoyo: true,
        repeat: -1,
        delay: (i / pts.length) * period,
        ease: 'Sine.easeInOut',
      })
      this.cabinetBulbs.push(bulb)
    })
  }

  /** Quick light flash on the cabinet — bulbs pop + reddish glow surges. For mega-wins / wins. */
  private flashCabinet(): void {
    for (const bulb of this.cabinetBulbs) {
      const base = bulb.scaleX
      this.tweens.add({ targets: bulb, scaleX: base * 1.7, scaleY: base * 1.7, duration: 140, yoyo: true, ease: 'Quad.easeOut' })
    }
    if (this.cabinetGlow) {
      this.tweens.add({ targets: this.cabinetGlow, alpha: 0.42, duration: 160, yoyo: true, repeat: 1, ease: 'Quad.easeOut' })
    }
  }

  /** A modest spray of chips + cards bursting from the board — the casino "panel" win touch. */
  private burstTokens(count = 10): void {
    const cx = BOARD_X + BOARD_W / 2
    const cy = BOARD_Y + BOARD_W / 2
    for (let i = 0; i < count; i++) {
      const key = i % 2 === 0 ? 'chip' : 'card'
      const token = this.add
        .image(cx + (Math.random() * 2 - 1) * 110, cy + (Math.random() * 2 - 1) * 110, key)
        .setDepth(24)
        .setScale(0)
      const ang = Math.random() * Math.PI * 2
      const dist = 150 + Math.random() * 170
      this.tweens.add({
        targets: token,
        x: cx + Math.cos(ang) * dist,
        y: cy + Math.sin(ang) * dist - 40,
        scale: 0.85,
        rotation: (Math.random() * 2 - 1) * 3,
        duration: 680,
        ease: 'Cubic.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: token, alpha: 0, y: token.y + 140, duration: 480, onComplete: () => token.destroy() }),
      })
    }
  }

  /** Full board win celebration: light flash + token burst (plays on the visible board pre-overlay). */
  private celebrateBoard(): void {
    this.flashCabinet()
    this.burstTokens()
  }

  private buildHud(): void {
    // Top row: back · LEVEL N (or ENDLESS) · score.
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => this.exitToLevels())
    addPillButton(
      this,
      DESIGN_W / 2,
      84,
      this.endless ? 240 : 220,
      56,
      this.endless ? 'ENDLESS' : `LEVEL ${this.level}`,
      this.endless ? ROSE_PILL : GOLD_PILL,
      () => {}
    )
    this.add
      .text(BOARD_X + BOARD_W, 62, 'SCORE', { fontFamily: FONT, fontSize: '18px', color: '#8a8577' })
      .setOrigin(1, 0)
      .setLetterSpacing(3)
    this.scoreText = this.add
      .text(BOARD_X + BOARD_W, 84, '0', { fontFamily: FONT, fontSize: '34px', color: '#2a2732', fontStyle: 'bold' })
      .setOrigin(1, 0)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
    // Mute chip nudged to y=34 (from 40) so its lower arc clears the SCORE label.
    addMuteChip(this, 676, 34)

    // Persistent chip balance — compact, tucked into the top row's gap between the back button
    // and the LEVEL tab. Shows the pre-win total; the win payout flies a chip in to bump it.
    this.chipHud = addChipPill(this, 182, 84, { compact: true })

    // Second row: moves card + objective chips.
    const cardY = 196
    const g = this.add.graphics()
    g.fillStyle(0x8a7a52, 0.12)
    g.fillRoundedRect(BOARD_X + 2, cardY - 52 + 5, 170, 104, 20)
    g.fillStyle(0xffffff, 1)
    g.fillRoundedRect(BOARD_X, cardY - 52, 170, 104, 20)
    g.lineStyle(2, 0xe8dfc9, 1)
    g.strokeRoundedRect(BOARD_X, cardY - 52, 170, 104, 20)
    this.add
      .text(BOARD_X + 85, cardY - 28, 'MOVES', { fontFamily: FONT, fontSize: '18px', color: '#8a8577' })
      .setOrigin(0.5)
      .setLetterSpacing(3)
    this.movesText = this.add
      .text(BOARD_X + 85, cardY + 12, String(this.movesLeft), {
        fontFamily: FONT,
        fontSize: '48px',
        fontStyle: '900',
        color: '#2a2732',
      })
      .setOrigin(0.5)

    if (this.endless) {
      // No objectives in endless — show this week's target (BEST to beat) instead.
      const cardW = 290
      const bx = BOARD_X + BOARD_W - cardW
      g.fillStyle(0x8a7a52, 0.12)
      g.fillRoundedRect(bx + 2, cardY - 52 + 5, cardW, 104, 20)
      g.fillStyle(0xfffdf8, 1)
      g.fillRoundedRect(bx, cardY - 52, cardW, 104, 20)
      g.lineStyle(2, 0xf2c14e, 0.9)
      g.strokeRoundedRect(bx, cardY - 52, cardW, 104, 20)
      this.add
        .text(bx + cardW / 2, cardY - 28, "WEEK'S BEST", { fontFamily: FONT, fontSize: '18px', color: '#8a8577' })
        .setOrigin(0.5)
        .setLetterSpacing(2)
      this.add
        .text(bx + cardW / 2, cardY + 12, this.endlessBest > 0 ? this.endlessBest.toLocaleString() : '—', {
          fontFamily: FONT,
          fontSize: '40px',
          fontStyle: '900',
          color: '#c9930a',
        })
        .setOrigin(0.5)
    } else {
      const chipW = 118
      const chipGap = 12
      const n = this.objectives.length
      // A "COLLECT" tag over the objective cluster — names the chips unmistakably as TARGETS.
      const clusterCx = BOARD_X + BOARD_W - chipW / 2 - ((n - 1) * (chipW + chipGap)) / 2
      this.add
        .text(clusterCx, cardY - 70, 'COLLECT', { fontFamily: FONT, fontSize: '18px', fontStyle: '900', color: '#c9930a' })
        .setOrigin(0.5)
        .setLetterSpacing(4)
        .setShadow(0, 2, 'rgba(90,70,20,0.18)', 3, false, true)
      this.objectives.forEach((o, i) => {
        const cx = BOARD_X + BOARD_W - chipW / 2 - (n - 1 - i) * (chipW + chipGap)
        const chip = this.add.container(cx, cardY)
        // Soft gold halo bleeding out around the (opaque) chip — breathes to pull the eye to an
        // incomplete target. A separate object from the chip so it never touches chip.scale (the
        // decrement "pop" guards on chip.scale === 1). Static + fainter under reduced-motion.
        const glow = this.add
          .image(0, 0, 'bgglow')
          .setTint(0xf2b234)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(chipW + 56, 104 + 44)
          .setAlpha(this.reducedMotion ? 0.22 : 0.3)
        chip.add(glow)
        o.glow = glow
        if (!this.reducedMotion) {
          o.pulse = this.tweens.add({
            targets: glow,
            alpha: 0.52,
            scaleX: glow.scaleX * 1.06,
            scaleY: glow.scaleY * 1.06,
            duration: 1100,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          })
        }
        const cg = this.add.graphics()
        cg.fillStyle(0x8a7a52, 0.12)
        cg.fillRoundedRect(-chipW / 2 + 2, -52 + 5, chipW, 104, 20)
        cg.fillStyle(0xffffff, 1)
        cg.fillRoundedRect(-chipW / 2, -52, chipW, 104, 20)
        cg.lineStyle(2, 0xe8dfc9, 1)
        cg.strokeRoundedRect(-chipW / 2, -52, chipW, 104, 20)
        chip.add(cg)
        const icon = this.add.image(0, -20, o.symbol)
        icon.setDisplaySize(54, 54)
        chip.add(icon)
        o.text = this.add
          .text(0, 27, String(o.remaining), { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: '#2a2732' })
          .setOrigin(0.5)
        chip.add(o.text)
        o.chip = chip
      })
    }

    this.add
      .text(
        DESIGN_W / 2,
        988,
        this.endless ? "Biggest score wins this week's board" : 'Match the highlighted goal symbols before moves run out',
        { fontFamily: 'Arial, sans-serif', fontSize: '22px', color: '#9a927e' }
      )
      .setOrigin(0.5)
  }

  private buildPieceLayer(): void {
    const maskShape = this.make.graphics({ x: 0, y: 0 }, false)
    maskShape.fillStyle(0xffffff)
    maskShape.fillRect(BOARD_X - 4, BOARD_Y - 4, BOARD_W + 8, BOARD_W + 8)

    this.pieceLayer = this.add.container(0, 0)
    this.pieceLayer.setMask(maskShape.createGeometryMask())

    this.ring = this.add.sprite(0, 0, 'ring').setVisible(false)
    this.ring.setDisplaySize(CELL * 1.02, CELL * 1.02)
    this.pieceLayer.add(this.ring)

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const at = { row: r, col: c }
        this.createSprite(this.board.get(at)!, at)
      }
    }
  }

  private buildParticles(): void {
    const emitters = {} as Record<SymbolType, Phaser.GameObjects.Particles.ParticleEmitter>
    for (const symbol of SYMBOLS) {
      emitters[symbol] = this.add
        .particles(0, 0, symbol, {
          speed: { min: 90, max: 280 },
          angle: { min: 0, max: 360 },
          scale: { start: 0.3, end: 0.1 },
          alpha: { start: 1, end: 0 },
          lifespan: { min: 300, max: 600 },
          gravityY: 800,
          rotate: { min: -180, max: 180 },
          emitting: false,
        })
        .setDepth(20)
    }
    this.emitters = emitters
    this.sparkEmitter = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 60, max: 360 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.8, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 250, max: 500 },
        gravityY: 600,
        emitting: false,
      })
      .setDepth(21)
  }

  private createSprite(piece: Piece, at: Coord, dropCells = 0): Phaser.GameObjects.Sprite {
    const pos = this.cellToXY(at)
    const y = pos.y - dropCells * CELL
    const sprite = this.add.sprite(pos.x, y, ensurePieceTexture(this, piece))
    sprite.setDisplaySize(PIECE_SIZE, PIECE_SIZE)
    // Specials read as "armed" on the board via a soft additive halo that trails them (synced in
    // update). Added BEFORE the sprite so it sits behind it; keyed by id so it never stacks.
    if (piece.kind !== 'normal' && !this.armedGlows.has(piece.id)) {
      const glow = this.add
        .image(pos.x, y, 'bgglow')
        .setTint(0xf2b234)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(PIECE_SIZE * 1.25, PIECE_SIZE * 1.25)
        .setAlpha(this.reducedMotion ? 0.16 : 0.22)
      this.pieceLayer.add(glow)
      this.armedGlows.set(piece.id, glow)
    }
    // Goal-piece "collect me" tell: a soft cream halo on NORMAL pieces whose symbol is still a
    // needed objective (specials already glow gold — skip them so the two tells never stack).
    // Governor-gated (off at the low tier via count(1)), softened to a static faint halo under
    // reduced-motion; the shimmer + upkeep run in update(). Added behind the sprite.
    if (
      piece.kind === 'normal' &&
      !this.goalGlows.has(piece.id) &&
      quality.count(1) > 0 &&
      this.objectives.some(o => o.remaining > 0 && o.symbol === piece.symbol)
    ) {
      const halo = this.add
        .image(pos.x, y, 'bgglow')
        .setTint(0xfff6e8)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(PIECE_SIZE * 1.4, PIECE_SIZE * 1.4)
        .setAlpha(this.reducedMotion ? 0.14 : 0.18)
      halo.setData('sym', piece.symbol)
      this.pieceLayer.add(halo)
      this.goalGlows.set(piece.id, halo)
    }
    this.pieceLayer.add(sprite)
    this.sprites.set(piece.id, sprite)
    return sprite
  }

  /**
   * Per-frame sync for the "armed" halos: keep each glow under its special sprite and breathe its
   * alpha (shared sine so they pulse in step — cheap, no per-glow tween). When a special's sprite
   * is gone (cleared / transformed / reshuffled) its halo is destroyed, so nothing leaks.
   */
  update(time: number): void {
    // 3a shimmer yields to the game: it only glides while the board is settled (idle). Toggle
    // only on the idle edge so we're not restarting a tween every frame.
    if (this.boardShimmer && this.boardShimmerTween) {
      const idleNow = this.state === 'idle'
      if (idleNow !== this.shimmerOn) {
        this.shimmerOn = idleNow
        if (idleNow) {
          this.boardShimmer.setVisible(true)
          this.boardShimmerTween.restart()
        } else {
          this.boardShimmerTween.pause()
          this.boardShimmer.setVisible(false)
        }
      }
    }
    if (this.armedGlows.size > 0) {
      const a = 0.16 + 0.14 * (0.5 + 0.5 * Math.sin(time / 300))
      for (const [id, glow] of this.armedGlows) {
        const sprite = this.sprites.get(id)
        if (sprite && sprite.active) {
          glow.setPosition(sprite.x, sprite.y)
          if (!this.reducedMotion) glow.setAlpha(a)
        } else {
          glow.destroy()
          this.armedGlows.delete(id)
        }
      }
    }
    // Goal halos: keep each under its piece and shimmer its alpha. A per-piece phase (off the
    // stable id) desyncs them into a gentle TWINKLE across the board — visually apart from the
    // armed glow's in-step breathe — and it's lower/cooler so a goal never reads as "armed".
    if (this.goalGlows.size > 0) {
      const gt = time / 480
      for (const [id, glow] of this.goalGlows) {
        const sprite = this.sprites.get(id)
        if (sprite && sprite.active) {
          glow.setPosition(sprite.x, sprite.y)
          if (!this.reducedMotion) glow.setAlpha(0.09 + 0.12 * (0.5 + 0.5 * Math.sin(gt + (id % 13) * 0.5)))
        } else {
          glow.destroy()
          this.goalGlows.delete(id)
        }
      }
    }
  }

  // ----------------------------------------------------------------- input

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.state !== 'idle') return
    const cell = this.xyToCell(p.x, p.y)
    if (!cell) {
      this.clearSelection()
      this.dragFrom = null
      return
    }
    this.disarmHint() // the player is engaging the board — retire the nudge
    this.dragFrom = cell
    this.dragStartX = p.x
    this.dragStartY = p.y
    this.dragConsumed = false
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (this.state !== 'idle' || !this.dragFrom || this.dragConsumed) return
    const dx = p.x - this.dragStartX
    const dy = p.y - this.dragStartY
    if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return
    this.dragConsumed = true
    const from = this.dragFrom
    const target: Coord =
      Math.abs(dx) > Math.abs(dy)
        ? { row: from.row, col: from.col + Math.sign(dx) }
        : { row: from.row + Math.sign(dy), col: from.col }
    if (this.board.inBounds(target)) {
      this.clearSelection()
      void this.trySwap(from, target)
    }
  }

  private onUp(p: Phaser.Input.Pointer): void {
    void p
    if (this.state === 'idle' && this.dragFrom && !this.dragConsumed) {
      const cell = this.dragFrom
      if (this.selected && Board.areAdjacent(this.selected, cell)) {
        const from = this.selected
        this.clearSelection()
        void this.trySwap(from, cell)
      } else if (this.selected && this.selected.row === cell.row && this.selected.col === cell.col) {
        this.clearSelection()
      } else {
        this.select(cell)
      }
    }
    this.dragFrom = null
  }

  private select(at: Coord): void {
    this.clearSelection()
    this.selected = at
    const pos = this.cellToXY(at)
    this.ring.setPosition(pos.x, pos.y).setVisible(true)
    this.selectedSprite = this.sprites.get(this.board.get(at)!.id) ?? null
    if (this.selectedSprite) {
      this.selectPulse = this.tweens.add({
        targets: this.selectedSprite,
        scale: PIECE_SCALE * 1.12,
        duration: 240,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
  }

  private clearSelection(): void {
    this.selectPulse?.stop()
    this.selectPulse = null
    this.selectedSprite?.setScale(PIECE_SCALE)
    this.selectedSprite = null
    this.selected = null
    this.ring.setVisible(false)
  }

  // ------------------------------------------------------------ game flow

  private async trySwap(a: Coord, b: Coord): Promise<void> {
    const pa = this.board.get(a)
    const pb = this.board.get(b)
    if (!pa || !pb) return
    this.state = 'swapping'
    this.disarmHint() // idle effects yield to the move (§3d composition)
    sfx.swap()

    const sa = this.sprites.get(pa.id)!
    const sb = this.sprites.get(pb.id)!
    const posA = this.cellToXY(a)
    const posB = this.cellToXY(b)

    await Promise.all([
      this.t({ targets: sa, x: posB.x, y: posB.y, duration: SWAP_MS, ease: 'Quad.easeOut' }),
      this.t({ targets: sb, x: posA.x, y: posA.y, duration: SWAP_MS, ease: 'Quad.easeOut' }),
    ])
    this.board.swap(a, b)

    let wave = this.board.swapActivation(a, b)
    if (!wave) {
      if (this.board.findRuns().length === 0) {
        // Invalid: thud and snap back. No move spent.
        this.board.swap(a, b)
        sfx.invalidThud()
        this.cameras.main.shake(90, 0.005)
        await Promise.all([
          this.t({ targets: sa, x: posA.x, y: posA.y, duration: INVALID_MS, ease: 'Quad.easeIn' }),
          this.t({ targets: sb, x: posB.x, y: posB.y, duration: INVALID_MS, ease: 'Quad.easeIn' }),
        ])
        this.state = 'idle'
        this.scheduleAutoplay()
        this.armHint()
        return
      }
      wave = this.board.matchWave([b, a])
    }

    this.movesLeft--
    this.moveMade = true
    this.movesText.setText(String(this.movesLeft))
    if (this.movesLeft <= 5) this.movesText.setColor('#d3302f')
    // Getting tight — start a gentle looping pulse on the moves number (once, no stacking).
    if (this.movesLeft <= 3 && !this.movesPulse) {
      this.movesPulse = this.tweens.add({
        targets: this.movesText,
        scale: 1.08,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
    await this.resolveLoop(wave)
  }

  /** Play waves until the board settles, then check for win/lose. */
  private async resolveLoop(first: ClearWave | null): Promise<void> {
    this.state = 'resolving'
    let cascade = 0
    let wave = first
    while (wave) {
      cascade++
      this.dbgStage = `playWave c${cascade} cl=${wave.cleared.length} tr=${wave.transformed.length} ev=${wave.events.length}`
      this.log(this.dbgStage)
      await this.playWave(wave, cascade)
      const falls = this.board.applyGravity()
      const spawns = this.board.refill()
      this.dbgStage = `falls c${cascade} f=${falls.length} s=${spawns.length}`
      this.log(this.dbgStage)
      await this.animateFalls(falls, spawns)
      this.dbgStage = `matchWave c${cascade}`
      this.log(this.dbgStage)
      wave = this.board.matchWave()
    }
    this.dbgStage = 'end-checks'
    this.log('end-checks', 'objectivesDone', this.objectives.every(o => o.remaining <= 0), 'movesLeft', this.movesLeft)
    // Endless never "wins" on objectives (it has none) — it ends when moves run out.
    if (!this.endless && this.objectives.every(o => o.remaining <= 0)) {
      this.finishWin()
      return
    }
    if (this.movesLeft <= 0) {
      if (this.endless) this.finishEndless()
      else this.finishLose()
      return
    }
    if (!this.board.hasValidMove()) await this.reshuffle()
    this.state = 'idle'
    this.scheduleAutoplay()
    this.armHint()
  }

  private async playWave(wave: ClearWave, cascade: number): Promise<void> {
    const transformedKeys = new Set(wave.transformed.map(t => key(t.at)))
    const pops = wave.cleared.filter(c => !transformedKeys.has(key(c.at)))

    // Signature clear blip, once per wave — rises a semitone per cascade step.
    sfx.pop(cascade)

    // Effect choreography.
    let effectMs = 0
    for (const e of wave.events) {
      if (e.type === 'reel') {
        this.detonateReel(e.at, e.horizontal, cascade)
        effectMs = Math.max(effectMs, 320)
      } else if (e.type === 'bomb') {
        this.detonateBomb(e.at, e.radius, cascade)
        effectMs = Math.max(effectMs, 300)
      } else {
        sfx.jackpotStrike()
        this.cameras.main.flash(280, 255, 214, 90)
        this.cameras.main.shake(240, 0.008)
        effectMs = Math.max(effectMs, 320)
      }
    }

    // Scoring + objectives (specials count as their symbol; jackpot pieces don't).
    const changedObjectives = new Set<ObjectiveState>()
    for (const { piece } of wave.cleared) {
      if (piece.kind === 'jackpot') continue
      const obj = this.objectives.find(o => o.symbol === piece.symbol)
      if (obj && obj.remaining > 0) {
        obj.remaining--
        obj.text?.setText(obj.remaining > 0 ? String(obj.remaining) : '✓')
        if (obj.remaining === 0) obj.text?.setColor('#2fae4c')
        changedObjectives.add(obj)
      }
    }
    // Pop only the chip(s) whose count actually changed this wave, and flash the number gold.
    for (const o of changedObjectives) {
      if (o.chip && o.chip.scale === 1) {
        this.tweens.add({ targets: o.chip, scale: 1.14, duration: 120, yoyo: true, ease: 'Quad.easeOut' })
      }
      // Gold flash — but leave a completed objective its green ✓.
      if (o.text && o.remaining > 0) {
        o.text.setColor('#f2b234')
        this.time.delayedCall(160, () => o.remaining > 0 && o.text?.setColor('#2a2732'))
      }
      // Done: retire the "target" emphasis (green ✓ already set above stays) + punch the beat.
      if (o.remaining === 0) {
        this.onObjectiveComplete(o)
        this.objectiveStamp(o)
      }
    }
    const wavePoints = wave.cleared.length * POINTS_PER_PIECE * cascade
    this.addScore(wavePoints)
    if (cascade >= 2) {
      this.showCombo(cascade)
      this.cameras.main.shake(100 + cascade * 30, 0.002 + 0.0012 * Math.min(cascade, 5))
    }

    // Pop cleared sprites, staggered outward from the first effect's epicenter.
    const epicenter = wave.events[0]?.at ?? pops[0]?.at
    // One floating "+N" per wave at the clear epicenter — bigger on chunky cascades.
    if (epicenter) {
      const ep = this.cellToXY(epicenter)
      this.spawnScorePopup(wavePoints, ep.x, ep.y, cascade)
    }
    const promises: Promise<void>[] = []
    for (const { piece, at } of pops) {
      const sprite = this.sprites.get(piece.id)
      if (!sprite) continue
      this.sprites.delete(piece.id)
      const delay = epicenter ? (Math.abs(at.row - epicenter.row) + Math.abs(at.col - epicenter.col)) * 16 : 0
      const pos = this.cellToXY(at)
      this.time.delayedCall(delay, () => {
        this.emitters[piece.symbol]?.explode(6, pos.x, pos.y)
        this.sparkEmitter.explode(4, pos.x, pos.y)
        // Subtle gloss pop — the emptied tile catches light on the clear. Reuses bgglow (ADD,
        // below the emitters), governor-gated for alpha/count, skipped under reduced-motion.
        if (!this.reducedMotion && quality.count(1) > 0) {
          const glow = this.add
            .image(pos.x, pos.y, 'bgglow')
            .setTint(0xffedc2)
            .setBlendMode(Phaser.BlendModes.ADD)
            .setDepth(19)
            .setDisplaySize(CELL * 0.72, CELL * 0.72)
            .setAlpha(0.5 * quality.scale())
          this.tweens.add({
            targets: glow,
            alpha: 0,
            scaleX: glow.scaleX * 1.8,
            scaleY: glow.scaleY * 1.8,
            duration: 190,
            ease: 'Quad.easeOut',
            onComplete: () => glow.destroy(),
          })
        }
      })
      promises.push(
        this.t({
          targets: sprite,
          scale: sprite.scale * 1.4,
          alpha: 0,
          delay,
          duration: CLEAR_MS,
          ease: 'Quad.easeOut',
        }).then(() => sprite.destroy())
      )
    }

    // Morph matched pieces into their earned specials.
    let births = 0
    for (const t of wave.transformed) {
      const old = this.sprites.get(t.from.id)
      if (old) {
        this.sprites.delete(t.from.id)
        old.destroy()
      }
      const sprite = this.createSprite(t.to, t.at)
      sprite.setScale(0)
      promises.push(
        this.t({ targets: sprite, scale: PIECE_SCALE, delay: 80, duration: 200, ease: 'Back.easeOut' })
      )
      // 3e: a quick gold ring implosion + spark celebrates the birth (cap ≤2/wave).
      if (births < 2) {
        this.specialBirth(t.at)
        births++
      }
    }

    promises.push(new Promise(resolve => this.time.delayedCall(effectMs, () => resolve())))
    await Promise.all(promises)
  }

  /** Tone particle counts down under prefers-reduced-motion (kept ≥1 so the beat still lands). */
  private motionCount(n: number): number {
    return this.reducedMotion ? Math.max(1, Math.ceil(n * 0.4)) : Math.round(n)
  }

  /**
   * Wild-reel line clear as a MISSILE strike: a fireball head streaks out of the epicenter to each
   * end of the row/col trailing sparks, and the whole line ignites in a fire streak. Faster/thicker
   * on higher cascades. Trails cap ~11 sparks each; total ≲30 for the event.
   */
  private detonateReel(atCoord: Coord, horizontal: boolean, cascade: number): void {
    sfx.reelSweep()
    const at = this.cellToXY(atCoord)
    const boost = Math.min(cascade - 1, 4)

    // The line ignites — a warm fire streak flashing across the whole row/col.
    const sweep = this.add
      .image(horizontal ? BOARD_X + BOARD_W / 2 : at.x, horizontal ? at.y : BOARD_Y + BOARD_W / 2, 'sweep')
      .setDepth(25)
      .setBlendMode(Phaser.BlendModes.ADD)
    sweep.setDisplaySize(BOARD_W + 24, CELL * (0.72 + boost * 0.05))
    if (!horizontal) sweep.setAngle(90)
    sweep.setAlpha(0)
    this.tweens.add({
      targets: sweep,
      alpha: { from: 0, to: 1 },
      scaleY: sweep.scaleY * 1.3,
      duration: 90,
      yoyo: true,
      hold: 120,
      onComplete: () => sweep.destroy(),
    })

    // Missile heads streak out to each end of the line, trailing sparks.
    const dur = 240 - boost * 26
    const dirs: Array<[number, number]> = horizontal ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]]
    for (const [dx, dy] of dirs) {
      const endX = horizontal ? (dx < 0 ? BOARD_X - 12 : BOARD_X + BOARD_W + 12) : at.x
      const endY = horizontal ? at.y : dy < 0 ? BOARD_Y - 12 : BOARD_Y + BOARD_W + 12
      const missile = this.add
        .image(at.x, at.y, 'fireball')
        .setDepth(27)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.85 + boost * 0.08)
      const trail = this.add
        .particles(0, 0, 'spark', {
          speed: { min: 20, max: 130 },
          scale: { start: 0.6, end: 0 },
          alpha: { start: 0.9, end: 0 },
          lifespan: { min: 160, max: 320 },
          gravityY: 140,
          tint: [0xf2b234, 0xffd75e],
          quantity: 1,
          frequency: this.reducedMotion ? 44 : 22,
          emitting: true,
        })
        .setDepth(26)
      trail.startFollow(missile)
      this.tweens.add({
        targets: missile,
        x: endX,
        y: endY,
        duration: dur,
        ease: 'Sine.easeIn',
        onComplete: () => {
          trail.stop()
          trail.stopFollow()
          missile.destroy()
          this.time.delayedCall(340, () => trail.destroy())
        },
      })
    }
  }

  /**
   * Dice-bomb cell blast as a real EXPLOSION: a white-hot flash core, a fireball bloom, an expanding
   * shockwave ring and a capped fire/debris burst — all scaled by the blast radius + cascade, with
   * a camera punch that hits harder on bigger combos. Particle budget ≤30 (spark ≤20 + fire ≤10).
   */
  private detonateBomb(atCoord: Coord, radius: number, cascade: number): void {
    sfx.bombBoom()
    this.vibrate(30 + Math.min(radius, 3) * 12)
    const at = this.cellToXY(atCoord)
    const boost = Math.min(cascade - 1, 4)
    const power = radius + boost * 0.4

    // Camera punch — bigger blasts / combos hit harder.
    this.cameras.main.shake(150 + radius * 70 + boost * 25, 0.007 + radius * 0.0045 + boost * 0.001)

    // White-hot flash core.
    const flash = this.add
      .image(at.x, at.y, 'bgglow')
      .setTint(0xfff6d9)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(28)
      .setAlpha(0.9)
      .setDisplaySize(CELL * 1.2, CELL * 1.2)
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scaleX: flash.scaleX * (2.2 + power * 0.4),
      scaleY: flash.scaleY * (2.2 + power * 0.4),
      duration: 220,
      ease: 'Quad.easeOut',
      onComplete: () => flash.destroy(),
    })

    // Fireball bloom.
    const ball = this.add
      .image(at.x, at.y, 'fireball')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(27)
      .setScale(0.5)
      .setAlpha(1)
    this.tweens.add({
      targets: ball,
      alpha: 0,
      scaleX: 1.6 + power * 0.6,
      scaleY: 1.6 + power * 0.6,
      duration: 380,
      ease: 'Quad.easeOut',
      onComplete: () => ball.destroy(),
    })

    // Expanding shockwave ring.
    const ring = this.add
      .image(at.x, at.y, 'shockwave')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(26)
      .setAlpha(0.9)
      .setDisplaySize(CELL, CELL)
    this.tweens.add({
      targets: ring,
      alpha: 0,
      scaleX: ring.scaleX * (3.2 + power * 0.6),
      scaleY: ring.scaleY * (3.2 + power * 0.6),
      duration: 440,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    })

    // Debris sparks + fiery chunks (capped, one-shot self-destructing emitter).
    this.sparkEmitter.explode(this.motionCount(Math.min(20, 8 + radius * 4 + boost)), at.x, at.y)
    const fire = this.add
      .particles(0, 0, 'fireball', {
        speed: { min: 90, max: 240 + radius * 40 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 300, max: 560 },
        gravityY: 380,
        tint: [0xf2b234, 0xffcf6a, 0xd3304f],
        emitting: false,
      })
      .setDepth(27)
    fire.explode(this.motionCount(Math.min(10, 5 + radius * 2)), at.x, at.y)
    this.time.delayedCall(680, () => fire.destroy())
  }

  private animateFalls(falls: FallMove[], spawns: Spawn[]): Promise<void[]> {
    const tweens: Promise<void>[] = []
    for (const move of falls) {
      const sprite = this.sprites.get(move.piece.id)
      if (!sprite) {
        this.log('fall MISSING sprite', move.piece.id)
        continue
      }
      const to = this.cellToXY(move.to)
      const dist = move.to.row - move.from.row
      tweens.push(
        this.t({
          targets: sprite,
          y: to.y,
          duration: FALL_BASE_MS + FALL_PER_CELL_MS * dist,
          ease: 'Back.easeOut',
        })
      )
    }
    for (const spawn of spawns) {
      const sprite = this.createSprite(spawn.piece, spawn.at, spawn.dropCells)
      const to = this.cellToXY(spawn.at)
      tweens.push(
        this.t({
          targets: sprite,
          y: to.y,
          duration: FALL_BASE_MS + FALL_PER_CELL_MS * spawn.dropCells,
          ease: 'Back.easeOut',
        })
      )
    }
    return Promise.all(tweens)
  }

  private async reshuffle(): Promise<void> {
    this.state = 'shuffling'
    sfx.reshuffleSwirl()
    const toast = this.add
      .text(DESIGN_W / 2, BOARD_Y + BOARD_W / 2, 'NO MOVES — RESHUFFLING', {
        fontFamily: FONT,
        fontSize: '36px',
        color: '#2a2732',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(30)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(0,0,0,0.18)', 6, true, true)

    await this.t({ targets: this.pieceLayer, alpha: 0, duration: 220 })
    for (const sprite of this.sprites.values()) sprite.destroy()
    this.sprites.clear()
    this.board.regenerate()
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const at = { row: r, col: c }
        this.createSprite(this.board.get(at)!, at)
      }
    }
    await this.t({ targets: this.pieceLayer, alpha: 1, duration: 220 })
    this.time.delayedCall(500, () => toast.destroy())
  }

  // -------------------------------------------------------------- endings

  private finishWin(): void {
    this.log('finishWin')
    this.state = 'ended'
    this.stopMovesPulse()
    this.celebrateBoard() // Beat 0: casino light flash + chip/card burst on the still-visible board
    this.vibrate(60)
    const movesFrac = this.movesLeft / this.spec.moves
    const stars = movesFrac >= 0.5 ? 3 : movesFrac >= 0.25 ? 2 : 1
    const bonus = this.movesLeft * MOVES_BONUS
    if (bonus > 0) this.addScore(bonus)
    const save = recordResult(this.level, stars, this.score)
    // Reward payout — rewards a clean, fast clear and is BANKED to the persistent chip balance.
    // Once per win (finishWin runs exactly once per completed level); endless/losses pay nothing.
    const chipReward = stars * 8 + this.movesLeft * 2
    this.chipBanked = addChips(chipReward)
    // Every 10th level is a milestone: a full-screen star-tally splash stands in for Beats 1–2.
    const milestone = this.level % 10 === 0
    const totalStars = Object.values(save.stars).reduce((sum, s) => sum + s, 0)
    if (milestone) {
      // The splash already fired the fanfare + heart shower — the card stays calm (celebrate=false)
      // but still runs Beat 4 (elastic entrance + coin roll-up), tap-to-settle.
      this.time.delayedCall(420, () =>
        this.milestoneSplash(totalStars, () => {
          this.showOverlay(true, stars, bonus, chipReward, false, true)
          this.input.once('pointerdown', () => this.overlaySettle?.())
        })
      )
    } else {
      this.runWinSequence(stars, bonus, chipReward)
    }
  }

  private prefersReducedMotion(): boolean {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  }

  /**
   * Orchestrates the video-inspired win celebration (Beats 1–4) over the still-visible board,
   * then hands off to the animated result card. The whole thing is TAP-TO-SKIP: the first
   * pointerdown cancels the pending beats and jumps straight to the settled card. Reduced-motion
   * keeps the bloom + card + roll-up but drops the fireworks/confetti.
   */
  private runWinSequence(stars: number, bonus: number, chipReward: number): void {
    const reduced = this.prefersReducedMotion()
    const timers: Phaser.Time.TimerEvent[] = []
    const transient: Phaser.GameObjects.GameObject[] = []
    let cardShown = false
    let skipped = false
    let fanfarePlayed = false

    const at = (ms: number, cb: () => void): void => {
      timers.push(this.time.delayedCall(ms, cb))
    }
    const track = <T extends Phaser.GameObjects.GameObject>(o: T): T => {
      transient.push(o)
      return o
    }
    const showCard = (animate: boolean): void => {
      cardShown = true
      this.showOverlay(true, stars, bonus, chipReward, false, animate)
    }

    const skip = (): void => {
      if (skipped) return
      skipped = true
      for (const t of timers) t.remove(false)
      for (const o of transient) if (o.active) o.destroy()
      if (!fanfarePlayed) sfx.winFanfare()
      if (!cardShown) showCard(false)
      else this.overlaySettle?.()
    }
    this.input.once('pointerdown', skip)

    // BEAT 1 — screen lights up (warm bloom + cream camera flash).
    at(120, () => {
      const bloom = track(
        this.add
          .image(360, 620, 'bgglow')
          .setTint(0xffe9b0)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(38)
          .setAlpha(0)
          .setScale(14)
      )
      this.tweens.add({
        targets: bloom,
        alpha: 0.55,
        duration: 120,
        ease: 'Quad.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: bloom, alpha: 0, duration: 460, ease: 'Quad.easeIn', onComplete: () => bloom.destroy() }),
      })
      this.cameras.main.flash(200, 255, 249, 235)
      sfx.reelSweep()
      if (stars >= 3) sfx.jackpotStrike()
    })

    // BEAT 2 — rank-word wordmark punch (fires the single winFanfare).
    at(200, () => {
      fanfarePlayed = true
      sfx.winFanfare()
      this.winWordmark(stars, track, at)
    })

    // BEAT 3 — fireworks + confetti + a brand heart puff (skipped under reduced-motion).
    if (!reduced) at(350, () => this.winFireworks(track, at))

    // BEAT 4 — the result card enters (elastic scale-in) + coin roll-up payout.
    at(1100, () => showCard(true))
  }

  /** Beat 2: a gold-bezel lozenge stamping the rank word (NICE/GREAT/PERFECT) over the board. */
  private winWordmark(stars: number, track: <T extends Phaser.GameObjects.GameObject>(o: T) => T, at: (ms: number, cb: () => void) => void): void {
    const cx = 360
    const cy = 470
    const word = this.rankWord(stars)
    const layer = track(this.add.container(cx, cy).setDepth(46))

    // Slow-spinning gold ray behind the lozenge.
    const ray = this.add.image(0, 0, 'sweep').setDisplaySize(560, 96).setAlpha(0.4).setBlendMode(Phaser.BlendModes.ADD)
    this.tweens.add({ targets: ray, angle: 360, duration: 2500, repeat: -1, ease: 'Linear' })

    const text = this.add
      .text(0, 0, word, { fontFamily: FONT, fontSize: '66px', fontStyle: '900', color: '#26304d' })
      .setOrigin(0.5)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(90,70,20,0.22)', 6, true, true)
    const w = text.width + 104
    const h = 130
    const g = this.add.graphics()
    g.fillStyle(0x8a7a52, 0.28)
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 8, w, h, h / 2)
    g.fillStyle(0xf2b234, 1)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.fillStyle(0xfffdf8, 1)
    g.fillRoundedRect(-w / 2 + 13, -h / 2 + 13, w - 26, h - 26, (h - 26) / 2)
    g.lineStyle(5, 0xc9930a, 1)
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    layer.add([ray, g, text])

    layer.setScale(0).setAngle(-6)
    // Back.easeOut overshoots ~1.1 then settles to 1 — the elastic punch, with a -6°→0° tilt.
    this.tweens.add({ targets: layer, scale: 1, angle: 0, duration: 340, ease: 'Back.easeOut' })

    // Hold, then fade up 40px as the card enters.
    at(940, () => {
      if (!layer.active) return
      this.tweens.add({
        targets: layer,
        alpha: 0,
        y: cy - 40,
        duration: 300,
        ease: 'Sine.easeIn',
        onComplete: () => layer.destroy(),
      })
    })
  }

  /** Beat 3: three staggered spark bursts + a capped confetti rain + a brand heart puff. */
  private winFireworks(track: <T extends Phaser.GameObjects.GameObject>(o: T) => T, at: (ms: number, cb: () => void) => void): void {
    const shots: Array<[number, number, number]> = [
      [200, 360, 0xd3304f],
      [540, 300, 0x26304d],
      [360, 240, 0xf2b234],
    ]
    shots.forEach(([x, y, tint], i) => {
      at(i * 260, () => {
        const fw = track(
          this.add
            .particles(0, 0, 'spark', {
              speed: { min: 200, max: 520 },
              angle: { min: 0, max: 360 },
              scale: { start: 0.5, end: 0 },
              alpha: { start: 0.95, end: 0 },
              lifespan: { min: 700, max: 1100 },
              gravityY: 120,
              tint,
              emitting: false,
            })
            .setDepth(44)
        )
        fw.explode(24, x, y)
        at(1600, () => {
          if (fw.active) fw.destroy()
        })
      })
    })

    // Confetti rain from a top line — capped to ~40 live squares (10 emits × 4).
    const confetti = track(
      this.add
        .particles(0, 0, 'confetti', {
          x: { min: 60, max: 660 },
          y: 120,
          speed: { min: 40, max: 130 },
          angle: { min: 80, max: 100 },
          gravityY: 220,
          rotate: { min: -180, max: 180 },
          lifespan: 1400,
          tint: [0xf2b234, 0xd3304f, 0x26304d, 0xfffdf8],
          quantity: 4,
          frequency: 60,
          emitting: true,
        })
        .setDepth(43)
    )
    at(600, () => {
      if (confetti.active) confetti.stop()
    })
    at(2200, () => {
      if (confetti.active) confetti.destroy()
    })

    // A small heart puff for brand warmth.
    this.overlayHearts(360, 14, 300)
  }

  private rankWord(stars: number): string {
    return stars >= 3 ? 'PERFECT!' : stars === 2 ? 'GREAT!' : 'NICE!'
  }

  private finishLose(): void {
    this.log('finishLose')
    this.state = 'ended'
    this.stopMovesPulse()
    spendLife() // a loss costs a life (numbered levels only ever reach finishLose)
    recordScore(this.score)
    this.time.delayedCall(400, () => this.showOverlay(false, 0, 0))
  }

  private finishEndless(): void {
    this.log('finishEndless')
    this.state = 'ended'
    this.stopMovesPulse()
    const { best, isRecord } = recordEndless(this.score, this.endlessWeekKey)
    this.time.delayedCall(450, () => this.showEndlessOverlay(this.score, best, isRecord))
  }

  /**
   * A star-milestone celebration (levels 10/20/30…): a big "LEVEL N · ★ totalStars"
   * flourish with a heart shower over the board, then hands off to the result card.
   */
  private milestoneSplash(totalStars: number, done: () => void): void {
    sfx.winFanfare()
    this.time.delayedCall(180, () => sfx.jackpotStrike())
    this.vibrate([80, 50, 120])
    const cx = DESIGN_W / 2
    const cy = 560
    this.overlayHearts(cx, 30, cy - 60)
    const layer = this.add.container(0, 0).setDepth(48)
    const big = this.add
      .text(cx, cy - 44, `LEVEL ${this.level}!`, {
        fontFamily: FONT,
        fontSize: '76px',
        fontStyle: '900',
        color: '#c9930a',
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 10)
      .setShadow(0, 4, 'rgba(0,0,0,0.22)', 10, true, true)
      .setScale(0)
    const sub = this.add
      .text(cx, cy + 60, `★  ${totalStars} STARS EARNED  ★`, {
        fontFamily: FONT,
        fontSize: '38px',
        fontStyle: '900',
        color: '#d3304f',
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 8)
      .setAlpha(0)
    layer.add([big, sub])
    this.tweens.add({ targets: big, scale: 1, duration: 360, ease: 'Back.easeOut' })
    // Genuine slide-up (from cy+60 to cy+42) as it fades in.
    this.tweens.add({ targets: sub, alpha: 1, y: cy + 42, duration: 300, delay: 240, ease: 'Sine.easeOut' })
    this.time.delayedCall(1550, () =>
      this.tweens.add({
        targets: layer,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          layer.destroy()
          done()
        },
      })
    )
  }

  /** Dim scrim behind an end-of-round overlay (also swallows taps meant for the board). */
  private overlayScrim(): void {
    this.clearSelection()
    this.add.rectangle(DESIGN_W / 2, 640, DESIGN_W, 1280, 0x2a2417, 0.5).setDepth(40).setInteractive()
  }

  /** Shared rounded result card, centered at (cx, cy) with half-height halfH. */
  private overlayCard(cx: number, cy: number, halfH: number): void {
    const g = this.add.graphics().setDepth(41)
    g.fillStyle(0x8a7a52, 0.25)
    g.fillRoundedRect(cx - 260 + 4, cy - halfH + 8, 520, halfH * 2, 34)
    g.fillStyle(0xfffdf8, 1)
    g.fillRoundedRect(cx - 260, cy - halfH, 520, halfH * 2, 34)
    g.lineStyle(4, 0xf2c14e, 1)
    g.strokeRoundedRect(cx - 260, cy - halfH, 520, halfH * 2, 34)
  }

  /** Maya's touch: a shower of hearts bursting from (x, y). */
  private overlayHearts(x: number, count: number, y = 400): void {
    const hearts = this.add
      .particles(0, 0, 'heart', {
        speed: { min: 140, max: 420 },
        angle: { min: 220, max: 320 },
        scale: { start: 0.55, end: 0.15 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 700, max: 1300 },
        gravityY: 500,
        rotate: { min: -120, max: 120 },
        emitting: false,
      })
      .setDepth(45)
    hearts.explode(count, x, y)
    this.time.delayedCall(1600, () => hearts.destroy())
  }

  private showOverlay(win: boolean, stars: number, bonus: number, chipReward = 0, celebrate = true, animate = true): void {
    this.log('showOverlay', win ? 'win' : 'lose', 'stars', stars, 'bonus', bonus, 'reward', chipReward)
    this.overlaySettle = null
    this.overlayScrim()

    if (win) {
      // celebrate=false when a milestone splash / win sequence already fired the fanfare.
      if (celebrate) {
        sfx.winFanfare()
        this.vibrate(80)
        this.overlayHearts(DESIGN_W / 2, 26)
      }
      this.buildWinCard(stars, bonus, chipReward, animate)
      return
    }

    sfx.loseWah()
    const cx = DESIGN_W / 2
    const cy = 590
    this.overlayCard(cx, cy, 230)

    this.add
      .text(cx, cy - 160, 'OUT OF MOVES', { fontFamily: FONT, fontSize: '48px', fontStyle: '900', color: '#d3302f' })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)

    const goals = this.objectives.map(o => `${o.remaining > 0 ? o.remaining : '✓'}`).join('   ')
    this.add
      .text(cx, cy - 70, `Still needed:  ${goals}`, { fontFamily: FONT, fontSize: '26px', color: '#8a8577' })
      .setOrigin(0.5)
      .setDepth(42)

    this.add
      .text(cx, cy + 10, `SCORE  ${this.score.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: '#2a2732',
      })
      .setOrigin(0.5)
      .setDepth(42)

    // A loss spent a life — show what's left + when the next one lands.
    const livesHud = addLivesHud(this, cx, cy + 56, { size: 28 })
    livesHud.container.setDepth(42)
    const refresh = (): void => livesHud.update(refreshLives())
    refresh()
    this.time.addEvent({ delay: 1000, loop: true, callback: refresh })

    addPillButton(this, cx, cy + 140, 300, 72, 'RETRY', GOLD_PILL, () => startScene(this,'game', { level: this.level })).setDepth(42)
    addPillButton(this, cx, cy + 140 + 84, 300, 60, 'LEVELS', GHOST_PILL, () => startScene(this,'levelselect')).setDepth(42)
  }

  /**
   * Beat 4 — the win result card: an elastic scale-in entrance (0→1.06→1), the rank-word
   * title, a star row with ascending dings, and the COIN ROLL-UP PAYOUT (a chip pile on a gold
   * disc with chips flying in as a counter rolls 0→chipReward). Everything lives in one container
   * so the card can scale as a unit; `animate=false` builds it fully settled (tap-to-skip lands
   * here). Never occludes the reward number or the Continue button.
   */
  private buildWinCard(stars: number, bonus: number, chipReward: number, animate: boolean): void {
    const cx = DESIGN_W / 2
    const cy = 610
    const halfH = 300
    const w = 520
    const card = this.add.container(cx, cy).setDepth(41)

    const settleActions: Array<() => void> = []
    const settleTimers: Phaser.Time.TimerEvent[] = []
    const at = (ms: number, cb: () => void): void => {
      settleTimers.push(this.time.delayedCall(ms, cb))
    }

    // Card panel (cream + gold bezel).
    const g = this.add.graphics()
    g.fillStyle(0x8a7a52, 0.25)
    g.fillRoundedRect(-w / 2 + 4, -halfH + 8, w, halfH * 2, 34)
    g.fillStyle(0xfffdf8, 1)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    g.lineStyle(4, 0xf2b234, 1)
    g.strokeRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    card.add(g)

    // "LEVEL N" gold pill tab straddling the top edge.
    const tab = this.add.container(0, -halfH)
    const tabLabel = this.add
      .text(0, 0, `LEVEL ${this.level}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: '#4a3305' })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    const tw = tabLabel.width + 56
    const tg = this.add.graphics()
    tg.fillStyle(0xf2b234, 1)
    tg.fillRoundedRect(-tw / 2, -26, tw, 52, 26)
    tg.lineStyle(3, 0xc9930a, 1)
    tg.strokeRoundedRect(-tw / 2, -26, tw, 52, 26)
    tab.add([tg, tabLabel])
    card.add(tab)

    // Rank-word title.
    const title = this.add
      .text(0, -210, this.rankWord(stars), { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: '#c9930a' })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
    card.add(title)

    // Faint static gold ray behind the star row.
    const ray = this.add.image(0, -122, 'sweep').setDisplaySize(440, 96).setAlpha(0.22).setBlendMode(Phaser.BlendModes.ADD)
    card.add(ray)

    // Star row (earned stars pop in with ascending dings).
    for (let i = 0; i < 3; i++) {
      const earned = i < stars
      const star = this.add.image((i - 1) * 84, -122, 'star').setAlpha(earned ? 1 : 0.22)
      const finalScale = (earned ? 1 : 0.8) * (68 / 64)
      card.add(star)
      if (animate) {
        star.setScale(0)
        const delay = 150 + i * 160
        this.tweens.add({ targets: star, scale: finalScale, delay, duration: 260, ease: 'Back.easeOut' })
        if (earned) at(delay, () => sfx.starDing(i))
        settleActions.push(() => star.setScale(finalScale))
      } else {
        star.setScale(finalScale)
      }
    }

    // Score + optional moves bonus.
    card.add(
      this.add
        .text(0, -44, `SCORE  ${this.score.toLocaleString()}`, {
          fontFamily: FONT,
          fontSize: '34px',
          fontStyle: '900',
          color: '#26304d',
        })
        .setOrigin(0.5)
    )
    if (bonus > 0) {
      card.add(
        this.add.text(0, -6, `+${bonus.toLocaleString()} moves bonus`, { fontFamily: FONT, fontSize: '20px', color: '#c9930a' }).setOrigin(0.5)
      )
    }

    // COIN ROLL-UP PAYOUT.
    this.buildCoinPayout(card, chipReward, animate, at, settleActions)

    // Continue buttons.
    const nextExists = this.level < LEVEL_COUNT
    const nextBtn = addPillButton(this, 0, 176, 300, 72, nextExists ? 'NEXT LEVEL' : 'ALL CLEAR!', GOLD_PILL, () => {
      if (nextExists) startScene(this,'game', { level: this.level + 1 })
      else startScene(this,'levelselect', { fromWin: true })
    })
    // Beat 5: a soft gold glow-ring pulse behind the Continue pill to lead the eye.
    const glow = this.add.image(0, 176, 'bgglow').setTint(0xf2b234).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(360, 150).setAlpha(0.18)
    card.add(glow)
    this.tweens.add({ targets: glow, alpha: 0.42, duration: 780, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    card.add(nextBtn)
    card.add(addPillButton(this, 0, 176 + 84, 300, 60, 'LEVELS', GHOST_PILL, () => startScene(this,'levelselect', { fromWin: true })))

    // Rose skip/close chip (top-right) — a tap jumps straight to the settled card.
    if (animate) {
      const close = this.add.container(w / 2 - 40, -halfH + 40)
      const cg = this.add.graphics()
      cg.fillStyle(0xd3304f, 1)
      cg.fillCircle(0, 0, 22)
      cg.lineStyle(3, 0xa8213c, 1)
      cg.strokeCircle(0, 0, 22)
      const cIcon = this.add.text(0, 0, '»', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: '#ffffff' }).setOrigin(0.5)
      const cZone = this.add.circle(0, 0, 24, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
      cZone.on('pointerup', () => this.overlaySettle?.())
      close.add([cg, cIcon, cZone])
      card.add(close)
      settleActions.push(() => close.destroy())
    }

    // Entrance + settle wiring.
    if (animate) {
      card.setScale(0)
      const entrance = this.tweens.add({ targets: card, scale: 1, duration: 320, ease: 'Back.easeOut' })
      settleActions.push(() => {
        entrance.stop()
        card.setScale(1)
      })
      this.overlaySettle = () => {
        for (const t of settleTimers) t.remove(false)
        for (const a of settleActions) a()
        this.overlaySettle = null
      }
    }
  }

  /**
   * The coin payout: a chip pile on a soft gold disc with a counter that rolls 0→chipReward in
   * navy numerals. When animating, ~12 chips fly in from the edges/star row and land on the pile
   * as the counter rolls (scored by sfx.coinCount). Built relative to the card container.
   */
  private buildCoinPayout(
    card: Phaser.GameObjects.Container,
    chipReward: number,
    animate: boolean,
    at: (ms: number, cb: () => void) => void,
    settleActions: Array<() => void>
  ): void {
    const py = 74
    const pileX = -96

    // Soft gold disc behind the pile.
    card.add(this.add.image(pileX, py, 'bgglow').setTint(0xf2c14e).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(150, 150).setAlpha(0.5))

    // The resting pile (4–5 chips, slightly fanned).
    const pileOffsets: Array<[number, number]> = [
      [-16, 8],
      [14, 6],
      [-6, -4],
      [8, -12],
      [0, 0],
    ]
    const pileChips = pileOffsets.map(([dx, dy]) => {
      const chip = this.add.image(pileX + dx, py + dy, 'chip').setDisplaySize(46, 46)
      card.add(chip)
      if (animate) chip.setScale(0)
      return chip
    })
    const popPile = (idx: number): void => {
      const chip = pileChips[idx % pileChips.length]
      chip.setScale(46 / 48)
      this.tweens.add({ targets: chip, scale: (46 / 48) * 1.18, duration: 110, yoyo: true, ease: 'Quad.easeOut' })
    }
    settleActions.push(() => pileChips.forEach(c => c.setScale(46 / 48)))

    // Reward label + rolling counter (navy on cream — legible under the celebration).
    card.add(this.add.text(58, py - 34, 'REWARD', { fontFamily: FONT, fontSize: '18px', color: '#8a8577' }).setOrigin(0, 0.5).setLetterSpacing(2))
    const counter = this.add
      .text(58, py + 8, animate ? '0' : String(chipReward), { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: '#26304d' })
      .setOrigin(0, 0.5)
    card.add(counter)
    settleActions.push(() => counter.setText(String(chipReward)))

    if (!animate) {
      pileChips.forEach(c => c.setScale(46 / 48))
      this.chipHud?.update(this.chipBanked) // snap the HUD balance to the banked total (no fly-in)
      return
    }
    // A skip mid-roll still lands the balance on the HUD pill.
    settleActions.push(() => this.chipHud?.update(this.chipBanked))

    // Flying chips arc in from the edges/star row and land on the pile, popping it.
    const flyCount = 12
    for (let i = 0; i < flyCount; i++) {
      const fromX = (Math.random() * 2 - 1) * 230
      const fromY = -150 - Math.random() * 40
      const chip = this.add.image(fromX, fromY, 'chip').setDisplaySize(40, 40).setScale(0)
      card.add(chip)
      const delay = 360 + i * 40
      at(delay, () => {
        this.tweens.add({ targets: chip, scale: 40 / 48, duration: 120, ease: 'Quad.easeOut' })
        this.tweens.add({
          targets: chip,
          x: pileX + (Math.random() * 2 - 1) * 14,
          y: py + (Math.random() * 2 - 1) * 10,
          duration: 500 + Math.random() * 180,
          ease: 'Cubic.easeOut',
          onComplete: () => {
            popPile(i)
            chip.destroy()
          },
        })
      })
      settleActions.push(() => chip.destroy())
    }

    // Counter roll-up, scored by the coin tally, with a final haptic tick.
    at(440, () => {
      sfx.coinCount()
      const c = { v: 0 }
      const roll = this.tweens.add({
        targets: c,
        v: chipReward,
        duration: 780,
        ease: 'Cubic.easeOut',
        onUpdate: () => counter.setText(String(Math.round(c.v))),
        onComplete: () => {
          counter.setText(String(chipReward))
          this.vibrate(30)
          // The reward leaps from the pile up to the HUD balance pill, bumping its count.
          const flyer = this.spawnHudFlyChip(card.x + pileX, card.y + py)
          if (flyer) settleActions.push(() => flyer.destroy())
        },
      })
      settleActions.push(() => {
        roll.stop()
        counter.setText(String(chipReward))
      })
    })
  }

  /** Beat 4 tail: a chip flies from the win-card pile to the HUD balance pill, then bumps it. */
  private spawnHudFlyChip(fromX: number, fromY: number): Phaser.GameObjects.Image | undefined {
    if (!this.chipHud) return undefined
    const target = this.chipHud.container
    const chip = this.add.image(fromX, fromY, 'chip').setDisplaySize(46, 46).setDepth(52)
    this.tweens.add({
      targets: chip,
      x: target.x,
      y: target.y,
      scaleX: chip.scaleX * 0.62,
      scaleY: chip.scaleY * 0.62,
      duration: 520,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        if (chip.active) chip.destroy()
        this.chipHud?.update(this.chipBanked)
      },
    })
    return chip
  }

  /** End-of-run card for the endless weekly race — a score attack, no stars. */
  private showEndlessOverlay(score: number, best: number, isRecord: boolean): void {
    this.log('showEndlessOverlay', 'score', score, 'best', best, 'isRecord', isRecord)
    this.overlayScrim()
    const cx = DESIGN_W / 2
    const cy = 590
    if (isRecord) {
      sfx.winFanfare()
      sfx.jackpotStrike()
      this.vibrate([60, 40, 120])
      this.overlayHearts(cx, 28)
    } else {
      // "Time's up" is a finish line, not a failure — a gentle close, no lose-wah.
      sfx.starDing(0)
    }
    this.overlayCard(cx, cy, 230)

    this.add
      .text(cx, cy - 158, isRecord ? 'NEW BEST!' : "TIME'S UP", {
        fontFamily: FONT,
        fontSize: '48px',
        fontStyle: '900',
        color: isRecord ? '#c9930a' : '#26304d',
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)

    this.add
      .text(cx, cy - 92, 'YOUR SCORE', { fontFamily: FONT, fontSize: '20px', color: '#8a8577' })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(2)
    this.add
      .text(cx, cy - 44, score.toLocaleString(), {
        fontFamily: FONT,
        fontSize: '58px',
        fontStyle: '900',
        color: '#2a2732',
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)

    this.add
      .text(cx, cy + 34, "THIS WEEK'S BEST", { fontFamily: FONT, fontSize: '20px', color: '#8a8577' })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(2)
    this.add
      .text(cx, cy + 74, best.toLocaleString(), {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: '#c9930a',
      })
      .setOrigin(0.5)
      .setDepth(42)

    addPillButton(this, cx, cy + 140, 300, 72, 'PLAY AGAIN', ROSE_PILL, () =>
      startScene(this,'game', { endless: true })
    ).setDepth(42)
    addPillButton(this, cx, cy + 140 + 84, 300, 60, 'LEVELS', GHOST_PILL, () =>
      startScene(this,'levelselect')
    ).setDepth(42)
  }

  // -------------------------------------------------------------- scoring

  private addScore(points: number): void {
    const gain = points * this.scoreMult
    this.score += gain
    this.scoreTween?.stop()
    const counter = { v: this.shownScore }
    this.scoreTween = this.tweens.add({
      targets: counter,
      v: this.score,
      duration: 380,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        this.shownScore = Math.round(counter.v)
        this.scoreText.setText(this.shownScore.toLocaleString())
      },
    })
    this.scorePunch(gain)
  }

  /**
   * 3c: a scale punch + brief gold tint flash on the SCORE read-out for chunky gains (≥120 pts).
   * Only during a resolve (mutually exclusive with the idle nudge, and skips the finishWin bonus,
   * which runs in 'ended'). Reduced-motion: instant (no punch — the counter still rolls).
   */
  private scorePunch(gain: number): void {
    if (this.reducedMotion || gain < 120 || this.state !== 'resolving' || !this.scoreText) return
    this.scoreText.setColor('#f2b234')
    this.time.delayedCall(180, () => this.scoreText?.setColor('#2a2732'))
    this.scorePunchTween?.stop()
    this.scoreText.setScale(1)
    this.scorePunchTween = this.tweens.add({
      targets: this.scoreText,
      scale: 1.15,
      duration: 120,
      yoyo: true,
      ease: 'Quad.easeOut',
    })
  }

  private showCombo(cascade: number): void {
    const big = cascade >= 4
    if (big) {
      sfx.jackpotStrike()
      this.vibrate([60, 40, 120])
      this.flashCabinet() // mega-win: pop the marquee lights
    }
    const text = this.add
      .text(DESIGN_W / 2, BOARD_Y + BOARD_W / 2 - 40, big ? 'MEGA WIN!' : `COMBO x${cascade}`, {
        fontFamily: FONT,
        fontSize: big ? '72px' : '52px',
        color: big ? '#c9930a' : '#d3302f',
        fontStyle: '900',
      })
      .setOrigin(0.5)
      .setDepth(30)
      .setScale(0)
      .setStroke('#ffffff', 8)
      .setShadow(0, 4, 'rgba(0,0,0,0.2)', 8, true, true)
    this.tweens.add({
      targets: text,
      scale: big ? 1.25 : 1,
      duration: 240,
      ease: 'Back.easeOut',
      onComplete: () => {
        this.tweens.add({
          targets: text,
          alpha: 0,
          y: text.y - 70,
          duration: 500,
          delay: 260,
          onComplete: () => text.destroy(),
        })
      },
    })
  }

  // --------------------------------------------------------------- helpers

  /** Small gold, navy-outlined "+N" that floats up and fades, then self-destroys. One per wave. */
  private spawnScorePopup(points: number, x: number, y: number, cascade: number): void {
    if (points <= 0) return
    const big = cascade >= 3
    const t = this.add
      .text(x, y, `+${points}`, {
        fontFamily: FONT,
        fontSize: big ? '40px' : '32px',
        color: '#f2b234',
        fontStyle: '900',
      })
      .setOrigin(0.5)
      .setDepth(28)
      .setStroke('#26304d', 6)
      .setShadow(0, 2, 'rgba(0,0,0,0.18)', 4, false, true)
    this.tweens.add({
      targets: t,
      y: y - 40,
      alpha: { from: 1, to: 0 },
      duration: 600,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    })
  }

  /** Kill the urgent-moves pulse and settle the number back to rest scale (called when a level ends). */
  private stopMovesPulse(): void {
    this.movesPulse?.stop()
    this.movesPulse = null
    this.movesText?.setScale(1)
  }

  private t(config: Record<string, unknown>): Promise<void> {
    return new Promise(resolve => {
      this.tweens.add({ ...config, onComplete: () => resolve() } as unknown as Phaser.Types.Tweens.TweenBuilderConfig)
    })
  }

  /** Haptic buzz, guarded for browsers without the Vibration API. */
  private vibrate(pattern: number | number[]): void {
    if ('vibrate' in navigator) navigator.vibrate?.(pattern)
  }
}

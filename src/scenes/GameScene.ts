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
  restScrollY,
  worldH,
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
import { todayKey } from '../core/daily'
import { ENDLESS_MOVES, endlessBestForWeek, endlessRngForWeek, recordEndless, weekKey } from '../core/endless'
import { LEVEL_COUNT, levelSpec } from '../core/levels'
import { devSetLives, formatCountdown, refreshLives, spendLife } from '../core/lives'
import { maya, pendingOccasion, warmLoseLine, warmWinSubtitle } from '../core/maya'
import { mulberry32 } from '../core/rng'
import { addChips, bumpJackpotMeter, loadSave, markFinaleSeen, markOccasionSeen, persistSave, recordResult, recordScore, resetJackpotMeter, takePendingBoosts } from '../core/save'
import { jackpotReady } from '../core/jackpot'
import { SYMBOLS, key } from '../core/types'
import type { BoostType, ClearWave, Coord, FallMove, LevelSpec, Piece, Spawn, SymbolType } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { addJackpotMeter, openJackpotWheel } from '../view/jackpot'
import type { JackpotMeter } from '../view/jackpot'
import { heartbeat } from '../view/motion'
import { quality } from '../view/quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing as prefReduceFlashing } from '../view/theme'
import { TEX_SIZE, ensurePieceTexture } from '../view/textures'
import {
  FONT,
  GHOST_PILL,
  GOLD_PILL,
  ROSE_PILL,
  addChipPill,
  addLivesHud,
  addMuteChip,
  addPillButton,
  hcBoard,
  openOnboarding,
  startScene,
} from '../view/ui'
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
  /**
   * Displayed collect count driving `text`. Lags `remaining` so the E10 collect-fly can tick the
   * visible number DOWN only when a flyer lands (the model decrements synchronously for correct win
   * detection; the chip catches up on arrival). Kept in sync with `remaining` under reduced motion.
   */
  shown?: number
  text?: Phaser.GameObjects.Text
  chip?: Phaser.GameObjects.Container
  /** Soft gold halo behind the chip that breathes while this objective is INCOMPLETE. */
  glow?: Phaser.GameObjects.Image
  /** The breathe tween on `glow` — stopped when the objective completes. */
  pulse?: Phaser.Tweens.Tween
  /** C5 latch — the rising "almost there" tone fires at most once, when remaining first crosses low. */
  nearFired?: boolean
}

const PIECE_SCALE = PIECE_SIZE / TEX_SIZE
const DRAG_THRESHOLD = CELL * 0.3
/** C5 · remaining-count at/under which a collect objective rings its one "almost there" tone. */
const OBJECTIVE_NEAR = 1

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
  /** §E12 cached High-Contrast board flag — read once at create(); drives the darker floor + tints. */
  private hc = false
  /** §E12 thicker high-contrast selection ring (a stroked Graphics), built + used only when `hc`. */
  private hcRing?: Phaser.GameObjects.Graphics
  /** §E14 guard — true while the first-run onboarding card is up, so board taps are ignored under it. */
  private introOpen = false
  private cabinetBulbs: Phaser.GameObjects.Image[] = []
  private cabinetGlow?: Phaser.GameObjects.Image
  /** True while a win surge (flashCabinet) briefly owns cabinetGlow's alpha, so the heartbeat drive in update() yields (C1). */
  private cabinetSurge = false
  private state: GameState = 'idle'
  /** §E4 latch — a jackpot chip detonated this round, so the Heartbloom hero win fires even below 3-star. */
  private jackpotOccurred = false
  /** §E4 guard — the Heartbloom (giant heart of light + Maya leitmotif) fires at most ONCE per round. */
  private heartbloomFired = false
  /** §E9 — set in finishWin when this win's score beats the stored best; drives the NEW BEST! ribbon. */
  private newBestThisWin = false

  // --- Impact & weight (E5/E6) ---
  /** Trauma accumulator (0..1); shake magnitude is trauma², decayed each frame in update(). */
  private trauma = 0
  private traumaDirX = 0
  private traumaDirY = 0
  /** The single shared impact-frame sprite — CAPPED at one concurrent (photosensitivity red line). */
  private impactFlash?: Phaser.GameObjects.Image
  /** Wall-clock deadline of the active hitstop freeze; guards "one freeze at a time, deepest owns it." */
  private hitstopUntil = 0
  /** Tween/timer timescale to restore after a hitstop (1, or ?turbo=N in DEV). */
  private baseTimeScale = 1
  /** A11y "reduce flashing" switch (photosensitivity ≠ vestibular) — read from the real toggle in create(). */
  private reduceFlashing = false

  // --- P6 idle micro-life (all reduced-motion-gated, governor-capped) ---
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
  /**
   * B2 magnetic select telegraph — the ≤4 orthogonal neighbor sprites leaned ~3px toward the current
   * selection, paired with their EXACT grid-home positions so a restore is pixel-perfect. Both are
   * cleared by disarmSelectTelegraph on clear / swap-start / any board mutation, so no piece is ever
   * left displaced when the board animates. Stays empty (and unused) under reduced motion.
   */
  private leanTweens: Phaser.Tweens.Tween[] = []
  private leanHomes: Array<{ sprite: Phaser.GameObjects.Sprite; x: number; y: number }> = []

  private dragFrom: Coord | null = null
  private dragStartX = 0
  private dragStartY = 0
  private dragConsumed = false
  /** B1 swipe-intent trail — a faint spark follow riding the grabbed piece across a swap glide; null when idle. */
  private swipeTrail: Phaser.GameObjects.Particles.ParticleEmitter | null = null

  /**
   * B4 rare idle twinkle — a lone masked `sweep` gleam on ONE resting piece, fired sparsely while idle
   * (deliberately NOT the removed board-wide light-sweep). The live gleam + its geometry mask + tween
   * are held so a board touch / resolve disarms it mid-flight; `nextTwinkleAt` is the scene-clock (ms)
   * of the next allowed fire, pushed forward on any activity so it never glints the instant rest resumes.
   */
  private twinkleGleam: Phaser.GameObjects.Image | null = null
  private twinkleMask: Phaser.GameObjects.Graphics | null = null
  private twinkleTween: Phaser.Tweens.Tween | null = null
  private nextTwinkleAt = 0

  private score = 0
  private shownScore = 0
  private scoreTween: Phaser.Tweens.Tween | null = null
  private scoreText!: Phaser.GameObjects.Text
  /** W3 — the next round score milestone (10k/25k/50k…) whose crossing fires a one-off gold pop on the readout. */
  private scoreMilestone = 10000

  /**
   * E11 continuous combo counter: ONE reused readout over the board — punches in place + heat-ramps
   * warm→hot across a cascade, then fades on resolve. Never per-wave spawns. `comboTween` holds
   * whichever beat is live (punch OR fade) so a new wave / the resolve can cancel it cleanly.
   */
  private comboText?: Phaser.GameObjects.Text
  private comboTween: Phaser.Tweens.Tween | null = null

  /** Compact chip-balance pill in the HUD; the win payout flies a chip into it. */
  private chipHud?: ChipPill
  /** New chip total banked by the current win (set in finishWin, applied on the payout fly-in). */
  private chipBanked = 0

  /** Jackpot charge meter in the HUD (fills one notch per level win). */
  private jackpotHud?: JackpotMeter
  /** True once this win charged the meter to full — the win-card Continue then fires the wheel. */
  private jackpotArmed = false

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
    this.jackpotOccurred = false // §E4 — reset per round (scene.restart re-runs create, not field inits)
    this.heartbloomFired = false
    this.newBestThisWin = false

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
    this.scoreMilestone = 10000 // W3 — first gold milestone pop
    this.state = 'idle'
    this.sprites.clear()
    this.armedGlows.clear()
    this.goalGlows.clear()
    this.reducedMotion = this.prefersReducedMotion()
    this.hc = hcBoard() // §E12 — high-contrast board mode (darker floor + tints + thicker ring)
    this.hcRing = undefined // drop any stale ref from a prior create (restart doesn't re-init fields)
    this.introOpen = false
    this.reduceFlashing = prefReduceFlashing() // §E8 — wire the punch() flash gate to the real toggle
    this.selected = null
    this.selectedSprite = null
    this.selectPulse = null
    // B1/B2/B4 additive-cue state — drop any stale refs from a prior create (restart re-runs create,
    // not field inits); the objects themselves were destroyed with the previous scene.
    this.leanTweens = []
    this.leanHomes = []
    this.swipeTrail = null
    this.twinkleGleam = null
    this.twinkleMask = null
    this.twinkleTween = null
    this.nextTwinkleAt = 0
    this.dragFrom = null
    this.scoreMult = 1
    this.movesPulse = null
    // Combo readout is a scene GameObject — the old one was destroyed on restart, so drop the stale ref.
    this.comboText = undefined
    this.comboTween = null
    this.trauma = 0
    this.traumaDirX = 0
    this.traumaDirY = 0
    this.hitstopUntil = 0
    this.baseTimeScale = 1
    this.impactFlash = undefined
    this.cameras.main.setScroll(0, restScrollY())
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
        this.baseTimeScale = turbo
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

    if (this.scoreMult > 1) {
      this.add
        .text(BOARD_X + BOARD_W - 128, 66, '×2', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: getTheme().goldText })
        .setOrigin(1, 0)
    }
    if (this.activeBoosts.length > 0) this.showBoostBanner(this.activeBoosts)
    this.showGoalCallout()
    this.maybeOccasion() // §E9 special-date dress-up (dormant unless an occasion is configured for today)

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p))
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p))
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p))

    if (import.meta.env.DEV) {
      this.updateDebug()
      this.time.addEvent({ delay: 300, loop: true, callback: () => this.updateDebug() })
    }
    // The animated deal-in sets state='resolving' and owns the idle handoff (autoplay + hint) once
    // the board finishes assembling; an instant fill (reduced motion) leaves us idle → hand off now.
    if (this.state === 'idle') {
      this.scheduleAutoplay()
      this.armHint()
    }

    this.maybeOnboarding()
  }

  /**
   * §E14 first-run onboarding: show the gentle teach-card ONCE, and only for a TRULY-NEW player —
   * `seenIntro` still false AND still on level 1 (`unlocked <= 1`). The second clause is the guard
   * that keeps it from ever popping for an existing player mid-progress (Maya at Level 46 has
   * `unlocked = 47`). Never in endless. Marked seen immediately (so it can't re-show even if the card
   * is dismissed by tapping away), then rendered; `introOpen` gates board taps while it's up.
   */
  private maybeOnboarding(): void {
    if (this.endless) return
    const save = loadSave()
    if (save.seenIntro || save.unlocked > 1) return
    save.seenIntro = true
    persistSave(save)
    this.introOpen = true
    openOnboarding(this, () => (this.introOpen = false))
  }

  /**
   * Out-of-lives screen (numbered levels only) — a warm "take a break" with a live
   * countdown to the next life. When one regenerates, a PLAY button appears. The
   * countdown is wall-clock based (refreshLives reads Date.now), so it stays correct
   * even if the timer tick is throttled while the tab is hidden.
   */
  private showLivesGate(): void {
    this.log('showLivesGate')
    const T = getTheme()
    const reduced = this.prefersReducedMotion()
    this.cameras.main.setScroll(0, restScrollY())
    addCasinoBackdrop(this, 'menu')
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this,'home'))
    addMuteChip(this, 676, 40)

    this.add
      .text(DESIGN_W / 2, 320, 'TAKE A BREAK', { fontFamily: FONT, fontSize: '56px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
    this.add
      .text(DESIGN_W / 2, 384, 'Out of lives — they refill on their own', { fontFamily: FONT, fontSize: '24px', color: T.onBackdropMuted })
      .setOrigin(0.5)

    const emblem = this.add.image(DESIGN_W / 2, 560, 'heartbig').setDisplaySize(150, 150).setTint(0x8a7a52).setAlpha(reduced ? 0.5 : 0.4)
    if (!reduced) {
      this.tweens.add({ targets: emblem, alpha: 0.65, scale: emblem.scaleX * 1.05, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }

    const hud = addLivesHud(this, DESIGN_W / 2, 700, { size: 46, showTimer: false })
    const nextText = this.add
      .text(DESIGN_W / 2, 782, '', { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: T.onBackdropInk })
      .setOrigin(0.5)
    const fullText = this.add
      .text(DESIGN_W / 2, 828, '', { fontFamily: FONT, fontSize: '22px', color: T.onBackdropMuted })
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
          if (!reduced) {
            this.tweens.add({ targets: playBtn, scale: 1.05, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
          }
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
    const T = getTheme()
    const banner = this.add.container(DESIGN_W / 2, BOARD_Y + 72).setDepth(31)
    const text = this.add
      .text(0, 0, `🎁  ${boosts.map(b => this.boostLabel(b)).join('   ·   ')}`, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
    const w = text.width + 56
    const h = 64
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.2)
    g.fillRoundedRect(-w / 2 + 2, -h / 2 + 5, w, h, h / 2)
    g.fillStyle(T.cardFill, 0.98)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.lineStyle(3, T.goldBezel, 1)
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
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = BOARD_Y + BOARD_W * 0.36
    const layer = this.add.container(cx, cy).setDepth(34)

    const header = this.add
      .text(0, -66, 'COLLECT', { fontFamily: FONT, fontSize: '32px', fontStyle: '900', color: T.goldText })
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
          .text(ix, 8 + iconSize / 2 + 22, `×${o.total}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.navyText })
          .setOrigin(0.5)
      )
    })

    const w = Math.max(header.width, rowW) + 84
    const halfH = 96
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.22)
    g.fillRoundedRect(-w / 2 + 3, -halfH + 8, w, halfH * 2, 30)
    g.fillStyle(T.cardFill, 0.98)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 30)
    g.lineStyle(3, T.goldBezel, 1)
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

  /**
   * E10 collect-fly, landing step (final): snap an objective's VISIBLE chip to its model value —
   * set the number (or ✓), pop the chip, gold-flash the number, and on completion retire the target
   * emphasis + fire the objective-complete stamp. Used directly under reduced motion / when a flyer
   * isn't in budget, and as the last collect flyer's arrival.
   */
  private settleCollect(o: ObjectiveState): void {
    o.shown = o.remaining
    o.text?.setText(o.remaining > 0 ? String(o.remaining) : '✓')
    if (o.chip && o.chip.scale === 1) {
      this.tweens.add({ targets: o.chip, scale: 1.14, duration: 120, yoyo: true, ease: 'Quad.easeOut' })
    }
    if (o.remaining > 0) {
      // C5 · one subtle rising "almost there" tone as this objective crosses into its final piece(s).
      // Latched (remaining only ever decreases) so it fires exactly once per objective — rare + meaningful.
      // Objectives that begin at/under the threshold (e.g. total 1) simply complete and never "approach".
      if (o.remaining <= OBJECTIVE_NEAR && !o.nearFired) {
        o.nearFired = true
        sfx.objectiveNear()
      }
      // Gold flash — reverts to ink only while still incomplete (a completed chip keeps its green ✓).
      o.text?.setColor(css(getTheme().gold))
      this.time.delayedCall(160, () => o.remaining > 0 && o.text?.setColor(getTheme().ink))
    } else {
      o.text?.setColor(getTheme().ok)
      this.onObjectiveComplete(o)
      this.objectiveStamp(o)
    }
  }

  /** E10 collect-fly, intermediate step: a non-final flyer landed — tick the visible counter down
   *  one notch toward the model + pop the chip (completion is owned by the final flyer's settle). */
  private stepCollect(o: ObjectiveState): void {
    const shown = Math.max(o.remaining, (o.shown ?? o.remaining) - 1)
    o.shown = shown
    o.text?.setText(shown > 0 ? String(shown) : '✓')
    if (o.chip && o.chip.scale === 1) {
      this.tweens.add({ targets: o.chip, scale: 1.12, duration: 110, yoyo: true, ease: 'Quad.easeOut' })
    }
    if (o.remaining > 0) {
      o.text?.setColor(css(getTheme().gold))
      this.time.delayedCall(140, () => o.remaining > 0 && o.text?.setColor(getTheme().ink))
    }
  }

  /**
   * E10 collect-fly: arc `sources.length` small copies of an objective's symbol from their cleared
   * cells UP to the COLLECT chip (a lifted quadratic, reusing the symbol texture, self-destroying on
   * arrival). Each landing ticks the visible counter one step toward the model; the LAST to land
   * settles it (snap + completion stamp). Non-blocking — the model already decremented, so the
   * cascade + win detection never wait on these. Cap is enforced by the caller (≤3/wave).
   */
  private flyCollect(o: ObjectiveState, sources: Coord[]): void {
    const chip = o.chip
    if (!chip) {
      this.settleCollect(o)
      return
    }
    const targetX = chip.x
    const targetY = chip.y - 20 // the chip's symbol icon sits above its number
    const startScale = PIECE_SCALE * 0.7
    const total = sources.length
    let landed = 0
    sources.forEach((at, i) => {
      const from = this.cellToXY(at)
      const flyer = this.add.image(from.x, from.y, o.symbol).setDepth(32).setScale(startScale)
      // Control point lifted above both ends → a gentle board→chip arc (no Path object needed).
      const ctrlX = (from.x + targetX) / 2 + (Math.random() * 2 - 1) * 30
      const ctrlY = Math.min(from.y, targetY) - 70 - Math.random() * 30
      const p = { t: 0 }
      this.tweens.add({
        targets: p,
        t: 1,
        delay: i * 60,
        duration: 320 + i * 30,
        ease: 'Sine.easeIn',
        onUpdate: () => {
          const t = p.t
          const u = 1 - t
          flyer.x = u * u * from.x + 2 * u * t * ctrlX + t * t * targetX
          flyer.y = u * u * from.y + 2 * u * t * ctrlY + t * t * targetY
          flyer.setScale(startScale * (1 - 0.4 * t))
          flyer.rotation = t * 1.1
        },
        onComplete: () => {
          flyer.destroy()
          if (++landed >= total) this.settleCollect(o)
          else this.stepCollect(o)
        },
      })
    })
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
      .text(x, y, '✓', { fontFamily: FONT, fontSize: '84px', fontStyle: '900', color: getTheme().ok })
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
    this.cabinetSurge = false // reset per build so a restart mid-surge can't leave the drive stuck off
    // cabinetGlow breathe — gated (§E8): reduced motion rests it at a static mid-glow, no pulse.
    // Otherwise it breathes off the shared `heartbeat` clock in update() (C1), in phase with Home's
    // PLAY halo — no independent yoyo (that would shimmer out of phase with the rest of the app).
    if (this.reducedMotion) this.cabinetGlow.setAlpha(0.14)

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
    // §E12 High-Contrast: a much darker well floor so the (inset) light cushions read as a crisp
    // grid — the dark floor peeking between tiles IS the 1px cell separator. Warm look untouched otherwise.
    const wellFloor = this.hc ? 0x241f18 : 0xe4d8bd
    g.fillStyle(wellFloor, 1)
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
    // §E12 High-Contrast: a second, higher-contrast checkerboard tint set (the warm default's two
    // tints are near-identical whispers), plus a 3px inset so the dark floor shows as cell separators.
    const TILE_A = this.hc ? 0xf7f1e3 : 0xf4e7c6
    const TILE_B = this.hc ? 0xe1cfa6 : 0xf7e3de
    const tileSize = this.hc ? CELL - 3 : CELL
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.cellToXY({ row: r, col: c })
        this.add
          .image(p.x, p.y, 'tile')
          .setDisplaySize(tileSize, tileSize)
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
      // Traveling bulb chase — gated (§E8): reduced motion rests every bulb statically lit, no chase.
      if (this.reducedMotion) {
        bulb.setAlpha(0.85)
      } else {
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
      }
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
      // The surge briefly OWNS the glow's alpha; the heartbeat drive in update() yields until it ends.
      this.cabinetSurge = true
      this.tweens.add({
        targets: this.cabinetGlow,
        alpha: 0.42,
        duration: 160,
        yoyo: true,
        repeat: 1,
        ease: 'Quad.easeOut',
        onComplete: () => {
          this.cabinetSurge = false
        },
      })
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
    const T = getTheme()
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
      .text(BOARD_X + BOARD_W, 84, '0', { fontFamily: FONT, fontSize: '34px', color: T.onBackdropInk, fontStyle: 'bold' })
      .setOrigin(1, 0)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
    // Mute chip nudged to y=34 (from 40) so its lower arc clears the SCORE label.
    addMuteChip(this, 676, 34)

    // Persistent chip balance — compact, tucked into the top row's gap between the back button
    // and the LEVEL tab. Shows the pre-win total; the win payout flies a chip in to bump it.
    this.chipHud = addChipPill(this, 182, 84, { compact: true })

    // Jackpot charge meter — a slot-console strip in the space below the board that fills one notch
    // per level win and then "explodes" into the wheel. Numbered levels only (endless has no jackpot).
    // Depth 42 so it sits above the win scrim and the player watches it tick up on the win card.
    if (!this.endless) {
      this.jackpotHud = addJackpotMeter(this, DESIGN_W / 2, 1086, { width: 300 })
      this.jackpotHud.container.setDepth(42)
      this.jackpotHud.update(loadSave().jackpotMeter, false)
    }
    // DEV-only: open the wheel on demand so an automated check can spin it repeatedly. Stripped in prod.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __spinWheel?: () => Promise<unknown> }).__spinWheel = () =>
        new Promise(res => openJackpotWheel(this, { onClaim: res }))
    }

    // Second row: moves card + objective chips.
    const cardY = 196
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.12)
    g.fillRoundedRect(BOARD_X + 2, cardY - 52 + 5, 170, 104, 20)
    g.fillStyle(0xffffff, 1)
    g.fillRoundedRect(BOARD_X, cardY - 52, 170, 104, 20)
    g.lineStyle(2, T.border, 1)
    g.strokeRoundedRect(BOARD_X, cardY - 52, 170, 104, 20)
    this.add
      .text(BOARD_X + 85, cardY - 28, 'MOVES', { fontFamily: FONT, fontSize: '18px', color: T.inkMuted })
      .setOrigin(0.5)
      .setLetterSpacing(3)
    this.movesText = this.add
      .text(BOARD_X + 85, cardY + 12, String(this.movesLeft), {
        fontFamily: FONT,
        fontSize: '48px',
        fontStyle: '900',
        color: T.ink,
      })
      .setOrigin(0.5)

    if (this.endless) {
      // No objectives in endless — show this week's target (BEST to beat) instead.
      const cardW = 290
      const bx = BOARD_X + BOARD_W - cardW
      g.fillStyle(T.shadow, 0.12)
      g.fillRoundedRect(bx + 2, cardY - 52 + 5, cardW, 104, 20)
      g.fillStyle(T.cardFill, 1)
      g.fillRoundedRect(bx, cardY - 52, cardW, 104, 20)
      g.lineStyle(2, T.goldBezel, 0.9)
      g.strokeRoundedRect(bx, cardY - 52, cardW, 104, 20)
      this.add
        .text(bx + cardW / 2, cardY - 28, "WEEK'S BEST", { fontFamily: FONT, fontSize: '18px', color: T.inkMuted })
        .setOrigin(0.5)
        .setLetterSpacing(2)
      this.add
        .text(bx + cardW / 2, cardY + 12, this.endlessBest > 0 ? this.endlessBest.toLocaleString() : '—', {
          fontFamily: FONT,
          fontSize: '40px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
    } else {
      const chipW = 118
      const chipGap = 12
      const n = this.objectives.length
      // A "COLLECT" tag over the objective cluster — names the chips unmistakably as TARGETS.
      const clusterCx = BOARD_X + BOARD_W - chipW / 2 - ((n - 1) * (chipW + chipGap)) / 2
      this.add
        .text(clusterCx, cardY - 70, 'COLLECT', { fontFamily: FONT, fontSize: '18px', fontStyle: '900', color: T.goldText })
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
          .setTint(T.gold)
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
        cg.fillStyle(T.shadow, 0.12)
        cg.fillRoundedRect(-chipW / 2 + 2, -52 + 5, chipW, 104, 20)
        cg.fillStyle(0xffffff, 1)
        cg.fillRoundedRect(-chipW / 2, -52, chipW, 104, 20)
        cg.lineStyle(2, T.border, 1)
        cg.strokeRoundedRect(-chipW / 2, -52, chipW, 104, 20)
        chip.add(cg)
        const icon = this.add.image(0, -20, o.symbol)
        icon.setDisplaySize(54, 54)
        chip.add(icon)
        o.text = this.add
          .text(0, 27, String(o.remaining), { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: T.ink })
          .setOrigin(0.5)
        chip.add(o.text)
        o.chip = chip
        o.shown = o.remaining // display starts synced; collect-fly lets it lag behind the model
      })
    }

    this.add
      .text(
        DESIGN_W / 2,
        988,
        this.endless ? "Biggest score wins this week's board" : 'Match the highlighted goal symbols before moves run out',
        { fontFamily: 'Arial, sans-serif', fontSize: '22px', color: T.onBackdropMuted }
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

    // §E12 High-Contrast: a thicker two-tone selection ring (dark contrast stroke + bright gold core)
    // drawn once around the origin and repositioned on select — reads on both the bright cushions and
    // the dark separators, where the thin baked gold `ring` alone can wash out. Warm mode uses `ring`.
    if (this.hc) {
      const s = (CELL * 1.06) / 2
      const hg = this.add.graphics().setVisible(false)
      hg.lineStyle(9, 0x241f18, 1)
      hg.strokeRoundedRect(-s, -s, s * 2, s * 2, 16)
      hg.lineStyle(5, 0xffd75e, 1)
      hg.strokeRoundedRect(-s, -s, s * 2, s * 2, 16)
      this.pieceLayer.add(hg)
      this.hcRing = hg
    }

    // Board deal-in (E5, signature moment #2): rain the 64 tiles in column-staggered from the top
    // edge — the layer is grid-masked, so pieces starting above BOARD_Y clip to "fall from above" —
    // with a Back landing overshoot + settle squash. Reduced motion → instant fill (today's behavior).
    if (this.reducedMotion) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const at = { row: r, col: c }
          this.createSprite(this.board.get(at)!, at)
        }
      }
      return
    }

    this.state = 'resolving' // gate input until the board finishes assembling
    const COL_STAGGER = 40
    const FALL_MS = FALL_BASE_MS + FALL_PER_CELL_MS * ROWS // full-height drop
    const total = ROWS * COLS
    let landed = 0
    for (let c = 0; c < COLS; c++) {
      // dropCells = ROWS → the whole column starts stacked just above the top edge and pours in.
      for (let r = 0; r < ROWS; r++) {
        const at = { row: r, col: c }
        const sprite = this.createSprite(this.board.get(at)!, at, ROWS)
        const to = this.cellToXY(at)
        this.tweens.add({
          targets: sprite,
          y: to.y,
          delay: c * COL_STAGGER,
          duration: FALL_MS,
          ease: 'Back.easeOut',
          onComplete: () => {
            this.settleSquash(sprite, ROWS)
            // §E5/B14: ONE full-height landing thunk per settling column (r===0 fires once/col),
            // panned by column — the board pours in left→right as a rain of thunks, not mush.
            if (r === 0) sfx.land(1, this.colPan(c))
            // B3: one floor-dust puff per column at its DEEPEST (bottom) cell — the whole column pours in
            // together, so this lands in step with the r===0 thunk; full-height drop → max-size puff.
            if (r === ROWS - 1) this.floorDust(to.x, to.y, ROWS)
            if (++landed >= total) {
              this.state = 'idle'
              this.scheduleAutoplay()
              this.armHint()
            }
          },
        })
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
          // ÷2: symbol textures are now baked at 2× native (TEX_SIZE 128→256), so halve the
          // particle scale to keep the burst fragments the same on-screen size.
          scale: { start: 0.15, end: 0.05 },
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
  update(time: number, delta: number): void {
    // Trauma screenshake (E6): decay the accumulator and drive a camera offset. Directional when a
    // blast latched a vector; omnidirectional otherwise. Camera scroll shakes ALL scene content
    // (incl. the masked board) as one unit and is free. No-op under reduced motion (trauma never
    // accumulates — addTrauma is gated), so the board sits perfectly still.
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - (delta / 1000) * 2.6)
      const amp = 14 * this.trauma * this.trauma
      let ox: number
      let oy: number
      if (this.traumaDirX !== 0 || this.traumaDirY !== 0) {
        const main = Math.random() * 2 - 1
        const cross = (Math.random() * 2 - 1) * 0.3
        ox = amp * (this.traumaDirX * main - this.traumaDirY * cross)
        oy = amp * (this.traumaDirY * main + this.traumaDirX * cross)
      } else {
        ox = amp * (Math.random() * 2 - 1)
        oy = amp * (Math.random() * 2 - 1)
      }
      this.cameras.main.setScroll(ox, restScrollY() + oy)
      if (this.trauma === 0) {
        this.traumaDirX = 0
        this.traumaDirY = 0
        this.cameras.main.setScroll(0, restScrollY())
      }
    } else if (this.cameras.main.scrollX !== 0 || this.cameras.main.scrollY !== restScrollY()) {
      this.cameras.main.setScroll(0, restScrollY())
    }
    // Ambient cabinet glow (C1): breathe off the shared `heartbeat` so it pulses in phase with Home's
    // PLAY halo and every other breather. Skipped under reduced motion (holds the static mid-glow set
    // in buildBackdrop) and while a win surge (flashCabinet) briefly owns the alpha.
    if (this.cabinetGlow && !this.reducedMotion && !this.cabinetSurge) {
      this.cabinetGlow.setAlpha(0.1 + heartbeat.amp() * 0.08) // ~0.1 rest → ~0.18 peak, matching the retired yoyo
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
    // B4 rare idle twinkle: while the board truly rests (idle state + governor-idle, not reduced motion,
    // not low tier) let ONE random piece gleam every ~8–12s — a single sparse glint, NOT the removed
    // board-wide sweep. The moment anything happens (a touch flips quality.idle() false, or a resolve
    // leaves 'idle') we push the next fire a full interval out and kill any gleam mid-flight, so it
    // disarms instantly and never glints the moment rest resumes.
    if (this.state === 'idle' && !this.reducedMotion && quality.idle() && quality.count(1) > 0) {
      if (!this.twinkleGleam && time >= this.nextTwinkleAt) {
        this.nextTwinkleAt = time + Phaser.Math.Between(8000, 12000)
        this.twinklePiece()
      }
    } else {
      if (this.twinkleGleam) this.disarmTwinkle()
      this.nextTwinkleAt = time + 10000
    }
  }

  // ----------------------------------------------------------------- input

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.introOpen) return // §E14 — ignore board taps while the first-run card is up
    if (this.state !== 'idle') return
    this.disarmTwinkle() // B4 — the board is being touched; kill any idle gleam instantly
    // Pieces are WORLD objects (rendered at BOARD_X/Y + col/row*CELL). Since the fill-screen change
    // scrolls the main camera by restScrollY() to centre the design box, game-space (p.x/p.y) no
    // longer equals world-space — so hit-test the cell against the camera-converted WORLD point.
    // Phaser sets p.worldX/worldY from the main camera (scroll incl.) before this event fires.
    const cell = this.xyToCell(p.worldX, p.worldY)
    if (!cell) {
      this.clearSelection()
      this.dragFrom = null
      return
    }
    this.disarmHint() // the player is engaging the board — retire the nudge
    this.dragFrom = cell
    this.dragStartX = p.worldX
    this.dragStartY = p.worldY
    this.dragConsumed = false
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (this.state !== 'idle' || !this.dragFrom || this.dragConsumed) return
    const dx = p.worldX - this.dragStartX // world-space deltas (dragStartX/Y are world; see onDown)
    const dy = p.worldY - this.dragStartY
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
    const ring = this.hc && this.hcRing ? this.hcRing : this.ring
    ring.setPosition(pos.x, pos.y).setVisible(true)
    this.selectedSprite = this.sprites.get(this.board.get(at)!.id) ?? null
    // Selected-piece pulse — gated (§E8): reduced motion relies on the static ring alone for the tell.
    if (this.selectedSprite && !this.reducedMotion) {
      this.selectPulse = this.tweens.add({
        targets: this.selectedSprite,
        scale: PIECE_SCALE * 1.12,
        duration: 240,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
    this.armSelectTelegraph(at) // B2: lean the swappable neighbors in (no-op under reduced motion)
  }

  private clearSelection(): void {
    this.selectPulse?.stop()
    this.selectPulse = null
    this.selectedSprite?.setScale(PIECE_SCALE)
    this.selectedSprite = null
    this.selected = null
    this.ring.setVisible(false)
    this.hcRing?.setVisible(false)
    this.disarmSelectTelegraph() // B2: settle the leaned neighbors back to their exact grid homes
  }

  /**
   * B2 magnetic select telegraph: the ≤4 in-bounds ORTHOGONAL neighbors of the selected cell lean
   * ~3px toward it and Back-settle — a tactile "these are your options" cue that complements the
   * selection ring. Each leaned sprite is stored with its EXACT grid-home position so disarm restores
   * it pixel-perfectly. Reduced motion → no lean (the ring alone carries the tell); ≤4 tiny transform
   * tweens per selection, all cleared before any board change so nothing fights a swap/fall.
   */
  private armSelectTelegraph(at: Coord): void {
    if (this.reducedMotion) return
    const center = this.cellToXY(at)
    const LEAN = 3
    const dirs: Coord[] = [{ row: -1, col: 0 }, { row: 1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }]
    for (const d of dirs) {
      const nAt = { row: at.row + d.row, col: at.col + d.col }
      if (!this.board.inBounds(nAt)) continue
      const piece = this.board.get(nAt)
      if (!piece) continue
      const sprite = this.sprites.get(piece.id)
      if (!sprite || !sprite.active) continue
      const home = this.cellToXY(nAt)
      const dx = center.x - home.x
      const dy = center.y - home.y
      const len = Math.hypot(dx, dy) || 1
      this.leanHomes.push({ sprite, x: home.x, y: home.y })
      this.leanTweens.push(
        this.tweens.add({
          targets: sprite,
          x: home.x + (dx / len) * LEAN,
          y: home.y + (dy / len) * LEAN,
          duration: 220,
          ease: 'Back.easeOut',
        })
      )
    }
  }

  /** Disarm B2: kill any half-finished lean tweens and snap the neighbors back to their grid homes. */
  private disarmSelectTelegraph(): void {
    if (this.leanTweens.length === 0 && this.leanHomes.length === 0) return
    for (const tw of this.leanTweens) tw.stop()
    this.leanTweens = []
    for (const { sprite, x, y } of this.leanHomes) if (sprite.active) sprite.setPosition(x, y)
    this.leanHomes = []
  }

  /**
   * B1 swipe-intent trail: a faint spark follow rides the grabbed piece as it glides on a swap, so the
   * gesture reads as physical intent before the pieces snap. A dedicated follow-emitter (the same idiom
   * as the reel missile trail), reusing the baked `spark` texture and retired the instant the glide
   * resolves. Reduced motion → no trail; governor-capped (off entirely on the low tier via
   * count(1)===0, and its live-particle budget sized by quality.count so it never gets busy).
   */
  private startSwipeTrail(sprite: Phaser.GameObjects.Sprite): void {
    this.stopSwipeTrail() // never stack two trails — a fresh swap owns the follow
    if (this.reducedMotion || quality.count(1) === 0) return
    const trail = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 10, max: 55 },
        scale: { start: 0.4, end: 0 },
        alpha: { start: 0.5, end: 0 },
        lifespan: { min: 150, max: 280 },
        tint: [0xf2b234, 0xffd75e],
        quantity: 1,
        frequency: 26,
        maxAliveParticles: quality.count(9),
        emitting: true,
      })
      .setDepth(20) // above the tiles/pieces, below the HUD — rides the piece, never a board-wide wash
    trail.startFollow(sprite)
    this.swipeTrail = trail
  }

  /** Retire the B1 trail: stop emitting + following, then free the emitter once its tail has faded. */
  private stopSwipeTrail(): void {
    const trail = this.swipeTrail
    if (!trail) return
    this.swipeTrail = null
    trail.stop()
    trail.stopFollow()
    this.time.delayedCall(320, () => trail.destroy())
  }

  // ------------------------------------------------------------ game flow

  private async trySwap(a: Coord, b: Coord): Promise<void> {
    const pa = this.board.get(a)
    const pb = this.board.get(b)
    if (!pa || !pb) return
    this.state = 'swapping'
    this.disarmHint() // idle effects yield to the move (§3d composition)
    this.disarmSelectTelegraph() // B2: restore any leaned neighbors before the board animates
    sfx.swap()

    const sa = this.sprites.get(pa.id)!
    const sb = this.sprites.get(pb.id)!
    const posA = this.cellToXY(a)
    const posB = this.cellToXY(b)

    // B1: a faint spark trail rides the grabbed piece across the glide (physical intent), retired the
    // instant the pieces snap. Reduced-motion / low tier → no trail (handled inside the helper).
    this.startSwipeTrail(sa)
    await Promise.all([
      this.t({ targets: sa, x: posB.x, y: posB.y, duration: SWAP_MS, ease: 'Quad.easeOut' }),
      this.t({ targets: sb, x: posA.x, y: posA.y, duration: SWAP_MS, ease: 'Quad.easeOut' }),
    ])
    this.stopSwipeTrail()
    this.board.swap(a, b)

    let wave = this.board.swapActivation(a, b)
    if (!wave) {
      if (this.board.findRuns().length === 0) {
        // Invalid: thud and snap back. No move spent.
        this.board.swap(a, b)
        sfx.invalidThud()
        this.punch({ trauma: 0.22 }) // small unified thud kick (reduced-motion → still)
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
    if (this.movesLeft <= 5) this.movesText.setColor(getTheme().warn)
    // Getting tight — start a gentle looping pulse on the moves number (once, no stacking). Gated
    // (§E8): reduced motion keeps the warn colour above (the real signal), just no pulse.
    if (this.movesLeft <= 3 && !this.movesPulse && !this.reducedMotion) {
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
    this.fadeCombo() // E11: the cascade settled — resolve the combo readout (composes with the win peak)
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

    const clearedIds = new Set(wave.cleared.map(c => c.piece.id))

    // Match-size weighting (E6/E11 first-wave part): a big OPENING match reads as weight instantly —
    // a brighter flash + extra spark + a small trauma kick, BEFORE any cascade (cascades get their
    // own combo beat below). Reduced motion keeps the flash, drops the kick (both gated in punch()).
    if (cascade === 1 && wave.cleared.length >= 5) {
      const bigAt = wave.events[0]?.at ?? pops[0]?.at
      if (bigAt) {
        const bp = this.cellToXY(bigAt)
        this.punch({ trauma: 0.3, flash: { x: bp.x, y: bp.y, size: CELL * 1.3 } })
        if (!this.reducedMotion && quality.count(1) > 0) this.sparkEmitter.explode(quality.count(12), bp.x, bp.y)
      }
    }

    // Effect choreography — charge → graded hitstop → release (E6, signature moment #4). The clear
    // pop of every cell is delayed by the same charge window (below) so the wind-up reads first.
    const hasEvents = wave.events.length > 0
    const chargeMs = hasEvents && !this.reducedMotion ? 70 : 0
    let effectMs = 0
    if (hasEvents) {
      // The deepest event this wave owns the single freeze: reel 0 / bomb ~45 / jackpot·mega ~70ms.
      let hitstopMs = 0
      for (const e of wave.events) {
        if (e.type === 'bomb') hitstopMs = Math.max(hitstopMs, 45)
        else if (e.type === 'jackpot') hitstopMs = Math.max(hitstopMs, 70)
      }
      if (cascade >= 4) hitstopMs = Math.max(hitstopMs, 70)

      for (const e of wave.events) this.chargeFlare(e.at) // wind-up on every detonating tile
      this.time.delayedCall(chargeMs, () => {
        this.hitstop(hitstopMs) // freeze, then release the explosions on the same frame
        for (const e of wave.events) {
          if (e.type === 'reel') this.detonateReel(e.at, e.horizontal, cascade)
          else if (e.type === 'bomb') this.detonateBomb(e.at, e.radius, cascade)
          else this.detonateJackpot()
        }
        // The board reacts: surviving neighbors of the primary blast flinch outward + settle.
        if (wave.events[0]) this.secondaryMotion(wave.events[0].at, clearedIds)
      })
      effectMs = chargeMs + 340
    } else if (pops.length >= 5) {
      // A chunky normal clear (no special) still shoves its surviving neighbors outward.
      const chunkAt = pops[0]?.at
      if (chunkAt) this.secondaryMotion(chunkAt, clearedIds)
    }

    // Scoring + objectives (specials count as their symbol; jackpot pieces don't). The MODEL
    // (obj.remaining) decrements SYNCHRONOUSLY here so win detection stays exact; the VISIBLE tick +
    // chip pop are deferred to the E10 collect-fly flyer's arrival below, so the decrement reads as
    // "the board fed the counter". We also remember which cleared cells fed each objective (for arc
    // origins). Reduced motion skips the arc and settles the display in place, instantly.
    const changedObjectives = new Set<ObjectiveState>()
    const collectSources = new Map<ObjectiveState, Coord[]>()
    for (const { piece, at } of wave.cleared) {
      if (piece.kind === 'jackpot') continue
      const obj = this.objectives.find(o => o.symbol === piece.symbol)
      if (obj && obj.remaining > 0) {
        obj.remaining--
        changedObjectives.add(obj)
        const src = collectSources.get(obj)
        if (src) src.push(at)
        else collectSources.set(obj, [at])
      }
    }
    if (this.reducedMotion) {
      // E10 fallback: no arc — the existing instant decrement + chip pop (+ complete stamp).
      for (const o of changedObjectives) this.settleCollect(o)
    } else {
      // Collect-fly (E10): arc a small copy of the cleared symbol from the board to its COLLECT chip,
      // and only THEN tick the counter + pop it. Capped to ≤3 flyers/wave, split greedily across the
      // objectives that changed (representative cells if more cleared); a starved objective settles
      // instantly so the visible count never desyncs from the model.
      let flyBudget = 3
      for (const o of changedObjectives) {
        const sources = collectSources.get(o) ?? []
        const n = Math.min(sources.length, flyBudget)
        if (n <= 0) {
          this.settleCollect(o)
          continue
        }
        flyBudget -= n
        this.flyCollect(o, sources.slice(0, n))
      }
    }
    const wavePoints = wave.cleared.length * POINTS_PER_PIECE * cascade
    this.addScore(wavePoints)
    if (cascade >= 2) {
      this.showCombo(cascade)
      // Cascade rumble routed through the single trauma authority (crisp + decayed, never muddy).
      this.punch({ trauma: Math.min(0.5, 0.12 + cascade * 0.06) })
    }

    // Pop cleared sprites, staggered outward from the first effect's epicenter.
    const epicenter = wave.events[0]?.at ?? pops[0]?.at
    // One floating "+N" per wave at the clear epicenter — bigger on chunky cascades.
    if (epicenter) {
      const ep = this.cellToXY(epicenter)
      this.spawnScorePopup(wavePoints, ep.x, ep.y, cascade)
    }
    const promises: Promise<void>[] = []
    // §E3/B14: a light glassy "tink" partners each clear pop, key-locked (an octave above pop's climb)
    // + panned by column, so the cells you see clear right you hear right. Capped so a huge jackpot
    // clear stays a shimmer, not a clatter; the outward stagger spreads them into an arpeggio.
    let tinks = 0
    for (const { piece, at } of pops) {
      const sprite = this.sprites.get(piece.id)
      if (!sprite) continue
      this.sprites.delete(piece.id)
      // Cleared cells pop AFTER the charge wind-up (chargeMs) so the detonation reads charge→release.
      const delay = chargeMs + (epicenter ? (Math.abs(at.row - epicenter.row) + Math.abs(at.col - epicenter.col)) * 16 : 0)
      const pos = this.cellToXY(at)
      const tink = tinks < 10
      if (tink) tinks++
      this.time.delayedCall(delay, () => {
        if (tink) sfx.clearTink(cascade, this.colPan(at.col))
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

  // ---------------------------------------------------- impact & weight (E5/E6)

  /**
   * The single shake/flash authority (KEY CROSS-LENS CALL #1). Every screen kick and impact-frame
   * flash routes through here so reduced-motion (gates trauma/freeze) and a future reduce-flashing
   * toggle (gates the white flash) each live in ONE place.
   */
  private punch(opts: { trauma?: number; dirX?: number; dirY?: number; flash?: { x: number; y: number; size?: number } }): void {
    if (opts.trauma) this.addTrauma(opts.trauma, opts.dirX ?? 0, opts.dirY ?? 0)
    if (opts.flash && !this.reduceFlashing) this.impactFrame(opts.flash.x, opts.flash.y, opts.flash.size)
  }

  /** Feed the trauma accumulator (clamped) + latch a blast direction. No-op under reduced motion. */
  private addTrauma(amount: number, dirX = 0, dirY = 0): void {
    if (this.reducedMotion) return
    this.trauma = Math.min(1, this.trauma + amount)
    if (dirX !== 0 || dirY !== 0) {
      const len = Math.hypot(dirX, dirY) || 1
      this.traumaDirX = dirX / len
      this.traumaDirY = dirY / len
    }
  }

  /**
   * Impact frame (E6): one cell-sized full-white silhouette (the `fireball` texture tinted white,
   * ADD) flashing α1→0 over ~60ms. CAPPED at ONE concurrent — a stacked detonation shares the live
   * one rather than spawning another (perf + photosensitivity red line). Kept even under reduced
   * motion (the single allowed 1-frame flash); gated only by the reduce-flashing hook (via punch()).
   */
  private impactFrame(x: number, y: number, size = CELL): void {
    if (this.impactFlash && this.impactFlash.active) return // share the one already flashing
    const f = this.add
      .image(x, y, 'fireball')
      .setTint(0xffffff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(29)
      .setAlpha(1)
      .setDisplaySize(size, size)
    this.impactFlash = f
    this.tweens.add({
      targets: f,
      alpha: 0,
      duration: 60,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (this.impactFlash === f) this.impactFlash = undefined
        f.destroy()
      },
    })
  }

  /**
   * Graded hitstop (E6, call #2): briefly freeze tweens + timers right before a big blast expands, so
   * the hit registers. reel 0 / bomb ~45 / jackpot·mega ~70ms. Restored on a WALL-CLOCK setTimeout so
   * the restore itself isn't frozen; honours ?turbo via baseTimeScale. One freeze at a time — a hit
   * arriving during an active freeze no-ops (the deepest owns it). Reduced motion → skip.
   */
  private hitstop(ms: number): void {
    if (this.reducedMotion || ms <= 0) return
    const now = performance.now()
    if (now < this.hitstopUntil) return
    this.hitstopUntil = now + ms
    const restore = this.baseTimeScale
    this.tweens.timeScale = 0.0001
    this.time.timeScale = 0.0001
    setTimeout(() => {
      if (performance.now() >= this.hitstopUntil - 1) {
        this.tweens.timeScale = restore
        this.time.timeScale = restore
      }
    }, ms)
  }

  /**
   * Charge→release wind-up (E6, signature moment #4): the detonating tile scale-punches DOWN (~0.9)
   * and a gold glow flares for ~70ms, so the explosion feels earned (its clear-pop is delayed by the
   * same window in playWave, so the two don't fight). No-op under reduced motion (instant release).
   */
  private chargeFlare(atCoord: Coord): void {
    sfx.charge() // §E6/B14: a short rising tick under the wind-up — audio is never motion-gated
    if (this.reducedMotion) return
    const pos = this.cellToXY(atCoord)
    const piece = this.board.get(atCoord)
    const sprite = piece ? this.sprites.get(piece.id) : undefined
    if (sprite && sprite.active) {
      this.tweens.add({ targets: sprite, scaleX: PIECE_SCALE * 0.9, scaleY: PIECE_SCALE * 0.9, duration: 70, ease: 'Quad.easeIn' })
    }
    const flare = this.add
      .image(pos.x, pos.y, 'bgglow')
      .setTint(0xffe6a8)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(24)
      .setDisplaySize(CELL * 0.9, CELL * 0.9)
      .setAlpha(0)
    this.tweens.add({
      targets: flare,
      alpha: 0.85,
      scaleX: flare.scaleX * 1.9,
      scaleY: flare.scaleY * 1.9,
      duration: 80,
      ease: 'Quad.easeOut',
      onComplete: () => flare.destroy(),
    })
  }

  /**
   * Fall/spawn squash-&-settle (E5): on landing, squash scaleY down (bulge X for volume) then
   * Back-ease to rest over ~110ms, amplitude ∝ drop distance. Reduced motion → none.
   */
  private settleSquash(sprite: Phaser.GameObjects.Sprite, dropCells: number): void {
    if (this.reducedMotion || !sprite.active) return
    const amp = Phaser.Math.Clamp(dropCells / ROWS, 0.2, 1)
    sprite.setScale(PIECE_SCALE * (1 + 0.1 * amp), PIECE_SCALE * (1 - 0.16 * amp))
    this.tweens.add({ targets: sprite, scaleX: PIECE_SCALE, scaleY: PIECE_SCALE, duration: 110, ease: 'Back.easeOut' })
  }

  /**
   * B3 floor-impact dust: ONE soft ground puff per settling COLUMN (co-timed with its land() thunk) — a
   * faint `bgglow` cloud + a few `spark` motes at the deepest-settling cell, sized by drop distance, the
   * visual partner to the audio thunk. Added INTO the board-masked pieceLayer BELOW every piece (addAt 0)
   * so it reads as dust at the tray floor and can never spill past the board rect. Reduced motion → none;
   * `quality.count()`-gated so it drops to nothing on the low tier. Self-destroying.
   */
  private floorDust(x: number, y: number, dropCells: number): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const amp = Phaser.Math.Clamp(dropCells / ROWS, 0.2, 1)
    const T = getTheme()
    const fy = y + CELL * 0.3 // sit the puff at the piece's base, not its centre
    // Soft dust cloud — a low, wide bloom that expands and fades under the pieces.
    const cloud = this.add
      .image(x, fy, 'bgglow')
      .setTint(T.bloom)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(CELL * (0.5 + amp * 0.5), CELL * (0.32 + amp * 0.3))
      .setAlpha(0.3 * amp * quality.scale())
    this.pieceLayer.addAt(cloud, 0) // below every piece; the layer's mask keeps it on the board
    this.tweens.add({
      targets: cloud,
      scaleX: cloud.scaleX * 1.7,
      scaleY: cloud.scaleY * 1.4,
      alpha: 0,
      duration: 300,
      ease: 'Quad.easeOut',
      onComplete: () => cloud.destroy(),
    })
    // A few low, outward-kicked motes settling as they fade.
    const motes = quality.count(1 + Math.round(amp * 2))
    for (let i = 0; i < motes; i++) {
      const mote = this.add
        .image(x, fy, 'spark')
        .setTint(T.sparkleTint)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(7, 7)
        .setAlpha(0.7 * amp)
      this.pieceLayer.addAt(mote, 0)
      this.tweens.add({
        targets: mote,
        x: x + Phaser.Math.Between(-1, 1) * CELL * (0.3 + amp * 0.25),
        y: fy - Phaser.Math.Between(4, 12) * amp,
        scale: 0,
        alpha: 0,
        duration: 260 + Math.random() * 120,
        ease: 'Quad.easeOut',
        onComplete: () => mote.destroy(),
      })
    }
  }

  /**
   * B4 helper: gleam ONE random resting piece with a short masked `sweep` shine — a single sparse glint,
   * deliberately not a board-wide sweep (that was removed as repetitive). The sweep is clipped to the
   * piece's cell by a geometry mask and slides across once, then everything self-destructs via
   * disarmTwinkle. Refs are held so a board touch / resolve can kill it mid-slide.
   */
  private twinklePiece(): void {
    const pool: Phaser.GameObjects.Sprite[] = []
    for (const s of this.sprites.values()) if (s.active && s.visible) pool.push(s)
    if (pool.length === 0) return
    const s = pool[Phaser.Math.Between(0, pool.length - 1)]
    const half = PIECE_SIZE / 2
    // Geometry mask matching the piece cell so the shine can't bleed onto its neighbours.
    const mg = this.make.graphics({ x: 0, y: 0 }, false)
    mg.fillStyle(0xffffff, 1)
    mg.fillRoundedRect(s.x - half, s.y - half, PIECE_SIZE, PIECE_SIZE, 14)
    this.twinkleMask = mg
    const gleam = this.add
      .image(s.x - half, s.y, 'sweep')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(19) // above the pieces (container depth 0), below the clear-burst emitters (20/21)
      .setDisplaySize(PIECE_SIZE * 0.55, PIECE_SIZE)
      .setAlpha(0)
      .setAngle(18)
      .setMask(mg.createGeometryMask())
    this.twinkleGleam = gleam
    // One pass: the shine catches at the left edge and fades as it crosses — never yoyos, never repeats.
    this.twinkleTween = this.tweens.add({
      targets: gleam,
      x: s.x + half,
      alpha: { from: 0.4 * quality.scale(), to: 0 },
      duration: 460,
      ease: 'Sine.easeInOut',
      onComplete: () => this.disarmTwinkle(),
    })
  }

  /** B4 teardown: stop the gleam tween and destroy the sweep + its mask graphics. Safe to call anytime. */
  private disarmTwinkle(): void {
    this.twinkleTween?.stop()
    this.twinkleTween = null
    if (this.twinkleGleam) {
      this.twinkleGleam.clearMask()
      this.twinkleGleam.destroy()
      this.twinkleGleam = null
    }
    this.twinkleMask?.destroy()
    this.twinkleMask = null
  }

  /**
   * Secondary motion (E5): the ring of SURVIVING neighbors around a blast gets shoved ~4–8px outward
   * (falloff by distance) then Back-settles home, so the board reads as physical. Cap ~10 pieces.
   * Reduced motion / weakest governor tier → none.
   */
  private secondaryMotion(epicenter: Coord, clearedIds: Set<number>): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const ep = this.cellToXY(epicenter)
    const CAP = 10
    const RADIUS = 2.4 * CELL
    let nudged = 0
    for (let dr = -2; dr <= 2 && nudged < CAP; dr++) {
      for (let dc = -2; dc <= 2 && nudged < CAP; dc++) {
        if (dr === 0 && dc === 0) continue
        const at = { row: epicenter.row + dr, col: epicenter.col + dc }
        if (!this.board.inBounds(at)) continue
        const piece = this.board.get(at)
        if (!piece || clearedIds.has(piece.id)) continue
        const sprite = this.sprites.get(piece.id)
        if (!sprite || !sprite.active) continue
        const pos = this.cellToXY(at)
        const dx = pos.x - ep.x
        const dy = pos.y - ep.y
        const dist = Math.hypot(dx, dy) || 1
        if (dist > RADIUS) continue
        const push = 4 + 4 * (1 - dist / RADIUS)
        this.tweens.add({
          targets: sprite,
          x: pos.x + (dx / dist) * push,
          y: pos.y + (dy / dist) * push,
          duration: 60,
          ease: 'Quad.easeOut',
          onComplete: () => {
            if (sprite.active) this.tweens.add({ targets: sprite, x: pos.x, y: pos.y, duration: 220, ease: 'Back.easeOut' })
          },
        })
        nudged++
      }
    }
  }

  /** Jackpot-chip strike (extracted so it composes with the charge→freeze→release orchestration). */
  private detonateJackpot(): void {
    this.jackpotOccurred = true // §E4 — a jackpot this round qualifies the win for the Heartbloom hero beat
    sfx.jackpotStrike()
    // The jackpot's signature is a full-screen cream flash (its own "impact frame") — gate it via the
    // reduce-flashing hook — plus a heavy omnidirectional trauma kick.
    if (!this.reduceFlashing) this.cameras.main.flash(280, 255, 214, 90)
    this.punch({ trauma: 0.95 })
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

    // DIRECTIONAL impact: a horizontal line-blast kicks the screen horizontally (force with a vector,
    // not generic noise) + a crisp white impact frame along the blast axis.
    this.punch({
      trauma: 0.5 + boost * 0.05,
      dirX: horizontal ? 1 : 0,
      dirY: horizontal ? 0 : 1,
      flash: { x: at.x, y: at.y, size: CELL * 1.2 },
    })

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

    // Omnidirectional trauma punch (bigger blasts / combos hit harder) + a capped white impact frame.
    this.punch({
      trauma: Math.min(1, 0.45 + radius * 0.12 + boost * 0.04),
      flash: { x: at.x, y: at.y, size: CELL * 1.3 },
    })

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
    // §E5/B14: throttle landing thunks to ONE voice per settling COLUMN (≤COLS=8/refill) so the
    // refill reads as a rain of thunks, not mush. Track the deepest drop per column + when it lands.
    // Track the deepest drop per column + when/where it lands, so B3's floor dust can co-fire with the thunk.
    const colDrop = new Map<number, { dist: number; ms: number; x: number; y: number }>()
    const noteCol = (col: number, dist: number, x: number, y: number): void => {
      const cur = colDrop.get(col)
      if (!cur || dist > cur.dist) colDrop.set(col, { dist, ms: FALL_BASE_MS + FALL_PER_CELL_MS * dist, x, y })
    }
    for (const move of falls) {
      const sprite = this.sprites.get(move.piece.id)
      if (!sprite) {
        this.log('fall MISSING sprite', move.piece.id)
        continue
      }
      const to = this.cellToXY(move.to)
      const dist = move.to.row - move.from.row
      noteCol(move.to.col, dist, to.x, to.y)
      tweens.push(
        this.t({
          targets: sprite,
          y: to.y,
          duration: FALL_BASE_MS + FALL_PER_CELL_MS * dist,
          ease: 'Back.easeOut',
        }).then(() => this.settleSquash(sprite, dist)) // E5: squash-&-settle on landing
      )
    }
    for (const spawn of spawns) {
      const sprite = this.createSprite(spawn.piece, spawn.at, spawn.dropCells)
      const to = this.cellToXY(spawn.at)
      noteCol(spawn.at.col, spawn.dropCells, to.x, to.y)
      tweens.push(
        this.t({
          targets: sprite,
          y: to.y,
          duration: FALL_BASE_MS + FALL_PER_CELL_MS * spawn.dropCells,
          ease: 'Back.easeOut',
        }).then(() => this.settleSquash(sprite, spawn.dropCells)) // E5: squash-&-settle on landing
      )
    }
    // One height-mapped thunk per column, fired as that column's deepest piece settles, panned by column,
    // with B3's floor-dust puff co-timed to it at the settling cell (sized by the same drop distance).
    for (const [col, { dist, ms, x, y }] of colDrop) {
      this.time.delayedCall(ms, () => {
        sfx.land(Phaser.Math.Clamp(dist / ROWS, 0.15, 1), this.colPan(col))
        this.floorDust(x, y, dist)
      })
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
        color: getTheme().ink,
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
    // §E9 new-best: capture the stored best BEFORE recordResult bumps it, then compare the final score.
    const prevBest = loadSave().best
    const save = recordResult(this.level, stars, this.score)
    this.newBestThisWin = this.score > prevBest
    // Reward payout — rewards a clean, fast clear and is BANKED to the persistent chip balance.
    // Once per win (finishWin runs exactly once per completed level); endless/losses pay nothing.
    const chipReward = stars * 8 + this.movesLeft * 2
    this.chipBanked = addChips(chipReward)
    // Charge the jackpot meter one notch. When it fills, arm the wheel — the win-card Continue then
    // fires it (see continueAfterWin). Persisted immediately, so quitting can't lose progress.
    const meter = bumpJackpotMeter()
    this.jackpotHud?.update(meter)
    this.jackpotArmed = jackpotReady(meter)
    const totalStars = Object.values(save.stars).reduce((sum, s) => sum + s, 0)
    const showCard = (): void => {
      this.showOverlay(true, stars, bonus, chipReward, false, true)
      this.input.once('pointerdown', () => this.overlaySettle?.())
    }
    // §E9 ALL CLEAR (signature moment #6) — a one-time bespoke crescendo the first time she clears the
    // FINAL level. Latched by finaleSeen so it never repeats; a later L100 replay falls back to the
    // normal milestone splash.
    if (this.level >= LEVEL_COUNT && !save.finaleSeen) {
      markFinaleSeen()
      this.time.delayedCall(420, () => this.allClearFinale(totalStars, showCard))
      return
    }
    // Every 10th level is a milestone: a full-screen star-tally splash stands in for Beats 1–2.
    if (this.level % 10 === 0) {
      // The splash already fired the fanfare + heart shower — the card stays calm (celebrate=false)
      // but still runs Beat 4 (elastic entrance + coin roll-up), tap-to-settle.
      this.time.delayedCall(420, () => this.milestoneSplash(totalStars, showCard))
    } else {
      this.runWinSequence(stars, bonus, chipReward)
    }
  }

  /**
   * Gate every post-win transition through the Jackpot Wheel when the meter just filled. If armed, the
   * wheel "explodes" in over the win card (an overlay, no scene-swap), pays its chips, and only THEN
   * runs the original transition `go` on CLAIM — so advancing after the fifth win always fires the
   * wheel exactly once. Not armed → straight through. Routing both Continue buttons here covers every
   * win branch (normal / milestone / all-clear all funnel to this card).
   */
  private continueAfterWin(go: () => void): void {
    if (!this.jackpotArmed) {
      go()
      return
    }
    this.jackpotArmed = false
    openJackpotWheel(this, {
      onClaim: result => {
        resetJackpotMeter()
        this.jackpotHud?.update(0, false)
        this.chipHud?.update(result.newTotal)
        go()
      },
    })
  }

  /** Reduced-motion (OS query OR in-app override) — delegates to the shared theme authority (§E8). */
  private prefersReducedMotion(): boolean {
    return prefersReducedMotion()
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

    // BEAT 0 — the Heartbloom hero win (§E4, signature moment #3). Fires ONLY on the biggest wins:
    // a PERFECT (3-star) clear OR a jackpot strike this round. A giant heart of light blooms from
    // board-center under the Maya leitmotif — LAYERED beneath the existing bloom/flash/rank-word/
    // fireworks/coin-payout, never replacing them. Scarce by construction: plain 1–2 star wins never
    // qualify, and it self-guards to one fire per round. Fired synchronously (not via `at`) so an
    // instant tap-skip can't rob the hero moment. Nothing else here is gated on it.
    if (stars >= 3 || this.jackpotOccurred) this.heartbloom()

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
      // Win bloom's cream camera flash — gated by the reduce-flashing switch (§E8), like the jackpot flash.
      if (!this.reduceFlashing) this.cameras.main.flash(200, 255, 249, 235)
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

    // Slow-spinning gold ray behind the lozenge — static under reduced motion (§E8); the lozenge stays.
    const ray = this.add.image(0, 0, 'sweep').setDisplaySize(560, 96).setAlpha(0.4).setBlendMode(Phaser.BlendModes.ADD)
    if (!this.reducedMotion) this.tweens.add({ targets: ray, angle: 360, duration: 2500, repeat: -1, ease: 'Linear' })

    const T = getTheme()
    const text = this.add
      .text(0, 0, word, { fontFamily: FONT, fontSize: '66px', fontStyle: '900', color: T.navyText })
      .setOrigin(0.5)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(90,70,20,0.22)', 6, true, true)
    const w = text.width + 104
    const h = 130
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.28)
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 8, w, h, h / 2)
    g.fillStyle(T.gold, 1)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(-w / 2 + 13, -h / 2 + 13, w - 26, h - 26, (h - 26) / 2)
    g.lineStyle(5, T.goldDeep, 1)
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

  /**
   * The HEARTBLOOM (§E4, signature moment #3) — Viva Maya's ownable hero-win beat. A giant translucent
   * heart of light (the baked `heartglow`, ADD, tinted the theme's warm `bloom`) blooms from board-
   * center, BEATS TWICE (lub-DUB) on a cadence inspired by Home's ~620/340 emblem heartbeat, and
   * streams heart-particles up from its apex — all under `sfx.mayaMotif()`, the 3-note leitmotif heard
   * NOWHERE else. Perf: 1 ADD sprite + a capped heart stream (~12 live), transient, over a win where
   * nothing else competes (~0.9 FSE). Reduced motion: a single STATIC heart of light — no double-beat,
   * no streaming particles — but the motif still plays (audio isn't motion). Caller gates scarcity;
   * this method self-guards to one fire per round.
   */
  private heartbloom(cx = DESIGN_W / 2, cy = BOARD_Y + BOARD_W / 2): void {
    if (this.heartbloomFired) return
    this.heartbloomFired = true
    sfx.mayaMotif() // the leitmotif rings in BOTH motion modes — audio is never "motion"
    const glow = this.add
      .image(cx, cy, 'heartglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(39) // above the Beat-1 warm bloom (38), below the rank wordmark (46) — a keystone backdrop
      .setTint(getTheme().bloom)
      .setDisplaySize(560, 560)
    const base = glow.scaleX

    if (this.reducedMotion) {
      // Static heart of light: a single soft appear + hold + fade. No double-beat, no strobing, no stream.
      glow.setScale(base).setAlpha(0)
      this.tweens.add({
        targets: glow,
        alpha: 0.4,
        duration: 220,
        ease: 'Quad.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: glow, alpha: 0, delay: 300, duration: 340, onComplete: () => glow.destroy() }),
      })
      return
    }

    // Bloom open, then a lub-DUB doublet (two Back.easeOut swells), then relax + fade out.
    glow.setScale(base * 0.4).setAlpha(0)
    this.tweens.chain({
      targets: glow,
      tweens: [
        { scale: base, alpha: 0.5, duration: 230, ease: 'Back.easeOut' }, // bloom open
        { scale: base * 1.12, duration: 150, ease: 'Back.easeOut' }, // lub
        { scale: base * 0.99, duration: 90, ease: 'Sine.easeInOut' }, // brief diastole
        { scale: base * 1.2, alpha: 0.56, duration: 160, ease: 'Back.easeOut' }, // DUB (the bigger beat)
        { scale: base * 1.06, alpha: 0, delay: 40, duration: 320, ease: 'Quad.easeIn' }, // relax + fade
      ],
      onComplete: () => glow.destroy(),
    })

    // Heart-particles STREAM up from the bloom's apex — a short capped plume (~12 live) timed to the beat.
    const stream = this.add
      .particles(cx, cy - 160, 'heart', {
        speed: { min: 130, max: 300 },
        angle: { min: 250, max: 290 }, // a narrow upward plume (270 = straight up)
        scale: { start: 0.5, end: 0.12 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 600, max: 1000 },
        gravityY: 360,
        rotate: { min: -90, max: 90 },
        quantity: 1,
        frequency: 45, // ~12 emits over the 560ms window → capped live count
        emitting: true,
      })
      .setDepth(45)
    this.time.delayedCall(560, () => stream.active && stream.stop())
    this.time.delayedCall(1700, () => stream.active && stream.destroy())
  }

  /**
   * W2 third-star flourish: a small gold burst crowning the 3rd star as it dings in on the win card —
   * deliberately a tier below the Heartbloom (giant heart of light + leitmotif) that fires on a
   * PERFECT/jackpot win. Rendered ABOVE the card (depth > 41) with its own transient emitter, since the
   * shared spark emitter sits below it. Reduced motion → nothing (the star stays static); the burst is
   * `quality.count()`-gated to nothing on the low tier and self-destroys.
   */
  private thirdStarBurst(x: number, y: number): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const T = getTheme()
    // Soft gold bloom behind the star.
    const bloom = this.add
      .image(x, y, 'bgglow')
      .setTint(T.gold)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(44)
      .setDisplaySize(120, 120)
      .setAlpha(0)
    this.tweens.add({
      targets: bloom,
      alpha: { from: 0.7, to: 0 },
      scaleX: bloom.scaleX * 1.8,
      scaleY: bloom.scaleY * 1.8,
      duration: 420,
      ease: 'Quad.easeOut',
      onComplete: () => bloom.destroy(),
    })
    // Capped gold spark crown above the card (own emitter — the shared one renders under the card).
    const burst = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 70, max: 220 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.7, end: 0 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 300, max: 560 },
        gravityY: 260,
        tint: [T.gold, T.sparkleTint],
        emitting: false,
      })
      .setDepth(45)
    burst.explode(quality.count(12), x, y)
    this.time.delayedCall(640, () => burst.destroy())
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
        color: getTheme().goldText,
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
        color: css(getTheme().rose),
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

  /**
   * §E9 ALL CLEAR (signature moment #6) — the one-time grand finale on clearing the FINAL level.
   * A full marquee celebration + the Heartbloom hero beat + a lingering, staggered heart shower + a
   * heartfelt line, with the owner's private sign-off appended ONLY when maya.secretMessage is set
   * (else a clean generic close). Reuses existing emitters/textures; reduced motion → static text +
   * one soft heart puff, no staggered showers. Latched by finaleSeen upstream — plays once, ever.
   */
  private allClearFinale(totalStars: number, done: () => void): void {
    const reduced = this.reducedMotion
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = 520
    sfx.winFanfare()
    this.time.delayedCall(220, () => sfx.jackpotStrike())
    this.vibrate([80, 60, 140, 60, 220])
    this.flashCabinet() // full marquee celebration (bulbs pop + reddish glow surge)
    // The Heartbloom hero beat, centred (self-guards to one fire — may already be lit on a 3★ clear).
    this.heartbloom(cx, cy + 40)
    // A lingering heart shower — staggered bursts (one soft puff under reduced motion).
    this.overlayHearts(cx, reduced ? 12 : 28, cy - 20)
    if (!reduced) {
      this.time.delayedCall(450, () => this.overlayHearts(cx - 150, 20, cy + 60))
      this.time.delayedCall(900, () => this.overlayHearts(cx + 150, 20, cy - 80))
      this.time.delayedCall(1400, () => this.overlayHearts(cx, 24, cy + 20))
    }

    const layer = this.add.container(0, 0).setDepth(48)
    const title = this.add
      .text(cx, cy - 150, 'ALL CLEAR', { fontFamily: FONT, fontSize: '80px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setLetterSpacing(3)
      .setStroke('#ffffff', 10)
      .setShadow(0, 4, 'rgba(0,0,0,0.22)', 10, true, true)
    const tally = this.add
      .text(cx, cy - 78, `★  ${LEVEL_COUNT} LEVELS  ·  ${totalStars} STARS  ★`, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: css(T.rose),
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 6)
    // The heartfelt line — always-on, non-name. Owner sign-off appended ONLY when secretMessage is set.
    const sign = maya.secretMessage?.trim()
    const heartfelt =
      sign && sign.length > 0
        ? `You finished every level.\nThank you for playing. ♥\n\n${sign}`
        : 'You finished every level.\nThank you for playing. ♥'
    // Drawn over the ALWAYS-cream board (not the backdrop) → use the cream-safe ink (dark on every
    // theme) + a white stroke so it stays legible under the celebration, even on the dark themes.
    const line = this.add
      .text(cx, cy + 150, heartfelt, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '700',
        color: T.ink,
        align: 'center',
        lineSpacing: 8,
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 5)
      .setShadow(0, 2, 'rgba(0,0,0,0.18)', 5, false, true)
    layer.add([title, tally, line])

    if (reduced) {
      title.setScale(0.92)
      this.time.delayedCall(2800, () =>
        this.tweens.add({ targets: layer, alpha: 0, duration: 340, onComplete: () => { layer.destroy(); done() } })
      )
      return
    }
    title.setScale(0)
    tally.setAlpha(0)
    line.setAlpha(0).setY(cy + 162)
    this.tweens.add({ targets: title, scale: 1, duration: 420, ease: 'Back.easeOut' })
    this.tweens.add({ targets: tally, alpha: 1, duration: 320, delay: 320, ease: 'Sine.easeOut' })
    this.tweens.add({ targets: line, alpha: 1, y: cy + 150, duration: 420, delay: 720, ease: 'Sine.easeOut' })
    this.time.delayedCall(3800, () =>
      this.tweens.add({ targets: layer, alpha: 0, duration: 360, onComplete: () => { layer.destroy(); done() } })
    )
  }

  /**
   * §E9 special-date dress-up (signature moment #5) — on a configured occasion (once per day) fire a
   * heart-shower over the board, the in-game "it knew" touch. Dormant with the default empty
   * occasions[]. Reduced motion → a single static heart, no shower.
   */
  private maybeOccasion(): void {
    const today = todayKey()
    if (!pendingOccasion(today, loadSave().occasionsSeen)) return
    markOccasionSeen(today)
    if (this.reducedMotion) {
      const h = this.add.image(DESIGN_W / 2, BOARD_Y + BOARD_W / 2, 'heartbig').setDisplaySize(90, 90).setDepth(45).setAlpha(0.85)
      this.time.delayedCall(1400, () => h.destroy())
      return
    }
    this.overlayHearts(DESIGN_W / 2, 22, BOARD_Y + BOARD_W / 2)
  }

  /** Dim scrim behind an end-of-round overlay (also swallows taps meant for the board). */
  private overlayScrim(): void {
    this.clearSelection()
    this.add.rectangle(DESIGN_W / 2, 640, DESIGN_W, worldH(), getTheme().scrim, 0.5).setDepth(40).setInteractive()
  }

  /** Shared rounded result card, centered at (cx, cy) with half-height halfH. */
  private overlayCard(cx: number, cy: number, halfH: number): void {
    const T = getTheme()
    const g = this.add.graphics().setDepth(41)
    g.fillStyle(T.shadow, 0.25)
    g.fillRoundedRect(cx - 260 + 4, cy - halfH + 8, 520, halfH * 2, 34)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(cx - 260, cy - halfH, 520, halfH * 2, 34)
    g.lineStyle(4, T.goldBezel, 1)
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
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = 590
    const halfH = 230
    const w = 520
    // Everything lives in ONE container (mirroring buildWinCard) so the card can gently scale + fade
    // in as a unit — a calm settle rather than the old hard appear. Depth 41 sits above the scrim (40).
    const card = this.add.container(cx, cy).setDepth(41)

    // Card panel (cream + gold bezel) — inlined from overlayCard at container-relative coords so the
    // backdrop scales together with the contents during the entrance.
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.25)
    g.fillRoundedRect(-w / 2 + 4, -halfH + 8, w, halfH * 2, 34)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    card.add(g)

    // §E9 warm lose copy — a kind rotating line instead of the cold "OUT OF MOVES". Seeded by score
    // so it stays stable for this result. Navy (not the warn colour) reads as gentle, not an error.
    card.add(
      this.add
        .text(0, -160, warmLoseLine(this.score), { fontFamily: FONT, fontSize: '42px', fontStyle: '900', color: T.navyText })
        .setOrigin(0.5)
        .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
    )

    // Show WHICH symbols still need collecting (icon + count), not bare numbers — a learning player
    // reads "which ones do I still need?" at a glance. A finished goal dims to a green check.
    const objs = this.objectives
    card.add(
      this.add
        .text(0, -112, 'STILL NEEDED', { fontFamily: FONT, fontSize: '18px', color: T.inkMuted })
        .setOrigin(0.5)
        .setLetterSpacing(3)
    )
    // "So close" emphasis — the nearest-to-complete goal (smallest count still OWED) gets a soft warm
    // shimmer below, so a loss reads as "you almost had this". Only the single nearest one is picked;
    // nearIdx stays -1 if nothing is owed (never on a real loss), which harmlessly skips the highlight.
    let nearIdx = -1
    let nearRem = Infinity
    objs.forEach((o, i) => {
      if (o.remaining > 0 && o.remaining < nearRem) {
        nearRem = o.remaining
        nearIdx = i
      }
    })
    const slotW = 94
    const x0 = -((objs.length - 1) * slotW) / 2
    let nearIcon: Phaser.GameObjects.Image | undefined
    let nearHalo: Phaser.GameObjects.Image | undefined
    objs.forEach((o, i) => {
      const ox = x0 + i * slotW
      const done = o.remaining <= 0
      if (i === nearIdx) {
        // Soft gold glow radiating from the nearest symbol (ADD, tucked BEHIND the icon). Rests at a
        // static soft alpha under reduced motion; breathes otherwise (gated with the entrance below).
        nearHalo = this.add
          .image(ox, -66, 'bgglow')
          .setTint(T.gold)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(84, 84)
          .setAlpha(this.reducedMotion ? 0.5 : 0.26)
        card.add(nearHalo)
      }
      const icon = this.add.image(ox, -66, o.symbol).setDisplaySize(48, 48).setAlpha(done ? 0.4 : 1)
      card.add(icon)
      if (i === nearIdx) nearIcon = icon
      card.add(
        this.add
          .text(ox, -30, done ? '✓' : String(o.remaining), {
            fontFamily: FONT,
            fontSize: '26px',
            fontStyle: '900',
            color: done ? T.ok : T.ink,
          })
          .setOrigin(0.5)
      )
    })

    card.add(
      this.add
        .text(0, 10, `SCORE  ${this.score.toLocaleString()}`, {
          fontFamily: FONT,
          fontSize: '34px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0.5)
    )

    // A loss spent a life — show what's left + when the next one lands.
    const livesHud = addLivesHud(this, 0, 56, { size: 28 })
    card.add(livesHud.container)
    const refresh = (): void => livesHud.update(refreshLives())
    refresh()
    this.time.addEvent({ delay: 1000, loop: true, callback: refresh })

    card.add(addPillButton(this, 0, 140, 300, 72, 'RETRY', GOLD_PILL, () => startScene(this,'game', { level: this.level })))
    card.add(addPillButton(this, 0, 140 + 84, 300, 60, 'LEVELS', GHOST_PILL, () => startScene(this,'levelselect')))

    // Entrance — mirror buildWinCard's calm Back.easeOut settle, from a slightly smaller scale + a
    // fade, so the card eases in rather than snapping. Reduced motion → instant card (today's feel).
    if (!this.reducedMotion) {
      card.setScale(0.9).setAlpha(0)
      this.tweens.add({ targets: card, scale: 1, alpha: 1, duration: 320, ease: 'Back.easeOut' })
    }
    // Shimmer the nearest goal once the card has settled — a gentle icon + halo breath (soft tint/
    // scale, never a hard flash). Reduced motion keeps the static highlight above, no breathing.
    if (nearIcon && !this.reducedMotion) {
      this.tweens.add({ targets: nearIcon, scale: nearIcon.scale * 1.08, duration: 900, yoyo: true, repeat: -1, delay: 320, ease: 'Sine.easeInOut' })
      if (nearHalo) {
        this.tweens.add({ targets: nearHalo, alpha: 0.5, duration: 900, yoyo: true, repeat: -1, delay: 320, ease: 'Sine.easeInOut' })
      }
    }
  }

  /**
   * Beat 4 — the win result card: an elastic scale-in entrance (0→1.06→1), the rank-word
   * title, a star row with ascending dings, and the COIN ROLL-UP PAYOUT (a chip pile on a gold
   * disc with chips flying in as a counter rolls 0→chipReward). Everything lives in one container
   * so the card can scale as a unit; `animate=false` builds it fully settled (tap-to-skip lands
   * here). Never occludes the reward number or the Continue button.
   */
  private buildWinCard(stars: number, bonus: number, chipReward: number, animate: boolean): void {
    const T = getTheme()
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
    g.fillStyle(T.shadow, 0.25)
    g.fillRoundedRect(-w / 2 + 4, -halfH + 8, w, halfH * 2, 34)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    g.lineStyle(4, T.gold, 1)
    g.strokeRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    card.add(g)

    // "LEVEL N" gold pill tab straddling the top edge.
    const tab = this.add.container(0, -halfH)
    const tabLabel = this.add
      .text(0, 0, `LEVEL ${this.level}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.goldPillText })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    const tw = tabLabel.width + 56
    const tg = this.add.graphics()
    tg.fillStyle(T.gold, 1)
    tg.fillRoundedRect(-tw / 2, -26, tw, 52, 26)
    tg.lineStyle(3, T.goldDeep, 1)
    tg.strokeRoundedRect(-tw / 2, -26, tw, 52, 26)
    tab.add([tg, tabLabel])
    card.add(tab)

    // Rank-word title.
    const title = this.add
      .text(0, -216, this.rankWord(stars), { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
    card.add(title)

    // §E9 warm subtitle under the rank word — always-on, non-name gentle encouragement (seeded by
    // score so it stays stable for this result).
    card.add(
      this.add
        .text(0, -176, warmWinSubtitle(this.score), { fontFamily: FONT, fontSize: '20px', fontStyle: '700', color: T.inkSoft })
        .setOrigin(0.5)
    )

    // §E9 NEW BEST! ribbon — a small rose banner across the card's top-left corner on a record score.
    if (this.newBestThisWin) {
      const ribbon = this.add.container(-156, -252).setAngle(-16)
      const rt = this.add.text(0, 0, 'NEW BEST!', { fontFamily: FONT, fontSize: '21px', fontStyle: '900', color: T.onRose }).setOrigin(0.5)
      const rw = rt.width + 40
      const rh = 42
      const rg = this.add.graphics()
      rg.fillStyle(T.shadow, 0.25)
      rg.fillRoundedRect(-rw / 2 + 2, -rh / 2 + 3, rw, rh, rh / 2)
      rg.fillStyle(T.rose, 1)
      rg.fillRoundedRect(-rw / 2, -rh / 2, rw, rh, rh / 2)
      rg.lineStyle(3, T.roseDeep, 1)
      rg.strokeRoundedRect(-rw / 2, -rh / 2, rw, rh, rh / 2)
      ribbon.add([rg, rt])
      card.add(ribbon)
      if (animate) {
        ribbon.setScale(0)
        this.tweens.add({ targets: ribbon, scale: 1, delay: 360, duration: 300, ease: 'Back.easeOut' })
        settleActions.push(() => ribbon.setScale(1))
      }
    }

    // Faint static gold ray behind the star row.
    const ray = this.add.image(0, -122, 'sweep').setDisplaySize(440, 96).setAlpha(0.22).setBlendMode(Phaser.BlendModes.ADD)
    card.add(ray)

    // Star row (earned stars pop in with ascending dings).
    for (let i = 0; i < 3; i++) {
      const earned = i < stars
      const star = this.add.image((i - 1) * 84, -122, 'star').setAlpha(earned ? 1 : 0.22)
      const finalScale = (earned ? 1 : 0.8) * (68 / 128) // 128 = 'star' native size (baked larger for hi-DPI)
      card.add(star)
      if (animate) {
        star.setScale(0)
        const delay = 150 + i * 160
        this.tweens.add({ targets: star, scale: finalScale, delay, duration: 260, ease: 'Back.easeOut' })
        if (earned)
          at(delay, () => {
            sfx.starDing(i)
            // W2: crown the 3rd (max) star with a small gold burst — a tier below the Heartbloom, which
            // already fires on a PERFECT/jackpot win. cx/cy are the card's rest coords; the star sits at
            // local ((i-1)*84, -122). Self-gates to nothing under reduced motion / low tier.
            if (i === 2) this.thirdStarBurst(cx + (i - 1) * 84, cy - 122)
          })
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
          color: T.navyText,
        })
        .setOrigin(0.5)
    )
    if (bonus > 0) {
      card.add(
        this.add.text(0, -6, `+${bonus.toLocaleString()} moves bonus`, { fontFamily: FONT, fontSize: '20px', color: T.goldText }).setOrigin(0.5)
      )
    }

    // COIN ROLL-UP PAYOUT.
    this.buildCoinPayout(card, chipReward, animate, at, settleActions)

    // Continue buttons. When the jackpot meter just filled, these route through the wheel first
    // (continueAfterWin) so it fires exactly once, then performs the original transition.
    const nextExists = this.level < LEVEL_COUNT
    const nextBtn = addPillButton(this, 0, 176, 300, 72, nextExists ? 'NEXT LEVEL' : 'ALL CLEAR!', GOLD_PILL, () => {
      this.continueAfterWin(() => {
        if (nextExists) startScene(this,'game', { level: this.level + 1 })
        else startScene(this,'levelselect', { fromWin: true })
      })
    })
    // Beat 5: a soft gold glow-ring pulse behind the Continue pill to lead the eye. Gated (§E8):
    // reduced motion rests it at a static soft glow, no pulse.
    const glow = this.add.image(0, 176, 'bgglow').setTint(T.gold).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(360, 150).setAlpha(this.reducedMotion ? 0.28 : 0.18)
    card.add(glow)
    if (!this.reducedMotion) this.tweens.add({ targets: glow, alpha: 0.42, duration: 780, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    card.add(nextBtn)
    card.add(
      addPillButton(this, 0, 176 + 84, 300, 60, 'LEVELS', GHOST_PILL, () =>
        this.continueAfterWin(() => startScene(this,'levelselect', { fromWin: true }))
      )
    )

    // §Jackpot — when the meter just filled, a glowing "JACKPOT READY" banner crowns the card (above
    // the top edge, clear of the LEVEL tab) to telegraph that the wheel explodes in on Continue.
    if (this.jackpotArmed) {
      const ready = this.add.container(0, -halfH - 50)
      const rt = this.add
        .text(0, 0, '🎰  JACKPOT READY!', { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.onRose })
        .setOrigin(0.5)
      const rw = rt.width + 44
      const rg = this.add.graphics()
      rg.fillStyle(T.shadow, 0.25)
      rg.fillRoundedRect(-rw / 2 + 2, -21 + 3, rw, 42, 21)
      rg.fillStyle(T.rose, 1)
      rg.fillRoundedRect(-rw / 2, -21, rw, 42, 21)
      rg.lineStyle(3, T.goldBright, 1)
      rg.strokeRoundedRect(-rw / 2, -21, rw, 42, 21)
      const rglow = this.add.image(0, 0, 'bgglow').setTint(T.rose).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(rw + 60, 90).setAlpha(this.reducedMotion ? 0.3 : 0.2)
      ready.add([rglow, rg, rt])
      card.add(ready)
      if (!this.reducedMotion) this.tweens.add({ targets: rglow, alpha: 0.5, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }

    // Rose skip/close chip (top-right) — a tap jumps straight to the settled card.
    if (animate) {
      const close = this.add.container(w / 2 - 40, -halfH + 40)
      const cg = this.add.graphics()
      cg.fillStyle(T.rose, 1)
      cg.fillCircle(0, 0, 22)
      cg.lineStyle(3, T.roseDeep, 1)
      cg.strokeCircle(0, 0, 22)
      const cIcon = this.add.text(0, 0, '»', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.onRose }).setOrigin(0.5)
      // Invisible hit circle grown to the ≥44pt floor (§E8) — the visual chip (r22) is unchanged.
      const cZone = this.add.circle(0, 0, 42, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
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
    const T = getTheme()
    const py = 74
    const pileX = -96

    // Soft gold disc behind the pile.
    card.add(this.add.image(pileX, py, 'bgglow').setTint(T.goldBezel).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(150, 150).setAlpha(0.5))

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
    card.add(this.add.text(58, py - 34, 'REWARD', { fontFamily: FONT, fontSize: '18px', color: T.inkMuted }).setOrigin(0, 0.5).setLetterSpacing(2))
    const counter = this.add
      .text(58, py + 8, animate ? '0' : String(chipReward), { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: T.navyText })
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
        color: isRecord ? getTheme().goldText : getTheme().navyText,
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)

    this.add
      .text(cx, cy - 92, 'YOUR SCORE', { fontFamily: FONT, fontSize: '20px', color: getTheme().inkMuted })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(2)
    this.add
      .text(cx, cy - 44, score.toLocaleString(), {
        fontFamily: FONT,
        fontSize: '58px',
        fontStyle: '900',
        color: getTheme().ink,
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)

    this.add
      .text(cx, cy + 34, "THIS WEEK'S BEST", { fontFamily: FONT, fontSize: '20px', color: getTheme().inkMuted })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(2)
    this.add
      .text(cx, cy + 74, best.toLocaleString(), {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: getTheme().goldText,
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
    // §E3/B14: a tiny key-locked tick partners a CHUNKY climb (the in-game readout roll is otherwise
    // silent — the win-card coin roll-up already has coinCount, so we don't double up there). ≥120
    // mirrors scorePunch's chunky threshold, but audio fires in both motion modes.
    if (gain >= 120) sfx.scoreTick()
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
    // W3: crossing a round milestone (10k/25k/50k…) gets its OWN gold pop — richer than the per-gain
    // scorePunch and mutually exclusive with it, so the two never fight over the readout the same frame.
    // The pointer always advances on a crossing (skipping any it leaps past); the pop is held during play.
    if (this.score >= this.scoreMilestone) {
      const crossed = this.scoreMilestone
      this.scoreMilestone = this.nextScoreMilestone(this.score)
      if (this.state !== 'ended') this.scoreMilestonePop(crossed)
    } else {
      this.scorePunch(gain)
    }
  }

  /**
   * 3c: a scale punch + brief gold tint flash on the SCORE read-out for chunky gains (≥120 pts).
   * Only during a resolve (mutually exclusive with the idle nudge, and skips the finishWin bonus,
   * which runs in 'ended'). Reduced-motion: instant (no punch — the counter still rolls).
   */
  private scorePunch(gain: number): void {
    if (this.reducedMotion || gain < 120 || this.state !== 'resolving' || !this.scoreText) return
    this.scoreText.setColor(css(getTheme().gold))
    this.time.delayedCall(180, () => this.scoreText?.setColor(getTheme().onBackdropInk))
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

  /** W3: the smallest 1 / 2.5 / 5 ×10ⁿ milestone strictly above `v` (…10k, 25k, 50k, 100k, 250k, 500k…). */
  private nextScoreMilestone(v: number): number {
    for (let exp = 4; exp < 15; exp++) {
      for (const mant of [1, 2.5, 5]) {
        const m = mant * Math.pow(10, exp)
        if (m > v) return m
      }
    }
    return Math.pow(10, 15) // unreachable for any real score
  }

  /**
   * W3 score-milestone pop: a one-off gold flash + tick + scale kick on the HUD readout when the rolling
   * score crosses a round threshold — a bigger, rarer sibling of scorePunch. Reduced motion → the colour
   * flash + tick only (no scale, no glow); the extra bright glow rides the reduce-flashing gate, and the
   * glow is `quality.count()`-gated. The threshold is passed for future copy but the pop is generic.
   */
  private scoreMilestonePop(_threshold: number): void {
    if (!this.scoreText) return
    const T = getTheme()
    sfx.scoreTick() // reuse the score tick — audio fires in both motion modes
    this.scoreText.setColor(css(T.gold))
    this.time.delayedCall(260, () => this.scoreText?.setColor(getTheme().onBackdropInk))
    if (this.reducedMotion) return
    // Scale kick — a notch beyond scorePunch's 1.15.
    this.scorePunchTween?.stop()
    this.scoreText.setScale(1)
    this.scorePunchTween = this.tweens.add({
      targets: this.scoreText,
      scale: 1.3,
      duration: 160,
      yoyo: true,
      ease: 'Back.easeOut',
    })
    // A brief gold flare over the readout — an extra flash, so it rides the reduce-flashing gate.
    if (!this.reduceFlashing && quality.count(1) > 0) {
      const flare = this.add
        .image(this.scoreText.x - this.scoreText.width / 2, this.scoreText.y + this.scoreText.height / 2, 'bgglow')
        .setTint(T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(5)
        .setDisplaySize(200, 90)
        .setAlpha(0)
      this.tweens.add({
        targets: flare,
        alpha: { from: 0.5, to: 0 },
        scaleX: flare.scaleX * 1.5,
        scaleY: flare.scaleY * 1.5,
        duration: 420,
        ease: 'Quad.easeOut',
        onComplete: () => flare.destroy(),
      })
    }
  }

  /**
   * E11 continuous combo counter: ONE reused readout over the board — not a fresh text per wave. Each
   * new cascade wave PUNCHES it in place (scale pop) and HEAT-RAMPS it warm→hot (x2 warm gold → x3 hot
   * amber → x4+ hot rose/red), with a subtle per-wave scale ramp so a deep chain reads as one rising
   * crescendo that resolves into the win fanfare (see fadeCombo, called when the cascade settles). At
   * x4+ it fires the MEGA peak (jackpot strike + haptic + marquee flash), matching the prior behaviour.
   * Reduced motion keeps the counter + number but drops the punch + colour-pulse (static set).
   */
  private showCombo(cascade: number): void {
    const big = cascade >= 4
    if (big) {
      sfx.jackpotStrike()
      this.vibrate([60, 40, 120])
      this.flashCabinet() // mega peak: pop the marquee lights
    }
    // §E3/E11/B14: a low bass bed ratchets UP a step per cascade wave and resolves into winFanfare —
    // the audio arc mirrors the visual combo arc. ONE voice, retriggered per wave (never accumulates).
    // Reduced motion drops this sustained riser (E11), matching its dropped colour-pulse.
    if (!this.reducedMotion) sfx.cascadeRiser(cascade)
    const label = big ? 'MEGA WIN!' : `COMBO x${cascade}`
    // Heat ramp: x2 warm gold → x3 hot amber → x4+ hot rose/red.
    const heat = cascade <= 2 ? getTheme().goldText : cascade === 3 ? css(getTheme().gold) : css(getTheme().rose)
    const cy = BOARD_Y + BOARD_W / 2 - 40
    if (!this.comboText || !this.comboText.active) {
      this.comboText = this.add
        .text(DESIGN_W / 2, cy, label, { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: heat })
        .setOrigin(0.5)
        .setDepth(30)
        .setStroke('#ffffff', 8)
        .setShadow(0, 4, 'rgba(0,0,0,0.2)', 8, true, true)
    }
    const t = this.comboText
    this.comboTween?.stop() // cancel a live punch/fade so waves never stack scale/alpha
    this.comboTween = null
    t.setText(label).setColor(heat).setPosition(DESIGN_W / 2, cy).setAlpha(1)
    // Subtle scale ramp — the resting size grows as the chain deepens (capped), the visual crescendo.
    const base = Math.min(1.5, 0.9 + cascade * 0.1)
    if (this.reducedMotion) {
      t.setScale(base) // static: number + heat colour, no punch/pulse
      return
    }
    // Punch in place: reset to rest, then a quick scale pop (killed + restarted per wave so no stacking).
    t.setScale(base)
    this.comboTween = this.tweens.add({
      targets: t,
      scale: base * 1.28,
      duration: 150,
      yoyo: true,
      ease: 'Quad.easeOut',
    })
  }

  /**
   * E11: resolve the combo counter once the cascade settles — a soft fade-up-out of the ONE reused
   * object (not destroyed; the next cascade re-shows it). No-op if nothing showed this resolve.
   * Reduced motion: a brief hold, then an instant hide.
   */
  private fadeCombo(): void {
    sfx.riserResolve() // §E11: the cascade settled — resolve the riser (fades into winFanfare on a win)
    const t = this.comboText
    if (!t || !t.active || t.alpha === 0) return
    this.comboTween?.stop()
    this.comboTween = null
    if (this.reducedMotion) {
      this.time.delayedCall(220, () => t.active && t.setAlpha(0))
      return
    }
    this.comboTween = this.tweens.add({
      targets: t,
      alpha: 0,
      y: t.y - 60,
      delay: 200,
      duration: 420,
      ease: 'Sine.easeIn',
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
        color: css(getTheme().gold),
        fontStyle: '900',
      })
      .setOrigin(0.5)
      .setDepth(28)
      .setStroke(getTheme().navyText, 6)
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

  /** Board column → equal-power stereo pan (§A8): left column hears left, right hears right (softened 0.7). */
  private colPan(col: number): number {
    return COLS > 1 ? ((col / (COLS - 1)) * 2 - 1) * 0.7 : 0
  }

  /** Haptic buzz, guarded for browsers without the Vibration API + the a11y haptics-off switch (§E8). */
  private vibrate(pattern: number | number[]): void {
    if (hapticsOff()) return
    if ('vibrate' in navigator) navigator.vibrate?.(pattern)
  }
}

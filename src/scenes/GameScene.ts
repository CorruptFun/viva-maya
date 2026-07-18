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
import { mulberry32 } from '../core/rng'
import { loadSave, recordResult, recordScore, takePendingBoosts } from '../core/save'
import { SYMBOLS, key } from '../core/types'
import type { BoostType, ClearWave, Coord, FallMove, LevelSpec, Piece, Spawn, SymbolType } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { TEX_SIZE, ensurePieceTexture } from '../view/textures'
import { FONT, GHOST_PILL, GOLD_PILL, ROSE_PILL, addMuteChip, addPillButton } from '../view/ui'

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
  private state: GameState = 'idle'

  private movesLeft = 0
  private objectives: ObjectiveState[] = []
  private movesText!: Phaser.GameObjects.Text

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

  private autoplay = false
  private autoplayDelay = 450
  private activeBoosts: BoostType[] = []
  private scoreMult = 1
  private endless = false
  private endlessBest = 0
  private endlessWeekKey = ''
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
    this.sid = Math.floor(Math.random() * 10000)
    this.log('create', location.search, this.endless ? 'ENDLESS' : `level ${this.level}`)
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
    this.selected = null
    this.selectedSprite = null
    this.selectPulse = null
    this.dragFrom = null
    this.scoreMult = 1
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
    this.buildHud()
    this.buildPieceLayer()
    this.buildParticles()

    if (this.scoreMult > 1) {
      this.add
        .text(BOARD_X + BOARD_W - 128, 66, '×2', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: '#c9930a' })
        .setOrigin(1, 0)
    }
    if (this.activeBoosts.length > 0) this.showBoostBanner(this.activeBoosts)

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p))
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p))
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p))

    if (import.meta.env.DEV) {
      this.updateDebug()
      this.time.addEvent({ delay: 300, loop: true, callback: () => this.updateDebug() })
    }
    this.scheduleAutoplay()
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
    const g = this.add.graphics()
    const pad = 18
    const x = BOARD_X - pad
    const y = BOARD_Y - pad
    const size = BOARD_W + pad * 2
    g.fillStyle(0x8a7a52, 0.1)
    g.fillRoundedRect(x + 3, y + 7, size, size, 26)
    g.fillStyle(0x8a7a52, 0.07)
    g.fillRoundedRect(x + 6, y + 12, size, size, 26)
    g.fillStyle(0xfffdf8, 1)
    g.fillRoundedRect(x, y, size, size, 26)
    g.lineStyle(2, 0xe8dfc9, 1)
    g.strokeRoundedRect(x, y, size, size, 26)
    g.lineStyle(3, 0xf2c14e, 0.65)
    g.strokeRoundedRect(x + 7, y + 7, size - 14, size - 14, 19)
    g.fillStyle(0xb49b62, 0.08)
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if ((r + c) % 2 === 0) g.fillRect(BOARD_X + c * CELL, BOARD_Y + r * CELL, CELL, CELL)
      }
    }
  }

  private buildHud(): void {
    // Top row: back · LEVEL N (or ENDLESS) · score.
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => this.scene.start('levelselect'))
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
      this.objectives.forEach((o, i) => {
        const cx = BOARD_X + BOARD_W - chipW / 2 - (this.objectives.length - 1 - i) * (chipW + chipGap)
        const chip = this.add.container(cx, cardY)
        const cg = this.add.graphics()
        cg.fillStyle(0x8a7a52, 0.12)
        cg.fillRoundedRect(-chipW / 2 + 2, -52 + 5, chipW, 104, 20)
        cg.fillStyle(0xffffff, 1)
        cg.fillRoundedRect(-chipW / 2, -52, chipW, 104, 20)
        cg.lineStyle(2, 0xe8dfc9, 1)
        cg.strokeRoundedRect(-chipW / 2, -52, chipW, 104, 20)
        chip.add(cg)
        const icon = this.add.image(0, -18, o.symbol)
        icon.setDisplaySize(46, 46)
        chip.add(icon)
        o.text = this.add
          .text(0, 26, String(o.remaining), { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: '#2a2732' })
          .setOrigin(0.5)
        chip.add(o.text)
        o.chip = chip
      })
    }

    this.add
      .text(
        DESIGN_W / 2,
        988,
        this.endless ? "Biggest score wins this week's board" : 'Collect the goal symbols before moves run out',
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
    const sprite = this.add.sprite(pos.x, pos.y - dropCells * CELL, ensurePieceTexture(this, piece))
    sprite.setDisplaySize(PIECE_SIZE, PIECE_SIZE)
    this.pieceLayer.add(sprite)
    this.sprites.set(piece.id, sprite)
    return sprite
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
    sfx.swapWhoosh()

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
        return
      }
      wave = this.board.matchWave([b, a])
    }

    this.movesLeft--
    this.movesText.setText(String(this.movesLeft))
    if (this.movesLeft <= 5) this.movesText.setColor('#d3302f')
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
        sfx.reelSweep()
        const at = this.cellToXY(e.at)
        const sweep = this.add.image(e.horizontal ? BOARD_X + BOARD_W / 2 : at.x, e.horizontal ? at.y : BOARD_Y + BOARD_W / 2, 'sweep')
        sweep.setDepth(25)
        if (e.horizontal) sweep.setDisplaySize(BOARD_W + 24, CELL * 0.72)
        else {
          sweep.setDisplaySize(BOARD_W + 24, CELL * 0.72)
          sweep.setAngle(90)
        }
        sweep.setAlpha(0)
        this.tweens.add({
          targets: sweep,
          alpha: { from: 0, to: 0.95 },
          duration: 90,
          yoyo: true,
          hold: 110,
          onComplete: () => sweep.destroy(),
        })
        effectMs = Math.max(effectMs, 290)
      } else if (e.type === 'bomb') {
        sfx.bombBoom()
        this.vibrate(30)
        const at = this.cellToXY(e.at)
        this.cameras.main.shake(140 + e.radius * 60, 0.006 + e.radius * 0.004)
        this.sparkEmitter.explode(18 + e.radius * 14, at.x, at.y)
        effectMs = Math.max(effectMs, 220)
      } else {
        sfx.jackpotStrike()
        this.cameras.main.flash(280, 255, 214, 90)
        this.cameras.main.shake(240, 0.008)
        effectMs = Math.max(effectMs, 320)
      }
    }

    // Scoring + objectives (specials count as their symbol; jackpot pieces don't).
    for (const { piece } of wave.cleared) {
      if (piece.kind === 'jackpot') continue
      const obj = this.objectives.find(o => o.symbol === piece.symbol)
      if (obj && obj.remaining > 0) {
        obj.remaining--
        obj.text?.setText(obj.remaining > 0 ? String(obj.remaining) : '✓')
        if (obj.remaining === 0) obj.text?.setColor('#2fae4c')
      }
    }
    for (const o of this.objectives) {
      if (o.chip && o.chip.scale === 1) {
        this.tweens.add({ targets: o.chip, scale: 1.08, duration: 110, yoyo: true })
      }
    }
    this.addScore(wave.cleared.length * POINTS_PER_PIECE * cascade)
    if (cascade >= 2) {
      this.showCombo(cascade)
      this.cameras.main.shake(100 + cascade * 30, 0.002 + 0.0012 * Math.min(cascade, 5))
    }

    // Pop cleared sprites, staggered outward from the first effect's epicenter.
    const epicenter = wave.events[0]?.at ?? pops[0]?.at
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
    }

    promises.push(new Promise(resolve => this.time.delayedCall(effectMs, () => resolve())))
    await Promise.all(promises)
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
    const movesFrac = this.movesLeft / this.spec.moves
    const stars = movesFrac >= 0.5 ? 3 : movesFrac >= 0.25 ? 2 : 1
    const bonus = this.movesLeft * MOVES_BONUS
    if (bonus > 0) this.addScore(bonus)
    const save = recordResult(this.level, stars, this.score)
    // Every 10th level is a milestone: a full-screen star-tally splash before the result card.
    const milestone = this.level % 10 === 0
    const totalStars = Object.values(save.stars).reduce((sum, s) => sum + s, 0)
    if (milestone) {
      // The splash already showered hearts + fanfare — the result card stays calm (celebrate=false).
      this.time.delayedCall(420, () => this.milestoneSplash(totalStars, () => this.showOverlay(true, stars, bonus, false)))
    } else {
      this.time.delayedCall(500, () => this.showOverlay(true, stars, bonus))
    }
  }

  private finishLose(): void {
    this.log('finishLose')
    this.state = 'ended'
    recordScore(this.score)
    this.time.delayedCall(400, () => this.showOverlay(false, 0, 0))
  }

  private finishEndless(): void {
    this.log('finishEndless')
    this.state = 'ended'
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

  private showOverlay(win: boolean, stars: number, bonus: number, celebrate = true): void {
    this.log('showOverlay', win ? 'win' : 'lose', 'stars', stars, 'bonus', bonus)
    this.overlayScrim()

    if (win) {
      // celebrate=false when a milestone splash already played the fanfare + heart shower.
      if (celebrate) {
        sfx.winFanfare()
        this.vibrate(80)
        this.overlayHearts(DESIGN_W / 2, 26)
      }
    } else {
      sfx.loseWah()
    }

    const cx = DESIGN_W / 2
    const cy = 590
    this.overlayCard(cx, cy, 230)

    this.add
      .text(cx, cy - 160, win ? 'LEVEL CLEAR!' : 'OUT OF MOVES', {
        fontFamily: FONT,
        fontSize: '48px',
        fontStyle: '900',
        color: win ? '#c9930a' : '#d3302f',
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)

    if (win) {
      for (let i = 0; i < 3; i++) {
        const star = this.add
          .image(cx + (i - 1) * 84, cy - 70, 'star')
          .setDepth(42)
          .setAlpha(i < stars ? 1 : 0.22)
          .setScale(0)
        const delay = 150 + i * 160
        this.tweens.add({
          targets: star,
          scale: (i < stars ? 1 : 0.8) * (68 / 64),
          delay,
          duration: 260,
          ease: 'Back.easeOut',
        })
        // Ascending bell ding synced to each earned star's pop-in.
        if (i < stars) this.time.delayedCall(delay, () => sfx.starDing(i))
      }
    } else {
      const goals = this.objectives.map(o => `${o.remaining > 0 ? o.remaining : '✓'}`).join('   ')
      this.add
        .text(cx, cy - 70, `Still needed:  ${goals}`, {
          fontFamily: FONT,
          fontSize: '26px',
          color: '#8a8577',
        })
        .setOrigin(0.5)
        .setDepth(42)
    }

    this.add
      .text(cx, cy + 10, `SCORE  ${this.score.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: '#2a2732',
      })
      .setOrigin(0.5)
      .setDepth(42)
    if (win && bonus > 0) {
      this.add
        .text(cx, cy + 58, `+${bonus.toLocaleString()} moves bonus`, {
          fontFamily: FONT,
          fontSize: '22px',
          color: '#c9930a',
        })
        .setOrigin(0.5)
        .setDepth(42)
    }

    const nextExists = win && this.level < LEVEL_COUNT
    if (win) {
      addPillButton(this, cx, cy + 140, 300, 72, nextExists ? 'NEXT LEVEL' : 'ALL CLEAR!', GOLD_PILL, () => {
        if (nextExists) this.scene.start('game', { level: this.level + 1 })
        else this.scene.start('levelselect')
      }).setDepth(42)
    } else {
      addPillButton(this, cx, cy + 140, 300, 72, 'RETRY', GOLD_PILL, () =>
        this.scene.start('game', { level: this.level })
      ).setDepth(42)
    }
    addPillButton(this, cx, cy + 140 + 84, 300, 60, 'LEVELS', GHOST_PILL, () =>
      this.scene.start('levelselect')
    ).setDepth(42)
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
      this.scene.start('game', { endless: true })
    ).setDepth(42)
    addPillButton(this, cx, cy + 140 + 84, 300, 60, 'LEVELS', GHOST_PILL, () =>
      this.scene.start('levelselect')
    ).setDepth(42)
  }

  // -------------------------------------------------------------- scoring

  private addScore(points: number): void {
    this.score += points * this.scoreMult
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
  }

  private showCombo(cascade: number): void {
    const big = cascade >= 4
    if (big) {
      sfx.jackpotStrike()
      this.vibrate([60, 40, 120])
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

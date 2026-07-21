/**
 * DEV-ONLY texture atlas — a visual audit harness for the baked-prop fidelity passes.
 * Boots a minimal Phaser game, bakes every prop texture exactly as the real game does
 * (createAllTextures + warmPieceTextures + ensurePieceTexture), and lays them out in a
 * labelled grid on a checker backdrop so alpha edges + gloss read clearly.
 *
 * Not part of the production build (index.html is the only real entry) and lives OUTSIDE
 * `src/` so it never touches `tsc --noEmit` (tsconfig include: ["src"]). Delete before shipping.
 *
 * Pages (via ?page=): normals · specials · board · fx · tokens   (default: normals)
 * Tint (?tint=RRGGBB) recolours every item — proves tint-stability for white-body props.
 */
import Phaser from 'phaser'
import { CELL, PIECE_SIZE, SYMBOL_COLORS } from '../src/config'
import { SYMBOLS } from '../src/core/types'
import type { PieceKind, SymbolType } from '../src/core/types'
import { createAllTextures, ensurePieceTexture, warmPieceTextures } from '../src/view/textures'

interface Item {
  key: string
  label: string
  tint?: number
}

const SPECIALS: PieceKind[] = ['wildReelRow', 'wildReelCol', 'diceBomb']
const KIND_LABEL: Record<string, string> = {
  wildReelRow: 'reel→',
  wildReelCol: 'reel↓',
  diceBomb: 'bomb',
}

function pageItems(page: string): Item[] {
  switch (page) {
    case 'specials': {
      const out: Item[] = []
      for (const s of SYMBOLS) for (const k of SPECIALS) out.push({ key: `${s}|${k}`, label: `${s}·${KIND_LABEL[k]}` })
      return out
    }
    case 'board':
      return [
        { key: 'tile', label: 'tile (raw)' },
        { key: 'tile', label: 'tile·gold', tint: 0xf2b234 },
        { key: 'tile', label: 'tile·rose', tint: 0xd3304f },
        { key: 'tile', label: 'tile·clover', tint: 0x3fae5a },
        { key: 'tile', label: 'tile·diamond', tint: 0x49c6ee },
        { key: 'tile', label: 'tile·navy', tint: 0x4a5a8f },
        { key: 'medallion', label: 'medallion (raw)' },
        { key: 'medallion', label: 'medallion·gold', tint: 0xffd75e },
        { key: 'medallion', label: 'medallion·rose', tint: 0xff7a85 },
        { key: 'softshadow', label: 'softshadow' },
      ]
    case 'fx':
      return [
        { key: 'spark', label: 'spark' },
        { key: 'ring', label: 'ring' },
        { key: 'sweep', label: 'sweep' },
        { key: 'fireball', label: 'fireball' },
        { key: 'shockwave', label: 'shockwave' },
        { key: 'confetti', label: 'confetti' },
        { key: 'glint', label: 'glint' },
        { key: 'raybeam', label: 'raybeam' },
        { key: 'heartglow', label: 'heartglow' },
      ]
    case 'tokens':
      return [
        { key: 'chip', label: 'chip' },
        { key: 'card', label: 'card' },
        { key: 'bulb', label: 'bulb' },
        { key: 'jackpot', label: 'jackpot' },
        { key: 'star', label: 'star' },
        { key: 'lock', label: 'lock' },
        { key: 'heart', label: 'heart' },
        { key: 'heartbig', label: 'heartbig' },
        { key: 'suitHeart', label: 'suitHeart' },
        { key: 'suitSpade', label: 'suitSpade' },
        { key: 'suitDiamond', label: 'suitDiamond' },
        { key: 'suitClub', label: 'suitClub' },
      ]
    case 'normals':
    default:
      return (['cherry', 'seven', 'diamond', 'bell', 'clover', 'bar'] as SymbolType[]).map(s => ({ key: s, label: s }))
  }
}

const params = new URLSearchParams(location.search)
const page = params.get('page') ?? 'normals'
const globalTint = params.get('tint')
const items = pageItems(page)

const COLS = 6
const COL_W = 200
const ART_BOX = 150
const ROW_H = 210
const HEADER = 74
const PAD = 20
const isCohesion = page === 'cohesion'
const W = isCohesion ? 760 : COLS * COL_W + PAD * 2
const rows = Math.ceil(items.length / COLS)
const H = isCohesion ? 560 : HEADER + rows * ROW_H + PAD

class Atlas extends Phaser.Scene {
  create(): void {
    createAllTextures(this)
    warmPieceTextures(this)
    for (const s of SYMBOLS) for (const k of SPECIALS) ensurePieceTexture(this, { id: -1, symbol: s, kind: k })

    // Checker backdrop so soft alpha edges + white props read clearly.
    const cg = this.make.graphics({ x: 0, y: 0 }, false)
    cg.fillStyle(0x6b7079, 1)
    cg.fillRect(0, 0, 32, 32)
    cg.fillStyle(0x565b66, 1)
    cg.fillRect(0, 0, 16, 16)
    cg.fillRect(16, 16, 16, 16)
    cg.generateTexture('__checker', 32, 32)
    cg.destroy()
    this.add.tileSprite(0, 0, W, H, '__checker').setOrigin(0, 0)

    const tintNum = globalTint ? parseInt(globalTint, 16) : undefined
    this.add
      .text(PAD, 24, `atlas · ${page}${tintNum !== undefined ? ` · tint #${globalTint}` : ''}`, {
        fontFamily: 'monospace',
        fontSize: '26px',
        color: '#ffffff',
      })
      .setOrigin(0, 0)

    if (isCohesion) {
      this.renderCohesion()
      return
    }

    items.forEach((it, i) => {
      const col = i % COLS
      const row = Math.floor(i / COLS)
      const cx = PAD + col * COL_W + COL_W / 2
      const cy = HEADER + row * ROW_H + ART_BOX / 2

      // faint cell frame
      const frame = this.add.graphics()
      frame.lineStyle(1, 0xffffff, 0.12)
      frame.strokeRect(cx - ART_BOX / 2, cy - ART_BOX / 2, ART_BOX, ART_BOX)

      const img = this.add.image(cx, cy, it.key)
      const tw = img.width || 1
      const th = img.height || 1
      const scale = ART_BOX / Math.max(tw, th)
      img.setScale(scale)
      const t = it.tint ?? tintNum
      if (t !== undefined) img.setTint(t)

      this.add
        .text(cx, cy + ART_BOX / 2 + 10, `${it.label}\n${tw}×${th}`, {
          fontFamily: 'monospace',
          fontSize: '15px',
          color: '#e7ecff',
          align: 'center',
        })
        .setOrigin(0.5, 0)
    })
  }

  /** The judging view: target props at their TRUE on-screen size, in context, beside the emoji. */
  private renderCohesion(): void {
    const lbl = (x: number, y: number, s: string, size = 16): void => {
      this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: `${size}px`, color: '#e7ecff', align: 'center' }).setOrigin(0.5)
    }
    // Row 1 — all 6 board symbols at real PIECE_SIZE on tinted tiles (the actual board look).
    const symbolsY = 150
    const cx0 = (W - CELL * SYMBOLS.length) / 2 + CELL / 2
    lbl(W / 2, symbolsY - 92, 'board symbols @ real ~73px on tinted tiles — do 7 and BAR cohere with the emoji?')
    SYMBOLS.forEach((s, i) => {
      const x = cx0 + i * CELL
      this.add.image(x, symbolsY, 'tile').setDisplaySize(CELL, CELL).setTint(SYMBOL_COLORS[s])
      this.add.image(x, symbolsY, s).setDisplaySize(PIECE_SIZE, PIECE_SIZE)
      lbl(x, symbolsY + CELL / 2 + 8, s, 13)
    })
    // Row 2 — chip at its real HUD display sizes.
    const chipY = 330
    lbl(W / 2, chipY - 50, 'chip @ HUD sizes')
    ;[26, 34, 46].forEach((sz, i) => {
      const x = W / 2 - 90 + i * 90
      this.add.image(x, chipY, 'chip').setDisplaySize(sz, sz)
      lbl(x, chipY + 36, `${sz}px`, 13)
    })
    // Row 3 — jackpot piece at board size.
    const jpY = 460
    this.add.image(W / 2, jpY, 'tile').setDisplaySize(CELL, CELL).setTint(0xf2b234)
    this.add.image(W / 2, jpY, 'jackpot').setDisplaySize(PIECE_SIZE, PIECE_SIZE)
    lbl(W / 2, jpY + CELL / 2 + 8, 'jackpot @73px', 13)
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'atlas',
  width: W,
  height: H,
  backgroundColor: '#4a4f59',
  render: { antialias: true },
  scale: { mode: Phaser.Scale.NONE },
  scene: [Atlas],
})

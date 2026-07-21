/**
 * DEV-ONLY texture atlas — a visual audit harness for the baked-prop fidelity passes.
 * Boots a minimal Phaser game, bakes every prop texture exactly as the real game does
 * (createAllTextures + warmPieceTextures + ensurePieceTexture), and lays them out in a
 * labelled grid on a checker backdrop so alpha edges + gloss read clearly.
 *
 * Not part of the production build (index.html is the only real entry) and lives OUTSIDE
 * `src/` so it never touches `tsc --noEmit` (tsconfig include: ["src"]). Delete before shipping.
 *
 * Pages (via ?page=): normals · specials · board · fx · tokens · cohesion · bulbs   (default: normals)
 * Tint (?tint=RRGGBB) recolours every item — proves tint-stability for white-body props.
 * The `bulbs` page judges the marquee lamp at its TRUE 13–20px display sizes, tinted, on the dark
 * cabinet ground it really sits on (the tokens page upscales 16px→150px and blurs the read).
 */
import Phaser from 'phaser'
import { CELL, PIECE_SIZE, SYMBOL_COLORS } from '../src/config'
import { SYMBOLS } from '../src/core/types'
import type { PieceKind, SymbolType } from '../src/core/types'
import { createAllTextures, ensurePieceTexture, warmPieceTextures } from '../src/view/textures'
import { makeMedal } from '../src/view/leaderboardpanel'
import { drawCodeTicket } from '../src/view/invite'
import { drawWheelBezel, drawWheelPointer } from '../src/view/jackpot'

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
const isBulbs = page === 'bulbs'
const isMedals = page === 'medals'
const isTicket = page === 'ticket'
const isWheel = page === 'wheel'
const custom = isCohesion || isBulbs || isMedals || isTicket || isWheel
const W = custom ? 760 : COLS * COL_W + PAD * 2
const rows = Math.ceil(items.length / COLS)
const H = custom ? 560 : HEADER + rows * ROW_H + PAD

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
    if (isBulbs) {
      this.renderBulbs()
      return
    }
    if (isMedals) {
      this.renderMedals()
      return
    }
    if (isTicket) {
      this.renderTicket()
      return
    }
    if (isWheel) {
      this.renderWheel()
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

  /** Bulb audit — the marquee lamp at its real 13–20px sizes, tinted, on cabinet dark (+ a big detail
   * row). The tokens page upscales 16px→150px and blurs the glass rim/specular read; this shows truth. */
  private renderBulbs(): void {
    const lbl = (x: number, y: number, s: string, size = 15): void => {
      this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: `${size}px`, color: '#e7ecff' }).setOrigin(0.5)
    }
    const dark = (x: number, y: number, w: number, h: number): void => {
      const d = this.add.graphics()
      d.fillStyle(0x1e1a2a, 1)
      d.fillRoundedRect(x, y, w, h, 10)
    }
    const gold = 0xf2b234
    const goldBright = 0xffd75e
    const rose = 0xd3304f
    const roseLight = 0xff7a85
    const bulb = (x: number, y: number, sz: number, tint: number, alpha: number): void => {
      this.add.image(x, y, 'bulb').setDisplaySize(sz, sz).setTint(tint).setAlpha(alpha)
    }

    // Row A — marquee @13px, alternating gold/rose at the real 0.62 alpha, on cabinet dark.
    lbl(W / 2, 92, 'marquee @13px · gold/rose · α0.62')
    dark(PAD, 108, W - PAD * 2, 46)
    const nA = 15
    for (let i = 0; i < nA; i++) bulb(PAD + 30 + (i * (W - PAD * 2 - 60)) / (nA - 1), 131, 13, i % 2 ? rose : gold, 0.62)

    // Row B — jackpot rim @20px, goldBright/roseLight at 0.5 alpha.
    lbl(W / 2, 186, 'jackpot rim @20px · goldBright/roseLight · α0.5')
    dark(PAD, 202, W - PAD * 2, 56)
    const nB = 13
    for (let i = 0; i < nB; i++) bulb(PAD + 34 + (i * (W - PAD * 2 - 68)) / (nB - 1), 230, 20, i % 2 ? roseLight : goldBright, 0.5)

    // Row C — detail @72px (white · gold · rose) to inspect the glass structure (intentional upscale).
    lbl(W / 2, 290, 'detail @72px · white · gold · rose')
    dark(PAD, 306, W - PAD * 2, 150)
    ;[0xffffff, gold, rose].forEach((t, i) => bulb(W / 2 - 200 + i * 200, 381, 72, t, 1))

    // Row D — true-size ladder on checker (white then gold) at 13·16·20·28px.
    lbl(W / 2, 486, 'true-size ladder · white / gold @ 13·16·20·28px')
    ;[13, 16, 20, 28].forEach((sz, i) => {
      bulb(W / 2 - 240 + i * 90, 522, sz, 0xffffff, 1)
      bulb(W / 2 + 40 + i * 90, 522, sz, gold, 1)
    })
  }

  /** Medal audit — the struck rank coin drawn by the REAL makeMedal, on cream leaderboard grounds:
   * a big detail trio (upscaled) + the true row sizes (#1 @r32 gold plate, #2/#3 @r26). */
  private renderMedals(): void {
    const lbl = (x: number, y: number, s: string, color = '#e7ecff', size = 15): void => {
      this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: `${size}px`, color, align: 'center' }).setOrigin(0.5)
    }
    const creamPanel = (x: number, y: number, w: number, h: number): void => {
      const d = this.add.graphics()
      d.fillStyle(0x8a7a52, 0.18)
      d.fillRoundedRect(x + 3, y + 5, w, h, 20)
      d.fillStyle(0xfffdf8, 1)
      d.fillRoundedRect(x, y, w, h, 20)
      d.lineStyle(3, 0xf2c14e, 1)
      d.strokeRoundedRect(x, y, w, h, 20)
    }

    // Detail row — #1/#2/#3 @96px beside the Pass-1 jackpot coin (the density bar to match).
    lbl(W / 2, 88, 'detail @96px — #1 · #2 · #3   vs   Pass-1 jackpot coin = the bar →')
    creamPanel(70, 112, W - 140, 168)
    ;[1, 2, 3].forEach((rank, i) => makeMedal(this, rank, 48).setPosition(150 + i * 180, 196))
    this.add.image(650, 196, 'jackpot').setDisplaySize(96, 96)
    lbl(650, 250, 'bar', '#2a2732', 12)

    // True size — the exact leaderboard sizes (#1 podium r32, #2/#3 rows r26).
    lbl(W / 2, 336, 'true size — #1 @r32 (gold plate) · #2/#3 @r26 (cream rows)')
    creamPanel(70, 360, W - 140, 150)
    ;[
      [1, 32],
      [2, 26],
      [3, 26],
    ].forEach(([rank, r], i) => {
      const x = W / 2 - 210 + i * 210
      makeMedal(this, rank, r).setPosition(x, 428)
      lbl(x, 470, `#${rank} · r${r}`, '#2a2732', 13)
    })
  }

  /** Invite-ticket audit — the real drawCodeTicket on a cream INVITE-card ground (so the perforation
   * bites punch to the same cardFill cream), with a mock code laid over it; true size + a 2× detail. */
  private renderTicket(): void {
    const lbl = (x: number, y: number, s: string): void => {
      this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: '15px', color: '#e7ecff', align: 'center' }).setOrigin(0.5)
    }
    // One ticket (240×48) on a cream pad + a mock 'MAYA7K' code, scaled as one unit.
    const ticket = (cxp: number, cyp: number, scale: number, signedIn: boolean): void => {
      const c = this.add.container(cxp, cyp).setScale(scale)
      const pad = this.add.graphics()
      pad.fillStyle(0x8a7a52, 0.14)
      pad.fillRoundedRect(-158, -46, 316, 96, 16)
      pad.fillStyle(0xfffdf8, 1) // cardFill — the invite card cream the bites punch through to
      pad.fillRoundedRect(-160, -48, 316, 96, 16)
      const g = this.add.graphics()
      drawCodeTicket(g, -120, -24, 240, 48, signedIn)
      const code = this.add
        .text(0, 1, signedIn ? 'MAYA7K' : 'sign in to invite', {
          fontFamily: 'Arial, sans-serif',
          fontSize: signedIn ? '30px' : '17px',
          fontStyle: '900',
          color: signedIn ? '#a8213c' : '#746d59',
        })
        .setOrigin(0.5)
        .setLetterSpacing(signedIn ? 6 : 0)
      c.add([pad, g, code])
    }

    lbl(W / 2, 96, 'invite raffle ticket @ true size (240×48) — embossed well + punched perforation')
    ticket(W / 2, 168, 1, true)
    lbl(W / 2, 250, 'detail @2×')
    ticket(W / 2, 340, 1.9, true)
    lbl(W / 2, 452, 'signed-out (dimmed) @true')
    ticket(W / 2, 500, 1, false)
  }

  /** Wheel audit — the real drawWheelBezel + drawWheelPointer on a mock wedge disc + dark scrim + rim
   * bulbs (@0.5 to fit the R=232 rig), plus a 2.5× pointer detail for the cast bevel/spine/rivet. */
  private renderWheel(): void {
    const deg = Phaser.Math.DegToRad
    const R = 232
    const lbl = (x: number, y: number, s: string): void => {
      this.add.text(x, y, s, { fontFamily: 'monospace', fontSize: '15px', color: '#e7ecff', align: 'center' }).setOrigin(0.5)
    }
    lbl(W / 2, 84, 'jackpot wheel @0.5 — dished bezel · milled knurl · beveled cast pointer (mock disc + scrim)')

    // Full rig at half scale (R=232 is nearly full phone width in-game).
    const c = this.add.container(W / 2, 320).setScale(0.5)
    const scrim = this.add.graphics()
    scrim.fillStyle(0x2a2417, 1)
    scrim.fillCircle(0, 0, R + 64)
    c.add(scrim)
    // Mock 8-wedge disc so the bezel sits on a realistic colourful ground.
    const disc = this.add.graphics()
    for (let i = 0; i < 8; i++) {
      const s = deg(i * 45)
      const e = deg((i + 1) * 45)
      disc.fillStyle(i % 2 ? 0xf2b234 : 0xfff3d6, 1)
      disc.slice(0, 0, R, s, e, false)
      disc.fillPath()
      disc.lineStyle(3, 0xc9930a, 0.9)
      disc.slice(0, 0, R, s, e, false)
      disc.strokePath()
    }
    c.add(disc)
    const bg = this.add.graphics()
    drawWheelBezel(bg, 0, 0, R)
    c.add(bg)
    c.add(this.add.image(0, 0, 'jackpot').setDisplaySize(96, 96))
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2
      c.add(
        this.add
          .image(Math.cos(a) * (R + 20), Math.sin(a) * (R + 20), 'bulb')
          .setDisplaySize(20, 20)
          .setTint(i % 2 ? 0xff7a85 : 0xffd75e)
          .setAlpha(0.85)
      )
    }
    const pc = this.add.container(0, -R - 6)
    const pg = this.add.graphics()
    drawWheelPointer(pg)
    pc.add(pg)
    c.add(pc)

    // Pointer detail @2.5× on a dark chip.
    lbl(140, 476, 'pointer @2.5×')
    const chip = this.add.graphics()
    chip.fillStyle(0x2a2417, 1)
    chip.fillRoundedRect(78, 360, 124, 96, 12)
    const pc2 = this.add.container(140, 414).setScale(2.5)
    const pg2 = this.add.graphics()
    drawWheelPointer(pg2)
    pc2.add(pg2)
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

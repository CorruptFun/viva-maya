import Phaser from 'phaser'
import type { Piece, SymbolType } from '../core/types'

/**
 * Symbol art = system emoji rendered into textures at boot — crisp, high-quality
 * platform artwork (Apple's on iOS/macOS) with zero asset files. The 7 and BAR
 * are composed in-engine to read like classic slot glyphs.
 */
export const TEX_SIZE = 128

const EMOJI: Partial<Record<SymbolType, string>> = {
  cherry: '🍒',
  diamond: '💎',
  bell: '🔔',
  clover: '🍀',
}

function intoTexture(scene: Phaser.Scene, key: string, draw: (dt: Phaser.Textures.DynamicTexture) => void): void {
  const dt = scene.textures.addDynamicTexture(key, TEX_SIZE, TEX_SIZE)
  if (!dt) return
  draw(dt)
}

function makeEmoji(scene: Phaser.Scene, key: SymbolType, glyph: string): void {
  const text = scene.make.text(
    {
      x: 0,
      y: 0,
      text: glyph,
      style: { fontFamily: 'sans-serif', fontSize: '100px', padding: { x: 10, y: 10 } },
    },
    false
  )
  intoTexture(scene, key, dt => {
    dt.draw(text, (TEX_SIZE - text.width) / 2, (TEX_SIZE - text.height) / 2)
  })
  text.destroy()
}

function makeSeven(scene: Phaser.Scene): void {
  const text = scene.make.text(
    {
      x: 0,
      y: 0,
      text: '7',
      style: {
        fontFamily: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
        fontStyle: '900',
        fontSize: '104px',
        color: '#e0312e',
        padding: { x: 12, y: 12 },
        shadow: { offsetX: 0, offsetY: 5, color: 'rgba(90,20,10,0.28)', blur: 8, fill: true },
      },
    },
    false
  )
  intoTexture(scene, 'seven', dt => {
    dt.draw(text, (TEX_SIZE - text.width) / 2, (TEX_SIZE - text.height) / 2)
  })
  text.destroy()
}

function makeBar(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0x1f2a4d, 0.25)
  g.fillRoundedRect(18, 42, 92, 52, 14)
  g.fillStyle(0x26304d, 1)
  g.fillRoundedRect(16, 36, 96, 54, 14)
  g.lineStyle(3, 0x3d4a75, 1)
  g.strokeRoundedRect(16, 36, 96, 54, 14)
  const text = scene.make.text(
    {
      x: 0,
      y: 0,
      text: 'BAR',
      style: {
        fontFamily: '"Arial Black", "Helvetica Neue", Arial, sans-serif',
        fontStyle: '900',
        fontSize: '34px',
        color: '#ffd75e',
        padding: { x: 4, y: 4 },
      },
    },
    false
  )
  intoTexture(scene, 'bar', dt => {
    dt.draw(g)
    dt.draw(text, (TEX_SIZE - text.width) / 2, 36 + (54 - text.height) / 2)
  })
  text.destroy()
  g.destroy()
}

function makeSpark(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0xf2b234, 0.35)
  g.fillCircle(12, 12, 11)
  g.fillStyle(0xffd75e, 0.85)
  g.fillCircle(12, 12, 6)
  g.fillStyle(0xfff6d9, 1)
  g.fillCircle(12, 12, 3)
  g.generateTexture('spark', 24, 24)
  g.destroy()
}

function makeRing(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const passes: Array<[number, number]> = [
    [10, 0.12],
    [5, 0.4],
    [3, 0.95],
  ]
  for (const [width, alpha] of passes) {
    g.lineStyle(width, 0xf2b234, alpha)
    g.strokeRoundedRect(10, 10, 76, 76, 18)
  }
  g.generateTexture('ring', 96, 96)
  g.destroy()
}

function makeGlyphTexture(scene: Phaser.Scene, key: string, glyph: string, fontSize: number, size: number): void {
  const text = scene.make.text(
    {
      x: 0,
      y: 0,
      text: glyph,
      style: { fontFamily: 'sans-serif', fontSize: `${fontSize}px`, padding: { x: 8, y: 8 } },
    },
    false
  )
  const dt = scene.textures.addDynamicTexture(key, size, size)
  if (dt) dt.draw(text, (size - text.width) / 2, (size - text.height) / 2)
  text.destroy()
}

function makeJackpot(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0xc9930a, 1)
  g.fillCircle(64, 64, 52)
  g.fillStyle(0xf2b234, 1)
  g.fillCircle(64, 64, 47)
  g.fillStyle(0xffd75e, 1)
  g.fillCircle(64, 64, 39)
  g.lineStyle(4, 0xa87410, 1)
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    const c = Math.cos(a)
    const s = Math.sin(a)
    g.lineBetween(64 + c * 41, 64 + s * 41, 64 + c * 50, 64 + s * 50)
  }
  const text = scene.make.text(
    {
      x: 0,
      y: 0,
      text: '🎰',
      style: { fontFamily: 'sans-serif', fontSize: '46px', padding: { x: 8, y: 8 } },
    },
    false
  )
  const dt = scene.textures.addDynamicTexture('jackpot', TEX_SIZE, TEX_SIZE)
  if (dt) {
    dt.draw(g)
    dt.draw(text, (TEX_SIZE - text.width) / 2, (TEX_SIZE - text.height) / 2)
  }
  text.destroy()
  g.destroy()
}

/** Casino chip token — for the slot-cabinet ambiance + win bursts. */
function makeChip(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const c = 24
  const r = 22
  g.fillStyle(0xc4223e, 1)
  g.fillCircle(c, c, r) // rose-red rim
  g.fillStyle(0xfff3d6, 1)
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    g.fillCircle(c + Math.cos(a) * r * 0.82, c + Math.sin(a) * r * 0.82, 3.2) // edge spots
  }
  g.fillStyle(0xf2b234, 1)
  g.fillCircle(c, c, r * 0.62) // gold inner ring
  g.fillStyle(0xfff3d6, 1)
  g.fillCircle(c, c, r * 0.5) // cream face
  g.fillStyle(0xd3304f, 1)
  g.fillCircle(c, c, r * 0.22) // center pip
  g.generateTexture('chip', 48, 48)
  g.destroy()
}

/** Mini playing card (red diamond pip). */
function makeCard(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const w = 40
  const h = 56
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(0, 0, w, h, 7)
  g.lineStyle(2, 0xe8dfc9, 1)
  g.strokeRoundedRect(1, 1, w - 2, h - 2, 6)
  const cx = w / 2
  const cy = h / 2
  g.fillStyle(0xd3304f, 1)
  g.fillPoints(
    [
      { x: cx, y: cy - 11 },
      { x: cx + 8, y: cy },
      { x: cx, y: cy + 11 },
      { x: cx - 8, y: cy },
    ],
    true
  )
  g.fillCircle(7, 8, 2.4) // corner pip
  g.fillCircle(w - 7, h - 8, 2.4)
  g.generateTexture('card', 40, 56)
  g.destroy()
}

/** Marquee bulb (white so it can be tinted red/gold per position). */
function makeBulb(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0xffffff, 0.22)
  g.fillCircle(8, 8, 8)
  g.fillStyle(0xffffff, 0.9)
  g.fillCircle(8, 8, 4.5)
  g.fillStyle(0xffffff, 1)
  g.fillCircle(8, 8, 2.4)
  g.generateTexture('bulb', 16, 16)
  g.destroy()
}

/** Tiny confetti square (white so it can be tinted per-particle) for the win rain. */
function makeConfetti(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0xffffff, 1)
  g.fillRect(0, 0, 8, 8)
  g.generateTexture('confetti', 8, 8)
  g.destroy()
}

function makeSweep(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0xf2b234, 0.45)
  g.fillRoundedRect(0, 0, 128, 48, 22)
  g.fillStyle(0xffd75e, 0.85)
  g.fillRoundedRect(6, 8, 116, 32, 16)
  g.fillStyle(0xfff6d9, 1)
  g.fillRoundedRect(12, 19, 104, 10, 5)
  g.generateTexture('sweep', 128, 48)
  g.destroy()
}

/** Texture key for a piece, composing special overlays lazily on first use. */
export function pieceTextureKey(piece: Piece): string {
  if (piece.kind === 'jackpot') return 'jackpot'
  if (piece.kind === 'normal') return piece.symbol
  return `${piece.symbol}|${piece.kind}`
}

export function ensurePieceTexture(scene: Phaser.Scene, piece: Piece): string {
  const key = pieceTextureKey(piece)
  if (scene.textures.exists(key)) return key
  const dt = scene.textures.addDynamicTexture(key, TEX_SIZE, TEX_SIZE)
  if (!dt) return piece.symbol
  const base = scene.make.image({ x: 0, y: 0, key: piece.symbol }, false)
  base.setScale(0.8)
  dt.draw(base, TEX_SIZE / 2, TEX_SIZE / 2)
  base.destroy()

  if (piece.kind === 'diceBomb') {
    const badge = scene.make.text(
      { x: 0, y: 0, text: '🎲', style: { fontFamily: 'sans-serif', fontSize: '40px', padding: { x: 6, y: 6 } } },
      false
    )
    dt.draw(badge, TEX_SIZE - badge.width - 2, TEX_SIZE - badge.height - 2)
    badge.destroy()
  } else {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    g.fillStyle(0xf2b234, 1)
    g.lineStyle(3, 0xa87410, 1)
    if (piece.kind === 'wildReelRow') {
      g.fillTriangle(102, 52, 102, 76, 120, 64)
      g.strokeTriangle(102, 52, 102, 76, 120, 64)
      g.fillTriangle(26, 52, 26, 76, 8, 64)
      g.strokeTriangle(26, 52, 26, 76, 8, 64)
    } else {
      g.fillTriangle(52, 102, 76, 102, 64, 120)
      g.strokeTriangle(52, 102, 76, 102, 64, 120)
      g.fillTriangle(52, 26, 76, 26, 64, 8)
      g.strokeTriangle(52, 26, 76, 26, 64, 8)
    }
    dt.draw(g)
    g.destroy()
  }
  return key
}

export function createAllTextures(scene: Phaser.Scene): void {
  for (const [key, glyph] of Object.entries(EMOJI) as Array<[SymbolType, string]>) {
    makeEmoji(scene, key, glyph)
  }
  makeSeven(scene)
  makeBar(scene)
  makeSpark(scene)
  makeRing(scene)
  makeJackpot(scene)
  makeSweep(scene)
  makeConfetti(scene)
  makeChip(scene)
  makeCard(scene)
  makeBulb(scene)
  makeGlyphTexture(scene, 'star', '⭐', 44, 64)
  makeGlyphTexture(scene, 'lock', '🔒', 40, 64)
  makeGlyphTexture(scene, 'heart', '❤️', 44, 64)
}

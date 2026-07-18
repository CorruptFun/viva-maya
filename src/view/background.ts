import Phaser from 'phaser'
import { DESIGN_H, DESIGN_W } from '../config'

/**
 * Ambient casino dressing for the empty margins: warm gradient wash, twinkling
 * marquee light strips, corner bokeh glows, faint card-suit watermarks, and
 * (on menu screens) slow-drifting sparkle dust. Everything is procedural and
 * static-cheap; the 'game' variant stays calm so the board keeps the focus.
 */
export type BackdropVariant = 'home' | 'menu' | 'game'

type SuitSpec = [glyph: string, x: number, y: number, size: number, angle: number, alpha: number]

const SUITS_BOTTOM: SuitSpec[] = [
  ['♥', 96, 1078, 64, -18, 0.09],
  ['♣', 250, 1160, 44, 12, 0.07],
  ['♦', 420, 1096, 52, -8, 0.08],
  ['♠', 580, 1170, 60, 16, 0.07],
  ['♥', 660, 1060, 38, 24, 0.06],
]

const SUITS_TOP: SuitSpec[] = [
  ['♦', 52, 44, 40, -14, 0.07],
  ['♣', 668, 52, 46, 10, 0.06],
]

const SUITS_MID: SuitSpec[] = [
  ['♥', 40, 640, 54, -20, 0.07],
  ['♠', 684, 560, 48, 14, 0.06],
  ['♦', 34, 900, 40, 10, 0.06],
  ['♣', 690, 860, 42, -12, 0.06],
]

function ensureTextures(scene: Phaser.Scene): void {
  if (!scene.textures.exists('bgdot')) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    g.fillStyle(0xffffff, 0.35)
    g.fillCircle(8, 8, 7)
    g.fillStyle(0xffffff, 0.8)
    g.fillCircle(8, 8, 4)
    g.fillStyle(0xffffff, 1)
    g.fillCircle(8, 8, 2)
    g.generateTexture('bgdot', 16, 16)
    g.destroy()
  }
  if (!scene.textures.exists('bgglow')) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    for (let i = 10; i >= 1; i--) {
      g.fillStyle(0xffffff, 0.028 * (11 - i))
      g.fillCircle(64, 64, (64 * i) / 10)
    }
    g.generateTexture('bgglow', 128, 128)
    g.destroy()
  }
}

export function addCasinoBackdrop(scene: Phaser.Scene, variant: BackdropVariant): void {
  ensureTextures(scene)

  // Warm wash: rose-tinted at the top, deeper tan at the bottom.
  const wash = scene.add.graphics()
  wash.fillGradientStyle(0xfaf3ec, 0xfaf3ec, 0xefe7d6, 0xefe7d6, 1)
  wash.fillRect(0, 0, DESIGN_W, DESIGN_H)

  // Corner bokeh glows.
  const bokeh: Array<[number, number, number, number, number]> = [
    [-30, 170, 2.6, 0xf2c14e, 0.1],
    [DESIGN_W + 20, 320, 2.2, 0xf0a3ad, 0.09],
    [50, DESIGN_H - 160, 2.4, 0xf0a3ad, 0.08],
    [DESIGN_W - 40, DESIGN_H - 260, 2.8, 0xf2c14e, 0.09],
  ]
  for (const [x, y, scale, tint, alpha] of bokeh) {
    scene.add.image(x, y, 'bgglow').setScale(scale).setTint(tint).setAlpha(alpha)
  }

  // Marquee light strips along the top and bottom edges.
  const dotCount = 15
  for (let i = 0; i < dotCount; i++) {
    const x = 24 + (i * (DESIGN_W - 48)) / (dotCount - 1)
    for (const y of [26, DESIGN_H - 26]) {
      const dot = scene.add.image(x, y, 'bgdot').setTint(0xf2b234).setAlpha(0.28)
      scene.tweens.add({
        targets: dot,
        alpha: 0.5,
        duration: 1100,
        delay: (i % 5) * 210 + (y > 100 ? 400 : 0),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
  }

  // Faint card-suit watermarks in the margins.
  const suits: SuitSpec[] =
    variant === 'game'
      ? [...SUITS_TOP, ...SUITS_BOTTOM]
      : variant === 'menu'
        ? [...SUITS_TOP, ...SUITS_BOTTOM, ...SUITS_MID.slice(0, 2)]
        : [...SUITS_TOP, ...SUITS_BOTTOM, ...SUITS_MID]
  for (const [glyph, x, y, size, angle, alpha] of suits) {
    scene.add
      .text(x, y, glyph, { fontFamily: 'Arial, sans-serif', fontSize: `${size}px`, color: '#8a7a52' })
      .setOrigin(0.5)
      .setAngle(angle)
      .setAlpha(alpha)
  }

  // Slow-drifting sparkle dust — menu screens only; the board stays calm.
  if (variant !== 'game') {
    const motes: Array<[number, number, number]> = [
      [90, 420, 0.9],
      [640, 380, 0.7],
      [180, 760, 0.6],
      [560, 700, 0.8],
      [340, 980, 0.7],
      [80, 1000, 0.5],
      [660, 950, 0.6],
    ]
    motes.forEach(([x, y, scale], i) => {
      const mote = scene.add.image(x, y, 'bgdot').setTint(0xd9a521).setAlpha(0.35).setScale(scale)
      scene.tweens.add({
        targets: mote,
        y: y - 70,
        alpha: 0.12,
        duration: 3800 + i * 420,
        delay: i * 300,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    })
  }

  // Game screen: faint tokens + cards shuffling through the empty space below the board —
  // casino ambiance for the "cabinet", kept low + slow so the board keeps the focus.
  if (variant === 'game' && scene.textures.exists('chip')) {
    const tokens: Array<[string, number, number, number, number]> = [
      ['chip', 96, 1092, 0.95, 0.16],
      ['card', 250, 1186, 0.85, 0.14],
      ['chip', 468, 1206, 1.05, 0.15],
      ['card', 624, 1104, 0.8, 0.13],
      ['chip', 356, 1234, 0.7, 0.12],
    ]
    tokens.forEach(([key, x, y, scale, alpha], i) => {
      const dir = i % 2 ? -1 : 1
      const t = scene.add.image(x, y, key).setScale(scale).setAlpha(alpha).setAngle(dir * 12)
      scene.tweens.add({
        targets: t,
        y: y - 42,
        angle: dir * 12 + dir * 20,
        duration: 4200 + i * 500,
        delay: i * 350,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    })
  }
}

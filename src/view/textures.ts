import Phaser from 'phaser'
import type { Piece, SymbolType } from '../core/types'

/**
 * Symbol art = system emoji rendered into textures at boot — crisp, high-quality
 * platform artwork (Apple's on iOS/macOS) with zero asset files. The 7 and BAR
 * are composed in-engine to read like classic slot glyphs.
 *
 * Hi-DPI: all symbol/special art is AUTHORED in a 128² logical space (BASE), but
 * BAKED into a TEX_SIZE² physical texture (supersampled by SS) so it stays crisp
 * when the canvas renders at device pixel ratio. Pieces still downscale from
 * TEX_SIZE (PIECE_SCALE = PIECE_SIZE / TEX_SIZE), so nothing moves in world space.
 */
const BASE = 128
/** Supersample factor: symbol/special textures bake at BASE×SS px (256²). */
const SS = 2
export const TEX_SIZE = BASE * SS

const EMOJI: Partial<Record<SymbolType, string>> = {
  cherry: '🍒',
  diamond: '💎',
  bell: '🔔',
  clover: '🍀',
}

/**
 * Create a symbol/special DynamicTexture that bakes 128²-authored art into a TEX_SIZE² physical
 * texture. Every draw call stays in the 128 logical space; the DT's own camera is zoomed by SS
 * (anchored top-left) so all drawing is supersampled into the larger texture — crisp on hi-DPI
 * with zero coordinate changes. Pieces downscale from TEX_SIZE, so nothing moves in world space.
 */
function makeDT(scene: Phaser.Scene, key: string): Phaser.Textures.DynamicTexture | null {
  const dt = scene.textures.addDynamicTexture(key, TEX_SIZE, TEX_SIZE)
  if (dt) {
    dt.camera.setZoom(SS)
    dt.camera.originX = 0
    dt.camera.originY = 0
  }
  return dt
}

function intoTexture(scene: Phaser.Scene, key: string, draw: (dt: Phaser.Textures.DynamicTexture) => void): void {
  const dt = makeDT(scene, key)
  if (!dt) return
  draw(dt)
}

/**
 * Subtle contact-shadow baked UNDER a piece glyph (a soft dark ellipse near the texture's
 * bottom) so pieces read as SEATED on their glossy tile instead of floating. Drawn first, so
 * the opaque emoji always renders crisp on top — the glyph is never recoloured or dimmed.
 * Zero runtime cost: it travels with the sprite through every swap / fall / cascade.
 */
function seatShadow(scene: Phaser.Scene, dt: Phaser.Textures.DynamicTexture): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0x000000, 0.05)
  g.fillEllipse(64, 109, 78, 26)
  g.fillStyle(0x000000, 0.05)
  g.fillEllipse(64, 110, 56, 18)
  g.fillStyle(0x000000, 0.06)
  g.fillEllipse(64, 111, 38, 11)
  dt.draw(g)
  g.destroy()
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
    seatShadow(scene, dt)
    dt.draw(text, (BASE - text.width) / 2, (BASE - text.height) / 2)
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
    seatShadow(scene, dt)
    dt.draw(text, (BASE - text.width) / 2, (BASE - text.height) / 2)
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
    seatShadow(scene, dt)
    dt.draw(g)
    dt.draw(text, (BASE - text.width) / 2, 36 + (54 - text.height) / 2)
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
  const dt = makeDT(scene, 'jackpot')
  if (dt) {
    dt.draw(g)
    dt.draw(text, (BASE - text.width) / 2, (BASE - text.height) / 2)
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

/**
 * Board tile — ONE reusable 128² texture for all 64 cells (§3c). A RAISED glossy cushion:
 * a pure-white body (so a single per-cell `setTint()` colours the whole cushion), a soft drop
 * shadow onto the tray floor, and a top-lit glossy dome shaded downward. The tint-stability
 * trick: shade with BLACK-alpha (0×tint = stays neutral-dark) and leave the body pure white
 * (→ full tint) so shadows read as depth and the lit top reads as gloss on every tint. Placed
 * as 64 same-texture Images = one batched draw call, zero tweens, zero per-frame graphics.
 * Gradients are only reliable on `fillRect` (Phaser 3.90), so the dome is stacked flat-alpha
 * rounded rects, never `fillGradientStyle` on a rounded shape.
 */
function makeTile(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Pinned to the 128 base (not TEX_SIZE): the tile's gutter/radius/shadow are absolute constants
  // tuned for this size, and it's a smooth gloss cushion (shown at CELL, downscaled) so it needs no
  // supersample. Keeping it at 128 preserves the exact board look after the symbol bump to 256.
  const S = BASE
  const m = 4 // inset → the dark-floor gutter that shows between tiles when drawn at CELL size
  const bw = S - m * 2
  const r = 22
  // Drop shadow onto the tray floor — neutral black survives the per-cell tint (0×tint = 0).
  g.fillStyle(0x000000, 0.1)
  g.fillRoundedRect(m, m + 5, bw, bw, r)
  g.fillStyle(0x000000, 0.1)
  g.fillRoundedRect(m, m + 3, bw, bw, r)
  // Pure-white cushion body — the ONLY thing a per-cell setTint() colours.
  g.fillStyle(0xffffff, 1)
  g.fillRoundedRect(m, m, bw, bw, r)
  // Glossy dome: top ~42% stays white (lit), shaded downward with stacked flat bands (rounded
  // bottom corners match the body; square top corners sit hidden mid-body).
  for (const [f, a] of [[0.42, 0.05], [0.6, 0.05], [0.78, 0.06]] as Array<[number, number]>) {
    g.fillStyle(0x000000, a)
    g.fillRoundedRect(m, m + bw * f, bw, bw * (1 - f), { tl: 0, tr: 0, bl: r, br: r })
  }
  // Faint seated-edge bevel (dark → survives tint) for tile-to-tile separation.
  g.lineStyle(2.5, 0x000000, 0.09)
  g.strokeRoundedRect(m, m, bw, bw, r)
  g.generateTexture('tile', S, S)
  g.destroy()
}

/**
 * Vertical light beam for the atmospheric backdrop (§3b) — a spotlight-cone blade / god-ray.
 * Bright feathered top → fully transparent bottom (a vertical alpha gradient, reliable on
 * `fillRect`), horizontally feathered by three nested rects: widest = faint halo, narrowest =
 * hot core. Pure warm-white so it tints cleanly (ADD) to any theme's rayTint; drawn at the use
 * site with origin (0.5, 0) so it pivots at the light source. Baked once.
 */
function makeRaybeam(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const W = 96
  const H = 640
  const c = 0xffffff
  // widest/faintest halo → narrowest/hottest core; each band fades bright top → clear bottom.
  const bands: Array<[number, number]> = [
    [W, 0.2],
    [W * 0.5, 0.28],
    [W * 0.2, 0.4],
  ]
  for (const [bw, topA] of bands) {
    const x = (W - bw) / 2
    g.fillGradientStyle(c, c, c, c, topA, topA, 0, 0)
    g.fillRect(x, 0, bw, H)
  }
  g.generateTexture('raybeam', W, H)
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

/** Soft radial fireball (rose→gold→white-hot) — the detonation flash/missile head. Additive. */
function makeFireball(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const c = 24
  g.fillStyle(0xd3304f, 0.22)
  g.fillCircle(c, c, 24)
  g.fillStyle(0xf2b234, 0.5)
  g.fillCircle(c, c, 18)
  g.fillStyle(0xffcf6a, 0.9)
  g.fillCircle(c, c, 11)
  g.fillStyle(0xfff6d9, 1)
  g.fillCircle(c, c, 5)
  g.generateTexture('fireball', 48, 48)
  g.destroy()
}

/** Bright thin blast ring — scaled out + faded for the bomb shockwave. Additive. */
function makeShockwave(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const c = 48
  g.lineStyle(10, 0xf2b234, 0.35)
  g.strokeCircle(c, c, 38)
  g.lineStyle(5, 0xffe6a8, 0.9)
  g.strokeCircle(c, c, 41)
  g.lineStyle(2, 0xfffdf8, 1)
  g.strokeCircle(c, c, 43)
  g.generateTexture('shockwave', 96, 96)
  g.destroy()
}

/** Texture key for a piece, composing special overlays lazily on first use. */
export function pieceTextureKey(piece: Piece): string {
  if (piece.kind === 'jackpot') return 'jackpot'
  if (piece.kind === 'normal') return piece.symbol
  return `${piece.symbol}|${piece.kind}`
}

/** Representative colour per symbol — the "match by colour" accent carried onto specials. */
const SYMBOL_TINT: Record<SymbolType, number> = {
  cherry: 0xd3304f,
  seven: 0xe0312e,
  diamond: 0x49c6ee,
  bell: 0xf2b234,
  clover: 0x3fae5a,
  bar: 0x4a5a8f,
}

/**
 * Primed dice-bomb: a dark glossy round shell with a top gloss highlight, a gold fuse collar,
 * a curved lit fuse and a bright spark at the tip — the piece's symbol rides on the belly as a
 * smaller colour accent (plus a tint halo + accent ring) so it still matches by colour.
 */
function drawBomb(scene: Phaser.Scene, dt: Phaser.Textures.DynamicTexture, symbol: SymbolType, tint: number): void {
  const cx = 64
  const cy = 76
  const r = 40
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Symbol-tint halo (keeps colour-match legible under the dark shell).
  g.fillStyle(tint, 0.16)
  g.fillCircle(cx, cy, r + 12)
  g.fillStyle(tint, 0.3)
  g.fillCircle(cx, cy, r + 3)
  // Cast shadow + dark glossy shell with a rounder lit upper form.
  g.fillStyle(0x0b0e18, 0.5)
  g.fillCircle(cx, cy + 4, r)
  g.fillStyle(0x1b2138, 1)
  g.fillCircle(cx, cy, r)
  g.fillStyle(0x2c3557, 1)
  g.fillCircle(cx - 3, cy - 5, r - 8)
  // Colour accent ring + dark bevel rim.
  g.lineStyle(4, tint, 0.9)
  g.strokeCircle(cx, cy, r - 1)
  g.lineStyle(3, 0x0b0e18, 1)
  g.strokeCircle(cx, cy, r + 1)
  // Gold fuse collar at the crown.
  g.fillStyle(0x8a5a12, 1)
  g.fillRoundedRect(cx - 9, cy - r - 5, 18, 13, 4)
  g.fillStyle(0xf2b234, 1)
  g.fillRoundedRect(cx - 8, cy - r - 7, 16, 11, 4)
  dt.draw(g)
  g.destroy()
  // Symbol emoji on the belly — the smaller colour accent (enlarged for legibility).
  // ÷SS: the symbol texture is itself supersampled, so halve the scale to keep the same size.
  const base = scene.make.image({ x: 0, y: 0, key: symbol }, false)
  base.setScale(0.46 / SS)
  dt.draw(base, cx, cy + 4)
  base.destroy()
  // Top pass: gloss, lit fuse and spark render above the symbol.
  const g2 = scene.make.graphics({ x: 0, y: 0 }, false)
  g2.fillStyle(0xffffff, 0.4)
  g2.fillEllipse(cx - 12, cy - 18, 28, 16)
  g2.fillStyle(0xffffff, 0.9)
  g2.fillCircle(cx - 15, cy - 20, 4)
  // Curved fuse (quadratic sample) from the collar up to the spark.
  const p0 = { x: cx + 2, y: cy - r - 5 }
  const cpx = cx + 6
  const cpy = cy - r - 30
  const p1 = { x: cx + 30, y: cy - r - 22 }
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= 8; i++) {
    const t = i / 8
    const mt = 1 - t
    pts.push({
      x: mt * mt * p0.x + 2 * mt * t * cpx + t * t * p1.x,
      y: mt * mt * p0.y + 2 * mt * t * cpy + t * t * p1.y,
    })
  }
  g2.lineStyle(6, 0x4a2f16, 1)
  g2.strokePoints(pts)
  g2.lineStyle(2.5, 0x9a6a34, 1)
  g2.strokePoints(pts)
  // Bright spark at the fuse tip.
  const tip = pts[pts.length - 1]
  g2.fillStyle(0xff7a2a, 0.5)
  g2.fillCircle(tip.x, tip.y, 11)
  g2.fillStyle(0xf2b234, 0.9)
  g2.fillCircle(tip.x, tip.y, 7)
  g2.fillStyle(0xffd75e, 1)
  g2.fillCircle(tip.x, tip.y, 4.5)
  g2.fillStyle(0xfff6d9, 1)
  g2.fillCircle(tip.x, tip.y, 2.4)
  g2.lineStyle(2, 0xffe08a, 0.9)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4
    g2.lineBetween(tip.x, tip.y, tip.x + Math.cos(a) * 12, tip.y + Math.sin(a) * 12)
  }
  dt.draw(g2)
  g2.destroy()
  // High-contrast corner badge naming the colour this bomb clears (colourblind/low-vision read).
  stampSymbolBadge(scene, dt, symbol, tint)
}

/**
 * Primed wild-reel missile: a beveled gold capsule with a rose warhead cone, navy tail fins and a
 * glowing thruster, a symbol-coloured payload window, and BOLD cream firing arrows on both ends
 * of the axis it clears (row = horizontal, col = vertical). Reads clearly as armed + directional.
 */
function drawRocket(
  scene: Phaser.Scene,
  dt: Phaser.Textures.DynamicTexture,
  symbol: SymbolType,
  tint: number,
  horizontal: boolean
): void {
  const cx = 64
  const cy = 64
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Canonical coords point +X (nose right); the column variant swaps axes (a clean 90° turn).
  const pt = (px: number, py: number): { x: number; y: number } =>
    horizontal ? { x: cx + px, y: cy + py } : { x: cx + py, y: cy + px }
  const tri = (a: [number, number], b: [number, number], c: [number, number], color: number, alpha = 1): void => {
    const pa = pt(a[0], a[1])
    const pb = pt(b[0], b[1])
    const pc = pt(c[0], c[1])
    g.fillStyle(color, alpha)
    g.fillTriangle(pa.x, pa.y, pb.x, pb.y, pc.x, pc.y)
  }
  const rrect = (x0: number, y0: number, w: number, h: number, rad: number, color: number): void => {
    g.fillStyle(color, 1)
    if (horizontal) g.fillRoundedRect(cx + x0, cy + y0, w, h, rad)
    else g.fillRoundedRect(cx + y0, cy + x0, h, w, rad)
  }

  // Symbol-tint aura (colour identity + juice).
  g.fillStyle(tint, 0.16)
  g.fillCircle(cx, cy, 54)
  // Thruster: gold glow + flame plume at the tail.
  const glow = pt(-40, 0)
  g.fillStyle(0xf2b234, 0.45)
  g.fillCircle(glow.x, glow.y, 15)
  tri([-30, -10], [-30, 10], [-50, 0], 0xffb347)
  tri([-30, -6], [-30, 6], [-44, 0], 0xfff6d9)
  // Tail fins (navy).
  tri([-30, -13], [-30, -30], [-12, -14], 0x26304d)
  tri([-30, 13], [-30, 30], [-12, 14], 0x26304d)
  // Body capsule — beveled gold with a glossy top band.
  rrect(-31, -18, 49, 36, 16, 0xa87410)
  rrect(-30, -16, 46, 32, 14, 0xf2b234)
  rrect(-27, -14, 40, 12, 7, 0xffe6a8)
  // Warhead nose cone (rose) with a cream glint.
  tri([15, -18], [15, 18], [45, 0], 0xa8213c)
  tri([16, -16], [16, 16], [42, 0], 0xd3304f)
  tri([18, -9], [16, 3], [34, -3], 0xffd9d9, 0.55)
  // Payload window (symbol colour) mid-body.
  const win = pt(-8, 0)
  g.fillStyle(0x26304d, 1)
  g.fillCircle(win.x, win.y, 15)
  g.fillStyle(0xfffdf8, 1)
  g.fillCircle(win.x, win.y, 11)
  dt.draw(g)
  g.destroy()

  // Symbol emoji inside the window — the colour accent (÷SS: the symbol texture is supersampled).
  const base = scene.make.image({ x: 0, y: 0, key: symbol }, false)
  base.setScale(0.18 / SS)
  dt.draw(base, win.x, win.y)
  base.destroy()

  // Top pass: tint ring around the window + bold firing arrows on both ends of the axis.
  const g2 = scene.make.graphics({ x: 0, y: 0 }, false)
  g2.lineStyle(3, tint, 1)
  g2.strokeCircle(win.x, win.y, 13)
  const chevron = (tipx: number, dir: number): void => {
    const cpts = [pt(tipx - dir * 11, -13), pt(tipx, 0), pt(tipx - dir * 11, 13)]
    g2.lineStyle(9, 0x26304d, 1)
    g2.strokePoints(cpts)
    g2.lineStyle(5, 0xfff6d9, 1)
    g2.strokePoints(cpts)
  }
  chevron(53, 1)
  chevron(-53, -1)
  dt.draw(g2)
  g2.destroy()
  // High-contrast corner badge naming the colour this reel clears (colourblind/low-vision read).
  stampSymbolBadge(scene, dt, symbol, tint)
}

/**
 * A11y legibility badge (E12): a high-contrast corner chip — dark ring + cream disc + a
 * symbol-coloured ring + the actual symbol glyph at a readable size — baked into the TOP-LEFT
 * corner of a special's texture, always upright (so it reads the same whether the reel points
 * across or down). This is the reliable "which symbol does this clear?" read that the thin
 * accent ring + tiny embedded glyph can't carry on their own.
 */
function stampSymbolBadge(
  scene: Phaser.Scene,
  dt: Phaser.Textures.DynamicTexture,
  symbol: SymbolType,
  tint: number
): void {
  const bx = 27
  const by = 27
  const br = 21
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0x0b0e18, 0.9)
  g.fillCircle(bx, by, br + 3) // dark contrast ring (reads on any shell/backdrop)
  g.fillStyle(0xfffdf8, 1)
  g.fillCircle(bx, by, br) // cream disc
  g.lineStyle(3, tint, 1)
  g.strokeCircle(bx, by, br) // symbol-colour ring (keeps the colour cue)
  dt.draw(g)
  g.destroy()
  const sym = scene.make.image({ x: 0, y: 0, key: symbol }, false)
  sym.setScale(0.34 / SS) // ~34px glyph — clearly readable at cell size (÷SS: supersampled source)
  dt.draw(sym, bx, by)
  sym.destroy()
}

export function ensurePieceTexture(scene: Phaser.Scene, piece: Piece): string {
  const key = pieceTextureKey(piece)
  if (scene.textures.exists(key)) return key
  const dt = makeDT(scene, key)
  if (!dt) return piece.symbol
  const tint = SYMBOL_TINT[piece.symbol] ?? 0xf2b234
  if (piece.kind === 'diceBomb') {
    drawBomb(scene, dt, piece.symbol, tint)
  } else {
    // wildReelRow | wildReelCol — a missile pointing along the line it fires.
    drawRocket(scene, dt, piece.symbol, tint, piece.kind === 'wildReelRow')
  }
  return key
}

/**
 * Points tracing a classic heart curve, centred on (cx,cy) and normalised to `scale` (roughly the
 * heart's half-width). Screen-space y is flipped so the cusp sits up top and the tip points down.
 */
function heartPoints(cx: number, cy: number, scale: number): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = []
  const steps = 46
  for (let i = 0; i <= steps; i++) {
    const t = (Math.PI * 2 * i) / steps
    const hx = 16 * Math.pow(Math.sin(t), 3)
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
    pts.push({ x: cx + (hx / 16) * scale, y: cy - (hy / 16) * scale })
  }
  return pts
}

/**
 * Soft feathered HEART of light — a warm-white heart baked as ~10 stacked falling-alpha passes
 * (the same feathering trick as `bgglow`), pure white so it tints cleanly under ADD blend. This is
 * the foundation texture for the upcoming "Heartbloom" hero-win moment (E4); nothing consumes it
 * yet — a later phase does. Baked once (generate-once guarded), zero runtime cost.
 */
function makeHeartglow(scene: Phaser.Scene): void {
  if (scene.textures.exists('heartglow')) return
  const S = 256
  const cx = S / 2
  const cy = S / 2 - 10 // nudge up so the downward tip has room
  const passes = 10
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  for (let i = passes; i >= 1; i--) {
    g.fillStyle(0xffffff, 0.03 * (passes + 1 - i)) // outer passes = larger + fainter, inner = brighter
    g.fillPoints(heartPoints(cx, cy, S * 0.4 * (i / passes)), true)
  }
  g.generateTexture('heartglow', S, S)
  g.destroy()
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
  makeFireball(scene)
  makeShockwave(scene)
  makeConfetti(scene)
  makeChip(scene)
  makeCard(scene)
  makeBulb(scene)
  makeTile(scene)
  makeRaybeam(scene)
  makeHeartglow(scene)
  // Glyphs baked at a larger native size so they stay crisp on hi-DPI. 'heart' stays small (it's
  // only used tiny — satellites, lives pips, particle bursts); the big Home/GameScene emblems use
  // 'heartbig' (baked large) via setDisplaySize, so the small-heart particle scales are untouched.
  makeGlyphTexture(scene, 'star', '⭐', 112, 128)
  makeGlyphTexture(scene, 'lock', '🔒', 104, 128)
  makeGlyphTexture(scene, 'heart', '❤️', 44, 64)
  makeGlyphTexture(scene, 'heartbig', '❤️', 330, 384)
  // Card-suit emblem set — the Home hero shuffles through these (heart · spade · diamond · club).
  // Baked large like 'heartbig' so they stay crisp on hi-DPI; the platform emoji give classic RED
  // hearts/diamonds + BLACK spades/clubs for free (the ️ forces colour-emoji presentation).
  // All four bake into the SAME 384² frame, so the emblem can `setTexture()` between them mid-tween
  // without any size jump. Suits are decorative only — the board still uses its own symbol art.
  makeGlyphTexture(scene, 'suitHeart', '♥️', 320, 384)
  makeGlyphTexture(scene, 'suitSpade', '♠️', 320, 384)
  makeGlyphTexture(scene, 'suitDiamond', '♦️', 320, 384)
  makeGlyphTexture(scene, 'suitClub', '♣️', 320, 384)
}

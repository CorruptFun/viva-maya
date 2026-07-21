import Phaser from 'phaser'
import { SYMBOLS } from '../core/types'
import type { Piece, PieceKind, SymbolType } from '../core/types'

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
  // Layered text stack fakes an embossed, glossy cast-metal "7" (Phaser Text can't gradient
  // natively): a solid dark cast copy offset down-right for depth, a lit rose bevel edge peeking
  // up-left behind the body, the bold red body carrying a dark minted outline + soft ground
  // shadow, and a cream specular sheen nudged high-left for gloss. Same silhouette/palette as
  // before (Direction A) — the flat glyph now reads as a raised, top-lit slot 7.
  const FONT = '"Arial Black", "Helvetica Neue", Arial, sans-serif'
  const mk = (
    color: string,
    alpha: number,
    stroke?: string,
    strokeThickness?: number
  ): Phaser.GameObjects.Text => {
    const style: Phaser.Types.GameObjects.Text.TextStyle = {
      fontFamily: FONT,
      fontStyle: '900',
      fontSize: '104px',
      color,
      padding: { x: 16, y: 16 },
    }
    if (stroke !== undefined && strokeThickness !== undefined) {
      style.stroke = stroke
      style.strokeThickness = strokeThickness
    }
    const t = scene.make.text({ x: 0, y: 0, text: '7', style }, false)
    t.setAlpha(alpha)
    return t
  }
  const cast = mk('#7a1329', 0.5) // solid dark maroon cast — the emboss's deep base
  const edge = mk('#ff7a85', 0.9) // lit rose bevel edge (roseLight), peeks behind the body
  const body = mk('#e0312e', 1, '#8f1a20', 4) // red body + dark minted outline
  body.setShadow(0, 5, 'rgba(90,20,10,0.28)', 8, false, true)
  const gloss = mk('#fff3d6', 0.22) // cream specular sheen (soft high-left highlight)
  intoTexture(scene, 'seven', dt => {
    seatShadow(scene, dt)
    const place = (t: Phaser.GameObjects.Text, dx: number, dy: number): void => {
      dt.draw(t, (BASE - t.width) / 2 + dx, (BASE - t.height) / 2 + dy)
    }
    place(cast, 3, 5) // depth cast, down-right
    place(edge, -1.5, -3) // lit bevel rim, up-left (behind body)
    place(body, 0, 0) // bold red body on top
    place(gloss, -2, -3) // cream gloss sheen, up-left
  })
  cast.destroy()
  edge.destroy()
  body.destroy()
  gloss.destroy()
}

function makeBar(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = 16
  const y = 36
  const w = 96
  const h = 54
  const r = 14
  // Soft drop shadow directly under the plate — neutral black, two feathered layers.
  g.fillStyle(0x000000, 0.14)
  g.fillRoundedRect(x, y + 7, w, h, r)
  g.fillStyle(0x000000, 0.14)
  g.fillRoundedRect(x, y + 4, w, h, r)
  // Navy plate body.
  g.fillStyle(0x26304d, 1)
  g.fillRoundedRect(x, y, w, h, r)
  // Glossy top highlight — lighter-navy bands anchored at the crown, brightest + narrowest on
  // top (stacked flat bands; Phaser 3.90 only fillGradientStyles reliably on fillRect, so the
  // pill gloss is faked with alpha bands like makeTile's dome — square bottoms sit hidden mid-body).
  const hi: Array<[number, number, number]> = [
    [30, 0x3a4778, 0.55],
    [20, 0x4a5a8f, 0.42],
    [11, 0x5f70a8, 0.32],
  ]
  for (const [bh, col, a] of hi) {
    g.fillStyle(col, a)
    g.fillRoundedRect(x, y, w, bh, { tl: r, tr: r, bl: 0, br: 0 })
  }
  // Gradient-shaded body — darker toward the bottom (black-alpha bands anchored at the base,
  // rounded bottom corners matching the pill; square tops hide mid-body).
  for (const [f, a] of [[0.52, 0.06], [0.7, 0.07], [0.86, 0.1]] as Array<[number, number]>) {
    g.fillStyle(0x000000, a)
    g.fillRoundedRect(x, y + h * f, w, h * (1 - f), { tl: 0, tr: 0, bl: r, br: r })
  }
  // Bevel frame: a dark bottom groove (shifted low → the shaded underside), a crisp gold-bezel
  // frame, and a lit gold inner top edge — a raised chrome-and-gold slot plate.
  g.lineStyle(3, 0x141a2e, 0.85)
  g.strokeRoundedRect(x, y + 2, w, h, r)
  g.lineStyle(3, 0xf2c14e, 1)
  g.strokeRoundedRect(x, y, w, h, r)
  g.lineStyle(1.5, 0xffe08a, 0.85)
  g.strokeRoundedRect(x + 2, y + 1, w - 4, h - 4, r - 2)
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
    // Embossed 'BAR': a dark edge copy (offset down-right) + a light glint (offset up-left) under
    // the full gold body drawn last, so the glyph stays fully legible while its edges read carved.
    const bx = (BASE - text.width) / 2
    const by = y + (h - text.height) / 2
    text.setColor('#3a2405')
    dt.draw(text, bx + 1.5, by + 2)
    text.setColor('#fff3d6')
    dt.draw(text, bx - 1, by - 1.5)
    text.setColor('#ffd75e')
    dt.draw(text, bx, by)
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

/**
 * JACKPOT token — a minted, top-lit GOLD coin behind the 🎰 glyph (Direction B: bold casino-lux).
 * Built like makeMedallion/drawBomb but in full gold: a warm radial halo, a soft contact shadow, a
 * dark rim GROOVE, a reeded/milled outer edge (alternating bright-ridge + dark-groove radial ticks
 * that read as 3D milling even when the coin blurs to ~73px on the board), a raised domed face faked
 * with stacked falling-alpha gold discs pushed UPWARD (deep gold at the belly → cream at the crown,
 * since Phaser 3.90 can't gradient a circle), a lit/dark bevel step, and a broad crown gloss +
 * specular. The 🎰 emoji is drawn LAST so it stays crisp on top. 128-space, baked ×2 → 256².
 */
function makeJackpot(scene: Phaser.Scene): void {
  const c = 64
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Soft contact shadow so the token reads SEATED on its tile (neutral black, feathered — the
  // seatShadow idiom, sized round for the coin). Drawn first; the opaque disc covers its top.
  g.fillStyle(0x000000, 0.09)
  g.fillEllipse(c, c + 9, 108, 98)
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(c, c + 7, 98, 88)
  g.fillStyle(0x000000, 0.12)
  g.fillEllipse(c, c + 5, 86, 78)
  // Milled outer rim base (goldDeep) — the reeded knurl sits on this dark ground.
  g.fillStyle(0xc9930a, 1)
  g.fillCircle(c, c, 52)
  // Reeded / knurled edge: alternating LIT + SHADOWED radial teeth so the rim reads as 3D milling
  // (light facet + dark facet per notch) instead of the old flat gold ring. Chunky enough (18 teeth)
  // to survive the downscale to ~73px — dimensional shimmer, not vanishing filigree.
  const teeth = 18
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2
    const co = Math.cos(a)
    const si = Math.sin(a)
    const lit = i % 2 === 0
    g.lineStyle(3.6, lit ? 0xffd75e : 0x7a5a08, lit ? 0.9 : 0.85)
    g.lineBetween(c + co * 43, c + si * 43, c + co * 51, c + si * 51)
  }
  // Dark rim GROOVE — the recessed channel between the milled edge and the raised face.
  g.lineStyle(4, 0x7a5a08, 0.55)
  g.strokeCircle(c, c, 43)
  // Raised domed face: goldBezel base, then a brighter goldBright upper form offset UP (the drawBomb
  // lit-dome idiom) — the base gold left showing along the bottom becomes the shaded underside.
  g.fillStyle(0xf2c14e, 1)
  g.fillCircle(c, c, 41)
  g.fillStyle(0xffd75e, 1)
  g.fillCircle(c, c - 5, 34)
  // Warm cream light pool near the crown → the top-lit highlight of the dome.
  g.fillStyle(0xfff3d6, 0.5)
  g.fillCircle(c, c - 10, 20)
  // Underside shading — black-alpha ellipses hugging the lower face (kept inside the r41 disc so the
  // shadow never spills onto the rim), deepening the bottom of the dome.
  g.fillStyle(0x000000, 0.08)
  g.fillEllipse(c, c + 28, 58, 20)
  g.fillStyle(0x000000, 0.09)
  g.fillEllipse(c, c + 34, 46, 14)
  // Bevel ring on the face edge + a lit inner ring → the face reads minted, not printed.
  g.lineStyle(2.5, 0x7a5a08, 0.5)
  g.strokeCircle(c, c, 40)
  g.lineStyle(2, 0xffd75e, 0.6)
  g.strokeCircle(c, c, 37)
  // Top gloss crescent + specular sheen at the crown, above where the emoji sits.
  g.fillStyle(0xfffdf8, 0.32)
  g.fillEllipse(c, c - 24, 34, 11)
  g.fillStyle(0xffffff, 0.5)
  g.fillEllipse(c - 8, c - 26, 13, 5)
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
  // Seated contact shadow — a soft dark ellipse under the token so it grounds on
  // the HUD rail instead of floating (kept low + wide so only a sliver peeks past
  // the rim at the bottom; neutral black reads as depth at every size).
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(c, 46, 42, 9)
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(c, 46, 30, 7)

  // Rim BEVEL: three stacked discs fake a lit rounded rim — deep rose shadow at
  // the lower-right, bright rose at the upper-left, main tone between (the same
  // offset-disc trick drawBomb uses for its lit upper form). Keeps the silhouette.
  g.fillStyle(0xa8213c, 1) // roseDeep — shadowed lower-right crescent
  g.fillCircle(c, c, r)
  g.fillStyle(0xff7a85, 1) // roseLight — lit upper-left edge
  g.fillCircle(c - 1.6, c - 1.8, r - 0.6)
  g.fillStyle(0xc4223e, 1) // original rim tone (identity preserved)
  g.fillCircle(c - 0.4, c - 0.6, r - 2.4)

  // 8 cream edge spots — each with a faint black seat so it reads inset, then the
  // cream nudged up into the light for a hair of relief.
  const sr = r * 0.82
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const sx = c + Math.cos(a) * sr
    const sy = c + Math.sin(a) * sr
    g.fillStyle(0x000000, 0.16) // dark seat under the spot
    g.fillCircle(sx, sy + 0.6, 3.7)
    g.fillStyle(0xfff3d6, 1) // cream spot
    g.fillCircle(sx, sy - 0.4, 3.2)
  }

  // Gold inner ring — beveled with the same three-disc trick: goldDeep groove,
  // goldBright lit edge, gold main tone.
  g.fillStyle(0xc9930a, 1) // goldDeep — groove / lower-right shadow
  g.fillCircle(c, c, r * 0.62 + 1)
  g.fillStyle(0xffd75e, 1) // goldBright — lit upper-left
  g.fillCircle(c - 1, c - 1.2, r * 0.62)
  g.fillStyle(0xf2b234, 1) // gold main tone
  g.fillCircle(c - 0.3, c - 0.4, r * 0.62 - 1.4)

  // Cream face with subtle CONCAVE shading (black pooled low) + a top-lit sheen,
  // so the recessed centre reads dished instead of flat.
  g.fillStyle(0xfff3d6, 1)
  g.fillCircle(c, c, r * 0.5)
  g.fillStyle(0x000000, 0.08) // concave shadow across the lower face
  g.fillEllipse(c, c + 4, r * 0.9, r * 0.5)
  g.fillStyle(0xffffff, 0.45) // top-lit sheen on the upper face
  g.fillEllipse(c - 1.5, c - 4, r * 0.62, r * 0.34)

  // Center pip — a small rose dome pressed into the face (dark seat, deep base,
  // lit top offset up, tiny specular), matching drawBomb's dome+specular idiom.
  const pr = r * 0.22
  g.fillStyle(0x000000, 0.1) // pressed-in seat around the pip
  g.fillCircle(c, c + 0.5, pr + 1.6)
  g.fillStyle(0xa8213c, 1) // roseDeep base
  g.fillCircle(c, c + 0.4, pr)
  g.fillStyle(0xd3304f, 1) // rose top (offset up = lit dome)
  g.fillCircle(c, c - 0.4, pr - 0.6)
  g.fillStyle(0xff7a85, 0.7) // specular highlight
  g.fillCircle(c - 1, c - 1.6, pr * 0.34)

  // Unifying GLOSS sweep across the whole upper half — the signature glassy arc
  // that ties rim + ring + face into one top-lit 3D token. Faint so it never
  // washes out the palette.
  g.fillStyle(0xffffff, 0.11)
  g.fillEllipse(c - 2, c - 9, r * 1.5, r * 0.9)

  g.generateTexture('chip', 48, 48)
  g.destroy()
}

/** Mini playing card (red diamond pip) — a glossy stock card so it reads dimensional beside the
 * minted chip in the win-burst spray. A top-lit stock (warm belly -> lit upper -> a gloss sweep),
 * a soft two-tone bevel frame, and a RAISED diamond pip (dark seat -> rose face -> cream glint),
 * matching the depth idiom of makeChip. Same 40x56 'card' key; nothing downstream moves. */
function makeCard(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const w = 40
  const h = 56
  const r = 7
  // Stock as a shallow top-lit dome: warm belly base, a lit upper band, then a soft gloss sweep.
  g.fillStyle(0xf1e6cf, 1)
  g.fillRoundedRect(0, 0, w, h, r) // warm belly
  g.fillStyle(0xfffdf8, 1)
  g.fillRoundedRect(0, 0, w, h * 0.56, { tl: r, tr: r, bl: 0, br: 0 }) // lit upper
  g.fillStyle(0xffffff, 0.4)
  g.fillEllipse(w / 2 - 2, h * 0.2, w * 0.9, h * 0.28) // gloss sweep across the top
  // Two-tone bevel frame: a warm seated outer edge + a fine bright top rim.
  g.lineStyle(1.5, 0xe0d4b8, 1)
  g.strokeRoundedRect(0.75, 0.75, w - 1.5, h - 1.5, r - 0.5)
  g.lineStyle(1, 0xffffff, 0.55)
  g.strokeRoundedRect(2, 1.5, w - 4, h - 4, r - 1.5)
  const cx = w / 2
  const cy = h / 2
  const diamond = (dx: number, dy: number): Array<{ x: number; y: number }> => [
    { x: cx + dx, y: cy - 11 + dy },
    { x: cx + 8 + dx, y: cy + dy },
    { x: cx + dx, y: cy + 11 + dy },
    { x: cx - 8 + dx, y: cy + dy },
  ]
  // Raised diamond pip: a dark seat below, the rose face, and a cream top glint (top-lit dome).
  g.fillStyle(0x000000, 0.12)
  g.fillPoints(diamond(0, 1.4), true) // pressed seat
  g.fillStyle(0xa8213c, 1)
  g.fillPoints(diamond(0, 0.5), true) // deep base
  g.fillStyle(0xd3304f, 1)
  g.fillPoints(diamond(0, -0.5), true) // rose face lifted toward the light
  g.fillStyle(0xff8a97, 0.65)
  g.fillPoints(
    [
      { x: cx, y: cy - 8 },
      { x: cx + 4, y: cy - 3.5 },
      { x: cx, y: cy - 1 },
      { x: cx - 4, y: cy - 3.5 },
    ],
    true
  ) // cream/rose top glint
  // Corner pips (kept from the original identity).
  g.fillStyle(0xd3304f, 1)
  g.fillCircle(7, 8, 2.4)
  g.fillCircle(w - 7, h - 8, 2.4)
  g.generateTexture('card', 40, 56)
  g.destroy()
}

/**
 * Marquee bulb — a lit GLASS LAMP (white-body so it tints gold/rose/accent per position, on every
 * theme). Structure is ALPHA-ONLY (never hue) so setTint stays true: a soft glass bloom holding the
 * old ~r8 footprint (nothing shifts in world space), a translucent envelope with the light pooled
 * UP-LEFT so the lower-right belly falls off, a hot filament core + peak, a thin glass rim that reads
 * as blown glass (not a glow blob), and an off-centre specular glint whose brightness survives the
 * tint. The premium lit-lamp read at its 13–20px display sizes vs the old flat concentric rings.
 * Key 'bulb', 16×16 — both unchanged.
 */
function makeBulb(scene: Phaser.Scene): void {
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Glass bloom + halo — the lamp's soft glow (same ~r8 extent the old bulb had).
  g.fillStyle(0xffffff, 0.16)
  g.fillCircle(8, 8, 8)
  g.fillStyle(0xffffff, 0.26)
  g.fillCircle(8, 8, 6.6)
  // Translucent glass envelope.
  g.fillStyle(0xffffff, 0.44)
  g.fillCircle(8, 8, 5.4)
  // Light pooled up-left inside the glass — the lit interior; leaving the envelope showing lower-right
  // as the shaded belly (the offset-disc lit-dome trick, in alpha).
  g.fillStyle(0xffffff, 0.64)
  g.fillCircle(7.6, 7.4, 4.2)
  // Hot filament core + peak.
  g.fillStyle(0xffffff, 0.9)
  g.fillCircle(7.4, 7.2, 2.5)
  g.fillStyle(0xffffff, 1)
  g.fillCircle(7.3, 7.1, 1.1)
  // Thin glass rim — the envelope edge catching light, so it reads as blown glass.
  g.lineStyle(1, 0xffffff, 0.4)
  g.strokeCircle(8, 8, 5.5)
  // Off-centre specular glint (upper-left) — brightness contrast carries it through the tint.
  g.fillStyle(0xffffff, 0.9)
  g.fillCircle(5.7, 5.8, 1.5)
  g.fillStyle(0xffffff, 1)
  g.fillCircle(5.5, 5.6, 0.7)
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
  // (§R3 depth pass: a touch denser than the original 0.10s, so the cushions sit deeper IN the well.)
  g.fillStyle(0x000000, 0.12)
  g.fillRoundedRect(m, m + 5, bw, bw, r)
  g.fillStyle(0x000000, 0.12)
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
  // Faint seated-edge bevel (dark → survives tint) for tile-to-tile separation. (§R3: a hair
  // stronger than the original 0.09 so pieces read as seated IN a well, not floating on a sheet.)
  g.lineStyle(2.5, 0x000000, 0.11)
  g.strokeRoundedRect(m, m, bw, bw, r)
  g.generateTexture('tile', S, S)
  g.destroy()
}

/**
 * Soft rounded ELEVATION shadow (§R3 depth stack) — a feathered neutral-black rounded square baked
 * once with the same stacked falling-alpha trick as `bgglow`, but rounded to match the app's
 * card/slab silhouettes. Pure black so it stays a neutral darkener on every theme wash (tint is
 * pointless on black — 0×tint = 0), display-scaled + alpha'd at the use site, NORMAL blend. This is
 * the one shared "the surface floats" underlay for the board cabinet and the HUD rail: bake once,
 * draw as plain Images, zero per-frame cost.
 */
function makeSoftShadow(scene: Phaser.Scene): void {
  if (scene.textures.exists('softshadow')) return
  const S = 256
  const passes = 12
  const feather = 44 // px of feathered falloff baked around the dense core rect
  const edge = 8 // clear margin so the outermost pass never clips at the texture edge
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  for (let i = 0; i < passes; i++) {
    const inset = edge + feather * (i / (passes - 1)) // outermost (largest) → innermost (core)
    const a = 0.028 * (i + 1) // faint rim → dense centre; stacking composites to a soft gradient
    g.fillStyle(0x000000, a)
    g.fillRoundedRect(inset, inset, S - inset * 2, S - inset * 2, Math.max(14, 46 - i * 2.5))
  }
  g.generateTexture('softshadow', S, S)
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

/**
 * Score MEDALLION (§R3 reward layer) — ONE chunky star-burst coin baked for every "+N" match
 * medallion. Same tint-stability trick as the board tile: the body is PURE WHITE (a single
 * `setTint()` colours the whole medallion warm gold → bright gold → rose across the cascade) and
 * all shading is BLACK-alpha (0×tint = stays neutral-dark), so rays read as chunky facets and the
 * disc reads as a raised coin face on every heat tint. The "+N" is a Phaser Text layered on top at
 * the use site. Baked once, pooled at the use site (hard cap), zero per-frame cost.
 */
function makeMedallion(scene: Phaser.Scene): void {
  if (scene.textures.exists('medallion')) return
  const S = 112
  const c = S / 2
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Soft radial halo — concentric falling-alpha white discs (tint turns them into warm glow).
  // This replaces the old 12-point star-burst, which read as a flat cartoon sun against the
  // board's glossy dimensional art (owner feedback, 2026-07-21). Light, not geometry.
  for (let r = 54, a = 0.045; r >= 38; r -= 4, a += 0.02) {
    g.fillStyle(0xffffff, a)
    g.fillCircle(c, c, r)
  }
  // Soft drop shadow under the coin (neutral black → survives every heat tint).
  g.fillStyle(0x000000, 0.16)
  g.fillEllipse(c, c + 4, 74, 68)
  // Coin: dark rim groove → raised white face → top-lit dome shading (the house gold-token look).
  g.fillStyle(0x000000, 0.18)
  g.fillCircle(c, c, 37)
  g.fillStyle(0xffffff, 1)
  g.fillCircle(c, c, 33)
  g.fillStyle(0x000000, 0.08)
  g.fillEllipse(c, c + 13, 58, 30)
  // Bevel ring on the face edge + a faint inner ring so the face reads minted, not flat.
  g.lineStyle(2.5, 0x000000, 0.13)
  g.strokeCircle(c, c, 32)
  g.lineStyle(1.5, 0x000000, 0.07)
  g.strokeCircle(c, c, 27)
  g.generateTexture('medallion', S, S)
  g.destroy()
}

/**
 * Star GLINT (§R3 reward layer) — a crisp 4-point light star (thin diamond cross + soft halo +
 * hot core), pure white for clean ADD-blend tinting. The shared sparkle for special payoffs:
 * jackpot conversion pops, bomb spark spray, collect-comet arrival ticks. Baked once.
 */
function makeGlint(scene: Phaser.Scene): void {
  if (scene.textures.exists('glint')) return
  const S = 48
  const c = S / 2
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  g.fillStyle(0xffffff, 0.16)
  g.fillCircle(c, c, 13) // soft halo
  const ray = (len: number, half: number, vertical: boolean): void => {
    const pts = vertical
      ? [{ x: c, y: c - len }, { x: c + half, y: c }, { x: c, y: c + len }, { x: c - half, y: c }]
      : [{ x: c - len, y: c }, { x: c, y: c + half }, { x: c + len, y: c }, { x: c, y: c - half }]
    g.fillPoints(pts, true)
  }
  g.fillStyle(0xffffff, 0.9)
  ray(21, 3.4, true)
  ray(21, 3.4, false)
  g.fillStyle(0xffffff, 1)
  g.fillCircle(c, c, 3.2) // hot core
  g.generateTexture('glint', S, S)
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
  makeSoftShadow(scene) // §R3 — shared elevation shadow for the board slab + HUD rail
  makeMedallion(scene) // §R3 reward layer — score medallion star-burst
  makeGlint(scene) // §R3 reward layer — 4-point star sparkle for special payoffs
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

/**
 * Pre-bake the piece signatures the first in-game cascade would otherwise bake LAZILY, so a cold
 * PWA's opening deal-in never hitches (BT2). Only the special overlays are lazy — normal-symbol and
 * jackpot art is already baked by `createAllTextures` (`ensurePieceTexture` self-skips those keys) —
 * so we front-load every symbol × special the board can spawn (6 × 3 = 18 signatures) through the
 * very `ensurePieceTexture` the cascade uses, then pre-touch the board tile + core deal-in/burst
 * particles in case warm-up ever runs before `createAllTextures`. Everything is generate-once
 * guarded (`ensurePieceTexture` skips existing keys; each particle pre-touch skips a key already
 * present), so this costs only a few ms once at boot with zero runtime cost. Mirrors
 * `ui.warmButtonTextures`; adds no visible boot change (BootScene stays hard/instant by design).
 */
export function warmPieceTextures(scene: Phaser.Scene): void {
  // Special overlays are the ONLY piece art baked on first use: a symbol-tinted bomb/reel drawn over
  // the belly. Warm all match-4 wild-reels (row + col) and L/T dice-bombs across every symbol — the
  // full set a first cascade can detonate. `id: -1` marks a synthetic piece (the key ignores id).
  const specials: PieceKind[] = ['wildReelRow', 'wildReelCol', 'diceBomb']
  for (const symbol of SYMBOLS) {
    for (const kind of specials) {
      ensurePieceTexture(scene, { id: -1, symbol, kind })
    }
  }
  // Pre-touch the glossy board tile + the primary deal-in/burst particles so warm-up is self-
  // sufficient. In the real boot flow `createAllTextures` already baked these, so the exists() guard
  // makes each a no-op — we never re-generate (and warn on) a live texture key.
  if (!scene.textures.exists('tile')) makeTile(scene)
  if (!scene.textures.exists('softshadow')) makeSoftShadow(scene)
  if (!scene.textures.exists('spark')) makeSpark(scene)
  if (!scene.textures.exists('ring')) makeRing(scene)
  if (!scene.textures.exists('confetti')) makeConfetti(scene)
  if (!scene.textures.exists('fireball')) makeFireball(scene)
  if (!scene.textures.exists('shockwave')) makeShockwave(scene)
  if (!scene.textures.exists('medallion')) makeMedallion(scene)
  if (!scene.textures.exists('glint')) makeGlint(scene)
}

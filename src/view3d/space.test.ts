import { describe, expect, it } from 'vitest'
import { computeStageView, frustumHeightAt, frustumWidthAt, projectToNdc, STAGE_FOV_DEG } from './space'

/**
 * The alignment contract: under the solved camera, a Z=0 stage point at Phaser
 * world (x, y) must project to the same screen spot Phaser draws (x, y) at.
 * Screen px → NDC: ndcX = (px/vw)·2 − 1, ndcY = 1 − (py/vh)·2.
 */
function phaserScreenToNdc(px: number, py: number, vw: number, vh: number): { x: number; y: number } {
  return { x: (px / vw) * 2 - 1, y: 1 - (py / vh) * 2 }
}

/** Phaser world → CSS screen under FIT: the linear map the game itself uses. */
function worldToScreen(
  wx: number,
  wy: number,
  canvasLeft: number,
  canvasTop: number,
  scale: number,
  scrollY: number
): { px: number; py: number } {
  return { px: canvasLeft + wx * scale, py: canvasTop + (wy - scrollY) * scale }
}

describe('computeStageView', () => {
  it('maps a full-bleed tall phone (canvas fills viewport, grown world, anchored scroll)', () => {
    // iPhone-ish: 390×844 CSS; worldH grows to round(720·844/390) = 1558; content
    // anchored 80 world px from the top (scrollY = −80).
    const v = computeStageView({
      viewportW: 390,
      viewportH: 844,
      canvasLeft: 0,
      canvasTop: 0,
      canvasWidth: 390,
      designW: 720,
      scrollY: -80,
    })
    expect(v.worldLeft).toBeCloseTo(0, 6)
    expect(v.worldRight).toBeCloseTo(720, 6)
    expect(v.camX).toBeCloseTo(360, 6)
    expect(v.worldTop).toBeCloseTo(-80, 6)
    // 844 CSS px at scale 390/720 → 1558.15 world units tall.
    expect(v.worldBottom).toBeCloseTo(-80 + (844 * 720) / 390, 4)
    expect(v.aspect).toBeCloseTo(390 / 844, 6)
    // Frustum height at Z=0 equals the viewport height in world units.
    expect(frustumHeightAt(v, 0)).toBeCloseTo(v.worldH, 6)
    expect(frustumWidthAt(v, 0)).toBeCloseTo(v.worldW, 4)
  })

  it('maps a letterboxed tablet (centred canvas, un-grown world, no scroll)', () => {
    // 1024×768 landscape: canvas CSS height 768 → width 768·720/1280 = 432,
    // centred at left = 296. Letterbox strips extend the world past [0, 720].
    const v = computeStageView({
      viewportW: 1024,
      viewportH: 768,
      canvasLeft: 296,
      canvasTop: 0,
      canvasWidth: 432,
      designW: 720,
      scrollY: 0,
    })
    const scale = 432 / 720
    expect(v.camX).toBeCloseTo(360, 6) // canvas centred → camera on the design centre
    expect(v.camY).toBeCloseTo(640, 6)
    expect(v.worldLeft).toBeCloseTo(-296 / scale, 4)
    expect(v.worldRight).toBeCloseTo((1024 - 296) / scale, 4)
    expect(v.worldTop).toBeCloseTo(0, 6)
    expect(v.worldBottom).toBeCloseTo(1280, 4)
  })

  it('projects Z=0 world points onto exactly Phaser’s screen positions', () => {
    const input = {
      viewportW: 390,
      viewportH: 844,
      canvasLeft: 0,
      canvasTop: 0,
      canvasWidth: 390,
      designW: 720,
      scrollY: -64,
    }
    const v = computeStageView(input)
    const scale = input.canvasWidth / input.designW
    // Board centre, board corners, HUD text spot — the places alignment matters.
    const samples: Array<[number, number]> = [
      [360, 620],
      [40, 300],
      [680, 940],
      [64, 84],
      [360, -64], // very top of the visible world
    ]
    for (const [wx, wy] of samples) {
      const { px, py } = worldToScreen(wx, wy, input.canvasLeft, input.canvasTop, scale, input.scrollY)
      const want = phaserScreenToNdc(px, py, input.viewportW, input.viewportH)
      const got = projectToNdc(v, wx, wy, 0)
      expect(got.x).toBeCloseTo(want.x, 6)
      expect(got.y).toBeCloseTo(want.y, 6)
    }
  })

  it('keeps deep layers moving less than the game plane under camera parallax', () => {
    const v = computeStageView({
      viewportW: 390,
      viewportH: 844,
      canvasLeft: 0,
      canvasTop: 0,
      canvasWidth: 390,
      designW: 720,
      scrollY: 0,
    })
    const dx = 8 // max pointer parallax, world units
    const at0 = projectToNdc(v, 360, 620, 0, dx, 0).x - projectToNdc(v, 360, 620, 0).x
    const atDeep = projectToNdc(v, 360, 620, -600, dx, 0).x - projectToNdc(v, 360, 620, -600).x
    // Both shift opposite the camera, the deep layer by measurably less — that
    // differential IS the parallax depth cue.
    expect(Math.abs(at0)).toBeGreaterThan(Math.abs(atDeep))
    expect(Math.abs(atDeep)).toBeGreaterThan(0)
    // And the game-plane shift from a full 8-unit offset stays a soft-glow-invisible
    // ~8 world px (≈ 4 CSS px on this phone) — the "nothing needs re-anchoring" bound.
    expect(Math.abs(at0) * (v.worldW / 2)).toBeCloseTo(dx, 4)
  })

  it('survives degenerate zero-size input with a sane design-box fallback', () => {
    const v = computeStageView({
      viewportW: 0,
      viewportH: 0,
      canvasLeft: 0,
      canvasTop: 0,
      canvasWidth: 0,
      designW: 720,
      scrollY: 0,
    })
    expect(v.worldW).toBeCloseTo(720, 6)
    expect(v.dist).toBeGreaterThan(0)
    expect(Number.isFinite(v.aspect)).toBe(true)
    expect(v.fovDeg).toBe(STAGE_FOV_DEG)
  })
})

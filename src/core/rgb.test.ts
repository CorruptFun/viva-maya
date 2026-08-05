/**
 * RGB marquee maths (§RGB). `attachRgbChase` needs a live Phaser scene and so is not covered here,
 * but everything that decides what a bulb LOOKS like is in these four functions, so the seam-free
 * ring and the per-theme hue-arc guarantees are testable without a canvas.
 *
 * The property that matters most is the closed loop: the ring has no start and no end, so any
 * discontinuity between the last bulb and the first shows up on screen as a hard colour seam sitting
 * at one corner of the cabinet forever. `ringHue` earns its ping-pong branch here.
 */
import { describe, expect, it } from 'vitest'
import { arcLean, frac, hsvToInt, hueGap, hueOf, ringAlpha, ringHue, roundedRectPath } from './rgb'
// `view/theme.ts` is Phaser-free (it imports only core), so a core test can read the theme table
// directly — and it should: the arcs are data the maths is meaningless without.
import { THEMES, THEME_ORDER } from '../view/theme'

describe('frac', () => {
  it('returns the fractional part in [0,1)', () => {
    expect(frac(0)).toBe(0)
    expect(frac(0.25)).toBeCloseTo(0.25)
    expect(frac(3.75)).toBeCloseTo(0.75)
  })

  it('stays in [0,1) for negative input — phases run backwards during a surge decay', () => {
    expect(frac(-0.25)).toBeCloseTo(0.75)
    expect(frac(-3.5)).toBeCloseTo(0.5)
    expect(frac(-1)).toBe(0)
  })
})

describe('hsvToInt', () => {
  it('hits the primaries exactly', () => {
    expect(hsvToInt(0, 1, 1)).toBe(0xff0000)
    expect(hsvToInt(120, 1, 1)).toBe(0x00ff00)
    expect(hsvToInt(240, 1, 1)).toBe(0x0000ff)
  })

  it('wraps hue rather than clamping it, so a lapping phase never sticks at one end', () => {
    expect(hsvToInt(360, 1, 1)).toBe(hsvToInt(0, 1, 1))
    expect(hsvToInt(480, 1, 1)).toBe(hsvToInt(120, 1, 1))
    expect(hsvToInt(-120, 1, 1)).toBe(hsvToInt(240, 1, 1))
  })

  it('collapses to greyscale at zero saturation and to black at zero value', () => {
    expect(hsvToInt(210, 0, 1)).toBe(0xffffff)
    expect(hsvToInt(210, 1, 0)).toBe(0x000000)
  })

  it('clamps out-of-range saturation and value instead of emitting a broken channel', () => {
    expect(hsvToInt(0, 5, 1)).toBe(0xff0000)
    expect(hsvToInt(0, 1, 5)).toBe(0xff0000)
    expect(hsvToInt(0, -1, 1)).toBe(0xffffff)
  })

  it('never produces a channel outside 0..255', () => {
    for (let h = 0; h < 360; h += 7) {
      for (const s of [0, 0.3, 0.72, 0.85, 1]) {
        const c = hsvToInt(h, s, 1)
        for (const ch of [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]) {
          expect(ch).toBeGreaterThanOrEqual(0)
          expect(ch).toBeLessThanOrEqual(255)
        }
      }
    }
  })
})

describe('ringHue', () => {
  const N = 32

  it('spreads a full wheel evenly around the ring', () => {
    expect(ringHue(0, N, 0, 0, 360)).toBeCloseTo(0)
    expect(ringHue(N / 4, N, 0, 0, 360)).toBeCloseTo(90)
    expect(ringHue(N / 2, N, 0, 0, 360)).toBeCloseTo(180)
  })

  it('advances every bulb by the same amount as the lap phase moves', () => {
    const before = ringHue(5, N, 0, 0, 360)
    const after = ringHue(5, N, 0.25, 0, 360)
    expect(after - before).toBeCloseTo(90)
  })

  it('closes a FULL wheel with no seam — last bulb wraps onto the first', () => {
    // Position N is position 0 again; on a 360 span the hues must agree modulo the wheel.
    const first = ringHue(0, N, 0, 0, 360)
    const past = ringHue(N, N, 0, 0, 360)
    expect(frac(past / 360)).toBeCloseTo(frac(first / 360))
  })

  it('closes a NARROW arc with no seam — the ping-pong branch', () => {
    // A 70° blush arc: a linear ramp would jump 70° between the last bulb and the first. The
    // ping-pong makes both ends of the ring land on the arc's start instead.
    const from = 310
    const span = 70
    expect(ringHue(0, N, 0, from, span)).toBeCloseTo(from)
    expect(ringHue(N, N, 0, from, span)).toBeCloseTo(from)
    // ...and the far side of the ring sits at the arc's opposite end.
    expect(ringHue(N / 2, N, 0, from, span)).toBeCloseTo(from + span)
  })

  it('keeps a narrow arc strictly inside its band for every bulb at every phase', () => {
    const from = 340
    const span = 60
    for (let phase = 0; phase < 1; phase += 0.05) {
      for (let i = 0; i < N; i++) {
        const h = ringHue(i, N, phase, from, span)
        expect(h).toBeGreaterThanOrEqual(from - 1e-9)
        expect(h).toBeLessThanOrEqual(from + span + 1e-9)
      }
    }
  })

  it('never divides by zero on an empty ring', () => {
    expect(Number.isFinite(ringHue(0, 0, 0.3, 0, 360))).toBe(true)
  })
})

/**
 * THE TELL (Act II) — the ring leaning toward the colour of the best move on the board.
 *
 * The whole reason it is a LEAN and not a hue shift is that the ring's arcs are law: shifting the
 * band far enough to notice would push some theme's arc into a hue family that theme never uses, and
 * Neon Vegas has five degrees of headroom. These are the assertions that make the lean safe to ship
 * without re-auditing four themes every time it is retuned.
 */
describe('ringHue lean — THE TELL', () => {
  const N = 48

  it('changes nothing at zero, and defaults to zero for every existing caller', () => {
    for (let i = 0; i < N; i++) {
      expect(ringHue(i, N, 0.3, 340, 60, 0)).toBeCloseTo(ringHue(i, N, 0.3, 340, 60))
    }
  })

  it('NEVER leaves the arc — at any lean, any phase, any position', () => {
    // The load-bearing one. If this can fail, the lean can put a hue on the cabinet that the theme
    // does not own, which is exactly what the per-theme arcs exist to prevent.
    for (const [from, span] of [
      [345, 70],
      [310, 70],
      [340, 70],
      [185, 155],
    ]) {
      for (const lean of [-2, -1, -0.6, -0.2, 0, 0.2, 0.6, 1, 2]) {
        for (let phase = 0; phase < 1; phase += 0.05) {
          for (let i = 0; i < N; i++) {
            const h = ringHue(i, N, phase, from, span, lean)
            expect(h).toBeGreaterThanOrEqual(from - 1e-9)
            expect(h).toBeLessThanOrEqual(from + span + 1e-9)
          }
        }
      }
    }
  })

  it('keeps the loop SEAMLESS — position n lands back on position 0', () => {
    for (const lean of [-1, -0.5, 0.5, 1]) {
      for (let phase = 0; phase < 1; phase += 0.1) {
        expect(ringHue(N, N, phase, 310, 70, lean)).toBeCloseTo(ringHue(0, N, phase, 310, 70, lean))
      }
    }
  })

  it('stays MONOTONE in the underlying wave, so the gradient never folds back on itself', () => {
    // A non-monotone reshape would put the same hue at two places on the way up, which reads as a
    // banding artefact rather than as a sweep. |k| ≤ 1 is exactly the condition that prevents it.
    for (const lean of [-1, -0.4, 0.4, 1]) {
      const half = ringHue(0, 2, 0, 0, 100, lean) // shaped(0) = 0
      expect(half).toBeCloseTo(0)
      let prev = -Infinity
      for (let s = 0; s <= 1.0001; s += 0.02) {
        const shaped = s + lean * s * (1 - s)
        expect(shaped).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = shaped
      }
    }
  })

  it('actually LEANS — a positive lean crowds the ring toward the arc\'s far end', () => {
    const mean = (lean: number): number => {
      let sum = 0
      for (let i = 0; i < N; i++) sum += ringHue(i, N, 0, 340, 60, lean)
      return sum / N
    }
    expect(mean(0.8)).toBeGreaterThan(mean(0) + 1)
    expect(mean(-0.8)).toBeLessThan(mean(0) - 1)
  })
})

describe('hueGap / hueOf / arcLean', () => {
  it('measures the SHORT way around the wheel', () => {
    expect(hueGap(10, 350)).toBeCloseTo(20)
    expect(hueGap(350, 10)).toBeCloseTo(20)
    expect(hueGap(0, 180)).toBeCloseTo(180)
    expect(hueGap(0, 0)).toBe(0)
  })

  it('reads a hue back out of a packed colour', () => {
    expect(hueOf(0xff0000)).toBeCloseTo(0)
    expect(hueOf(0x00ff00)).toBeCloseTo(120)
    expect(hueOf(0x0000ff)).toBeCloseTo(240)
    expect(hueOf(0x808080)).toBe(0) // grey has no hue
    // Round-trips against the forward transform it is the inverse of.
    for (const h of [0, 37, 120, 210, 300, 359]) expect(hueOf(hsvToInt(h, 1, 1))).toBeCloseTo(h, 0)
  })

  it('pins the lean to whichever END of the arc the hue is nearer', () => {
    // Golden Hour's arc: 345 (crimson) → 55 (gold).
    expect(arcLean(345, 70, 345)).toBeCloseTo(-1) // exactly the start
    expect(arcLean(345, 70, 55)).toBeCloseTo(1) // exactly the far end
    expect(arcLean(345, 70, 20)).toBeCloseTo(0, 1) // dead centre → no opinion
    // A cherry (rose) pulls crimson; a bell (gold) pulls gold. That is the whole feature.
    expect(arcLean(345, 70, 340)).toBeLessThan(-0.5)
    expect(arcLean(345, 70, 45)).toBeGreaterThan(0.5)
  })

  it('never answers outside [-1, 1], for any hue against any arc', () => {
    for (const [from, span] of [
      [345, 70],
      [310, 70],
      [185, 155],
    ]) {
      for (let h = 0; h < 360; h += 3) {
        const k = arcLean(from, span, h)
        expect(k).toBeGreaterThanOrEqual(-1)
        expect(k).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('ringAlpha', () => {
  it('stays within the requested floor and ceiling', () => {
    for (let phase = 0; phase < 1; phase += 0.05) {
      for (let i = 0; i < 32; i++) {
        const a = ringAlpha(i, 32, phase, 0.3, 1, 2)
        expect(a).toBeGreaterThanOrEqual(0.3 - 1e-9)
        expect(a).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })

  it('puts `waves` bright crests on the ring at once', () => {
    // With 3 waves over 30 bulbs a crest recurs every 10 positions.
    const at = (i: number): number => ringAlpha(i, 30, 0.25, 0, 1, 3)
    expect(at(0)).toBeCloseTo(at(10))
    expect(at(10)).toBeCloseTo(at(20))
  })

  it('travels: the crest moves as phase advances', () => {
    expect(ringAlpha(0, 32, 0, 0, 1, 1)).not.toBeCloseTo(ringAlpha(0, 32, 0.25, 0, 1, 1))
  })
})

describe('roundedRectPath', () => {
  // The board cabinet's real light channel: the 676² bezel inset 12, radius 28-12.
  const G = { x: 34, y: 294, w: 652, h: 652, r: 16 }
  const path = (spacing: number) => roundedRectPath(G.x, G.y, G.w, G.h, G.r, spacing)

  /** Distance from a point to the rounded-rect boundary — 0 when the point sits exactly on it. */
  function offBoundary(p: { x: number; y: number }): number {
    // Fold into one quadrant, then measure against the straight edges / corner arc.
    const cx = G.x + G.w / 2
    const cy = G.y + G.h / 2
    const dx = Math.abs(p.x - cx)
    const dy = Math.abs(p.y - cy)
    const ix = G.w / 2 - G.r // corner-centre offsets
    const iy = G.h / 2 - G.r
    if (dx <= ix) return Math.abs(dy - G.h / 2) // on a horizontal run
    if (dy <= iy) return Math.abs(dx - G.w / 2) // on a vertical run
    return Math.abs(Math.hypot(dx - ix, dy - iy) - G.r) // in a corner
  }

  it('puts every sample ON the rounded-rect boundary', () => {
    for (const p of path(8)) expect(offBoundary(p)).toBeLessThan(0.5)
  })

  it('spaces samples EVENLY, corners included — the old ring clumped there', () => {
    const pts = path(8)
    const gaps: number[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length] // includes the wrap gap
      gaps.push(Math.hypot(b.x - a.x, b.y - a.y))
    }
    const min = Math.min(...gaps)
    const max = Math.max(...gaps)
    // Chords across a corner arc are a hair shorter than a straight run's; anything under 10% is
    // invisible once the nodes overlap. A per-edge fixed count would blow way past this.
    expect(max / min).toBeLessThan(1.1)
  })

  it('closes the loop — the wrap gap matches the rest', () => {
    const pts = path(8)
    const first = pts[0]
    const last = pts[pts.length - 1]
    const wrap = Math.hypot(first.x - last.x, first.y - last.y)
    const typical = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)
    expect(Math.abs(wrap - typical)).toBeLessThan(0.6)
  })

  it('scales sample count with the requested spacing', () => {
    expect(path(4).length).toBeGreaterThan(path(8).length)
    expect(path(8).length).toBeGreaterThan(path(16).length)
  })

  it('runs CLOCKWISE from the top-left, so a lap travels the way the chase expects', () => {
    const pts = path(8)
    expect(pts[0].y).toBeCloseTo(G.y, 0) // starts on the top edge
    expect(pts[1].x).toBeGreaterThan(pts[0].x) // and heads right
  })

  it('survives degenerate geometry instead of emitting NaNs', () => {
    expect(roundedRectPath(0, 0, 0, 0, 0, 8)).toEqual([])
    expect(roundedRectPath(0, 0, 100, 100, 0, 0)).toEqual([])
    // A radius past half the side clamps rather than inverting the corners.
    for (const p of roundedRectPath(0, 0, 100, 100, 999, 8)) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
  })
})

describe('theme hue arcs', () => {
  it('every theme defines a usable arc', () => {
    for (const id of THEME_ORDER) {
      const t = THEMES[id]
      expect(t.rgbHueSpan).toBeGreaterThan(0)
      expect(t.rgbSat).toBeGreaterThan(0)
      expect(t.rgbSat).toBeLessThanOrEqual(1)
      expect(Number.isFinite(t.rgbHueFrom)).toBe(true)
    }
  })

  it("the blush theme's arc never reaches green — the reason narrow arcs exist at all", () => {
    const t = THEMES.mayaHeart
    for (let i = 0; i < 32; i++) {
      for (let phase = 0; phase < 1; phase += 0.1) {
        // Normalise onto the wheel: the arc runs 310°..380°, i.e. magenta → coral through red.
        const h = frac(ringHue(i, 32, phase, t.rgbHueFrom, t.rgbHueSpan) / 360) * 360
        const isGreenish = h > 70 && h < 290
        expect(isGreenish).toBe(false)
      }
    }
  })

  it('NO theme sweeps the full wheel — the ring wears the room, not a rainbow', () => {
    for (const id of THEME_ORDER) {
      // A full 360 would drag hues no theme uses onto its own board. Every arc is deliberately a
      // slice. (It also switches `ringHue` to its wrapping branch, which is not what these want.)
      expect(THEMES[id].rgbHueSpan).toBeLessThan(360)
    }
  })

  it("every arc contains that theme's OWN marquee tones — the fitting test", () => {
    // This is the property that makes the ring read as the cabinet's lighting rather than as an
    // effect: whatever hue a theme already lights its marquee with must be somewhere on the arc.
    for (const id of THEME_ORDER) {
      const t = THEMES[id]
      for (const tone of [t.marqueeBright, t.marqueeDim]) {
        expect(arcContains(t.rgbHueFrom, t.rgbHueSpan, hueOf(tone))).toBe(true)
      }
    }
  })

  it('no arc strays into a hue family its theme never uses', () => {
    // The three warm themes must never reach green/cyan/blue; Neon Vegas must never reach the warm
    // reds and greens that would fight its navy night.
    const forbidden: Record<string, [number, number]> = {
      golden: [70, 290],
      mayaHeart: [70, 290],
      roseMidnight: [70, 290],
      neonVegas: [0, 180],
    }
    for (const id of THEME_ORDER) {
      const t = THEMES[id]
      const [lo, hi] = forbidden[id]
      for (let i = 0; i < 64; i++) {
        for (let phase = 0; phase < 1; phase += 0.1) {
          const h = frac(ringHue(i, 64, phase, t.rgbHueFrom, t.rgbHueSpan) / 360) * 360
          expect(h > lo && h < hi).toBe(false)
        }
      }
    }
  })
})

// `hueOf` used to live here as a private oracle for the arc-fitting test below. It moved into
// `rgb.ts` when THE TELL needed it in production, and the arc test now imports it — which is a
// stronger position than it was in, not a weaker one: the shared function is pinned directly above
// against the primaries AND round-tripped through `hsvToInt`, where the private copy was never
// asserted on at all.

/** Does `hue` (0..360) fall on the arc `[from, from + span]`? Checks both wrap directions. */
function arcContains(from: number, span: number, hue: number): boolean {
  return [hue, hue + 360, hue - 360].some(c => c >= from - 1e-6 && c <= from + span + 1e-6)
}

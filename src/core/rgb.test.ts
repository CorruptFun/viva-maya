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
import { frac, hsvToInt, ringAlpha, ringHue } from './rgb'
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

  it('the two full-wheel themes really do sweep the whole wheel', () => {
    expect(THEMES.golden.rgbHueSpan).toBeGreaterThanOrEqual(360)
    expect(THEMES.neonVegas.rgbHueSpan).toBeGreaterThanOrEqual(360)
  })
})

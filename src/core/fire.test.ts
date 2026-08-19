/**
 * Fire maths (§X2). `fireRing` / `blazeField` / `burnAway` need a live Phaser scene and so are not
 * covered here, but everything that decides what the fire LOOKS like is in these five functions.
 *
 * Two of the properties below are the whole reason this module exists as pure maths, and both are
 * failures you cannot see in a code review — you see them on a phone, six months later, as "the
 * explosion looks cheap":
 *
 *   · the ring's SEAM — a nearly-even ring parks its one odd gap at a fixed spot on screen forever;
 *   · the wall's STROBE — neighbouring tongues that breathe in phase flash as one rectangle.
 */
import { describe, expect, it } from 'vitest'
import {
  blazeTongues,
  burnFront,
  burnHeat,
  fireJitter,
  flameColor,
  MIN_PHASE_GAP,
  phaseGap,
  ringPetals,
  TONGUE_OVERLAP,
} from './fire'
import { hueOf } from './rgb'
// The real piece tints — a fire that claims to wear the symbol's colour has to be tested against
// the actual six, not against invented ones. `view/textures.ts` pulls in Phaser, so the table is
// re-stated here from the same source of truth it is defined from (`THEMES.golden` + the literals).
const SYMBOL_TINTS: Record<string, number> = {
  cherry: 0xe61f4d,
  seven: 0xe0312e,
  diamond: 0x49c6ee,
  bell: 0xffb01c,
  clover: 0x3fae5a,
  bar: 0x4a5a8f, // the dark one — the case this whole function exists for
}

describe('fireJitter', () => {
  it('stays inside [0,1)', () => {
    for (let i = 0; i < 400; i++) {
      const v = fireJitter(i, i * 7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('is deterministic — the same atom rebuilds identically, so turbulence never re-rolls per frame', () => {
    expect(fireJitter(19, 3)).toBe(fireJitter(19, 3))
    expect(fireJitter(0, 0)).toBe(fireJitter(0, 0))
  })

  it('decorrelates neighbours, so the turbulence never lays down in visible bands', () => {
    // Adjacent atoms must not walk in step. A hash whose neighbours correlate would draw the jitter
    // as a smooth ramp around the ring — a lopsided blob rather than a boiling front.
    const deltas: number[] = []
    for (let i = 0; i < 200; i++) deltas.push(fireJitter(i + 1, 5) - fireJitter(i, 5))
    const mean = deltas.reduce((a, d) => a + d, 0) / deltas.length
    expect(Math.abs(mean)).toBeLessThan(0.06) // no drift: as many steps down as up
    // …and the steps are big: a correlated hash would produce tiny neighbour-to-neighbour deltas.
    const spread = deltas.reduce((a, d) => a + Math.abs(d), 0) / deltas.length
    expect(spread).toBeGreaterThan(0.25)
  })

  it('separates seeds, so two fires alight at once do not wear the same turbulence', () => {
    const a = Array.from({ length: 24 }, (_, i) => fireJitter(i, 1))
    const b = Array.from({ length: 24 }, (_, i) => fireJitter(i, 2))
    expect(a).not.toEqual(b)
  })
})

describe('ringPetals', () => {
  it('spaces petals EXACTLY evenly, including across the wrap — the ring has no seam', () => {
    const n = 18
    const petals = ringPetals(n)
    const gaps: number[] = []
    for (let i = 0; i < n; i++) {
      const a = petals[i]
      const b = petals[(i + 1) % n] // the last→first gap is measured with all the others
      // Angle between two unit headings, via the dot product (wrap-safe by construction).
      gaps.push(Math.acos(Math.min(1, Math.max(-1, a.dx * b.dx + a.dy * b.dy))))
    }
    const want = (Math.PI * 2) / n
    for (const g of gaps) expect(g).toBeCloseTo(want, 10)
  })

  it('puts every petal on the unit circle', () => {
    for (const p of ringPetals(23, 9)) {
      expect(Math.hypot(p.dx, p.dy)).toBeCloseTo(1, 12)
    }
  })

  it('aims a tip-up sprite OUTWARD — the flames lick away from the blast, never into it', () => {
    for (const p of ringPetals(16, 4)) {
      // Phaser rotation is clockwise with y down, and the art points up (−y). Rotating (0,−1) by
      // `angle` must land on the petal's own outward heading.
      const tipX = Math.sin(p.angle)
      const tipY = -Math.cos(p.angle)
      expect(tipX).toBeCloseTo(p.dx, 10)
      expect(tipY).toBeCloseTo(p.dy, 10)
    }
  })

  it('keeps the turbulence bounded, so the front stays one shockwave and not scattered debris', () => {
    for (const p of ringPetals(40, 77)) {
      expect(p.size).toBeGreaterThanOrEqual(0.7)
      expect(p.size).toBeLessThanOrEqual(1.3)
      expect(p.reach).toBeGreaterThanOrEqual(0.78)
      expect(p.reach).toBeLessThanOrEqual(1.22)
      expect(p.lead).toBeGreaterThanOrEqual(0)
      expect(p.lead).toBeLessThan(1)
    }
  })

  it('still varies — a "bounded" jitter that collapsed to a constant would be a clean ring', () => {
    const sizes = ringPetals(40, 77).map(p => p.size)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(0.3)
  })

  it('never returns a degenerate ring, however small the count asked for', () => {
    expect(ringPetals(0).length).toBe(3)
    expect(ringPetals(-5).length).toBe(3)
    expect(ringPetals(1).length).toBe(3)
  })
})

describe('blazeTongues', () => {
  it('seats tongues evenly across the full width', () => {
    const W = 640
    const t = blazeTongues(W, 10)
    expect(t.length).toBe(10)
    for (let i = 1; i < t.length; i++) {
      expect(t[i].x - t[i - 1].x).toBeCloseTo(W / 10, 8)
    }
    // First and last sit half a step in from the edges — the wall is centred on the region.
    expect(t[0].x).toBeCloseTo(W / 20, 8)
    expect(t[t.length - 1].x).toBeCloseTo(W - W / 20, 8)
  })

  it('OVERLAPS neighbouring bodies, so the roots fuse into one front instead of scalloping', () => {
    const W = 640
    const t = blazeTongues(W, 12)
    for (let i = 1; i < t.length; i++) {
      const gap = t[i].x - t[i].w / 2 - (t[i - 1].x + t[i - 1].w / 2)
      expect(gap).toBeLessThan(0) // negative gap == overlap
    }
    expect(TONGUE_OVERLAP).toBeGreaterThan(1.5)
  })

  it('covers the region edge to edge — no cold strip at either end', () => {
    const W = 500
    const t = blazeTongues(W, 8)
    expect(t[0].x - t[0].w / 2).toBeLessThanOrEqual(0)
    expect(t[t.length - 1].x + t[t.length - 1].w / 2).toBeGreaterThanOrEqual(W)
  })

  it('NEVER lets two neighbours share a flicker phase — the anti-strobe rule', () => {
    // The failure this pins: a wall whose atoms breathe together is a flashing rectangle, not fire.
    for (const seed of [0, 1, 2, 3, 17, 512, 9001]) {
      const t = blazeTongues(640, 16, seed)
      for (let i = 1; i < t.length; i++) {
        // Phases live on a circle, so a gap of 0.95 is really a gap of 0.05 — check the short way.
        expect(phaseGap(t[i].phase, t[i - 1].phase)).toBeGreaterThanOrEqual(MIN_PHASE_GAP - 1e-9)
      }
    }
  })

  it('keeps every phase and period in a usable band', () => {
    for (const t of blazeTongues(640, 30, 5)) {
      expect(t.phase).toBeGreaterThanOrEqual(0)
      expect(t.phase).toBeLessThan(1)
      expect(t.period).toBeGreaterThan(0.7)
      expect(t.period).toBeLessThan(1.4)
      expect(t.h).toBeGreaterThan(0.6)
      expect(t.h).toBeLessThan(1.3)
      expect(Math.abs(t.lean)).toBeLessThan(0.2) // a lean, never a topple
    }
  })

  it('makes a RAGGED front — a wall of equal-height tongues is a bar, not a fire', () => {
    const hs = blazeTongues(640, 16, 3).map(t => t.h)
    expect(Math.max(...hs) - Math.min(...hs)).toBeGreaterThan(0.35)
  })

  it('never returns a degenerate wall', () => {
    expect(blazeTongues(640, 0).length).toBe(2)
    expect(blazeTongues(640, -3).length).toBe(2)
  })
})

describe('burnFront', () => {
  it('starts at the near edge and clears the far one', () => {
    expect(burnFront(0)).toBe(0)
    expect(burnFront(1)).toBe(1)
  })

  it('clamps, so an over-run window can never drag the front back onto the region', () => {
    expect(burnFront(-3)).toBe(0)
    expect(burnFront(4)).toBe(1)
  })

  it('advances monotonically — the fire never burns backwards', () => {
    let prev = -1
    for (let i = 0; i <= 40; i++) {
      const v = burnFront(i / 40)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('is eased, not linear — a linear wipe reads as a scene transition, not as burning', () => {
    expect(burnFront(0.1)).toBeLessThan(0.1) // slow to bite
    expect(burnFront(0.5)).toBeGreaterThan(0.5) // fast through the middle
  })

  it('clears the far edge BEFORE the window ends, so the last frames are ash, not a parked line', () => {
    expect(burnFront(0.94)).toBe(1)
  })
})

describe('burnHeat', () => {
  it('peaks exactly at the front', () => {
    expect(burnHeat(0.5, 0.5)).toBe(1)
    expect(burnHeat(0.2, 0.2)).toBe(1)
  })

  it('is cold both behind (ash) and ahead (untouched) of the lip', () => {
    expect(burnHeat(0.1, 0.5)).toBe(0)
    expect(burnHeat(0.9, 0.5)).toBe(0)
  })

  it('falls off symmetrically and monotonically away from the front', () => {
    let prev = 1
    for (let d = 0; d <= 10; d++) {
      const v = burnHeat(0.5 + (d / 10) * 0.22, 0.5)
      expect(v).toBeLessThanOrEqual(prev + 1e-12)
      expect(v).toBeCloseTo(burnHeat(0.5 - (d / 10) * 0.22, 0.5), 12)
      prev = v
    }
  })

  it('keeps the lip NARROW — a wide band slides as a gradient instead of cutting as a line', () => {
    // Two cells a third of the region apart can never both be lit by the default lip.
    expect(burnHeat(0.5, 0.5) * burnHeat(0.83, 0.5)).toBe(0)
  })

  it('never goes negative or above 1, at any bandwidth', () => {
    for (const bw of [0.02, 0.1, 0.5, 1, 3]) {
      for (let i = 0; i <= 20; i++) {
        const v = burnHeat(i / 20, 0.37, bw)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('flameColor', () => {
  const heats: Array<1 | 2 | 3> = [1, 2, 3]
  const chan = (c: number): [number, number, number] => [((c >> 16) & 0xff) / 255, ((c >> 8) & 0xff) / 255, (c & 0xff) / 255]
  const val = (c: number): number => Math.max(...chan(c))
  const sat = (c: number): number => {
    const [r, g, b] = chan(c)
    const max = Math.max(r, g, b)
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max
  }

  it("keeps the SYMBOL's hue — a diamond blast is blue, a clover blast is green", () => {
    for (const [name, tint] of Object.entries(SYMBOL_TINTS)) {
      for (const h of heats) {
        const d = Math.abs(hueOf(flameColor(tint, h)) - hueOf(tint))
        expect(Math.min(d, 360 - d), `${name} @ heat ${h}`).toBeLessThan(4)
      }
    }
  })

  it('takes every symbol to full VALUE, however dull the token it started from', () => {
    // `bar` is the case this exists for: a navy #4a5a8f, under half saturated and barely half
    // bright, which added to a dark board is very nearly nothing.
    expect(sat(SYMBOL_TINTS.bar)).toBeLessThan(0.55) // the source really is dull…
    for (const [name, tint] of Object.entries(SYMBOL_TINTS)) {
      for (const h of heats) {
        expect(val(flameColor(tint, h)), `${name} @ heat ${h}`).toBeCloseTo(1, 2)
        expect(sat(flameColor(tint, h)), `${name} @ heat ${h}`).toBeGreaterThan(0.8)
      }
    }
    expect(sat(flameColor(SYMBOL_TINTS.bar, 2))).toBeGreaterThan(sat(SYMBOL_TINTS.bar) + 0.3)
  })

  it('spends heat on SATURATION, never on paling toward white', () => {
    for (const [name, tint] of Object.entries(SYMBOL_TINTS)) {
      const s = heats.map(h => sat(flameColor(tint, h)))
      expect(s[1], name).toBeGreaterThan(s[0])
      expect(s[2], name).toBeGreaterThan(s[1])
    }
  })

  it('keeps the RED symbols RED — the luminance-equalising trap, pinned', () => {
    // ⚠️ This is the regression guard for a fix that was tried and reverted. Equalising PERCEIVED
    // luminance across symbols looks like the right correction (a saturated blue really does carry
    // a quarter of a saturated gold's luma) — but pure red is one of the darkest hues there is, so
    // any rule that lifts the blue lifts the reds harder. The implementation that did it turned
    // cherry into #ff678a (salmon) and the 7 into #ff6a68 (coral), both at saturation ~0.6. If
    // these drop again, someone has re-derived that fix; the brightness belongs to the geometry.
    for (const name of ['cherry', 'seven'] as const) {
      for (const h of heats) {
        expect(sat(flameColor(SYMBOL_TINTS[name], h)), `${name} @ heat ${h}`).toBeGreaterThan(0.85)
      }
    }
  })

  it('clamps heat rather than extrapolating off the ladder', () => {
    const t = SYMBOL_TINTS.cherry
    expect(flameColor(t, 0 as 1)).toBe(flameColor(t, 1))
    expect(flameColor(t, 9 as 3)).toBe(flameColor(t, 3))
  })
})

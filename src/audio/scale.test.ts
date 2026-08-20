import { describe, expect, it } from 'vitest'
import { THEME_ORDER, THEMES } from '../view/theme'
import { degree, LADDER_RUNGS, PENTATONIC, rung } from './scale'

/**
 * The regression this file exists for. The cascade voices built a chromatic ramp and quantised it onto
 * the 5-note key-lock scale, so consecutive waves collapsed onto the same pitch — 10 waves produced 5
 * distinct pitches on every theme, with three identical waves in a row on neonVegas. Nothing caught it
 * because nothing asserted the only property a ladder actually has to have: that it goes UP, every
 * step, in every key. That is the first test below; the rest guard the octave maths the anchors rely on.
 */

/** Every shipped room's key-lock root — a ladder that only works in C would still be broken. */
const ROOTS = Object.values(THEMES).map((t) => t.audio.bedRoot)

describe('degree', () => {
  it('covers every shipped theme root, and no two rooms share one', () => {
    // Counted off THEME_ORDER rather than a literal: a theme that exists but never reached the
    // picker's list is both invisible to players and unpinned by every test that walks that list.
    expect(ROOTS).toHaveLength(THEME_ORDER.length)
    expect(new Set(ROOTS).size).toBe(ROOTS.length) // distinct roots, so each is a real case
  })

  it('is strictly increasing over a deep chain on every theme root', () => {
    for (const root of ROOTS) {
      for (let n = 1; n <= 15; n++) {
        expect(degree(root, n)).toBeGreaterThan(degree(root, n - 1))
      }
    }
  })

  it('gives a distinct pitch per rung — the collapse this replaced did not', () => {
    for (const root of ROOTS) {
      const rungs = Array.from({ length: 16 }, (_, n) => degree(root, n))
      expect(new Set(rungs).size).toBe(16)
    }
  })

  it('accelerates by the octave: the same rung one octave up is twice the jump', () => {
    // NOT rung-to-rung — the pentatonic's own 2/2/3/2/3-semitone shape means a 2-semitone step after a
    // 3-semitone one is a narrower jump in Hz. The acceleration is across octaves, and it is exact.
    const jump = (root: number, n: number) => degree(root, n) - degree(root, n - 1)
    for (const root of ROOTS) {
      for (let n = 1; n <= 10; n++) {
        expect(jump(root, n + PENTATONIC.length)).toBeCloseTo(jump(root, n) * 2, 6)
      }
    }
  })

  it('starts on the root and puts an octave every 5 degrees (how anchors are set)', () => {
    for (const root of ROOTS) {
      expect(degree(root, 0)).toBe(root)
      for (let n = 0; n <= 10; n++) {
        expect(degree(root, n + PENTATONIC.length)).toBeCloseTo(degree(root, n) * 2, 6)
      }
    }
  })

  it('never returns NaN, so a bad input still makes a sound', () => {
    for (const bad of [NaN, -3, Infinity]) {
      expect(degree(440, bad)).toBe(440)
    }
    expect(degree(0, 3)).toBe(0)
    expect(degree(NaN, 3)).toBeNaN() // root passes straight through — the caller's bug, not ours
  })
})

describe('rung', () => {
  it('maps 1-based cascade waves onto rungs from zero', () => {
    expect(rung(1)).toBe(0)
    expect(rung(2)).toBe(1)
    expect(rung(LADDER_RUNGS)).toBe(LADDER_RUNGS - 1)
  })

  it('holds at the ceiling instead of climbing out of the audible band', () => {
    for (const deep of [LADDER_RUNGS + 1, 12, 40]) expect(rung(deep)).toBe(LADDER_RUNGS - 1)
  })

  it('clamps junk to the bottom rung', () => {
    for (const bad of [0, -5, NaN]) expect(rung(bad)).toBe(0)
  })
})

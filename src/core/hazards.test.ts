import { describe, expect, it } from 'vitest'
import { ROWS, COLS } from '../config'
import { DIFFICULTY } from './difficulty'
import { coatsToClear, densityFor, hazardPlan } from './hazards'
import type { HazardPlan } from './hazards'

/**
 * The hazard plan is the seed of every new mechanic, so three things have to be nailed down before
 * any of it touches the board:
 *
 *  1. DETERMINISM — same level, same table, every attempt. This is what makes a failed level
 *     learnable instead of a lottery, and it is the entire reason a second-attempt clear feels
 *     earned. A plan that drifts between attempts would quietly destroy that.
 *  2. THE CAPS HOLD — blockers are the one mechanic that can structurally shorten cascades, and
 *     cascades are what fire Plinko. A blocker that walls off a column starves every cell beneath
 *     it. These caps are load-bearing for the game staying fun, not just for it staying fair.
 *  3. THE PANIC SWITCH IS REAL — flags off must mean GONE, provably, not "mostly gone".
 */

const plan = (level: number): HazardPlan => hazardPlan(level, ROWS, COLS)
const allCells = (p: HazardPlan): string[] => [
  ...p.coats.map(c => `${c.row},${c.col}`),
  ...p.blockers.map(b => `${b.row},${b.col}`),
  ...p.locks.map(l => `${l.row},${l.col}`),
]

describe('hazardPlan — determinism', () => {
  it('gives an identical plan for the same level, every time', () => {
    for (const L of [31, 56, 86, 120, 200, 300]) {
      expect(plan(L)).toEqual(plan(L))
    }
  })

  it('gives different layouts to different levels (not one table reused)', () => {
    const a = allCells(plan(200)).join('|')
    const b = allCells(plan(201)).join('|')
    expect(a).not.toBe(b)
  })
})

describe('hazardPlan — the protected early game', () => {
  it('is completely empty below the first band, including the endless sentinel level 0', () => {
    for (const L of [0, 1, 10, 20, 29, 30]) {
      expect(plan(L)).toEqual({ coats: [], blockers: [], locks: [] })
    }
  })

  it('introduces exactly one mechanic at a time, in order', () => {
    // Locks arrive first and hold the board alone until coats appear.
    expect(plan(31).locks.length).toBeGreaterThan(0)
    expect(plan(31).coats).toHaveLength(0)
    expect(plan(31).blockers).toHaveLength(0)

    // Coats join next; blockers are still absent.
    expect(plan(56).coats.length).toBeGreaterThan(0)
    expect(plan(56).blockers).toHaveLength(0)

    // Blockers are last.
    expect(plan(86).blockers.length).toBeGreaterThan(0)
  })

  it('never seeds a mechanic below its own band start', () => {
    for (let L = 1; L < DIFFICULTY.bands.coatStart; L++) expect(plan(L).coats).toHaveLength(0)
    for (let L = 1; L < DIFFICULTY.bands.blockerStart; L++) expect(plan(L).blockers).toHaveLength(0)
  })
})

describe('hazardPlan — caps that keep cascades alive', () => {
  it('never walls off a column and never blocks the refill row', () => {
    for (let L = DIFFICULTY.bands.blockerStart; L <= 300; L++) {
      const { blockers } = plan(L)
      expect(blockers.length).toBeLessThanOrEqual(DIFFICULTY.caps.maxBlockers)

      const perCol = new Map<number, number>()
      const perRow = new Map<number, number>()
      for (const b of blockers) {
        expect(DIFFICULTY.caps.forbiddenBlockerRows).not.toContain(b.row)
        perCol.set(b.col, (perCol.get(b.col) ?? 0) + 1)
        perRow.set(b.row, (perRow.get(b.row) ?? 0) + 1)
      }
      for (const n of perCol.values()) expect(n).toBeLessThanOrEqual(DIFFICULTY.caps.blockersPerColumn)
      for (const n of perRow.values()) expect(n).toBeLessThanOrEqual(DIFFICULTY.caps.blockersPerRow)
    }
  })

  it('never places a coat underneath a blocker (an unreachable coat reads as a bug)', () => {
    for (let L = DIFFICULTY.bands.blockerStart; L <= 300; L += 7) {
      const p = plan(L)
      const blocked = new Set(p.blockers.map(b => `${b.row},${b.col}`))
      for (const c of p.coats) expect(blocked.has(`${c.row},${c.col}`)).toBe(false)
    }
  })

  it('never asks for more hazard cells than the board has', () => {
    for (let L = 31; L <= 300; L += 3) {
      const p = plan(L)
      expect(p.blockers.length + p.coats.length).toBeLessThanOrEqual(ROWS * COLS)
      expect(p.locks.length).toBeLessThanOrEqual(ROWS * COLS)
    }
  })
})

describe('densityFor — the ramp', () => {
  it('never decreases across a band, ignoring the deliberate breather beat', () => {
    for (const kind of ['lock', 'coat', 'blocker'] as const) {
      let prev = 0
      for (let L = 31; L <= 300; L++) {
        if (L % 5 === 0) continue // the breather is an intentional dip
        const d = densityFor(kind, L)
        expect(d).toBeGreaterThanOrEqual(prev - 1) // -1 tolerance for integer rounding
        prev = d
      }
    }
  })

  it('makes every 5th level visibly lighter — the breather you can actually see', () => {
    // L200 vs its neighbours: same band, but the breather halves the table dressing.
    const busy = densityFor('coat', 199) + densityFor('lock', 199)
    const breather = densityFor('coat', 200) + densityFor('lock', 200)
    expect(breather).toBeLessThan(busy)
  })

  it('gives a teaching level its band floor, never a breather-shrunk version', () => {
    // L56 introduces coats and is not a multiple of 5, but L86 (blockers) is — the floor must hold.
    expect(densityFor('blocker', DIFFICULTY.bands.blockerStart)).toBe(DIFFICULTY.density.blocker.count[0])
    expect(densityFor('coat', DIFFICULTY.bands.coatStart)).toBe(DIFFICULTY.density.coat.count[0])
  })

  it('grows the table dressing from the first band to the end', () => {
    // Compare like with like: L299, not L300, because every 5th level is a deliberate breather and
    // L300 is one. Comparing a breather against a band floor measures the beat, not the trend.
    expect(densityFor('lock', 299)).toBeGreaterThan(densityFor('lock', 31))
    expect(densityFor('coat', 299)).toBeGreaterThan(densityFor('coat', 56))
    expect(densityFor('blocker', 299)).toBeGreaterThan(densityFor('blocker', 86))
  })
})

describe('the panic switch', () => {
  it('coatsToClear is zero when there are no coats, so the win condition is unchanged', () => {
    expect(coatsToClear(plan(31))).toBe(0)
    expect(coatsToClear(plan(100))).toBeGreaterThan(0)
  })

  /**
   * DIFFICULTY is `as const`, so flipping a flag here needs a cast. That is deliberate: the flags
   * are compile-time constants in the shipping build (dead code eliminates cleanly), and the test
   * proves the OFF path rather than trusting it. If this ever fails, the panic switch is a lie.
   */
  it('flags off means gone — not "mostly gone"', () => {
    const flags = DIFFICULTY.hazards as { enabled: boolean; lock: boolean; coat: boolean; blocker: boolean }
    const original = { ...flags }
    try {
      flags.blocker = false
      for (let L = 86; L <= 300; L += 11) expect(plan(L).blockers).toHaveLength(0)
      expect(plan(300).coats.length).toBeGreaterThan(0) // other mechanics untouched
      flags.blocker = original.blocker

      flags.enabled = false
      for (let L = 1; L <= 300; L += 13) expect(plan(L)).toEqual({ coats: [], blockers: [], locks: [] })
    } finally {
      Object.assign(flags, original)
    }
  })
})

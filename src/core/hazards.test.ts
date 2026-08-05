import { describe, expect, it } from 'vitest'
import { ROWS, COLS } from '../config'
import { DIFFICULTY, isTeachingLevel } from './difficulty'
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

/**
 * The mechanic flags are a ROLLOUT control, not a statement about whether the logic works. These
 * tests therefore force every mechanic on before exercising the planner, so staging the rollout
 * (shipping locks alone, say) can never turn this file green by making it test nothing. The
 * shipped configuration is asserted separately, at the bottom, where it belongs.
 */
const MECH = DIFFICULTY.hazards as { enabled: boolean; lock: boolean; coat: boolean; blocker: boolean }
function allOn<T>(fn: () => T): T {
  const was = { ...MECH }
  Object.assign(MECH, { enabled: true, lock: true, coat: true, blocker: true })
  try {
    return fn()
  } finally {
    Object.assign(MECH, was)
  }
}

const plan = (level: number): HazardPlan => allOn(() => hazardPlan(level, ROWS, COLS))
const density = (kind: 'lock' | 'coat' | 'blocker', level: number): number => allOn(() => densityFor(kind, level))
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
        const d = density(kind, L)
        expect(d).toBeGreaterThanOrEqual(prev - 1) // -1 tolerance for integer rounding
        prev = d
      }
    }
  })

  it('makes every 5th level visibly lighter — the breather you can actually see', () => {
    // L200 vs its neighbours: same band, but the breather halves the table dressing.
    const busy = density('coat', 199) + density('lock', 199)
    const breather = density('coat', 200) + density('lock', 200)
    expect(breather).toBeLessThan(busy)
  })

  it('gives a teaching level its band floor, never a breather-shrunk version', () => {
    // L56 introduces coats and is not a multiple of 5, but L86 (blockers) is — the floor must hold.
    expect(density('blocker', DIFFICULTY.bands.blockerStart)).toBe(DIFFICULTY.density.blocker.count[0])
    expect(density('coat', DIFFICULTY.bands.coatStart)).toBe(DIFFICULTY.density.coat.count[0])
  })

  it('grows the table dressing from the first band to the end', () => {
    // Compare like with like: L299, not L300, because every 5th level is a deliberate breather and
    // L300 is one. Comparing a breather against a band floor measures the beat, not the trend.
    expect(density('lock', 299)).toBeGreaterThan(density('lock', 31))
    expect(density('coat', 299)).toBeGreaterThan(density('coat', 56))
    expect(density('blocker', 299)).toBeGreaterThan(density('blocker', 86))
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
    const original = { ...MECH }
    const raw = (L: number): HazardPlan => hazardPlan(L, ROWS, COLS)
    try {
      Object.assign(MECH, { enabled: true, lock: true, coat: true, blocker: true })
      MECH.blocker = false
      for (let L = 86; L <= 300; L += 11) expect(raw(L).blockers).toHaveLength(0)
      expect(raw(300).coats.length).toBeGreaterThan(0) // other mechanics untouched
      MECH.blocker = true

      MECH.enabled = false
      for (let L = 1; L <= 300; L += 13) expect(raw(L)).toEqual({ coats: [], blockers: [], locks: [] })
    } finally {
      Object.assign(MECH, original)
    }
  })
})

/**
 * THE SHIPPED ROLLOUT. Staging was deliberate: locks first (cheapest by measurement, ~-4% to a
 * player's collects-per-move), then §G6 advanced coats (the second objective archetype the ladder
 * needed), and **Slice 0 (2026-08-04) turned blockers on at their designed band** — the mid-game
 * refresh's first beat, ending the stretch where the ladder introduced nothing new between the
 * 2-layer felt at 151 and the end at 300. Blockers stayed off longest because they are the sharp
 * instrument (a permanently inert cell is ~10x a lock, superlinear); their ramp, caps, 2-hp
 * escalation and feasibility gates were all measured before the flag flipped.
 *
 * This test exists so the shipped state is a DECISION rather than an accident: changing the
 * rollout means changing this assertion, on purpose, in the same commit. It has now done that job
 * twice — §G6 and Slice 0 each failed here until the decision was written down.
 */
describe('the shipped rollout', () => {
  it('ships the full hazard book — locks, coats and blockers', () => {
    expect({
      hazards: DIFFICULTY.hazards.enabled,
      lock: DIFFICULTY.hazards.lock,
      coat: DIFFICULTY.hazards.coat,
      blocker: DIFFICULTY.hazards.blocker,
      curve: DIFFICULTY.curve.enabled,
    }).toEqual({ hazards: true, lock: true, coat: true, blocker: true, curve: true })
  })

  it('ships AFTER DARK (Slice 3) — points nights, hot tables, the high-roller marker and the eye', () => {
    // The fourth staged block, pinned for the same reason the three above it are: a rollout change
    // has to be a DECISION written down in the same commit. `points`/`hot` also buy their band start
    // a teaching level, so a silent flip would move a move budget as well as a win condition.
    expect({ ...DIFFICULTY.afterDark }).toEqual({
      enabled: true,
      points: true,
      pointsStart: 216,
      hot: true,
      hotStart: 233,
      marker: true,
      markerStart: 251,
      eye: true,
      eyeStart: 281,
    })
  })

  it('teaches AFTER DARK where it starts — and never for the eye, which changes nothing', () => {
    expect(isTeachingLevel(DIFFICULTY.afterDark.pointsStart)).toBe(true)
    expect(isTeachingLevel(DIFFICULTY.afterDark.hotStart)).toBe(true)
    // §G12 in its purest form: THE EYE is presentational, so buying its level +3 moves would make
    // it measurably easier than its neighbours to introduce something that costs the player nothing.
    expect(isTeachingLevel(DIFFICULTY.afterDark.eyeStart)).toBe(false)
  })

  it('means a live board carries clamps, felt and lockboxes, each from its own band', () => {
    // Below the blocker band: never a lockbox.
    for (const L of [31, 56, DIFFICULTY.bands.blockerStart - 1]) {
      expect({ L, blockers: hazardPlan(L, ROWS, COLS).blockers.length }).toEqual({ L, blockers: 0 })
    }
    // From the band on — including the L150 breather (halved, not emptied) and L300.
    for (const L of [DIFFICULTY.bands.blockerStart, 150, 300]) {
      expect({ L, present: hazardPlan(L, ROWS, COLS).blockers.length > 0 }).toEqual({ L, present: true })
    }
    expect(hazardPlan(120, ROWS, COLS).locks.length).toBeGreaterThan(0)
    // Coats respect their own band: nothing before `coatStart`, something from it on.
    expect(hazardPlan(DIFFICULTY.bands.coatStart - 1, ROWS, COLS).coats.length).toBe(0)
    expect(hazardPlan(DIFFICULTY.bands.coatStart, ROWS, COLS).coats.length).toBeGreaterThan(0)
    expect(hazardPlan(300, ROWS, COLS).coats.length).toBeGreaterThan(0)
  })
})

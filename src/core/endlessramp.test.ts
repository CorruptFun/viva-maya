import { describe, expect, it } from 'vitest'
import { ENDLESS_MOVES, seedForKey } from './endless'
import {
  ENDLESS_BASE_MOVES,
  endlessLockPlan,
  endlessShapeFor,
  endlessWeekBounds,
  endlessWeekdayIndex,
} from './endlessramp'
import { mulberry32 } from './rng'
import { percentile, playEndless } from './sim'

/**
 * Guards on the week's ramp.
 *
 * The FAIRNESS assertions here are the load-bearing ones: the race's entire premise is that everyone
 * plays the same board, and a ramp that drew anything per-run or per-device would break that
 * silently — every player would still see a plausible board, and nothing would look wrong until two
 * people compared screenshots. Determinism is asserted first for that reason.
 *
 * The last test is a MEASUREMENT, in the spirit of the other economy guards in this directory: it
 * prints what the ramp actually costs a player across the seven days. If a future tune makes Sunday
 * unplayable, that is where it shows up.
 */

/** A Monday → Sunday run of real day keys. 2026-08-03 is a Monday. */
const WEEK_KEYS = [
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
  '2026-08-08',
  '2026-08-09',
]

describe('the week ramps', () => {
  it('indexes weekdays Monday-first, matching the season boundary', () => {
    WEEK_KEYS.forEach((k, i) => expect(endlessWeekdayIndex(k)).toBe(i))
    expect(endlessWeekdayIndex('nonsense')).toBeNull()
    expect(endlessWeekdayIndex('2026-13-99')).toBeNull()
  })

  it('opens the week on the untouched board', () => {
    // Monday must stay byte-identical to what every day was before the ramp existed — it is the
    // invitation AND the control. If this fails, the mode's baseline has moved.
    const mon = endlessShapeFor('2026-08-03')
    expect(mon.weekday).toBe(0)
    expect(mon.moves).toBe(ENDLESS_MOVES)
    expect(mon.moves).toBe(ENDLESS_BASE_MOVES)
    expect(mon.locks).toBe(0)
    expect(endlessLockPlan('2026-08-03', 8, 8).locks).toHaveLength(0)
  })

  it('never gets easier as the week runs', () => {
    const shapes = WEEK_KEYS.map(endlessShapeFor)
    for (let i = 1; i < shapes.length; i++) {
      expect(shapes[i].moves).toBeLessThanOrEqual(shapes[i - 1].moves)
    }
    // The finale is strictly harder than the opening on both axes.
    expect(shapes[6].moves).toBeLessThan(shapes[0].moves)
    expect(shapes[6].locks).toBeGreaterThan(shapes[0].locks)
  })

  it('taper stays small enough that the ceiling is not what decides the season', () => {
    // The season is the SUM of seven daily bests. A late week that simply pays less hands the race to
    // whoever played Monday, which is the opposite of the intent — so the budget may only ever be a
    // gentle taper, and the locks have to do the work. 10% is the line.
    const { openMoves, finaleMoves } = endlessWeekBounds()
    expect((openMoves - finaleMoves) / openMoves).toBeLessThanOrEqual(0.1)
  })

  it('is a pure function of the day key — the same board for everyone', () => {
    for (const k of WEEK_KEYS) {
      const a = endlessShapeFor(k)
      const b = endlessShapeFor(k)
      expect(a).toEqual(b)
      expect(endlessLockPlan(k, 8, 8)).toEqual(endlessLockPlan(k, 8, 8))
    }
  })

  it('draws locks from a stream that cannot disturb the shared layout', () => {
    // The determinism trap: if the shape or the plan drew from the board's own stream, seeding the
    // locks would advance it and every player's LAYOUT would depend on when hazards were applied.
    // Proven by construction — the board seed for a day is untouched by asking for its shape.
    for (const k of WEEK_KEYS) {
      const before = seedForKey(k)
      endlessShapeFor(k)
      endlessLockPlan(k, 8, 8)
      expect(seedForKey(k)).toBe(before)
    }
  })

  it('keeps locks off the refill row and inside the board', () => {
    for (const k of WEEK_KEYS) {
      const plan = endlessLockPlan(k, 8, 8)
      for (const l of plan.locks) {
        expect(l.row).toBeGreaterThanOrEqual(1) // row 0 is where refills enter
        expect(l.row).toBeLessThan(8)
        expect(l.col).toBeGreaterThanOrEqual(0)
        expect(l.col).toBeLessThan(8)
      }
      // No duplicate cells — a double-locked cell is just a wasted draw.
      const keys = new Set(plan.locks.map(l => `${l.row},${l.col}`))
      expect(keys.size).toBe(plan.locks.length)
      // Coats and blockers never belong in this mode.
      expect(plan.coats).toHaveLength(0)
      expect(plan.blockers).toHaveLength(0)
    }
  })

  it('widens the spread of boards as the week runs', () => {
    // The variance half of the ramp. Sample many real weeks and check that the late-week lock count
    // varies more than the early-week one — "less alike", not merely "harder".
    const spread = (weekday: number): number => {
      const counts: number[] = []
      for (let w = 0; w < 60; w++) {
        const d = new Date(Date.UTC(2026, 7, 3 + w * 7 + weekday)).toISOString().slice(0, 10)
        counts.push(endlessShapeFor(d).locks)
      }
      return Math.max(...counts) - Math.min(...counts)
    }
    expect(spread(0)).toBe(0) // Monday is a fixed point
    expect(spread(6)).toBeGreaterThan(spread(2)) // Sunday is less predictable than Wednesday
  })

  it('MEASURED: what the ramp costs across the seven days', { timeout: 300000 }, () => {
    const rows: string[] = []
    const medians: number[] = []
    for (const k of WEEK_KEYS) {
      const shape = endlessShapeFor(k)
      const s: number[] = []
      for (let r = 0; r < 120; r++) {
        s.push(
          playEndless(seedForKey(k), 'greedy', mulberry32(0x5eed + r * 7919), {
            moves: shape.moves,
            plan: endlessLockPlan(k, 8, 8),
          }).score
        )
      }
      s.sort((a, b) => a - b)
      medians.push(percentile(s, 0.5))
      rows.push(
        `  ${k} ${shape.label.padEnd(11)} moves ${shape.moves}  locks ${String(shape.locks).padStart(2)}` +
          `   p50 ${percentile(s, 0.5).toLocaleString().padStart(8)}  max ${s[s.length - 1].toLocaleString()}`
      )
    }
    console.log(`\nTHE WEEK'S RAMP (greedy policy, real day seeds)\n${rows.join('\n')}\n`)

    // The finale must still be a real board — a ramp that flattens Sunday to noise would make the
    // last day of the season the least worth playing.
    expect(Math.min(...medians)).toBeGreaterThan(0)
  })
})

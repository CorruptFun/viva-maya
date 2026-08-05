import { describe, expect, it } from 'vitest'
import { COLS, ROWS } from '../config'
import { DIFFICULTY } from './difficulty'
import { hazardPlan } from './hazards'
import { buildLevelBoard, playLevel, sampleLevel } from './sim'
import { endlessRngForDay } from './endless'
import { Board } from './board'
import { SYMBOLS } from './types'

/**
 * The acceptance gates for the hazard overhaul, measured against the real board core.
 *
 * A note on the numbers: the `banker` policy is a WEAK FLOOR, not a player. It has no lookahead
 * past the opening wave, so its absolute clear rate (~40-50% on the shipped game) says nothing
 * about how often a person wins. What it gives us is a stable yardstick for CHANGE: if the proxy's
 * clear rate collapses, a real player's will fall too. So every threshold here is relative or
 * structural, never "the player wins N% of the time".
 *
 * The default sample is deliberately coarse so `npm test` stays quick — `plinko.rate.test.ts`
 * already spends a 120s budget on the real board and a second one is not worth the wall clock.
 * Set VM_FULL_SWEEP=1 for the dense pass.
 */

const FULL =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VM_FULL_SWEEP === '1'
const SEEDS = FULL ? 40 : 10
/**
 * ACT II joins the sweep at 310 / 355 / 390 — one on each side of the floor-1/floor-2 seam plus the
 * top of the shipped ladder. They matter more than their count suggests: hazard densities FLATLINE
 * above 300 (every ramp in hazards.ts clamps there), so these three are the check that a flat
 * hazard load under a rising collect demand is still winnable, and that the new verb has not moved
 * cascade health or Plinko eligibility.
 *
 * Banker win rates measured at 40 seeds when the floors shipped (2026-08-04) — L300 is 18% for
 * scale, so Act II sits comfortably ABOVE the end of Act I:
 *     310 → 53% · 340 → 38% · 350 → 40% · 355 → 20% · 360 → 38% · 390 → 43% · 400 → 40%
 *
 * ⚠️ 355 IS DELIBERATELY NOT IN THE QUICK SET. `everWon` over 10 seeds at a 20% win rate fails by
 * chance about one run in nine, and a gate that red-lights on the dice teaches people to re-run the
 * suite until it passes — which is how a real failure gets waved through. It keeps its place in the
 * dense sweep, where 40 seeds make the same assertion mean something.
 *
 * ⚠️ The banker only takes a pull that matches something IMMEDIATELY (see sim.previewPull), so it
 * plays Act II as a slightly better swapper rather than as a player using the verb. Every number
 * here is therefore a FLOOR on player power — fine as a gate, worthless as an estimate.
 */
const CHECK_LEVELS = FULL ? [31, 45, 56, 65, 86, 100, 150, 220, 300, 310, 355, 390] : [65, 150, 300, 390]
/** Playing the real board headlessly is not cheap, and the dense sweep is ~30s per gate. Vitest's
 *  5s default would fail these on wall clock rather than on merit — which is exactly the kind of
 *  false red that teaches people to ignore a suite. */
const T = { timeout: FULL ? 180_000 : 30_000 }

type Flags = { enabled: boolean }
function withHazards<T>(on: boolean, fn: () => T): T {
  const f = DIFFICULTY.hazards as Flags
  const was = f.enabled
  f.enabled = on
  try {
    return fn()
  } finally {
    f.enabled = was
  }
}

describe('cascade health — the Plinko guarantee', () => {
  /**
   * The single constraint that shaped the whole blocker design. Cascades are already rare (a chain
   * reaches Plinko's threshold of 5 on well under 1% of moves), so there was no headroom to spend:
   * a blocker that segmented a column would have starved the cells beneath it and quietly removed
   * Plinko from the game rather than making it rarer. Segment-aware gravity plus the placement caps
   * are what keep this passing — if either regresses, this is the test that catches it.
   */
  it('keeps chains as deep with hazards on as without', T, () => {
    for (const L of CHECK_LEVELS) {
      const off = withHazards(false, () => sampleLevel(L, SEEDS, 'banker'))
      const on = withHazards(true, () => sampleLevel(L, SEEDS, 'banker'))
      const ratio = off.meanMaxCascade > 0 ? on.meanMaxCascade / off.meanMaxCascade : 1
      expect({ L, ok: ratio >= 0.85 }).toEqual({ L, ok: true })
    }
  })

  it('still reaches a Plinko-eligible chain often enough to stay a treat', T, () => {
    for (const L of CHECK_LEVELS) {
      const on = withHazards(true, () => sampleLevel(L, SEEDS, 'banker'))
      expect({ L, ok: on.plinkoEligibleRate >= 0.15 }).toEqual({ L, ok: true })
    }
  })
})

describe('hazards stay fair', () => {
  it('never hands out a level that cannot be finished', T, () => {
    // A weak proxy clearing at least once across several seeds is a floor, not a target: it only
    // proves the level is winnable at all. A band that fails this is broken, not merely hard.
    for (const L of CHECK_LEVELS) {
      const s = withHazards(true, () => sampleLevel(L, SEEDS, 'banker'))
      expect({ L, everWon: s.runs.some(r => r.won) }).toEqual({ L, everWon: true })
    }
  })

  it('never leaves a board with no legal move that a reshuffle cannot fix', () => {
    for (const L of [31, 86, 200, 300]) {
      const b = buildLevelBoard(L, 0x51ee + L)
      expect({ L, hasMove: b.hasValidMove() }).toEqual({ L, hasMove: true })
    }
  })

  it('lets blockers decay instead of squatting on the board all level', T, () => {
    // Hazards are seeded once and only ever removed, so their cost must be front-loaded. A blocker
    // that survived most of a level would be a permanent inert cell, which measurement showed is
    // roughly 10x more punishing per cell than anything else here.
    for (const L of [86, 150, 300]) {
      const nb = hazardPlan(L, ROWS, COLS).blockers.length
      if (nb === 0) continue
      const s = withHazards(true, () => sampleLevel(L, SEEDS, 'banker'))
      const turns = s.runs.reduce((t, r) => t + r.blockerCellTurns, 0) / s.runs.length
      const moves = s.runs.reduce((t, r) => t + r.chains.length, 0) / s.runs.length
      expect({ L, ok: turns / Math.max(1, nb * moves) <= 0.35 }).toEqual({ L, ok: true })
    }
  })

  it('does not gate the win behind coats a player cannot reach', T, () => {
    for (const L of [56, 100, 300]) {
      const s = withHazards(true, () => sampleLevel(L, SEEDS, 'banker'))
      const stranded = s.runs.filter(r => r.coatsLeft > 0).length / s.runs.length
      expect({ L, ok: stranded <= 0.35 }).toEqual({ L, ok: true })
    }
  })
})

describe('the protected early game', () => {
  it('plays identically with hazards on and off, all the way to the first band', T, () => {
    for (const L of [1, 10, 20, 29, 30]) {
      const off = withHazards(false, () => playLevel(L, 0xa11ce + L, 'banker'))
      const on = withHazards(true, () => playLevel(L, 0xa11ce + L, 'banker'))
      expect({ L, chains: on.chains, won: on.won }).toEqual({ L, chains: off.chains, won: off.won })
    }
  })
})

describe('endless is excluded', () => {
  /**
   * The daily race is a same-board-for-everyone fairness contract — the same reason boosts are
   * kept out of it. Hazards would make one player's board harder than another's and break the
   * score comparison the whole race rests on, so they must never reach it. GameScene guards this by
   * building the endless board in its own branch (it never calls levelSpec at all); this proves the
   * model layer agrees, whatever the flags say.
   */
  it('builds the same board for a day key regardless of hazard flags or player level', () => {
    const day = '2026-07-29'
    const build = (): string => {
      const b = new Board(ROWS, COLS, SYMBOLS.length, endlessRngForDay(day))
      const cells: string[] = []
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const p = b.get({ row: r, col: c })
          cells.push(`${p?.symbol ?? '-'}:${p?.kind ?? '-'}:${p?.locked ? 'L' : ''}`)
        }
      }
      return cells.join('|')
    }
    const a = withHazards(false, build)
    const b = withHazards(true, build)
    expect(b).toBe(a)
    expect(b).not.toContain(':blocker:')
    expect(b).not.toContain('L')
  })
})

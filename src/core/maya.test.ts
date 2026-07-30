import { describe, expect, it } from 'vitest'

import { levelProgress, wasNearMiss } from './maya'

/** A collect goal that has been fully met. */
const met = (total: number): { remaining: number; total: number } => ({ remaining: 0, total })

describe('levelProgress', () => {
  it('still owes the last felt layer once every symbol is collected', () => {
    // The level 77 report: three goals ticked, FELT 10/11, and the level correctly refusing to end.
    // Deriving this from the objectives alone returned 0 — which is what let the lose card head a
    // row of green checks with STILL NEEDED, and what made the continue offer decline to sell the
    // move that would have won it.
    const { owed, collected, total } = levelProgress([met(55), met(55), met(55)], 1, 11)
    expect(owed).toBe(1)
    expect(collected).toBe(175) // 165 symbols + 10 felt swept
    expect(total).toBe(176)
  })

  it('reports nothing owed only when the felt is gone too', () => {
    expect(levelProgress([met(55)], 0, 11).owed).toBe(0)
    expect(levelProgress([met(55)], 1, 11).owed).toBeGreaterThan(0)
  })

  it('counts felt in layers, so a half-stripped 2-layer coat is not swept', () => {
    // coatsToClear sums layers, not squares; one layer off a 2-layer coat still owes the other.
    expect(levelProgress([met(30)], 1, 2)).toMatchObject({ owed: 1, collected: 31, total: 32 })
  })

  it('collapses to the objectives alone on a hazard-free level', () => {
    const goals = [{ remaining: 4, total: 20 }, met(20)]
    expect(levelProgress(goals)).toMatchObject({ owed: 4, collected: 36, total: 40 })
    expect(levelProgress(goals, 0, 0)).toMatchObject({ owed: 4, collected: 36, total: 40 })
  })

  it('never reports negative progress from an over-collected goal', () => {
    // `remaining` can run past the goal on a cascade that clears more than the level asked for.
    expect(levelProgress([{ remaining: -3, total: 20 }], 0, 0)).toMatchObject({ owed: 0, collected: 20 })
  })

  it('keeps the near-miss verdict honest on a felt-heavy loss', () => {
    // Goals all met but most of the table still coated. Read from the objectives alone this scored
    // 0/30 — a perfect near miss — and the card said "so close" to a player who had swept 2 of 20.
    const goalsOnly = wasNearMiss(0, 30)
    const withFelt = levelProgress([met(30)], 18, 20)
    expect(goalsOnly).toBe(true)
    expect(wasNearMiss(withFelt.owed, withFelt.total)).toBe(false)
  })

  it('still calls a genuine last-square loss a near miss', () => {
    const p = levelProgress([met(55), met(55), met(55)], 1, 11)
    expect(wasNearMiss(p.owed, p.total)).toBe(true)
  })
})

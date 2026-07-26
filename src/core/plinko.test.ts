import { describe, expect, it } from 'vitest'
import { PLINKO_MIN_CASCADE, PLINKO_ROWS, PLINKO_SLOTS, dropPath, rollSlotIndex, shouldOfferPlinko } from './plinko'
import { mulberry32 } from './rng'

/**
 * The Plinko drop is AWARD-FIRST: the slot is chosen and the prize banked before the ball moves, and
 * `dropPath` then manufactures a bounce sequence that lands there. That makes one invariant
 * load-bearing above all others — **a path built for slot N must actually arrive at slot N**. If it
 * ever drifts, the player watches the ball land in ×2 and gets paid ×10 (or worse, the reverse), and
 * the whole "the machine always pays what you see" contract is gone.
 *
 * The rest pin the table itself (weights are the odds, so a typo is a balance bug) and the
 * ticket-suppression path, which exists so a capped-out or endless player is never shown a prize
 * that can't be honoured.
 */

describe('the slot table', () => {
  it('has one slot per landing position — rows + 1', () => {
    expect(PLINKO_SLOTS).toHaveLength(PLINKO_ROWS + 1)
  })

  it('weights sum to 100, so each reads directly as a percentage', () => {
    expect(PLINKO_SLOTS.reduce((sum, p) => sum + p.weight, 0)).toBe(100)
  })

  it('is symmetric about the centre — neither side of the board is luckier', () => {
    for (let i = 0; i < PLINKO_SLOTS.length >> 1; i++) {
      const left = PLINKO_SLOTS[i]
      const right = PLINKO_SLOTS[PLINKO_SLOTS.length - 1 - i]
      expect(left, `slot ${i} vs its mirror`).toEqual(right)
    }
  })

  it('is cheapest in the middle and richest at the edges (the binomial shape)', () => {
    const mid = PLINKO_SLOTS.length >> 1
    const centre = PLINKO_SLOTS[mid]
    const edge = PLINKO_SLOTS[0]
    expect(centre.kind).toBe('mult')
    expect(edge.kind).toBe('mult')
    if (centre.kind === 'mult' && edge.kind === 'mult') expect(edge.mult).toBeGreaterThan(centre.mult)
    expect(centre.weight).toBeGreaterThan(edge.weight)
  })
})

describe('rollSlotIndex', () => {
  it('always lands on a real slot, across a wide seed sweep', () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 500; seed++) {
      for (const allow of [true, false]) {
        const i = rollSlotIndex(mulberry32(seed), allow)
        if (!Number.isInteger(i) || i < 0 || i >= PLINKO_SLOTS.length) {
          if (bad.length < 20) bad.push(`seed ${seed} allowTickets=${allow} → ${i}`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('handles both ends of the random stream', () => {
    expect(rollSlotIndex(() => 0, true)).toBe(0)
    expect(rollSlotIndex(() => 0.9999999, true)).toBe(PLINKO_SLOTS.length - 1)
  })

  it('never returns a ticket slot when tickets cannot be paid', () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 2000; seed++) {
      const i = rollSlotIndex(mulberry32(seed), false)
      if (PLINKO_SLOTS[i].kind === 'ticket' && bad.length < 20) bad.push(`seed ${seed} → ticket slot ${i}`)
    }
    expect(bad).toEqual([])
  })

  it('pays out close to the declared weights over many rolls', () => {
    const rng = mulberry32(12345)
    const N = 20_000
    const counts = new Array(PLINKO_SLOTS.length).fill(0)
    for (let i = 0; i < N; i++) counts[rollSlotIndex(rng, true)]++
    const bad: string[] = []
    PLINKO_SLOTS.forEach((slot, i) => {
      const pct = (counts[i] / N) * 100
      // Generous band — this catches a transposed/typo'd weight, not sampling noise.
      if (Math.abs(pct - slot.weight) > Math.max(1.5, slot.weight * 0.25)) {
        bad.push(`slot ${i} (${slot.label}): declared ${slot.weight}%, rolled ${pct.toFixed(2)}%`)
      }
    })
    expect(bad).toEqual([])
  })
})

describe('dropPath — the rig that keeps the drop honest', () => {
  it('lands in the slot it was built for, every slot, every seed', () => {
    const bad: string[] = []
    for (let slot = 0; slot <= PLINKO_ROWS; slot++) {
      for (let seed = 1; seed <= 200; seed++) {
        const path = dropPath(mulberry32(seed), slot)
        const rights = path.filter(d => d === 1).length
        if (path.length !== PLINKO_ROWS && bad.length < 20) bad.push(`slot ${slot} seed ${seed}: ${path.length} bounces`)
        if (rights !== slot && bad.length < 20) bad.push(`slot ${slot} seed ${seed}: landed in ${rights}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('only ever emits left or right', () => {
    const path = dropPath(mulberry32(9), 5)
    expect(path.every(d => d === 1 || d === -1)).toBe(true)
  })

  it('clamps a nonsense target instead of building an impossible path', () => {
    expect(dropPath(mulberry32(1), -3).filter(d => d === 1)).toHaveLength(0)
    expect(dropPath(mulberry32(1), 99).filter(d => d === 1)).toHaveLength(PLINKO_ROWS)
  })

  it('actually varies the route — two seeds to the same slot differ', () => {
    const a = dropPath(mulberry32(1), 4).join('')
    const b = dropPath(mulberry32(77), 4).join('')
    expect(a).not.toBe(b)
  })
})

describe('shouldOfferPlinko', () => {
  it('never offers below the bar, however lucky the roll', () => {
    for (let cascade = 0; cascade < PLINKO_MIN_CASCADE; cascade++) {
      expect(shouldOfferPlinko(cascade, () => 0), `cascade x${cascade}`).toBe(false)
    }
  })

  it('offers on a qualifying chain when the roll lands under the chance', () => {
    expect(shouldOfferPlinko(PLINKO_MIN_CASCADE, () => 0)).toBe(true)
    expect(shouldOfferPlinko(PLINKO_MIN_CASCADE + 4, () => 0)).toBe(true)
  })

  it('declines a qualifying chain when the roll misses — it is a chance, not a guarantee', () => {
    expect(shouldOfferPlinko(PLINKO_MIN_CASCADE, () => 0.999)).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { mulberry32 } from './rng'
import { SHOE_COPIES, Shoe, buildShoe } from './shoe'
import { SYMBOLS } from './types'
import type { Piece, SymbolType } from './types'

/**
 * THE COUNTING SHOE's own contract — the pure half. What the band it runs on promises (which levels
 * carry one, the teaching level, revocability, endless untouched) is asserted in actII.test.ts next
 * to the other Act II bands; what is asserted HERE is that the shoe itself deals honestly: a full
 * shoe is the uniform composition, a draw is without replacement, an empty shoe reshuffles rather
 * than failing, and a snapshot round-trips without ever being trusted.
 */

describe('the shoe deals without replacement', () => {
  it('holds SHOE_COPIES of each live symbol and deals exactly that many of each per shoe', () => {
    const shoe = buildShoe(6, mulberry32(0xd00d))
    expect(shoe.capacity()).toBe(6 * SHOE_COPIES)
    expect(shoe.cardsLeft()).toBe(shoe.capacity())
    const dealt = new Map<SymbolType, number>()
    for (let i = 0; i < shoe.capacity(); i++) {
      const s = shoe.draw()
      dealt.set(s, (dealt.get(s) ?? 0) + 1)
    }
    // One full pass through the shoe is the exact composition — that is what "finite" means, and
    // it is the property that makes counting it worth anything.
    for (const s of SYMBOLS) expect({ s, n: dealt.get(s) }).toEqual({ s, n: SHOE_COPIES })
    expect(shoe.cardsLeft()).toBe(0)
    expect(shoe.reshuffles()).toBe(0)
  })

  it('reshuffles itself at empty — a draw can never fail, so a cascade can never stall on it', () => {
    const shoe = buildShoe(6, mulberry32(0xfeed))
    let beats = 0
    shoe.setOnReshuffle(() => beats++)
    for (let i = 0; i < shoe.capacity(); i++) shoe.draw()
    expect(shoe.cardsLeft()).toBe(0)
    const next = shoe.draw()
    expect(SYMBOLS.includes(next)).toBe(true)
    expect(shoe.reshuffles()).toBe(1)
    expect(beats).toBe(1)
    // The reshuffle dealt from a FULL shoe: everything is back except the one card just drawn.
    expect(shoe.cardsLeft()).toBe(shoe.capacity() - 1)
    expect(shoe.countOf(next)).toBe(SHOE_COPIES - 1)
  })

  it('counts track every draw — the HUD chip and the panel read these', () => {
    const shoe = buildShoe(6, mulberry32(0xace))
    const first = shoe.draw()
    expect(shoe.countOf(first)).toBe(SHOE_COPIES - 1)
    expect(shoe.cardsLeft()).toBe(shoe.capacity() - 1)
    // A symbol outside the live palette counts zero rather than lying or throwing.
    const five = new Shoe(SYMBOLS.slice(0, 5), mulberry32(1))
    expect(five.countOf(SYMBOLS[5])).toBe(0)
  })

  it('is deterministic per rng — the sim reproduces a run, the scene deals fresh', () => {
    const a = buildShoe(6, mulberry32(0xbead))
    const b = buildShoe(6, mulberry32(0xbead))
    const seqA = Array.from({ length: 60 }, () => a.draw())
    const seqB = Array.from({ length: 60 }, () => b.draw())
    expect(seqA).toEqual(seqB)
    const c = buildShoe(6, mulberry32(0xbead + 1))
    expect(Array.from({ length: 60 }, () => c.draw())).not.toEqual(seqA)
  })
})

describe('the snapshot round-trip — levelresume reads localStorage, so nothing is trusted', () => {
  it('round-trips its own counts', () => {
    const shoe = buildShoe(6, mulberry32(7))
    for (let i = 0; i < 17; i++) shoe.draw()
    const counts = shoe.toCounts()
    const back = buildShoe(6, mulberry32(99))
    expect(back.restoreCounts(counts)).toBe(true)
    expect(back.toCounts()).toEqual(counts)
    expect(back.cardsLeft()).toBe(shoe.cardsLeft())
  })

  it('refuses garbage and stays full — a refused restore costs a reshuffle, never a crash', () => {
    const bad: unknown[] = [
      null,
      'x',
      [1, 2, 3], // wrong length
      [8, 8, 8, 8, 8, 9], // over capacity
      [8, 8, 8, 8, 8, -1], // negative
      [8, 8, 8, 8, 8, 1.5], // fractional
      [8, 8, 8, 8, 8, '3'], // wrong type
    ]
    for (const junk of bad) {
      const shoe = buildShoe(6, mulberry32(3))
      expect({ junk, ok: shoe.restoreCounts(junk) }).toEqual({ junk, ok: false })
      expect(shoe.cardsLeft()).toBe(shoe.capacity())
    }
  })
})

describe('the board seam', () => {
  type Grid = (Piece | null)[][]
  const gridOf = (b: Board): Grid => (b as unknown as { grid: Grid }).grid

  it('with a source attached, every refill is dealt by it', () => {
    const b = new Board(8, 8, 6, mulberry32(0x1dea))
    let draws = 0
    b.setRefillSource({
      draw: () => {
        draws++
        return 'cherry'
      },
    })
    // Punch three holes the way a clear does, then refill: the dealer covers exactly the holes.
    const g = gridOf(b)
    g[0][2] = null
    g[3][5] = null
    g[7][7] = null
    const spawns = b.refill()
    expect(spawns).toHaveLength(3)
    expect(draws).toBe(3)
    for (const s of spawns) expect(s.piece.symbol).toBe('cherry')
  })

  it('absent, the uniform path runs — a fresh board holds no source', () => {
    // The strong form of this contract — absence is bit-for-bit the pre-shoe game — is carried by
    // every pre-existing board, endless and boardpick golden passing unmodified; what is asserted
    // here is the seam's default, so no board can be born holding a dealer nobody attached.
    const b = new Board(8, 8, 6, mulberry32(0x1dea))
    expect((b as unknown as { refillSource: unknown }).refillSource).toBeNull()
    const g = gridOf(b)
    g[4][4] = null
    const spawns = b.refill()
    expect(spawns).toHaveLength(1)
    expect(SYMBOLS.slice(0, 6).includes(spawns[0].piece.symbol)).toBe(true)
  })
})

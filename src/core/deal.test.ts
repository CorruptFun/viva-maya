import { describe, expect, it } from 'vitest'
import {
  BELL_SUBSTITUTE_CHIPS,
  DEAL_CARDS,
  DEAL_FACES,
  DEAL_MATCH,
  DEAL_STREAK,
  FAST_DEAL_FLIPS,
  buildDeck,
  dealFaces,
  dealHand,
  dealReady,
  fastDeal,
  luckWeights,
  matchAt,
  pipTotal,
  rollFace,
  settleDeal,
  winsToDeal,
} from './deal'
import type { DealFaceId } from './deal'
import { LUCK_CAP } from './charms'
import { mulberry32 } from './rng'

/** Every id in the catalogue, so the fuzz sweeps cover every possible winner. */
const IDS = DEAL_FACES.map(f => f.id)

describe('the face table', () => {
  it('sums to 100 in BOTH weight columns, so every weight reads as a percentage', () => {
    const base = DEAL_FACES.reduce((s, f) => s + f.weight, 0)
    const lucky = DEAL_FACES.reduce((s, f) => s + f.luckyWeight, 0)
    expect(base).toBe(100)
    expect(lucky).toBe(100)
  })

  it('substitutes the BELL for chips when a spin cannot be paid, keeping its weight', () => {
    const bell = DEAL_FACES.find(f => f.id === 'bell')!
    const substituted = dealFaces(false).find(f => f.id === 'bell')!
    expect(bell.prize).toEqual({ kind: 'spin', spins: 1 })
    expect(substituted.prize).toEqual({ kind: 'chips', chips: BELL_SUBSTITUTE_CHIPS })
    expect(substituted.weight).toBe(bell.weight)
    // The whole point of substituting rather than zeroing: the table still sums to 100, so no face on
    // the table is unwinnable and every weight still reads directly as a percentage.
    expect(dealFaces(false).reduce((s, f) => s + f.weight, 0)).toBe(100)
  })

  it('leaves the pips alone when the BELL is substituted (settleDeal prices pips off the base table)', () => {
    for (const f of dealFaces(false)) {
      expect(f.pip).toBe(DEAL_FACES.find(b => b.id === f.id)!.pip)
    }
  })
})

describe('luck', () => {
  it('is the base table at luck 0 and the lucky table at the cap', () => {
    expect(luckWeights(DEAL_FACES, 0)).toEqual(DEAL_FACES.map(f => f.weight))
    expect(luckWeights(DEAL_FACES, LUCK_CAP)).toEqual(DEAL_FACES.map(f => f.luckyWeight))
  })

  it('always sums to 100, at every luck level in between', () => {
    for (let luck = 0; luck <= LUCK_CAP; luck++) {
      const sum = luckWeights(DEAL_FACES, luck).reduce((s, w) => s + w, 0)
      expect(sum).toBeCloseTo(100, 10)
    }
  })

  it('clamps past the cap rather than extrapolating past the lucky table', () => {
    expect(luckWeights(DEAL_FACES, LUCK_CAP * 5)).toEqual(luckWeights(DEAL_FACES, LUCK_CAP))
    expect(luckWeights(DEAL_FACES, -3)).toEqual(luckWeights(DEAL_FACES, 0))
  })

  it('moves the HEART monotonically upward and the CHERRY monotonically downward', () => {
    const heart = DEAL_FACES.findIndex(f => f.id === 'heart')
    const cherry = DEAL_FACES.findIndex(f => f.id === 'cherry')
    for (let luck = 1; luck <= LUCK_CAP; luck++) {
      const prev = luckWeights(DEAL_FACES, luck - 1)
      const now = luckWeights(DEAL_FACES, luck)
      expect(now[heart]).toBeGreaterThan(prev[heart])
      expect(now[cherry]).toBeLessThan(prev[cherry])
    }
  })

  it('actually shifts the observed roll toward the HEART — measured, not assumed', () => {
    const count = (luck: number): number => {
      const rng = mulberry32(0xd1ce)
      let hearts = 0
      for (let i = 0; i < 40000; i++) if (rollFace(rng, true, luck).id === 'heart') hearts++
      return hearts
    }
    const cold = count(0)
    const lucky = count(LUCK_CAP)
    // 10% → 18% of rolls. Assert the direction and a loose band, not the exact count, so the test
    // guards the tuning intent without breaking on an unrelated table nudge.
    expect(cold / 40000).toBeGreaterThan(0.085)
    expect(cold / 40000).toBeLessThan(0.115)
    expect(lucky / 40000).toBeGreaterThan(0.16)
    expect(lucky / 40000).toBeLessThan(0.2)
    expect(lucky).toBeGreaterThan(cold * 1.5)
  })

  it('keeps the HEART reachable enough to be a CURRENCY, not just a lottery', () => {
    // The rate guard for the exchange (core/charms.ts CHARM_EXCHANGE). Charms are spendable, and a
    // spendable thing that arrives once per several hours of play makes the shelf decoration. The
    // HEART sat at 3% when it was only a keepsake; if a future tuning pass pushes it back down there,
    // the exchange quietly stops working and nothing else would have caught it.
    const heart = DEAL_FACES.find(f => f.id === 'heart')!
    expect(heart.weight).toBeGreaterThanOrEqual(8)
    expect(heart.luckyWeight).toBeGreaterThan(heart.weight)
    // …but still the top of the ladder: nothing above it may be commoner than the cheap cards.
    const cherry = DEAL_FACES.find(f => f.id === 'cherry')!
    expect(heart.weight).toBeLessThan(cherry.weight)
  })
})

describe('the deck rig', () => {
  it('holds exactly DEAL_MATCH of the winner and AT MOST DEAL_MATCH-1 of anything else', () => {
    // The invariant the entire award-first design rests on. Swept across every winner and 400 seeds:
    // if any decoy can ever reach three, a pick order exists that pays the wrong prize.
    for (const winner of IDS) {
      for (let seed = 0; seed < 400; seed++) {
        const deck = buildDeck(mulberry32(seed), winner)
        expect(deck).toHaveLength(DEAL_CARDS)
        const counts = new Map<DealFaceId, number>()
        for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1)
        expect(counts.get(winner)).toBe(DEAL_MATCH)
        for (const [id, n] of counts) {
          if (id !== winner) expect(n).toBeLessThanOrEqual(DEAL_MATCH - 1)
        }
      }
    }
  })

  it('never deals a card outside the catalogue', () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const id of buildDeck(mulberry32(seed), 'heart')) expect(IDS).toContain(id)
    }
  })

  it('pays the ROLLED face for EVERY possible pick order — the rig is order-independent', () => {
    // The strongest statement of correctness available: enumerate a large sample of pick orders and
    // assert the face that reaches three is always the one rolled up front. If the deck construction
    // ever regressed, some order would resolve to a decoy and this would catch it.
    for (const winner of IDS) {
      for (let seed = 0; seed < 60; seed++) {
        const deck = buildDeck(mulberry32(seed), winner)
        for (let trial = 0; trial < 40; trial++) {
          const rng = mulberry32(seed * 1000 + trial)
          const order = [...Array(DEAL_CARDS).keys()]
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1))
            ;[order[i], order[j]] = [order[j], order[i]]
          }
          const at = matchAt(deck, order, winner)
          expect(at).toBeGreaterThanOrEqual(DEAL_MATCH - 1)
          // Nothing else reached three at or before the winner did.
          const seen = new Map<DealFaceId, number>()
          for (let i = 0; i <= at; i++) {
            const id = deck[order[i]]
            seen.set(id, (seen.get(id) ?? 0) + 1)
          }
          expect(seen.get(winner)).toBe(DEAL_MATCH)
          for (const [id, n] of seen) if (id !== winner) expect(n).toBeLessThan(DEAL_MATCH)
        }
      }
    }
  })

  it('lands the match around the 7.5th flip on average — a round is ~7 taps, not 9', () => {
    let total = 0
    let rounds = 0
    for (let seed = 0; seed < 3000; seed++) {
      const rng = mulberry32(seed)
      const hand = dealHand(rng, true)
      const order = [...Array(DEAL_CARDS).keys()]
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      total += matchAt(hand.deck, order, hand.face.id) + 1
      rounds++
    }
    const mean = total / rounds
    // Three winners uniform among nine cards ⇒ E[position of the 3rd] = 3·(9+1)/4 = 7.5.
    expect(mean).toBeGreaterThan(7.0)
    expect(mean).toBeLessThan(8.0)
  })

  it('usually deals live decoy PAIRS, so a turned pair is a real question', () => {
    let withPairs = 0
    const rounds = 1000
    for (let seed = 0; seed < rounds; seed++) {
      const deck = buildDeck(mulberry32(seed), 'cherry')
      const counts = new Map<DealFaceId, number>()
      for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1)
      let pairs = 0
      for (const [id, n] of counts) if (id !== 'cherry' && n === 2) pairs++
      if (pairs >= 2) withPairs++
    }
    expect(withPairs / rounds).toBeGreaterThan(0.7)
  })
})

describe('settling a hand', () => {
  it('pays the headline chips, the pips and nothing else for a chip face', () => {
    const rng = mulberry32(1)
    const hand = { face: DEAL_FACES.find(f => f.id === 'seven')!, deck: buildDeck(rng, 'seven'), luck: 0 }
    const order = [...Array(DEAL_CARDS).keys()]
    const flips = matchAt(hand.deck, order, 'seven') + 1
    const out = settleDeal(hand, order, flips, rng)
    expect(out.prizeChips).toBe(120)
    expect(out.pipChips).toBe(pipTotal(hand.deck, order, flips))
    expect(out.chips).toBe(out.prizeChips + out.pipChips + out.fastChips)
    expect(out.spins).toBe(0)
    expect(out.boost).toBeNull()
    expect(out.charm).toBe(false)
  })

  it('pays a spin for the BELL and a charm for the HEART, never chips for either', () => {
    const rng = mulberry32(2)
    const order = [...Array(DEAL_CARDS).keys()]
    const bell = { face: DEAL_FACES.find(f => f.id === 'bell')!, deck: buildDeck(rng, 'bell'), luck: 0 }
    const bellOut = settleDeal(bell, order, matchAt(bell.deck, order, 'bell') + 1, rng)
    expect(bellOut.spins).toBe(1)
    expect(bellOut.prizeChips).toBe(0)

    const heart = { face: DEAL_FACES.find(f => f.id === 'heart')!, deck: buildDeck(rng, 'heart'), luck: 0 }
    const heartOut = settleDeal(heart, order, matchAt(heart.deck, order, 'heart') + 1, rng)
    expect(heartOut.charm).toBe(true)
    expect(heartOut.prizeChips).toBe(0)
  })

  it('rolls a real boost for the DIAMOND', () => {
    const rng = mulberry32(3)
    const order = [...Array(DEAL_CARDS).keys()]
    const hand = { face: DEAL_FACES.find(f => f.id === 'diamond')!, deck: buildDeck(rng, 'diamond'), luck: 0 }
    const out = settleDeal(hand, order, matchAt(hand.deck, order, 'diamond') + 1, rng)
    expect(out.boost).toBeTruthy()
    expect(out.prizeChips).toBe(0)
  })

  it('only pays the FAST DEAL bonus inside the flip window', () => {
    expect(fastDeal(DEAL_MATCH)).toBe(true)
    expect(fastDeal(FAST_DEAL_FLIPS)).toBe(true)
    expect(fastDeal(FAST_DEAL_FLIPS + 1)).toBe(false)
    expect(fastDeal(0)).toBe(false)
  })

  it('counts pips only for the cards actually turned', () => {
    const deck = buildDeck(mulberry32(7), 'cherry')
    const order = [...Array(DEAL_CARDS).keys()]
    expect(pipTotal(deck, order, 0)).toBe(0)
    expect(pipTotal(deck, order, 3)).toBeLessThanOrEqual(pipTotal(deck, order, 9))
    expect(pipTotal(deck, order, 99)).toBe(pipTotal(deck, order, DEAL_CARDS))
  })
})

describe('the hot-streak trigger', () => {
  it('deals every DEAL_STREAK wins and never on a cold streak', () => {
    expect(dealReady(0)).toBe(false)
    for (let n = 1; n <= 30; n++) expect(dealReady(n)).toBe(n % DEAL_STREAK === 0)
  })

  it('counts down the wins remaining, wrapping cleanly at each deal', () => {
    expect(winsToDeal(0)).toBe(DEAL_STREAK)
    expect(winsToDeal(1)).toBe(DEAL_STREAK - 1)
    expect(winsToDeal(DEAL_STREAK)).toBe(DEAL_STREAK)
    expect(winsToDeal(DEAL_STREAK + 1)).toBe(DEAL_STREAK - 1)
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRIZES } from './daily'
import { DIFFICULTY } from './difficulty'
import { BOOST_META, BOOST_ORDER, hasSurplus, stash, stashTotal, usingNextCount } from './inventory'
import { coerceSave, loadSave, persistSave, promoteBoost, splitPendingBoosts, takePendingBoosts } from './save'
import { BOOST_ITEMS } from './store'
import type { BoostType } from './types'

const save = (pendingBoosts: BoostType[]) => coerceSave({ pendingBoosts })

// Minimal localStorage stub for the Node test env — same shape leaderboard.test.ts uses. Only the
// promoteBoost / takePendingBoosts blocks need it; the pure `stash` reads take a SaveData directly.
function stubStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
}
function dropStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage
}

describe('BOOST_META — the canonical names', () => {
  /**
   * The whole point of BOOST_META is that ONE object has ONE name. Before it, the free prize table
   * (daily.ts) and the paid one (store.ts) each carried their own copy of every label, so a rename
   * in one place left the other describing the same item differently — and a player has no way to
   * know two differently-worded things are the same thing they already own.
   */
  it('is the single source of truth for the free prize table', () => {
    for (const prize of PRIZES) {
      expect(prize.label).toBe(BOOST_META[prize.type].label)
      expect(prize.blurb).toBe(BOOST_META[prize.type].blurb)
    }
  })

  it('is the single source of truth for the paid store table', () => {
    for (const item of BOOST_ITEMS) {
      expect(item.label).toBe(BOOST_META[item.type].label)
    }
  })

  it('covers every boost type exactly once, with no gaps in the display order', () => {
    const ordered = [...BOOST_ORDER].sort()
    const metaKeys = (Object.keys(BOOST_META) as BoostType[]).sort()
    expect(ordered).toEqual(metaKeys)
    expect(new Set(BOOST_ORDER).size).toBe(BOOST_ORDER.length)
  })

  /**
   * Display order is deliberately NOT the prize table's order — that one is weight-ordered and
   * `rollPrize` walks it, so reordering it silently changes which prize an RNG roll returns. Pinned
   * so a future "let's make these consistent" tidy-up can't quietly rewrite the drop rates.
   */
  it('keeps display order independent of the weight-ordered prize table', () => {
    expect(BOOST_ORDER).not.toEqual(PRIZES.map(p => p.type))
  })
})

describe('stash — what the player owns', () => {
  it('counts duplicates and keeps a stable row for every type', () => {
    const rows = stash(save(['extraMoves', 'extraMoves', 'wildReel']))
    expect(rows).toHaveLength(BOOST_ORDER.length) // zero-count rows are kept, so the grid never reflows
    expect(rows.find(r => r.type === 'extraMoves')?.count).toBe(2)
    expect(rows.find(r => r.type === 'wildReel')?.count).toBe(1)
    expect(rows.find(r => r.type === 'jackpot')?.count).toBe(0)
  })

  it('is empty-safe', () => {
    expect(stashTotal(coerceSave({}))).toBe(0)
    expect(usingNextCount(coerceSave({}))).toBe(0)
    expect(hasSurplus(coerceSave({}))).toBe(false)
    expect(stash(coerceSave({})).every(r => r.count === 0 && r.usingNext === 0)).toBe(true)
  })
})

/**
 * ⚠️ THE DRIFT GUARD, and the reason `splitPendingBoosts` was extracted at all. The stash panel
 * promises "these go in next level"; that promise is only true while the preview and the actual
 * consumption run the same rule. Two copies of the cap logic would diverge the first time a cap
 * moved, and the symptom would be a player watching a promised boost fail to appear.
 */
describe('usingNext mirrors what the level actually consumes', () => {
  beforeEach(stubStorage)
  afterEach(dropStorage)

  it('agrees with takePendingBoosts for an over-cap queue', () => {
    const pending: BoostType[] = ['wildReel', 'diceBomb', 'extraMoves', 'doubleScore', 'jackpot']
    const predicted = stash(save(pending))

    persistSave(save(pending))
    const actuallyTaken = takePendingBoosts()

    for (const type of BOOST_ORDER) {
      expect(predicted.find(r => r.type === type)?.usingNext).toBe(actuallyTaken.filter(b => b === type).length)
    }
  })

  it('respects boostApplyMax and banks the surplus rather than dropping it', () => {
    const pending: BoostType[] = ['wildReel', 'diceBomb', 'extraMoves', 'doubleScore']
    expect(usingNextCount(save(pending))).toBe(DIFFICULTY.economy.boostApplyMax)
    expect(hasSurplus(save(pending))).toBe(true)

    persistSave(save(pending))
    const taken = takePendingBoosts()
    expect(taken).toHaveLength(DIFFICULTY.economy.boostApplyMax)
    // Nothing evaporates: taken + still-banked accounts for every boost that went in.
    expect(taken.length + loadSave().pendingBoosts.length).toBe(pending.length)
  })

  it('lets only jackpotBoostPerLevel jackpots through at once', () => {
    const rows = stash(save(['jackpot', 'jackpot', 'jackpot']))
    expect(rows.find(r => r.type === 'jackpot')?.count).toBe(3)
    expect(rows.find(r => r.type === 'jackpot')?.usingNext).toBe(DIFFICULTY.economy.jackpotBoostPerLevel)
  })

  it('reports no surplus when the queue fits', () => {
    expect(hasSurplus(save(['wildReel']))).toBe(false)
    expect(usingNextCount(save(['wildReel']))).toBe(1)
  })
})

/**
 * Promotion is how the stash lets a player CHOOSE. It works by reordering the pending queue rather
 * than adding an `armedBoosts` field, because `takePendingBoosts` already consumes from the front —
 * so there is no second array to keep in sync through grants, spends and cross-device merges.
 */
describe('promoteBoost — choosing what goes in next', () => {
  beforeEach(stubStorage)
  afterEach(dropStorage)

  it('moves a banked boost to the front so the next level takes it', () => {
    persistSave(save(['wildReel', 'diceBomb', 'extraMoves', 'jackpot']))
    expect(usingNextCount(loadSave())).toBe(3)
    expect(stash(loadSave()).find(r => r.type === 'jackpot')?.usingNext).toBe(0) // 4th — banked

    expect(promoteBoost('jackpot')).toBe(true)
    expect(stash(loadSave()).find(r => r.type === 'jackpot')?.usingNext).toBe(1)
    expect(loadSave().pendingBoosts[0]).toBe('jackpot')
  })

  it('never changes how many boosts are owned', () => {
    persistSave(save(['wildReel', 'diceBomb', 'extraMoves', 'jackpot']))
    const before = stashTotal(loadSave())
    promoteBoost('jackpot')
    expect(stashTotal(loadSave())).toBe(before)
  })

  it('is a no-op for a type the player does not own', () => {
    persistSave(save(['wildReel']))
    expect(promoteBoost('jackpot')).toBe(false)
    expect(loadSave().pendingBoosts).toEqual(['wildReel'])
  })

  it('is idempotent on something already at the front', () => {
    persistSave(save(['wildReel', 'diceBomb']))
    expect(promoteBoost('wildReel')).toBe(true)
    expect(loadSave().pendingBoosts).toEqual(['wildReel', 'diceBomb'])
  })
})

describe('splitPendingBoosts — the shared rule', () => {
  it('partitions without losing or inventing anything', () => {
    const pending: BoostType[] = ['jackpot', 'jackpot', 'wildReel', 'extraMoves', 'diceBomb']
    const { take, keep } = splitPendingBoosts(pending)
    expect([...take, ...keep].sort()).toEqual([...pending].sort())
  })

  it('preserves queue order within each partition, so the oldest prizes are spent first', () => {
    const { keep } = splitPendingBoosts(['wildReel', 'diceBomb', 'extraMoves', 'doubleScore', 'jackpot'])
    expect(keep).toEqual(['doubleScore', 'jackpot'])
  })
})

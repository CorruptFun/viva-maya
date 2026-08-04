import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRIZES } from './daily'
import { DIFFICULTY } from './difficulty'
import { BOOST_META, BOOST_ORDER, freeSourceFor, freeStockFor, hasSurplus, nextLevelSummary, stash, stashTotal, usingNextCount } from './inventory'
import { coerceSave, consumeBoost, loadSave, persistSave, promoteBoost, splitPendingBoosts, takePendingBoosts, toggleHoldBoost } from './save'
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

describe('freeSourceFor — paying with something you already own', () => {
  it('maps the +5 shelf item to the +5 boost, the one honest equivalence', () => {
    expect(freeSourceFor('moves5')).toBe('extraMoves')
  })

  /**
   * ⚠️ These NEGATIVE cases are the point of the test. BLAST and DICE BOMB sound like the same
   * thing and are not — a Dice Bomb is a piece planted on the board that you then have to match,
   * BLAST is an immediate 3×3 you aim. Offering one as the other would rebuild the exact
   * same-name-different-thing confusion this whole change set exists to undo, one layer deeper.
   * And spending a +5 boost to satisfy a +1 item would be a worse deal than the 8 chips it saved.
   */
  it('refuses the tempting-but-wrong mappings', () => {
    expect(freeSourceFor('bomb')).toBeNull() // NOT diceBomb — different mechanic, similar name
    expect(freeSourceFor('move1')).toBeNull() // no boost grants one move; burning a +5 is worse
    expect(freeSourceFor('nonsense')).toBeNull()
  })

  it('counts only stock that can actually stand in', () => {
    expect(freeStockFor(save(['extraMoves', 'extraMoves']), 'moves5')).toBe(2)
    expect(freeStockFor(save(['wildReel', 'diceBomb']), 'moves5')).toBe(0)
    expect(freeStockFor(save(['diceBomb']), 'bomb')).toBe(0) // owning a Dice Bomb does not buy BLAST
    expect(freeStockFor(coerceSave({}), 'moves5')).toBe(0)
  })
})

describe('consumeBoost — spending one outright', () => {
  beforeEach(stubStorage)
  afterEach(dropStorage)

  it('removes exactly one and leaves the rest', () => {
    persistSave(save(['extraMoves', 'extraMoves', 'wildReel']))
    expect(consumeBoost('extraMoves')).toBe(true)
    expect(loadSave().pendingBoosts).toEqual(['extraMoves', 'wildReel'])
  })

  it('drains the same end of the queue the level start does, so nothing goes stale', () => {
    persistSave(save(['extraMoves', 'wildReel', 'extraMoves']))
    consumeBoost('extraMoves')
    expect(loadSave().pendingBoosts).toEqual(['wildReel', 'extraMoves'])
  })

  it('reports false when the player owns none, so the caller can fall through to paying', () => {
    persistSave(save(['wildReel']))
    expect(consumeBoost('extraMoves')).toBe(false)
    expect(loadSave().pendingBoosts).toEqual(['wildReel'])
  })
})

describe('holding a boost type back', () => {
  beforeEach(stubStorage)
  afterEach(dropStorage)

  const heldSave = (pendingBoosts: BoostType[], heldBoosts: BoostType[]) =>
    coerceSave({ pendingBoosts, heldBoosts })

  it('excludes every instance of a held type, however many are owned', () => {
    const rows = stash(heldSave(['jackpot', 'jackpot', 'wildReel'], ['jackpot']))
    const jack = rows.find(r => r.type === 'jackpot')
    expect(jack?.count).toBe(2) // still owned
    expect(jack?.usingNext).toBe(0) // but none go in
    expect(jack?.held).toBe(true)
    expect(rows.find(r => r.type === 'wildReel')?.usingNext).toBe(1)
  })

  /**
   * ⚠️ The subtle one. Holding must FREE UP a slot, not silently waste one — otherwise setting a
   * Jackpot Chip aside would quietly cost the player one of their three boosts for that level, which
   * is the opposite of what "save it for later" means.
   */
  it('frees the slot rather than wasting it, so the next boost in line moves up', () => {
    const pending: BoostType[] = ['jackpot', 'wildReel', 'diceBomb', 'extraMoves']
    expect(usingNextCount(heldSave(pending, []))).toBe(3)
    expect(usingNextCount(heldSave(pending, ['jackpot']))).toBe(3) // still three, not two

    const rows = stash(heldSave(pending, ['jackpot']))
    expect(rows.find(r => r.type === 'extraMoves')?.usingNext).toBe(1) // promoted into the free slot
  })

  it('can hold everything, and then nothing goes in', () => {
    const held: BoostType[] = ['extraMoves', 'wildReel']
    expect(usingNextCount(heldSave(['extraMoves', 'wildReel'], held))).toBe(0)
  })

  /** The drift guard again, now with holds in play: preview and consumption must still agree. */
  it('agrees with what takePendingBoosts actually consumes', () => {
    const pending: BoostType[] = ['jackpot', 'wildReel', 'diceBomb', 'extraMoves']
    const predicted = stash(heldSave(pending, ['jackpot']))

    persistSave(heldSave(pending, ['jackpot']))
    const taken = takePendingBoosts()

    for (const type of BOOST_ORDER) {
      expect(predicted.find(r => r.type === type)?.usingNext).toBe(taken.filter(b => b === type).length)
    }
    expect(taken).not.toContain('jackpot')
    expect(loadSave().pendingBoosts).toContain('jackpot') // held, therefore still owned afterwards
  })

  it('toggles on and off, and survives a round trip through the save', () => {
    persistSave(heldSave(['jackpot'], []))
    expect(toggleHoldBoost('jackpot')).toBe(true)
    expect(loadSave().heldBoosts).toEqual(['jackpot'])
    expect(usingNextCount(loadSave())).toBe(0)

    expect(toggleHoldBoost('jackpot')).toBe(false)
    expect(loadSave().heldBoosts).toEqual([])
    expect(usingNextCount(loadSave())).toBe(1)
  })

  it('defaults to holding nothing, so older saves behave exactly as before', () => {
    expect(coerceSave({}).heldBoosts).toEqual([])
    expect(usingNextCount(coerceSave({ pendingBoosts: ['wildReel'] }))).toBe(1)
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

describe('nextLevelSummary — what am I about to spend', () => {
  const s = (pendingBoosts: BoostType[], heldBoosts: BoostType[] = []) =>
    coerceSave({ pendingBoosts, heldBoosts })

  it('names what is actually going in', () => {
    expect(nextLevelSummary(s(['extraMoves']))).toContain('+5 MOVES')
    expect(nextLevelSummary(s(['extraMoves']))).toContain('next level')
  })

  /** Three 12-character names on a 20px line would run off a 720-wide box. */
  it('caps at two names and counts the rest', () => {
    const out = nextLevelSummary(s(['extraMoves', 'wildReel', 'diceBomb']))
    expect(out).toContain('+1')
    expect(out).not.toContain('DICE BOMB')
  })

  it('says so when everything is held, rather than reading as broken', () => {
    const out = nextLevelSummary(s(['jackpot'], ['jackpot']))
    expect(out).toContain('nothing goes in next level')
    expect(out).toContain('1 held')
  })

  it('teaches the concept when the stash is empty', () => {
    expect(nextLevelSummary(coerceSave({}))).toContain('empty for now')
  })

  /** Never contradicts the tiles: the summary and the panel run the same split. */
  it('agrees with usingNextCount', () => {
    const save = s(['jackpot', 'wildReel', 'diceBomb', 'extraMoves'], ['jackpot'])
    expect(usingNextCount(save)).toBe(3)
    expect(nextLevelSummary(save)).not.toContain('JACKPOT')
  })
})

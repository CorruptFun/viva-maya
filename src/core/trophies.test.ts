import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHAPTER_BOOSTS,
  CHAPTER_PURSES,
  CHAPTER_PURSE_TOTAL,
  TROPHIES,
  TROPHY_TIERS,
  chaptersCompleted,
  claimChapter,
  claimChapterCatchUp,
  trophyFor,
  trophyTier,
  unclaimedChapters,
} from './trophies'
import { CHAPTER_COUNT, CHAPTER_LEVELS, LEVEL_COUNT } from './levels'
import { BOOST_META } from './inventory'
import { coerceSave, loadSave, persistSave } from './save'
import { mergeSaves } from './merge'

/**
 * Chapter trophies are the one reward a player can only EARN and never lose, and the purse ladder is
 * a fixed lifetime faucet — so what these tests pin is exactly that: the tables are data the economy
 * was sized against (re-derive, never edit-to-green), a chapter pays exactly once across any number
 * of devices and crashes, and no state can mint a trophy that wasn't earned.
 */

beforeEach(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    },
  })
})

/** Seed the store with a save whose highest attemptable level is `unlocked`. */
function seed(partial: Parameters<typeof coerceSave>[0]): void {
  persistSave(coerceSave(partial))
}

describe('the tables — economy data, pinned', () => {
  it('has exactly one trophy per chapter, in chapter order, all emoji unique', () => {
    expect(TROPHIES).toHaveLength(CHAPTER_COUNT)
    TROPHIES.forEach((t, i) => expect(t.chapter).toBe(i + 1))
    expect(new Set(TROPHIES.map(t => t.emoji)).size).toBe(CHAPTER_COUNT)
  })

  it('chapter 30 is the car — the showroom grand prize the whole ladder builds toward', () => {
    expect(TROPHIES[CHAPTER_COUNT - 1].emoji).toBe('🏎️')
    expect(TROPHIES[CHAPTER_COUNT - 1].label).toBe('THE CAR')
  })

  it('pins the purse ladder exactly — retune the economy there, not here', () => {
    expect(CHAPTER_PURSES).toEqual([
      100, 100, 100, 100, 150,
      150, 150, 150, 150, 250,
      200, 200, 200, 200, 300,
      250, 250, 250, 250, 400,
      300, 300, 300, 300, 500,
      400, 400, 400, 400, 1000,
    ])
    expect(CHAPTER_PURSE_TOTAL).toBe(8200)
  })

  it('the ladder never steps DOWN across a five-chapter band boundary base', () => {
    // Milestones spike (150→150 ok, 250→200 is the deliberate post-milestone reset), but the BASE
    // rate per band must be non-decreasing so later chapters never feel worth less than earlier ones.
    const bandBase = [0, 5, 10, 15, 20, 25].map(i => CHAPTER_PURSES[i])
    for (let i = 1; i < bandBase.length; i++) expect(bandBase[i]).toBeGreaterThanOrEqual(bandBase[i - 1])
  })

  it('milestone boosts land only on every 5th chapter and name real BOOST_META types', () => {
    for (const [chapter, type] of Object.entries(CHAPTER_BOOSTS)) {
      expect(Number(chapter) % 5).toBe(0)
      expect(type && BOOST_META[type]).toBeTruthy()
    }
  })

  it('tier ladder: no badge below 5 chapters, then bronze→silver→gold→case→car', () => {
    expect(trophyTier(0)).toBeNull()
    expect(trophyTier(4)).toBeNull()
    expect(trophyTier(5)?.emoji).toBe('🥉')
    expect(trophyTier(9)?.emoji).toBe('🥉')
    expect(trophyTier(10)?.emoji).toBe('🥈')
    expect(trophyTier(15)?.emoji).toBe('🥇')
    expect(trophyTier(20)?.emoji).toBe('🏆')
    expect(trophyTier(29)?.emoji).toBe('🏆')
    expect(trophyTier(30)?.emoji).toBe('🏎️')
    expect(trophyTier(Number.NaN)).toBeNull()
    // The ladder's own glyphs never collide with a showroom trophy except the car itself, which is
    // the point — wearing it means owning it.
    const shelf = new Set(TROPHIES.slice(0, -1).map(t => t.emoji))
    for (const tier of TROPHY_TIERS) expect(shelf.has(tier.emoji)).toBe(false)
  })
})

describe('chaptersCompleted — unlocked is the highest ATTEMPTABLE level', () => {
  it('counts a chapter only once its closing level is actually cleared', () => {
    expect(chaptersCompleted(1)).toBe(0)
    expect(chaptersCompleted(CHAPTER_LEVELS)).toBe(0) // level 10 reachable, not yet won
    expect(chaptersCompleted(CHAPTER_LEVELS + 1)).toBe(1) // level 10 cleared
    expect(chaptersCompleted(45)).toBe(4)
    expect(chaptersCompleted(LEVEL_COUNT + 1)).toBe(CHAPTER_COUNT)
  })

  it('clamps garbage — merged or foreign saves can carry anything', () => {
    expect(chaptersCompleted(Number.POSITIVE_INFINITY)).toBe(0)
    expect(chaptersCompleted(Number.NaN)).toBe(0)
    expect(chaptersCompleted(-5)).toBe(0)
    expect(chaptersCompleted(99999)).toBe(CHAPTER_COUNT)
  })
})

describe('claimChapter — pays exactly once, and only what was earned', () => {
  it('banks trophy + purse + latch in ONE persisted write', () => {
    seed({ unlocked: 11, chips: 10 })
    const grant = claimChapter(1)
    expect(grant).not.toBeNull()
    expect(grant?.trophy.label).toBe('PARTY PIÑATA')
    expect(grant?.purse).toBe(100)
    expect(grant?.boost).toBeNull()
    expect(grant?.balance).toBe(110)
    // Reload from storage: the latch, the chips and the (absent) boost all landed atomically.
    const after = loadSave()
    expect(after.chips).toBe(110)
    expect(after.chapterRewards).toEqual([1])
    expect(after.pendingBoosts).toEqual([])
  })

  it('a milestone chapter banks exactly one boost into pendingBoosts', () => {
    seed({ unlocked: 51 })
    const grant = claimChapter(5)
    expect(grant?.boost).toBe('extraMoves')
    expect(loadSave().pendingBoosts).toEqual(['extraMoves'])
  })

  it('returns null and leaves the save untouched on a double claim', () => {
    seed({ unlocked: 11 })
    expect(claimChapter(1)).not.toBeNull()
    const snapshot = loadSave()
    expect(claimChapter(1)).toBeNull()
    expect(loadSave()).toEqual(snapshot)
  })

  it('refuses a chapter the save has not actually completed — no state can mint an unearned trophy', () => {
    seed({ unlocked: 10 }) // level 10 not yet cleared
    expect(claimChapter(1)).toBeNull()
    seed({ unlocked: 45 })
    expect(claimChapter(5)).toBeNull() // chapter 5 needs unlocked > 50
    expect(loadSave().chapterRewards).toEqual([])
  })

  it('refuses off-map chapters outright', () => {
    seed({ unlocked: 9999 })
    expect(claimChapter(0)).toBeNull()
    expect(claimChapter(31)).toBeNull()
    expect(claimChapter(2.5)).toBeNull()
  })
})

describe('claimChapterCatchUp — the back-fill sweep and the recovery net', () => {
  it('is null for a fresh save and for anyone fully claimed', () => {
    seed({})
    expect(claimChapterCatchUp()).toBeNull()
    seed({ unlocked: 21, chapterRewards: [1, 2] })
    expect(claimChapterCatchUp()).toBeNull()
  })

  it('grants every completed-but-unclaimed chapter in ONE persisted write', () => {
    seed({ unlocked: 45, chips: 0 })
    const result = claimChapterCatchUp()
    expect(result?.grants.map(g => g.chapter)).toEqual([1, 2, 3, 4])
    expect(result?.totalPurse).toBe(400)
    expect(result?.balance).toBe(400)
    const after = loadSave()
    expect(after.chapterRewards).toEqual([1, 2, 3, 4])
    expect(after.chips).toBe(400)
    expect(claimChapterCatchUp()).toBeNull() // and never again
  })

  it('respects partial claims — only the gaps are paid', () => {
    seed({ unlocked: 45, chapterRewards: [1, 3], chips: 0 })
    const result = claimChapterCatchUp()
    expect(result?.grants.map(g => g.chapter)).toEqual([2, 4])
    expect(loadSave().chips).toBe(200)
    expect(loadSave().chapterRewards.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('a finished player back-fills the whole ladder: 30 trophies, the full 8,200, six boosts', () => {
    seed({ unlocked: LEVEL_COUNT + 1, chips: 0 })
    const result = claimChapterCatchUp()
    expect(result?.grants).toHaveLength(CHAPTER_COUNT)
    expect(result?.totalPurse).toBe(CHAPTER_PURSE_TOTAL)
    expect(loadSave().pendingBoosts).toHaveLength(Object.keys(CHAPTER_BOOSTS).length)
  })
})

describe('coercion + merge — trophies survive old saves and second devices', () => {
  it('an old save without the field coerces to an empty list, junk entries are dropped', () => {
    expect(coerceSave({}).chapterRewards).toEqual([])
    expect(
      coerceSave({ chapterRewards: [2, 2, -1, 0, 1.5, 'x', 7] as unknown as number[] }).chapterRewards
    ).toEqual([2, 7])
  })

  it('unclaimedChapters is exactly the completed-minus-claimed gap, ascending', () => {
    const save = coerceSave({ unlocked: 61, chapterRewards: [2, 5] })
    expect(unclaimedChapters(save)).toEqual([1, 3, 4, 6])
  })

  it('two devices that each claimed different chapters merge into one full showroom', () => {
    const phone = coerceSave({ unlocked: 45, chips: 500, chapterRewards: [1, 2, 3, 4] })
    const tablet = coerceSave({ unlocked: 45, chips: 500, chapterRewards: [1, 2] })
    const merged = mergeSaves(phone, tablet)
    expect(merged.chapterRewards).toEqual([1, 2, 3, 4])
    expect(unclaimedChapters(merged)).toEqual([])
  })

  it('trophyFor maps chapters to the catalogue and null off it', () => {
    expect(trophyFor(1)?.emoji).toBe('🪅')
    expect(trophyFor(30)?.label).toBe('THE CAR')
    expect(trophyFor(31)).toBeNull()
    expect(trophyFor(0)).toBeNull()
  })
})

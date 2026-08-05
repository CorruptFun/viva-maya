import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHAPTER_BOOSTS,
  CHAPTER_PURSES,
  CHAPTER_PURSE_TOTAL,
  GRAND_PRIZE_CHAPTERS,
  TROPHIES,
  TROPHY_TIERS,
  TROPHY_WINGS,
  WING_CHAPTERS,
  chaptersCompleted,
  claimChapter,
  claimChapterCatchUp,
  trophyFor,
  trophyTier,
  unclaimedChapters,
  wingForChapter,
} from './trophies'
import { CHAPTER_COUNT, CHAPTER_LEVELS, LEVEL_COUNT } from './levels'
import { BOOST_META } from './inventory'
import { CHARMS } from './charms'
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

  it('chapter 30 is the car — Act I\'s grand prize, and it stays chapter 30 as the ladder grows', () => {
    // Keyed to the CHAPTER, never to "the last one in the array". The car is the prize for finishing
    // the MAIN FLOOR; an index-from-the-end test would have quietly handed the title to whatever
    // chapter happened to close the newest act.
    expect(trophyFor(30)?.emoji).toBe('🏎️')
    expect(trophyFor(30)?.label).toBe('THE CAR')
  })

  it('every act closes on a crown, and the floor closes carry the Act II ones', () => {
    // Act II's shape: five chapters per floor, the fifth is the floor's crest/door.
    expect(trophyFor(35)?.label).toBe('THE CLUB CREST')
    expect(trophyFor(40)?.label).toBe('THE HIDDEN DOOR')
  })

  it('a wing knows its own chapters and its own podium piece', () => {
    // Every chapter in the catalogue lands in exactly one wing, and the wings tile without a gap.
    for (let c = 1; c <= CHAPTER_COUNT; c++) {
      const w = wingForChapter(c)
      expect({ c, inside: c >= w.chapterFrom && c <= w.chapterTo }).toEqual({ c, inside: true })
    }
    expect(TROPHY_WINGS.map(w => w.chapterFrom)).toEqual([1, WING_CHAPTERS + 1])
    // Six rows of five, forever — this is what keeps the showroom card at its pinned 1156 height
    // however many acts open above it.
    for (const w of TROPHY_WINGS) expect(w.chapterTo - w.chapterFrom + 1).toBe(WING_CHAPTERS)
    // A podium piece INSIDE the shipped catalogue must be the same object the shelf shows; one
    // beyond it is the tease (Act II's deed at chapter 60), and must NOT be claimable yet.
    for (const w of TROPHY_WINGS) {
      const shelf = trophyFor(w.hero.chapter)
      if (shelf) expect({ e: w.hero.emoji, l: w.hero.label }).toEqual({ e: shelf.emoji, l: shelf.label })
      else expect(w.hero.chapter).toBeGreaterThan(CHAPTER_COUNT)
    }
  })

  it('pins the purse ladder exactly — retune the economy there, not here', () => {
    expect(CHAPTER_PURSES).toEqual([
      100, 100, 100, 100, 150,
      150, 150, 150, 150, 250,
      200, 200, 200, 200, 300,
      250, 250, 250, 250, 400,
      300, 300, 300, 300, 500,
      400, 400, 400, 400, 1000,
      // Act II — flat with crowns on the floor closes. See the design note in trophies.ts.
      250, 250, 250, 250, 400,
      250, 250, 250, 250, 400,
    ])
    expect(CHAPTER_PURSE_TOTAL).toBe(11000)
    // The act's own contribution, stated separately so a future act can be added without anyone
    // having to subtract two totals in their head to see what it cost.
    expect(CHAPTER_PURSES.slice(30).reduce((s, n) => s + n, 0)).toBe(2800)
  })

  it('the ladder never steps DOWN across a band boundary WITHIN an act', () => {
    // Milestones spike (150→150 ok, 250→200 is the deliberate post-milestone reset), but the BASE
    // rate per band must be non-decreasing so later chapters never feel worth less than earlier ones.
    //
    // ACT-LOCAL on purpose. Act II starts at 250 — BELOW Act I's closing 400 base — because the chip
    // faucet is a lifetime budget and the act's real currency arrives later (the reasoning is
    // written out in full in trophies.ts). A step down between acts is the design; a step down
    // inside one is the bug this test has always been about.
    const bands = [
      [0, 5, 10, 15, 20, 25], // Act I
      [30, 35], // Act II
    ]
    for (const act of bands) {
      const base = act.map(i => CHAPTER_PURSES[i])
      for (let i = 1; i < base.length; i++) expect(base[i]).toBeGreaterThanOrEqual(base[i - 1])
    }
    // And every chapter still pays SOMETHING — a silent 0 would read as a bug to the one player it
    // happened to, which is exactly how a short catalogue would present itself.
    expect(CHAPTER_PURSES).toHaveLength(CHAPTER_COUNT)
    for (const p of CHAPTER_PURSES) expect(p).toBeGreaterThan(0)
  })

  it('milestone boosts land only on every 5th chapter and name real BOOST_META types', () => {
    for (const [chapter, type] of Object.entries(CHAPTER_BOOSTS)) {
      expect(Number(chapter) % 5).toBe(0)
      expect(type && BOOST_META[type]).toBeTruthy()
    }
  })

  it('tier ladder: no badge below 5 chapters, then bronze→silver→gold→case→car→high-roller', () => {
    expect(trophyTier(0)).toBeNull()
    expect(trophyTier(4)).toBeNull()
    expect(trophyTier(5)?.emoji).toBe('🥉')
    expect(trophyTier(9)?.emoji).toBe('🥉')
    expect(trophyTier(10)?.emoji).toBe('🥈')
    expect(trophyTier(15)?.emoji).toBe('🥇')
    expect(trophyTier(20)?.emoji).toBe('🏆')
    expect(trophyTier(29)?.emoji).toBe('🏆')
    expect(trophyTier(30)?.emoji).toBe('🏎️')
    expect(trophyTier(39)?.emoji).toBe('🏎️')
    expect(trophyTier(40)?.emoji).toBe('🎖️')
    expect(trophyTier(Number.NaN)).toBeNull()
    // Descending order is load-bearing — `trophyTier` returns the FIRST match.
    for (let i = 1; i < TROPHY_TIERS.length; i++) {
      expect(TROPHY_TIERS[i].min).toBeLessThan(TROPHY_TIERS[i - 1].min)
    }
  })

  it('a tier glyph may equal a GRAND PRIZE trophy, never an ordinary shelf one', () => {
    // The car precedent, codified. 🏎️ is deliberately both a shelf trophy and a rung: wearing it
    // next to your name means you OWN the thing on the podium, which is the whole idea. What must
    // never happen is a rung colliding with an ordinary chapter prize, where the badge would claim
    // a milestone the trophy does not mark. `GRAND_PRIZE_CHAPTERS` is the exemption list, derived
    // from the showroom wings' podium pieces rather than hand-maintained here.
    const grand = new Set(GRAND_PRIZE_CHAPTERS)
    const shelf = new Set(TROPHIES.filter(t => !grand.has(t.chapter)).map(t => t.emoji))
    for (const tier of TROPHY_TIERS) {
      expect({ tier: tier.label, collides: shelf.has(tier.emoji) }).toEqual({ tier: tier.label, collides: false })
    }
    // And the rungs are distinct from each other.
    expect(new Set(TROPHY_TIERS.map(t => t.emoji)).size).toBe(TROPHY_TIERS.length)
  })

  it('no trophy glyph collides with a charm, a boost icon or the champion crown', () => {
    // The showroom, the charm album and the stash all draw system emoji at ~50px, often on the same
    // screen. Two surfaces wearing the same glyph for different things is the cheapest possible
    // way to make a reward look like a bug — and it is invisible in review, so it is a test.
    const elsewhere = new Set<string>([...CHARMS.map(c => c.emoji), ...Object.values(BOOST_META).map(b => b.icon), '👑'])
    for (const t of TROPHIES) {
      expect({ chapter: t.chapter, clash: elsewhere.has(t.emoji) }).toEqual({ chapter: t.chapter, clash: false })
    }
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
    expect(claimChapter(CHAPTER_COUNT + 1)).toBeNull()
    expect(claimChapter(2.5)).toBeNull()
    // The one that matters when an act opens: the FIRST chapter past the end. A save from a newer
    // build (or a merge from a device on one) carries an `unlocked` that says this chapter is done,
    // so the bound is the only thing standing between it and a ceremony with no trophy in it.
    expect(claimChapter(CHAPTER_COUNT + 1)).toBeNull()
    expect(loadSave().chapterRewards).toEqual([])
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

  it('a finished player back-fills the whole ladder: every trophy, the full purse, every boost', () => {
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
    expect(trophyFor(CHAPTER_COUNT)?.label).toBe('THE HIDDEN DOOR')
    expect(trophyFor(CHAPTER_COUNT + 1)).toBeNull()
    expect(trophyFor(0)).toBeNull()
  })
})

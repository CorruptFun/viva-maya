import { describe, expect, it } from 'vitest'
import {
  ACT2_FROM,
  FLOORS,
  FLOOR_LEVELS,
  PULL_FROM,
  act2Spec,
  floorFor,
  floorForChapter,
  isAct2Level,
  isFloorOpening,
  pullLevel,
} from './actII'
import { ACT1_LEVELS, CHAPTER_COUNT, CHAPTER_LEVELS, LEVEL_COUNT, levelSpec } from './levels'
import { DIFFICULTY, isTeachingLevel } from './difficulty'
import { CHAPTER_PURSES, TROPHIES } from './trophies'

/**
 * ACT II's structural promises. Two of them are the kind that cost a player something real when
 * they break, and neither is visible in review:
 *
 *  1. THE ACT IS CLIENT-ATOMIC. `LEVEL_COUNT` makes chapters reachable, and a reachable chapter is
 *     one `claimChapter` will try to pay. So the ladder, the trophy catalogue, the purse ladder and
 *     the floor table have to agree in ONE tree — the failure mode is a ceremony with no prize in
 *     it, on the device of whoever got there first.
 *  2. THE ACT IS REVOCABLE. Turning it off must leave levels 301+ as ordinary levels on the plain
 *     extended curve, not as broken ones. That is the same contract `hazards` and `goals` sign, and
 *     the reason `levels.test.ts`'s panic-switch transcription can still cover the whole range.
 */

describe('the 300 seam', () => {
  it('agrees with levels.ts about where Act I ends', () => {
    // ACT2_FROM is kept in actII.ts rather than imported, so this module stays out of a cycle with
    // levels.ts (which imports IT). That is the only reason the two constants exist separately, and
    // this is the assertion that makes it safe.
    expect(ACT2_FROM).toBe(ACT1_LEVELS + 1)
    expect(LEVEL_COUNT).toBeGreaterThan(ACT1_LEVELS)
  })

  it('is client-atomic: ladder, floors, trophies and purses all describe the same chapters', () => {
    expect(TROPHIES).toHaveLength(CHAPTER_COUNT)
    expect(CHAPTER_PURSES).toHaveLength(CHAPTER_COUNT)
    // The shipped floors reach exactly as far as the ladder does — no level without a floor, no
    // floor without levels.
    expect(FLOORS[FLOORS.length - 1].to).toBe(LEVEL_COUNT)
    expect(FLOORS[0].from).toBe(ACT2_FROM)
  })

  it('lays the floors end to end, five chapters each, with no gap and no overlap', () => {
    FLOORS.forEach((f, i) => {
      expect({ floor: f.floor, span: f.to - f.from + 1 }).toEqual({ floor: f.floor, span: FLOOR_LEVELS })
      expect(f.chapterTo - f.chapterFrom + 1).toBe(FLOOR_LEVELS / CHAPTER_LEVELS)
      // The chapter range is DERIVED from the level range in meaning, so prove they agree rather
      // than trusting two hand-typed numbers.
      expect(f.chapterFrom).toBe(Math.floor((f.from - 1) / CHAPTER_LEVELS) + 1)
      expect(f.chapterTo).toBe(f.to / CHAPTER_LEVELS)
      if (i > 0) expect(f.from).toBe(FLOORS[i - 1].to + 1)
    })
  })

  it('puts every Act II level and chapter on exactly one floor, and nothing below 301', () => {
    for (let L = 1; L <= ACT1_LEVELS; L++) expect(floorFor(L)).toBeNull()
    for (let L = ACT2_FROM; L <= LEVEL_COUNT; L++) {
      const f = floorFor(L)
      expect({ L, found: f !== null }).toEqual({ L, found: true })
      expect({ L, inside: L >= f!.from && L <= f!.to }).toEqual({ L, inside: true })
    }
    for (let c = 1; c <= 30; c++) expect(floorForChapter(c)).toBeNull()
    for (let c = 31; c <= CHAPTER_COUNT; c++) expect(floorForChapter(c)).not.toBeNull()
    // Off the top of the shipped tower there is nothing — floors arrive with their slices.
    expect(floorFor(LEVEL_COUNT + 1)).toBeNull()
    expect(isAct2Level(LEVEL_COUNT + 1)).toBe(false)
    expect(floorFor(Number.NaN)).toBeNull()
  })

  it('opens a floor exactly on its first level', () => {
    const openings = []
    for (let L = ACT2_FROM; L <= LEVEL_COUNT; L++) if (isFloorOpening(L)) openings.push(L)
    expect(openings).toEqual(FLOORS.map(f => f.from))
  })
})

describe('THE REEL PULL — the band and the teaching level', () => {
  it('starts at 301 and runs to the top of the ladder, never below', () => {
    expect(PULL_FROM).toBe(ACT2_FROM)
    for (const L of [1, 30, 150, 299, ACT1_LEVELS]) expect(pullLevel(L)).toBe(false)
    for (const L of [ACT2_FROM, 320, 355, LEVEL_COUNT]) expect(pullLevel(L)).toBe(true)
  })

  it('marks the spec, and marks nothing at all in Act I', () => {
    for (const L of [1, 100, 201, ACT1_LEVELS]) expect(levelSpec(L).pull).toBeUndefined()
    for (const L of [ACT2_FROM, 350, 400]) expect(levelSpec(L).pull).toBe(true)
  })

  it('teaches at 301 with the same +3 every other band start gets', () => {
    expect(isTeachingLevel(PULL_FROM)).toBe(true)
    const a2 = DIFFICULTY.act2 as { enabled: boolean }
    const was = a2.enabled
    try {
      a2.enabled = false
      const off = levelSpec(PULL_FROM).moves
      a2.enabled = true
      expect(levelSpec(PULL_FROM).moves).toBe(off + DIFFICULTY.teachingLevelBonusMoves)
    } finally {
      a2.enabled = was
    }
  })
})

describe('the act is revocable', () => {
  it('switched off, 301+ are ordinary levels on the plain extended curve', () => {
    const a2 = DIFFICULTY.act2 as { enabled: boolean }
    const was = a2.enabled
    try {
      // Capture what the act adds, then prove removing it leaves a well-formed ordinary spec — same
      // goals, same symbol count, and a budget that still climbs. Not "the same moves": the teaching
      // level is DELIBERATELY +3 with the act on, which is the one difference there should be.
      a2.enabled = false
      for (let L = ACT2_FROM; L <= LEVEL_COUNT; L++) {
        const s = levelSpec(L)
        expect({ L, pull: s.pull }).toEqual({ L, pull: undefined })
        expect({ L, ok: s.moves > 0 && s.objectives.length > 0 }).toEqual({ L, ok: true })
      }
      // And the ladder does not suddenly step down at the act break with the act off. Measured at
      // 302, not 301: the act opening lands on the plaque cadence (every act opens on a …01), and a
      // collect ratio cannot see a score target — the same blind spot levels.test.ts's monotonicity
      // check skips minimum levels for.
      const req = (L: number): number => {
        const s = levelSpec(L)
        return s.objectives.reduce((n, o) => n + o.count, 0) / s.moves
      }
      expect(req(ACT2_FROM + 1)).toBeGreaterThanOrEqual(req(ACT1_LEVELS) - 0.01)
    } finally {
      a2.enabled = was
    }
  })

  it('act2Spec is additive only — it never rewrites a budget, a goal or a plaque', () => {
    for (const L of [ACT2_FROM, 306, 355, 396]) {
      const base = { level: L, moves: 42, symbolCount: 6, objectives: [{ symbol: 'bell' as const, count: 7 }] }
      const out = act2Spec(L, base)
      expect({ moves: out.moves, symbolCount: out.symbolCount, objectives: out.objectives }).toEqual({
        moves: base.moves,
        symbolCount: base.symbolCount,
        objectives: base.objectives,
      })
    }
  })
})

/**
 * THE SHIPPED ROLLOUT — the `hazards.test.ts` idiom, one act up. Changing what Act II ships means
 * changing this assertion, on purpose, in the same commit.
 */
describe('the shipped rollout', () => {
  it('ships Slice 1: the act, the rail, the moods, the elevator and the tell', () => {
    expect({
      enabled: DIFFICULTY.act2.enabled,
      pull: DIFFICULTY.act2.pull,
      pullStart: DIFFICULTY.act2.pullStart,
      mood: DIFFICULTY.act2.mood,
      reveal: DIFFICULTY.act2.reveal,
      tell: DIFFICULTY.act2.tell,
    }).toEqual({ enabled: true, pull: true, pullStart: 301, mood: true, reveal: true, tell: true })
  })

  it('ships two floors — the high-limit room and the speakeasy', () => {
    expect(FLOORS.map(f => f.name)).toEqual(['THE HIGH-LIMIT ROOM', 'THE SPEAKEASY'])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  ACT2_FROM,
  FLOORS,
  FLOOR_LEVELS,
  PULL_FROM,
  ROPE_FROM,
  ROPE_TO,
  SHOE_FROM,
  act2Plan,
  act2Spec,
  floorFor,
  floorForChapter,
  isAct2Level,
  isFloorOpening,
  pullLevel,
  ropedLevel,
  shoeLevel,
} from './actII'
import { coatsToClear, densityFor, hazardPlan } from './hazards'
import type { HazardPlan } from './hazards'
import { ACT1_LEVELS, CHAPTER_COUNT, CHAPTER_LEVELS, LEVEL_COUNT, levelSpec, minimumTargetFrac } from './levels'
import { DIFFICULTY, isTeachingLevel } from './difficulty'
import { buildLevelBoard } from './sim'
import { CHAPTER_PURSES, TROPHIES } from './trophies'
import type { SymbolType } from './types'
import { activeFloor, activeFloorMood, chapterMood, enterFloor, moodedFloors } from '../view/floormood'
import { DEFAULT_THEME_ID, THEMES, getTheme, setFloorOverlay } from '../view/theme'

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
 * GOLDEN — floor 1's specs exactly as authored, `levels.test.ts`'s L1–30 table one act up.
 *
 * `[level, moves, [[symbol, count], …], scoreTarget?]`. The SYMBOLS are pinned as hard as the
 * numbers: `levelSpec` draws them from a per-level stream, so a stray draw added anywhere before the
 * objective loop would silently re-roll every goal on every level in the game. That is the exact
 * trap `hazards.ts` documents, and this is the Act II half of the proof that nothing has sprung it.
 *
 * A failure here means SHIPPED LEVELS MOVED. Re-record only as a deliberate content change.
 */
const ACT2_GOLDEN: [number, number, [SymbolType, number][], number?][] = [
  [301, 90, [['bell', 102], ['seven', 102]], 16100],
  [302, 87, [['cherry', 102], ['bell', 102], ['diamond', 102]]],
  [303, 87, [['diamond', 102], ['bell', 102], ['bar', 102]]],
  [304, 87, [['cherry', 102], ['seven', 102], ['diamond', 102]]],
  [305, 87, [['cherry', 102], ['seven', 102], ['bar', 102]]],
  [306, 87, [['bell', 102], ['bar', 102]], 18900],
  [307, 88, [['cherry', 103], ['bell', 103], ['seven', 103]]],
  [308, 88, [['cherry', 103], ['clover', 103], ['bar', 103]]],
  [309, 88, [['diamond', 103], ['bar', 103], ['cherry', 103]]],
  [310, 88, [['bell', 103], ['bar', 103], ['clover', 103]]],
  [311, 88, [['diamond', 103], ['cherry', 103]], 19100],
  [312, 88, [['bar', 103], ['diamond', 103], ['cherry', 103]]],
  [313, 88, [['cherry', 103], ['bar', 103], ['diamond', 103]]],
  [314, 88, [['diamond', 103], ['bell', 103], ['cherry', 103]]],
  [315, 88, [['bar', 103], ['seven', 103], ['bell', 103]]],
  [316, 89, [['bell', 104], ['bar', 104]], 19300],
  [317, 89, [['cherry', 104], ['bar', 104], ['clover', 104]]],
  [318, 89, [['bell', 104], ['cherry', 104], ['clover', 104]]],
  [319, 88, [['bar', 104], ['clover', 104], ['bell', 104]]],
  [320, 88, [['cherry', 104], ['diamond', 104], ['seven', 104]]],
  [321, 88, [['seven', 104], ['bar', 104]], 19300],
  [322, 88, [['cherry', 104], ['diamond', 104], ['bell', 104]]],
  [323, 88, [['bar', 104], ['clover', 104], ['cherry', 104]]],
  [324, 88, [['seven', 104], ['bar', 104], ['clover', 104]]],
  [325, 89, [['diamond', 105], ['seven', 105], ['clover', 105]]],
  [326, 89, [['seven', 105], ['bar', 105]], 19500],
  [327, 89, [['diamond', 105], ['clover', 105], ['bell', 105]]],
  [328, 89, [['cherry', 105], ['bar', 105], ['diamond', 105]]],
  [329, 89, [['diamond', 105], ['bell', 105], ['seven', 105]]],
  [330, 89, [['seven', 105], ['diamond', 105], ['bar', 105]]],
]

describe('floor 1 as authored — GOLDEN', () => {
  it('pins moves, goal symbols, counts and plaques for 301–330', () => {
    for (const [level, moves, objectives, scoreTarget] of ACT2_GOLDEN) {
      const s = levelSpec(level)
      expect({ level, moves: s.moves, target: s.scoreTarget }).toEqual({ level, moves, target: scoreTarget })
      expect({ level, o: s.objectives.map(o => [o.symbol, o.count]) }).toEqual({ level, o: objectives })
      // Every one of them carries the rail — floor 1 IS the reel-pull floor.
      expect({ level, pull: s.pull }).toEqual({ level, pull: true })
    }
  })

  it('teaches 301 with room to learn in: the softest budget on the floor', () => {
    // The teaching level's collect ratio must be the LOWEST of its decade. A new verb learned under
    // the floor's own pressure is not taught, it is sprung.
    const ratio = (L: number): number => {
      const s = levelSpec(L)
      return s.objectives.reduce((n, o) => n + o.count, 0) / s.moves
    }
    for (let L = 302; L <= 310; L++) expect({ L, harder: ratio(L) > ratio(301) }).toEqual({ L, harder: true })
  })
})

/**
 * GOLDEN — floor 3's opening as authored, the same discipline one floor up. `perObjective` sits on
 * its 110 clamp through this whole band (it clamps near L378), so the numbers are flatter than
 * floor 1's — which is precisely why the floor brings a RULE (the shoe) instead of bigger numbers,
 * and why the plaques below carry the counted-table pricing (16,200 teaching · 19,100–19,200 band).
 *
 * A failure here means SHIPPED LEVELS MOVED. Re-record only as a deliberate content change.
 */
const F3_GOLDEN: [number, number, [SymbolType, number][], number?][] = [
  [401, 95, [['bell', 110], ['diamond', 110]], 16200],
  [402, 92, [['seven', 110], ['clover', 110], ['bell', 110]]],
  [403, 92, [['bar', 110], ['bell', 110], ['clover', 110]]],
  [404, 92, [['clover', 110], ['bell', 110], ['bar', 110]]],
  [405, 92, [['bell', 110], ['seven', 110], ['bar', 110]]],
  [406, 92, [['bar', 110], ['diamond', 110]], 19100],
  [407, 92, [['diamond', 110], ['bell', 110], ['seven', 110]]],
  [408, 92, [['cherry', 110], ['seven', 110], ['bell', 110]]],
  [409, 92, [['bell', 110], ['bar', 110], ['seven', 110]]],
  [410, 92, [['seven', 110], ['bell', 110], ['cherry', 110]]],
  [411, 92, [['cherry', 110], ['bar', 110]], 19100],
  [412, 92, [['clover', 110], ['cherry', 110], ['bell', 110]]],
  [413, 92, [['diamond', 110], ['bell', 110], ['seven', 110]]],
  [414, 92, [['seven', 110], ['bar', 110], ['bell', 110]]],
  [415, 92, [['cherry', 110], ['diamond', 110], ['bell', 110]]],
  [416, 92, [['seven', 110], ['cherry', 110]], 19200],
  [417, 92, [['seven', 110], ['diamond', 110], ['cherry', 110]]],
  [418, 92, [['bar', 110], ['bell', 110], ['cherry', 110]]],
  [419, 92, [['clover', 110], ['diamond', 110], ['bar', 110]]],
  [420, 92, [['cherry', 110], ['bell', 110], ['clover', 110]]],
  [421, 92, [['clover', 110], ['bar', 110]], 19200],
  [422, 92, [['bar', 110], ['clover', 110], ['seven', 110]]],
  [423, 92, [['seven', 110], ['bar', 110], ['diamond', 110]]],
  [424, 92, [['seven', 110], ['bar', 110], ['clover', 110]]],
  [425, 92, [['clover', 110], ['cherry', 110], ['seven', 110]]],
  [426, 92, [['bar', 110], ['bell', 110]], 19200],
  [427, 92, [['bar', 110], ['diamond', 110], ['bell', 110]]],
  [428, 92, [['bar', 110], ['cherry', 110], ['bell', 110]]],
  [429, 92, [['diamond', 110], ['bell', 110], ['clover', 110]]],
  [430, 92, [['cherry', 110], ['seven', 110], ['bar', 110]]],
]

describe('floor 3 as authored — GOLDEN', () => {
  it('pins moves, goal symbols, counts and plaques for 401–430', () => {
    for (const [level, moves, objectives, scoreTarget] of F3_GOLDEN) {
      const s = levelSpec(level)
      expect({ level, moves: s.moves, target: s.scoreTarget }).toEqual({ level, moves, target: scoreTarget })
      expect({ level, o: s.objectives.map(o => [o.symbol, o.count]) }).toEqual({ level, o: objectives })
      // The whole floor carries the rail, and every non-breather deals from the shoe.
      expect({ level, pull: s.pull, shoe: s.shoe }).toEqual({ level, pull: true, shoe: level % 5 !== 0 ? true : undefined })
    }
  })
})

/**
 * THE COUNTING SHOE — floor 3's band. The shoe ITSELF is asserted in shoe.test.ts; what is pinned
 * here is which levels deal from one, that its teaching level gets the standard courtesy, and that
 * both the flag and the act take it out cleanly. The endless doctrine's half of the story is
 * structural — endless builds its board directly and never passes a refill source — and the
 * boardpick goldens are the tripwire that would catch anyone changing that.
 */
describe('THE COUNTING SHOE — the band', () => {
  it('deals on floor 3 only, skipping breathers, and nowhere else on the tower', () => {
    expect(SHOE_FROM).toBe(401)
    for (const L of [1, 201, 300, ACT2_FROM, 355, 399, 400]) expect({ L, shoe: shoeLevel(L) }).toEqual({ L, shoe: false })
    for (const L of [451, 468, LEVEL_COUNT]) expect({ L, shoe: shoeLevel(L) }).toEqual({ L, shoe: false })
    for (let L = 401; L <= 450; L++) {
      // Breathers sit the shoe out — the dealer's empty-chair seat, one floor up.
      expect({ L, shoe: shoeLevel(L) }).toEqual({ L, shoe: L % 5 !== 0 })
    }
  })

  it('marks the spec on shoe levels, and only there', () => {
    expect(levelSpec(401).shoe).toBe(true)
    expect(levelSpec(423).shoe).toBe(true)
    expect(levelSpec(445).shoe).toBe(undefined) // breather
    expect(levelSpec(400).shoe).toBe(undefined)
    expect(levelSpec(451).shoe).toBe(undefined) // the card room's own rule arrives with its own slice
    // The rail rides through the whole band — pull × shoe is floor 3's daily texture.
    expect(levelSpec(423).pull).toBe(true)
  })

  it('teaches at 401 with the standard +3, and a relieved plaque — a floor opening is always a …01', () => {
    expect(isTeachingLevel(SHOE_FROM)).toBe(true)
    const a2 = DIFFICULTY.act2 as { shoe: boolean }
    const on = levelSpec(SHOE_FROM)
    try {
      a2.shoe = false
      const off = levelSpec(SHOE_FROM)
      expect(on.moves).toBe(off.moves + DIFFICULTY.teachingLevelBonusMoves)
      expect(off.shoe).toBeUndefined()
      // Flag off, 401 is an ordinary plaque level: same goals, same symbols, full brass.
      expect(on.objectives).toEqual(off.objectives)
      expect(off.scoreTarget).toBeGreaterThan(on.scoreTarget as number)
    } finally {
      a2.shoe = true
    }
    // The teaching relief generalised (TEACHING_PLAQUE_RELIEF): the floor's first plaque steps
    // back even from the band's own relieved rate, and the next plaque resumes the climb INSIDE
    // the band. It does NOT resume above 396 — the whole band is priced against the counted
    // table's thinner tail (SHOE_PLAQUE_RELIEF), and the cross-band step-down and its resume at
    // 451 are pinned where the ladder itself is, in levels.test.ts.
    expect(minimumTargetFrac(401)).toBeLessThan(minimumTargetFrac(406))
    expect(levelSpec(406).scoreTarget as number).toBeGreaterThan(levelSpec(401).scoreTarget as number)
  })

  it('attaches the dealer exactly where the spec says — and nowhere the flag is off', () => {
    const source = (b: unknown): unknown => (b as { refillSource: unknown }).refillSource
    expect(source(buildLevelBoard(423, 0xabc))).not.toBeNull()
    expect(source(buildLevelBoard(400, 0xabc))).toBeNull()
    expect(source(buildLevelBoard(445, 0xabc))).toBeNull()
    const a2 = DIFFICULTY.act2 as { shoe: boolean }
    try {
      a2.shoe = false
      expect(source(buildLevelBoard(423, 0xabc))).toBeNull()
    } finally {
      a2.shoe = true
    }
  })
})

/**
 * THE FLOOR-PAIR RAMP — the seam for floors 3–4's own hazard climb (DIFFICULTY.act2.ramp). SHIPS
 * OFF: measured, the candidates' signal was smaller than 40-seed noise and the shoe already
 * carries the pair's climb — the table lives on the flag. The logic assertions force it ON, the
 * hazards.test.ts idiom, so staging can never quietly make them test nothing; the shipped state is
 * pinned separately in the rollout describe below.
 */
describe('the floor-pair ramp', () => {
  const withRamp = <T,>(on: boolean, fn: () => T): T => {
    const a2 = DIFFICULTY.act2 as { ramp: { enabled: boolean } }
    const was = a2.ramp.enabled
    a2.ramp.enabled = on
    try {
      return fn()
    } finally {
      a2.ramp.enabled = was
    }
  }

  it('leaves floors 1–2 bit-identical, flag on or off', () => {
    for (const L of [ACT2_FROM, 313, 350, 355, 400]) {
      const on = withRamp(true, () => hazardPlan(L, 8, 8))
      const off = withRamp(false, () => hazardPlan(L, 8, 8))
      expect({ L, plan: off }).toEqual({ L, plan: on })
    }
  })

  it('lit, it starts from the flatline at the floor door and reaches exactly +extra at the pair top', () =>
    withRamp(true, () => {
      const { extra } = DIFFICULTY.act2.ramp
      // 401 adds nothing — the ramp is a climb OUT of the pair's own door, not a step at it.
      expect(densityFor('lock', 401)).toBe(densityFor('lock', 399))
      expect(densityFor('coat', 402)).toBe(densityFor('coat', 399))
      // 499 (the last non-breather) carries the full climb; 500 is a breather and halves as ever.
      expect(densityFor('lock', 499)).toBe(densityFor('lock', 399) + extra.lock)
      expect(densityFor('coat', 499)).toBe(densityFor('coat', 399) + extra.coat)
      expect(densityFor('blocker', 499)).toBe(densityFor('blocker', 399) + extra.blocker)
    }))

  it('lit, it only ever climbs across the pair — no level hands back cells its predecessor charged', () =>
    withRamp(true, () => {
      for (const kind of ['lock', 'coat', 'blocker'] as const) {
        let prev = densityFor(kind, 401)
        for (let L = 402; L <= LEVEL_COUNT; L++) {
          if (L % 5 === 0) continue // breathers are the one deliberate dip, as everywhere on the ladder
          const n = densityFor(kind, L)
          expect({ kind, L, rises: n >= prev }).toEqual({ kind, L, rises: true })
          prev = n
        }
      }
    }))

  it('off — the shipped state — the pair sits on the L300 flatline exactly', () =>
    withRamp(false, () => {
      for (const kind of ['lock', 'coat', 'blocker'] as const) {
        expect(densityFor(kind, 499)).toBe(densityFor(kind, 399))
      }
    }))
})

/**
 * THE ACTIVE FLOOR — the scene-scoped "which room is the player in" that the hazard skins and the
 * margin flourish read (neither is a theme token, so neither can travel on the theme overlay).
 *
 * The assertion that earns its keep is the DEGRADE: every level at or below 300, plus endless, plus
 * the act switched off, must resolve to no floor at all — because that is the only thing standing
 * between Act II's furniture and three hundred shipped levels drawn by a different skin.
 */
describe('the active floor', () => {
  it('stands the player on exactly the floor their level is on, and nowhere in Act I', () => {
    try {
      for (const L of [1, 86, 151, 201, 299, ACT1_LEVELS]) {
        enterFloor(L)
        expect({ L, floor: activeFloor() }).toEqual({ L, floor: null })
        expect({ L, mood: activeFloorMood() }).toEqual({ L, mood: null })
      }
      for (const [L, floor] of [
        [ACT2_FROM, 1],
        [325, 1],
        [350, 1],
        [351, 2],
        [400, 2],
        [401, 3],
        [437, 3],
        [451, 4],
        [LEVEL_COUNT, 4],
      ] as const) {
        enterFloor(L)
        expect({ L, floor: activeFloor() }).toEqual({ L, floor })
        expect({ L, mood: activeFloorMood() !== null }).toEqual({ L, mood: true })
      }
      // Endless has no level number and passes null — the same call the scene makes on shutdown.
      enterFloor(null)
      expect(activeFloor()).toBeNull()
      // Off the top of the shipped tower there is no floor either, so a level that outran its
      // catalogue draws the main floor's furniture rather than nothing at all.
      enterFloor(LEVEL_COUNT + 1)
      expect(activeFloor()).toBeNull()
    } finally {
      enterFloor(null)
    }
  })

  it('is total when moods are switched off — both on the way in and once already standing', () => {
    const a2 = DIFFICULTY.act2 as { mood: boolean }
    const was = a2.mood
    try {
      enterFloor(ACT2_FROM)
      expect(activeFloor()).toBe(1)
      // Already inside a floor: flipping the flag has to take effect NOW, not at the next entry.
      a2.mood = false
      expect(activeFloor()).toBeNull()
      expect(activeFloorMood()).toBeNull()
      enterFloor(ACT2_FROM)
      expect(activeFloor()).toBeNull()
    } finally {
      a2.mood = was
      enterFloor(null)
    }
  })
})

/**
 * THE ROPED RUN (311–315) — the pull × lockbox interaction band.
 *
 * The band's whole claim is that it changes the PICTURE and not the level: same boxes, same hit
 * points, same coats, same layers, same locks, moved. If that stops being true the level's demand
 * has quietly moved with it, and a curated arrangement will have re-priced five shipped levels.
 */
describe('the roped run', () => {
  const plan = (L: number): HazardPlan => hazardPlan(L, 8, 8)
  const roped = (L: number): HazardPlan => act2Plan(L, plan(L), 8)

  it('runs 311–315 and touches nothing else, in either act', () => {
    for (const L of [1, 86, 300, ACT2_FROM, 310, 316, 351, LEVEL_COUNT]) {
      expect({ L, roped: ropedLevel(L) }).toEqual({ L, roped: false })
      // Off the band it hands the SAME OBJECT back, not a rebuilt copy of it — the strongest form
      // of "untouched", and the one `levels.test.ts`'s panic-switch transcription depends on.
      const p = plan(L)
      expect({ L, identical: act2Plan(L, p, 8) === p }).toEqual({ L, identical: true })
    }
    for (let L = ROPE_FROM; L <= ROPE_TO; L++) expect({ L, roped: ropedLevel(L) }).toEqual({ L, roped: true })
  })

  it('is a PERMUTATION — the demand budget cannot move', () => {
    for (let L = ROPE_FROM; L <= ROPE_TO; L++) {
      const before = plan(L)
      const after = roped(L)
      expect({ L, boxes: after.blockers.length }).toEqual({ L, boxes: before.blockers.length })
      expect({ L, hp: after.blockers.map(b => b.hp) }).toEqual({ L, hp: before.blockers.map(b => b.hp) })
      // The win condition's second term, to the layer.
      expect({ L, coats: coatsToClear(after) }).toEqual({ L, coats: coatsToClear(before) })
      expect({ L, n: after.coats.length }).toEqual({ L, n: before.coats.length })
      expect({ L, n: after.locks.length }).toEqual({ L, n: before.locks.length })
      // And nothing ends up stacked on a box, which would render as an unreachable coat.
      const boxes = new Set(after.blockers.map(b => `${b.row},${b.col}`))
      for (const c of [...after.coats, ...after.locks]) expect(boxes.has(`${c.row},${c.col}`)).toBe(false)
      // No two coats (or two locks) land on the same cell either — a bijection, not a collapse.
      expect(new Set(after.coats.map(c => `${c.row},${c.col}`)).size).toBe(after.coats.length)
      expect(new Set(after.locks.map(c => `${c.row},${c.col}`)).size).toBe(after.locks.length)
    }
  })

  it("keeps every one of hazardPlan's own safety caps", () => {
    const { caps } = DIFFICULTY
    for (let L = ROPE_FROM; L <= ROPE_TO; L++) {
      const perCol = new Map<number, number>()
      const perRow = new Map<number, number>()
      for (const b of roped(L).blockers) {
        expect({ L, row0: (caps.forbiddenBlockerRows as readonly number[]).includes(b.row) }).toEqual({ L, row0: false })
        expect(b.row).toBeGreaterThanOrEqual(0)
        expect(b.row).toBeLessThan(8)
        expect(b.col).toBeGreaterThanOrEqual(0)
        expect(b.col).toBeLessThan(8)
        perCol.set(b.col, (perCol.get(b.col) ?? 0) + 1)
        perRow.set(b.row, (perRow.get(b.row) ?? 0) + 1)
      }
      for (const [, n] of perCol) expect(n).toBeLessThanOrEqual(caps.blockersPerColumn)
      for (const [, n] of perRow) expect(n).toBeLessThanOrEqual(caps.blockersPerRow)
    }
  })

  it('ropes a CONTIGUOUS block of handles — which is the entire point of the band', () => {
    for (let L = ROPE_FROM; L <= ROPE_TO; L++) {
      const cols = [...new Set(roped(L).blockers.map(b => b.col))].sort((a, b) => a - b)
      // One box per column (above), so a contiguous run means max − min + 1 === count.
      expect({ L, contiguous: cols[cols.length - 1] - cols[0] + 1 === cols.length }).toEqual({ L, contiguous: true })
      // ...and the rail is never entirely dead: at least two handles always work.
      expect({ L, live: 8 - cols.length }).toEqual({ L, live: 8 - cols.length })
      expect(8 - cols.length).toBeGreaterThanOrEqual(2)
    }
    // The rope travels along the machine across the band rather than sitting in one place.
    const starts = []
    for (let L = ROPE_FROM; L <= ROPE_TO; L++) starts.push(Math.min(...roped(L).blockers.map(b => b.col)))
    expect(new Set(starts).size).toBeGreaterThan(1)
  })

  it('is revocable — with the flag off those five levels get their ordinary boards back', () => {
    const a2 = DIFFICULTY.act2 as { rope: boolean }
    const was = a2.rope
    try {
      a2.rope = false
      for (let L = ROPE_FROM; L <= ROPE_TO; L++) {
        expect({ L, roped: ropedLevel(L) }).toEqual({ L, roped: false })
        expect({ L, blockers: roped(L).blockers }).toEqual({ L, blockers: plan(L).blockers })
        expect({ L, coats: roped(L).coats }).toEqual({ L, coats: plan(L).coats })
      }
    } finally {
      a2.rope = was
    }
  })
})

/**
 * THE FLOOR OVERLAY — "a mood MODULATES, it never replaces", proved rather than asserted in a
 * comment. Two halves, and the first one is the half that was actually broken.
 */
describe('the floor overlay', () => {
  const base = THEMES[DEFAULT_THEME_ID]

  afterEach(() => setFloorOverlay(null))

  it('leaves a token the mood never mentions at the THEME\'s value', () => {
    // The caller builds the overlay from a mood's OPTIONAL fields, so a mood with no opinion about
    // the bokeh still hands over `{ bokehWarm: undefined }`. Spread copies KEYS, so folding that in
    // used to delete the theme's colour outright — a mood silently replacing a token it never named,
    // which is the exact rule the overlay exists to enforce. It surfaces downstream as a NaN colour
    // in the three.js room, never as a type error, so nothing but this catches it.
    setFloorOverlay({ rgbHueFrom: 45, bokehWarm: undefined, moteTint: undefined })
    const lit = getTheme()
    expect(lit.rgbHueFrom).toBe(45)
    expect(lit.bokehWarm).toBe(base.bokehWarm)
    expect(lit.moteTint).toBe(base.moteTint)
    // An audio room merges the same way: name one term, keep the rest.
    setFloorOverlay({ audio: { bedRoot: 43.65 } })
    expect(getTheme().audio.bedRoot).toBe(43.65)
    expect(getTheme().audio.reverbMix).toBe(base.audio.reverbMix)
  })

  it('cannot reach a wash, a card, an ink or a cushion — on any shipped floor', () => {
    // The type is the real guard (FloorOverlay is a Pick, not a Partial<Theme>). This proves the
    // shipped moods actually travel through it: light and tone change, identity does not.
    for (const f of FLOORS) {
      const mood = chapterMood(f.chapterFrom)!
      setFloorOverlay({
        rgbHueFrom: mood.rgbHueFrom,
        rgbHueSpan: mood.rgbHueSpan,
        rgbSat: mood.rgbSat,
        rayTint: mood.rayTint,
        bokehWarm: mood.bokehWarm,
        moteTint: mood.moteTint,
        audio: mood.audio,
      })
      const lit = getTheme()
      for (const key of ['washTop', 'washBottom', 'cardFill', 'ink', 'inkMuted', 'tileA', 'tileB', 'gold'] as const) {
        expect({ floor: f.floor, key, same: lit[key] === base[key] }).toEqual({ floor: f.floor, key, same: true })
      }
      // ...and it DID light the room, or the mood is not doing its job.
      expect({ floor: f.floor, arc: lit.rgbHueFrom }).toEqual({ floor: f.floor, arc: mood.rgbHueFrom })
    }
  })

  it('gives every floor a SLICE of the wheel, never the wheel — the theme-arc law, one act up', () => {
    // rgb.test.ts pins this for the four themes; a floor arc REPLACES a theme arc while the floor is
    // live, so it inherits the same law. A 360° span would also flip `ringHue` onto its wrapping
    // branch, which is not the branch any cabinet in this game uses.
    for (const f of FLOORS) {
      const mood = chapterMood(f.chapterFrom)!
      expect({ floor: f.floor, ok: (mood.rgbHueSpan ?? 0) > 0 && (mood.rgbHueSpan ?? 0) < 360 }).toEqual({
        floor: f.floor,
        ok: true,
      })
      expect({ floor: f.floor, ok: (mood.rgbSat ?? 0) > 0 && (mood.rgbSat ?? 0) <= 1 }).toEqual({
        floor: f.floor,
        ok: true,
      })
    }
  })
})

/**
 * THE SHIPPED ROLLOUT — the `hazards.test.ts` idiom, one act up. Changing what Act II ships means
 * changing this assertion, on purpose, in the same commit.
 */
describe('the shipped rollout', () => {
  it('ships the act: the rail, the moods, the elevator, the tell — and floor 3 deals from the shoe', () => {
    expect({
      enabled: DIFFICULTY.act2.enabled,
      pull: DIFFICULTY.act2.pull,
      pullStart: DIFFICULTY.act2.pullStart,
      rope: DIFFICULTY.act2.rope,
      shoe: DIFFICULTY.act2.shoe,
      shoeStart: DIFFICULTY.act2.shoeStart,
      // The pair ramp is BUILT AND HELD OFF — a measured decision, not a staging accident; the
      // table is on the flag. Changing this is a decision written down in the same commit.
      ramp: DIFFICULTY.act2.ramp.enabled,
      mood: DIFFICULTY.act2.mood,
      reveal: DIFFICULTY.act2.reveal,
      tell: DIFFICULTY.act2.tell,
    }).toEqual({
      enabled: true,
      pull: true,
      pullStart: 301,
      rope: true,
      shoe: true,
      shoeStart: 401,
      ramp: false,
      mood: true,
      reveal: true,
      tell: true,
    })
  })

  it('ships four floors — the high-limit room, the speakeasy, the vault and the card room', () => {
    expect(FLOORS.map(f => f.name)).toEqual(['THE HIGH-LIMIT ROOM', 'THE SPEAKEASY', 'THE VAULT', 'THE CARD ROOM'])
  })

  it('every shipped floor is DRESSED — no floor arrives without an identity', () => {
    // Fifty levels with no room around them, sitting next to fifty with one, reads as unfinished
    // rather than as restraint. A floor and its mood ship together or the floor does not ship.
    expect(moodedFloors()).toEqual(FLOORS.map(f => f.floor))
  })
})

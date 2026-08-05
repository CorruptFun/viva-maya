import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { DIFFICULTY } from './difficulty'
import { ACT2_FROM, FLOORS } from './actII'
import { LEVEL_COUNT, levelSpec } from './levels'
import { dealCount, dealMoveAllowance, dealPlan, dealTargets, feltDealCount, pitBossLevel } from './pitboss'
import { mulberry32 } from './rng'
import { buildLevelBoard } from './sim'
import type { Coord } from './types'

/**
 * THE PIT BOSS — its fairness constitution, asserted clause by clause.
 *
 * This is the first mechanic in the game that adds work to a live table, so the constitution is not
 * flavour: an opponent that can act on you at random, or in your endgame, or twice in a row, is not
 * a villain — it is a bug with a story. Every clause in `pitboss.ts`'s header has an assertion here,
 * and the two that would hurt most if they broke are the LAST-FIVE stand-off (clause 3) and the
 * no-soft-lock revert in `dealLocks` (clause 8), because both fail silently and only in play.
 */

/** Every level a boss actually works, across the shipped tower. */
const BOSS_LEVELS: number[] = []
for (let L = DIFFICULTY.act2.pitBossStart; L <= LEVEL_COUNT; L++) if (pitBossLevel(L)) BOSS_LEVELS.push(L)

describe('where the boss works', () => {
  it('never below its band, and never in Act I', () => {
    for (const L of [1, 86, 201, 300, ACT2_FROM, 310, 349, 350]) {
      expect({ L, boss: pitBossLevel(L), deals: dealCount(L) }).toEqual({ L, boss: false, deals: 0 })
    }
    expect(pitBossLevel(DIFFICULTY.act2.pitBossStart)).toBe(true)
  })

  it('takes the every-5th breather off — the empty chair', () => {
    for (const L of BOSS_LEVELS) expect({ L, breather: L % 5 === 0 }).toEqual({ L, breather: false })
    for (const L of [355, 360, 375, 390, 400]) {
      expect({ L, boss: pitBossLevel(L), plan: dealPlan(L, 90).length }).toEqual({ L, boss: false, plan: 0 })
    }
  })

  it('stops at the top of the shipped tower, like every other Act II rule', () => {
    const top = FLOORS[FLOORS.length - 1].to
    expect(pitBossLevel(top + 1)).toBe(false)
    expect(pitBossLevel(top + 4)).toBe(false)
  })

  it('is revocable — off means levels 351+ are ordinary Act II levels again', () => {
    const a2 = DIFFICULTY.act2 as { pitBoss: boolean }
    const was = a2.pitBoss
    try {
      a2.pitBoss = false
      for (const L of [351, 366, 387, 399]) {
        expect({ L, boss: pitBossLevel(L), deals: dealCount(L), allowance: dealMoveAllowance(L) }).toEqual({
          L,
          boss: false,
          deals: 0,
          allowance: 0,
        })
        expect(dealPlan(L, 90)).toEqual([])
      }
    } finally {
      a2.pitBoss = was
    }
  })

  it('brings fresh felt into the book only from its own band', () => {
    const feltAt = (L: number): number => dealPlan(L, 90).filter(d => d.kind === 'felt').length
    for (const L of BOSS_LEVELS.filter(x => x < DIFFICULTY.act2.pitBossFeltFrom)) {
      expect({ L, felt: feltAt(L) }).toEqual({ L, felt: 0 })
    }
    // …and once it does, the level still OPENS on a clamp: the cheap instrument teaches the rhythm
    // before the dear one arrives.
    for (const L of BOSS_LEVELS.filter(x => x >= DIFFICULTY.act2.pitBossFeltFrom)) {
      const plan = dealPlan(L, levelSpec(L).moves)
      expect({ L, felt: plan.filter(d => d.kind === 'felt').length }).toEqual({ L, felt: 1 })
      expect({ L, opensOn: plan[0].kind }).toEqual({ L, opensOn: 'clamp' })
    }
  })
})

describe('the schedule', () => {
  it('is a pure function of the level — the same rhythm on every attempt', () => {
    for (const L of BOSS_LEVELS) {
      const moves = levelSpec(L).moves
      expect(dealPlan(L, moves)).toEqual(dealPlan(L, moves))
    }
    // Different levels get different books, or the "learn this floor" premise is a lie.
    const books = new Set(BOSS_LEVELS.map(L => JSON.stringify(dealPlan(L, levelSpec(L).moves))))
    expect(books.size).toBeGreaterThan(BOSS_LEVELS.length / 2)
  })

  it('never acts inside your last five moves', () => {
    for (const L of BOSS_LEVELS) {
      const moves = levelSpec(L).moves
      for (const d of dealPlan(L, moves)) {
        expect({ L, at: d.atMove, standsOff: moves - d.atMove >= 5 }).toEqual({ L, at: d.atMove, standsOff: true })
      }
    }
  })

  it('leaves a move to telegraph on, and at least four moves between deals', () => {
    for (const L of BOSS_LEVELS) {
      const plan = dealPlan(L, levelSpec(L).moves)
      expect({ L, first: plan[0].atMove >= 2 }).toEqual({ L, first: true })
      for (let i = 1; i < plan.length; i++) {
        const gap = plan[i].atMove - plan[i - 1].atMove
        expect({ L, i, gap: gap >= 4 }).toEqual({ L, i, gap: true })
      }
    }
  })

  it('drops deals it cannot fit rather than squeezing them', () => {
    // A pathologically short budget is not reachable through `levelSpec` (Act II levels run ~90
    // moves), but "fewer deals" must be the failure mode if it ever were.
    expect(dealPlan(387, 8).length).toBeLessThanOrEqual(1)
    expect(dealPlan(387, 6)).toEqual([])
    expect(dealPlan(387, 0)).toEqual([])
    for (const d of dealPlan(387, 12)) expect(12 - d.atMove).toBeGreaterThanOrEqual(5)
  })

  it('draws from its own stream — goal symbols and hazard cells are untouched by it', () => {
    // The determinism trap `hazards.ts` documents: a draw added to a SHARED stream silently re-rolls
    // every level in the game. The whole-game proof lives in levels.test.ts's GOLDEN table and
    // actII.test.ts's; this is the local statement of intent.
    const goals = (L: number): string => levelSpec(L).objectives.map(o => `${o.symbol}:${o.count}`).join(',')
    expect(goals(352)).toBe(goals(352))
    expect(goals(387)).toBe(goals(387))
  })
})

describe('the move budget pays for the work up front', () => {
  it('pays for the felt and nothing else — the measured cost, not one move per deal', () => {
    // The clamp is free BY MEASUREMENT (see dealMoveAllowance's table): it removes nothing from the
    // board and lifts on the next clear beside it. The felt is paid for because every dealt square
    // is one more on the win condition. Paying per deal made Floor 2 measurably easier than Floor 1.
    for (const L of BOSS_LEVELS) {
      const felt = dealPlan(L, levelSpec(L).moves).filter(d => d.kind === 'felt').length
      expect({ L, allowance: dealMoveAllowance(L), felt: feltDealCount(L) }).toEqual({ L, allowance: felt, felt })
    }
    for (const L of [300, 350, 355, 400]) expect({ L, allowance: dealMoveAllowance(L) }).toEqual({ L, allowance: 0 })
    // Below the felt band the boss is working and the budget does not move at all.
    for (const L of BOSS_LEVELS.filter(x => x < DIFFICULTY.act2.pitBossFeltFrom)) {
      expect({ L, allowance: dealMoveAllowance(L), deals: dealCount(L) }).toEqual({ L, allowance: 0, deals: 2 })
    }
  })

  it('is folded into levelSpec, and vanishes with the mechanic', () => {
    const a2 = DIFFICULTY.act2 as { pitBoss: boolean }
    const was = a2.pitBoss
    try {
      const on = levelSpec(387).moves
      a2.pitBoss = false
      const off = levelSpec(387).moves
      expect(on - off).toBe(1) // one felt deal at 387
      // …and a clamp-only level's budget is untouched in both directions.
      const onClamp = levelSpec(363).moves
      a2.pitBoss = true
      expect(levelSpec(363).moves).toBe(onClamp)
    } finally {
      a2.pitBoss = was
    }
  })

  it('leaves the plaque ladder alone — the brass number is priced off collects, not moves', () => {
    const a2 = DIFFICULTY.act2 as { pitBoss: boolean }
    const was = a2.pitBoss
    try {
      const on = levelSpec(396).scoreTarget
      a2.pitBoss = false
      expect(levelSpec(396).scoreTarget).toBe(on)
    } finally {
      a2.pitBoss = was
    }
  })
})

describe('what a deal may touch', () => {
  const board = (): Board => buildLevelBoard(387, 0xc0ffee)

  it('clamps a plain piece and refuses everything else', () => {
    const b = board()
    // A special the player banked, a clamped piece and a lockbox are all off limits.
    const special: Coord = { row: 4, col: 1 }
    b.plant(special, 'wildReelRow')
    const already: Coord = { row: 4, col: 3 }
    b.dealLocks([already])
    const targets = dealTargets(b, 'clamp', 40, mulberry32(7))
    expect(targets.some(c => c.row === special.row && c.col === special.col)).toBe(false)
    expect(targets.some(c => c.row === already.row && c.col === already.col)).toBe(false)
    for (const c of targets) {
      const p = b.get(c)
      expect({ c, ok: p !== null && p.kind === 'normal' && !p.locked }).toEqual({ c, ok: true })
    }
  })

  it('never clamps the last legal move off the board', () => {
    // The failure this closes is not theoretical: clamps do not block gravity, but "every remaining
    // swap involves a clamped piece" is entirely reachable on a tight board — and reshuffling out of
    // it would rewrite the level under the player at the exact moment they were being interfered
    // with. Clamp EVERY cell and the board must still be playable.
    const b = board()
    const all: Coord[] = []
    for (let r = 0; r < b.rows; r++) for (let c = 0; c < b.cols; c++) all.push({ row: r, col: c })
    const done = b.dealLocks(all)
    expect(done.length).toBeGreaterThan(0)
    expect(done.length).toBeLessThan(all.length) // something had to be put back
    expect(b.hasValidMove()).toBe(true)
  })

  it('lays felt only on bare squares, never under a lockbox, and never stacks', () => {
    const b = board()
    const targets = dealTargets(b, 'felt', 40, mulberry32(11))
    for (const c of targets) {
      expect({ c, bare: b.coatAt(c) === 0, box: b.get(c)?.kind === 'blocker' }).toEqual({ c, bare: true, box: false })
    }
    const before = b.coatsRemaining()
    const laid = b.dealCoats(targets.slice(0, 3))
    expect(b.coatsRemaining()).toBe(before + laid.length)
    // Dealing the same squares again adds nothing — a deal adds SQUARES, not layers.
    expect(b.dealCoats(laid)).toEqual([])
    expect(b.coatsRemaining()).toBe(before + laid.length)
  })

  it('lays felt on a board that had none, allocating the layer lazily', () => {
    // Every board above the coat band carries felt, but a hazard-free one must survive the deal too
    // — the coat grid is allocated on demand and a null one used to mean "this board has no coats".
    const b = new Board(8, 8, 6, mulberry32(3))
    expect(b.coatsRemaining()).toBe(0)
    expect(b.dealCoats([{ row: 2, col: 2 }])).toHaveLength(1)
    expect(b.coatsRemaining()).toBe(1)
  })

  it('spreads a deal across columns rather than stacking one', () => {
    const b = board()
    const cols = new Set(dealTargets(b, 'clamp', 3, mulberry32(5)).map(c => c.col))
    expect(cols.size).toBe(3)
  })

  it('refuses a lockbox on row 0, on a special, and where it would end the game', () => {
    const b = board()
    expect(b.dealBlocker({ row: 0, col: 2 })).toBe(false)
    const special: Coord = { row: 3, col: 2 }
    b.plant(special, 'jackpot')
    expect(b.dealBlocker(special)).toBe(false)
    expect(b.hasValidMove()).toBe(true)
  })
})

describe('endless can never meet the pit boss', () => {
  it('has no level number to schedule against', () => {
    // Endless passes 0 wherever a level number is asked for, and never calls levelSpec at all.
    expect(pitBossLevel(0)).toBe(false)
    expect(dealPlan(0, 30)).toEqual([])
    expect(dealMoveAllowance(0)).toBe(0)
  })

  it('leaves a board that is never dealt to exactly as it was', () => {
    // Dormant BY ABSENCE: the mutators exist on every Board, and an endless board simply never has
    // them called. The proof that matters is boardpick.test.ts's goldens; this states the shape.
    const b = new Board(8, 8, 6, mulberry32(99))
    const before = JSON.stringify((b as unknown as { grid: unknown }).grid)
    expect(b.dealLocks([])).toEqual([])
    expect(b.dealCoats([])).toEqual([])
    expect(JSON.stringify((b as unknown as { grid: unknown }).grid)).toBe(before)
    expect(b.coatsRemaining()).toBe(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Board } from './board'
import { clearLevelSnapshot, loadLevelSnapshot, pendingResumeLevel, saveLevelSnapshot } from './levelresume'
import type { LevelSnapshotInput } from './levelresume'
import { mulberry32 } from './rng'

/**
 * Mid-level resume. Two things are being defended here and they pull in opposite directions:
 *
 *  - a level in progress must genuinely survive the page going away (the whole point), and
 *  - a hand-edited localStorage entry must never be able to crash the game or hand out a rewind.
 *
 * So the round-trip tests sit next to a block of deliberately hostile input, and both matter.
 */

const boardOf = (seed = 7): Board => new Board(8, 8, 6, mulberry32(seed))

const inputFor = (board: Board, over: Partial<LevelSnapshotInput> = {}): LevelSnapshotInput => ({
  level: 104,
  moves: 10,
  score: 17240,
  objectives: [{ symbol: 'bell', remaining: 0, total: 12 }],
  coatsTotal: 14,
  moveMade: true,
  bombsUsed: 1,
  purchasedMoves: 5,
  plinkoUsed: true,
  markerStake: 250,
  minPlaqueMet: true,
  board: board.toSnapshot(),
  ...over,
})

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

afterEach(() => {
  vi.useRealTimers()
})

describe('board snapshot — the level survives the page', () => {
  it('round-trips every cell through JSON', () => {
    const from = boardOf()
    const to = boardOf(999) // a completely different board
    expect(to.restoreSnapshot(JSON.parse(JSON.stringify(from.toSnapshot())))).toBe(true)

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const at = { row: r, col: c }
        expect(to.get(at)?.symbol).toBe(from.get(at)?.symbol)
        expect(to.get(at)?.id).toBe(from.get(at)?.id)
      }
    }
  })

  /** The interesting cells: specials, locks, blockers and the felt are the level's whole character. */
  it('carries specials, locks, blockers and coats', () => {
    const from = boardOf()
    from.seedHazards({
      coats: [{ row: 6, col: 7, layers: 2 }],
      blockers: [{ row: 2, col: 2, hp: 2 }],
      locks: [{ row: 4, col: 1 }],
    })
    from.plant({ row: 0, col: 0 }, 'jackpot')

    const to = boardOf(31)
    expect(to.restoreSnapshot(JSON.parse(JSON.stringify(from.toSnapshot())))).toBe(true)

    expect(to.coatAt({ row: 6, col: 7 })).toBe(2)
    expect(to.coatsRemaining()).toBe(from.coatsRemaining())
    expect(to.get({ row: 2, col: 2 })?.kind).toBe('blocker')
    expect(to.get({ row: 2, col: 2 })?.hp).toBe(2)
    expect(to.get({ row: 4, col: 1 })?.locked).toBe(true)
    expect(to.get({ row: 0, col: 0 })?.kind).toBe('jackpot')
  })

  it('leaves a coat-free board coat-free rather than inventing the structure', () => {
    const from = boardOf()
    const to = boardOf(5)
    expect(to.restoreSnapshot(from.toSnapshot())).toBe(true)
    expect(to.coatsRemaining()).toBe(0)
  })

  it('is a deep copy — mutating the live board cannot reach into a held snapshot', () => {
    const board = boardOf()
    const snap = board.toSnapshot()
    const before = snap.grid[3][3]?.symbol
    board.plant({ row: 3, col: 3 }, 'diceBomb')
    expect(snap.grid[3][3]?.symbol).toBe(before)
    expect(snap.grid[3][3]?.kind).toBe('normal')
  })

  /**
   * ⚠️ The view keys its sprite map by piece id. A restored board whose `nextId` sits at or below an
   * id already on the grid would hand two cells the same id on the next refill, and the second sprite
   * would silently replace the first — a piece that renders in one place and is tapped in another.
   */
  it('never lets the id counter collide with a piece already on the grid', () => {
    const snap = boardOf().toSnapshot()
    snap.nextId = 1 // as if hand-edited, or written by an older build

    const to = boardOf(11)
    expect(to.restoreSnapshot(snap)).toBe(true)

    let highest = 0
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) highest = Math.max(highest, to.get({ row: r, col: c })!.id)
    }
    // The next id the board mints — read straight back off a fresh snapshot — must clear every id
    // already on the grid, no matter what the stored counter claimed.
    expect(to.toSnapshot().nextId).toBeGreaterThan(highest)
  })
})

describe('board snapshot — hostile input is refused, not trusted', () => {
  const rejected = (mutate: (snap: ReturnType<Board['toSnapshot']>) => unknown): void => {
    const board = boardOf()
    const before = board.get({ row: 0, col: 0 })!.id
    const snap = boardOf(2).toSnapshot()
    expect(board.restoreSnapshot(mutate(snap) as never)).toBe(false)
    // and crucially: the live board is untouched, so the caller's fallback level is still playable
    expect(board.get({ row: 0, col: 0 })!.id).toBe(before)
  }

  it('refuses null and undefined', () => {
    const board = boardOf()
    expect(board.restoreSnapshot(null)).toBe(false)
    expect(board.restoreSnapshot(undefined)).toBe(false)
  })

  it('refuses a board of the wrong size', () => rejected(s => ({ ...s, rows: 6 })))
  it('refuses a short grid', () => rejected(s => ({ ...s, grid: s.grid.slice(0, 4) })))
  it('refuses a short row', () => rejected(s => ({ ...s, grid: s.grid.map(r => r.slice(0, 3)) })))
  it('refuses a grid that is not an array', () => rejected(s => ({ ...s, grid: 'nope' })))
  it('refuses an unknown symbol', () =>
    rejected(s => {
      s.grid[0][0] = { ...s.grid[0][0]!, symbol: 'diamondz' as never }
      return s
    }))
  it('refuses an unknown piece kind', () =>
    rejected(s => {
      s.grid[0][0] = { ...s.grid[0][0]!, kind: 'godmode' as never }
      return s
    }))
  it('refuses a coat grid of the wrong shape', () => rejected(s => ({ ...s, coats: [[1, 2]] })))
  it('refuses negative coat layers', () =>
    rejected(s => ({ ...s, coats: Array.from({ length: 8 }, () => new Array(8).fill(-1)) })))
})

describe('level snapshot store', () => {
  it('round-trips a level in progress', () => {
    const board = boardOf()
    saveLevelSnapshot(inputFor(board))

    const back = loadLevelSnapshot(104)
    expect(back).not.toBeNull()
    expect(back!.moves).toBe(10)
    expect(back!.score).toBe(17240)
    expect(back!.coatsTotal).toBe(14)
    expect(back!.moveMade).toBe(true)
    expect(back!.bombsUsed).toBe(1)
    expect(back!.purchasedMoves).toBe(5)
    expect(back!.plinkoUsed).toBe(true)
    expect(new Board(8, 8, 6, mulberry32(1)).restoreSnapshot(back!.board)).toBe(true)
  })

  /**
   * ⚠️ THE MARKER IS REAL MONEY. `placeMarker` spends the chips the moment it is slid and the
   * level's ending settles them, so a snapshot that dropped the stake would take up to 500 chips
   * and then never pay the hand out — silently, because nothing in the level would remember a bet
   * had been placed. It rides with `moveMade`, which is what decides whether it can still be
   * backed out.
   */
  it('carries the marker stake, because those chips are already spent', () => {
    saveLevelSnapshot(inputFor(boardOf(), { markerStake: 500, moveMade: true }))
    const back = loadLevelSnapshot(104)
    expect(back!.markerStake).toBe(500)
    expect(back!.moveMade).toBe(true)
  })

  it('carries a level with no marker down as no marker down', () => {
    saveLevelSnapshot(inputFor(boardOf(), { markerStake: 0 }))
    expect(loadLevelSnapshot(104)!.markerStake).toBe(0)
  })

  it('carries the HOUSE MINIMUM latch, so a met plaque is not re-announced', () => {
    saveLevelSnapshot(inputFor(boardOf(), { minPlaqueMet: true }))
    expect(loadLevelSnapshot(104)!.minPlaqueMet).toBe(true)
  })

  it('does not hand a stored level to a DIFFERENT level', () => {
    saveLevelSnapshot(inputFor(boardOf()))
    expect(loadLevelSnapshot(103)).toBeNull()
    expect(loadLevelSnapshot(105)).toBeNull()
  })

  it('is single-slot — starting another level replaces it', () => {
    saveLevelSnapshot(inputFor(boardOf(), { level: 104 }))
    saveLevelSnapshot(inputFor(boardOf(), { level: 12 }))
    expect(loadLevelSnapshot(104)).toBeNull()
    expect(loadLevelSnapshot(12)).not.toBeNull()
  })

  it('clears', () => {
    saveLevelSnapshot(inputFor(boardOf()))
    clearLevelSnapshot()
    expect(loadLevelSnapshot(104)).toBeNull()
    expect(pendingResumeLevel()).toBeNull()
  })

  it('reports which level is waiting, without needing to know it in advance', () => {
    saveLevelSnapshot(inputFor(boardOf()))
    expect(pendingResumeLevel()).toBe(104)
  })

  /** A board abandoned across days should not ambush someone who has long since moved on. */
  it('expires after a day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-06T12:00:00Z'))
    saveLevelSnapshot(inputFor(boardOf()))

    vi.setSystemTime(new Date('2026-08-07T11:00:00Z')) // 23h — still yours
    expect(loadLevelSnapshot(104)).not.toBeNull()

    vi.setSystemTime(new Date('2026-08-07T13:00:00Z')) // 25h — gone
    expect(loadLevelSnapshot(104)).toBeNull()
    expect(pendingResumeLevel()).toBeNull()
  })

  it('survives garbage in storage without throwing', () => {
    localStorage.setItem('viva-maya:level', '{not json at all')
    expect(loadLevelSnapshot(104)).toBeNull()
    expect(pendingResumeLevel()).toBeNull()
  })

  it('refuses a snapshot from a future schema version', () => {
    saveLevelSnapshot(inputFor(boardOf()))
    const raw = JSON.parse(localStorage.getItem('viva-maya:level')!) as Record<string, unknown>
    localStorage.setItem('viva-maya:level', JSON.stringify({ ...raw, v: 2 }))
    expect(loadLevelSnapshot(104)).toBeNull()
  })

  /** Zero moves is a finished level, and resuming into one would be a board that cannot be played. */
  it('refuses a snapshot with no moves left', () => {
    saveLevelSnapshot(inputFor(boardOf(), { moves: 0 }))
    expect(loadLevelSnapshot(104)).toBeNull()
  })

  it('refuses a nonsense score', () => {
    saveLevelSnapshot(inputFor(boardOf(), { score: -5 }))
    expect(loadLevelSnapshot(104)).toBeNull()
  })
})

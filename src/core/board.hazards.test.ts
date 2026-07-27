import { describe, expect, it } from 'vitest'
import { COLS, ROWS } from '../config'
import { Board } from './board'
import { hazardPlan } from './hazards'
import { DIFFICULTY } from './difficulty'
import { mulberry32 } from './rng'
import type { ClearWave, Coord, Piece } from './types'

/**
 * The model/view contract, with hazards on.
 *
 * `board.test.ts` already fuzzes this for the base game, and its central invariant is the one that
 * matters most here: nothing may leave the board unreported (the view never destroys the sprite →
 * a ghost you can't match), and nothing may arrive unreported (the view never creates it → an
 * invisible piece you can't see but can hit). Hazards add three new ways to break exactly that:
 *
 *   - a blocker destroyed by adjacent damage disappears from the grid WITHOUT being part of a
 *     match, so if it never lands in `cleared` its sprite is stranded on screen forever;
 *   - segment-aware gravity refills each segment separately, so a bug there leaves a permanent
 *     hole under a blocker rather than an obvious full-column gap;
 *   - a reshuffle rebuilds the whole grid, and hazards must survive it or the level silently
 *     rewrites itself mid-play.
 *
 * Note the base fuzz cannot simply be pointed at hazard boards: it asserts that any non-`normal`
 * piece appearing in `cleared` must also have detonated, and a blocker is the one kind that is
 * consumed without ever firing. That exemption is why this lives in its own file.
 */

type Grid = (Piece | null)[][]
const gridOf = (b: Board): Grid => (b as unknown as { grid: Grid }).grid
const at = (row: number, col: number): Coord => ({ row, col })

/** Every piece currently on the board, by id. */
function pieces(b: Board): Map<number, Piece> {
  const m = new Map<number, Piece>()
  for (const row of gridOf(b)) for (const p of row) if (p) m.set(p.id, p)
  return m
}

/**
 * A board for `level` with its full hazard plan applied.
 *
 * Every mechanic is forced ON here regardless of the shipped rollout. These are RULE tests: if
 * they respected the live flags, staging the rollout (shipping locks alone) would silently reduce
 * this file to fuzzing an almost-empty board and it would stay green while proving nothing about
 * the code it exists to guard.
 */
const MECH = DIFFICULTY.hazards as { enabled: boolean; lock: boolean; coat: boolean; blocker: boolean }
function allOn<T>(fn: () => T): T {
  const was = { ...MECH }
  Object.assign(MECH, { enabled: true, lock: true, coat: true, blocker: true })
  try {
    return fn()
  } finally {
    Object.assign(MECH, was)
  }
}

function hazardBoard(level: number, seed: number): Board {
  return allOn(() => {
    const b = new Board(ROWS, COLS, 6, mulberry32(seed))
    b.seedHazards(hazardPlan(level, ROWS, COLS))
    return b
  })
}

function everyValidMove(b: Board): { a: Coord; to: Coord }[] {
  const out: { a: Coord; to: Coord }[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      for (const to of [at(r, c + 1), at(r + 1, c)]) {
        if (b.inBounds(to) && b.wouldSwapMatch(at(r, c), to)) out.push({ a: at(r, c), to })
      }
    }
  }
  return out
}

/** One committed move, resolved through the full cascade, auditing every wave. */
function playMove(b: Board, mv: { a: Coord; to: Coord }, tag: string, bad: string[]): void {
  b.swap(mv.a, mv.to)
  let wave: ClearWave | null = b.swapActivation(mv.a, mv.to)
  if (!wave) {
    if (b.findRuns().length === 0) {
      b.swap(mv.a, mv.to)
      return
    }
    wave = b.matchWave([mv.to, mv.a])
  }
  let cascade = 0
  while (wave && cascade < 60) {
    cascade++
    const before = pieces(b)
    const clearedIds = new Set(wave.cleared.map(c => c.piece.id))
    const morphed = new Set(wave.transformed.map(t => t.from.id))

    b.applyGravity()
    const spawns = b.refill()
    const after = pieces(b)
    const born = new Set(spawns.map(s => s.piece.id))

    // Nothing may vanish without being reported — a stranded blocker sprite lives here.
    for (const id of before.keys()) {
      if (!after.has(id) && !clearedIds.has(id) && !morphed.has(id)) {
        const p = before.get(id)!
        if (bad.length < 15) bad.push(`${tag} c${cascade}: ${p.kind} ${id} left the board unreported -> orphan sprite`)
      }
    }
    // Nothing may appear without being reported.
    for (const id of after.keys()) {
      if (!before.has(id) && !born.has(id) && bad.length < 15) {
        bad.push(`${tag} c${cascade}: piece ${id} appeared unreported -> invisible piece`)
      }
    }
    // Segment refill must leave no hole, including under a blocker.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!gridOf(b)[r][c] && bad.length < 15) bad.push(`${tag} c${cascade}: hole left at ${r},${c} after refill`)
      }
    }
    wave = b.matchWave()
  }
  if (cascade >= 60 && bad.length < 15) bad.push(`${tag}: cascade never settled`)
}

describe('hazard boards keep the model and the view in step', () => {
  it('survives a fuzz across every band, with no orphans, ghosts or holes', { timeout: 120_000 }, () => {
    const bad: string[] = []
    for (const level of [31, 56, 86, 120, 200, 300]) {
      for (let seed = 1; seed <= 25; seed++) {
        const b = hazardBoard(level, seed * 7919 + level)
        for (let move = 0; move < 25; move++) {
          let moves = everyValidMove(b)
          if (moves.length === 0) {
            b.regenerate()
            moves = everyValidMove(b)
            if (moves.length === 0) break
          }
          playMove(b, moves[move % moves.length], `L${level} s${seed} m${move}`, bad)
          if (bad.length >= 15) break
        }
      }
    }
    expect(bad).toEqual([])
  })
})

describe('hazard rules hold on a live board', () => {
  it('never offers a swap involving a locked piece or a blocker', () => {
    for (const level of [31, 86, 200, 300]) {
      for (let seed = 1; seed <= 20; seed++) {
        const b = hazardBoard(level, seed * 104729 + level)
        for (const mv of everyValidMove(b)) {
          for (const c of [mv.a, mv.to]) {
            const p = b.get(c)!
            expect({ level, kind: p.kind, locked: p.locked === true }).toEqual({
              level,
              kind: p.kind,
              locked: false,
            })
            expect(p.kind).not.toBe('blocker')
          }
        }
      }
    }
  })

  it('only reports a blocker as cleared once its last hit lands', () => {
    // A 2-hp blocker reported cleared on the first hit would destroy the sprite while the model
    // still holds the piece — the exact ghost the fuzz above hunts, but reachable deterministically.
    const b = hazardBoard(300, 4242)
    const hp2 = gridOf(b)
      .flatMap((row, r) => row.map((p, c) => ({ p, at: at(r, c) })))
      .filter(x => x.p?.kind === 'blocker' && (x.p.hp ?? 1) >= 2)
    for (const { at: cell } of hp2) {
      const before = b.get(cell)!
      expect(before.hp).toBeGreaterThanOrEqual(2)
    }
  })

  it('never refills a hazard back onto the board', () => {
    // Hazards are seeded once and only ever removed. If refill could mint one, a level could get
    // HARDER as it went and could soft-lock behind something it spawned.
    const b = hazardBoard(300, 909)
    for (let i = 0; i < 40; i++) {
      const moves = everyValidMove(b)
      if (moves.length === 0) break
      playMove(b, moves[0], 'refill-check', [])
    }
    const seeded = allOn(() => hazardPlan(300, ROWS, COLS)).blockers.length
    let blockers = 0
    for (const row of gridOf(b)) for (const p of row) if (p?.kind === 'blocker') blockers++
    expect(blockers).toBeLessThanOrEqual(seeded)
  })

  it('carries hazards through a reshuffle instead of confiscating them', () => {
    const b = hazardBoard(300, 77)
    const count = (): { blockers: number; locks: number } => {
      let blockers = 0
      let locks = 0
      for (const row of gridOf(b)) for (const p of row) {
        if (p?.kind === 'blocker') blockers++
        if (p?.locked) locks++
      }
      return { blockers, locks }
    }
    const before = count()
    const coatsBefore = b.coatsRemaining()
    b.regenerate()
    expect(count()).toEqual(before)
    expect(b.coatsRemaining()).toBe(coatsBefore)
  })

  it('only ever lets coats decrease', () => {
    const b = hazardBoard(200, 31337)
    let prev = b.coatsRemaining()
    expect(prev).toBeGreaterThan(0)
    for (let i = 0; i < 40; i++) {
      const moves = everyValidMove(b)
      if (moves.length === 0) break
      playMove(b, moves[0], 'coat-check', [])
      const now = b.coatsRemaining()
      expect(now).toBeLessThanOrEqual(prev)
      prev = now
    }
  })
})

import { describe, expect, it } from 'vitest'
import { Board } from './board'
import { mulberry32 } from './rng'
import type { ClearWave, Coord, Piece, PieceKind, Spawn, SymbolType } from './types'

/**
 * Board rules that the SCENE cannot re-check at runtime.
 *
 * The headline case is the "swallowed special": a Wild Reel / Dice Bomb that gets caught in a match
 * big enough to mint a NEW special lands on the very cell the new one spawns on. That cell is
 * protected from the blast flood (so the newborn survives its own wave), which used to mean the old
 * special was overwritten in silence — it never fired, and to the player it looked like the rocket
 * had simply refused to detonate and "survived" the match. It hit every direction, every special,
 * and cascades and the purchased bomb too. See `blastOf` / the carry seeds in matchWave.
 *
 * The rest pin the model↔view contract GameScene.playWave depends on: every piece that leaves the
 * board is reported (or its sprite orphans), every piece that arrives is reported (or it's
 * invisible), and nothing is reported twice (or score/objectives double-count).
 */

const at = (row: number, col: number): Coord => ({ row, col })
const gridOf = (b: Board): (Piece | null)[][] => (b as unknown as { grid: (Piece | null)[][] }).grid

/** Author a whole board from rows of `symbol[kind]` tokens, e.g. 'ch' or 'ch>' for a row reel. */
function build(rows: string[]): Board {
  const b = new Board(rows.length, rows[0].trim().split(/\s+/).length, 5, mulberry32(7))
  const sym: Record<string, SymbolType> = {
    ch: 'cherry',
    se: 'seven',
    di: 'diamond',
    be: 'bell',
    cl: 'clover',
    ba: 'bar',
  }
  const kinds: Record<string, PieceKind> = { '>': 'wildReelRow', v: 'wildReelCol', '*': 'diceBomb', J: 'jackpot' }
  let id = 1
  gridOf(b).splice(
    0,
    rows.length,
    ...rows.map(row =>
      row
        .trim()
        .split(/\s+/)
        .map(tok => ({ id: id++, symbol: sym[tok.slice(0, 2)], kind: kinds[tok.slice(2)] ?? 'normal' }))
    )
  )
  return b
}

/**
 * A match-free 8x8 base to paint fixtures onto: symbol `(col + 2*row) % 4` never repeats along a row
 * and alternates down a column, and it leaves `clover`/`bar` unused so a painted shape can only ever
 * match itself.
 */
function neutral(): Board {
  const base: SymbolType[] = ['cherry', 'seven', 'diamond', 'bell']
  return build(
    Array.from({ length: 8 }, (_, r) =>
      Array.from({ length: 8 }, (_, c) => base[(c + 2 * r) % 4].slice(0, 2)).join(' ')
    )
  )
}

/** Exactly what GameScene.trySwap does with a player swipe. Returns null when the swap is rejected. */
function swipe(b: Board, from: Coord, to: Coord): ClearWave | null {
  b.swap(from, to)
  const activation = b.swapActivation(from, to)
  if (activation) return activation
  if (b.findRuns().length === 0) {
    b.swap(from, to)
    return null
  }
  return b.matchWave([to, from])
}

const firedAt = (wave: ClearWave, c: Coord): boolean =>
  wave.events.some(e => e.at.row === c.row && e.at.col === c.col)

describe('a special swallowed by the match that upgrades it', () => {
  // Column 3 is three cherries with a GAP at row 3; the reel waits at (3,4). Swiping it LEFT into
  // the gap makes the column four long — a match-4, which wants to mint a new reel on the cell the
  // old one just landed on. The old reel must blast its line on the way out.
  const REPRO = [
    'se di be se cl di be se',
    'se di be ch cl di be se',
    'di be se ch di be se cl',
    'be se cl di ch> se cl di', // (3,3) is the gap, (3,4) the reel
    'cl di be ch se cl di be',
    'se cl di be cl di be se',
    'di be se cl di be se cl',
    'be se cl di be se cl di',
  ]

  it('starts from a board with nothing already matched', () => {
    expect(build(REPRO).findRuns()).toEqual([])
  })

  it('detonates the reel AND leaves the upgrade standing', () => {
    const b = build(REPRO)
    const wave = swipe(b, at(3, 4), at(3, 3))!
    expect(wave).not.toBeNull()

    // The reel fired: a reel event on its landing cell, and its whole row is gone.
    expect(wave.events.some(e => e.type === 'reel' && e.at.row === 3 && e.at.col === 3)).toBe(true)
    for (let c = 0; c < 8; c++) {
      if (c === 3) continue // the upgrade cell — protected, see below
      expect(gridOf(b)[3][c], `row 3 col ${c} should have been blasted`).toBeNull()
    }
    // ...and the match-4 still paid out: a fresh special stands on the landing cell.
    expect(wave.transformed).toHaveLength(1)
    expect(wave.transformed[0].at).toEqual(at(3, 3))
    expect(gridOf(b)[3][3]?.kind).toBe('wildReelRow')
    // The old reel is consumed exactly once (it feeds score/objectives, and its sprite is replaced).
    const oldReel = wave.cleared.filter(c => c.piece.kind === 'wildReelRow' && c.at.row === 3 && c.at.col === 3)
    expect(oldReel).toHaveLength(1)
  })

  it('detonates whichever way the special is swiped, and whatever it is', () => {
    // The same shape rotated into all four swipe directions: the special always lands in the gap of
    // a gapped line of three, so the SWIPE is what completes the match-4. Painted onto a neutral
    // base in a symbol the base never uses, so the only runs possible are the ones under test.
    const dirs: Record<string, { line: Coord[]; gap: Coord; from: Coord }> = {
      left: { line: [at(1, 3), at(2, 3), at(4, 3)], gap: at(3, 3), from: at(3, 4) },
      right: { line: [at(1, 4), at(2, 4), at(4, 4)], gap: at(3, 4), from: at(3, 3) },
      up: { line: [at(3, 1), at(3, 2), at(3, 4)], gap: at(3, 3), from: at(4, 3) },
      down: { line: [at(3, 1), at(3, 2), at(3, 4)], gap: at(3, 3), from: at(2, 3) },
    }
    for (const [dir, { line, gap, from }] of Object.entries(dirs)) {
      for (const kind of ['wildReelRow', 'wildReelCol', 'diceBomb'] as PieceKind[]) {
        const b = neutral()
        for (const c of line) b.plant(c, 'normal', 'clover')
        b.plant(from, kind, 'clover') // the gap keeps its neutral symbol
        expect(b.findRuns(), `${dir}/${kind}: fixture pre-matched`).toEqual([])

        const wave = swipe(b, from, gap)
        expect(wave, `${dir}/${kind}: swipe was rejected`).not.toBeNull()
        expect(firedAt(wave!, gap), `${dir}/${kind}: the special did not detonate`).toBe(true)
        expect(wave!.transformed, `${dir}/${kind}: no upgrade minted`).toHaveLength(1)
      }
    }
  })
})

describe('a no-moves reshuffle', () => {
  it('hands the player back their specials on a fresh, match-free layout', () => {
    const b = neutral()
    const planted: [Coord, PieceKind][] = [
      [at(0, 0), 'wildReelRow'],
      [at(2, 5), 'wildReelCol'],
      [at(6, 1), 'diceBomb'],
      [at(7, 7), 'jackpot'],
    ]
    for (const [c, kind] of planted) b.plant(c, kind)

    b.regenerate()

    for (const [c, kind] of planted) {
      expect(b.get(c)?.kind, `the ${kind} at ${c.row},${c.col} was confiscated by the reshuffle`).toBe(kind)
    }
    expect(gridOf(b).flat().filter(p => p?.kind !== 'normal')).toHaveLength(planted.length)
    expect(b.findRuns(), 'reshuffle handed back a pre-matched board').toEqual([])
    expect(b.hasValidMove()).toBe(true)
  })
})

// --------------------------------------------------------------- model ↔ view contract

const KINDS: PieceKind[] = ['wildReelRow', 'wildReelCol', 'diceBomb', 'jackpot']

/** A fresh board salted with specials, so the fuzz actually reaches the chain/upgrade paths. */
function salted(seed: number, specials: number): Board {
  const rng = mulberry32(seed)
  const b = new Board(8, 8, 5, rng)
  const g = gridOf(b)
  for (let i = 0; i < specials; i++) {
    const r = Math.floor(rng() * 8)
    const c = Math.floor(rng() * 8)
    g[r][c] = { ...g[r][c]!, kind: KINDS[Math.floor(rng() * KINDS.length)] }
  }
  return b
}

function pieces(b: Board): Map<number, Piece> {
  const m = new Map<number, Piece>()
  for (const row of gridOf(b)) for (const p of row) if (p) m.set(p.id, p)
  return m
}

function audit(tag: string, before: Map<number, Piece>, after: Map<number, Piece>, wave: ClearWave, spawns: Spawn[], bad: string[]): void {
  const flag = (ok: boolean, msg: string) => {
    if (!ok && bad.length < 20) bad.push(`${tag}: ${msg}`)
  }
  const cleared = wave.cleared.map(c => c.piece.id)
  const clearedSet = new Set(cleared)
  const morphed = new Set(wave.transformed.map(t => t.from.id))
  const born = new Set([...wave.transformed.map(t => t.to.id), ...spawns.map(s => s.piece.id)])

  flag(cleared.length === clearedSet.size, 'duplicate entries in cleared → score/objectives double-count')
  for (const id of before.keys()) {
    if (after.has(id)) continue
    flag(clearedSet.has(id) || morphed.has(id), `piece ${id} (${before.get(id)!.kind}) left the board unreported → orphan sprite`)
  }
  for (const id of after.keys()) {
    if (!before.has(id)) flag(born.has(id), `piece ${id} appeared unreported → invisible piece`)
  }
  for (const id of clearedSet) {
    flag(!after.has(id) || morphed.has(id), `piece ${id} reported cleared but still on the board → ghost cell`)
  }
  for (const { piece, at: cell } of wave.cleared) {
    if (piece.kind === 'normal') continue
    flag(firedAt(wave, cell), `${piece.kind} at ${cell.row},${cell.col} was consumed WITHOUT detonating`)
  }
}

/** GameScene.resolveLoop: play the wave, drop, refill, look for the next one. */
function resolve(b: Board, first: ClearWave, tag: string, bad: string[]): void {
  let wave: ClearWave | null = first
  let cascade = 0
  while (wave && cascade < 60) {
    cascade++
    const before = pieces(b)
    b.applyGravity()
    const spawns = b.refill()
    audit(`${tag} c${cascade}`, before, pieces(b), wave, spawns, bad)
    if (gridOf(b).some(row => row.some(p => p === null)) && bad.length < 20) bad.push(`${tag} c${cascade}: holes left after refill`)
    wave = b.matchWave()
  }
  if (cascade >= 60 && bad.length < 20) bad.push(`${tag}: cascade never settled`)
}

describe('THE REEL PULL — the column notch', () => {
  it('rotates the column down one and wraps the bottom piece to the top, touching nothing else', () => {
    const b = neutral()
    const before = gridOf(b).map(r => r.map(p => p!.id))
    const moves = b.pullColumn(3)!
    expect(moves).not.toBeNull()
    // Column 3: every id shifts down one, the bottom id lands in row 0.
    for (let r = 1; r < 8; r++) expect(gridOf(b)[r][3]!.id).toBe(before[r - 1][3])
    expect(gridOf(b)[0][3]!.id).toBe(before[7][3])
    // Every OTHER column is byte-identical — a pull is one column's business.
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (c === 3) continue
        expect(gridOf(b)[r][c]!.id).toBe(before[r][c])
      }
    }
    // Every piece that moved is reported exactly once, with the right from/to — the same
    // model↔view contract gravity signs, and the reason the view can tween this for free.
    expect(moves).toHaveLength(8)
    expect(new Set(moves.map(m => m.piece.id)).size).toBe(8)
    for (const m of moves) expect(m.to.col).toBe(3)
  })

  it('refuses a column holding a blocker or a clamp — the rule those pieces already carry', () => {
    const blocked = neutral()
    blocked.plant(at(4, 2), 'blocker')
    expect(blocked.canPull(2)).toBe(false)
    expect(blocked.pullColumn(2)).toBeNull()
    expect(blocked.canPull(3)).toBe(true)

    const clamped = neutral()
    const g = gridOf(clamped)
    g[6][5] = { ...g[6][5]!, locked: true }
    expect(clamped.canPull(5)).toBe(false)
    expect(clamped.pullColumn(5)).toBeNull()

    // A refused pull leaves the board completely untouched — no half-rotation.
    const snap = gridOf(clamped).map(r => r.map(p => p!.id))
    clamped.pullColumn(5)
    expect(gridOf(clamped).map(r => r.map(p => p!.id))).toEqual(snap)
  })

  it('refuses off-board columns and garbage', () => {
    const b = neutral()
    for (const c of [-1, 8, 99, 1.5, Number.NaN]) {
      expect(b.canPull(c)).toBe(false)
      expect(b.pullColumn(c)).toBeNull()
    }
  })

  it('carries specials through the wrap without consuming them', () => {
    const b = neutral()
    b.plant(at(7, 4), 'diceBomb')
    const id = b.get(at(7, 4))!.id
    expect(b.pullColumn(4)).not.toBeNull()
    const wrapped = b.get(at(0, 4))!
    expect({ id: wrapped.id, kind: wrapped.kind }).toEqual({ id, kind: 'diceBomb' })
  })

  it('survives a fuzz over every column of every seed, resolving like any other move', () => {
    // The same invariant harness the swap fuzz uses: nothing leaves the board unreported, nothing
    // arrives unreported, nothing is reported twice, and no special is consumed without detonating.
    const bad: string[] = []
    for (let seed = 1; seed <= 120; seed++) {
      for (let c = 0; c < 8; c++) {
        const b = salted(seed, 6)
        if (!b.canPull(c)) continue
        const idsBefore = new Set(pieces(b).keys())
        expect(b.pullColumn(c)).not.toBeNull()
        // A pull moves pieces, it never removes or mints them — check that BEFORE any wave runs.
        const idsAfter = new Set(pieces(b).keys())
        if (idsAfter.size !== idsBefore.size) bad.push(`s${seed} c${c}: the pull changed the piece count`)
        for (const id of idsBefore) if (!idsAfter.has(id)) bad.push(`s${seed} c${c}: piece ${id} vanished in the pull`)
        const wave = b.matchWave()
        if (wave) resolve(b, wave, `s${seed} pull c${c}`, bad)
      }
    }
    expect(bad).toEqual([])
  })
})

describe('every activation path keeps the board and the view in step', () => {
  /** 120 seeds x every legal swap on the board: ~1s on a quiet machine, but 4-5s once `npm test`
   *  saturates the cores, because wall clock here scales with whatever else is running. That put it
   *  under Vitest's 5s default only sometimes — a red that says "the machine was busy", not "the
   *  board broke". Same reasoning as the budgets in `feasibility.test.ts` / `plinko.rate.test.ts`. */
  it('survives a fuzz over swipes, activations, cascades and the purchased bomb', { timeout: 30_000 }, () => {
    const bad: string[] = []
    for (let seed = 1; seed <= 120; seed++) {
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          for (const d of [at(0, 1), at(1, 0)]) {
            const to = at(r + d.row, c + d.col)
            if (to.row > 7 || to.col > 7) continue
            const b = salted(seed, 6)
            if (!b.wouldSwapMatch(at(r, c), to)) continue
            const wave = swipe(b, at(r, c), to)
            if (!wave) {
              bad.push(`s${seed} ${r},${c}→${to.row},${to.col}: wouldSwapMatch said yes but the swap was rejected`)
              continue
            }
            resolve(b, wave, `s${seed} ${r},${c}→${to.row},${to.col}`, bad)
          }
        }
      }
      const bomb = salted(seed, 6)
      resolve(bomb, bomb.detonate(at(3, 3), 1), `s${seed} bomb`, bad)
    }
    expect(bad).toEqual([])
  })
})

import { SYMBOLS, key } from './types'
import type { BlastEvent, ClearWave, Coord, FallMove, Piece, PieceKind, RunMatch, Spawn, SymbolType } from './types'
import { randInt } from './rng'
import type { Rng } from './rng'

/**
 * Pure board model — no Phaser imports. The scene owns sprites/tweens; this owns truth.
 *
 * Match shapes → specials (created at the swapped cell when possible):
 *   4 in a row      → Wild Reel (blasts the perpendicular line)
 *   L / T (3+3)     → Dice Bomb (3x3 blast)
 *   5+ straight     → Jackpot Chip (color bomb)
 * Any blast that hits another special chains it. Swapping two specials combos them.
 */
export class Board {
  private grid: (Piece | null)[][] = []
  private nextId = 1

  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly symbolCount: number,
    private rng: Rng
  ) {
    this.regenerate()
  }

  /** Fresh board: no pre-existing matches, at least one valid move. */
  regenerate(): void {
    for (let attempt = 0; attempt < 100; attempt++) {
      this.fillWithoutMatches()
      if (this.findFirstValidMove()) return
    }
    // Statistically unreachable at 8x8 with 5-6 symbols; last fill stands regardless.
  }

  private palette(): SymbolType[] {
    return SYMBOLS.slice(0, this.symbolCount)
  }

  private newPiece(symbol: SymbolType, kind: PieceKind = 'normal'): Piece {
    return { id: this.nextId++, symbol, kind }
  }

  private fillWithoutMatches(): void {
    const pal = this.palette()
    this.grid = []
    for (let r = 0; r < this.rows; r++) {
      const row: (Piece | null)[] = []
      for (let c = 0; c < this.cols; c++) {
        const banned = new Set<SymbolType>()
        const left1 = row[c - 1]
        const left2 = row[c - 2]
        if (left1 && left2 && left1.symbol === left2.symbol) banned.add(left1.symbol)
        if (r >= 2) {
          const up1 = this.grid[r - 1][c]
          const up2 = this.grid[r - 2][c]
          if (up1 && up2 && up1.symbol === up2.symbol) banned.add(up1.symbol)
        }
        const choices = pal.filter(s => !banned.has(s))
        row.push(this.newPiece(choices[randInt(this.rng, choices.length)]))
      }
      this.grid.push(row)
    }
  }

  get(at: Coord): Piece | null {
    return this.inBounds(at) ? this.grid[at.row][at.col] : null
  }

  inBounds(at: Coord): boolean {
    return at.row >= 0 && at.col >= 0 && at.row < this.rows && at.col < this.cols
  }

  static areAdjacent(a: Coord, b: Coord): boolean {
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1
  }

  swap(a: Coord, b: Coord): void {
    const tmp = this.grid[a.row][a.col]
    this.grid[a.row][a.col] = this.grid[b.row][b.col]
    this.grid[b.row][b.col] = tmp
  }

  wouldSwapMatch(a: Coord, b: Coord): boolean {
    // Special-piece activations count as valid moves too.
    const pa = this.get(a)
    const pb = this.get(b)
    if (!pa || !pb) return false
    const spec = (p: Piece) => p.kind !== 'normal'
    if (pa.kind === 'jackpot' || pb.kind === 'jackpot' || (spec(pa) && spec(pb))) return true
    this.swap(a, b)
    const ok = this.findRuns().length > 0
    this.swap(a, b)
    return ok
  }

  /** All horizontal and vertical runs of >=3 (matched by symbol; specials match too). */
  findRuns(): RunMatch[] {
    const runs: RunMatch[] = []
    for (let r = 0; r < this.rows; r++) {
      let c = 0
      while (c < this.cols) {
        const p = this.grid[r][c]
        if (!p || p.kind === 'jackpot') {
          c++
          continue
        }
        let end = c + 1
        while (end < this.cols) {
          const q = this.grid[r][end]
          if (!q || q.kind === 'jackpot' || q.symbol !== p.symbol) break
          end++
        }
        if (end - c >= 3) {
          const cells: Coord[] = []
          for (let i = c; i < end; i++) cells.push({ row: r, col: i })
          runs.push({ symbol: p.symbol, horizontal: true, cells })
        }
        c = end
      }
    }
    for (let c = 0; c < this.cols; c++) {
      let r = 0
      while (r < this.rows) {
        const p = this.grid[r][c]
        if (!p || p.kind === 'jackpot') {
          r++
          continue
        }
        let end = r + 1
        while (end < this.rows) {
          const q = this.grid[end][c]
          if (!q || q.kind === 'jackpot' || q.symbol !== p.symbol) break
          end++
        }
        if (end - r >= 3) {
          const cells: Coord[] = []
          for (let i = r; i < end; i++) cells.push({ row: i, col: c })
          runs.push({ symbol: p.symbol, horizontal: false, cells })
        }
        r = end
      }
    }
    return runs
  }

  // ------------------------------------------------------------ match waves

  /**
   * Detect matches and compute the full clear step: special spawns, chained
   * detonations, effects. Returns null when the board has no matches.
   * `prefer` biases where match-created specials appear (the swapped cells).
   */
  matchWave(prefer: Coord[] = []): ClearWave | null {
    const runs = this.findRuns()
    if (runs.length === 0) return null

    // Union runs of the same symbol that share a cell (L/T shapes).
    const groups: { symbol: SymbolType; runs: RunMatch[]; cells: Map<string, Coord> }[] = []
    for (const run of runs) {
      const cellKeys = run.cells.map(key)
      const hits = groups.filter(
        g => g.symbol === run.symbol && cellKeys.some(k => g.cells.has(k))
      )
      const target = hits[0] ?? { symbol: run.symbol, runs: [], cells: new Map<string, Coord>() }
      if (!hits[0]) groups.push(target)
      // Merge any additional overlapping groups into the first.
      for (const extra of hits.slice(1)) {
        target.runs.push(...extra.runs)
        for (const [k, c] of extra.cells) target.cells.set(k, c)
        groups.splice(groups.indexOf(extra), 1)
      }
      target.runs.push(run)
      for (const c of run.cells) target.cells.set(key(c), c)
    }

    const transformed: ClearWave['transformed'] = []
    const protectedCells = new Set<string>()
    for (const g of groups) {
      const maxLen = Math.max(...g.runs.map(r => r.cells.length))
      const bothDirs = g.runs.some(r => r.horizontal) && g.runs.some(r => !r.horizontal)
      let kind: PieceKind | null = null
      if (maxLen >= 5) kind = 'jackpot'
      else if (bothDirs) kind = 'diceBomb'
      else if (maxLen === 4) {
        // Perpendicular blast: a horizontal match-4 spawns a column reel.
        kind = g.runs[0].horizontal ? 'wildReelCol' : 'wildReelRow'
      }
      if (!kind) continue

      const spawnAt =
        prefer.find(p => g.cells.has(key(p))) ??
        this.intersectionOf(g.runs) ??
        g.runs[0].cells[Math.floor(g.runs[0].cells.length / 2)]
      const from = this.grid[spawnAt.row][spawnAt.col]
      if (!from) continue
      const to = this.newPiece(from.symbol, kind)
      this.grid[spawnAt.row][spawnAt.col] = to
      transformed.push({ at: spawnAt, from, to })
      protectedCells.add(key(spawnAt))
    }

    const seeds: Coord[] = []
    for (const g of groups) for (const c of g.cells.values()) seeds.push(c)
    const { cleared, events } = this.chainExpand(seeds, protectedCells)
    // Count the morphed pieces as collected too (their match consumed them).
    for (const t of transformed) cleared.push({ piece: t.from, at: t.at })
    return { cleared, transformed, events }
  }

  private intersectionOf(runs: RunMatch[]): Coord | null {
    const seen = new Set<string>()
    for (const run of runs) {
      for (const c of run.cells) {
        const k = key(c)
        if (seen.has(k)) return c
        seen.add(k)
      }
    }
    return null
  }

  /**
   * Swap-activation of specials (jackpot with anything; special + special).
   * Returns null when the swap is NOT an activation (plain pieces, or a single
   * reel/bomb swapped with a normal piece — those only fire when matched).
   * Call after the model swap; `b` is the drop cell and combo epicenter.
   */
  swapActivation(a: Coord, b: Coord): ClearWave | null {
    const pA = this.get(a)
    const pB = this.get(b)
    if (!pA || !pB) return null
    const spec = (p: Piece) => p.kind !== 'normal'
    if (pA.kind !== 'jackpot' && pB.kind !== 'jackpot' && !(spec(pA) && spec(pB))) return null

    const events: BlastEvent[] = []
    const seeds: Coord[] = [a, b]
    const strip = (p: Piece) => {
      // Consume the activating pair as plain pieces so chainExpand doesn't re-fire them.
      this.grid[a.row][a.col] = this.grid[a.row][a.col] === p ? { ...p, kind: 'normal' } : this.grid[a.row][a.col]
      this.grid[b.row][b.col] = this.grid[b.row][b.col] === p ? { ...p, kind: 'normal' } : this.grid[b.row][b.col]
    }

    if (pA.kind === 'jackpot' || pB.kind === 'jackpot') {
      const jack = pA.kind === 'jackpot' ? pA : pB
      const other = jack === pA ? pB : pA
      strip(jack)
      if (other.kind === 'jackpot') {
        // Jackpot + Jackpot: the whole board goes.
        strip(other)
        events.push({ type: 'jackpot', at: b, symbol: null })
        for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) seeds.push({ row: r, col: c })
      } else if (other.kind === 'wildReelRow' || other.kind === 'wildReelCol' || other.kind === 'diceBomb') {
        // Convert every piece of the target color into that special, detonate all.
        strip(other)
        events.push({ type: 'jackpot', at: b, symbol: other.symbol })
        const kind: PieceKind = other.kind === 'diceBomb' ? 'diceBomb' : this.rng() < 0.5 ? 'wildReelRow' : 'wildReelCol'
        for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            const p = this.grid[r][c]
            if (p && p.kind === 'normal' && p.symbol === other.symbol) {
              // Keep the piece's IDENTITY (id) — only change its kind. The view keys its sprites by
              // piece id, and chainExpand reports these same pieces back in `cleared`. Minting a
              // fresh-id piece here (newPiece) would orphan the original sprite — it never lands in
              // `cleared`, so the view never destroys it, and the next refill stacks a new piece on
              // top of the ghost (the jackpot+reel/bomb "double-stack" bug).
              this.grid[r][c] = { ...p, kind: kind === 'diceBomb' ? 'diceBomb' : this.rng() < 0.5 ? 'wildReelRow' : 'wildReelCol' }
              seeds.push({ row: r, col: c })
            }
          }
        }
      } else {
        // Jackpot + normal: everything of that symbol.
        events.push({ type: 'jackpot', at: b, symbol: other.symbol })
        for (let r = 0; r < this.rows; r++) {
          for (let c = 0; c < this.cols; c++) {
            const p = this.grid[r][c]
            if (p && p.symbol === other.symbol && p.kind !== 'jackpot') seeds.push({ row: r, col: c })
          }
        }
      }
    } else if (
      (pA.kind === 'diceBomb' && pB.kind === 'diceBomb')
    ) {
      // Bomb + Bomb: 5x5.
      strip(pA)
      strip(pB)
      events.push({ type: 'bomb', at: b, radius: 2 })
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const c = { row: b.row + dr, col: b.col + dc }
          if (this.inBounds(c)) seeds.push(c)
        }
      }
    } else if (pA.kind === 'diceBomb' || pB.kind === 'diceBomb') {
      // Reel + Bomb: three rows and three columns through the drop cell.
      strip(pA)
      strip(pB)
      events.push({ type: 'reel', at: b, horizontal: true })
      events.push({ type: 'reel', at: b, horizontal: false })
      events.push({ type: 'bomb', at: b, radius: 1 })
      for (let d = -1; d <= 1; d++) {
        for (let c = 0; c < this.cols; c++) {
          const cell = { row: b.row + d, col: c }
          if (this.inBounds(cell)) seeds.push(cell)
        }
        for (let r = 0; r < this.rows; r++) {
          const cell = { row: r, col: b.col + d }
          if (this.inBounds(cell)) seeds.push(cell)
        }
      }
    } else {
      // Reel + Reel: full cross through the drop cell.
      strip(pA)
      strip(pB)
      events.push({ type: 'reel', at: b, horizontal: true })
      events.push({ type: 'reel', at: b, horizontal: false })
      for (let c = 0; c < this.cols; c++) seeds.push({ row: b.row, col: c })
      for (let r = 0; r < this.rows; r++) seeds.push({ row: r, col: b.col })
    }

    const { cleared, events: chained } = this.chainExpand(seeds, new Set())
    events.push(...chained)
    return { cleared, transformed: [], events }
  }

  /** Flood outward from the seed cells, firing any specials hit along the way. */
  private chainExpand(
    seedCells: Coord[],
    protectedCells: Set<string>
  ): { cleared: { piece: Piece; at: Coord }[]; events: BlastEvent[] } {
    const clearedMap = new Map<string, { piece: Piece; at: Coord }>()
    const events: BlastEvent[] = []
    const queue = [...seedCells]
    while (queue.length > 0) {
      const at = queue.pop()!
      const k = key(at)
      if (clearedMap.has(k) || protectedCells.has(k) || !this.inBounds(at)) continue
      const piece = this.grid[at.row][at.col]
      if (!piece) continue
      clearedMap.set(k, { piece, at })
      switch (piece.kind) {
        case 'wildReelRow':
          events.push({ type: 'reel', at, horizontal: true })
          for (let c = 0; c < this.cols; c++) queue.push({ row: at.row, col: c })
          break
        case 'wildReelCol':
          events.push({ type: 'reel', at, horizontal: false })
          for (let r = 0; r < this.rows; r++) queue.push({ row: r, col: at.col })
          break
        case 'diceBomb':
          events.push({ type: 'bomb', at, radius: 1 })
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) queue.push({ row: at.row + dr, col: at.col + dc })
          }
          break
        case 'jackpot': {
          // Triggered by a blast: takes a random present symbol with it.
          const present = this.palette().filter(s =>
            this.grid.some(row => row.some(p => p && p.kind === 'normal' && p.symbol === s))
          )
          const symbol = present.length > 0 ? present[randInt(this.rng, present.length)] : null
          events.push({ type: 'jackpot', at, symbol })
          if (symbol) {
            for (let r = 0; r < this.rows; r++) {
              for (let c = 0; c < this.cols; c++) {
                const p = this.grid[r][c]
                if (p && p.symbol === symbol && p.kind !== 'jackpot') queue.push({ row: r, col: c })
              }
            }
          }
          break
        }
        case 'normal':
          break
      }
    }
    for (const { at } of clearedMap.values()) {
      this.grid[at.row][at.col] = null
    }
    return { cleared: [...clearedMap.values()], events }
  }

  // ------------------------------------------------------------- gravity

  /** Compact each column downward. Returns every piece that moved, for the view to tween. */
  applyGravity(): FallMove[] {
    const moves: FallMove[] = []
    for (let c = 0; c < this.cols; c++) {
      let write = this.rows - 1
      for (let r = this.rows - 1; r >= 0; r--) {
        const p = this.grid[r][c]
        if (!p) continue
        if (write !== r) {
          this.grid[write][c] = p
          this.grid[r][c] = null
          moves.push({ piece: p, from: { row: r, col: c }, to: { row: write, col: c } })
        }
        write--
      }
    }
    return moves
  }

  /** Fill remaining holes (all at column tops after gravity) with new pieces. */
  refill(): Spawn[] {
    const spawns: Spawn[] = []
    const pal = this.palette()
    for (let c = 0; c < this.cols; c++) {
      let holes = 0
      for (let r = 0; r < this.rows; r++) if (!this.grid[r][c]) holes++
      for (let r = 0; r < this.rows; r++) {
        if (this.grid[r][c]) continue
        const p = this.newPiece(pal[randInt(this.rng, pal.length)])
        this.grid[r][c] = p
        spawns.push({ piece: p, at: { row: r, col: c }, dropCells: holes })
      }
    }
    return spawns
  }

  findFirstValidMove(): { a: Coord; b: Coord } | null {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const a = { row: r, col: c }
        for (const b of [
          { row: r, col: c + 1 },
          { row: r + 1, col: c },
        ]) {
          if (this.inBounds(b) && this.wouldSwapMatch(a, b)) return { a, b }
        }
      }
    }
    return null
  }

  hasValidMove(): boolean {
    return this.findFirstValidMove() !== null
  }

  /** Turn the piece at a cell into a special (keeps its symbol) — daily-boost plants + DEV tooling. */
  plant(at: Coord, kind: PieceKind): void {
    const p = this.get(at)
    if (p) this.grid[at.row][at.col] = this.newPiece(p.symbol, kind)
  }
}

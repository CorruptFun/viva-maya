import { SYMBOLS, isMatchable, key } from './types'
import type {
  BlastEvent,
  ClearWave,
  Coord,
  FallMove,
  HazardEffects,
  Piece,
  PieceKind,
  RunMatch,
  Spawn,
  SymbolType,
} from './types'
import { randInt } from './rng'
import type { Rng } from './rng'
import type { HazardPlan } from './hazards'

/**
 * Pure board model — no Phaser imports. The scene owns sprites/tweens; this owns truth.
 *
 * Match shapes → specials (created at the swapped cell when possible):
 *   4 in a row      → Wild Reel (blasts the perpendicular line)
 *   L / T (3+3)     → Dice Bomb (3x3 blast)
 *   5+ straight     → Jackpot Chip (color bomb)
 * Any blast that hits another special chains it. Swapping two specials combos them.
 */
const NO_EFFECTS: HazardEffects = { coatsStripped: [], blockersDamaged: [], blockersBroken: [], unlocked: [] }

export class Board {
  private grid: (Piece | null)[][] = []
  private nextId = 1
  /**
   * Coat layers per cell, or null when this board has no coats. Lazily allocated so a hazard-free
   * board — every level below the first band, and every endless run — does not even hold the
   * structure, let alone pay for it.
   */
  private coats: number[][] | null = null

  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly symbolCount: number,
    private rng: Rng
  ) {
    this.regenerate()
  }

  /**
   * Fresh board: no pre-existing matches, at least one valid move.
   *
   * Specials RIDE THROUGH. A no-moves reshuffle used to hand back an all-normal board, quietly
   * confiscating any Wild Reel / Dice Bomb / Jackpot Chip the player was holding — including ones
   * bought or won from the daily spin. Only the KIND is carried over; each cell keeps whatever
   * symbol the fresh fill gave it, so the board stays match-free, and re-planting can only ADD valid
   * moves (a special never removes one), never invalidate the layout we just settled on.
   */
  regenerate(): void {
    // Hazards ride through too, for the same reason specials do: a reshuffle that confiscated the
    // blockers you had nearly broken (or the coats you had cleared around) would silently rewrite
    // the level mid-play. Only kind/locked/hp are carried — the symbol under each comes from the
    // fresh fill, so the board stays match-free.
    const keep = this.grid.flatMap((row, r) =>
      row
        .map((p, c) => ({
          at: { row: r, col: c },
          kind: p?.kind ?? ('normal' as PieceKind),
          locked: p?.locked === true,
          hp: p?.hp,
        }))
        .filter(x => x.kind !== 'normal' || x.locked)
    )
    for (let attempt = 0; attempt < 100; attempt++) {
      this.fillWithoutMatches()
      if (this.findFirstValidMove()) break
      // Statistically unreachable at 8x8 with 5-6 symbols; the last fill stands regardless.
    }
    for (const { at, kind, locked, hp } of keep) {
      if (kind !== 'normal') this.plant(at, kind)
      const p = this.grid[at.row][at.col]
      if (!p) continue
      if (locked) this.grid[at.row][at.col] = { ...p, locked: true }
      if (kind === 'blocker') this.grid[at.row][at.col] = { ...this.grid[at.row][at.col]!, hp: hp ?? 1 }
    }
  }

  // ------------------------------------------------------------- hazards

  /**
   * Lay a level's hazard plan onto a freshly generated board. Call once, right after construction;
   * nothing here is ever invoked again mid-level. That is a deliberate guarantee the rest of the
   * design leans on: because hazards are only ever removed after this point, a level gets strictly
   * easier as it proceeds and can never soft-lock behind something it just spawned.
   */
  seedHazards(plan: HazardPlan): void {
    for (const b of plan.blockers) {
      if (!this.inBounds(b)) continue
      const under = this.grid[b.row][b.col]
      this.grid[b.row][b.col] = { ...this.newPiece(under?.symbol ?? this.palette()[0], 'blocker'), hp: b.hp }
    }
    for (const l of plan.locks) {
      const p = this.inBounds(l) ? this.grid[l.row][l.col] : null
      // Never lock a blocker (it cannot be swapped anyway) — that would just be a confusing overlay.
      if (p && p.kind !== 'blocker') this.grid[l.row][l.col] = { ...p, locked: true }
    }
    if (plan.coats.length > 0) {
      this.coats = Array.from({ length: this.rows }, () => new Array<number>(this.cols).fill(0))
      for (const c of plan.coats) {
        if (this.inBounds(c)) this.coats[c.row][c.col] = c.layers
      }
    }
    // A plan can lock enough of the board to leave no legal swap. Reshuffling here (which preserves
    // every hazard, see regenerate) is far better than handing the player a dead board on move one.
    if (!this.findFirstValidMove()) this.regenerate()
  }

  /** Total coat layers still on the table — the second half of the win condition. 0 when unused. */
  coatsRemaining(): number {
    if (!this.coats) return 0
    let n = 0
    for (const row of this.coats) for (const v of row) n += v
    return n
  }

  /** Coat layers on one cell (0 when none). For the view. */
  coatAt(at: Coord): number {
    return this.coats && this.inBounds(at) ? this.coats[at.row][at.col] : 0
  }

  /**
   * Apply everything a wave's cleared cells do to the hazards, and return it for the view.
   *
   * Called from the three places a clear can originate — `matchWave`, `swapActivation` and
   * `detonate` — so every route through the game (a plain match, a special combo, a purchased
   * bomb) affects hazards identically. Destroyed blockers are appended to the wave's `cleared` by
   * the caller so the view's existing destroy path handles the sprite.
   *
   * Damage is by ORTHOGONAL ADJACENCY to a cleared cell, at most once per wave. A blast that lands
   * on a blocker is covered by the same rule, because any blast wide enough to cover the blocker
   * covers one of its neighbours too.
   */
  private applyHazardSideEffects(cleared: { piece: Piece; at: Coord }[]): HazardEffects {
    if (!this.coats && !this.hasPieceHazards()) return NO_EFFECTS

    const effects: HazardEffects = { coatsStripped: [], blockersDamaged: [], blockersBroken: [], unlocked: [] }
    const clearedKeys = new Set(cleared.map(c => key(c.at)))

    // Coats: a clear ON the cell strips one layer. Specials strip whole swathes for free, which is
    // exactly the intent — this is the mechanic that REWARDS the game's existing power pieces.
    if (this.coats) {
      for (const { at } of cleared) {
        if (!this.inBounds(at) || this.coats[at.row][at.col] <= 0) continue
        this.coats[at.row][at.col] -= 1
        effects.coatsStripped.push({ at, remaining: this.coats[at.row][at.col] })
      }
    }

    // Blockers and locks: adjacency, once per wave per cell.
    const touched = new Set<string>()
    for (const { at } of cleared) {
      for (const n of [
        { row: at.row - 1, col: at.col },
        { row: at.row + 1, col: at.col },
        { row: at.row, col: at.col - 1 },
        { row: at.row, col: at.col + 1 },
      ]) {
        const k = key(n)
        if (!this.inBounds(n) || touched.has(k) || clearedKeys.has(k)) continue
        const p = this.grid[n.row][n.col]
        if (!p) continue
        if (p.kind === 'blocker') {
          touched.add(k)
          const hp = (p.hp ?? 1) - 1
          if (hp > 0) {
            this.grid[n.row][n.col] = { ...p, hp }
            effects.blockersDamaged.push({ at: n, hp })
          } else {
            this.grid[n.row][n.col] = null
            effects.blockersBroken.push({ piece: p, at: n })
          }
        } else if (p.locked) {
          touched.add(k)
          this.grid[n.row][n.col] = { ...p, locked: false }
          effects.unlocked.push(n)
        }
      }
    }
    return effects
  }

  /**
   * The single seam where a computed wave picks up its hazard consequences. Every clear origin
   * returns through here, so there is one place to delete when the mechanic is rolled back.
   *
   * A destroyed blocker is pushed onto `cleared` so the view's existing "everything in cleared gets
   * its sprite destroyed" path handles it — no parallel sprite plumbing, and the board.test.ts
   * model/view fuzz invariant ("nothing leaves the board unreported") keeps holding.
   */
  private withHazards(wave: ClearWave): ClearWave {
    const hazards = this.applyHazardSideEffects(wave.cleared)
    if (hazards === NO_EFFECTS) return wave
    wave.cleared.push(...hazards.blockersBroken)
    wave.hazards = hazards
    return wave
  }

  /** Cheap check: does any cell carry a piece-borne hazard (blocker or lock)? */
  private hasPieceHazards(): boolean {
    for (const row of this.grid) {
      for (const p of row) if (p && (p.kind === 'blocker' || p.locked)) return true
    }
    return false
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
    // Hazards gate the swap BEFORE anything else. Routing it through here means the hint engine,
    // the reshuffle trigger and `findFirstValidMove` all respect locks and blockers for free —
    // there is exactly one definition of "can these two cells trade places".
    if (pa.kind === 'blocker' || pb.kind === 'blocker') return false
    if (pa.locked || pb.locked) return false
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
        if (!isMatchable(p)) {
          c++
          continue
        }
        let end = c + 1
        while (end < this.cols) {
          const q = this.grid[r][end]
          if (!isMatchable(q) || q.symbol !== p.symbol) break
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
        if (!isMatchable(p)) {
          r++
          continue
        }
        let end = r + 1
        while (end < this.rows) {
          const q = this.grid[end][c]
          if (!isMatchable(q) || q.symbol !== p.symbol) break
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
    // A special standing on the upgrade cell is CONSUMED by this match, so it must still detonate —
    // its blast rides along in the same wave (see below).
    const carrySeeds: Coord[] = []
    const carryEvents: BlastEvent[] = []
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
      // The upgrade cell can already hold a LIVE special — swipe a Wild Reel into a line of three and
      // it lands in a match-4, which spawns a new reel right on top of it. The upgrade cell is
      // protected from chainExpand (so the newborn survives its own wave), so overwriting blind ate
      // the old special's blast: the line never fired and the piece looked like it "survived" the
      // match, when it was really its own replacement standing there. Carry its detonation into the
      // wave first (computed while it's still on the grid — the jackpot's pick reads the board).
      if (from.kind !== 'normal') {
        const blast = this.blastOf(from, spawnAt)
        carrySeeds.push(...blast.seeds)
        carryEvents.push(...blast.events)
      }
      const to = this.newPiece(from.symbol, kind)
      this.grid[spawnAt.row][spawnAt.col] = to
      transformed.push({ at: spawnAt, from, to })
      protectedCells.add(key(spawnAt))
    }

    const seeds: Coord[] = [...carrySeeds]
    for (const g of groups) for (const c of g.cells.values()) seeds.push(c)
    const { cleared, events } = this.chainExpand(seeds, protectedCells)
    // Count the morphed pieces as collected too (their match consumed them).
    for (const t of transformed) cleared.push({ piece: t.from, at: t.at })
    // Carried blasts lead the event list so the view centres the wave on the detonation (epicenter,
    // hitstop, score popup) rather than on the quiet match that set it off.
    return this.withHazards({ cleared, transformed, events: [...carryEvents, ...events] })
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
    return this.withHazards({ cleared, transformed: [], events })
  }

  /**
   * The blast a special throws when it fires at `at`: the cells it reaches plus the event the view
   * renders. ONE definition, shared by every trigger path — chainExpand (hit by another blast) and
   * matchWave (swallowed by the match that upgrades it) — so a special detonates the same way no
   * matter what set it off.
   */
  private blastOf(piece: Piece, at: Coord): { seeds: Coord[]; events: BlastEvent[] } {
    const seeds: Coord[] = []
    switch (piece.kind) {
      case 'wildReelRow':
        for (let c = 0; c < this.cols; c++) seeds.push({ row: at.row, col: c })
        return { seeds, events: [{ type: 'reel', at, horizontal: true }] }
      case 'wildReelCol':
        for (let r = 0; r < this.rows; r++) seeds.push({ row: r, col: at.col })
        return { seeds, events: [{ type: 'reel', at, horizontal: false }] }
      case 'diceBomb':
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) seeds.push({ row: at.row + dr, col: at.col + dc })
        }
        return { seeds, events: [{ type: 'bomb', at, radius: 1 }] }
      case 'jackpot': {
        // Triggered by a blast: takes a random present symbol with it.
        const present = this.palette().filter(s =>
          this.grid.some(row => row.some(p => p && p.kind === 'normal' && p.symbol === s))
        )
        const symbol = present.length > 0 ? present[randInt(this.rng, present.length)] : null
        if (symbol) {
          for (let r = 0; r < this.rows; r++) {
            for (let c = 0; c < this.cols; c++) {
              const p = this.grid[r][c]
              if (p && p.symbol === symbol && p.kind !== 'jackpot') seeds.push({ row: r, col: c })
            }
          }
        }
        return { seeds, events: [{ type: 'jackpot', at, symbol }] }
      }
      case 'normal':
        return { seeds, events: [] }
      case 'blocker':
        // An obstacle, never an amplifier: it absorbs the hit and never propagates one. This is the
        // single most important line for cascade health — a blocker that chained would turn the one
        // mechanic that shortens chains into one that also randomises them.
        return { seeds, events: [] }
    }
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
      // Blockers are never cleared by the flood itself — they take damage from clears landing
      // ADJACENT to them (see applyHazardSideEffects), which is also what a direct blast does,
      // since any blast wide enough to cover a blocker covers a neighbour too.
      if (piece.kind === 'blocker') continue
      clearedMap.set(k, { piece, at })
      const blast = this.blastOf(piece, at)
      queue.push(...blast.seeds)
      events.push(...blast.events)
    }
    for (const { at } of clearedMap.values()) {
      this.grid[at.row][at.col] = null
    }
    return { cleared: [...clearedMap.values()], events }
  }

  // ------------------------------------------------------------- gravity

  /**
   * Rows of column `c` at which a segment ENDS, walking bottom to top: every blocker row, plus a
   * virtual boundary above row 0. A blocker never moves, so it splits its column into independent
   * gravity regions.
   *
   * This is THE cascade-preservation mechanism. The naive alternative — letting gravity compact
   * straight past a blocker — is not merely wrong, it starves the cells beneath one permanently:
   * nothing above can ever reach them, so that region of the board dies for the rest of the level
   * and chains can never run through it. Segmenting instead means a blocker costs match
   * OPPORTUNITIES without ever costing chain CONTINUITY, which is what keeps Plinko firing.
   */
  private columnBoundaries(c: number): number[] {
    const bounds: number[] = []
    for (let r = this.rows - 1; r >= 0; r--) {
      if (this.grid[r][c]?.kind === 'blocker') bounds.push(r)
    }
    bounds.push(-1) // the top of the column always closes the last segment
    return bounds
  }

  /** Compact each column segment downward. Returns every piece that moved, for the view to tween. */
  applyGravity(): FallMove[] {
    const moves: FallMove[] = []
    for (let c = 0; c < this.cols; c++) {
      let segBottom = this.rows - 1
      for (const boundary of this.columnBoundaries(c)) {
        let write = segBottom
        for (let r = segBottom; r > boundary; r--) {
          const p = this.grid[r][c]
          if (!p) continue
          if (write !== r) {
            this.grid[write][c] = p
            this.grid[r][c] = null
            moves.push({ piece: p, from: { row: r, col: c }, to: { row: write, col: c } })
          }
          write--
        }
        segBottom = boundary - 1
      }
    }
    return moves
  }

  /**
   * Fill remaining holes with new pieces. Holes sit at the top of each SEGMENT after gravity, not
   * just at the top of the column, so every segment refills — no cell is ever starved. `dropCells`
   * is measured within the segment so the view drops the piece in from just under its blocker.
   */
  refill(): Spawn[] {
    const spawns: Spawn[] = []
    const pal = this.palette()
    for (let c = 0; c < this.cols; c++) {
      let segBottom = this.rows - 1
      for (const boundary of this.columnBoundaries(c)) {
        const segTop = boundary + 1
        let holes = 0
        for (let r = segTop; r <= segBottom; r++) if (!this.grid[r][c]) holes++
        for (let r = segTop; r <= segBottom; r++) {
          if (this.grid[r][c]) continue
          const p = this.newPiece(pal[randInt(this.rng, pal.length)])
          this.grid[r][c] = p
          spawns.push({ piece: p, at: { row: r, col: c }, dropCells: holes })
        }
        segBottom = boundary - 1
      }
    }
    return spawns
  }

  // ------------------------------------------------------------- the reel pull

  /**
   * THE REEL PULL (Act II) — slide one COLUMN down a single notch, the bottom piece riding over the
   * top into row 0. Returns the moves for the view to tween, or NULL when the column refuses.
   *
   * ── DORMANT BY ABSENCE ──────────────────────────────────────────────────────────────────
   * Purely additive: nothing above calls this, so every existing path through the board — endless
   * included — behaves exactly as it did. That is the blocker precedent, and it is what lets
   * `boardpick.test.ts`'s goldens pass unmodified while a new verb ships.
   *
   * ── THE TWO REFUSALS, AND WHY THEY ARE NOT BALANCE CHOICES ──────────────────────────────
   * A column refuses when it holds a BLOCKER or a LOCKED piece, and both fall out of what those
   * things already mean rather than out of tuning:
   *   · a blocker never moves — it is not a piece in a column, it is a hole in one. `columnBoundaries`
   *     already treats it as a wall that gravity cannot cross, and a pull is gravity with an opinion.
   *   · a locked piece "still matches, but it will not move". A pull moves it. Same rule, one scale up.
   * The second one is the reason this verb makes an OLD mechanic new: from 301 a clamp stops being
   * texture and starts being a decision about which column you can still work with.
   *
   * Specials ride the wrap intact — a Wild Reel pulled off the bottom lands in row 0 still armed,
   * because a pull is a move, not a clear, and nothing here consumes anything. The caller resolves
   * the result through the ordinary wave pipeline, so a pull that lands a run cascades exactly like
   * a swap and a pull that lands nothing is simply a move spent on position.
   */
  pullColumn(col: number): FallMove[] | null {
    if (!Number.isInteger(col) || col < 0 || col >= this.cols) return null
    const column: Piece[] = []
    for (let r = 0; r < this.rows; r++) {
      const p = this.grid[r][col]
      // A hole means a wave is mid-resolve; refusing is right, and the scene never asks then anyway.
      if (!p || p.kind === 'blocker' || p.locked) return null
      column.push(p)
    }
    const moves: FallMove[] = []
    const wrapped = column[this.rows - 1]
    for (let r = this.rows - 1; r > 0; r--) {
      this.grid[r][col] = column[r - 1]
      moves.push({ piece: column[r - 1], from: { row: r - 1, col }, to: { row: r, col } })
    }
    this.grid[0][col] = wrapped
    moves.push({ piece: wrapped, from: { row: this.rows - 1, col }, to: { row: 0, col } })
    return moves
  }

  /** Would `pullColumn` succeed? The view's own question — it greys a rail handle that cannot pull. */
  canPull(col: number): boolean {
    if (!Number.isInteger(col) || col < 0 || col >= this.cols) return false
    for (let r = 0; r < this.rows; r++) {
      const p = this.grid[r][col]
      if (!p || p.kind === 'blocker' || p.locked) return false
    }
    return true
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

  /** Author a cell: become `kind`, keeping the symbol unless one is given — daily-boost plants + DEV tooling. */
  plant(at: Coord, kind: PieceKind, symbol?: SymbolType): void {
    const p = this.get(at)
    if (p) this.grid[at.row][at.col] = this.newPiece(symbol ?? p.symbol, kind)
  }

  /**
   * Detonate a (2·radius+1)² square centred on `center` — the purchased in-level bomb. No match is
   * required and no special is created; it simply seeds the blast square and floods through
   * chainExpand, so any Wild Reel / Dice Bomb / Jackpot Chip caught in the blast chains for free,
   * exactly like a matched Dice Bomb. Mutates the grid (clears the hit cells) and returns the
   * ClearWave for the view — feed it straight to the scene's resolve loop. Mirrors swapActivation's
   * shape (transformed is always empty; a leading `bomb` event drives the 3×3 detonation art).
   */
  detonate(center: Coord, radius = 1): ClearWave {
    const seeds: Coord[] = []
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        const c = { row: center.row + dr, col: center.col + dc }
        if (this.inBounds(c)) seeds.push(c)
      }
    }
    const { cleared, events } = this.chainExpand(seeds, new Set())
    return this.withHazards({ cleared, transformed: [], events: [{ type: 'bomb', at: center, radius }, ...events] })
  }
}

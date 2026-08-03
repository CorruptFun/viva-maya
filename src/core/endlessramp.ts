import { mulberry32 } from './rng'
import { seedForKey } from './endless'
import { EMPTY_PLAN } from './hazards'
import type { HazardPlan, LockCell } from './hazards'

/**
 * THE WEEK'S SHAPE — how a daily endless board gets harder, and less predictable, as the season runs.
 *
 * The race is seven boards and one season total (core/endless.ts). Before this, all seven were the
 * same shape: 30 moves, six symbols, no hazards, one seeded layout. That made the week flat — a
 * player who had the mode figured out on Monday had it figured out on Sunday, and the only thing
 * separating the seven days was which layout the seed happened to hand out.
 *
 * This ramps two things across the week, Monday → Sunday:
 *
 *   DIFFICULTY  locks climb from none to a third of the board, and the move budget tapers gently.
 *   VARIANCE    the lock COUNT is drawn from a band that WIDENS as the week runs. Monday is a fixed
 *               point; by Sunday the draw spans eight cells. So the late-week boards are not merely
 *               harder, they are less alike — what Thursday taught you about the week is worth less
 *               on Saturday than it used to be.
 *
 * ── WHY LOCKS, AND ONLY LOCKS ───────────────────────────────────────────────────────────────────
 * Of the three hazards in difficulty.ts, a lock is the only one that means anything here:
 *   · a COAT is half of a win condition ("clear every covered square"), and endless has no win
 *     condition — `finishEndless` runs when moves hit zero and the objective check at the top of the
 *     resolve is behind `!this.endless`. A coat in endless is an overlay that does nothing.
 *   · a BLOCKER is switched off game-wide (`DIFFICULTY.hazards.blocker === false`) and is the sharp
 *     instrument besides — 10x a lock per cell, superlinear, and capped at 6 for numbered levels
 *     with a 60-90 move budget. On a 30-move score attack it would not add difficulty so much as
 *     delete the run.
 *   · a LOCK still MATCHES and still SCORES; it just cannot be SWAPPED until an adjacent clear frees
 *     it. That is exactly the right tax for a score attack: it removes moves from the legal set
 *     without removing points from the board, so a good player routes around it and a careless one
 *     stalls. It is also self-clearing, so its bite is front-loaded and never strands a late run.
 *
 * ── WHY THE MOVE TAPER IS SO SMALL ──────────────────────────────────────────────────────────────
 * Score in this mode is close to linear in moves, so the budget is a CEILING control, not a
 * difficulty control. Cutting Sunday to 25 would not stump anyone — it would just make Sunday worth
 * less, and since the season is the SUM of seven daily bests, a uniformly lower Sunday hands the
 * week to whoever played Monday. That inverts the whole point. So the taper is 30 → 28 (a shade
 * under 7%), enough to be felt at the end of a run and far too small to decide the season, and the
 * locks do the actual work.
 *
 * ── THE FAIRNESS CONTRACT IS UNTOUCHED ──────────────────────────────────────────────────────────
 * Everything here is a pure function of the DAY KEY. Same day → same shape → same lock count → same
 * lock cells, for every player on earth, exactly as the board seed already was. Nothing is drawn
 * per-run or per-device. "Harder and more varied across the week" never becomes "different for you
 * than for me".
 */

/** The move budget on the week's opening board — the number every other day is expressed against. */
export const ENDLESS_BASE_MOVES = 30

/**
 * One day's shape. `lockLo`/`lockHi` are the BAND the day's lock count is drawn from; `locks` on
 * `EndlessShape` is the draw itself.
 */
interface DayRamp {
  /** Short name, for the HUD chip and for test output. */
  label: string
  moves: number
  lockLo: number
  lockHi: number
}

/**
 * Monday → Sunday. Indexed by `endlessWeekdayIndex`.
 *
 * Monday is DELIBERATELY the untouched board — 30 moves, zero locks, byte-identical to what every
 * day was before this file existed. The week has to open with an invitation, and a player meeting
 * the race for the first time should meet the version that is easiest to read. It is also the
 * control: if the ramp is ever wrong, Monday still says what the mode is supposed to feel like.
 *
 * The band WIDTH (lockHi − lockLo) is the variance ramp and runs 0 · 2 · 2 · 4 · 4 · 6 · 8. The
 * widening is the point — see the header. Lock counts stay inside the range difficulty.ts already
 * measures for numbered levels (3 → 12 cells on this same 64-cell board), so the top of Sunday's
 * band is the top of a tested range rather than a new regime.
 */
const WEEK: readonly DayRamp[] = [
  { label: 'OPENING', moves: 30, lockLo: 0, lockHi: 0 },
  { label: 'WARMING', moves: 30, lockLo: 1, lockHi: 3 },
  { label: 'MIDWEEK', moves: 30, lockLo: 3, lockHi: 5 },
  { label: 'TIGHTENING', moves: 29, lockLo: 4, lockHi: 8 },
  { label: 'PRESSURE', moves: 29, lockLo: 6, lockHi: 10 },
  { label: 'HEAT', moves: 28, lockLo: 7, lockHi: 13 },
  { label: 'FINALE', moves: 28, lockLo: 8, lockHi: 16 },
]

/** The shape of one day's board, resolved. */
export interface EndlessShape {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number
  label: string
  moves: number
  /** Cells locked on this board — the draw from the day's band. */
  locks: number
  /** 0..1, how far through the week — for a view that wants to paint the ramp. */
  intensity: number
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Monday-indexed weekday of a day key (0 = Mon … 6 = Sun), or null for a malformed key.
 *
 * Pure calendar math on the KEY, parsed as UTC — the key is already a RACE_TZ calendar date by the
 * time it gets here (core/endless.ts `dayKey`), so re-interpreting it in any local zone would be the
 * 2026-07-26 bug all over again. Matches `isoWeekOf`'s Monday-first convention, so the ramp and the
 * season boundary agree: the week's hardest board is always the last one before the totals reset.
 */
export function endlessWeekdayIndex(day: string): number | null {
  if (!DAY_RE.test(day)) return null
  const t = Date.parse(`${day}T00:00:00Z`)
  if (Number.isNaN(t)) return null
  return (new Date(t).getUTCDay() + 6) % 7
}

/**
 * An RNG for this day's SHAPE, deliberately independent of the board's own stream.
 *
 * This is the determinism trap hazards.ts warns about, in its endless form. `endlessRngForDay` is
 * consumed by the board fill; drawing the lock count or the lock cells from that same stream would
 * advance it, so seeding hazards would silently change the LAYOUT underneath them — and the layout
 * is the thing every player is supposed to share. A separate stream keeps the two orthogonal: the
 * board is what it always was, and the locks land on top of it.
 */
function shapeRng(day: string): () => number {
  return mulberry32((seedForKey(day) ^ 0x7a1c0de5) >>> 0)
}

/** How many of `n` a uniform draw takes, inclusive of both ends. */
const drawInt = (rng: () => number, lo: number, hi: number): number =>
  hi <= lo ? lo : lo + Math.floor(rng() * (hi - lo + 1))

/**
 * The shape of `day`'s board. Pure, deterministic, and the single definition of the week's ramp —
 * GameScene reads it for the move budget, `endlessLockPlan` reads it for the lock count, and the
 * sim reads it so the economy guards keep describing the board the game actually deals.
 *
 * A malformed key falls back to Monday rather than throwing: a corrupt day key should hand out the
 * gentlest, most legible board, never crash a run that is already in progress.
 */
export function endlessShapeFor(day: string): EndlessShape {
  const wd = endlessWeekdayIndex(day) ?? 0
  const ramp = WEEK[wd]
  return {
    weekday: wd,
    label: ramp.label,
    moves: ramp.moves,
    locks: drawInt(shapeRng(day), ramp.lockLo, ramp.lockHi),
    intensity: wd / (WEEK.length - 1),
  }
}

/**
 * The week's endpoints, for copy that has to describe the ramp without hard-coding it.
 *
 * The help screen's rule (view/leaderboardpanel.ts) is that every player-visible number is READ FROM
 * THE CONSTANT rather than typed as a literal, because that copy is exactly what rots when a budget
 * is retuned. The budget is no longer ONE number, so this exposes the two ends of it instead.
 */
export function endlessWeekBounds(): { openMoves: number; finaleMoves: number; maxLocks: number } {
  return {
    openMoves: WEEK[0].moves,
    finaleMoves: WEEK[WEEK.length - 1].moves,
    maxLocks: WEEK[WEEK.length - 1].lockHi,
  }
}

/**
 * The lock layout for `day` — the hazard plan GameScene seeds onto the endless board.
 *
 * Row 0 is excluded for the reason `caps.forbiddenBlockerRows` excludes it on numbered levels: it is
 * where refills enter. A lock there is cleared and re-entered constantly and reads as a flicker
 * rather than an obstacle.
 *
 * Coats and blockers are always empty here — see the header for why neither belongs in this mode.
 */
export function endlessLockPlan(day: string, rows: number, cols: number): HazardPlan {
  const shape = endlessShapeFor(day)
  if (shape.locks <= 0) return EMPTY_PLAN

  // Drawn from a stream FORKED off the shape's, not the shape's itself — so the count and the
  // placement stay independent, and a future tweak to one cannot silently reshuffle the other.
  const rng = mulberry32((seedForKey(day) ^ 0x10c4ce11) >>> 0)
  const pool: LockCell[] = []
  for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) pool.push({ row: r, col: c })

  const locks: LockCell[] = []
  const want = Math.min(shape.locks, pool.length)
  for (let i = 0; i < want; i++) locks.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])

  return { coats: [], blockers: [], locks }
}

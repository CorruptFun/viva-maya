import { DIFFICULTY } from './difficulty'
import type { LevelSpec } from './types'

/**
 * ACT II — THE HIGH-ROLLER FLOORS. Pure logic, no Phaser, no view imports; the appearance half
 * (floor accents, ambiance tints, hazard skins, croupier voice) lives in `view/floormood.ts` under
 * the same split `view/hazardskins.ts` keeps: core names a floor, the view dresses it.
 *
 * ── WHY THERE IS A MODULE AT ALL ────────────────────────────────────────────────────────────
 * The difficulty curve is EXHAUSTED at 300 — the collect ratio is within 5% of its 3.7 cap,
 * `perObjective` clamps around L378, every hazard ramp in `hazards.ts` hard-codes 300 as its
 * horizon and flatlines above it, and the sim's win margin is already sitting on its ~20% humane
 * floor through the 270s. So Act II cannot come from bigger numbers; it comes from a new AXIS. The
 * first one is THE REEL PULL (below), and this module is where every "levels above 300 behave
 * differently" rule is written down so `levels.ts` keeps reading as one curve rather than two.
 *
 * ── THE FLATLINE IS DELIBERATE ──────────────────────────────────────────────────────────────
 * `densityFor` ramps hazards toward L300 and `clamp01` pins everything above it at the L300
 * densities, so a floor-1 board carries exactly a L300 board's felt, lockboxes and clamps. That is
 * the intended slice-1 shape, not an oversight: F1 is the TEACHING floor for a new verb, and
 * stacking a fresh hazard ramp on top of a fresh mechanic is how you get an unplayable teaching
 * level. New ramps arrive with the floors that need them.
 *
 * ── DORMANT BY ABSENCE ──────────────────────────────────────────────────────────────────────
 * Everything here keys off a level NUMBER, and endless has none — it never calls `levelSpec`, and
 * `Board.pullColumn` is an additive operation nothing on the endless path invokes. The weekly race
 * is a same-board-for-everyone contract; `boardpick.test.ts`'s goldens are the tripwire, and they
 * must pass unmodified on every commit in this act.
 */

/**
 * First numbered level of Act II. The same switch as `levels.ts`'s `ACT1_LEVELS` seen from the
 * other side — kept here (rather than imported) so this module stays free of a cycle with
 * `levels.ts`, which imports IT. `actII.test.ts` asserts the two agree.
 */
export const ACT2_FROM = 301

/** Levels per FLOOR — five chapters. The unit Act II is authored, named and dressed in. */
export const FLOOR_LEVELS = 50

/** One floor of the high-roller tower. Name and ranges only — the LOOK lives in `view/floormood.ts`. */
export interface Floor {
  /** 1-based floor number within Act II. */
  floor: number
  /** ALL-CAPS display name, without the `FLOOR N ·` prefix the nameplates add. */
  name: string
  /** First and last numbered level on this floor. */
  from: number
  to: number
  /** First and last 1-based CHAPTER on this floor (five of them, `CHAPTER_LEVELS` frozen at 10). */
  chapterFrom: number
  chapterTo: number
}

/**
 * The floors that EXIST. Two of six: the act is designed to 600 but ships a floor pair per slice,
 * because a floor is only real once its levels, trophies and showroom plinths land in the same
 * tree — a `claimChapter` that outruns the catalogue is the one failure mode a staged rollout must
 * never have. Adding a floor means bumping `LEVEL_COUNT`, extending `TROPHIES`/`CHAPTER_PURSES`
 * and adding a mood, all together.
 */
export const FLOORS: readonly Floor[] = [
  { floor: 1, name: 'THE HIGH-LIMIT ROOM', from: 301, to: 350, chapterFrom: 31, chapterTo: 35 },
  { floor: 2, name: 'THE SPEAKEASY', from: 351, to: 400, chapterFrom: 36, chapterTo: 40 },
]

/** Is the act live at all? The master switch; every helper below answers `false`/`null` when it is off. */
export function act2Live(): boolean {
  return DIFFICULTY.act2.enabled
}

/** True for a numbered level on a shipped Act II floor. False for everything in Act I, and for endless (never numbered). */
export function isAct2Level(level: number): boolean {
  return act2Live() && Number.isFinite(level) && level >= ACT2_FROM && level <= FLOORS[FLOORS.length - 1].to
}

/** The floor a numbered level sits on, or null in Act I / off the shipped tower / with the act switched off. */
export function floorFor(level: number): Floor | null {
  if (!isAct2Level(level)) return null
  return FLOORS.find(f => level >= f.from && level <= f.to) ?? null
}

/** The floor a 1-based CHAPTER belongs to — what LevelSelect's nameplates and the showroom wing read. */
export function floorForChapter(chapter: number): Floor | null {
  if (!act2Live() || !Number.isFinite(chapter)) return null
  return FLOORS.find(f => chapter >= f.chapterFrom && chapter <= f.chapterTo) ?? null
}

/** True on the level that OPENS a floor — the one that earns the floor-door card and the `floor_enter` event. */
export function isFloorOpening(level: number): boolean {
  const f = floorFor(level)
  return f !== null && f.from === level
}

// ─────────────────────────────────────────────────────────────────────────────
// THE REEL PULL — Act II's first new verb.
//
// A chrome slot arm beside the board pulls one COLUMN a single notch downward; the piece at the
// bottom rides over the top and lands in row 0. It costs a move and resolves through the ordinary
// wave pipeline, so a pull that lands a run cascades exactly like a swap.
//
// The strategic point is that a pull with NO match is still a legal move: it is repositioning, and
// paying a move for position is the trade the verb exists to sell. That is also why it is capped by
// nothing but the move budget — an allowance would turn a strategic tool into a resource to hoard,
// and `splitPendingBoosts`' lesson is that a second inventory is a second thing to keep in sync.
//
// One refusal, derived from the mechanic rather than chosen for balance (see `Board.pullColumn`): a
// column holding a BLOCKER will not pull, because a blocker is the one piece that never moves at all
// — segment gravity already treats it as a wall. That single rule is what gives the verb its shape
// up here: at 301 five of the eight columns are blocked, and they open as the lockboxes break, so
// "which column can I still work with" is a live question that answers itself as the level goes on.
// ⚠️ Clamped pieces RIDE the pull. Refusing them read well and measured terribly — see pullColumn.
// ─────────────────────────────────────────────────────────────────────────────

/** First level carrying the rail. Its own constant so the band can move without touching the act. */
export const PULL_FROM = DIFFICULTY.act2.pullStart

/** True when this numbered level's board should carry the slot-arm rail. */
export function pullLevel(level: number): boolean {
  const { act2 } = DIFFICULTY
  return act2.enabled && act2.pull && Number.isFinite(level) && level >= act2.pullStart
}

/**
 * Fold Act II's additions into a finished Act I spec. Returns `base` UNTOUCHED for every Act I
 * level and whenever the act is switched off — which is what keeps `levels.test.ts`'s panic-switch
 * transcription honest over the whole 1..LEVEL_COUNT range: with the act off, levels 301–400 are
 * the plain extended formula and nothing else.
 *
 * Deliberately additive-only. It never rewrites `moves`, `objectives` or `scoreTarget`: the move
 * budget for an Act II level is the same curve Act I ends on (plus the ordinary teaching bonus at
 * `PULL_FROM`, granted by `isTeachingLevel` inside `levelSpec` like every other band start), and
 * the plaque ladder continues through `minimumTargetFrac`. Everything Act II asks EXTRA for comes
 * from the new verb and the floors, not from a tighter number.
 */
export function act2Spec(level: number, base: LevelSpec): LevelSpec {
  if (!pullLevel(level)) return base
  return { ...base, pull: true }
}

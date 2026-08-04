import { SYMBOLS } from './types'
import type { LevelSpec, SymbolType } from './types'
import { mulberry32, randInt } from './rng'
import { DIFFICULTY, isTeachingLevel } from './difficulty'

export const LEVEL_COUNT = 300

/**
 * Levels per CHAPTER — the decade grouping the level map draws (ribbons every ten) and the win flow
 * celebrates (milestone splash on every `% CHAPTER_LEVELS === 0` clear). Promoted here from
 * LevelSelectScene so core code (trophies, chapter rewards) and the scenes read ONE constant; the
 * scene previously owned a private copy while GameScene hard-coded the same 10 as a bare literal.
 * LevelSelect's layout leans on 10 = exactly two 5-wide grid rows — change this and the chapter
 * ribbon math changes with it.
 */
export const CHAPTER_LEVELS = 10
/** How many chapters the 300 levels make — 30. The trophy showroom has exactly this many plinths. */
export const CHAPTER_COUNT = LEVEL_COUNT / CHAPTER_LEVELS

/**
 * Deterministic difficulty curve: level N always has the same goals/moves (seeded off N), but
 * every attempt plays on a fresh random board. Designed as a SMOOTH, progressively-harder ramp
 * across all 300 levels — no early plateau — anchored so the early game keeps its current feel
 * (new L10 ≈ old L10: 3 objectives × 32 = 96 collects, ~34 moves).
 *
 * The three levers, all ramped smoothly with no early caps:
 *
 *  • symbolCount — 5 for the first onboarding levels, then the full 6-symbol SYMBOLS palette.
 *    (6 is the hard cap: there are only 6 symbol textures; more distinct symbols = harder matching.)
 *
 *  • objectiveCount — 1 (L1–2) → 2 (L3–7) → 3 (L8+). Held at 3: with a 6-symbol palette, a 4th
 *    goal would leave the HUD's objective row (3 chips wide) no room and is unnecessary — the
 *    collect-count + move-pressure levers carry the late-game difficulty.
 *
 *  • perObjective — a concave power curve (≈15 → 32 → 102 at L1 → L10 → L300). Rises smoothly the
 *    whole way with no early cap; the high clamp (110) is never reached inside 1–300. This is the
 *    "levels keep getting bigger" lever: L300 is meaningfully larger than L100, which beats L30.
 *
 * The true difficulty knob is the COLLECT RATIO = (total collects ÷ moves). moves is derived from a
 * density-aware target ratio so the ratio itself is the thing we ramp smoothly. Crucially, the
 * ratio a player can sustain depends on how many of the 6 symbols are goals (objective density):
 * with only 2 of 6 symbols wanted, most natural matches are wasted, so 1-/2-objective levels
 * tolerate only a LOW ratio; the 3-objective phase steps up and carries the main climb. Ratios:
 *
 *    1 objective  → 0.50                       (generous onboarding)
 *    2 objectives → 1.15 → 1.63  (L3 → L7)     (gentle climb)
 *    3 objectives → ~2.8 → ~3.44 (L8 → L300)   (eased-in onset, then a slow log creep, cap 3.5)
 *
 * This replaces the old model whose three caps (perObjective≤45 by ~L16, moves floored at 14 by
 * ~L24, objectiveCount≤3 by L8) made every level past ~L24 identical — the plateau this fixes.
 *
 * Feasibility: verified with a headless simulator that plays the real board core with an
 * objective-aware move policy (a conservative human proxy — deliberately weaker than an engaged
 * player). Across 1–300 (dense sample incl. every one of the last 50) it clears every level, with
 * the win-margin shrinking smoothly as the level rises — ~100% at L1, ~56% at L10, tapering to a
 * ~17–27% floor in the 200s–300 where wins still finish with moves to spare. Since a real player
 * (planning cascades, banking specials onto goal colours) far outperforms that proxy, every level
 * is comfortably winnable, hardest at L300.
 */
/** Last level of the protected early game — everything at or below this is untouched by the retune. */
const PROTECTED_TO = DIFFICULTY.bands.lockStart - 1

/**
 * The 3-objective ratio exactly as the original curve left it at `PROTECTED_TO`. The post-band
 * branch starts here rather than at a bare 3.0, so the seam can never step DOWN. Frozen by
 * `levels.test.ts` ("does not dip at the seam").
 */
const RATIO_AT_SEAM = 3.0 + 0.27 * Math.log(1 + (PROTECTED_TO - 8) / 52)

export function levelSpec(level: number): LevelSpec {
  const L = level
  const rng = mulberry32((0xc0ffee ^ Math.imul(L, 2654435761)) >>> 0)

  // 5 symbols early keeps matches flowing; the 6th tightens the board from level 4.
  const symbolCount = L < 4 ? 5 : 6
  const objectiveCount = L < 3 ? 1 : L < 8 ? 2 : 3

  // Collect target per objective: concave growth, no early cap (clamp is a far-off safety rail).
  const perObjective = Math.min(110, Math.max(12, Math.round(32 * Math.pow(L / 10, 0.34))))
  const total = perObjective * objectiveCount

  // Density-aware target collect ratio → move budget.
  const legacyCurve = !DIFFICULTY.curve.enabled || L <= PROTECTED_TO
  let ratio: number
  if (objectiveCount === 1) {
    ratio = 0.5
  } else if (objectiveCount === 2) {
    ratio = 1.15 + 0.12 * (L - 3) // L3..L7 → 1.15..1.63
  } else if (legacyCurve) {
    // Ease the 3-objective onset (L8..L11) so the 2→3 step isn't a spike, then a slow log creep
    // toward a 3.5 ceiling — the smooth main climb that never plateaus.
    const onsetEase = 0.14 * Math.max(0, Math.min(1, (11 - L) / 3))
    ratio = Math.min(3.5, 3.0 - onsetEase + 0.27 * Math.log(1 + Math.max(0, L - 8) / 52))
  } else {
    // ANCHORED at the seam value, never rebased to 3.0. Starting the new branch from a bare 3.0
    // would put L31 BELOW L30 (3.016 vs 3.095) — reintroducing the exact "next level is easier"
    // defect this retune exists to remove, right at the moment hazards first appear.
    ratio = Math.min(3.7, RATIO_AT_SEAM + 0.2 * Math.log(1 + (L - PROTECTED_TO) / 38))
  }

  // Breather cadence. Below the protected band (and whenever the retune is switched off) this stays
  // the original +2 moves every 5th level. ABOVE it the +2 is gone: it was a 4-5% difficulty DIP,
  // larger than the trend gain over the surrounding 15-25 levels, and it made 31% of levels easier
  // than their predecessor — the noise drowned the signal. The breather still exists up there, but
  // as a visibly lighter table (see DIFFICULTY.breatherHazardScale) rather than an invisible +2.
  const breather = legacyCurve && L % 5 === 0 ? 2 : 0
  // The level that introduces a mechanic is taught gently. Gated on both switches so that turning
  // the curve off restores the pre-overhaul budget exactly, and turning hazards off leaves nothing
  // to teach.
  const teaching =
    DIFFICULTY.curve.enabled && DIFFICULTY.hazards.enabled && isTeachingLevel(L)
      ? DIFFICULTY.teachingLevelBonusMoves
      : 0
  // A hard feasibility floor keeps the budget above the point where even a flawless clear
  // (~6 collects/move) couldn't finish.
  let moves = Math.round(total / ratio) + breather + teaching
  moves = Math.max(moves, Math.ceil(total / 6.2) + objectiveCount)

  // Distinct goal symbols, chosen deterministically per level (variety; feasibility is symbol-
  // agnostic since the board fills uniformly from the palette).
  const pool: SymbolType[] = [...SYMBOLS.slice(0, symbolCount)]
  const objectives = []
  for (let i = 0; i < objectiveCount; i++) {
    const pick = randInt(rng, pool.length)
    objectives.push({ symbol: pool[pick], count: perObjective })
    pool.splice(pick, 1)
  }

  return { level: L, moves, symbolCount, objectives }
}

/**
 * §G3 · what a 3★ / 2★ clear is graded against, as a COLLECT RATE (goal pieces per move) rather
 * than a fixed slice of the move budget.
 *
 * The bug this replaces: stars were graded on a constant `movesLeft / moves >= 0.5` while the curve
 * above ramps the REQUIRED ratio from 2.94 to 3.52 collects/move. A fixed half-budget bar therefore
 * silently means "sustain 2× the level's own required rate" — 5.87/mv at L30, 7.03/mv at L300 —
 * while line 105 right above declares ~6.2/mv to be a FLAWLESS clear. So from L32 the top grade
 * asked for more than this file's own definition of perfect play, and 3★ stopped existing. It was
 * invisible because star records are stored best-of and the early levels (where the bar is
 * reachable) are the ones people replay.
 *
 * Calibrated against `sim.ts`'s headless proxy, which is a deliberately WEAK player (no lookahead
 * past the opening wave): across L15–L300 it sustains ~3.2–3.5 collects/move and peaks near 4.7 on
 * its best seeds. So 3★ at 4.7 is "beat the proxy's best run", and 2★ at 4.0 is "clearly beat its
 * average" — a real mastery bar that a thinking player can actually hit, at every level.
 *
 * The clamps preserve the early game exactly: below ~L8 the required ratio is so low that both
 * formulas exceed the old constants, so they clamp to today's 0.5 / 0.25 and L1–L7 grade unchanged.
 */
const RATE_3 = 4.7
const RATE_2 = 4.0

export function starThresholds(spec: LevelSpec): { three: number; two: number } {
  const total = spec.objectives.reduce((n, o) => n + o.count, 0)
  const req = total / Math.max(1, spec.moves)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  return {
    three: clamp(1 - req / RATE_3, 0.08, 0.5),
    two: clamp(1 - req / RATE_2, 0.04, 0.25),
  }
}

/** Stars for a clear that finished with `earnedLeftover` of its own (unbought) moves unspent. */
export function starsFor(spec: LevelSpec, earnedLeftover: number): 1 | 2 | 3 {
  const frac = Math.max(0, earnedLeftover) / Math.max(1, spec.moves)
  const t = starThresholds(spec)
  return frac >= t.three ? 3 : frac >= t.two ? 2 : 1
}

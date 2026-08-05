import { SYMBOLS } from './types'
import type { BoostType, LevelSpec, SymbolType } from './types'
import { mulberry32, randInt } from './rng'
import { DIFFICULTY, isTeachingLevel } from './difficulty'
import { act2Spec } from './actII'

/**
 * The last level of ACT I — THE MAIN FLOOR. Not the same thing as `LEVEL_COUNT`, and the difference
 * is the whole point of this pair.
 *
 * `LEVEL_COUNT` is how far the ladder currently REACHES; `ACT1_LEVELS` is where the campaign's first
 * story ENDS. Chapter 30's car ceremony, the ALL CLEAR finale and the "★ 300 LEVELS ★" tally all
 * belong to the second number and must never drift with the first — an act finale that re-fires
 * every time the ladder grows is a grand prize that means nothing. Anything that means "the end of
 * the list" (PLAY's target, the Store/Slot clamps, LevelSelect's frontier and recall) keeps reading
 * `LEVEL_COUNT` and self-heals.
 */
export const ACT1_LEVELS = 300

/**
 * How far the ladder reaches today. ACT II — THE HIGH-ROLLER FLOORS opens at `ACT1_LEVELS + 1` and
 * is designed to 600; it ships a floor pair per slice (`core/actII.ts` FLOORS).
 *
 * ⚠️ CLIENT-ATOMIC. Raising this is never a one-line change: `CHAPTER_COUNT` derives from it, and
 * `claimChapter` will hand out a chapter this number makes reachable. So the trophy catalogue, the
 * purse ladder and the showroom's wing for those chapters must land in the SAME tree — a cached PWA
 * client running yesterday's bundle is fine (it simply never offers the new levels), but a client
 * whose LEVEL_COUNT outran its catalogue would claim a trophy that does not exist.
 * `trophies.test.ts` pins `TROPHIES.length === CHAPTER_COUNT` precisely so a lone bump goes red.
 */
export const LEVEL_COUNT = 400

/**
 * Levels per CHAPTER — the decade grouping the level map draws (ribbons every ten) and the win flow
 * celebrates (milestone splash on every `% CHAPTER_LEVELS === 0` clear). Promoted here from
 * LevelSelectScene so core code (trophies, chapter rewards) and the scenes read ONE constant; the
 * scene previously owned a private copy while GameScene hard-coded the same 10 as a bare literal.
 * LevelSelect's layout leans on 10 = exactly two 5-wide grid rows — change this and the chapter
 * ribbon math changes with it.
 */
export const CHAPTER_LEVELS = 10
/** How many chapters the ladder makes — 40 today. The showroom has exactly this many plinths, split
 *  across its wings (Act I's thirty, then a floor's five per Act II chapter band). Derived, so a
 *  `LEVEL_COUNT` bump moves it automatically — which is exactly why the catalogues have to move with
 *  it in the same commit (see the LEVEL_COUNT note above). */
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

/**
 * HOUSE MINIMUM — the third goal archetype (Slice 0, 2026-08-04). From
 * `DIFFICULTY.goals.minimumStart`, levels on a fixed cadence carry a brass score plaque as a
 * second win term: collect the goals, sweep the felt, AND beat the number. The cadence is
 * L % 10 ∈ {1, 6} — two per decade, never an every-5th breather, never a chapter-closing 10th —
 * and the band start itself (…01) is the teaching level.
 */
export function isMinimumLevel(level: number): boolean {
  const { goals } = DIFFICULTY
  return goals.minimum && level >= goals.minimumStart && (level % 10 === 1 || level % 10 === 6)
}

/**
 * AFTER DARK — POINTS NIGHT (Slice 3). The plaque's PURE FORM: a minimum level with its collect
 * goals taken away, so the brass number (plus the felt) is the whole win condition.
 *
 * It runs on the `…6` half of the shipped plaque cadence from `pointsStart`, which is why the band
 * begins at 216 rather than the round 211 the fiction would have picked — 211 is a `…1`, and
 * splitting one cadence across two ideas would have made both unreadable. The `…1` half stays an
 * ordinary HOUSE MINIMUM all the way up, so the band reads as one idea escalating.
 */
export function isPointsNight(level: number): boolean {
  const { afterDark } = DIFFICULTY
  // Gated on the PLAQUE, not merely on the cadence. This is the plaque's pure form, so switching
  // HOUSE MINIMUM off must take points nights with it — otherwise `goals.minimum = false` would
  // deal a level with no collect goals AND no score target, which is not a level at all.
  return (
    isMinimumLevel(level) &&
    afterDark.enabled &&
    afterDark.points &&
    level >= afterDark.pointsStart &&
    level <= ACT1_LEVELS &&
    level % 10 === 6
  )
}

/**
 * AFTER DARK — HOT TABLE (Slice 3). The cascade multiplier opens at ×2 (`cascade + 1` in the wave
 * score) against a `HOT_TABLE_MOVE_TRIM` budget. Hotter, shorter, riskier — and made of two numbers
 * that already existed, which is the whole rule this band is built under.
 *
 * `…3` is disjoint from the plaque cadence `…1`/`…6` by construction, and from the every-5th
 * breathers and the chapter-closing `…0`, so a hot table can never be anything else as well.
 */
export function isHotTable(level: number): boolean {
  const { afterDark } = DIFFICULTY
  return (
    afterDark.enabled && afterDark.hot && level >= afterDark.hotStart && level <= ACT1_LEVELS && level % 10 === 3
  )
}

/**
 * ⚠️ THERE IS NO MOVE TRIM ON A HOT TABLE, and that is a MEASURED reversal of how it was specced
 * ("~10% trimmed move budget — hotter, shorter, riskier"). Written down here because the idea is an
 * obvious one to have again.
 *
 * Two measurements killed it (banker, 40 seeds, 2026-08-05).
 *
 * 1 · THE LATE BAND CANNOT AFFORD IT. Clear rate against moves given back, from the untrimmed budget:
 *
 *        level      base   −0    −1    −2    −4    −8
 *        233         84   40%   40%   33%   23%    8%
 *        253         83   23%   23%   20%   15%    5%
 *        273         86   25%   23%   20%   20%    8%
 *        293         86   33%   33%   30%   28%   23%
 *
 *    The specced 10% is the −8 column: a FIVE-FOLD collapse. Even −2 costs ~13% of the clear rate.
 *    Up here the marginal move is worth far more than a percentage of the budget suggests.
 *
 * 2 · THE MULTIPLIER CANNOT PAY FOR IT, because a hot table is a COLLECT level. Doubling the wave
 *    score moves the score and nothing else: the win condition is goals plus felt, the chip reward
 *    is star- and move-based, and there is no plaque on a `…3`. Measured, the multiplier lifts the
 *    mean score 16,050 → 25,093 at L233 and the clear rate 40% → 8%. That is paying real difficulty
 *    for a number — and it would make AFTER DARK the one band in Act I that punishes you for
 *    arriving, against the act's standing "a level only ever gets easier".
 *
 * So the beat ships as PURE UPSIDE: the table runs hot, the numbers run hot with it, a personal best
 * jumps, and a Plinko drop that lands here pays on a doubled stake. The House is having a good night
 * and letting you have one too — which is a better read of "the tables keep odd hours" than a tax
 * was. If a future slice wants the risk back, it has to bring something score ACTUALLY BUYS with it.
 */

/**
 * Banker-proxy points scored per MOVE on a POINTS NIGHT board — the anchor the pure plaque is priced
 * against, and deliberately NOT `MINIMUM_POINTS_PER_GOAL`.
 *
 * With no collect goals the proxy's `goalValue` term is zero, so the banker collapses to a
 * points-and-coats chaser (the same collapse `playEndless` documents) — which is, for once, the
 * RIGHT player model: a points night asks for points, so the proxy finally wants what the level
 * wants. It also means the usual proxy-bias caveat is weaker here than anywhere else in this file.
 *
 * MEASURED 2026-08-05, banker, 40 seeds, full budget forced:
 *
 *     level     216    226    236    246    256    266    276    286    296
 *     pts/move  178    180    191    185    182    183    185    186    173
 *
 * Remarkably flat, and within a few percent of the ~186–202 the ORDINARY plaque levels post — the
 * proxy plays a points night almost exactly as it plays its sibling, because `previewValue` already
 * weights raw clear size far above goal symbols. A real player, freed from chasing two colours, does
 * strictly better, so this anchor is a floor.
 *
 * ⚠️ "Full budget FORCED" is load-bearing and is not how the plaque is measured. `minimum.rate.ts`
 * strips the target to observe a natural run; do that here and the win condition collapses to "sweep
 * the felt", the sim stops with half its moves unspent, and the measured score comes out ~40% low
 * (8,300 against 14,600 at L216 — the first attempt at this calibration, caught by the numbers being
 * absurd next to the siblings'). An UNREACHABLE target is what makes the proxy spend the budget.
 */
export const POINTS_NIGHT_POINTS_PER_MOVE = 183

/**
 * The pure plaque's demand as a fraction of what a full-budget proxy run scores. Same shape as
 * `minimumTargetFrac` and the same philosophy — free where the idea is introduced, real by the top
 * of the band — but its own numbers, and a GENTLER ladder than the plaque's, deliberately.
 *
 * The plaque can afford to ask for more than the proxy scores (L291 posts 18,400 against a 16,000
 * full-budget mean) because it is the SECOND win term: a player who finishes the collects has
 * usually scored past it on the way. Here it is the only term there is. A points night priced at
 * the plaque's aggression would be the hardest level in Act I, which would break both the band's
 * brief (seasoning, not a wall) and Act I's own "a level only ever gets easier" invariant.
 *
 * So the ramp lands the proxy's bind rate at roughly 5% on the teaching level and ~25% by 296 —
 * measured in `minimum.rate.test.ts`, which re-derives it and guards BOTH directions: a plaque that
 * never binds is decoration, one that always binds is a wall.
 */
export function pointsNightTargetFrac(level: number): number {
  const start = DIFFICULTY.afterDark.pointsStart
  // The teaching level exists to introduce the shape, not to enforce it — the same courtesy L201
  // gets from `minimumTargetFrac`'s own early return, and comfortably under the proxy's p10.
  if (level === start) return 0.65
  // ⚠️ ACT1_LEVELS, never LEVEL_COUNT — the same rule the plaque ramp carries. Points nights cannot
  // exist above 300 today (`isPointsNight` caps them), so this is belt and braces; it stays because
  // the failure it prevents is silent, and the day the band moves upstairs is the day it matters.
  const t = Math.max(0, Math.min(1, (level - start) / (ACT1_LEVELS - start)))
  return 0.76 + 0.09 * t
}

/**
 * Banker-proxy points scored per GOAL COLLECT, among runs that FINISH the collect goals — measured
 * at the middle of the band (L251), where it is remarkably stable (~89–94 across 201–296 while
 * points-per-MOVE drifts 193→220). Priced against completing runs on purpose: score and collects
 * are strongly correlated, so a plaque priced off the all-runs mean is free for anyone who would
 * win anyway — measured, not assumed (the first calibration made exactly that mistake and the
 * BINDS guard caught it). `minimum.rate.test.ts` re-measures this against the real board and fails
 * if the mechanics under it drift. Re-derive, never hand-tune (the slots.rate discipline).
 */
export const MINIMUM_POINTS_PER_GOAL = 89

/**
 * The plaque's demand as a fraction of a goal-completing proxy run's expected score. Calibrated
 * against the banker completer distribution: ~p10 at the band start (a light bind — most runs
 * that finish the goals also clear the number), rising to ~p25–p40 by the band top (sleepy play
 * misses it, cascade play clears it). The teaching level sits below p10 — it exists to introduce
 * the plaque, not to enforce it. Remember the proxy-bias rule: the banker cannot chase points, so
 * every one of these binds is an UPPER bound on how often a real player misses the number.
 */
export function minimumTargetFrac(level: number): number {
  const start = DIFFICULTY.goals.minimumStart
  if (level === start) return 0.75
  // ⚠️ ACT1_LEVELS, never LEVEL_COUNT. This ramp's endpoints are the SHIPPED plaque goldens
  // (201→11,900 … 296→18,600); anchoring it to a constant that grows with the ladder would re-price
  // every brass plaque in Act I the moment a new act opened — a silent retune of levels people have
  // already played, from a change that had nothing to do with them.
  const t = Math.max(0, Math.min(1, (level - start) / (ACT1_LEVELS - start)))
  const act1 = 0.88 + 0.16 * t
  if (level <= ACT1_LEVELS) return act1
  // Upstairs the House keeps raising its minimum, but GENTLY — a third of Act I's slope, spread over
  // Act II's own designed span (300 levels). The demand it multiplies (`owed`) is still climbing on
  // its own until `perObjective` clamps around L378, so a steeper `f` would compound with it; past
  // the clamp this term is the only thing still moving, which is precisely why it must keep moving.
  const t2 = Math.max(0, Math.min(1, (level - ACT1_LEVELS) / ACT2_SPAN))
  const f = act1 + 0.06 * t2
  // A level that TEACHES something new posts a gentler minimum — the same courtesy L201 gets from
  // the early return above, generalised.
  //
  // This exists because of an arithmetic collision, not a design choice: the plaque cadence is
  // L % 10 ∈ {1, 6}, and every act opens on a …01, so an act opening ALWAYS lands on a plaque.
  // Without this, level 301 would ask a player to learn a brand-new verb under the toughest minimum
  // the House has ever posted. The brass ladder therefore dips exactly once per act, on the level
  // that also hands out +3 moves and an intro card — visible, explained, and immediately resumed
  // (306 clears 296). `levels.test.ts` carves teaching levels out of the monotone check for the
  // same reason it already carves them out of the move-budget one.
  return isTeachingLevel(level) ? f * TEACHING_PLAQUE_RELIEF : f
}

/** How far a teaching level's plaque steps back from its band rate. 0.85 ≈ L201's own 0.75/0.88 —
 *  the shipped teaching discount, re-expressed as a ratio so it travels up the ladder unchanged. */
const TEACHING_PLAQUE_RELIEF = 0.85

/** Act II's designed span (301–600), the denominator its gentle ramps are measured against — the
 *  act ships a floor pair at a time, so this is deliberately NOT `LEVEL_COUNT - ACT1_LEVELS`: the
 *  slope must not steepen every time another floor opens. */
const ACT2_SPAN = 300

/**
 * Boost TYPES a level refuses at start. Refused boosts are SKIPPED, never consumed — they stay
 * banked (save.ts takePendingBoosts threads these through splitPendingBoosts as extra holds).
 * A minimum level auto-holds DOUBLE SCORE: 2× scoring against a score target would trivially
 * delete the plaque. ⚠️ The stash preview must pass the same exclusions for the level it is
 * previewing — the whole point of splitPendingBoosts is that the promise and the consumption run
 * one rule.
 */
export function levelBoostExclusions(level: number): BoostType[] {
  return isMinimumLevel(level) ? ['doubleScore'] : []
}

export function levelSpec(level: number): LevelSpec {
  const L = level
  const rng = mulberry32((0xc0ffee ^ Math.imul(L, 2654435761)) >>> 0)

  // 5 symbols early keeps matches flowing; the 6th tightens the board from level 4.
  const symbolCount = L < 4 ? 5 : 6
  const objectiveCount = L < 3 ? 1 : L < 8 ? 2 : 3
  // HOUSE MINIMUM: the plaque REPLACES the third collect objective on minimum-cadence levels. The
  // demand — and therefore the move budget derived from `total` below — still counts all three
  // shares, so a minimum level is exactly as big as its 3-objective sibling; the third share is
  // simply asked for in points instead of pieces.
  const minimum = isMinimumLevel(L)
  // POINTS NIGHT takes the idea one step further: the plaque replaces ALL the collect goals, not
  // just the third. The demand — and so the budget below — still counts every share, so a points
  // night is exactly as big as its 3-objective sibling; it is simply asked for entirely in points.
  const points = isPointsNight(L)
  const goalCount = points ? 0 : minimum ? Math.min(2, objectiveCount) : objectiveCount

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
  // HOT TABLE touches the SCORING only — see the measurement above for why it touches no budget.
  const hot = isHotTable(L)

  // Distinct goal symbols, chosen deterministically per level (variety; feasibility is symbol-
  // agnostic since the board fills uniformly from the palette).
  const pool: SymbolType[] = [...SYMBOLS.slice(0, symbolCount)]
  const objectives = []
  for (let i = 0; i < goalCount; i++) {
    const pick = randInt(rng, pool.length)
    objectives.push({ symbol: pool[pick], count: perObjective })
    pool.splice(pick, 1)
  }

  // The plaque price: a fraction of what a goal-completing proxy run scores, priced off the
  // COLLECT DEMAND (frac × pts-per-goal × collects owed) rather than the move budget — the demand
  // is strictly non-decreasing in the level, so the brass ladder is monotone by construction with
  // no move-rounding wobble. Rounded to a brass-friendly 100; the exact numbers are pinned as
  // goldens in levels.test.ts and the constant under them is re-measured by minimum.rate.test.ts.
  // POINTS NIGHT prices off MOVES, not collects — there are none to price against. Its own
  // constant, its own fraction, its own goldens: the plaque's anchor is a goal-completing run's
  // score, and a level with no goals to complete has no such run. `demand` rides along so star
  // grading still has a rate to read (see LevelSpec.demand).
  if (points) {
    const scoreTarget = Math.round((pointsNightTargetFrac(L) * POINTS_NIGHT_POINTS_PER_MOVE * moves) / 100) * 100
    return act2Spec(L, { level: L, moves, symbolCount, objectives, scoreTarget, demand: total })
  }
  if (minimum) {
    const owed = objectives.reduce((n, o) => n + o.count, 0)
    const scoreTarget = Math.round((minimumTargetFrac(L) * MINIMUM_POINTS_PER_GOAL * owed) / 100) * 100
    return act2Spec(L, { level: L, moves, symbolCount, objectives, scoreTarget })
  }
  if (hot) return act2Spec(L, { level: L, moves, symbolCount, objectives, hot: true })
  // ACT II folds in LAST and only ADDS — everything above is the one curve, unchanged, all the way
  // up. `act2Spec` returns this object untouched for every Act I level and whenever the act is
  // switched off, which is what keeps the panic-switch transcription honest over the whole range.
  return act2Spec(L, { level: L, moves, symbolCount, objectives })
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
  // `demand` is the level's collect budget when `objectives` no longer represents it — POINTS NIGHT
  // only. Without it an empty objective list reads as a required rate of ZERO, which clamps both
  // bars to the pre-§G3 constants and asks for half the move budget back: by this file's own
  // definition of flawless play, a 3★ that does not exist. See LevelSpec.demand for why ordinary
  // plaque levels deliberately keep the bar they shipped with.
  const total = spec.demand ?? spec.objectives.reduce((n, o) => n + o.count, 0)
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

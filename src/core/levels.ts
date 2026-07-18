import { SYMBOLS } from './types'
import type { LevelSpec, SymbolType } from './types'
import { mulberry32, randInt } from './rng'

export const LEVEL_COUNT = 300

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
  let ratio: number
  if (objectiveCount === 1) {
    ratio = 0.5
  } else if (objectiveCount === 2) {
    ratio = 1.15 + 0.12 * (L - 3) // L3..L7 → 1.15..1.63
  } else {
    // Ease the 3-objective onset (L8..L11) so the 2→3 step isn't a spike, then a slow log creep
    // toward a 3.5 ceiling — the smooth main climb that never plateaus.
    const onsetEase = 0.14 * Math.max(0, Math.min(1, (11 - L) / 3))
    ratio = Math.min(3.5, 3.0 - onsetEase + 0.27 * Math.log(1 + Math.max(0, L - 8) / 52))
  }

  // Breather cadence: a gentle +2 moves every 5th level — a "catch your breath" beat layered on
  // the rising trend so the grind reads as a wave, not a monotone. A hard feasibility floor keeps
  // the budget above the point where even a flawless clear (~6 collects/move) couldn't finish.
  let moves = Math.round(total / ratio) + (L % 5 === 0 ? 2 : 0)
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

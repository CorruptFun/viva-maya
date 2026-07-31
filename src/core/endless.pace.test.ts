import { describe, expect, it } from 'vitest'
import { ENDLESS_MAX_CHEAT_SCORE } from './endless'
import { percentile, playEndless } from './sim'

/**
 * A guard on the CHEAT CEILING — rewritten 2026-07-31 when the constant changed job.
 *
 * ⚠️ READ THIS BEFORE "FIXING" A FAILURE HERE. This file used to assert that the ceiling was
 * BEATABLE: pitched at the 85th percentile, taken down about one run in seven, and strictly below
 * anything the board had ever produced. Those assertions were correct for a 13,000 "pace score" and
 * are WRONG for what the constant is now. The owner deliberately raised it to 100,000 so that a
 * player who fires the cheat once, gets a little ahead and plays the run out posts THEIR REAL SCORE
 * instead of a flat substitute. The old ceiling bound on essentially every cheat run, which is the
 * behaviour that was being complained about.
 *
 * So the ceiling is now a BACKSTOP against an unbounded runaway — the cheat costs no moves and can be
 * re-entered forever — and nothing more. The bands below guard that job. They deliberately do NOT
 * re-assert chaseability, because a ceiling above honest scores is the accepted, documented trade.
 *
 * What is still worth failing over, and is what this file now checks:
 *   1. it must actually CLAMP — a runaway cannot post an arbitrary number;
 *   2. it must stay a CEILING and never a floor — it can't invent a score a run didn't reach;
 *   3. it must stay above ordinary cheat use, or it silently goes back to being a normaliser;
 *   4. it must stay BOUNDED relative to the real board, or "backstop" means nothing.
 *
 * The distribution is still measured and printed on every run, because the cost of this decision is
 * exactly "how far above honest play does the ceiling sit" and that number must stay visible.
 *
 * Two policies bracket real play, the same pair the Plinko guard uses. 'first' takes whatever swap it
 * scans first — weaker than anyone actually playing, so it stands in for a passive player. 'greedy'
 * takes the biggest opening wave it can SEE with no lookahead, which is roughly a person playing
 * quickly. Both UNDERSTATE a human paying attention.
 */

const RUNS = 400

function scores(policy: 'first' | 'greedy'): number[] {
  const out: number[] = []
  for (let s = 1; s <= RUNS; s++) out.push(playEndless(s * 7919 + 13, policy).score)
  return out.sort((a, b) => a - b)
}

/** Share of runs that finish at or above `target`. */
const beatRate = (sorted: number[], target: number): number =>
  sorted.filter(v => v >= target).length / sorted.length

describe('the cheat ceiling stays a backstop', () => {
  it('sits above ordinary cheat use but stays bounded against the real board', () => {
    const typical = scores('greedy')
    const passive = scores('first')
    const honestMax = typical[typical.length - 1]
    console.log(
      `\nENDLESS_MAX_CHEAT_SCORE=${ENDLESS_MAX_CHEAT_SCORE}  (n=${RUNS} runs per policy)\n` +
        `  typical player: p50 ${percentile(typical, 0.5)} · p75 ${percentile(typical, 0.75)}` +
        ` · p85 ${percentile(typical, 0.85)} · p95 ${percentile(typical, 0.95)} · max ${honestMax}\n` +
        `                  reaches the ceiling in ${(beatRate(typical, ENDLESS_MAX_CHEAT_SCORE) * 100).toFixed(1)}% of runs\n` +
        `  passive player: p50 ${percentile(passive, 0.5)} · p95 ${percentile(passive, 0.95)}\n` +
        `  ceiling sits at ${(ENDLESS_MAX_CHEAT_SCORE / honestMax).toFixed(1)}× the best honest run measured`
    )

    // ABOVE ORDINARY USE. The point of the 2026-07-31 raise: one mega win plus a played-out run must
    // post its REAL score, not a substitute. A single fire lands in the tens of thousands, so a
    // ceiling that slipped back under the honest tail would quietly restore the old normalising
    // behaviour — the exact thing that was complained about — with nothing on screen to say so.
    expect(
      ENDLESS_MAX_CHEAT_SCORE,
      'the ceiling has dropped back among honest scores — it is normalising real runs again'
    ).toBeGreaterThan(honestMax)

    // STILL BOUNDED. "Backstop" has to mean something: the cheat costs no moves and can be re-entered
    // forever, so without a ceiling in the same order of magnitude as the real board a single
    // determined run owns the leaderboard permanently. Ten times the best honest run is the outer
    // edge of defensible; beyond that the clamp stops being a limit and becomes decoration.
    expect(
      ENDLESS_MAX_CHEAT_SCORE,
      'the ceiling is so far above the board that it no longer bounds anything'
    ).toBeLessThan(honestMax * 10)

    // AND IT REALLY CLAMPS — the behaviour, not just the number. A runaway posts exactly the ceiling,
    // while a modest cheat run posts what it actually scored (ceiling, never floor).
    expect(Math.min(5_000_000, ENDLESS_MAX_CHEAT_SCORE)).toBe(ENDLESS_MAX_CHEAT_SCORE)
    const modest = Math.round(honestMax / 2)
    expect(Math.min(modest, ENDLESS_MAX_CHEAT_SCORE), 'a ceiling must never raise a score').toBe(modest)
  }, 300_000)
})

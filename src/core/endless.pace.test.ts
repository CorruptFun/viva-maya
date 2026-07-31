import { describe, expect, it } from 'vitest'
import { ENDLESS_PACE_SCORE } from './endless'
import { percentile, playEndless } from './sim'

/**
 * A guard on FEEL, in the same spirit as plinko.rate.test.ts: "the pace score must stay a top line
 * worth chasing that people actually take down".
 *
 * ENDLESS_PACE_SCORE is the ceiling a cheat run may post to the daily race. The whole point of it is
 * a number pitched at real human reach, so it cannot be a constant somebody picked — it has to be
 * re-derived from the board as the board actually plays, and it has to fail loudly if a future
 * change to the board, the symbol count, the move budget or the Plinko tuning moves the distribution
 * out from under it. A pace score that quietly became unbeatable would do the exact damage it exists
 * to prevent, and nothing on screen would ever say so.
 *
 * Two policies bracket real play, the same pair the Plinko guard uses. 'first' takes whatever swap it
 * scans first — weaker than anyone actually playing, so it stands in for a passive player. 'greedy'
 * takes the biggest opening wave it can SEE with no lookahead, which is roughly a person playing
 * quickly, and it is the one the constant is pinned to. Both UNDERSTATE a human paying attention, so
 * every band below is conservative in the safe direction: the real board gets beaten more often than
 * this says, never less.
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

describe('the pace score stays a chaseable top line', () => {
  it('sits where a typical player takes it down regularly, but not casually', () => {
    const typical = scores('greedy')
    const passive = scores('first')
    console.log(
      `\nENDLESS_PACE_SCORE=${ENDLESS_PACE_SCORE}  (n=${RUNS} runs per policy)\n` +
        `  typical player: p50 ${percentile(typical, 0.5)} · p75 ${percentile(typical, 0.75)}` +
        ` · p85 ${percentile(typical, 0.85)} · p95 ${percentile(typical, 0.95)} · max ${typical[typical.length - 1]}\n` +
        `                  beats the pace score in ${(beatRate(typical, ENDLESS_PACE_SCORE) * 100).toFixed(1)}% of runs\n` +
        `  passive player: p50 ${percentile(passive, 0.5)} · p95 ${percentile(passive, 0.95)}` +
        ` · beats it in ${(beatRate(passive, ENDLESS_PACE_SCORE) * 100).toFixed(1)}% of runs`
    )

    // BEATABLE. Roughly one run in seven for a typical player, so the top line comes down most days
    // and there is always someone who has just done it. Below ~5% and the board has a squatter.
    const rate = beatRate(typical, ENDLESS_PACE_SCORE)
    expect(rate, 'the pace score has drifted out of human reach — nobody can take the board back').toBeGreaterThan(0.06)

    // WORTH CHASING. It has to read as a real score, not a participation trophy: comfortably above
    // the median, or the leaderboard's top line is something a player clears without noticing.
    expect(rate, 'the pace score is now a routine result — it sets no pace at all').toBeLessThan(0.3)
    expect(ENDLESS_PACE_SCORE, 'the pace score has fallen to a median run').toBeGreaterThan(percentile(typical, 0.5))

    // NOT UNREALISTIC. The owner's actual constraint, stated as the thing it protects: the pace score
    // must stay inside the range the board really produces, nowhere near its tail.
    expect(ENDLESS_PACE_SCORE, 'the pace score is above anything the board has ever produced').toBeLessThan(
      typical[typical.length - 1]
    )
    expect(ENDLESS_PACE_SCORE).toBeLessThan(percentile(typical, 0.99))
  }, 300_000)
})

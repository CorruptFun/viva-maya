/**
 * The key-lock scale maths behind every pitched voice in `audio/sfx.ts` (§E3-A10), split into its own
 * module so the ladder walk is pure and unit-testable — see `scale.test.ts`, which exists because the
 * bug described below shipped once already.
 *
 * There are TWO different operations here, and conflating them is exactly what broke the cascade:
 *   - `sfx.snap()` QUANTISES an arbitrary frequency onto the scale. Right for a one-off note that
 *     must land in key ("make this bell consonant with the room").
 *   - `degree()` (here) WALKS the scale, one degree per step. Right for a LADDER ("make wave N higher
 *     than wave N−1"), because there the caller's step count IS the musical interval.
 *
 * Every cascade voice used to build a CHROMATIC ramp (`2 ** ((cascade - 1) / 12)`) and hand it to
 * `snap()`. A pentatonic has only 5 notes per octave, so consecutive semitones quantise onto the SAME
 * degree: measured over 10 waves it yielded just 5 distinct pitches on all four theme roots. Waves 1
 * and 2 were the SAME pitch on golden, roseMidnight and mayaHeart, and every root had a run of three
 * identical waves somewhere (golden at 3–4–5, neonVegas at 2–3–4 — 987.84 Hz three times running).
 * The ladder was not audible as a ladder. `degree()` cannot do that: it is strictly increasing by
 * construction, and the test pins that.
 */

/** Major-pentatonic semitone classes — the key-lock scale (§E3-A10). Shared with `sfx.snap()`. */
export const PENTATONIC = [0, 2, 4, 7, 9]

/**
 * The `n`-th degree of the major pentatonic above `root`, in Hz. `n = 0` IS the root, and 5 degrees is
 * exactly one octave, so `degree(root, n + 5) === degree(root, n) * 2` — which is how callers anchor a
 * ladder in a comfortable register without leaving the key: pass `bedRoot * 16` for "four octaves up".
 *
 * Strictly increasing in `n`, and accelerating by the octave — rung n+5 is exactly twice rung n, so a
 * deep chain pulls away instead of creeping (within an octave it keeps the pentatonic's own uneven
 * 2/2/3/2/3-semitone shape, which is what makes it read as a scale rather than a siren). Safe on any
 * input like the rest of the audio layer: a bad root or a bad `n` returns `root` rather than NaN, so
 * the voice still sounds.
 */
export function degree(root: number, n: number): number {
  if (!(root > 0)) return root
  const i = Math.floor(n)
  if (!Number.isFinite(i) || i <= 0) return root
  const oct = Math.floor(i / PENTATONIC.length)
  const pc = PENTATONIC[i % PENTATONIC.length]
  return root * Math.pow(2, (oct * 12 + pc) / 12)
}

/**
 * How many rungs a cascade ladder climbs before it holds. SIX — one full pentatonic octave (5 degrees
 * plus the octave) — picked by measuring the TOP of the ladder rather than by taste:
 *   - `pop` anchors at `bedRoot * 16` (880–1175 Hz across the theme roots). Rung 5 lands it at
 *     1760–2349 Hz, a hair above the ladder's old ceiling of 1480–1568 Hz. A 10-rung ladder would put
 *     rung 9 at 2960–3951 Hz — dead in the ear's most sensitive band at `pop`'s full 0.34 peak, which
 *     would make the deepest chain in the game also its most piercing sound.
 *   - `clearTink` rides an octave above that, so even at rung 5 its 2.01 partial is already 7–9 kHz.
 * Six also matches what callers already assume (`view/plinko.ts` caps its `clearTink` row at 6) and
 * covers real play: x4 chains land ~1–2 per level and x6 is the practical deep end, so the hold is
 * rare — and a deeper chain still escalates, through `megaBoom`'s tier and the riser's level, not pitch.
 */
export const LADDER_RUNGS = 6

/** Cascade wave (1-based, the way the scenes count them) → ladder rung, clamped to `LADDER_RUNGS`. */
export function rung(cascade: number): number {
  const c = Math.floor(cascade)
  if (!Number.isFinite(c)) return 0
  return Math.max(0, Math.min(LADDER_RUNGS - 1, c - 1))
}

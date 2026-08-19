/**
 * FIRE maths (§X2) — the Phaser-free half of the game's fire vocabulary.
 *
 * The rendering half is `view/firekit.ts`; everything that decides WHERE a flame atom sits, which
 * way it points and how it breathes lives here, so the two properties that make baked sprites read
 * as fire rather than as sprites are unit-testable without a canvas:
 *
 *   1. **A ring of fire is a closed loop with no seam.** The petals are laid at exactly `2πi/n`, so
 *      the gap between the last petal and the first is the same as every other gap. This is the RGB
 *      marquee's law restated for a blast: a ring that is *nearly* even parks its one odd gap in a
 *      fixed spot on screen and the eye finds it immediately.
 *   2. **A wall of fire has no comb and no strobe.** Tongues are laid so their bodies OVERLAP into a
 *      continuous front (spaced atoms scallop into a row of candles — the same failure the marquee's
 *      `ALONG_OVERLAP` exists to prevent), and no two neighbours share a flicker phase, because a
 *      wall whose atoms breathe together is a strobe, not a fire.
 *
 * The turbulence is DETERMINISTIC — a small integer hash per atom, not `Math.random()`. Two reasons,
 * and the second is the one that bites: a hashed jitter is testable (the invariants above are
 * properties of the layout, and a layout that rolls dice can only be spot-checked), and a caller can
 * pass a `seed` to make two fires that overlap in time look different without either one looking
 * random from frame to frame — an atom that re-rolls its size every rebuild flickers as noise.
 */
// The colour half borrows the marquee's own HSV pair rather than growing a second copy — the two
// modules already answer the same question ("what does this hue look like as light?").
import { hsvToInt, hueOf } from './rgb'

/**
 * The fire's colour for a source `tint` at `heat` 1..3 — the SYMBOL's hue, the FIRE's chroma.
 *
 * A blast in Viva Maya belongs to the piece that caused it: a cherry or a red 7 blows up red, a
 * diamond blue, a bell gold, a clover green (owner's call). Only the HUE survives from the source,
 * because a piece tint is picked to read as a small object sitting on a lit board and a fire is
 * additive light on a dark ground — two different jobs:
 *
 *   · **Piece tints can be dark AND dull.** `bar` is a navy `#4a5a8f` — barely half-saturated and
 *     barely half-bright. Added to a dark board that is very nearly nothing, so one symbol out of
 *     six would blast invisibly, which reads as a bug rather than as a colour choice. Taken to full
 *     chroma at full value the same hue is a vivid blue that carries perfectly well.
 *   · **Hotter must not mean paler.** Escalating a coloured flame by washing it toward white is the
 *     desaturation trap that made the first cut of the ring look like flying paper shards (see
 *     `heatTint`). Value is pinned at the top and the heat step is spent on SATURATION — deeper
 *     into the hue, never toward white.
 *
 * ⚠️ **Do not "fix" this by equalising perceived luminance across the symbols.** It is a tempting
 * correction — value is famously not brightness, and a saturated blue really does carry a quarter
 * of a saturated gold's luma — but it was tried here and it is wrong for this job. Pure RED is one
 * of the *darkest* hues there is (luma 0.21, below even the navy's 0.26), so any rule that lifts the
 * blue lifts the reds harder: targeting equal luma turned the cherry blast salmon pink and the red
 * 7's coral, which loses the exact thing the per-symbol colour was asked for. Brightness is supplied
 * instead by GEOMETRY — the kit's atoms overlap, and where they pile up the additive sum clips to
 * white on its own. Colour is this function's job; heat is the geometry's.
 *
 * `fire.test.ts` pins all of it against the real `SYMBOL_TINT` table.
 */
export function flameColor(tint: number, heat: 1 | 2 | 3): number {
  const h = Math.max(1, Math.min(3, Math.round(heat)))
  return hsvToInt(hueOf(tint), 0.82 + h * 0.055, 1)
}

/**
 * Deterministic 0..1 jitter for atom `i` under `salt`. A cheap integer avalanche (the same family as
 * `seedForKey`'s FNV mix, chosen for the same reason: no state, no allocation, and adjacent `i`
 * decorrelate — a hash whose neighbours correlate would lay the turbulence down in visible bands).
 */
export function fireJitter(i: number, salt: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(salt | 0, 668265263)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** One atom of an expanding ring of fire — a unit heading plus its own turbulence. */
export interface RingPetal {
  /** Unit heading out of the ring centre. Multiply by a radius to place or aim the atom. */
  dx: number
  dy: number
  /**
   * Sprite rotation (radians) that points a texture drawn TIP-UP along `dx,dy`. Phaser rotates
   * clockwise in screen space (y down), so "up" (−y) swings onto the heading at `atan2 + π/2`.
   */
  angle: number
  /** Size multiplier around 1 — unequal petals are what make the ring boil instead of inflate. */
  size: number
  /** Travel multiplier around 1 — the ragged front. */
  reach: number
  /** Launch offset in [0,1) of the caller's stagger window, so the ring tears open unevenly. */
  lead: number
}

/**
 * Lay `count` flame atoms around a ring, each aimed outward.
 *
 * Spacing is EXACTLY even by construction (`2πi/count`) — see the file header. Only size, reach and
 * launch are jittered, and all three are bounded well inside ±40% so the ring stays a ring: past
 * that the front stops reading as one shockwave and starts reading as scattered debris, which is a
 * different (and much cheaper-looking) effect.
 */
export function ringPetals(count: number, seed = 0): RingPetal[] {
  const n = Math.max(3, Math.round(count))
  const out: RingPetal[] = []
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i) / n
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    out.push({
      dx,
      dy,
      angle: a + Math.PI / 2,
      size: 0.74 + fireJitter(i, seed + 1) * 0.52, // 0.74 … 1.26
      reach: 0.8 + fireJitter(i, seed + 2) * 0.4, // 0.80 … 1.20
      lead: fireJitter(i, seed + 3),
    })
  }
  return out
}

/** One tongue in a wall of fire — a seat on the front plus its own breathing. */
export interface BlazeTongue {
  /** Centre offset along the wall, in the same units as the width passed in. */
  x: number
  /** Body width. Deliberately WIDER than the spacing, so neighbouring tongues overlap. */
  w: number
  /** Body height at full lick, as a fraction of the caller's reference height. */
  h: number
  /** Flicker period multiplier around 1 — neighbours never share one (see `blazeTongues`). */
  period: number
  /** Flicker phase in [0,1). */
  phase: number
  /** Lean off vertical, in radians — a wall of perfectly upright flames reads as a picket fence. */
  lean: number
}

/**
 * How much wider than its spacing each tongue is drawn. Below ~1.6 the wall scallops into separate
 * candles at the roots; above ~2.4 the overlap stops adding continuity and only costs fill rate.
 * (The marquee's `ALONG_OVERLAP` note, one dimension over.)
 */
export const TONGUE_OVERLAP = 1.9

/**
 * Lay a wall of fire `count` tongues wide across `width`.
 *
 * Seats are even (so the wall's density is uniform) and bodies overlap by `TONGUE_OVERLAP`, so the
 * roots fuse into one front. Height, period, phase and lean are jittered — the front is ragged and
 * every tongue breathes on its own clock.
 *
 * ⚠️ The phase jitter carries a HARD anti-strobe rule the tests pin: consecutive tongues are pushed
 * apart in phase by at least `MIN_PHASE_GAP`. A hash alone will occasionally hand two neighbours
 * near-identical phases, and two neighbours pulsing together is exactly the block-flash that makes a
 * wall of fire read as a flashing rectangle — the one thing this effect must never do, both because
 * it looks cheap and because it is the failure mode the reduce-flashing setting exists to prevent.
 */
export const MIN_PHASE_GAP = 0.12

/** Distance between two phases the SHORT way round the cycle — always in [0, 0.5]. */
export function phaseGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 1
  return Math.min(d, 1 - d)
}

export function blazeTongues(width: number, count: number, seed = 0): BlazeTongue[] {
  const n = Math.max(2, Math.round(count))
  const step = width / n
  const out: BlazeTongue[] = []
  let prevPhase = -1
  for (let i = 0; i < n; i++) {
    // Raw hashed phase, then nudged away from the neighbour it landed on top of. The nudge is a
    // fixed rotation by MIN_PHASE_GAP (not a re-roll), so it stays deterministic and bounded.
    // ⚠️ The proximity test must be CIRCULAR (`phaseGap`), not `Math.abs(a - b)`: phase 0.02 and
    // phase 0.98 are a twentieth of a cycle apart and flash together, but read as 0.96 apart to a
    // linear test — so a linear guard waves through the one pairing it exists to catch.
    let phase = fireJitter(i, seed + 11)
    if (prevPhase >= 0 && phaseGap(phase, prevPhase) < MIN_PHASE_GAP) {
      phase = (prevPhase + MIN_PHASE_GAP * 2) % 1
    }
    prevPhase = phase
    out.push({
      x: step * (i + 0.5),
      w: step * TONGUE_OVERLAP,
      h: 0.62 + fireJitter(i, seed + 12) * 0.66, // 0.62 … 1.28 of the reference height
      period: 0.72 + fireJitter(i, seed + 13) * 0.62, // 0.72 … 1.34
      phase,
      lean: (fireJitter(i, seed + 14) - 0.5) * 0.34, // ±~10°
    })
  }
  return out
}

/**
 * Where the burn front sits at time `t` (0..1) across a region, as a fraction of its width.
 *
 * The reference's tally burn does not fade its region out uniformly — a white-hot line CROSSES it,
 * and everything behind the line is already ash. So the consume is a moving front, and this is the
 * only thing the view needs from it. Eased (slow to bite, fast through the middle, easing out as it
 * runs off the far edge) because a linear wipe reads as a scene transition rather than as burning.
 * Clamped, so a caller that over-runs its own window can't push the front back off the region.
 */
export function burnFront(t: number): number {
  const u = t <= 0 ? 0 : t >= 1 ? 1 : t
  // smoothstep, then biased slightly forward: the front should clear the far edge before the
  // caller's window ends, so the last frames are ash settling rather than a line parked on the edge.
  const s = u * u * (3 - 2 * u)
  return Math.min(1, s * 1.12)
}

/**
 * How lit a cell at `pos` (0..1 across the region) is when the burn front is at `front`.
 *
 * Returns 1 exactly AT the front (the hot line), falling off fast behind it into ash (0) and fast
 * ahead of it into untouched (0). `bandwidth` is the width of the glowing lip, as a fraction of the
 * region — the reference's is narrow, which is what makes it read as a cutting line and not a
 * gradient sliding across.
 */
export function burnHeat(pos: number, front: number, bandwidth = 0.22): number {
  const bw = Math.max(0.02, bandwidth)
  const d = Math.abs(pos - front) / bw
  return d >= 1 ? 0 : 1 - d * d
}

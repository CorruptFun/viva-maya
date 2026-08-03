/**
 * RGB marquee maths (§RGB) — the pure half of the chasing rainbow ring that laps the game-board and
 * Lucky Slots cabinets. The Phaser half (the per-frame drive, the mode profiles, the a11y paths) is
 * `view/rgbmarquee.ts`; everything that decides what a bulb LOOKS like lives here, Phaser-free, so
 * the ring's two hard guarantees — a seamless closed loop and an arc that never leaves its band —
 * are unit-testable without a canvas.
 */

/** Fractional part, always landing in [0,1) — including for negative input. */
export function frac(x: number): number {
  const f = x - Math.floor(x)
  return f < 0 ? f + 1 : f
}

/**
 * Hue in degrees for ring position `i` of `n` at lap `phase` (0..1), across a theme's arc.
 *
 * A full wheel (`span >= 360`) is a straight ramp — it wraps on its own. A narrower arc CANNOT ramp:
 * the ring is a closed loop, so a linear sweep would snap from the arc's end back to its start at the
 * wrap point and leave a hard hue seam sitting at one corner of the cabinet forever. Narrow arcs
 * therefore ping-pong (0 → 1 → 0 around the ring), which closes the loop smoothly at both ends.
 */
export function ringHue(i: number, n: number, phase: number, from: number, span: number): number {
  const t = frac(i / Math.max(1, n) + phase)
  const shaped = span >= 360 ? t : 1 - Math.abs(2 * t - 1)
  return from + shaped * span
}

/**
 * HSV → packed `0xRRGGBB`. Allocation-free on purpose: this runs per bulb per tick, and
 * `Phaser.Display.Color.HSVToRGB` returns a fresh object every call — ~2 900 short-lived objects a
 * second at 48 bulbs / 60fps, which is exactly the kind of garbage that surfaces as jank on a phone.
 *
 * `h` is in degrees and may be any real number (it wraps); `s` and `v` are 0..1 and are clamped.
 */
export function hsvToInt(h: number, s: number, v: number): number {
  const sat = s < 0 ? 0 : s > 1 ? 1 : s
  const val = v < 0 ? 0 : v > 1 ? 1 : v
  const hh = frac(h / 360) * 6
  const c = val * sat
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = val - c
  let r = 0
  let g = 0
  let b = 0
  switch (Math.floor(hh)) {
    case 0:
      r = c
      g = x
      break
    case 1:
      r = x
      g = c
      break
    case 2:
      g = c
      b = x
      break
    case 3:
      g = x
      b = c
      break
    case 4:
      r = x
      b = c
      break
    default:
      r = c
      b = x
  }
  return (
    (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)
  )
}

/**
 * Travelling brightness for ring position `i` of `n`. `waves` is how many bright crests ride the
 * ring at once — one crest reads as a single lamp walking the frame, three as a running chase.
 */
export function ringAlpha(
  i: number,
  n: number,
  phase: number,
  lo: number,
  hi: number,
  waves = 1
): number {
  const w = 0.5 + 0.5 * Math.sin(((i / Math.max(1, n)) * waves + phase) * Math.PI * 2)
  return lo + (hi - lo) * w
}

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
 *
 * ── `lean` (THE TELL) — EMPHASIS, NEVER BAND ────────────────────────────────────────────────
 * `lean` in [-1, 1] redistributes how much of the ring's LENGTH sits near each end of the arc: at
 * +1 most of the ring crowds the arc's far end, at -1 its start, at 0 nothing changes. It is the one
 * shape a hue bias can take without breaking anything the ring promises, and the reason it is safe
 * is worth writing down, because the obvious alternative is not:
 *
 *   · Shifting `from` toward a target hue MOVES THE BAND, and every theme arc is cut to hues that
 *     theme already uses (`rgb.test.ts`: "no arc strays into a hue family its theme never uses").
 *     Neon Vegas has FIVE degrees of headroom before its arc reaches the warm reds it must never
 *     show. Any shift big enough to see is big enough to break that law on some theme.
 *   · `s + k·s(1-s)` is monotone on [0,1] for |k| ≤ 1 (it is linear in its own derivative, so
 *     checking the two endpoints is checking all of it), and it pins f(0)=0 and f(1)=1. So the hue
 *     stays strictly inside [from, from+span] — the band is untouched, by construction — and both
 *     ends of the ring still land on the same hue, so the loop stays seamless.
 *
 * The lean is one number computed per PAINT, not per node, and it is eased on the ring's existing
 * UPDATE clock. Nothing here adds a tween, and nothing here needs a shader.
 */
export function ringHue(i: number, n: number, phase: number, from: number, span: number, lean = 0): number {
  const t = frac(i / Math.max(1, n) + phase)
  const base = span >= 360 ? t : 1 - Math.abs(2 * t - 1)
  const k = lean < -1 ? -1 : lean > 1 ? 1 : lean
  const shaped = k === 0 ? base : base + k * base * (1 - base)
  return from + shaped * span
}

/** Shortest distance between two hues around the wheel, in degrees — always 0..180. */
export function hueGap(a: number, b: number): number {
  const d = Math.abs(frac((a - b) / 360) * 360)
  return d > 180 ? 360 - d : d
}

/**
 * Hue in degrees of a packed `0xRRGGBB` — the inverse of `hsvToInt`'s hue channel. Greys have no
 * hue and answer 0, which is the only sensible answer and never reaches the ring anyway (every piece
 * tint it is asked about is a saturated colour).
 */
export function hueOf(rgb: number): number {
  const r = ((rgb >> 16) & 0xff) / 255
  const g = ((rgb >> 8) & 0xff) / 255
  const b = (rgb & 0xff) / 255
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  if (d === 0) return 0
  const h = 60 * (max === r ? (((g - b) / d) % 6) : max === g ? (b - r) / d + 2 : (r - g) / d + 4)
  return h < 0 ? h + 360 : h
}

/**
 * THE TELL's lean: which END of the arc `[from, from+span]` is nearer to `hue`, as a number in
 * [-1, 1] ready to hand to `ringHue`. -1 is "all the way toward the arc's start", +1 its far end.
 *
 * A RATIO rather than a threshold, so the answer degrades gracefully instead of flipping: a hue the
 * theme genuinely has (a cherry on the blush arc) pins the ring near that end, and a hue no arc
 * contains (a clover on any warm theme) leans gently toward whichever end is less wrong. Every warm
 * theme therefore says "green" as "the gold end", which is the honest translation — the ring is the
 * cabinet's lighting and is not allowed to turn green to say so.
 */
export function arcLean(from: number, span: number, hue: number): number {
  const d0 = hueGap(hue, from)
  const d1 = hueGap(hue, from + span)
  const sum = d0 + d1
  return sum > 0 ? (d0 - d1) / sum : 0
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

/** A sampled point on the ring path, with the tangent angle (radians) of the path there. */
export interface RingPoint {
  x: number
  y: number
  /** Direction of travel along the path — lets a caller orient an elongated sprite along the tube. */
  angle: number
}

/**
 * Sample a rounded-rect perimeter CLOCKWISE from the top-left corner at (near-)even arc length.
 *
 * Even arc length is the load-bearing property. The obvious implementation — walk the four straight
 * edges and the four corner arcs with a fixed count each — bunches points around the corners, which
 * is exactly what made the OLD bulb ring visibly clump (see the `perSide` note in GameScene). Here
 * the spacing is derived from the TOTAL perimeter and then divided evenly, so corners and straights
 * carry the same density and the light tube has uniform brightness the whole way round.
 *
 * `spacing` is a target: the real step is the perimeter divided by a whole number of samples, so the
 * loop always closes exactly rather than leaving a short final segment (a seam in the tube).
 */
export function roundedRectPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  spacing: number
): RingPoint[] {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2))
  const sw = w - rad * 2 // straight run, horizontal
  const sh = h - rad * 2 // straight run, vertical
  const arc = (Math.PI * rad) / 2 // one quarter-corner

  // Clockwise: top → TR corner → right → BR → bottom → BL → left → TL.
  const segs: Array<{ len: number; at: (t: number) => RingPoint }> = [
    { len: sw, at: t => ({ x: x + rad + sw * t, y, angle: 0 }) },
    { len: arc, at: t => arcPoint(x + w - rad, y + rad, rad, -Math.PI / 2, t) },
    { len: sh, at: t => ({ x: x + w, y: y + rad + sh * t, angle: Math.PI / 2 }) },
    { len: arc, at: t => arcPoint(x + w - rad, y + h - rad, rad, 0, t) },
    { len: sw, at: t => ({ x: x + w - rad - sw * t, y: y + h, angle: Math.PI }) },
    { len: arc, at: t => arcPoint(x + rad, y + h - rad, rad, Math.PI / 2, t) },
    { len: sh, at: t => ({ x, y: y + h - rad - sh * t, angle: -Math.PI / 2 }) },
    { len: arc, at: t => arcPoint(x + rad, y + rad, rad, Math.PI, t) },
  ]

  const total = segs.reduce((a, s) => a + s.len, 0)
  if (!(total > 0) || !(spacing > 0)) return []
  const n = Math.max(8, Math.round(total / spacing))
  const step = total / n

  const out: RingPoint[] = []
  let seg = 0
  let base = 0 // arc length at the start of `seg`
  for (let i = 0; i < n; i++) {
    const s = i * step
    while (seg < segs.length - 1 && s >= base + segs[seg].len) {
      base += segs[seg].len
      seg++
    }
    const len = segs[seg].len
    out.push(segs[seg].at(len > 0 ? (s - base) / len : 0))
  }
  return out
}

/** Point a quarter-turn clockwise from `from` around (cx,cy), at parameter `t` in 0..1. */
function arcPoint(cx: number, cy: number, r: number, from: number, t: number): RingPoint {
  const a = from + (Math.PI / 2) * t
  return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, angle: a + Math.PI / 2 }
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

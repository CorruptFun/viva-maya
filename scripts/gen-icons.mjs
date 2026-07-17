// Generates the PWA icon set procedurally (neon diamond on casino-night black).
// Zero dependencies: pixels are computed with distance fields and written as PNG
// by hand (zlib is in Node core). Rerun with `npm run icons`.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------ artwork

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * Viva Maya: red card-suit heart on warm off-white, thin gold ring.
 * Heart = union of two circles and a 45°-rotated square (classic construction).
 * motif = heart half-extent in normalized units; ring = draw the gold ring.
 */
function render(size, motif, ring) {
  const buf = Buffer.alloc(size * size * 4)
  const half = size / 2
  const m = motif
  const mix = (r, g, b, cr, cg, cb, a) => [r + (cr - r) * a, g + (cg - g) * a, b + (cb - b) * a]
  // Signed-ish distance to the heart silhouette (negative inside), in normalized units.
  const heartDist = (px, py) => {
    const c1 = Math.hypot(px + 0.22 * m, py + 0.22 * m) - 0.36 * m
    const c2 = Math.hypot(px - 0.22 * m, py + 0.22 * m) - 0.36 * m
    // Rotated square centered slightly below middle; Chebyshev box in rotated frame.
    const cxp = px
    const cyp = py - 0.06 * m
    const u = (cxp + cyp) / Math.SQRT2
    const v = (cyp - cxp) / Math.SQRT2
    const hbox = 0.38 * m
    const sq = Math.max(Math.abs(u), Math.abs(v)) - hbox
    return Math.min(c1, c2, sq)
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - half) / half
      const ny = (y + 0.5 - half) / half
      const rad = Math.hypot(nx, ny)

      // Warm off-white with a hint of vignette.
      let r = 246
      let g = 243
      let b = 236
      const dark = Math.max(0, rad - 0.8) * 0.25
      r *= 1 - dark
      g *= 1 - dark
      b *= 1 - dark

      if (ring) {
        const ringPx = Math.abs(rad - 0.86) * half
        const ringA = Math.max(0, Math.min(1, (0.018 * size - ringPx) / (0.006 * size)))
        ;[r, g, b] = mix(r, g, b, 217, 165, 33, ringA * 0.9)
      }

      // Soft drop shadow, then the heart itself.
      const dShadow = heartDist(nx, ny - 0.045) * half
      const shadowA = Math.max(0, Math.min(1, (size * 0.02 - dShadow) / (size * 0.02))) * 0.18
      ;[r, g, b] = mix(r, g, b, 160, 140, 90, shadowA)

      const d = heartDist(nx, ny) * half
      const heartA = Math.max(0, Math.min(1, -d / 1.5 + 1))
      // Slight vertical grade on the red for depth.
      const shade = 1 - 0.14 * ((ny + 1) / 2)
      ;[r, g, b] = mix(r, g, b, 224 * shade, 49 * shade, 60 * shade, heartA)

      const o = (y * size + x) * 4
      buf[o] = Math.min(255, r)
      buf[o + 1] = Math.min(255, g)
      buf[o + 2] = Math.min(255, b)
      buf[o + 3] = 255
    }
  }
  return buf
}

mkdirSync(OUT, { recursive: true })
const jobs = [
  ['pwa-512.png', 512, 0.62, true],
  ['pwa-192.png', 192, 0.62, true],
  ['pwa-maskable-512.png', 512, 0.46, false], // motif inside the maskable safe zone
  ['apple-touch-icon.png', 180, 0.58, false],
]
for (const [name, size, motif, ring] of jobs) {
  writeFileSync(join(OUT, name), encodePng(size, render(size, motif, ring)))
  console.log(`wrote public/${name}`)
}

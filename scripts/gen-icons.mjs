// Generates the full icon set + social poster from scripts/icon.html and
// scripts/og.html: headless Chrome renders the art (real typography + Apple
// emoji), sips resizes, and favicon.ico is packed by hand. macOS tooling
// (Chrome + sips) — this repo is developed on Macs. Rerun with `npm run icons`.
//
// Small sizes (16/32/48 + favicon.ico) use the banner-less board (#plain) —
// the wordmark isn't legible below ~120px, so tiny icons stay board-only.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'public')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function shoot(url, out, width, height, extra = []) {
  execFileSync(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--screenshot=${out}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=3000',
      ...extra,
      url,
    ],
    { stdio: 'ignore' }
  )
}

function resize(src, dst, size) {
  execFileSync('sips', ['--resampleHeightWidth', String(size), String(size), src, '--out', dst], {
    stdio: 'ignore',
  })
}

/** ICO container with embedded PNG entries (fine for all modern browsers). */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const dirs = []
  let offset = 6 + 16 * entries.length
  for (const { size, buf } of entries) {
    const dir = Buffer.alloc(16)
    dir[0] = size >= 256 ? 0 : size
    dir[1] = size >= 256 ? 0 : size
    dir.writeUInt16LE(1, 4) // color planes
    dir.writeUInt16LE(32, 6) // bpp
    dir.writeUInt32LE(buf.length, 8)
    dir.writeUInt32LE(offset, 12)
    offset += buf.length
    dirs.push(dir)
  }
  return Buffer.concat([header, ...dirs, ...entries.map(e => e.buf)])
}

const tmp = mkdtempSync(join(tmpdir(), 'viva-icons-'))
const iconUrl = `file://${join(HERE, 'icon.html')}`
const banner1024 = join(tmp, 'banner-1024.png')
const plain1024 = join(tmp, 'plain-1024.png')

shoot(iconUrl, banner1024, 1024, 1024)
shoot(`${iconUrl}#plain`, plain1024, 1024, 1024)

for (const [name, size] of [
  ['pwa-512.png', 512],
  ['pwa-192.png', 192],
  ['apple-touch-icon.png', 180],
]) {
  resize(banner1024, join(OUT, name), size)
  console.log(`wrote public/${name}`)
}

// Maskable: pad to 125% with the page cream so the safe zone holds the art.
const padded = join(tmp, 'padded.png')
execFileSync('sips', ['-p', '1280', '1280', '--padColor', 'F6F3EC', banner1024, '--out', padded], {
  stdio: 'ignore',
})
resize(padded, join(OUT, 'pwa-maskable-512.png'), 512)
console.log('wrote public/pwa-maskable-512.png')

for (const [name, size] of [
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
]) {
  resize(plain1024, join(OUT, name), size)
  console.log(`wrote public/${name}`)
}

const icoEntries = [16, 32, 48].map(size => {
  const path = join(tmp, `ico-${size}.png`)
  resize(plain1024, path, size)
  return { size, buf: readFileSync(path) }
})
writeFileSync(join(OUT, 'favicon.ico'), encodeIco(icoEntries))
console.log('wrote public/favicon.ico')

// Social poster: render at 2x, downsample for crisp emoji.
const og2x = join(tmp, 'og-2x.png')
shoot(`file://${join(HERE, 'og.html')}`, og2x, 1200, 630, ['--force-device-scale-factor=2'])
execFileSync('sips', ['--resampleHeightWidth', '630', '1200', og2x, '--out', join(OUT, 'og-image.png')], {
  stdio: 'ignore',
})
console.log('wrote public/og-image.png')

rmSync(tmp, { recursive: true, force: true })

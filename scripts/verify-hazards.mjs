/**
 * Browser regression check for the hazard mechanics.
 *
 * WHY THIS EXISTS. The unit suite is pure-logic (no DOM, no Phaser) and it cannot see two whole
 * categories of failure that shipped to players in the first hazard release:
 *
 *   1. RULES THE SCENE NEVER ASKS ABOUT. `Board.wouldSwapMatch` correctly refuses a swap involving
 *      a clamped piece, and a core test proved it. But the swipe and tap-tap handlers call
 *      `trySwap` directly and never consulted that helper, so a clamped piece could simply be
 *      dragged. The rule was tested, taught by an intro card, and completely unenforced.
 *
 *   2. VIEW-OBJECT LIFECYCLE. A clamp is a separate GameObject keyed by piece id. It is not part
 *      of the model, so no amount of model/view fuzzing can tell you that it failed to follow its
 *      piece down the board, or that it outlived a piece that got matched away — leaving a clamp
 *      standing on a cell whose contents are not clamped at all.
 *
 * Both are invisible to `npm test` by construction. They are obvious within ten seconds of play.
 *
 * USAGE:  npx vite --port 5177 &   then   node scripts/verify-hazards.mjs
 * Exits non-zero on failure, so it can gate a release.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PORT = process.env.PORT ?? 5177
const LEVEL = process.env.LEVEL ?? 65

// Playwright is not a project dependency (the browser is preinstalled in the image), so resolve it
// from wherever it lives rather than assuming node_modules.
let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  const globalRoot = require('node:child_process').execSync('npm root -g').toString().trim()
  ;({ chromium } = await import(`${globalRoot}/playwright/index.mjs`))
}

const SAVE = JSON.stringify({
  v: 9,
  best: 0,
  unlocked: 120,
  stars: {},
  chips: 900,
  seenIntro: true,
  hazardIntros: ['lock', 'coat', 'blocker'],
  occasionsSeen: [],
  pendingBoosts: [],
  championWeeks: [],
})

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 480, height: 854 }, deviceScaleFactor: 2 })
const pageErrors = []
page.on('pageerror', e => pageErrors.push(String(e)))
page.on('console', m => {
  if (m.type() === 'error') pageErrors.push(m.text())
})

await page.addInitScript(s => localStorage.setItem('viva-maya:v1', s), SAVE)
await page.goto(`http://localhost:${PORT}/?level=${LEVEL}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(4500)

const failures = []

// ── 1. A hazard-held piece must not move through the REAL input path. ───────────────────────────
const held = await page.evaluate(async () => {
  const s = window.__vm.scene.getScenes(true).find(x => x.scene.key === 'game')
  const stuck = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = s.board.get({ row: r, col: c })
      if (p && (p.locked || p.kind === 'blocker')) stuck.push({ row: r, col: c, id: p.id })
    }
  }
  if (stuck.length === 0) return { skipped: true }
  const t = stuck[0]
  const nb = [
    { row: t.row, col: t.col + 1 },
    { row: t.row, col: t.col - 1 },
    { row: t.row + 1, col: t.col },
    { row: t.row - 1, col: t.col },
  ].find(n => s.board.inBounds(n))
  await s.trySwap({ row: t.row, col: t.col }, nb)
  await new Promise(r => setTimeout(r, 700))
  const after = s.board.get({ row: t.row, col: t.col })
  return { moved: !after || after.id !== t.id }
})
if (held.skipped) console.log('· no held pieces on this board — swap guard not exercised')
else if (held.moved) failures.push('a clamped/blocked piece was moved by trySwap')
else console.log('✓ held pieces refuse the swap through the real input path')

// ── 2. Overlays follow their piece and die with it, across real play. ───────────────────────────
const auditOverlays = () =>
  page.evaluate(() => {
    const s = window.__vm.scene.getScenes(true).find(x => x.scene.key === 'game')
    const lockedIds = new Set()
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = s.board.get({ row: r, col: c })
        if (p?.locked) lockedIds.add(p.id)
      }
    }
    const orphans = []
    for (const [id, clamp] of s.lockOverlays) {
      const sprite = s.sprites.get(id)
      if (!sprite || !sprite.active) orphans.push({ id, why: 'overlay outlived its sprite' })
      else if (!lockedIds.has(id)) orphans.push({ id, why: 'overlay on an unlocked piece' })
      else if (Math.abs(clamp.x - sprite.x) > 1 || Math.abs(clamp.y - sprite.y) > 1)
        orphans.push({ id, why: `overlay drifted from its piece` })
    }
    return { locked: lockedIds.size, overlays: s.lockOverlays.size, orphans }
  })

for (let i = 0; i < 20; i++) {
  await page.evaluate(async () => {
    const s = window.__vm.scene.getScenes(true).find(x => x.scene.key === 'game')
    const mv = s.board.findFirstValidMove()
    if (mv) await s.trySwap(mv.a, mv.b)
  })
  await page.waitForTimeout(820)
  const a = await auditOverlays()
  if (a.orphans.length > 0) {
    failures.push(`move ${i + 1}: ${a.orphans.map(o => o.why).join(', ')}`)
    break
  }
}
if (!failures.some(f => f.startsWith('move '))) console.log('✓ clamps track their piece and are destroyed with it')

if (pageErrors.length > 0) failures.push(`page errors: ${pageErrors.slice(0, 3).join(' | ')}`)
else console.log('✓ no page errors')

await browser.close()

if (failures.length > 0) {
  console.error('\nFAILED:')
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('\nAll hazard browser checks passed.')

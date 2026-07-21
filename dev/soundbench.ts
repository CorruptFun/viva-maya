/**
 * DEV-ONLY sound & haptics audition bench — the audio analog of dev/atlas.ts.
 *
 * A plain-DOM grid of buttons that fires the REAL procedural sound engine (the `sfx`
 * singleton in src/audio/sfx.ts) and the REAL haptic gating, so the owner can rapidly
 * audition/feel every one-shot, the ambient bed per theme, cascade arpeggios, the
 * land-intensity sweep, and the haptic vocabulary — on a foregrounded browser (sound)
 * or a real phone (haptics). No audio capture exists for verification; this bench IS
 * the verification surface.
 *
 * Not part of the production build (index.html is the only real entry) and lives OUTSIDE
 * `src/` so it never touches `tsc --noEmit` (tsconfig include: ["src"]). `vite build`
 * emits only index.html, so this page ships nothing. Delete before shipping.
 *
 * Run: `npm run dev` → http://localhost:5173/soundbench.html
 *      (open on the phone via the LAN IP Vite prints, to feel haptics.)
 */
import { sfx, SWAP_SOUNDS, SWAP_SOUND_LABELS } from '../src/audio/sfx'
import type { SwapSound } from '../src/audio/sfx'
import { setTheme, getTheme, getThemeId, THEME_ORDER, THEME_META, hapticsOff, setHapticsOff } from '../src/view/theme'
import type { ThemeId } from '../src/view/theme'

// ─────────────────────────────────────────────────────────── shared bench state
/** Global stereo pan fed to the panned one-shots (matches GameScene.colPan range ±0.7). */
let pan = 0
/** Global cascade step fed to the stepped one-shots (pop/clearTink/charge/cascadeRiser climb per step). */
let step = 1

const bench = document.getElementById('bench') as HTMLDivElement
const statusEl = document.getElementById('status') as HTMLDivElement
const logEl = document.getElementById('log') as HTMLDivElement

// ─────────────────────────────────────────────────────────────────── DOM helpers
function section(title: string, hint?: string): HTMLDivElement {
  const s = document.createElement('section')
  const h = document.createElement('h2')
  h.textContent = title
  s.appendChild(h)
  if (hint) {
    const p = document.createElement('p')
    p.className = 'hint'
    p.textContent = hint
    s.appendChild(p)
  }
  const row = document.createElement('div')
  row.className = 'row'
  s.appendChild(row)
  bench.appendChild(s)
  return row
}

function button(parent: HTMLElement, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  if (cls) b.className = cls
  b.addEventListener('click', onClick)
  parent.appendChild(b)
  return b
}

function sep(parent: HTMLElement): void {
  const d = document.createElement('div')
  d.className = 'sep'
  parent.appendChild(d)
}

let logCount = 0
function log(msg: string): void {
  logCount++
  logEl.textContent = `${logCount}. ${msg}`
}

// ───────────────────────────────────────────────────────────── status chips
function chip(label: string, value: string): string {
  return `<span class="chip">${label} <b>${value}</b></span>`
}
function refreshStatus(): void {
  const pal = getTheme().audio
  statusEl.innerHTML = [
    chip('theme', getThemeId()),
    chip('muted', sfx.muted ? 'YES' : 'no'),
    chip('ambient', sfx.ambience ? 'ON' : 'off'),
    chip('haptics', hapticsOff() ? 'OFF' : 'on'),
    chip('bedRoot', `${pal.bedRoot}Hz`),
    chip('wave', pal.waveBias),
    chip('warmth', `${pal.filterWarmth}Hz`),
    chip('reverb', pal.reverbMix.toFixed(2)),
  ].join('')
}

// ───────────────────────────────────────────────────── haptics (mirrors real gating)
/** Mirror the exact in-game gate: hapticsOff() opt-out + Vibration-API feature-detect. */
function buzz(label: string, pattern: number | number[]): void {
  const off = hapticsOff()
  const supported = 'vibrate' in navigator
  log(`haptic ${label} = ${JSON.stringify(pattern)}${off ? ' — SKIPPED (haptics off)' : supported ? '' : ' — no Vibration API'}`)
  if (off) return
  if (supported) navigator.vibrate?.(pattern)
}

// ───────────────────────────────────────────────────────── sequenced demos
/** Fire fn(1..n) spaced by `gap` ms — for pop/tink arpeggios and star runs. */
function arp(fn: (i: number) => void, n: number, gap: number): void {
  for (let i = 1; i <= n; i++) setTimeout(() => fn(i), (i - 1) * gap)
}

/** The full combo arc: riser + pop + tink stepping 1..6, then resolve → win fanfare. */
function comboArc(): void {
  const gap = 380
  for (let i = 1; i <= 6; i++) {
    setTimeout(() => {
      sfx.cascadeRiser(i)
      sfx.pop(i, pan)
      sfx.clearTink(i, colPanAt(i))
    }, (i - 1) * gap)
  }
  setTimeout(() => sfx.riserResolve(), 6 * gap)
  setTimeout(() => sfx.winFanfare(), 6 * gap + 140)
  log('combo arc: riser+pop+tink ×6 → winFanfare')
}

/** Spread six column pans across the field (matches GameScene.colPan for COLS=6). */
function colPanAt(col: number): number {
  const cols = 6
  return ((col / (cols - 1)) * 2 - 1) * 0.7
}

/** A refill "rain": one land per column, jittered timing + drop height, panned by column. */
function refillRain(): void {
  const cols = 6
  for (let c = 0; c < cols; c++) {
    const h = 0.3 + Math.random() * 0.7
    setTimeout(() => sfx.land(h, colPanAt(c)), Math.random() * 240)
  }
  log('refill rain: 6 lands, jittered, panned by column')
}

// ═══════════════════════════════════════════════════════════════════ BUILD UI

// ── Globals ─────────────────────────────────────────────────────────────────
{
  const row = section('Globals', 'Mute / haptics mirror the real opt-outs. Theme switch retunes the room (reverb + bed). Pan & step feed the one-shots below.')

  const mute = button(row, '', () => {
    sfx.toggleMuted()
    syncToggles()
    refreshStatus()
    log(`mute → ${sfx.muted ? 'MUTED' : 'unmuted'}`)
  }, 'toggle')

  const haptic = button(row, '', () => {
    setHapticsOff(!hapticsOff())
    syncToggles()
    refreshStatus()
    log(`haptics → ${hapticsOff() ? 'OFF' : 'on'}`)
  }, 'toggle')

  const ambient = button(row, '', () => {
    sfx.toggleAmbience()
    syncToggles()
    refreshStatus()
    log(`ambient bed → ${sfx.ambience ? 'ON' : 'off'}${sfx.ambience && sfx.muted ? ' (muted — inaudible until unmuted)' : ''}`)
  }, 'toggle')

  // eslint-disable-next-line no-inner-declarations
  function syncToggles(): void {
    mute.dataset.on = sfx.muted ? '1' : '0'
    mute.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound on'
    haptic.dataset.on = hapticsOff() ? '0' : '1'
    haptic.textContent = hapticsOff() ? '📴 Haptics off' : '📳 Haptics on'
    ambient.dataset.on = sfx.ambience ? '1' : '0'
    ambient.textContent = sfx.ambience ? '🛋️ Ambient ON' : '🛋️ Ambient off'
  }
  syncToggles()

  sep(row)

  // Theme row — each retunes the audio room live.
  const themeBtns: HTMLButtonElement[] = []
  for (const id of THEME_ORDER) {
    const b = button(row, THEME_META[id].name, () => {
      setTheme(id)
      sfx.refreshTheme()
      for (const tb of themeBtns) tb.dataset.active = tb.dataset.id === id ? '1' : '0'
      refreshStatus()
      log(`theme → ${id} — ${THEME_META[id].feel}`)
    }, 'theme')
    b.dataset.id = id
    b.dataset.active = getThemeId() === id ? '1' : '0'
    themeBtns.push(b)
  }

  sep(row)

  // Pan slider + cascade-step input.
  const panWrap = document.createElement('label')
  panWrap.className = 'ctl'
  panWrap.innerHTML = '<span>pan <b id="panVal">0.0</b></span>'
  const panIn = document.createElement('input')
  panIn.type = 'range'
  panIn.min = '-1'
  panIn.max = '1'
  panIn.step = '0.1'
  panIn.value = '0'
  panIn.addEventListener('input', () => {
    pan = parseFloat(panIn.value)
    ;(document.getElementById('panVal') as HTMLElement).textContent = pan.toFixed(1)
  })
  panWrap.appendChild(panIn)
  row.appendChild(panWrap)

  const stepWrap = document.createElement('label')
  stepWrap.className = 'ctl'
  stepWrap.innerHTML = '<span>cascade step</span>'
  const stepIn = document.createElement('input')
  stepIn.type = 'number'
  stepIn.min = '1'
  stepIn.max = '8'
  stepIn.value = '1'
  stepIn.addEventListener('input', () => {
    step = Math.max(1, Math.min(8, parseInt(stepIn.value || '1', 10)))
  })
  stepWrap.appendChild(stepIn)
  row.appendChild(stepWrap)
}

// ── Cascade & clears ─────────────────────────────────────────────────────────
{
  const row = section('Cascade & clears', 'pop climbs a semitone per step; clearTink rings an octave above; the riser ratchets up and resolves into winFanfare.')
  button(row, 'pop @step', () => { sfx.pop(step, pan); log(`pop(${step}, ${pan.toFixed(1)})`) })
  button(row, 'clearTink @step', () => { sfx.clearTink(step, pan); log(`clearTink(${step}, ${pan.toFixed(1)})`) })
  button(row, 'charge @step', () => { sfx.charge(step); log(`charge(${step})`) })
  button(row, 'scoreTick', () => { sfx.scoreTick(); log('scoreTick()') })
  sep(row)
  button(row, '▶ pop arpeggio 1‥6', () => { arp(i => sfx.pop(i, pan), 6, 260); log('pop arpeggio 1..6') }, 'accent')
  button(row, '▶ clearTink arp 1‥6', () => { arp(i => sfx.clearTink(i, colPanAt(i)), 6, 220); log('clearTink arpeggio 1..6') }, 'accent')
  button(row, '▶ full combo arc', comboArc, 'accent big')
  sep(row)
  button(row, 'cascadeRiser @step', () => { sfx.cascadeRiser(step); log(`cascadeRiser(${step})`) })
  button(row, 'riserResolve', () => { sfx.riserResolve(); log('riserResolve()') })
}

// ── Lands & settles ──────────────────────────────────────────────────────────
{
  const row = section('Lands & settles', 'land(height 0‥1, pan): deeper drop = lower, weightier thunk. Callers throttle to one per settling column.')
  for (const h of [0.15, 0.4, 0.7, 1.0]) {
    button(row, `land ${h.toFixed(2)}`, () => { sfx.land(h, pan); log(`land(${h}, ${pan.toFixed(1)})`) })
  }
  sep(row)
  button(row, '▶ land pan trio', () => {
    ;[-0.7, 0, 0.7].forEach((p, i) => setTimeout(() => sfx.land(0.8, p), i * 130))
    log('land trio L/C/R @0.8')
  }, 'accent')
  button(row, '▶ refill rain', refillRain, 'accent')
  button(row, 'reelClunk @pan', () => { sfx.reelClunk(pan); log(`reelClunk(${pan.toFixed(1)})`) })
}

// ── Swaps & UI ───────────────────────────────────────────────────────────────
{
  const row = section('Swaps & UI', 'swap() plays the persisted pick; the four named buttons audition + persist that pick (they play through mute).')
  button(row, 'swap (selected)', () => { sfx.swap(); log(`swap() → "${sfx.swapSound}"`) })
  for (const s of SWAP_SOUNDS) {
    button(row, SWAP_SOUND_LABELS[s], () => {
      sfx.previewSwap(s)
      sfx.setSwapSound(s as SwapSound)
      refreshStatus()
      log(`swap "${s}" auditioned + set`)
    })
  }
  sep(row)
  button(row, 'uiTap', () => { sfx.uiTap(); log('uiTap()') })
  button(row, 'uiPress', () => { sfx.uiPress(); log('uiPress()') })
  button(row, 'whoosh @pan', () => { sfx.whoosh(pan); log(`whoosh(${pan.toFixed(1)})`) })
  button(row, 'invalidThud', () => { sfx.invalidThud(); log('invalidThud()') })
  button(row, 'reshuffleSwirl', () => { sfx.reshuffleSwirl(); log('reshuffleSwirl()') })
  button(row, 'themeSwap', () => { sfx.themeSwap(); log('themeSwap()') })
  button(row, 'powerOn', () => { sfx.powerOn(); log('powerOn()') })
}

// ── Wins & specials ──────────────────────────────────────────────────────────
{
  const row = section('Wins & specials', 'The big cues — jackpot strike, win fanfare, the Maya leitmotif, coin tally, detonations. Watch loudness here.')
  button(row, 'winFanfare', () => { sfx.winFanfare(); log('winFanfare()') }, 'accent')
  button(row, 'jackpotStrike', () => { sfx.jackpotStrike(); log('jackpotStrike()') }, 'accent')
  button(row, 'mayaMotif', () => { sfx.mayaMotif(); log('mayaMotif()') }, 'accent')
  button(row, 'coinCount', () => { sfx.coinCount(); log('coinCount()') })
  sep(row)
  button(row, 'starDing 0', () => { sfx.starDing(0); log('starDing(0)') })
  button(row, 'starDing 1', () => { sfx.starDing(1); log('starDing(1)') })
  button(row, 'starDing 2', () => { sfx.starDing(2); log('starDing(2)') })
  button(row, '▶ star run 0‥2', () => { arp(i => sfx.starDing(i - 1), 3, 300); log('star run 0..2') }, 'accent')
  sep(row)
  button(row, 'reelSweep @pan', () => { sfx.reelSweep(pan); log(`reelSweep(${pan.toFixed(1)})`) })
  button(row, 'bombBoom @pan', () => { sfx.bombBoom(pan); log(`bombBoom(${pan.toFixed(1)})`) }, 'rose')
  button(row, 'loseWah', () => { sfx.loseWah(); log('loseWah()') }, 'rose')
  sep(row)
  button(row, 'lifeRestored', () => { sfx.lifeRestored(); log('lifeRestored()') })
  button(row, 'objectiveNear', () => { sfx.objectiveNear(); log('objectiveNear()') })
}

// ── Haptics (current vocabulary) ─────────────────────────────────────────────
{
  const supported = 'vibrate' in navigator
  const row = section(
    'Haptics — current vocabulary',
    `Vibration API: ${supported ? 'supported ✓ (feel these on a phone)' : 'NOT supported on this device ✗'}. Gated by the Haptics toggle above, exactly like in-game. These are today's patterns — Track 3 replaces them with a named set.`
  )
  button(row, 'press · 8', () => buzz('press', 8))
  button(row, 'coin tick · 30', () => buzz('coin tick', 30))
  button(row, 'detent · 12', () => buzz('reel detent', 12))
  button(row, 'objective · 40', () => buzz('objective', 40))
  button(row, 'star · 24', () => buzz('star', 24))
  sep(row)
  button(row, 'bomb · 30+r·12', () => buzz('bomb r=3', 30 + 3 * 12))
  button(row, 'wheel · 16', () => buzz('wheel tick', 16))
  button(row, 'wheel jackpot · [20,40,30]', () => buzz('wheel jackpot', [20, 40, 30]))
  sep(row)
  button(row, 'win · [80,50,120]', () => buzz('win', [80, 50, 120]), 'accent')
  button(row, 'win alt · [60,40,120]', () => buzz('win alt', [60, 40, 120]), 'accent')
  button(row, 'MEGA · [80,60,140,60,220]', () => buzz('mega', [80, 60, 140, 60, 220]), 'accent')
}

refreshStatus()

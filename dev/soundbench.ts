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
import { sfx, SWAP_SOUNDS, SWAP_SOUND_LABELS, legacyBedVoices } from '../src/audio/sfx'
import type { SwapSound, BedVoices } from '../src/audio/sfx'
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

// ═══════════════════════════════════════════════ evolved ambient "rooms" (dev A/B)
// Injected into the REAL sfx.startBed({ voices }) via the BedVoicesApi seam (src/audio/sfx.ts). Each is
// palette-derived + level-capped ≤ legacy; drafted by the ambient-bed-rooms workflow, reviewed here. Only
// the winner gets promoted into sfx.ts as the shipped default — until then the game stays on Legacy.

// DRIFT (Room 1) — the minimal, least-fatiguing room: the legacy pad + room-tone + 0.06 Hz level
// breath kept intact, with only two whisper-slow movers added — a detune shimmer-beat and a
// brightness breath. No new sustained layer, no sparkle. Movement comes from modulation, not volume.
const driftVoices: BedVoices = ({ ctx, t, pal, dest, bedMaster, level, noise, add }) => {
  // Our OWN lowpass in front of the pad — the shipped warmth LPF behind `dest` is fixed, so brightness
  // movement needs a filter we can sweep. Q low (0.6, matching the warmth stage) so it can only ever
  // subtract, never a resonant boost → the pad stays no louder than legacy (its body always passes).
  const padLp = ctx.createBiquadFilter()
  padLp.type = 'lowpass'
  padLp.Q.value = 0.6
  padLp.frequency.value = pal.filterWarmth * 0.6 // base cutoff, well above the pad fundamentals, below warmth
  padLp.connect(dest)

  // Slow detune DRIFT LFO (~0.037 Hz) — a few cents, counter-signed per voice so the two same-pitch
  // root voices spread apart and back together, slowly breathing their beat rate: a shimmer, not a throb.
  const driftLfo = ctx.createOscillator()
  driftLfo.type = 'sine'
  driftLfo.frequency.value = 0.037
  driftLfo.start(t)
  add(driftLfo)

  // Detuned pad: root · root · fifth · octave — legacy chord, legacy 0.25 gains (no added level).
  const voices: Array<[number, number]> = [
    [pal.bedRoot, -6],
    [pal.bedRoot, 6],
    [pal.bedRoot * 1.5, -4], // a perfect fifth
    [pal.bedRoot * 2, 3], // octave shimmer
  ]
  voices.forEach(([freq, detune], i) => {
    const o = ctx.createOscillator()
    o.type = pal.waveBias
    o.frequency.value = freq
    o.detune.value = detune
    const vg = ctx.createGain()
    vg.gain.value = 0.25 // legacy pad gain, unchanged — the only path change is the subtractive LPF
    o.connect(vg).connect(padLp)
    // Counter-sign the drift so the two roots move oppositely → their beat rate breathes; ±5 cents, barely there.
    const dg = ctx.createGain()
    dg.gain.value = i % 2 === 0 ? 5 : -5
    driftLfo.connect(dg).connect(o.detune)
    o.start(t)
    add(o)
  })

  // Gentle BRIGHTNESS breath — a second slow LFO (~0.029 Hz) sweeping the pad LPF cutoff. Its rate is a
  // non-integer ratio to both 0.037 and the 0.06 level breath, so the three never phase-lock into a pulse.
  // It drives only the filter (no gain), so it colours the pad without adding a shred of loudness. Depth
  // scales with the room's warmth, and stays above the pad fundamentals — so it opens the harmonics of the
  // triangle/saw rooms yet never dips onto the fundamental (which would pump the level).
  const briLfo = ctx.createOscillator()
  briLfo.type = 'sine'
  briLfo.frequency.value = 0.029
  const briDepth = ctx.createGain()
  briDepth.gain.value = pal.filterWarmth * 0.22
  briLfo.connect(briDepth).connect(padLp.frequency)
  briLfo.start(t)
  add(briLfo)

  // Low room-tone: filtered noise, barely there, grounds the pad — verbatim legacy, untouched.
  const room = noise()
  room.loop = true
  const roomLp = ctx.createBiquadFilter()
  roomLp.type = 'lowpass'
  roomLp.frequency.value = 220
  const roomG = ctx.createGain()
  roomG.gain.value = 0.12
  room.connect(roomLp).connect(roomG).connect(dest)
  room.start(t)
  add(room)

  // One slow ~0.06 Hz level breath swelling the bed — verbatim legacy, the ONLY node on bedMaster.gain
  // (its base 0.05 is owned by startBed and stays untouched).
  const lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.06
  const lfoDepth = ctx.createGain()
  lfoDepth.gain.value = level * 0.4
  lfo.connect(lfoDepth).connect(bedMaster.gain)
  lfo.start(t)
  add(lfo)
}

// LAYERED (Room 2) — Drift's pad given a floor + a ceiling: a clean sub an octave below the root for
// felt body, and a breathing band of "air" tucked just under the warmth cutoff — both palette-scaled.
const layeredVoices: BedVoices = ({ ctx, t, pal, dest, bedMaster, level, noise, add }) => {
  // Palette-derived character across the four-room range (§A3): brighter/airier vs lower/darker.
  const bright = Math.max(0, Math.min(1, (pal.filterWarmth - 640) / 810)) // 0 velvet(rose) .. 1 airy(neon)
  const low = Math.max(0, Math.min(1, (73.42 - pal.bedRoot) / 18.42)) // 0 high(maya) .. 1 low(rose)

  // Drift pad (root · root · fifth · octave), trimmed from legacy's 0.25 to make room for the sub + air.
  const voices: Array<[number, number]> = [
    [pal.bedRoot, -6],
    [pal.bedRoot, 6],
    [pal.bedRoot * 1.5, -4], // a perfect fifth
    [pal.bedRoot * 2, 3], // octave shimmer
  ]
  // My OWN low-pass on the pad so a slow LFO can drift its brightness (the fixed warmth filter is untouchable).
  const padLp = ctx.createBiquadFilter()
  padLp.type = 'lowpass'
  padLp.Q.value = 0.6 // gentle, no resonant boost (matches the warmth filter)
  const padCenter = pal.filterWarmth * 0.55 // stays UNDER the warmth cutoff → its movement is what you hear
  padLp.frequency.value = padCenter
  padLp.connect(dest)
  for (const [freq, detune] of voices) {
    const o = ctx.createOscillator()
    o.type = pal.waveBias
    o.frequency.value = freq
    o.detune.value = detune
    const vg = ctx.createGain()
    vg.gain.value = 0.185 // trimmed from legacy 0.25 to compensate the added sub + air layers
    o.connect(vg).connect(padLp)
    o.start(t)
    add(o)
  }

  // Sub body: a clean sine one octave BELOW the root — decorrelated from the audible fundamental, so it
  // adds felt weight without lifting the low-band above legacy. Weightier when the room is low + dark.
  const sub = ctx.createOscillator()
  sub.type = 'sine'
  sub.frequency.value = pal.bedRoot * 0.5
  const subG = ctx.createGain()
  subG.gain.value = 0.11 + 0.09 * low + 0.05 * (1 - bright) // rose heaviest (velvet+sub), maya lightest
  sub.connect(subG).connect(dest)
  sub.start(t)
  add(sub)

  // Low room-tone floor (Drift base), a hair below legacy's 0.12 since the sub now grounds the low end.
  const room = noise()
  room.loop = true
  const roomLp = ctx.createBiquadFilter()
  roomLp.type = 'lowpass'
  roomLp.frequency.value = 220
  const roomG = ctx.createGain()
  roomG.gain.value = 0.1
  room.connect(roomLp).connect(roomG).connect(dest)
  room.start(t)
  add(room)

  // High "air": band-passed noise just under the warmth cutoff, present only on the brighter rooms.
  const air = noise()
  air.loop = true
  const airBp = ctx.createBiquadFilter()
  airBp.type = 'bandpass'
  airBp.Q.value = 0.7 // wide + soft → air, never a resonant whistle
  airBp.frequency.value = pal.filterWarmth * 0.9 // survives the warmth LPF; higher/opener on airy rooms
  const airG = ctx.createGain()
  const airPeak = 0.018 + 0.05 * bright // rose ≈ silent (velvet), neon fullest (airy)
  airG.gain.value = airPeak * 0.55 // the air LFO breathes it above/below this
  air.connect(airBp).connect(airG).connect(dest)
  air.start(t)
  add(air)

  // ── Three SLOW, pairwise-non-integer LFOs (0.06 / 0.037 / 0.023 Hz) so movement never phase-locks. ──
  // 1) Level breath onto bedMaster (like legacy) — a touch gentler given the extra layers.
  const lfoLvl = ctx.createOscillator()
  lfoLvl.type = 'sine'
  lfoLvl.frequency.value = 0.06
  const lfoLvlD = ctx.createGain()
  lfoLvlD.gain.value = level * 0.32 // bed swings ~0.034..0.066, quieter at peak than legacy's 0.07
  lfoLvl.connect(lfoLvlD).connect(bedMaster.gain)
  lfoLvl.start(t)
  add(lfoLvl)
  // 2) Air breath — fades the shimmer in/out slowly, never to zero (it presents, it never flickers).
  const lfoAir = ctx.createOscillator()
  lfoAir.type = 'sine'
  lfoAir.frequency.value = 0.037
  const lfoAirD = ctx.createGain()
  lfoAirD.gain.value = airPeak * 0.45 // gain rides 0.10..1.0 × airPeak → gentle presence, no pulse
  lfoAir.connect(lfoAirD).connect(airG.gain)
  lfoAir.start(t)
  add(lfoAir)
  // 3) Brightness drift — opens/closes the pad's own low-pass (most audible on triangle/saw rooms).
  const lfoBr = ctx.createOscillator()
  lfoBr.type = 'sine'
  lfoBr.frequency.value = 0.023
  const lfoBrD = ctx.createGain()
  lfoBrD.gain.value = padCenter * 0.3 // cutoff rides 0.70..1.30 × center, always below the warmth cutoff
  lfoBr.connect(lfoBrD).connect(padLp.frequency)
  lfoBr.start(t)
  add(lfoBr)
}

// LIVING (Room 3) — Layered's movement plus a RARE key-locked sparkle bell (every ~20-40s) blooming
// into the shared reverb tail: "the room settling". The most alive; still level-capped ≤ legacy.
const livingVoices: BedVoices = ({ ctx, t, pal, dest, bedMaster, level, dryBus, snap, noise, add, onStop, isActive }) => {
  const warm = pal.filterWarmth // brightness anchor (§A3) — dark themes sweep low/velvet, bright ones airier

  // The pad's OWN low-pass: brightness MOVES by sweeping this (below), never by adding level. Its ceiling
  // stays under the fixed warmth LPF behind `dest`, so the pad reads no brighter — nor louder — than legacy.
  const padLp = ctx.createBiquadFilter()
  padLp.type = 'lowpass'
  padLp.Q.value = 0.6 // no resonant bump → the sweep is pure timbre, never a level peak
  padLp.frequency.value = warm * 0.6
  padLp.connect(dest)

  // Detuned pad: root · root · fifth · octave (as legacy) — trimmed 0.25→0.22 to buy headroom for the
  // added movement + sparkle, so the summed bed stays no louder than legacy.
  const voices: Array<[number, number]> = [
    [pal.bedRoot, -6],
    [pal.bedRoot, 6],
    [pal.bedRoot * 1.5, -4], // a perfect fifth
    [pal.bedRoot * 2, 3], // octave shimmer
  ]
  let rootOsc: OscillatorNode | null = null
  for (const [freq, detune] of voices) {
    const o = ctx.createOscillator()
    o.type = pal.waveBias
    o.frequency.value = freq
    o.detune.value = detune
    const vg = ctx.createGain()
    vg.gain.value = 0.22 // trimmed from legacy's 0.25
    o.connect(vg).connect(padLp)
    o.start(t)
    add(o)
    rootOsc ??= o // first (root) voice — the detune-drift target below
  }

  // Low room-tone: filtered noise, barely there (0.12→0.11) — grounds the pad.
  const room = noise()
  room.loop = true
  const roomLp = ctx.createBiquadFilter()
  roomLp.type = 'lowpass'
  roomLp.frequency.value = 220
  const roomG = ctx.createGain()
  roomG.gain.value = 0.11
  room.connect(roomLp).connect(roomG).connect(dest)
  room.start(t)
  add(room)

  // ── Three slow LFOs at mutually NON-integer rates (0.053 : 0.023 : 0.037) → never phase-lock (§rule) ──

  // 1) Level breath on bedMaster.gain (like legacy) — gentler (0.4→0.35) so peak level stays under legacy.
  const breath = ctx.createOscillator()
  breath.type = 'sine'
  breath.frequency.value = 0.053 // ~19s
  const breathDepth = ctx.createGain()
  breathDepth.gain.value = level * 0.35
  breath.connect(breathDepth).connect(bedMaster.gain)
  breath.start(t)
  add(breath)

  // 2) Brightness sweep on the pad's own LPF — a slow "lights" drift; ceiling always below the fixed warmth.
  const bright = ctx.createOscillator()
  bright.type = 'sine'
  bright.frequency.value = 0.023 // ~43s
  const brightDepth = ctx.createGain()
  brightDepth.gain.value = warm * 0.3 // padLp sweeps ~warm*0.3 … warm*0.9 — never above the fixed warmth
  bright.connect(brightDepth).connect(padLp.frequency)
  bright.start(t)
  add(bright)

  // 3) Detune drift on the root voice — the chorus beat keeps shifting (alive); far too slow to be vibrato.
  const drift = ctx.createOscillator()
  drift.type = 'sine'
  drift.frequency.value = 0.037 // ~27s
  const driftDepth = ctx.createGain()
  driftDepth.gain.value = 5 // ±5 cents around its -6 detune → living, non-pulsing chorus (no added level)
  if (rootOsc) drift.connect(driftDepth).connect(rootOsc.detune)
  drift.start(t)
  add(drift)

  // ── Rare sparkle (room 3): ONE whisper-quiet key-locked bell every ~20-40s → the shared reverb tail ──
  const partials = [8, 12, 16, 24] // high overtones of bedRoot; snap() locks each into the theme key
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    timer = setTimeout(() => {
      if (isActive()) {
        // "the room settling": one soft sine bell, snapped to key, blooming into the shared reverb.
        const bt = ctx.currentTime
        const f = snap(pal.bedRoot * partials[Math.floor(Math.random() * partials.length)])
        const peak = 0.03 - pal.reverbMix * 0.02 + Math.random() * 0.012 // ~0.02-0.04; wetter rooms sit drier
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.value = f
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, bt)
        g.gain.exponentialRampToValueAtTime(peak, bt + 0.04) // soft mallet — no click to draw the ear
        g.gain.exponentialRampToValueAtTime(0.0001, bt + 2.2) // long bloom → rides the reverb, then gone
        o.connect(g).connect(dryBus) // → master + shared reverb send (the tail)
        o.start(bt)
        o.stop(bt + 2.3)
        add(o) // register so stopBed() stops it even mid-ring
      }
      schedule() // reschedule after EVERY fire (even a blur-skipped one) so sparkles resume cleanly
    }, 20000 + Math.random() * 20000) // 20-40s, jittered → never a metronome
  }
  schedule()
  onStop(() => clearTimeout(timer)) // clear the pending sparkle on teardown (§A2)
}

/** The bed A/B set — Legacy (shipped) + the three evolved rooms drafted by the workflow. */
const ROOMS: Array<{ key: string; label: string; build: BedVoices }> = [
  { key: 'legacy', label: 'Legacy', build: legacyBedVoices },
  { key: 'drift', label: 'Drift', build: driftVoices },
  { key: 'layered', label: 'Layered', build: layeredVoices },
  { key: 'living', label: 'Living', build: livingVoices },
]

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

// ── Ambient rooms (A/B) ───────────────────────────────────────────────────────
{
  const row = section(
    'Ambient rooms — A/B (evolved)',
    'Swap the LIVE bed between the shipped Legacy room and three evolved rooms — all palette-derived + level-capped ≤ legacy. Pick a room, then use the Theme row above to hear it across all 4 palettes. Give Living ~20–40s to catch a sparkle. (Needs Sound on.)'
  )
  const roomBtns: HTMLButtonElement[] = []
  const playRoom = (label: string, build: BedVoices, btn: HTMLButtonElement): void => {
    if (sfx.muted) {
      log(`unmute (Sound on) to hear the "${label}" room`)
      return
    }
    if (!sfx.ambience) sfx.toggleAmbience() // enable the opt-in bed if it's off
    sfx.stopBed()
    sfx.startBed({ voices: build }) // sfx remembers this builder, so the Theme row rebuilds THIS room per palette
    for (const b of roomBtns) b.dataset.on = b === btn ? '1' : '0'
    refreshStatus()
    log(`ambient room → ${label} @ ${getThemeId()} — switch themes above to hear it in each palette`)
  }
  for (const r of ROOMS) {
    const b = button(row, r.label, () => playRoom(r.label, r.build, b), 'toggle big')
    b.dataset.on = '0'
    roomBtns.push(b)
  }
  button(row, '■ stop bed', () => {
    sfx.stopBed()
    for (const b of roomBtns) b.dataset.on = '0'
    log('bed stopped')
  })
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

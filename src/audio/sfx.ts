/**
 * Procedural Web Audio SFX for Viva Ton.
 *
 * Every sound is synthesized at runtime from oscillators, noise buffers, filters
 * and gain envelopes — the PWA ships ZERO audio assets and stays fully offline.
 * All calls are fire-and-forget and swallow errors: if the AudioContext is
 * unavailable the game simply runs silent, never throwing.
 */

import { getTheme } from '../view/theme'

const MUTE_KEY = 'viva-ton:muted'
const SWAP_KEY = 'viva-ton:swapSound'
const AMBIENCE_KEY = 'viva-ton:ambience'

/** Subtle level every dry voice bleeds into the shared reverb bus (§E3-A1) — a light send, not a wash. */
const REVERB_SEND = 0.12

/** Major-pentatonic semitone classes — the key-lock scale (§E3-A10). */
const PENTATONIC = [0, 2, 4, 7, 9]

/** Selectable "move a piece" sound. 'silk'/'chime'/'aurora' are the smooth/mystical set. */
export type SwapSound = 'silk' | 'chime' | 'aurora' | 'classic'
export const SWAP_SOUNDS: SwapSound[] = ['silk', 'chime', 'aurora', 'classic']
export const SWAP_SOUND_LABELS: Record<SwapSound, string> = {
  silk: 'SILK',
  chime: 'CHIME',
  aurora: 'AURORA',
  classic: 'CLASSIC',
}
const DEFAULT_SWAP: SwapSound = 'silk'

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    // storage blocked (private mode / no DOM) — mute just won't persist
  }
}

function readSwap(): SwapSound {
  try {
    const v = localStorage.getItem(SWAP_KEY)
    return (SWAP_SOUNDS as string[]).includes(v ?? '') ? (v as SwapSound) : DEFAULT_SWAP
  } catch {
    return DEFAULT_SWAP
  }
}

function writeSwap(s: SwapSound): void {
  try {
    localStorage.setItem(SWAP_KEY, s)
  } catch {
    // best-effort only
  }
}

/** Ambient bed opt-in flag — persisted exactly like mute (§E3-A2). Default OFF: a gift never surprises with a drone. */
function readAmbience(): boolean {
  try {
    return localStorage.getItem(AMBIENCE_KEY) === '1'
  } catch {
    return false
  }
}

function writeAmbience(on: boolean): void {
  try {
    localStorage.setItem(AMBIENCE_KEY, on ? '1' : '0')
  } catch {
    // storage blocked — ambience just won't persist
  }
}

interface ToneOpts {
  type: OscillatorType
  freq: number
  /** Exponential glide target reached at start+dur. */
  endFreq?: number
  peak: number
  dur: number
  attack?: number
  delay?: number
}

class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  /** Every one-shot lands here (dry). Fans out to master + a subtle shared reverb send (§A1). */
  private dryBus: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private started = false
  private _muted = false
  private _swapSound: SwapSound = DEFAULT_SWAP

  // --- Shared reverb bus (§E3-A1) ---
  private reverbWet: GainNode | null = null
  private reverbFb: GainNode[] = []
  private reverbDamp: BiquadFilterNode[] = []

  // --- Cascade riser (§E3/E11) — ONE continuous low voice, retriggered per wave, never accumulating ---
  private riserNodes: AudioScheduledSourceNode[] = []
  private riserGain: GainNode | null = null

  // --- Ambient bed (§E3-A2) ---
  private _ambience = false
  private bedRunning = false
  private bedNodes: AudioScheduledSourceNode[] = []
  private bedMaster: GainNode | null = null // overall bed level (LFO rides on top)
  private bedDuck: GainNode | null = null // 1 → dips under wins (§A4) → 1
  private bedMute: GainNode | null = null // 1 → 0 on tab-blur (§A2 suspend)

  get muted(): boolean {
    return this._muted
  }

  /** Whether the opt-in ambient bed is enabled (default OFF). */
  get ambience(): boolean {
    return this._ambience
  }

  get swapSound(): SwapSound {
    return this._swapSound
  }

  /** Persist the chosen "move a piece" sound. */
  setSwapSound(s: SwapSound): void {
    this._swapSound = s
    writeSwap(s)
  }

  /**
   * Attach the one-time autoplay-unlock listener and restore the persisted mute
   * flag. iOS/Chrome refuse to start audio without a user gesture, so we resume
   * (and lazily create) the context on the first real pointerdown — once, in the
   * capture phase so it runs before any game handler. Idempotent.
   */
  init(): void {
    if (this.started) return
    this.started = true
    this._muted = readMuted()
    this._swapSound = readSwap()
    this._ambience = readAmbience() // flag only — the bed never auto-starts (§A2 default OFF)
    const unlock = () => {
      const ctx = this.ensureContext()
      if (ctx && ctx.state === 'suspended') void ctx.resume()
      window.removeEventListener('pointerdown', unlock, true)
    }
    try {
      window.addEventListener('pointerdown', unlock, true)
    } catch {
      // no DOM (tests / SSR) — audio stays disabled, game runs fine
    }
    // Tab-blur → silence the ambient bed (§A2). The game loop sleeps in main.ts, but the
    // AudioContext runs on its own thread and would keep droning; gain-to-zero suspends it.
    try {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.suspendBed()
          this.teardownRiser(0.05) // the one continuous partner voice must stop cleanly on blur (§A2)
        } else this.resumeBed()
      })
    } catch {
      // no DOM — nothing to suspend
    }
  }

  toggleMuted(): boolean {
    this._muted = !this._muted
    writeMuted(this._muted)
    // The bed is mute-gated: muting stops it; unmuting restarts it only if ambience is on.
    if (this._muted) this.stopBed()
    else if (this._ambience) this.startBed()
    return this._muted
  }

  /**
   * Toggle the opt-in ambient bed (§E3-A2) and persist it, mirroring mute. Turning it ON starts
   * the bed (it's a menu control, so this fires in a menu); OFF stops it. Returns the new state.
   */
  toggleAmbience(): boolean {
    this._ambience = !this._ambience
    writeAmbience(this._ambience)
    if (this._ambience) this.startBed()
    else this.stopBed()
    return this._ambience
  }

  // ------------------------------------------------------------ audio graph

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      const ctx = new Ctor()
      const master = ctx.createGain()
      master.gain.value = 0.5
      // Gentle limiter so stacked cascade voices never clip harshly.
      const comp = ctx.createDynamicsCompressor()
      master.connect(comp)
      comp.connect(ctx.destination)
      this.ctx = ctx
      this.master = master
      // Dry bus: every one-shot lands here, then fans out to master (dry) + reverb (subtle tail).
      const dryBus = ctx.createGain()
      dryBus.gain.value = 1
      dryBus.connect(master)
      this.dryBus = dryBus
      this.buildReverb(ctx, master, dryBus)
    } catch {
      this.ctx = null
      this.master = null
      this.dryBus = null
    }
    return this.ctx
  }

  /**
   * Shared reverb/space bus (§E3-A1) — a small FDN of 4 damped feedback delay lines. The dry bus
   * bleeds a SUBTLE tail into it so every disparate one-shot sits in one lounge (the sonic vignette).
   * No outer loop: master never feeds back here, and each line's feedback stays < 1 → always stable.
   */
  private buildReverb(ctx: AudioContext, master: GainNode, dryBus: GainNode): void {
    const send = ctx.createGain()
    send.gain.value = REVERB_SEND
    dryBus.connect(send) // one shared, light send for the whole mix
    const wet = ctx.createGain()
    wet.connect(master)
    const times = [0.0297, 0.0371, 0.0411, 0.0437] // mutually-prime-ish delays
    this.reverbFb = []
    this.reverbDamp = []
    for (const dt of times) {
      const d = ctx.createDelay(0.5)
      d.delayTime.value = dt
      const damp = ctx.createBiquadFilter()
      damp.type = 'lowpass'
      const fb = ctx.createGain()
      send.connect(d)
      d.connect(damp)
      damp.connect(fb)
      fb.connect(d) // feedback loop (gain < 1 → stable), damped each pass
      d.connect(wet) // tap to output
      this.reverbFb.push(fb)
      this.reverbDamp.push(damp)
    }
    this.reverbWet = wet
    this.applyReverbTheme() // set wet/feedback/damp from the active theme's palette
  }

  /** Tune the reverb's wet level + tail length + brightness from the active theme (§A3). Never louder — tonal only. */
  private applyReverbTheme(): void {
    const pal = getTheme().audio
    if (this.reverbWet) this.reverbWet.gain.value = pal.reverbMix
    const fb = Math.min(0.78, 0.6 + pal.reverbMix * 0.4) // higher mix → longer tail
    for (const g of this.reverbFb) g.gain.value = fb
    const damp = Math.max(1500, Math.min(6000, 1800 + pal.filterWarmth * 1.5)) // brighter/darker tail
    for (const f of this.reverbDamp) f.frequency.value = damp
  }

  /** Run a voice builder against a live context. Never throws. `force` plays through mute
   * (for the sound picker preview, where a tap is an explicit request to hear it). */
  private voice(build: (ctx: AudioContext, t: number, out: AudioNode) => void, force = false): void {
    if (this._muted && !force) return
    const ctx = this.ensureContext()
    if (!ctx || !this.dryBus) return
    if (ctx.state === 'suspended') void ctx.resume()
    try {
      // Voices land on the dry bus (→ master + a subtle shared reverb tail), not master directly.
      build(ctx, ctx.currentTime, this.dryBus)
    } catch {
      // an effect must never break the game loop
    }
  }

  // ------------------------------------------------------------- key-lock (§A10)

  /**
   * Snap a frequency to the nearest note of the theme's C-pentatonic scale (rooted on `bedRoot`),
   * so busy cascades arpeggiate consonantly. Purely tonal — the nudge is < ~1.5 semitones and never
   * touches gain, so nothing gets louder. Safe on any input (bad values pass through untouched).
   */
  private snap(freq: number): number {
    const root = getTheme().audio.bedRoot
    if (!(freq > 0) || !(root > 0)) return freq
    const n = 12 * Math.log2(freq / root) // semitones above the root
    const oct = Math.floor(n / 12)
    const within = n - oct * 12
    let best = 0
    let bestErr = Infinity
    for (const wrap of [-12, 0, 12]) {
      for (const pc of PENTATONIC) {
        const err = Math.abs(within - (pc + wrap))
        if (err < bestErr) {
          bestErr = err
          best = pc + wrap
        }
      }
    }
    return root * Math.pow(2, (oct * 12 + best) / 12)
  }

  // -------------------------------------------------------------- stereo pan (§A8)

  /** Wrap `out` in a StereoPannerNode when `pan` ≠ 0 (equal-power, so centre = no loudness change). */
  private panOut(ctx: AudioContext, out: AudioNode, pan: number): AudioNode {
    if (!pan || typeof ctx.createStereoPanner !== 'function') return out
    try {
      const p = ctx.createStereoPanner()
      p.pan.value = Math.max(-1, Math.min(1, pan))
      p.connect(out)
      return p
    } catch {
      return out
    }
  }

  private getNoise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const len = Math.floor(ctx.sampleRate * 0.8)
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
      this.noiseBuffer = buf
    }
    return this.noiseBuffer
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource()
    src.buffer = this.getNoise(ctx)
    return src
  }

  /** Enveloped oscillator with an optional exponential pitch glide. */
  private tone(ctx: AudioContext, out: AudioNode, t: number, o: ToneOpts): void {
    const start = t + (o.delay ?? 0)
    const osc = ctx.createOscillator()
    osc.type = o.type
    osc.frequency.setValueAtTime(o.freq, start)
    if (o.endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), start + o.dur)
    const g = ctx.createGain()
    const attack = o.attack ?? 0.006
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(o.peak, start + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, start + o.dur)
    osc.connect(g).connect(out)
    osc.start(start)
    osc.stop(start + o.dur + 0.02)
  }

  // ---------------------------------------------------------------- effects

  /** Soft UI click. */
  uiTap(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'triangle', freq: 620, endFreq: 430, peak: 0.32, dur: 0.07 })
    })
  }

  /** Play the currently-selected "move a piece" sound. */
  swap(): void {
    this.playSwap(this._swapSound, false)
  }

  /** Audition a specific move sound (plays through mute — the picker tap is an explicit request). */
  previewSwap(s: SwapSound): void {
    this.playSwap(s, true)
  }

  private playSwap(s: SwapSound, force: boolean): void {
    if (s === 'silk') this.swapSilk(force)
    else if (s === 'chime') this.swapChime(force)
    else if (s === 'aurora') this.swapAurora(force)
    else this.swapClassic(force)
  }

  /** SILK — warm sine + soft fifth gliding up through a low-pass, with a breath of air. Smooth. */
  private swapSilk(force: boolean): void {
    this.voice((ctx, t, out) => {
      const glide = (freq: number) => {
        const o = ctx.createOscillator()
        o.type = 'sine'
        o.frequency.setValueAtTime(freq, t)
        o.frequency.exponentialRampToValueAtTime(freq * 1.6, t + 0.15)
        return o
      }
      const o1 = glide(300)
      const o2 = glide(450) // a gentle perfect fifth for warmth
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(700, t)
      lp.frequency.exponentialRampToValueAtTime(2200, t + 0.15)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.24, t + 0.05)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
      o1.connect(lp)
      o2.connect(lp)
      lp.connect(g).connect(out)
      o1.start(t)
      o1.stop(t + 0.28)
      o2.start(t)
      o2.stop(t + 0.28)
      // faint low-passed air
      const n = this.noiseSource(ctx)
      const nlp = ctx.createBiquadFilter()
      nlp.type = 'lowpass'
      nlp.frequency.value = 1300
      const ng = ctx.createGain()
      ng.gain.setValueAtTime(0.0001, t)
      ng.gain.exponentialRampToValueAtTime(0.045, t + 0.05)
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
      n.connect(nlp).connect(ng).connect(out)
      n.start(t)
      n.stop(t + 0.24)
    }, force)
  }

  /** CHIME — a soft glassy bell (inharmonic partials) with a gentle upward pull. Mystical. */
  private swapChime(force: boolean): void {
    this.voice((ctx, t, out) => {
      const base = 587.33 // D5
      const partials: Array<[number, number, number]> = [
        [1, 0.2, 0.34],
        [2.01, 0.1, 0.24],
        [3.02, 0.05, 0.18],
        [4.31, 0.03, 0.14],
      ]
      for (const [m, p, d] of partials) {
        this.tone(ctx, out, t, { type: 'sine', freq: base * m, peak: p, dur: d, attack: 0.005 })
      }
      this.tone(ctx, out, t, { type: 'sine', freq: base * 0.75, endFreq: base * 1.01, peak: 0.07, dur: 0.2, attack: 0.02 })
    }, force)
  }

  /** AURORA — two detuned triangles swelling through an opening filter, with an ethereal
   * feedback-delay shimmer tail. Airy, "pulling you in". */
  private swapAurora(force: boolean): void {
    this.voice((ctx, t, out) => {
      const mk = (detune: number) => {
        const o = ctx.createOscillator()
        o.type = 'triangle'
        o.detune.value = detune
        o.frequency.setValueAtTime(330, t)
        o.frequency.exponentialRampToValueAtTime(500, t + 0.2)
        return o
      }
      const o1 = mk(-8)
      const o2 = mk(8)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.Q.value = 5
      lp.frequency.setValueAtTime(520, t)
      lp.frequency.exponentialRampToValueAtTime(2400, t + 0.2)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.06)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3)
      const delay = ctx.createDelay(0.5)
      delay.delayTime.value = 0.12
      const fb = ctx.createGain()
      fb.gain.value = 0.3
      const wet = ctx.createGain()
      wet.gain.setValueAtTime(0.4, t)
      wet.gain.setValueAtTime(0.4, t + 0.3)
      wet.gain.exponentialRampToValueAtTime(0.0001, t + 0.75)
      o1.connect(lp)
      o2.connect(lp)
      lp.connect(g)
      g.connect(out) // dry
      g.connect(delay)
      delay.connect(fb)
      fb.connect(delay)
      delay.connect(wet).connect(out) // wet shimmer
      o1.start(t)
      o1.stop(t + 0.32)
      o2.start(t)
      o2.stop(t + 0.32)
    }, force)
  }

  /** CLASSIC — the original filtered-noise "whoosh". */
  private swapClassic(force: boolean): void {
    this.voice((ctx, t, out) => {
      const src = this.noiseSource(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.9
      bp.frequency.setValueAtTime(420, t)
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.17)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.28, t + 0.04)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.22)
    }, force)
  }

  /** Low damped thud plus a tiny click — the invalid snap-back. */
  invalidThud(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'sine', freq: 155, endFreq: 68, peak: 0.5, dur: 0.19, attack: 0.008 })
      const src = this.noiseSource(ctx)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 480
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.22, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
      src.connect(lp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.08)
    })
  }

  /**
   * Signature clear blip — a bright coin-like "ding" that rises one semitone per
   * cascade step (rate = 2^((cascade-1)/12)).
   */
  pop(cascade: number, pan = 0): void {
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan) // pan by board column (§A8); centre by default
      const rate = Math.pow(2, (Math.max(1, cascade) - 1) / 12)
      const base = this.snap(880 * rate) // key-lock: cascades arpeggiate on the theme scale (§A10)
      // quick upward chirp with fast decay = coin flip
      this.tone(ctx, out, t, { type: 'triangle', freq: base, endFreq: base * 1.5, peak: 0.34, dur: 0.18 })
      // octave-up sine sparkle = casino "ding"
      this.tone(ctx, out, t, { type: 'sine', freq: base * 2, peak: 0.16, dur: 0.12 })
    })
  }

  /** Rising zipper/ratchet: a rapid tick train with an upward pitch ramp. */
  reelSweep(pan = 0): void {
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan) // pan by board column (§A8)
      const ticks = 14
      for (let i = 0; i < ticks; i++) {
        this.tone(ctx, out, t, {
          type: 'square',
          freq: 300 + i * 92,
          peak: 0.11,
          dur: 0.014,
          attack: 0.002,
          delay: i * 0.02,
        })
      }
    })
  }

  /** Noise burst plus a 90->40Hz sine drop — the dice-bomb detonation (~350ms). */
  bombBoom(pan = 0): void {
    this.duckBed() // bed inhales under the detonation (§A4)
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan) // detonation pans by board column (§A8)
      this.tone(ctx, out, t, { type: 'sine', freq: 90, endFreq: 40, peak: 0.6, dur: 0.3, attack: 0.01 })
      const src = this.noiseSource(ctx)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(1800, t)
      lp.frequency.exponentialRampToValueAtTime(200, t + 0.3)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.5, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32)
      src.connect(lp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.34)
    })
  }

  /** Dramatic two-tone siren wail with a bell on top — the jackpot strike (~900ms). */
  jackpotStrike(): void {
    this.duckBed(0.4, 1.0) // bed inhales under the jackpot (§A4)
    this.voice((ctx, t, out) => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      const lo = 520
      const hi = 1040
      osc.frequency.setValueAtTime(lo, t)
      osc.frequency.linearRampToValueAtTime(hi, t + 0.22)
      osc.frequency.linearRampToValueAtTime(lo, t + 0.44)
      osc.frequency.linearRampToValueAtTime(hi, t + 0.66)
      osc.frequency.linearRampToValueAtTime(lo, t + 0.88)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 900
      bp.Q.value = 1.3
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.26, t + 0.05)
      g.gain.setValueAtTime(0.26, t + 0.8)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
      osc.connect(bp).connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.92)
      // shimmering bell over the wail
      this.tone(ctx, out, t, { type: 'sine', freq: 1568, peak: 0.16, dur: 0.5, attack: 0.02 })
    })
  }

  /** i-th of three ascending bell dings, played per win star. */
  starDing(i: number): void {
    this.voice((ctx, t, out) => {
      const freqs = [1046.5, 1318.5, 1568.0] // C6 E6 G6
      const f = this.snap(freqs[Math.max(0, Math.min(freqs.length - 1, i))]) // dings in the theme's key (§A10)
      this.tone(ctx, out, t, { type: 'sine', freq: f, peak: 0.34, dur: 0.42, attack: 0.005 })
      this.tone(ctx, out, t, { type: 'sine', freq: f * 2.01, peak: 0.11, dur: 0.28, attack: 0.005 })
    })
  }

  /** Short rising major arpeggio with a shimmer tail — the win fanfare (~1.2s). */
  winFanfare(): void {
    this.riserResolve() // the cascade riser hands its crescendo off to the fanfare (§E11), never overlapping it
    this.duckBed(0.45, 1.2) // bed inhales under the fanfare (§A4)
    this.voice((ctx, t, out) => {
      const notes = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
      notes.forEach((f, i) => {
        const delay = i * 0.12
        this.tone(ctx, out, t, { type: 'triangle', freq: f, peak: 0.3, dur: 0.5, attack: 0.02, delay })
        this.tone(ctx, out, t, { type: 'sine', freq: f * 2, peak: 0.1, dur: 0.3, attack: 0.02, delay })
      })
      // sustained sparkle chord to close it out
      const tail = notes.length * 0.12
      for (const f of [1046.5, 1318.5, 1568.0]) {
        this.tone(ctx, out, t, { type: 'sine', freq: f, peak: 0.11, dur: 0.7, attack: 0.05, delay: tail })
      }
    })
  }

  /**
   * The "Ton" leitmotif (§E4) — the ownable signature. A 3-note RISING motif (major-third → fifth →
   * octave) closed by winFanfare's sparkle-chord tail, KEY-LOCKED to the active theme (each degree
   * snapped to the theme's pentatonic, anchored 3 octaves above `bedRoot`) and bathed in the shared
   * reverb room, so it "sits in the theme's lounge." This voice is fired ONLY by the Heartbloom hero
   * win (PERFECT / jackpot / daily claim) and plays NOWHERE else — that scarcity is what keeps it the
   * one phrase people hum. Deliberately distinct from winFanfare (full 4-note arpeggio) and
   * jackpotStrike (siren wail). Mute-gated like every voice.
   */
  mayaMotif(): void {
    this.duckBed(0.4, 1.4) // the bed inhales under the leitmotif (§A4)
    this.voice((ctx, t, out) => {
      // Anchor 3 octaves above the theme root, then snap each rising degree into the theme's key (§A10).
      const base = getTheme().audio.bedRoot * 8
      const notes = [
        this.snap(base * Math.pow(2, 4 / 12)), // major third — "Ma"
        this.snap(base * Math.pow(2, 7 / 12)), // perfect fifth — "a"
        this.snap(base * 2), // octave — "ya", the resolving lift
      ]
      const step = 0.16 // a touch slower than winFanfare's 0.12 → a deliberate, singable phrase
      notes.forEach((f, i) => {
        const delay = i * step
        this.tone(ctx, out, t, { type: 'triangle', freq: f, peak: 0.3, dur: 0.6, attack: 0.02, delay })
        this.tone(ctx, out, t, { type: 'sine', freq: f * 2, peak: 0.1, dur: 0.34, attack: 0.02, delay })
      })
      // winFanfare's sustained sparkle-chord tail, snapped to key, closing the motif out.
      const tail = notes.length * step + 0.05
      for (const f of [1046.5, 1318.5, 1568.0]) {
        this.tone(ctx, out, t, { type: 'sine', freq: this.snap(f), peak: 0.11, dur: 0.8, attack: 0.05, delay: tail })
      }
    })
  }

  /**
   * Coin roll-up tally — ~8 ascending metallic pings (a brighter, pitched-up cousin of
   * reelSweep's tick train) closed by a 2-note "cha-ching" (the top two winFanfare notes).
   * Scores the payout counter as it rolls 0→reward.
   */
  coinCount(): void {
    this.voice((ctx, t, out) => {
      const pings = 8
      for (let i = 0; i < pings; i++) {
        const f = this.snap(880 * Math.pow(2, i / 12)) // key-locked climb — arpeggiates in scale (§A10)
        const delay = i * 0.07
        this.tone(ctx, out, t, { type: 'triangle', freq: f, endFreq: f * 1.5, peak: 0.16, dur: 0.07, attack: 0.003, delay })
        this.tone(ctx, out, t, { type: 'sine', freq: f * 2, peak: 0.07, dur: 0.05, attack: 0.003, delay })
      }
      // 2-note "cha-ching" (G5 → C6, the top two winFanfare notes) on completion — snapped to key.
      const end = pings * 0.07 + 0.04
      const chaA = this.snap(783.99)
      const chaB = this.snap(1046.5)
      this.tone(ctx, out, t, { type: 'triangle', freq: chaA, peak: 0.24, dur: 0.14, attack: 0.004, delay: end })
      this.tone(ctx, out, t, { type: 'sine', freq: chaA * 2, peak: 0.1, dur: 0.12, attack: 0.004, delay: end })
      this.tone(ctx, out, t, { type: 'triangle', freq: chaB, peak: 0.26, dur: 0.32, attack: 0.004, delay: end + 0.12 })
      this.tone(ctx, out, t, { type: 'sine', freq: chaB * 2, peak: 0.11, dur: 0.26, attack: 0.004, delay: end + 0.12 })
    })
  }

  /** Two-note descending "wah-wah" — the lose sting (~700ms). */
  loseWah(): void {
    this.voice((ctx, t, out) => {
      const notes = [
        { f: 311.13, at: t }, // Eb4
        { f: 261.63, at: t + 0.34 }, // C4
      ]
      for (const { f, at } of notes) {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(f, at)
        osc.frequency.linearRampToValueAtTime(f * 0.94, at + 0.3) // droop
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.setValueAtTime(1200, at)
        lp.frequency.exponentialRampToValueAtTime(480, at + 0.3) // "wah" close
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, at)
        g.gain.exponentialRampToValueAtTime(0.3, at + 0.03)
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.33)
        osc.connect(lp).connect(g).connect(out)
        osc.start(at)
        osc.stop(at + 0.35)
      }
    })
  }

  /** Small tick sound for progressive pot increment. */
  potTick(): void {
    this.voice((ctx, t, out) => {
      const f = this.snap(1200)
      this.tone(ctx, out, t, { type: 'triangle', freq: f, endFreq: f * 1.2, peak: 0.12, dur: 0.05, attack: 0.002 })
      this.tone(ctx, out, t, { type: 'sine', freq: f * 2, peak: 0.06, dur: 0.03, attack: 0.002 })
    })
  }

  /** Escalating riser followed by explosive boom and golden ring for progressive pot jackpot. */
  potPop(): void {
    this.voice((ctx, t, out) => {
      this.duckBed(0.1, 1.8)
      
      const oscRiser = ctx.createOscillator()
      oscRiser.type = 'sine'
      oscRiser.frequency.setValueAtTime(220, t)
      oscRiser.frequency.exponentialRampToValueAtTime(880, t + 0.6)
      const gainRiser = ctx.createGain()
      gainRiser.gain.setValueAtTime(0.0001, t)
      gainRiser.gain.exponentialRampToValueAtTime(0.25, t + 0.5)
      gainRiser.gain.exponentialRampToValueAtTime(0.0001, t + 0.6)
      oscRiser.connect(gainRiser).connect(out)
      oscRiser.start(t)
      oscRiser.stop(t + 0.6)

      const tBoom = t + 0.6
      this.tone(ctx, out, tBoom, { type: 'sine', freq: 150, endFreq: 38, peak: 0.8, dur: 0.8, attack: 0.01 })
      
      const bellFreqs = [880, 1320, 1760, 2640]
      bellFreqs.forEach((f, idx) => {
        const peak = 0.18 / (idx + 1)
        this.tone(ctx, out, tBoom, { type: 'sine', freq: this.snap(f), peak, dur: 1.2, attack: 0.005 })
      })

      const noise = this.noiseSource(ctx)
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(1000, tBoom)
      filter.frequency.exponentialRampToValueAtTime(150, tBoom + 0.6)
      const gainNoise = ctx.createGain()
      gainNoise.gain.setValueAtTime(0.0001, tBoom)
      gainNoise.gain.exponentialRampToValueAtTime(0.35, tBoom + 0.03)
      gainNoise.gain.exponentialRampToValueAtTime(0.0001, tBoom + 0.7)
      
      noise.connect(filter).connect(gainNoise).connect(out)
      noise.start(tBoom)
      noise.stop(tBoom + 0.75)
    })
  }

  /** Soft swirling filtered noise — the board reshuffle. */
  reshuffleSwirl(): void {
    this.voice((ctx, t, out) => {
      const src = this.noiseSource(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 3
      bp.frequency.setValueAtTime(600, t)
      bp.frequency.linearRampToValueAtTime(1500, t + 0.2)
      bp.frequency.linearRampToValueAtTime(560, t + 0.42)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.24, t + 0.08)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.46)
    })
  }

  // ------------------------------------------------- per-beat partners (§E3 B14)
  // Subtle one-shot VOICES that give each new visual beat an audible partner. Every one routes
  // through voice() (→ dry bus + shared reverb room), key-locks pitched material via snap(), pans
  // where the beat is positional, and stays QUIETER than the existing lead SFX — partners, not leads.

  /**
   * Soft low "thock" on a button PRESS (pointerdown) — the depress, distinct from `uiTap`'s brighter
   * pointerup release click. Lower, rounder, and quieter so a press+release reads as one tactile event.
   */
  uiPress(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'sine', freq: 200, endFreq: 128, peak: 0.16, dur: 0.06, attack: 0.004 })
      const src = this.noiseSource(ctx)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 700
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.06, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
      src.connect(lp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.05)
    })
  }

  /** Short airy filtered-noise sweep — a subtle partner for scene cross-fades + panel open/close. */
  whoosh(pan = 0): void {
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan)
      const src = this.noiseSource(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.7
      bp.frequency.setValueAtTime(500, t)
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.12)
      bp.frequency.exponentialRampToValueAtTime(700, t + 0.26)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.06) // subtle — never a lead
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.3)
    })
  }

  /**
   * Light glassy "tink" on a match-clear pop — an octave above `pop`'s climb, key-locked to the same
   * scale (§A10) so it shimmers consonantly over the cascade, panned by board column (§A8). Kept very
   * quiet so a busy wave stays musical rather than clacky.
   */
  clearTink(cascade = 1, pan = 0): void {
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan)
      const rate = Math.pow(2, (Math.max(1, cascade) - 1) / 12)
      const f = this.snap(1760 * rate)
      this.tone(ctx, out, t, { type: 'sine', freq: f, peak: 0.07, dur: 0.09, attack: 0.002 })
      this.tone(ctx, out, t, { type: 'sine', freq: f * 2.01, peak: 0.03, dur: 0.06, attack: 0.002 })
    })
  }

  /**
   * Height-mapped landing thunk for deal-in + refill settles (§E5). `height` ∈ 0..1 (drop distance /
   * board height): a deep drop reads as a low, weighty thunk; a short one as a light tick. Panned by
   * column (§A8). Callers throttle to one voice per settling column so a refill is a rain, not mush.
   */
  land(height = 0.5, pan = 0): void {
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan)
      const h = Math.max(0, Math.min(1, height))
      const f = 190 - 95 * h // heavier (lower) with drop distance
      this.tone(ctx, out, t, { type: 'sine', freq: f, endFreq: f * 0.7, peak: 0.1 + 0.12 * h, dur: 0.08 + 0.05 * h, attack: 0.004 })
      const src = this.noiseSource(ctx)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 500
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.05 + 0.05 * h, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
      src.connect(lp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.04)
    })
  }

  /** Short rising tick — the special-piece charge→release wind-up (§E6). Key-locked, subtle. */
  charge(cascade = 1): void {
    this.voice((ctx, t, out) => {
      const rate = Math.pow(2, (Math.max(1, cascade) - 1) / 12)
      const base = this.snap(440 * rate)
      this.tone(ctx, out, t, { type: 'triangle', freq: base, endFreq: base * 3, peak: 0.12, dur: 0.09, attack: 0.006 })
    })
  }

  /** Tiny key-locked tick under a chunky score climb (composes with — never doubles — `coinCount`). */
  scoreTick(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'triangle', freq: this.snap(1320), peak: 0.08, dur: 0.05, attack: 0.002 })
    })
  }

  /** Mechanical reel-landing clunk — a wood-block detent + short clack for a slot reel settling. Panned by reel. */
  reelClunk(pan = 0): void {
    this.voice((ctx, t, out0) => {
      const out = this.panOut(ctx, out0, pan)
      this.tone(ctx, out, t, { type: 'triangle', freq: 150, endFreq: 90, peak: 0.28, dur: 0.1, attack: 0.003 })
      const src = this.noiseSource(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 1.2
      bp.frequency.value = 1400
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.14, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.06)
    })
  }

  // ------------------------------------------------- cascade riser (§E3 / E11)

  /**
   * Low bass bed that ratchets UP one key-locked step per cascade wave and resolves into `winFanfare`
   * (§E11) — ties the audio arc to the visual combo arc. Exactly ONE voice: each wave stops/retriggers
   * the previous so oscillators NEVER accumulate, and every voice self-stops after ~2.3s so a stalled
   * cascade can't drone. Mute-gated; sits in the shared reverb room via the dry bus.
   */
  cascadeRiser(cascade: number): void {
    if (this._muted) return
    const ctx = this.ensureContext()
    if (!ctx || !this.dryBus) return
    if (ctx.state === 'suspended') void ctx.resume()
    try {
      this.teardownRiser(0.05) // fade + stop the previous wave's voice first — never accumulate
      const t = ctx.currentTime
      const step = Math.max(1, cascade)
      const level = Math.min(0.12, 0.05 + step * 0.015) // subtle, capped — a bed, never a lead
      const root = getTheme().audio.bedRoot
      const f = this.snap(root * 2 * Math.pow(2, Math.min(step - 1, 7) / 12)) // climbs, capped at +7 steps
      const g = ctx.createGain()
      g.gain.setValueAtTime(Math.max(0.0001, this.riserGain ? 0.02 : 0.0001), t)
      g.gain.linearRampToValueAtTime(level, t + 0.12) // swell in
      g.gain.setValueAtTime(level, t + 1.2)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2) // auto-fade safety
      g.connect(this.dryBus)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 420 + step * 60
      lp.connect(g)
      const mk = (detune: number): OscillatorNode => {
        const o = ctx.createOscillator()
        o.type = 'sawtooth'
        o.frequency.setValueAtTime(f, t)
        o.frequency.linearRampToValueAtTime(f * 1.06, t + 1.2) // slow rising tension
        o.detune.value = detune
        o.connect(lp)
        o.start(t)
        o.stop(t + 2.3) // self-stop so a never-resolved riser can't leak oscillators
        return o
      }
      this.riserGain = g
      this.riserNodes = [mk(-7), mk(7)]
    } catch {
      this.riserNodes = []
      this.riserGain = null
    }
  }

  /** Resolve the cascade riser — a short fade-out that hands off to the win fanfare. Idempotent. */
  riserResolve(): void {
    this.teardownRiser(0.3)
  }

  /** Fade + stop the current riser voice cleanly (no-op if none). Shared by retrigger/resolve/blur. */
  private teardownRiser(fade = 0.2): void {
    const ctx = this.ctx
    const g = this.riserGain
    const nodes = this.riserNodes
    this.riserGain = null
    this.riserNodes = []
    if (!ctx) return
    try {
      const t = ctx.currentTime
      if (g) {
        g.gain.cancelScheduledValues(t)
        g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t)
        g.gain.exponentialRampToValueAtTime(0.0001, t + fade)
      }
      for (const o of nodes) {
        try {
          o.stop(t + fade + 0.05)
        } catch {
          // already stopped
        }
      }
    } catch {
      // teardown must never throw
    }
  }

  // ---------------------------------------------------------- ambient bed (§A2)

  /**
   * Start the opt-in ambient bed (§E3-A2): a warm detuned pad + low room-tone under one slow LFO
   * "breath", voiced in the active theme's palette (§A3). Only runs when ambience is ON, not muted,
   * and the tab is visible. Intended for MENUS — scenes call `stopBed()` when gameplay begins.
   * Idempotent. Reads `getTheme().audio`, so a P8 `scene.restart()` rebuilds it in the new room.
   */
  startBed(): void {
    if (this.bedRunning || !this._ambience || this._muted) return
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return
    if (ctx.state === 'suspended') void ctx.resume()
    try {
      const pal = getTheme().audio
      const t = ctx.currentTime
      // Chain: [pad + room-tone] → warmth LPF → bedMaster(LFO) → bedDuck(§A4) → bedMute(blur) → master
      const bedMute = ctx.createGain()
      bedMute.gain.value = typeof document !== 'undefined' && document.hidden ? 0 : 1
      bedMute.connect(this.master)
      const bedDuck = ctx.createGain()
      bedDuck.gain.value = 1
      bedDuck.connect(bedMute)
      const bedMaster = ctx.createGain()
      const level = 0.05 // very quiet — a bed, never louder than the one-shots on top
      bedMaster.gain.value = level
      bedMaster.connect(bedDuck)
      const warmth = ctx.createBiquadFilter()
      warmth.type = 'lowpass'
      warmth.frequency.value = pal.filterWarmth
      warmth.Q.value = 0.6
      warmth.connect(bedMaster)

      const nodes: AudioScheduledSourceNode[] = []
      // Detuned pad: root + fifth + octave, softly spread for a warm chord.
      const voices: Array<[number, number]> = [
        [pal.bedRoot, -6],
        [pal.bedRoot, 6],
        [pal.bedRoot * 1.5, -4], // a perfect fifth
        [pal.bedRoot * 2, 3], // octave shimmer
      ]
      for (const [freq, detune] of voices) {
        const o = ctx.createOscillator()
        o.type = pal.waveBias
        o.frequency.value = freq
        o.detune.value = detune
        const vg = ctx.createGain()
        vg.gain.value = 0.25
        o.connect(vg).connect(warmth)
        o.start(t)
        nodes.push(o)
      }
      // Low room-tone: filtered noise, barely there, grounds the pad.
      const room = this.noiseSource(ctx)
      room.loop = true
      const roomLp = ctx.createBiquadFilter()
      roomLp.type = 'lowpass'
      roomLp.frequency.value = 220
      const roomG = ctx.createGain()
      roomG.gain.value = 0.12
      room.connect(roomLp).connect(roomG).connect(warmth)
      room.start(t)
      nodes.push(room)

      // One slow LFO breath (~16s period, matching the backdrop's slow breath) swelling the level.
      const lfo = ctx.createOscillator()
      lfo.type = 'sine'
      lfo.frequency.value = 0.06
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = level * 0.4
      lfo.connect(lfoDepth).connect(bedMaster.gain)
      lfo.start(t)
      nodes.push(lfo)

      // Fade the bed in gently so opting in never pops.
      bedMaster.gain.cancelScheduledValues(t)
      bedMaster.gain.setValueAtTime(0.0001, t)
      bedMaster.gain.linearRampToValueAtTime(level, t + 1.2)

      this.bedNodes = nodes
      this.bedMaster = bedMaster
      this.bedDuck = bedDuck
      this.bedMute = bedMute
      this.bedRunning = true
    } catch {
      this.bedRunning = false
    }
  }

  /** Stop and tear down the ambient bed. Idempotent. */
  stopBed(): void {
    if (!this.bedRunning) return
    this.bedRunning = false
    const ctx = this.ctx
    try {
      if (ctx && this.bedMaster) {
        const t = ctx.currentTime
        this.bedMaster.gain.cancelScheduledValues(t)
        this.bedMaster.gain.setValueAtTime(Math.max(0.0001, this.bedMaster.gain.value), t)
        this.bedMaster.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
      }
      const stopAt = ctx ? ctx.currentTime + 0.45 : 0
      for (const n of this.bedNodes) {
        try {
          n.stop(stopAt)
        } catch {
          // already stopped
        }
      }
    } catch {
      // never let teardown throw
    }
    this.bedNodes = []
    this.bedMaster = null
    this.bedDuck = null
    this.bedMute = null
  }

  /** Tab-blur → silence the bed without tearing it down (§A2 suspend). */
  private suspendBed(): void {
    if (!this.bedRunning || !this.bedMute || !this.ctx) return
    try {
      const t = this.ctx.currentTime
      this.bedMute.gain.cancelScheduledValues(t)
      this.bedMute.gain.setValueAtTime(this.bedMute.gain.value, t)
      this.bedMute.gain.linearRampToValueAtTime(0, t + 0.15)
    } catch {
      // best-effort
    }
  }

  /** Tab-visible again → restore the bed (only if still enabled and unmuted). */
  private resumeBed(): void {
    if (!this.bedRunning || this._muted || !this._ambience || !this.bedMute || !this.ctx) return
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    try {
      const t = this.ctx.currentTime
      this.bedMute.gain.cancelScheduledValues(t)
      this.bedMute.gain.setValueAtTime(this.bedMute.gain.value, t)
      this.bedMute.gain.linearRampToValueAtTime(1, t + 0.4)
    } catch {
      // best-effort
    }
  }

  /** Bed "inhales" under a big one-shot (win/jackpot/bomb, §A4), recovering after. No-op if bed is off. */
  private duckBed(depth = 0.45, dur = 0.9): void {
    if (!this.bedRunning || !this.bedDuck || !this.ctx) return
    try {
      const t = this.ctx.currentTime
      const g = this.bedDuck.gain
      g.cancelScheduledValues(t)
      g.setValueAtTime(Math.max(0.0001, g.value), t)
      g.linearRampToValueAtTime(depth, t + 0.06) // quick inhale
      g.linearRampToValueAtTime(1, t + dur) // slow recovery
    } catch {
      // best-effort
    }
  }

  /**
   * Re-read the active theme's audio palette (§A3): retune the reverb bus and rebuild the bed in the
   * new room. Cheap to call on a theme swap; the scene-restart path gets a fresh bed for free anyway.
   */
  refreshTheme(): void {
    this.applyReverbTheme()
    if (this.bedRunning) {
      this.stopBed()
      this.startBed()
    }
  }
}

/** Shared singleton — import and call from any scene. */
export const sfx = new Sfx()

// Attach the autoplay-unlock listener as soon as the module loads.
if (typeof window !== 'undefined') sfx.init()

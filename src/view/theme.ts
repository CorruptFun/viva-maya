/**
 * Design-token layer for Viva Maya — the single source of truth for every brand
 * colour, wash, glow, gloss and text ink the visual overhaul reads from.
 *
 * Two representations, because Phaser needs both:
 *   - graphics colours are stored as NUMBERS  (fillStyle / lineStyle / setTint)
 *   - text colours are stored as CSS STRINGS  (Text `color`)
 * Bridge a number → CSS string with `css()`.
 *
 * Persistence mirrors `audio/sfx.ts`: one shape-tolerant `localStorage` key,
 * decoupled from `core/save.ts` for STORAGE (no save-schema migration). Theme
 * selection is ALWAYS FREE — never chip-priced. `getTheme()`/`setTheme()` never
 * gate; the picker consults the read-only `themeUnlocked(id, save)` helper (the only
 * save coupling, and read-only) for the two soft level-unlocks, at selection time.
 *
 * Apply model (§2.4): themes only change colours read at `create()`. Picking a
 * theme calls `setTheme(id)` then the scene restarts — there is no live re-tint.
 * Boot textures (symbols/chip/spark/…) are never re-baked; they carry Golden-Hour
 * warmth permanently and read fine on all four washes.
 */

import { endlessUnlocked } from '../core/endless'
import type { SaveData } from '../core/save'

export type ThemeId = 'golden' | 'roseMidnight' | 'neonVegas' | 'mayaHeart'

/**
 * Per-theme audio palette (§E3-A3) — makes each theme a *room you can hear*. Read by
 * `audio/sfx.ts` when it (re)builds the ambient bed and tunes the shared reverb bus, so
 * P8's `scene.restart()` rebuilds the bed in the new palette for free. Purely tonal:
 * changing these never changes loudness.
 */
export interface AudioPalette {
  /** Root frequency (Hz) of the ambient bed + the C-pentatonic key-lock scale (§A10). Low = warmer. */
  bedRoot: number
  /** Oscillator bias for the bed pad + tonal voices — sine=warm, triangle=soft, sawtooth=electric. */
  waveBias: OscillatorType
  /** Bed low-pass cutoff (Hz). Lower = darker/warmer, higher = brighter/airier. */
  filterWarmth: number
  /** Shared reverb wet character 0..1 — return level + tail length (higher = longer, wetter lounge). */
  reverbMix: number
}

/** ~50 flat tokens (§2.2). Graphics colours are numbers; text colours are CSS strings. */
export interface Theme {
  id: ThemeId
  name: string

  // --- Atmosphere (numbers → backdrop fills / tints) ---
  washTop: number
  washBottom: number
  washGlowWarm: number
  washGlowCool: number
  rayTint: number
  rayTintCool: number
  bokehWarm: number
  bokehCool: number
  marqueeDim: number
  marqueeBright: number
  sparkleTint: number
  moteTint: number
  suitWatermark: number
  scrim: number
  vignetteInk: number

  // --- Brand accents (numbers) ---
  gold: number
  goldBright: number
  goldBezel: number
  goldDeep: number
  goldDarkest: number
  rose: number
  roseLight: number
  roseDeep: number
  navy: number
  accent: number
  accentAlt: number

  // --- Surfaces (numbers) — cards stay LIGHT on every theme ---
  cardFill: number
  cardFillWarm: number
  cardFillAlt: number
  border: number
  shadow: number
  cabinetGlow: number
  bloom: number
  bleedWarm: number
  bleedCool: number

  // --- Gloss (numbers) — consumed by tiles & buttons ---
  glossHi: number
  glossLo: number
  rim: number

  // --- Text on cream (CSS strings) — dark on cards, stay dark on all themes ---
  ink: string
  inkSoft: string
  inkMuted: string
  inkFaint: string
  goldText: string
  goldPillText: string
  navyText: string
  onRose: string
  warn: string
  ok: string

  // --- Text on backdrop (CSS strings) — flip light on the dark themes ---
  onBackdropInk: string
  onBackdropMuted: string

  // --- Audio palette (§E3-A3) — the theme's sonic room; read by audio/sfx.ts ---
  audio: AudioPalette

  // --- Page chrome (CSS string) — body bg + <meta theme-color> + game backgroundColor ---
  pageBg: string
}

/** Number → `#rrggbb`. The bridge for Phaser `Text` colours drawn from graphics tokens. */
export const css = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0')

const THEME_KEY = 'viva-maya:theme'
export const DEFAULT_THEME_ID: ThemeId = 'golden'
/** Picker display order (§2.1): the two free themes first, then the progress-gated pair. */
export const THEME_ORDER: ThemeId[] = ['golden', 'mayaHeart', 'roseMidnight', 'neonVegas']

/**
 * Golden Hour — the warm default. Its values are the app's CURRENT literals, so
 * migrating consumers onto tokens is a zero-visual-diff change. Every other theme
 * is `{ ...golden, ...overrides }` so no key can ever be missing at compile time.
 */
const golden: Theme = {
  id: 'golden',
  name: 'Golden Hour',

  // Atmosphere
  washTop: 0xfaf3ec,
  washBottom: 0xefe7d6,
  washGlowWarm: 0xf2c14e,
  washGlowCool: 0xf0a3ad,
  rayTint: 0xf2c14e,
  rayTintCool: 0xf0a3ad,
  bokehWarm: 0xf2c14e,
  bokehCool: 0xf0a3ad,
  marqueeDim: 0xc9930a,
  marqueeBright: 0xf2b234,
  sparkleTint: 0xffe8b0,
  moteTint: 0xd9a521,
  suitWatermark: 0x8a7a52,
  scrim: 0x2a2417,
  vignetteInk: 0x3a2a12,

  // Brand accents
  gold: 0xf2b234,
  goldBright: 0xffd75e,
  goldBezel: 0xf2c14e,
  goldDeep: 0xc9930a,
  goldDarkest: 0x7a5a08,
  rose: 0xd3304f,
  roseLight: 0xff7a85,
  roseDeep: 0xa8213c,
  navy: 0x26304d,
  accent: 0xf2b234,
  accentAlt: 0xd3304f,

  // Surfaces
  cardFill: 0xfffdf8,
  cardFillWarm: 0xfff3d6,
  cardFillAlt: 0xf3ece0,
  border: 0xe8dfc9,
  shadow: 0x8a7a52,
  cabinetGlow: 0xd3304f,
  bloom: 0xffedc2,
  bleedWarm: 0xf7cf68,
  bleedCool: 0xf0a3ad,

  // Gloss
  glossHi: 0xfffef8,
  glossLo: 0xf7e9cf,
  rim: 0xfff7e0,

  // Text on cream. inkMuted / inkFaint / goldText are the deliberate WCAG-AA contrast nudge
  // (§E8 call #3 — the one intentional carve-out from P7's zero-visual-diff pledge): darkened so
  // muted body text clears 4.5:1 and gold display text clears 3:1 on the cream cards, on all four
  // themes (cards stay cream everywhere, so one fix covers all). Bright gold stays a FILL colour
  // (gold / goldBright / goldBezel below), never a body-text colour.
  ink: '#2a2732',
  inkSoft: '#6a6459',
  inkMuted: '#746d59', // was #9a927e (3.04:1) → 5.07:1 on cardFill (body AA)
  inkFaint: '#857e6b', // was #b3ab97 (2.25:1) → 3.98:1 on cardFill (large AA, faintest tier)
  goldText: '#9a6d00', // was #c9930a (2.70:1) → 4.53:1 on cardFill; also fixes gold on the golden wash
  goldPillText: '#4a3305',
  navyText: '#26304d',
  onRose: '#ffffff',
  warn: '#d3302f',
  ok: '#2fae4c',

  // Text on backdrop (Golden: wash is light → stays dark)
  onBackdropInk: '#2a2732',
  onBackdropMuted: '#9a927e',

  // Audio — warm golden-hour lounge: low sine bed, gentle room.
  audio: { bedRoot: 65.41 /* C2 */, waveBias: 'sine', filterWarmth: 900, reverbMix: 0.18 },

  // Page chrome
  pageBg: '#f6f3ec',
}

/** Maya's Heart — tender valentine (free). Soft rose wash, rose glows, rose accent. */
const mayaHeart: Theme = {
  ...golden,
  id: 'mayaHeart',
  name: "Maya's Heart",
  washTop: 0xfdf1f0,
  washBottom: 0xf7e6e6,
  washGlowWarm: 0xf5b6c0,
  washGlowCool: 0xf0a3ad,
  rayTint: 0xf5b6c0,
  rayTintCool: 0xf0a3ad,
  bokehWarm: 0xf5b6c0,
  bokehCool: 0xf0a3ad,
  marqueeBright: 0xf07a8c,
  marqueeDim: 0xc94f66,
  sparkleTint: 0xffd6dd,
  moteTint: 0xe08a98,
  suitWatermark: 0x9a6a72,
  vignetteInk: 0x4a2a30,
  accent: 0xd3304f,
  accentAlt: 0xf0a3ad,
  onBackdropInk: '#6a3a45',
  onBackdropMuted: '#a67e86',
  // Softer, a touch higher, more reverb — a tender valentine room.
  audio: { bedRoot: 73.42 /* D2 */, waveBias: 'sine', filterWarmth: 1150, reverbMix: 0.28 },
  pageBg: '#fdf1f0',
}

/** Rose Midnight — after-hours velvet (plum near-dark). Gold+rose aurora on dark. */
const roseMidnight: Theme = {
  ...golden,
  id: 'roseMidnight',
  name: 'Rose Midnight',
  washTop: 0x241a2e,
  washBottom: 0x1a1526,
  washGlowWarm: 0xf2b234,
  washGlowCool: 0xd3304f,
  rayTint: 0xf2c14e,
  rayTintCool: 0xd3304f,
  bokehWarm: 0xf2c14e,
  bokehCool: 0xd3304f,
  marqueeBright: 0xffd75e,
  marqueeDim: 0x8a5e06,
  sparkleTint: 0xffe8b0,
  moteTint: 0xc98ad0,
  suitWatermark: 0x4a3a5a,
  scrim: 0x0d0912,
  vignetteInk: 0x0d0912,
  shadow: 0x0d0912,
  accent: 0xd3304f,
  accentAlt: 0xf2b234,
  onBackdropInk: '#f3e8f0',
  onBackdropMuted: '#b9a6c4',
  // Darker, lower, longer tail — after-hours velvet.
  audio: { bedRoot: 55.0 /* A1 */, waveBias: 'triangle', filterWarmth: 640, reverbMix: 0.34 },
  pageBg: '#1a1526',
}

/** Neon Vegas — the strip at night (navy neon). Magenta + cyan accents; cabinet halo stays warm. */
const neonVegas: Theme = {
  ...golden,
  id: 'neonVegas',
  name: 'Neon Vegas',
  washTop: 0x14203a,
  washBottom: 0x0e1730,
  washGlowWarm: 0xff3d81,
  washGlowCool: 0x35d0e0,
  rayTint: 0xff3d81,
  rayTintCool: 0x35d0e0,
  bokehWarm: 0xff3d81,
  bokehCool: 0x35d0e0,
  marqueeBright: 0x35d0e0,
  marqueeDim: 0xff3d81,
  sparkleTint: 0x9be8ff,
  moteTint: 0x35d0e0,
  suitWatermark: 0x2a4a7a,
  scrim: 0x060b18,
  vignetteInk: 0x060b18,
  shadow: 0x060b18,
  accent: 0xff3d81,
  accentAlt: 0x35d0e0,
  onBackdropInk: '#eaf6ff',
  onBackdropMuted: '#8fa8c8',
  // Saw bias + brighter, cyan shimmer — the strip at night, electric.
  audio: { bedRoot: 61.74 /* B1 */, waveBias: 'sawtooth', filterWarmth: 1450, reverbMix: 0.24 },
  pageBg: '#0e1730',
}

export const THEMES: Record<ThemeId, Theme> = { golden, mayaHeart, roseMidnight, neonVegas }

/** Picker-facing metadata for each theme (§3e). Cosmetic only — `unlockLevel` gates DISPLAY, never price. */
export interface ThemeMeta {
  /** Display name for the picker row (mirrors `THEMES[id].name`). */
  name: string
  /** One-line mood line shown under the name. */
  feel: string
  /** Level the player must reach before the theme unlocks; `0` = free from the start. */
  unlockLevel: number
}

export const THEME_META: Record<ThemeId, ThemeMeta> = {
  golden: { name: 'Golden Hour', feel: 'the warm default', unlockLevel: 0 },
  mayaHeart: { name: "Maya's Heart", feel: 'a tender valentine', unlockLevel: 0 },
  roseMidnight: { name: 'Rose Midnight', feel: 'after-hours velvet', unlockLevel: 10 },
  neonVegas: { name: 'Neon Vegas', feel: 'the strip at night', unlockLevel: 30 },
}

/**
 * Read-only unlock gate for the picker (§3e / §7 #1). Cosmetic + ALWAYS FREE — this never gates
 * `getTheme()`/`setTheme()`; it only tells the picker which rows to render as locked. `golden` +
 * `mayaHeart` are free (`unlockLevel 0`); `roseMidnight` opens at `save.unlocked ≥ 10`; `neonVegas`
 * mirrors `endlessUnlocked` (`save.unlocked > 30`) so it lands together with the endless race.
 */
export function themeUnlocked(id: ThemeId, save: SaveData): boolean {
  if (id === 'neonVegas') return endlessUnlocked(save)
  return save.unlocked >= THEME_META[id].unlockLevel
}

/** Read + validate the persisted id. Shape-tolerant; any bad/absent value → default. */
function readThemeId(): ThemeId {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v !== null && v in THEMES ? (v as ThemeId) : DEFAULT_THEME_ID
  } catch {
    return DEFAULT_THEME_ID
  }
}

function writeThemeId(id: ThemeId): void {
  try {
    localStorage.setItem(THEME_KEY, id)
  } catch {
    // storage blocked (private mode / no DOM) — the choice just won't persist
  }
}

let _themeId: ThemeId = readThemeId()

/** The current theme's id (persisted choice, default `golden`). */
export function getThemeId(): ThemeId {
  return _themeId
}

/** The current theme's full token set. Never gates — selection is always free. */
export function getTheme(): Theme {
  return THEMES[_themeId]
}

/** Alias for `getTheme()` — the current active theme. */
export function activeTheme(): Theme {
  return THEMES[_themeId]
}

/** Select a theme: persist it and repaint the page chrome. Callers restart the scene to repaint art. */
export function setTheme(id: ThemeId): void {
  if (!(id in THEMES)) return
  _themeId = id
  writeThemeId(id)
  applyPageChrome(THEMES[id])
}

/**
 * Paint the body background + `<meta theme-color>` to match the theme (best-effort, no-DOM safe).
 *
 * Full-bleed fix: the 720×1280 canvas is FIT-letterboxed, so a taller-than-9:16 phone shows a strip
 * of body above and below (and a tablet shows strips left/right). We paint the body with the SAME
 * vertical wash the backdrop draws (washTop→washBottom) instead of a flat `pageBg`, so those strips
 * read as a seamless continuation of the scene rather than dead bars. The wash varies only on Y, so a
 * single full-height vertical gradient lines up with the canvas edge on every side. `<meta
 * theme-color>` tints the iOS status-bar / notch region at the very top → point it at washTop.
 */
export function applyPageChrome(T: Theme): void {
  try {
    const top = css(T.washTop)
    const bottom = css(T.washBottom)
    document.body.style.background = `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)`
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', top)
  } catch {
    // no DOM (tests / SSR) — chrome just isn't repainted
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// In-app accessibility preferences (§E8). Two switches (vestibular ≠ photosensitivity) plus a
// haptics opt-out, persisted in one shape-tolerant localStorage key so users needn't touch the OS
// setting. Defaults are all OFF, so Maya's default experience is unchanged: every motion loop still
// animates and every flash still fires unless she (or her OS) opts out. The settings panel (a later
// slice) is the UI that flips these; this module owns the state + persistence.
// ─────────────────────────────────────────────────────────────────────────────

const A11Y_KEY = 'viva-maya:a11y'

interface A11yPrefs {
  /** In-app Reduce-Motion override — OR'd into `prefersReducedMotion()` alongside the OS query. */
  reduceMotion: boolean
  /** Separate photosensitivity switch — gates camera flashes + impact frames (never the OS query). */
  reduceFlashing: boolean
  /** Opt out of haptic vibration. */
  hapticsOff: boolean
}

const A11Y_DEFAULTS: A11yPrefs = { reduceMotion: false, reduceFlashing: false, hapticsOff: false }

/** Read + validate the persisted prefs. Shape-tolerant; any bad/absent value → all-off default. */
function readA11y(): A11yPrefs {
  try {
    const raw = localStorage.getItem(A11Y_KEY)
    if (raw === null) return { ...A11Y_DEFAULTS }
    const v = JSON.parse(raw) as Partial<A11yPrefs>
    return {
      reduceMotion: v.reduceMotion === true,
      reduceFlashing: v.reduceFlashing === true,
      hapticsOff: v.hapticsOff === true,
    }
  } catch {
    return { ...A11Y_DEFAULTS }
  }
}

let _a11y: A11yPrefs = readA11y()

function writeA11y(): void {
  try {
    localStorage.setItem(A11Y_KEY, JSON.stringify(_a11y))
  } catch {
    // storage blocked (private mode / no DOM) — the choice just won't persist
  }
}

/** The OS `prefers-reduced-motion` media query, kept internal so the export can OR-in the app flag. */
function osReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * Canonical reduced-motion check (§2.1) — the single home for the duplicated copies. TRUE when the
 * OS media query matches OR the in-app Reduce-Motion override is on, so a user who can't change the
 * OS setting still gets the static path. Default (both off) → identical to the old OS-only behaviour.
 */
export function prefersReducedMotion(): boolean {
  return _a11y.reduceMotion || osReducedMotion()
}

/** In-app Reduce-Flashing switch (§E8) — gates camera flashes + impact frames. Default OFF. */
export function reduceFlashing(): boolean {
  return _a11y.reduceFlashing
}

/** In-app Haptics-off switch (§E8) — callers skip `navigator.vibrate` when true. Default OFF. */
export function hapticsOff(): boolean {
  return _a11y.hapticsOff
}

/** Set + persist the in-app Reduce-Motion override (the settings panel's toggle). */
export function setReduceMotion(v: boolean): void {
  _a11y.reduceMotion = v
  writeA11y()
}

/** Set + persist the in-app Reduce-Flashing switch. */
export function setReduceFlashing(v: boolean): void {
  _a11y.reduceFlashing = v
  writeA11y()
}

/** Set + persist the in-app Haptics-off switch. */
export function setHapticsOff(v: boolean): void {
  _a11y.hapticsOff = v
  writeA11y()
}

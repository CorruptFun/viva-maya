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

  // Text on cream
  ink: '#2a2732',
  inkSoft: '#6a6459',
  inkMuted: '#9a927e',
  inkFaint: '#b3ab97',
  goldText: '#c9930a',
  goldPillText: '#4a3305',
  navyText: '#26304d',
  onRose: '#ffffff',
  warn: '#d3302f',
  ok: '#2fae4c',

  // Text on backdrop (Golden: wash is light → stays dark)
  onBackdropInk: '#2a2732',
  onBackdropMuted: '#9a927e',

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

/** Paint the body background + `<meta theme-color>` to match the theme (best-effort, no-DOM safe). */
export function applyPageChrome(T: Theme): void {
  try {
    document.body.style.background = T.pageBg
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', T.pageBg)
  } catch {
    // no DOM (tests / SSR) — chrome just isn't repainted
  }
}

/** Canonical `prefers-reduced-motion` check (§2.1) — the single home for the duplicated copies. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

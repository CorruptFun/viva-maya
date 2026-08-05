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

import { ENDLESS_UNLOCK_LEVEL, endlessUnlocked } from '../core/endless'
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
  /**
   * RGB chase arc (§RGB) — the hue band the cabinet's chasing ring sweeps, per theme, so a rainbow
   * never fights a theme's own identity. `rgbHueFrom` is where the arc starts (degrees) and
   * `rgbHueSpan` is how far it travels: `>= 360` is a full wheel that wraps seamlessly, anything
   * narrower ping-pongs back across the arc so the ring still closes with no hue seam at the wrap.
   * `rgbSat` holds saturation just under neon — cabinet lighting, not a gaming keyboard.
   */
  rgbHueFrom: number
  rgbHueSpan: number
  rgbSat: number
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

  // --- Board cushions (numbers) — the 8×8 checkerboard tint pair (§V1) ---
  /** Checkerboard tint A — the lit cushion the symbols are read against. */
  tileA: number
  /** Checkerboard tint B — its barely-cooler partner (a whisper, never a stripe). */
  tileB: number
  /** High-contrast (§E12) tint pair, used when the a11y contrast switch is on. */
  tileHcA: number
  tileHcB: number

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

  // Atmosphere. §V1 vibrancy pass: the v1 wash (#faf3ec → #efe7d6) was a narrow, near-grey sepia
  // band — the board, the cards and the backdrop all landed within ~6 points of lightness of each
  // other, so NOTHING separated and the whole app read as one dingy tan sheet. The fix is a wider
  // value range carrying real chroma: a clean warm-white top falling to a genuinely amber bottom.
  // Same warm identity, but lit sunlight instead of old newsprint — and the light cards/cushions
  // now sit clearly IN FRONT of it. Every downstream layer (backdrop wash, body CSS gradient,
  // letterbox strips, <meta theme-color>) reads these two, so this one edit repaints the stage.
  washTop: 0xfff9ec,
  washBottom: 0xffdda8,
  // The coloured light itself — pushed from muted honey/dusty-pink to hot amber + hot rose so the
  // glow blobs, rays and bokeh read as SATURATED light sources rather than smudges on the wash.
  washGlowWarm: 0xffab1f,
  washGlowCool: 0xff8fa8,
  rayTint: 0xffbe33,
  rayTintCool: 0xff8fa8,
  bokehWarm: 0xffb52e,
  bokehCool: 0xff92ab,
  marqueeDim: 0xbf7f00,
  marqueeBright: 0xffb51f,
  // Golden Hour's own arc: rose-red (its ~346° accent) through red and orange up to gold (~40°).
  // NOT the full wheel — a literal rainbow on the warm parchment wash reads as a gaming peripheral
  // bolted to a casino cabinet. Every hue here is one the board already wears, so the ring looks
  // like the frame lighting up rather than like an effect running on top of it.
  rgbHueFrom: 345,
  rgbHueSpan: 70,
  rgbSat: 0.8,
  sparkleTint: 0xfff0c0,
  moteTint: 0xe09a12,
  suitWatermark: 0x9a7f45,
  scrim: 0x2a2417,
  vignetteInk: 0x4a3210,

  // Brand accents — saturated to sit ON the richer wash instead of dissolving into it. The gold
  // loses its mustard cast (more chroma, less grey) and the rose gains punch; both stay in the
  // same hue family, so every derived shade (pill bevels, bezels, embosses) tracks for free.
  gold: 0xffb01c,
  goldBright: 0xffdc5c,
  goldBezel: 0xffc233,
  goldDeep: 0xd18a00,
  goldDarkest: 0x7a5208,
  rose: 0xe61f4d,
  roseLight: 0xff6b82,
  roseDeep: 0xb01536,
  navy: 0x223056,
  accent: 0xffb01c,
  accentAlt: 0xe61f4d,

  // Surfaces — cards/cushions stay bright (they are the FIGURE against the new deeper ground) but
  // shed their grey: cardFillAlt in particular was a dirty putty that muddied every secondary panel.
  cardFill: 0xfffdf7,
  cardFillWarm: 0xfff2cf,
  cardFillAlt: 0xfaf0dd,
  border: 0xf0dfb4,
  shadow: 0x8a6b32,
  cabinetGlow: 0xe61f4d,
  bloom: 0xffeaba,
  bleedWarm: 0xffcc52,
  bleedCool: 0xff9db0,

  // Gloss
  glossHi: 0xfffef8,
  glossLo: 0xfeecc8,
  rim: 0xfff7e0,

  // Board cushions. v1 used hardcoded 0xf4e7c6 / 0xf7e3de literals in GameScene — a muddy cream and
  // a dusty pink that DESATURATED every symbol sitting on them. These are brighter and cleaner, so
  // the emoji (red 7, gold bell, blue diamond, green clover) read as lit objects on a lit cushion.
  tileA: 0xfff6de,
  tileB: 0xfff0e8,
  tileHcA: 0xfffaf0,
  tileHcB: 0xe8d3a8,

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

  // Text on backdrop (Golden: wash is light → stays dark). §V1: both were NEUTRAL GREYS sitting on a
  // warm wash, which is what made the tagline / "Level N · best" lines look dusty and washed-out.
  // Re-cast in the wash's own hue family — warm dark ink and a warm brown muted — so backdrop copy
  // reads as part of the golden room. Muted clears 4.5:1 on the wash's lightest band.
  onBackdropInk: '#3b2a12',
  onBackdropMuted: '#8a6626',

  // Audio — warm golden-hour lounge: low sine bed, gentle room.
  audio: { bedRoot: 65.41 /* C2 */, waveBias: 'sine', filterWarmth: 900, reverbMix: 0.18 },

  // Page chrome
  pageBg: '#fff9ec',
}

/** Maya's Heart — tender valentine (free). Soft rose wash, rose glows, rose accent. */
const mayaHeart: Theme = {
  ...golden,
  id: 'mayaHeart',
  name: "Maya's Heart",
  // §V1: same widen-the-range treatment as golden — the v1 rose wash (#fdf1f0 → #f7e6e6) was an
  // even flatter near-grey than the default. Bottom drops into a real blush so the cards lift off it.
  washTop: 0xfff2f4,
  washBottom: 0xffcbd8,
  washGlowWarm: 0xff9fb4,
  washGlowCool: 0xff85a0,
  rayTint: 0xffa8bc,
  rayTintCool: 0xff85a0,
  bokehWarm: 0xffa0b6,
  bokehCool: 0xff8fa8,
  marqueeBright: 0xff6b86,
  marqueeDim: 0xc93f5e,
  // Blush theme → a rose ARC, never a rainbow: magenta → this theme's own ~348° rose → coral. A green
  // bulb on the valentine wash would read as a bug, so the arc simply never reaches one.
  rgbHueFrom: 310,
  rgbHueSpan: 70,
  rgbSat: 0.72,
  sparkleTint: 0xffd6dd,
  moteTint: 0xf07d92,
  suitWatermark: 0xa8656f,
  vignetteInk: 0x5a2832,
  accent: 0xe61f4d,
  accentAlt: 0xff8fa8,
  tileB: 0xfff0f2,
  // §V1: darkened to clear 4.5:1 against the deepened blush wash (the old #a67e86 fell to ~2.9:1).
  onBackdropInk: '#5c2732',
  onBackdropMuted: '#8f4f5e',
  // Softer, a touch higher, more reverb — a tender valentine room.
  audio: { bedRoot: 73.42 /* D2 */, waveBias: 'sine', filterWarmth: 1150, reverbMix: 0.28 },
  pageBg: '#fff2f4',
}

/** Rose Midnight — after-hours velvet (plum near-dark). Gold+rose aurora on dark. */
const roseMidnight: Theme = {
  ...golden,
  id: 'roseMidnight',
  name: 'Rose Midnight',
  // §V1: deepened top-to-bottom (a real plum falloff, not two near-identical darks) and the aurora
  // glows swapped onto the saturated gold/rose so the night reads lit rather than merely dim.
  washTop: 0x2e1f3d,
  washBottom: 0x150f1f,
  washGlowWarm: 0xffb01c,
  washGlowCool: 0xe61f4d,
  rayTint: 0xffc233,
  rayTintCool: 0xe61f4d,
  bokehWarm: 0xffc233,
  bokehCool: 0xe61f4d,
  marqueeBright: 0xffdc5c,
  marqueeDim: 0x8a5e06,
  // Gold+rose aurora on plum → the arc sweeps exactly that pair and nothing else: crimson (this
  // theme's own ~346° accent) through red and orange up to its gold marquee tone (~47°). Both
  // accents sit ON the arc, so the ring reads as this room's own lighting moving through the frame.
  rgbHueFrom: 340,
  rgbHueSpan: 70,
  rgbSat: 0.85,
  sparkleTint: 0xffe8b0,
  moteTint: 0xd494dd,
  suitWatermark: 0x574468,
  scrim: 0x0d0912,
  vignetteInk: 0x0d0912,
  shadow: 0x0d0912,
  accent: 0xe61f4d,
  accentAlt: 0xffb01c,
  onBackdropInk: '#f3e8f0',
  onBackdropMuted: '#b9a6c4',
  // Darker, lower, longer tail — after-hours velvet.
  audio: { bedRoot: 55.0 /* A1 */, waveBias: 'triangle', filterWarmth: 640, reverbMix: 0.34 },
  pageBg: '#2e1f3d',
}

/** Neon Vegas — the strip at night (navy neon). Magenta + cyan accents; cabinet halo stays warm. */
const neonVegas: Theme = {
  ...golden,
  id: 'neonVegas',
  name: 'Neon Vegas',
  // §V1: a deeper night with a wider falloff, and the neon pushed to full electric saturation.
  washTop: 0x1b2c50,
  washBottom: 0x0a1128,
  washGlowWarm: 0xff2b78,
  washGlowCool: 0x1fdcf0,
  rayTint: 0xff2b78,
  rayTintCool: 0x1fdcf0,
  bokehWarm: 0xff2b78,
  bokehCool: 0x1fdcf0,
  marqueeBright: 0x1fdcf0,
  marqueeDim: 0xff2b78,
  // The widest arc of the four, because this theme's identity IS two far-apart hues: its cyan
  // (~186°) and its magenta (~338°). The ring sweeps between them the pretty way — cyan → azure →
  // blue → violet → magenta — so every tone is a neon this theme already uses. Still not the full
  // wheel: rounding the rest of the way would drag reds and greens onto the navy night, which is
  // the one thing Neon Vegas doesn't wear. Full saturation, since here neon IS the brand.
  rgbHueFrom: 185,
  rgbHueSpan: 155,
  rgbSat: 0.95,
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
  pageBg: '#1b2c50',
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
  // Gated by `endlessUnlocked`, not by this number — so it must TRACK the endless constant, or the
  // row advertises a level the theme already opened past when the race unlock is retuned.
  neonVegas: { name: 'Neon Vegas', feel: 'the strip at night', unlockLevel: ENDLESS_UNLOCK_LEVEL },
}

/**
 * Read-only unlock gate for the picker (§3e / §7 #1). Cosmetic + ALWAYS FREE — this never gates
 * `getTheme()`/`setTheme()`; it only tells the picker which rows to render as locked. `golden` +
 * `mayaHeart` are free (`unlockLevel 0`); `roseMidnight` opens at `save.unlocked ≥ 10`; `neonVegas`
 * mirrors `endlessUnlocked` (`save.unlocked > ENDLESS_UNLOCK_LEVEL`) so it lands together with the
 * endless race.
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

/**
 * ── THE FLOOR OVERLAY (Act II) ──────────────────────────────────────────────────────────────
 *
 * A high-roller floor gets to change how the ROOM is lit without changing the player's theme, and
 * this is the seam that does it: while a floor is active, `getTheme()` hands back the chosen theme
 * with a handful of keys replaced. One seam serves the marquee's hue arc, the ambient tints and the
 * audio room at once — `audio/sfx.ts` alone reads `getTheme().audio` from a dozen places, and
 * threading a floor parameter through all of them would have been a dozen chances to miss one.
 *
 * ⚠️ THE KEY LIST IS THE LAW. Only these fields may be overlaid, and none of them is a surface the
 * player's theme owns: no `washTop`/`washBottom`, no card fill, no ink, no cushion, no page chrome.
 * The floor owns the light; the theme owns the cabinet. Widening this type is how that stops being
 * true, so it is spelled out rather than left as `Partial<Theme>`.
 */
export type FloorOverlay = Partial<
  Pick<Theme, 'rgbHueFrom' | 'rgbHueSpan' | 'rgbSat' | 'rayTint' | 'bokehWarm' | 'moteTint'>
> & { audio?: Partial<AudioPalette> }

let _floor: FloorOverlay | null = null

/**
 * Light the room for a floor, or clear it with `null`. Scene-scoped by convention: GameScene sets it
 * in `create()` and clears it on shutdown, so nothing outside a numbered Act II level can ever be
 * looking at a floor's light. Textures baked before this is set are NOT re-baked (the theme rule),
 * which is fine — everything an overlay reaches is tint or tone, computed at draw time.
 */
export function setFloorOverlay(overlay: FloorOverlay | null): void {
  _floor = overlay
}

/** The current theme's full token set, with any floor overlay folded in. Never gates — free always. */
export function getTheme(): Theme {
  const base = THEMES[_themeId]
  if (!_floor) return base
  return { ...base, ..._floor, audio: { ...base.audio, ..._floor.audio } }
}

/** Alias for `getTheme()` — the current active theme. */
export function activeTheme(): Theme {
  return getTheme()
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
  /**
   * RGB marquee chase (§RGB) — the ONE pref in this shape that defaults ON, because it is a look
   * rather than a comfort opt-out: the cabinets ship wearing it. Off falls the board + slots back to
   * their original alternating gold/rose bulbs, so this is a true toggle, not a degraded mode.
   */
  rgbMarquee: boolean
}

const A11Y_DEFAULTS: A11yPrefs = {
  reduceMotion: false,
  reduceFlashing: false,
  hapticsOff: false,
  rgbMarquee: true,
}

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
      // Inverted test on purpose: this one defaults ON, so only an explicit `false` turns it off.
      // A player who saved prefs before this key existed keeps the new default instead of losing it.
      rgbMarquee: v.rgbMarquee !== false,
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

/** RGB marquee chase (§RGB) — the chasing rainbow ring on the board + slots cabinets. Default ON. */
export function rgbMarquee(): boolean {
  return _a11y.rgbMarquee
}

/** Set + persist the RGB marquee switch. */
export function setRgbMarquee(v: boolean): void {
  _a11y.rgbMarquee = v
  writeA11y()
}

/** Set + persist the in-app Haptics-off switch. */
export function setHapticsOff(v: boolean): void {
  _a11y.hapticsOff = v
  writeA11y()
}

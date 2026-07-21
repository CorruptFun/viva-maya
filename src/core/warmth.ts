/**
 * §E9 — the PERSONAL WARMTH LAYER config surface: Viva Ton's hidden emotional soul.
 *
 * Pure data + logic — NO Phaser imports (src/core stays engine-free). The scenes read this
 * to decide whether to greet by name, reveal the secret note, or dress the app up for a date.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *  KEY CROSS-LENS CALL #5 — "personal/named warmth is hidden or owner-gated, never on the
 *  front door." Everything below ships EMPTY / OFF so the DEFAULT product stays clean and
 *  nameless. The always-on touches (warm win/lose copy, the time-of-day greeting with NO name,
 *  the new-best ribbon, and the discoverable heart note) work with zero config here. The
 *  name / dedication / special dates only wake up once the owner fills this in.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */

/** A special date that quietly dresses the app up (§ signature moment #5, "It knew"). */
export interface Occasion {
  /** The day it fires, 'MM-DD' (zero-padded, e.g. '02-14'). Year-agnostic — recurs annually. */
  date: string
  /** A short warm greeting shown on the day (e.g. 'Happy birthday'). Replaces the time-of-day line. */
  label: string
  /** Optional longer line for the day's heart-shower card; falls back to `label` when omitted. */
  message?: string
}

export interface MayaConfig {
  /** Her name. Shown ONLY when `showName` is also true — otherwise the product stays nameless. */
  name?: string
  /** Master switch for the name. Default FALSE → the default product never shows a name anywhere. */
  showName: boolean
  /**
   * The owner's private words — surfaced by the DISCOVERED heart note (long-press the Home heart)
   * and the one-time ALL CLEAR sign-off. Empty → a tasteful generic line stands in.
   */
  secretMessage?: string
  /** Special dates. Empty → the special-date dress-up is fully DORMANT (no behavior change). */
  occasions: Occasion[]
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
//  OWNER CONFIG — this is the ONE block to personalize. It ships empty/off; edit the values
//  (and uncomment the occasion examples) to wake the hidden touches. Nothing here changes the
//  save, gameplay, or the default look while it stays at these defaults.
// ═══════════════════════════════════════════════════════════════════════════════════════════
export const maya: MayaConfig = {
  name: undefined, //            → e.g. 'Maya'   (only ever shown when showName is true)
  showName: false, //            → flip to true (with a name) to greet her by name
  secretMessage: undefined, //   → e.g. 'For Maya — every level was built thinking of you. ♥'
  occasions: [
    // { date: '02-14', label: 'Happy Valentine’s Day', message: 'For my valentine. ♥' },
    // { date: '06-21', label: 'Happy birthday', message: 'Happy birthday, my love. ♥' },
    // { date: '09-30', label: 'Happy anniversary', message: 'Here’s to us. ♥' },
  ],
}
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** MM-DD for a Date (local), matching the `Occasion.date` format. */
export function dateKeyMMDD(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** The configured occasion for a given 'MM-DD' key, or null. First match wins. */
export function occasionFor(mmdd: string, cfg: MayaConfig = maya): Occasion | null {
  return cfg.occasions.find(o => o.date === mmdd) ?? null
}

/**
 * The special-date dress-up gate: returns today's occasion IFF one is configured for today AND
 * its once-a-day key isn't already in `seen`. Pure — the caller marks the key seen and runs the
 * beat. `todayKey` is the full 'YYYY-MM-DD' (so the occasion recurs every year but fires once a
 * day); its MM-DD tail is matched against `Occasion.date`.
 */
export function pendingOccasion(todayKey: string, seen: string[], cfg: MayaConfig = maya): Occasion | null {
  const occ = occasionFor(todayKey.slice(5), cfg)
  return occ && !seen.includes(todayKey) ? occ : null
}

/**
 * A gentle time-of-day greeting keyed to `getHours()` (0–23). Appends her name ONLY when
 * `showName && name` — otherwise it's a clean, nameless line that works with no config.
 */
export function greeting(hour: number, cfg: MayaConfig = maya): string {
  let base: string
  if (hour < 5) base = 'Still up?'
  else if (hour < 12) base = 'Good morning'
  else if (hour < 17) base = 'Good afternoon'
  else if (hour < 21) base = 'Golden hour'
  else base = 'Good evening'
  return withName(base, cfg)
}

/** Append ", <name>" only when the owner has opted in (showName && name); otherwise return `base`. */
export function withName(base: string, cfg: MayaConfig = maya): string {
  return cfg.showName && cfg.name ? `${base}, ${cfg.name}` : base
}

/** The discovered heart-note body: the owner's message if set, else a tasteful generic line. */
export function secretNote(cfg: MayaConfig = maya): string {
  const msg = cfg.secretMessage?.trim()
  return msg && msg.length > 0 ? msg : 'Made with ♥'
}

// ── Warm, NON-name encouragement — always on, works with zero config; touches every session. ──
// (Owner-editable too, but these need no personal data — the default product ships with them.)

/** Rotating warm subtitle shown under the win rank word. */
export const WIN_SUBTITLES = [
  'You make this look easy.',
  'Beautifully played.',
  'Look at you go.',
  'That was lovely.',
  'A little brighter now.',
  'Right on the money.',
]

/** Rotating kind lines that replace the cold "out of moves" text on a loss. */
export const LOSE_LINES = [
  'So close — one more?',
  'Almost had it!',
  'Nearly there.',
  'One more try?',
  'You were so close.',
]

const pick = (arr: readonly string[], seed?: number): string => {
  const n = seed === undefined ? Math.floor(Math.random() * arr.length) : Math.abs(Math.floor(seed)) % arr.length
  return arr[n % arr.length]
}

/** A warm win subtitle; pass a seed (e.g. score) for stable-per-result rotation, else random. */
export function warmWinSubtitle(seed?: number): string {
  return pick(WIN_SUBTITLES, seed)
}

/** A kind lose line; pass a seed for stable-per-result rotation, else random. */
export function warmLoseLine(seed?: number): string {
  return pick(LOSE_LINES, seed)
}

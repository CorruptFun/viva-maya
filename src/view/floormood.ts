import { DIFFICULTY } from '../core/difficulty'
import { FLOORS, floorFor, floorForChapter } from '../core/actII'
import type { Floor } from '../core/actII'
import type { AudioPalette } from './theme'

// ⚠️ NO PHASER IMPORT, and keep it that way. This module is pure data plus lookups, so a core test
// can assert that every shipped floor has a mood (`actII.test.ts`) — the moment a Phaser import
// lands here that assertion dies with "window is not defined". The door CARD, which does need
// Phaser, lives next door in `floordoor.ts` for exactly this reason.

/**
 * HOW A FLOOR FEELS — the appearance half of `core/actII.ts`, kept apart from what a floor IS,
 * exactly as `hazardskins.ts` is kept apart from `difficulty.ts`. Core names the floors; this dresses
 * them.
 *
 * ── THE ONE RULE: A MOOD MODULATES, IT NEVER REPLACES ───────────────────────────────────────
 * The floor owns the ROOM; the player's theme owns the CABINET. So a mood may tint the light — the
 * glow blobs, the rays, the bokeh, the motes, the marquee's hue arc, the audio room, the hazard
 * skins, the margin flourish — and it may NEVER touch `washTop`/`washBottom`, the cards, the ink,
 * the cushions or the page chrome. Those are the four free themes' identity, and a player who chose
 * Maya's Heart did not choose to have it overwritten by a floor.
 *
 * That constraint is what makes moods cheap AND safe: everything here is additive light on top of
 * whatever theme is loaded, so 2 floors × 4 themes needs no combinatorial testing — the theme keeps
 * looking like itself in every one of the eight.
 *
 * ── SLICE 1 STATUS — WHAT IS AND IS NOT BUILT ───────────────────────────────────────────────
 * BUILT: the accent (nameplates, journey trail), the marquee's hue arc, the ambient light tints and
 * the audio room, all applied through `theme.setFloorOverlay` — plus the croupier's door card
 * (`floordoor.ts`). Floor 1's numbers were tuned against the running game; floor 2 ships a LIGHT
 * mood (accent, arc, audio) because its full pass belongs with the slice that builds its mechanic.
 * It is deliberately not left blank: fifty levels with no identity, next to fifty with one, reads as
 * unfinished rather than as restrained.
 *
 * NOT BUILT, and deliberately absent rather than stubbed: PER-FLOOR HAZARD SKINS (the designed
 * BAIZE / CHIP RACK / DEALER'S CLAMP set for floor 1) and the brass table-lamp MARGIN FLOURISH.
 * `hazardskins.ts` keys skins by ThemeId and has no floor lookup yet; adding one is that file's
 * documented two-step, and it belongs in a pass that can verify the art. A `skin` field sitting here
 * doing nothing would have been worse than its absence — it would read as wired.
 */

/** A floor's dressing. Every field OPTIONAL and every one a modulation — see the rule above. */
export interface FloorMood {
  /** The floor's signature colour. Nameplates, journey-trail dots above 300, the margin flourish. */
  accent: number
  /** Hue arc for the RGB cabinet marquee, overriding the theme's own (see view/rgbmarquee.ts).
   *  Narrow arcs only: the ring is the cabinet, and a rainbow up here would fight the room. */
  rgbHueFrom?: number
  rgbHueSpan?: number
  rgbSat?: number
  /** Coloured-light tints. Undefined leaves the theme's value alone, which is the common case. */
  rayTint?: number
  bokehWarm?: number
  moteTint?: number
  /** The room you can HEAR — merged over the theme's palette by audio/sfx.ts. Tonal only; a mood
   *  never changes loudness, exactly as a theme never does. */
  audio?: Partial<AudioPalette>
  /** The croupier's introduction, spoken once on the floor's door card. One voice per floor: floor 1
   *  is the amused host who has decided to enjoy watching you. */
  croupier: string
  /** One-line description under the floor name on its door card. */
  blurb: string
}

const FLOOR_MOODS: Readonly<Record<number, FloorMood>> = {
  1: {
    // Brass and baize. The arc runs from the board's own gold (45°) round to a table-felt emerald
    // (145°) — a hundred degrees, which is wide for this game but every hue in it is a hue the
    // high-limit room actually contains. Saturation sits under the themes' own so the ring reads as
    // lamplight on brass rather than as an effect bolted to the cabinet.
    accent: 0x1f7a5a,
    rgbHueFrom: 45,
    rgbHueSpan: 100,
    rgbSat: 0.7,
    rayTint: 0x3f9a72,
    moteTint: 0x2f8f63,
    // G1. A fifth below the default bed and darker through the filter: a smaller, more expensive
    // room than the main floor, with the reverb pulled in close.
    audio: { bedRoot: 49.0, waveBias: 'sine', filterWarmth: 700, reverbMix: 0.3 },
    croupier: 'Good evening. The table is yours — take your time, the House is in no hurry.',
    blurb: 'Private tables. Real stakes. The arm on the right pulls a whole column.',
  },
  2: {
    // PROVISIONAL — a light mood pending floor 2's own pass. Plum and low brass: the room behind the
    // room, lit by less of everything.
    accent: 0x8c3b6b,
    rgbHueFrom: 300,
    rgbHueSpan: 70,
    rgbSat: 0.72,
    moteTint: 0x9a4a78,
    audio: { bedRoot: 46.25, waveBias: 'triangle', filterWarmth: 560, reverbMix: 0.42 },
    croupier: 'Keep your voice down. Nobody in this room has a name, including you.',
    blurb: 'The room behind the room. Same game, quieter, and nobody is watching the clock.',
  },
}

/** True when floor moods are live at all. Their own flag, revocable without touching the act. */
export function moodsLive(): boolean {
  return DIFFICULTY.act2.enabled && DIFFICULTY.act2.mood
}

/** The mood for a numbered level, or null in Act I / with moods off. */
export function floorMood(level: number): FloorMood | null {
  if (!moodsLive()) return null
  const f = floorFor(level)
  return f ? (FLOOR_MOODS[f.floor] ?? null) : null
}

/** The mood for a 1-based CHAPTER — what LevelSelect's nameplates read. */
export function chapterMood(chapter: number): FloorMood | null {
  if (!moodsLive()) return null
  const f = floorForChapter(chapter)
  return f ? (FLOOR_MOODS[f.floor] ?? null) : null
}

/** `FLOOR N · THE NAME` — the nameplate copy, and the floor door card's title. */
export function floorPlateLabel(f: Floor): string {
  return `FLOOR ${f.floor} · ${f.name}`
}

/** Every shipped floor has a mood — asserted in actII.test.ts so a new floor cannot ship blank. */
export function moodedFloors(): number[] {
  return FLOORS.map(f => f.floor).filter(n => FLOOR_MOODS[n] !== undefined)
}

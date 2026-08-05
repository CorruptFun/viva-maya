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
 * ── ONE VOICE, ONE ROOM, PER FLOOR ──────────────────────────────────────────────────────────
 * Each floor owns a palette, an RGB arc, an audio room, a hazard-skin set, a margin flourish and a
 * croupier. They are meant to be read as a PROGRESSION rather than as six independent skins: the
 * rooms get smaller and closer as you climb (floor 1's reverb is the wettest on the tower, and it
 * gets drier from here), and the House's voice gets warier with them — floor 1 is an amused host,
 * floor 2 a conspiratorial barkeep.
 *
 * ── WHAT A MOOD REACHES ─────────────────────────────────────────────────────────────────────
 * The accent (nameplates, journey trail), the marquee's hue arc, the ambient light tints and the
 * audio room all travel through `theme.setFloorOverlay`, whose key list is the whitelist. The two
 * that CANNOT go through a theme overlay — because neither is a theme token — are the HAZARD SKIN
 * (which furniture the room's obstacles are made of, `hazardskins.ts`) and the MARGIN FLOURISH (the
 * room's one ambient accent, `background.ts`). Both read the ACTIVE FLOOR below instead, which is
 * why that little piece of scene-scoped state exists rather than a second overlay.
 */

/**
 * The floor's one ambient MARGIN accent, drawn by `background.ts` in place of the theme's own while
 * the floor is active. Same law as everything else here: it is LIGHT in the margins, so it can never
 * cross the board, and the a11y/tier gates the theme flourishes already sit behind apply unchanged.
 */
export type FloorFlourish = 'tableLamp' | 'filamentBulb'

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
  /** The room's ambient margin accent, replacing the theme's for the duration of the floor. */
  flourish?: FloorFlourish
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
    // A brass banker's lamp burning in the bottom margin — the pool of light on the side table just
    // out of frame. The one thing every picture of a private table has in it.
    flourish: 'tableLamp',
    croupier: 'Good evening. The table is yours — take your time, the House is in no hurry.',
    blurb: 'Private tables. Real stakes. The arm on the right pulls a whole column.',
  },
  2: {
    // Candlelight, oxblood and walnut. Where floor 1 is brass under a high ceiling, this is a low
    // one: a room lit by a dozen small flames rather than by the House.
    //
    // The arc is the NARROWEST on the tower — 20° to 55°, amber through to a dull gold, and under
    // floor 1's saturation. That is the point of it: a speakeasy is not lit, it is candle-lit, and
    // the marquee reading as one colour that barely moves says "low ceiling" better than any tint on
    // the walls could. It sits inside every theme's warm half, so unlike floor 1's hundred-degree
    // sweep it needs no argument with the blush themes at all.
    accent: 0x8a2230,
    rgbHueFrom: 20,
    rgbHueSpan: 35,
    rgbSat: 0.65,
    rayTint: 0xd98b3a,
    bokehWarm: 0xe0a457,
    moteTint: 0xc9762f,
    // F1 — a whole octave below floor 1's G1, on a triangle (more body than a sine, still no edge),
    // through a darker filter and with LESS reverb than upstairs. That last one is the counter-
    // intuitive part and it is deliberate: the wettest room is the one with the high ceiling, and the
    // progression across the tower is wet → dry as the rooms get smaller and closer. A big reverb
    // here would put the speakeasy in a hall.
    audio: { bedRoot: 43.65, waveBias: 'triangle', filterWarmth: 520, reverbMix: 0.38 },
    // A bare filament on a cord, swinging just enough to notice.
    flourish: 'filamentBulb',
    // The croupier is a BARKEEP here, and a warier one — floor 1's host was amused to be watched,
    // this one would rather nobody was. The House gets less comfortable the higher you climb.
    croupier: 'Sit where you like. I never saw you come in, and neither did the House.',
    blurb: 'The room behind the room. Same game, quieter, and nobody is watching the clock.',
  },
}

/**
 * AFTER DARK's accent (Slice 3) — the 200s' signature colour, and the appearance half of
 * `core/levels.ts`'s band predicates, kept here for the same reason every other accent is: core
 * names a stretch of the ladder, this dresses it.
 *
 * A late-evening indigo. It has to do two jobs at once and they pull against each other: read as
 * "the main floor, LATE" beside Act I's gold, and stay clearly WARMER and softer than THE EYE's
 * security blue, which arrives inside this same band at 281 and has to register as the House doing
 * something the room was not already doing. So the band sits at the blue end of dusk and the Eye
 * sits past it, colder and flatter.
 *
 * ⚠️ IT IS DARKER THAN IT WANTS TO BE, and that is a contrast constraint rather than taste. This ink
 * lands on all three ribbon plate states, and the `now` state is REAL METAL — a bright gold face. A
 * dusk indigo picked for the trail alone measured about 2.7:1 there, under AA even for large text
 * (caught in browser verification). Deepened until it clears the gold plate as well as the cream
 * ones; on the journey trail it still reads as evening light rather than as dirt, because the trail
 * paints it at half alpha over a warm ground.
 *
 * ⚠️ It is NOT a `FloorMood`. Moods carry an audio room, a hazard skin, a flourish and a croupier,
 * and AFTER DARK has none of those on purpose — it is a recombination band, not a new room. Giving
 * it a mood object would put it in `moodedFloors()` and break `actII.test.ts`'s "every shipped floor
 * is dressed" check with a floor that does not exist.
 */
export const AFTER_DARK_ACCENT = 0x3d4f85

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

// ─────────────────────────────────────────────────────────────────────────────
// THE ACTIVE FLOOR — "which room is the player standing in".
//
// `theme.setFloorOverlay`'s twin, and set from the same three lines of GameScene for the same
// reason: the two consumers that a THEME overlay cannot serve (the hazard SKIN and the margin
// FLOURISH — neither is a theme token) both need the answer at draw time, from call sites that have
// no level to hand. `ensureHazardTexture` is reached from the texture cache and `themeFlourish` from
// the backdrop composer; threading a level through either would mean threading it through
// everything that calls them.
//
// SCENE-SCOPED BY CONVENTION, exactly as the overlay is: GameScene enters the floor in `create()`
// and leaves it on SHUTDOWN (which fires before the next scene's `create`), so no screen outside a
// numbered Act II level ever sees a floor. Off/endless/Act I all resolve to `null`, so every caller
// degrades to what it drew before Act II existed.
// ─────────────────────────────────────────────────────────────────────────────

let _active: number | null = null

/**
 * Stand the player on the floor a numbered LEVEL belongs to. `null` (endless, or leaving the scene)
 * steps off it. Reads `moodsLive()` at entry AND at exit, so flipping the flag off is instantly
 * total rather than leaving whatever floor was last entered latched.
 */
export function enterFloor(level: number | null): void {
  _active = level === null || !moodsLive() ? null : (floorFor(level)?.floor ?? null)
}

/** The floor being played, or null outside one. */
export function activeFloor(): number | null {
  return moodsLive() ? _active : null
}

/** The mood of the floor being played — what the hazard skins and the margin flourish read. */
export function activeFloorMood(): FloorMood | null {
  const f = activeFloor()
  return f === null ? null : (FLOOR_MOODS[f] ?? null)
}

/** `FLOOR N · THE NAME` — the nameplate copy, and the floor door card's title. */
export function floorPlateLabel(f: Floor): string {
  return `FLOOR ${f.floor} · ${f.name}`
}

/** Every shipped floor has a mood — asserted in actII.test.ts so a new floor cannot ship blank. */
export function moodedFloors(): number[] {
  return FLOORS.map(f => f.floor).filter(n => FLOOR_MOODS[n] !== undefined)
}

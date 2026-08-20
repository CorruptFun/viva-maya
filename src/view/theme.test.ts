/**
 * The theme table's WIRING, and the two colour laws that hold across every room — the things nobody
 * is looking at when a fifth room lands.
 *
 * Adding a theme touches five separate places in `theme.ts`, and the failure mode for missing one is
 * SILENCE. A theme absent from `THEME_ORDER` renders no picker row, so players never see it — and
 * every test that walks that list (the hue arcs in `core/rgb.test.ts`, the key-lock roots in
 * `audio/scale.test.ts`) walks straight past it too, so it ships both invisible and unpinned. That
 * is the first test here, and it is the only one that can catch a half-wired theme.
 *
 * The rest pin the two rules a new room is most likely to break by eye rather than by type:
 *
 *  1. **Backdrop copy stays legible on its OWN wash.** The muted tier is what goes first, and it
 *     did go first — Maya's Heart's `onBackdropMuted` fell to ~2.9:1 when its wash was deepened for
 *     §V1, and only a hand re-check caught it. Measured against the wash's LIGHTEST band, which is
 *     the hard case on a light theme and the honest one on a dark theme (the gradient really does
 *     reach it).
 *  2. **`pageBg` agrees with `washTop`.** `applyPageChrome` paints the body gradient and
 *     `<meta theme-color>` from the wash, so a `pageBg` that drifts from it puts a seam across the
 *     letterbox strip on any phone taller than 9:16 — the one place the DOM and the canvas meet.
 *
 * Plus the promise that makes golden's single WCAG pass legal for all of them: cards stay CREAM
 * everywhere, so the on-card inks are pinned against each theme's own `cardFill` rather than assumed.
 */
import { describe, expect, it } from 'vitest'
import { css, DEFAULT_THEME_ID, THEME_META, THEME_ORDER, THEMES } from './theme'
import type { Theme, ThemeId } from './theme'

/** WCAG relative luminance of a packed RGB (the real curve — a naive average mis-ranks warm hues). */
function luminance(n: number): number {
  const chan = (c: number): number => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan((n >> 16) & 0xff) + 0.7152 * chan((n >> 8) & 0xff) + 0.0722 * chan(n & 0xff)
}

/** WCAG contrast ratio between two packed RGBs, 1..21. */
function contrast(a: number, b: number): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** `#rrggbb` → packed RGB, for the tokens stored as CSS strings. */
const hex = (s: string): number => parseInt(s.slice(1), 16)

/** The lightest band of a theme's wash — the end that decides whether light-on-wash copy survives. */
const lightestBand = (T: Theme): number => (luminance(T.washTop) >= luminance(T.washBottom) ? T.washTop : T.washBottom)

const every = (): Array<[ThemeId, Theme]> => THEME_ORDER.map(id => [id, THEMES[id]])

describe('the theme table is fully wired', () => {
  it('lists every theme in THEME_ORDER exactly once — the picker and every walking test read it', () => {
    expect([...THEME_ORDER].sort()).toEqual(Object.keys(THEMES).sort())
    expect(new Set(THEME_ORDER).size).toBe(THEME_ORDER.length)
  })

  it('files each theme under its own id, with a picker entry that agrees about the name', () => {
    for (const [id, T] of every()) {
      expect({ id, filedAs: T.id }).toEqual({ id, filedAs: id })
      expect({ id, name: THEME_META[id]?.name }).toEqual({ id, name: T.name })
      expect({ id, feel: (THEME_META[id]?.feel ?? '').length > 0 }).toEqual({ id, feel: true })
    }
  })

  it('opens on a room the player already owns', () => {
    expect(THEME_ORDER).toContain(DEFAULT_THEME_ID)
    expect(THEME_META[DEFAULT_THEME_ID].unlockLevel).toBe(0)
  })
})

describe('every room stays legible in its own light', () => {
  it('keeps backdrop copy above AA on the wash it is drawn on', () => {
    for (const [id, T] of every()) {
      const band = lightestBand(T)
      // Body tier: the 4.5:1 line. This is the one that failed silently on a wash retune.
      expect({ id, muted: contrast(hex(T.onBackdropMuted), band) >= 4.5 }).toEqual({ id, muted: true })
      // Display tier: comfortably past it, because headings on the wash are the game's loudest copy.
      expect({ id, ink: contrast(hex(T.onBackdropInk), band) >= 7 }).toEqual({ id, ink: true })
    }
  })

  it('keeps on-card ink above AA on its OWN cardFill — the promise that lets one pass cover five', () => {
    for (const [id, T] of every()) {
      // Body AA on the card. `inkFaint` is the deliberate large-text tier (3:1), never body copy.
      expect({ id, muted: contrast(hex(T.inkMuted), T.cardFill) >= 4.5 }).toEqual({ id, muted: true })
      expect({ id, gold: contrast(hex(T.goldText), T.cardFill) >= 4.5 }).toEqual({ id, gold: true })
      expect({ id, faint: contrast(hex(T.inkFaint), T.cardFill) >= 3 }).toEqual({ id, faint: true })
      // `roseDeep` is the one THEME-OWNED accent drawn as body-size type on a cream card (the
      // picker's own "Reach Level N"), so a theme that recasts the rose role has to clear it too.
      expect({ id, roseDeep: contrast(T.roseDeep, T.cardFill) >= 4.5 }).toEqual({ id, roseDeep: true })
    }
  })

  it('points page chrome at the wash, so the letterbox strip has no seam', () => {
    for (const [id, T] of every()) {
      expect({ id, pageBg: T.pageBg }).toEqual({ id, pageBg: css(T.washTop) })
    }
  })
})

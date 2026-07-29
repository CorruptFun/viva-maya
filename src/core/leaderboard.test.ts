import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_WEEK_CUTOVER,
  formatStanding,
  getHandle,
  isLegacyWeek,
  levelStanding,
  preferredName,
  sanitizeName,
  setHandle,
} from './leaderboard'
import type { SaveData } from './save'

/**
 * Race-name (handle) unit tests — the pure storage + sanitising layer only.
 * The Supabase paths are dormant here by design (no VITE_SUPABASE_* in the test
 * env), so setHandle's fire-and-forget rename resolves as a no-op — exactly the
 * unconfigured production path.
 */

// Minimal localStorage stub for the Node test env (theme.ts-style guarded access).
function stubStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
}

beforeEach(stubStorage)
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('sanitizeName', () => {
  it('keeps letters, numbers, spaces and _.- and trims', () => {
    expect(sanitizeName('  Neon_Ghost-77. ')).toBe('Neon_Ghost-77.')
  })
  it('takes only the local part of an email', () => {
    expect(sanitizeName('jane.doe@example.com')).toBe('jane.doe')
  })
  it('strips symbols and emoji', () => {
    expect(sanitizeName('n<e>o#n!👻ghost')).toBe('neonghost')
  })
  it('caps at 24 characters', () => {
    expect(sanitizeName('a'.repeat(40))).toHaveLength(24)
  })
  it('falls back to "player" when nothing survives', () => {
    expect(sanitizeName('@@@')).toBe('player')
    expect(sanitizeName('')).toBe('player')
    expect(sanitizeName(null)).toBe('player')
  })
  it('keeps non-latin letters', () => {
    expect(sanitizeName('Майя-77')).toBe('Майя-77')
  })
})

describe('handle storage', () => {
  it('round-trips a chosen handle, sanitized', () => {
    expect(setHandle('  Neon Ghost!! ')).toBe('Neon Ghost')
    expect(getHandle()).toBe('Neon Ghost')
  })
  it('clears with null or blank input', () => {
    setHandle('ghosty')
    expect(setHandle('')).toBeNull()
    expect(getHandle()).toBeNull()
    setHandle('ghosty')
    expect(setHandle(null)).toBeNull()
    expect(getHandle()).toBeNull()
  })
  it('behaves as unset when storage is unavailable', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(getHandle()).toBeNull()
    expect(setHandle('ghosty')).toBe('ghosty') // sanitized value still returned for the session
  })
})

describe('preferredName', () => {
  it('prefers the chosen handle over everything', () => {
    setHandle('neonghost')
    expect(preferredName()).toBe('neonghost')
  })
  it('falls back to "player" when signed out with no handle', () => {
    // cloudSession() is null in the test env (never signed in).
    expect(preferredName()).toBe('player')
  })
})

/**
 * LEVEL RACE standing — the whole basis of the ladder's ranking. It decides the rung a player lands
 * on and the stars that break ties on it, and it is the only part of the board pure enough to test
 * without a network, so it gets pinned hard: the off-by-one that would put every player a level
 * ahead, and the shape-tolerance that stops a corrupt save poisoning a PUBLIC row.
 */
const save = (over: Partial<SaveData>): SaveData => ({ unlocked: 1, stars: {}, ...over }) as SaveData

describe('levelStanding', () => {
  it('reads CLEARED as one below unlocked — a fresh save has cleared nothing', () => {
    // `unlocked` is the highest level the player MAY ATTEMPT, so a brand-new save (unlocked 1,
    // attempting level 1) has cleared ZERO. Reporting 1 would place every player who has never
    // finished a level onto the ladder alongside those who legitimately cleared level 1.
    expect(levelStanding(save({ unlocked: 1 })).cleared).toBe(0)
    expect(levelStanding(save({ unlocked: 2 })).cleared).toBe(1)
    expect(levelStanding(save({ unlocked: 48 })).cleared).toBe(47)
  })

  it('never reports a negative rung from a corrupt unlocked value', () => {
    expect(levelStanding(save({ unlocked: 0 })).cleared).toBe(0)
    expect(levelStanding(save({ unlocked: -5 })).cleared).toBe(0)
  })

  it('sums stars across cleared levels', () => {
    expect(levelStanding(save({ unlocked: 4, stars: { 1: 3, 2: 2, 3: 1 } }))).toEqual({ cleared: 3, stars: 6 })
  })

  it('ignores stars recorded ABOVE the cleared mark', () => {
    // The server clamps to 3×cleared anyway; sending a row it has to correct would hide a real
    // desync (stars and unlocked disagreeing) behind a silent server-side fixup.
    expect(levelStanding(save({ unlocked: 3, stars: { 1: 3, 2: 3, 9: 3, 40: 3 } }))).toEqual({ cleared: 2, stars: 6 })
  })

  it('survives a corrupt stars record without emitting NaN', () => {
    // `stars` is restored shape-tolerantly straight from localStorage, so anything can be in there.
    // A NaN would serialize into the public row and sort unpredictably against every other player.
    const dirty = { 1: 3, 2: NaN, 3: 'three', 4: null, 5: undefined, 6: -2, 7: Infinity } as unknown as Record<number, number>
    const s = levelStanding(save({ unlocked: 8, stars: dirty }))
    expect(Number.isFinite(s.stars)).toBe(true)
    expect(s.stars).toBe(3) // only level 1's legitimate 3 survives
    expect(s.cleared).toBe(7)
  })

  it('caps any single level at 3 stars', () => {
    expect(levelStanding(save({ unlocked: 3, stars: { 1: 99, 2: 3 } })).stars).toBe(6)
  })

  it('never exceeds the server ceiling of 3 stars per cleared level', () => {
    // Mirrors `least(new.stars, new.cleared * 3)` in migration 0007. If this ever breaches the
    // ceiling the server silently rewrites our row and the board stops matching the game.
    for (const unlocked of [1, 2, 10, 51, 301]) {
      const stars: Record<number, number> = {}
      for (let i = 1; i < unlocked; i++) stars[i] = 3
      const s = levelStanding(save({ unlocked, stars }))
      expect(s.stars, `unlocked ${unlocked}`).toBeLessThanOrEqual(s.cleared * 3)
    }
  })

  it('tolerates a missing stars record entirely', () => {
    expect(levelStanding({ unlocked: 5 } as SaveData)).toEqual({ cleared: 4, stars: 0 })
  })
})

describe('formatStanding', () => {
  it('shows the rung first, then the mastery that breaks ties on it', () => {
    expect(formatStanding({ cleared: 47, stars: 118 })).toBe('47 · ★118')
    expect(formatStanding({ cleared: 0, stars: 0 })).toBe('0 · ★0')
  })
})

/**
 * The TRANSITION CUTOVER. The daily format shipped mid-week into a weekly race that was already
 * being run, so every week up to the cutover is still settled on the old shared board — otherwise
 * that week's crown goes to whoever won the days AFTER the switch and the players who spent it
 * battling get nothing. This is the one line that decides which source pays out, so it gets pinned:
 * an off-by-one week here silently pays the wrong player 1,000 chips.
 */
describe('isLegacyWeek — which weeks the old board still settles', () => {
  it('settles the cutover week and everything before it', () => {
    expect(isLegacyWeek(LEGACY_WEEK_CUTOVER)).toBe(true)
    expect(isLegacyWeek('2026-W30')).toBe(true)
    expect(isLegacyWeek('2026-W01')).toBe(true)
    expect(isLegacyWeek('2025-W52')).toBe(true)
  })

  it('hands the very next week to the summed-daily season', () => {
    expect(isLegacyWeek('2026-W32')).toBe(false)
    expect(isLegacyWeek('2026-W52')).toBe(false)
  })

  it('orders correctly across a year boundary — the trap in comparing week keys as strings', () => {
    // Zero-padded 'YYYY-Www' sorts chronologically, so a plain <= is safe. If the format ever loses
    // its padding this breaks silently, which is exactly why it is asserted rather than assumed.
    expect(isLegacyWeek('2027-W01')).toBe(false)
    expect(LEGACY_WEEK_CUTOVER).toMatch(/^\d{4}-W\d{2}$/)
  })

  it('is set to the week the switch actually landed in', () => {
    expect(LEGACY_WEEK_CUTOVER).toBe('2026-W31')
  })
})

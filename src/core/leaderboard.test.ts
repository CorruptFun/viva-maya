import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getHandle, preferredName, sanitizeName, setHandle } from './leaderboard'

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

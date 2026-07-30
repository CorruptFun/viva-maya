import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * THE PRIVACY INVARIANT: nothing derived from a player's email address may ever become their public
 * name. This file is the only place it can be tested honestly, because it needs a SIGNED-IN session —
 * leaderboard.test.ts runs the dormant, signed-out path, where an email cannot leak because there
 * isn't one.
 *
 * Why it earns a file of its own: the display name used to FALL BACK to the email local-part, which
 * for a Google account is routinely a real name ('jane.doe'), so every player who never opened the
 * race-name picker was publishing one to a world-readable table. The fix is that `preferredName` — the
 * single function deciding what goes public — cannot reach the email at all. That is a property of the
 * code, not a value to check, so the test mocks a session whose email is a real-looking name and
 * asserts that no part of it survives into anything published.
 *
 * The server enforces the same rule independently (migration 0017), because cached PWA clients keep
 * running the old fallback for as long as it takes them to update.
 */

const EMAIL = 'jane.doe@example.com'
const USER_ID = '7f3a91b2-0000-0000-0000-000000000000'

// Spy on the immediate save-push. Declared via vi.hoisted because vi.mock's factory is hoisted above
// ordinary consts, and this one has to exist when the factory runs, not merely when the test does.
const mocks = vi.hoisted(() => ({ flushCloudSaveNow: vi.fn(async () => {}) }))

// Signed IN, with an email that is a real name — the exact shape that used to leak. isCloudConfigured
// is true so nothing takes the dormant early-out, while sbClient yields null so the fire-and-forget
// rename resolves as a no-op instead of reaching for a network.
vi.mock('./cloud', () => ({
  cloudSession: () => ({ userId: USER_ID, email: EMAIL }),
  isCloudConfigured: () => true,
  sbClient: async () => null,
  flushCloudSaveNow: mocks.flushCloudSaveNow,
}))

const { anonName, preferredName, sanitizeName, setHandle } = await import('./leaderboard')

function stubStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
}

beforeEach(() => {
  stubStorage()
  mocks.flushCloudSaveNow.mockClear()
})
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('preferredName never publishes the email', () => {
  it('uses the anonymous name when no handle is set — NOT the email local-part', () => {
    // The regression itself. Before the fix this returned 'jane.doe'.
    expect(preferredName()).toBe('Player 7F3A')
    expect(preferredName()).toBe(anonName(USER_ID))
  })

  it('leaks no fragment of the address, under any casing', () => {
    // Deliberately broader than the assertion above: this fails for ANY future fallback that derives
    // from the email, not just the local-part that was there before.
    const published = preferredName().toLowerCase()
    for (const fragment of ['jane', 'doe', 'jane.doe', 'janedoe', 'example', 'example.com', '@']) {
      expect(published).not.toContain(fragment)
    }
  })

  it('still prefers a chosen handle over the anonymous name', () => {
    setHandle('neonghost')
    expect(preferredName()).toBe('neonghost')
  })

  it('publishes the anonymous name again once a handle is cleared', () => {
    // Clearing must not reopen the fallback — the old code would have gone back to the email here.
    setHandle('neonghost')
    setHandle(null)
    expect(preferredName()).toBe('Player 7F3A')
  })

  it('does not resurrect the email even when the player types it in as their handle', () => {
    // sanitizeName drops everything from the '@' on, so a pasted address cannot publish a domain.
    // (The server independently substitutes the anonymous name for this case — see 0017's header.)
    expect(setHandle(EMAIL)).toBe('jane.doe')
    expect(sanitizeName(EMAIL)).not.toContain('@')
    expect(sanitizeName(EMAIL)).not.toContain('example')
  })
})

/**
 * Setting a name must reach the CLOUD immediately, not on the 1.5s save debounce.
 *
 * The reported flow was "set my race name, then close the browser", which fits inside that window.
 * The name would still reach the boards (setHandle renames those rows directly) but never the cloud
 * SAVE — so the next device would restore progress without the name, which is the exact bug the
 * handle bridge exists to fix. Only reachable with a session, hence this file rather than the other.
 */
describe('setHandle pushes the save immediately', () => {
  it('flushes the pending cloud save rather than waiting for the debounce', () => {
    setHandle('neonghost')
    expect(mocks.flushCloudSaveNow).toHaveBeenCalledTimes(1)
  })

  it('flushes on a CLEAR too — erasing a name is just as deliberate as setting one', () => {
    setHandle(null)
    expect(mocks.flushCloudSaveNow).toHaveBeenCalledTimes(1)
  })
})

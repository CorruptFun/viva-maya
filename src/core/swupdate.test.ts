import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AUTO_UPDATE_WINDOW_MS, claimAutoUpdate } from './swupdate'

/**
 * These pin the guard that lets main.ts apply a waiting service worker WITHOUT asking. The one that
 * matters most is `refuses a second claim in the same tab`: that latch is the only thing standing
 * between a worker which installs but never takes control and an app that reload-loops forever with
 * no way out on the player's side — a strictly worse outcome than the staleness this fixes.
 *
 * The rest guard the two ways the silent path could misfire: applying late (a reload under a player
 * who has already started tapping) and applying when storage cannot record that we did.
 */

let store: Record<string, string>
/** Set to make every storage operation throw, the way a blocked or full quota does. */
let storageThrows: boolean

beforeEach(() => {
  store = {}
  storageThrows = false
  ;(globalThis as Record<string, unknown>).sessionStorage = {
    getItem(k: string): string | null {
      if (storageThrows) throw new Error('blocked')
      return store[k] ?? null
    },
    setItem(k: string, v: string): void {
      if (storageThrows) throw new Error('blocked')
      store[k] = v
    },
  }
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).sessionStorage
})

describe('claimAutoUpdate', () => {
  it('allows a silent update during boot', () => {
    expect(claimAutoUpdate(0)).toBe(true)
  })

  it('refuses a second claim in the same tab', () => {
    // The anti-reload-loop latch. A worker that fails to activate leaves the page still eligible on
    // every subsequent check; without this the app would apply-reload-apply indefinitely.
    expect(claimAutoUpdate(0)).toBe(true)
    expect(claimAutoUpdate(10)).toBe(false)
  })

  it('refuses when a previous page already auto-applied', () => {
    // sessionStorage SURVIVES the reload the first claim caused — that persistence is what makes
    // the latch a loop breaker rather than a no-op, so a fresh call after the reload must refuse.
    store['viva-maya:auto-updated'] = '1'
    expect(claimAutoUpdate(0)).toBe(false)
  })

  it('refuses past the boot window, so it can never reload a player mid-play', () => {
    expect(claimAutoUpdate(AUTO_UPDATE_WINDOW_MS + 1)).toBe(false)
  })

  it('allows exactly at the window edge', () => {
    expect(claimAutoUpdate(AUTO_UPDATE_WINDOW_MS)).toBe(true)
  })

  it('refuses on an unusable clock rather than guessing', () => {
    expect(claimAutoUpdate(Number.NaN)).toBe(false)
  })

  it('refuses when storage is blocked, and spends nothing', () => {
    // No latch can be recorded, so a loop could not be broken — decline the silent path entirely
    // and let main.ts fall back to the visible toast.
    storageThrows = true
    expect(claimAutoUpdate(0)).toBe(false)
    storageThrows = false
    expect(store).toEqual({})
  })
})

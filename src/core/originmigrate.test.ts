import { describe, expect, it } from 'vitest'
import {
  CANONICAL_URL,
  LEGACY_HOST,
  MAX_HANDOFF_CHARS,
  adoptHandoffInto,
  collectCarried,
  handoffTarget,
  readHandoff,
  type MigrateEnv,
} from './originmigrate'

/**
 * The load-bearing test in this file is `never hands off from the canonical origin`. Both origins
 * serve the SAME bundle (corrupt.solutions is a reverse proxy in front of the Pages deployment), so
 * this module's code runs on the destination too — a hostname gate that answered the wrong way
 * would redirect the canonical address to itself and take down every player at once, which is
 * strictly worse than the storage split it exists to fix.
 *
 * The rest guard the ways the migration could COST a player something: ejecting an installed PWA
 * out of its own scope, dropping a `?ref=` invite on the hop, or clobbering a profile on arrival.
 */

const encode = (o: unknown): string => encodeURIComponent(JSON.stringify(o))

const env = (over: Partial<MigrateEnv> = {}): MigrateEnv => ({
  hostname: LEGACY_HOST,
  standalone: false,
  search: '',
  ...over,
})

/** A minimal in-memory Storage, faithful enough for key()/length iteration. */
function makeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage
}

describe('handoffTarget', () => {
  it('never hands off from the canonical origin', () => {
    // THE anti-loop rule. corrupt.solutions serves this same code through its proxy.
    expect(handoffTarget(env({ hostname: 'corrupt.solutions' }), '{}')).toBeNull()
  })

  it('never hands off from any other host', () => {
    for (const hostname of ['localhost', '127.0.0.1', 'example.com', 'corruptfun.github.io.evil.com']) {
      expect(handoffTarget(env({ hostname }), '{}')).toBeNull()
    }
  })

  it('hands off from the legacy origin', () => {
    expect(handoffTarget(env(), encode({ a: '1' }))).toContain(CANONICAL_URL)
  })

  it('carries a ?ref= invite across the hop', () => {
    // The origin split is what lost a real referral: the code was captured in one storage context
    // and the sign-in happened in another. Dropping the query here would recreate that exactly.
    const target = handoffTarget(env({ search: '?ref=JDWWJO' }), '{}')
    expect(target).toContain('?ref=JDWWJO')
  })

  it('refuses to eject an installed PWA from its own scope', () => {
    // Navigating a standalone window off-scope bounces it into the browser on iOS, breaking the
    // app the player installed. They keep the legacy origin, which still works.
    expect(handoffTarget(env({ standalone: true }), '{}')).toBeNull()
  })

  it('stays put rather than hopping without an oversized profile', () => {
    // Refusing to MOVE, not refusing to carry: arriving with an empty profile would cost an
    // un-signed-in player everything they had.
    expect(handoffTarget(env(), 'x'.repeat(MAX_HANDOFF_CHARS + 1))).toBeNull()
  })
})

describe('readHandoff', () => {
  it('reads a payload written by handoffTarget', () => {
    const target = handoffTarget(env(), encode({ 'viva-maya:theme': 'silk' }))
    expect(readHandoff(new URL(target!).hash)).toEqual({ 'viva-maya:theme': 'silk' })
  })

  it('returns null when there is no handoff', () => {
    expect(readHandoff('')).toBeNull()
    expect(readHandoff('#other=1')).toBeNull()
  })

  it('survives a malformed or truncated fragment', () => {
    expect(readHandoff('#vmfrom=not-json')).toBeNull()
    expect(readHandoff(`#vmfrom=${encode(['a'])}`)).toBeNull()
  })

  it('drops keys outside the game namespace', () => {
    // The fragment is attacker-reachable, so nothing may be written outside our own prefixes.
    const got = readHandoff(`#vmfrom=${encode({ 'evil:token': 'x', 'viva-maya:theme': 'silk' })}`)
    expect(got).toEqual({ 'viva-maya:theme': 'silk' })
  })

  it('drops origin-local machinery that must not ride along', () => {
    const got = readHandoff(`#vmfrom=${encode({ 'viva-maya:auto-updated': '1', 'vm.racesalt': 's' })}`)
    expect(got).toEqual({ 'vm.racesalt': 's' })
  })
})

describe('adoptHandoffInto', () => {
  it('fills keys the destination does not have', () => {
    const s = makeStorage()
    expect(adoptHandoffInto({ 'viva-maya:theme': 'silk' }, s)).toBe(1)
    expect(s.getItem('viva-maya:theme')).toBe('silk')
  })

  it('never overwrites a setting the destination already has', () => {
    const s = makeStorage({ 'viva-maya:theme': 'aurora' })
    expect(adoptHandoffInto({ 'viva-maya:theme': 'silk' }, s)).toBe(0)
    expect(s.getItem('viva-maya:theme')).toBe('aurora')
  })

  it('merges a colliding save monotonically instead of picking one', () => {
    // A player who used BOTH origins must not lose the further-progressed half. mergeSaves is the
    // same primitive the cloud merge uses, so the two can never disagree.
    const s = makeStorage({ 'viva-maya:v1': JSON.stringify({ unlocked: 3, chips: 500 }) })
    expect(adoptHandoffInto({ 'viva-maya:v1': JSON.stringify({ unlocked: 9, chips: 10 }) }, s)).toBe(1)
    expect(JSON.parse(s.getItem('viva-maya:v1')!).unlocked).toBe(9)
  })

  it('cannot be used to roll a save backwards', () => {
    const s = makeStorage({ 'viva-maya:v1': JSON.stringify({ unlocked: 9 }) })
    adoptHandoffInto({ 'viva-maya:v1': JSON.stringify({ unlocked: 2 }) }, s)
    expect(JSON.parse(s.getItem('viva-maya:v1')!).unlocked).toBe(9)
  })

  it('one unparseable key does not abort the rest', () => {
    const s = makeStorage({ 'viva-maya:v1': '{ not json' })
    expect(adoptHandoffInto({ 'viva-maya:v1': '{ also not json', 'vm.racesalt': 's' }, s)).toBe(1)
    expect(s.getItem('vm.racesalt')).toBe('s')
  })
})

describe('collectCarried', () => {
  it('takes the player’s keys and leaves everything else', () => {
    const s = makeStorage({
      'viva-maya:v1': '{}',
      'vm.boardpick': 'x',
      'viva-maya:auto-updated': '1', // origin-local machinery
      'viva-maya:origin-migrated': '1', // ditto — carrying it would latch the destination
      'unrelated-app': 'y',
    })
    expect(collectCarried(s)).toEqual({ 'viva-maya:v1': '{}', 'vm.boardpick': 'x' })
  })
})

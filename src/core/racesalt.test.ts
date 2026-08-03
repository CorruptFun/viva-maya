import { describe, expect, it } from 'vitest'
import { SALT_ACTIVE_FROM, daySaltApplies, endlessRngForDay, seedForKey } from './endless'

/**
 * Guards on the board salt — the mechanism that stops a race board being computable before its day
 * opens (migration 0023).
 *
 * The DORMANCY assertions are the load-bearing ones. This ships ahead of its activation date so that
 * cached PWA clients have time to update, and the entire safety of that plan rests on the seed being
 * byte-identical to the old one until SALT_ACTIVE_FROM. If a salt ever leaked into an earlier day,
 * two populations would race different boards under one leaderboard — which looks exactly like
 * normal results and would never surface on its own.
 */

const BEFORE = '2026-08-03'
const ON = SALT_ACTIVE_FROM
const AFTER = '2026-08-20'

/** Pull the first few values off an RNG — the board fill's actual input. */
const sample = (day: string, salt?: string | null): number[] => {
  const rng = endlessRngForDay(day, salt)
  return Array.from({ length: 8 }, () => rng())
}

describe('the board salt', () => {
  it('is dormant before the activation date', () => {
    expect(daySaltApplies(BEFORE)).toBe(false)
    expect(daySaltApplies('2026-07-29')).toBe(false)
    // A salt supplied for an earlier day must be IGNORED, not mixed in — the old board, exactly.
    expect(sample(BEFORE, 'some-server-salt')).toEqual(sample(BEFORE))
    expect(sample(BEFORE, 'some-server-salt')).toEqual(sample(BEFORE, null))
  })

  it('activates on the date itself, not the day after', () => {
    expect(daySaltApplies(ON)).toBe(true)
    expect(daySaltApplies(AFTER)).toBe(true)
  })

  it('changes the board once active', () => {
    expect(sample(ON, 'salt-a')).not.toEqual(sample(ON))
    expect(sample(ON, 'salt-a')).not.toEqual(sample(ON, 'salt-b'))
  })

  it('falls back to the ORIGINAL board when no salt is available', () => {
    // The offline path. It must reproduce the pre-salt board exactly, because that is the board the
    // player keeps a local best against — and because a third distinct board would be a third
    // population.
    expect(sample(AFTER, null)).toEqual(sample(AFTER))
    expect(sample(AFTER, '')).toEqual(sample(AFTER))
    expect(endlessRngForDay(AFTER, null)()).toBe(mulberryFirst(seedForKey(AFTER)))
  })

  it('is the same board for everyone holding the same salt', () => {
    // The fairness contract, unchanged: the salt is shared, not per-player.
    expect(sample(AFTER, 'shared')).toEqual(sample(AFTER, 'shared'))
  })

  it('rejects a malformed day key rather than salting it', () => {
    expect(daySaltApplies('nonsense')).toBe(false)
    expect(daySaltApplies('')).toBe(false)
  })

  it('gives adjacent days unrelated boards under the same salt', () => {
    // The salt must not turn the day key into a weak suffix — two consecutive days sharing a salt
    // still have to be independent boards.
    expect(sample('2026-08-20', 's')).not.toEqual(sample('2026-08-21', 's'))
  })
})

/** First value of mulberry32(seed) — inlined so the test does not depend on rng.ts internals. */
function mulberryFirst(seed: number): number {
  let a = seed
  a |= 0
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

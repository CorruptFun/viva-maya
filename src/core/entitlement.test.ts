import { describe, expect, it } from 'vitest'
import {
  PAYWALL_ACTIVE_FROM,
  PAYWALL_ACTIVE_FROM_DAY,
  gateVerdict,
  grandfatheredLocally,
  paywallActive,
  type CachedAccess,
  type GateInput,
} from './entitlement'

/**
 * These pin the boot gate — the one decision that stands between a player and the game.
 *
 * Two of them matter more than the rest, and both are about which way the gate FAILS:
 *
 *   · `a dormant build never paywalls` — a local-only build (no VITE_SUPABASE_*) can neither sell
 *     an entitlement nor verify one. Charging into a paywall that cannot possibly resolve would
 *     brick every dev checkout and any build shipped without cloud config, with no way out from
 *     inside the game.
 *   · `a server refusal beats the local grandfather clause` — the grandfather clause reads
 *     `save.firstPlayDate`, which any player can edit. It exists so that the large cohort who never
 *     signed in aren't billed for a game they already own. But it must never answer AFTER the
 *     server has already refused, or a refunded account — whose save is by then genuinely old —
 *     walks straight back in for free, having taken its money back.
 */

const BEFORE = new Date(Date.parse(PAYWALL_ACTIVE_FROM) - 86_400_000)
const AFTER = new Date(Date.parse(PAYWALL_ACTIVE_FROM) + 86_400_000)

/** A live account with no local history and no server answer — the new-player default. */
function input(over: Partial<GateInput> = {}): GateInput {
  return {
    now: AFTER,
    configured: true,
    userId: 'user-a',
    cached: null,
    firstPlayDate: null,
    ...over,
  }
}

function cached(over: Partial<CachedAccess> = {}): CachedAccess {
  return { userId: 'user-a', entitled: true, reason: 'paid', at: 0, ...over }
}

describe('the switch', () => {
  it('is a real instant, and its day key agrees with it', () => {
    expect(Number.isFinite(Date.parse(PAYWALL_ACTIVE_FROM))).toBe(true)
    expect(PAYWALL_ACTIVE_FROM_DAY).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(PAYWALL_ACTIVE_FROM.startsWith(PAYWALL_ACTIVE_FROM_DAY)).toBe(true)
  })

  it('opens on the instant, not the day after', () => {
    expect(paywallActive(new Date(Date.parse(PAYWALL_ACTIVE_FROM) - 1))).toBe(false)
    expect(paywallActive(new Date(Date.parse(PAYWALL_ACTIVE_FROM)))).toBe(true)
  })
})

describe('gateVerdict', () => {
  it('a dormant build never paywalls', () => {
    // No cloud → no way to sell OR verify. Must fail open, in every other circumstance that would
    // otherwise block: after the switch, signed out, brand-new save.
    const v = gateVerdict(input({ configured: false }))
    expect(v.allow).toBe(true)
    expect(v.reason).toBe('dormant')
  })

  it('lets everyone through before the switch', () => {
    const v = gateVerdict(input({ now: BEFORE }))
    expect(v.allow).toBe(true)
    expect(v.reason).toBe('prelaunch')
  })

  it('blocks a brand-new signed-in player once the switch has passed', () => {
    const v = gateVerdict(input())
    expect(v.allow).toBe(false)
    expect(v.reason).toBe('unpaid')
  })

  it('blocks a brand-new SIGNED-OUT player too', () => {
    // Sign-in is a step INSIDE the paywall, not a way around it.
    const v = gateVerdict(input({ userId: null }))
    expect(v.allow).toBe(false)
  })

  it('honours a paid verdict from the server', () => {
    const v = gateVerdict(input({ cached: cached({ entitled: true, reason: 'paid' }) }))
    expect(v.allow).toBe(true)
    expect(v.reason).toBe('server')
    expect(v.serverReason).toBe('paid')
  })

  it('keeps a paid player in while offline, forever', () => {
    // There is no expiry on a positive cached verdict, and there must not be: a player who paid and
    // then lost their network has bought the game, not a lease on it.
    const ancient = cached({ entitled: true, at: 0 })
    const v = gateVerdict(input({ now: new Date(AFTER.getTime() + 5 * 365 * 86_400_000), cached: ancient }))
    expect(v.allow).toBe(true)
  })

  it('a server refusal beats the local grandfather clause', () => {
    // The case this exists for: an account that paid, played for a month (so firstPlayDate is now
    // genuinely old), then charged back. The server says refunded; the forgeable local clause must
    // not overrule it.
    const v = gateVerdict(
      input({
        cached: cached({ entitled: false, reason: 'refunded' }),
        firstPlayDate: '2020-01-01',
      })
    )
    expect(v.allow).toBe(false)
    expect(v.reason).toBe('server')
    expect(v.serverReason).toBe('refunded')
  })

  it('does not apply another account’s verdict on a shared device', () => {
    // The cache is keyed by user id precisely so signing out and signing in as someone else cannot
    // inherit the first player's entitlement.
    const v = gateVerdict(input({ userId: 'user-b', cached: cached({ userId: 'user-a', entitled: true }) }))
    expect(v.allow).toBe(false)
    expect(v.reason).toBe('unpaid')
  })

  it('falls back to the local clause when signed out, even holding a stale verdict', () => {
    // Signed out there is no account to match the cache against, so the device's own history is all
    // there is — and an existing player who signs out must not be locked out of a game they own.
    const v = gateVerdict(input({ userId: null, cached: cached(), firstPlayDate: '2026-01-15' }))
    expect(v.allow).toBe(true)
    expect(v.reason).toBe('grandfathered_local')
  })

  it('grandfathers an existing player who has never signed in', () => {
    const v = gateVerdict(input({ userId: null, firstPlayDate: '2026-06-01' }))
    expect(v.allow).toBe(true)
    expect(v.reason).toBe('grandfathered_local')
  })
})

describe('grandfatheredLocally', () => {
  it('admits a save stamped before the switch day', () => {
    expect(grandfatheredLocally('2026-08-31')).toBe(true)
    expect(grandfatheredLocally('2020-01-01')).toBe(true)
  })

  it('refuses the switch day itself and everything after', () => {
    // The switch day is the first BILLABLE day; a save first stamped that morning is a new player.
    expect(grandfatheredLocally(PAYWALL_ACTIVE_FROM_DAY)).toBe(false)
    expect(grandfatheredLocally('2027-01-01')).toBe(false)
  })

  it('refuses a brand-new install', () => {
    // `firstPlayDate` is null until Home stamps it, and the gate runs BEFORE Home — so a genuinely
    // new player is null here, not "today".
    expect(grandfatheredLocally(null)).toBe(false)
  })

  it('refuses a malformed date rather than string-comparing junk into a free game', () => {
    for (const junk of ['', 'yesterday', '26-08-31', '2026-8-3', '0000', 'null']) {
      expect(grandfatheredLocally(junk)).toBe(false)
    }
    expect(grandfatheredLocally(20260831 as unknown as string)).toBe(false)
  })
})

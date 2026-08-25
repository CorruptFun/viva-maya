import { describe, expect, it } from 'vitest'
import {
  CASH_BY_DEPTH,
  ENTRY_PRICE_CENTS,
  HOLD_DAYS,
  MIN_PAYOUT_CENTS,
  cashRateCents,
  earnsCash,
  formatUsd,
  processorFeeCents,
} from './referralcash'

/**
 * ⚠️ AN ECONOMY GUARD, not a unit test — the family of slots.rate / plinko.rate / endless.pace.
 *
 * It measures what the referral program actually PAYS against what an entry fee actually TAKES. If
 * you retune a commission or the entry price, the numbers below are what you RE-DERIVE — never what
 * you edit to make the suite green. A failure here means the program's solvency changed, which is
 * a business decision, not a test maintenance chore.
 *
 * The invariant it exists for: **the house is solvent on every individual transaction, not on
 * average.** One entry fee funds at most one commission, so no mix of referral depths and no growth
 * rate can put the program underwater. That property is what makes this safe to run at any scale,
 * and it is one careless constant away from being false.
 */

/** What Stripe leaves us on one entry fee, before any commission. */
const NET_PER_ENTRY = ENTRY_PRICE_CENTS - processorFeeCents(ENTRY_PRICE_CENTS)

/**
 * Floor on what the house keeps from the WORST case (the largest commission). Not a derived
 * quantity — a stated floor. Below a dollar a paid referral stops covering support, refunds and the
 * chargeback reserve the hold exists to fund, and the program should be re-priced rather than run.
 */
const MIN_RETAINED_CENTS = 100

describe('the rate table', () => {
  it('pays the recorded rates — GOLDEN, re-derive rather than edit', () => {
    // These are the numbers the game says out loud, on the invite card and in the share sheet.
    // They are also written into `public.referral_cash_rate_cents()` in migration 0026; if this
    // test is updated without that function, the game promises one figure and the ledger pays
    // another — which is the worst bug this feature can have, because the number is money and the
    // player is reading it.
    expect(cashRateCents(0)).toBe(169)
    expect(cashRateCents(1)).toBe(69)
    expect(cashRateCents(2)).toBe(0)
  })

  it('ends in nothing, so "in-game rewards only" is true at EVERY depth below the ladder', () => {
    // The whole promise of the third tier is that the cash stops. A table whose last entry were
    // non-zero would silently pay every depth from there down, forever.
    expect(CASH_BY_DEPTH[CASH_BY_DEPTH.length - 1]).toBe(0)
    for (const depth of [3, 4, 7, 12, 100, 1e6]) expect(cashRateCents(depth)).toBe(0)
  })

  it('never pays a deeper referrer more than a shallower one', () => {
    // Not cosmetic: an inverted step would make it profitable to acquire a deeper position in the
    // chain, which is precisely the incentive a referral program must not create.
    for (let d = 1; d < CASH_BY_DEPTH.length; d++) {
      expect(cashRateCents(d)).toBeLessThanOrEqual(cashRateCents(d - 1))
    }
  })

  it('clamps junk depths to zero rather than paying on a NaN', () => {
    for (const bad of [-1, -99, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(cashRateCents(bad)).toBe(0)
    }
    // A fractional depth cannot occur (the SQL returns an int) but must not index between rungs.
    expect(cashRateCents(1.9)).toBe(cashRateCents(1))
  })

  it('agrees with earnsCash about who is on the cash ladder', () => {
    expect(earnsCash(0)).toBe(true)
    expect(earnsCash(1)).toBe(true)
    expect(earnsCash(2)).toBe(false)
    expect(earnsCash(9)).toBe(false)
  })
})

describe('solvency', () => {
  it('keeps the house whole on EVERY single transaction', () => {
    // The load-bearing assertion in this file. Checked per-depth rather than on the maximum alone,
    // so a table that grew a new rung is covered without anyone remembering to extend the test.
    for (let depth = 0; depth < CASH_BY_DEPTH.length + 4; depth++) {
      const retained = NET_PER_ENTRY - cashRateCents(depth)
      expect(retained).toBeGreaterThanOrEqual(MIN_RETAINED_CENTS)
    }
  })

  it('leaves the recorded margins — GOLDEN', () => {
    // $3.99 in · 42c to Stripe · the commission · the rest is ours.
    expect(processorFeeCents(ENTRY_PRICE_CENTS)).toBe(42)
    expect(NET_PER_ENTRY - cashRateCents(0)).toBe(188) // referred by an organic player
    expect(NET_PER_ENTRY - cashRateCents(1)).toBe(288) // referred by a referred player
    expect(NET_PER_ENTRY - cashRateCents(2)).toBe(357) // organic, or deeper than the ladder
  })

  it('never lets one entry fee pay out more than it took in', () => {
    // A restatement of the one-commission-per-fee rule from the far side. If a future change ever
    // makes this fail, the mistake is almost certainly a SECOND payout rung stacked on one sale —
    // which is the shape this program deliberately is not.
    const worst = Math.max(...CASH_BY_DEPTH)
    expect(worst + processorFeeCents(ENTRY_PRICE_CENTS)).toBeLessThan(ENTRY_PRICE_CENTS)
  })
})

describe('payout policy', () => {
  it('holds commissions across a realistic chargeback window', () => {
    // Card disputes routinely arrive weeks after the charge. A hold shorter than a month would pay
    // the referrer before the money is safely ours; the reversal path exists for what slips past.
    expect(HOLD_DAYS).toBeGreaterThanOrEqual(30)
  })

  it('does not send a referrer through bank-details KYC for pocket change', () => {
    // The minimum must at least exceed the largest single commission, or a player could complete a
    // full identity + bank verification to withdraw one referral's worth.
    expect(MIN_PAYOUT_CENTS).toBeGreaterThan(Math.max(...CASH_BY_DEPTH))
  })
})

describe('formatUsd', () => {
  it('renders the rates the way the UI states them', () => {
    expect(formatUsd(399)).toBe('$3.99')
    expect(formatUsd(169)).toBe('$1.69')
    expect(formatUsd(69)).toBe('$0.69')
  })

  it('pads the cents so a round figure never reads as a rate', () => {
    // "$10.5" would be read as ten dollars fifty by nobody and as an error by everyone.
    expect(formatUsd(1000)).toBe('$10.00')
    expect(formatUsd(1050)).toBe('$10.50')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('survives junk rather than printing NaN at a player', () => {
    expect(formatUsd(Number.NaN)).toBe('$0.00')
    expect(formatUsd(-169)).toBe('-$1.69')
  })
})

import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudSession, isCloudConfigured, sbClient } from './cloud'

/**
 * CASH referral commissions — the money half of the referral program.
 *
 * core/referrals.ts keeps the IN-GAME half (chips, hearts, the qualify latch) and is untouched by
 * this module: every referrer still earns REFERRER_CHIPS + a lives refill for every friend who
 * reaches the qualify level, at every depth, exactly as before. This adds a cash commission ON TOP,
 * for the first two rungs of the chain only.
 *
 * ---------------------------------------------------------------------------- the model
 * A player's DEPTH is how far down the invite chain they sit:
 *   depth 0 — arrived organically (no `referrals` row naming them as referee)
 *   depth 1 — joined through a depth-0 player's link
 *   depth 2 — joined through a depth-1 player's link, and so on
 *
 * When a new player pays the entry fee, ONE cash commission is written, to their DIRECT referrer,
 * at a rate set by that referrer's OWN depth (CASH_BY_DEPTH below).
 *
 * ⚠️ ONE ENTRY FEE PAYS AT MOST ONE PERSON, and that must never change. It is the property that
 * keeps the house solvent on every individual transaction rather than on average: the largest
 * commission plus the processor's cut is 211c of a 399c fee, so no mix of referral depths and no
 * growth rate can put the program underwater. A second payout rung stacked on the same fee would
 * break that, and `referralcash.test.ts` fails if anyone tries — it asserts the invariant against
 * these constants, so a retune that walks out of the safe band fails the suite instead of the bank
 * account. (Same posture as slots.rate / plinko.rate / endless.pace: an economy guard, not a unit
 * test. Re-derive the numbers, never edit them to make green.)
 *
 * ---------------------------------------------------------------------------- what is NOT here
 * Nothing in this module can move a cent. It reads a summary and asks the server to start a
 * payout; the ledger, the hold, the rate that actually gets paid and the payout itself all live
 * server-side (supabase/migrations/0025 + supabase/functions/), because `referral_earnings` has no
 * INSERT/UPDATE policy for any client role. That is deliberate and is the one place this feature
 * departs from the rest of the game's trust model: scores are self-reported, money is not.
 *
 * Design contract (mirrors core/referrals.ts exactly):
 *   - DORMANT until configured + signed in: every export no-ops / returns null when VITE_SUPABASE_*
 *     is absent or the player is signed out. Nothing here may ever throw into the game.
 */

// ---------------------------------------------------------------------------- the numbers
/** What a new account pays, once, to play at all. Set server-side too — this copy is for DISPLAY. */
export const ENTRY_PRICE_CENTS = 399

/**
 * Cash paid to a referrer per paid referral, indexed by the REFERRER's own chain depth.
 *
 * ⚠️ THE SAME TABLE AS `public.referral_cash_rate_cents()` in migration 0025. Change one, change
 * both. This copy only ever DISPLAYS a rate; the SQL copy is what actually writes the ledger row.
 * If they drift, the game promises a player one dollar figure and pays another — the single most
 * damaging bug this feature can have, because the number is money and the player is reading it.
 *
 * Depths past the end of the table earn nothing in cash (in-game rewards only) — see `cashRateCents`.
 */
export const CASH_BY_DEPTH: readonly number[] = [169, 69, 0]

/**
 * Stripe's cut of one entry fee: 2.9% + 30c, rounded up to the cent as Stripe does.
 *
 * Here only so the solvency invariant can be asserted against a real number rather than a vibe.
 * Nothing pays this — Stripe deducts it before settlement.
 */
export function processorFeeCents(amountCents: number): number {
  return Math.ceil(amountCents * 0.029) + 30
}

/** How long a commission is held before it can be withdrawn — the chargeback window. Server-enforced. */
export const HOLD_DAYS = 30

/**
 * Smallest balance that may be withdrawn. Not a Stripe limit (a transfer can be any amount) — it
 * exists so the payout function isn't wiring 69c at a time, and so a referrer with one referral
 * doesn't complete a bank-details KYC flow to move less than a dollar.
 */
export const MIN_PAYOUT_CENTS = 1000

/**
 * The cash rate for a referrer at `depth`. Clamps past the end of the table to 0 rather than
 * returning undefined: a chain deeper than the table is the "in-game rewards only" case, and it is
 * also what a corrupted / unexpectedly-deep read must degrade to. Never negative, never NaN.
 */
export function cashRateCents(depth: number): number {
  if (!Number.isFinite(depth) || depth < 0) return 0
  const at = Math.min(Math.floor(depth), CASH_BY_DEPTH.length - 1)
  return CASH_BY_DEPTH[at] ?? 0
}

/** True when a referrer at this depth earns real money (vs. chips and hearts only). */
export function earnsCash(depth: number): boolean {
  return cashRateCents(depth) > 0
}

/** `169` → `"$1.69"`. The one place cents become a player-facing string, so rounding can't diverge. */
export function formatUsd(cents: number): string {
  const n = Number.isFinite(cents) ? Math.round(cents) : 0
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------- cloud surface
// Lazy + optional, exactly like core/referrals.ts: cloud.ts owns the singleton client.
async function client(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured() || !cloudSession()) return null
  return sbClient()
}

/** What the cash-out panel renders. All amounts in cents. */
export interface CashSummary {
  /** This player's own rate per paid referral (0 = in-game rewards only). */
  rateCents: number
  /** This player's chain depth — 0 organic, 1 referred, 2+ deeper. */
  depth: number
  /** Earned but still inside the hold window. */
  pendingCents: number
  /** Past the hold and not yet paid out — what CASH OUT would move. */
  availableCents: number
  /** Lifetime paid out. */
  paidCents: number
  /** Commissions written (reversed ones excluded). */
  referralCount: number
  /** Stripe has cleared this player's payout account (identity + bank details). */
  payoutsEnabled: boolean
}

/**
 * Read this player's cash position — ONE round trip (`my_cash_summary`, migration 0025), so the
 * panel can never render a rate from one instant against balances from another. Null when dormant /
 * signed out / offline; the panel then shows its signed-out state rather than a zeroed one, because
 * "you have earned $0.00" and "we could not ask" must not look the same.
 */
export async function fetchCashSummary(): Promise<CashSummary | null> {
  try {
    const c = await client()
    if (!c) return null
    const { data, error } = await c.rpc('my_cash_summary')
    if (error || !data) return null
    // PostgREST returns a single-row TABLE function as an array of one.
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
    if (!row) return null
    const int = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v)
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0
    }
    return {
      rateCents: int(row.rate_cents),
      depth: int(row.depth),
      pendingCents: int(row.pending_cents),
      availableCents: int(row.available_cents),
      paidCents: int(row.paid_cents),
      referralCount: int(row.referral_count),
      payoutsEnabled: row.payouts_enabled === true,
    }
  } catch {
    return null
  }
}

/** What a cash-out attempt did, for the panel's feedback line. */
export type PayoutOutcome =
  | { ok: true; amountCents: number }
  /** Stripe needs identity/bank details first — `url` opens Connect onboarding. */
  | { ok: false; reason: 'onboarding'; url: string }
  | { ok: false; reason: 'below_minimum' | 'nothing_available' | 'unavailable' }

/**
 * Ask the server to pay out everything available.
 *
 * The client sends NO amount — the payout function recomputes the balance from the ledger under the
 * hold rule and transfers that. A client-supplied figure would be a number the server had to trust,
 * which is exactly what this whole subsystem exists not to do.
 *
 * Returns 'onboarding' with a Stripe-hosted URL when the player has no verified payout account yet;
 * the panel sends them there and they come back to try again.
 */
export async function requestPayout(): Promise<PayoutOutcome> {
  try {
    const c = await client()
    if (!c) return { ok: false, reason: 'unavailable' }
    const { data, error } = await c.functions.invoke('payout', { body: {} })
    if (error || !data || typeof data !== 'object') return { ok: false, reason: 'unavailable' }
    const res = data as Record<string, unknown>
    if (res.ok === true) return { ok: true, amountCents: Number(res.amount_cents) || 0 }
    const reason = String(res.reason ?? '')
    if (reason === 'onboarding' && typeof res.url === 'string') {
      return { ok: false, reason: 'onboarding', url: res.url }
    }
    if (reason === 'below_minimum' || reason === 'nothing_available') return { ok: false, reason }
    return { ok: false, reason: 'unavailable' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * Get a Stripe Connect onboarding link (identity + bank details) for this player, or null when
 * dormant / offline. The link is single-use and short-lived, so it is fetched at tap time and never
 * cached. Navigation is the caller's job — this only mints the URL.
 */
export async function fetchOnboardingUrl(): Promise<string | null> {
  try {
    const c = await client()
    if (!c) return null
    const { data, error } = await c.functions.invoke('connect-onboard', {
      body: { return_url: window.location.href.split('#')[0] },
    })
    if (error || !data || typeof data !== 'object') return null
    const url = (data as Record<string, unknown>).url
    return typeof url === 'string' && url.startsWith('https://') ? url : null
  } catch {
    return null
  }
}

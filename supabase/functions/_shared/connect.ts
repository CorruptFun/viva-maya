// ============================================================================
// Stripe Connect (Express) helpers — shared by connect-onboard and payout.
//
// Shared rather than duplicated because BOTH functions need to be able to send
// a referrer into onboarding: `connect-onboard` because that is its whole job,
// and `payout` because "cash out" on an unverified account has to lead
// somewhere useful rather than dead-ending on an error the player can't act on.
// Two copies of the account-creation rule would eventually create two Stripe
// accounts for one player, and only one of them would ever get paid.
// ============================================================================

import { Stripe, type SupabaseClient } from './deps.ts'

/**
 * The player's Stripe Connect account id, creating one if this is their first time.
 *
 * `payout_accounts.user_id` is the primary key and `stripe_account_id` is UNIQUE, so the read
 * before the create is what stops a double-tap minting two Stripe accounts. A race that slips
 * through is caught by the insert, and we then re-read and use the row that won — an orphaned
 * Stripe account is untidy but harmless, whereas TWO rows for one player would split their
 * balance across accounts.
 *
 * `capabilities.transfers` is the only capability requested: this platform sends money to
 * referrers and never lets them charge anyone. Asking for card_payments would put every referrer
 * through a merchant onboarding they have no use for.
 */
export async function ensureAccount(
  db: SupabaseClient,
  stripe: Stripe,
  userId: string
): Promise<string | null> {
  const existing = await db
    .from('payout_accounts')
    .select('stripe_account_id')
    .eq('user_id', userId)
    .maybeSingle()
  const found = (existing.data as { stripe_account_id: string } | null)?.stripe_account_id
  if (typeof found === 'string') return found
  if (existing.error) return null // transient read failure — don't blind-create a second account

  const account = await stripe.accounts.create({
    type: 'express',
    capabilities: { transfers: { requested: true } },
    metadata: { user_id: userId },
  })

  const ins = await db.from('payout_accounts').insert({
    user_id: userId,
    stripe_account_id: account.id,
    payouts_enabled: account.payouts_enabled === true,
    details_submitted: account.details_submitted === true,
    country: account.country ?? null,
  })
  if (ins.error) {
    // Raced (23505 on either key). Whoever won holds the account we should be using.
    const raced = await db
      .from('payout_accounts')
      .select('stripe_account_id')
      .eq('user_id', userId)
      .maybeSingle()
    return (raced.data as { stripe_account_id: string } | null)?.stripe_account_id ?? null
  }
  return account.id
}

/**
 * A single-use, short-lived onboarding link (identity + bank details).
 *
 * Minted at tap time and never cached — Stripe expires these in minutes, and a stored one is a
 * link that reliably fails by the time anybody clicks it. `refresh_url` is where Stripe sends a
 * player whose link died mid-flow; pointing it back at the game means they land somewhere that
 * can mint them a fresh one rather than at a Stripe error page.
 */
export async function onboardingUrl(
  stripe: Stripe,
  accountId: string,
  returnUrl: string
): Promise<string> {
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: returnUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  })
  return link.url
}

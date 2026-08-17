// ============================================================================
// stripe-webhook — the ONLY thing that grants an entitlement or writes a
// commission. Everything else in this feature reads.
//
// ⚠️ DEPLOY WITHOUT JWT VERIFICATION:
//   supabase functions deploy stripe-webhook --no-verify-jwt
// Stripe cannot send a Supabase JWT. The signature header is what authenticates
// this endpoint, and it is verified below BEFORE the body is looked at — an
// unverified webhook endpoint is an anonymous "give me the game for free" API.
//
// Point Stripe at it and set the signing secret:
//   https://<project>.functions.supabase.co/stripe-webhook
//   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
// Events to subscribe: checkout.session.completed · charge.refunded ·
// charge.dispute.created · account.updated · transfer.reversed
//
// ---------------------------------------------------------------------------
// IDEMPOTENCY. Stripe retries a webhook until it gets a 2xx, and will happily
// deliver the same event twice on its own. Nothing here counts on being run
// once. Both writes are guarded by a UNIQUE constraint rather than by a
// "have I seen this event" table:
//   · entitlements.stripe_payment_intent — one entitlement per charge
//   · referral_earnings.referee_user_id  — one commission per referred account, EVER
// A duplicate insert comes back 23505 and is a SUCCESS here, not an error.
//
// ⚠️ The two writes are attempted INDEPENDENTLY, and that is deliberate: an
// early return between them (e.g. "the entitlement already existed, so stop")
// would permanently lose the commission for any delivery whose first attempt
// died after the entitlement landed and before the ledger row did.
// ============================================================================

import {
  CURRENCY,
  ENTRY_PRICE_CENTS,
  HOLD_DAYS,
  Stripe,
  env,
  json,
  serviceClient,
  stripeClient,
  type SupabaseClient,
} from '../_shared/deps.ts'

/** A duplicate-key rejection — the expected, benign outcome of a replayed delivery. */
function isDuplicate(error: { code?: string } | null): boolean {
  return error?.code === '23505'
}

/**
 * Write the commission owed for a player who has just paid.
 *
 * Silence is a legitimate outcome in three cases and none of them is an error: the payer was never
 * referred, their referrer sits at depth 2 or deeper (in-game rewards only — no ledger row is
 * written at all, which is what "cash stops here" means physically), or the row already exists.
 */
async function writeCommission(
  db: SupabaseClient,
  refereeId: string,
  paymentIntentId: string
): Promise<void> {
  const ref = await db
    .from('referrals')
    .select('referrer_user_id')
    .eq('referee_user_id', refereeId)
    .maybeSingle()
  const referrerId = (ref.data as { referrer_user_id: string } | null)?.referrer_user_id
  if (typeof referrerId !== 'string' || referrerId === refereeId) return

  // ⚠️ The rate is read from the DATABASE, never computed here. `referral_cash_rate_cents` is the
  // one definition of what a depth is worth (migration 0025); a second copy in this file would be
  // a second thing to keep in step with the client's display copy, and the failure mode of that
  // drift is paying a player a different number from the one the game showed them.
  const rateRes = await db.rpc('referral_cash_rate_cents', { p_user: referrerId })
  const cents = typeof rateRes.data === 'number' ? rateRes.data : 0
  if (rateRes.error || cents <= 0) return

  const depthRes = await db.rpc('referral_depth', { p_user: referrerId })
  const depth = typeof depthRes.data === 'number' ? depthRes.data : 0

  const availableAt = new Date(Date.now() + HOLD_DAYS * 86_400_000).toISOString()
  const ins = await db.from('referral_earnings').insert({
    referrer_user_id: referrerId,
    referee_user_id: refereeId,
    tier: depth,
    amount_cents: cents,
    status: 'pending',
    stripe_payment_intent: paymentIntentId,
    available_at: availableAt,
  })
  if (ins.error && !isDuplicate(ins.error)) {
    // Throw so the handler returns non-2xx and Stripe retries. Losing a commission silently is the
    // one failure here a player would experience as us simply not paying them.
    throw new Error(`commission insert failed: ${ins.error.message}`)
  }
}

/**
 * Attach the Checkout email to the paying account, but ONLY when that account has none.
 *
 * ⚠️ THE "ONLY WHEN EMPTY" TEST IS THE WHOLE FUNCTION, and getting it wrong is destructive rather
 * than merely untidy. Paid entry requires a real sign-in before the price, so by the time a payment
 * lands the account almost always HAS a verified address — the one they signed in with. Stripe's
 * email is frequently a different one (a card receipt goes to a work address, a partner's address,
 * an old address autofilled by the browser). Writing it over the auth email would silently change
 * the address the player signs in with, and the first they would know of it is being unable to get
 * back into a game they had paid for.
 *
 * So this only ever fills a GAP. `entitlements.contact_email` records what Stripe collected in
 * every case, which is the support breadcrumb when the two differ and somebody writes in about a
 * receipt from an address we have never seen.
 *
 * ⚠️ BEST-EFFORT, AND NEVER FATAL. Throwing here would make Stripe retry a delivery whose real
 * work — the entitlement and the commission — has already landed, forever. A failed binding must
 * never cost somebody the game they just bought.
 */
async function bindEmail(db: SupabaseClient, userId: string, email: string | null): Promise<void> {
  if (!email) return
  try {
    const { data, error: readErr } = await db.auth.admin.getUserById(userId)
    // A read failure is a reason to do NOTHING, not a reason to guess. Proceeding blind here is
    // exactly how an existing sign-in address gets overwritten.
    if (readErr || !data.user) return
    if (data.user.email) return // already identified — never overwrite
    const { error } = await db.auth.admin.updateUserById(userId, { email, email_confirm: true })
    if (error) console.warn(`email binding skipped for ${userId}: ${error.message}`)
  } catch (e) {
    console.warn('email binding threw', e)
  }
}

/** Grant access + write the commission for a completed Checkout session. */
async function fulfil(
  db: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session
): Promise<void> {
  if (session.payment_status !== 'paid') return
  const userId =
    (typeof session.metadata?.user_id === 'string' ? session.metadata.user_id : '') ||
    session.client_reference_id
  if (!userId) return
  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
  if (!paymentIntentId) return

  // The card's fingerprint — Stripe's own opaque handle for "this same card", not a card number
  // and not PII. Held so that one instrument funding a ring of accounts is visible when a payout
  // is investigated. Best-effort: a fingerprint we couldn't read must not block a paid player.
  let fingerprint: string | null = null
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ['latest_charge.payment_method_details'],
    })
    const charge = pi.latest_charge as Stripe.Charge | null
    fingerprint = charge?.payment_method_details?.card?.fingerprint ?? null
  } catch {
    // leave null
  }

  // The address the payer typed into Checkout. This is the identity half of "pay first, identify
  // second": the player never fills in a sign-up form, so this is the only thing that can turn the
  // anonymous row carrying their purchase into an account they can get back on another phone.
  const email = session.customer_details?.email ?? session.customer_email ?? null

  const ins = await db.from('entitlements').insert({
    user_id: userId,
    status: 'paid',
    source: 'stripe',
    amount_cents: session.amount_total ?? ENTRY_PRICE_CENTS,
    currency: session.currency ?? CURRENCY,
    stripe_payment_intent: paymentIntentId,
    payment_fingerprint: fingerprint,
    contact_email: email,
  })
  if (ins.error && !isDuplicate(ins.error)) {
    throw new Error(`entitlement insert failed: ${ins.error.message}`)
  }

  await bindEmail(db, userId, email)

  // ⚠️ Runs whether or not the entitlement was fresh. See the idempotency note in the header.
  await writeCommission(db, userId, paymentIntentId)
}

/**
 * The money came back: revoke access and reverse the commission.
 *
 * A commission that has ALREADY been paid out is still flipped to 'reversed'. The cash is gone —
 * we cannot claw a Connect transfer back from a bank account — so what this records is a DEBT, not
 * a recovery. That is the point: `reversed_at` on a row with a `payout_id` is exactly the query
 * that finds referrers who have been paid for charges that later failed, which is how a farming
 * ring shows itself. Reversing only unpaid rows would make that population invisible.
 */
async function reverse(db: SupabaseClient, paymentIntentId: string, reason: string): Promise<void> {
  const now = new Date().toISOString()
  await db
    .from('entitlements')
    .update({ status: 'refunded', revoked_at: now })
    .eq('stripe_payment_intent', paymentIntentId)
  await db
    .from('referral_earnings')
    .update({ status: 'reversed', reversed_at: now, reversal_reason: reason })
    .eq('stripe_payment_intent', paymentIntentId)
    .neq('status', 'reversed')
}

/** Mirror Stripe's verdict on a Connect account — the flag the payout function gates on. */
async function syncAccount(db: SupabaseClient, account: Stripe.Account): Promise<void> {
  await db
    .from('payout_accounts')
    .update({
      payouts_enabled: account.payouts_enabled === true,
      details_submitted: account.details_submitted === true,
      country: account.country ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_account_id', account.id)
}

/**
 * A transfer was reversed after we recorded it as paid. Mark the payout failed and RELEASE its
 * earnings back to the available pool, so the referrer can withdraw again once whatever blocked it
 * is resolved. Rows already reversed for a chargeback are left alone — that money is not owed.
 */
async function releasePayout(db: SupabaseClient, transferId: string): Promise<void> {
  const p = await db
    .from('payouts')
    .update({ status: 'failed', failure_reason: 'transfer_reversed' })
    .eq('stripe_transfer_id', transferId)
    .select('id')
  const payoutId = (p.data as { id: string }[] | null)?.[0]?.id
  if (!payoutId) return
  await db
    .from('referral_earnings')
    .update({ status: 'available', payout_id: null })
    .eq('payout_id', payoutId)
    .neq('status', 'reversed')
}

Deno.serve(async (req: Request): Promise<Response> => {
  // ⚠️ Signature first, body second. `constructEventAsync` needs the RAW text — parsing the body
  // before verifying it (or re-serialising it) breaks the signature and, worse, means untrusted
  // JSON has already been handled.
  const signature = req.headers.get('stripe-signature')
  if (!signature) return new Response('missing signature', { status: 400 })

  const raw = await req.text()
  const stripe = stripeClient()
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      raw,
      signature,
      env('STRIPE_WEBHOOK_SECRET'),
      undefined,
      // Deno has no Node crypto — Stripe's SubtleCrypto provider is the supported path here.
      Stripe.createSubtleCryptoProvider()
    )
  } catch (e) {
    console.error('webhook signature rejected', e)
    return new Response('bad signature', { status: 400 })
  }

  const db = serviceClient()
  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await fulfil(db, stripe, event.data.object as Stripe.Checkout.Session)
        break
      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id
        if (pi) await reverse(db, pi, 'refund')
        break
      }
      case 'charge.dispute.created': {
        const dispute = event.data.object as Stripe.Dispute
        const pi = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id
        if (pi) await reverse(db, pi, 'dispute')
        break
      }
      case 'account.updated':
        await syncAccount(db, event.data.object as Stripe.Account)
        break
      case 'transfer.reversed':
        await releasePayout(db, (event.data.object as Stripe.Transfer).id)
        break
      default:
        // Subscribed to more than we handle is normal and harmless — acknowledge and move on,
        // rather than making Stripe retry an event nothing will ever do anything with.
        break
    }
  } catch (e) {
    // Non-2xx makes Stripe retry with backoff for ~3 days. Everything above is idempotent, so a
    // retry is always safe and is strictly better than swallowing a failed grant.
    console.error(`webhook handler failed for ${event.type}`, e)
    return new Response('handler failed', { status: 500 })
  }

  return json({ received: true })
})

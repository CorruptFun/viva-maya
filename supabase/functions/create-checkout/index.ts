// ============================================================================
// create-checkout — open a Stripe Checkout session for the $3.99 entry fee.
//
// Deploy WITH jwt verification (the default):
//   supabase functions deploy create-checkout
//
// Two things here are security controls rather than plumbing, and both exist
// because the browser is not trusted:
//   · THE PRICE IS SET HERE. The client sends no amount. An amount the browser
//     can name is an amount the browser can change.
//   · THE REFERRER IS RESOLVED HERE. The client sends at most an invite CODE,
//     which is a hint; the referrer it maps to is looked up server-side. A
//     client-named referrer would let anyone mint themselves a commission by
//     posting their own user id.
// ============================================================================

import {
  CURRENCY,
  ENTRY_PRICE_CENTS,
  callerId,
  json,
  preflight,
  readJson,
  safeReturnUrl,
  serviceClient,
  stripeClient,
  withFlag,
  type SupabaseClient,
} from '../_shared/deps.ts'

const CODE_RE = /^[A-Z0-9]{6}$/

/**
 * Who gets paid for this player, decided server-side.
 *
 * Prefers the `referrals` row, which is the program's source of truth and is normally already
 * there — the referee's own client writes it on the first save push after sign-in. The invite code
 * is the fallback for the gap that push leaves: a keen player can sign in and reach the PAY button
 * before any save has been persisted, and losing their inviter's commission to that race would be
 * a silent, unreportable bug for both of them.
 *
 * When it resolves from a code it also WRITES the row, so the in-game referral rewards
 * (core/referrals.ts — chips, hearts, the qualify latch) fire for the same pair. There is one
 * referral chain, not a cash one and a chips one.
 */
async function resolveReferrer(
  db: SupabaseClient,
  refereeId: string,
  rawCode: unknown
): Promise<string | null> {
  const existing = await db
    .from('referrals')
    .select('referrer_user_id')
    .eq('referee_user_id', refereeId)
    .maybeSingle()
  const found = (existing.data as { referrer_user_id: string } | null)?.referrer_user_id
  if (typeof found === 'string') return found

  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : ''
  if (!CODE_RE.test(code)) return null

  const owner = await db.from('referral_codes').select('user_id').eq('code', code).maybeSingle()
  const referrerId = (owner.data as { user_id: string } | null)?.user_id
  // Self-referral is blocked by 0004's check constraint too; refusing here as well means we never
  // even write the row, so the player isn't left with a referrals row naming themselves.
  if (typeof referrerId !== 'string' || referrerId === refereeId) return null

  // Best-effort: a duplicate (the client raced us) is fine — the PK holds and the row that won
  // names the same pair we just resolved.
  await db.from('referrals').insert({ referee_user_id: refereeId, referrer_user_id: referrerId })
  return referrerId
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const userId = await callerId(req)
    if (!userId) return json({ error: 'signed_out' }, 401)

    const db = serviceClient()

    // Never sell the same account the game twice. A 'refunded' row is the one status that may buy
    // again — that is a player who charged back (or was refunded) and has come back to pay properly.
    const ent = await db.from('entitlements').select('status').eq('user_id', userId).maybeSingle()
    const status = (ent.data as { status: string } | null)?.status
    if (status && status !== 'refunded') return json({ already: true })

    const body = await readJson(req)
    // ⚠️ Allowlisted, not trusted. See safeReturnUrl — an unchecked success_url is an open redirect
    // an attacker can drive from a phishing page.
    const returnUrl = safeReturnUrl(body.return_url)
    const referrerId = await resolveReferrer(db, userId, body.ref)

    const stripe = stripeClient()
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: CURRENCY,
              unit_amount: ENTRY_PRICE_CENTS,
              product_data: {
                name: 'Viva Maya — full game',
                description: 'One-time entry. Every level, the daily race, the slots and the storm.',
              },
            },
          },
        ],
        success_url: withFlag(returnUrl, 'paid', '1'),
        cancel_url: withFlag(returnUrl, 'cancelled', '1'),
        client_reference_id: userId,
        // Carried on BOTH the session and the payment intent. The webhook reads the session on
        // `checkout.session.completed`; the payment-intent copy is what makes a charge traceable
        // back to an account from the Stripe dashboard during a support or dispute investigation,
        // where the session is several clicks away.
        metadata: { user_id: userId, referrer_user_id: referrerId ?? '' },
        payment_intent_data: {
          metadata: { user_id: userId, referrer_user_id: referrerId ?? '' },
        },
      },
      // Keyed to the account, so a double-tapped PAY button reuses one session instead of opening
      // two. Deliberately NOT keyed to the account alone forever — the date suffix lets a player who
      // abandoned checkout yesterday start a fresh one today rather than being handed a dead link.
      { idempotencyKey: `entry:${userId}:${new Date().toISOString().slice(0, 10)}` }
    )

    if (!session.url) return json({ error: 'no_session_url' }, 502)
    return json({ url: session.url })
  } catch (e) {
    // Never leak a secret or a Stripe internal into a response a browser will read.
    console.error('create-checkout failed', e)
    return json({ error: 'unavailable' }, 500)
  }
})

// ============================================================================
// payout — pay a referrer everything their ledger says is available.
//
// Deploy WITH jwt verification (the default):
//   supabase functions deploy payout
//
// ⚠️ THE CLIENT SENDS NO AMOUNT, and there is no parameter here it could send
// one in. The figure is recomputed from `referral_earnings` under the hold rule
// every time. A client-supplied amount would be a number the server had to
// trust, which is the one thing this whole subsystem exists not to do.
//
// ---------------------------------------------------------------------------
// THE ORDER OF OPERATIONS IS THE DESIGN. Money leaving is the one action here
// that cannot be undone by a retry, so the ledger is CLAIMED before the
// transfer and only marked PAID after it:
//
//   1. claim   — stamp payout_id on every eligible row, WHERE payout_id IS NULL.
//                Atomic: a concurrent second invocation matches zero rows and
//                pays nothing, so a double-tapped CASH OUT cannot double-pay.
//   2. transfer — Stripe, with the payout id as the idempotency key. A retried
//                invocation with the same key returns the ORIGINAL transfer
//                instead of creating a second one, so even a lost response
//                cannot move the money twice.
//   3. settle   — mark the claimed rows 'paid'.
//   3'. release — on failure, clear payout_id so the balance becomes withdrawable
//                again. Without this a failed transfer would strand a referrer's
//                money in a claimed-but-never-paid limbo with no way out.
//
// The window between 1 and 3 is the only risk left: a crash there leaves rows
// claimed by a payout that says 'pending'. That is recoverable by hand and is
// visible (`select * from payouts where status='pending'`), which is the right
// trade — the alternative ordering loses money instead of stranding it.
// ============================================================================

import {
  CURRENCY,
  MIN_PAYOUT_CENTS,
  callerId,
  json,
  preflight,
  readJson,
  safeReturnUrl,
  serviceClient,
  stripeClient,
} from '../_shared/deps.ts'
import { ensureAccount, onboardingUrl } from '../_shared/connect.ts'

interface EarningRow {
  amount_cents: number
}

function sum(rows: EarningRow[] | null): number {
  return (rows ?? []).reduce((n, r) => n + (Number(r.amount_cents) || 0), 0)
}

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const userId = await callerId(req)
    if (!userId) return json({ error: 'signed_out' }, 401)

    const db = serviceClient()
    const stripe = stripeClient()
    const nowIso = new Date().toISOString()

    // --- can this player receive money at all? ------------------------------
    const acct = await db
      .from('payout_accounts')
      .select('stripe_account_id, payouts_enabled')
      .eq('user_id', userId)
      .maybeSingle()
    const row = acct.data as { stripe_account_id: string; payouts_enabled: boolean } | null

    if (!row || !row.payouts_enabled) {
      // Not an error — a step. Hand back a live onboarding link so "cash out" leads somewhere the
      // player can act on rather than dead-ending on a refusal they can do nothing about.
      const returnUrl = safeReturnUrl((await readJson(req)).return_url)
      const accountId = row?.stripe_account_id ?? (await ensureAccount(db, stripe, userId))
      if (!accountId) return json({ ok: false, reason: 'unavailable' })
      return json({ ok: false, reason: 'onboarding', url: await onboardingUrl(stripe, accountId, returnUrl) })
    }

    // --- what is actually withdrawable? -------------------------------------
    // Read first so a balance below the minimum never creates a junk payout row it then has to
    // clean up. `available_at <= now` IS the hold — nothing else enforces it, and nothing a client
    // can call moves that date.
    const preview = await db
      .from('referral_earnings')
      .select('amount_cents')
      .eq('referrer_user_id', userId)
      .in('status', ['pending', 'available'])
      .lte('available_at', nowIso)
      .is('payout_id', null)
    if (preview.error) return json({ ok: false, reason: 'unavailable' })

    const previewCents = sum(preview.data as EarningRow[] | null)
    if (previewCents <= 0) return json({ ok: false, reason: 'nothing_available' })
    if (previewCents < MIN_PAYOUT_CENTS) {
      return json({ ok: false, reason: 'below_minimum', minimum_cents: MIN_PAYOUT_CENTS })
    }

    // --- 1. claim -----------------------------------------------------------
    const payoutId = crypto.randomUUID()
    const created = await db.from('payouts').insert({
      id: payoutId,
      user_id: userId,
      amount_cents: previewCents,
      status: 'pending',
      idempotency_key: payoutId,
    })
    if (created.error) return json({ ok: false, reason: 'unavailable' })

    const claim = await db
      .from('referral_earnings')
      .update({ payout_id: payoutId })
      .eq('referrer_user_id', userId)
      .in('status', ['pending', 'available'])
      .lte('available_at', nowIso)
      .is('payout_id', null)
      .select('amount_cents')
    const claimedCents = sum(claim.data as EarningRow[] | null)

    if (claim.error || claimedCents <= 0) {
      // Raced by a concurrent cash-out that claimed everything first. Drop our empty payout row —
      // an amount_cents of 0 would violate the table's own check constraint anyway.
      await db.from('payouts').delete().eq('id', payoutId)
      return json({ ok: false, reason: 'nothing_available' })
    }
    if (claimedCents !== previewCents) {
      // A row matured or was reversed between the preview and the claim. The CLAIM is the truth —
      // it is what we hold — so correct the payout row to it before sending money.
      await db.from('payouts').update({ amount_cents: claimedCents }).eq('id', payoutId)
    }

    // --- 2. transfer --------------------------------------------------------
    try {
      const transfer = await stripe.transfers.create(
        {
          amount: claimedCents,
          currency: CURRENCY,
          destination: row.stripe_account_id,
          metadata: { user_id: userId, payout_id: payoutId },
        },
        { idempotencyKey: payoutId }
      )

      // --- 3. settle --------------------------------------------------------
      await db
        .from('payouts')
        .update({ status: 'paid', stripe_transfer_id: transfer.id, settled_at: new Date().toISOString() })
        .eq('id', payoutId)
      await db.from('referral_earnings').update({ status: 'paid' }).eq('payout_id', payoutId)

      return json({ ok: true, amount_cents: claimedCents })
    } catch (e) {
      // --- 3'. release ------------------------------------------------------
      console.error('transfer failed', e)
      await db
        .from('payouts')
        .update({ status: 'failed', failure_reason: 'transfer_failed' })
        .eq('id', payoutId)
      await db
        .from('referral_earnings')
        .update({ payout_id: null, status: 'available' })
        .eq('payout_id', payoutId)
        .neq('status', 'reversed')
      return json({ ok: false, reason: 'unavailable' })
    }
  } catch (e) {
    console.error('payout failed', e)
    return json({ ok: false, reason: 'unavailable' }, 500)
  }
})

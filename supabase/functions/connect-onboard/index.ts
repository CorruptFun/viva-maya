// ============================================================================
// connect-onboard — mint a Stripe Connect onboarding link so a referrer can be
// paid their cash commissions.
//
// Deploy WITH jwt verification (the default):
//   supabase functions deploy connect-onboard
//
// This is where the referrer gives Stripe their identity and bank details.
// WE NEVER SEE ANY OF IT: the flow is hosted by Stripe end to end, and all this
// project ever stores is an account id and Stripe's own boolean verdict on
// whether that account may receive money. Keeping bank details out of this
// database is not a nicety — it is the difference between a game's Postgres
// instance being a nuisance to leak and being a catastrophe to leak.
//
// Tax reporting (1099-NEC at the US $600/yr threshold) rides on the same
// Express accounts. Enable it on the Stripe platform; nothing in this repo
// needs to know about it, which is exactly why it should be done there.
// ============================================================================

import {
  callerId,
  json,
  preflight,
  readJson,
  safeReturnUrl,
  serviceClient,
  stripeClient,
} from '../_shared/deps.ts'
import { ensureAccount, onboardingUrl } from '../_shared/connect.ts'

Deno.serve(async (req: Request): Promise<Response> => {
  const pre = preflight(req)
  if (pre) return pre

  try {
    const userId = await callerId(req)
    if (!userId) return json({ error: 'signed_out' }, 401)

    const db = serviceClient()
    const stripe = stripeClient()

    const accountId = await ensureAccount(db, stripe, userId)
    if (!accountId) return json({ error: 'unavailable' }, 503)

    // Allowlisted like every other caller-supplied return URL — see safeReturnUrl.
    const returnUrl = safeReturnUrl((await readJson(req)).return_url)
    return json({ url: await onboardingUrl(stripe, accountId, returnUrl) })
  } catch (e) {
    console.error('connect-onboard failed', e)
    return json({ error: 'unavailable' }, 500)
  }
})

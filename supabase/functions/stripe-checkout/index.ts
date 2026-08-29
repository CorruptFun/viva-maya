// stripe-checkout — mints a Stripe Checkout Session for the $1.33 one-time lifetime unlock and
// hands the client the hosted URL to redirect to. Never touches the entitlements tables itself;
// granting happens on the way back (stripe-webhook, or entitlement-status on the return trip),
// once Stripe has actually confirmed payment. See supabase/migrations/0029_paid_entry.sql.
import Stripe from 'npm:stripe@17'
import { corsHeaders } from '../_shared/cors.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' })

// The one price this whole function exists to sell. Not a Stripe Dashboard product — built inline
// with price_data so standing this up needs no manual product/price setup, only the two secrets
// (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET) named in docs/PAID_ENTRY_STRIPE.md.
const PRICE_CENTS = 133
const DEFAULT_RETURN = 'https://corrupt.solutions/games/viva-maya/'

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get('origin'))
  if (req.method === 'OPTIONS') return new Response(null, { headers })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers })

  try {
    const { deviceId, returnUrl } = await req.json()
    if (typeof deviceId !== 'string' || deviceId.length < 8) {
      return new Response(JSON.stringify({ error: 'invalid deviceId' }), { status: 400, headers: { ...headers, 'Content-Type': 'application/json' } })
    }
    const base = typeof returnUrl === 'string' && returnUrl.startsWith('http') ? returnUrl : DEFAULT_RETURN
    // {CHECKOUT_SESSION_ID} is a literal Stripe substitutes at redirect time — PaywallScene reads it
    // back as `entitlement_session` to verify the payment the instant the player lands, rather than
    // waiting on the webhook (which still runs, and is what makes the grant durable either way).
    const successUrl = `${base}${base.includes('?') ? '&' : '?'}entitlement_session={CHECKOUT_SESSION_ID}`

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: PRICE_CENTS,
            product_data: { name: 'Viva Maya — Lifetime Access' },
          },
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: base,
      // Read by the webhook + the direct-verify path to link this purchase back to the anonymous
      // device that started checkout, without ever putting the device id in a URL.
      metadata: { device_id: deviceId },
    })

    return new Response(JSON.stringify({ url: session.url }), { headers: { ...headers, 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('stripe-checkout error', err)
    return new Response(JSON.stringify({ error: 'checkout_failed' }), { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } })
  }
})

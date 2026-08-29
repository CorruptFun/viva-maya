// stripe-webhook — the DURABLE grant path. Stripe calls this server-to-server on
// `checkout.session.completed`; it verifies the signature and writes the entitlement. This is what
// makes a purchase stick even if the player closes the tab before the redirect back ever loads (so
// entitlement-status's direct-verify-on-return path never has to be the only way a sale is recorded).
//
// No CORS here on purpose — Stripe is the only caller, and a browser has no business calling this
// endpoint (it carries no deviceId to attribute to; that lives in the Checkout Session metadata
// stripe-checkout set, which this handler reads back off the event itself).
import Stripe from 'npm:stripe@17'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' })
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!
// Deno's runtime doesn't provide Node's sync crypto Stripe's default verifier expects — the async
// constructor + SubtleCrypto provider is Stripe's own documented fix for Deno/edge runtimes.
const cryptoProvider = Stripe.createSubtleCryptoProvider()

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function grant(session: Stripe.Checkout.Session): Promise<void> {
  const email = session.customer_details?.email
  if (!email) return // Checkout in payment mode always collects one; nothing to attribute otherwise
  const deviceId = typeof session.metadata?.device_id === 'string' ? session.metadata.device_id : null

  // Upsert on the session id: the direct-verify path (entitlement-status, on the player's return
  // trip) may have already recorded this exact sale before this webhook fires. Same row, not a
  // second purchase.
  const { error: insertErr } = await admin.from('entitlements').upsert(
    {
      stripe_checkout_session_id: session.id,
      stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
      email,
      amount_cents: session.amount_total ?? 133,
      currency: session.currency ?? 'usd',
    },
    { onConflict: 'stripe_checkout_session_id' }
  )
  if (insertErr) throw insertErr

  if (deviceId) {
    const { error: linkErr } = await admin.from('entitlement_devices').upsert({ device_id: deviceId, email }, { onConflict: 'device_id' })
    if (linkErr) throw linkErr
  }
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')
  const body = await req.text()
  if (!signature) return new Response('missing signature', { status: 400 })

  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret, undefined, cryptoProvider)
  } catch (err) {
    console.error('stripe-webhook signature verification failed', err)
    return new Response('invalid signature', { status: 400 })
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    if (session.payment_status === 'paid') {
      try {
        await grant(session)
      } catch (err) {
        console.error('stripe-webhook grant failed', err)
        // Non-2xx tells Stripe to retry the delivery — the upsert above is safe to re-run.
        return new Response('grant failed', { status: 500 })
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } })
})

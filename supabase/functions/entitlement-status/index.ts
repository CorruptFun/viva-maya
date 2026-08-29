// entitlement-status — the one read path for "is this device unlocked", in three flavours:
//   { sessionId }          — fresh return from Stripe Checkout: verify directly with Stripe rather
//                             than waiting on stripe-webhook, so the player unlocks the instant they
//                             land back instead of racing an async delivery.
//   { deviceId }           — ordinary boot-time re-check (cache lost, or checking a device that
//                             never itself completed a checkout).
//   { email }              — "restore purchase": look up by the email used to pay, and link this
//                             device to it on a hit.
// Every branch reports only `{ entitled: boolean }` — never the email, customer id, or anything else
// in the entitlements row, so this endpoint can't be used to enumerate who paid.
import Stripe from 'npm:stripe@17'
import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' })
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

async function linkDevice(deviceId: string, email: string): Promise<void> {
  await admin.from('entitlement_devices').upsert({ device_id: deviceId, email }, { onConflict: 'device_id' })
}

async function hasPaidEmail(email: string): Promise<boolean> {
  const { data, error } = await admin.from('entitlements').select('id').ilike('email', email).limit(1)
  if (error) throw error
  return !!data && data.length > 0
}

Deno.serve(async (req) => {
  const headers = { ...corsHeaders(req.headers.get('origin')), 'Content-Type': 'application/json' }
  if (req.method === 'OPTIONS') return new Response(null, { headers })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers })

  try {
    const { deviceId, email, sessionId } = await req.json()
    const deviceOk = typeof deviceId === 'string' && deviceId.length >= 8

    if (typeof sessionId === 'string' && sessionId.length > 0) {
      const session = await stripe.checkout.sessions.retrieve(sessionId)
      if (session.payment_status !== 'paid') {
        return new Response(JSON.stringify({ entitled: false }), { headers })
      }
      const payerEmail = session.customer_details?.email
      if (payerEmail) {
        // Same upsert-on-session-id as the webhook — whichever of the two lands first wins, the
        // other is a no-op. See stripe-webhook/index.ts.
        await admin.from('entitlements').upsert(
          {
            stripe_checkout_session_id: session.id,
            stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
            email: payerEmail,
            amount_cents: session.amount_total ?? 133,
            currency: session.currency ?? 'usd',
          },
          { onConflict: 'stripe_checkout_session_id' }
        )
        const attributedDevice = typeof session.metadata?.device_id === 'string' ? session.metadata.device_id : deviceOk ? deviceId : null
        if (attributedDevice) await linkDevice(attributedDevice, payerEmail)
      }
      return new Response(JSON.stringify({ entitled: true }), { headers })
    }

    if (deviceOk) {
      const { data: linkRow } = await admin.from('entitlement_devices').select('email').eq('device_id', deviceId).maybeSingle()
      if (linkRow?.email && (await hasPaidEmail(linkRow.email))) {
        return new Response(JSON.stringify({ entitled: true }), { headers })
      }
    }

    if (typeof email === 'string' && email.includes('@')) {
      const paid = await hasPaidEmail(email)
      if (paid && deviceOk) await linkDevice(deviceId, email)
      return new Response(JSON.stringify({ entitled: paid }), { headers })
    }

    return new Response(JSON.stringify({ entitled: false }), { headers })
  } catch (err) {
    console.error('entitlement-status error', err)
    return new Response(JSON.stringify({ error: 'status_failed' }), { status: 500, headers })
  }
})

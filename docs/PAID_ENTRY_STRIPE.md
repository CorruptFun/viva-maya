# Paid Entry — Stripe Setup

This is the owner-facing checklist for turning on the **$1.33 one-time lifetime
unlock** in front of the whole game. See `core/paywall.ts`'s header for the
client-side trust model and `supabase/migrations/0029_paid_entry.sql`'s header
for the schema/RLS reasoning — this doc is just "how do I wire it up."

## What this does

- Gates the entire game behind a one-time Stripe Checkout payment
  (`PaywallScene`, routed to by `BootScene` instead of `'home'`).
- Once a device pays, it never sees the paywall again (`isEntitledLocally()`).
- **RESTORE PURCHASE** on the paywall screen recovers an existing purchase on a
  new device by the email used to pay.
- **Dormant if unconfigured**: with no `VITE_SUPABASE_URL`, `paywallConfigured()`
  is false and the game boots straight to Home, exactly as it did before this
  feature existed — a local/dev build is never blocked.

## The one thing to understand about safety

> **`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server secrets.** They
> live only as Supabase Edge Function secrets, set via the CLI or dashboard —
> **never** in `.env`, `src/config.ts`, or anywhere that ends up in the client
> bundle or a commit. The client never talks to Stripe directly; it only calls
> the three Edge Functions below.

The entitlement tables carry **no RLS policies at all** — every read/write goes
through the Edge Functions using the `service_role` key, which bypasses RLS.
That is deliberate (see the migration header), not a gap to "fix" with a policy.

## Step 1 — Apply the migration

From the repo root (see CLAUDE.md's Supabase section for the `--include-all`
warning):

```sh
supabase db push --dry-run --include-all
supabase db push --include-all
```

This creates `public.entitlements` and `public.entitlement_devices`.

## Step 2 — Set the Edge Function secrets

```sh
supabase secrets set STRIPE_SECRET_KEY=sk_live_...
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...   # from Step 4, below
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already provided
automatically to every Edge Function by the platform — nothing to set there.

> Start with a **test-mode** secret key (`sk_test_...`) and Stripe's test card
> `4242 4242 4242 4242` if you want to run the whole flow once before pointing
> this at real money. Swapping to `sk_live_...` later is the only change needed.

## Step 3 — Deploy the three functions

```sh
supabase functions deploy stripe-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
supabase functions deploy entitlement-status
```

`stripe-webhook` needs `--no-verify-jwt` — Stripe calls it directly with no
Supabase auth header; the function verifies the request itself via the Stripe
signature instead (`STRIPE_WEBHOOK_SECRET`).

## Step 4 — Register the webhook in Stripe

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
3. Events to send: `checkout.session.completed`.
4. Copy the **Signing secret** (`whsec_...`) it gives you back into Step 2.

## Step 5 — Verify

1. Load the game with no `?level=`/`?scene=` dev params — you should land on
   the paywall instead of Home.
2. Tap **UNLOCK — $1.33**, complete Checkout (test card in test mode).
3. You should land back in the game, past the paywall, permanently on this
   device.
4. Open the Stripe Dashboard → the payment should show as succeeded, and
   `public.entitlements` should have one new row (Table Editor, service role).
5. Clear the site's storage and reload — the paywall should reappear; tap
   **RESTORE PURCHASE** with the same email and confirm it unlocks again.

## Files

| path | role |
|---|---|
| `supabase/migrations/0029_paid_entry.sql` | `entitlements` + `entitlement_devices`, RLS-enabled with no policies |
| `supabase/functions/stripe-checkout/` | mints a Checkout Session for the $1.33 price |
| `supabase/functions/stripe-webhook/` | the durable grant path — verifies Stripe's signature, writes the entitlement |
| `supabase/functions/entitlement-status/` | the one read path: verify-on-return, boot-time re-check, restore-by-email |
| `src/core/paywall.ts` | client trust model — local cache, dormant-if-unconfigured, never throws |
| `src/scenes/PaywallScene.ts` | the gate screen itself |
| `src/scenes/BootScene.ts` | routes here instead of `'home'` when ungated |

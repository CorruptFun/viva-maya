// ============================================================================
// Shared layer for the paid-entry Edge Functions.
//
// ⚠️ EVERYTHING IN supabase/functions/ RUNS WITH THE SERVICE ROLE, which bypasses
// RLS. These four functions are the ONLY writers to `entitlements`,
// `referral_earnings`, `payout_accounts` and `payouts` — those tables
// deliberately have no INSERT/UPDATE/DELETE policy for `anon` or
// `authenticated` (migration 0025), so a client physically cannot mint itself
// an entitlement or a commission. Nothing here may ever be moved into the
// browser bundle, and no secret read here may ever be echoed into a response.
//
// This is the first `supabase/functions/` directory the repo has had. CLAUDE.md
// used to state there wasn't one — that note existed to debunk a document
// belonging to a DIFFERENT product (Viva Ton), not to forbid ever having one.
// It has been updated rather than worked around.
// ============================================================================

import Stripe from 'https://esm.sh/stripe@17.5.0?target=deno&deno-std=0.224.0'
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.47.10'

export { Stripe }
export type { SupabaseClient }

// ---------------------------------------------------------------------------- money
/**
 * What a new account pays, once, to play at all.
 *
 * ⚠️ Mirrored by `ENTRY_PRICE_CENTS` in src/core/referralcash.ts, but only THIS copy is
 * authoritative — the client's is for display. The browser never names a price: an amount the
 * client can send is an amount the client can change, and "the player asked for a 1c entry fee"
 * is not a class of bug worth being exposed to.
 */
export const ENTRY_PRICE_CENTS = 399
export const CURRENCY = 'usd'

/** Days a commission is held before it can be withdrawn — the chargeback window. */
export const HOLD_DAYS = 30

/** Smallest withdrawable balance. Mirrors MIN_PAYOUT_CENTS in src/core/referralcash.ts. */
export const MIN_PAYOUT_CENTS = 1000

/**
 * Where the game is allowed to send a player back to after Checkout or Connect onboarding.
 *
 * ⚠️ THIS LIST IS A SECURITY CONTROL, not configuration. `success_url` and Connect's `return_url`
 * are attacker-reachable: they arrive in a request body, and an unchecked one turns this function
 * into an open redirect that a phishing page can drive — "pay on Stripe, get bounced to a site
 * that looks like the game and asks for your Google password". Anything not matching an entry here
 * falls back to CANONICAL_ORIGIN rather than erroring, so a legitimate new origin is a broken
 * return trip rather than a broken purchase.
 *
 * The game answers on two origins (see the two-origins note in CLAUDE.md) and storage does not
 * cross between them, so a player must come back to the one they left from or they land signed out.
 */
export const ALLOWED_RETURN_PREFIXES = [
  'https://corrupt.solutions/games/viva-maya/',
  'https://corruptfun.github.io/viva-maya/',
  'http://localhost:5173/',
  'http://127.0.0.1:5173/',
]
export const CANONICAL_ORIGIN = 'https://corrupt.solutions/games/viva-maya/'

/**
 * Coerce a caller-supplied return URL to something safe: it must start with an allowed prefix, or
 * it is replaced by the canonical address. Query and hash are stripped — the caller's own params
 * have no business surviving into a URL we then decorate with `?paid=1`, and a fragment could
 * carry an origin-migration payload into a page that never asked for one.
 */
export function safeReturnUrl(raw: unknown): string {
  if (typeof raw !== 'string') return CANONICAL_ORIGIN
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return CANONICAL_ORIGIN
  }
  const clean = `${url.origin}${url.pathname}`
  return ALLOWED_RETURN_PREFIXES.some(p => clean.startsWith(p)) ? clean : CANONICAL_ORIGIN
}

/** Append a flag to a return URL without disturbing whatever path it carries. */
export function withFlag(returnUrl: string, key: string, value: string): string {
  const url = new URL(returnUrl)
  url.searchParams.set(key, value)
  return url.toString()
}

// ---------------------------------------------------------------------------- clients
/** Read a required secret, or throw. The message names the KEY, never the value. */
export function env(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing secret: ${name}`)
  return v
}

/**
 * The Stripe client. `apiVersion` is deliberately NOT pinned to a literal here — the SDK pins its
 * own default, which is the version it was tested against. Pinning a string by hand is how a
 * function ends up asking for an API shape its SDK cannot parse.
 */
export function stripeClient(): Stripe {
  return new Stripe(env('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
  })
}

/** A service-role Supabase client — bypasses RLS. Never hand this to anything caller-controlled. */
export function serviceClient(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

// ---------------------------------------------------------------------------- auth
/**
 * Resolve the caller from their `Authorization: Bearer <jwt>` header, or null.
 *
 * The platform already rejects an invalid JWT before the function runs (these three are deployed
 * WITH jwt verification; only the webhook opts out, because Stripe cannot send a Supabase token).
 * This re-reads it because the platform proves the token is valid, not WHO it belongs to, and every
 * row these functions touch is keyed by that identity.
 */
export async function callerId(req: Request): Promise<string | null> {
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!jwt) return null
    const { data, error } = await serviceClient().auth.getUser(jwt)
    if (error || !data.user) return null
    return data.user.id
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------- http
export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

/** Preflight, or null when this isn't one. */
export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: CORS_HEADERS }) : null
}

/**
 * Read a JSON body without letting a malformed one throw a 500 at a player mid-purchase.
 * Returns `{}` for anything unparseable — every caller treats missing fields as absent anyway.
 */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json()
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

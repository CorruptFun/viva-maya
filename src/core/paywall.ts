/**
 * PAID ENTRY — a $1.33 one-time lifetime unlock, gating the whole game behind Stripe Checkout.
 * Server side: supabase/migrations/0029_paid_entry.sql + the three Edge Functions under
 * supabase/functions/ (stripe-checkout, stripe-webhook, entitlement-status). Client side: this
 * module (pure, no Phaser) + scenes/PaywallScene.ts (presentation) + BootScene's routing gate.
 *
 * Design contract, matching core/cloud.ts / core/analytics.ts / core/push.ts:
 *   - DORMANT until configured. No VITE_SUPABASE_URL → `paywallConfigured()` is false and
 *     BootScene never routes to the paywall at all — a local-only / preview build plays exactly
 *     as before, same as cloud save and push.
 *   - NEVER THROWS into the game — every export catches and degrades to "not entitled" / a no-op.
 *   - Entitlement is CACHED locally once granted and trusted from then on (`viva-maya:entitled`).
 *     This is the same "guard rails, not replay" posture CLAUDE.md's score-defence section states
 *     for scores: real anti-tamper would need a receipt store this static site doesn't have, and a
 *     $1.33 unlock doesn't justify building one. A cleared cache or a fresh device re-verifies
 *     against the server (`refreshEntitlement`), and `restoreByEmail` recovers a purchase made
 *     elsewhere. The two-origins note applies here too: storage doesn't cross
 *     corruptfun.github.io ↔ corrupt.solutions, so a purchase made on one is invisible on the
 *     other until restored by email — there is no fix for that short of the origin handoff
 *     (core/originmigrate.ts) carrying the flag, which it deliberately does not for money state.
 *   - The identity a purchase is attributed to is the SAME anonymous device id
 *     core/analytics.ts mints (`viva-maya:device`) — one id, reused everywhere, never a second
 *     fingerprint minted just for this.
 */
import { getDeviceId } from './analytics'

const env = import.meta.env as unknown as Record<string, string | undefined>
const SUPABASE_URL = env.VITE_SUPABASE_URL

const ENTITLED_KEY = 'viva-maya:entitled'

/** The one price this whole feature exists to charge. Kept as a single source for the UI copy. */
export const LIFETIME_PRICE_LABEL = '$1.33'

/** False on a build with no Supabase configured — BootScene must never gate play on a dormant build. */
export function paywallConfigured(): boolean {
  return !!SUPABASE_URL
}

function fnUrl(name: string): string {
  return `${SUPABASE_URL}/functions/v1/${name}`
}

function readLocalEntitled(): boolean {
  try {
    return localStorage.getItem(ENTITLED_KEY) === '1'
  } catch {
    return false
  }
}

function writeLocalEntitled(): void {
  try {
    localStorage.setItem(ENTITLED_KEY, '1')
  } catch {
    // Storage blocked (private mode, quota) — the current session still unlocks below; it just
    // won't stick past a reload, which is a strictly better failure than refusing to play at all.
  }
}

/** True once this device has locally recorded a completed purchase. Instant, no network. */
export function isEntitledLocally(): boolean {
  return readLocalEntitled()
}

async function postJson(name: string, body: Record<string, unknown>): Promise<{ entitled?: boolean; url?: string } | null> {
  try {
    const res = await fetch(fnUrl(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** Re-checks with the server whether this device is entitled. Used to recover a lost local flag. */
export async function refreshEntitlement(): Promise<boolean> {
  if (!paywallConfigured()) return true // dormant build — never blocks play
  if (readLocalEntitled()) return true
  const res = await postJson('entitlement-status', { deviceId: getDeviceId() })
  const entitled = res?.entitled === true
  if (entitled) writeLocalEntitled()
  return entitled
}

/** The Stripe return trip: `?entitlement_session=<id>` on the URL after a successful Checkout. */
export async function verifyCheckoutSession(sessionId: string): Promise<boolean> {
  const res = await postJson('entitlement-status', { sessionId, deviceId: getDeviceId() })
  const entitled = res?.entitled === true
  if (entitled) writeLocalEntitled()
  return entitled
}

/** "I already paid, on another device" — looked up by email, and links THIS device on a hit. */
export async function restoreByEmail(email: string): Promise<boolean> {
  const res = await postJson('entitlement-status', { email, deviceId: getDeviceId() })
  const entitled = res?.entitled === true
  if (entitled) writeLocalEntitled()
  return entitled
}

/** Starts a Stripe Checkout redirect for the lifetime unlock. Returns false if it couldn't start. */
export async function startCheckout(): Promise<boolean> {
  const res = await postJson('stripe-checkout', { deviceId: getDeviceId(), returnUrl: location.href.split('?')[0] })
  if (typeof res?.url !== 'string') return false
  location.href = res.url
  return true
}

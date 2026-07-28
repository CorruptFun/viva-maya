/**
 * Web Push opt-in — the client half of the weekly-race callback.
 *
 * WHY: the endless race resets Monday 00:00 UTC and nothing tells anyone. The one measured churn so
 * far (a W30 player absent from W31) crossed exactly that boundary. A reset nobody is told about is a
 * reset most players sleep through.
 *
 * Design contract, matching core/cloud.ts and core/analytics.ts:
 *   - DORMANT until configured. No VAPID key or no Supabase env → every export reports unsupported
 *     and does nothing. A local-only build behaves exactly as before.
 *   - NEVER THROWS into the game.
 *   - The subscription is stored server-side keyed on its ENDPOINT (0011), which is what makes a
 *     subscription belong to a browser install rather than to an account — one person with a phone
 *     and a laptop has two, and a signed-out player has one with no account at all.
 *
 * ⚠️ PLATFORM CONSTRAINTS THAT SHAPE THE UI, not just the code:
 *   - iOS/iPadOS only support Web Push in an INSTALLED (home-screen) PWA, since 16.4. In a Safari tab
 *     the API is either missing or permanently denied. `pushSupported()` reports that distinctly so
 *     the UI can say "add to your home screen first" instead of showing a button that cannot work.
 *   - `Notification.requestPermission()` must be called from a user gesture, and a DENY is
 *     effectively permanent — the browser will not ask again, and the player has to dig through site
 *     settings to undo it. So the prompt must never be fired on load; it is only ever reached from an
 *     explicit tap on a control that has already explained what it is for.
 */

import { cloudAccessToken, cloudUserId } from './cloud'

const env = import.meta.env as unknown as Record<string, string | undefined>
const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY
const VAPID_PUBLIC_KEY = env.VITE_VAPID_PUBLIC_KEY

const DEVICE_KEY = 'viva-maya:device'

export type PushSupport =
  /** Everything present — the opt-in can be offered. */
  | 'ready'
  /** iOS Safari in a browser tab: real support exists, but only once installed to the home screen. */
  | 'needs-install'
  /** No Push API / no service worker / not configured on this build. */
  | 'unsupported'

/** True when the page is running as an installed PWA rather than a browser tab. */
function isStandalone(): boolean {
  try {
    return (
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as unknown as { standalone?: boolean }).standalone === true
    )
  } catch {
    return false
  }
}

function isAppleMobile(): boolean {
  try {
    const ua = navigator.userAgent || ''
    // iPadOS 13+ reports as Macintosh; the touch-point check separates a real iPad from a desktop Mac.
    return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  } catch {
    return false
  }
}

/**
 * Whether push can be offered here, and if not, whether that is fixable by the player.
 * The 'needs-install' case is the reason this returns three states rather than a boolean: on iOS the
 * feature is one home-screen install away, and telling the player that is the difference between a
 * dead end and a conversion.
 */
export function pushSupport(): PushSupport {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !VAPID_PUBLIC_KEY) return 'unsupported'
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported'
    if (typeof window === 'undefined' || !('PushManager' in window)) {
      // Apple ships PushManager only in the installed context, so its ABSENCE on an Apple mobile
      // device is the signal for "install me", not for "unsupported".
      return isAppleMobile() && !isStandalone() ? 'needs-install' : 'unsupported'
    }
    if (typeof Notification === 'undefined') {
      return isAppleMobile() && !isStandalone() ? 'needs-install' : 'unsupported'
    }
    if (isAppleMobile() && !isStandalone()) return 'needs-install'
    return 'ready'
  } catch {
    return 'unsupported'
  }
}

/** The browser's current permission state, or null when push can't be offered at all. */
export function pushPermission(): NotificationPermission | null {
  try {
    if (pushSupport() !== 'ready') return null
    return Notification.permission
  } catch {
    return null
  }
}

/** Whether this install currently holds a push subscription. */
export async function isPushEnabled(): Promise<boolean> {
  try {
    if (pushSupport() !== 'ready' || Notification.permission !== 'granted') return false
    const reg = await navigator.serviceWorker.getRegistration()
    return !!(await reg?.pushManager.getSubscription())
  } catch {
    return false
  }
}

/**
 * The applicationServerKey has to be raw BYTES, not the base64url string the key is distributed as —
 * passing the string silently produces an invalid subscription on some engines rather than an error,
 * which is a genuinely nasty way to lose an afternoon.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(normalized)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function readDeviceId(): string {
  try {
    // Shared with core/analytics.ts on purpose: an opt-in should be attributable in the funnel
    // without an account, and re-minting a second id here would make those two views disagree.
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
  } catch {
    // fall through
  }
  try {
    return crypto.randomUUID()
  } catch {
    return '00000000-0000-4000-8000-000000000000'
  }
}

function authHeaders(): Record<string, string> {
  const token = cloudAccessToken()
  return {
    'Content-Type': 'application/json',
    apikey: SUPABASE_ANON_KEY as string,
    Authorization: `Bearer ${token ?? (SUPABASE_ANON_KEY as string)}`,
  }
}

export interface EnableResult {
  ok: boolean
  /** Machine-readable so the caller can pick its own copy. */
  reason?: 'unsupported' | 'needs-install' | 'denied' | 'failed'
}

/**
 * Ask for permission and register a subscription. MUST be called from a user gesture.
 *
 * The order matters: permission first, subscribe second, store third. Storing last means a row only
 * ever exists for a subscription that really was created, so the sender never wastes a send on a
 * subscription the browser rejected.
 */
export async function enablePush(): Promise<EnableResult> {
  const support = pushSupport()
  if (support !== 'ready') return { ok: false, reason: support === 'needs-install' ? 'needs-install' : 'unsupported' }

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return { ok: false, reason: 'denied' }

    const reg = await navigator.serviceWorker.ready
    // Reuse an existing subscription when there is one — re-subscribing rotates the endpoint and
    // would orphan the previous row (which the sender would then keep failing on until it retires).
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        // Required to be true by every engine: a push MUST result in a visible notification.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY as string),
      }))

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return { ok: false, reason: 'failed' }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        // Re-registering the same endpoint must UPDATE, not duplicate — otherwise a player who
        // toggles this twice gets two notifications.
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        device_id: readDeviceId(),
        user_id: cloudUserId(),
        week_race: true,
      }),
    })
    if (!res.ok) return { ok: false, reason: 'failed' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/**
 * Turn notifications off: drop the server row first, then unsubscribe locally.
 *
 * That order is deliberate. If the local unsubscribe ran first and the network call then failed, the
 * row would be stranded server-side with a live-looking endpoint and the player would keep getting
 * notifications they just switched off — the single worst outcome for this feature. Deleting first
 * means the failure mode is a subscription that exists locally but is never sent to, which is
 * invisible and self-corrects on the next enable.
 */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return

    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`,
        { method: 'DELETE', headers: authHeaders() }
      )
    } catch {
      // best-effort; the sender retires it on the first 404/410 from the push service anyway
    }
    await sub.unsubscribe()
  } catch {
    // never throws into the game
  }
}

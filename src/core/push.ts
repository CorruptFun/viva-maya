/**
 * Web Push opt-in — the client half of the endless-race callback.
 *
 * WHY: the race resets and nothing tells anyone. The one measured churn so far (a W30 player absent
 * from W31) crossed exactly that boundary. A reset nobody is told about is a reset most players
 * sleep through — and since the board went DAILY there are now seven of those a week, so the
 * reminder went from a nice-to-have to the main thing carrying the format's rhythm.
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

// cloudUserId is deliberately NOT imported: user_id is no longer sent from the client at all.
// register_push_subscription (0012) reads it from the JWT server-side, so it cannot be forged.
import { cloudAccessToken } from './cloud'
import type { SaveData } from './save'

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

    // Goes through the SECURITY DEFINER function (0012), NOT a direct table write.
    // A direct upsert CANNOT WORK here: the table has no SELECT policy (endpoints must never be
    // enumerable), and Postgres needs a row to be visible under a SELECT policy before ON CONFLICT
    // can update it — so the direct version silently refreshed nothing while returning 201.
    // user_id is deliberately NOT sent: the function reads it from the JWT so it can't be forged.
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/register_push_subscription`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        p_endpoint: json.endpoint,
        p_p256dh: json.keys.p256dh,
        p_auth: json.keys.auth,
        p_device_id: readDeviceId(),
      }),
    })
    if (!res.ok) return { ok: false, reason: 'failed' }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORIES — which kinds of notification this install has said yes to.
//
// Two of them (migration 0025): the evening RACE reminder 0011 shipped, and the
// morning PLAY nudge that carries the day's house gift. They are per-category
// rather than one switch because they answer different questions, and a player
// who wants their standing before a board closes but does not want a 9am nudge
// should be able to say exactly that instead of choosing between everything and
// nothing.
//
// ⚠️ Both on is still ONE notification a day, never two — the sender's two slots
// have disjoint audiences and it re-checks `last_sent_at` before every send.
// That is stated at length in 0025's header, and it is what makes it honest to
// have defaulted the new category ON for the people who opted in under the old
// card's "one nudge, that is the only one you will ever get".
// ─────────────────────────────────────────────────────────────────────────────

/** The two notification categories. Column names in `push_subscriptions`; the RPC validates them. */
export type PushCategory = 'week_race' | 'daily_play'

/** Which categories this install currently holds. */
export interface PushCategories {
  /** The evening reminder before a race board closes. */
  weekRace: boolean
  /** The morning nudge — today's house gift, and a streak about to break. */
  dailyPlay: boolean
}

/**
 * Read this install's categories back from the row that decides them, or null when there is no
 * subscription (or the read failed).
 *
 * ⚠️ Deliberately NOT mirrored in localStorage. A local copy is a second definition of a fact the
 * server owns, and the two drift the moment a row goes away underneath it — a rotated endpoint, a
 * re-register, or the last-category delete below — leaving Settings painting an ON switch over a
 * subscription that no longer exists. `get_push_categories` (0025) exists precisely so there is one
 * answer; it is a definer function because 0011 grants no SELECT policy, and it is safe to expose
 * because it takes the endpoint as an argument and so can enumerate nothing.
 *
 * `null` is "unknown", not "off" — a caller must not paint switches from a failed read.
 */
export async function pushCategories(): Promise<PushCategories | null> {
  try {
    if (pushSupport() !== 'ready') return null
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return null
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_push_categories`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ p_endpoint: sub.endpoint }),
    })
    // 404 is the shape a client deployed ahead of migration 0025 gets back. Answering "unknown"
    // rather than throwing is what keeps that ordering survivable — see the two-phase note in 0025.
    if (!res.ok) return null
    const rows = (await res.json()) as Array<{ week_race?: boolean; daily_play?: boolean }>
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) return null
    return { weekRace: row.week_race !== false, dailyPlay: row.daily_play !== false }
  } catch {
    return null
  }
}

/**
 * Turn one category on or off. Returns whether the change actually landed.
 *
 * ⚠️ TURNING OFF THE LAST CATEGORY IS A FULL UNSUBSCRIBE, and that rule lives here rather than in
 * the Settings screen so both doors cannot disagree about it. 0016's stance on `unsubscribe_push` is
 * that deleting is the honest implementation of "off" — no row, no send, nothing retained — and a
 * player who switches off the last thing we would ever send has said off. The server half does the
 * same (0025 deletes the row when both booleans go false); this half also drops the BROWSER
 * subscription, which the server cannot do, so the player is not left holding a live endpoint for a
 * row that is gone.
 */
export async function setPushCategory(category: PushCategory, on: boolean): Promise<boolean> {
  try {
    if (pushSupport() !== 'ready') return false
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (!sub) return false

    if (!on) {
      // Read before writing so "is this the last one" is answered by the row rather than guessed.
      // An unknown answer (null) falls through to the plain toggle: refusing to act would leave the
      // player unable to switch anything off, which is strictly the worse failure.
      const current = await pushCategories()
      const other = category === 'week_race' ? current?.dailyPlay : current?.weekRace
      if (current && other === false) {
        await disablePush()
        return true
      }
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_push_category`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ p_endpoint: sub.endpoint, p_category: category, p_on: on }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Whether to put the RACE REMINDER card (view/pushoptin.ts) in front of this player right now.
 *
 * Lives here rather than beside the card because it is a composition of the three capability checks
 * above — and because a gate that decides whether to spend a PERMANENT browser permission ask has to
 * be testable without booting Phaser. `SaveData` is a type-only import, so the dormant contract at
 * the top of this file is untouched: no new runtime dependency, nothing new to configure.
 *
 * Every `false` is a case where the card would either be a lie or a waste of the one-time latch, so
 * the gate is deliberately strict:
 *
 *  - **Already answered** (`seenPushOffer`) — asked once, in our own words, ever.
 *  - **Has not raced yet** — `endlessDays` is `{}` until the first run, so this is the "first race
 *    happened" signal, and a reminder about a board closing is meaningless before then. It is the
 *    entire premise of the card's copy.
 *  - **Can't subscribe here** — 'needs-install' on an iPhone outside an installed PWA, 'unsupported'
 *    on a browser without the APIs or a build with no VAPID key. Burning the latch to say "not on
 *    this device" would mean never offering it on the device they go on to install to; that case
 *    already belongs to the install nudge.
 *  - **The browser already decided** — 'granted' with a live subscription means it is on, and
 *    'denied' is permanent and unreachable from inside the page. Offering either is offering nothing.
 *
 * Async because the live-subscription check is. Never throws; a failure answers `false`, which fails
 * toward not nagging.
 */
export async function pushOfferDue(save: SaveData): Promise<boolean> {
  try {
    if (save.seenPushOffer) return false
    if (Object.keys(save.endlessDays ?? {}).length === 0) return false
    if (pushSupport() !== 'ready') return false
    if (pushPermission() === 'denied') return false
    if (await isPushEnabled()) return false
    return true
  } catch {
    return false
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
      // Via the definer function (0012) for the same reason as register: a direct DELETE can never
      // find the row without a SELECT policy, so it returned 204 and deleted nothing — the player
      // kept receiving notifications they had just switched off.
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/unsubscribe_push`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ p_endpoint: sub.endpoint }),
      })
    } catch {
      // best-effort; the sender retires it on the first 404/410 from the push service anyway
    }
    await sub.unsubscribe()
  } catch {
    // never throws into the game
  }
}

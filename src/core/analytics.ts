/**
 * Product analytics — a tiny, first-party, append-only event pipe.
 *
 * WHY IT EXISTS: the two leaderboards were the only telemetry this game had, and both need a Google
 * sign-in. On 2026-07-28 that was 8 known accounts against ~10-12 believed-active players, so every
 * signed-out player was invisible and nothing about the funnel — how many opened it, where they quit,
 * whether an invite ever converted — could be answered at all. Sign-in is optional by design, so
 * anything keyed on auth.users can only ever see the minority. Hence a DEVICE id below.
 *
 * Design contract, deliberately identical to core/cloud.ts so there is one mental model for "talks to
 * the network" in this codebase:
 *   - DORMANT until configured: with no VITE_SUPABASE_* env, every export no-ops and the game runs
 *     exactly as before. Analytics is never a reason for the game to behave differently.
 *   - NEVER THROWS into the game. Every path is wrapped; a failed flush drops events on the floor.
 *     Losing a metric is free. Breaking a level is not.
 *   - FIRE AND FORGET: track() returns void synchronously and does no network work on the caller's
 *     frame. It appends to an in-memory queue; flushing is batched and off the hot path.
 *
 * WHY RAW fetch AND NOT THE SUPABASE CLIENT: two reasons. (1) The unload flush needs `keepalive`,
 * which supabase-js does not expose — and the unload flush is the one that carries "player quit here",
 * the single most valuable event in a funnel. (2) It keeps analytics working even when the lazy
 * supabase chunk hasn't loaded, so a first-session bounce (the exact player we can't currently see) is
 * still counted.
 *
 * Privacy: no PII, no fingerprinting, no third party. `device_id` is a random UUID this file mints —
 * it is not derived from anything about the device or the person. Disclosed in public/privacy.html,
 * and honours an opt-out (setAnalyticsEnabled) that persists locally.
 */

/**
 * Read lazily rather than captured into module-scope consts (which is what core/cloud.ts does).
 * Vite inlines import.meta.env at build time either way, so this costs nothing in the bundle — but
 * capturing at module load makes the module impossible to exercise from a test, because the import
 * happens before any test can stub the environment. Everything else here is only meaningful when
 * configured, so an untestable gate would mean an untested file.
 */
function env(): Record<string, string | undefined> {
  return import.meta.env as unknown as Record<string, string | undefined>
}
function supabaseUrl(): string | undefined {
  return env().VITE_SUPABASE_URL
}
function supabaseKey(): string | undefined {
  return env().VITE_SUPABASE_ANON_KEY
}

/** Injected by vite.config define — the CI commit SHA, or 'dev' locally. */
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

const DEVICE_KEY = 'viva-maya:device'
const OPTOUT_KEY = 'viva-maya:analytics-off'

/**
 * Canonical event names. Kept as a const object rather than a Postgres enum or a lookup table on
 * purpose (see 0010_events.sql): under a 'prompt'-mode PWA, players sit on several bundles at once, so
 * a server that only accepts today's vocabulary would reject events from every un-updated client.
 * The server normalises shape and buckets anything unrecognised as 'unknown'.
 */
export const EVENTS = {
  /** Once per app open. The denominator for literally every other rate on this list. */
  APP_OPEN: 'app_open',

  /** {level} — a level actually began (not merely browsed to on the map). */
  LEVEL_START: 'level_start',
  /** {level, stars, moves_left} */
  LEVEL_WIN: 'level_win',
  /** {level, reason: 'out_of_moves' | 'out_of_lives'} — the wall detector. */
  LEVEL_FAIL: 'level_fail',
  /** {level} — backed out mid-level, which reads very differently from losing. */
  LEVEL_QUIT: 'level_quit',

  /** {score} */
  ENDLESS_START: 'endless_start',
  ENDLESS_END: 'endless_end',

  /** The sign-in funnel: how many see the offer vs take it. */
  SIGNIN_SHOWN: 'signin_shown',
  SIGNIN_STARTED: 'signin_started',
  SIGNIN_COMPLETED: 'signin_completed',

  /** PWA install funnel — the memory note says installs are believed to predict retention; this tests it. */
  INSTALL_SHOWN: 'install_shown',
  INSTALL_ACCEPTED: 'install_accepted',

  /** Push opt-in funnel. */
  PUSH_SHOWN: 'push_shown',
  PUSH_ENABLED: 'push_enabled',
  PUSH_BLOCKED: 'push_blocked',

  /** {surface} — invite/share. Answers "did the referral system ever do anything". */
  SHARE_CLICKED: 'share_clicked',
  REFERRAL_CAPTURED: 'referral_captured',
  REFERRAL_REGISTERED: 'referral_registered',

  /** {cascade} / {slot, payout} — the 2026-07-28 endless retune has no field data behind it yet. */
  PLINKO_OFFERED: 'plinko_offered',
  PLINKO_PLAYED: 'plinko_played',

  /**
   * §G2 the out-of-moves continue funnel: {level, price, chips, near} shown → {level, price} taken.
   * `shown` minus `taken` is the decline rate, and `near` (goal pieces still owed) is what makes the
   * pair readable — a high decline rate on near=1 means the price is wrong, while a high decline on
   * near=40 just means the offer fired on a level the player had already given up on.
   * A level that is failed far more often than it is continued is a wall; one that is continued far
   * more often than it is failed is a level whose move budget is simply short.
   */
  CONTINUE_SHOWN: 'continue_shown',
  CONTINUE_TAKEN: 'continue_taken',

  /** The update toast, which the PWA stale-build trap makes worth watching. */
  UPDATE_SHOWN: 'update_shown',
  UPDATE_APPLIED: 'update_applied',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

interface QueuedEvent {
  device_id: string
  session_id: string
  user_id?: string | null
  name: string
  props: Record<string, unknown>
  app_version: string
}

/** Flush when the queue reaches this many — keeps a chatty session from hoarding events in memory. */
const BATCH_SIZE = 20
/** …or when this long has passed, so a quiet session still reports before the player leaves. */
const FLUSH_MS = 15_000
/** Hard cap. If the network is down for a whole session, drop the OLDEST rather than grow forever. */
const MAX_QUEUE = 200

let queue: QueuedEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let deviceId: string | null = null
let sessionId: string | null = null
let started = false
/** Set by initAnalytics from core/cloud, so events can carry attribution without importing cloud here. */
let currentUserId: (() => string | null) | null = null
let currentToken: (() => string | null) | null = null

function uuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  } catch {
    // fall through
  }
  // Non-crypto fallback (older WebViews). Uniqueness here only needs to hold across this one
  // installation, not globally, so Math.random is sufficient.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** localStorage can throw (private mode, quota) — the same hazard save.ts already guards. */
function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLS(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // unavailable — analytics degrades to per-session, the game is unaffected
  }
}

/**
 * The stable anonymous id. Minted once and reused forever; a cache wipe mints a new one, which
 * slightly inflates "new device" counts. That is the accepted cost of storing no fingerprint —
 * the alternative (deriving an id from device characteristics) is exactly the tracking this
 * game's privacy policy promises not to do.
 */
function getDeviceId(): string {
  if (deviceId) return deviceId
  const existing = readLS(DEVICE_KEY)
  if (existing && existing.length >= 8) {
    deviceId = existing
  } else {
    deviceId = uuid()
    writeLS(DEVICE_KEY, deviceId)
  }
  return deviceId
}

/** True unless the player opted out locally. */
export function analyticsEnabled(): boolean {
  return readLS(OPTOUT_KEY) !== '1'
}

/** Opt out (or back in). Opting out also discards anything already queued. */
export function setAnalyticsEnabled(on: boolean): void {
  writeLS(OPTOUT_KEY, on ? '0' : '1')
  if (!on) queue = []
}

function configured(): boolean {
  return !!supabaseUrl() && !!supabaseKey()
}

/**
 * Queue an event. Safe to call from anywhere, including a scene's update loop — it does no network
 * work and never throws.
 */
export function track(name: EventName | string, props: Record<string, unknown> = {}): void {
  try {
    if (!configured() || !analyticsEnabled()) return
    if (!sessionId) sessionId = uuid()

    queue.push({
      device_id: getDeviceId(),
      session_id: sessionId,
      // Only set when signed in. RLS pins this to auth.uid(), so a wrong value would be REJECTED
      // (0010) — null is both the honest value and the safe one.
      user_id: currentUserId?.() ?? null,
      name,
      props,
      app_version: APP_VERSION,
    })

    // Drop the OLDEST on overflow: during a long offline stretch the recent events are the ones
    // that still describe what the player is doing now.
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE)

    if (queue.length >= BATCH_SIZE) {
      void flush()
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        void flush()
      }, FLUSH_MS)
    }
  } catch {
    // analytics must never surface into gameplay
  }
}

/**
 * Send whatever is queued.
 *
 * `keepalive` is what makes the unload path work: a normal fetch is cancelled when the page goes
 * away, which would lose precisely the last events of a session — the ones that say where the player
 * stopped. Failures re-queue rather than retry in place; the next flush (or the next app open) picks
 * them up, and a permanently offline player just tops out at MAX_QUEUE.
 */
async function flush(unloading = false): Promise<void> {
  if (!configured() || queue.length === 0) return
  const batch = queue
  queue = []
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  const token = currentToken?.() ?? null
  const key = supabaseKey() as string
  const body = JSON.stringify(batch)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: key,
    // A signed-in player's own JWT, so auth.uid() matches the user_id above and RLS admits the row.
    // Anonymous rows go up under the publishable key, which is what the 0010 policy is built for.
    Authorization: `Bearer ${token ?? key}`,
    // No response body wanted; this is a write-only table and nothing reads the result.
    Prefer: 'return=minimal',
  }

  try {
    const res = await fetch(`${supabaseUrl()}/rest/v1/events`, {
      method: 'POST',
      headers,
      body,
      keepalive: unloading,
      // Analytics must never keep a connection alive that the game needs.
      cache: 'no-store',
    })
    // 4xx means this batch will never be accepted (bad shape, revoked key) — dropping it is correct.
    // Only a transport failure or a 5xx is worth keeping.
    if (!res.ok && res.status >= 500) queue = batch.concat(queue).slice(-MAX_QUEUE)
  } catch {
    queue = batch.concat(queue).slice(-MAX_QUEUE)
  }
}

/**
 * Wire up the session: mint a session id, log the open, and arrange for the queue to be flushed when
 * the player leaves.
 *
 * `visibilitychange`→hidden is the ONLY reliable "leaving" signal on iOS — `beforeunload` and
 * `unload` are not fired when an app is swiped away or backgrounded, which is how a phone player
 * almost always ends a session. `pagehide` covers the bfcache case on desktop. Both are registered.
 *
 * @param getUserId  reads the current signed-in user id (core/cloud), or null
 * @param getToken   reads the current access token (core/cloud), or null
 */
export function initAnalytics(
  getUserId: () => string | null,
  getToken: () => string | null
): void {
  if (started || !configured()) return
  started = true
  currentUserId = getUserId
  currentToken = getToken
  // `??=`, not `=`: an event can legitimately be tracked BEFORE this runs — the service-worker
  // update toast fires from registerSW at module scope, ahead of the cloud bootstrap this is
  // sequenced behind. Overwriting would split one real session into two.
  sessionId ??= uuid()

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void flush(true)
    })
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void flush(true))
    // A reconnect is the natural moment to drain anything the offline stretch accumulated.
    window.addEventListener('online', () => void flush())
  }

  track(EVENTS.APP_OPEN, {
    standalone:
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true),
    lang: typeof navigator !== 'undefined' ? navigator.language : undefined,
  })
}

/** Test/diagnostic seam: what is waiting to be sent. Not part of the game's runtime surface. */
export function _queueDepth(): number {
  return queue.length
}

/** Test seam: drop all state so each test starts clean. */
export function _reset(): void {
  queue = []
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = null
  deviceId = null
  sessionId = null
  started = false
  currentUserId = null
  currentToken = null
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { mergeSaves } from './merge'
import { coerceSave, loadSave, persistSave, type SaveData } from './save'

// Re-export the pure merge so the cloud module is the single public surface for the sync layer.
export { mergeSaves }

/**
 * Minimal Supabase cloud-save — one row per user, and the whole of it.
 *
 * Design contract:
 *   - DORMANT until configured: with no VITE_SUPABASE_* env, every export no-ops and the game runs
 *     exactly as today (localStorage only). Nothing here may ever throw into the game.
 *   - localStorage stays AUTHORITATIVE. The cloud is a mirror: on boot we pull the cloud row, MERGE it
 *     with local ("furthest-progressed wins"), persist the winner locally, and push it back so both
 *     ends converge. Thereafter every persistSave() debounce-pushes to the cloud.
 *   - Identity is a Google account (OAuth) so progress survives a cache wipe and syncs across devices.
 */

const env = import.meta.env as unknown as Record<string, string | undefined>
const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY

/** True only when both env vars are present — the single gate every cloud path checks. */
export function isCloudConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY
}

let clientPromise: Promise<SupabaseClient> | null = null
/**
 * Lazily import the Supabase client — ONLY when configured. This keeps @supabase/supabase-js in a
 * separate async chunk (named + excluded from the PWA precache in vite.config) so a LOCAL-ONLY build
 * never ships or downloads it; it loads on demand the moment cloud is actually turned on.
 */
async function sb(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured()) return null
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(m =>
      m.createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    )
  }
  return clientPromise
}

/**
 * Shared client accessor for sibling cloud modules (core/leaderboard.ts) — hands out the SAME lazy
 * singleton, so a second connection can never exist. Null when unconfigured (the dormant path).
 */
export function sbClient(): Promise<SupabaseClient | null> {
  return sb()
}

export interface CloudSession {
  userId: string
  email: string | null
}
let session: CloudSession | null = null
/**
 * The live access token, mirrored out of the Supabase session.
 *
 * Exists for core/analytics.ts, which posts to PostgREST with a RAW fetch rather than through the
 * Supabase client (it needs `keepalive` on the page-unload flush, which supabase-js doesn't expose).
 * Without the token those writes would be anonymous and could not carry a user_id past the 0010 RLS
 * check. Kept as a separate variable rather than a field on CloudSession so the shape every other
 * consumer already destructures stays untouched.
 */
let accessToken: string | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const l of listeners) {
    try {
      l()
    } catch {
      // a listener error must not cascade
    }
  }
}

/** Subscribe to auth/session changes (for the sign-in UI). Returns an unsubscribe fn. */
export function onCloudChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** The current signed-in session, or null (signed out / unconfigured). */
export function cloudSession(): CloudSession | null {
  return session
}

/** The current user id, or null. Convenience for callers that only need attribution. */
export function cloudUserId(): string | null {
  return session?.userId ?? null
}

/** The current access token, or null. See the `accessToken` note above for why this is exposed. */
export function cloudAccessToken(): string | null {
  return accessToken
}

// ---------------------------------------------------------------------------- pull / push
/** Fetch the signed-in user's cloud save (coerced), or null (none yet / unconfigured / error). */
export async function pullCloudSave(): Promise<SaveData | null> {
  const c = await sb()
  if (!c || !session) return null
  try {
    const { data, error } = await c.from('saves').select('data').eq('user_id', session.userId).maybeSingle()
    if (error || !data) return null
    return coerceSave((data as { data: unknown }).data)
  } catch {
    return null
  }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null
let pending: SaveData | null = null

/** Debounced upsert of the save to the cloud. No-op when unconfigured / signed out. Never throws. */
export function pushCloudSave(data: SaveData): void {
  if (!isCloudConfigured() || !session) return
  pending = data
  if (pushTimer) return
  pushTimer = setTimeout(() => {
    void flushPush()
  }, 1500)
}

/**
 * Push the queued save NOW, skipping the 1.5s debounce.
 *
 * The debounce is right for gameplay — a level win writes the save several times in a second and one
 * upsert should carry them all. It is WRONG for a deliberate, one-off act the player expects to have
 * taken effect, because the window is exactly long enough to lose: the reporting player's flow was
 * "set my race name, then close the browser", and a tab closed inside 1.5s takes the pending push
 * with it. The name would still reach the boards (setHandle renames those rows directly) but never
 * the cloud SAVE — so the next device would restore progress without the name, which is the whole
 * bug the handle bridge exists to fix.
 *
 * Safe to call with nothing queued: flushPush no-ops on a null `pending`. Failures re-queue exactly
 * as the debounced path does, so this is an "also try now", never a replacement for it.
 */
export async function flushCloudSaveNow(): Promise<void> {
  if (!isCloudConfigured() || !session) return
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
  try {
    await flushPush()
  } catch {
    // Never reject. flushPush guards its own upsert, but `await sb()` — a dynamic import — is
    // outside that guard and can fail offline, and this module's contract is that nothing here
    // throws into the game. Callers use `void flushCloudSaveNow()`, so a rejection would surface
    // as an unhandled one; the debounced push still stands behind us either way.
  }
}

async function flushPush(): Promise<void> {
  pushTimer = null
  const c = await sb()
  const data = pending
  pending = null
  if (!c || !session || !data) return
  try {
    await c.from('saves').upsert(
      { user_id: session.userId, data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    // Leaderboard mirrors: after the save lands, mirror BOTH boards from the same push — TODAY's
    // endless best and the all-time level ladder (core/leaderboard.ts — each no-ops unless it has
    // something to say; lazy import keeps the dependency one-directional and out of the boot path).
    // The WEEKLY standings need no mirror of their own: the server derives them from the daily rows.
    // Fire-and-forget: a board must never block or fail a save.
    void import('./leaderboard').then(m => {
      void m.maybeSubmitEndless(data)
      void m.maybeSubmitLevels(data)
    })
    // Referral bookkeeping piggybacks the same beat: register a stashed invite, then (ordered —
    // a row minted this push must be visible to the qualify check) stamp qualification once the
    // save is past the qualify level. Both are session-memoized no-ops at steady state and obey
    // the dormant contract, so this adds zero traffic for the un-referred majority.
    void import('./referrals').then(async r => {
      await r.maybeRegisterReferral()
      await r.maybeQualify(data)
    })
  } catch {
    pending = data // offline / transient → re-queue for the next persist or the 'online' event
  }
}

/**
 * Reconcile local ↔ cloud: pull the cloud row, merge with local (furthest-progressed wins), persist
 * the winner locally (which re-triggers a push via the persist listener) so both ends converge.
 */
export async function syncNow(): Promise<void> {
  if (!session) return
  const remote = await pullCloudSave()
  const winner = remote ? mergeSaves(loadSave(), remote) : loadSave()
  persistSave(winner)
  // The race name rides the save (core/leaderboard.ts's handle bridge). Adopt the merge winner's
  // handle into this device's mirror FIRST, then repair the player's board rows — in that order, or
  // the repair would publish whatever name this device happened to have instead of the reconciled
  // one. This is the step that restores a name after a cleared browser or on a new phone, and that
  // scrubs rows an older build published under the email fallback. Lazy import + fire-and-forget,
  // matching flushPush above: a board must never block or fail a sync.
  void import('./leaderboard').then(m => {
    m.adoptHandle(winner)
    void m.reconcileName()
  })
  pushCloudSave(winner) // ensure a first-ever cloud row is created even if local was already newest
}

// ---------------------------------------------------------------------------- auth (Google OAuth)
/**
 * Start the Google sign-in flow. This REDIRECTS the whole page to Google's consent screen and back to
 * `redirectTo` (the app's current URL, minus any hash). Nothing runs after this on success — the
 * return is a fresh page load where the Supabase client (detectSessionInUrl: true) establishes the
 * session, `onAuthStateChange` fires, and the null→session transition reconciles saves via syncNow().
 * Returns an error only if the redirect couldn't be started (or cloud is unconfigured). Chosen over
 * email codes because Supabase's built-in email sender is throttled to ~2/hour (testing-only) and
 * Google is one tap for a non-technical player. See docs/CLOUD_SAVE_GOOGLE_SIGNIN.md.
 */
export async function signInWithGoogle(): Promise<{ ok: boolean; error?: string }> {
  const c = await sb()
  if (!c) return { ok: false, error: 'Cloud save isn’t set up on this build.' }
  const { error } = await c.auth.signInWithOAuth({
    provider: 'google',
    // Strip the hash so we return to a clean app URL; Supabase appends its own auth params on return.
    options: { redirectTo: window.location.href.split('#')[0] },
  })
  return error ? { ok: false, error: error.message } : { ok: true }
}

export async function signOutCloud(): Promise<void> {
  const c = await sb()
  if (!c) return
  try {
    await c.auth.signOut()
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------- boot
function applySession(
  s: { access_token?: string | null; user?: { id: string; email?: string | null } | null } | null
): void {
  session = s?.user ? { userId: s.user.id, email: s.user.email ?? null } : null
  // Mirrored for analytics' raw-fetch path. Refreshed on every auth event, so a rotated token
  // (autoRefreshToken is on) can't leave analytics posting with a stale one.
  accessToken = s?.user ? (s.access_token ?? null) : null
}

/**
 * Restore any existing session + wire listeners. Safe/instant when unconfigured. Called once at boot
 * (before the game is created) via bootstrapCloud so a returning signed-in player boots on their
 * cloud save from the first paint.
 */
export async function initCloud(): Promise<void> {
  const c = await sb()
  if (!c) return
  c.auth.onAuthStateChange((event, s) => {
    const hadSession = session !== null
    applySession(s)
    notify()
    // Google OAuth returns via a full-page redirect with NO explicit verify step (the old email code
    // reconciled inside verifyEmailOtp). So a newly-established session — the null→session transition,
    // which is exactly what the redirect return produces — MUST reconcile here (pull cloud → merge
    // "furthest-progressed wins" → persist + push) BEFORE any local persist can mirror a fresh/default
    // save over the player's real cloud progress. Idempotent: the redundant run alongside
    // bootstrapCloud's own syncNow simply converges. Does NOT fire on token refresh or sign-out.
    if (session && !hadSession) {
      // The other half of the OAuth funnel (signin_started is fired before the redirect, in
      // view/cloudmodal.ts). The null→session transition alone does NOT identify the redirect
      // return: a returning signed-in player's boot restore is the same transition delivered as
      // INITIAL_SESSION, and counting those logged a "completed sign-in" on EVERY app open — the
      // first live dashboard read showed 242 completions against 13 starts, which is how this was
      // caught. Only a genuinely new sign-in (the OAuth return included) arrives as SIGNED_IN.
      // Lazy import so the auth path never waits on analytics and cloud.ts keeps no static
      // dependency on it.
      if (event === 'SIGNED_IN') {
        void import('./analytics').then(a => a.track(a.EVENTS.SIGNIN_COMPLETED))
      }
      void syncNow()
    }
    // The push subscription row must name the player who is signed in NOW, or the sender can read
    // nothing personal for this device and every weekday nudge stays silent (see syncPushIdentity).
    // Latched on the user id inside, so this is one round trip per device per account, not per
    // open. Lazy import for the same reason as analytics: the auth path never waits on push.
    if (session) {
      const userId = session.userId
      void import('./push').then(p => p.syncPushIdentity(userId))
    }
  })
  try {
    const { data } = await c.auth.getSession()
    applySession(data.session)
  } catch {
    session = null
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      if (pending) void flushPush()
    })
  }
  notify()
}

/**
 * Boot entry: init the client, and for a signed-in returning player, reconcile saves BEFORE the game
 * reads them — bounded by a timeout so a slow/offline network can never stall boot. Never throws.
 */
export async function bootstrapCloud(timeoutMs = 3000): Promise<void> {
  if (!isCloudConfigured()) return
  try {
    await initCloud()
    if (session) {
      await Promise.race([syncNow(), new Promise<void>(resolve => setTimeout(resolve, timeoutMs))])
    }
  } catch {
    // cloud must never block boot
  }
}

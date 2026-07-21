import type { SupabaseClient } from '@supabase/supabase-js'
import { mergeSaves } from './merge'
import { coerceSave, loadSave, persistSave, type SaveData } from './save'

// Re-export the pure merge so the cloud module is the single public surface for the sync layer.
export { mergeSaves }

/**
 * Minimal Supabase cloud-save — the first slice of `Supabase_Architecture.md`.
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
    // Weekly-race mirror: after the save lands, mirror its endless best to the shared leaderboard
    // (core/leaderboard.ts — no-ops unless this week has a score; lazy import keeps the dependency
    // one-directional and out of the boot path). Fire-and-forget: the race must never block a save.
    void import('./leaderboard').then(m => m.maybeSubmitEndless(data))
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
function applySession(s: { user?: { id: string; email?: string | null } | null } | null): void {
  session = s?.user ? { userId: s.user.id, email: s.user.email ?? null } : null
}

/**
 * Restore any existing session + wire listeners. Safe/instant when unconfigured. Called once at boot
 * (before the game is created) via bootstrapCloud so a returning signed-in player boots on their
 * cloud save from the first paint.
 */
export async function initCloud(): Promise<void> {
  const c = await sb()
  if (!c) return
  c.auth.onAuthStateChange((_event, s) => {
    const hadSession = session !== null
    applySession(s)
    notify()
    // Google OAuth returns via a full-page redirect with NO explicit verify step (the old email code
    // reconciled inside verifyEmailOtp). So a newly-established session — the null→session transition,
    // which is exactly what the redirect return produces — MUST reconcile here (pull cloud → merge
    // "furthest-progressed wins" → persist + push) BEFORE any local persist can mirror a fresh/default
    // save over the player's real cloud progress. Idempotent: the redundant run alongside
    // bootstrapCloud's own syncNow simply converges. Does NOT fire on token refresh or sign-out.
    if (session && !hadSession) void syncNow()
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

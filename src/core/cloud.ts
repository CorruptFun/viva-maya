import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
 *   - Identity is an email (one-time code) so progress survives a cache wipe and syncs across devices.
 */

const env = import.meta.env as unknown as Record<string, string | undefined>
const SUPABASE_URL = env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY

/** True only when both env vars are present — the single gate every cloud path checks. */
export function isCloudConfigured(): boolean {
  return !!SUPABASE_URL && !!SUPABASE_ANON_KEY
}

let client: SupabaseClient | null = null
function sb(): SupabaseClient | null {
  if (!isCloudConfigured()) return null
  if (!client) {
    client = createClient(SUPABASE_URL as string, SUPABASE_ANON_KEY as string, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  }
  return client
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
  const c = sb()
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
  const c = sb()
  const data = pending
  pending = null
  if (!c || !session || !data) return
  try {
    await c.from('saves').upsert(
      { user_id: session.userId, data, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
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

// ---------------------------------------------------------------------------- auth (email OTP)
/** Email the user a one-time sign-in code (also sends a magic link the client can detect). */
export async function sendEmailOtp(email: string): Promise<{ ok: boolean; error?: string }> {
  const c = sb()
  if (!c) return { ok: false, error: 'Cloud save isn’t set up on this build.' }
  const { error } = await c.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } })
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Verify the 6-digit email code, establish the session, and immediately reconcile saves. */
export async function verifyEmailOtp(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const c = sb()
  if (!c) return { ok: false, error: 'Cloud save isn’t set up on this build.' }
  const { error } = await c.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
  if (error) return { ok: false, error: error.message }
  try {
    await syncNow()
  } catch {
    // sign-in still succeeded; a failed first sync will retry on the next persist
  }
  return { ok: true }
}

export async function signOutCloud(): Promise<void> {
  const c = sb()
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
  const c = sb()
  if (!c) return
  c.auth.onAuthStateChange((_event, s) => {
    applySession(s)
    notify()
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

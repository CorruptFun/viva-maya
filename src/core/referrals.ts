import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudSession, isCloudConfigured, sbClient } from './cloud'
import {
  claimReferralWelcome,
  grantReferralRewards,
  setReferredByCode,
  type SaveData,
} from './save'

/**
 * Referral program client — the read/write surface over `public.referral_codes` +
 * `public.referrals` (see supabase/migrations/0004_referrals.sql).
 *
 * FLOW: every player mints one short code (mintMyCode). The invite link carries
 * ?ref=CODE; the friend's client stashes it at boot (captureRefFromUrl), and after
 * sign-in inserts its own referrals row (maybeRegisterReferral — one per account,
 * ever). When the friend passes the qualify level their client stamps qualified_at
 * (maybeQualify); the referrer's client later finds qualified-unclaimed rows
 * (fetchPendingRewards), plays the reward moment, stamps claimed_at and grants
 * chips + a lives refill locally (claimReferralRewards). The referee's own welcome
 * grant rides the save latch (isWelcomePending / claimWelcome).
 *
 * Design contract (mirrors core/cloud.ts exactly):
 *   - DORMANT until configured + signed in: every export no-ops / returns empty
 *     when VITE_SUPABASE_* is absent or the player is signed out. Nothing here may
 *     ever throw into the game.
 *   - The save stays AUTHORITATIVE for everything the player owns (chips, lives,
 *     the welcome latch). The cloud rows only coordinate the two accounts.
 *   - Registration + qualification piggyback the cloud-save push (core/cloud.ts
 *     calls both after each successful save upsert), so there is no new traffic
 *     path; session memos keep the steady-state cost at zero queries.
 */

// ---------------------------------------------------------------------------- constants
/** The referee must UNLOCK past this level before the referral qualifies (real play, not a click). */
export const QUALIFY_LEVEL = 5
/** Lifetime cap on REWARDED referrals per referrer — keeps farming unprofitable. */
export const REFERRAL_CAP = 20
/** Chips the referrer banks per qualified friend (plus a full lives refill on claim). */
export const REFERRER_CHIPS = 300
/** Chips the referred friend banks once their own referral qualifies. */
export const REFEREE_CHIPS = 150

/** localStorage key holding the captured invite code until registration resolves it. */
const REF_STASH_KEY = 'viva-maya:ref'
const CODE_RE = /^[A-Z0-9]{6}$/
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// Supabase access is lazy + optional, exactly like core/leaderboard.ts: cloud.ts owns the
// lazy singleton and `sbClient()` hands out the same instance — never a second connection.
async function client(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured() || !cloudSession()) return null
  return sbClient()
}

// ---------------------------------------------------------------------------- stash (?ref=CODE)
function readStash(): string | null {
  try {
    const raw = localStorage.getItem(REF_STASH_KEY)
    return raw && CODE_RE.test(raw) ? raw : null
  } catch {
    return null
  }
}

function clearStash(): void {
  try {
    localStorage.removeItem(REF_STASH_KEY)
  } catch {
    // best-effort only
  }
}

/**
 * Boot hook (one line in main.ts): capture a `?ref=CODE` invite parameter into the
 * localStorage stash so it survives until the player signs in — even if that's days later.
 * NEVER overwrites an existing stash (first inviter wins; a second link can't hijack it).
 * Also mirrors the code into the save for UI (set-once). Local-only; safe when dormant.
 */
export function captureRefFromUrl(): void {
  try {
    const raw = new URLSearchParams(window.location.search).get('ref')
    if (!raw) return
    const code = raw.trim().toUpperCase()
    if (!CODE_RE.test(code)) return
    if (readStash()) return // never overwrite — the first captured invite stands
    localStorage.setItem(REF_STASH_KEY, code)
    setReferredByCode(code)
  } catch {
    // storage unavailable / malformed URL — the invite is simply lost, never the boot
  }
}

// ---------------------------------------------------------------------------- my code (referrer side)
// Memoized per user id so the steady state is zero queries; reset on account switch.
let myCodeMemo: { userId: string; code: string } | null = null

function randomCode(): string {
  let out = ''
  for (let i = 0; i < 6; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return out
}

/**
 * Get-or-create the signed-in player's own 6-char [A-Z0-9] invite code. Mints on first call
 * (retrying fresh codes on a rare collision — 36^6 keyspace), memoizes for the session, and
 * returns null when dormant / signed out / offline. Never throws.
 */
export async function mintMyCode(): Promise<string | null> {
  try {
    const s = cloudSession()
    if (!s) return null
    if (myCodeMemo && myCodeMemo.userId === s.userId) return myCodeMemo.code
    const c = await client()
    if (!c) return null
    // Existing code? (user_id is UNIQUE — at most one row.)
    const existing = await c.from('referral_codes').select('code').eq('user_id', s.userId).maybeSingle()
    const found = (existing.data as { code: string } | null)?.code
    if (typeof found === 'string' && CODE_RE.test(found)) {
      myCodeMemo = { userId: s.userId, code: found }
      return found
    }
    if (existing.error) return null // transient read failure — retry next call, don't blind-mint
    // Mint: retry fresh codes on PK collision; a user_id collision (another device raced the
    // mint) surfaces the same unique-violation, so on error we re-read our row before retrying.
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = randomCode()
      const ins = await c.from('referral_codes').insert({ code, user_id: s.userId })
      if (!ins.error) {
        myCodeMemo = { userId: s.userId, code }
        return code
      }
      const raced = await c.from('referral_codes').select('code').eq('user_id', s.userId).maybeSingle()
      const racedCode = (raced.data as { code: string } | null)?.code
      if (typeof racedCode === 'string' && CODE_RE.test(racedCode)) {
        myCodeMemo = { userId: s.userId, code: racedCode }
        return racedCode
      }
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------- register (referee side)
// Session memo: once registration reaches a terminal state (row exists / stash resolved) the
// piggybacked call becomes a no-op without touching the network. The absent stash is the
// natural cross-session memo — success and definitive rejection both clear it.
let registerDoneFor: string | null = null

/**
 * If a stashed invite code is waiting and this signed-in account has never been referred,
 * resolve code → referrer and insert our own referrals row. Self-referral and double-referral
 * are impossible server-side (check constraint + PK); we also pre-check client-side so the
 * stash clears on any DEFINITIVE rejection (dead code, own code, already registered) while a
 * transient network failure keeps it for the next save push. No-ops when dormant. Never throws.
 */
export async function maybeRegisterReferral(): Promise<void> {
  try {
    const s = cloudSession()
    if (!s || registerDoneFor === s.userId) return
    const stash = readStash()
    if (!stash) {
      registerDoneFor = s.userId
      return
    }
    const c = await client()
    if (!c) return
    // Already referred? (PK = referee — one row per account, ever.)
    const mine = await c
      .from('referrals')
      .select('referee_user_id')
      .eq('referee_user_id', s.userId)
      .maybeSingle()
    if (mine.error) return // transient — retry on the next push
    if (mine.data) {
      clearStash() // definitive: this account is already registered
      registerDoneFor = s.userId
      return
    }
    // Resolve the code to its owner (codes are world-readable by design).
    const owner = await c.from('referral_codes').select('user_id').eq('code', stash).maybeSingle()
    if (owner.error) return // transient — retry on the next push
    const referrerId = (owner.data as { user_id: string } | null)?.user_id
    if (!referrerId || referrerId === s.userId) {
      clearStash() // definitive: dead code, or our own (self-referral)
      registerDoneFor = s.userId
      return
    }
    const ins = await c
      .from('referrals')
      .insert({ referee_user_id: s.userId, referrer_user_id: referrerId })
    if (!ins.error) {
      clearStash()
      registerDoneFor = s.userId
      return
    }
    // 23505 duplicate row / 23514 self-referral check — definitive server rejections.
    const code = (ins.error as { code?: string }).code
    if (code === '23505' || code === '23514') {
      clearStash()
      registerDoneFor = s.userId
    }
  } catch {
    // transient — the stash survives; the next save push retries
  }
}

// ---------------------------------------------------------------------------- qualify (referee side)
// Session memo: qualification is a one-way latch (set-once server-side), so once we've seen a
// terminal state — stamped, or no referral row — this becomes a free no-op for the session.
// Safe to memo "no row": registration always runs BEFORE this in the flushPush chain, so a row
// minted this session is seen by the very next call.
let qualifyDoneFor: string | null = null

/**
 * If this signed-in account has an unqualified referral row and the save has progressed past
 * QUALIFY_LEVEL, stamp qualified_at (the server clock overwrites our value — set-once via the
 * guard trigger). Piggybacks the cloud-save push. No-ops when dormant. Never throws.
 */
export async function maybeQualify(save: SaveData): Promise<void> {
  try {
    const s = cloudSession()
    if (!s || qualifyDoneFor === s.userId) return
    if (save.unlocked <= QUALIFY_LEVEL) return
    const c = await client()
    if (!c) return
    const mine = await c
      .from('referrals')
      .select('qualified_at')
      .eq('referee_user_id', s.userId)
      .maybeSingle()
    if (mine.error) return // transient — retry on the next push
    if (!mine.data) {
      qualifyDoneFor = s.userId // never referred — terminal for this session
      return
    }
    if ((mine.data as { qualified_at: string | null }).qualified_at !== null) {
      qualifyDoneFor = s.userId // already stamped (set-once)
      return
    }
    const upd = await c
      .from('referrals')
      .update({ qualified_at: new Date().toISOString() })
      .eq('referee_user_id', s.userId)
    if (!upd.error) qualifyDoneFor = s.userId
  } catch {
    // transient — the next save push retries
  }
}

// ---------------------------------------------------------------------------- rewards (referrer side)
/** One qualified-unclaimed referral, ready for the reward moment then claimReferralRewards. */
export interface PendingReferralReward {
  refereeUserId: string
  qualifiedAt: string
}

/** Referral stats for UI: invites registered, qualified, rewarded, and the lifetime cap. */
export interface ReferralStats {
  /** Rows registered under my code (qualified or not). */
  invited: number
  /** Rows that reached the qualify level. */
  qualified: number
  /** Rows already rewarded (claimed). */
  claimed: number
  /** Lifetime rewarded cap (REFERRAL_CAP). */
  cap: number
}

interface ReferralRow {
  referee_user_id: string
  qualified_at: string | null
  claimed_at: string | null
}

async function fetchMyRows(): Promise<ReferralRow[] | null> {
  const s = cloudSession()
  if (!s) return null
  const c = await client()
  if (!c) return null
  const { data, error } = await c
    .from('referrals')
    .select('referee_user_id, qualified_at, claimed_at')
    .eq('referrer_user_id', s.userId)
  if (error || !data) return null
  return data as ReferralRow[]
}

/**
 * My qualified-but-unclaimed referrals (as referrer), oldest first, capped so lifetime rewarded
 * (already-claimed + these) never exceeds REFERRAL_CAP. Empty when dormant / none / offline.
 */
export async function fetchPendingRewards(): Promise<PendingReferralReward[]> {
  try {
    const rows = await fetchMyRows()
    if (!rows) return []
    const claimed = rows.filter(r => r.claimed_at !== null).length
    const room = Math.max(0, REFERRAL_CAP - claimed)
    if (room === 0) return []
    return rows
      .filter((r): r is ReferralRow & { qualified_at: string } => r.qualified_at !== null && r.claimed_at === null)
      .sort((a, b) => a.qualified_at.localeCompare(b.qualified_at))
      .slice(0, room)
      .map(r => ({ refereeUserId: r.referee_user_id, qualifiedAt: r.qualified_at }))
  } catch {
    return []
  }
}

/** Aggregate referral stats for UI. Null when dormant / signed out / offline. */
export async function fetchMyReferralStats(): Promise<ReferralStats | null> {
  try {
    const rows = await fetchMyRows()
    if (!rows) return null
    return {
      invited: rows.length,
      qualified: rows.filter(r => r.qualified_at !== null).length,
      claimed: rows.filter(r => r.claimed_at !== null).length,
      cap: REFERRAL_CAP,
    }
  } catch {
    return null
  }
}

/**
 * Claim rewards for rows from fetchPendingRewards (called AFTER the celebration): stamp each
 * claimed_at in the cloud, then grant locally in one atomic save write — REFERRER_CHIPS per
 * successfully-stamped row plus a full lives refill (save.grantReferralRewards). Rows that fail
 * to stamp (offline / raced) grant NOTHING and simply reappear in the next fetch. Returns how
 * many were claimed and the resulting chip balance (null when nothing landed / dormant).
 */
export async function claimReferralRewards(
  rows: readonly PendingReferralReward[]
): Promise<{ claimed: number; chips: number | null }> {
  try {
    const s = cloudSession()
    const c = await client()
    if (!s || !c || rows.length === 0) return { claimed: 0, chips: null }
    let claimed = 0
    for (const row of rows.slice(0, REFERRAL_CAP)) {
      // Guarded update: RLS restricts us to our own qualified rows, the `.is(null)` filter makes
      // a raced double-claim match ZERO rows, and `.select()` returns the rows actually stamped —
      // so chips are only ever granted for stamps that truly landed, exactly once.
      const upd = await c
        .from('referrals')
        .update({ claimed_at: new Date().toISOString() })
        .eq('referee_user_id', row.refereeUserId)
        .eq('referrer_user_id', s.userId)
        .is('claimed_at', null)
        .select('referee_user_id')
      if (!upd.error && Array.isArray(upd.data) && upd.data.length > 0) claimed++
    }
    if (claimed === 0) return { claimed: 0, chips: null }
    return { claimed, chips: grantReferralRewards(claimed, REFERRER_CHIPS) }
  } catch {
    return { claimed: 0, chips: null }
  }
}

// ---------------------------------------------------------------------------- welcome (referee side)
// Memo of the cloud check (per user): once we know our row is qualified, stop querying — the
// remaining gate (the save latch) is local and free.
let welcomeQualifiedFor: string | null = null

/**
 * Should the referee's one-time welcome moment play? True when signed in, our own referral row
 * is QUALIFIED, and the save latch hasn't been claimed yet. False when dormant. Never throws.
 */
export async function isWelcomePending(save: SaveData): Promise<boolean> {
  try {
    if (save.referralWelcomeClaimed) return false
    const s = cloudSession()
    if (!s) return false
    if (welcomeQualifiedFor === s.userId) return true
    const c = await client()
    if (!c) return false
    const mine = await c
      .from('referrals')
      .select('qualified_at')
      .eq('referee_user_id', s.userId)
      .maybeSingle()
    if (mine.error || !mine.data) return false
    const qualified = (mine.data as { qualified_at: string | null }).qualified_at !== null
    if (qualified) welcomeQualifiedFor = s.userId
    return qualified
  } catch {
    return false
  }
}

/**
 * Grant the referee welcome (called AFTER isWelcomePending gated the celebration): +REFEREE_CHIPS
 * and the save latch flips, atomically (save.claimReferralWelcome). Returns the new chip balance,
 * or null when already claimed. Purely local — the latch rides the cloud-synced save.
 */
export function claimWelcome(): number | null {
  return claimReferralWelcome(REFEREE_CHIPS)
}

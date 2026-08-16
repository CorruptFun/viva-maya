import type { SupabaseClient } from '@supabase/supabase-js'
import { cloudSession, ensureAnonymousSession, isCloudConfigured, sbClient } from './cloud'
import { loadSave } from './save'
import { stashedRefCode } from './referrals'

/**
 * PAID ENTRY — may this account play at all.
 *
 * The game charges ENTRY_PRICE_CENTS (core/referralcash.ts) once per new account, before the first
 * board. This module is the gate in front of that: a synchronous verdict for the boot path, an
 * async server check that keeps it honest, and the call that opens Stripe Checkout.
 *
 * ---------------------------------------------------------------------------- the switch
 * `PAYWALL_ACTIVE_FROM` is the same switch as `public.paywall_active_from()` in migration 0025 —
 * two sides of one wire, exactly like SALT_ACTIVE_FROM / v_salt_from in the race-day salt. CHANGE
 * ONE, CHANGE BOTH. The server half decides who is grandfathered; this half decides who is SHOWN
 * the paywall. Shipping the code dark and flipping a date is what makes the whole player base cross
 * on a day boundary instead of drifting across a deploy — under `registerType: 'prompt'` players
 * run cached bundles for days, so a switch tied to a release would land on each player whenever
 * they happened to update.
 *
 * ---------------------------------------------------------------------------- what this gate is
 * ⚠️ It is a FUNNEL, not a lock, and the difference matters when reasoning about it. The game is a
 * static bundle the player's own browser runs; anyone willing to edit localStorage can walk past
 * this, the same way anyone willing to edit a POST body can put a fake score on the leaderboard
 * (see the score-defence note in CLAUDE.md — same trust posture, deliberately). What is NOT
 * bypassable is everything on the other side of the wire: `entitlements`, `referral_earnings`,
 * `payout_accounts` and `payouts` have no INSERT/UPDATE policy for any client role, so a forged
 * client can grant itself a free game and can never grant itself a cent.
 *
 * ---------------------------------------------------------------------------- never mid-level
 * `refreshAccess()` writes the cache and NOTHING else. It must never be able to interrupt play: the
 * verdict is read once, in BootScene, and a revocation that lands mid-session takes effect on the
 * next launch. Ejecting a player from a level they are winning because a network call came back
 * unfavourably would be a far worse bug than a few extra minutes of free play.
 */

// ---------------------------------------------------------------------------- the switch
/**
 * The instant paid entry begins. Accounts (and local saves) that predate it never pay.
 * ⚠️ Mirrored by `public.paywall_active_from()` in supabase/migrations/0025 — change both.
 */
export const PAYWALL_ACTIVE_FROM = '2026-09-01T00:00:00Z'

/**
 * The same instant as a local date key, for comparing against `save.firstPlayDate` — which is a
 * LOCAL 'YYYY-MM-DD' (save.ts touchOpen), not an instant. The comparison is therefore fuzzy by up
 * to a day at the extremes of the timezone range, always in the generous direction (a player near
 * the international date line may be grandfathered a few hours early). That is the correct way for
 * this particular error to point: grandfathering only ever grants free play, never money.
 */
export const PAYWALL_ACTIVE_FROM_DAY = PAYWALL_ACTIVE_FROM.slice(0, 10)

const CACHE_KEY = 'viva-maya:access'

// ---------------------------------------------------------------------------- pure decision
/** A server verdict we have seen and cached, tied to the account it was issued for. */
export interface CachedAccess {
  /** The account the verdict belongs to — a shared device must never inherit another player's. */
  userId: string
  entitled: boolean
  /** The server's own word: 'paid' | 'granted' | 'grandfathered' | 'prelaunch' | 'unpaid' | 'refunded'. */
  reason: string
  /**
   * Whether this account can be pulled onto another device — i.e. it has a CONFIRMED email, not
   * merely one typed into a payment form. False for a player whose purchase is sitting on an
   * anonymous row, who is one cleared browser away from losing something they paid for.
   *
   * Used for a nudge, never for a gate: having taken someone's money, refusing to let them play
   * until they finish an identity step would rebuild the wall this whole flow exists to remove.
   */
  recoverable: boolean
  /** Epoch ms the verdict was cached. Diagnostics only — a positive verdict never expires. */
  at: number
}

export type AccessReason =
  /** Cloud isn't configured on this build — a local-only game can't sell or verify anything. */
  | 'dormant'
  /** Today is before PAYWALL_ACTIVE_FROM. */
  | 'prelaunch'
  /** The server answered for this account, and its answer is being used (either way). */
  | 'server'
  /** No server answer available, but this device's save predates the paywall. */
  | 'grandfathered_local'
  /** No server answer, no local history — a new player who has not paid. */
  | 'unpaid'

export interface Verdict {
  allow: boolean
  reason: AccessReason
  /** The server's own reason string when `reason` is 'server' — for analytics + the paywall copy. */
  serverReason?: string
}

export interface GateInput {
  now: Date
  /** Is cloud configured on this build at all. */
  configured: boolean
  /** The signed-in account, or null. */
  userId: string | null
  /** The cached server verdict, or null when we have never had one. */
  cached: CachedAccess | null
  /** `save.firstPlayDate` — local 'YYYY-MM-DD', or null on a brand-new install. */
  firstPlayDate: string | null
}

/**
 * The whole gate, as one pure function so every branch is testable without a network or a DOM.
 *
 * ⚠️ THE ORDER IS THE DESIGN, and the middle step is load-bearing in a way that is easy to undo.
 * A server verdict outranks the local grandfather clause in one direction only, and the split is
 * between the two ways the server can say no:
 *
 *   · 'refunded' — OVERRIDES the local clause. This is someone who paid, played for a month and
 *     then charged back, so their save genuinely IS old enough to look grandfathered by the time
 *     they come back. The local clause reads `save.firstPlayDate`, which any player can edit;
 *     letting a forgeable field answer after the server has recorded a chargeback would hand free
 *     access straight back to the person who took their money back.
 *   · 'unpaid'   — FALLS THROUGH to the local clause. This is the case anonymous sign-in created:
 *     a player who has been here since June, has never made an account, and whose freshly-minted
 *     anonymous row has a `created_at` of today. The server is not saying "this person has not
 *     paid", it is saying "this ROW has not paid" — which is a different and much weaker claim,
 *     and treating it as a refusal would lock out the exact cohort grandfathering exists for.
 *
 * If the local clause does not apply either, the server's 'unpaid' stands and the player sees the
 * door.
 */
export function gateVerdict(input: GateInput): Verdict {
  // A build with no cloud can neither take payment nor check an entitlement. Charging into a
  // paywall that cannot possibly resolve would brick a local-only build (and every dev checkout).
  if (!input.configured) return { allow: true, reason: 'dormant' }

  if (input.now.getTime() < Date.parse(PAYWALL_ACTIVE_FROM)) {
    return { allow: true, reason: 'prelaunch' }
  }

  // The server's word about THIS account, when we have one for it. A cached verdict belonging to
  // some other user id is nobody's business here — that is a shared device, and the next player
  // must not inherit the last one's purchase.
  const mine =
    input.cached && input.userId && input.cached.userId === input.userId ? input.cached : null

  if (mine?.entitled) return { allow: true, reason: 'server', serverReason: mine.reason }
  if (mine?.reason === 'refunded') return { allow: false, reason: 'server', serverReason: mine.reason }

  // This device's own history. Grandfathering is generous on purpose — sign-in was optional for
  // this game's whole life before the paywall, so a large share of existing players have no account
  // for the server to recognise them by, and billing a loyal player for a game they already own is
  // the worst outcome available here.
  if (grandfatheredLocally(input.firstPlayDate)) {
    return { allow: true, reason: 'grandfathered_local' }
  }

  // No local history either, so the server's refusal is the answer after all.
  if (mine) return { allow: false, reason: 'server', serverReason: mine.reason }

  return { allow: false, reason: 'unpaid' }
}

/** True when this device's save was first stamped before the paywall's start day. */
export function grandfatheredLocally(firstPlayDate: string | null): boolean {
  if (typeof firstPlayDate !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstPlayDate)) return false
  return firstPlayDate < PAYWALL_ACTIVE_FROM_DAY
}

/** True once paid entry has begun (pure; `now` injectable for tests). */
export function paywallActive(now: Date = new Date()): boolean {
  return now.getTime() >= Date.parse(PAYWALL_ACTIVE_FROM)
}

// ---------------------------------------------------------------------------- cache
/** Read the cached server verdict. Never throws (private mode / quota / junk blob). */
export function readCachedAccess(): CachedAccess | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<CachedAccess>
    if (typeof v?.userId !== 'string' || typeof v.entitled !== 'boolean') return null
    return {
      userId: v.userId,
      entitled: v.entitled,
      reason: typeof v.reason === 'string' ? v.reason : 'unknown',
      recoverable: v.recoverable === true,
      at: typeof v.at === 'number' ? v.at : 0,
    }
  } catch {
    return null
  }
}

function writeCachedAccess(v: CachedAccess): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(v))
  } catch {
    // Storage unavailable — the gate falls back to asking the server on every boot, which is
    // correct but online-only. Deliberately not fatal: a player in private mode still plays.
  }
}

/** Drop the cached verdict — called on sign-out so the next account starts from a clean sheet. */
export function clearCachedAccess(): void {
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    // best-effort only
  }
}

// ---------------------------------------------------------------------------- the gate
/**
 * The synchronous verdict the boot path reads. No network, no promises — BootScene must be able to
 * route on this in the same tick. Safe before sign-in resolves only because main.ts awaits
 * `bootstrapCloud()` before starting Phaser, so the session (if any) is already restored.
 */
export function accessNow(now: Date = new Date()): Verdict {
  let firstPlayDate: string | null = null
  try {
    firstPlayDate = loadSave().firstPlayDate
  } catch {
    // A save that won't load is a brand-new / broken install — treat as no local history.
  }
  return gateVerdict({
    now,
    configured: isCloudConfigured(),
    userId: cloudSession()?.userId ?? null,
    cached: readCachedAccess(),
    firstPlayDate,
  })
}

/** Convenience for scenes that only need the boolean. */
export function mayPlay(): boolean {
  return accessNow().allow
}

// Supabase access is lazy + optional, exactly like core/referrals.ts.
async function client(): Promise<SupabaseClient | null> {
  if (!isCloudConfigured() || !cloudSession()) return null
  return sbClient()
}

/**
 * Ask the server whether this account may play, and cache the answer.
 *
 * ⚠️ WRITES THE CACHE AND NOTHING ELSE. It never navigates, never stops a scene, never touches the
 * game — a revocation lands on the NEXT boot. See the module header.
 *
 * Returns the fresh verdict, or null when dormant / signed out / offline (in which case the cached
 * verdict, if any, still stands — a paid player who is offline keeps playing, forever if need be).
 */
export async function refreshAccess(): Promise<CachedAccess | null> {
  try {
    const s = cloudSession()
    const c = await client()
    if (!s || !c) return null
    const { data, error } = await c.rpc('my_access')
    if (error || !data) return null
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
    if (!row || typeof row.entitled !== 'boolean') return null
    const v: CachedAccess = {
      userId: s.userId,
      entitled: row.entitled,
      reason: typeof row.reason === 'string' ? row.reason : 'unknown',
      recoverable: row.recoverable === true,
      at: Date.now(),
    }
    writeCachedAccess(v)
    return v
  } catch {
    return null
  }
}

/**
 * Poll `refreshAccess` until it reports entitled, or the budget runs out.
 *
 * Exists for exactly one moment: the return from Stripe Checkout. The redirect lands the player
 * back in the game the instant the card clears, but fulfilment happens in the WEBHOOK, which is a
 * separate request Stripe makes to us — usually inside a second, occasionally several. Showing "you
 * are not entitled" in that window would be telling a player who has just been charged that they
 * haven't paid.
 *
 * Backs off 700ms → 3s so a slow webhook costs a handful of requests, not a spin loop.
 */
export async function awaitEntitlement(budgetMs = 25_000): Promise<boolean> {
  const started = Date.now()
  let wait = 700
  for (;;) {
    const v = await refreshAccess()
    if (v?.entitled) return true
    if (Date.now() - started >= budgetMs) return false
    await new Promise<void>(r => setTimeout(r, wait))
    wait = Math.min(3000, Math.round(wait * 1.6))
  }
}

// ---------------------------------------------------------------------------- checkout
export type CheckoutResult = { ok: true } | { ok: false; error: string }

/**
 * Open Stripe Checkout for the entry fee. Navigates the page away on success — nothing after the
 * assign() runs.
 *
 * The client sends NO price. `create-checkout` sets the amount from its own configuration, because
 * an amount the browser can name is an amount the browser can change, and "the client asked for a
 * $0.01 entry fee" is not a class of bug worth being exposed to.
 *
 * The invite code rides along as a HINT only: the function prefers the `referrals` row the referee's
 * own client may already have written, and resolves this code only when there isn't one yet (the
 * row is written on a save push after sign-in, which may not have happened by the time a keen
 * player taps PAY). Either way the referrer is resolved SERVER-side — a client-named referrer would
 * let anyone mint themselves a commission.
 */
export async function beginCheckout(): Promise<CheckoutResult> {
  try {
    // ⚠️ THE IDENTITY IS MINTED HERE, at the tap, and this is the whole "pay first" design in one
    // line. An entitlement has to attach to something durable, but making the player CREATE that
    // something first is a second wall in front of someone who has not yet seen a board — so a
    // silent anonymous account appears instead, and the email that makes it recoverable is taken
    // from the payment form they are about to fill in anyway (the webhook binds it).
    //
    // At the tap rather than at boot because every anonymous row is a monthly active user on the
    // bill: minting per visitor would price the game's traffic instead of its sales.
    //
    // Refusing when this fails is correct, however unhelpful it looks: taking money for an
    // entitlement with nothing to attach it to produces a charge we cannot honour and a player we
    // cannot identify, which is a refund at best and a chargeback at worst.
    if (!(await ensureAnonymousSession())) {
      return { ok: false, error: 'We couldn’t start checkout just now — please try again.' }
    }
    const c = await client()
    if (!c) return { ok: false, error: 'We couldn’t start checkout just now — please try again.' }
    const { data, error } = await c.functions.invoke('create-checkout', {
      body: {
        // Return to THIS origin. The game answers on two of them and storage does not cross
        // (see the two-origins note in CLAUDE.md) — sending a corrupt.solutions player back to
        // the Pages origin would land them signed out, looking at a paywall they just paid.
        // The function checks this against its own allowlist; it is a hint, never a trusted URL.
        return_url: window.location.href.split('#')[0],
        ref: stashedRefCode(),
      },
    })
    if (error || !data || typeof data !== 'object') {
      return { ok: false, error: 'Checkout is unavailable right now — please try again.' }
    }
    const url = (data as Record<string, unknown>).url
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return { ok: false, error: 'Checkout is unavailable right now — please try again.' }
    }
    window.location.assign(url)
    return { ok: true }
  } catch {
    return { ok: false, error: 'Checkout is unavailable right now — please try again.' }
  }
}

/**
 * True when this page load is the return leg from a completed Checkout (`?paid=1`, set as Stripe's
 * success_url by create-checkout). The paywall scene uses it to go straight into the "confirming
 * your payment" state instead of showing a price to someone who has just paid it.
 */
export function returningFromCheckout(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('paid') === '1'
  } catch {
    return false
  }
}

/**
 * Strip the checkout params out of the address bar once they have been consumed, so a reload — or a
 * PWA restoring its last URL — doesn't put the player back into the confirming state forever.
 * History-replace only; never navigates.
 */
export function clearCheckoutParams(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('paid') && !url.searchParams.has('cancelled')) return
    url.searchParams.delete('paid')
    url.searchParams.delete('cancelled')
    window.history.replaceState({}, '', url.toString())
  } catch {
    // best-effort only
  }
}

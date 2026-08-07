import { mergeSaves } from './merge'
import { coerceSave } from './save'

/**
 * ORIGIN MIGRATION — the game answers on TWO origins, and localStorage does not cross them.
 *
 *   https://corruptfun.github.io/viva-maya/    the legacy address (GitHub Pages, the original home)
 *   https://corrupt.solutions/games/viva-maya/ the canonical one — a Vercel reverse proxy in FRONT
 *                                              of that same Pages deployment, and what every invite
 *                                              link has minted since (view/invite.ts)
 *
 * Identical bytes, different origins — so a player has a separate save, device id, referral stash,
 * settings, PWA install and push subscription on each. Measured 2026-08-07: a friend's invite was
 * lost exactly this way (the `?ref=` code was captured in one storage context and the sign-in
 * happened in another), and analytics counts one human as two devices.
 *
 * ⚠️ WHY THIS IS CLIENT-SIDE AND NOT A REDIRECT. Because corrupt.solutions PROXIES Pages, a 3xx on
 * the Pages origin would be fetched and served by the proxy too — it would redirect the canonical
 * address to itself. Confirmed by headers: a corrupt.solutions response carries `server: Vercel`
 * AND GitHub's own `x-github-request-id` passed through. So the handoff lives in the bundle, which
 * both origins serve, and `handoffTarget` decides by HOSTNAME which copy is which.
 *
 * ⚠️ THE HOSTNAME GATE IS THE WHOLE SAFETY ARGUMENT. Get it wrong and the canonical origin
 * redirects to itself forever, taking down every player at once — strictly worse than the problem
 * being fixed. It is pinned by originmigrate.test.ts, and a sessionStorage latch bounds even a
 * wrong answer to one hop per tab.
 *
 * The legacy address must keep WORKING, not merely keep resolving: every refusal below leaves the
 * player exactly where they are, on a fully functional game, rather than stranding them.
 */

/** The legacy address. Early invite links still point here, and they must keep working. */
export const LEGACY_HOST = 'corruptfun.github.io'
/** The canonical address. Trailing slash is load-bearing — the proxy breaks relative assets without it. */
export const CANONICAL_URL = 'https://corrupt.solutions/games/viva-maya/'

/** The save blob (core/save.ts's own KEY, which is module-private there). */
const SAVE_KEY = 'viva-maya:v1'
/** Everything the player owns is namespaced under one of these two prefixes. */
const CARRIED_PREFIXES = ['viva-maya:', 'vm.'] as const
/**
 * Keys that describe the ORIGIN we are leaving rather than the player, and so must never ride
 * along. Both are per-tab/per-origin machinery whose meaning does not survive the hop.
 */
const NEVER_CARRY: ReadonlySet<string> = new Set(['viva-maya:auto-updated', 'viva-maya:origin-migrated'])

/**
 * The handoff travels in the URL FRAGMENT, never the query string: a fragment is not sent to the
 * server, so a player's save never lands in a Vercel or GitHub access log.
 */
const HANDOFF_KEY = 'vmfrom'

/** One hop per tab. A latch is what stops a mistake anywhere above from becoming a redirect loop. */
const LATCH_KEY = 'viva-maya:origin-migrated'

/**
 * Refuse to carry a payload past this. A URL this long is a portability risk (Safari is the tight
 * one), and the refusal is deliberately to STAY PUT rather than to hop without the payload —
 * arriving with an empty profile would cost an un-signed-in player everything.
 */
export const MAX_HANDOFF_CHARS = 30_000

export interface MigrateEnv {
  hostname: string
  /** True in an installed PWA, from display-mode or Apple's `navigator.standalone`. */
  standalone: boolean
  /** Preserved across the hop so an early `?ref=CODE` invite link survives it. */
  search: string
}

/**
 * Where should this page hand off to — or null to STAY. Pure, so the gate that could loop the whole
 * game is testable without a DOM.
 *
 * Refuses, in order: any hostname that is not the legacy one (the anti-loop rule, and the reason
 * the canonical origin never acts on this code at all); an installed PWA (navigating a standalone
 * window off its own scope ejects it into the browser on iOS, breaking the app the player
 * installed — they keep the legacy origin, which still works); and an oversized payload.
 */
export function handoffTarget(env: MigrateEnv, payload: string): string | null {
  if (env.hostname !== LEGACY_HOST) return null
  if (env.standalone) return null
  if (payload.length > MAX_HANDOFF_CHARS) return null
  return `${CANONICAL_URL}${env.search}#${HANDOFF_KEY}=${payload}`
}

/** Read the handoff payload out of a URL fragment, or null if there isn't one. */
export function readHandoff(hash: string): Record<string, string> | null {
  const marker = `${HANDOFF_KEY}=`
  const at = hash.indexOf(marker)
  if (at < 0) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(hash.slice(at + marker.length)))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // Re-check the prefix on the way IN as well as on the way out: the fragment is attacker-
      // reachable, and nothing outside the game's own namespace may be written to storage.
      if (typeof v === 'string' && !NEVER_CARRY.has(k) && CARRIED_PREFIXES.some(p => k.startsWith(p))) {
        out[k] = v
      }
    }
    return out
  } catch {
    return null // malformed / truncated fragment — arrive as a normal visit rather than throwing
  }
}

/**
 * Merge a handed-off profile into this origin's storage.
 *
 * TWO RULES, and they are what make a hostile fragment boring rather than dangerous:
 *   - a key that already exists here is NEVER overwritten, and
 *   - the save is combined with `mergeSaves`, which is MONOTONIC (furthest-progressed wins) —
 *     the same primitive the cloud merge uses.
 * So the worst a crafted link can do is fill in settings on a fresh profile or advance a save; it
 * can never destroy progress. There is deliberately no `document.referrer` check: a browser that
 * strips the referrer would silently cost a real player their save, which is a far worse outcome
 * than the low-severity nuisance the check would prevent.
 *
 * Returns the number of keys adopted.
 */
export function adoptHandoffInto(
  incoming: Record<string, string>,
  storage: Pick<Storage, 'getItem' | 'setItem'>
): number {
  let adopted = 0
  for (const [key, value] of Object.entries(incoming)) {
    try {
      const existing = storage.getItem(key)
      if (existing === null) {
        storage.setItem(key, value)
        adopted++
        continue
      }
      if (key !== SAVE_KEY) continue // never clobber this origin's own settings
      const merged = mergeSaves(coerceSave(JSON.parse(existing)), coerceSave(JSON.parse(value)))
      storage.setItem(key, JSON.stringify(merged))
      adopted++
    } catch {
      // one unparseable key must never abort the rest of the migration
    }
  }
  return adopted
}

/** Everything under the carried prefixes, minus the origin-local machinery. */
export function collectCarried(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (!key || NEVER_CARRY.has(key)) continue
      if (!CARRIED_PREFIXES.some(p => key.startsWith(p))) continue
      const value = storage.getItem(key)
      if (typeof value === 'string') out[key] = value
    }
  } catch {
    // storage unavailable — hand off nothing; handoffTarget still decides whether to move
  }
  return out
}

/** True at most once per tab. Spends the latch when it returns true. */
function claimHop(): boolean {
  try {
    if (sessionStorage.getItem(LATCH_KEY)) return false
    sessionStorage.setItem(LATCH_KEY, '1')
    return true
  } catch {
    return false // cannot record the hop → cannot bound a loop → do not hop
  }
}

/**
 * Boot hook for the CANONICAL origin: adopt a profile handed over from the legacy one, then strip
 * the fragment so a reload (or a shared URL) cannot replay it. Must run BEFORE anything reads the
 * save. No-ops everywhere else. Never throws.
 */
export function adoptHandoffFromUrl(): number {
  try {
    const incoming = readHandoff(window.location.hash)
    if (!incoming) return 0
    const adopted = adoptHandoffInto(incoming, localStorage)
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return adopted
  } catch {
    return 0
  }
}

/**
 * Boot hook for the LEGACY origin: carry this profile to the canonical address. Returns true when a
 * navigation has been started, so the caller can skip booting a game that is about to be discarded.
 * No-ops on every other hostname — including the canonical one, which is what makes this safe to
 * ship in a bundle that both origins serve. Never throws.
 */
export function migrateFromLegacyOrigin(): boolean {
  try {
    const env: MigrateEnv = {
      hostname: window.location.hostname,
      standalone:
        window.matchMedia?.('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true,
      search: window.location.search,
    }
    // Cheap gate first: on the canonical origin this returns immediately and never touches storage,
    // so the common case pays nothing and cannot spend the latch.
    if (env.hostname !== LEGACY_HOST) return false
    const payload = encodeURIComponent(JSON.stringify(collectCarried(localStorage)))
    const target = handoffTarget(env, payload)
    if (!target || !claimHop()) return false
    // replace(), not assign(): the legacy URL must not sit in history for Back to bounce off.
    window.location.replace(target)
    return true
  } catch {
    return false
  }
}

/**
 * The guard behind the SILENT service-worker update (wired in main.ts).
 *
 * WHY THIS EXISTS. The PWA runs in 'prompt' mode, so a new build sits in the WAITING state until
 * something applies it. Offering it as a toast was measured and found wanting (2026-08-07): 47
 * devices active over three days were spread across 13 distinct builds, only 6 on HEAD, with
 * devices running a bundle 12 commits old the same day. A prompt the player can decline forever is
 * not an update mechanism — and a stale bundle is not a cosmetic problem here, because migrations
 * ship on a two-phase rule that assumes clients eventually catch up.
 *
 * WHAT main.ts DOES WITH IT. A worker already waiting when the page loads means the player has just
 * opened the app and nothing is in progress, so it is applied without asking. A worker that goes
 * waiting mid-session means they are already playing, so that path still asks — levelresume only
 * snapshots a SETTLED board and endless is excluded from it entirely, so a forced reload mid-cascade
 * is a real loss of progress. This module owns only the "may we apply silently right now?" decision.
 *
 * ⚠️ THE FAILURE MODE THIS PREVENTS is worse than the staleness it cures: a worker that installs but
 * never takes control would, without a latch, be re-applied on every load and spin the app in a
 * reload loop with no way out on the player's side. Hence a latch that is spent on the way IN, and
 * that deliberately survives the very reload it authorises.
 */

/**
 * How long after page load a waiting worker may be applied WITHOUT asking. Registration normally
 * resolves in well under a second; the window exists so that a slow cold start cannot turn the
 * silent update into a reload under a player who has already started tapping. Past it, main.ts
 * falls back to the visible toast.
 */
export const AUTO_UPDATE_WINDOW_MS = 6_000

/** How long to wait for a silent apply to actually reload before falling back to the toast. */
export const AUTO_UPDATE_FALLBACK_MS = 4_000

/**
 * sessionStorage on purpose, and this is the load-bearing choice: it SURVIVES the reload it causes
 * (which is what makes it a loop breaker rather than a no-op) and dies with the tab (so the next
 * cold launch is free to update again).
 */
const AUTO_UPDATE_KEY = 'viva-maya:auto-updated'

/**
 * May this page apply a waiting worker silently, right now? True at most ONCE per tab, and only
 * inside the boot window. SPENDS the latch when it returns true — call it exactly where the update
 * is about to be applied, never as a speculative check.
 *
 * `elapsedMs` is injected so the window is testable; production passes `performance.now()`.
 * Returns false whenever storage is unavailable: a loop we cannot break is never worth the update.
 */
export function claimAutoUpdate(elapsedMs: number): boolean {
  if (!(elapsedMs <= AUTO_UPDATE_WINDOW_MS)) return false // NaN-safe: an unusable clock asks instead
  try {
    if (sessionStorage.getItem(AUTO_UPDATE_KEY)) return false
    sessionStorage.setItem(AUTO_UPDATE_KEY, '1')
    return true
  } catch {
    return false // storage blocked / full → fall back to the toast
  }
}

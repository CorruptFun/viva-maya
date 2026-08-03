/**
 * "Add to home screen" — the install custody layer. Pure logic (no Phaser, no DOM writes); the sheet
 * that renders this lives in view/installsheet.ts, mirroring core/daily.ts ↔ SlotScene.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The first week of analytics: **5 of 60 real players were running installed** (`app_open` with
 * `props.standalone = true`). Installing is not a nice-to-have here — on iOS it is the *only* way a
 * player can ever receive a web push (see core/push.ts), so the entire daily-race callback loop is
 * gated behind an action almost nobody was taking, and nothing in the game had ever explained it.
 *
 * Until now `beforeinstallprompt` was listened to PASSIVELY in main.ts, for analytics only, with an
 * explicit warning not to `preventDefault()` it: capturing the event suppresses the browser's own
 * install affordance, so capturing it *without* offering a replacement button would have made
 * installing strictly harder. That warning named its own release condition — build the button — and
 * this module plus view/installsheet.ts is that button. main.ts now captures.
 *
 * ── THE PLATFORM SPLIT, WHICH IS THE WHOLE DESIGN ────────────────────────────
 * There is no single "install" API, and pretending otherwise is what makes install UX bad:
 *
 *   • **Chromium (Android, desktop Chrome/Edge)** fires `beforeinstallprompt`. Stash it and a later
 *     `.prompt()` from a user gesture is a genuine ONE-TAP install. This is the real thing.
 *   • **iOS/iPadOS Safari** has NO install API whatsoever, and never has. Apple exposes no way to
 *     trigger, detect-as-available, or even feature-detect the Add to Home Screen flow. The only
 *     honest answer is a clear illustrated instruction — which is exactly the case the owner
 *     identified ("people don't do it because they don't know how"). We cannot make iOS one-tap. We
 *     CAN make it three taps that a player can actually follow, tailored to the browser they are in.
 *   • **Everything else** (Firefox, and iOS browsers we can't script) gets no promise at all.
 *
 * Never throws: every export is wrapped or total, per the house contract shared with core/cloud.ts,
 * core/analytics.ts and core/push.ts. A browser that supports none of this reports 'unavailable' and
 * the game behaves exactly as it did before.
 */

/** The captured Chromium prompt. Not in the TS DOM lib, so it is typed here. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallState =
  /** Already running from the home screen — nothing to offer. */
  | 'installed'
  /** A real one-tap install is available right now (Chromium prompt captured). */
  | 'ready'
  /** iOS: no API exists; the sheet must teach Share → Add to Home Screen. */
  | 'manual-ios'
  /** No install path we can drive or describe accurately. */
  | 'unavailable'

/** Which iOS browser we're in — the Add to Home Screen gesture differs, and a wrong diagram is worse
 *  than none. Safari puts Share in the bottom bar; Chrome/Edge on iOS hide it behind ⋯ / •••. */
export type IosBrowser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'other'

let captured: BeforeInstallPromptEvent | null = null
let onChange: (() => void) | null = null

/**
 * Start capturing. Called once from main.ts at module scope — `beforeinstallprompt` fires within
 * moments of load, so anything sequenced behind the cloud bootstrap would miss it.
 *
 * `preventDefault()` is now correct BECAUSE the game offers its own button; see the module header.
 */
export function initInstallCapture(): void {
  try {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault() // suppress the browser bar — view/installsheet.ts replaces it
      captured = e as BeforeInstallPromptEvent
      onChange?.()
    })
    // The prompt is single-use and dies with the install; drop it so state flips to 'installed'.
    window.addEventListener('appinstalled', () => {
      captured = null
      onChange?.()
    })
  } catch {
    // no addEventListener (impossible in practice) — stay 'unavailable'
  }
}

/** Notify the UI when custody changes (prompt arrives late, or the install completes). */
export function onInstallStateChange(fn: (() => void) | null): void {
  onChange = fn
}

/** True when running as an installed / standalone PWA. Mirrors view/installnudge.ts's local copy. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
    // iOS Safari's own non-standard flag — the ONLY signal on iOS, where display-mode is unreliable.
    if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) return true
  } catch {
    // matchMedia unsupported — treat as a normal browser tab
  }
  return false
}

/**
 * iOS/iPadOS detection. ⚠️ iPadOS 13+ deliberately reports itself as "Macintosh" in the UA — the
 * touch-point check is what catches it, and without that every iPad silently falls to 'unavailable'
 * and is never taught the one gesture it needs.
 */
export function isIos(): boolean {
  try {
    const ua = navigator.userAgent || ''
    if (/iPhone|iPad|iPod/i.test(ua)) return true
    return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
  } catch {
    return false
  }
}

/** Which iOS browser — drives which diagram the sheet draws. Order matters: every iOS browser's UA
 *  also contains "Safari", so the branded tokens must be tested first. */
export function iosBrowser(): IosBrowser {
  try {
    const ua = navigator.userAgent || ''
    if (/CriOS/i.test(ua)) return 'chrome'
    if (/EdgiOS/i.test(ua)) return 'edge'
    if (/FxiOS/i.test(ua)) return 'firefox'
    if (/Safari/i.test(ua)) return 'safari'
    return 'other'
  } catch {
    return 'other'
  }
}

/** What the game can offer this player right now. */
export function installState(): InstallState {
  if (isStandalone()) return 'installed'
  if (captured) return 'ready'
  if (isIos()) return 'manual-ios'
  return 'unavailable'
}

/** True when there is anything worth showing a player — the gate for every entry point. */
export function canOfferInstall(): boolean {
  const s = installState()
  return s === 'ready' || s === 'manual-ios'
}

/**
 * Fire the real one-tap install. Chromium only — resolves 'unsupported' anywhere else, so callers
 * never branch on platform themselves.
 *
 * ⚠️ Must be called from inside a user gesture or the browser rejects it. And the prompt is
 * SINGLE-USE: whatever the outcome, the captured event is spent and cannot be re-prompted, so a
 * dismissal correctly returns the player to 'unavailable' rather than to a button that silently
 * does nothing on the second tap.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unsupported'> {
  const evt = captured
  if (!evt) return 'unsupported'
  captured = null // spent either way — see above
  try {
    await evt.prompt()
    const { outcome } = await evt.userChoice
    onChange?.()
    return outcome === 'accepted' ? 'accepted' : 'dismissed'
  } catch {
    onChange?.()
    return 'dismissed'
  }
}

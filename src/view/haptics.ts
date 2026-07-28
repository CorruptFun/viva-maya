/**
 * §G5 · Haptics.
 *
 * The scene calls `vibrate(...)` at every impact beat — a bomb, a MEGA finish, a win, a jackpot
 * strike. All of it went through `navigator.vibrate`, which **iOS Safari does not implement**, so on
 * the one device this PWA is actually installed to (see README: "on iPhone: Share → Add to Home
 * Screen") every haptic in the game was a silent no-op, and the visual + audio layers were carrying
 * the whole tactile load alone.
 *
 * There is no Web Vibration API on iOS and there is no sign of one coming. The only mechanism that
 * reaches Taptic from Safari is the **switch control**: since iOS 17.4, toggling an
 * `<input type="checkbox" switch>` plays the system switch haptic. So on iOS we keep a hidden switch
 * and flip it. That buys exactly one flavour of tap — no duration, no intensity — so a pattern is
 * rendered as its BURST COUNT (a `[80, 50, 120]` two-pulse pattern becomes two taps at the pattern's
 * own gaps), which preserves the rhythm that carries most of the meaning even though the weight is
 * lost.
 *
 * ⚠️ UNVERIFIED ON HARDWARE. This was written and reasoned about on a Mac; nobody has yet felt it on
 * an iPhone. It is built so that being wrong is free — every path is feature-detected, wrapped, and
 * falls back to doing nothing. If it turns out not to fire, the thing to check first is whether the
 * synthetic `.click()` counts as user activation for the haptic (it may need to happen inside the
 * real pointer event, in which case the call sites are already correct — they all run from input
 * handlers — but the element may need to be genuinely visible rather than clipped).
 *
 * Android/desktop Chrome keep the real `navigator.vibrate` path, which is strictly better.
 */

type Mode = 'vibrate' | 'switch' | 'none'

let mode: Mode | null = null
let toggle: HTMLInputElement | null = null

/** Max taps we will fire for one pattern — a long pattern must not turn into a burst of chatter. */
const MAX_TAPS = 4

/**
 * `switch` is a content attribute with no IDL reflection, so there is no property to feature-detect.
 * Setting it and asking the UA whether the control still reports as a checkbox is not conclusive
 * either. Rather than sniff, we build the element whenever `navigator.vibrate` is absent: on a
 * browser that ignores `switch` entirely the click is a no-op on a hidden checkbox, which costs
 * nothing and breaks nothing.
 */
function ensureToggle(): HTMLInputElement | null {
  if (toggle) return toggle
  if (typeof document === 'undefined') return null
  try {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.setAttribute('switch', '')
    // Clipped rather than `display:none`/`hidden`: a display-none control is not rendered, and an
    // unrendered control is the most likely reason for the haptic not to fire. This keeps it laid
    // out and hit-testable while being invisible and outside the tab order.
    el.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;margin:0;padding:0;border:0;'
    el.tabIndex = -1
    el.setAttribute('aria-hidden', 'true')
    document.body.appendChild(el)
    toggle = el
    return el
  } catch {
    return null
  }
}

function detect(): Mode {
  if (mode) return mode
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') mode = 'vibrate'
    else mode = ensureToggle() ? 'switch' : 'none'
  } catch {
    mode = 'none'
  }
  return mode
}

/** One system tap via the switch control. Swallows everything — a haptic must never break a frame. */
function tap(): void {
  try {
    const el = toggle ?? ensureToggle()
    if (!el) return
    el.checked = !el.checked
    el.click()
  } catch {
    // no haptic available — the game just runs without it
  }
}

/**
 * Play a vibration pattern. Accepts the same shape as `navigator.vibrate`: a duration, or an
 * alternating [pulse, gap, pulse, …] pattern.
 */
export function vibratePattern(pattern: number | number[]): void {
  switch (detect()) {
    case 'vibrate':
      try {
        navigator.vibrate?.(pattern)
      } catch {
        // some UAs throw when the page is not visible / user hasn't interacted
      }
      return
    case 'switch': {
      if (typeof pattern === 'number') {
        tap()
        return
      }
      // Even indices are pulses, odd are gaps — replay the pulses at their own offsets so the
      // RHYTHM of a `[70,40,90,40,160]` MEGA pattern survives even though the durations cannot.
      let at = 0
      let fired = 0
      for (let i = 0; i < pattern.length && fired < MAX_TAPS; i++) {
        if (i % 2 === 0) {
          if (at === 0) tap()
          else setTimeout(tap, at)
          fired++
        }
        at += Math.max(0, pattern[i])
      }
      return
    }
    default:
      return
  }
}

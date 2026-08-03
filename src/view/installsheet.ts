// ─────────────────────────────────────────────────────────────────────────────
// ADD TO HOME SCREEN — the sheet. DOM, not Phaser, and that is a design decision rather than a
// convenience: on iOS the instruction has to point at the browser's OWN Share button, which lives
// in native chrome outside the canvas. A Phaser panel can only describe it; a DOM sheet can sit at
// the bottom of the viewport with an arrow aimed at the real thing.
//
// Two modes, decided by core/install.ts (see its header for the platform split):
//   • 'ready'      → one gold button. A genuine one-tap Chromium install.
//   • 'manual-ios' → the three-step gesture, tailored to the actual iOS browser, because Safari and
//                    Chrome-on-iOS hide Share in different places and a wrong diagram is worse
//                    than none.
//
// Mirrors view/installnudge.ts's DOM idioms (fixed overlay, inline cssText, safe-area insets,
// scene-tied teardown) so the two never look like they came from different apps.
// ─────────────────────────────────────────────────────────────────────────────

import type Phaser from 'phaser'
import { EVENTS, track } from '../core/analytics'
import { iosBrowser, installState, promptInstall } from '../core/install'
import type { IosBrowser } from '../core/install'

// ⚠️ INVARIANT for the `innerHTML` calls below: every string assigned to innerHTML in this file is a
// MODULE-LOCAL LITERAL — the step copy and the two inline SVG glyphs, all written above. No save
// data, no user input, no network response, and no URL parameter is ever interpolated into them.
// innerHTML is used only because the steps carry <b> emphasis and an inline <svg>, which textContent
// would render as visible tag soup. If a future edit needs to put a *dynamic* value in a step, use
// textContent for that fragment and append it — do not template it into the literal.
const SHEET_ID = 'vm-install-sheet'

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const CREAM = '#fffdf7'
const INK = '#3c3527'
const MUTED = '#6a6459'
const GOLD = '#d18a00'

/** The iOS Share glyph, drawn rather than described — a player scanning for a shape finds it faster
 *  than one reading the word "Share". Inline SVG so it inherits colour and needs no asset. */
function shareGlyph(size = 19): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px">' +
    '<path d="M12 15V3"/><path d="M8 7l4-4 4 4"/>' +
    '<path d="M20 14v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5"/></svg>'
  )
}

/** The ⋯ / ••• overflow glyph used by Chrome and Edge on iOS. */
function moreGlyph(size = 19): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" style="vertical-align:-4px">` +
    '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>'
  )
}

/**
 * The per-browser gesture. Returns the steps AND where the control physically is, because "tap
 * Share" is useless without "at the bottom" — the single most common reason a player gives up.
 */
function iosSteps(browser: IosBrowser): { steps: string[]; foot: string } {
  const share = shareGlyph()
  const more = moreGlyph()
  switch (browser) {
    case 'chrome':
      return {
        steps: [
          `Tap ${more} in the address bar, top right`,
          'Choose <b>Add to Home Screen</b>',
          'Tap <b>Add</b> — done',
        ],
        foot: 'In Chrome the menu is the three dots beside the address bar.',
      }
    case 'edge':
      return {
        steps: [`Tap ${more} at the bottom`, 'Choose <b>Add to Home Screen</b>', 'Tap <b>Add</b> — done'],
        foot: 'In Edge the menu is the three dots in the bottom bar.',
      }
    case 'firefox':
      return {
        steps: [`Tap ${more} at the bottom right`, 'Choose <b>Share</b>, then <b>Add to Home Screen</b>', 'Tap <b>Add</b> — done'],
        foot: 'Firefox tucks Add to Home Screen inside the Share menu.',
      }
    default:
      // Safari, and anything we can't identify — Safari's is the flow the overwhelming majority hit.
      return {
        steps: [
          `Tap ${share} <b>Share</b> at the bottom of the screen`,
          'Scroll down, choose <b>Add to Home Screen</b>',
          'Tap <b>Add</b> — done',
        ],
        foot: 'The Share button is in Safari’s bottom bar, not on this page.',
      }
  }
}

/** Close any open sheet. Safe to call repeatedly. */
export function closeInstallSheet(): void {
  const el = document.getElementById(SHEET_ID)
  if (!el) return
  el.style.opacity = '0'
  window.setTimeout(() => el.remove(), 260)
}

/**
 * Open the sheet. `scene` (optional) ties teardown to a Phaser scene so the sheet can never outlive
 * the screen that opened it. Returns false and does nothing when there is no install path to offer,
 * so callers can use it as their own gate.
 */
export function openInstallSheet(scene?: Phaser.Scene, source = 'unknown'): boolean {
  const state = installState()
  if (state !== 'ready' && state !== 'manual-ios') return false
  if (document.getElementById(SHEET_ID)) return true

  track(EVENTS.INSTALL_SHEET, { source, mode: state })

  const wrap = document.createElement('div')
  wrap.id = SHEET_ID
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483100;display:flex;align-items:flex-end;justify-content:center;' +
    'background:rgba(42,36,23,0.62);opacity:0;transition:opacity .26s ease;' +
    `font-family:${SANS};padding:16px;box-sizing:border-box`

  const card = document.createElement('div')
  card.style.cssText =
    `width:100%;max-width:430px;box-sizing:border-box;background:${CREAM};border:1px solid #f0e6cf;` +
    'border-radius:20px;padding:20px 20px calc(18px + env(safe-area-inset-bottom,0px));' +
    'box-shadow:0 -8px 40px rgba(60,45,10,0.34);transform:translateY(14px);transition:transform .28s ease'

  const h = document.createElement('div')
  h.innerHTML = 'Put Viva Maya on your home screen'
  h.style.cssText = `font-size:19px;font-weight:900;color:${GOLD};margin-bottom:6px;line-height:1.25`

  const why = document.createElement('div')
  // Concrete, not marketing: these are the two things installing actually changes for the player.
  why.innerHTML =
    'It opens full screen like a real app, works offline, and it’s the only way to get a nudge when the daily race resets.'
  why.style.cssText = `font-size:14px;line-height:1.45;color:${MUTED};margin-bottom:16px`

  card.append(h, why)

  const done = (): void => closeInstallSheet()

  if (state === 'ready') {
    // ── One tap. The whole point. ──
    const cta = document.createElement('button')
    cta.type = 'button'
    cta.textContent = 'Add to Home Screen'
    cta.style.cssText =
      'display:block;width:100%;appearance:none;border:0;cursor:pointer;min-height:52px;padding:14px 18px;' +
      `border-radius:14px;background:${GOLD};color:#fff;font-family:${SANS};font-size:17px;font-weight:900`
    cta.addEventListener('click', () => {
      cta.disabled = true
      cta.textContent = 'Opening…'
      void promptInstall().then(outcome => {
        track(EVENTS.INSTALL_RESULT, { outcome, source })
        done()
      })
    })
    card.append(cta)
  } else {
    // ── iOS: teach the gesture. ──
    const { steps, foot } = iosSteps(iosBrowser())
    const ol = document.createElement('ol')
    ol.style.cssText = `margin:0 0 14px;padding:0;list-style:none;color:${INK}`
    steps.forEach((s, i) => {
      const li = document.createElement('li')
      li.style.cssText =
        'display:flex;align-items:flex-start;gap:11px;font-size:15px;line-height:1.5;padding:8px 0;' +
        (i < steps.length - 1 ? 'border-bottom:1px solid #f2ead8' : '')
      const n = document.createElement('span')
      n.textContent = String(i + 1)
      n.style.cssText =
        `flex:0 0 auto;width:23px;height:23px;border-radius:50%;background:${GOLD};color:#fff;` +
        'font-size:13px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:1px'
      const t = document.createElement('span')
      t.innerHTML = s
      t.style.cssText = 'flex:1 1 auto'
      li.append(n, t)
      ol.append(li)
    })
    const note = document.createElement('div')
    note.textContent = foot
    note.style.cssText = `font-size:12.5px;line-height:1.4;color:${MUTED};margin-bottom:14px`

    const ok = document.createElement('button')
    ok.type = 'button'
    ok.textContent = 'Got it'
    ok.style.cssText =
      'display:block;width:100%;appearance:none;border:0;cursor:pointer;min-height:50px;padding:13px 18px;' +
      `border-radius:14px;background:${GOLD};color:#fff;font-family:${SANS};font-size:16px;font-weight:900`
    ok.addEventListener('click', () => {
      track(EVENTS.INSTALL_RESULT, { outcome: 'guided', source })
      done()
    })
    card.append(ol, note, ok)
  }

  const dismiss = document.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = 'Not now'
  dismiss.style.cssText =
    `display:block;width:100%;appearance:none;border:0;background:transparent;cursor:pointer;color:${MUTED};` +
    `font-family:${SANS};font-size:14px;font-weight:700;padding:12px 0 2px;margin-top:4px`
  dismiss.addEventListener('click', () => {
    track(EVENTS.INSTALL_RESULT, { outcome: 'not_now', source })
    done()
  })
  card.append(dismiss)

  // Tap-outside closes, matching the Phaser panels' §E3 B14 behaviour.
  wrap.addEventListener('click', e => {
    if (e.target === wrap) {
      track(EVENTS.INSTALL_RESULT, { outcome: 'scrim', source })
      done()
    }
  })

  wrap.append(card)
  document.body.append(wrap)
  requestAnimationFrame(() => {
    wrap.style.opacity = '1'
    card.style.transform = 'translateY(0)'
  })

  scene?.events.once('shutdown', closeInstallSheet)
  scene?.events.once('sleep', closeInstallSheet)
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OFFER — a small Home banner, because a sheet nobody opens is a sheet nobody installs from.
// Same self-limiting discipline as view/installnudge.ts: at most once per launch, a few launches
// total, and gone for good once acted on or dismissed.
// ─────────────────────────────────────────────────────────────────────────────

const OFFER_ID = 'vm-install-offer'
const OFFER_KEY = 'viva-maya:install-offer' // device-local UI latch, deliberately NOT in the synced save
const MAX_OFFERS = 4

let offeredThisSession = false

/** True while either install surface is on screen — the sign-in nudge checks this so two banners
 *  can never stack at the bottom of Home. */
export function installUiOpen(): boolean {
  return !!document.getElementById(OFFER_ID) || !!document.getElementById(SHEET_ID)
}

function offerState(): string {
  try {
    return localStorage.getItem(OFFER_KEY) ?? ''
  } catch {
    return 'done' // storage blocked (private mode) → never nag
  }
}

/**
 * Offer the install if it's genuinely available and not intrusive. Safe to call on every Home entry.
 *
 * Deliberately NOT gated on progress the way view/installnudge.ts is. That nudge protects existing
 * progress, so it waits until there is some; this one is about the shape of the whole experience
 * (full screen, offline, and the only route to a push on iOS), and it is most useful *before* a
 * player has built up a browser-tab save that installing would strand.
 */
/**
 * ⚠️ Returns whether it CLAIMED the slot, and callers must branch on the return value rather than on
 * `installUiOpen()`. The banner mounts on a delay, so the DOM is still empty the instant this
 * returns — checking `installUiOpen()` immediately after would always say "free" and let a second
 * banner schedule underneath this one. The claim has to be synchronous even though the mount is not.
 */
export function maybeShowInstallOffer(scene: Phaser.Scene): boolean {
  if (offeredThisSession) return false
  const state = installState()
  if (state !== 'ready' && state !== 'manual-ios') return false // installed, or nothing honest to offer

  const seen = offerState()
  if (seen === 'done') return false
  const shows = Number.parseInt(seen, 10) || 0
  if (shows >= MAX_OFFERS) return false

  offeredThisSession = true
  scene.time.delayedCall(1800, () => {
    if (document.getElementById(OFFER_ID) || document.getElementById(SHEET_ID)) return
    try {
      localStorage.setItem(OFFER_KEY, String(shows + 1))
    } catch {
      // best-effort only
    }
    mountOffer(scene, state)
  })
  return true
}

function mountOffer(scene: Phaser.Scene, mode: 'ready' | 'manual-ios'): void {
  const bar = document.createElement('div')
  bar.id = OFFER_ID
  bar.style.cssText =
    'position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:2147483000;' +
    'width:calc(100vw - 28px);max-width:400px;box-sizing:border-box;display:flex;align-items:center;gap:11px;' +
    `padding:13px 14px;border-radius:16px;background:${CREAM};border:1px solid #f0e6cf;` +
    `box-shadow:0 12px 34px rgba(60,45,10,0.28);font-family:${SANS};` +
    'opacity:0;transform:translateX(-50%) translateY(10px);transition:opacity .28s ease, transform .28s ease;'

  const icon = document.createElement('div')
  icon.textContent = '📲'
  icon.style.cssText = 'font-size:26px;line-height:1;flex:0 0 auto'

  const col = document.createElement('div')
  col.style.cssText = 'flex:1 1 auto;min-width:0'
  const title = document.createElement('div')
  title.textContent = 'Add to your home screen'
  title.style.cssText = `font-size:14px;font-weight:800;color:${GOLD};margin-bottom:2px`
  const body = document.createElement('div')
  // Honest per platform: promising "one tap" on iOS, where no install API exists, would be a lie the
  // very next screen exposes.
  body.textContent =
    mode === 'ready'
      ? 'One tap — opens full screen, works offline.'
      : 'Takes three taps — opens full screen, works offline.'
  body.style.cssText = `font-size:13px;line-height:1.4;color:${MUTED}`
  col.append(title, body)

  const cta = document.createElement('button')
  cta.type = 'button'
  cta.textContent = mode === 'ready' ? 'Add' : 'Show me'
  cta.style.cssText =
    'flex:0 0 auto;appearance:none;border:0;cursor:pointer;min-height:40px;padding:9px 16px;border-radius:12px;' +
    `background:${GOLD};color:#fff;font-family:${SANS};font-size:14px;font-weight:800`

  const close = document.createElement('button')
  close.type = 'button'
  close.setAttribute('aria-label', 'Dismiss')
  close.textContent = '×'
  close.style.cssText =
    `flex:0 0 auto;appearance:none;border:0;background:transparent;cursor:pointer;color:${MUTED};` +
    'font-size:22px;line-height:1;width:26px;height:36px;padding:0'

  const remove = (): void => {
    bar.style.opacity = '0'
    bar.style.transform = 'translateX(-50%) translateY(10px)'
    window.setTimeout(() => bar.remove(), 300)
  }
  const setDone = (): void => {
    try {
      localStorage.setItem(OFFER_KEY, 'done')
    } catch {
      // best-effort only
    }
  }

  cta.addEventListener('click', () => {
    setDone() // acted on → the sheet takes over from here
    remove()
    openInstallSheet(scene, 'home_banner')
  })
  close.addEventListener('click', () => {
    setDone()
    track(EVENTS.INSTALL_RESULT, { outcome: 'banner_dismissed', source: 'home_banner' })
    remove()
  })

  bar.append(icon, col, cta, close)
  document.body.append(bar)
  requestAnimationFrame(() => {
    bar.style.opacity = '1'
    bar.style.transform = 'translateX(-50%) translateY(0)'
  })

  scene.events.once('shutdown', remove)
  scene.events.once('sleep', remove)
  scene.time.delayedCall(14000, remove)
}

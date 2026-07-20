// ─────────────────────────────────────────────────────────────────────────────
// Install onboarding nudge (DOM, not Phaser). A gentle, one-off bottom banner shown to a player who
// is (a) in a REGULAR browser tab — not an installed/standalone PWA, (b) NOT signed in, and (c) has
// real progress worth protecting. It invites them to save/sync BEFORE they add the game to their home
// screen, because an installed iOS PWA gets its OWN storage separate from Safari — so un-synced browser
// progress wouldn't automatically follow them into the installed app.
//
// Deliberately gentle: at most once per app launch, at most a few launches total, and it stops for good
// the instant the player either taps it or dismisses it. Never shown once signed in or once installed.
// ─────────────────────────────────────────────────────────────────────────────

import type Phaser from 'phaser'
import { cloudSession } from '../core/cloud'
import { loadSave } from '../core/save'
import { openCloudModal } from './cloudmodal'

const BANNER_ID = 'vm-install-nudge'
const SEEN_KEY = 'viva-maya:install-nudge' // device-local UI latch — deliberately NOT part of the synced save
const MAX_SHOWS = 3

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const CREAM = '#fffdf8'
const MUTED = '#6a6459'
const GOLD = '#c9930a'

let shownThisSession = false

/** True when running as an installed / standalone PWA (iOS `navigator.standalone` or display-mode). */
function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
    if ((window.navigator as unknown as { standalone?: boolean }).standalone === true) return true
  } catch {
    // matchMedia unsupported — treat as a normal browser tab
  }
  return false
}

function seenState(): string {
  try {
    return localStorage.getItem(SEEN_KEY) ?? ''
  } catch {
    return 'done' // storage blocked (private mode) → never nag
  }
}
function setSeen(v: string): void {
  try {
    localStorage.setItem(SEEN_KEY, v)
  } catch {
    // best-effort only
  }
}

/**
 * Show the install/save nudge if — and only if — it's genuinely useful and not intrusive. Safe to call
 * on every Home entry; it self-limits. `scene` ties the banner's lifetime to the Home scene, so it
 * clears itself the instant the player starts a level or navigates away.
 */
export function maybeShowInstallNudge(scene: Phaser.Scene): void {
  if (shownThisSession) return
  if (isStandalone()) return // already installed → no browser↔app storage gap to warn about
  if (cloudSession()) return // already signed in → progress already syncs

  const state = seenState()
  if (state === 'done') return
  const shows = Number.parseInt(state, 10) || 0
  if (shows >= MAX_SHOWS) return

  // Only nudge a player with real progress to protect — never a brand-new one on their first minute.
  const save = loadSave()
  const hasProgress = save.unlocked >= 3 || save.best > 0 || save.chips > 0
  if (!hasProgress) return

  shownThisSession = true // set at schedule time so rapid Home re-entries can't double-schedule

  // Appear a gentle beat after Home settles (never jarring on entry). Tied to the scene clock, so if the
  // player leaves Home before it fires, Phaser cancels it and the banner simply never shows.
  scene.time.delayedCall(2200, () => {
    if (document.getElementById(BANNER_ID)) return
    setSeen(String(shows + 1))
    mount(scene)
  })
}

function mount(scene: Phaser.Scene): void {
  const bar = document.createElement('div')
  bar.id = BANNER_ID
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
  title.textContent = 'Save your progress'
  title.style.cssText = `font-size:14px;font-weight:800;color:${GOLD};margin-bottom:2px`
  const body = document.createElement('div')
  body.textContent = 'Sign in or back it up so it follows you when you add Viva Maya to your home screen.'
  body.style.cssText = `font-size:13px;line-height:1.4;color:${MUTED}`
  col.append(title, body)

  const cta = document.createElement('button')
  cta.type = 'button'
  cta.textContent = 'Save'
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
  const done = (): void => {
    setSeen('done') // acted on or dismissed → never show again
    remove()
  }
  cta.addEventListener('click', () => {
    done()
    openCloudModal()
  })
  close.addEventListener('click', done)

  bar.append(icon, col, cta, close)
  document.body.append(bar)
  requestAnimationFrame(() => {
    bar.style.opacity = '1'
    bar.style.transform = 'translateX(-50%) translateY(0)'
  })

  // Clear the banner the moment the player leaves Home (starts a level, etc.) so it never overlaps
  // gameplay; also auto-dismiss after a while if they just idle on Home. Multiple remove() calls are safe.
  scene.events.once('shutdown', remove)
  scene.events.once('sleep', remove)
  scene.time.delayedCall(14000, remove)
}

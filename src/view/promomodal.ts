// ─────────────────────────────────────────────────────────────────────────────
// "Enter a code" modal (DOM, not Phaser) — mirrors cloudmodal.ts: a warm cream
// overlay appended to document.body ABOVE the WebGL canvas, framework-free (plain
// DOM + inline styles, no assets). Opened from the Gift Store's REDEEM pill. The
// player types a code you handed out; core/promo.redeemCode validates it server-
// side and grants the reward, and the panel celebrates or explains the failure.
// ─────────────────────────────────────────────────────────────────────────────

import { redeemCode, reasonMessage, rewardLabel } from '../core/promo'
import type { PromoReward } from '../core/types'

const MODAL_ID = 'vm-promo-modal'

// Warm palette (mirrors the game's cream card + gold accents), kept local so the modal is self-contained.
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const CREAM = '#fffdf8'
const INK = '#4a3305'
const MUTED = '#6a6459'
const GOLD = '#c9930a'
const BORDER = '#e6dcc4'
const ERR = '#c0392b'
const GOOD = '#2e7d32'

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  text?: string
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  Object.assign(el.style, style)
  if (text !== undefined) el.textContent = text
  return el
}

export interface PromoModalOpts {
  /** Called after a successful redeem so the Store can pop the balance + celebrate. */
  onRedeemed?: (reward: PromoReward, balance: number) => void
}

/**
 * Open the "Enter a code" modal. Idempotent (a second tap while open no-ops). Everything is torn
 * down on close, including the Escape-key handler. Never throws.
 */
export function openPromoModal(opts: PromoModalOpts = {}): void {
  if (document.getElementById(MODAL_ID)) return

  const scrim = mk('div', {
    position: 'fixed', inset: '0', zIndex: '10000',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '20px', background: 'rgba(40,28,4,0.5)', boxSizing: 'border-box',
    fontFamily: SANS,
  })
  scrim.id = MODAL_ID

  const panel = mk('div', {
    position: 'relative', width: '100%', maxWidth: '360px', boxSizing: 'border-box',
    background: CREAM, border: `1px solid ${BORDER}`, borderRadius: '18px',
    padding: '22px 20px 20px', boxShadow: '0 18px 50px rgba(40,28,4,0.35)',
    display: 'flex', flexDirection: 'column', gap: '12px',
  })

  const close = mk('button', {
    position: 'absolute', top: '10px', right: '12px', width: '38px', height: '38px',
    border: 'none', borderRadius: '10px', background: 'transparent', color: MUTED,
    fontFamily: SANS, fontSize: '22px', lineHeight: '1', cursor: 'pointer',
  }, '✕')
  close.type = 'button'

  const heading = mk('div', {
    margin: '0', fontFamily: SANS, fontSize: '13px', fontWeight: '800',
    letterSpacing: '0.8px', textTransform: 'uppercase', color: GOLD,
  }, 'Enter a code')
  const title = mk('div', { margin: '0', fontSize: '24px', fontWeight: '800', color: INK }, 'Got a reward code?')
  const note = mk('p', { margin: '0', fontSize: '14px', lineHeight: '1.5', color: MUTED },
    'Type a code you were given to claim chips, hearts, or a boost.')

  const input = mk('input', {
    display: 'block', width: '100%', minHeight: '48px', padding: '12px 14px',
    border: `2px solid ${BORDER}`, borderRadius: '12px', background: '#fffef9', color: INK,
    fontFamily: SANS, fontSize: '20px', fontWeight: '700', letterSpacing: '3px',
    textTransform: 'uppercase', textAlign: 'center', boxSizing: 'border-box', outline: 'none',
  })
  input.type = 'text'
  input.placeholder = 'CODE'
  input.maxLength = 16
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('autocapitalize', 'characters')
  input.setAttribute('inputmode', 'text')
  input.addEventListener('focus', () => { input.style.borderColor = GOLD })
  input.addEventListener('blur', () => { input.style.borderColor = BORDER })

  const redeem = mk('button', {
    display: 'block', width: '100%', minHeight: '48px', padding: '12px 16px',
    border: 'none', borderRadius: '12px', background: GOLD, color: '#ffffff',
    fontFamily: SANS, fontSize: '16px', fontWeight: '800', cursor: 'pointer',
    boxSizing: 'border-box', letterSpacing: '0.5px',
  }, 'REDEEM')
  redeem.type = 'button'

  // Feedback line (hidden until there's something to say). Colour set per message.
  const feedback = mk('p', {
    margin: '2px 0 0', minHeight: '18px', fontSize: '14px', fontWeight: '700',
    textAlign: 'center', color: MUTED,
  }, '')

  panel.append(close, heading, title, note, input, redeem, feedback)
  scrim.append(panel)
  document.body.appendChild(scrim)
  // Focus the field so the keyboard comes up straight away.
  setTimeout(() => input.focus(), 30)

  let done = false // latch after a successful redeem so it can't double-grant
  let busy = false

  const teardown = (): void => {
    document.removeEventListener('keydown', onKey)
    scrim.remove()
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') teardown()
    else if (e.key === 'Enter' && !busy && !done) void submit()
  }
  document.addEventListener('keydown', onKey)
  close.addEventListener('click', teardown)
  scrim.addEventListener('click', e => { if (e.target === scrim) teardown() })

  const setFeedback = (msg: string, color: string): void => {
    feedback.textContent = msg
    feedback.style.color = color
  }

  const submit = async (): Promise<void> => {
    if (busy || done) return
    const raw = input.value.trim()
    if (!raw) { setFeedback('Type your code above.', MUTED); return }
    busy = true
    redeem.disabled = true
    redeem.style.opacity = '0.6'
    redeem.style.cursor = 'default'
    redeem.textContent = 'CHECKING…'
    setFeedback('', MUTED)
    let res
    try {
      res = await redeemCode(raw)
    } catch {
      res = { ok: false as const, reason: 'offline' as const }
    }
    if (!scrim.isConnected) return // closed mid-request
    if (res.ok && res.reward) {
      done = true
      setFeedback(`🎉  ${rewardLabel(res.reward)} added!`, GOOD)
      redeem.textContent = 'DONE'
      redeem.style.background = GOOD
      redeem.style.opacity = '1'
      input.disabled = true
      try {
        opts.onRedeemed?.(res.reward, res.balance ?? 0)
      } catch {
        // the grant is already in the save; a celebration hiccup must never bubble
      }
      setTimeout(() => { if (scrim.isConnected) teardown() }, 1700)
      return
    }
    // Failure — explain and let them try again.
    busy = false
    redeem.disabled = false
    redeem.style.opacity = '1'
    redeem.style.cursor = 'pointer'
    redeem.textContent = 'REDEEM'
    setFeedback(reasonMessage(res.reason), ERR)
    input.focus()
    input.select()
  }

  redeem.addEventListener('click', () => void submit())
}

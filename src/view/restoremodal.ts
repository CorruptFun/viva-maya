import { sendRestoreCode, verifyRestoreCode } from '../core/cloud'

/**
 * RESTORE MY PURCHASE — the door for someone who has already paid and is on a new phone, a new
 * browser, or a cleared one.
 *
 * ---------------------------------------------------------------------------- why it exists
 * The paid-entry flow deliberately never asks a new player to make an account (see
 * core/entitlement.ts): they pay, and the email Stripe collects during checkout is bound to the
 * silent anonymous account the purchase landed on. That is what makes this possible at all — the
 * address on file is the ONLY handle a returning player has, so this is the one path that turns it
 * back into their game.
 *
 * ⚠️ Its absence is not a missing feature, it is a REFUND. A player standing in front of a $3.99
 * price tag for a game they already bought will either pay twice and resent it or charge back; the
 * line that offers this is the cheapest support in the whole feature.
 *
 * ---------------------------------------------------------------------------- why DOM
 * Phaser has no text input. Every other typed field in this game is DOM for the same reason
 * (view/promomodal.ts, view/installsheet.ts) — it also means the player gets their platform's real
 * keyboard, autofill and password-manager email suggestions, which on a phone is the difference
 * between one tap and typing an address from memory.
 *
 * ⚠️ Needs real SMTP on the Supabase project. The built-in sender is throttled to a testing-grade
 * ~2/hour (the limitation that pushed this game to Google OAuth in the first place — see
 * docs/CLOUD_SAVE_GOOGLE_SIGNIN.md). Unconfigured, this works for the first player each hour and
 * silently fails for everyone behind them.
 */

const ID = 'vm-restore'

const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'

export interface RestoreOpts {
  /** Called after a verified code has established the session — the caller re-checks entitlement. */
  onRestored: () => void
}

export function openRestoreModal(opts: RestoreOpts): void {
  if (document.getElementById(ID)) return

  const root = document.createElement('div')
  root.id = ID
  root.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;background:rgba(40,30,12,.58);backdrop-filter:blur(2px)'

  const card = document.createElement('div')
  card.style.cssText =
    'width:100%;max-width:420px;background:#fffdf8;color:#3a352b;border:2px solid #f2c14e;border-radius:20px;' +
    `padding:24px;box-shadow:0 18px 48px rgba(90,66,20,.34);font-family:${FONT_STACK}`

  const title = document.createElement('h2')
  title.textContent = 'Restore your purchase'
  title.style.cssText = 'margin:0 0 8px;font-size:22px;font-weight:800;letter-spacing:-.01em'

  const blurb = document.createElement('p')
  blurb.textContent = 'Enter the email you used when you bought the game and we’ll send you a code.'
  blurb.style.cssText = 'margin:0 0 18px;font-size:15px;line-height:1.45;color:#6a6459'

  const field = document.createElement('input')
  field.type = 'email'
  field.inputMode = 'email'
  field.autocomplete = 'email'
  field.placeholder = 'you@example.com'
  field.style.cssText =
    'width:100%;box-sizing:border-box;padding:13px 14px;font-size:17px;border:2px solid #e8dcc0;' +
    `border-radius:12px;background:#fff;color:#3a352b;font-family:${FONT_STACK}`

  const note = document.createElement('p')
  note.setAttribute('role', 'status')
  note.style.cssText = 'margin:12px 0 0;font-size:14px;line-height:1.4;min-height:20px;color:#6a6459'

  const go = document.createElement('button')
  go.textContent = 'SEND CODE'
  go.style.cssText =
    'appearance:none;border:0;cursor:pointer;width:100%;margin-top:16px;padding:14px;border-radius:14px;' +
    `min-height:52px;background:#c9930a;color:#fff;font:800 16px ${FONT_STACK};letter-spacing:.04em`

  const cancel = document.createElement('button')
  cancel.textContent = 'Cancel'
  cancel.style.cssText =
    'appearance:none;border:0;cursor:pointer;width:100%;margin-top:8px;padding:11px;border-radius:12px;' +
    `min-height:44px;background:transparent;color:#8a8172;font:600 15px ${FONT_STACK}`

  card.append(title, blurb, field, note, go, cancel)
  root.append(card)
  document.body.append(root)
  field.focus()

  const close = (): void => root.remove()
  cancel.onclick = close
  // Backdrop dismiss, but only when the press LANDS on the backdrop itself — without the target
  // check, a drag that starts inside the card and releases outside it closes the dialog and throws
  // away a code the player is halfway through typing.
  root.onclick = e => {
    if (e.target === root) close()
  }
  root.onkeydown = e => {
    if (e.key === 'Escape') close()
  }

  /** 'email' → we are collecting the address; 'code' → the code that was sent to it. */
  let step: 'email' | 'code' = 'email'
  let address = ''
  let busy = false

  const say = (msg: string, bad = false): void => {
    note.textContent = msg
    note.style.color = bad ? '#b3261e' : '#6a6459'
  }

  const setBusy = (v: boolean): void => {
    busy = v
    go.disabled = v
    go.style.opacity = v ? '0.6' : '1'
    go.style.cursor = v ? 'default' : 'pointer'
  }

  const toCodeStep = (): void => {
    step = 'code'
    title.textContent = 'Check your email'
    blurb.textContent = `We sent a code to ${address}. It expires in a few minutes.`
    field.type = 'text'
    field.inputMode = 'numeric'
    // The one-time-code autocomplete hint is what lets iOS and Android offer the code straight from
    // the notification, so the player never leaves the game to go and read their inbox.
    field.autocomplete = 'one-time-code'
    field.placeholder = '123456'
    field.value = ''
    go.textContent = 'UNLOCK'
    field.focus()
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    const value = field.value.trim()

    if (step === 'email') {
      // Deliberately permissive: the server is the real check, and a regex strict enough to be
      // worth having is also strict enough to reject somebody's perfectly valid address.
      if (!value.includes('@') || value.length < 5) {
        say('That doesn’t look like an email address.', true)
        return
      }
      setBusy(true)
      say('Sending…')
      const res = await sendRestoreCode(value)
      setBusy(false)
      if (!res.ok) {
        say(res.error ?? 'We couldn’t send a code to that address.', true)
        return
      }
      address = value
      say('')
      toCodeStep()
      return
    }

    if (value.length < 4) {
      say('Enter the code from your email.', true)
      return
    }
    setBusy(true)
    say('Checking…')
    const res = await verifyRestoreCode(address, value)
    if (!res.ok) {
      setBusy(false)
      say(res.error ?? 'That code didn’t work — check and try again.', true)
      return
    }
    say('Welcome back!')
    close()
    opts.onRestored()
  }

  go.onclick = () => void submit()
  field.onkeydown = e => {
    if (e.key === 'Enter') void submit()
  }
}

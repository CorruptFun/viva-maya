import { sendEmailCode, signInWithGoogle, verifyEmailCode } from '../core/cloud'

/**
 * The paid-entry sign-in step — the account a purchase attaches to.
 *
 * ---------------------------------------------------------------------------- why it comes first
 * Paid entry requires an account BEFORE the price, not after. An entitlement has to belong to
 * something that survives a cleared browser and follows a player to a new phone, and the honest
 * moment to establish that is before money changes hands rather than after: a player who has paid
 * and then discovers they have no way to prove it is a support ticket at best and a chargeback at
 * worst.
 *
 * It also makes RESTORE and SIGN IN the same act. There is no separate "I already paid" flow to
 * find, because signing in with the account you used is the whole of it — the entitlement is on
 * the account, so it simply follows.
 *
 * ---------------------------------------------------------------------------- two doors
 *   GOOGLE — one tap, no typing, and typo-proof, which matters more here than anywhere else in the
 *     game: an address entered wrongly at this step is an account the player can never get back
 *     into. It redirects the whole page and returns as a fresh load, so nothing after the call runs.
 *   EMAIL  — a one-time code, for the sizeable share of players who have no Google account or will
 *     not use one. ⚠️ Needs real SMTP on the Supabase project; the built-in sender is throttled to
 *     a testing-grade ~2/hour (the limitation that made this game pick Google OAuth in the first
 *     place — docs/CLOUD_SAVE_GOOGLE_SIGNIN.md). With SMTP unconfigured this door quietly stops
 *     working after the first player or two each hour, which is why Google is the primary and not
 *     merely the first-listed.
 *
 * ---------------------------------------------------------------------------- why DOM
 * Phaser has no text input. Every typed field in this game is DOM for the same reason
 * (view/cloudmodal.ts, view/promomodal.ts), and it also hands the player their platform's real
 * keyboard, autofill and one-time-code suggestions — on a phone that is the difference between one
 * tap and typing an address from memory.
 *
 * This is deliberately NOT `openCloudModal()`, which is the Settings card: sign-in, display name,
 * push toggles, analytics opt-out and backup codes. Putting all of that in front of a purchase
 * would bury the one action that matters under five that don't.
 */

import type { SignInResult } from '../core/cloud'

const ID = 'vm-signin'
const FONT_STACK = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif'

export interface SignInOpts {
  /** Called once a session is established (email path only — Google reloads the page instead). */
  onSignedIn: () => void
}

export function openSignInModal(opts: SignInOpts): void {
  if (document.getElementById(ID)) return

  const root = document.createElement('div')
  root.id = ID
  root.style.cssText =
    'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;background:rgba(42,36,23,.58);backdrop-filter:blur(2px)'

  const card = document.createElement('div')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.style.cssText =
    'width:100%;max-width:420px;background:#fffdf8;color:#3a352b;border:2px solid #f2c14e;border-radius:20px;' +
    `padding:24px;box-shadow:0 18px 48px rgba(90,66,20,.34);font-family:${FONT_STACK}`

  const title = document.createElement('h2')
  title.textContent = 'Sign in to continue'
  title.style.cssText = 'margin:0 0 8px;font-size:22px;font-weight:800;letter-spacing:-.01em'

  const blurb = document.createElement('p')
  blurb.textContent =
    'Your game is tied to your account, so it follows you to a new phone — and comes back if you clear your browser.'
  blurb.style.cssText = 'margin:0 0 18px;font-size:15px;line-height:1.45;color:#6a6459'

  const google = document.createElement('button')
  google.type = 'button'
  google.textContent = 'CONTINUE WITH GOOGLE'
  google.style.cssText =
    'appearance:none;border:0;cursor:pointer;width:100%;padding:14px;border-radius:14px;min-height:52px;' +
    `background:#c9930a;color:#fff;font:800 15px ${FONT_STACK};letter-spacing:.04em`

  const divider = document.createElement('div')
  divider.textContent = 'or use your email'
  divider.style.cssText =
    'margin:16px 0 12px;text-align:center;font-size:13px;color:#8a8172;letter-spacing:.04em'

  const field = document.createElement('input')
  field.type = 'email'
  field.inputMode = 'email'
  field.autocomplete = 'email'
  field.placeholder = 'you@example.com'
  field.setAttribute('aria-label', 'Email address')
  field.style.cssText =
    'width:100%;box-sizing:border-box;padding:13px 14px;font-size:17px;border:2px solid #e8dcc0;' +
    `border-radius:12px;background:#fff;color:#3a352b;font-family:${FONT_STACK}`

  const note = document.createElement('p')
  note.setAttribute('role', 'status')
  note.style.cssText = 'margin:12px 0 0;font-size:14px;line-height:1.4;min-height:20px;color:#6a6459'

  const go = document.createElement('button')
  go.type = 'button'
  go.textContent = 'SEND CODE'
  go.style.cssText =
    'appearance:none;border:0;cursor:pointer;width:100%;margin-top:14px;padding:13px;border-radius:14px;' +
    `min-height:50px;background:#fff;color:#c9930a;border:2px solid #e8dcc0;font:800 15px ${FONT_STACK};letter-spacing:.04em`

  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.textContent = 'Cancel'
  cancel.style.cssText =
    'appearance:none;border:0;cursor:pointer;width:100%;margin-top:8px;padding:11px;border-radius:12px;' +
    `min-height:44px;background:transparent;color:#8a8172;font:600 15px ${FONT_STACK}`

  card.append(title, blurb, google, divider, field, note, go, cancel)
  root.append(card)
  document.body.append(root)
  field.focus()

  const close = (): void => root.remove()
  cancel.onclick = close
  // Backdrop dismiss, but only when the press LANDS on the backdrop. Without the target check a
  // drag that starts inside the card and releases outside closes the dialog and throws away a code
  // the player is halfway through typing.
  root.onclick = e => {
    if (e.target === root) close()
  }
  root.onkeydown = e => {
    if (e.key === 'Escape') close()
  }

  /** 'email' → collecting the address; 'code' → the code that was sent to it. */
  let step: 'email' | 'code' = 'email'
  let address = ''
  let busy = false

  const say = (msg: string, bad = false): void => {
    note.textContent = msg
    note.style.color = bad ? '#b3261e' : '#6a6459'
  }

  const setBusy = (v: boolean): void => {
    busy = v
    for (const b of [go, google]) {
      b.disabled = v
      b.style.opacity = v ? '0.6' : '1'
      b.style.cursor = v ? 'default' : 'pointer'
    }
  }

  google.onclick = () => {
    if (busy) return
    setBusy(true)
    say('Opening Google…')
    // Redirects the whole page and returns as a fresh load, so there is nothing to await: BootScene
    // runs again and lands the player back on the paywall, signed in. Only a FAILURE to start the
    // redirect ever gets back here with a live modal.
    void signInWithGoogle().then((res: SignInResult) => {
      if (res.ok) return
      setBusy(false)
      say(res.error ?? 'We couldn’t open Google sign-in.', true)
    })
  }

  const toCodeStep = (): void => {
    step = 'code'
    title.textContent = 'Check your email'
    blurb.textContent = `We sent a code to ${address}. It expires in a few minutes.`
    google.style.display = 'none'
    divider.style.display = 'none'
    field.type = 'text'
    field.inputMode = 'numeric'
    // The one-time-code hint is what lets iOS and Android offer the code straight from the
    // notification, so the player never leaves the game to go and read their inbox.
    field.autocomplete = 'one-time-code'
    field.setAttribute('aria-label', 'Six-digit code')
    field.placeholder = '123456'
    field.value = ''
    go.textContent = 'CONTINUE'
    go.style.background = '#c9930a'
    go.style.color = '#fff'
    go.style.border = '0'
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
      const res = await sendEmailCode(value)
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
    const res = await verifyEmailCode(address, value)
    if (!res.ok) {
      setBusy(false)
      say(res.error ?? 'That code didn’t work — check and try again.', true)
      return
    }
    close()
    opts.onSignedIn()
  }

  go.onclick = () => void submit()
  field.onkeydown = e => {
    if (e.key === 'Enter') void submit()
  }
}

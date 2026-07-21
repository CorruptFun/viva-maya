// ─────────────────────────────────────────────────────────────────────────────
// Cloud sign-in / backup modal (DOM, not Phaser). A warm cream overlay appended to
// document.body ABOVE the game canvas, opened from the Settings panel's CLOUD & BACKUP
// pill. It is deliberately framework-free (plain DOM + inline styles, no assets) so it
// layers cleanly over the WebGL canvas and survives a scene restart.
//
// It renders by auth state (not-configured / signed-out / signed-in) and ALWAYS shows a
// device backup/restore block. State is read live from the locked core API; the card
// re-renders in place whenever the auth state changes (an `onCloudChange` subscription
// held while open) and after each async action, so it always reflects reality.
// ─────────────────────────────────────────────────────────────────────────────

import { cloudSession, isCloudConfigured, onCloudChange, signInWithGoogle, signOutCloud } from '../core/cloud'
import { exportSave, importSave } from '../core/save'

const MODAL_ID = 'vm-cloud-modal'

// Warm palette (mirrors the game's cream card + gold accents), kept local so the modal is self-contained.
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const CREAM = '#fffdf8'
const INK = '#4a3305'
const MUTED = '#6a6459'
const GOLD = '#c9930a'
const BORDER = '#e6dcc4'
const ERR = '#c0392b'

/** Tiny styled-element factory: create `tag`, apply inline styles, optionally set text. */
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

/** Solid gold primary action button (≥44px tall, full width). */
function primaryBtn(label: string): HTMLButtonElement {
  const b = mk('button', {
    display: 'block', width: '100%', minHeight: '44px', padding: '12px 16px',
    border: 'none', borderRadius: '12px', background: GOLD, color: '#ffffff',
    fontFamily: SANS, fontSize: '16px', fontWeight: '700', cursor: 'pointer',
    boxSizing: 'border-box', lineHeight: '1.2',
  }, label)
  b.type = 'button'
  return b
}

/** Ghost (cream + gold-outline) secondary action button (≥44px tall, full width). */
function ghostBtn(label: string): HTMLButtonElement {
  const b = mk('button', {
    display: 'block', width: '100%', minHeight: '44px', padding: '12px 16px',
    border: `2px solid ${BORDER}`, borderRadius: '12px', background: '#ffffff', color: GOLD,
    fontFamily: SANS, fontSize: '16px', fontWeight: '700', cursor: 'pointer',
    boxSizing: 'border-box', lineHeight: '1.2',
  }, label)
  b.type = 'button'
  return b
}

/** Gold focus ring for inputs/textareas (border warms to gold on focus, back to tan on blur). */
function focusRing(el: HTMLElement): void {
  el.addEventListener('focus', () => { el.style.borderColor = GOLD })
  el.addEventListener('blur', () => { el.style.borderColor = BORDER })
}

function textArea(opts: { id?: string; placeholder?: string; readOnly?: boolean }): HTMLTextAreaElement {
  const t = mk('textarea', {
    display: 'block', width: '100%', minHeight: '68px', padding: '11px 13px',
    border: `2px solid ${BORDER}`, borderRadius: '12px', background: '#fffef9', color: INK,
    fontFamily: SANS, fontSize: '14px', boxSizing: 'border-box', outline: 'none',
    resize: 'vertical', wordBreak: 'break-all',
  })
  if (opts.id) t.id = opts.id
  if (opts.placeholder) t.placeholder = opts.placeholder
  if (opts.readOnly) t.readOnly = true
  focusRing(t)
  return t
}

/** Muted explanatory line. */
function note(text: string): HTMLParagraphElement {
  return mk('p', { margin: '0', fontFamily: SANS, fontSize: '14px', lineHeight: '1.5', color: MUTED }, text)
}

/** Small-caps gold section heading. */
function heading(text: string): HTMLDivElement {
  return mk('div', {
    margin: '0', fontFamily: SANS, fontSize: '12px', fontWeight: '800',
    letterSpacing: '0.7px', textTransform: 'uppercase', color: GOLD,
  }, text)
}

/** Inline error line (carries the `.error` class the caller can style/target). */
function errorEl(text: string): HTMLParagraphElement {
  const p = mk('p', { margin: '0', fontFamily: SANS, fontSize: '14px', fontWeight: '600', color: ERR }, text)
  p.className = 'error'
  return p
}

/** Hairline divider between the auth block and the always-on backup block. */
function divider(): HTMLDivElement {
  return mk('div', { height: '1px', background: '#eee3c8', margin: '4px 0' })
}

/** Vertical stack with consistent gaps. */
function stack(children: HTMLElement[], gap = '10px'): HTMLDivElement {
  const d = mk('div', { display: 'flex', flexDirection: 'column', gap })
  for (const c of children) d.append(c)
  return d
}

/**
 * Open the cloud sign-in / backup modal. Idempotent: if the overlay is already mounted this
 * returns immediately (guards against double-open from a second tap). Everything is torn down
 * on close, including the `onCloudChange` subscription and the Escape-key handler.
 */
export function openCloudModal(): void {
  if (document.getElementById(MODAL_ID)) return

  // ── Local UI state (preserved across re-renders so a pasted backup code isn't lost) ─────────
  let authError = ''
  let restoreValue = ''
  let restoreError = ''
  let unsub: (() => void) | null = null

  // ── Overlay (scrim) + card shell ──────────────────────────────────────────────────────────
  const overlay = mk('div', {
    position: 'fixed', top: '0', left: '0', right: '0', bottom: '0',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '16px', boxSizing: 'border-box',
    background: 'rgba(42,36,23,0.55)', // warm dark scrim (matches the in-game 0x2a2417 overlay)
    zIndex: '2147483000', // above the WebGL canvas
  })
  overlay.id = MODAL_ID

  const card = mk('div', {
    position: 'relative', width: '100%', maxWidth: '360px', boxSizing: 'border-box',
    background: CREAM, borderRadius: '20px', padding: '24px 20px 20px',
    border: '1px solid #f0e6cf', boxShadow: '0 18px 50px rgba(60,45,10,0.35)',
    maxHeight: 'calc(100vh - 32px)', overflowY: 'auto',
    fontFamily: SANS, color: INK,
  })
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', 'Cloud and backup')

  const close = (): void => {
    if (unsub) { unsub(); unsub = null }
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') close()
  }
  // Scrim click (only on the backdrop itself, not inside the card) closes.
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close() })
  document.addEventListener('keydown', onKey)

  const closeBtn = mk('button', {
    position: 'absolute', top: '10px', right: '12px', width: '38px', height: '38px',
    padding: '0', border: 'none', background: 'transparent', color: MUTED,
    fontFamily: SANS, fontSize: '28px', lineHeight: '1', cursor: 'pointer', borderRadius: '10px',
  }, '×')
  closeBtn.type = 'button'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.addEventListener('click', close)

  const title = mk('div', {
    margin: '0 40px 14px 0', fontFamily: SANS, fontSize: '20px', fontWeight: '800',
    letterSpacing: '0.3px', color: GOLD,
  }, 'Cloud & Backup')

  // The content block is rebuilt wholesale by render() on every state change.
  const content = mk('div', { display: 'flex', flexDirection: 'column', gap: '14px' })

  // ── Auth block (varies by state) ──────────────────────────────────────────────────────────
  const buildAuth = (): HTMLElement => {
    // Not configured on this build — a friendly note; backup still works below.
    if (!isCloudConfigured()) {
      return note(
        "Cloud sync isn't set up on this build yet, but your progress is saved on this device. You can still back it up below."
      )
    }

    const session = cloudSession()
    // Signed in — confirm who + offer sign-out.
    if (session) {
      const who = session.email
        ? `Signed in as ${session.email} — your progress syncs automatically.`
        : 'Signed in — your progress syncs automatically.'
      const out = ghostBtn('Sign out')
      out.addEventListener('click', () => {
        out.disabled = true
        out.textContent = 'Signing out…'
        signOutCloud()
          .then(() => location.reload())
          .catch(() => { out.disabled = false; out.textContent = 'Sign out' })
      })
      return stack([note(who), out])
    }

    // Configured but signed out — one-tap Google sign-in. This REDIRECTS the whole page to Google and
    // returns to the app; there is no code to run on success (see signInWithGoogle in core/cloud), so we
    // only surface an error if the redirect itself couldn't start. On success the button stays in its
    // "Continuing…" state because the navigation happens immediately.
    const signInBtn = primaryBtn('Sign in with Google')
    signInBtn.addEventListener('click', () => {
      authError = ''
      signInBtn.disabled = true
      signInBtn.textContent = 'Continuing…'
      signInWithGoogle()
        .then((res) => {
          if (!res.ok) {
            authError = res.error ?? "Couldn't start Google sign-in. Please try again."
            render()
          }
          // On success the page redirects to Google — nothing else runs here.
        })
        .catch(() => {
          authError = "Couldn't start Google sign-in. Please try again."
          render()
        })
    })

    return stack([
      note('Sign in with Google to save your progress to the cloud and restore it on any device — even after clearing your browser or on a new phone.'),
      signInBtn,
    ])
  }

  // ── Backup / restore block (always shown) ─────────────────────────────────────────────────
  const buildBackup = (): HTMLElement => {
    const copyBtn = ghostBtn('Copy backup code')
    // Readonly fallback shown only if the clipboard API is unavailable/blocked.
    const fallback = textArea({ readOnly: true })
    fallback.style.display = 'none'

    copyBtn.addEventListener('click', () => {
      const codeStr = exportSave()
      const showCopied = (): void => {
        copyBtn.textContent = 'Copied ✓'
        window.setTimeout(() => { copyBtn.textContent = 'Copy backup code' }, 1600)
      }
      const showFallback = (): void => {
        fallback.value = codeStr
        fallback.style.display = 'block'
        fallback.focus()
        fallback.select()
      }
      try {
        const clip = navigator.clipboard
        if (clip && typeof clip.writeText === 'function') clip.writeText(codeStr).then(showCopied).catch(showFallback)
        else showFallback()
      } catch {
        showFallback()
      }
    })

    const restore = textArea({ id: 'vm-cloud-restore', placeholder: 'Paste a backup code to restore' })
    restore.value = restoreValue
    restore.addEventListener('input', () => { restoreValue = restore.value })

    const restoreBtn = ghostBtn('Restore from code')
    restoreBtn.addEventListener('click', () => {
      const c = restoreValue.trim()
      if (!c) { restoreError = 'Paste a backup code first.'; render(); return }
      if (importSave(c)) location.reload() // reload so restored progress shows everywhere
      else { restoreError = "That code didn't work."; render() }
    })

    // Download-a-FILE backup: a file saved to the device (Downloads / Files) survives clearing the
    // browser's site data — the strongest durability we can offer with no account. It holds the same
    // backup code, so "Restore from a file" simply re-imports it.
    const downloadBtn = ghostBtn('Download backup file')
    downloadBtn.addEventListener('click', () => {
      try {
        const a = document.createElement('a')
        const url = URL.createObjectURL(new Blob([exportSave()], { type: 'text/plain' }))
        a.href = url
        a.download = 'viva-ton-backup.txt'
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 2000)
      } catch {
        // download unsupported (rare) — the copy-code path still works
      }
    })

    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'text/plain,.txt'
    fileInput.style.display = 'none'
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0]
      fileInput.value = '' // allow re-picking the same file later
      if (!f) return
      f.text()
        .then(txt => {
          if (importSave(txt.trim())) location.reload()
          else { restoreError = "That file didn't work."; render() }
        })
        .catch(() => { restoreError = "Couldn't read that file."; render() })
    })
    const restoreFileBtn = ghostBtn('Restore from a file')
    restoreFileBtn.addEventListener('click', () => fileInput.click())

    const children: HTMLElement[] = [
      heading('Back up on this device'),
      note('Download a backup file (or copy a code) to keep your progress safe — restore it here anytime, even after clearing your browser or on a new device.'),
      downloadBtn,
      copyBtn,
      fallback,
      restoreFileBtn,
      restore,
      restoreBtn,
      fileInput,
    ]
    if (restoreError) children.push(errorEl(restoreError))
    return stack(children)
  }

  function render(): void {
    content.replaceChildren()
    content.append(buildAuth())
    if (authError) content.append(errorEl(authError))
    content.append(divider())
    content.append(buildBackup())
  }

  render()
  // Re-render in place whenever auth state changes (sign-in/out, session resolve). Reset the
  // transient OTP step + error so the card reflects the new reality cleanly. Only meaningful on a
  // configured build (auth never changes otherwise), so the friendly not-configured path never
  // depends on a live cloud client.
  if (isCloudConfigured()) {
    unsub = onCloudChange(() => { authError = ''; render() })
  }

  card.append(closeBtn, title, content)
  overlay.append(card)
  document.body.append(overlay)
}

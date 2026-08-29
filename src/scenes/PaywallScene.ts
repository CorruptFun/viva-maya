import Phaser from 'phaser'
import { DESIGN_W, restScrollY } from '../config'
import { LIFETIME_PRICE_LABEL, restoreByEmail, startCheckout, verifyCheckoutSession } from '../core/paywall'
import { addCasinoBackdrop } from '../view/background'
import { addScreenGloss } from '../view/fx'
import { D, backOut, fadeRise, OVERSHOOT } from '../view/motion'
import { getTheme, prefersReducedMotion } from '../view/theme'
import { FONT, GHOST_PILL, GOLD_PILL, addGoldWordmark, addPillButton, applyEntrance, startScene } from '../view/ui'

/**
 * PAID ENTRY — the hard gate in front of the whole game. BootScene routes here instead of 'home'
 * whenever `paywallConfigured()` is true and this device has no cached entitlement (core/paywall.ts
 * owns the trust model + the dormant-build fallback). Three ways out, all ending at 'home':
 *   1. A fresh return from Stripe Checkout — `sessionId` in scene data, verified immediately.
 *   2. Tapping UNLOCK — redirects to Stripe-hosted Checkout; the round trip re-enters this scene.
 *   3. RESTORE PURCHASE — a device that already paid, recovered by the email used to pay.
 */
export class PaywallScene extends Phaser.Scene {
  private statusText?: Phaser.GameObjects.Text
  private buyBtn?: Phaser.GameObjects.Container
  private restoreBtn?: Phaser.GameObjects.Container

  constructor() {
    super('paywall')
  }

  create(data: { sessionId?: string | null }): void {
    this.cameras.main.setScroll(0, restScrollY())
    this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    applyEntrance(this)
    addCasinoBackdrop(this, 'home')
    addScreenGloss(this)
    const T = getTheme()

    const title = addGoldWordmark(this, DESIGN_W / 2, 220, 'VIVA MAYA')
    fadeRise(this, title, { rise: 22, duration: D.pop, ease: backOut(OVERSHOOT.gentle) })

    this.add
      .text(DESIGN_W / 2, 310, 'Unlock lifetime access', {
        fontFamily: FONT,
        fontSize: '32px',
        fontStyle: '900',
        color: T.onBackdropInk,
      })
      .setOrigin(0.5)
    this.add
      .text(DESIGN_W / 2, 364, `Pay once — ${LIFETIME_PRICE_LABEL} — play forever. No ads, no subscription.`, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '20px',
        color: T.onBackdropMuted,
        wordWrap: { width: 560 },
        align: 'center',
      })
      .setOrigin(0.5)

    this.statusText = this.add
      .text(DESIGN_W / 2, 440, '', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '18px',
        color: T.onBackdropMuted,
        wordWrap: { width: 580 },
        align: 'center',
      })
      .setOrigin(0.5)

    this.buyBtn = addPillButton(this, DESIGN_W / 2, 580, 380, 84, `UNLOCK — ${LIFETIME_PRICE_LABEL}`, GOLD_PILL, () => this.buy())
    this.restoreBtn = addPillButton(this, DESIGN_W / 2, 690, 340, 60, 'RESTORE PURCHASE', GHOST_PILL, () => this.restore())

    const sessionId = data?.sessionId
    if (sessionId) {
      this.stripSessionParam()
      this.setBusy(true, 'Confirming your purchase…')
      verifyCheckoutSession(sessionId).then((ok) => {
        if (!this.scene.isActive()) return
        if (ok) {
          this.unlock()
          return
        }
        this.setBusy(false)
        this.setStatus("We couldn't confirm that payment yet. Try RESTORE PURCHASE in a moment, or unlock again below.")
      })
    }
  }

  /** Strips `entitlement_session` from the URL once read, so a reload can't re-trigger a stale verify. */
  private stripSessionParam(): void {
    try {
      const url = new URL(location.href)
      url.searchParams.delete('entitlement_session')
      history.replaceState(null, '', url.toString())
    } catch {
      /* ignore — cosmetic only */
    }
  }

  private setStatus(msg: string): void {
    this.statusText?.setText(msg)
  }

  private setBusy(busy: boolean, msg = ''): void {
    this.buyBtn?.setAlpha(busy ? 0.5 : 1)
    this.restoreBtn?.setAlpha(busy ? 0.5 : 1)
    if (msg) this.setStatus(msg)
  }

  private unlock(): void {
    startScene(this, 'home')
  }

  private async buy(): Promise<void> {
    this.setBusy(true, 'Opening secure checkout…')
    const started = await startCheckout()
    if (!started) {
      this.setBusy(false)
      this.setStatus('Could not reach checkout — check your connection and try again.')
    }
  }

  private restore(): void {
    const email = window.prompt('Enter the email you used to pay:')?.trim()
    if (!email) return
    this.setBusy(true, 'Checking…')
    restoreByEmail(email).then((ok) => {
      if (!this.scene.isActive()) return
      this.setBusy(false)
      if (ok) this.unlock()
      else this.setStatus('No payment found for that email. Try again, or unlock below.')
    })
  }
}

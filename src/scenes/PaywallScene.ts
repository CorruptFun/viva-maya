import Phaser from 'phaser'
import { DESIGN_H, DESIGN_W, restScrollY } from '../config'
import { EVENTS, track } from '../core/analytics'
import { cloudSession, onCloudChange, signOutCloud } from '../core/cloud'
import {
  awaitEntitlement,
  beginCheckout,
  clearCheckoutParams,
  refreshAccess,
  returningFromCheckout,
} from '../core/entitlement'
import { ENTRY_PRICE_CENTS, formatUsd } from '../core/referralcash'
import { addCasinoBackdrop } from '../view/background'
import { addScreenGloss } from '../view/fx'
import { openSignInModal } from '../view/signinmodal'
import { D, E, OVERSHOOT, backOut, fadeRise, popIn } from '../view/motion'
import { getTheme, prefersReducedMotion } from '../view/theme'
import { FONT, GHOST_PILL, GOLD_PILL, addGoldWordmark, addPillButton, applyEntrance, inkShadow, startScene } from '../view/ui'

/**
 * THE DOOR — the one-time entry fee, charged before a new player's first board.
 *
 * The gate itself is core/entitlement.ts; this scene is its face. BootScene routes here instead of
 * Home when `accessNow()` refuses, and nothing but a granted entitlement gets out of it.
 *
 * ---------------------------------------------------------------------------- ACCOUNT FIRST
 * ⚠️ SIGN-IN COMES BEFORE THE PRICE, and the order is deliberate: an entitlement has to belong to
 * something that survives a cleared browser and follows a player to a new phone, and the honest
 * moment to establish that is BEFORE money changes hands. A player who pays and only then
 * discovers they have no way to prove it is a support ticket at best and a chargeback at worst.
 *
 * It costs a step at the top of the funnel, and that cost is real — it is a commitment asked for
 * before any value has been delivered. What it buys is that every payment has a verified address
 * behind it from the moment it is made, that no account is created without the player knowing, and
 * that RESTORE and SIGN IN are the same act with nothing extra to find: the entitlement lives on
 * the account, so signing back in simply brings it.
 *
 * ---------------------------------------------------------------------------- the five states
 *   'checking'   — asking the server. The FIRST paint, always, because a player who bought the game
 *                  on another device must never be shown a price before we have asked.
 *   'signedout'  — the account step. Google (one tap, typo-proof) or an emailed code.
 *   'offer'      — the price, and what it buys.
 *   'confirming' — back from Stripe with `?paid=1`, waiting on the webhook. See below.
 *   'failed'     — the wait ran out. NOT a refusal — a retry.
 *
 * ⚠️ 'confirming' is the state that must never be skipped, and it exists because fulfilment is not
 * synchronous with the redirect. Stripe sends the player straight back the instant the card clears,
 * but the entitlement is written by a WEBHOOK — a separate request Stripe makes to us, usually
 * inside a second and occasionally much slower. Rendering the price in that window would be showing
 * a bill to somebody who has just paid it, which is the single worst thing this screen can do.
 *
 * ⚠️ And 'failed' must never say "payment failed", because it isn't one: the card HAS been charged
 * by the time we get here. It says the receipt is slow and offers to look again.
 */
type State = 'checking' | 'signedout' | 'offer' | 'confirming' | 'failed'

const CARD_X = 60
const CARD_W = DESIGN_W - CARD_X * 2

export class PaywallScene extends Phaser.Scene {
  private layer!: Phaser.GameObjects.Container
  private state: State = 'checking'
  private busy = false
  private offCloud?: () => void
  /** Set on SHUTDOWN so an async resolution can never touch a scene that has moved on. */
  private gone = false

  constructor() {
    super('paywall')
  }

  create(): void {
    this.gone = false
    this.busy = false
    this.cameras.main.setScroll(0, restScrollY())
    this.cameras.main.fadeIn(prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    applyEntrance(this, undefined, { zoomSettle: true })
    addCasinoBackdrop(this, 'home')
    addScreenGloss(this)

    const T = getTheme()
    addGoldWordmark(this, DESIGN_W / 2, 214, 'VIVA MAYA')
    this.add
      .text(DESIGN_W / 2, 272, 'The house is open', {
        fontFamily: FONT,
        fontSize: '22px',
        color: T.onBackdropMuted,
      })
      .setOrigin(0.5)
      .setLetterSpacing(3)

    this.layer = this.add.container(0, 0)

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.gone = true
      this.offCloud?.()
      this.offCloud = undefined
    })

    // A session can land without this scene asking for one — another tab restoring it, a token
    // refresh arriving late, the Google redirect settling. Re-deciding on that signal is what stops
    // the scene sitting on 'signedout' behind a player who is, by then, signed in.
    this.offCloud = onCloudChange(() => {
      if (this.gone || this.busy) return
      if (this.state === 'signedout' && cloudSession()) void this.decide()
    })

    this.setState('checking')
    void this.decide()
  }

  // ------------------------------------------------------------------ flow

  /** Ask the server what this account is owed, and route to the right state. Never throws. */
  private async decide(): Promise<void> {
    // Back from Stripe: go straight to waiting on the webhook. Deliberately BEFORE the sign-in
    // check — a session that is a moment late to restore must not bounce a paying player to a
    // sign-in screen with their receipt in hand.
    if (returningFromCheckout()) {
      this.setState('confirming')
      const ok = await awaitEntitlement()
      if (this.gone) return
      clearCheckoutParams()
      if (ok) {
        track(EVENTS.ENTRY_PAID, { reason: 'paid' })
        this.enter()
        return
      }
      this.setState('failed')
      return
    }

    // The account step, ahead of the price. Deliberately AFTER the returning-from-Stripe branch
    // above: a session that is a moment late to restore must not bounce a player who has just paid
    // back to a sign-in screen with their receipt in hand.
    if (!cloudSession()) {
      this.setState('signedout')
      return
    }

    const verdict = await refreshAccess()
    if (this.gone) return
    if (verdict?.entitled) {
      // Already owned — bought on another device, comped, or grandfathered server-side. Nobody in
      // this branch is shown a price.
      track(EVENTS.ENTRY_PAID, { reason: verdict.reason })
      this.enter()
      return
    }
    this.setState('offer')
  }

  /** Hand the player their game. */
  private enter(): void {
    if (this.gone) return
    startScene(this, 'home')
  }

  private setState(state: State): void {
    this.state = state
    track(EVENTS.PAYWALL_SHOWN, { state })
    this.render()
  }

  // ------------------------------------------------------------------ actions

  private async onUnlock(): Promise<void> {
    if (this.busy) return
    this.busy = true
    track(EVENTS.CHECKOUT_STARTED)
    const res = await beginCheckout()
    // On success the page is already navigating to Stripe — nothing after this runs. Only a
    // FAILURE gets here with a live scene, so the button has to come back for another try.
    if (this.gone) return
    this.busy = false
    if (!res.ok) {
      this.toast(res.error)
      this.render()
    }
  }

  /**
   * The account step (view/signinmodal.ts) — Google, or an emailed one-time code.
   *
   * This is also the restore path, and there is deliberately no second one: the entitlement lives
   * on the account, so a player returning on a new phone signs in with what they used before and
   * their game simply follows. Anything labelled separately as "restore" would be the same button
   * twice.
   *
   * Google redirects the whole page and comes back as a fresh load, so only the EMAIL path ever
   * reaches `onSignedIn` with this scene still alive.
   */
  private onSignIn(): void {
    if (this.busy) return
    openSignInModal({
      onSignedIn: () => {
        if (this.gone) return
        this.setState('checking')
        void this.decide()
      },
    })
  }

  private onRetry(): void {
    if (this.busy) return
    void this.decide()
  }

  /**
   * Drop the current session and go back to the account step — the escape hatch for a player the
   * browser signed in as the wrong person. Signing out also clears the cached entitlement verdict
   * (core/cloud.ts), so the next account is judged on its own.
   */
  private async onSwitchAccount(): Promise<void> {
    if (this.busy) return
    this.busy = true
    await signOutCloud()
    this.busy = false
    if (this.gone) return
    this.setState('signedout')
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    this.layer.removeAll(true)
    const T = getTheme()
    const reduced = prefersReducedMotion()

    // The plate every state sits on — one shape, so a state change reads as the same door
    // answering differently rather than as four different screens.
    const top = 340
    const h = 470
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.18)
    g.fillRoundedRect(CARD_X + 3, top + 7, CARD_W, h, 28)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(CARD_X, top, CARD_W, h, 28)
    g.lineStyle(2.5, T.goldBezel, 0.9)
    g.strokeRoundedRect(CARD_X, top, CARD_W, h, 28)
    this.layer.add(g)

    if (this.state === 'checking' || this.state === 'confirming') this.renderWaiting(top, h)
    else if (this.state === 'failed') this.renderFailed(top)
    else if (this.state === 'signedout') this.renderSignedOut(top)
    else this.renderOffer(top)

    if (!reduced) {
      fadeRise(this, this.layer, { rise: 22, duration: D.pop, ease: backOut(OVERSHOOT.gentle) })
    }
  }

  /** 'checking' and 'confirming' share a shape and differ only in what they promise. */
  private renderWaiting(top: number, h: number): void {
    const T = getTheme()
    const confirming = this.state === 'confirming'
    const cy = top + h / 2
    this.layer.add(
      inkShadow(
        this.add
          .text(DESIGN_W / 2, cy - 46, confirming ? 'Confirming your payment' : 'One moment', {
            fontFamily: FONT,
            fontSize: '30px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
      )
    )
    this.layer.add(
      this.add
        .text(
          DESIGN_W / 2,
          cy + 4,
          confirming
            ? 'Your card has gone through. We’re waiting\non the receipt — this is usually seconds.'
            : 'Checking your account…',
          { fontFamily: 'Arial, sans-serif', fontSize: '19px', color: T.inkSoft, align: 'center', lineSpacing: 6 }
        )
        .setOrigin(0.5)
    )
    const dots = this.add
      .text(DESIGN_W / 2, cy + 78, '· · ·', { fontFamily: FONT, fontSize: '32px', color: T.inkMuted })
      .setOrigin(0.5)
      .setLetterSpacing(4)
    this.layer.add(dots)
    if (!prefersReducedMotion()) {
      this.tweens.add({ targets: dots, alpha: 0.3, duration: 620, yoyo: true, repeat: -1, ease: E.hero })
    }
  }

  private renderSignedOut(top: number): void {
    const T = getTheme()
    this.layer.add(
      inkShadow(
        this.add
          .text(DESIGN_W / 2, top + 60, 'SIGN IN TO PLAY', {
            fontFamily: FONT,
            fontSize: '34px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
      )
    )
    // Say WHY the account comes first. An account demanded before a player has seen a board needs a
    // reason attached to it, and the reason is a benefit to them rather than to us — this is the
    // thing that gives their purchase back when they change phones.
    this.layer.add(
      this.add
        .text(
          DESIGN_W / 2,
          top + 142,
          'Viva Maya is a one-time purchase.\nYour account is what keeps it yours —\non every device, and after a cleared browser.',
          {
            fontFamily: 'Arial, sans-serif',
            fontSize: '19px',
            color: T.inkSoft,
            align: 'center',
            lineSpacing: 8,
          }
        )
        .setOrigin(0.5)
    )
    this.layer.add(
      addPillButton(this, DESIGN_W / 2, top + 282, 384, 80, 'SIGN IN', GOLD_PILL, () => this.onSignIn(), {
        juice: true,
      })
    )
    // The line that saves the returning player. Someone who bought the game and then changed phones
    // lands here looking at what reads as a fresh bill; without this they have no way to know that
    // signing in is the thing that gives it back rather than the thing that charges them.
    this.layer.add(
      this.add
        .text(DESIGN_W / 2, top + 370, 'Already bought it? Sign in and it’s waiting for you.', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '16px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )
  }

  private renderOffer(top: number): void {
    const T = getTheme()
    this.layer.add(
      this.add
        .text(DESIGN_W / 2, top + 44, 'ONE-TIME ENTRY', {
          fontFamily: FONT,
          fontSize: '20px',
          fontStyle: '900',
          color: T.inkMuted,
        })
        .setOrigin(0.5)
        .setLetterSpacing(4)
    )

    const price = this.add
      .text(DESIGN_W / 2, top + 108, formatUsd(ENTRY_PRICE_CENTS), {
        fontFamily: FONT,
        fontSize: '76px',
        fontStyle: '900',
        color: T.ink,
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(80,60,20,0.28)', 5, false, true)
    this.layer.add(price)
    popIn(this, price, { from: 0.8, delay: 90, overshoot: OVERSHOOT.gentle })

    // Say what the money buys, in the player's words. "No subscription" is load-bearing copy on a
    // $3.99 screen: the default assumption about any price in a mobile game is that it recurs, and
    // an unanswered assumption is a bounce.
    const lines = [
      'Every level, chapter to chapter',
      'The daily race, the slots, the storm',
      'No subscription — you own it',
    ]
    lines.forEach((text, i) => {
      const y = top + 188 + i * 42
      this.layer.add(this.add.image(CARD_X + 62, y, 'chip').setDisplaySize(24, 24))
      this.layer.add(
        this.add
          .text(CARD_X + 88, y, text, { fontFamily: 'Arial, sans-serif', fontSize: '19px', color: T.inkSoft })
          .setOrigin(0, 0.5)
      )
    })

    this.layer.add(
      addPillButton(
        this,
        DESIGN_W / 2,
        top + 372,
        384,
        80,
        this.busy ? 'OPENING…' : 'UNLOCK THE GAME',
        this.busy ? GHOST_PILL : GOLD_PILL,
        () => void this.onUnlock(),
        this.busy ? { disabled: true } : { juice: true }
      )
    )

    // WHICH account is about to be charged, stated before the charge rather than after it.
    //
    // Not decoration: a player who signed in with the wrong Google account — easy on a shared or
    // family device, where the browser picks one for you — would otherwise buy the game for an
    // account they will never use again, and then still be looking at a price on the one they
    // wanted. That is a double charge caused entirely by us not saying who we thought they were.
    const who = cloudSession()?.email
    if (who) {
      this.layer.add(
        this.add
          .text(DESIGN_W / 2, 894, `Signing in as ${who}`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '16px',
            color: T.onBackdropMuted,
            wordWrap: { width: CARD_W },
            align: 'center',
          })
          .setOrigin(0.5)
      )
    }
    this.layer.add(
      addPillButton(this, DESIGN_W / 2, 954, 300, 58, 'USE ANOTHER ACCOUNT', GHOST_PILL, () =>
        void this.onSwitchAccount()
      )
    )

    // ⚠️ Held in `this.layer`, like everything else here. renderOffer runs again on every busy
    // toggle, so a stray `this.add` at scene level would stack a fresh copy of this line under the
    // last one on each repaint.
    this.layer.add(
      this.add
        .text(DESIGN_W / 2, DESIGN_H - 92, 'Secure checkout by Stripe. We never see your card.', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '16px',
          color: T.onBackdropMuted,
        })
        .setOrigin(0.5)
    )
  }

  private renderFailed(top: number): void {
    const T = getTheme()
    this.layer.add(
      inkShadow(
        this.add
          .text(DESIGN_W / 2, top + 62, 'STILL WAITING', {
            fontFamily: FONT,
            fontSize: '32px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
      )
    )
    // ⚠️ This copy must never read as a declined payment. The charge succeeded — what is late is
    // our receipt for it. Telling a charged player their payment failed would send them to their
    // bank, and the bank's answer to that is a chargeback.
    this.layer.add(
      this.add
        .text(
          DESIGN_W / 2,
          top + 156,
          'Your payment went through, but the receipt\nhasn’t reached us yet. Nothing is lost —\ntap below and we’ll look again.',
          {
            fontFamily: 'Arial, sans-serif',
            fontSize: '19px',
            color: T.inkSoft,
            align: 'center',
            lineSpacing: 8,
          }
        )
        .setOrigin(0.5)
    )
    this.layer.add(
      addPillButton(this, DESIGN_W / 2, top + 300, 340, 78, 'CHECK AGAIN', GOLD_PILL, () => this.onRetry(), {
        juice: true,
      })
    )
    this.layer.add(
      this.add
        .text(DESIGN_W / 2, top + 392, 'Still nothing after a few minutes? Email support\nand we’ll sort it out by hand.', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '15px',
          color: T.inkFaint,
          align: 'center',
          lineSpacing: 5,
        })
        .setOrigin(0.5)
    )
  }

  private toast(msg: string): void {
    const T = getTheme()
    const t = this.add
      .text(DESIGN_W / 2, DESIGN_H - 150, msg, {
        fontFamily: FONT,
        fontSize: '20px',
        fontStyle: '900',
        color: T.warn,
        align: 'center',
        wordWrap: { width: CARD_W },
      })
      .setOrigin(0.5)
      .setDepth(70)
    this.tweens.add({ targets: t, alpha: 0, delay: 2600, duration: 340, onComplete: () => t.destroy() })
  }
}

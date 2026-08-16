import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { EVENTS, track } from '../core/analytics'
import {
  HOLD_DAYS,
  MIN_PAYOUT_CENTS,
  cashRateCents,
  fetchCashSummary,
  fetchOnboardingUrl,
  formatUsd,
  requestPayout,
  type CashSummary,
} from '../core/referralcash'
import { REFEREE_CHIPS, REFERRER_CHIPS } from '../core/referrals'
import { D, E, OVERSHOOT, popIn } from './motion'
import { getTheme, prefersReducedMotion } from './theme'
import { FONT, GHOST_PILL, GOLD_PILL, addPillButton, inkShadow } from './ui'

/**
 * YOUR EARNINGS — the cash side of the referral program, as a panel.
 *
 * A PANEL rather than a row on the Gift Store shelf, and that is a layout decision with a reason:
 * the store's vertical band is full (an invite card, five boost rows and the slots card inside
 * 1280), and seating a sixth card there would push the last boost row through the slots card. The
 * store opens this instead, from a chip on the invite card. Same idiom as the sound / theme panels.
 *
 * ---------------------------------------------------------------------------- what it must say
 * This panel is the only place in the game that shows a player real money, so it carries three
 * things that are easy to leave out and expensive to omit:
 *
 *   · WHY a balance is not yet withdrawable. "Pending" with no explanation reads as a stall. The
 *     hold is a chargeback window, it is HOLD_DAYS long, and saying so turns a suspicious number
 *     into an understood one.
 *   · THE MINIMUM, before the player taps and is refused. A refusal a player could have predicted
 *     is a UI failure, not a business rule.
 *   · THAT CHIPS ARE NOT CASH. The game's in-game currency sits two taps away in the same scene and
 *     is deliberately worthless outside it. Any screen that shows dollars next to chips has to be
 *     unambiguous about which is which, or the store's own "no cash value" line stops being true
 *     in the player's head.
 *
 * ⚠️ Nothing here can move money. It reads a summary and asks the server to pay out; the amount,
 * the hold and the transfer are all decided server-side (supabase/functions/payout), because the
 * ledger has no write policy for any client role. See core/referralcash.ts.
 */

const PANEL_W = 600
const PANEL_H = 560

/** Open the earnings panel. Self-contained: builds its own scrim, fetches, and cleans itself up. */
export function openEarningsPanel(scene: Phaser.Scene): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const cx = DESIGN_W / 2
  const cy = viewportCenterY()

  // Full-bleed scrim. Sized off the WORLD, not the design box, and generously overscanned on both
  // axes — a screen shake translates the camera matrix, so anything sized to the visible box exactly
  // tears a strip of clear colour off its own edge (see the WASH_BLEED note in CLAUDE.md).
  const scrim = scene.add
    .rectangle(cx, cy, DESIGN_W + 800, worldH() + 800, T.shadow, 0.52)
    .setDepth(120)
    .setInteractive()
  const panel = scene.add.container(cx, cy).setDepth(121)

  const close = (): void => {
    scene.tweens.killTweensOf(panel)
    panel.destroy()
    scrim.destroy()
  }
  scrim.on('pointerup', close)
  // A scene change with the panel open must not strand the scrim over the next screen.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, close)

  const g = scene.add.graphics()
  g.fillStyle(T.shadow, 0.3)
  g.fillRoundedRect(-PANEL_W / 2 + 4, -PANEL_H / 2 + 9, PANEL_W, PANEL_H, 30)
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 30)
  g.lineStyle(3, T.goldBezel, 1)
  g.strokeRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 30)
  panel.add(g)

  panel.add(
    inkShadow(
      scene.add
        .text(0, -PANEL_H / 2 + 46, 'YOUR EARNINGS', {
          fontFamily: FONT,
          fontSize: '30px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2)
    )
  )

  // Body is rebuilt when the fetch lands and again after a cash-out, so it lives in its own layer.
  const body = scene.add.container(0, 0)
  panel.add(body)

  panel.add(addPillButton(scene, 0, PANEL_H / 2 - 52, 200, 62, 'CLOSE', GHOST_PILL, close))

  const status = scene.add
    .text(0, PANEL_H / 2 - 104, '', {
      fontFamily: 'Arial, sans-serif',
      fontSize: '17px',
      color: T.inkSoft,
      align: 'center',
      wordWrap: { width: PANEL_W - 80 },
      lineSpacing: 4,
    })
    .setOrigin(0.5)
  panel.add(status)

  const say = (msg: string, tone: 'good' | 'bad' | 'plain' = 'plain'): void => {
    if (!status.active) return
    status.setText(msg).setColor(tone === 'bad' ? T.warn : tone === 'good' ? T.ok : T.inkSoft)
  }

  let busy = false

  const renderBody = (summary: CashSummary | null): void => {
    if (!body.active) return
    body.removeAll(true)
    if (!summary) {
      body.add(
        scene.add
          .text(0, -20, 'Sign in to see your earnings.', {
            fontFamily: 'Arial, sans-serif',
            fontSize: '20px',
            color: T.inkSoft,
            align: 'center',
          })
          .setOrigin(0.5)
      )
      return
    }

    // Depth 2+ — the honest version of "in-game rewards only". Showing a $0.00 balance to someone
    // who can never earn a cent would read as a bug, or worse, as money being withheld.
    if (summary.rateCents <= 0) {
      body.add(
        inkShadow(
          scene.add
            .text(0, -110, 'CHIPS & HEARTS', {
              fontFamily: FONT,
              fontSize: '36px',
              fontStyle: '900',
              color: T.ink,
            })
            .setOrigin(0.5)
        )
      )
      body.add(
        scene.add
          .text(
            0,
            -30,
            `Every friend who joins on your link earns you\n${REFERRER_CHIPS} chips and a full set of hearts —\nand gives them ${REFEREE_CHIPS} chips to start with.`,
            {
              fontFamily: 'Arial, sans-serif',
              fontSize: '19px',
              color: T.inkSoft,
              align: 'center',
              lineSpacing: 7,
            }
          )
          .setOrigin(0.5)
      )
      body.add(
        scene.add
          .text(0, 78, `${summary.referralCount} joined so far`, {
            fontFamily: FONT,
            fontSize: '22px',
            fontStyle: '900',
            color: T.inkMuted,
          })
          .setOrigin(0.5)
      )
      // Chips are not cash, said plainly, on the one screen where the two ideas meet.
      body.add(
        scene.add
          .text(0, 138, 'Chips are for the Gift Store — no cash value.', {
            fontFamily: 'Arial, sans-serif',
            fontSize: '15px',
            color: T.inkFaint,
          })
          .setOrigin(0.5)
      )
      return
    }

    // The cash tiers.
    body.add(
      scene.add
        .text(0, -150, `${formatUsd(summary.rateCents)} per friend who joins`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '19px',
          color: T.inkSoft,
        })
        .setOrigin(0.5)
    )

    const ready = scene.add
      .text(0, -92, formatUsd(summary.availableCents), {
        fontFamily: FONT,
        fontSize: '62px',
        fontStyle: '900',
        color: summary.availableCents > 0 ? T.ok : T.inkMuted,
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(80,60,20,0.24)', 4, false, true)
    body.add(ready)
    body.add(
      scene.add
        .text(0, -44, 'ready to cash out', {
          fontFamily: FONT,
          fontSize: '16px',
          color: T.inkMuted,
        })
        .setOrigin(0.5)
        .setLetterSpacing(3)
    )

    // The hold, explained where the number it explains is standing. A "pending" figure with no
    // reason attached is the line that generates support mail.
    if (summary.pendingCents > 0) {
      body.add(
        scene.add
          .text(0, 8, `${formatUsd(summary.pendingCents)} still clearing`, {
            fontFamily: FONT,
            fontSize: '22px',
            fontStyle: '900',
            color: T.inkSoft,
          })
          .setOrigin(0.5)
      )
      body.add(
        scene.add
          .text(0, 42, `Earnings clear ${HOLD_DAYS} days after your friend joins.`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '16px',
            color: T.inkFaint,
          })
          .setOrigin(0.5)
      )
    }

    const summaryLine =
      summary.paidCents > 0
        ? `${summary.referralCount} joined · ${formatUsd(summary.paidCents)} paid out so far`
        : `${summary.referralCount} joined`
    body.add(
      scene.add
        .text(0, 86, summaryLine, { fontFamily: 'Arial, sans-serif', fontSize: '17px', color: T.inkSoft })
        .setOrigin(0.5)
    )

    // The minimum is stated BEFORE the tap, so a refusal is never a surprise. Below it the pill is
    // a ghost — inert, and visibly so.
    const canCash = summary.availableCents >= MIN_PAYOUT_CENTS
    body.add(
      addPillButton(
        scene,
        0,
        158,
        320,
        70,
        busy ? 'WORKING…' : summary.payoutsEnabled ? 'CASH OUT' : 'SET UP PAYOUTS',
        canCash && !busy ? GOLD_PILL : GHOST_PILL,
        () => void onCashOut(summary),
        canCash && !busy ? { juice: true } : { disabled: true }
      )
    )
    if (!canCash) {
      body.add(
        scene.add
          .text(0, 204, `${formatUsd(MIN_PAYOUT_CENTS)} minimum to cash out`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '15px',
            color: T.inkFaint,
          })
          .setOrigin(0.5)
      )
    }
  }

  const onCashOut = async (summary: CashSummary): Promise<void> => {
    if (busy) return
    busy = true
    renderBody(summary)
    say('')

    // Not verified with Stripe yet — send them to onboarding rather than refusing. This is the step
    // most likely to be where the cash program quietly stops paying anyone, so it is measured.
    if (!summary.payoutsEnabled) {
      const url = await fetchOnboardingUrl()
      track(EVENTS.CASHOUT_REQUESTED, { outcome: 'onboarding' })
      busy = false
      if (url) {
        say('Opening secure setup with Stripe…', 'good')
        window.location.assign(url)
        return
      }
      say('Payout setup is unavailable right now — please try again.', 'bad')
      renderBody(summary)
      return
    }

    const res = await requestPayout()
    busy = false
    if (!panel.active) return

    if (res.ok) {
      track(EVENTS.CASHOUT_REQUESTED, { outcome: 'paid', amount_cents: res.amountCents })
      sfx.coinCount()
      say(`${formatUsd(res.amountCents)} is on its way to your bank.`, 'good')
      void fetchCashSummary().then(s => renderBody(s))
      return
    }

    track(EVENTS.CASHOUT_REQUESTED, { outcome: res.reason })
    if (res.reason === 'onboarding') {
      say('Finishing your payout setup…', 'good')
      window.location.assign(res.url)
      return
    }
    if (res.reason === 'below_minimum') say(`You need ${formatUsd(MIN_PAYOUT_CENTS)} to cash out.`, 'bad')
    else if (res.reason === 'nothing_available') say('Nothing has cleared yet — check back soon.', 'bad')
    else say('Cash out is unavailable right now — please try again.', 'bad')
    renderBody(summary)
  }

  // First paint: the loading state, then the real one. Never a zeroed board that later fills in —
  // "$0.00 ready" flashing before a real balance would be a small lie every single time.
  renderLoading(scene, body)
  void fetchCashSummary().then(summary => {
    if (!body.active) return
    if (summary) track(EVENTS.CASHOUT_SHOWN, { depth: summary.depth, rate: summary.rateCents })
    renderBody(summary)
  })

  if (reduced) return
  popIn(scene, panel, { from: 0.72, overshoot: OVERSHOOT.pop })
  scrim.setAlpha(0)
  scene.tweens.add({ targets: scrim, alpha: 0.52, duration: D.pop, ease: E.hero })
}

function renderLoading(scene: Phaser.Scene, body: Phaser.GameObjects.Container): void {
  const T = getTheme()
  const dots = scene.add
    .text(0, -20, '· · ·', { fontFamily: FONT, fontSize: '34px', color: T.inkMuted })
    .setOrigin(0.5)
    .setLetterSpacing(5)
  body.add(dots)
  if (!prefersReducedMotion()) {
    scene.tweens.add({ targets: dots, alpha: 0.32, duration: 600, yoyo: true, repeat: -1, ease: E.hero })
  }
}

/**
 * The cash rate a signed-out / unknown player should be TOLD about on the invite card.
 *
 * Deliberately the depth-0 rate: it is the most anyone earns, it is what an organic player (the
 * majority of anyone reading a marketing line) actually gets, and it is the honest headline. The
 * panel then shows each player their OWN rate, resolved server-side. Advertising a rate a reader
 * cannot reach would be the wrong trade in the other direction — but so would advertising the
 * lowest one to people entitled to the highest.
 */
export function headlineCashRateCents(): number {
  return cashRateCents(0)
}

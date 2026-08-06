import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { EVENTS, track } from '../core/analytics'
import { enablePush } from '../core/push'
import { markPushOfferSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL, inkShadow } from './ui'

/**
 * NEVER MISS A BOARD — the race-reminder opt-in card.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Web Push has been fully built since the race went daily (core/push.ts, migrations 0011/0012, the
 * endless-push workflow), and the only door to it was a ghost button three taps deep inside
 * Settings → Cloud & Backup. Nothing in the game ever mentioned it. A feature whose entire job is to
 * call players back to a board that resets every night cannot be reached only by players who were
 * already coming back — that is the audience it is least needed for.
 *
 * ── Why this is a SOFT ASK, and why that is not a workaround ──────────────────
 * `Notification.requestPermission()` gets exactly one shot per install: a denial is effectively
 * permanent, the browser will not ask twice, and undoing it means digging through site settings.
 * So this card is the question, and the browser's prompt is only ever reached by tapping REMIND ME —
 * an explicit gesture, from someone who has just read what the reminder is for. Firing the real
 * prompt on load would convert worse AND burn the ask on everyone who happened to open the app.
 * That constraint is stated at the top of core/push.ts; this card is what it was asking for.
 *
 * ── Why HERE, after their first race ─────────────────────────────────────────
 * The reminder's whole content is "your board closes soon". Offered before a player has raced, that
 * is a notification about an abstraction. Offered on the Home visit after their first run, they have
 * just played the exact board it is about — so "want a nudge before tomorrow's closes?" answers
 * itself. It rides HomeScene's growth-celebration queue rather than the end-of-run chain for the
 * same reason the race unlock does: that chain is already jackpot → deal → plinko deep, and a fourth
 * card would bury this one behind celebrations that have nothing to do with it.
 *
 * ⚠️ Never opened when `pushSupport()` isn't 'ready' — the gate is `pushOfferDue` in core/push.ts,
 * which lives there rather than here so it can be tested without booting Phaser. An iPhone in a Safari tab
 * cannot subscribe at all (Apple ships Web Push only in an installed PWA), and spending the one-time
 * latch to tell someone that would mean never offering it once they DO install. That case belongs to
 * the install nudge, which already exists.
 */

/** How long the confirmation sits on screen before the card bows out. */
const CONFIRM_HOLD_MS = 1500

export function openPushOptIn(scene: Phaser.Scene): Promise<void> {
  return new Promise<void>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      // Latched on the way OUT, not on the way in — see markPushOfferSeen. Every exit path runs
      // through here (both pills, the scrim, the auto-close), so the offer can never be re-put in
      // front of someone who actually answered it.
      markPushOfferSeen()
      sfx.whoosh()
      layer.destroy()
      resolve()
    }

    const scrimKit = addFocusScrim(scene, { alpha: 0.72 })
    const scrim = scrimKit.hit.setInteractive()
    scrim.on('pointerup', () => finish())
    layer.add([scrim, ...scrimKit.art])

    // Deliberately the race-unlock card's geometry to the pixel — same plate, same icon/title/rule
    // rhythm, same footer band. The two are siblings a player can meet within a week of each other,
    // both explaining the same daily race, and a card that is nearly-but-not-quite the shape of the
    // last one reads as a different, less trustworthy screen. Change one, look at the other.
    const px = 46
    const pw = W - 92
    const ph = 740
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    panelPlate(g, px, pyTop, pw, ph, 30)
    layer.add(g)
    // Blocker so taps on the card don't fall through to the scrim behind it.
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    const bell = scene.add.text(W / 2, pyTop + 96, '🔔', { fontSize: '76px' }).setOrigin(0.5)
    layer.add(bell)

    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 182, 'NEVER MISS', {
            fontFamily: FONT,
            fontSize: '50px',
            fontStyle: '900',
            color: T.goldText,
          })
          .setOrigin(0.5)
          .setLetterSpacing(2),
        'title'
      )
    )
    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 232, 'A BOARD', {
            fontFamily: FONT,
            fontSize: '30px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(6)
      )
    )

    // Three facts, not three features — the same shape as the race-unlock card, because a player
    // deciding whether to hand over notification permission needs to know exactly what they'd get.
    // The third line is doing real work: "one and only one" is the objection, so answer it unasked.
    const rules: Array<[string, string]> = [
      ['⏰', 'One nudge before the board closes — and that is the only one you will ever get'],
      ['📅', 'A brand-new board every day. When it is gone, it is gone'],
      ['🔕', 'Switch it off whenever you like, in Settings'],
    ]
    rules.forEach(([icon, text], i) => {
      const y = pyTop + 300 + i * 96
      layer.add(scene.add.text(px + 40, y, icon, { fontSize: '29px' }).setOrigin(0, 0.5))
      layer.add(
        scene.add
          .text(px + 88, y, text, {
            fontFamily: FONT,
            fontSize: '19px',
            color: T.inkMuted,
            wordWrap: { width: pw - 128 },
            lineSpacing: 4,
          })
          .setOrigin(0, 0.5)
      )
    })

    // ── The footer: one swappable region, because the ask has four outcomes ────────────────────
    // Rebuilt in place rather than opening a second card, so the answer lands where the question
    // was asked and the player never watches one modal replace another.
    let footer = scene.add.container(0, 0)
    layer.add(footer)
    // The band the race-unlock card puts its "Opened by clearing level 10" note on. Every state
    // below is measured from here, so the plate's bottom margin is one number, not four.
    const footerTop = pyTop + ph - 186

    const setFooter = (build: (into: Phaser.GameObjects.Container) => void): void => {
      footer.destroy()
      footer = scene.add.container(0, 0)
      layer.add(footer)
      build(footer)
    }

    const caption = (text: string, y: number, color: string): Phaser.GameObjects.Text =>
      scene.add
        .text(W / 2, y, text, {
          fontFamily: FONT,
          fontSize: '18px',
          color,
          align: 'center',
          wordWrap: { width: pw - 96 },
          lineSpacing: 4,
        })
        .setOrigin(0.5)

    /** The ask. Telling them the phone's own dialog is next is worth a line: an unexplained system
     *  prompt is the thing people dismiss reflexively. */
    const showOffer = (): void => {
      setFooter(into => {
        into.add(caption('Your phone will ask you to allow it', footerTop, T.inkFaint))
        into.add(addPillButton(scene, W / 2, footerTop + 66, 340, 66, 'REMIND ME', GOLD_PILL, () => ask()))
        into.add(addPillButton(scene, W / 2, footerTop + 140, 220, 50, 'NOT NOW', GHOST_PILL, () => finish()))
      })
    }

    const showWorking = (): void => {
      setFooter(into => {
        into.add(caption('Waiting for your phone…', footerTop + 66, T.inkMuted))
      })
    }

    const showOn = (): void => {
      setFooter(into => {
        const tick = scene.add.text(W / 2, footerTop + 40, '✅', { fontSize: '46px' }).setOrigin(0.5)
        into.add(tick)
        into.add(caption('You are on the list. See you before the board closes.', footerTop + 116, T.inkMuted))
        if (!reduced) {
          tick.setScale(0.4)
          scene.tweens.add({ targets: tick, scale: 1, duration: 420, ease: backOut(OVERSHOOT.pop) })
          sfx.winFanfare()
        }
      })
      // Bows out on its own — there is nothing left to decide, and a player left holding a DONE
      // button after saying yes is being asked to confirm their own confirmation.
      scene.time.delayedCall(reduced ? 900 : CONFIRM_HOLD_MS, () => finish())
    }

    /** A browser-level denial cannot be undone from in here, so don't offer a button that can't win. */
    const showDenied = (): void => {
      setFooter(into => {
        into.add(
          caption(
            'Notifications are blocked for Viva Maya in your browser settings. You can turn them back on there.',
            footerTop + 34,
            T.inkMuted
          )
        )
        into.add(addPillButton(scene, W / 2, footerTop + 134, 220, 56, 'OK', GHOST_PILL, () => finish()))
      })
    }

    /** A network flake is NOT an answer — offer the retry, and keep the latch unspent until they
     *  leave, so a bad minute of signal doesn't cost them the feature. */
    const showFailed = (): void => {
      setFooter(into => {
        into.add(caption('That did not go through. Worth another try?', footerTop + 4, T.inkMuted))
        into.add(addPillButton(scene, W / 2, footerTop + 68, 320, 62, 'TRY AGAIN', GOLD_PILL, () => ask()))
        into.add(addPillButton(scene, W / 2, footerTop + 140, 200, 48, 'NOT NOW', GHOST_PILL, () => finish()))
      })
    }

    const ask = (): void => {
      showWorking()
      // The gesture requirement is satisfied by this tap: enablePush calls requestPermission first
      // thing, synchronously enough to count as user-activated on every engine that enforces it.
      void enablePush().then(res => {
        if (settled) return
        if (res.ok) {
          track(EVENTS.PUSH_ENABLED, { surface: 'card' })
          showOn()
          return
        }
        track(EVENTS.PUSH_BLOCKED, { reason: res.reason ?? 'failed', surface: 'card' })
        if (res.reason === 'denied') showDenied()
        else showFailed()
      })
    }

    showOffer()
    track(EVENTS.PUSH_SHOWN, { surface: 'card' })

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      bell.setScale(0.4)
      scene.tweens.add({ targets: bell, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      // A shake, not a fanfare: this is an invitation, not a prize. The celebration is held back for
      // the confirmation, where there is actually something to celebrate.
      scene.tweens.add({
        targets: bell,
        angle: { from: -12, to: 12 },
        duration: 110,
        delay: 520,
        yoyo: true,
        repeat: 2,
        ease: 'Sine.easeInOut',
        onComplete: () => bell.setAngle(0),
      })
      sfx.objectiveNear()
    }
  })
}

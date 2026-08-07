import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { CHECKIN_CHIPS } from '../core/daily'
import { markSlotsIntroSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL, inkShadow } from './ui'

/**
 * FREE SPIN — the one-time reveal that finally says out loud what the LUCKY SLOTS cabinet holds.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Measured 2026-08-07 across 73 real players: only **24 had ever opened the cabinet**, and 12 of
 * those opened it exactly once and never came back. Seven devices accounted for 79% of all opens.
 * The daily race — which is GATED at level 10 — was opened by 40. The ungated thing lost to the
 * gated thing by 22 points, which rules out the intuitive diagnosis: the door was never hidden. It
 * is a gold pill, front and centre on Home, never deferred, with its own marquee-stud branding.
 *
 * What was hidden was the OFFER. The pill said `LUCKY SLOTS` — a name — and the free daily pull
 * announced itself *only* by that pill being gold rather than grey. Gold is an unlearnable signal:
 * it means nothing until you have already opened the door you are not opening. The `×N FREE SPINS`
 * badge covered banked spins only, so a new player — who has a daily pull and no banked ones — got
 * no words at all. The streak flame is hidden at streak 0, so they got none there either.
 *
 * This card is the moment the race has and the slots never did. The badge fix (HomeScene
 * `buildFreeSpinsBadge`) makes the offer *legible*; this makes it *land once, properly*.
 *
 * ── Why HOME, and why after a win ────────────────────────────────────────────
 * Home because that is where the cabinet is — the point is not "a thing exists" but "here is the
 * thing, one tap away". After a first win because chips and boosts mean nothing to a player who has
 * not yet finished a level: the card would be describing a currency they have never held.
 *
 * ⚠️ Latched in the SAVE (`seenSlotsIntro`) and unioned on merge, so a second device cannot replay
 * it. Latched on RENDER, not on dismissal — a reveal spends itself by being SEEN, and a force-quit
 * mid-card has still seen it. (Contrast `seenPushOffer`, an OFFER, which spends itself by being
 * answered and so latches on the way out.) Absent in every save written before 2026-08-07, which
 * coerces to false: the players who need this most are the existing ones who have been walking past
 * the cabinet for weeks, and they get it once, on their next visit.
 */

export interface FreeSpinCardResult {
  /** True when the player asked to go and pull it — the caller opens the slots cabinet. */
  spinNow: boolean
}

/**
 * Play the reveal. Resolves when the card is dismissed; marks the latch itself so a caller can never
 * forget and re-show it.
 */
export function openFreeSpinCard(scene: Phaser.Scene): Promise<FreeSpinCardResult> {
  return new Promise<FreeSpinCardResult>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    // Latch immediately, not on dismissal — see the header. Same award-first reasoning the daily
    // spin, the jackpot wheel and the race reveal all use.
    markSlotsIntroSeen()

    let settled = false
    const finish = (spinNow: boolean): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve({ spinNow })
    }

    const scrimKit = addFocusScrim(scene, { alpha: 0.72 })
    const scrim = scrimKit.hit.setInteractive()
    scrim.on('pointerup', () => finish(false))
    layer.add([scrim, ...scrimKit.art])

    const px = 46
    const pw = W - 92
    const ph = 740
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    panelPlate(g, px, pyTop, pw, ph, 30)
    layer.add(g)
    // Blocker so taps on the card don't fall through to the scrim.
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    const machine = scene.add.text(W / 2, pyTop + 96, '🎰', { fontSize: '78px' }).setOrigin(0.5)
    layer.add(machine)

    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 182, 'FREE SPIN', {
            fontFamily: FONT,
            fontSize: '52px',
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
          .text(W / 2, pyTop + 232, 'EVERY SINGLE DAY', {
            fontFamily: FONT,
            fontSize: '30px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(4)
      )
    )

    // Three facts, phrased as facts rather than features — the same rule the race reveal follows. A
    // player deciding whether to tap needs to know what the offer IS, and each of these is a real,
    // checkable property of the machine rather than a promise: the GIFT FLOOR in `freeSlotSpin`
    // genuinely guarantees a free pull never pays nothing, and CHECKIN_CHIPS really does ramp to its
    // last entry on the seventh day of a streak.
    const rules: Array<[string, string]> = [
      ['🎁', 'One free pull on the house, every day. It never pays nothing'],
      ['💰', `Chips on top, growing to ${CHECKIN_CHIPS[CHECKIN_CHIPS.length - 1]} a day across a streak week`],
      ['🔥', 'Come back tomorrow and it grows. Miss a day and it starts over'],
    ]
    rules.forEach(([icon, text], i) => {
      const y = pyTop + 300 + i * 96
      layer.add(scene.add.text(px + 40, y, icon, { fontSize: '30px' }).setOrigin(0, 0.5))
      layer.add(
        scene.add
          .text(px + 88, y, text, {
            fontFamily: FONT,
            fontSize: '20px',
            color: T.inkMuted,
            wordWrap: { width: pw - 128 },
            lineSpacing: 4,
          })
          .setOrigin(0, 0.5)
      )
    })

    layer.add(
      scene.add
        .text(W / 2, pyTop + ph - 186, 'It has been waiting on the LUCKY SLOTS cabinet', {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    const spin = addPillButton(scene, W / 2, pyTop + ph - 120, 330, 66, 'PULL IT NOW', GOLD_PILL, () => finish(true))
    layer.add(spin)
    const later = addPillButton(scene, W / 2, pyTop + ph - 46, 220, 50, 'LATER', GHOST_PILL, () => finish(false))
    layer.add(later)

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      machine.setScale(0.4)
      scene.tweens.add({ targets: machine, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      sfx.winFanfare()
    }
  })
}

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import type { BonusDropGrant } from '../core/bonusdrop'
import { BOOST_META } from '../core/inventory'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GOLD_PILL, inkShadow } from './ui'

/**
 * ON THE HOME SCREEN — the HOUSE GIFT's payout card (core/bonusdrop.ts).
 *
 * `installrewardcard.ts` / `streakrewardcard.ts`'s third sibling, built from the same parts on
 * purpose — same plate, same prize rows, same balance line — with one difference that is the whole
 * feature: it opens SEALED.
 *
 * ── Why a sealed box, when the money has already moved ───────────────────────
 * ⚠️ AWARD-FIRST, per the economy's iron rule 4: `claimBonusDrop` banked the chips, the boost and
 * the spins and wrote the day latch BEFORE this card was constructed. The seal is theatre and
 * nothing else — a force-quit between the grant and the reveal keeps every chip, and a re-open
 * re-offers nothing because the latch is already spent. **Nothing in this file may ever be the
 * thing that pays.** The moment OPEN IT is the button that grants, a player who force-quits on the
 * unopened box has been robbed by an animation.
 *
 * The theatre earns its place anyway: the gift is NAMED IN ADVANCE by the push reminder ("a JACKPOT
 * CHIP is on the table today"), so by the time this card opens the player may already know what is
 * inside. The seal is what converts "collect the thing you were told about" back into an opening —
 * and for the player who arrived without a notification, it is the surprise the whole mechanic is
 * named for. Reduced motion skips straight to the opened state, because a player who has asked for
 * less movement has not asked for a slower reveal, they have asked for no reveal.
 */
export function openBonusDropCard(scene: Phaser.Scene, grant: BonusDropGrant): Promise<void> {
  return new Promise<void>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve()
    }

    const scrimKit = addFocusScrim(scene, { alpha: 0.72 })
    const scrim = scrimKit.hit.setInteractive()
    scrim.on('pointerup', () => finish())
    layer.add([scrim, ...scrimKit.art])

    // ── The prize rows, built first because the plate is sized from them ──────────────────────────
    // Same three-row vocabulary as the streak card, and only the rows this gift actually paid: the
    // table runs from 20 chips to chips + a boost + two spins, and a plate padded for the richest
    // day leaves HOUSE CHIPS sitting in a half-empty rectangle that reads as a bug.
    const rows: Array<{ icon: string | null; token: string | null; text: string }> = []
    if (grant.chips > 0) {
      rows.push({ icon: null, token: 'chip', text: `${grant.chips.toLocaleString()} chips, straight into the bank` })
    }
    if (grant.boost) {
      // Named from BOOST_META — the only place a boost is called anything — so the name here, the
      // name in the stash and the name the notification used can never drift apart.
      const meta = BOOST_META[grant.boost]
      rows.push({ icon: meta.icon, token: null, text: `A ${meta.label} — ${meta.blurb.toLowerCase()}` })
    }
    if (grant.freeSpins > 0) {
      rows.push({
        icon: '🎰',
        token: null,
        text: `${grant.freeSpins} free spin${grant.freeSpins === 1 ? '' : 's'} banked — pull them any day`,
      })
    }
    // Defensive: a table entry that paid nothing at all (or a gift whose only prize was spins the
    // full bank refused) would otherwise render an empty plate. The gift table has no such row, but
    // the bank cap can produce one, and "you got nothing" is better said than shown as a blank.
    if (rows.length === 0) {
      rows.push({ icon: '🎰', token: null, text: 'Your free-spin bank is already full — nothing to add today' })
    }

    const px = 46
    const pw = W - 92

    // ⚠️ THE PLATE IS A BUDGET, NOT A GUESS, and it is sized for the OPENED state even while the box
    // is still sealed. A plate that grew when the rows arrived would make the card jump under the
    // player's thumb at the exact moment they are reading it — and the button is seated from the
    // plate's own bottom edge, so a plate sized for the sealed state prints the footer through the
    // control rather than clipping it (the failure the streak card records).
    const ROW_GAP = 84
    const rowTop = 330
    const lastRowY = rowTop + (rows.length - 1) * ROW_GAP
    const balanceY = lastRowY + 70
    const btnH = 64
    const btnY = balanceY + 34 + btnH / 2
    const ph = btnY + 70
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    panelPlate(g, px, pyTop, pw, ph, 30)
    layer.add(g)
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    const hero = scene.add.text(W / 2, pyTop + 96, '🎁', { fontSize: '78px' }).setOrigin(0.5)
    layer.add(hero)

    const title = inkShadow(
      scene.add
        .text(W / 2, pyTop + 186, 'THE HOUSE', {
          fontFamily: FONT,
          fontSize: '46px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2),
      'title'
    )
    const subtitle = inkShadow(
      scene.add
        .text(W / 2, pyTop + 236, 'GIFT', {
          fontFamily: FONT,
          fontSize: '24px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0.5)
        .setLetterSpacing(6)
    )
    layer.add([title, subtitle])

    // The line under the headline. Sealed it is the invitation; opened it is the gift's own blurb.
    const caption = scene.add
      .text(W / 2, pyTop + 282, 'One a day, whether you win or lose. Open it.', {
        fontFamily: FONT,
        fontSize: '18px',
        color: T.inkFaint,
        align: 'center',
        wordWrap: { width: pw - 96 },
        lineSpacing: 4,
      })
      .setOrigin(0.5)
    layer.add(caption)

    // Everything below the fold is built up-front and revealed together, so the opened card is one
    // composition rather than a sequence of things arriving.
    const spoils = scene.add.container(0, 0).setAlpha(0)
    layer.add(spoils)

    rows.forEach((row, i) => {
      const y = pyTop + rowTop + i * ROW_GAP
      if (row.token) {
        // The game's own baked gold chip token, not 🪙 — the coin emoji renders as a dull grey disc
        // on cream, and this is the same token the balance pill above the card is already showing,
        // so the player reads one currency rather than two.
        spoils.add(scene.add.image(px + 60, y, row.token).setDisplaySize(38, 38))
      } else if (row.icon) {
        spoils.add(scene.add.text(px + 44, y, row.icon, { fontSize: '32px' }).setOrigin(0, 0.5))
      }
      spoils.add(
        scene.add
          .text(px + 96, y, row.text, {
            fontFamily: FONT,
            fontSize: '20px',
            color: T.inkMuted,
            wordWrap: { width: pw - 140 },
            lineSpacing: 4,
          })
          .setOrigin(0, 0.5)
      )
    })
    spoils.add(
      scene.add
        .text(W / 2, pyTop + balanceY, `Balance: ${grant.balance.toLocaleString()} chips`, {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    // ── The button seat ──────────────────────────────────────────────────────────────────────────
    // `addPillButton` bakes its label into the pill's geometry (it shrinks the font to fit), so
    // there is no relabel API and the control is REBUILT to change its text — the same move
    // `pushoptin.ts` makes for its four-state footer. What matters is that the replacement lands on
    // the SAME SEAT: a button that moved between OPEN IT and TAKE IT would slide out from under a
    // thumb already on its way down, and the second tap would land on the plate.
    const buttonSeat = scene.add.container(0, 0)
    layer.add(buttonSeat)
    const setButton = (label: string, onTap: () => void): void => {
      buttonSeat.removeAll(true)
      buttonSeat.add(addPillButton(scene, W / 2, pyTop + btnY, 320, btnH, label, GOLD_PILL, onTap))
    }

    /** The opened state — reached by the button, or immediately under reduced motion. */
    let opened = false
    const reveal = (animated: boolean): void => {
      if (opened) return
      opened = true
      hero.setText(grant.drop.emoji)
      title.setText(grant.drop.label)
      subtitle.setText('YOURS')
      caption.setText(grant.drop.blurb)
      setButton('TAKE IT', () => finish())
      if (!animated) {
        spoils.setAlpha(1)
        return
      }
      // The pop is on the HERO alone. A whole-card scale would drag the plate's edges against the
      // scrim and read as the modal reopening rather than as the box giving up its contents.
      hero.setScale(0.35)
      scene.tweens.add({ targets: hero, scale: 1, duration: 420, ease: backOut(OVERSHOOT.pop) })
      scene.tweens.add({ targets: spoils, alpha: 1, duration: 300, delay: 140, ease: 'Sine.easeOut' })
      sfx.winFanfare()
    }

    setButton('OPEN IT', () => reveal(!reduced))

    if (reduced) {
      reveal(false)
      return
    }

    layer.setAlpha(0)
    scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
    hero.setScale(0.4)
    scene.tweens.add({ targets: hero, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
    // A rattle, not a fanfare — there is something moving inside the box and it has not been opened
    // yet. The celebration is held back for the reveal, where there is finally something to
    // celebrate; the same restraint the push opt-in card's bell shake is built on.
    scene.tweens.add({
      targets: hero,
      angle: { from: -9, to: 9 },
      duration: 96,
      delay: 540,
      yoyo: true,
      repeat: 3,
      ease: 'Sine.easeInOut',
      onComplete: () => hero.setAngle(0),
    })
    sfx.objectiveNear()
  })
}

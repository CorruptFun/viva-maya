import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import type { InstallReward } from '../core/install'
import { BOOST_META } from '../core/inventory'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GOLD_PILL, inkShadow } from './ui'

/**
 * ON THE HOME SCREEN — the install reward's payout card.
 *
 * The first launch of the installed app opens with the prize the banner promised. That timing is
 * the entire point of the feature: on iOS there is no install event to pay against (Apple fires
 * nothing), so `claimInstallReward` triggers on the first `standalone` open instead — which means
 * this card IS the receipt, and it has to arrive before anything else on the screen can distract
 * from it. A prize that turns up three taps into a session is a promise the player has already
 * stopped believing.
 *
 * ⚠️ The grant happens BEFORE this opens, in `claimInstallReward` — award-first, per the economy's
 * iron rule 4. A force-quit mid-card keeps the chips and the boost; only the card is lost. This is
 * a receipt for money that has already moved, so it never needs a confirm button, and there is
 * nothing here that can fail.
 */
export function openInstallRewardCard(scene: Phaser.Scene, reward: InstallReward): Promise<void> {
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

    // Shorter than its two siblings (raceunlockcard / pushoptin, both 740): this card has a headline
    // and two prize rows, no rules list and no decision to make.
    const px = 46
    const pw = W - 92
    const ph = 600
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    panelPlate(g, px, pyTop, pw, ph, 30)
    layer.add(g)
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    // 🎁, not 📲. Both are supported and measure identically at this size, but the phone glyph is a
    // narrow dark shape that reads as a smudge on a cream plate, and this card is about the PRIZE
    // rather than about the device. 🎁 is also already the stash door's glyph, so it arrives
    // pre-associated with "something is waiting for you".
    const gift = scene.add.text(W / 2, pyTop + 92, '🎁', { fontSize: '74px' }).setOrigin(0.5)
    layer.add(gift)

    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 178, 'YOU’RE IN', {
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
          .text(W / 2, pyTop + 226, 'THANKS FOR INSTALLING', {
            fontFamily: FONT,
            fontSize: '21px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(3)
      )
    )

    // The two prizes. The boost is named from BOOST_META — the only place a boost is called
    // anything — so what is promised here and the row the player finds in the stash can never drift.
    const boostMeta = BOOST_META[reward.boost]
    const rowText = (y: number, text: string): void => {
      layer.add(
        scene.add
          .text(px + 96, y, text, {
            fontFamily: FONT,
            fontSize: '20px',
            color: T.inkMuted,
            wordWrap: { width: pw - 140 },
            lineSpacing: 4,
          })
          .setOrigin(0, 0.5)
      )
    }

    // The game's own baked gold chip token, not 🪙 — the coin emoji renders as a dull grey disc on
    // cream, and this is the same token the balance pill above the card is already showing, so the
    // player reads one currency rather than two.
    const chipY = pyTop + 300
    layer.add(scene.add.image(px + 60, chipY, 'chip').setDisplaySize(38, 38))
    rowText(chipY, `${reward.chips.toLocaleString()} chips, straight into the bank`)

    const boostY = pyTop + 384
    layer.add(scene.add.text(px + 44, boostY, boostMeta.icon, { fontSize: '32px' }).setOrigin(0, 0.5))
    rowText(boostY, `A ${boostMeta.label} — ${boostMeta.blurb.toLowerCase()}`)

    layer.add(
      scene.add
        .text(W / 2, pyTop + 452, `Balance: ${reward.balance.toLocaleString()} chips`, {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    layer.add(addPillButton(scene, W / 2, pyTop + ph - 70, 300, 64, 'NICE', GOLD_PILL, () => finish()))

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      gift.setScale(0.4)
      scene.tweens.add({ targets: gift, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      sfx.winFanfare()
    }
  })
}

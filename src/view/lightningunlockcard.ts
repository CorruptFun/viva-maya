import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { LIGHTNING_UNLOCK_LEVEL, MAX_STRIKES, START_QUOTA, START_SECONDS } from '../core/lightning'
import { markLightningUnlockSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL, inkShadow } from './ui'

/**
 * ⚡ LIGHTNING ROUND UNLOCKED — the one-time reveal, shown on Home once level 5 is cleared.
 *
 * ── Why a gated mode gets a card and an ungated one does not ─────────────────
 * This card is the reason the mode is gated at all. Measured 2026-08-07 across 73 real players: the
 * ungated LUCKY SLOTS cabinet had been opened by 24 (33%), the level-10-gated daily race by 40 (55%).
 * The gated thing beat the ungated one by 22 points, which kills the intuitive reading that a gate
 * suppresses discovery. What a gate actually buys is a MOMENT — a point in time at which the game can
 * say "this exists now". A door that has always been there is never new, and a thing that is never
 * new is wallpaper; the slots pill has sat gold and front-and-centre on Home the whole time.
 *
 * So the gate is not a tax on the player, it is the price of this card existing at all.
 *
 * ── Why HOME, and why these three facts ──────────────────────────────────────
 * Home for the same reason `raceunlockcard.ts` is: the point is not "you unlocked a thing" but "here
 * is the thing", one tap from where it lives. Threading it through the win chain would bury it behind
 * celebrations that have nothing to do with it.
 *
 * The three lines are FACTS about the contest, not features — a player deciding whether to tap needs
 * to know what the game IS. Each is read from `core/lightning.ts` rather than typed here, so a retune
 * of the opening quota or the strike count cannot leave this card quietly lying about the rules.
 *
 * ⚠️ Latched in the SAVE (`seenLightningUnlock`) and unioned on merge, so a second device cannot
 * replay it. Latched on RENDER, not on dismissal — a reveal spends itself by being SEEN, and a
 * force-quit mid-card has still seen it. (Contrast `seenPushOffer`, an OFFER, which spends itself by
 * being answered.) Absent in every save written before the storm shipped, which coerces to false: the
 * existing cohort is already well past level 5 and gets the reveal once, on their next visit.
 */

export interface LightningUnlockResult {
  /** True when the player asked to go straight in — the caller starts the round. */
  playNow: boolean
}

export function openLightningUnlockCard(scene: Phaser.Scene): Promise<LightningUnlockResult> {
  return new Promise<LightningUnlockResult>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    markLightningUnlockSeen()

    let settled = false
    const finish = (playNow: boolean): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve({ playNow })
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
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    const bolt = scene.add.text(W / 2, pyTop + 96, '⚡', { fontSize: '78px' }).setOrigin(0.5)
    layer.add(bolt)

    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 182, 'LIGHTNING', {
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
          .text(W / 2, pyTop + 232, 'ROUND UNLOCKED', {
            fontFamily: FONT,
            fontSize: '28px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(4)
      )
    )

    // Read from core/lightning.ts, never typed in — see the header.
    const rules: Array<[string, string]> = [
      ['⏱️', `Clear ${START_QUOTA} pieces in ${START_SECONDS} seconds. Then it gets faster`],
      ['⚡', 'Miss it and lightning takes the board — a fresh one, on the spot'],
      ['💛', `${MAX_STRIKES - 1} strikes to spare. It costs no hearts, win or lose`],
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
        .text(W / 2, pyTop + ph - 186, `Opened by clearing level ${LIGHTNING_UNLOCK_LEVEL}`, {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    layer.add(
      addPillButton(scene, W / 2, pyTop + ph - 120, 330, 66, 'BRING IT ON', GOLD_PILL, () => finish(true))
    )
    layer.add(addPillButton(scene, W / 2, pyTop + ph - 46, 220, 50, 'LATER', GHOST_PILL, () => finish(false)))

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      bolt.setScale(0.4)
      scene.tweens.add({ targets: bolt, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      // The card's own thunder — the same voice the strike uses, so the reveal sounds like the thing
      // it is describing rather than like every other celebration in the game.
      sfx.thunderCrack()
    }
  })
}

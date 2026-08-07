import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { ROUND_SECONDS, START_QUOTA, START_SECONDS } from '../core/lightning'
import { markStormIntroSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GOLD_PILL, inkShadow } from './ui'

/**
 * ⚡ THE STORM — the teach-once card, shown as the first storm arrives and never again.
 *
 * ── Why this is a TEACH card and not an unlock reveal ────────────────────────
 * The storm is not unlocked; it is EARNED and simply happens. So this belongs to the family of
 * `hazardIntros` / `specialIntros` — explain a new rule the first time the player meets it, on a
 * settled board, with the thing about to be visible — rather than to `raceunlockcard.ts`'s family of
 * "a new place now exists, here is the door".
 *
 * That difference is the whole reason there is no Home door, no gate and no unlock moment to buy.
 * The measured problem this design avoids: as of 2026-08-07, 24 of 73 real players had ever opened
 * the ungated LUCKY SLOTS cabinet — a fully built mode behind a gold pill in the middle of Home. A
 * bonus that comes TO the player has no discovery problem to solve.
 *
 * ── Why these three facts ────────────────────────────────────────────────────
 * They are FACTS about what is about to happen, not features. A player about to lose their board to
 * a storm needs to know what the contest is and — critically — that it cannot cost them anything.
 * Each is read from `core/lightning.ts` rather than typed here, so a retune of the opening quota,
 * the clock or the strike count cannot leave this card quietly lying about the rules.
 *
 * ⚠️ Latched in the SAVE (`seenStormIntro`) and unioned on merge, so a second device does not
 * re-teach a rule already learned. Latched on RENDER, not on dismissal: a force-quit mid-card has
 * still seen it, and re-teaching is worse than skipping.
 */

export interface StormIntroResult {
  /** Resolves when the card is dismissed. The caller then hands the board to the storm. */
  dismissed: true
}

export function openStormIntroCard(scene: Phaser.Scene): Promise<StormIntroResult> {
  return new Promise<StormIntroResult>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    markStormIntroSeen()

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve({ dismissed: true })
    }

    const scrimKit = addFocusScrim(scene, { alpha: 0.72 })
    const scrim = scrimKit.hit.setInteractive()
    scrim.on('pointerup', () => finish())
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
          .text(W / 2, pyTop + 182, 'A STORM', {
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
          .text(W / 2, pyTop + 232, 'IS ROLLING IN', {
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
    //
    // ⚠️ The middle line is the one that has to land. The mode's whole shape is "the clock is your
    // life and you can win more of it", and a player who reads only "beat the clock" will play it as
    // survival rather than as something to feed. It is stated as the reward it is, not as a rule.
    const rules: Array<[string, string]> = [
      ['⏱️', `${START_SECONDS} seconds. One clock — it never resets, and when it runs out you're done`],
      ['⚡', `Clear ${START_QUOTA} pieces to win +${ROUND_SECONDS}s. Big chains pay time too`],
      ['💛', 'Then it asks for more. See how far you get — it pays either way'],
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
        .text(W / 2, pyTop + ph - 176, 'You earned this by clearing pieces', {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    // ONE button. There is no LATER: the storm is already here, the charge is already spent, and an
    // opt-out would either strand that charge or need a whole defer-and-restore path for a card that
    // is shown exactly once. A bonus you can accidentally decline is a bonus most people decline.
    layer.add(addPillButton(scene, W / 2, pyTop + ph - 96, 330, 66, 'BRING IT ON', GOLD_PILL, () => finish()))

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

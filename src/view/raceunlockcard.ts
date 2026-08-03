import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { ENDLESS_MOVES, ENDLESS_UNLOCK_LEVEL } from '../core/endless'
import { markRaceUnlockSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL } from './ui'

/**
 * DAILY RACE UNLOCKED — the one-time reveal, shown on Home the first time endless is open.
 *
 * ── Why this exists, and why it lives on HOME ────────────────────────────────
 * Until now the race simply *appeared*. A player cleared a level, went back to Home, and a module
 * that had been a dim "unlocks at level N" signpost was quietly a live thing — with no explanation
 * of what it was, that everyone plays the same board, or that it resets every night. The single
 * most repeatable, most social feature in the game introduced itself by changing colour.
 *
 * Home rather than the level-end screen on purpose. The point is not "you unlocked a thing", it is
 * "here is the thing" — and the thing is on this screen, behind this card. The win chain is also
 * already three deep (jackpot wheel → deal → plinko) and threading a fourth moment through it would
 * bury the reveal behind celebrations that have nothing to do with it.
 *
 * It rides HomeScene's existing growth-celebration queue as step 0, ahead of coronation and recap,
 * because a brand-new racer cannot have won anything yet — and because it is the card that explains
 * every card that could follow it.
 *
 * ⚠️ Latched in the SAVE (`seenRaceUnlock`), not in localStorage, so a second device doesn't replay
 * it. The field is absent from every save written before 2026-08-03 and coerces to false, which is
 * deliberate: the unlock moved from level 20 to level 10 that same day, so a large number of
 * existing players are "already unlocked" and have still never had the race explained to them. They
 * get it once, on their next visit.
 */

export interface RaceUnlockResult {
  /** True when the player asked to see the board — the caller opens the race panel. */
  showBoard: boolean
}

/**
 * Play the reveal. Resolves when the card is dismissed; marks the latch itself so a caller can never
 * forget and re-show it. `onDismissed` fires before the promise resolves so the caller can chain.
 */
export function openRaceUnlockCard(scene: Phaser.Scene): Promise<RaceUnlockResult> {
  return new Promise<RaceUnlockResult>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    // Latch immediately, not on dismissal. A player who force-quits mid-card has still SEEN it, and
    // re-showing a one-time reveal is worse than skipping it — the same award-first reasoning the
    // daily spin and the jackpot wheel use.
    markRaceUnlockSeen()

    let settled = false
    const finish = (showBoard: boolean): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve({ showBoard })
    }

    const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH() + 400, T.scrim, 0.72).setInteractive()
    scrim.on('pointerup', () => finish(false))
    layer.add(scrim)

    const px = 46
    const pw = W - 92
    const ph = 740
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(px, pyTop, pw, ph, 30)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(px, pyTop, pw, ph, 30)
    layer.add(g)
    // Blocker so taps on the card don't fall through to the scrim.
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    const trophy = scene.add.text(W / 2, pyTop + 96, '🏆', { fontSize: '78px' }).setOrigin(0.5)
    layer.add(trophy)

    layer.add(
      scene.add
        .text(W / 2, pyTop + 182, 'DAILY RACE', {
          fontFamily: FONT,
          fontSize: '52px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2)
    )
    layer.add(
      scene.add
        .text(W / 2, pyTop + 232, 'UNLOCKED', {
          fontFamily: FONT,
          fontSize: '30px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0.5)
        .setLetterSpacing(6)
    )

    // The three rules that make the race make sense. Kept to three, and phrased as facts rather than
    // features — a player deciding whether to tap needs to know what the contest IS.
    const rules: Array<[string, string]> = [
      ['🎲', 'Everyone plays the exact same board — no boosts, no luck of the draw'],
      ['📅', `${ENDLESS_MOVES} moves, one score. A brand-new board every single day`],
      ['👑', 'Top score when the day closes wins it. Then it all resets'],
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
        .text(W / 2, pyTop + ph - 186, `Opened by clearing level ${ENDLESS_UNLOCK_LEVEL}`, {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    const see = addPillButton(scene, W / 2, pyTop + ph - 120, 330, 66, 'SEE THE BOARD', GOLD_PILL, () => finish(true))
    layer.add(see)
    const later = addPillButton(scene, W / 2, pyTop + ph - 46, 220, 50, 'LATER', GHOST_PILL, () => finish(false))
    layer.add(later)

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      trophy.setScale(0.4)
      scene.tweens.add({ targets: trophy, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      sfx.winFanfare()
    }
  })
}

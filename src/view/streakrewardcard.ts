import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { nextStreakReward, type StreakRewardGrant } from '../core/daily'
import { BOOST_META } from '../core/inventory'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GOLD_PILL, inkShadow } from './ui'

/**
 * ON THE LUCKY SLOTS CABINET — the STREAK REWARD's payout card.
 *
 * Shown when the daily pull lands on a rung of the ladder (core/daily.ts STREAK_REWARDS — 3 / 7 /
 * 14 / 30 / 60 / 100 consecutive days). `installrewardcard.ts`'s twin, and built from the same
 * parts on purpose: both are receipts for money that has already moved, so neither has a confirm
 * button and neither can fail.
 *
 * ⚠️ AWARD-FIRST, per the economy's iron rule 4 — the grant happened inside `advanceDailyRitual`,
 * several beats before this opens. A force-quit mid-card keeps the chips, the boost and the spins;
 * only the card is lost. Nothing here may ever be the thing that pays.
 *
 * ── The last line is the feature ─────────────────────────────────────────────
 * The footer names the NEXT rung and how many days away it is. That sentence, not the purse above
 * it, is what a streak ladder is for: a reward the player only ever discovers by receiving it
 * cannot incentivise the day after. It is the same lesson the free-spin reveal was built on — the
 * cabinet's door was never hidden, the OFFER was — and it is why `nextStreakReward` exists as a
 * public function rather than as a private detail of the grant.
 */
export function openStreakRewardCard(scene: Phaser.Scene, grant: StreakRewardGrant): Promise<void> {
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

    // Sized to the rows it actually has rather than to a fixed height: the ladder pays between one
    // prize (day 3, chips only) and three (day 14 up, chips + boost + spins), and a card padded for
    // the tallest case leaves day 3 sitting in a half-empty plate that reads as a bug.
    const rows: Array<{ icon: string | null; token: string | null; text: string }> = [
      { icon: null, token: 'chip', text: `${grant.chips.toLocaleString()} chips, straight into the bank` },
    ]
    if (grant.boost) {
      // Named from BOOST_META — the only place a boost is called anything — so what is promised here
      // and the row the player finds in the stash can never drift.
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

    const px = 46
    const pw = W - 92

    // The forward look. Phrased as the thing that is now AT STAKE rather than as a fact about the
    // calendar, the same way the Home flame badge switches from `3 DAY STREAK` to `3 DAYS — SPIN
    // TODAY`: a player needs the next prize and the cost of missing it in one sentence.
    //
    // ⚠️ BUILT AND MEASURED BEFORE THE PLATE, because it is the one line here whose height is not
    // knowable in advance — it WRAPS, and the topped-out sentence is the longest string on the card
    // (measured 648px against a 628px plate, i.e. it hung off both edges on the very rung that is
    // hardest to reach). Wrapping alone would only have traded the overflow for a collision with the
    // button below, so the plate is sized from what this actually rendered to rather than from an
    // assumed single line. A longer rung label or a reworded fallback now costs a taller card, which
    // is the failure that is visible in a screenshot instead of the one that is not.
    const next = nextStreakReward(grant.reward.day)
    const away = next ? next.day - grant.reward.day : 0
    const nextLine = scene.add
      .text(
        W / 2,
        0,
        next
          ? `${away} more day${away === 1 ? '' : 's'} → ${next.label}`
          : 'Top of the ladder — the daily gift keeps coming',
        {
          fontFamily: FONT,
          fontSize: '19px',
          fontStyle: '900',
          color: T.goldText,
          align: 'center',
          wordWrap: { width: pw - 72 },
          lineSpacing: 4,
        }
      )
      .setOrigin(0.5)
      .setLetterSpacing(1)

    // ⚠️ THE PLATE IS A BUDGET, NOT A GUESS. Every seat below is derived from the one above it and
    // the plate is sized from the LAST of them, because the card has three different heights (one,
    // two or three prize rows) and the only thing that changes between them is where the bottom is.
    // Sizing the plate with a literal is what put the "N more days →" line underneath the NICE
    // button on the three-row variant — the button is seated from the plate's own bottom edge, so a
    // plate an inch too short does not clip the footer, it prints the footer through the control.
    const ROW_GAP = 84
    const rowTop = 316
    const lastRowY = rowTop + (rows.length - 1) * ROW_GAP
    const balanceY = lastRowY + 72
    const nextY = balanceY + 24 + nextLine.height / 2
    const btnH = 64
    // Half the button plus real clearance under the last line of type — the gap the eye reads as
    // "these are separate things", and the margin that keeps a longer rung name off the control.
    const btnY = nextY + nextLine.height / 2 + 30 + btnH / 2
    const ph = btnY + 70
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    panelPlate(g, px, pyTop, pw, ph, 30)
    layer.add(g)
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    const hero = scene.add.text(W / 2, pyTop + 92, grant.reward.emoji, { fontSize: '74px' }).setOrigin(0.5)
    layer.add(hero)

    // The DAY COUNT is the headline, not the prize — the player is being congratulated for the
    // streak, and the purse is the evidence. Naming the number is also the only way the card can be
    // told apart at a glance from the day-5 double, which pays on a different rhythm entirely.
    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 178, grant.reward.label, {
            fontFamily: FONT,
            fontSize: '46px',
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
          .text(W / 2, pyTop + 228, `${grant.reward.day} DAYS IN A ROW`, {
            fontFamily: FONT,
            fontSize: '21px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(3)
      )
    )

    rows.forEach((row, i) => {
      const y = pyTop + rowTop + i * ROW_GAP
      if (row.token) {
        // The game's own baked gold chip token, not 🪙 — the coin emoji renders as a dull grey disc
        // on cream, and this is the same token the balance pill is already showing, so the player
        // reads one currency rather than two.
        layer.add(scene.add.image(px + 60, y, row.token).setDisplaySize(38, 38))
      } else if (row.icon) {
        layer.add(scene.add.text(px + 44, y, row.icon, { fontSize: '32px' }).setOrigin(0, 0.5))
      }
      layer.add(
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

    layer.add(
      scene.add
        .text(W / 2, pyTop + balanceY, `Balance: ${grant.balance.toLocaleString()} chips`, {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    layer.add(nextLine.setY(pyTop + nextY))

    layer.add(addPillButton(scene, W / 2, pyTop + btnY, 300, btnH, 'NICE', GOLD_PILL, () => finish()))

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      hero.setScale(0.4)
      scene.tweens.add({ targets: hero, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      sfx.winFanfare()
    }
  })
}

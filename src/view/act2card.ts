import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { EVENTS, track } from '../core/analytics'
import { FLOORS } from '../core/actII'
import { ACT1_LEVELS } from '../core/levels'
import { markAct2RevealSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL, inkShadow } from './ui'

/**
 * THE PRIVATE ELEVATOR — the one-time reveal that opens ACT II.
 *
 * Built on `raceunlockcard.ts`'s pattern, deliberately and completely: same scrim + plate, same
 * latch-immediately rule, same two-door delivery. Where the race card explains a feature, this one
 * explains a PLACE — the point is not "you unlocked a hundred levels", it is "there is an upstairs,
 * and you have just been handed the key to it".
 *
 * ── The two doors ───────────────────────────────────────────────────────────
 * 1. Chained after the chapter-30 car ceremony, BEFORE the result card. That is the moment it means
 *    something: you have just been handed the grand prize of a game you thought you finished, and
 *    the next thing that happens is a lift arriving.
 * 2. HomeScene's growth-celebration queue, step 0. Without it, everyone who cleared level 300 before
 *    this shipped would simply find a hundred new levels on the map with no explanation — the same
 *    cohort problem `seenRaceUnlock` was written for, and the same fix.
 *
 * ⚠️ Latched in the SAVE (`seenAct2Reveal`), union-merged, so a second device does not replay it.
 * Latched on RENDER rather than on dismissal, like every other one-time card here: a player who
 * force-quits mid-card has still seen it, and re-showing a one-time reveal is worse than skipping it.
 */

/** Where the card was opened from — carried on the analytics event so the two doors stay separable. */
export type Act2RevealSource = 'finale' | 'home'

export interface Act2RevealResult {
  /** True when the player asked to go straight up — the caller starts level `ACT1_LEVELS + 1`. */
  goUp: boolean
}

export function openAct2Card(scene: Phaser.Scene, source: Act2RevealSource): Promise<Act2RevealResult> {
  return new Promise<Act2RevealResult>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    markAct2RevealSeen()
    track(EVENTS.ACT2_REVEAL, { source })

    let settled = false
    const finish = (goUp: boolean): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve({ goUp })
    }

    const scrimKit = addFocusScrim(scene, { alpha: 0.76 })
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

    // The doors themselves — two gold panels parting on a dark shaft. Drawn rather than glyphed:
    // no emoji reads as "a lift you are being invited into", and this is the one image the whole
    // act hangs off. Cheap (one Graphics, baked once at open, never touched again).
    const doorW = 168
    const doorH = 132
    // ⚠️ Drawn in LOCAL coordinates inside a container seated at the door's centre. A Graphics
    // scales about its own origin, so a world-coordinate drawing tweened from 0.5 would fly toward
    // the top-left of the screen instead of growing in place.
    const art = scene.add.container(W / 2, pyTop + 48 + doorH / 2)
    const door = scene.add.graphics()
    const x0 = -doorW / 2
    const y0 = -doorH / 2
    door.fillStyle(T.navy, 1)
    door.fillRoundedRect(x0 - 12, y0 - 10, doorW + 24, doorH + 20, 10)
    door.fillStyle(T.goldDarkest, 1)
    door.fillRect(x0, y0, doorW, doorH)
    const leaf = doorW / 2 - 3
    for (const lx of [x0, x0 + doorW / 2 + 3]) {
      door.fillStyle(T.goldDeep, 1)
      door.fillRect(lx, y0, leaf, doorH)
      door.fillStyle(T.gold, 1)
      door.fillRect(lx + 3, y0 + 3, leaf - 6, doorH - 6)
      door.fillStyle(T.goldBright, 0.5)
      door.fillRect(lx + 7, y0 + 7, leaf - 14, 12)
      // Two inlaid bands per leaf — enough grain to read as brass rather than a flat swatch.
      door.fillStyle(T.goldDeep, 0.65)
      door.fillRect(lx + 10, y0 + 40, leaf - 20, 5)
      door.fillRect(lx + 10, y0 + 78, leaf - 20, 5)
    }
    door.lineStyle(3, T.goldBezel, 1)
    door.strokeRoundedRect(x0 - 12, y0 - 10, doorW + 24, doorH + 20, 10)
    art.add(door)
    layer.add(art)

    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 214, 'THE PRIVATE ELEVATOR', {
            fontFamily: FONT,
            fontSize: '38px',
            fontStyle: '900',
            color: T.goldText,
          })
          .setOrigin(0.5)
          .setLetterSpacing(1),
        'title'
      )
    )
    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 254, 'ACT II UNLOCKED', {
            fontFamily: FONT,
            fontSize: '26px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(6)
      )
    )

    // Three facts, not three features — the race card's rule. A player deciding whether to step in
    // needs to know where this goes, what is different up there, and that the House has noticed.
    const facts: Array<[string, string]> = [
      // ⚠️ Icons stay in the card's own warm vocabulary. 🛗 is the literal glyph for this and it was
      // the first choice; it renders as a BLUE SIGN, which is the one colour nothing else on a cream
      // card wears, so it read as a pasted-in UI element rather than as part of the room.
      ['🎩', `Levels ${ACT1_LEVELS + 1} and up — ${FLOORS.length} new floors above the main floor`],
      ['🎰', 'A new move: pull a whole column down with the slot arm'],
      ['🏆', 'Fifty levels a floor — and a new trophy wing to fill'],
    ]
    // The race card's proven three-row geometry (300 / step 96), not a fresh number. At 330/94 the
    // third row wrapped to two lines and landed 6px off the provenance line under it — the same
    // clipped-teach-card defect Slice 0 shipped and had to fix in browser verification.
    facts.forEach(([icon, text], i) => {
      const y = pyTop + 306 + i * 96
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
        .text(W / 2, pyTop + ph - 186, 'The House has been watching you play', {
          fontFamily: FONT,
          fontSize: '17px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
    )

    const go = addPillButton(scene, W / 2, pyTop + ph - 120, 330, 66, 'GO UP', GOLD_PILL, () => finish(true))
    layer.add(go)
    const later = addPillButton(scene, W / 2, pyTop + ph - 46, 220, 50, 'LATER', GHOST_PILL, () => finish(false))
    layer.add(later)

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      // ⚠️ `art` is a CONTAINER at scale 1, so tweening to `scale: 1` returns it exactly where it
      // started. That is only true because nothing inside it was sized with setDisplaySize — the
      // rule this file inherits is: never put an Image whose size you set into a `scale: 1` tween.
      art.setScale(0.5)
      scene.tweens.add({ targets: art, scale: 1, duration: 480, delay: 120, ease: backOut(OVERSHOOT.pop) })
      sfx.winFanfare()
    }
  })
}

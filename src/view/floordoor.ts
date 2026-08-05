import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { EVENTS, track } from '../core/analytics'
import { floorFor, isFloorOpening } from '../core/actII'
import { markFloorIntroSeen } from '../core/save'
import { floorMood, floorPlateLabel, moodsLive } from './floormood'
import { addFocusScrim, panelPlate } from './platekit'
import { css, getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GOLD_PILL, inkShadow } from './ui'

/**
 * THE FLOOR DOOR — a one-time card on the first level of each floor, carrying the croupier's
 * introduction. `hazardIntros`' twin in every respect: latched in the save (`floorIntros`, union-
 * merged), latched on RENDER not on dismissal, and shown exactly once per floor per player.
 *
 * Deliberately NOT a teach card. Nothing here is a rule — the rail teaches itself at 301 and the
 * plaque taught itself at 201. This is the House introducing a room, which is the one thing an
 * expansion made of numbers cannot do for itself.
 *
 * Returns false (showing nothing, calling nothing) when the level does not open a floor, when the
 * card has already been seen, or with moods switched off — so the caller can chain on it.
 */
export function maybeFloorDoor(scene: Phaser.Scene, level: number, then: () => void): boolean {
  if (!moodsLive() || !isFloorOpening(level)) return false
  const floor = floorFor(level)
  const mood = floorMood(level)
  if (!floor || !mood) return false
  if (!markFloorIntroSeen(floor.floor)) return false

  track(EVENTS.FLOOR_ENTER, { floor: floor.floor, level })

  const T = getTheme()
  const reduced = prefersReducedMotion()
  const W = DESIGN_W
  const layer = scene.add.container(0, 0).setDepth(65)
  const scrimKit = addFocusScrim(scene, { alpha: 0.66, ink: 0x2a2417 })
  const scrim = scrimKit.hit.setInteractive()
  let settled = false
  const close = (): void => {
    if (settled) return
    settled = true
    sfx.whoosh()
    layer.destroy()
    then()
  }
  scrim.on('pointerup', close)
  layer.add([scrim, ...scrimKit.art])

  const pw = 600
  const ph = 440
  const px = (W - pw) / 2
  const pyTop = viewportCenterY() - ph / 2

  const g = scene.add.graphics()
  panelPlate(g, px, pyTop, pw, ph, 28)
  layer.add(g)
  layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

  // A nameplate in the floor's own accent — the same plate the level map wears, at card scale, so
  // arriving on the floor and reading about it on the map are visibly the same place.
  const plate = scene.add.graphics()
  plate.fillStyle(mood.accent, 1)
  plate.fillRoundedRect(px + 40, pyTop + 40, pw - 80, 52, 12)
  plate.fillStyle(0xffffff, 0.14)
  plate.fillRoundedRect(px + 44, pyTop + 44, pw - 88, 18, 8)
  layer.add(plate)
  layer.add(
    scene.add
      .text(W / 2, pyTop + 66, floorPlateLabel(floor), {
        fontFamily: FONT,
        fontSize: '21px',
        fontStyle: '900',
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )

  layer.add(
    inkShadow(
      scene.add
        .text(W / 2, pyTop + 132, 'THE FLOOR IS OPEN', {
          fontFamily: FONT,
          fontSize: '18px',
          fontStyle: '900',
          color: css(mood.accent),
        })
        .setOrigin(0.5)
        .setLetterSpacing(4)
    )
  )

  // The croupier speaks — one voice per floor, in quotes, because it is a PERSON talking and the
  // rest of this game's copy is the game talking.
  layer.add(
    scene.add
      .text(W / 2, pyTop + 208, `“${mood.croupier}”`, {
        fontFamily: FONT,
        fontSize: '23px',
        fontStyle: 'italic',
        color: T.ink,
        align: 'center',
        wordWrap: { width: pw - 96 },
        lineSpacing: 6,
      })
      .setOrigin(0.5)
  )
  layer.add(
    scene.add
      .text(W / 2, pyTop + 302, mood.blurb, {
        fontFamily: FONT,
        fontSize: '18px',
        color: T.inkMuted,
        align: 'center',
        wordWrap: { width: pw - 96 },
        lineSpacing: 4,
      })
      .setOrigin(0.5)
  )

  layer.add(addPillButton(scene, W / 2, pyTop + ph - 54, 260, 58, 'GOOD EVENING', GOLD_PILL, close))

  if (!reduced) {
    layer.setAlpha(0)
    scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
    // ⚠️ NO scale tween on `plate`. It is a Graphics drawn in WORLD coordinates, so it scales about
    // (0,0) — the top-left of the screen — and a 0.9→1 tween would slide the nameplate in from the
    // corner rather than growing it in place. Scaling a Graphics only works when it was drawn in
    // LOCAL coordinates inside a container seated where you want the pivot (see view/act2card.ts).
    // The layer fade carries the entrance instead.
  }
  return true
}

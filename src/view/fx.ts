/**
 * Full-screen effects layer for Viva Maya (§F2/§F3) — the OVER-scene sibling of `background.ts`.
 *
 * Where the backdrop fakes lounge depth BEHIND the gameplay (negative depth), this module adds the
 * barely-there glass-and-light finish ON TOP of it: a whisper of over-screen vignette plus one or
 * two slow-drifting warm light-leaks, the kind of soft lens bloom a modern app composites over its
 * whole frame. It is deliberately the quietest layer in the app — depth in the 50s (over the scene
 * UI, under every panel/overlay at ≥ 60), ADD-blended warm theme light at single-digit alphas, and
 * screen-anchored (scrollFactor 0) so the §E10 entrance nudge never bends it.
 *
 * Discipline (matching background.ts's three guarantees):
 *  1. Governor-gated: the whole layer is SKIPPED on the low tier — it is pure finish, zero function.
 *  2. Reduced motion: the leaks freeze at their resting alpha (static warmth, no drift, no pulse,
 *     no per-frame read) — the calm path costs nothing and flashes nothing.
 *  3. Zero per-frame allocation: two baked `bgglow` images + one Graphics, animated only with slow
 *     transform/alpha tweens; the heartbeat shimmer is a single UPDATE read of `heartbeat.amp()`
 *     (the same pattern every hero breather already uses), unhooked on scene shutdown.
 */
import Phaser from 'phaser'
import { DESIGN_W, worldH } from '../config'
import { ensureBandTexture } from './background'
import { D, E, heartbeat, reduced } from './motion'
import { quality } from './quality'
import { getTheme } from './theme'

/** Depth for the gloss stack: above the scene's own UI (≤ 50), below panels/overlays (≥ 60). */
const GLOSS_DEPTH = 52

/** Slow leak drift, derived from the breath token so the gloss moves on ambient time. */
const T_LEAK = D.breath * 3.6

/**
 * §F3 · ambient screen gloss for Home: a very subtle over-screen vignette (four warm gradient edge
 * bands — the backdrop vignette's exact recipe at a fraction of its strength, so the UI sits "inside
 * the glass") plus two warm light-leaks loafing along the top corners. The primary leak's alpha is
 * phase-locked to the shared `heartbeat` clock, so the glass glints in time with the PLAY halo and
 * every other hero breather. Skipped entirely on the low tier; static (no drift/pulse) under reduced
 * motion. Everything is created once and lives with the scene — nothing transient, nothing per-frame
 * beyond the one heartbeat read.
 */
export function addScreenGloss(scene: Phaser.Scene): void {
  if (quality.tier() === 'low') return // pure finish — the first thing weak hardware sheds
  if (!scene.textures.exists('bgglow')) return
  const T = getTheme()
  const still = reduced()
  const W = DESIGN_W
  const H = worldH() // scrollFactor-0 space: the camera viewport spans the full visible world

  // --- Over-screen vignette: the faintest inward focus ON TOP of the UI (warm ink, never black).
  // Same four-band technique as the backdrop vignette, at ~1/3 its alpha, screen-anchored — drawn as
  // tinted `bgband` images, not fillGradientStyle, which mis-composites on the transparent canvas
  // (see background.ensureBandTexture).
  ensureBandTexture(scene)
  const ink = T.vignetteInk
  const Vt = 0.035
  const Vb = 0.055
  const Vs = 0.04
  const band = (x: number, y: number, w: number, h: number, alpha: number, angle: number): void => {
    scene.add
      .image(x, y, 'bgband')
      .setDisplaySize(w, h)
      .setAngle(angle)
      .setTint(ink)
      .setAlpha(alpha)
      .setDepth(GLOSS_DEPTH)
      .setScrollFactor(0)
  }
  band(W / 2, 110, W, 220, Vt, 0) // top (fades down)
  band(W / 2, H - 130, W, 260, Vb, 180) // bottom (fades up)
  band(60, H / 2, H, 120, Vs, -90) // left (fades right)
  band(W - 60, H / 2, H, 120, Vs, 90) // right (fades left)

  // --- Warm light-leaks: big soft `bgglow` smudges bleeding in from the top corners, drifting on
  // slow yoyo loops so the light never sits perfectly still. Single-digit alphas — felt, not seen.
  const leak = (x: number, y: number, size: number, tint: number, a: number, delay: number): Phaser.GameObjects.Image => {
    const img = scene.add
      .image(x, y, 'bgglow')
      .setDisplaySize(size, size)
      .setTint(tint)
      .setAlpha(a)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScrollFactor(0)
      .setDepth(GLOSS_DEPTH)
    if (!still) {
      scene.tweens.add({ targets: img, x: x + 42, y: y + 26, duration: T_LEAK, delay, yoyo: true, repeat: -1, ease: E.hero })
    }
    return img
  }
  const primary = leak(-40, -30, 760, T.bleedWarm, 0.055, 0)
  leak(W + 30, H * 0.24, 620, T.washGlowWarm, 0.045, T_LEAK * 0.45)

  // --- Heartbeat glint: the primary leak breathes a hair brighter on each shared-clock beat, so the
  // glass pulses in phase with the whole organism. One amp() read per frame, unhooked on shutdown.
  if (!still) {
    const baseA = primary.alpha
    const onUpdate = (): void => {
      primary.setAlpha(baseA + heartbeat.amp() * 0.03)
    }
    scene.events.on(Phaser.Scenes.Events.UPDATE, onUpdate)
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => scene.events.off(Phaser.Scenes.Events.UPDATE, onUpdate))
  }
}

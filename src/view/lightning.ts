import Phaser from 'phaser'
import { prefersReducedMotion, reduceFlashing } from './theme'

/**
 * THE LIGHTNING STRIKE — the bolt that takes the board (LIGHTNING ROUND).
 *
 * Pure view. It draws and destroys itself and owns no game state, so the scene composing a strike
 * (GameScene `swapBoard`) decides what the strike MEANS and this decides only what it looks like.
 *
 * ── Four things here are deliberate ──────────────────────────────────────────
 *
 * **ONE Graphics, built and destroyed.** A Phaser Graphics is re-tessellated every frame it is alive,
 * so a bolt kept around at alpha 0 between strikes would cost a draw call forever for the 99% of the
 * time there is no storm. It is cheaper to rebuild the geometry on each strike than to keep an idle
 * one breathing. The impact flare is a SPRITE for the same reason — a scaling glow costs nothing per
 * frame, where the equivalent `fillCircle` stack would re-tessellate 32 segments a disc, every frame.
 *
 * **ADD blend over a DARK SCRIM, and the scrim is not optional.** Additive light blows bright colour
 * out toward white, which is exactly wrong for the cabinet marquee (see `rgbmarquee.ts` — gold goes
 * pastel) and exactly right here: a bolt SHOULD white out. But the first build of this drew the bolt
 * straight onto the board and it was nearly INVISIBLE, because the board is cream tiles and adding
 * white to near-white changes nothing — the bolt only showed where it crossed the grout. The storm
 * scrim is doing contrast work, not mood work, and it is the same lesson the marquee's dark baked
 * groove teaches one surface over: remove the dark and the light has nothing to be brighter than.
 *
 * **The channel is a CAPSULE CHAIN, not a stroke** — discs at every joint under the segments. At
 * these widths a plain polyline serrates at every direction change, exactly as `strokeRoundedRect`
 * does on the marquee's groove, and the fix is the same one: lay discs and let the segments bridge
 * them. It also buys the TAPER for free, since each joint can carry its own radius, and a bolt that
 * narrows toward the ground is most of what makes it read as enormous rather than as a thick line.
 *
 * **The flicker is re-drawn geometry, not a tweened alpha.** Real lightning re-strikes along a
 * slightly different channel; fading one fixed shape in and out reads as a lamp, not a bolt.
 *
 * ── Accessibility ────────────────────────────────────────────────────────────
 * Three separate hazards, three separate answers — none of which skip the strike, because silently
 * swapping the board out is worse than a brief bolt:
 *  - `reduceFlashing()` — the STROBE is the hazard. One steady bolt, no re-strikes, no camera flash.
 *    Still full size: the bolt is the feedback that says why the board changed under you.
 *  - `prefersReducedMotion()` — no camera shake, and a shorter beat.
 */

/**
 * ⚡ THE STORM CHARGE METER — the in-level strip that shows the storm coming.
 *
 * ⚠️ THIS WAS MISSING FROM THE FIRST SHIP, and its absence broke the design's own argument. The
 * storm beats a standalone mode because it COMES TO YOU — but a reward you cannot see coming has no
 * anticipation, which is most of what makes an earned bonus feel earned rather than random. The
 * charge accumulated silently and the storm simply ambushed the player. `stormProgress` existed and
 * was tested, with a docstring calling it "what the in-level charge bar draws"; the bar was never
 * built. (Reported by the owner within an hour of release: "I'm playing levels right now and I don't
 * see it anywhere.")
 *
 * Seated in the 50px band between the level brief (ends y1000) and the JACKPOT label (starts y1050),
 * so the two charge meters read as one slot console — which is exactly what they are. It deliberately
 * mirrors `addJackpotMeter`'s shape (label + recessed track) rather than inventing a second visual
 * language for the same idea, but carries the storm's cold palette so the two are never confused.
 *
 * Read-only display: `SaveData.stormCharge` is the source of truth, and the caller repaints after a
 * bump. One Graphics, repainted on change — never per frame.
 */
export interface StormMeter {
  container: Phaser.GameObjects.Container
  /** Fill to `progress` (0..1). Near-full breathes, to telegraph that the board is about to go. */
  update(progress: number): void
}

export function addStormMeter(scene: Phaser.Scene, cx: number, cy: number, width = 300): StormMeter {
  const reduced = prefersReducedMotion()
  const container = scene.add.container(cx, cy)
  const h = 16
  const label = scene.add
    .text(-width / 2, 0, '⚡ STORM', { fontFamily: 'sans-serif', fontSize: '13px', fontStyle: 'bold', color: '#9ec6ff' })
    .setOrigin(0, 0.5)
  // ⚠️ The gutter is MEASURED off the rendered label, not a guessed constant. A hard-coded 58 was
  // narrower than "⚡ STORM" actually renders (67px), so the track was drawn straight over the final
  // letter. Emoji and bold weights make text width genuinely hard to predict — ask the object.
  const trackX = -width / 2 + label.width + 10
  const trackW = width / 2 - trackX
  const g = scene.add.graphics()
  container.add([g, label])

  let breathing: Phaser.Tweens.Tween | null = null

  const paint = (p: number): void => {
    const frac = Math.max(0, Math.min(1, p))
    g.clear()
    // Recessed track — dark, so the fill has something to be brighter than. Same reasoning as the
    // strike's storm scrim, one surface over.
    g.fillStyle(0x0a0a18, 0.55)
    g.fillRoundedRect(trackX, -h / 2, trackW, h, h / 2)
    if (frac > 0) {
      const fw = Math.max(h, trackW * frac)
      g.fillStyle(frac >= 1 ? CORE : HALO, frac >= 1 ? 1 : 0.9)
      g.fillRoundedRect(trackX, -h / 2, fw, h, h / 2)
    }
    g.lineStyle(1.5, HALO, 0.5)
    g.strokeRoundedRect(trackX, -h / 2, trackW, h, h / 2)
  }

  return {
    container,
    update(progress: number): void {
      paint(progress)
      // Past three-quarters the strip breathes — the tell that the next good cascade might take the
      // board. Started once and left running; a full meter is spent within a move or two anyway.
      const near = progress >= 0.75
      if (near && !breathing && !reduced && !reduceFlashing()) {
        breathing = scene.tweens.add({
          targets: container,
          alpha: 0.55,
          duration: 620,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        })
      } else if (!near && breathing) {
        breathing.stop()
        breathing = null
        container.setAlpha(1)
      }
    },
  }
}

/** Near-white core. The bolt's own colour, deliberately outside every theme palette. */
const CORE = 0xffffff
/** The electric halo around it — cold blue-violet, the storm's one hue. */
const HALO = 0x9ec6ff
/** The storm scrim — a cold near-black the bolt can be brighter than. See the header. */
const STORM = 0x0a0a18
/** How dark the room goes under a strike. Enough for contrast, short of a blackout. */
const STORM_ALPHA = 0.72

/** Core half-width where the bolt enters, and where it lands. The taper is the sense of scale. */
const CORE_TOP = 17
const CORE_BOT = 6
/** Halo multipliers over the core, widest first. Three layers is what reads as glow rather than outline. */
const HALO_TIERS: ReadonlyArray<readonly [number, number]> = [
  [3.6, 0.13],
  [2.2, 0.22],
  [1.45, 0.34],
]

const GLOW_TEX = 'vm-boltglow'

export interface StrikeOpts {
  /** Horizontal centre the bolt falls through. */
  x: number
  /** Top of the strike (usually above the viewport — the bolt should arrive from the sky). */
  yTop: number
  /** Where the bolt lands. The impact flare is centred here. */
  yBottom: number
  /** How far the channel may wander off `x`, in px. Also sizes the forks. */
  spread?: number
  /** Render depth — must sit above the pieces and below any card/scrim. */
  depth?: number
}

/**
 * A soft radial glow, generated once and cached on the texture manager. Used for the impact flare
 * and the ground bloom; tinted and scaled per use.
 */
function ensureGlowTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(GLOW_TEX)) return
  const S = 128
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  // Concentric discs falling off toward the rim. Cheap to build, and it only happens once ever —
  // after this the flare is a plain tinted Image with no per-frame geometry at all.
  const steps = 16
  for (let i = steps; i >= 1; i--) {
    const t = i / steps
    g.fillStyle(0xffffff, 0.055 * (1 - t) + 0.012)
    g.fillCircle(S / 2, S / 2, (S / 2) * t)
  }
  g.generateTexture(GLOW_TEX, S, S)
  g.destroy()
}

/** One jagged channel from top to bottom, as a flat list of points. */
function channel(x: number, yTop: number, yBottom: number, spread: number): Phaser.Math.Vector2[] {
  const steps = 14
  const pts: Phaser.Math.Vector2[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    // Taper the wander at both ends so the bolt enters and exits roughly where it was aimed — a
    // channel that drifts off-centre at the bottom reads as a crack in the glass, not a strike.
    const taper = Math.sin(t * Math.PI)
    // Two frequencies: a broad sway that gives the bolt a shape you could describe, and a fine
    // jitter on top. One frequency alone looks like a zigzag decoration.
    const sway = Math.sin(t * Math.PI * 1.7 + x) * spread * 0.55 * taper
    const jitter = (Math.random() * 2 - 1) * spread * 0.75 * taper
    pts.push(new Phaser.Math.Vector2(x + sway + jitter, yTop + (yBottom - yTop) * t))
  }
  return pts
}

/**
 * Lay one tapered capsule chain: a disc at every joint, segments bridging them. See the header for
 * why this is not a `lineStyle` polyline.
 */
function capsuleChain(
  g: Phaser.GameObjects.Graphics,
  pts: readonly Phaser.Math.Vector2[],
  wTop: number,
  wBot: number,
  color: number
): void {
  if (pts.length < 2) return
  const at = (i: number): number => wTop + (wBot - wTop) * (i / (pts.length - 1))
  // ⚠️ ALWAYS alpha 1 — brightness arrives pre-baked into `color`. See `dim()`.
  g.fillStyle(color, 1)
  for (let i = 0; i < pts.length; i++) g.fillCircle(pts[i].x, pts[i].y, at(i))
  // Bridging quads between consecutive discs, each squared off along the segment normal so the
  // chain reads as one continuous limb rather than a string of beads.
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const wa = at(i - 1)
    const wb = at(i)
    g.fillPoints(
      [
        new Phaser.Math.Vector2(a.x + nx * wa, a.y + ny * wa),
        new Phaser.Math.Vector2(b.x + nx * wb, b.y + ny * wb),
        new Phaser.Math.Vector2(b.x - nx * wb, b.y - ny * wb),
        new Phaser.Math.Vector2(a.x - nx * wa, a.y - ny * wa),
      ],
      true
    )
  }
}

/**
 * Scale a packed `0xRRGGBB` toward black.
 *
 * ⚠️ THIS IS WHY THE BOLT DOESN'T BEAD, and it took two goes to get right. The chain overlaps itself
 * everywhere by construction — a disc at each joint, sitting on the two quads that bridge it — so any
 * transparency at all makes the joints add to roughly double the limb's brightness, and the channel
 * reads as a string of beads. Per-FILL alpha does it; so does per-OBJECT alpha, because Phaser folds
 * a Graphics' alpha into each fill's vertices and the overlapping triangles still blend with one
 * another.
 *
 * Under ADD blend, though, brightness and alpha are interchangeable — a dim white and a transparent
 * white land on the same pixel value. So brightness lives in the COLOUR, every fill stays at alpha 1,
 * and overlapping geometry simply overwrites instead of compounding. Same lesson as the marquee's
 * groove ("all opaque so overlaps don't compound"), one step further because that surface never
 * needed to dim.
 */
function dim(color: number, k: number): number {
  const f = Math.max(0, Math.min(1, k))
  return (
    (Math.round(((color >> 16) & 0xff) * f) << 16) |
    (Math.round(((color >> 8) & 0xff) * f) << 8) |
    Math.round((color & 0xff) * f)
  )
}

/**
 * One Graphics per tier — widest halo → core — so the tiers composite into a soft falloff.
 *
 * They are separate objects only so each tier's geometry can overlap ITSELF without compounding; the
 * tiers are meant to add to one another, and that is what builds the glow. Layer `alpha` stays at 1
 * throughout the strike (see `dim`) and is only ever touched by the final fade-out, where a little
 * compounding is invisible because everything is on its way to zero anyway.
 */
interface BoltLayers {
  /** Widest → narrowest halo, then the core. Index order is paint order. */
  all: Phaser.GameObjects.Graphics[]
}

function buildLayers(scene: Phaser.Scene, depth: number): BoltLayers {
  const all: Phaser.GameObjects.Graphics[] = []
  for (let i = 0; i <= HALO_TIERS.length; i++) {
    all.push(scene.add.graphics().setDepth(depth).setBlendMode(Phaser.BlendModes.ADD))
  }
  return { all }
}

/** Draw one pass of the bolt. Returns where it landed, so the impact flare can follow the channel. */
function drawBolt(layers: BoltLayers, opts: StrikeOpts, alpha: number): Phaser.Math.Vector2 {
  const { x, yTop, yBottom } = opts
  const spread = opts.spread ?? 46
  for (const g of layers.all) g.clear()

  const main = channel(x, yTop, yBottom, spread)

  // Three or four forks, branching off the main channel and dying before the ground. A bolt with no
  // forks reads as a drawn line; it is the branching that says "electricity" at a glance, and at this
  // scale the forks need real width of their own or they look like cracks beside a column.
  const forks: Phaser.Math.Vector2[][] = []
  const forkCount = 3 + (Math.random() < 0.5 ? 1 : 0)
  for (let f = 0; f < forkCount; f++) {
    const from = main[2 + Math.floor(Math.random() * (main.length - 6))]
    const dir = Math.random() < 0.5 ? -1 : 1
    const dx = dir * spread * (1.1 + Math.random() * 1.3)
    const dy = (yBottom - yTop) * (0.12 + Math.random() * 0.18)
    const steps = 5
    const pts = [from]
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      // Wander shrinks toward the tip so the fork tapers to a point instead of fraying.
      const wobble = (Math.random() * 2 - 1) * spread * 0.4 * (1 - t)
      pts.push(new Phaser.Math.Vector2(from.x + dx * t + wobble, from.y + dy * t))
    }
    forks.push(pts)
  }

  // Halo tiers first (widest, dimmest), core last — each into its OWN layer, at alpha 1, with this
  // pass's brightness baked into the colour so nothing compounds where the chain overlaps itself.
  HALO_TIERS.forEach(([mult, a], i) => {
    const g = layers.all[i]
    const c = dim(HALO, a * alpha)
    capsuleChain(g, main, CORE_TOP * mult, CORE_BOT * mult, c)
    const cf = dim(HALO, a * 0.8 * alpha)
    for (const f of forks) capsuleChain(g, f, CORE_TOP * mult * 0.42, 1.2, cf)
  })
  const core = layers.all[layers.all.length - 1]
  for (const f of forks) capsuleChain(core, f, CORE_TOP * 0.4, 1, dim(CORE, 0.85 * alpha))
  capsuleChain(core, main, CORE_TOP, CORE_BOT, dim(CORE, alpha))

  return main[main.length - 1]
}

/**
 * Fire one strike over `scene`. Resolves when the bolt has finished and cleaned itself up.
 *
 * ⚠️ Every timer here is a PHASER timer, never `window.setTimeout`. `core/apploop.ts` stops the loop
 * while the page is hidden, so a Phaser timer pauses with it and a backgrounded strike resumes where
 * it left off; a `setTimeout` would keep running and destroy the bolt over a board the player is not
 * even looking at, then hand back a resolved promise for a strike they never saw.
 */
export function strikeBolt(scene: Phaser.Scene, opts: StrikeOpts): Promise<void> {
  return new Promise<void>(resolve => {
    const calm = reduceFlashing()
    const reduced = prefersReducedMotion()
    const depth = opts.depth ?? 40
    const cam = scene.cameras.main
    ensureGlowTexture(scene)

    // The storm scrim — sized off the camera and pinned to it, so it covers the room whatever the
    // safe-area anchoring did to the layout on this device. One notch UNDER the bolt's depth.
    const scrim = scene.add
      .rectangle(cam.centerX, cam.centerY, cam.width * 2, cam.height * 2, STORM, 0)
      .setScrollFactor(0)
      .setDepth(depth - 1)
    const layers = buildLayers(scene, depth)
    const flares: Phaser.GameObjects.Image[] = []

    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      scene.tweens.killTweensOf(scrim)
      for (const f of flares) {
        scene.tweens.killTweensOf(f)
        f.destroy()
      }
      for (const g of layers.all) {
        scene.tweens.killTweensOf(g)
        g.destroy()
      }
      scrim.destroy()
      resolve()
    }
    // If the scene goes away mid-strike everything dies with it — resolve so an awaiting caller is
    // never left pinned. Same reasoning as GameScene.t()'s deadline: a promise that cannot settle
    // bricks whatever is awaiting it.
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, finish)

    // The strobe is the seizure hazard, so `calm` removes the RE-STRIKES rather than the bolt: one
    // steady channel, held and faded, at full size.
    const passes = calm ? 1 : reduced ? 3 : 5
    const hold = calm ? 260 : reduced ? 64 : 48
    // The room goes out FIRST and fast — the dark is what the bolt is brighter than, so it has to be
    // there before the first pass draws rather than fading in alongside it.
    scene.tweens.add({ targets: scrim, fillAlpha: STORM_ALPHA, duration: calm ? 150 : 60, ease: 'Quad.easeOut' })

    if (!calm) {
      // A hard white-out sold as the strike's own light. Short enough that it clears before the
      // second pass, so it reads as the strike igniting rather than as a wash hiding the shape it
      // is supposed to be lighting.
      cam.flash(reduced ? 90 : 130, 226, 238, 255, false)
    }
    if (!reduced) {
      // The ground takes the hit. Gated on MOTION rather than on flashing — a shake is not a strobe,
      // and it is the single biggest contributor to the strike having weight.
      cam.shake(300, 0.011)
    }

    /** The impact bloom where the bolt lands — a tinted glow that punches out and fades. */
    const flare = (x: number, y: number, size: number, life: number, tint: number, from = 0.35): void => {
      const img = scene.add
        .image(x, y, GLOW_TEX)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(depth)
        .setTint(tint)
        .setDisplaySize(size * from, size * from)
      flares.push(img)
      // ⚠️ Tween displayWidth/Height, never `scale` — these were sized with setDisplaySize, and a
      // tween to `scale: 1` would snap the image to its NATIVE 128px instead of the size asked for.
      scene.tweens.add({
        targets: img,
        displayWidth: size,
        displayHeight: size,
        alpha: 0,
        duration: life,
        ease: 'Quad.easeOut',
      })
    }

    let pass = 0
    const step = (): void => {
      if (done) return
      // Alternate bright/dim passes rather than decaying monotonically — a bolt that fades out evenly
      // reads as a dissolve, where a real one gutters.
      const alpha = pass === 0 ? 1 : pass % 2 === 1 ? 0.4 : 0.82
      const land = drawBolt(layers, opts, alpha)
      if (pass === 0) {
        // The main impact: a wide cold bloom, a tighter white-hot core, and a bloom back up the
        // channel so the strike looks like it lit the air it travelled through.
        flare(land.x, land.y, (opts.spread ?? 46) * 11, 520, HALO)
        flare(land.x, land.y, (opts.spread ?? 46) * 4.5, 380, CORE, 0.2)
        flare(opts.x, (opts.yTop + land.y) / 2, (opts.spread ?? 46) * 7, 440, HALO, 0.5)
      }
      pass++
      if (pass >= passes) {
        // The bolt snaps out faster than the room comes back up, so the light is gone before the new
        // board is legible — the order that reads as "it struck, then the lights came on".
        scene.tweens.add({ targets: layers.all, alpha: 0, duration: calm ? 280 : 150, ease: 'Sine.easeIn' })
        scene.tweens.add({
          targets: scrim,
          fillAlpha: 0,
          duration: calm ? 340 : 300,
          delay: 80,
          ease: 'Sine.easeIn',
          onComplete: finish,
        })
        return
      }
      scene.time.delayedCall(hold, step)
    }
    step()
  })
}

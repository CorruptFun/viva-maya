/**
 * FIREKIT for Viva Maya — the board's fire vocabulary (§X2).
 *
 * `megafx.ts` owns the SCREEN: rays, a burning frame, coins, symbols erupting past the edges. This
 * module owns the BOARD, and it exists because everything the game currently detonates with is a
 * smooth radial glow — a bloom, a ring, a spark spray. Those read as *light*. The reference footage
 * this pass is cut from (a slot ad whose win escalates from a hot core → an expanding ring of fire →
 * the whole grid alight → the grid's value burning off into one total) reads as *combustion*, and
 * the difference is structure: fire has a direction, a ragged front, and atoms that lick.
 *
 * Three tools, in the order the reference plays them:
 *
 *   - `fireRing`   — a hot core blowing out into a turbulent ANNULUS of flame. The signature.
 *   - `blazeField` — a bounded region catching fire and staying alight, licking upward, with
 *                    whatever is inside it still readable THROUGH the flames. Returned as a handle
 *                    the owner extinguishes (auto-timed out as a backstop, like `igniteVignette`).
 *   - `burnAway`   — the tally burn: a region's perimeter traces white-hot, a burning front crosses
 *                    it, and what was inside is ash. Resolves at the moment a total should land.
 *
 * ── THE HOUSE RULES (megafx's four, inherited verbatim, plus one this module adds) ────────────
 *  1. **No shaders, no pipelines.** Everything is the baked `flametongue` / `rgbnode` / `bgglow`
 *     atoms under ADD blend — the game is `Phaser.AUTO` and the Canvas fallback must render it all.
 *  2. **Transient by construction.** Every object is created at fire time and destroys itself; the
 *     one sustained effect (`blazeField`) carries its own auto-extinguish deadline.
 *  3. **A11y-gated at the door.** `reduced()` skips motion entirely, `reduceFlashing()` turns the
 *     flicker into a slow swell, and counts/alphas run through the `quality` governor.
 *  4. **Camera-safe** — but INVERTED from megafx, and this is the one difference that matters.
 *     megafx's layers are `scrollFactor(0)` because they belong to the screen. Everything here
 *     belongs to the BOARD, so it is world-space on purpose: a blaze over the board that did not
 *     shake with the board would visibly detach from it on the first trauma rattle, and every one
 *     of these effects fires on a beat that also shakes the camera.
 *  5. **One clock per effect.** Where a fire's atoms must agree on a shared quantity — the position
 *     of a burn front — they are driven by a SINGLE tween's `onUpdate`, never a tween each. This is
 *     the RGB marquee's law (`CLAUDE.md`: one UPDATE hook replaced 80 per-bulb tweens) applied to a
 *     transient: 40 nodes that each own a tween is 40 tweens, and they still could not express
 *     "how bright am I given where the front is" without knowing about each other.
 *
 * Depth contract: callers pass the band that fits their scene. GameScene's board art sits at ≤22
 * and its HUD at ≤34, so board fire wants 24–29 (over the pieces, under the readouts).
 */
import Phaser from 'phaser'
import { blazeTongues, burnFront, burnHeat, ringPetals } from '../core/fire'
import { roundedRectPath } from '../core/rgb'
import { E, reduced } from './motion'
import { quality } from './quality'
import { getTheme, reduceFlashing } from './theme'

/** Default depth: above GameScene's board art (≤22), below its HUD (≥30). */
const FIRE_DEPTH = 26

/** A rectangle in world space — the region an effect is bounded to. */
export interface FireRect {
  x: number
  y: number
  width: number
  height: number
}

/** Heat 1..3 — the same ladder the combo tiers and `igniteVignette` speak. */
export type Heat = 1 | 2 | 3

/**
 * Push a colour toward saturated flame by pulling its green and blue down while holding red — gold
 * → amber → hot orange, anchored on whatever the live theme calls gold.
 */
function stoke(color: number, k: number): number {
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return (r << 16) | (Math.round(g * k) << 8) | Math.round(b * k * 0.8)
}

/**
 * Warm→hot tint for a heat step, anchored on the live theme's gold so fire never fights the room.
 *
 * ⚠️ THE HOTTER STEPS GO MORE SATURATED, NOT PALER, and getting this backwards is not a taste call —
 * it is the RGB marquee's physics restated (`CLAUDE.md`: "additive light on bright gold desaturates
 * straight to white"). The first cut of this module ran the obvious ladder, gold → bright gold →
 * near-white cream, on the reasoning that hotter fire is whiter. Additive near-white over a dark
 * warm board renders as PALE GREY: the whole ring came out looking like flying paper shards, and no
 * amount of alpha or count fixed it, because the problem was never density.
 *
 * White heat still happens — it is just not the tint's job. It comes from OVERLAP: where petals or
 * tongues pile up, the additive sum clips to white on its own, which is also where real fire is
 * hottest. So the tint carries the colour and the geometry carries the heat.
 */
function heatTint(heat: Heat): number {
  const gold = getTheme().gold
  return heat >= 3 ? stoke(gold, 0.5) : heat === 2 ? stoke(gold, 0.72) : gold
}

/**
 * SOOT — the dark ground the additive fire burns against, laid under it in NORMAL blend.
 *
 * ⚠️ THIS IS NOT AN EFFECT, IT IS WHAT MAKES THE FIRE VISIBLE AT ALL, and skipping it is the single
 * biggest way this module can fail. `CLAUDE.md` records the rule twice already — the RGB marquee's
 * band is opaque colour in a dark baked groove because "additive light on bright gold desaturates
 * straight to white", and megafx drops the house lights before its payoffs for the same reason. The
 * game's default theme, Golden Hour, seats the board on a CREAM wash with near-white tiles: adding
 * saturated orange to (255, 249, 235) clips every channel, so a ring of fire drawn there without a
 * ground renders as a white blob. Not dimmer — the wrong colour entirely.
 *
 * Soot is also the honest read: fire on a bright surface is legible because of what it blackens.
 * Alpha is deliberately modest — this darkens a region for a beat, it never blacks it out, and the
 * board has to stay playable underneath.
 *
 * Returns the object so the caller can own its lifetime (or null when there is nothing to draw on).
 */
function soot(scene: Phaser.Scene, x: number, y: number, w: number, h: number, depth: number): Phaser.GameObjects.Image | null {
  if (!scene.textures.exists('bgglow')) return null
  return scene.add
    .image(x, y, 'bgglow')
    .setBlendMode(Phaser.BlendModes.NORMAL)
    .setTint(getTheme().vignetteInk)
    .setDepth(depth)
    .setDisplaySize(w, h)
    .setAlpha(0)
}

/**
 * A FLAT soot slab, for a region that is being darkened evenly rather than shadowed from a point.
 *
 * `soot` is `bgglow`, and `bgglow` is a radial — it is thickest at its centre and thins to nothing
 * at its rim. That is right under a blast (the epicentre really is the sootiest part) and exactly
 * wrong under `burnAway`, whose whole subject is the region's EDGE: a radial ash leaves the
 * perimeter almost undarkened, so the burning frame — additive gold — had nothing to burn against
 * and vanished on the cream themes. A slab covers corner to corner at one density.
 */
function sootSlab(scene: Phaser.Scene, x: number, y: number, w: number, h: number, depth: number): Phaser.GameObjects.Rectangle {
  return scene.add.rectangle(x, y, w, h, getTheme().vignetteInk, 1).setDepth(depth).setAlpha(0)
}

/**
 * Light it, hold it, burn it out — alpha as its OWN pair of tweens rather than a `{from, to}` riding
 * the flight tween.
 *
 * That is not tidiness; it is the difference between a ring of fire and a puff of dust. Riding the
 * flight, alpha decays on the same `easeOut` that shapes the travel, so it front-loads: the atom is
 * already half faded by the time it has cleared the epicentre and the eye gets a brown smudge. Here
 * it snaps to full in the first fifth and burns out over the rest, so the fire reads BRIGHT while it
 * opens and dies once it has arrived.
 */
function fadeIn(scene: Phaser.Scene, img: Phaser.GameObjects.Image, peak: number, delay: number, flight: number): void {
  scene.tweens.add({
    targets: img,
    alpha: peak,
    delay,
    duration: flight * 0.18,
    ease: 'Quad.easeOut',
    onComplete: () => {
      if (!img.active) return
      scene.tweens.add({ targets: img, alpha: 0, duration: flight * 0.82, ease: 'Quad.easeIn' })
    },
  })
}

// ---------------------------------------------------------------------------
// fireRing — the turbulent expanding annulus
// ---------------------------------------------------------------------------

/**
 * How much wider than its arc-length spacing each petal is drawn, so a ring's flames OVERLAP into a
 * continuous band. The marquee's `ALONG_OVERLAP` law, third time: laid at their own width, atoms on
 * a path scallop into separate beads — here that turns a ring of fire into a ring of flying shards,
 * which is exactly what the first cut of this effect looked like.
 */
const RING_OVERLAP = 1.7

/** Petal count is DERIVED from the overlap law; these bound what the derivation may ask for. */
const RING_PETALS_MIN = 10
const RING_PETALS_MAX = 34

export interface FireRingOpts {
  /** Final ring radius in world px (default 150). Flame length scales off it unless overridden. */
  radius?: number
  /** Flame length in world px (default `radius * 0.45`). */
  flame?: number
  /**
   * Petal count override. Leave unset: the default is DERIVED from radius and flame width so the
   * band always overlaps (see `RING_OVERLAP`). A hand-picked count is a promise about density that
   * silently breaks the first time a caller changes the radius.
   */
  petals?: number
  /** Heat 1..3 (default 2). */
  heat?: Heat
  /** Explicit tint, overriding the heat ladder (for a caller that wants the theme's rose accent). */
  tint?: number
  /** Total flight time in ms (default 420). */
  ms?: number
  /** Turbulence seed — two rings alight at once should not wear the same jitter. */
  seed?: number
  /** Swirl in radians applied across the flight (default 0.5) — the ring turns as it opens. */
  spin?: number
  /** Drop the white-hot core flash (default false) — for a ring layered over one that already has. */
  quiet?: boolean
  /** Drop the soot ground (default false). Only for a ring fired INTO another effect's soot. */
  smoke?: boolean
  depth?: number
}

/**
 * A RING OF FIRE blowing out of `(x, y)`: a white-hot core, then an annulus of flame tongues aimed
 * outward, each with its own size, reach and launch so the front boils and tears instead of
 * inflating like a balloon. The whole ring also swirls a little as it opens, which is what stops a
 * ring of identical petals reading as a cog.
 *
 * The petals are laid EXACTLY evenly (`ringPetals`, pinned by `fire.test.ts`) — a nearly-even ring
 * parks its one odd gap at a fixed spot on screen and the eye finds it every single time.
 *
 * Gates: reduced motion → nothing (the caller's own bloom/shockwave already carries the beat, and a
 * transient's resting state is nothing); LOW tier → nothing (this is a fill-rate layer on top of a
 * detonation that already reads); reduce-flashing → dimmer, slower, and no white core.
 */
export function fireRing(scene: Phaser.Scene, x: number, y: number, opts: FireRingOpts = {}): void {
  if (reduced() || quality.tier() === 'low') return
  if (!scene.textures.exists('flametongue')) return
  const soft = reduceFlashing()
  const heat = opts.heat ?? 2
  const depth = opts.depth ?? FIRE_DEPTH
  const radius = opts.radius ?? 150
  const flame = opts.flame ?? radius * 0.45
  const ms = opts.ms ?? 420
  const spin = opts.spin ?? 0.5
  const tint = opts.tint ?? heatTint(heat)
  const wide = flame * 0.72 // one petal's body width
  // Enough petals that their bodies overlap on the ring they end up sitting on — derived, never
  // guessed (see RING_OVERLAP). `quality.count` then thins the ring on a weaker device, which
  // costs density rather than correctness: a sparse ring still reads as fire, just thinner.
  const want = Math.ceil((Math.PI * 2 * radius * 0.72 * RING_OVERLAP) / wide)
  const count = Math.max(6, quality.count(opts.petals ?? Math.min(RING_PETALS_MAX, Math.max(RING_PETALS_MIN, want))))
  const peak = (soft ? 0.4 : 0.78) * quality.scale()
  const petals = ringPetals(count, opts.seed ?? 0)

  // The blast's own smoke shadow — see `soot`. Slightly ahead of the fire and gone before it, so it
  // reads as the flash darkening the board rather than as a shadow someone left behind.
  const smoke = opts.smoke === false ? null : soot(scene, x, y, radius * 0.9, radius * 0.9, depth - 2)
  if (smoke) {
    scene.tweens.add({
      targets: smoke,
      displayWidth: radius * 3,
      displayHeight: radius * 3,
      alpha: { from: 0, to: (soft ? 0.28 : 0.5) * quality.scale() },
      duration: ms * 0.28,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (!smoke.active) return
        scene.tweens.add({ targets: smoke, alpha: 0, duration: ms * 0.7, ease: E.exit, onComplete: () => smoke.destroy() })
      },
    })
  }

  /**
   * THE BODY, under the tongues: soft `fireball` blobs on the same ring, laid close enough to
   * overlap into one molten torus.
   *
   * The tongues alone cannot do this. However many you lay, a ring of tapered atoms pointing
   * outward reads as a STARBURST — spokes with dark between them — because the shape carries a
   * direction and the gaps between directions stay empty. The blobs have no direction, so they fuse;
   * and where they pile up the additive sum clips to white, which is where the ring's white heat
   * comes from (see `heatTint`: the tint's job is colour, the geometry's job is heat).
   */
  /**
   * ⚠️ THE RING BLOOMS, IT DOES NOT FLY APART, and the two radii below are budgeted against the
   * atom growth right under them to keep it that way. An atom count is fixed but a circumference is
   * not: launch from 0.1R out to 1.0R and the same atoms are ten times further apart when they
   * arrive, so a ring that started continuous ENDS as a starburst — dense fire at the epicentre
   * that tears into spokes with dark between them. Travel and growth are therefore matched: ~2.6x
   * out, ~2.7x bigger, so the angular density the ring opens with is the density it burns at.
   */
  const bodyR0 = radius * 0.3
  const bodyR = radius * 0.78
  // Every SECOND petal carries a body blob, drawn correspondingly bigger. `fireball` is a soft
  // radial with a long skirt, so the body fuses at half the density a tapered tongue needs — and
  // halving it is worth real money here: a bomb is an everyday event, and this is the layer with
  // the most sprites in the kit.
  for (let i = 0; i < petals.length; i += 2) {
    const p = petals[i]
    if (!scene.textures.exists('fireball')) break
    const blob = scene.add
      .image(x + p.dx * bodyR0, y + p.dy * bodyR0, 'fireball')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(depth - 1)
      .setTint(tint)
      .setDisplaySize(flame * 0.6 * p.size, flame * 0.6 * p.size)
      .setAlpha(0)
    const br = bodyR * p.reach
    scene.tweens.add({
      targets: blob,
      x: x + p.dx * br,
      y: y + p.dy * br,
      displayWidth: flame * 1.6 * p.size,
      displayHeight: flame * 1.6 * p.size,
      delay: p.lead * ms * 0.22,
      duration: (soft ? ms * 1.5 : ms) * 0.9,
      ease: 'Quad.easeOut',
      onComplete: () => blob.destroy(),
    })
    // Same hold-then-burn-out profile as the tongues below, and for a sharper reason here: the body
    // is the layer that keeps the ring CONTINUOUS. Let it decay from the first frame (a `from/to`
    // alpha riding the flight tween does exactly that) and it is half gone by the time the ring has
    // opened — leaving the tongues alone on screen, which is the starburst this layer exists to
    // prevent. The continuity layer has to outlive the opening, not fade during it.
    fadeIn(scene, blob, peak * 0.85, p.lead * ms * 0.22, (soft ? ms * 1.5 : ms) * 0.9)
  }

  for (const p of petals) {
    // Origin (0.5, 1) puts the flame's ROOT at the placement point, so it licks outward along its
    // own heading. The root starts near the epicentre and travels out; it stops SHORT of the final
    // radius by most of a flame length, so the body straddles the ring rather than hanging off it
    // — roots parked on the ring itself leave the middle hollow and the fire reads as debris.
    const r0 = radius * 0.25
    const img = scene.add
      .image(x + p.dx * r0, y + p.dy * r0, 'flametongue')
      .setOrigin(0.5, 1)
      .setRotation(p.angle)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(depth)
      .setTint(tint)
      .setDisplaySize(wide * 0.55 * p.size, flame * 0.55 * p.size)
      .setAlpha(0)
    const reach = Math.max(radius * 0.28, radius * 0.72 * p.reach - flame * 0.28)
    const lead = p.lead * ms * 0.3
    const flight = soft ? ms * 1.5 : ms
    scene.tweens.add({
      targets: img,
      x: x + p.dx * reach,
      y: y + p.dy * reach,
      rotation: p.angle + spin,
      // Grow as it flies, then the alpha carries the death — a flame that shrinks away reads as a
      // sprite being scaled down; one that keeps growing while it thins reads as burning out.
      displayWidth: wide * 1.15 * p.size,
      displayHeight: flame * 1.15 * p.size,
      delay: lead,
      duration: flight,
      ease: 'Cubic.easeOut',
      onComplete: () => img.destroy(),
    })
    fadeIn(scene, img, peak, lead, flight)
  }

  // The white-hot core the ring tears open from. Skipped when flashing is reduced (it is the one
  // genuinely bright pop in the effect) and when a caller is layering a second ring on the same spot.
  if (soft || opts.quiet || !scene.textures.exists('fireball')) return
  const core = scene.add
    .image(x, y, 'fireball')
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDepth(depth + 1)
    .setDisplaySize(radius * 0.5, radius * 0.5)
    .setAlpha(0.95 * quality.scale())
  scene.tweens.add({
    targets: core,
    displayWidth: radius * 1.5,
    displayHeight: radius * 1.5,
    alpha: 0,
    duration: ms * 0.62,
    ease: 'Quad.easeOut',
    onComplete: () => core.destroy(),
  })
}

// ---------------------------------------------------------------------------
// blazeField — a region catching fire and staying alight
// ---------------------------------------------------------------------------

export interface BlazeHandle {
  /** Put the fire out and free everything. Safe to call twice; safe after scene teardown. */
  extinguish(): void
  /** True until extinguished (by the owner or the auto-deadline). */
  readonly live: boolean
}

const DEAD_BLAZE: BlazeHandle = { extinguish() {}, live: false }

export interface BlazeFieldOpts {
  /** Heat 1..3 (default 2) — drives tint, height and how bright the wall burns. */
  heat?: Heat
  /** Explicit tint, overriding the heat ladder. */
  tint?: number
  /** Tongue count before governor scaling (default 11). */
  count?: number
  /** Turbulence seed. */
  seed?: number
  /** Auto-extinguish backstop in ms (default 6500) — a lost owner can never leave the board alight. */
  maxMs?: number
  depth?: number
}

/**
 * A WALL OF FIRE standing in `rect`, licking upward from its floor and staying alight until the
 * owner puts it out. The reference's middle beat: the grid is *on fire while play continues*, and
 * you can still read every symbol through it.
 *
 * That readability is the whole design constraint, and it is what decides three things:
 *   · the flames are ADD, so they BRIGHTEN what is under them rather than hiding it;
 *   · the peak alpha stays modest even at heat 3 — this is a veil, never a curtain;
 *   · the tongues stand at the region's FLOOR and reach up through it, so the densest fire sits
 *     where the board's own art is least busy.
 *
 * Tongue seats overlap by construction (`blazeTongues`), so the roots fuse into one front instead of
 * scalloping into a row of candles, and no two neighbours share a flicker phase — a wall whose atoms
 * breathe together is a strobing rectangle, which is both ugly and the exact thing reduce-flashing
 * exists to prevent. Both properties are pinned in `fire.test.ts`.
 *
 * World-space on purpose (house rule 4): this fire belongs to the board and must rattle with it.
 * Gates: reduced motion / LOW tier → dead handle; reduce-flashing → dimmer, with a slow swell in
 * place of the flicker.
 */
export function blazeField(scene: Phaser.Scene, rect: FireRect, opts: BlazeFieldOpts = {}): BlazeHandle {
  if (reduced() || quality.tier() === 'low') return DEAD_BLAZE
  if (!scene.textures.exists('flametongue')) return DEAD_BLAZE
  const soft = reduceFlashing()
  const heat = opts.heat ?? 2
  const depth = opts.depth ?? FIRE_DEPTH
  const tint = opts.tint ?? heatTint(heat)
  const count = Math.max(4, quality.count(opts.count ?? 13))
  // A VEIL, not a curtain: even at full heat the wall stays around half opacity so the board reads
  // through it. Raising this is the one change that would quietly make the game unplayable while a
  // chain runs — the pieces are still there, you just cannot see which is which.
  const peak = Math.min(0.58, 0.24 + heat * 0.12) * (soft ? 0.6 : 1) * quality.scale()
  const floor = rect.y + rect.height
  const tall = rect.height * (0.32 + heat * 0.09)

  const pieces: Phaser.GameObjects.Image[] = []
  const tweens: Phaser.Tweens.Tween[] = []
  let live = true

  // The dark ground first, then the fire — see `soot`. Sized to the band the flames actually
  // occupy, so the top of the board keeps its own light while its floor goes to embers.
  const ground = soot(scene, rect.x + rect.width / 2, rect.y + rect.height * 0.86, rect.width * 1.1, rect.height * 0.95, depth - 2)
  if (ground) {
    ground.setData('peak', Math.min(0.52, 0.24 + heat * 0.1) * (soft ? 0.7 : 1))
    pieces.push(ground)
  }

  // A hot bed at the floor, under the tongues. Two jobs: the roots need something to be standing in
  // (a wall of tongues with nothing beneath them reads as flames hovering in mid-air), and it is
  // where the additive alphas stack thickest, which is what takes the base to white-hot without the
  // tint ever being white.
  if (scene.textures.exists('bgglow')) {
    // ⚠️ Kept largely INSIDE the region. `bgglow` is a radial, so a bed centred on the floor hangs
    // half its own height below it — and callers seat things directly under a board (GameScene's
    // standing brief sits 48px under the numbered board, with the JACKPOT deck and charge bar below
    // that). A hot wash reaching down there would be lighting up furniture that has nothing to do
    // with the fire. Lifting the centre keeps the spill to ~40px, which reads as heat escaping the
    // cabinet rather than as a second glow with its own opinions.
    const bedH = rect.height * 0.3
    pieces.push(
      scene.add
        .image(rect.x + rect.width / 2, floor - bedH * 0.28, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(depth - 1)
        .setTint(tint)
        .setDisplaySize(rect.width * 1.12, bedH)
        .setAlpha(0)
        .setData('peak', peak * 0.85)
    )
  }

  /**
   * The wall is TWO rows, and that is what makes it read as fire rather than as a row of cones.
   * The back row is tall, wide and dim; the front row is short, narrow and bright, seeded
   * differently so its tongues sit in the back row's gaps. Real fire has depth — a dim body with a
   * brighter heart standing inside it — and one row of identical atoms cannot fake it at any alpha.
   */
  const row = (n: number, seed: number, hScale: number, wScale: number, aScale: number, z: number): void => {
    for (const t of blazeTongues(rect.width, n, seed)) {
      pieces.push(
        scene.add
          .image(rect.x + t.x, floor, 'flametongue')
          .setOrigin(0.5, 1)
          .setRotation(t.lean)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(z)
          .setTint(tint)
          .setDisplaySize(t.w * wScale, tall * t.h * hScale)
          .setAlpha(0)
          .setData('peak', peak * aScale)
          .setData('tall', tall * t.h * hScale)
          .setData('period', t.period)
          .setData('phase', t.phase)
      )
    }
  }
  const seed = opts.seed ?? 0
  row(count, seed, 1, 1, 0.72, depth) // the body
  row(Math.max(3, Math.round(count * 0.7)), seed + 97, 0.58, 0.62, 1, depth + 1) // the heart

  for (const img of pieces) {
    const a = img.getData('peak') as number
    const period = (img.getData('period') as number) ?? 1
    const phase = (img.getData('phase') as number) ?? 0
    const full = img.getData('tall') as number | undefined
    // Ignite (staggered by the tongue's own phase, so the wall catches raggedly), then breathe.
    tweens.push(
      scene.tweens.add({
        targets: img,
        alpha: a,
        duration: soft ? 520 : 260,
        delay: phase * 220,
        ease: E.settle,
        onComplete: () => {
          if (!live || !img.active) return
          const beat = (soft ? 1500 : 560) * period
          tweens.push(
            scene.tweens.add({
              targets: img,
              alpha: a * (soft ? 0.82 : 0.58),
              // Only the tongues breathe in HEIGHT — the floor bed holds still, or the whole wall
              // pumps together and becomes the block-flash the phase jitter exists to prevent.
              ...(full === undefined ? {} : { displayHeight: full * 0.66 }),
              duration: beat,
              yoyo: true,
              repeat: -1,
              ease: E.hero,
            })
          )
        },
      })
    )
  }

  const extinguish = (): void => {
    if (!live) return
    live = false
    deadline.remove(false)
    for (const t of tweens) t.stop()
    for (const img of pieces) {
      if (!img.active) continue
      scene.tweens.add({
        targets: img,
        alpha: 0,
        displayHeight: (img.displayHeight || 1) * 0.4,
        duration: 380,
        ease: E.exit,
        onComplete: () => img.destroy(),
      })
    }
  }
  const deadline = scene.time.delayedCall(opts.maxMs ?? 6500, extinguish)

  return {
    extinguish,
    get live(): boolean {
      return live
    },
  }
}

// ---------------------------------------------------------------------------
// burnAway — the tally burn
// ---------------------------------------------------------------------------

export interface BurnAwayOpts {
  /** Heat 1..3 (default 3 — this is a payoff beat). */
  heat?: Heat
  /** Explicit tint, overriding the heat ladder. */
  tint?: number
  /** Time for the front to cross the region, in ms (default 620). */
  ms?: number
  /** Corner radius of the traced frame (default 22). */
  radius?: number
  /** Node spacing along the frame in px (default 26). */
  spacing?: number
  depth?: number
}

/**
 * THE TALLY BURN — the reference's finale, and the one beat in the kit that is a *statement* rather
 * than a flourish: a region's perimeter traces white-hot, a burning front crosses it, and what was
 * inside is gone. It is what a slot machine does when a screen full of values resolves into one
 * number, and the resolved promise is the cue to land that number.
 *
 * ── WHY THE FRAME IS A CHAIN OF NODES AND NOT A `strokeRoundedRect` ──────────────────────────
 * The same reason the RGB marquee's groove is (`CLAUDE.md`): a thick rounded-rect stroke SERRATES
 * where the corner arc meets the straights, and the serration is exactly where a bright additive
 * line is most visible. Soft `rgbnode` atoms laid along `roundedRectPath` at overlapping spacing sum
 * into a continuous tube instead — and, unlike a stroke, each atom can carry its own brightness,
 * which is what lets the front's heat run round the frame as it crosses.
 *
 * ── ONE CLOCK ────────────────────────────────────────────────────────────────────────────────
 * The front's position, the interior's heat and every node's brightness are three views of ONE
 * number, so they are driven by ONE tween's `onUpdate` (house rule 5). The alternative — a tween per
 * node with a staggered delay — is 40 tweens that still cannot answer "how bright am I right now".
 *
 * The promise resolves when the front has crossed (the region is ash; land the total). It ALWAYS
 * settles — on the tween's completion or on a Phaser-timer deadline, whichever comes first, and
 * deliberately a Phaser timer rather than `window.setTimeout` so a backgrounded app does not tear
 * the beat down while it is merely paused (`GameScene.t()`'s lesson, same failure mode).
 *
 * Gates: reduced motion / LOW tier → resolves on the next tick with nothing drawn, so a caller's
 * `await` is never the thing that hangs; reduce-flashing → slower and dimmer, never a wipe-flash.
 */
export function burnAway(scene: Phaser.Scene, rect: FireRect, opts: BurnAwayOpts = {}): Promise<void> {
  if (reduced() || quality.tier() === 'low' || !scene.textures.exists('rgbnode')) {
    return new Promise(resolve => scene.time.delayedCall(0, resolve))
  }
  const soft = reduceFlashing()
  const heat = opts.heat ?? 3
  const depth = opts.depth ?? FIRE_DEPTH
  const tint = opts.tint ?? heatTint(heat)
  const ms = (opts.ms ?? 620) * (soft ? 1.4 : 1)
  const nodeSpacing = opts.spacing ?? 26

  // The traced frame. `roundedRectPath` is the marquee's own path walker — even arc-length spacing
  // all the way round, including through the corners, which is what keeps the tube's density flat.
  const path = roundedRectPath(rect.x, rect.y, rect.width, rect.height, opts.radius ?? 22, nodeSpacing)
  // Nodes are drawn WIDER than their spacing so their falloffs overlap into one tube (`rgbnode` is
  // baked as a near-partition-of-unity for exactly this); stretched along the tangent so a corner
  // never shows a bead.
  const nodeW = nodeSpacing * 2.4
  const nodeH = nodeSpacing * 1.5
  const nodes = path.map(pt =>
    scene.add
      .image(pt.x, pt.y, 'rgbnode')
      .setRotation(pt.angle)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(depth + 1)
      .setTint(tint)
      .setDisplaySize(nodeW, nodeH)
      .setAlpha(0)
  )

  // The dark ground the whole beat burns against (see `soot`), and here it is carrying meaning as
  // well as contrast: the region really is being consumed, so it going to ash under the fire is the
  // effect, not a trick to make the fire show. It comes up with the front and never fully lifts —
  // the caller's total lands on a darkened board, which is what makes the number the brightest
  // thing on screen.
  // Inset by a corner radius so the slab's square corners stay inside the frame's rounded ones.
  const ash = sootSlab(scene, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width - 10, rect.height - 10, depth - 1)

  // The interior: a molten wash that comes up under everything, plus the hot lip that crosses it.
  const wash = scene.textures.exists('bgglow')
    ? scene.add
        .image(rect.x + rect.width / 2, rect.y + rect.height / 2, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(depth)
        .setTint(tint)
        .setDisplaySize(rect.width * 1.05, rect.height * 1.05)
        .setAlpha(0)
    : null
  const lip = scene.textures.exists('bgglow')
    ? scene.add
        .image(rect.x, rect.y + rect.height / 2, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(depth + 1)
        .setTint(0xfff2d0)
        // NARROW on purpose — this is the cutting line, and `burnHeat`'s own bandwidth is narrow for
        // the same reason. Widen it and the beat stops reading as a fire crossing the board and
        // starts reading as a gradient sliding over it, which is a scene transition, not a burn.
        .setDisplaySize(rect.width * 0.15, rect.height * 1.12)
        .setAlpha(0)
    : null

  const peakFrame = (soft ? 0.5 : 0.95) * quality.scale()
  const peakWash = (soft ? 0.24 : 0.44) * quality.scale()
  const peakLip = (soft ? 0.4 : 0.95) * quality.scale()
  const peakAsh = soft ? 0.34 : 0.56

  let settled = false
  return new Promise<void>(resolve => {
    const done = (): void => {
      if (settled) return
      settled = true
      deadline.remove(false)
      resolve()
    }
    const drive = { t: 0 }
    scene.tweens.add({
      targets: drive,
      t: 1,
      duration: ms,
      ease: 'Linear', // the EASING lives in `burnFront`, so the front's shape is testable maths
      onUpdate: () => {
        const front = burnFront(drive.t)
        // The frame lights ahead of the front and stays lit behind it — the fire has taken the
        // border by the time it is eating the middle — with a hot lip travelling round it.
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]
          if (!n.active) continue
          const pos = (path[i].x - rect.x) / Math.max(1, rect.width)
          const taken = pos <= front ? 1 : 0
          n.setAlpha(peakFrame * (0.42 * taken + 0.58 * burnHeat(pos, front)))
        }
        if (ash.active) ash.setAlpha(peakAsh * Math.min(1, front * 2.2))
        if (wash?.active) wash.setAlpha(peakWash * Math.min(1, front * 1.6))
        if (lip?.active) {
          lip.x = rect.x + rect.width * front
          lip.setAlpha(peakLip * (1 - Math.max(0, front - 0.8) * 5))
        }
      },
      onComplete: () => {
        done()
        // Ash: the frame and wash release AFTER the total has landed, so the plaque arrives on a
        // still-glowing region rather than on a board that has already gone cold.
        const fade = [...nodes, wash, lip, ash].filter(
          (o): o is Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle => !!o && o.active
        )
        if (fade.length === 0) return
        scene.tweens.add({
          targets: fade,
          alpha: 0,
          delay: 160,
          duration: 460,
          ease: E.exit,
          onComplete: () => {
            for (const o of fade) if (o.active) o.destroy()
          },
        })
      },
    })
    // Backstop: the promise settles even if the drive tween is killed out from under us (a scene
    // shutdown, a `killTweensOf` sweep — 3.90's `destroy()` dispatches NOTHING, which is the exact
    // trap `GameScene.t()` carries a deadline for).
    const deadline = scene.time.delayedCall(ms + 400, () => {
      done()
      for (const o of [...nodes, wash, lip, ash]) if (o?.active) o.destroy()
    })
  })
}

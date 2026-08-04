import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import { CHAPTER_COUNT } from '../core/levels'
import { BOOST_META } from '../core/inventory'
import type { ChapterCatchUp, ChapterGrant } from '../core/trophies'
import { backOut, E, OVERSHOOT } from './motion'
import { quality } from './quality'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
import { ensureGlyphTexture } from './textures'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL } from './ui'
import type { ChipPill } from './ui'
import { vibratePattern } from './haptics'

/**
 * CHAPTER TROPHY ceremonies — the "you won something real" moment a chapter close pays.
 *
 * Two exports:
 *   • playChapterCeremony() — the in-scene reveal that REPLACES the milestone splash on a first
 *     clear of a chapter-closing level: letter-punch headline, the trophy descending onto a gold
 *     plinth under a room-filling burst, and the purse pouring physically into the balance pill.
 *   • openTrophyCatchUpCard() — the one-time Home card that back-pays every chapter a player had
 *     already beaten when the feature arrived (and quietly self-heals any grant a crash skipped).
 *
 * Both replay a SETTLED result: the caller banks the grant (core/trophies.ts claim*) before a pixel
 * moves, so a mid-celebration crash loses nothing — the same award-first discipline as the wheel,
 * the Deal and the charms. Built entirely from the shared toolkit (theme tokens, motion eases, baked
 * textures, sfx cues) so it reads as native cabinet art on all four themes, and fully reduced-motion
 * / reduce-flashing / haptics aware.
 *
 * The ceremony borrows the jackpot wheel's payoff grammar — gold flood, marquee letters, the chip
 * fountain that ticks the readout per landing — but those beats are closure-locals inside
 * openJackpotWheel, so they are re-implemented here from the same parts rather than exported: the
 * live wheel stays untouched, and the two ceremonies stay free to drift apart.
 */

export interface ChapterCeremonyOpts {
  /** The host scene's single graded-freeze authority (GameScene.hitstop). */
  hitstop?: (ms: number) => void
  /** Where the purse chips fly — the balance pill; onLand ticks the displayed total per landing. */
  chipFlyTo?: { x: number; y: number; onLand?: (landed: number, total: number) => void }
}

/**
 * Play the full chapter reveal. Resolves when it settles (auto, or tap-to-skip then tap-to-close).
 * The grant is already banked; this only performs it. First tap snaps every beat to its rest state,
 * second (or the auto-advance) resolves — the same two-stage skip the win sequence uses, so an
 * impatient player is never punished with a lost purse display.
 */
export function playChapterCeremony(
  scene: Phaser.Scene,
  grant: ChapterGrant,
  opts: ChapterCeremonyOpts = {}
): Promise<void> {
  return new Promise<void>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const flashOff = reduceFlashing()
    const W = DESIGN_W
    const cx = W / 2
    // The milestone splash's own seat — this ceremony stands in for it, so it composes on the same
    // sightline over the still-visible board.
    const cy = 560
    const isCar = grant.chapter === CHAPTER_COUNT

    const layer = scene.add.container(0, 0).setDepth(60)
    const timers: Phaser.Time.TimerEvent[] = []
    const at = (ms: number, fn: () => void): void => {
      timers.push(scene.time.delayedCall(ms, fn))
    }
    const killTimers = (): void => {
      for (const t of timers) t.remove(false)
      timers.length = 0
    }
    const killTweens = (): void => {
      layer.each((child: Phaser.GameObjects.GameObject) => scene.tweens.killTweensOf(child))
    }

    // ── Cast (built up front so a skip can snap the whole composition to rest) ──

    // A soft scrim, not the modal 0.72: the board should glow through — the ceremony happens over
    // the table, not in a separate room. It is also the tap surface for skip/close.
    const scrim = scene.add
      .rectangle(cx, viewportCenterY(), W, worldH() + 400, T.scrim, 0.5)
      .setInteractive()
    layer.add(scrim)

    const kicker = scene.add
      .text(cx, cy - 224, `CHAPTER ${grant.chapter}`, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(8)
      .setStroke('#ffffff', 6)
    layer.add(kicker)

    // Marquee letters — each punches in on its own eager overshoot with a tiny cant (the wheel's
    // JACKPOT! grammar), then rests as the headline.
    const word = 'COMPLETE!'
    const letterW = 46
    const x0 = cx - ((word.length - 1) * letterW) / 2
    const letters: Phaser.GameObjects.Text[] = []
    for (let i = 0; i < word.length; i++) {
      const L = scene.add
        .text(x0 + i * letterW, cy - 152, word[i], {
          fontFamily: FONT,
          fontSize: '58px',
          fontStyle: '900',
          color: css(T.goldBright),
        })
        .setOrigin(0.5)
        .setStroke(css(T.goldDarkest), 8)
        .setShadow(0, 5, 'rgba(70,45,10,0.55)', 9, false, true)
      letters.push(L)
      layer.add(L)
    }

    // The plinth — a squat gold pedestal with a lit top edge, drawn once (one Graphics, opaque).
    const plinthTop = cy + 64
    const plinth = scene.add.graphics()
    plinth.fillStyle(0x000000, 0.18)
    plinth.fillEllipse(cx, plinthTop + 74, 240, 30)
    plinth.fillStyle(T.goldDeep, 1)
    plinth.fillRoundedRect(cx - 92, plinthTop + 10, 184, 58, 12)
    plinth.fillStyle(T.gold, 1)
    plinth.fillRoundedRect(cx - 104, plinthTop - 4, 208, 20, 9)
    plinth.lineStyle(3, T.goldBezel, 1)
    plinth.strokeRoundedRect(cx - 104, plinthTop - 4, 208, 20, 9)
    plinth.fillStyle(0xffffff, 0.28)
    plinth.fillRoundedRect(cx - 96, plinthTop - 1, 192, 6, 3)
    layer.add(plinth)

    const trophyKey = ensureGlyphTexture(scene, `trophy:${grant.chapter}`, grant.trophy.emoji, 96, 128)
    const trophyRestY = plinthTop - 62
    const trophy = scene.add.image(cx, trophyRestY, trophyKey).setDisplaySize(128, 128)
    layer.add(trophy)

    const name = scene.add
      .text(cx, plinthTop + 116, grant.trophy.label, {
        fontFamily: FONT,
        fontSize: '36px',
        fontStyle: '900',
        color: isCar ? css(T.rose) : T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(3)
      .setStroke('#ffffff', 7)
    layer.add(name)

    const shelfLine = scene.add
      .text(cx, plinthTop + 156, `TROPHY ${grant.chapter} OF ${CHAPTER_COUNT} · NOW IN THE SHOWROOM`, {
        fontFamily: FONT,
        fontSize: '17px',
        fontStyle: '700',
        color: T.inkMuted,
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 4)
    layer.add(shelfLine)

    const purse = scene.add
      .text(cx, plinthTop + 212, `+${grant.purse.toLocaleString()} CHIPS`, {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: css(T.roseLight),
      })
      .setOrigin(0.5)
      .setStroke(css(T.goldDarkest), 6)
    layer.add(purse)

    const boostLine = grant.boost
      ? scene.add
          .text(cx, plinthTop + 254, `+1 ${BOOST_META[grant.boost].label} · JOINS YOUR NEXT LEVEL`, {
            fontFamily: FONT,
            fontSize: '18px',
            fontStyle: '700',
            color: T.inkSoft,
          })
          .setOrigin(0.5)
          .setStroke('#ffffff', 4)
      : null
    if (boostLine) layer.add(boostLine)

    // ── Payoff beats (re-implementations of the wheel's closure-local grammar) ──

    /** Room-filling gold flood; rose for the car. Slow swell under reduce-flashing, skipped reduced. */
    const goldBurst = (): void => {
      if (reduced) return
      const burst = scene.add
        .image(cx, cy, 'bgglow')
        .setTint(isCar ? T.rose : T.goldBright)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(DESIGN_W * 2.6, worldH() * 1.7)
      layer.add(burst)
      if (flashOff) {
        burst.setAlpha(0)
        scene.tweens.add({
          targets: burst,
          alpha: 0.26,
          duration: 640,
          yoyo: true,
          hold: 200,
          ease: 'Sine.easeInOut',
          onComplete: () => burst.destroy(),
        })
      } else {
        burst.setAlpha(isCar ? 0.85 : 0.7)
        scene.tweens.add({ targets: burst, alpha: 0, duration: 620, ease: 'Quad.easeOut', onComplete: () => burst.destroy() })
      }
    }

    // The purse fountain — chips launch off the plinth and dive into the balance pill, ticking the
    // readout per landing. Mirrors the wheel's; governor-scaled; needs the baked textures the host
    // scene already carries (guarded so a texture-less host degrades to the readout alone).
    let fountainDone = reduced || !opts.chipFlyTo || !scene.textures.exists('chip')
    const settleFountain = (): void => {
      // Whatever the chips were doing, the readout must end true — one final tick to the full total.
      if (!fountainDone) {
        fountainDone = true
        opts.chipFlyTo?.onLand?.(1, 1)
      }
    }
    const chipFountain = (): void => {
      const fly = opts.chipFlyTo
      if (fountainDone || !fly) return
      const n = Math.max(1, quality.count(Math.min(12, 5 + Math.floor(grant.purse / 100))))
      let landed = 0
      sfx.coinCount()
      const sparks = scene.textures.exists('spark')
        ? scene.add
            .particles(0, 0, 'spark', {
              speed: { min: 40, max: 160 },
              angle: { min: 0, max: 360 },
              scale: { start: 0.5, end: 0 },
              alpha: { start: 0.9, end: 0 },
              lifespan: { min: 240, max: 420 },
              tint: T.goldBright,
              blendMode: 'ADD',
              emitting: false,
            })
            .setDepth(64)
        : null
      if (sparks) layer.add(sparks)
      for (let i = 0; i < n; i++) {
        const c = scene.add.image(cx, plinthTop - 20, 'chip').setDisplaySize(44, 44).setAlpha(0)
        layer.add(c)
        const delay = 90 + i * 70
        const apexX = cx + Phaser.Math.Between(-190, 190)
        const apexY = plinthTop - Phaser.Math.Between(240, 360)
        const spin = Phaser.Math.Between(140, 300) * (Math.random() < 0.5 ? -1 : 1)
        scene.tweens.add({ targets: c, alpha: 1, duration: 60, delay, ease: 'Quad.easeOut' })
        scene.tweens.add({ targets: c, x: apexX, angle: spin, duration: 400, delay, ease: 'Sine.easeOut' })
        scene.tweens.add({
          targets: c,
          y: apexY,
          duration: 400,
          delay,
          ease: 'Quad.easeOut',
          onComplete: () => {
            scene.tweens.add({
              targets: c,
              x: fly.x,
              y: fly.y,
              angle: spin * 2,
              displayWidth: 20,
              displayHeight: 20,
              duration: 440,
              ease: 'Cubic.easeIn',
              onComplete: () => {
                landed++
                sparks?.explode(quality.count(3), fly.x, fly.y)
                sfx.scoreTick()
                if (!fountainDone) fly.onLand?.(landed, n)
                if (landed >= n) fountainDone = true
                c.destroy()
              },
            })
          },
        })
      }
    }

    // ── Skip / close ──

    let phase: 'playing' | 'settled' | 'done' = 'playing'
    const finish = (): void => {
      if (phase === 'done') return
      phase = 'done'
      killTimers()
      killTweens()
      settleFountain()
      layer.destroy()
      resolve()
    }
    const rest = (): void => {
      // Snap every element to its settled pose — the exact end state of the timeline below.
      killTimers()
      killTweens()
      settleFountain()
      layer.each((child: Phaser.GameObjects.GameObject) => {
        if (child === (scrim as Phaser.GameObjects.GameObject)) return
        const o = child as unknown as { setAlpha?: (a: number) => void }
        o.setAlpha?.(1)
      })
      scrim.setAlpha(0.5)
      for (const L of letters) L.setScale(1).setAngle(0)
      kicker.setScale(1)
      trophy.setPosition(cx, trophyRestY).setScale(1).setDisplaySize(128, 128)
      name.setScale(1)
      purse.setScale(1)
    }
    const settle = (fromTap: boolean): void => {
      if (phase !== 'playing') return
      phase = 'settled'
      if (fromTap) rest()
      // Give the settled card a beat to be read, then close on its own; a tap closes it sooner.
      at(fromTap ? 1200 : 1600, finish)
    }
    scrim.on('pointerup', () => (phase === 'playing' ? settle(true) : finish()))

    // ── Timeline ──

    if (reduced) {
      // Reduced motion: the composed card, at rest, one fanfare — and the readout still ends true.
      rest()
      phase = 'settled'
      sfx.winFanfare()
      at(2600, finish)
      return
    }

    layer.setAlpha(0)
    scene.tweens.add({ targets: layer, alpha: 1, duration: 200, ease: 'Sine.easeOut' })
    sfx.winFanfare()
    if (!hapticsOff()) vibratePattern([80, 50, 120])

    kicker.setScale(0)
    scene.tweens.add({ targets: kicker, scale: 1, duration: 320, delay: 80, ease: backOut(OVERSHOOT.gentle) })
    letters.forEach((L, i) => {
      L.setScale(0).setAngle(Phaser.Math.Between(-8, 8))
      scene.tweens.add({ targets: L, scale: 1, angle: 0, duration: 300, delay: 150 + i * 55, ease: backOut(OVERSHOOT.pop) })
    })
    // One cream gleam gliding across the headline once the letters land.
    if (scene.textures.exists('sweep')) {
      const gleam = scene.add
        .image(x0 - letterW, cy - 152, 'sweep')
        .setDisplaySize(46, 84)
        .setTint(0xfffdf8)
        .setAlpha(0)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAngle(12)
      layer.add(gleam)
      const sweepDelay = 150 + word.length * 55 + 180
      scene.tweens.add({ targets: gleam, x: x0 + word.length * letterW, duration: 340, delay: sweepDelay, ease: E.glide, onComplete: () => gleam.destroy() })
      scene.tweens.add({ targets: gleam, alpha: 0.7, duration: 170, delay: sweepDelay, yoyo: true, ease: E.hero })
    }

    // The trophy descends onto the plinth — the coronation's crown-descend, landing with the room.
    trophy.setPosition(cx, trophyRestY - 210).setAlpha(0).setScale(0.72)
    name.setAlpha(0)
    shelfLine.setAlpha(0)
    purse.setAlpha(0)
    boostLine?.setAlpha(0)
    at(760, () => {
      scene.tweens.add({ targets: trophy, alpha: 1, duration: 140, ease: 'Quad.easeOut' })
      scene.tweens.add({
        targets: trophy,
        y: trophyRestY,
        scale: 1,
        duration: 460,
        ease: 'Cubic.easeIn',
        onComplete: () => {
          opts.hitstop?.(isCar ? 90 : 60)
          sfx.jackpotStrike()
          if (isCar) sfx.mayaMotif()
          if (!hapticsOff()) vibratePattern(isCar ? [20, 40, 30] : 16)
          goldBurst()
          name.setScale(0.6)
          scene.tweens.add({ targets: name, alpha: 1, scale: 1, duration: 300, ease: backOut(OVERSHOOT.pop) })
          scene.tweens.add({ targets: shelfLine, alpha: 1, duration: 280, delay: 160, ease: 'Sine.easeOut' })
        },
      })
    })

    // The purse lands, then physically pours into the balance.
    at(1720, () => {
      purse.setScale(0)
      scene.tweens.add({ targets: purse, alpha: 1, scale: 1, duration: 300, ease: backOut(OVERSHOOT.pop) })
      chipFountain()
      if (boostLine) scene.tweens.add({ targets: boostLine, alpha: 1, duration: 300, delay: 260, ease: 'Sine.easeOut' })
    })

    at(4200, () => settle(false))
  })
}

export interface TrophyCatchUpResult {
  /** True when the player asked to see the showroom — the caller opens it. */
  showShowroom: boolean
}

/**
 * The one-time catch-up card on Home — every chapter already beaten, back-paid in one sweep.
 *
 * The caller has ALREADY claimed (claimChapterCatchUp, award-first), so this card presents a settled
 * result and latches nothing: the claim latch is the only latch, which is what makes the sweep also
 * the crash-recovery net. Shows the trophies as a shelf and the purse as one honest total — thirty
 * chapters of back-pay lands as "the game owed you this", not as an inexplicable jackpot.
 */
export function openTrophyCatchUpCard(
  scene: Phaser.Scene,
  result: ChapterCatchUp,
  pill?: ChipPill
): Promise<TrophyCatchUpResult> {
  return new Promise<TrophyCatchUpResult>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    let settled = false
    const finish = (showShowroom: boolean): void => {
      if (settled) return
      settled = true
      sfx.whoosh()
      layer.destroy()
      resolve({ showShowroom })
    }

    const scrim = scene.add.rectangle(W / 2, viewportCenterY(), W, worldH() + 400, T.scrim, 0.72).setInteractive()
    scrim.on('pointerup', () => finish(false))
    layer.add(scrim)

    // Card height breathes with the shelf: 6 trophies per row, up to 5 rows for a finished player.
    const n = result.grants.length
    const COLS = 6
    const CELL = 74
    const rows = Math.ceil(n / COLS)
    const gridH = rows * CELL
    const px = 46
    const pw = W - 92
    const ph = Math.min(1020, 560 + gridH)
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(px, pyTop, pw, ph, 30)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(px, pyTop, pw, ph, 30)
    layer.add(g)
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    layer.add(
      scene.add
        .text(W / 2, pyTop + 74, 'CHAPTER TROPHIES', {
          fontFamily: FONT,
          fontSize: '46px',
          fontStyle: '900',
          color: T.goldText,
        })
        .setOrigin(0.5)
        .setLetterSpacing(2)
    )
    layer.add(
      scene.add
        .text(W / 2, pyTop + 122, 'DELIVERED', {
          fontFamily: FONT,
          fontSize: '28px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0.5)
        .setLetterSpacing(6)
    )
    layer.add(
      scene.add
        .text(W / 2, pyTop + 176, 'Every chapter you had already beaten now pays its trophy and purse.', {
          fontFamily: FONT,
          fontSize: '19px',
          color: T.inkMuted,
          wordWrap: { width: pw - 120 },
          align: 'center',
          lineSpacing: 4,
        })
        .setOrigin(0.5)
    )

    // The shelf — the earned trophies, chapter order, popped in reading order.
    const gridTop = pyTop + 232
    const gridW = COLS * CELL
    const icons: Phaser.GameObjects.Image[] = []
    result.grants.forEach((grant, i) => {
      const gx = W / 2 - gridW / 2 + CELL / 2 + (i % COLS) * CELL
      const gy = gridTop + CELL / 2 + Math.floor(i / COLS) * CELL
      const key = ensureGlyphTexture(scene, `trophy:${grant.chapter}`, grant.trophy.emoji, 96, 128)
      const icon = scene.add.image(gx, gy, key).setDisplaySize(52, 52)
      icons.push(icon)
      layer.add(icon)
    })

    const footTop = gridTop + gridH + 34
    layer.add(
      scene.add
        .text(W / 2, footTop, `${n} ${n === 1 ? 'TROPHY' : 'TROPHIES'} · +${result.totalPurse.toLocaleString()} CHIPS`, {
          fontFamily: FONT,
          fontSize: '30px',
          fontStyle: '900',
          color: css(T.rose),
        })
        .setOrigin(0.5)
        .setStroke('#ffffff', 6)
    )
    const boosts = result.grants.filter(grantItem => grantItem.boost).length
    if (boosts > 0) {
      layer.add(
        scene.add
          .text(W / 2, footTop + 42, `+${boosts} ${boosts === 1 ? 'BOOST' : 'BOOSTS'} BANKED FOR YOUR NEXT LEVELS`, {
            fontFamily: FONT,
            fontSize: '17px',
            fontStyle: '700',
            color: T.inkSoft,
          })
          .setOrigin(0.5)
      )
    }

    const see = addPillButton(scene, W / 2, pyTop + ph - 120, 360, 66, 'SEE THE SHOWROOM', GOLD_PILL, () => finish(true))
    layer.add(see)
    const later = addPillButton(scene, W / 2, pyTop + ph - 46, 220, 50, 'LATER', GHOST_PILL, () => finish(false))
    layer.add(later)

    // The balance readout catches up shortly after the card lands — the chips are already banked.
    if (pill) scene.time.delayedCall(reduced ? 200 : 600, () => pill.update(result.balance))

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      icons.forEach((icon, i) => {
        icon.setScale(0)
        scene.tweens.add({ targets: icon, scale: 1, duration: 260, delay: 140 + i * 36, ease: backOut(OVERSHOOT.pop) })
      })
      sfx.winFanfare()
    }
  })
}

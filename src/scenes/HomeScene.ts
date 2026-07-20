import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY } from '../config'
import { spinAvailable, todayKey } from '../core/daily'
import { endlessBestThisWeek, endlessUnlocked } from '../core/endless'
import { LEVEL_COUNT } from '../core/levels'
import { refreshLives } from '../core/lives'
import { greeting, occasionFor, pendingOccasion, secretNote, withName } from '../core/maya'
import { loadSave, markOccasionSeen, touchOpen } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import { addJackpotMeter } from '../view/jackpot'
import { OVERSHOOT, backOut, fadeRise, heartbeat } from '../view/motion'
import { quality } from '../view/quality'
import { getTheme, prefersReducedMotion } from '../view/theme'
import {
  FONT,
  GHOST_PILL,
  GOLD_PILL,
  ROSE_PILL,
  addChipPill,
  addHelpChip,
  addLivesHud,
  addMarquee,
  addPillButton,
  addSettingsChip,
  addSoundChip,
  addStreakBadge,
  addThemeChip,
  applyEntrance,
  hasNavigated,
  openHelpPanel,
  openSettingsPanel,
  openSoundPanel,
  openThemePanel,
  startScene,
} from '../view/ui'

/**
 * Power-on latch (§E10 / Signature #1). Set once the app's first Home paint has run its full
 * "wake up" choreography, so later returns to Home (from a level / back) get the normal quick
 * entrance instead of replaying the reveal. Module-scoped → resets on a real page reload (a true
 * boot), never on an in-app scene.restart() (theme/settings change) or scene navigation.
 */
let bootRevealed = false

export class HomeScene extends Phaser.Scene {
  /** Guards the discovered secret-note overlay so long-press/4-tap can't stack copies. */
  private noteOpen = false

  // --- C1 · ambient PLAY-glow halo, phase-locked to the shared heartbeat clock in update() ---
  /** The soft gold halo behind PLAY; its steady breathe is driven per-frame off `heartbeat`. */
  private playGlow?: Phaser.GameObjects.Image
  /** Resting scale of the halo — the heartbeat swells a small delta above this. */
  private playGlowBaseSX = 1
  private playGlowBaseSY = 1
  /** Gate: the heartbeat only takes over AFTER the fade-in/power-on bloom lands (never under reduced motion). */
  private playGlowLive = false

  // --- C4/H3 · idle attract beat: a soft one-shot "come play" invitation fired once per idle entry ---
  /** Rising-edge latch for `quality.idle()` — true once the current idle beat has fired; re-armed on activity. */
  private wasIdle = false
  /** The PLAY container + its steady breathe tween; the attract beat pauses the breathe for one bigger pulse. */
  private playButton?: Phaser.GameObjects.Container
  private playBreathe?: Phaser.Tweens.Tween
  /** The hero emblem — the idle suit-ghost drifts across behind it (read for its live centre). */
  private heroEmblem?: Phaser.GameObjects.Image

  constructor() {
    super('home')
  }

  create(): void {
    this.noteOpen = false // reset per entry (scene.start reuses the instance)
    this.wasIdle = false // C4: re-arm the idle-attract latch per entry (the instance is reused across navigation)
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    // Centre the 720×1280 design box in the (possibly taller) world; applyEntrance/power-on animate
    // onto this rest position rather than 0.
    this.cameras.main.setScroll(0, restScrollY())
    // §E10 / Signature #1 — the app's FIRST Home paint (straight from BootScene, before any in-app
    // navigation and only once per page-load) is the "power-on" reveal. Every later Home entry
    // (return from a level, back button, theme/settings restart) gets the normal quick entrance.
    const isBoot = !hasNavigated() && !bootRevealed
    bootRevealed = true
    const powerOn = isBoot && !this.prefersReducedMotion()
    // Directional push/pop (§E10) rides the NORMAL entrances (returns settle DOWN); the power-on IS
    // its own entrance, so it opts out of the camera nudge. Reduced-motion → applyEntrance no-ops.
    if (!powerOn) applyEntrance(this)
    const save = loadSave()
    // §E9 — stamp first/last open dates (safe: touches only those two fields). Enables future
    // "welcome back" warmth; never alters progress.
    const today = touchOpen(todayKey()).lastOpenDate ?? todayKey()
    const currentLevel = Math.min(save.unlocked, LEVEL_COUNT)
    const reduced = this.prefersReducedMotion()
    // Stacked pill buttons that fade + slide up into place on entrance (see below).
    const menuButtons: Phaser.GameObjects.Container[] = []

    addCasinoBackdrop(this, 'home')

    // How-to-play / FAQ, tucked in the top-left corner.
    const helpChip = addHelpChip(this, 60, 44)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('help')) openHelpPanel(this)

    // Settings / accessibility — paired with help on the left (utility cluster).
    addSettingsChip(this, 132, 44)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('settings')) openSettingsPanel(this)

    // Move-sound picker, mirrored in the top-right corner.
    addSoundChip(this, 676, 44)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('sound')) openSoundPanel(this)

    // Theme picker — paired with the sound chip (both are look-and-feel pickers).
    addThemeChip(this, 604, 44)
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('theme')) openThemePanel(this)

    // §E14 first-run advertisement: pulse the ? help chip ONCE for a truly-new player (seenIntro
    // still false AND on level 1) so a first-timer notices where help lives. Reduced motion → no
    // pulse (the onboarding card itself carries the teach). Never fires for Maya's Level-46 save.
    if (!save.seenIntro && save.unlocked <= 1 && !reduced) {
      this.tweens.add({
        targets: helpChip,
        scale: 1.18,
        duration: 420,
        yoyo: true,
        repeat: 3,
        ease: 'Sine.easeInOut',
        delay: 320,
      })
    }

    // Persistent chip balance (earned reward token) — top-center, between the ? and ♪ corner
    // chips and above the lives pool. A read-out here; chips are spent in the Gift Store.
    addChipPill(this, DESIGN_W / 2, 44)

    // Top status: lives pool (with a live "next life" countdown) above the streak flame.
    const livesHud = addLivesHud(this, DESIGN_W / 2, 100, { size: 32, timerColor: getTheme().onBackdropMuted })
    const refreshLivesHud = (): void => livesHud.update(refreshLives())
    refreshLivesHud()
    this.time.addEvent({ delay: 1000, loop: true, callback: refreshLivesHud })
    // Daily-spin streak flame — hidden at streak 0.
    addStreakBadge(this, DESIGN_W / 2, 176, save.streak)

    // §E9 time-of-day greeting — NAMELESS by default; the name appears ONLY when maya.showName.
    // On a configured special date it becomes the occasion greeting (the app "already knew").
    // Backdrop-drawn → routed through onBackdrop* tokens (legible on the dark themes too).
    const occToday = occasionFor(today.slice(5))
    const greetLine = occToday ? withName(occToday.label) : greeting(new Date().getHours())
    const greetText = this.add
      .text(DESIGN_W / 2, 214, greetLine, { fontFamily: FONT, fontSize: '23px', color: getTheme().onBackdropInk })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    // H1 · fade-rise the greeting so the top of Home composes in rather than stamping static. On boot it
    // sequences in behind the emblem spring (a delay so it never precedes the power-on reveal); on a
    // normal entry it rises a hair after the camera nudge (applyEntrance) leads. Reduced motion →
    // fadeRise places it at its resting state instantly (the a11y path for free).
    fadeRise(this, greetText, { delay: powerOn ? 220 : 120 })

    // §E9 special-date dress-up (signature moment #5) — DORMANT unless an occasion is configured,
    // matches today, and hasn't fired today. Fires a once-that-day heart-shower and marks it seen.
    const occFire = pendingOccasion(today, save.occasionsSeen)
    if (occFire) {
      markOccasionSeen(today)
      this.occasionShower()
    }

    // Card-suit hero emblem — the full deck shuffles through the emblem slot (heart · spade ·
    // diamond · club), each one winding down + tipping, swapping glyph, then springing back up past
    // its resting scale with a bouncy overshoot before it holds for a heartbeat. Red hearts/diamonds
    // + black spades/clubs come straight from the platform emoji. All four share the same 384² frame,
    // so `setTexture()` swaps mid-tween with no size jump. Reduced motion (§E8): a single static
    // heart, no cycle — identical to the old resting emblem.
    const emblemY = 330
    const SUITS = ['suitHeart', 'suitSpade', 'suitDiamond', 'suitClub'] as const
    const emblem = this.add.image(DESIGN_W / 2, emblemY, reduced ? 'heartbig' : SUITS[0])
    emblem.setDisplaySize(190, 190)
    this.heroEmblem = emblem // held so the C4/H3 idle suit-ghost can drift across behind it
    const base = emblem.scaleX
    let suitIdx = 0
    // Hold the landed suit with one gentle heartbeat, then shuffle on to the next.
    const holdBeat = (): void => {
      this.tweens.add({
        targets: emblem,
        scale: base * 1.06,
        duration: 280,
        yoyo: true,
        ease: 'Sine.easeInOut',
        onComplete: () => this.time.delayedCall(200, spinNext),
      })
    }
    // One turn of the shuffle: wind the current suit down + tip it (Back.easeIn anticipation), swap
    // to the next suit tipped the other way, then spring it upright + up to rest with a bouncy pop.
    const spinNext = (): void => {
      const nextIdx = (suitIdx + 1) % SUITS.length
      this.tweens.add({
        targets: emblem,
        scale: base * 0.5,
        angle: -12,
        duration: 170,
        ease: 'Back.easeIn',
        onComplete: () => {
          suitIdx = nextIdx
          emblem.setTexture(SUITS[suitIdx])
          emblem.setAngle(12)
          this.tweens.add({
            targets: emblem,
            scale: base,
            angle: 0,
            duration: 480,
            ease: backOut(OVERSHOOT.pop),
            onComplete: holdBeat,
          })
        },
      })
    }
    if (reduced) {
      // Static heart — the emblem already rests at base scale; no shuffle.
    } else if (powerOn) {
      // Power-on beat #1: the first suit springs up from nothing, THEN the shuffle begins.
      emblem.setScale(0)
      this.tweens.add({
        targets: emblem,
        scale: base,
        duration: 440,
        delay: 100,
        ease: backOut(OVERSHOOT.pop),
        onComplete: holdBeat,
      })
    } else {
      holdBeat()
    }
    // §E9 secret love note — DISCOVERED, never advertised: a long-press (~620ms) or 4 quick taps
    // on the emblem opens it. Nothing on the front door hints at it beyond the tappable emblem.
    this.wireSecretNote(emblem)
    // 3f Home emblem sparkle: sparse drifting hearts near the emblem. Reconciled with the existing
    // satellites (not a second emitter) — governor-capped (fewer on weak tiers) and reduced-motion
    // gated (placed static, no drift).
    const satellites: Array<[number, number, number, number]> = [
      [-130, -60, 30, 0],
      [138, -30, 24, 500],
      [110, 84, 20, 900],
    ]
    for (const [dx, dy, size, delay] of satellites.slice(0, Math.max(1, quality.count(satellites.length)))) {
      const mini = this.add.image(DESIGN_W / 2 + dx, emblemY + dy, 'heart').setAlpha(reduced ? 0.4 : 0.5)
      mini.setDisplaySize(size, size)
      if (reduced) continue
      this.tweens.add({
        targets: mini,
        y: emblemY + dy - 14,
        alpha: 0.25,
        duration: 1600,
        delay,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }

    // Marquee wordmark (+ a subtle bulb row for the power-on to cascade-light). On boot, beats #2/#3:
    // a single gold sweep unveils VIVA·MAYA and the bulbs cascade left→right after the emblem draws in.
    const marquee = addMarquee(this, DESIGN_W / 2, 500, { bulbs: true })
    if (powerOn) marquee.powerOn(this, 420)
    // BT1 · power-on audio swell (Signature #1 finish). A warm, theme-tinted rising chord — the tonal
    // sibling of the sweep's airy `whoosh` — blooms as the boot reveal lights the wordmark, so the
    // identity open is multi-sensory. Fires on the TRUE boot reveal only (`isBoot`), so it stays scarce
    // (never on a normal Home re-entry). NOT motion-gated: like `mayaMotif` a boot chord is no motion
    // hazard, so it plays under reduced motion too (there the wordmark is already lit → it just sounds
    // promptly); mute-gated inside `sfx`. Under the visual sweep, delay it to swell as the gold light
    // passes VIVA (~150ms into the 420ms lead-in).
    if (isBoot) this.time.delayedCall(powerOn ? 560 : 120, () => sfx.powerOn())
    const tagline = this.add
      .text(DESIGN_W / 2, 560, 'cascades  ·  power-ups  ·  jackpots', {
        fontFamily: FONT,
        fontSize: '24px',
        color: getTheme().onBackdropMuted,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
    // H1 · the tagline fade-rises a beat after the greeting (a gentle top-down settle). On boot it lands
    // just after the gold sweep reveals VIVA·MAYA above it; on a normal entry it follows the greeting in.
    fadeRise(this, tagline, { delay: powerOn ? 700 : 200 })

    // Soft gold halo behind PLAY — rendered underneath the button. Its steady breathe is phase-locked
    // to the shared `heartbeat` clock in update() (C1), so it pulses in time with every other ambient
    // glow in the app. Uses the runtime 'bgglow' texture from the backdrop.
    const glow = this.add.image(DESIGN_W / 2, 720, 'bgglow')
    glow.setTint(getTheme().gold).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(460, 240)
    const glowSX = glow.scaleX
    const glowSY = glow.scaleY
    glow.setAlpha(reduced ? 0.28 : 0)
    // Stash the halo + its resting scale so update() can drive it once the bloom has landed.
    this.playGlow = glow
    this.playGlowBaseSX = glowSX
    this.playGlowBaseSY = glowSY
    this.playGlowLive = false
    if (!reduced) {
      // Power-on beat #4: on boot the warm glow BLOOMS up (delayed + swelling from small) after the
      // wordmark reveal; on a normal entrance it just fades in alongside PLAY. Then the shared
      // heartbeat takes over its steady breathing (see update()) — no independent yoyo.
      const bloomDelay = powerOn ? 980 : 0
      if (powerOn) glow.setScale(glowSX * 0.7, glowSY * 0.7)
      this.tweens.add({
        targets: glow,
        alpha: 0.22,
        scaleX: glowSX,
        scaleY: glowSY,
        duration: powerOn ? 420 : 260,
        delay: bloomDelay,
        ease: 'Sine.easeOut',
        onComplete: () => {
          // Hand the breathe off to the heartbeat clock: update() now modulates alpha (~0.22 rest →
          // ~0.4 peak) + a slight scale from heartbeat.amp(), in phase with the rest of the app.
          this.playGlowLive = true
        },
      })
    }

    // C6 · opt-in shared-element bloom: hand the destination PLAY's on-screen spot + size so the board
    // "opens" from right here. Additive — only this one nav passes a focus; reduced motion never queues
    // it (gated in startScene), so the calm path keeps today's flat cream cross-fade untouched.
    const play = addPillButton(this, DESIGN_W / 2, 720, 340, 96, 'PLAY', GOLD_PILL, () =>
      startScene(this, 'game', { level: currentLevel }, undefined, { x: DESIGN_W / 2, y: 720, w: 340, h: 96, tint: getTheme().gold })
    )
    menuButtons.push(play)
    // Held for the C4/H3 idle attract beat — the "come play" pulse pauses this breathe, nudges, resumes.
    this.playButton = play
    // PLAY breathe — gated (§E8): reduced motion leaves it at its resting scale.
    if (!reduced) {
      this.playBreathe = this.tweens.add({
        targets: play,
        scale: 1.04,
        duration: 800,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
    const sub =
      save.best > 0
        ? `Level ${currentLevel}  ·  best ${save.best.toLocaleString()}`
        : `Level ${currentLevel}  ·  swipe to match 3`
    this.add
      .text(DESIGN_W / 2, 790, sub, { fontFamily: FONT, fontSize: '22px', color: getTheme().onBackdropMuted })
      .setOrigin(0.5)

    // Jackpot charge meter — a compact progress read-out in the hero area (fills one notch per level
    // win). Display-only: the wheel itself explodes in-game after the win that tops the meter off.
    addJackpotMeter(this, DESIGN_W / 2, 590, { width: 300, compact: true }).update(save.jackpotMeter, false)

    // LEVELS + GIFT STORE share a row so the store gets a first-class entry without growing the stack.
    const levels = addPillButton(this, DESIGN_W / 2 - 158, 872, 300, 64, 'LEVELS', GHOST_PILL, () =>
      startScene(this, 'levelselect')
    )
    menuButtons.push(levels)
    const store = addPillButton(this, DESIGN_W / 2 + 158, 872, 300, 64, 'GIFT STORE', GHOST_PILL, () =>
      startScene(this, 'store')
    )
    menuButtons.push(store)

    // Daily bonus entry: glowing when the spin is ready, quiet when claimed.
    // NOTE: no emoji in pill labels — addPillButton's letterSpacing splits
    // surrogate pairs in Phaser's glyph renderer (renders tofu).
    const ready = spinAvailable(save)
    const label = ready ? 'DAILY BONUS' : `SPUN · DAY ${Math.max(1, save.streak)}`
    const daily = addPillButton(this, DESIGN_W / 2, 986, 340, 76, label, ready ? GOLD_PILL : GHOST_PILL, () =>
      startScene(this,'daily')
    )
    menuButtons.push(daily)
    // Daily-ready breathe — gated (§E8): reduced motion leaves it at its resting scale.
    if (ready && !reduced) {
      this.tweens.add({ targets: daily, scale: 1.05, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    if (save.pendingBoosts.length > 0) {
      this.add
        .text(DESIGN_W / 2, 1044, `🎁 boost ready for your next level`, { fontFamily: FONT, fontSize: '20px', color: getTheme().goldText })
        .setOrigin(0.5)
    }

    // Endless weekly race — unlocks after level 30.
    if (endlessUnlocked(save)) {
      const wkBest = endlessBestThisWeek(save)
      const endless = addPillButton(this, DESIGN_W / 2, 1108, 340, 72, 'ENDLESS', ROSE_PILL, () =>
        startScene(this,'game', { endless: true })
      )
      menuButtons.push(endless)
      this.add
        .text(
          DESIGN_W / 2,
          1158,
          wkBest > 0 ? `this week's board  ·  best ${wkBest.toLocaleString()}` : `new weekly board  ·  set the pace`,
          { fontFamily: FONT, fontSize: '20px', color: getTheme().onBackdropMuted }
        )
        .setOrigin(0.5)
    }

    // Entrance stagger: the stacked pill buttons fade + slide up 12px into place,
    // ~60ms apart (PLAY, LEVELS, DAILY, ENDLESS). The scale pulses on PLAY/DAILY
    // tween a different property, so they coexist with these y/alpha tweens.
    // Reduced motion keeps every button in its final alpha=1 / final-y resting state.
    if (!reduced) {
      // Power-on beat #5: on boot the button stagger waits for the glow bloom, so the chips/buttons
      // are the last thing to arrive; on a normal entrance it plays immediately (unchanged).
      const staggerBase = powerOn ? 1080 : 0
      menuButtons.forEach((btn, i) => {
        const finalY = btn.y
        btn.setAlpha(0)
        btn.y = finalY + 12
        this.tweens.add({
          targets: btn,
          y: finalY,
          alpha: 1,
          duration: 260,
          delay: staggerBase + i * 60,
          ease: 'Back.easeOut',
        })
      })
    }
  }

  /**
   * C1 · heartbeat coherence. Drive the ambient PLAY-glow halo off the shared `heartbeat` clock so it
   * breathes in phase with the in-game cabinet glow and every other hero breather — one organism, not
   * N independent yoyos. Only runs once the fade-in/power-on bloom has landed (`playGlowLive`), and
   * NEVER under reduced motion: there the halo holds the static resting alpha set in create(), reading
   * neither the clock nor modulating per-frame — exactly today's reduced-motion behaviour.
   */
  update(): void {
    // C4 · idle attract — watch the governor's idle flag every frame; a rising edge fires the H3 beat
    // ONCE per idle entry. Sits BEFORE the C1 glow gate so it stays live even during the boot bloom and
    // independent of the glow's readiness; reduced motion is handled inside the beat (the single opt-out).
    this.updateIdleAttract()
    // C1 · heartbeat coherence — drive the ambient PLAY-glow halo off the shared clock (unchanged).
    if (!this.playGlowLive || !this.playGlow || this.prefersReducedMotion()) return
    const a = heartbeat.amp()
    // ~0.22 rest → ~0.4 peak alpha + a ≤1.04× swell, matching the retired independent yoyo's range.
    this.playGlow.setAlpha(0.22 + a * 0.18)
    this.playGlow.setScale(this.playGlowBaseSX * (1 + a * 0.04), this.playGlowBaseSY * (1 + a * 0.04))
  }

  /**
   * C4 · idle-attract edge detector. `quality.idle()` flips true after 6s of no input and clears on the
   * next input (via `quality.noteActivity()`), so a rising edge (`idle && !wasIdle`) fires the attract
   * beat EXACTLY once per idle entry; tracking the raw flag re-arms it automatically only after activity.
   * No reduced-motion check here — `playIdleBeat` is the single opt-out point, so the edge stays honest.
   */
  private updateIdleAttract(): void {
    const idle = quality.idle()
    if (idle && !this.wasIdle) this.playIdleBeat()
    this.wasIdle = idle
  }

  /**
   * H3 · idle attract beat: a soft one-shot invitation (NOT a loop). (1) PLAY gives ONE slightly-larger
   * "come play" pulse — its steady breathe is paused, nudged, then resumed from the same scale (the yoyo
   * returns to the paused value, so the hand-back is seamless). (2) A single card-suit glyph ghosts across
   * behind the hero, then rests (fades in on entry, out on exit, self-destroys). Reduced motion (§E8) → no
   * beat at all. The ghost sprite is governor-capped (dropped on the low tier), leaving just the free
   * transform pulse on the busiest devices; each fire is a lone transient, so it can never stack.
   */
  private playIdleBeat(): void {
    if (this.prefersReducedMotion()) return
    // (1) PLAY "come play" pulse — a pure transform (no fill cost). Pause the steady breathe, pulse a hair
    // larger than its 1.04 rest, then resume; both container + breathe are absent under reduced motion but
    // we've already returned there, and the `?.` keeps a normal-entry-without-breathe path safe too.
    const play = this.playButton
    if (play) {
      this.playBreathe?.pause()
      this.tweens.add({
        targets: play,
        scale: 1.09,
        duration: 300,
        yoyo: true,
        ease: 'Sine.easeInOut',
        onComplete: () => this.playBreathe?.resume(),
      })
    }
    // (2) Single suit-glyph ghost drifting behind the hero. Governor-capped: `quality.count(1)` rounds to 0
    // on the low tier → the sprite is dropped (the pulse alone carries the beat). A RED suit (heart or
    // diamond) so the faint ghost reads on all 4 themes — a black club/spade would vanish on the dark ones.
    if (quality.count(1) < 1) return
    const cx = this.heroEmblem?.x ?? DESIGN_W / 2
    const cy = this.heroEmblem?.y ?? 330
    const suit = Math.random() < 0.5 ? 'suitHeart' : 'suitDiamond'
    const dir = Math.random() < 0.5 ? 1 : -1 // drift left→right or right→left, for a touch of variety
    const span = 220
    // Depth −10: above the whole backdrop stack (proscenium −28) yet behind the hero (depth 0).
    const ghost = this.add
      .image(cx - dir * span, cy, suit)
      .setDepth(-10)
      .setDisplaySize(240, 240)
      .setAngle(-8)
      .setAlpha(0)
    // Slow, ghostly drift across the hero; alpha fades in over the entry then out over the exit (yoyo at
    // half the drift time). The sprite destroys itself once it rests — one transient object, never a loop.
    this.tweens.add({ targets: ghost, x: cx + dir * span, duration: 2600, ease: 'Sine.easeInOut' })
    this.tweens.add({
      targets: ghost,
      alpha: 0.16,
      duration: 1300,
      yoyo: true,
      ease: 'Sine.easeInOut',
      onComplete: () => ghost.destroy(),
    })
  }

  /**
   * §E9 — wire the discoverable secret note onto the heart emblem. Two intentionally-hidden
   * gestures open it: a long-press (~620ms) OR four quick taps. Deliberately no hand cursor and no
   * on-screen hint — only someone who lingers on the heart finds it.
   */
  private wireSecretNote(heart: Phaser.GameObjects.Image): void {
    heart.setInteractive({ useHandCursor: false })
    let pressTimer: Phaser.Time.TimerEvent | null = null
    let taps = 0
    let tapWindow: Phaser.Time.TimerEvent | null = null
    const trigger = (): void => {
      pressTimer?.remove(false)
      pressTimer = null
      taps = 0
      this.openSecretNote()
    }
    heart.on('pointerdown', () => {
      if (this.noteOpen) return
      pressTimer?.remove(false)
      pressTimer = this.time.delayedCall(620, trigger)
      taps += 1
      tapWindow?.remove(false)
      tapWindow = this.time.delayedCall(900, () => (taps = 0))
      if (taps >= 4) trigger()
    })
    const cancel = (): void => {
      pressTimer?.remove(false)
      pressTimer = null
    }
    heart.on('pointerup', cancel)
    heart.on('pointerout', cancel)
  }

  /**
   * The discovered heart note: a scrim + cream+gold card with a slow-BEATING heart, a heart-shower,
   * and the owner's `secretMessage` (or a tasteful generic "made with ♥" when unconfigured). Tap the
   * scrim or CLOSE to dismiss. Reduced motion: static heart + static hearts, no beat, no shower.
   */
  private openSecretNote(): void {
    if (this.noteOpen) return
    this.noteOpen = true
    sfx.uiTap()
    const reduced = this.prefersReducedMotion()
    const T = getTheme()
    const W = DESIGN_W
    const H = 1280
    const cx = W / 2
    const cy = 640
    const layer = this.add.container(0, 0).setDepth(70)

    const scrim = this.add.rectangle(cx, H / 2, W, H, T.scrim, 0.62).setInteractive()
    const close = (): void => {
      this.noteOpen = false
      layer.destroy()
    }
    scrim.on('pointerup', close)
    layer.add(scrim)

    // Cream + gold card.
    const cardW = 560
    const cardH = 620
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.28)
    g.fillRoundedRect(cx - cardW / 2 + 4, cy - cardH / 2 + 10, cardW, cardH, 34)
    g.fillStyle(T.cardFillWarm, 1)
    g.fillRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, 34)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(cx - cardW / 2, cy - cardH / 2, cardW, cardH, 34)
    layer.add(g)

    // Blocker so taps on the card don't fall through to the scrim (which closes).
    layer.add(this.add.rectangle(cx, cy, cardW, cardH, 0xffffff, 0.001).setInteractive())

    // Soft heart-glow halo behind the beating heart.
    const halo = this.add
      .image(cx, cy - 156, 'heartglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.bloom)
      .setDisplaySize(340, 340)
      .setAlpha(reduced ? 0.3 : 0.24)
    layer.add(halo)

    // Slow-BEATING heart — the intimate heartbeat (lub-dub cadence borrowed from the emblem).
    const noteHeart = this.add.image(cx, cy - 156, 'heartbig').setDisplaySize(130, 130)
    layer.add(noteHeart)
    if (!reduced) {
      const hb = noteHeart.scaleX
      this.tweens.add({ targets: noteHeart, scale: hb * 1.12, duration: 640, yoyo: true, repeat: -1, repeatDelay: 360, ease: 'Sine.easeInOut' })
      this.tweens.add({ targets: halo, alpha: 0.4, scale: halo.scaleX * 1.08, duration: 640, yoyo: true, repeat: -1, repeatDelay: 360, ease: 'Sine.easeInOut' })
    }

    // The message — owner's words, or the generic fallback.
    layer.add(
      this.add
        .text(cx, cy + 46, secretNote(), {
          fontFamily: FONT,
          fontSize: '30px',
          fontStyle: '700',
          color: T.ink,
          align: 'center',
          wordWrap: { width: cardW - 96 },
          lineSpacing: 10,
        })
        .setOrigin(0.5)
    )

    layer.add(addPillButton(this, cx, cy + cardH / 2 - 58, 220, 64, 'CLOSE', GHOST_PILL, close))

    // Heart-shower (static hearts under reduced motion).
    if (reduced) {
      const spots: Array<[number, number, number]> = [
        [-190, -80, 34],
        [196, -40, 28],
        [168, 150, 24],
        [-196, 150, 22],
      ]
      for (const [dx, dy, s] of spots) layer.add(this.add.image(cx + dx, cy + dy, 'heart').setDisplaySize(s, s).setAlpha(0.5))
    } else {
      const hearts = this.add.particles(0, 0, 'heart', {
        speed: { min: 120, max: 360 },
        angle: { min: 220, max: 320 },
        scale: { start: 0.5, end: 0.12 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 800, max: 1500 },
        gravityY: 380,
        rotate: { min: -120, max: 120 },
        emitting: false,
      })
      layer.add(hearts)
      hearts.explode(20, cx, cy - 230)
      layer.setAlpha(0)
      this.tweens.add({ targets: layer, alpha: 1, duration: 200, ease: 'Quad.easeOut' })
    }
  }

  /** §E9 special-date beat: a once-that-day heart-shower over the emblem (skipped under reduced motion). */
  private occasionShower(): void {
    sfx.starDing(2)
    if (this.prefersReducedMotion()) return
    const hearts = this.add
      .particles(0, 0, 'heart', {
        speed: { min: 130, max: 400 },
        angle: { min: 220, max: 320 },
        scale: { start: 0.55, end: 0.14 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 800, max: 1500 },
        gravityY: 420,
        rotate: { min: -120, max: 120 },
        emitting: false,
      })
      .setDepth(50)
    hearts.explode(26, DESIGN_W / 2, 300)
    this.time.delayedCall(1700, () => hearts.destroy())
  }

  /** Reduced-motion (OS query OR in-app override) — delegates to the shared theme authority (§E8). */
  private prefersReducedMotion(): boolean {
    return prefersReducedMotion()
  }
}

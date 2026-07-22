import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY, viewportCenterY, worldH } from '../config'
import { spinAvailable, todayKey } from '../core/daily'
import { endlessUnlocked } from '../core/endless'
import { PRIZE_TIERS, checkWeeklyPrize, previousWeekKey } from '../core/leaderboard'
import type { WeeklyPrizeWin } from '../core/leaderboard'
import { LEVEL_COUNT } from '../core/levels'
import { refreshLives } from '../core/lives'
import { greeting, occasionFor, pendingOccasion, secretNote, withName } from '../core/maya'
import { REFERRER_CHIPS, claimReferralRewards, fetchPendingRewards } from '../core/referrals'
import type { PendingReferralReward } from '../core/referrals'
import { claimChampionship, loadSave, markOccasionSeen, touchOpen } from '../core/save'
import { addCasinoBackdrop } from '../view/background'
import {
  addWeeklyRaceLockedModule,
  addWeeklyRaceModule,
  devRaceOpts,
  devSeedRaceLine,
  openWeeklyRacePanel,
} from '../view/leaderboardpanel'
import { addScreenGloss } from '../view/fx'
import { maybeShowInstallNudge } from '../view/installnudge'
import { addJackpotMeter } from '../view/jackpot'
import { D, E, OVERSHOOT, backOut, fadeRise, heartbeat, popIn } from '../view/motion'
import { quality } from '../view/quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from '../view/theme'
import type { Theme } from '../view/theme'
import type { ChipPill } from '../view/ui'
import {
  FONT,
  GHOST_PILL,
  GOLD_PILL,
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
  goldFace,
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

/** Dark-wash check (mirrors ui.ts's private `isDarkTheme`) — drives the celebration cards' lit accent rim. */
function darkWash(T: Theme): boolean {
  const r = ((T.washBottom >> 16) & 0xff) / 255
  const g = ((T.washBottom >> 8) & 0xff) / 255
  const b = (T.washBottom & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4
}

/** The alpha/transform surface the celebration snap-to-end restores (containers included). */
type SnapTarget = Phaser.GameObjects.Components.Transform & {
  alpha: number
  setAlpha(value?: number): unknown
}

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

  /** Guards the growth-celebration queue (coronation → friend toasts) so entries can never stack. */
  private celebrating = false

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
    // Gentle one-off nudge: a browser player (not installed) with progress + not signed in is invited to
    // save/sync before adding to the home screen (an installed iOS PWA gets its own storage). Self-guards.
    maybeShowInstallNudge(this)
    const currentLevel = Math.min(save.unlocked, LEVEL_COUNT)
    const reduced = this.prefersReducedMotion()
    // Stacked pill buttons that fade + slide up into place on entrance (see below).
    const menuButtons: Phaser.GameObjects.Container[] = []

    addCasinoBackdrop(this, 'home')
    // §F3 · ambient screen gloss — the over-screen vignette + drifting warm light-leaks (fx.ts).
    // Governor-gated inside (skipped on the low tier); static under reduced motion.
    addScreenGloss(this)

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

    // Weekly-race panel, opened directly for testing (mirrors the ?help pattern). `?race=<variant>`
    // maps to the DEV fixture boards (rich / crownyou / out / empty / loading / error); bare `?race`
    // = live data. `?raceline=<variant>` seeds the Home standings-line cache (rich / out / new).
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('race')) {
      openWeeklyRacePanel(this, devRaceOpts(new URLSearchParams(location.search).get('race')))
    }
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('raceline')) {
      devSeedRaceLine(new URLSearchParams(location.search).get('raceline'))
    }

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
    // chips and above the lives pool. A read-out here; chips are spent in the Gift Store. The
    // handle is kept so the coronation / friend-joined purses can count up into it.
    const chipPill = addChipPill(this, DESIGN_W / 2, 44)

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
    const play = addPillButton(this, DESIGN_W / 2, 720, 340, 96, 'PLAY', GOLD_PILL, () => {
      // §F2 launch bloom fires FIRST (a full-screen gold swell from the button), then the nav —
      // composing with, never replacing, the C6 shared-element focus handed to the destination.
      this.launchBloom(DESIGN_W / 2, 720, 340, 96)
      startScene(this, 'game', { level: currentLevel }, undefined, { x: DESIGN_W / 2, y: 720, w: 340, h: 96, tint: getTheme().gold })
    },
      { sheen: true }
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
    // Banked free spins → a glowing "×N FREE SPINS" badge pinned to the DAILY BONUS corner. Rides
    // INSIDE the pill container so the daily breathe carries it; the glow pulse is its own beat
    // (reduce-flashing → static soft glow; reduced motion → static badge, no pop, no pulse).
    if (save.freeSpins > 0) daily.add(this.buildFreeSpinsBadge(save.freeSpins))
    if (save.pendingBoosts.length > 0) {
      this.add
        .text(DESIGN_W / 2, 1044, `🎁 boost ready for your next level`, { fontFamily: FONT, fontSize: '20px', color: getTheme().goldText })
        .setOrigin(0.5)
    }

    // WEEKLY RACE module — the full-width ENDLESS block (replaces the v1 trophy chip). Unlocked:
    // the rose ENDLESS pill over a live, tappable standings line (leaderboardpanel owns the data +
    // panel). Locked (<30): the same silhouette dimmed to a quiet "unlocks at level 30" signpost.
    if (endlessUnlocked(save)) {
      menuButtons.push(
        addWeeklyRaceModule(this, DESIGN_W / 2, 1134, save, () => startScene(this, 'game', { endless: true }))
      )
    } else {
      menuButtons.push(addWeeklyRaceLockedModule(this, DESIGN_W / 2, 1134))
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

    // ── Growth celebrations (coronation, then friend-joined), queued AFTER the entrance settles —
    // and, on a true boot, after the whole power-on reveal has finished (never over it). The fetches
    // are dormant-safe (both resolve null/empty offline), so scheduling this is always free.
    const celebrateDelay = powerOn ? 2400 : reduced ? 300 : 800
    this.time.delayedCall(celebrateDelay, () => {
      void this.runCelebrations(chipPill, refreshLivesHud)
    })
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
   * §F2 · launch bloom — PLAY answers with a quick full-screen radial gold bloom swelling from the
   * button's own footprint: a warm `bgglow` flare that grows past the screen edges as the cream
   * fade-out takes over, plus one expanding `ring` echo of the pill itself. It COMPOSES with the
   * C6 shared-element focus (queued separately by the same tap) — the bloom is the send-off on this
   * side of the cut, the focus is the landing on the other. Both transients destroy themselves (the
   * scene stop reaps them early if the cut lands first — by then the cream fade owns the screen).
   * Gated on reduced motion AND reduce-flashing (it is a bright full-screen swell) AND the low tier.
   */
  private launchBloom(x: number, y: number, w: number, h: number): void {
    if (this.prefersReducedMotion() || reduceFlashing() || quality.tier() === 'low') return
    const T = getTheme()
    // The radial gold swell: button-footprint → past every screen edge, peaking early so most of
    // the light reads before the 180ms cream fade covers it.
    const glow = this.add
      .image(x, y, 'bgglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.gold)
      .setDisplaySize(w * 1.4, h * 2.4)
      .setAlpha(0)
      .setDepth(120)
    this.tweens.add({
      targets: glow,
      displayWidth: 2400,
      displayHeight: 2400,
      duration: 320,
      ease: 'Sine.easeOut',
      onComplete: () => glow.destroy(),
    })
    // Fast attack + short hold: the bloom has to peak inside the clear first beats of the cream
    // fade-out, before the deepening cream washes the light away.
    this.tweens.add({ targets: glow, alpha: 0.55, duration: 90, yoyo: true, hold: 60, ease: 'Quad.easeOut' })
    // A single bright ring echo of the pill, expanding + fading — the "shockwave" of the launch.
    const ring = this.add
      .image(x, y, 'ring')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.goldBright)
      .setDisplaySize(w, h)
      .setAlpha(0.7)
      .setDepth(120)
    this.tweens.add({
      targets: ring,
      displayWidth: w * 4.4,
      displayHeight: h * 4.4,
      alpha: 0,
      duration: 300,
      ease: 'Sine.easeOut',
      onComplete: () => ring.destroy(),
    })
  }

  /**
   * Growth-celebration queue: CORONATION first (the fat weekly-champion moment), then up to two
   * FRIEND-JOINED toasts — strictly one at a time, never stacked, never over the power-on (the
   * caller delays past it). Every data call is dormant-safe (null/empty offline), and a scene
   * shutdown mid-queue simply stops the chain (`alive`). DEV: `?coronation` / `?friend[=n]`
   * substitute deterministic fixtures for the network checks (mirrors the `?race` pattern).
   */
  private async runCelebrations(pill: ChipPill, refreshLives: () => void): Promise<void> {
    if (this.celebrating) return
    this.celebrating = true
    const alive = { on: true }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      alive.on = false
    })
    try {
      const q = import.meta.env.DEV ? new URLSearchParams(location.search) : null
      // 1 · CORONATION — did the player win an unclaimed prize for the most recently closed week?
      let win: WeeklyPrizeWin | null = null
      if (q?.has('coronation')) {
        win = { week: previousWeekKey(), rank: 1, score: 9840, tier: PRIZE_TIERS[0] }
      } else {
        win = await checkWeeklyPrize(loadSave().championWeeks)
      }
      if (!alive.on) return
      if (win) await this.openCoronation(win, pill)
      if (!alive.on) return
      // 2 · FRIEND-JOINED — referrer rewards, one toast each, max 2 per visit (the rest keep).
      let rewards: Array<PendingReferralReward | null>
      if (q?.has('friend')) {
        rewards = new Array<null>(Math.min(2, Math.max(1, Number(q.get('friend') ?? '1') || 1))).fill(null)
      } else {
        rewards = (await fetchPendingRewards()).slice(0, 2)
      }
      for (const reward of rewards) {
        if (!alive.on) return
        await this.openFriendToast(reward, pill, refreshLives)
      }
    } finally {
      this.celebrating = false
    }
  }

  /**
   * The CORONATION — Signature growth moment: scrim, a crown descending onto a marquee-grade
   * "WEEKLY CHAMPION" card with a gold burst, governor-scaled heart+chip confetti, and the purse
   * counting up before it lands in the chip pill. THEN the claim (save.claimChampionship) — so a
   * crash mid-ceremony re-offers the crown, and the once-per-week latch makes any double call inert.
   *
   * Tap once mid-sequence → snap to the finished card (the award still happens, immediately); tap
   * again → dismiss. Reduced motion: the finished card appears at rest, the award is instant, one
   * tap dismisses. reduceFlashing: no bright burst/flash — a slow soft halo swell instead.
   */
  private openCoronation(win: WeeklyPrizeWin, pill: ChipPill): Promise<void> {
    return new Promise(resolve => {
      const reduced = this.prefersReducedMotion()
      const calmFlash = reduceFlashing()
      const fancy = !reduced && quality.tier() !== 'low'
      const T = getTheme()
      const cx = DESIGN_W / 2
      const cy = 640
      const layer = this.add.container(0, 0).setDepth(80)
      layer.once(Phaser.GameObjects.Events.DESTROY, () => resolve())

      // ── Snap bookkeeping: every animated object is registered at its RESTING pose first ──
      const rest: Array<{ o: SnapTarget; y: number; alpha: number; scale: number }> = []
      const reg = <Tp extends SnapTarget>(o: Tp): Tp => {
        rest.push({ o, y: o.y, alpha: o.alpha, scale: o.scaleX })
        return o
      }
      const timers: Phaser.Time.TimerEvent[] = []
      const later = (ms: number, fn: () => void): void => {
        timers.push(this.time.delayedCall(ms, fn))
      }
      const transients: Phaser.GameObjects.GameObject[] = []

      // Exactly-once award. The count-up landing fires it; tap-to-skip fires it early; the save's
      // per-week championWeeks latch makes even a raced second call a no-op.
      let awarded = false
      const award = (): void => {
        if (awarded) return
        awarded = true
        const balance = claimChampionship(win.week, win.tier.chips)
        if (balance !== null) pill.update(balance)
      }

      // ── Build the finished scene first (rest pose), then wind it back for the entrance ──
      const scrim = this.add.rectangle(cx, viewportCenterY(), DESIGN_W, worldH(), T.scrim, 0.68).setInteractive()
      layer.add(scrim)

      const cardRoot = this.add.container(cx, cy)
      layer.add(cardRoot)
      reg(cardRoot)
      const cardW = 560
      const cardH = 620
      const g = this.add.graphics()
      for (let i = 3; i >= 1; i--) {
        g.fillStyle(T.shadow, 0.1)
        g.fillRoundedRect(-cardW / 2, -cardH / 2 + i * 3, cardW, cardH, 34)
      }
      g.fillStyle(T.cardFill, 1)
      g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 34)
      g.lineStyle(4, T.goldBezel, 1)
      g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 34)
      if (darkWash(T)) {
        g.fillStyle(T.accent, 0.85)
        g.fillRoundedRect(-cardW / 2 + 34, -cardH / 2 + 3, cardW - 68, 2, 1)
      }
      cardRoot.add(g)

      // Marquee bulb row along the card's top — the "sign" dressing the title deserves.
      const bulbs: Phaser.GameObjects.Image[] = []
      for (let i = 0; i < 11; i++) {
        const bx = -230 + (460 * i) / 10
        const bulb = this.add
          .image(bx, -cardH / 2 + 42, 'bulb')
          .setDisplaySize(13, 13)
          .setTint(i % 2 === 0 ? T.gold : T.accent)
          .setAlpha(0.62)
        cardRoot.add(bulb)
        bulbs.push(reg(bulb))
      }

      // Crown zone: soft gold halo + the crown itself (it DESCENDS in with the gold burst).
      const halo = this.add
        .image(0, -160, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(T.gold)
        .setDisplaySize(360, 300)
        .setAlpha(0.22)
      cardRoot.add(reg(halo))
      const crown = this.add.text(0, -160, '👑', { fontFamily: 'sans-serif', fontSize: '116px' }).setOrigin(0.5)
      cardRoot.add(reg(crown))

      // Marquee-grade title banner — the canonical real-metal gold face carrying tier.title.
      const banner = this.add.container(0, 0)
      const bg = this.add.graphics()
      bg.fillStyle(T.shadow, 0.14)
      bg.fillRoundedRect(-240, -42 + 5, 480, 84, 20)
      goldFace(bg, -240, -42, 480, 84, T, 20)
      bg.lineStyle(3, T.goldDeep, 1)
      bg.strokeRoundedRect(-240, -42, 480, 84, 20)
      banner.add(bg)
      const title = this.add
        .text(0, 0, win.tier.title, { fontFamily: FONT, fontSize: '38px', fontStyle: '900', color: T.goldPillText })
        .setOrigin(0.5)
        .setLetterSpacing(2)
        .setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      banner.add(title)
      // Fit long future tier titles inside the banner (PODIUM / TOP 10 stay big).
      if (title.width > 440) title.setScale(440 / title.width)
      cardRoot.add(reg(banner))

      const scoreLine = this.add
        .text(0, 66, `your winning run  ·  ${win.score.toLocaleString()}`, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '22px',
          color: T.inkMuted,
        })
        .setOrigin(0.5)
      cardRoot.add(reg(scoreLine))

      // The purse row — chip token + the count-up number.
      const purse = this.add.container(0, 146)
      const purseChip = this.add.image(0, 0, 'chip').setDisplaySize(46, 46)
      const purseFinal = `+${win.tier.chips.toLocaleString()}`
      const purseText = this.add
        .text(0, 1, purseFinal, { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: T.goldText })
        .setOrigin(0, 0.5)
        .setShadow(0, 2, 'rgba(0,0,0,0.12)', 3, false, true)
      // Centre chip + number as one unit around x=0.
      const purseW = 46 + 14 + purseText.width
      purseChip.setX(-purseW / 2 + 23)
      purseText.setX(purseChip.x + 23 + 14)
      purse.add([purseChip, purseText])
      cardRoot.add(reg(purse))
      const purseSub = this.add
        .text(0, 198, 'CHIPS · added to your balance', {
          fontFamily: 'Arial, sans-serif',
          fontSize: '19px',
          color: T.inkFaint,
        })
        .setOrigin(0.5)
      cardRoot.add(reg(purseSub))

      const hint = this.add
        .text(0, cardH / 2 - 44, 'tap to continue', { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: T.inkFaint })
        .setOrigin(0.5)
        .setLetterSpacing(1)
      cardRoot.add(hint) // NOT registered — its rest during play is hidden; snap/end shows it

      // ── The gold burst on crown landing (reduceFlashing → the soft halo swell only) ──
      const burst = (): void => {
        sfx.jackpotStrike()
        if (!reduced) {
          // The halo swells warm at the landing on EVERY motion path (soft, not a flash).
          this.tweens.add({ targets: halo, alpha: 0.4, duration: calmFlash ? 620 : 220, yoyo: true, ease: E.hero })
        }
        if (fancy && !calmFlash) {
          const ring = this.add
            .image(cx, cy - 160, 'ring')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setTint(T.goldBright)
            .setDisplaySize(90, 90)
            .setAlpha(0.85)
          layer.add(ring)
          transients.push(ring)
          this.tweens.add({
            targets: ring,
            displayWidth: 420,
            displayHeight: 420,
            alpha: 0,
            duration: 420,
            ease: E.settle,
            onComplete: () => ring.destroy(),
          })
          const sparks = this.add.particles(0, 0, 'spark', {
            speed: { min: 180, max: 520 },
            scale: { start: 0.9, end: 0 },
            alpha: { start: 1, end: 0 },
            lifespan: { min: 350, max: 700 },
            blendMode: Phaser.BlendModes.ADD,
            tint: T.goldBright,
            emitting: false,
          })
          layer.add(sparks)
          transients.push(sparks)
          sparks.explode(quality.count(18), cx, cy - 160)
        }
        // Heart + chip confetti — celebration, not luminance: plays under reduceFlashing too.
        if (fancy) {
          for (const tex of ['heart', 'chip'] as const) {
            const p = this.add.particles(0, 0, tex, {
              speed: { min: 170, max: 470 },
              angle: { min: 230, max: 310 },
              scale: { start: tex === 'chip' ? 0.5 : 0.55, end: 0.1 },
              alpha: { start: 1, end: 0 },
              lifespan: { min: 900, max: 1600 },
              gravityY: 520,
              rotate: { min: -180, max: 180 },
              emitting: false,
            })
            layer.add(p)
            transients.push(p)
            p.explode(quality.count(14), cx, cy - 220)
          }
        }
      }

      // Purse count-up → the award. A plain counter object tween; snap kills it via `counter`.
      const counter = { v: 0 }
      const countUp = (): void => {
        sfx.coinCount()
        this.tweens.add({
          targets: counter,
          v: win.tier.chips,
          duration: 700,
          ease: 'Cubic.easeOut',
          onUpdate: () => purseText.setText(`+${Math.round(counter.v).toLocaleString()}`),
          onComplete: () => {
            purseText.setText(purseFinal)
            award()
            // A few chips arc up into the chip pill as the balance lands (pure garnish).
            if (fancy) {
              for (let i = 0; i < 3; i++) {
                const fly = this.add.image(cx + (i - 1) * 44, cy + 146, 'chip').setDisplaySize(34, 34).setDepth(81)
                transients.push(fly)
                this.tweens.add({
                  targets: fly,
                  x: cx,
                  y: 44,
                  displayWidth: 20,
                  displayHeight: 20,
                  alpha: 0.9,
                  duration: 520,
                  delay: i * 80,
                  ease: E.glide,
                  onComplete: () => fly.destroy(),
                })
              }
            }
          },
        })
      }

      // ── Phase machine: playing → rest → (dismiss) ──
      let phase: 'playing' | 'rest' | 'gone' = 'playing'
      const stopAll = (): void => {
        for (const t of timers) t.remove(false)
        timers.length = 0
        this.tweens.killTweensOf(counter)
        this.tweens.killTweensOf(scrim)
        this.tweens.killTweensOf(hint)
        for (const r of rest) this.tweens.killTweensOf(r.o)
        for (const tr of transients) {
          this.tweens.killTweensOf(tr)
          tr.destroy()
        }
        transients.length = 0
      }
      const snapToEnd = (): void => {
        if (phase !== 'playing') return
        phase = 'rest'
        stopAll()
        for (const r of rest) {
          r.o.setY(r.y)
          r.o.setAlpha(r.alpha)
          r.o.setScale(r.scale)
        }
        cardRoot.setX(cx) // x never animates, but be exact
        scrim.setAlpha(0.68)
        purseText.setText(purseFinal)
        hint.setAlpha(1)
        award()
      }
      const dismiss = (): void => {
        if (phase === 'gone') return
        phase = 'gone'
        stopAll()
        award() // belt & braces — the latch makes this free when already fired
        sfx.whoosh()
        if (reduced) {
          layer.destroy() // DESTROY hook resolves
          return
        }
        this.tweens.add({ targets: layer, alpha: 0, duration: 180, ease: E.exit, onComplete: () => layer.destroy() })
      }
      scrim.on('pointerup', () => {
        if (phase === 'playing') snapToEnd()
        else dismiss()
      })

      // ── Entrance choreography (reduced motion: everything already rests; claim instantly) ──
      if (reduced) {
        phase = 'rest'
        hint.setAlpha(1)
        award()
        return
      }
      sfx.winFanfare()
      hint.setAlpha(0)
      scrim.setAlpha(0)
      this.tweens.add({ targets: scrim, alpha: 0.68, duration: D.settle, ease: E.settle })
      cardRoot.setAlpha(0)
      this.tweens.add({ targets: cardRoot, alpha: 1, duration: D.base, delay: 60, ease: E.settle })
      popIn(this, cardRoot, { from: 0.88, delay: 60, duration: D.pop, overshoot: OVERSHOOT.gentle })
      // The crown starts high above the card and drops onto its halo with the big overshoot.
      crown.setY(-430).setAlpha(0)
      this.tweens.add({ targets: crown, alpha: 1, duration: 200, delay: 360, ease: E.settle })
      this.tweens.add({ targets: crown, y: -160, duration: 560, delay: 360, ease: backOut(OVERSHOOT.pop) })
      halo.setAlpha(0)
      this.tweens.add({ targets: halo, alpha: 0.22, duration: 320, delay: 420, ease: E.settle })
      later(920, burst)
      // Bulbs cascade-light left→right behind the title reveal.
      bulbs.forEach((b, i) => {
        b.setAlpha(0.12)
        this.tweens.add({ targets: b, alpha: 0.62, duration: 220, delay: 640 + i * 45, ease: E.settle })
      })
      fadeRise(this, banner, { rise: 14, delay: 560, duration: D.settle })
      fadeRise(this, scoreLine, { delay: 700 })
      purseText.setText('+0')
      fadeRise(this, purse, { delay: 820 })
      fadeRise(this, purseSub, { delay: 880 })
      later(1250, countUp)
      this.tweens.add({ targets: hint, alpha: 1, duration: 300, delay: 2500, ease: E.settle })
      later(2600, () => {
        if (phase === 'playing') phase = 'rest'
      })
    })
  }

  /**
   * FRIEND-JOINED toast — the coronation's smaller sibling for the referrer's reward moment:
   * scrim + compact cream card, a beating heart, a mini heart shower, then the claim lands
   * (+REFERRER_CHIPS into the pill, hearts refilled — the lives HUD pops the pips itself).
   * `reward === null` is the DEV fixture path (no cloud claim). Auto-dismisses; tap dismisses.
   * NOTE: the referrals schema deliberately carries no referee display name (privacy — see
   * migration 0004), so the live copy celebrates "a friend" rather than a name.
   */
  private openFriendToast(
    reward: PendingReferralReward | null,
    pill: ChipPill,
    refreshLives: () => void
  ): Promise<void> {
    return new Promise(resolve => {
      const reduced = this.prefersReducedMotion()
      const fancy = !reduced && quality.tier() !== 'low'
      const T = getTheme()
      const cx = DESIGN_W / 2
      const cy = 540
      const layer = this.add.container(0, 0).setDepth(78)
      let alive = true
      layer.once(Phaser.GameObjects.Events.DESTROY, () => {
        alive = false
        resolve()
      })

      const scrim = this.add.rectangle(cx, viewportCenterY(), DESIGN_W, worldH(), T.scrim, 0.42).setInteractive()
      layer.add(scrim)

      const cardRoot = this.add.container(cx, cy)
      layer.add(cardRoot)
      const cardW = 520
      const cardH = 300
      const g = this.add.graphics()
      for (let i = 2; i >= 1; i--) {
        g.fillStyle(T.shadow, 0.1)
        g.fillRoundedRect(-cardW / 2, -cardH / 2 + i * 3, cardW, cardH, 30)
      }
      g.fillStyle(T.cardFillWarm, 1)
      g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 30)
      g.lineStyle(4, T.goldBezel, 1)
      g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 30)
      if (darkWash(T)) {
        g.fillStyle(T.accent, 0.85)
        g.fillRoundedRect(-cardW / 2 + 30, -cardH / 2 + 3, cardW - 60, 2, 1)
      }
      cardRoot.add(g)

      const haloGlow = this.add
        .image(0, -66, 'heartglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(T.bloom)
        .setDisplaySize(220, 220)
        .setAlpha(0.26)
      cardRoot.add(haloGlow)
      const heart = this.add.image(0, -66, 'heartbig').setDisplaySize(84, 84)
      cardRoot.add(heart)
      cardRoot.add(
        this.add
          .text(0, 22, 'A FRIEND JOINED THE GAME!', {
            fontFamily: FONT,
            fontSize: '27px',
            fontStyle: '900',
            color: T.ink,
            align: 'center',
            wordWrap: { width: cardW - 70 },
          })
          .setOrigin(0.5)
          .setLetterSpacing(1)
      )
      cardRoot.add(
        this.add
          .text(0, 72, `+${REFERRER_CHIPS} chips  ·  full hearts`, {
            fontFamily: FONT,
            fontSize: '23px',
            fontStyle: '900',
            color: T.goldText,
          })
          .setOrigin(0.5)
      )

      let gone = false
      const dismiss = (): void => {
        if (gone) return
        gone = true
        this.tweens.killTweensOf([cardRoot, heart, haloGlow, scrim])
        sfx.whoosh()
        if (reduced) {
          layer.destroy()
          return
        }
        this.tweens.add({ targets: layer, alpha: 0, duration: 160, ease: E.exit, onComplete: () => layer.destroy() })
      }
      scrim.on('pointerup', dismiss)

      // The claim happens mid-toast (celebrate → claim): stamp the row, then land chips + hearts.
      // Fixture path (null) only re-pops the pill so captures show the beat without a fake grant.
      this.time.delayedCall(reduced ? 100 : 700, () => {
        if (reward === null) {
          if (alive) {
            pill.update(loadSave().chips)
            refreshLives()
          }
          return
        }
        void claimReferralRewards([reward]).then(res => {
          if (!alive || res.chips === null) return // grant is safely in the save either way
          pill.update(res.chips)
          refreshLives() // full hearts → the lives HUD pops the freshly-filled pips
        })
      })

      // Entrance + life: pop the card, beat the heart, shower a few hearts. Reduced → static card.
      if (!reduced) {
        sfx.lifeRestored()
        scrim.setAlpha(0)
        this.tweens.add({ targets: scrim, alpha: 0.42, duration: D.base, ease: E.settle })
        cardRoot.setAlpha(0)
        this.tweens.add({ targets: cardRoot, alpha: 1, duration: D.base, ease: E.settle })
        popIn(this, cardRoot, { from: 0.9, duration: D.pop, overshoot: OVERSHOOT.gentle })
        popIn(this, heart, { from: 0.4, delay: 140, overshoot: OVERSHOOT.pop })
        const hb = heart.scaleX
        this.tweens.add({
          targets: heart,
          scale: hb * 1.1,
          duration: 640,
          delay: D.pop + 200,
          yoyo: true,
          repeat: -1,
          repeatDelay: 360,
          ease: E.hero,
        })
        this.tweens.add({ targets: haloGlow, alpha: 0.4, duration: 640, delay: D.pop + 200, yoyo: true, repeat: -1, repeatDelay: 360, ease: E.hero })
        if (fancy) {
          const hearts = this.add.particles(0, 0, 'heart', {
            speed: { min: 120, max: 340 },
            angle: { min: 230, max: 310 },
            scale: { start: 0.45, end: 0.1 },
            alpha: { start: 1, end: 0 },
            lifespan: { min: 700, max: 1300 },
            gravityY: 420,
            rotate: { min: -120, max: 120 },
            emitting: false,
          })
          layer.add(hearts)
          hearts.explode(quality.count(12), cx, cy - 120)
        }
      }
      // Auto-dismiss keeps the queue moving (a tap gets there sooner).
      this.time.delayedCall(reduced ? 2200 : 3400, dismiss)
    })
  }

  /**
   * Glowing "×N FREE SPINS" badge for the DAILY BONUS pill's corner — banked wheel spins waiting.
   * A rose tab (rose = the "special" accent, distinct on the gold pill) with a soft gold glow:
   * pulse gated by reduceFlashing (static soft glow) and reduced motion (static badge, no pop).
   */
  private buildFreeSpinsBadge(n: number): Phaser.GameObjects.Container {
    const T = getTheme()
    const reduced = this.prefersReducedMotion()
    const c = this.add.container(140, -40)
    c.setAngle(-6)
    const label = this.add
      .text(0, 0, `×${n} FREE SPINS`, { fontFamily: FONT, fontSize: '17px', fontStyle: '900', color: T.onRose })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    const w = label.width + 28
    const h = 34
    if (this.textures.exists('bgglow')) {
      const glow = this.add
        .image(0, 0, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(T.goldBright)
        .setDisplaySize(w * 1.9, h * 3.2)
        .setAlpha(0.3)
      c.add(glow)
      if (!reduced && !reduceFlashing()) {
        this.tweens.add({ targets: glow, alpha: 0.5, duration: 900, yoyo: true, repeat: -1, ease: E.hero })
      }
    }
    const g = this.add.graphics()
    g.fillStyle(T.roseDeep, 1)
    g.fillRoundedRect(-w / 2, -h / 2 + 2.5, w, h, h / 2)
    g.fillStyle(T.rose, 1)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.fillStyle(T.roseLight, 0.45)
    g.fillRoundedRect(-w / 2 + 5, -h / 2 + 3, w - 10, h * 0.42, h * 0.21)
    g.lineStyle(2, T.goldBezel, 1)
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    c.add([g, label])
    // Announce with a late pop (after the menu stagger has landed); reduced → already at rest.
    popIn(this, c, { from: 0.5, delay: 900, overshoot: OVERSHOOT.pop })
    return c
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
    const cx = W / 2
    const cy = 640
    const layer = this.add.container(0, 0).setDepth(70)

    const scrim = this.add.rectangle(cx, viewportCenterY(), W, worldH(), T.scrim, 0.62).setInteractive()
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

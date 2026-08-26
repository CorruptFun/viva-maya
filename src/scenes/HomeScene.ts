import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, restScrollY, viewportCenterY, worldH } from '../config'
import { claimBonusDrop, dropForDay } from '../core/bonusdrop'
import { hasAnySpin, spinAvailable, todayKey } from '../core/daily'
import {
  DAYS_PER_WEEK,
  dayKey,
  endlessUnlocked,
  endlessWeekStanding,
  previousDayKey,
  previousWeekKey,
  weekKey,
  weekKeyOfDay,
} from '../core/endless'
import { pushOfferDue } from '../core/push'
import {
  DAILY_PRIZE_TIERS,
  PRIZE_TIERS,
  chaseCopy,
  checkDailyPrize,
  checkWeeklyPrize,
  fetchLevelNeighbours,
  fetchRaceRecap,
  saveChaseSnapshot,
} from '../core/leaderboard'
import type { RacePrizeWin, RaceRecap } from '../core/leaderboard'
import { ACT1_LEVELS, LEVEL_COUNT } from '../core/levels'
import { DIFFICULTY } from '../core/difficulty'
import { refreshLives } from '../core/lives'
import { greeting, occasionFor, pendingOccasion, secretNote, withName } from '../core/maya'
import { REFERRER_CHIPS, claimReferralRewards, fetchPendingRewards } from '../core/referrals'
import type { PendingReferralReward } from '../core/referrals'
import { claimChampionship, claimDailyWin, loadSave, markOccasionSeen, markRaceRecapSeen, touchOpen } from '../core/save'
import { EVENTS, track } from '../core/analytics'
import { CHAPTER_BOOSTS, CHAPTER_PURSES, claimChapterCatchUp, trophyFor, unclaimedChapters } from '../core/trophies'
import type { ChapterCatchUp } from '../core/trophies'
import { openTrophyCatchUpCard } from '../view/trophyceremony'
import { openShowroom } from '../view/showroom'
import { addCasinoBackdrop } from '../view/background'
import {
  ENDLESS_HERO_H,
  addEndlessHero,
  devLevelOpts,
  devRaceOpts,
  devSeedRaceLine,
  openLevelRacePanel,
  openRacePanel,
  openRaceRulesPanel,
} from '../view/leaderboardpanel'
import { addScreenGloss } from '../view/fx'
import { installNudgeOpen, maybeShowInstallNudge } from '../view/installnudge'
import { maybeShowInstallOffer } from '../view/installsheet'
import { claimInstallReward, onInstallStateChange } from '../core/install'
import { openStash, stashBadgeCount } from '../view/stash'
import { LIVE_CARD_H, addLiveCard, pickLiveNow } from '../view/livecard'
import type { LiveCtx } from '../view/livecard'
import { openFreeSpinCard } from '../view/freespincard'
import { openRaceUnlockCard } from '../view/raceunlockcard'
import { openBonusDropCard } from '../view/bonusdropcard'
import { openPushOptIn } from '../view/pushoptin'
import { openInstallRewardCard } from '../view/installrewardcard'
import { openAct2Card } from '../view/act2card'
import { addJackpotMeter } from '../view/jackpot'
import { D, E, OVERSHOOT, backOut, fadeRise, heartbeat, popIn } from '../view/motion'
import { quality } from '../view/quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from '../view/theme'
import type { Theme } from '../view/theme'
import { addCharmChip, openCharmAlbum } from '../view/charmalbum'
import type { ChipPill } from '../view/ui'
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
  addPressablePlate,
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

/**
 * ── Home's vertical band, budgeted in one place ──────────────────────────────
 *
 * Home is a HIERARCHY now, not a stack of equals. It used to carry six gold pills at near-equal
 * weight (PLAY, LEVELS, GIFT STORE, LUCKY SLOTS, ENDLESS and the streak) over five simultaneous
 * notices, and when everything is urgent nothing is: there was no first place for the eye to land.
 * So there is ONE dominant PLAY carrying the level number on its face, ONE rose ENDLESS hero under
 * it (the game's second mode, back at first-class weight — owner call 2026-08-26, and rose so the
 * gold stays PLAY's alone), a badged icon rail for everything else, and at most ONE "what's live
 * now" card (view/livecard.ts owns the ranking).
 *
 * The seats used to be a dozen unrelated literals with the arithmetic that kept them apart living
 * only in comments — the exact shape of bug that landed LevelSelect's stash door on its leaderboard
 * marquee with one pixel to spare. So the seats are named here and the band below the hero is
 * DERIVED from them. Move a seat and the band follows; add anything up here and budget it against
 * these numbers rather than against a fresh literal.
 *
 *   utility chips   44 · help · settings · CHIPS · charms · theme · sound      (unchanged)
 *   lives HUD      100 · hearts 84–116, "next life" countdown 120–140          (unchanged)
 *   greeting       162 · 150–174 — a clear 10px under the countdown
 *   hero emblem    274 · 168² → 190–358 (the drifting satellites reach 368)
 *   marquee        434 · bulbs 382–398, VIVA·MAYA 405–469
 *   tagline        494 · 482–506
 *   jackpot meter  552 · 540–564
 *   PLAY           681 · 460×150 → cap 606–756, a 42px gap under the meter
 *   the band       780 → 1210 · whatever survives the progressive reveal, centred inside it
 *
 * ⚠️ The dead band is closed by a MOVE, not by squeezing. The streak flame used to sit at 176,
 * between the lives countdown and the greeting; it now rides the band under PLAY, and the ~60px it
 * vacated is exactly what let the decorative stack (emblem · wordmark · tagline · meter) come up far
 * enough to absorb PLAY growing from 340×96 to 460×150. Net: the primary action starts at 47% of
 * the design box instead of 53%, on the same 1210 floor the race module used to sit on. Nothing was
 * made smaller — the emblem is still the tuned 168² that handed the visual lead to PLAY in the
 * first place, and every gap above is the one it already had (±2px) except emblem→marquee, which
 * gives up 34 for 12 because a satellite heart and a marquee bulb are both soft decoration.
 */
const GREET_Y = 162
const EMBLEM_Y = 274
const MARQUEE_Y = 434
const TAGLINE_Y = 494
const METER_Y = 552
/**
 * PLAY — the largest thing on the screen and the only saturated face left on it. 460×150 =
 * 69,000px² against 8,320 for a rail tile (8.3×) and 43,680 for the live card (1.6×); the card is
 * wider on purpose (it carries a sentence) and gives up the height and the gold in exchange, so the
 * only control PLAY has to out-shout it is beaten many times over. It was 340×96 and 1.26× a LUCKY
 * SLOTS pill wearing the same gold, which is not a hierarchy — it is a tie.
 *
 * The level number rides the CAP. It used to be the first clause of the small line beneath, where it
 * was a caption about the player rather than a promise about what this button does.
 */
const PLAY_Y = 681
const PLAY_W = 460
const PLAY_H = 150
/** Top of the demoted band — derived off PLAY's cap so moving the hero moves everything under it. */
const STACK_TOP = PLAY_Y + PLAY_H / 2 + 24
/** The floor the race module used to sit on; the band still ends exactly here. */
const STACK_BOTTOM = 1210

/**
 * Icon-rail geometry. Five tiles is the widest it ever gets (LEVELS · STORE · SLOTS · RANKS · STASH)
 * and 5×104 + 4×18 = 592 leaves 64px of margin a side inside the 720 box. The tile is the art box
 * only: `buildPressable` grows every hit zone to ≥84 design px (≈44pt) in each axis, so a tile is
 * comfortably tappable at this size and would stay so if it shrank further.
 */
const RAIL_W = 104
const RAIL_H = 80
const RAIL_GAP = 18

/** One door on the icon rail. `onTap` absent = the tile is present but inert (the locked race). */
interface RailItem {
  /** Stable id — never shown; the caller reaches back for a tile by it (the LUCKY SLOTS knock). */
  id: string
  /** Bare emoji Text, never a pill label: addPillButton's letterSpacing splits the surrogate pair. */
  glyph: string
  label: string
  onTap?: () => void
  /**
   * The one badge this door is allowed. `text` absent = a bare DOT ("there is something here"),
   * which is all a state with no number to report ever needs.
   */
  badge?: { text?: string; gold?: boolean }
}

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
    // §11: field initializers do NOT re-run on scene.restart(), and this one is only ASSIGNED on the
    // animated path — so a restart into reduced motion (the settings panel does exactly that) would
    // otherwise leave a destroyed tween here for playIdleBeat to pause/resume.
    this.playBreathe = undefined
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
    // ── Entrance beat sheet ──────────────────────────────────────────────────────────────────────
    // The spring itself is the §V1 "pops off the screen" pass: each pill starts a little small and
    // low, overshoots past its resting spot and settles (ENTRANCE_MS), with a wide STAGGER_STEP gap
    // so the stack reads as distinct arrivals rather than one blur.
    //
    // What changed is the ORDER on a cold boot. The power-on reveal is KEPT — it is the identity
    // moment — but the primary action no longer queues behind it. v1 held the whole menu, PLAY
    // included, until the wordmark and the glow bloom had finished: measured off the live tween
    // list, PLAY landed at 1440ms (stagger base 1080 + 360) and the last module at 1744ms, on the
    // one entry per app launch where a returning player is already waiting to tap. Genre leaders are
    // tappable well under a second. So PLAY springs in on its OWN early beat and the theatre plays
    // around it:
    //   0.10s  the emblem springs up          — identity
    //   0.14s  PLAY + its halo bloom          — the primary action, fully landed by 0.50s
    //   0.42s  the marquee gold sweep + bulbs — wordmark reveal (audio swell at 0.56s)
    //   0.76s  the subordinate stack staggers in BEHIND it (last module ~1.35s)
    // Off-boot both beats collapse to the old cascade — PLAY, then the stack one step behind it —
    // so returning from a level / a settings restart is unchanged to the millisecond.
    const STAGGER_STEP = 76
    const ENTRANCE_MS = 360
    const HERO_BEAT = powerOn ? 140 : 0
    const STACK_BEAT = powerOn ? 760 : STAGGER_STEP
    const save = loadSave()
    // §E9 — stamp first/last open dates (safe: touches only those two fields). Enables future
    // "welcome back" warmth; never alters progress.
    const today = touchOpen(todayKey()).lastOpenDate ?? todayKey()
    // Two bottom-of-Home invitations, both self-guarding, and ORDER IS THE COORDINATION between them:
    // the install offer is asked first and wins the slot, because it is the one that answers "how do I
    // even do this" — measured 2026-08-03, only 5 of 60 real players were running installed, and on
    // iOS an install is the sole route to a web push, so the daily-race callback is gated behind it.
    // The older sign-in nudge (save/sync BEFORE installing, since an installed iOS PWA gets its own
    // storage) then yields while any install surface is up, so the two can never stack.
    // NB: branch on the RETURN VALUE, not on installUiOpen() — the offer mounts on a delay, so the
    // DOM is still empty here and a DOM check would let both schedule. See its doc comment.
    const offeringInstall = maybeShowInstallOffer(this)
    if (!offeringInstall) maybeShowInstallNudge(this)
    // ⚠️ Chromium fires `beforeinstallprompt` on its OWN schedule, and it routinely lands after this
    // create() has already asked `installState()` and been told 'unavailable'. When that happens the
    // banner never mounts for this visit — while main.ts has already `preventDefault()`ed the
    // browser's own install bar. Capturing the prompt and then showing nothing is strictly worse
    // than never capturing, which is the exact risk core/install.ts's header names. `onInstallState-
    // Change` was built for this and NOTHING had ever subscribed to it. Measured 2026-08-06: of 67
    // real players not installed, 14 had a prompt captured and only 4 produced any banner response.
    onInstallStateChange(() => {
      if (!this.scene.isActive()) return
      // The sign-in nudge took the slot on the first pass and sits in the identical strip; the
      // scheduled mount only knows about its own two surfaces, so this is the one check it can't do.
      if (installNudgeOpen()) return
      maybeShowInstallOffer(this)
    })
    // Single global callback slot — leaving it bound would fire against a dead scene after the
    // player starts a level.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => onInstallStateChange(null))
    const currentLevel = Math.min(save.unlocked, LEVEL_COUNT)
    const reduced = this.prefersReducedMotion()
    // ── Progressive reveal ───────────────────────────────────────────────────────────────────────
    // A destination that can do NOTHING for this player yet is DEFERRED, not shown greyed-out: on a
    // brand-new save LEVELS can only reach the level PLAY already starts, the Gift Store's cheapest
    // boost is 40 chips against a balance of 0, and the locked WEEKLY RACE plate advertises a
    // milestone 19 levels out. Same shape as the `endlessUnlocked(save)` branch further down — read
    // the save, branch once — rather than a second gating idiom.
    //
    // Deliberately the TIGHTEST gate that still clears the first screen: one finished level OR one
    // banked chip opens all three, and BOTH of those only ever grow (a level win banks chips; so
    // does the very first daily spin, via its check-in purse). So an entry can appear and can never
    // disappear again — nothing a player has ever been able to use is taken off the screen.
    const preFirstWin = save.unlocked <= 1 && save.chips === 0
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

    // CHARMS album — seated left of the look-and-feel pair and right of the chip balance, because it
    // belongs with the balance rather than with the pickers: both readouts answer "what do I own".
    // The chip pill self-sizes around its count and tops out near x=440 even at six digits, so 532
    // clears it. NOT in the stack under PLAY — that band is budgeted to the pixel (840→1210 fits the
    // full LEVELS/DAILY/RACE set exactly), so a tenth row there would push the race plate off-screen.
    // `onChanged` fires after a charm EXCHANGE (spending charms on a spin / hearts / an instant Deal).
    // A purchase can move the chip collar, the hearts pool, the free-spin badge and the chip balance
    // at once, so Home repaints wholesale rather than reaching into four widgets — the same
    // "apply by repaint, not live re-tint" rule the theme picker follows (UI_COOKBOOK §7). Deferred a
    // frame so the restart can never land while the panel that triggered it is still tearing down.
    const refreshHome = (): void => void this.time.delayedCall(0, () => this.scene.restart())
    addCharmChip(this, 532, 44, 52, { onChanged: refreshHome })
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('charms')) {
      openCharmAlbum(this, { onChanged: refreshHome })
    }

    // Weekly-race panel, opened directly for testing (mirrors the ?help pattern). `?race=<variant>`
    // maps to the DEV fixture boards (rich / crownyou / out / empty / loading / error); bare `?race`
    // = live data. `?raceline=<variant>` seeds the standings-line cache behind the ENDLESS hero's
    // sub-line (rich / out / new) — the same cache LevelSelect's strip paints from.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('race')) {
      openRacePanel(this, devRaceOpts(new URLSearchParams(location.search).get('race')))
    }
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('raceline')) {
      devSeedRaceLine(new URLSearchParams(location.search).get('raceline'))
    }
    // `?levels=<variant>` — the LEVEL RACE ladder, same fixture variants as `?race`. Separate knob
    // because the two boards render through one panel and this is what proves the mode branch.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('levels')) {
      openLevelRacePanel(this, devLevelOpts(new URLSearchParams(location.search).get('levels')))
    }
    // `?rules=<race|levels>` — the explainer behind a board's `?` chip, opened straight. Worth its own
    // knob: it is two screens deep from Home otherwise, and the two variants are exactly the pair that
    // has to be checked together whenever either one's copy or diagram moves.
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('rules')) {
      openRaceRulesPanel(this, new URLSearchParams(location.search).get('rules') === 'levels' ? 'levels' : 'daily')
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
    // The daily-spin streak flame used to sit HERE, at y=176, between the lives countdown and the
    // greeting. It now rides the band under PLAY (see the seat block at the top of this file): it is
    // one of the five notices the hierarchy pass collapsed, and it belongs next to the thing it is
    // an argument for. The badge itself is unchanged — same component, same tested copy.

    // §E9 time-of-day greeting — NAMELESS by default; the name appears ONLY when maya.showName.
    // On a configured special date it becomes the occasion greeting (the app "already knew").
    // Backdrop-drawn → routed through onBackdrop* tokens (legible on the dark themes too).
    const occToday = occasionFor(today.slice(5))
    const greetLine = occToday ? withName(occToday.label) : greeting(new Date().getHours())
    const greetText = this.add
      .text(DESIGN_W / 2, GREET_Y, greetLine, { fontFamily: FONT, fontSize: '23px', color: getTheme().onBackdropInk })
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
    //
    // 168², was 190²: at 190 the decoration was the biggest object on a screen whose PLAY cap is
    // 340×96, and it out-shouted the primary action on motion too (see HOLD_MS below). −20% of its
    // area hands the visual lead back to PLAY while the emblem stays the hero of the top band.
    const emblemY = EMBLEM_Y
    const SUITS = ['suitHeart', 'suitSpade', 'suitDiamond', 'suitClub'] as const
    const emblem = this.add.image(DESIGN_W / 2, emblemY, reduced ? 'heartbig' : SUITS[0])
    emblem.setDisplaySize(168, 168)
    this.heroEmblem = emblem // held so the C4/H3 idle suit-ghost can drift across behind it
    const base = emblem.scaleX
    let suitIdx = 0
    // Rest between shuffles. Was 200ms, which put the emblem in motion ~85% of the time (560ms beat
    // + 200 rest + 170 wind-down + 480 spring ≈ a 1.4s cycle) — a perpetual motor next to PLAY's
    // 1.04 breathe, i.e. the loudest motion on the screen belonged to decoration. At 2200 the same
    // choreography becomes a periodic flourish (~35% moving) and the eye settles back on the button.
    const HOLD_MS = 2200
    // Hold the landed suit with one gentle heartbeat, then shuffle on to the next.
    const holdBeat = (): void => {
      this.tweens.add({
        targets: emblem,
        scale: base * 1.06,
        duration: 280,
        yoyo: true,
        ease: 'Sine.easeInOut',
        onComplete: () => this.time.delayedCall(HOLD_MS, spinNext),
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
    const marquee = addMarquee(this, DESIGN_W / 2, MARQUEE_Y, { bulbs: true })
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
      .text(DESIGN_W / 2, TAGLINE_Y, 'cascades  ·  power-ups  ·  jackpots', {
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
    // 600×270 for a 460×150 cap. The old halo was 460×240 behind a 340×96 button — 1.35× its width
    // but 2.5× its height, because a short button needs a tall glow to read as lit at all. A cap half
    // again as tall does not, and keeping that ratio would have washed the jackpot meter above it.
    const glow = this.add.image(DESIGN_W / 2, PLAY_Y, 'bgglow')
    glow.setTint(getTheme().gold).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(600, 270)
    const glowSX = glow.scaleX
    const glowSY = glow.scaleY
    glow.setAlpha(reduced ? 0.28 : 0)
    // Stash the halo + its resting scale so update() can drive it once the bloom has landed.
    this.playGlow = glow
    this.playGlowBaseSX = glowSX
    this.playGlowBaseSY = glowSY
    this.playGlowLive = false
    if (!reduced) {
      // On boot the warm glow BLOOMS up (swelling from small) WITH the primary action — it used to
      // wait for the wordmark at 980ms, which is what pushed PLAY itself to the back of the queue.
      // Now it rides PLAY's own beat, a hair ahead so the light is already gathering as the cap
      // lands. On a normal entrance it just fades in alongside PLAY (unchanged). Then the shared
      // heartbeat takes over its steady breathing (see update()) — no independent yoyo.
      const bloomDelay = powerOn ? HERO_BEAT - 60 : 0
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
    //
    // Composed from `addPressablePlate` rather than `addPillButton` because the cap carries TWO
    // children — the word and the level number. `addPillButton` can only seat one centred label, and
    // its letterSpacing is also what makes an emoji render as tofu, so the plate is the house answer
    // whenever a control needs more than a single string (the stash door composes the same way).
    const { container: play, face: playFace } = addPressablePlate(
      this,
      DESIGN_W / 2,
      PLAY_Y,
      PLAY_W,
      PLAY_H,
      GOLD_PILL,
      () => {
        sfx.uiTap()
        // §F2 launch bloom fires FIRST (a full-screen gold swell from the button), then the nav —
        // composing with, never replacing, the C6 shared-element focus handed to the destination.
        this.launchBloom(DESIGN_W / 2, PLAY_Y, PLAY_W, PLAY_H)
        startScene(this, 'game', { level: currentLevel }, undefined, {
          x: DESIGN_W / 2,
          y: PLAY_Y,
          w: PLAY_W,
          h: PLAY_H,
          tint: getTheme().gold,
        })
      },
      { sheen: true }
    )
    // THE LEVEL NUMBER IS ON THE BUTTON. It used to be the first clause of the small line underneath
    // ("Level 47 · best 12,340"), where it read as a caption about the player rather than as a
    // promise about what this button does. Both texts are seated in the moving `face`, so they sink
    // with the cap. The emboss shadow is `GOLD_PILL.textColor` at 0.35 — the same struck-metal
    // treatment `addPillButton` derives and the coronation banner spells out by hand.
    playFace.add(
      this.add
        .text(0, -24, 'PLAY', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: GOLD_PILL.textColor })
        .setOrigin(0.5)
        .setLetterSpacing(2)
        .setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
    )
    playFace.add(
      this.add
        .text(0, 32, `LEVEL ${currentLevel}`, {
          fontFamily: FONT,
          fontSize: '26px',
          fontStyle: '900',
          color: GOLD_PILL.textColor,
        })
        .setOrigin(0.5)
        .setLetterSpacing(3)
        .setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
        .setAlpha(0.82)
    )
    // PLAY is deliberately NOT in `menuButtons`: it is the one primary action and it gets its own
    // early entrance beat (HERO_BEAT) rather than a slot in the subordinate stagger below.
    // Held for the C4/H3 idle attract beat — the "come play" pulse pauses this breathe, nudges, resumes.
    this.playButton = play
    // PLAY's breathe is STARTED LATER (see the entrance below). §V1 gave the entrance a real scale
    // pop, and a resting breathe on the same property would fight it — so the idle breathe is
    // deferred until the button has finished landing. Gated (§E8): reduced motion never starts it.

    // Jackpot charge meter — a compact progress read-out in the hero area (fills one notch per level
    // win). Display-only: the wheel itself explodes in-game after the win that tops the meter off.
    // §V1 spacing: was y=590, which left only ~5px between the tagline's descenders and the 24px-tall
    // track — the two read as one crowded clump while a 130px void sat below them. It keeps the 34px
    // of air it was given then; only the seat moved, with the rest of the decorative stack.
    addJackpotMeter(this, DESIGN_W / 2, METER_Y, { width: 300, compact: true }).update(save.jackpotMeter, false)

    // ── The demoted band under PLAY ──────────────────────────────────────────────────────────────
    // Rows carry no hard-coded y: whatever survives the progressive reveal is CENTRED in the fixed
    // band (STACK_TOP → STACK_BOTTOM, both derived at the top of this file). Six full-width gold
    // pills used to live down here at near-equal weight; what lives here now, top → bottom, is one
    // status line, the streak, the rose ENDLESS hero, ONE live card, and the icon rail. A short band
    // keeps its balance rather than clumping up under the primary action or stranding the survivors
    // at the bottom — the same centring the old stack used, for the same reason.
    //
    // Budget check at the fullest band (flame + card + hero all present): 26 + (18+54) + (26+88) +
    // (26+78) + (26+80) = 422 against the 430 the band holds — grow any row and re-derive this sum.
    const showBrowseRow = !preFirstWin
    /** The ENDLESS hero rides the race tile's old rule: present from the first win on, live or locked. */
    const showEndlessHero = !preFirstWin
    /** What the card would say right now — asked BEFORE the band is measured, since it may say nothing. */
    const liveCtx: LiveCtx = { save, preFirstWin, refresh: refreshHome }
    const liveNow = pickLiveNow(liveCtx)
    /** The surviving rows, top → bottom: [height, air above it]. Drives the centring below. */
    const stackRows: Array<[number, number]> = []
    stackRows.push([26, 0]) // the sub-line — best / the chase / HOT STREAK
    if (save.streak > 0) stackRows.push([54, 18]) // the streak flame
    if (showEndlessHero) stackRows.push([ENDLESS_HERO_H, 26]) // the ENDLESS hero — the second mode
    if (liveNow) stackRows.push([LIVE_CARD_H, 26]) // WHAT'S LIVE NOW — at most one, often none
    stackRows.push([RAIL_H, 26]) // the icon rail — never empty (LUCKY SLOTS is never deferred)
    const stackH = stackRows.reduce((total, [h, gap], i) => total + h + (i > 0 ? gap : 0), 0)
    let stackY = STACK_TOP + Math.round((STACK_BOTTOM - STACK_TOP - stackH) / 2)
    let stackIdx = 0
    /** Seat the next surviving row — called in the same order `stackRows` was built. */
    const seatRow = (): number => {
      const [h, gap] = stackRows[stackIdx]
      if (stackIdx > 0) stackY += gap
      stackIdx += 1
      const cy = stackY + h / 2
      stackY += h
      return cy
    }

    // PLAY's sub-line. The level number LEFT this line for the button face, so what remains is the
    // one thing it was always really for: where you stand. A live HOT STREAK rides it rather than
    // taking furniture of its own — and the wins-to-a-deal detail still lives on the win card, which
    // is where it can actually be acted on.
    const sub = save.best > 0 ? `best ${save.best.toLocaleString()}` : 'swipe to match 3'
    const hot = save.winStreak > 0 ? `${sub}  ·  HOT STREAK ${save.winStreak}` : sub
    // A repaint that lands after the scene has gone would set text on a destroyed object — the same
    // SHUTDOWN latch the reveal chain below uses, declared here because this fetch starts earlier.
    const subLineAlive = { on: true }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      subLineAlive.on = false
    })
    const subLine = this.add
      .text(DESIGN_W / 2, seatRow(), hot, { fontFamily: FONT, fontSize: '22px', color: getTheme().onBackdropMuted })
      .setOrigin(0.5)
    /**
     * THE CHASE rides this line too, and it takes the `best` segment's slot when it arrives.
     *
     * Same reasoning that put HOT STREAK here rather than in furniture of its own, one step further:
     * the band is budgeted (see the seat block at the top of this file), so there is no room on Home
     * for a strip, and this is already the one line on the screen about where you stand. `best`
     * yields rather than appends because a third clause would run this line under 700px on a long
     * handle, and between "your best score" and "someone is three levels ahead of you" only one of
     * them is a reason to press PLAY.
     *
     * Asynchronous and SILENT on failure: signed out, offline, dormant or alone on the ladder all
     * leave the line exactly as it painted. It never blanks and never shows a spinner — the chase is
     * a bonus on a line that already said something true.
     */
    void fetchLevelNeighbours().then(w => {
      if (!w || !subLineAlive.on) return
      saveChaseSnapshot(w)
      const copy = chaseCopy(w)
      track(EVENTS.CHASE_SHOWN, { gap_above: w.above[0]?.gap ?? -1, gap_below: w.below[0]?.gap ?? -1 })
      subLine.setText(save.winStreak > 0 ? `${copy.tag}  ·  HOT STREAK ${save.winStreak}` : copy.tag)
    })

    // The daily-spin streak flame, moved down from y=176 to sit with the thing it argues for. Hidden
    // at streak 0 (`addStreakBadge` returns null and the row was never budgeted). Reads as a STAKE
    // rather than a readout while today's pull is still unspent, which is the only window in which
    // the streak can be acted on — and it keeps naming the NEXT rung and its distance, which is the
    // half of the ladder that can actually bring somebody back. The card carries the same fact as a
    // full sentence when it wins the slot; this is the compact form that is always on screen.
    // And the pill DOES the thing it asks (owner call, 2026-08-26): tapping it opens the cabinet,
    // so "SPIN TODAY" is a working button, not a caption about a door two rows further down.
    if (save.streak > 0) {
      const flame = addStreakBadge(this, DESIGN_W / 2, seatRow(), save.streak, spinAvailable(save), () =>
        startScene(this, 'slots')
      )
      if (flame) menuButtons.push(flame)
    }

    // ── THE ENDLESS HERO — the second mode, said in its own name ─────────────────────────────────
    // The rose plate under PLAY: "ENDLESS" over the live standings line, tap = start a run. It
    // replaces three scattered race surfaces at once — the rail's 🏆 RACE tile (players know the
    // mode as ENDLESS, not RACE — owner call, 2026-08-26), the bottom standings strip (its line now
    // rides this plate; the PANEL moved to the rail's RANKS door), and the live card's stash/locked
    // floors. Locked it is the dimmed signpost the locked tile was; `view/leaderboardpanel.ts` owns
    // the plate so Home and the fixtures share one standings sentence.
    if (showEndlessHero) {
      menuButtons.push(
        addEndlessHero(this, DESIGN_W / 2, seatRow(), save, () => startScene(this, 'game', { endless: true }))
      )
    }

    // ── WHAT'S LIVE NOW — the one rotating card ──────────────────────────────────────────────────
    // Home used to carry five notices at once (the streak line, the ×N free-spins tab, the charm
    // collar's 0/9, the stash's "boost ready" line and the strip's "new board today"). They collapse
    // into this one slot; `view/livecard.ts` owns the ordered provider list that decides who gets it,
    // and the QUESTS INSERTION POINT is a commented line inside that list. Often there is nothing
    // live at all, and then there is no card — which is the point of a slot rather than a shelf.
    if (liveNow) menuButtons.push(addLiveCard(this, DESIGN_W / 2, seatRow(), liveNow, liveCtx))

    // ── The icon rail ────────────────────────────────────────────────────────────────────────────
    // LEVELS · GIFT STORE · LUCKY SLOTS · RANKS · THE STASH, demoted from full-width pills to
    // one row of badged doors. Every destination that was reachable before is still exactly one tap
    // away; what changed is that none of them shouts any more. (The race's RUN launcher is the one
    // exception, promoted back OUT of the rail — the ENDLESS hero above owns it now.)
    //
    // Progressive reveal is unchanged in substance: a destination that can do NOTHING for this player
    // yet is DEFERRED, not greyed out. LEVELS would open a grid whose only reachable chip is the
    // level PLAY already starts, and the store's cheapest boost costs 40 chips of a balance of 0.
    // LUCKY SLOTS is NEVER deferred — day one is exactly when the daily spin pays (it seeds the
    // streak and boosts the first level), so it is the one first-run door that can already do
    // something, and it sits in the middle of the rail because it is the one that is always there.
    const playable = hasAnySpin(save)
    const dailyDue = spinAvailable(save)
    const railItems: RailItem[] = []
    if (showBrowseRow) {
      railItems.push({ id: 'levels', glyph: '⭐', label: 'LEVELS', onTap: () => startScene(this, 'levelselect') })
      // No badge: the store sells, it does not hold anything unclaimed for the day. Referral purses
      // and chapter trophies are paid by the celebration queue below, never picked up in there.
      railItems.push({ id: 'store', glyph: '💰', label: 'STORE', onTap: () => startScene(this, 'store') })
    }
    railItems.push({
      id: 'slots',
      glyph: '🎰',
      label: 'SLOTS',
      onTap: () => startScene(this, 'slots'),
      // The count when there is one, a bare gold dot when the only thing waiting is today's pull.
      // GOLD means "free pull ready" — today's daily spin, banked spins, or both. That state used to
      // be carried by the pill's whole face going gold, which is unlearnable (it means nothing until
      // you have opened the door you are not opening); a badge is a difference you can see without
      // knowing the rule, and the card says it in words whenever it wins the slot.
      badge: save.freeSpins > 0 ? { text: String(save.freeSpins), gold: playable } : dailyDue ? { gold: true } : undefined,
    })
    // THE LEADERBOARD DOOR — the tile the 🏆 RACE tile became when launching the run moved up to the
    // ENDLESS hero. One door, one modal, every board: it opens the standings panel on its tab row
    // (TODAY / THIS WEEK / LEVELS), landing on the week — the board the days add into — for a racer,
    // and on the level ladder for a player the race hasn't opened for yet, so the door always opens
    // onto a board the player is actually on. No badge: standings hold nothing unclaimed.
    if (!preFirstWin) {
      railItems.push({
        id: 'ranks',
        glyph: '🏆',
        label: 'RANKS',
        onTap: () => openRacePanel(this, { mode: endlessUnlocked(save) ? 'weekly' : 'levels' }),
      })
    }
    // THE STASH DOOR — the ONLY stash control on Home (owner call, 2026-08-26: two stash buttons
    // was one too many, so the live card's "YOUR STASH · next level: …" provider is gone and the
    // ENDLESS hero stands where it stood). The badge carries the count; the panel behind the door
    // still NAMES what's going into the next level, which is where that sentence moved.
    //
    // ⚠️ Shown even when the stash is EMPTY, which is a deliberate break from the progressive-reveal
    // rule above. That rule defers a destination that can do NOTHING for this player yet — but an
    // empty stash is not nothing: it is the only place that says where winnings go, and the moment a
    // player most needs to know that is BEFORE they have won anything. Gated only on `preFirstWin`,
    // so a brand-new save still opens uncluttered.
    if (!preFirstWin) {
      const stashed = stashBadgeCount()
      railItems.push({
        id: 'stash',
        glyph: '🎁',
        label: 'STASH',
        onTap: () => {
          // Holding or promoting changes which boosts the next level takes, and the card, this badge
          // and PLAY's sub-line are all read from the save at build time — so a change repaints Home
          // wholesale rather than leaving three stale readouts behind. Deferred a frame (refreshHome)
          // so the restart can never land while the panel that triggered it is still tearing down.
          sfx.whoosh()
          openStash(this, { onChanged: refreshHome })
        },
        badge: stashed > 0 ? { text: String(stashed), gold: true } : undefined,
      })
    }
    const rail = this.addIconRail(seatRow(), railItems)
    menuButtons.push(rail.container)
    // The daily standings strip used to close the band here. Its LINE now rides the ENDLESS hero's
    // sub-line and its DESTINATION is the rail's RANKS door, so Home's band carries the same facts
    // one row shorter. `addDailyRaceStrip` itself lives on — LevelSelect's race module still seats
    // it, and the board's TODAY'S LEADER variant still guards against the swipe-release misfire.

    // Entrance (timings + rationale in the beat sheet at the top of create()). Reduced motion keeps
    // every button in its final alpha=1 / final-y / final-scale resting state — nothing below runs.
    /** The spring-in itself — one definition, shared by the hero beat and the stagger. */
    const springIn = (btn: Phaser.GameObjects.Container, delay: number): void => {
      const finalY = btn.y
      btn.setAlpha(0)
      btn.y = finalY + 26
      btn.setScale(0.86)
      this.tweens.add({
        targets: btn,
        y: finalY,
        alpha: 1,
        scale: 1,
        duration: ENTRANCE_MS,
        delay,
        ease: backOut(OVERSHOOT.pop),
      })
    }
    /** When a stack button has finished landing — the cue for the beat that hands off from it. */
    const landedAt = (btn: Phaser.GameObjects.Container): number =>
      STACK_BEAT + Math.max(0, menuButtons.indexOf(btn)) * STAGGER_STEP + ENTRANCE_MS
    if (!reduced) {
      springIn(play, HERO_BEAT) // the primary action leads; on boot it is fully landed at 500ms
      menuButtons.forEach((btn, i) => springIn(btn, STACK_BEAT + i * STAGGER_STEP))
      // The ONE perpetual breathe on this screen — the cookbook's "≤1 hero breathe per screen",
      // which Home was quietly breaking. Two of them (PLAY + a lit LUCKY SLOTS) is the same as
      // none: an idle pulse means "tap me", and the eye can only be sent to one place. It hands off
      // from the entrance so the two scale animations never overlap on the same target.
      this.playBreathe = this.tweens.add({
        targets: play,
        scale: 1.04,
        duration: 800,
        delay: HERO_BEAT + ENTRANCE_MS,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
      const slotsTile = rail.tiles.get('slots')
      if (playable && slotsTile) {
        // A playable machine still has to say "there's something here" — so it says it ONCE, in the
        // ARRIVAL channel rather than the idle one: a single knock a beat after it has settled (far
        // enough after that it reads as its own gesture, not entrance overshoot), then stillness.
        // What carries the state from then on is static and always legible: the gold badge against
        // its unbadged twin, the 🎰 glyph, and the card's own sentence when it wins the slot.
        // ⚠️ The cue is timed off the RAIL, not off the tile — the tiles ride inside one container
        // that springs in as a single beat, so a tile has no stagger index of its own.
        this.tweens.add({
          targets: slotsTile,
          scale: 1.05,
          duration: 260,
          delay: landedAt(rail.container) + 260,
          yoyo: true,
          ease: 'Sine.easeInOut',
        })
      }
    }

    // ── Growth celebrations (coronation, then friend-joined), queued AFTER the entrance settles —
    // and, on a true boot, after the whole power-on reveal has finished (never over it). The fetches
    // are dormant-safe (both resolve null/empty offline), so scheduling this is always free. The
    // boot wait tracks the reveal: the last module now lands at ~1350ms (was 1744), so 1900 keeps
    // the same ~150ms of quiet after it before a celebration can take the screen.
    const celebrateDelay = powerOn ? 1900 : reduced ? 300 : 800
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
    // diamond) so the faint ghost reads on every theme — a black club/spade would vanish on the dark ones.
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
   * Growth-celebration queue: CORONATIONS first — the weekly champion, then yesterday's daily
   * winner — then the RESULT RECAP for everyone who didn't win, followed by up to two FRIEND-JOINED
   * toasts. Strictly one at a time, never stacked, never over the power-on (the caller delays past
   * it). Every data call is dormant-safe (null/empty offline), and a scene shutdown mid-queue simply
   * stops the chain (`alive`). DEV: `?coronation` / `?dailywin` / `?recap` / `?friend[=n]`
   * substitute deterministic fixtures for the network checks (mirrors the `?race` pattern).
   *
   * WEEKLY BEFORE DAILY, and both can land on the same open: a Monday visit closes a season AND a
   * Sunday board. The season is the bigger moment and the one whose result the daily boards were
   * building toward, so it goes first — a 1,000-chip crown landing after a 150-chip one would read
   * as an anticlimax. They are separate ceremonies rather than a merged card because they are
   * separate prizes with separate claim latches: if the app dies between them, the unclaimed one is
   * simply re-offered on the next open.
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
      // 0 · THE INSTALL REWARD — paid on the FIRST launch of the installed app, and therefore first
      // in this queue. It is the direct, promised consequence of something the player did seconds
      // ago, and a promise kept late reads as a promise broken: the install banner said the prize
      // would be waiting when they opened it, so it cannot queue behind a coronation. Granted
      // award-first inside `claimInstallReward` (iron rule 4), which also owns the standalone and
      // already-claimed checks — a non-installed player never reaches the card. DEV: `?installgift`.
      let installReward = claimInstallReward()
      if (q?.has('installgift') && !installReward) {
        installReward = { chips: 150, boost: 'jackpot', balance: loadSave().chips }
      }
      if (installReward && alive.on) {
        track(EVENTS.INSTALL_REWARD, { chips: installReward.chips, boost: installReward.boost })
        await openInstallRewardCard(this, installReward)
        // The pill was built from the save BEFORE the grant, so it is showing the pre-purse balance
        // until this fires — the same reason the coronation refreshes it after paying out.
        pill.update(loadSave().chips)
      }
      if (!alive.on) return
      // 0.1 · THE PRIVATE ELEVATOR — ACT II's one-time reveal.
      //
      // This is the CATCH-UP door. The intended one is chained off the chapter-30 car ceremony, and
      // everyone who clears 300 from now on meets it there. This exists for the cohort who had
      // already finished the game when the act shipped: without it they would simply find a hundred
      // more levels on the map one day, with nothing anywhere saying where they came from. Exactly
      // the problem `seenRaceUnlock` was written for, and the same shape of fix.
      //
      // Ahead of the race reveal because it is rarer and bigger; the card latches itself, so the two
      // doors can never double-show. DEV: `?elevator`.
      const act2Save = loadSave()
      const act2Due = DIFFICULTY.act2.enabled && DIFFICULTY.act2.reveal && act2Save.unlocked > ACT1_LEVELS
      if ((q?.has('elevator') || (act2Due && !act2Save.seenAct2Reveal)) && alive.on) {
        const { goUp } = await openAct2Card(this, 'home')
        if (!alive.on) return
        if (goUp) startScene(this, 'game', { level: ACT1_LEVELS + 1 })
        if (goUp) return
      }
      if (!alive.on) return
      // 0.25 · DAILY RACE UNLOCKED — the one-time reveal, ahead of everything else in this queue.
      // First because a brand-new racer cannot have won a crown or placed on yesterday's board yet,
      // and because it is the card that explains every card that could follow it. Before this, the
      // most repeatable feature in the game introduced itself by a dim signpost silently going live.
      // The card latches itself in the save, so this can never double-show.
      const unlockSave = loadSave()
      if ((q?.has('raceunlock') || (endlessUnlocked(unlockSave) && !unlockSave.seenRaceUnlock)) && alive.on) {
        const { showBoard } = await openRaceUnlockCard(this)
        if (!alive.on) return
        // "SEE THE BOARD" hands them straight to the standings — the whole point is that they end up
        // looking at the thing, not merely told it exists.
        if (showBoard) openRacePanel(this)
      }
      if (!alive.on) return
      // 0.4 · FREE SPIN — the one-time reveal that says out loud what the LUCKY SLOTS cabinet holds.
      //
      // AFTER the race reveal because the race is the bigger, rarer moment and a player who just
      // unlocked it should meet that first; the two can only collide on a single visit and the
      // ordering decides which leads. BEFORE the coronations for the same reason the race card is:
      // it explains a surface the later cards can pay into.
      //
      // Gated on a FIRST WIN (`unlocked > 1`), not on first open — chips and boosts describe a
      // currency a brand-new player has never held, so the card would be explaining nothing to them.
      // Gated on the pull actually being AVAILABLE, so it can never open with "free spin today" over
      // a cabinet the player already emptied this morning. DEV: `?freespin`.
      const spinSave = loadSave()
      const spinIntroDue = !spinSave.seenSlotsIntro && spinSave.unlocked > 1 && spinAvailable(spinSave)
      if ((q?.has('freespin') || spinIntroDue) && alive.on) {
        const { spinNow } = await openFreeSpinCard(this)
        if (!alive.on) return
        track(EVENTS.SLOTS_INTRO, { result: spinNow ? 'spin' : 'later', streak: spinSave.streak })
        // Hand them straight to the cabinet — the point is that they end up looking at the machine,
        // not merely being told it exists. Returns: nothing below this should run over a scene swap.
        if (spinNow) {
          startScene(this, 'slots')
          return
        }
      }
      if (!alive.on) return
      // 0.5 · CHAPTER TROPHY CATCH-UP — the one-time back-fill: every chapter beaten before the
      // trophies existed pays out here in one summed card, and thereafter this same sweep is the
      // self-healing net for any win-flow grant a crash or a merge race skipped. Claimed AWARD-FIRST
      // in one atomic write BEFORE the card opens, so a force-quit mid-card loses nothing and a
      // re-open re-offers nothing — the claim latch is the only latch. Ahead of the coronations
      // because it is once-ever and explains the showroom the ribbons now advertise; zero network,
      // so the dormant contract holds. DEV: `?catchup` shows the card on fixture grants (no award).
      let catchUp: ChapterCatchUp | null = null
      if (q?.has('catchup')) {
        const chips = loadSave().chips
        const grants = [1, 2, 3, 4].map(c => ({
          chapter: c,
          trophy: trophyFor(c)!,
          purse: CHAPTER_PURSES[c - 1] ?? 0,
          boost: CHAPTER_BOOSTS[c] ?? null,
          balance: chips,
        }))
        catchUp = { grants, totalPurse: grants.reduce((s, g) => s + g.purse, 0), balance: chips }
      } else if (unclaimedChapters(loadSave()).length > 0) {
        catchUp = claimChapterCatchUp()
        if (catchUp) {
          for (const g of catchUp.grants) {
            track(EVENTS.CHAPTER_REWARD, { chapter: g.chapter, purse: g.purse, retro: true })
          }
        }
      }
      if (catchUp && alive.on) {
        const { showShowroom } = await openTrophyCatchUpCard(this, catchUp, pill)
        if (!alive.on) return
        if (showShowroom) openShowroom(this)
      }
      if (!alive.on) return
      // 1 · CORONATION — did the player win an unclaimed prize for the season that just closed?
      let win: RacePrizeWin | null = null
      if (q?.has('coronation')) {
        win = { scope: 'week', key: previousWeekKey(), rank: 1, score: 38420, tier: PRIZE_TIERS[0] }
      } else {
        win = await checkWeeklyPrize(loadSave().championWeeks)
      }
      if (!alive.on) return
      if (win) await this.openCoronation(win, pill)
      if (!alive.on) return
      // 2 · DAILY WIN — and did they take yesterday's board? Read AFTER the weekly ceremony, not
      // before it: claiming the week writes the save, and this check reads the latches back.
      let day: RacePrizeWin | null = null
      if (q?.has('dailywin')) {
        day = { scope: 'day', key: previousDayKey(), rank: 1, score: 9840, tier: DAILY_PRIZE_TIERS[0] }
      } else {
        day = await checkDailyPrize(loadSave().championDays)
      }
      if (!alive.on) return
      if (day) await this.openCoronation(day, pill)
      if (!alive.on) return
      // 3 · RESULT RECAP — for everyone who raced yesterday and did NOT win it. Only reached when
      // `day` is null, because the winner already had their ceremony and must never get both: the
      // recap's whole job is to give the other players the closure the crown gives the winner.
      if (!day) {
        let recap: RaceRecap | null = null
        if (q?.has('recap')) {
          recap = {
            day: previousDayKey(),
            rank: 4,
            total: 12,
            score: 7744,
            winnerName: 'marisol',
            winnerScore: 9840,
            aheadName: 'chipqueen',
            gap: 527,
          }
        } else {
          recap = await fetchRaceRecap(loadSave().raceRecapDays)
        }
        if (!alive.on) return
        if (recap) await this.openRaceRecap(recap)
        if (!alive.on) return
      }
      // 4 · FRIEND-JOINED — referrer rewards, one toast each, max 2 per visit (the rest keep).
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
      if (!alive.on) return
      // 4.5 · THE HOUSE GIFT — one surprise a day, taken here (core/bonusdrop.ts).
      //
      // The LAST payout and the one directly before the ask, which is where it belongs on both
      // sides: it is the only entry in this queue that arrives every single day, so putting it
      // ahead of a coronation would mean the rarest moment in the game queueing behind the
      // commonest one — and it is the warmest possible thing to have just handed someone before
      // asking them for a notification permission.
      //
      // ⚠️ CLAIMED AWARD-FIRST, in one atomic write BEFORE the card opens, exactly like the chapter
      // catch-up above: a force-quit mid-card keeps every chip and a re-open re-offers nothing,
      // because the day latch inside the claim is the only latch. Zero network, so the dormant
      // contract holds — this pays whether or not Supabase is configured, which matters because the
      // reminder that names the gift is the half that needs a server and the gift itself is not.
      // DEV: `?gift` shows the card on a fixture grant (no award, no latch).
      // `dayKey`, not `todayKey`: the gift runs on the RACE calendar so the sender can name it in
      // advance (core/bonusdrop.ts). A DEV fixture on the local calendar would quietly show a
      // different gift than the live path on any device far enough from Alberta to disagree.
      const gift = q?.has('gift')
        ? {
            drop: dropForDay(q.get('gift') || dayKey()),
            day: dayKey(),
            chips: 150,
            freeSpins: 1,
            boost: 'doubleScore' as const,
            balance: loadSave().chips,
          }
        : claimBonusDrop()
      if (gift && alive.on) {
        if (!q?.has('gift')) {
          track(EVENTS.BONUS_DROP, {
            drop: gift.drop.id,
            chips: gift.chips,
            spins: gift.freeSpins,
            boost: gift.boost ?? 'none',
          })
        }
        pill.update(loadSave().chips)
        await openBonusDropCard(this, gift)
      }
      if (!alive.on) return
      // 5 · RACE REMINDER — the push opt-in, offered on the Home visit after a player's FIRST daily
      // race and never again (view/pushoptin.ts owns the gate and the latch).
      //
      // Dead last on purpose, and it is the only entry here that is an ASK rather than a payout or a
      // reveal. Nothing the player earned should ever queue behind a request from us — and landing
      // after a coronation or a recap is where the pitch is warmest anyway, because they have just
      // been shown a board result they care about. DEV: `?pushoffer`.
      if ((q?.has('pushoffer') || (await pushOfferDue(loadSave()))) && alive.on) {
        await openPushOptIn(this)
      }
    } finally {
      this.celebrating = false
    }
  }

  /**
   * The CORONATION — Signature growth moment: scrim, a crown descending onto a marquee-grade card
   * carrying the tier's title ("WEEKLY CHAMPION" / "DAILY WINNER") with a gold burst, governor-scaled
   * heart+chip confetti, and the purse counting up before it lands in the chip pill. THEN the claim —
   * so a crash mid-ceremony re-offers the crown, and the once-per-key latch makes any double call inert.
   *
   * ONE ceremony for both cadences, deliberately. Everything that differs between them is already
   * data — the tier's title, its purse, the winning number, and which latch the claim writes — so a
   * second copy of 300 lines of choreography would exist only to change four strings, and would be a
   * second place for the crown-landing beat to drift out of step with the confetti.
   *
   * Tap once mid-sequence → snap to the finished card (the award still happens, immediately); tap
   * again → dismiss. Reduced motion: the finished card appears at rest, the award is instant, one
   * tap dismisses. reduceFlashing: no bright burst/flash — a slow soft halo swell instead.
   */
  private openCoronation(win: RacePrizeWin, pill: ChipPill): Promise<void> {
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
      // per-key latch (championWeeks / championDays) makes even a raced second call a no-op.
      let awarded = false
      const award = (): void => {
        if (awarded) return
        awarded = true
        const balance =
          win.scope === 'week' ? claimChampionship(win.key, win.tier.chips) : claimDailyWin(win.key, win.tier.chips)
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

      // The winning NUMBER means something different per cadence — a day is one run, a season is
      // every day's best added together — and calling a week's total "your winning run" would read
      // as a score the player knows they never hit in one sitting.
      const scoreLine = this.add
        .text(0, 66, `${win.scope === 'week' ? 'your week' : 'your winning run'}  ·  ${win.score.toLocaleString()}`, {
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
        // Layered under the strike, not instead of it: the strike is the crown hitting the halo, the
        // boom is the room answering. Together they read an order of magnitude bigger than either.
        later(70, () => sfx.megaBoom())
        kick(340, 0.011)
        goldWash(0.3, 420)
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
        shower(14, cx)
        // …and it KEEPS RAINING. One burst reads as "a thing happened"; three overlapping waves,
        // each wider and off-centre from the last, read as a room throwing money in the air. This is
        // the cheapest half of "feels like the lottery" and the half players actually describe.
        later(430, () => shower(11, cx - 150))
        later(880, () => shower(11, cx + 150))
      }

      /**
       * One wave of heart+chip confetti from `x`. Extracted so the landing can rain repeatedly
       * instead of popping once — see `burst`. Governor-capped like every other emitter here.
       */
      const shower = (n: number, x: number): void => {
        if (!fancy) return
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
          p.explode(quality.count(n), x, cy - 220)
        }
      }

      /**
       * A short camera kick. The coronation is the one moment on Home where the ROOM is allowed to
       * react rather than just the card — a win you can feel in the furniture is the difference
       * between a notification and a jackpot. Skipped entirely under reduced motion; `shake` is
       * motion, not luminance, so `reduceFlashing` leaves it alone.
       */
      const kick = (ms: number, intensity: number): void => {
        if (!reduced) this.cameras.main.shake(ms, intensity)
      }

      /**
       * Full-screen gold wash — the light of the win reaching past the card. Held inside `layer` so
       * it dies with the ceremony, and behind both accessibility gates: it is a bright flash, which
       * is exactly what `reduceFlashing` exists to withhold.
       */
      const goldWash = (peak: number, ms: number): void => {
        if (!fancy || calmFlash) return
        const wash = this.add
          .rectangle(cx, viewportCenterY(), DESIGN_W, worldH(), T.goldBright, 0)
          .setBlendMode(Phaser.BlendModes.ADD)
        layer.add(wash)
        transients.push(wash)
        this.tweens.add({
          targets: wash,
          fillAlpha: peak,
          duration: ms * 0.35,
          yoyo: true,
          ease: E.hero,
          onComplete: () => wash.destroy(),
        })
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
            // THE NUMBER IS THE PRIZE. The count-up used to simply stop, which threw away the one
            // beat everybody actually waits for. It now lands: a ding, a scale punch on the figure
            // itself, a second wash and one more fall of confetti over the top.
            sfx.starDing(2) // top rung — G6, the brightest of the three
            if (!reduced) {
              this.tweens.add({
                targets: purseText,
                scale: 1.24,
                duration: 150,
                yoyo: true,
                ease: E.hero,
              })
            }
            kick(260, 0.008)
            goldWash(0.22, 380)
            shower(12, cx)
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
      // ── THE DRAW ───────────────────────────────────────────────────────────────────────────────
      // LEAD is an anticipation beat held BEFORE anything is shown: the room goes dark and a riser
      // climbs into silence, and only then does the card arrive. It is the single biggest reason this
      // reads as a draw rather than as a notification — a prize you see arriving has already been
      // given to you, whereas a prize you WAIT half a second for is won. Every delay below is
      // expressed against it, so the whole ceremony shifts as one and the skip/snap machinery (which
      // works off `rest` poses and tracked timers, never off wall-clock) is unaffected.
      const LEAD = 560
      // A deep rung on the riser — it is pitched by cascade depth, and this is the biggest moment the
      // game has. `winFanfare` resolves the riser itself (§E11), so the resolve is NOT fired here:
      // doing both would overlap the crescendo with the thing it hands off to.
      sfx.cascadeRiser(6)
      hint.setAlpha(0)
      scrim.setAlpha(0)
      this.tweens.add({ targets: scrim, alpha: 0.68, duration: D.settle, ease: E.settle })
      halo.setAlpha(0)
      // A glow blooms alone in the dark during the lead, so the eye is already parked where the crown
      // is about to land. It lives on `layer`, NOT on cardRoot: the card is held at alpha 0 until the
      // slam, and anything parented to it is held invisible with it — the first cut of this beat put
      // the glow on the halo and played 560ms to an empty screen.
      const leadGlow = this.add
        .image(cx, cy - 160, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(T.gold)
        .setDisplaySize(120, 110)
        .setAlpha(0)
      layer.add(leadGlow)
      transients.push(leadGlow)
      this.tweens.add({
        targets: leadGlow,
        alpha: calmFlash ? 0.16 : 0.3,
        displayWidth: 420,
        displayHeight: 360,
        duration: LEAD,
        ease: E.hero,
      })
      // …then the resolve, and the card SLAMS in on it — the glow handing off to the real halo.
      this.tweens.add({ targets: leadGlow, alpha: 0, duration: 260, delay: LEAD, ease: E.exit })
      later(LEAD, () => {
        sfx.winFanfare()
        kick(220, 0.006)
      })
      cardRoot.setAlpha(0)
      this.tweens.add({ targets: cardRoot, alpha: 1, duration: D.base, delay: LEAD + 60, ease: E.settle })
      popIn(this, cardRoot, { from: 0.88, delay: LEAD + 60, duration: D.pop, overshoot: OVERSHOOT.gentle })
      // The crown starts high above the card and drops onto its halo with the big overshoot.
      crown.setY(-430).setAlpha(0)
      this.tweens.add({ targets: crown, alpha: 1, duration: 200, delay: LEAD + 360, ease: E.settle })
      this.tweens.add({ targets: crown, y: -160, duration: 560, delay: LEAD + 360, ease: backOut(OVERSHOOT.pop) })
      this.tweens.add({ targets: halo, alpha: 0.22, duration: 320, delay: LEAD + 420, ease: E.settle })
      later(LEAD + 920, burst)
      // Bulbs cascade-light left→right behind the title reveal.
      bulbs.forEach((b, i) => {
        b.setAlpha(0.12)
        this.tweens.add({ targets: b, alpha: 0.62, duration: 220, delay: LEAD + 640 + i * 45, ease: E.settle })
      })
      fadeRise(this, banner, { rise: 14, delay: LEAD + 560, duration: D.settle })
      fadeRise(this, scoreLine, { delay: LEAD + 700 })
      purseText.setText('+0')
      fadeRise(this, purse, { delay: LEAD + 820 })
      fadeRise(this, purseSub, { delay: LEAD + 880 })
      later(LEAD + 1250, countUp)
      this.tweens.add({ targets: hint, alpha: 1, duration: 300, delay: LEAD + 2500, ease: E.settle })
      later(LEAD + 2600, () => {
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
  /**
   * The RESULT RECAP — yesterday's board, for the players who raced it and didn't win it.
   *
   * This exists because the crown was the only thing the format had to say when a day closed, and a
   * crown speaks to exactly one person. Everyone else played a shared board, watched a leaderboard,
   * and then got silence — no result, no confirmation the day had even ended. On a small board that
   * is nearly the whole player base, and it quietly makes the daily rhythm look like it isn't
   * happening.
   *
   * Deliberately NOT a celebration. No crown, no confetti, no purse, a lighter scrim: this is a
   * RESULT, and dressing 4th place like a win would read as consolation. The card is built around
   * the two numbers that make someone open today's board — how close the next place up was, and how
   * much of the week they have banked — with the play button right there under them.
   *
   * Latched BEFORE it animates (see save.markRaceRecapSeen): unlike a coronation there is nothing
   * owed, so a card interrupted halfway should not come back tomorrow to report the wrong day.
   */
  private openRaceRecap(recap: RaceRecap): Promise<void> {
    return new Promise(resolve => {
      markRaceRecapSeen(recap.day)
      const reduced = this.prefersReducedMotion()
      const T = getTheme()
      const cx = DESIGN_W / 2
      const cy = 560
      const layer = this.add.container(0, 0).setDepth(78)
      layer.once(Phaser.GameObjects.Events.DESTROY, () => resolve())

      // The week the CLOSED day belonged to — not today's. On a Monday those differ, and reporting a
      // fresh empty week under a Sunday result would read as the totals having been wiped.
      const closedWeek = weekKeyOfDay(recap.day) ?? weekKey()
      const weekLive = closedWeek === weekKey()
      const wk = endlessWeekStanding(loadSave(), closedWeek)

      const scrim = this.add.rectangle(cx, viewportCenterY(), DESIGN_W, worldH(), T.scrim, 0.45).setInteractive()
      layer.add(scrim)

      const cardW = 540
      const cardH = 510
      const cardRoot = this.add.container(cx, cy)
      layer.add(cardRoot)
      const g = this.add.graphics()
      for (let i = 2; i >= 1; i--) {
        g.fillStyle(T.shadow, 0.1)
        g.fillRoundedRect(-cardW / 2, -cardH / 2 + i * 3, cardW, cardH, 30)
      }
      g.fillStyle(T.cardFill, 1)
      g.fillRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 30)
      g.lineStyle(4, T.goldBezel, 1)
      g.strokeRoundedRect(-cardW / 2, -cardH / 2, cardW, cardH, 30)
      if (darkWash(T)) {
        g.fillStyle(T.accent, 0.85)
        g.fillRoundedRect(-cardW / 2 + 30, -cardH / 2 + 3, cardW - 60, 2, 1)
      }
      cardRoot.add(g)
      // Blocker so a tap on the card never falls through to the dismissing scrim.
      cardRoot.add(this.add.rectangle(0, 0, cardW, cardH, 0xffffff, 0.001).setInteractive())

      cardRoot.add(
        this.add
          .text(0, -196, 'YESTERDAY’S BOARD', { fontFamily: FONT, fontSize: '19px', fontStyle: '900', color: T.inkFaint })
          .setOrigin(0.5)
          .setLetterSpacing(3)
      )

      // Where you finished — the hero number. Rank alone, big: "#4" is the answer to the question the
      // player actually has, and everything else on the card is context for it.
      cardRoot.add(
        this.add
          .text(0, -134, `#${recap.rank}`, { fontFamily: FONT, fontSize: '72px', fontStyle: '900', color: T.goldText })
          .setOrigin(0.5)
          .setShadow(0, 3, 'rgba(0,0,0,0.14)', 5, false, true)
      )
      cardRoot.add(
        this.add
          .text(0, -80, `of ${recap.total}  ·  ${recap.score.toLocaleString()}`, {
            fontFamily: 'Arial, sans-serif',
            fontSize: '21px',
            color: T.inkMuted,
          })
          .setOrigin(0.5)
      )

      // Who took it — on the canonical gold plate, so the winner's line is visibly the same metal the
      // leaderboard crowns them with.
      const plateW = cardW - 76
      const plate = this.add.graphics()
      goldFace(plate, -plateW / 2, -26, plateW, 52, T, 16)
      plate.lineStyle(2, T.goldDeep, 1)
      plate.strokeRoundedRect(-plateW / 2, -26, plateW, 52, 16)
      const winner = this.add.container(0, -18)
      winner.add(plate)
      // No crown glyph here, deliberately: 👑 is gold-on-gold against this plate and renders as a
      // smudge. The plate IS the crown — it is the same struck-metal face the leaderboard gives #1.
      winner.add(
        this.add
          .text(-plateW / 2 + 28, 0, `won by ${recap.winnerName}`, {
            fontFamily: FONT,
            fontSize: '21px',
            fontStyle: '900',
            color: T.goldPillText,
          })
          .setOrigin(0, 0.5)
          .setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      )
      winner.add(
        this.add
          .text(plateW / 2 - 24, 0, recap.winnerScore.toLocaleString(), {
            fontFamily: FONT,
            fontSize: '21px',
            fontStyle: '900',
            color: T.goldPillText,
          })
          .setOrigin(1, 0.5)
          .setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      )
      cardRoot.add(winner)

      // The near-miss. This is the line that sends someone back to the board, so it gets the gap to
      // the NEXT PLACE UP rather than to the winner — "527 behind" is catchable; "2,096 behind the
      // leader" is a wall. Falls back to the winner's number when we couldn't see who was directly
      // ahead (the player finished outside the fetched rows).
      cardRoot.add(
        this.add
          .text(
            0,
            34,
            recap.aheadName !== null && recap.gap > 0
              ? `just ${recap.gap.toLocaleString()} behind ${recap.aheadName}`
              : `${recap.winnerScore.toLocaleString()} was the score to beat`,
            { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.ink, align: 'center', wordWrap: { width: cardW - 70 } }
          )
          .setOrigin(0.5)
      )

      // The week, and what is still on the table. The second half is the whole point of saying it:
      // "3 boards left" is a plan, where a bare total is a scoreboard.
      const left = Math.max(0, DAYS_PER_WEEK - wk.days)
      cardRoot.add(
        this.add
          .text(
            0,
            84,
            weekLive
              ? `your week  ·  ${wk.total.toLocaleString()}  ·  ${wk.days} of ${DAYS_PER_WEEK} days`
              : `that week finished  ·  ${wk.total.toLocaleString()}  ·  ${wk.days} of ${DAYS_PER_WEEK} days`,
            { fontFamily: 'Arial, sans-serif', fontSize: '20px', color: T.inkMuted }
          )
          .setOrigin(0.5)
      )
      cardRoot.add(
        this.add
          .text(
            0,
            114,
            weekLive
              ? left > 0
                ? `${left} more board${left === 1 ? '' : 's'} to add to it`
                : 'every board raced — hold your total'
              : 'a fresh week starts today',
            { fontFamily: 'Arial, sans-serif', fontSize: '19px', color: T.inkFaint }
          )
          .setOrigin(0.5)
      )

      let gone = false
      const dismiss = (then?: () => void): void => {
        if (gone) return
        gone = true
        sfx.whoosh()
        if (reduced) {
          layer.destroy()
          then?.()
          return
        }
        this.tweens.add({
          targets: layer,
          alpha: 0,
          duration: 160,
          ease: E.exit,
          onComplete: () => {
            layer.destroy()
            then?.()
          },
        })
      }
      scrim.on('pointerup', () => dismiss())

      // The call to action, in the race's own rose so it reads as "the same thing you were playing".
      // It starts today's board directly — the recap's job is finished the moment it hands over.
      cardRoot.add(
        addPillButton(this, 0, 172, 452, 72, 'PLAY TODAY’S BOARD', ROSE_PILL, () =>
          dismiss(() => startScene(this, 'game', { endless: true }))
        )
      )
      cardRoot.add(
        this.add
          .text(0, 228, 'tap anywhere to close', { fontFamily: 'Arial, sans-serif', fontSize: '17px', color: T.inkFaint })
          .setOrigin(0.5)
      )

      if (reduced) return
      cardRoot.setAlpha(0)
      this.tweens.add({ targets: cardRoot, alpha: 1, duration: D.base, ease: E.settle })
      popIn(this, cardRoot, { from: 0.92, duration: D.pop, overshoot: OVERSHOOT.gentle })
    })
  }

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
   * ── THE ICON RAIL ────────────────────────────────────────────────────────────
   * One row of badged doors, replacing the four full-width pills (LEVELS, GIFT STORE, LUCKY SLOTS,
   * ENDLESS) that used to compete with PLAY at near-equal weight. Every tile is the same chunky-3D
   * GHOST cap the rest of the app wears, so the rail is quiet by construction: PLAY keeps the only
   * saturated face on the screen, and a badge — not a gold pill — is what says "something here".
   *
   * Three things are load-bearing:
   *   · TILES RIDE ONE CONTAINER. The whole rail springs in as a single entrance beat rather than
   *     five staggered ones, which is what keeps the last module landing at ~1350ms the way three
   *     rows used to. It also means a tile has no stagger index of its own — see the LUCKY SLOTS
   *     arrival knock, which is timed off the rail.
   *   · THE GLYPH IS ITS OWN TEXT. `addPillButton`'s letterSpacing splits an emoji's surrogate pair
   *     and Phaser renders tofu, so a tile composes from `addPressablePlate` — the same reason the
   *     stash door and the live card do.
   *   · THE BADGE RIDES THE OUTER CONTAINER, never the sinking `face`: the press must carry the
   *     glyph without dragging the number off the tile. That is the charm collar's own seat, and the
   *     one place this rail deliberately copies rather than shares (a collar is five lines).
   *
   * Hit zones are ≥84 design px (≈44pt) in each axis for free — `buildPressable` grows every one to
   * that floor whatever the art box says, so the tiles could shrink further without becoming a miss.
   */
  private addIconRail(
    y: number,
    items: RailItem[]
  ): { container: Phaser.GameObjects.Container; tiles: Map<string, Phaser.GameObjects.Container> } {
    const T = getTheme()
    const container = this.add.container(DESIGN_W / 2, y)
    const tiles = new Map<string, Phaser.GameObjects.Container>()
    // Centre whatever survived the progressive reveal, rather than seating against a fixed left edge
    // — a rail of one (a brand-new save keeps only LUCKY SLOTS) has to look deliberate too.
    const span = items.length * RAIL_W + Math.max(0, items.length - 1) * RAIL_GAP
    items.forEach((item, i) => {
      const x = -span / 2 + RAIL_W / 2 + i * (RAIL_W + RAIL_GAP)
      const { container: tile, face } = addPressablePlate(
        this,
        x,
        0,
        RAIL_W,
        RAIL_H,
        GHOST_PILL,
        () => {
          sfx.uiTap()
          item.onTap?.()
        },
        // `disabled` dims AND inerts in one flag — a tile with no `onTap` is a signpost: present so
        // the road is visible, silent because there is nothing behind it yet.
        { disabled: item.onTap === undefined }
      )
      face.add(this.add.text(0, -13, item.glyph, { fontFamily: 'sans-serif', fontSize: '30px' }).setOrigin(0.5))
      face.add(
        this.add
          .text(0, 21, item.label, { fontFamily: FONT, fontSize: '13px', fontStyle: '900', color: T.inkSoft })
          .setOrigin(0.5)
          .setLetterSpacing(1)
      )
      if (item.badge) {
        // Top-right, clear of the caption at the tile's foot. Gold = a free pull or a purse already
        // yours; rose = a thing worth doing. A bare dot when there is no number to report.
        const badge = this.add.container(RAIL_W / 2 - 13, -RAIL_H / 2 + 2)
        const fill = item.badge.gold ? T.gold : T.rose
        const g = this.add.graphics()
        if (item.badge.text === undefined) {
          g.fillStyle(T.cardFill, 0.9)
          g.fillCircle(0, 0, 10)
          g.fillStyle(fill, 1)
          g.fillCircle(0, 0, 7.5)
          badge.add(g)
        } else {
          const label = this.add
            .text(0, 0, item.badge.text, {
              fontFamily: FONT,
              fontSize: '15px',
              fontStyle: '900',
              color: item.badge.gold ? T.goldPillText : T.onRose,
            })
            .setOrigin(0.5)
          const bw = Math.max(22, label.width + 14)
          g.fillStyle(fill, 1)
          g.fillRoundedRect(-bw / 2, -11, bw, 22, 11)
          g.lineStyle(2, T.cardFill, 0.9)
          g.strokeRoundedRect(-bw / 2, -11, bw, 22, 11)
          badge.add([g, label])
        }
        tile.add(badge)
      }
      container.add(tile)
      tiles.set(item.id, tile)
    })
    return { container, tiles }
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

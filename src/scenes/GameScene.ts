import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import {
  BOARD_W,
  BOARD_X,
  BOARD_Y,
  ENDLESS_BOARD_DROP,
  ENDLESS_STRIP_Y,
  CELL,
  CLEAR_MS,
  COLS,
  DESIGN_W,
  restScrollY,
  viewportCenterY,
  worldH,
  FALL_BASE_MS,
  FALL_PER_CELL_MS,
  INVALID_MS,
  MOVES_BONUS,
  PIECE_SIZE,
  POINTS_PER_PIECE,
  ROWS,
  SWAP_MS,
} from '../config'
import { Board } from '../core/board'
import { CheatSwipeCode, swipeDir } from '../core/cheat'
import { awardFreeSpinsFor, todayKey } from '../core/daily'
import { DAYS_PER_WEEK, dayKey, endlessBestForDay, recordEndless } from '../core/endless'
import type { WeekStanding } from '../core/endless'
import { endlessLockPlan, endlessShapeFor } from '../core/endlessramp'
import type { EndlessShape } from '../core/endlessramp'
import { endlessBoardRng } from '../core/boardpick'
import { cachedSalt } from '../core/racesalt'
import { CHAPTER_COUNT, CHAPTER_LEVELS, LEVEL_COUNT, levelSpec, starsFor } from '../core/levels'
import { CHAPTER_BOOSTS, CHAPTER_PURSES, claimChapter, trophyFor } from '../core/trophies'
import type { ChapterGrant } from '../core/trophies'
import { playChapterCeremony } from '../view/trophyceremony'
import { hazardPlan } from '../core/hazards'
import { ensureHazardTexture } from '../view/textures'
import { DIFFICULTY, type HazardKind } from '../core/difficulty'
import { shouldOfferPlinko } from '../core/plinko'
import { dealReady, winsToDeal } from '../core/deal'
import { EVENTS, track } from '../core/analytics'
import { devSetLives, formatCountdown, grantLife, refreshLives, spendLifeFor } from '../core/lives'
import { levelProgress, maya, pendingOccasion, warmLoseLine, warmWinSubtitle, wasNearMiss } from '../core/maya'
import { mulberry32 } from '../core/rng'
import { addChips, addFreeSpins, bumpJackpotMeter, consumeBoost, bumpWinStreak, freeSpinRoom, loadSave, markFinaleSeen, markOccasionSeen, persistSave, recordResult, recordScore, resetWinStreak, spendChips, spendJackpotCharge, takePendingBoosts } from '../core/save'
import { freeSourceFor, freeStockFor } from '../core/inventory'
import { LIFE_REFILL_PRICE, POWER_ITEMS } from '../core/store'
import type { PowerItem } from '../core/store'
import { jackpotReady } from '../core/jackpot'
import { SYMBOLS, key } from '../core/types'
import type { BlastEvent, BoostType, ClearWave, Coord, FallMove, LevelSpec, Piece, PieceKind, Spawn, SymbolType } from '../core/types'
import { addCasinoBackdrop } from '../view/background'
import { stageFlare, stagePulse } from '../view3d/stage'
import { addJackpotMeter, openJackpotWheel } from '../view/jackpot'
import { openPlinko } from '../view/plinko'
import { openDeal } from '../view/deal'
import type { JackpotMeter } from '../view/jackpot'
import { D, E, OVERSHOOT, backOut, heartbeat } from '../view/motion'
import { quality } from '../view/quality'
import { vibratePattern } from '../view/haptics'
import { css, getTheme, hapticsOff, prefersReducedMotion, reduceFlashing as prefReduceFlashing, rgbMarquee } from '../view/theme'
import { addEndlessLeaderStrip } from '../view/leaderboardpanel'
import { attachRgbRing, type RgbRing } from '../view/rgbmarquee'
import { TEX_SIZE, ensurePieceTexture } from '../view/textures'
import {
  FONT,
  GHOST_PILL,
  GOLD_PILL,
  ROSE_PILL,
  addChipPill,
  addLivesHud,
  addMuteChip,
  addPillButton,
  consumeFocus,
  goldFace,
  hcBoard,
  inkShadow,
  openHazardIntro,
  openOnboarding,
  startScene,
  openSpecialIntro,
  specialTeachKey,
} from '../view/ui'
import type { ChipPill, SceneFocus } from '../view/ui'
import { addFocusScrim, bakePanel, panelPlate } from '../view/platekit'

/**
 * Turn state machine:
 *
 *   idle --input--> swapping --activation?--> resolving (wave/fall/refill loop, cascades)
 *                      |  no                        |
 *                      v                            v
 *                 snap back --> idle    objectives met / moves out --> ended (overlay)
 *                                       no valid moves --> shuffling --> idle
 */
type GameState = 'idle' | 'swapping' | 'resolving' | 'shuffling' | 'ended'

interface ObjectiveState {
  symbol: SymbolType
  remaining: number
  total: number
  /**
   * Displayed collect count driving `text`. Lags `remaining` so the E10 collect-fly can tick the
   * visible number DOWN only when a flyer lands (the model decrements synchronously for correct win
   * detection; the chip catches up on arrival). Kept in sync with `remaining` under reduced motion.
   */
  shown?: number
  text?: Phaser.GameObjects.Text
  chip?: Phaser.GameObjects.Container
  /** Soft gold halo behind the chip that breathes while this objective is INCOMPLETE. */
  glow?: Phaser.GameObjects.Image
  /** The breathe tween on `glow` — stopped when the objective completes. */
  pulse?: Phaser.Tweens.Tween
  /** C5 latch — the rising "almost there" tone fires at most once, when remaining first crosses low. */
  nearFired?: boolean
}

/**
 * §R3 reward layer — one pooled score-medallion slot: the star-burst coin + its "+N" label under a
 * single container so the pop/float/fade tweens drive ONE target. `live` marks it in flight; `born`
 * orders slots so a spawn past the hard cap recycles the OLDEST (its tweens killed first — Phaser
 * 3.90 never sweeps tweens for reused targets).
 */
interface MedallionSlot {
  root: Phaser.GameObjects.Container
  badge: Phaser.GameObjects.Image
  label: Phaser.GameObjects.Text
  live: boolean
  born: number
}

/** §R3 hard cap on concurrent score medallions — the 5th mint recycles the oldest in flight. */
const MEDALLION_CAP = 4

const PIECE_SCALE = PIECE_SIZE / TEX_SIZE
const DRAG_THRESHOLD = CELL * 0.3
/**
 * §G1 · how long a swap aimed mid-cascade stays booked. Sized against the resolve it has to outlive:
 * a wave is ~CLEAR_MS + a fall (~100–450ms), so a typical x3–x4 chain settles inside ~1.5s and the
 * book survives it. Much longer and a swipe fires long after the player stopped meaning it; much
 * shorter and the buffer stops covering the deep chains that made it necessary.
 */
const BUFFERED_SWAP_MS = 1600
/** C5 · remaining-count at/under which a collect objective rings its one "almost there" tone. */
const OBJECTIVE_NEAR = 1

/**
 * B5 · win "board sweep-clean" tuning. The cascade is short BY DESIGN — it lands right as the result
 * card enters and never delays the tap-to-skip (footprint ≈ SWEEP_STAGGER_MS + SWEEP_ARC_MS). SWEEP_FLIES
 * is the HIGH-tier fly cap; `quality.count()` thins it per device (0 → no sweep). SWEEP_FADE_MS empties
 * the WHOLE board as one fade under the flyers, so cells with no flyer of their own never pop.
 */
const SWEEP_FLIES = 22
const SWEEP_STAGGER_MS = 150
const SWEEP_ARC_MS = 250
const SWEEP_FADE_MS = 360

/**
 * Top edge (design-box y) of the endless cheat strip — the hidden swipe surface the mega win is
 * entered on. See core/cheat.ts for the code itself and why a run that fires it is unranked.
 *
 * Everything from here down is dead space in endless, and only in endless: the numbered levels
 * spend it on the jackpot meter (y 1086) and the HELPERS shelf (1136–1240), while the race — a
 * boost-free fairness board — builds neither. It has no bottom edge: a tall phone's reclaimed height
 * pools at the bottom (config.ts contentOffsetY), and that extra room is strip too, which is why the
 * hit test is a bare `y >=` rather than a fixed rectangle.
 *
 * ⚠️ RE-DERIVED 2026-08-03, when the TODAY'S LEADER strip moved from below the board to ABOVE it
 * (`ENDLESS_STRIP_Y`) and the board dropped by `ENDLESS_BOARD_DROP` to make the lane. The old value
 * was keyed off the strip's bottom edge, and that anchor no longer exists down here.
 *
 * The only thing left below the board is the standing brief, which follows the board down to
 * `988 + ENDLESS_BOARD_DROP` = 1072 and is a 22px line, so its bottom sits near 1083. The zone must
 * not overlap a real control: it swallows whole gestures, so a swipe starting on one would read as
 * cheat input AND as a press.
 *
 * ⚠️ Re-derived a second time on 2026-08-04, when ENDLESS_BOARD_DROP went 60 → 84 to keep board
 * swipes off the leader strip. The brief moved down with the board, so 1080 would now have started
 * the zone INSIDE it. 1104 clears the text plus room for a thumb landing just under it.
 *
 * Dead space is still ample: 1104 → the 1280 design box is a full-width band ~176px tall, and a real
 * phone's reclaimed height pools below that and is strip too. Comfortably enough to enter the
 * pattern unnoticed, which the owner confirmed is the only requirement down here. Re-derive AGAIN if
 * the brief or the drop moves — this constant has no other anchor now that the strip lives up top.
 */
const CHEAT_ZONE_TOP = 1104

/**
 * What the mega win multiplies the blast's points by. The cheat pays through the SAME chokepoint as
 * every other score in the game (`addScore`'s `scoreMult`) rather than adding a flat lump: the
 * cascade the blast sets off is genuinely worth ~1–2k, and ×12 turns that into the five-figure
 * eruption "MEGA WIN" promises, sized by how well the blast actually landed instead of by a magic
 * number. Composes with any multiplier already running (endless has none today).
 */
const MEGA_WIN_MULT = 12

export class GameScene extends Phaser.Scene {
  private level = 1
  private spec!: LevelSpec
  private board!: Board
  private sprites = new Map<number, Phaser.GameObjects.Sprite>()
  private pieceLayer!: Phaser.GameObjects.Container
  private emitters!: Record<SymbolType, Phaser.GameObjects.Particles.ParticleEmitter>
  private sparkEmitter!: Phaser.GameObjects.Particles.ParticleEmitter
  /** Looping additive halo behind each on-board special sprite (the "armed/loaded" tell). */
  private armedGlows = new Map<number, Phaser.GameObjects.Image>()
  /** Felt sprites by cell key — the coat layer, drawn UNDER the pieces. */
  private coatCells = new Map<string, Phaser.GameObjects.Image>()
  /** Clamp furniture by piece id, mirroring `armedGlows`: same create/sync/destroy discipline. */
  private lockOverlays = new Map<number, Phaser.GameObjects.Image>()
  /** Coats present when the level started — the denominator for the sweep counter. */
  private coatsTotal = 0
  private coatLabel?: Phaser.GameObjects.Text
  /**
   * Soft CREAM shimmer halo behind each on-board NORMAL piece whose symbol is still a needed
   * objective — the "collect me" tell. Deliberately cool/white and phase-shimmered (see update)
   * so it never reads as the specials' warm-gold armed glow. Keyed by piece id; position +
   * alpha are synced per-frame, so there are no per-piece tweens and no graphics redraws.
   */
  private goalGlows = new Map<number, Phaser.GameObjects.Image>()
  /** Cached prefers-reduced-motion — tones down detonation particle counts + the armed pulse. */
  private reducedMotion = false
  /** §E12 cached High-Contrast board flag — read once at create(); drives the darker floor + tints. */
  private hc = false
  /** §E12 thicker high-contrast selection ring (a stroked Graphics), built + used only when `hc`. */
  private hcRing?: Phaser.GameObjects.Graphics
  /** §E14 guard — true while the first-run onboarding card is up, so board taps are ignored under it. */
  private introOpen = false
  private cabinetBulbs: Phaser.GameObjects.Image[] = []
  /** The fluid RGB light ring on the bezel (§RGB), or undefined when the player has it switched off. */
  private cabinetRgb?: RgbRing
  private cabinetGlow?: Phaser.GameObjects.Image
  /** True while a win surge (flashCabinet) briefly owns cabinetGlow's alpha, so the heartbeat drive in update() yields (C1). */
  private cabinetSurge = false
  private state: GameState = 'idle'
  /** §E4 latch — a jackpot chip detonated this round, so the Heartbloom hero win fires even below 3-star. */
  private jackpotOccurred = false
  /** §E4 guard — the Heartbloom (giant heart of light + Maya leitmotif) fires at most ONCE per round. */
  private heartbloomFired = false
  /** §E9 — set in finishWin when this win's score beats the stored best; drives the NEW BEST! ribbon. */
  private newBestThisWin = false

  // --- Impact & weight (E5/E6) ---
  /** Trauma accumulator (0..1); shake magnitude is trauma², decayed each frame in update(). */
  private trauma = 0
  private traumaDirX = 0
  private traumaDirY = 0
  /** The single shared impact-frame sprite — CAPPED at one concurrent (photosensitivity red line). */
  private impactFlash?: Phaser.GameObjects.Image
  /** Wall-clock deadline of the active hitstop freeze; guards "one freeze at a time, deepest owns it." */
  private hitstopUntil = 0
  /** The one live camera-breath zoom tween (big clears) — guards "one breath at a time". */
  private cameraBreathTween: Phaser.Tweens.Tween | null = null
  /** Deliberate vertical camera offset for the BOARD SLAM — a heavy detonation punches the view down
   *  then springs back. Added to the camera scroll in update() ON TOP of the random trauma rattle, so
   *  the slam is the clean directional dip and trauma is the grit on it. `.y` is tweened by boardSlam. */
  private boardKick = { y: 0 }
  private boardKickTween: Phaser.Tweens.Tween | Phaser.Tweens.TweenChain | null = null
  /** The board's tight CONTACT shadow (baked in buildBackdrop) + its resting scale — pulsed darker/
   *  tighter on a slam so the slab reads as pressing toward its housing (depth). */
  private contactShadow?: Phaser.GameObjects.Image
  private contactShadowBase = 1
  /** Tween/timer timescale to restore after a hitstop (1, or ?turbo=N in DEV). */
  private baseTimeScale = 1
  /** A11y "reduce flashing" switch (photosensitivity ≠ vestibular) — read from the real toggle in create(). */
  private reduceFlashing = false

  // --- P6 idle micro-life (all reduced-motion-gated, governor-capped) ---
  /** 3c: score-text punch tween — killed + restarted so overlapping chunky gains don't stack scale. */
  private scorePunchTween: Phaser.Tweens.Tween | null = null
  /** 3d: idle-hint nudge — armed on entering idle, disarmed on the first board touch / swap-start. */
  private hintTimer: Phaser.Time.TimerEvent | null = null
  private hintTween: Phaser.Tweens.Tween | null = null
  private hintTargets: Phaser.GameObjects.Sprite[] = []
  private hintRing?: Phaser.GameObjects.Image

  private movesLeft = 0
  private objectives: ObjectiveState[] = []
  private movesText!: Phaser.GameObjects.Text
  /** Looping "urgent" pulse on the moves number once movesLeft ≤ 3 (started once, cleared on level end). */
  private movesPulse: Phaser.Tweens.Tween | null = null

  private selected: Coord | null = null
  private selectedSprite: Phaser.GameObjects.Sprite | null = null
  private selectPulse: Phaser.Tweens.Tween | null = null
  private ring!: Phaser.GameObjects.Sprite
  /**
   * B2 magnetic select telegraph — the ≤4 orthogonal neighbor sprites leaned ~3px toward the current
   * selection, paired with their EXACT grid-home positions so a restore is pixel-perfect. Both are
   * cleared by disarmSelectTelegraph on clear / swap-start / any board mutation, so no piece is ever
   * left displaced when the board animates. Stays empty (and unused) under reduced motion.
   */
  private leanTweens: Phaser.Tweens.Tween[] = []
  private leanHomes: Array<{ sprite: Phaser.GameObjects.Sprite; x: number; y: number }> = []

  private dragFrom: Coord | null = null
  private dragStartX = 0
  private dragStartY = 0
  private dragConsumed = false

  /**
   * §G1 INPUT BUFFER — one swap, aimed while a cascade was still resolving, replayed the instant the
   * board settles. Field initializers do NOT re-run across `scene.restart()`, so every one of these is
   * reset in `create()` alongside the other carried state (see the scene-restart hygiene note there).
   *
   * Only ONE swap is ever held: a queue would let a mashed board run away from the player, and every
   * genre benchmark buffers exactly one. The book is dropped on expiry (`BUFFERED_SWAP_MS`) and
   * whenever the level ends, so a swipe made during the win cascade can never fire into the next level.
   */
  private bufferFrom: Coord | null = null
  private bufferStartX = 0
  private bufferStartY = 0
  private bufferConsumed = false
  /** The first half of a tap-tap pair aimed mid-resolve (the idle `selected` ring's off-board twin). */
  private bufferSelected: Coord | null = null
  /** The booked swap + the scene-clock ms it was aimed at, or null when nothing is queued. */
  private bookedSwap: { from: Coord; to: Coord; at: number } | null = null

  /** B1 swipe-intent trail — a faint spark follow riding the grabbed piece across a swap glide; null when idle. */
  private swipeTrail: Phaser.GameObjects.Particles.ParticleEmitter | null = null

  /**
   * B4 rare idle twinkle — a lone masked `sweep` gleam on ONE resting piece, fired sparsely while idle
   * (deliberately NOT the removed board-wide light-sweep). The live gleam + its geometry mask + tween
   * are held so a board touch / resolve disarms it mid-flight; `nextTwinkleAt` is the scene-clock (ms)
   * of the next allowed fire, pushed forward on any activity so it never glints the instant rest resumes.
   */
  private twinkleGleam: Phaser.GameObjects.Image | null = null
  private twinkleMask: Phaser.GameObjects.Graphics | null = null
  private twinkleTween: Phaser.Tweens.Tween | null = null
  private nextTwinkleAt = 0

  private score = 0
  private shownScore = 0
  private scoreTween: Phaser.Tweens.Tween | null = null
  private scoreText!: Phaser.GameObjects.Text
  /** W3 — the next round score milestone (10k/25k/50k…) whose crossing fires a one-off gold pop on the readout. */
  private scoreMilestone = 10000

  /**
   * E11 continuous combo counter: ONE reused readout over the board — punches in place + heat-ramps
   * warm→hot across a cascade, then fades on resolve. Never per-wave spawns. `comboTween` holds
   * whichever beat is live (punch OR fade) so a new wave / the resolve can cancel it cleanly.
   */
  private comboText?: Phaser.GameObjects.Text
  private comboTween: Phaser.Tweens.Tween | null = null
  /** Deepest MEGA tier (1 MEGA / 2 SUPER / 3 UNREAL) reached this resolve — so the strike PUNCTUATES
   *  each new tier instead of firing every wave. Reset per resolve (resolveLoop) + on restart. */
  private comboPeakTier = 0
  /** Points the CURRENT chain has scored (summed across its waves) — the stake a Plinko drop
   *  multiplies. Reset per resolve (resolveLoop) + on restart. */
  private chainPoints = 0
  /** One Plinko drop per level, however hot the player gets. Reset on restart (create). */
  private plinkoUsedThisLevel = false

  /** §R3 score-medallion pool (≤MEDALLION_CAP slots, built lazily, reused for the whole round). */
  private medallionPool: MedallionSlot[] = []
  /** §R3 monotonic mint counter — orders medallion slots so recycling always takes the oldest. */
  private medallionSeq = 0

  /** Compact chip-balance pill in the HUD; the win payout flies a chip into it. */
  private chipHud?: ChipPill
  /** New chip total banked by the current win (set in finishWin, applied on the payout fly-in). */
  private chipBanked = 0

  /** Jackpot charge meter in the HUD (fills one notch per level win). */
  private jackpotHud?: JackpotMeter
  /** True once this win charged the meter to full — the win-card Continue then fires the wheel. */
  private jackpotArmed = false
  /** True once this win completed a HOT STREAK — the win-card Continue then deals the Lucky Deal. */
  private dealArmed = false

  /** R4 · lazy "FREE SPINS ×N" corner counter — minted the first time a ticket flies (numbered levels). */
  private freeSpinBadge?: { root: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text }
  /**
   * Where the free-spins counter parks, measured while the HUD rail is built (so it reads the SAME
   * chip geometry rather than duplicating those magic numbers). The counter is the only HUD element
   * whose neighbours change per level — 1–3 objective chips, or the endless week's-best card — so its
   * home has to be derived, not hard-coded. See `ensureFreeSpinBadge`.
   */
  private freeSpinSpot?: { x: number; y: number }

  /** Set while the win result card is animating in — a tap fast-forwards it to the settled state. */
  private overlaySettle: (() => void) | null = null

  /**
   * Top edge of the board for THIS run. `BOARD_Y` (config) is the numbered-level seat; the endless
   * race sits `ENDLESS_BOARD_DROP` lower so the TODAY'S LEADER strip can live ABOVE the board rather
   * than below it — you race against a number, and it belongs in your eyeline, not past the bottom
   * of the grid where you have to look away from the game to read it.
   *
   * ⚠️ EVERY piece of board geometry reads this, not BOARD_Y: piece placement, the mask, the frame,
   * the RGB ring AND `rowAt`'s hit test. They must agree exactly — a hit test that disagrees with
   * the render by even one row means taps land on the wrong piece, which is close to unplayable and
   * looks like a swap bug rather than a layout one. Set once in `create()` before anything is built.
   *
   * §11: assigned in create(), because field initializers do NOT re-run on scene.restart().
   */
  private boardTop = BOARD_Y

  // --- In-level helpers (the mid-level power bar below the jackpot meter; numbered levels only) ---
  /** The shop-bar container (caption + item buttons); undefined in endless. Hidden on level end. */
  private powerBar?: Phaser.GameObjects.Container
  /** The rebuildable layer of item buttons inside `powerBar` (affordability re-renders swap gold↔ghost). */
  private powerItemsLayer?: Phaser.GameObjects.Container
  /** The shelf caption — held because its wording changes with free stock (see renderPowerItems). */
  private powerCaption?: Phaser.GameObjects.Text
  /** Transient "+N moves" / "Not enough chips" toast over the bar. */
  private powerToastText?: Phaser.GameObjects.Text
  /** Moves bought this level — SUBTRACTED from the win's star/bonus/reward math so buys can't farm stars/chips. */
  private purchasedMoves = 0
  /** True between tapping BOMB and picking a target: the next board tap detonates instead of selecting. */
  private bombArmed = false
  /** §G4 — purchased bombs DETONATED this level, against `DIFFICULTY.economy.maxBombsPerLevel`. */
  private bombsUsed = 0
  /** §G11 — a first-ever special waiting for its teach card at the next idle handoff. */
  private pendingSpecialTeach: { key: string; kind: PieceKind } | null = null
  /** The bomb-aim overlay (board-frame highlight + prompt + cancel); torn down on detonate/cancel. */
  private bombAimLayer?: Phaser.GameObjects.Container
  /** The looping pulse on the aim board-frame — killed explicitly (Phaser 3.90 won't sweep it on destroy). */
  private bombAimTween?: Phaser.Tweens.Tween

  private autoplay = false
  private autoplayDelay = 450
  private activeBoosts: BoostType[] = []
  private scoreMult = 1
  private endless = false
  private endlessBest = 0
  private endlessDayKey = ''
  /** The week's ramp for this run's board (core/endlessramp.ts). Undefined on a numbered level. */
  private endlessShape?: EndlessShape

  // --- The endless cheat strip (core/cheat.ts) — dead space under the board that reads swipes ---
  /** Rolling matcher for the secret pattern; fed one swipe at a time, fires the mega win on a hit. */
  private cheatCode = new CheatSwipeCode()
  /** Where the live strip gesture started (world space), or null when no finger is on the strip. */
  private cheatFrom: { x: number; y: number } | null = null
  /** One swipe per touch: set once this gesture has been read, so a long drag can't feed the code twice. */
  private cheatConsumed = false
  /** Mega wins fired this run. Non-zero makes the run a PACED one — see finishEndless. */
  private cheatFires = 0
  /** A mega win is owed its Plinko drop: the next offer bypasses the latch and the roll. */
  private cheatDropPending = false

  /** The live over-board banner (boosts / MEGA WIN), so a second one replaces rather than stacks. */
  private boardBanner?: Phaser.GameObjects.Container
  /** A move was consumed this level — so a mid-level quit costs a life (numbered levels only). */
  private moveMade = false
  private apSched = 0
  private apFired = 0
  private apMoved = 0
  private dbgStage = ''
  private sid = 0

  private log(...args: unknown[]): void {
    if (import.meta.env.DEV) console.log(`[vm ${this.sid}]`, ...args)
  }

  constructor() {
    super('game')
  }

  init(data: { level?: number; endless?: boolean }): void {
    // The ?endless URL fallback only applies when no explicit level was routed in — otherwise
    // it would stick across scene.start('game', {level}) (the SPA URL never changes in DEV).
    this.endless =
      data?.endless === true ||
      (import.meta.env.DEV && data?.level == null && new URLSearchParams(location.search).has('endless'))
    this.level = Math.max(1, data?.level ?? 1)
    // Set HERE, in init(), not in create(): init runs first, so every piece of board geometry built
    // during create() — placement, mask, frame, RGB ring and the `rowAt` hit test — reads one
    // already-settled value. Assigning it inside create() would work only for as long as nothing
    // moved above the first read, which is exactly the kind of ordering nobody re-checks.
    this.boardTop = BOARD_Y + (this.endless ? ENDLESS_BOARD_DROP : 0)
  }

  create(): void {
    // Warm cream fade-in (never black) — the receiving half of every startScene cross-fade.
    this.cameras.main.fadeIn(this.prefersReducedMotion() ? 90 : 180, 255, 253, 248)
    this.sid = Math.floor(Math.random() * 10000)
    this.log('create', location.search, this.endless ? 'ENDLESS' : `level ${this.level}`)
    this.moveMade = false
    this.jackpotOccurred = false // §E4 — reset per round (scene.restart re-runs create, not field inits)
    this.heartbloomFired = false
    this.newBestThisWin = false

    // DEV: ?lives=N forces the pool before the gate check.
    if (import.meta.env.DEV) {
      const lv = new URLSearchParams(location.search).get('lives')
      if (lv !== null) devSetLives(Number(lv))
    }
    // Lives gate — a numbered level needs a life to enter (endless is never gated). Checked
    // BEFORE the board build / boost consume, so a gated entry never wastes a pending boost.
    if (!this.endless && refreshLives().lives <= 0) {
      this.showLivesGate()
      return
    }

    // Endless: a fixed-budget score attack on TODAY's shared, seeded board (same for
    // everyone). No objectives, no boosts (planting specials would change the board and
    // break the race's fairness). Otherwise: the numbered level with a fresh random board.
    if (this.endless) {
      // Capture the day key ONCE so the run is scored against the board it was seeded from,
      // even if the midnight handover (core/endless.ts RACE_TZ) passes mid-run.
      this.endlessDayKey = dayKey()
      // The week's ramp (core/endlessramp.ts): the board gets harder and less predictable Monday →
      // Sunday. A pure function of the day key, so every player still races the same board — the
      // move budget, the lock count and the lock cells are all shared, exactly as the layout is.
      this.endlessShape = endlessShapeFor(this.endlessDayKey)
      this.spec = { level: 0, moves: this.endlessShape.moves, symbolCount: SYMBOLS.length, objectives: [] }
      // The salt (core/racesalt.ts) is what stops this board being computable before the day opened.
      // Read synchronously from the prefetch cache; null falls back to the original unsalted board,
      // which stays playable and simply does not post — see `playedRealBoard`.
      this.board = new Board(
        ROWS,
        COLS,
        SYMBOLS.length,
        endlessBoardRng(this.endlessDayKey, cachedSalt(this.endlessDayKey))
      )
      // Seeded AFTER the board, from its own stream, so the locks land on top of the shared layout
      // instead of displacing it — see endlessramp.ts on the determinism trap.
      this.board.seedHazards(endlessLockPlan(this.endlessDayKey, ROWS, COLS))
      this.endlessBest = endlessBestForDay(loadSave(), this.endlessDayKey)
    } else {
      this.spec = levelSpec(this.level)
      this.board = new Board(ROWS, COLS, this.spec.symbolCount, mulberry32((Math.random() * 2 ** 31) | 0))
      // Hazards are numbered-levels-only, seeded once, never mid-level. Deliberately inside this
      // arm rather than behind a second `if (!this.endless)` — one fork, one place to delete.
      this.board.seedHazards(hazardPlan(this.level, ROWS, COLS))
    }
    this.coatsTotal = this.board.coatsRemaining()
    this.movesLeft = this.spec.moves
    // Placed AFTER the lives gate returns, so a bounced entry is not counted as an attempt — a level
    // the player couldn't even get into must not drag down its own win rate.
    if (this.endless) track(EVENTS.ENDLESS_START, { day: this.endlessDayKey })
    else track(EVENTS.LEVEL_START, { level: this.level, moves: this.spec.moves })
    this.objectives = this.spec.objectives.map(o => ({ symbol: o.symbol, remaining: o.count, total: o.count }))
    this.score = 0
    this.shownScore = 0
    this.scoreMilestone = 10000 // W3 — first gold milestone pop
    this.state = 'idle'
    this.sprites.clear()
    this.armedGlows.clear()
    this.goalGlows.clear()
    this.coatCells.clear()
    this.lockOverlays.clear()
    this.reducedMotion = this.prefersReducedMotion()
    this.hc = hcBoard() // §E12 — high-contrast board mode (darker floor + tints + thicker ring)
    this.hcRing = undefined // drop any stale ref from a prior create (restart doesn't re-init fields)
    this.introOpen = false
    this.reduceFlashing = prefReduceFlashing() // §E8 — wire the punch() flash gate to the real toggle
    this.selected = null
    this.selectedSprite = null
    this.selectPulse = null
    // B1/B2/B4 additive-cue state — drop any stale refs from a prior create (restart re-runs create,
    // not field inits); the objects themselves were destroyed with the previous scene.
    this.leanTweens = []
    this.leanHomes = []
    this.swipeTrail = null
    this.twinkleGleam = null
    this.twinkleMask = null
    this.twinkleTween = null
    this.nextTwinkleAt = 0
    this.dragFrom = null
    // Cheat strip — a restart re-runs create() but NOT the field initializers, so a half-entered
    // code (and the unranked verdict a previous run earned) must never carry into a fresh board.
    this.cheatCode.reset()
    this.cheatFrom = null
    this.cheatConsumed = false
    this.cheatFires = 0
    this.cheatDropPending = false
    this.boardBanner = undefined // its GameObject died with the previous scene
    // §G1 — a swap booked during the LAST level's final cascade must never fire into this one.
    this.bookedSwap = null
    this.bufferFrom = null
    this.bufferSelected = null
    this.bufferConsumed = false
    this.scoreMult = 1
    this.movesPulse = null
    // Combo readout is a scene GameObject — the old one was destroyed on restart, so drop the stale ref.
    this.comboText = undefined
    this.comboTween = null
    this.comboPeakTier = 0
    this.chainPoints = 0
    this.plinkoUsedThisLevel = false // a fresh level re-arms the bonus drop
    this.dealArmed = false // §11 — a restart re-runs create() but NOT the field initializers
    this.freeSpinBadge = undefined // scene GameObject from a prior round — died with that scene
    // §R3 score-medallion pool: its slots' GameObjects (Text/Image/Container) were destroyed with the
    // prior scene, so drop the stale refs and let takeMedallion rebuild. A restart re-runs create() but
    // NOT the field initializers — without this, spawnScorePopup reuses a destroyed Text and setText()
    // throws inside the resolve loop, wedging the board in 'resolving' (a permanent freeze).
    this.medallionPool = []
    this.medallionSeq = 0
    this.trauma = 0
    this.traumaDirX = 0
    this.traumaDirY = 0
    this.hitstopUntil = 0
    this.baseTimeScale = 1
    this.impactFlash = undefined
    this.cameraBreathTween = null // stale tween ref from a prior create (restart re-runs create, not field inits)
    this.boardKickTween = null
    this.boardKick = { y: 0 } // fresh holder — a prior scene's slam tween died with it
    this.cameras.main.setScroll(0, restScrollY())
    this.cameras.main.setZoom(1) // in case a prior round ended mid camera-breath
    this.activeBoosts = []
    // In-level helpers — drop any stale refs (scene.restart re-runs create, not field inits) + reset counters.
    this.powerBar = undefined
    this.powerItemsLayer = undefined
    this.powerCaption = undefined
    this.powerToastText = undefined
    this.purchasedMoves = 0
    this.pendingSpecialTeach = null // §G11 — never carry a queued card into the next level
    this.bombsUsed = 0 // §G4 — per-level cap, so it must reset with the level (field inits don't re-run)
    this.bombArmed = false
    this.bombAimLayer = undefined
    this.bombAimTween = undefined
    this.autoplay = import.meta.env.DEV && new URLSearchParams(location.search).has('auto')
    if (!this.endless) this.applyBoosts(takePendingBoosts())

    if (import.meta.env.DEV) {
      // URL knobs for automated checks: ?goal=N ?moves=N ?auto=MS ?plant=1
      const params = new URLSearchParams(location.search)
      const goal = Number(params.get('goal'))
      if (goal > 0) this.objectives.forEach(o => ((o.remaining = goal), (o.total = goal)))
      const moves = Number(params.get('moves'))
      if (moves > 0) this.movesLeft = moves
      this.autoplayDelay = Number(params.get('auto')) || 450
      // The embedded-pane clock is starved by visibility pauses; turbo multiplies
      // tween/timer time so automated checks advance at a usable pace.
      const turbo = Number(params.get('turbo'))
      if (turbo > 0) {
        this.tweens.timeScale = turbo
        this.time.timeScale = turbo
        this.baseTimeScale = turbo
      }
      if (params.has('plant')) {
        this.board.plant({ row: 6, col: 1 }, 'wildReelCol')
        this.board.plant({ row: 7, col: 1 }, 'diceBomb')
        this.board.plant({ row: 7, col: 2 }, 'jackpot')
      }
      // ?repro=upgrade (?repro=upgrade-col for the column reel) — the "swallowed special" case,
      // planted so it can be re-checked by hand. Column 3 holds the reel's own symbol at rows 1, 2
      // and 4 with a GAP at row 3 (so nothing is matched yet); the reel sits at (3,4). Swipe it one
      // cell LEFT into the gap and the column is four long — a match-4, which wants to spawn a new
      // reel on the cell the old one just landed on. The old reel must still blast its line on the
      // way out; it used to be overwritten in silence. Retries symbol pairs until the plant leaves
      // the board run-free, so the repro starts clean.
      const repro = params.get('repro')
      if (repro === 'upgrade' || repro === 'upgrade-col') {
        const kind = repro === 'upgrade-col' ? 'wildReelCol' : 'wildReelRow'
        const line = [
          { row: 1, col: 3 },
          { row: 2, col: 3 },
          { row: 4, col: 3 },
        ]
        const gap = { row: 3, col: 3 } // the reel's landing cell — swipe (3,4) → here
        const reel = { row: 3, col: 4 }
        const cells = [...line, gap, reel]
        const before = cells.map(at => this.board.get(at)!.symbol)
        // Stay inside the LEVEL's palette — a symbol the board can't refill would never return.
        const pal = SYMBOLS.slice(0, this.board.symbolCount)
        let clean = false
        for (const s of pal) {
          for (const other of pal) {
            if (other === s || clean) continue
            line.forEach(at => this.board.plant(at, 'normal', s))
            this.board.plant(gap, 'normal', other)
            this.board.plant(reel, kind, s)
            clean = this.board.findRuns().length === 0
          }
        }
        // No clean pair (vanishingly unlikely) — restore rather than start on a pre-matched board.
        if (!clean) cells.forEach((at, i) => this.board.plant(at, 'normal', before[i]))
        else this.log('repro=upgrade planted: swipe (3,4) LEFT')
      }
      // ?wheel — fire the full armed post-win wheel flow (mirrors ?race) so automated checks can
      // reach the spectacle without grinding five wins. Routes through continueAfterWin, so the
      // hitstop + chip-fountain hooks are exercised exactly as in production.
      if (params.has('wheel')) {
        this.time.delayedCall(600, () => {
          this.jackpotArmed = true
          this.continueAfterWin(() => {})
        })
      }
      // ?ticket=N — punch the "+N FREE SPINS" ticket beat on demand (presentation only; no award).
      const ticket = Number(params.get('ticket'))
      if (ticket > 0) this.time.delayedCall(700, () => this.freeSpinTicket(ticket))
      // ?chapter=N — play the chapter trophy ceremony on demand (presentation only; no award — the
      // balance readout re-ticks to its real value). ?chapter=30 is the car. Mirrors ?ticket.
      const chapter = Math.floor(Number(params.get('chapter')))
      if (chapter >= 1 && chapter <= CHAPTER_COUNT) {
        this.time.delayedCall(700, () => {
          const trophy = trophyFor(chapter)
          if (!trophy) return
          this.chapterCeremony(
            {
              chapter,
              trophy,
              purse: CHAPTER_PURSES[chapter - 1] ?? 0,
              boost: CHAPTER_BOOSTS[chapter] ?? null,
              balance: loadSave().chips,
            },
            () => {}
          )
        })
      }
      // ?plinko[=PTS] — drop the Plinko board on demand (mirrors ?wheel) so automated checks can reach
      // it without grinding for a chain. Routes through the real open path, so the award, the rigged
      // landing and the board handback are all exercised exactly as in production. Pair with ?slot=N
      // (read inside view/plinko.ts) to pin the landing slot.
      if (params.has('plinko')) {
        const stake = Number(params.get('plinko')) || 2000
        // Wait for a settled board (the level intro owns the opening beat) so the drop borrows the
        // board from exactly the state the resolve loop would hand it over in.
        const fire = (): void => {
          if (this.state !== 'idle') {
            this.time.delayedCall(300, fire)
            return
          }
          this.state = 'resolving'
          this.chainPoints = stake
          this.offerPlinko(99, true)
        }
        this.time.delayedCall(900, fire)
      }
      // ?deal — open the Lucky Deal on demand (mirrors ?wheel / ?plinko), through the real offer path
      // so the award-first banking, the rigged deck and the win-card handback are all exercised as in
      // production. Pair with ?face=ID (read inside view/deal.ts) to pin the winning face, which is
      // the only way to reach the CHARM and SERIES COMPLETE payoffs without grinding for a 3% card.
      if (params.has('deal')) {
        this.time.delayedCall(600, () => {
          this.dealArmed = true
          this.continueAfterWin(() => {})
        })
      }
    }

    addCasinoBackdrop(this, 'game')
    this.buildBackdrop()
    this.buildCabinet()
    this.buildHud()
    // §R3: when the level intro will play (numbered level with objectives, full motion), the deal
    // is DEFERRED — the intro card runs over an empty tray, then the board builds in as it exits.
    // The same condition gates playLevelIntro inside showGoalCallout below.
    this.buildPieceLayer(this.wantsLevelIntro())
    this.buildParticles()
    if (!this.endless) this.buildPowerBar() // mid-level helper shelf below the jackpot meter (numbered levels only)

    // §C6 shared-element transition (destination half): if the tapped element (Home PLAY / a LevelSelect
    // chip) queued a focus, bloom ONE transient light from its on-screen spot into the board frame under
    // the camera fade-in. Consumed AFTER the board is built so it targets the real frame; the lives-gate
    // early-return above never reaches here, so a gated entry simply doesn't bloom (the next nav clears
    // the queue). No focus (every other nav) or reduced motion → the guard skips it and the flat cream
    // cross-fade is byte-for-byte today's. The `!reducedMotion` is a second guard behind startScene's own.
    const focus = consumeFocus()
    if (focus && !this.reducedMotion) this.playFocusBloom(focus)

    if (this.scoreMult > 1) {
      this.add
        .text(BOARD_X + BOARD_W - 128, 66, '×2', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: getTheme().goldText })
        .setOrigin(1, 0)
    }
    if (this.activeBoosts.length > 0) this.showBoostBanner(this.activeBoosts)
    // §G7 — the goal callout stays HERE, before the idle-handoff check below, because
    // `playLevelIntro` also owns the board deal-in and the handoff itself. The teach cards are what
    // move: they now run on its settle (see `teachAfterIntro`) instead of on top of it.
    this.showGoalCallout(() => this.teachAfterIntro())
    this.maybeOccasion() // §E9 special-date dress-up (dormant unless an occasion is configured for today)

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p))
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p))
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p))

    if (import.meta.env.DEV) {
      this.updateDebug()
      this.time.addEvent({ delay: 300, loop: true, callback: () => this.updateDebug() })
    }
    // The animated deal-in sets state='resolving' and owns the idle handoff (autoplay + hint) once
    // the board finishes assembling; an instant fill (reduced motion) leaves us idle → hand off now.
    if (this.state === 'idle') {
      this.scheduleAutoplay()
      this.armHint()
    }

  }

  /**
   * §G7 — the teach cards, run ONE AT A TIME once the level intro has settled.
   *
   * They used to fire in `create()` in the same frame as the goal callout: the callout drew the
   * "COLLECT ×N" card at depth 44 and `maybeOnboarding` then drew an opaque card at depth 65 straight
   * over it — and the goal card self-destructs on a timer, so by the time a brand-new player
   * dismissed the teach card the one screen that says what to collect had already gone. The player
   * most in need of the goal card was the only one guaranteed never to see it.
   *
   * Order: HOW TO PLAY (the rules) before the hazard card (the exception to them). Each card owns
   * the handoff to the next, so two are never up together either.
   */
  private teachAfterIntro(): void {
    if (!this.scene.isActive()) return
    const hazard = (): void => void this.maybeHazardIntro(() => {})
    if (!this.maybeOnboarding(hazard)) hazard()
  }

  /**
   * §C6 shared-element transition (destination half). The tapped element (Home PLAY / a LevelSelect
   * chip) queued a `focus`; here we bloom ONE soft transient light from its on-screen spot INTO the
   * board frame as the camera cross-fades in, giving spatial continuity ("the thing I tapped opened
   * into the board"). Strictly additive + self-cleaning:
   *   • Reached only WITH a real focus AND when motion is allowed (double-guarded — startScene never
   *     queues a focus under reduced motion, and the create() call site re-checks `reducedMotion`), so
   *     the no-focus / calm path never runs this and the flat cream cross-fade stays byte-for-byte today's.
   *   • ONE additive `bgglow` sprite (the app's house glow idiom, reused — no new asset), tweened
   *     origin→board-centre while it grows + fades, then DESTROYED on arrival (no leak). It's a plain
   *     display image (never interactive), so the transition's existing input-lock is untouched.
   *   • Depth 36: above the board (container depth 0) + HUD (≤34), below every overlay/onboarding (38+/65).
   * A missing `bgglow` (can't happen post-backdrop) → no bloom, i.e. silently the flat fade.
   */
  private playFocusBloom(focus: SceneFocus): void {
    if (!this.textures.exists('bgglow')) return
    // Board-frame centre in world space (cameras share restScrollY, so the queued world coords line up).
    const bx = BOARD_X + BOARD_W / 2
    const by = this.boardTop + (ROWS * CELL) / 2
    const bloom = this.add
      .image(focus.x, focus.y, 'bgglow')
      .setDepth(36)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(focus.tint ?? getTheme().gold)
      .setDisplaySize(focus.w * 1.2, focus.h * 1.2)
      .setAlpha(0.5)
    // Grow to ~the board frame in BOTH axes (independent factors, so a wide PLAY and a square chip both
    // settle board-sized) while gliding to the board centre and fading out beneath the camera fade-in.
    this.tweens.add({
      targets: bloom,
      x: bx,
      y: by,
      scaleX: bloom.scaleX * ((BOARD_W * 1.05) / (focus.w * 1.2)),
      scaleY: bloom.scaleY * ((BOARD_W * 1.05) / (focus.h * 1.2)),
      alpha: 0,
      duration: 340,
      ease: 'Cubic.easeInOut',
      onComplete: () => bloom.destroy(),
    })
  }

  /**
   * §E14 first-run onboarding: show the gentle teach-card ONCE, and only for a TRULY-NEW player —
   * `seenIntro` still false AND still on level 1 (`unlocked <= 1`). The second clause is the guard
   * that keeps it from ever popping for an existing player mid-progress (Maya at Level 46 has
   * `unlocked = 47`). Never in endless. Marked seen immediately (so it can't re-show even if the card
   * is dismissed by tapping away), then rendered; `introOpen` gates board taps while it's up.
   */
  private maybeOnboarding(then: () => void): boolean {
    if (this.endless) return false
    const save = loadSave()
    if (save.seenIntro || save.unlocked > 1) return false
    save.seenIntro = true
    persistSave(save)
    this.introOpen = true
    openOnboarding(this, () => {
      this.introOpen = false
      then() // §G7 — the card owns the handoff; the goal callout runs once the player has read this
    })
    return true
  }

  /**
   * Teach each new board mechanic ONCE, the first time a level actually contains it.
   *
   * Gated on what is really on this board, not on the level number, so a player who jumps ahead (or
   * whose flags were changed) is never shown a rule for something they cannot see. The latch is
   * persisted IMMEDIATELY, before the card renders — same discipline as `maybeOnboarding` — so
   * dismissing by tapping away cannot make it re-appear. Never in endless, which has no hazards.
   */
  /**
   * §G11 — record that the player has just MADE a special of this kind, if it is their first ever.
   * Called from `playWave`; the card is deferred to the idle handoff by `maybeSpecialIntro`.
   *
   * The latch is persisted here, at the moment of the match, rather than when the card renders —
   * same discipline as the hazard and onboarding cards, so quitting mid-cascade cannot make the
   * card queue up again on the next level.
   */
  private noteSpecialMade(kind: PieceKind): void {
    if (this.endless || this.pendingSpecialTeach) return
    const teachKey = specialTeachKey(kind)
    if (!teachKey) return
    const save = loadSave()
    if (save.specialIntros.includes(teachKey)) return
    save.specialIntros.push(teachKey)
    persistSave(save)
    this.pendingSpecialTeach = { key: teachKey, kind }
  }

  /**
   * §G11 — show the queued special-piece teach card, if one is waiting. Returns true if it took the
   * screen (the caller must then leave the handoff to the card, exactly like `flushBookedSwap`).
   *
   * The Wild Reel, Dice Bomb and Jackpot Chip are the best thing about this board and the reason
   * cascades are worth chasing, and the game explained them nowhere except one line in a passive
   * help panel nobody opens. The hazard system already had a just-in-time teach card; the specials
   * were simply never wired into it.
   */
  private maybeSpecialIntro(): boolean {
    const pending = this.pendingSpecialTeach
    if (!pending || this.introOpen || !this.scene.isActive()) return false
    this.pendingSpecialTeach = null
    this.introOpen = true
    // The card shows the REAL art for the piece they just made, at board scale.
    const texture = ensurePieceTexture(this, { id: -1, kind: pending.kind, symbol: SYMBOLS[0] })
    openSpecialIntro(this, pending.key, texture, () => {
      this.introOpen = false
      this.scheduleAutoplay()
      this.armHint()
    })
    return true
  }

  private maybeHazardIntro(then: () => void): boolean {
    if (this.endless || this.introOpen) return false
    const present: HazardKind[] = []
    if (this.board.coatsRemaining() > 0) present.push('coat')
    for (let r = 0; r < ROWS && present.length < 3; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.board.get({ row: r, col: c })
        if (p?.kind === 'blocker' && !present.includes('blocker')) present.push('blocker')
        if (p?.locked && !present.includes('lock')) present.push('lock')
      }
    }
    const save = loadSave()
    const unseen = present.find(k => !save.hazardIntros.includes(k))
    if (!unseen) return false
    save.hazardIntros.push(unseen)
    persistSave(save)
    this.introOpen = true
    openHazardIntro(this, unseen, () => {
      this.introOpen = false
      then() // §G7 — see maybeOnboarding
    })
    return true
  }

  /**
   * Out-of-lives screen (numbered levels only) — a warm "take a break" with a live
   * countdown to the next life. When one regenerates, a PLAY button appears. The
   * countdown is wall-clock based (refreshLives reads Date.now), so it stays correct
   * even if the timer tick is throttled while the tab is hidden.
   */
  private showLivesGate(): void {
    this.log('showLivesGate')
    const T = getTheme()
    const reduced = this.prefersReducedMotion()
    this.cameras.main.setScroll(0, restScrollY())
    addCasinoBackdrop(this, 'menu')
    addPillButton(this, 64, 84, 84, 56, '‹', GHOST_PILL, () => startScene(this,'home'))
    addMuteChip(this, 676, 40)

    this.add
      .text(DESIGN_W / 2, 320, 'TAKE A BREAK', { fontFamily: FONT, fontSize: '56px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(90,70,20,0.25)', 6, false, true)
    this.add
      .text(DESIGN_W / 2, 384, 'Out of lives — they refill on their own', { fontFamily: FONT, fontSize: '24px', color: T.onBackdropMuted })
      .setOrigin(0.5)

    const emblem = this.add.image(DESIGN_W / 2, 560, 'heartbig').setDisplaySize(150, 150).setTint(0x8a7a52).setAlpha(reduced ? 0.5 : 0.4)
    if (!reduced) {
      this.tweens.add({ targets: emblem, alpha: 0.65, scale: emblem.scaleX * 1.05, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }

    const hud = addLivesHud(this, DESIGN_W / 2, 700, { size: 46, showTimer: false })
    const nextText = this.add
      .text(DESIGN_W / 2, 782, '', { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: T.onBackdropInk })
      .setOrigin(0.5)
    const fullText = this.add
      .text(DESIGN_W / 2, 828, '', { fontFamily: FONT, fontSize: '22px', color: T.onBackdropMuted })
      .setOrigin(0.5)
    let playBtn: Phaser.GameObjects.Container | null = null

    // §G10 — a way THROUGH the wall, not just a clock. Every genre benchmark pairs an energy gate
    // with an out (gems / an ad / asking a friend); this screen had none, so the only affordance on
    // it was "close the app for up to 20 minutes". The currency and `grantLife` both already
    // existed — `grantLife` had literally zero callers anywhere in the codebase.
    //
    // Shown only when it is actionable (affordable), for the same reason the continue offer is: with
    // no cash purchase behind it, an offer the player cannot take is just a taunt.
    let refillBtn: Phaser.GameObjects.Container | null = null
    let priceRow: Phaser.GameObjects.Container | null = null
    const clearRefill = (): void => {
      refillBtn?.destroy()
      priceRow?.destroy()
      refillBtn = null
      priceRow = null
    }
    const buyLife = (): void => {
      if (spendChips(LIFE_REFILL_PRICE) === null) return
      grantLife()
      sfx.lifeRestored()
      this.vibrate(30)
      clearRefill()
      tick() // re-render the HUD + surface PLAY immediately, rather than up to a second later
    }

    const tick = (): void => {
      const st = refreshLives()
      hud.update(st)
      if (st.lives > 0) {
        nextText.setText('A life is ready!')
        fullText.setText('')
        clearRefill() // a life arrived on its own — retire the offer rather than take chips for it
        if (!playBtn) {
          playBtn = addPillButton(this, DESIGN_W / 2, 924, 320, 88, 'PLAY', GOLD_PILL, () =>
            startScene(this,'game', { level: this.level })
          )
          if (!reduced) {
            this.tweens.add({ targets: playBtn, scale: 1.05, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
          }
        }
      } else {
        nextText.setText(`Next life in  ${formatCountdown(st.nextInMs)}`)
        fullText.setText(`Full in  ${formatCountdown(st.fullInMs)}`)
        if (!refillBtn && loadSave().chips >= LIFE_REFILL_PRICE) {
          refillBtn = addPillButton(this, DESIGN_W / 2, 924, 320, 88, 'REFILL A HEART', GOLD_PILL, buyLife)
          priceRow = this.add.container(DESIGN_W / 2, 1000)
          const price = this.add
            .text(14, 0, String(LIFE_REFILL_PRICE), { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: T.onBackdropInk })
            .setOrigin(0, 0.5)
          priceRow.add([this.add.image(-12, 0, 'chip').setDisplaySize(36, 36), price])
        }
      }
    }
    tick()
    this.time.addEvent({ delay: 1000, loop: true, callback: tick })
  }

  /**
   * In-game back button: a mid-level quit AFTER a move spends a life (numbered levels only).
   * Only when the board is settled (idle) — mid-resolve, finishWin/finishLose is the single
   * source of truth for the outcome, so we must not pre-charge a move that's about to WIN
   * (wins are free) or double-charge one that's about to lose.
   */
  private exitToLevels(): void {
    if (!this.endless && this.state === 'idle' && this.moveMade) {
      spendLifeFor(this.level)
      // Same two events, same two costs: whatever spends a life also breaks the streak, so "what
      // broke my streak" never needs a second rule to explain — and quitting can't dodge it.
      resetWinStreak()
    }
    // Tracked separately from level_fail: walking away reads very differently from being beaten, and
    // a level with a high QUIT rate but a normal loss rate is a boredom/confusion problem, not a
    // difficulty one. Lumping them together would hide that distinction entirely.
    if (!this.endless) track(EVENTS.LEVEL_QUIT, { level: this.level, moved: this.moveMade })
    startScene(this,'levelselect')
  }

  /** DEV only: expose model state via DOM (dataset + visible strip) for external tooling. */
  private updateDebug(): void {
    if (!import.meta.env.DEV) return
    const hint = this.board.findFirstValidMove()
    const describe = (c: Coord) => `${this.board.get(c)?.symbol}@(${c.row},${c.col})`
    const obj = this.objectives.map(o => `${o.symbol}:${o.remaining}`).join(',')
    const text = `L${this.level} ${this.state} [${this.dbgStage}] mv=${this.movesLeft} sc=${this.score} obj=${obj} hint=${
      hint ? `${describe(hint.a)}->${describe(hint.b)}` : 'none'
    }`
    document.body.dataset.vegas = JSON.stringify({
      level: this.level,
      state: this.state,
      moves: this.movesLeft,
      score: this.score,
      objectives: this.objectives.map(o => ({ symbol: o.symbol, remaining: o.remaining })),
      hint,
    })
    let el = document.getElementById('dbg')
    if (!el) {
      el = document.createElement('div')
      el.id = 'dbg'
      el.style.cssText =
        'position:fixed;top:0;left:0;background:#000c;color:#0f0;font:12px monospace;padding:2px 6px;z-index:9;pointer-events:none'
      document.body.appendChild(el)
    }
    el.textContent = text
  }

  /** Daily-spin prizes: head starts applied to this level, consumed win or lose. */
  private applyBoosts(boosts: BoostType[]): void {
    if (boosts.length === 0) return
    this.activeBoosts = boosts
    const usedCells = new Set<string>()
    const plantAt = (kind: 'wildReelRow' | 'wildReelCol' | 'diceBomb' | 'jackpot') => {
      for (let tries = 0; tries < 20; tries++) {
        const at = { row: 3 + Math.floor(Math.random() * 5), col: Math.floor(Math.random() * COLS) }
        const cellKey = `${at.row},${at.col}`
        if (usedCells.has(cellKey)) continue
        usedCells.add(cellKey)
        this.board.plant(at, kind)
        return
      }
    }
    for (const boost of boosts) {
      if (boost === 'extraMoves') this.movesLeft += 5
      else if (boost === 'doubleScore') this.scoreMult = 2
      else if (boost === 'wildReel') plantAt(Math.random() < 0.5 ? 'wildReelRow' : 'wildReelCol')
      else if (boost === 'diceBomb') plantAt('diceBomb')
      else if (boost === 'jackpot') plantAt('jackpot')
    }
  }

  private boostLabel(boost: BoostType): string {
    switch (boost) {
      case 'extraMoves':
        return '+5 moves'
      case 'doubleScore':
        return '2x score'
      case 'wildReel':
        return 'Wild Reel planted'
      case 'diceBomb':
        return 'Dice Bomb planted'
      case 'jackpot':
        return 'Jackpot Chip planted'
    }
  }

  /** Level-start banner announcing the daily-spin boosts. */
  private showBoostBanner(boosts: BoostType[]): void {
    this.showBoardBanner(`🎁  ${boosts.map(b => this.boostLabel(b)).join('   ·   ')}`)
  }

  /**
   * A self-sizing gold pill that pops in over the top of the board, holds, then fades up — sits
   * below the HUD so it never collides with the moves/objective chips (the old flat toast at
   * BOARD_Y-44 overlapped that row). Scales down if the label runs wider than the board.
   *
   * Shared by the boost announcement and the cheat strip's MEGA WIN: the two are the same beat — a
   * thing just happened TO this board, before you touched it — and should read as one. Only one is
   * ever up, so a second banner replaces the first rather than stacking on it (two mega wins in
   * quick succession being the case that can actually reach this).
   */
  private showBoardBanner(label: string): void {
    const T = getTheme()
    // Tweens first: Phaser 3.90 does not sweep tweens whose target has been destroyed, so the
    // outgoing banner's pending pop/fade pair has to be killed before the object goes.
    if (this.boardBanner) {
      this.tweens.killTweensOf(this.boardBanner)
      this.boardBanner.destroy()
    }
    const banner = this.add.container(DESIGN_W / 2, this.boardTop + 72).setDepth(31)
    this.boardBanner = banner
    const text = this.add
      .text(0, 0, label, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
    const w = text.width + 56
    const h = 64
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.2)
    g.fillRoundedRect(-w / 2 + 2, -h / 2 + 5, w, h, h / 2)
    g.fillStyle(T.cardFill, 0.98)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.lineStyle(3, T.goldBezel, 1)
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    banner.add([g, text])
    const fit = Math.min(1, (BOARD_W + 20) / w)
    banner.setScale(0)
    this.tweens.add({ targets: banner, scale: fit, duration: 320, ease: 'Back.easeOut' })
    this.tweens.add({
      targets: banner,
      alpha: 0,
      y: banner.y - 26,
      delay: 2400,
      duration: 500,
      onComplete: () => {
        if (this.boardBanner === banner) this.boardBanner = undefined
        banner.destroy()
      },
    })
  }

  /**
   * §R3 — true when the full level-intro beat plays this round: a numbered level with objectives,
   * full motion. The SAME predicate gates the deferred deal in create() and playLevelIntro below,
   * so the board can never end up both un-dealt and intro-less.
   */
  private wantsLevelIntro(): boolean {
    return !this.reducedMotion && !this.endless && this.objectives.length > 0
  }

  /**
   * Level-start "COLLECT" callout. Under reduced motion this is the original instant card exactly
   * (shown at rest, gone after ~1.4s, board already filled instantly). Otherwise it upgrades into
   * the full §R3 LEVEL INTRO (playLevelIntro): scrim + card pop, goal counters ticking up, a
   * "get ready" heart cameo, a light-sweep exit — and THEN the board builds in as a fast diagonal
   * wave. No-op in endless / when there are no objectives.
   */
  /** `onSettled` fires once the intro has finished and the board is playable (§G7 teach-card cue). */
  private showGoalCallout(onSettled: () => void = () => {}): void {
    if (this.endless || this.objectives.length === 0) {
      onSettled()
      return
    }
    if (!this.reducedMotion) {
      this.playLevelIntro(onSettled)
      return
    }
    // Reduced motion — the instant resting card, byte-for-byte the old behaviour.
    const { layer, fit } = this.buildGoalCard(false)
    layer.setScale(fit)
    this.time.delayedCall(1400, () => {
      layer.destroy()
      onSettled()
    })
  }

  /**
   * Build the goal card layer (cream panel + COLLECT header + goal icons + ×N counters), shared by
   * the reduced-motion instant callout and the full intro. `withReady` adds the intro-only
   * "get ready" row (small heart cameo + caption) and grows the panel to fit it. Returns the parts
   * the intro choreographs; the reduced path only uses `layer` + `fit`.
   */
  private buildGoalCard(withReady: boolean): {
    layer: Phaser.GameObjects.Container
    icons: Phaser.GameObjects.Image[]
    counts: Phaser.GameObjects.Text[]
    ready: Array<Phaser.GameObjects.Image | Phaser.GameObjects.Text>
    heart: Phaser.GameObjects.Image | null
    fit: number
    w: number
    halfH: number
  } {
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = this.boardTop + BOARD_W * 0.36
    const layer = this.add.container(cx, cy).setDepth(44)

    const headY = withReady ? -84 : -66
    const iconY = withReady ? -6 : 8
    const header = this.add
      .text(0, headY, 'COLLECT', { fontFamily: FONT, fontSize: '32px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setLetterSpacing(5)
      .setShadow(0, 3, 'rgba(90,70,20,0.22)', 5, false, true)
    const content: Phaser.GameObjects.GameObject[] = [header]
    const icons: Phaser.GameObjects.Image[] = []
    const counts: Phaser.GameObjects.Text[] = []

    const iconSize = 80
    const gap = 34
    const n = this.objectives.length
    const rowW = n * iconSize + (n - 1) * gap
    const startX = -rowW / 2 + iconSize / 2
    this.objectives.forEach((o, i) => {
      const ix = startX + i * (iconSize + gap)
      const icon = this.add.image(ix, iconY, o.symbol).setDisplaySize(iconSize, iconSize)
      const count = this.add
        .text(ix, iconY + iconSize / 2 + 22, `×${o.total}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.navyText })
        .setOrigin(0.5)
      icons.push(icon)
      counts.push(count)
      content.push(icon, count)
    })

    // Intro-only "get ready" row: a small heart-emblem cameo + caption below the counters.
    const ready: Array<Phaser.GameObjects.Image | Phaser.GameObjects.Text> = []
    let heart: Phaser.GameObjects.Image | null = null
    if (withReady) {
      const readyY = iconY + iconSize / 2 + 66
      const caption = this.add
        .text(16, readyY, 'GET READY…', { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.goldText })
        .setOrigin(0.5)
        .setLetterSpacing(3)
      heart = this.add.image(caption.x - caption.width / 2 - 26, readyY, 'heartbig').setDisplaySize(30, 30)
      ready.push(heart, caption)
      content.push(heart, caption)
    }

    const w = Math.max(header.width, rowW) + 84
    const halfH = withReady ? 122 : 96
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.22)
    g.fillRoundedRect(-w / 2 + 3, -halfH + 8, w, halfH * 2, 30)
    g.fillStyle(T.cardFill, 0.98)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 30)
    g.lineStyle(3, T.goldBezel, 1)
    g.strokeRoundedRect(-w / 2, -halfH, w, halfH * 2, 30)
    layer.add(g)
    layer.add(content)

    const fit = Math.min(1, (BOARD_W + 16) / w)
    return { layer, icons, counts, ready, heart, fit, w, halfH }
  }

  /**
   * §R3 LEVEL INTRO — the proper opening moment on a numbered level, replacing the old
   * pop-hold-fade callout. Choreography (all tween-scheduled, tap-to-skip anywhere; R4-tightened so
   * input unlocks ≤1.5s from entry — the get-ready hold is short and the board assembles UNDER the
   * departing card, never after it):
   *   1. A warm theme scrim settles over the empty tray; the goal card pops in.
   *   2. Goal icons pop in staggered; each ×N counter TICKS UP from ×0 to its total.
   *   3. The "get ready" row fades up; the heart cameo gives one lub-dub double pulse.
   *   4. A light sweep crosses the card; card + scrim exit; and as they go the BOARD BUILDS IN —
   *      a fast diagonal stagger wave (top-left → bottom-right, < 600ms) with per-column landing
   *      thunks + floor dust, then input unlocks.
   * A tap at ANY point kills every intro tween, destroys the transients, snaps all 64 pieces to
   * rest and unlocks immediately (the settle-actions discipline: kill → destroy → snap → handoff).
   * Never runs under reduced motion (showGoalCallout keeps the instant card + instant fill).
   */
  private playLevelIntro(onSettled: () => void = () => {}): void {
    const T = getTheme()
    const { layer, icons, counts, ready, heart, fit, w } = this.buildGoalCard(true)
    const cy = layer.y
    // Warm scrim between board and card — same idiom as the win overlay's (depth 40 < card 44).
    // Full fillAlpha baked into the fill, object alpha drives the fade (fill × object multiply).
    const scrim = this.add.rectangle(DESIGN_W / 2, viewportCenterY(), DESIGN_W, worldH(), T.scrim, 0.32).setDepth(40)
    scrim.setAlpha(0)
    const introTweens: Phaser.Tweens.Tween[] = []
    const tw = (cfg: Record<string, unknown>): void => {
      introTweens.push(this.tweens.add(cfg as unknown as Phaser.Types.Tweens.TweenBuilderConfig))
    }

    let done = false
    let skipped = false
    let waveStarted = false

    // Final settle: unlock the board + retire the skip listener (idempotent).
    const handoff = (): void => {
      if (done || !this.scene.isActive()) return
      done = true
      this.input.off('pointerdown', skip)
      this.state = 'idle'
      this.scheduleAutoplay()
      this.armHint()
      onSettled() // §G7 — the board is playable; now (and only now) a teach card may take the screen
    }

    // The build-in wave: every piece born at its own cell, dropping in a short third-of-a-cell
    // with a gentle Back settle, staggered along the (row+col) diagonal — the whole board
    // assembles in ≈ 560ms (14 bands × 24ms + 220ms settle), never slow on replay.
    const dealWave = (): void => {
      if (done || skipped || waveStarted) return
      waveStarted = true
      const STEP = 24
      const total = ROWS * COLS
      let landed = 0
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const at = { row: r, col: c }
          const sprite = this.createSprite(this.board.get(at)!, at)
          const to = this.cellToXY(at)
          sprite.setPosition(to.x, to.y - CELL * 0.34).setAlpha(0)
          sprite.setScale(PIECE_SCALE * 0.6)
          this.tweens.add({
            targets: sprite,
            y: to.y,
            alpha: 1,
            scaleX: PIECE_SCALE,
            scaleY: PIECE_SCALE,
            delay: (r + c) * STEP,
            duration: 220,
            ease: backOut(OVERSHOOT.gentle),
            onComplete: () => {
              // One thunk + dust puff per column as its deepest cell lands — the wave's rhythm.
              if (r === ROWS - 1) {
                sfx.land(0.4, this.colPan(c))
                this.floorDust(to.x, to.y, 3)
              }
              if (++landed >= total) handoff()
            },
          })
        }
      }
    }

    // Tap-to-skip: kill intro tweens FIRST (Phaser 3.90 never sweeps tweens for destroyed
    // targets — `remove()` is parent-guarded, so already-finished ones are a safe no-op), drop the
    // transients, snap all 64 pieces to rest, unlock. The unlock itself is deferred a microtask so
    // the very tap that skipped can't fall through to onDown as a board tap (state is still
    // 'resolving' while this dispatch loop runs).
    const skip = (): void => {
      if (done || skipped) return
      skipped = true
      for (const t of introTweens) t.remove()
      this.tweens.killTweensOf(scrim)
      scrim.destroy()
      layer.destroy(true) // children's tweens are all in introTweens (already removed)
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const at = { row: r, col: c }
          const piece = this.board.get(at)!
          const sprite = this.sprites.get(piece.id) ?? this.createSprite(piece, at)
          this.tweens.killTweensOf(sprite)
          const to = this.cellToXY(at)
          sprite.setPosition(to.x, to.y).setScale(PIECE_SCALE).setAlpha(1)
        }
      }
      void Promise.resolve().then(handoff)
    }
    this.input.on('pointerdown', skip)

    // ---- Beat 1 (0–320ms): scrim settles, card pops. ----------------------------------------
    tw({ targets: scrim, alpha: 1, duration: 200, ease: E.settle })
    layer.setScale(0)
    tw({ targets: layer, scale: fit, duration: 320, ease: backOut(OVERSHOOT.pop) })
    sfx.uiTap()

    // ---- Beat 2 (200–940ms): icons pop in staggered; counters tick up to their totals. ------
    icons.forEach((icon, i) => {
      const s0 = icon.scaleX
      icon.setScale(0)
      tw({ targets: icon, scale: s0, delay: 200 + i * 80, duration: 260, ease: backOut(OVERSHOOT.pop) })
    })
    counts.forEach((count, i) => {
      const total = this.objectives[i].total
      count.setText('×0')
      const proxy = { v: 0 }
      let shown = 0
      tw({
        targets: proxy,
        v: total,
        delay: 280 + i * 80,
        duration: 340,
        ease: E.glide,
        onUpdate: () => {
          const v = Math.round(proxy.v)
          if (v !== shown) {
            shown = v
            count.setText(`×${v}`)
          }
        },
        onComplete: () => {
          count.setText(`×${total}`)
          sfx.scoreTick()
          count.setScale(1)
          tw({ targets: count, scale: 1.22, duration: 90, yoyo: true, ease: E.press })
        },
      })
    })

    // ---- Beat 3 (520–960ms): "get ready" rises; the heart gives one lub-dub. ----------------
    // R4-tightened: the row rides in while the counters are still ticking and the hold is one
    // heartbeat, not two — the intro promises "ready" and then IS ready.
    for (const item of ready) {
      const y0 = item.y
      item.setAlpha(0)
      item.setY(y0 + 10)
      tw({ targets: item, alpha: 1, y: y0, delay: 520, duration: 220, ease: E.release })
    }
    if (heart) {
      const hs = heart.scaleX
      tw({ targets: heart, scaleX: hs * 1.22, scaleY: hs * 1.22, delay: 660, duration: 110, yoyo: true, repeat: 1, ease: E.hero })
    }

    // ---- Beat 4 (720ms+): light sweep → card + scrim exit → the board builds in. ------------
    // R4-tightened (audit: input was gated ≈2.4s): the sweep fires right off the heart's lub-dub and
    // the build-in wave starts UNDER the card exit at ~860ms, so the full unlock lands ≈1.45s.
    // The sweep's alpha yoyos 0 → 0.55 → 0 across the same window as its travel, so it is only
    // bright mid-card and effectively invisible where it overhangs the rounded corners (no mask).
    const travel = w / 2 + 20
    const sweep = this.add
      .image(-travel, 0, 'sweep')
      .setDisplaySize(64, 300)
      .setAngle(14)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0)
    layer.add(sweep)
    tw({ targets: sweep, x: travel, delay: 720, duration: 200, ease: E.glide })
    tw({ targets: sweep, alpha: 0.55, delay: 720, duration: 100, yoyo: true, ease: E.hero })
    tw({
      targets: layer,
      alpha: 0,
      y: cy - 26,
      scale: fit * 0.94,
      delay: 860,
      duration: 240,
      ease: E.exit,
      onStart: () => {
        sfx.whoosh(0)
        dealWave() // the board assembles UNDER the departing card — no dead beat
      },
      onComplete: () => {
        if (!done) layer.destroy(true)
      },
    })
    tw({
      targets: scrim,
      alpha: 0,
      delay: 860,
      duration: 260,
      ease: E.exit,
      onComplete: () => {
        if (!done) scrim.destroy()
      },
    })
  }

  /**
   * An objective just hit zero: retire its "target" emphasis. Stops + fades the chip's gold
   * breathe glow and drops every on-board goal halo for that symbol (the chip's green ✓ is set by
   * the caller and stays). New spawns of a completed symbol never re-highlight (createSprite gates
   * on remaining > 0).
   */
  private onObjectiveComplete(o: ObjectiveState): void {
    o.pulse?.stop()
    o.pulse = undefined
    if (o.glow) {
      const glow = o.glow
      o.glow = undefined
      this.tweens.add({
        targets: glow,
        alpha: 0,
        duration: 260,
        ease: 'Quad.easeOut',
        onComplete: () => glow.destroy(),
      })
    }
    for (const [id, halo] of this.goalGlows) {
      if (halo.getData('sym') === o.symbol) {
        halo.destroy()
        this.goalGlows.delete(id)
      }
    }
  }

  /**
   * E10 collect-fly, landing step (final): snap an objective's VISIBLE chip to its model value —
   * set the number (or ✓), pop the chip, gold-flash the number, and on completion retire the target
   * emphasis + fire the objective-complete stamp. Used directly under reduced motion / when a flyer
   * isn't in budget, and as the last collect flyer's arrival.
   */
  private settleCollect(o: ObjectiveState): void {
    o.shown = o.remaining
    o.text?.setText(o.remaining > 0 ? String(o.remaining) : '✓')
    if (o.chip && o.chip.scale === 1) {
      this.tweens.add({ targets: o.chip, scale: 1.14, duration: 120, yoyo: true, ease: this.reducedMotion ? 'Quad.easeOut' : backOut(OVERSHOOT.gentle) })
    }
    if (o.remaining > 0) {
      // C5 · one subtle rising "almost there" tone as this objective crosses into its final piece(s).
      // Latched (remaining only ever decreases) so it fires exactly once per objective — rare + meaningful.
      // Objectives that begin at/under the threshold (e.g. total 1) simply complete and never "approach".
      if (o.remaining <= OBJECTIVE_NEAR && !o.nearFired) {
        o.nearFired = true
        sfx.objectiveNear()
      }
      // Gold flash — reverts to ink only while still incomplete (a completed chip keeps its green ✓).
      o.text?.setColor(css(getTheme().gold))
      this.time.delayedCall(160, () => o.remaining > 0 && o.text?.setColor(getTheme().ink))
    } else {
      o.text?.setColor(getTheme().ok)
      this.onObjectiveComplete(o)
      this.objectiveStamp(o)
    }
  }

  /** E10 collect-fly, intermediate step: a non-final flyer landed — tick the visible counter down
   *  one notch toward the model + pop the chip (completion is owned by the final flyer's settle). */
  private stepCollect(o: ObjectiveState): void {
    const shown = Math.max(o.remaining, (o.shown ?? o.remaining) - 1)
    o.shown = shown
    o.text?.setText(shown > 0 ? String(shown) : '✓')
    if (o.chip && o.chip.scale === 1) {
      this.tweens.add({ targets: o.chip, scale: 1.12, duration: 110, yoyo: true, ease: this.reducedMotion ? 'Quad.easeOut' : backOut(OVERSHOOT.gentle) })
    }
    if (o.remaining > 0) {
      o.text?.setColor(css(getTheme().gold))
      this.time.delayedCall(140, () => o.remaining > 0 && o.text?.setColor(getTheme().ink))
    }
  }

  /**
   * E10 collect-fly: arc `sources.length` small copies of an objective's symbol from their cleared
   * cells UP to the COLLECT chip (a lifted quadratic, reusing the symbol texture, self-destroying on
   * arrival). Each landing ticks the visible counter one step toward the model; the LAST to land
   * settles it (snap + completion stamp). Non-blocking — the model already decremented, so the
   * cascade + win detection never wait on these. Cap is enforced by the caller (≤3/wave).
   */
  private flyCollect(o: ObjectiveState, sources: Coord[]): void {
    const chip = o.chip
    if (!chip) {
      this.settleCollect(o)
      return
    }
    const targetX = chip.x
    const targetY = chip.y - 20 // the chip's symbol icon sits above its number
    const startScale = PIECE_SCALE * 0.7
    const total = sources.length
    let landed = 0
    // §R3 collect comet: each goal piece reads as LIGHT IN MOTION — an additive head glint riding
    // the flyer (brightening as it nears the counter) + a short spark tail (follow-emitter). Both
    // governor-gated: the LOW tier flies the bare symbol exactly as before. ≤3 flyers/wave (caller),
    // so at most 3 emitters live at once; each stops, un-follows and self-destroys on arrival.
    const T = getTheme()
    const dress = quality.count(1) > 0
    sources.forEach((at, i) => {
      const from = this.cellToXY(at)
      const flyer = this.add.image(from.x, from.y, o.symbol).setDepth(32).setScale(startScale)
      const head = dress
        ? this.add
            .image(from.x, from.y, 'glint')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setDepth(33)
            .setTint(T.goldBright)
            .setDisplaySize(CELL * 0.5, CELL * 0.5)
            .setAlpha(0.55)
        : null
      const tail = dress
        ? this.add
            .particles(0, 0, 'spark', {
              speed: { min: 8, max: 46 },
              scale: { start: 0.55, end: 0 },
              alpha: { start: 0.9, end: 0 },
              lifespan: { min: 160, max: 320 },
              tint: [T.gold, T.goldBright],
              blendMode: Phaser.BlendModes.ADD, // the tail is LIGHT, not confetti
              quantity: 1,
              frequency: quality.tier() === 'high' ? 12 : 26,
              emitting: true,
            })
            .setDepth(31)
        : null
      tail?.startFollow(flyer)
      // Control point lifted above both ends → a gentle board→chip arc (no Path object needed).
      const ctrlX = (from.x + targetX) / 2 + (Math.random() * 2 - 1) * 30
      const ctrlY = Math.min(from.y, targetY) - 70 - Math.random() * 30
      const p = { t: 0 }
      this.tweens.add({
        targets: p,
        t: 1,
        delay: i * 60,
        duration: 320 + i * 30,
        ease: 'Sine.easeIn',
        onUpdate: () => {
          const t = p.t
          const u = 1 - t
          flyer.x = u * u * from.x + 2 * u * t * ctrlX + t * t * targetX
          flyer.y = u * u * from.y + 2 * u * t * ctrlY + t * t * targetY
          flyer.setScale(startScale * (1 - 0.4 * t))
          flyer.rotation = t * 1.1
          head?.setPosition(flyer.x, flyer.y).setAlpha(0.55 + 0.45 * t) // the head glints brighter on approach
        },
        onComplete: () => {
          head?.destroy()
          if (tail) {
            tail.stop()
            tail.stopFollow()
            this.time.delayedCall(320, () => tail.destroy())
          }
          if (dress) this.cometArrival(targetX, targetY) // impact bloom + glint on the counter
          flyer.destroy()
          if (++landed >= total) this.settleCollect(o)
          else this.stepCollect(o)
        },
      })
    })
  }

  private scheduleAutoplay(): void {
    if (!this.autoplay) return
    this.apSched++
    this.time.delayedCall(this.autoplayDelay, () => {
      this.apFired++
      if (this.state !== 'idle' || this.bombArmed) return
      const hint = this.board.findFirstValidMove()
      if (hint) {
        this.apMoved++
        void this.trySwap(hint.a, hint.b)
      }
    })
  }

  // ------------------------------------------------------------ idle micro-life (§3d)

  /** 3d: (re)arm the ~5s idle-hint timer. Idempotent — clears any pending/active nudge first. */
  private armHint(): void {
    this.disarmHint()
    if (this.state !== 'idle') return
    this.hintTimer = this.time.delayedCall(5000, () => this.showHint())
  }

  /**
   * 3d: after ~5s idle, gently pulse a valid pair (reusing the engine's findFirstValidMove). Under
   * reduced motion it's a single static ring on the pair — no loop. Disarmed the moment the player
   * touches the board (onDown) or a swap starts (trySwap).
   */
  private showHint(): void {
    this.hintTimer = null
    if (this.state !== 'idle') return
    const move = this.board.findFirstValidMove()
    if (!move) return
    const pa = this.board.get(move.a)
    const pb = this.board.get(move.b)
    if (!pa || !pb) return
    const sprites = [this.sprites.get(pa.id), this.sprites.get(pb.id)].filter(
      (s): s is Phaser.GameObjects.Sprite => !!s && s.active
    )
    if (sprites.length === 0) return
    this.hintTargets = sprites
    if (this.reducedMotion) {
      const pos = this.cellToXY(move.a)
      this.hintRing = this.add
        .image(pos.x, pos.y, 'ring')
        .setDisplaySize(CELL * 1.02, CELL * 1.02)
        .setTint(0xf2b234)
        .setAlpha(0.7)
      this.pieceLayer.add(this.hintRing)
      return
    }
    this.hintTween = this.tweens.add({
      targets: sprites,
      scale: PIECE_SCALE * 1.12,
      duration: 460,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    })
  }

  /** Retire the idle-hint nudge: cancel the timer, stop the pulse, settle the pair, drop the ring. */
  private disarmHint(): void {
    this.hintTimer?.remove(false)
    this.hintTimer = null
    this.hintTween?.stop()
    this.hintTween = null
    for (const s of this.hintTargets) if (s.active) s.setScale(PIECE_SCALE)
    this.hintTargets = []
    this.hintRing?.destroy()
    this.hintRing = undefined
  }

  /**
   * 3b: the objective-complete beat. The chip's green ✓ + pulse-stop are already handled by the
   * clarity pass (onObjectiveComplete) — this ADDS the celebration: a ✓ stamp punch over the chip,
   * a spark burst, an ascending ding + a haptic. Reduced motion: a static stamp, no spark, instant.
   */
  private objectiveStamp(o: ObjectiveState): void {
    const chip = o.chip
    if (!chip) return
    sfx.starDing(2)
    this.vibrate(40)
    const x = chip.x
    const y = chip.y
    if (!this.reducedMotion && quality.count(1) > 0) {
      this.sparkEmitter.explode(quality.count(10), x, y)
    }
    const stamp = this.add
      .text(x, y, '✓', { fontFamily: FONT, fontSize: '84px', fontStyle: '900', color: getTheme().ok })
      .setOrigin(0.5)
      .setDepth(33)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(0,0,0,0.18)', 6, false, true)
    if (this.reducedMotion) {
      stamp.setScale(0.9)
      this.time.delayedCall(600, () => stamp.destroy())
      return
    }
    stamp.setScale(0).setAngle(-12)
    this.tweens.add({
      targets: stamp,
      scale: 1,
      angle: 0,
      duration: 300,
      ease: 'Back.easeOut',
      onComplete: () =>
        this.tweens.add({
          targets: stamp,
          alpha: 0,
          y: y - 30,
          delay: 240,
          duration: 320,
          ease: 'Sine.easeIn',
          onComplete: () => stamp.destroy(),
        }),
    })
  }

  /**
   * 3e: a quick gold `ring` implosion + spark when a piece is born into a special (wild reel / dice
   * bomb / jackpot). ADD, transient, depth 22 (above the pieces, below the HUD). Reduced motion: no-op.
   */
  private specialBirth(at: Coord): void {
    const pos = this.cellToXY(at)
    if (!this.reducedMotion && quality.count(1) > 0) {
      this.sparkEmitter.explode(quality.count(6), pos.x, pos.y)
    }
    if (this.reducedMotion) return
    const ring = this.add
      .image(pos.x, pos.y, 'ring')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(0xf2b234)
      .setDepth(22)
      .setDisplaySize(CELL * 2.2, CELL * 2.2)
      .setAlpha(0.7)
    this.tweens.add({
      targets: ring,
      alpha: 0,
      scaleX: ring.scaleX * 0.42,
      scaleY: ring.scaleY * 0.42,
      duration: 320,
      ease: 'Quad.easeIn',
      onComplete: () => ring.destroy(),
    })
  }

  // ---------------------------------------------------------------- layout

  private cellToXY(at: Coord): { x: number; y: number } {
    return {
      x: BOARD_X + at.col * CELL + CELL / 2,
      y: this.boardTop + at.row * CELL + CELL / 2,
    }
  }

  private xyToCell(x: number, y: number): Coord | null {
    const col = Math.floor((x - BOARD_X) / CELL)
    const row = Math.floor((y - this.boardTop) / CELL)
    if (row < 0 || col < 0 || row >= ROWS || col >= COLS) return null
    return { row, col }
  }

  // ----------------------------------------------------------------- build

  private buildBackdrop(): void {
    const T = getTheme()
    // §R3 PLAY-FOCUS SCRIM: one translucent theme-ink sheet over the ENTIRE atmospheric backdrop
    // (all negative depths) but under every gameplay object (≥ 0). It pushes the lounge wash a
    // touch darker and duller while playing, so the elevated cabinet + HUD rail pop forward.
    // Warm ink from the theme's own `scrim` token (never black) at whisper alpha — all four themes
    // stay warm, not muddy. Static, zero motion → no reduced-motion path needed.
    this.add.rectangle(DESIGN_W / 2, viewportCenterY(), DESIGN_W, worldH(), getTheme().scrim, 0.07).setDepth(-24)

    // Reddish "screen is on" glow behind the board — the opaque card covers its center, so only
    // a soft rose halo bleeds past the frame. Surges on a win (see celebrateBoard).
    this.cabinetGlow = this.add
      .image(DESIGN_W / 2, this.boardTop + BOARD_W / 2, 'bgglow')
      .setTint(T.cabinetGlow)
      .setAlpha(0.13)
      .setBlendMode(Phaser.BlendModes.ADD)
    this.cabinetGlow.setDisplaySize(BOARD_W + 170, BOARD_W + 170)
    this.cabinetSurge = false // reset per build so a restart mid-surge can't leave the drive stuck off
    // cabinetGlow breathe — gated (§E8): reduced motion rests it at a static mid-glow, no pulse.
    // Otherwise it breathes off the shared `heartbeat` clock in update() (C1), in phase with Home's
    // PLAY halo — no independent yoyo (that would shimmer out of phase with the rest of the app).
    if (this.reducedMotion) this.cabinetGlow.setAlpha(0.14)

    // Recessed gold TRAY: an opaque gold-bezel cabinet with a well floor DARKER than the tiles,
    // so the 64 raised glossy cushions pop out of a real 3-D setting. Baked once (static graphics),
    // footprint (pad 18 → x22/y282/size676) unchanged so the marquee bulbs stay aligned.
    const pad = 18
    const x = BOARD_X - pad
    const y = this.boardTop - pad
    const size = BOARD_W + pad * 2
    // §R3 ELEVATION: the cabinet now FLOATS. Two baked `softshadow` layers under the slab — a
    // tight, darker CONTACT shadow hugging the silhouette plus a wide, faint AMBIENT falloff —
    // replace the old flat gold-tint offset fills. Both are plain Images of one baked texture
    // (zero per-frame cost, one key light from above per E7 → offsets straight DOWN). Neutral
    // black at low alpha reads as depth on all four theme washes.
    this.add.image(x + size / 2, y + size / 2 + 26, 'softshadow').setDisplaySize(size + 96, size + 96).setAlpha(0.32)
    // The tight contact shadow is kept so a board SLAM can briefly deepen + tighten it (the slab
    // pressing toward its housing — a real depth cue synced to the dip). Base scale captured for a
    // clean return, since it's tweened from either theme.
    this.contactShadow = this.add.image(x + size / 2, y + size / 2 + 11, 'softshadow').setDisplaySize(size + 38, size + 38).setAlpha(0.3)
    this.contactShadowBase = this.contactShadow.scaleX

    const g = this.add.graphics()
    // §R3 chunky under-bezel: a darker gold SIDE WALL peeking a few px below the face, so the slab
    // reads as a thick raised surface (the face fill below covers all but the bottom lip).
    //
    // §RGB — skipped when the light ring is on. The ring's bottom band ends level with the face, so
    // this lip is the one part of the cabinet the light does NOT cover: it surfaced as a gold arc
    // under the band along the bottom edge and both bottom corners, reading as the old bulb bezel
    // showing through. Widening the ring to cover it only moves the seam inboard (see buildCabinet),
    // and the lip is hidden either way, so with the ring on it is simply not drawn. Elevation still
    // comes from the two baked softshadow layers above, which is what actually carries it.
    if (!rgbMarquee()) {
      g.fillStyle(0x8a6206, 1)
      g.fillRoundedRect(x, y + 7, size, size, 28)
      g.fillStyle(0x6b4c05, 0.5)
      g.fillRoundedRect(x + 2, y + 9, size - 4, size, 28)
    }
    // Gold bezel frame (opaque) + a lit inner sheen and a dark outer edge for bevel depth.
    // §V1: the cabinet frame is the largest single block of gold on screen — read it from the theme
    // so it carries the saturated brand instead of the v1 mustard it was frozen at.
    g.fillStyle(T.goldDeep, 1)
    g.fillRoundedRect(x, y, size, size, 28)
    g.fillStyle(T.gold, 1)
    g.fillRoundedRect(x + 3, y + 3, size - 6, size - 6, 25)
    g.lineStyle(2, 0xffe6a8, 0.6)
    g.strokeRoundedRect(x + 3, y + 3, size - 6, size - 6, 25)
    g.lineStyle(2, 0x7a5a08, 0.5)
    g.strokeRoundedRect(x, y, size, size, 28)
    // Recessed well (floor deeper than the tiles so the cushions read as raised).
    const wi = 14
    const wx = x + wi
    const wy = y + wi
    const ws = size - wi * 2
    const wr = 20
    // §E12 High-Contrast: a much darker well floor so the (inset) light cushions read as a crisp
    // grid — the dark floor peeking between tiles IS the 1px cell separator. Warm look untouched
    // otherwise. (§R3 depth pass: the warm floor drops a shade from 0xe4d8bd so the cushions sit
    // deeper IN the tray — still warm parchment, just recessed.)
    //
    // §G9 FIGURE/GROUND. The default floor was 0xddcfae — about 14 L* below the cushions — and the
    // cushions were drawn at the FULL cell size, so they butted edge to edge and the floor never
    // showed between them at all. The result was a single continuous cream slab: cream pieces on
    // cream cushions on a cream ground, with no visible grid. That was the largest single visual gap
    // against Candy Crush and Royal Match, both of which sit their pieces on a distinctly darker
    // board so the pieces read as objects rather than as pattern. The floor now drops to a deep
    // warm tan (~35 L* below the cushions), which is where the separator becomes legible without
    // leaving the warm casino palette. High-Contrast keeps its near-black extreme — this closes most
    // of the gap between the two so the accessibility mode is a preference, not a bug fix.
    const wellFloor = this.hc ? 0x241f18 : 0xa78c57
    g.fillStyle(wellFloor, 1)
    g.fillRoundedRect(wx, wy, ws, ws, wr)
    // Top inner-shadow (the recess): stacked dark bands from the top edge, rounded to the well.
    // (§R3: a hair denser than the original 0.05s — a deeper recess under the raised bezel.)
    for (const [f, a] of [[0.18, 0.06], [0.12, 0.06], [0.06, 0.07]] as Array<[number, number]>) {
      g.fillStyle(0x000000, a)
      g.fillRoundedRect(wx, wy, ws, ws * f, { tl: wr, tr: wr, bl: 0, br: 0 })
    }
    // Lit bottom lip + a crisp inner rim to seal the recess.
    g.fillStyle(0xfff3d6, 0.08)
    g.fillRoundedRect(wx + 4, wy + ws - 12, ws - 8, 9, { tl: 0, tr: 0, bl: wr - 6, br: wr - 6 })
    g.lineStyle(2, 0x9a875f, 0.45)
    g.strokeRoundedRect(wx, wy, ws, ws, wr)

    // 64 raised glossy tiles — ONE white texture, per-cell tinted (checkerboard WHISPER for
    // row/col tracking, not a stripe). 64 same-texture Images batch to a single draw call; this
    // replaces the old flat one-graphics checkerboard at ≈ +1 persistent draw call.
    // §E12 High-Contrast: a second, higher-contrast checkerboard tint set (the warm default's two
    // tints are near-identical whispers), plus a 3px inset so the dark floor shows as cell separators.
    const TILE_A = this.hc ? T.tileHcA : T.tileA
    const TILE_B = this.hc ? T.tileHcB : T.tileB
    // §G9 — the default gets an inset too (2px vs High-Contrast's 3px). Without one the cushions
    // touch and the deepened floor above has nothing to show through; the inset IS the grid line.
    // Kept a hair tighter than HC so the default still reads as a warm continuous felt tray rather
    // than as 64 separate keys.
    const tileSize = this.hc ? CELL - 3 : CELL - 2
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = this.cellToXY({ row: r, col: c })
        this.add
          .image(p.x, p.y, 'tile')
          .setDisplaySize(tileSize, tileSize)
          .setTint((r + c) % 2 === 0 ? TILE_A : TILE_B)
        // §detail: a soft ADD-blend glossy crown sheen per cushion — the catch-light the tint-locked
        // tile can't bake in. All 64 batch to one extra draw call (same texture); zero per-frame cost.
        this.add
          .image(p.x, p.y, 'tilegloss')
          .setDisplaySize(tileSize, tileSize)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(0.55)
      }
    }
  }

  /**
   * Slot-cabinet marquee: a ring of bulbs on the board bezel, lit in a traveling chase. Sits outside
   * the 8×8 grid so it never covers a piece. Bulbs are stored so a win can flash them (flashCabinet /
   * celebrateBoard).
   *
   * §RGB — with the RGB marquee ON there are no bulbs at all: the gold bezel instead carries a
   * continuous band of light (`attachRgbRing`), running down the centre of the frame where the bulb
   * ring used to sit so the cabinet footprint is unchanged. With it OFF the original alternating
   * red/gold bulbs and their 48 per-bulb tweens are rebuilt exactly as before.
   */
  private buildCabinet(): void {
    this.cabinetRgb?.destroy()
    this.cabinetRgb = undefined
    this.cabinetBulbs = []
    const pad = 18
    const inset = 12

    if (rgbMarquee()) {
      // The channel's CENTRELINE sits `RGB_INSET` in from the cabinet's outer edge, and the corner
      // radius shrinks with it or the tube would cut across the corners.
      //
      // The light must not touch the playfield. The numbers, left to right: the cabinet's outer edge
      // is at BOARD_X-pad (22); the first tile's LEFT EDGE is at BOARD_X + 1 (41, since the cushions
      // are drawn CELL-2 wide and centred). With the centreline at 22+7 = 29, the band reaches
      // 29 ± (9 × 1.6)/2 = 21.8…36.2 and the halo 29 ± 20/2 = 19…39 — so the glow stops 2px short of
      // the tiles and spills only OUTWARD onto the backdrop, which is where a cabinet's light belongs.
      // Change any of pad / RGB_INSET / thickness / haloWidth and this clearance has to be re-derived.
      const RGB_INSET = 7
      const side = BOARD_W + pad * 2 - RGB_INSET * 2
      // THE RING IS SQUARE TO THE FACE, and buildBoard drops its under-bezel to keep it that way.
      // That slab is normally filled a second time offset 7px DOWN (plus a half-alpha one at 9px) so
      // a side wall hangs below the face and it reads as thick — but the ring's bottom band ends at
      // y+size+0.2, so those 7px of gold ran on underneath the light, along the whole bottom edge and
      // round both bottom corners. That is the old bulb bezel showing through the new one, which is
      // the one thing this feature set out to remove, and because it appeared only at the bottom it
      // read as a defect rather than as depth.
      //
      // Growing the ring's height to swallow the lip works, but trades the fault for a subtler one:
      // the bottom band then sits 7px lower than the side bands, so ~7px of bright face shows between
      // the well and the light along the bottom only — a second ring again, just on the inside. The
      // lip is invisible either way once the band covers it, so it is earning nothing here; dropping
      // it (see buildBoard, gated on the same `rgbMarquee()`) keeps all four channels identical and
      // leaves the elevation to the two baked softshadow layers, which is where it already came from.
      this.cabinetRgb = attachRgbRing(
        this,
        {
          x: BOARD_X - pad + RGB_INSET,
          y: this.boardTop - pad + RGB_INSET,
          w: side,
          h: side,
          r: 28 - RGB_INSET,
          thickness: 9,
          haloWidth: 20,
        },
        { depth: 2 } // the bulbs' old depth: above the baked cabinet, below every gameplay object
      )
      return
    }

    const left = BOARD_X - pad + inset
    const right = BOARD_X - pad + (BOARD_W + pad * 2) - inset
    const top = this.boardTop - pad + inset
    const bottom = this.boardTop - pad + (BOARD_W + pad * 2) - inset
    // Derive the step from the side length instead of hard-coding it. At a fixed 56 the side
    // (652) isn't a whole number of steps, so each edge ended on a 36px stub gap right before the
    // corner — the bulbs visibly bunched at all four corners. Rounding to the nearest whole count
    // keeps the same 48 bulbs and the same ~56 rhythm, but every gap is now identical.
    const side = right - left
    const perSide = Math.max(1, Math.round(side / 56))
    const step = side / perSide
    const pts: Array<{ x: number; y: number }> = []
    for (let i = 0; i < perSide; i++) pts.push({ x: left + step * i, y: top })
    for (let i = 0; i < perSide; i++) pts.push({ x: right, y: top + step * i })
    for (let i = 0; i < perSide; i++) pts.push({ x: right - step * i, y: bottom })
    for (let i = 0; i < perSide; i++) pts.push({ x: left, y: bottom - step * i })

    const period = 1500 // one lap of the chase
    pts.forEach((p, i) => {
      const bulb = this.add.image(p.x, p.y, 'bulb').setDisplaySize(13, 13).setDepth(2)
      this.cabinetBulbs.push(bulb)
      bulb.setTint(i % 2 === 0 ? 0xff5a6a : 0xffd75e) // reddish / gold
      bulb.setAlpha(this.reducedMotion ? 0.85 : 0.4)
    })
    // Traveling bulb chase — gated (§E8): reduced motion rests every bulb statically lit (above).
    // ONE UPDATE hook drives all 48 bulbs with the exact curve the old 48 looping tweens ran —
    // 0.4→1→0.4 on Sine.easeInOut legs of period/2, phase-staggered i/N, and resting at 0.4 until
    // each bulb's stagger comes up (the tween's pre-delay rest, so even the first lap matches).
    // The marquee's one-clock rule applied to the legacy ring: RGB-off now idles at ~6 tweens
    // instead of ~53. flashCabinet's scale pops stay tweens — the clock owns only alpha.
    if (!this.reducedMotion) {
      const bulbs = this.cabinetBulbs
      const half = period / 2
      let t = 0
      const onUpdate = (_: number, delta: number): void => {
        t += delta
        for (let i = 0; i < bulbs.length; i++) {
          const delay = (i / bulbs.length) * period
          let a = 0.4
          if (t >= delay) {
            const tau = (t - delay) % period
            const u = tau < half ? tau / half : (period - tau) / half
            a = 0.4 + 0.6 * 0.5 * (1 - Math.cos(Math.PI * u))
          }
          bulbs[i].setAlpha(a)
        }
      }
      this.events.on(Phaser.Scenes.Events.UPDATE, onUpdate)
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.events.off(Phaser.Scenes.Events.UPDATE, onUpdate))
    }
  }

  /**
   * Quick light flash on the cabinet — bulbs pop + reddish glow surges. For mega-wins / wins.
   * `strength` (0..3) intensifies it: a deeper MEGA tier / finish pops the bulbs wider, drives the
   * glow brighter, and adds an extra surge cycle. strength 0 is the original win/flash, untouched.
   */
  private flashCabinet(strength = 0): void {
    const s = Math.max(0, Math.min(3, strength))
    const bulbScale = 1.7 + s * 0.16 // 1.7 / 1.86 / 2.02 / 2.18
    for (const bulb of this.cabinetBulbs) {
      const base = bulb.scaleX
      this.tweens.add({ targets: bulb, scaleX: base * bulbScale, scaleY: base * bulbScale, duration: 140, yoyo: true, ease: 'Quad.easeOut' })
    }
    // §RGB — with the light ring on there are no bulbs, so the scale-punch loop above simply finds
    // an empty array and the ring's own surge (a quickened lap + a brighter floor, self-decaying)
    // IS the win flash. With it off, the bulbs pop and this is a no-op. Never both.
    this.cabinetRgb?.surge(s)
    if (this.cabinetGlow) {
      // The surge briefly OWNS the glow's alpha; the heartbeat drive in update() yields until it ends.
      this.cabinetSurge = true
      this.tweens.add({
        targets: this.cabinetGlow,
        alpha: Math.min(0.6, 0.42 + s * 0.06),
        duration: 160,
        yoyo: true,
        repeat: s >= 2 ? 2 : 1,
        ease: 'Quad.easeOut',
        onComplete: () => {
          this.cabinetSurge = false
        },
      })
    }
  }

  /** A modest spray of chips + cards bursting from the board — the casino "panel" win touch. */
  private burstTokens(count = 10): void {
    const cx = BOARD_X + BOARD_W / 2
    const cy = this.boardTop + BOARD_W / 2
    for (let i = 0; i < count; i++) {
      const key = i % 2 === 0 ? 'chip' : 'card'
      const token = this.add
        .image(cx + (Math.random() * 2 - 1) * 110, cy + (Math.random() * 2 - 1) * 110, key)
        .setDepth(24)
        .setScale(0)
      const ang = Math.random() * Math.PI * 2
      const dist = 150 + Math.random() * 170
      this.tweens.add({
        targets: token,
        x: cx + Math.cos(ang) * dist,
        y: cy + Math.sin(ang) * dist - 40,
        scale: 0.85,
        rotation: (Math.random() * 2 - 1) * 3,
        delay: i * 16, // Pass 2 overlap: fan the burst into a staggered volley...
        duration: 680 - i * 16, // ...while every token still lands on the same beat (delay+dur constant)
        ease: 'Cubic.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: token, alpha: 0, y: token.y + 140, duration: 480, onComplete: () => token.destroy() }),
      })
    }
  }

  /** Full board win celebration: light flash + token burst (plays on the visible board pre-overlay). */
  private celebrateBoard(): void {
    this.flashCabinet()
    this.burstTokens()
  }

  /**
   * The sweep counter. Lives in the 52px band between the HUD rail and the board top, directly
   * above the felt so the eye connects the two, and it is not created at all on a level without
   * coats — the objective row stays exactly three chips wide, untouched.
   */
  private buildCoatCounter(): void {
    if (this.coatsTotal <= 0) return
    this.coatLabel = this.add
      .text(DESIGN_W / 2, this.boardTop - 38, '', {
        fontFamily: FONT,
        fontSize: '23px',
        fontStyle: '900',
        color: getTheme().goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
    this.refreshCoatLabel()
  }

  private buildHud(): void {
    const T = getTheme()
    // Top row: back · LEVEL N (or ENDLESS) · score.
    const BACK_X = 64
    const BACK_W = 84
    addPillButton(this, BACK_X, 84, BACK_W, 56, '‹', GHOST_PILL, () => this.exitToLevels())
    // ONE WIDTH FOR BOTH MODES. Endless used to take 240 against a level's 220, which is what put its
    // left edge at x=240 and left the chip pill nowhere to go. The extra 20px bought nothing:
    // "ENDLESS" measures 110px, so even at 220 it keeps 82px of slack — more than "LEVEL 300" (64px).
    // Matching them also makes the two modes read as the same control, which they are.
    const TAB_W = 220
    addPillButton(
      this,
      DESIGN_W / 2,
      84,
      TAB_W,
      56,
      this.endless ? 'ENDLESS' : `LEVEL ${this.level}`,
      this.endless ? ROSE_PILL : GOLD_PILL,
      () => {}
    )
    this.add
      .text(BOARD_X + BOARD_W, 62, 'SCORE', { fontFamily: FONT, fontSize: '18px', color: '#8a8577' })
      .setOrigin(1, 0)
      .setLetterSpacing(3)
    this.scoreText = this.add
      .text(BOARD_X + BOARD_W, 84, '0', { fontFamily: FONT, fontSize: '34px', color: T.onBackdropInk, fontStyle: 'bold' })
      .setOrigin(1, 0)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
    // Mute chip nudged to y=34 (from 40) so its lower arc clears the SCORE label.
    addMuteChip(this, 676, 34)

    // Persistent chip balance — compact, tucked into the top row's gap between the back button and
    // the LEVEL/ENDLESS tab. Shows the pre-win total; the win payout flies a chip in to bump it.
    //
    // CENTRED IN THE GAP THAT ACTUALLY EXISTS, and capped to it. It used to sit at a hard-coded
    // x=182 with no width limit, which failed in both directions: the fixed centre pushed it right,
    // wasting 14px of clear space on the back-button side, and the pill self-sizes with the balance
    // so it grew straight into the tab. Measured on the reported screenshot — a 2,935 balance ran to
    // x=244 against the ENDLESS tab's left edge at 240, a 4px OVERLAP, and five digits (12,935 →
    // 136px) overflowed the whole 134px gap. Deriving both numbers from the neighbours means the
    // next change to either pill's width cannot re-open this by hand.
    const gapFrom = BACK_X + BACK_W / 2
    const gapTo = DESIGN_W / 2 - TAB_W / 2
    const BREATH = 10 // clear air either side, so "close enough to touch" never reads as touching
    this.chipHud = addChipPill(this, (gapFrom + gapTo) / 2, 84, {
      compact: true,
      maxWidth: gapTo - gapFrom - BREATH * 2,
    })

    // Jackpot charge meter — a slot-console strip in the space below the board that fills one notch
    // per level win and then "explodes" into the wheel. Numbered levels only (endless has no jackpot).
    // Depth 42 so it sits above the win scrim and the player watches it tick up on the win card.
    if (!this.endless) {
      this.jackpotHud = addJackpotMeter(this, DESIGN_W / 2, 1086, { width: 300 })
      this.jackpotHud.container.setDepth(42)
      this.jackpotHud.update(loadSave().jackpotMeter, false)
    }
    // DEV-only: open the wheel on demand so an automated check can spin it repeatedly. Stripped in prod.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __spinWheel?: () => Promise<unknown> }).__spinWheel = () =>
        new Promise(res => openJackpotWheel(this, { onClaim: res }))
    }

    // Second row: moves card + objective chips — the console's ELEVATED RAIL (§R3). Each card gets
    // one baked `softshadow` underlay (offset straight down per ui.ts's E7 one-key-light law) below
    // its existing crisp offset shadow, so the whole cluster lifts off the darkened backdrop the
    // same way the board slab does. Plain Images of one baked texture — zero per-frame cost.
    const cardY = 196
    const lift = (cx: number, cy: number, w: number, h: number): Phaser.GameObjects.Image =>
      this.add.image(cx, cy + 8, 'softshadow').setDisplaySize(w + 48, h + 48).setAlpha(0.28)
    lift(BOARD_X + 85, cardY, 170, 104) // moves card
    if (this.endless) lift(BOARD_X + BOARD_W - 290 / 2, cardY, 290, 104) // week's-best card
    // The rail cards are baked plates (platekit) — same size/fill/stroke as the old flat Graphics,
    // plus the gloss/rim/soft-shadow finish every pressable already wears. Keyed by theme id.
    this.add.image(
      BOARD_X + 85,
      cardY,
      bakePanel(this, `hud:moves:${T.id}:170x104`, 170, 104, 20, {
        fill: 0xffffff,
        bezel: T.border,
        bezelWidth: 2,
        shadowAlpha: 0.12,
        shadowDist: 5,
      })
    )
    this.add
      .text(BOARD_X + 85, cardY - 28, 'MOVES', { fontFamily: FONT, fontSize: '18px', color: T.inkMuted })
      .setOrigin(0.5)
      .setLetterSpacing(3)
    this.movesText = inkShadow(
      this.add
        .text(BOARD_X + 85, cardY + 12, String(this.movesLeft), {
          fontFamily: FONT,
          fontSize: '48px',
          fontStyle: '900',
          color: T.ink,
        })
        .setOrigin(0.5),
      'numeral'
    )

    if (this.endless) {
      // No objectives in endless — show today's target (BEST to beat) instead.
      const cardW = 290
      const bx = BOARD_X + BOARD_W - cardW
      this.add.image(
        bx + cardW / 2,
        cardY,
        bakePanel(this, `hud:best:${T.id}:290x104`, cardW, 104, 20, {
          bezel: T.goldBezel,
          bezelWidth: 2,
          shadowAlpha: 0.12,
          shadowDist: 5,
        })
      )
      this.add
        .text(bx + cardW / 2, cardY - 28, "TODAY'S BEST", { fontFamily: FONT, fontSize: '18px', color: T.inkMuted })
        .setOrigin(0.5)
        .setLetterSpacing(2)
      inkShadow(
        this.add
          .text(bx + cardW / 2, cardY + 12, this.endlessBest > 0 ? this.endlessBest.toLocaleString() : '—', {
            fontFamily: FONT,
            fontSize: '40px',
            fontStyle: '900',
            color: T.goldText,
          })
          .setOrigin(0.5),
        'numeral'
      )
      // Free-spins counter parks in the rail gap between the moves card and this one.
      this.freeSpinSpot = { x: (BOARD_X + 170 + bx) / 2, y: cardY }
    } else {
      const chipW = 118
      const chipGap = 12
      const n = this.objectives.length
      // §G8 — the cluster is CENTRED on a fixed anchor, not right-aligned to the board edge.
      //
      // Right-aligning grew the cluster leftwards from the board's right edge, so its width — and
      // therefore the "COLLECT" tag's x — moved with the objective count. At the three objectives
      // every level from 8 onward has, that put the tag safely mid-rail; at ONE objective (levels 1
      // and 2 — literally every new player's first two screens) the lone chip hugged the right edge
      // and its tag landed directly underneath the SCORE readout, printing "SCORE / 0 / COLLECT" as
      // one column. The anchor below IS the n=3 centre, so the common case is byte-for-byte
      // unchanged and only the narrow clusters move.
      const clusterCx = BOARD_X + BOARD_W - chipW / 2 - (chipW + chipGap)
      const slot = (i: number): number => clusterCx + (i - (n - 1) / 2) * (chipW + chipGap)
      // Free-spins counter parks in the rail gap between the moves card and the objective cluster.
      // Narrowest at 3 objectives (~92px) and roomier with fewer, so it is derived, never fixed.
      const firstChipLeft = slot(0) - chipW / 2
      this.freeSpinSpot = { x: (BOARD_X + 170 + firstChipLeft) / 2, y: cardY }
      this.add
        .text(clusterCx, cardY - 70, 'COLLECT', { fontFamily: FONT, fontSize: '18px', fontStyle: '900', color: T.goldText })
        .setOrigin(0.5)
        .setLetterSpacing(4)
        .setShadow(0, 2, 'rgba(90,70,20,0.18)', 3, false, true)
      this.objectives.forEach((o, i) => {
        const chip = this.add.container(slot(i), cardY)
        // §R3 elevated-rail underlay — BELOW the gold halo so the additive breathe stays luminous.
        chip.add(this.add.image(0, 8, 'softshadow').setDisplaySize(chipW + 48, 104 + 48).setAlpha(0.28))
        // Soft gold halo bleeding out around the (opaque) chip — breathes to pull the eye to an
        // incomplete target. A separate object from the chip so it never touches chip.scale (the
        // decrement "pop" guards on chip.scale === 1). Static + fainter under reduced-motion.
        const glow = this.add
          .image(0, 0, 'bgglow')
          .setTint(T.gold)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(chipW + 56, 104 + 44)
          .setAlpha(this.reducedMotion ? 0.22 : 0.3)
        chip.add(glow)
        o.glow = glow
        if (!this.reducedMotion) {
          o.pulse = this.tweens.add({
            targets: glow,
            alpha: 0.52,
            scaleX: glow.scaleX * 1.06,
            scaleY: glow.scaleY * 1.06,
            duration: 1100,
            yoyo: true,
            repeat: -1,
            ease: 'Sine.easeInOut',
          })
        }
        chip.add(
          this.add.image(
            0,
            0,
            bakePanel(this, `hud:chip:${T.id}:118x104`, chipW, 104, 20, {
              fill: 0xffffff,
              bezel: T.border,
              bezelWidth: 2,
              shadowAlpha: 0.12,
              shadowDist: 5,
            })
          )
        )
        const icon = this.add.image(0, -20, o.symbol)
        icon.setDisplaySize(54, 54)
        chip.add(icon)
        o.text = inkShadow(
          this.add
            .text(0, 27, String(o.remaining), { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: T.ink })
            .setOrigin(0.5)
        )
        chip.add(o.text)
        o.chip = chip
        o.shown = o.remaining // display starts synced; collect-fly lets it lag behind the model
      })
    }

    // The standing brief under the board. It named only the symbols even on a coated level, where
    // felt is a genuine binding constraint (core/difficulty.ts: ~5pp of failures end with felt still
    // on the table) — so the one always-visible sentence describing the win condition described half
    // of it, and a player could sweep every symbol and still not know what was holding the level open.
    const brief = this.endless
      ? "Biggest score wins today's board"
      : this.coatsTotal > 0
        ? 'Match the goal symbols and sweep every felt square'
        : 'Match the highlighted goal symbols before moves run out'
    inkShadow(
      this.add
        .text(DESIGN_W / 2, 988 + ENDLESS_BOARD_DROP, brief, {
          fontFamily: 'Arial, sans-serif',
          fontSize: '22px',
          color: T.onBackdropMuted,
        })
        .setOrigin(0.5),
      'onBackdrop'
    )

    // TODAY'S LEADER, now seated ABOVE the board (owner request, 2026-08-03). The brief states the
    // RULE ("biggest score wins today's board"); this states the SCORE currently winning it, which
    // is the question players actually ask mid-run — and it belongs in the same glance as the board
    // and your own SCORE, not past the bottom of the grid where reading it means looking away from
    // the game. The board drops by ENDLESS_BOARD_DROP to open the lane. Endless only: numbered
    // levels spend this space on the jackpot meter and the helper shelf, and have no board to lead.
    if (this.endless) this.add.existing(addEndlessLeaderStrip(this, DESIGN_W / 2, ENDLESS_STRIP_Y, loadSave()))
  }

  // ------------------------------------------------------- in-level helpers (power bar)

  /**
   * The mid-level HELPER shelf, seated in the space below the jackpot meter (numbered levels only —
   * endless stays a boost-free fairness race). A caption over three chunky item buttons: +1 move,
   * +5 moves, and a targeted bomb. Same earned-chip economy as the Gift Store, but these apply to the
   * level being PLAYED (top up so you don't run out, or blast a spot) instead of queuing for the next.
   * Spend is atomic (save.spendChips); affordability restyles gold↔ghost on every rebuild.
   */
  private buildPowerBar(): void {
    const T = getTheme()
    this.powerBar = this.add.container(0, 0).setDepth(34)
    // Held on the scene so renderPowerItems can retitle it: while something on the shelf is free,
    // "SPEND CHIPS" is the exact mixed message that produced "I'm still getting charged coins for
    // using perks I've won" (2026-08-03). A caption must not contradict the item beneath it.
    this.powerCaption = this.add
      .text(DESIGN_W / 2, 1136, 'HELPERS · SPEND CHIPS TO WIN THIS LEVEL', {
        fontFamily: FONT,
        fontSize: '18px',
        fontStyle: '900',
        color: T.goldText,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
      .setShadow(0, 2, 'rgba(90,70,20,0.18)', 3, false, true)
    this.powerBar.add(this.powerCaption)
    this.powerItemsLayer = this.add.container(0, 0)
    this.powerBar.add(this.powerItemsLayer)
    this.renderPowerItems()
  }

  /** (Re)build the item buttons from the live chip balance — affordable pills read gold, the rest ghost. */
  private renderPowerItems(): void {
    const layer = this.powerItemsLayer
    if (!layer) return
    this.killPowerTweens()
    layer.removeAll(true)
    const T = getTheme()
    const save = loadSave()
    const chips = save.chips
    // Retitle when anything on the shelf is free — see the note where the caption is created.
    const anyFree = POWER_ITEMS.some(it => freeStockFor(save, it.type) > 0)
    this.powerCaption?.setText(
      anyFree ? 'HELPERS · USE YOURS, OR SPEND CHIPS' : 'HELPERS · SPEND CHIPS TO WIN THIS LEVEL'
    )
    const n = POWER_ITEMS.length
    const pillW = 200
    const pillH = 58
    const gap = 14
    const rowW = n * pillW + (n - 1) * gap
    const cx0 = DESIGN_W / 2 - rowW / 2 + pillW / 2
    POWER_ITEMS.forEach((item, i) => {
      const cx = cx0 + i * (pillW + gap)
      // Owning the equivalent boost makes the item reachable regardless of the chip balance — a
      // player holding a free +5 must never see it ghosted for being broke.
      const freeStock = freeStockFor(save, item.type)
      const afford = freeStock > 0 || chips >= item.price
      const btn = addPillButton(this, cx, 1188, pillW, pillH, item.label, afford ? GOLD_PILL : GHOST_PILL, () =>
        this.buyPower(item, btn)
      )
      layer.add(btn)
      // FREE line — the player owns something that does exactly this, so the shelf offers it instead
      // of a price. This is the in-level half of the 2026-08-03 report ("I'm still getting charged
      // coins for using perks I've won"): the stash and the Gift Store now show ownership, but this
      // shelf is where the player was standing when they felt it, so it has to answer here too.
      // No chip token, because showing one next to the word FREE is exactly the mixed signal that
      // started this.
      if (freeStock > 0) {
        const freeText = this.add
          .text(cx, 1240, freeStock > 1 ? `FREE · YOU OWN ${freeStock}` : 'FREE · YOU OWN 1', {
            fontFamily: FONT,
            fontSize: '20px',
            fontStyle: '900',
            color: T.goldText,
          })
          .setOrigin(0.5)
        layer.add(freeText)
        return
      }
      // Price line beneath the button: chip token + amount, centred under `cx` (gold when affordable).
      const priceText = this.add
        .text(0, 1240, item.price.toLocaleString(), {
          fontFamily: FONT,
          fontSize: '22px',
          fontStyle: '900',
          color: afford ? T.goldText : T.onBackdropMuted,
        })
        .setOrigin(0, 0.5)
      const chipIcon = this.add.image(0, 1240, 'chip').setDisplaySize(26, 26).setAlpha(afford ? 1 : 0.45)
      const groupW = 26 + 6 + priceText.width
      chipIcon.setX(cx - groupW / 2 + 13)
      priceText.setX(chipIcon.x + 13 + 6)
      layer.add([chipIcon, priceText])
    })
  }

  /** Kill any lingering press/looping tweens on the item layer before a rebuild (3.90 won't sweep them). */
  private killPowerTweens(): void {
    const layer = this.powerItemsLayer
    if (!layer) return
    const walk = (obj: Phaser.GameObjects.GameObject): void => {
      this.tweens.killTweensOf(obj)
      if (obj instanceof Phaser.GameObjects.Container) obj.list.forEach(walk)
    }
    layer.list.forEach(walk)
  }

  /** Buy an in-level helper — only while the board rests. Bomb arms an aim mode; moves top up now. */
  private buyPower(item: PowerItem, btn: Phaser.GameObjects.Container): void {
    if (this.state !== 'idle' || this.bombArmed) return // spend only when the board is settled
    if (item.type === 'bomb') {
      this.armBomb(item, btn)
      return
    }
    const n = item.moves ?? 0
    // §G2 — the buy cap (`DIFFICULTY.economy.purchasedMovesFrac`) is checked BEFORE the spend, so a
    // capped-out player is never charged for moves they don't receive. Endless has no `spec.moves`
    // budget and never shows this shelf, so the cap only ever governs numbered levels.
    if (n > 0 && this.purchasedMoveRoom() < n) {
      sfx.invalidThud()
      this.powerToast('Move top-ups maxed for this level', 'bad')
      return
    }
    // ── Spend a stashed boost before spending chips ──
    // The cap above is checked FIRST and applies either way, deliberately. It governs how far a
    // level's difficulty can be bought down mid-flight, and a free boost buys it down by exactly as
    // much as a paid top-up does — so paying with something you won changes the PRICE, never the
    // ceiling. (A boost applied at level start is a different thing and rightly bypasses this: it
    // was part of the level's shape from the first move rather than a rescue at move 3.)
    const freeSource = freeSourceFor(item.type)
    if (freeSource && consumeBoost(freeSource)) {
      this.grantMoves(n)
      sfx.winFanfare()
      this.powerToast(`+${n} moves — used your own, no chips spent`, 'good')
      this.renderPowerItems() // the free stock just dropped; the line may revert to a price
      return
    }
    const balance = spendChips(item.price)
    if (balance === null) {
      this.denyPower(btn)
      return
    }
    this.grantMoves(n)
    sfx.coinCount()
    this.flyChipToHud(btn.x, btn.y)
    this.powerToast(`+${n} ${n === 1 ? 'move' : 'moves'}`, 'good')
    this.renderPowerItems() // affordability may have changed
  }

  /** Add bought moves to the live counter, restoring the "plenty" colour + stopping the urgent pulse. */
  private grantMoves(n: number): void {
    if (n <= 0) return
    this.movesLeft += n
    this.purchasedMoves += n
    this.movesText.setText(String(this.movesLeft))
    this.movesText.setColor(this.movesLeft <= 5 ? getTheme().warn : getTheme().ink)
    if (this.movesLeft > 3) this.stopMovesPulse()
    if (!this.reducedMotion) {
      // Pass 2 follow-through: punch out fast, then SETTLE back with a gentle overshoot (vs a
      // symmetric yoyo that stops dead). Whole block already gated by `if (!this.reducedMotion)`.
      this.tweens.chain({
        targets: this.movesText,
        tweens: [
          { scale: 1.2, duration: 90, ease: 'Quad.easeOut' },
          { scale: 1, duration: 150, ease: backOut(OVERSHOOT.gentle) },
        ],
        onComplete: () => this.movesText.setScale(1),
      })
    }
  }

  /** Not-enough-chips feedback: a thud, a red toast, and a shake of the tapped button. */
  private denyPower(btn: Phaser.GameObjects.Container): void {
    sfx.invalidThud()
    this.powerToast('Not enough chips', 'bad')
    if (this.reducedMotion) return
    const x0 = btn.x
    this.tweens.add({ targets: btn, x: x0 - 6, duration: 50, yoyo: true, repeat: 3, onComplete: () => btn.setX(x0) })
  }

  /** A single chip arcs from the tapped button up into the HUD balance pill, which pops on arrival. */
  private flyChipToHud(fromX: number, fromY: number): void {
    if (!this.chipHud || this.reducedMotion) {
      this.chipHud?.update(loadSave().chips)
      return
    }
    const target = this.chipHud.container
    const c = this.add.image(fromX, fromY, 'chip').setDisplaySize(40, 40).setDepth(60)
    this.tweens.add({
      targets: c,
      x: target.x,
      y: target.y,
      scale: c.scale * 0.5,
      duration: 420,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        c.destroy()
        this.chipHud?.update(loadSave().chips)
      },
    })
  }

  /** Brief toast over the power bar (good = ok tone, bad = warn tone). Reduced motion → static, no slide. */
  private powerToast(msg: string, tone: 'good' | 'bad'): void {
    this.powerToastText?.destroy()
    const T = getTheme()
    const t = this.add
      .text(DESIGN_W / 2, 1104, msg, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: tone === 'bad' ? T.warn : T.ok })
      .setOrigin(0.5)
      .setDepth(46)
    this.powerToastText = t
    if (this.reducedMotion) {
      this.time.delayedCall(1000, () => t.destroy())
      return
    }
    t.setAlpha(0).setY(1116)
    this.tweens.add({ targets: t, alpha: 1, y: 1104, duration: 180, ease: 'Back.easeOut' })
    this.tweens.add({ targets: t, alpha: 0, delay: 900, duration: 300, onComplete: () => t.destroy() })
  }

  // -------------------------------------------------------- bomb (targeted 3×3 blast)

  /** Pay for the bomb, then enter aim mode (the next board tap blasts a 3×3 there). */
  private armBomb(item: PowerItem, btn: Phaser.GameObjects.Container): void {
    if (this.bombArmed) return
    // §G4 — `DIFFICULTY.economy.maxBombsPerLevel`, the last of the written-but-never-read economy
    // caps. Checked BEFORE the spend so a capped player is never charged for a bomb they can't arm.
    if (this.bombsUsed >= DIFFICULTY.economy.maxBombsPerLevel) {
      sfx.invalidThud()
      this.powerToast('Bombs maxed for this level', 'bad')
      return
    }
    const balance = spendChips(item.price)
    if (balance === null) {
      this.denyPower(btn)
      return
    }
    this.bombArmed = true
    this.disarmHint() // no idle nudge while aiming
    sfx.coinCount()
    this.flyChipToHud(btn.x, btn.y)
    this.renderPowerItems() // affordability may have changed
    this.showBombAim()
  }

  /** Aim overlay: a pulsing gold frame round the board + a prompt + a Cancel (which refunds). */
  private showBombAim(): void {
    const T = getTheme()
    this.powerBar?.setVisible(false) // swap the shelf for the aim controls while targeting
    const layer = this.add.container(0, 0).setDepth(44)
    this.bombAimLayer = layer
    const frame = this.add.graphics()
    frame.lineStyle(6, T.gold, 0.95)
    frame.strokeRoundedRect(BOARD_X - 8, this.boardTop - 8, BOARD_W + 16, BOARD_W + 16, 18)
    layer.add(frame)
    if (!this.reducedMotion) {
      this.bombAimTween = this.tweens.add({ targets: frame, alpha: 0.35, duration: 600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    layer.add(
      this.add
        .text(DESIGN_W / 2, 1150, 'TAP A TILE — 3×3 BLAST', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.goldText })
        .setOrigin(0.5)
        .setLetterSpacing(2)
        .setShadow(0, 2, 'rgba(90,70,20,0.2)', 3, false, true)
    )
    // Cancel sits well BELOW the board (y≈1206 → row 11, out of the 8×8 grid) so tapping it can never
    // read as a board target in onDown; it refunds the spent chips and returns to the shelf.
    layer.add(addPillButton(this, DESIGN_W / 2, 1206, 220, 58, 'CANCEL', GHOST_PILL, () => this.cancelBombAim()))
  }

  /** Tear down the aim overlay (kills its pulse + the CANCEL pill's press tween) and restore the shelf. */
  private hideBombAim(): void {
    this.bombAimTween?.stop()
    this.bombAimTween = undefined
    const layer = this.bombAimLayer
    if (layer) {
      // Kill any in-flight tweens on the layer's children BEFORE destroying them: Phaser 3.90 doesn't
      // sweep tweens on GameObject.destroy, so the CANCEL pill's release tween (started on pointerup,
      // just before onPress → cancelBombAim → here) would keep writing to a dead face container. Mirrors
      // killPowerTweens for the shelf.
      const walk = (obj: Phaser.GameObjects.GameObject): void => {
        this.tweens.killTweensOf(obj)
        if (obj instanceof Phaser.GameObjects.Container) obj.list.forEach(walk)
      }
      layer.list.forEach(walk)
      layer.destroy(true)
    }
    this.bombAimLayer = undefined
    this.powerBar?.setVisible(true)
  }

  /** Cancel an armed bomb: refund the chips, restore the shelf, disarm. */
  private cancelBombAim(): void {
    if (!this.bombArmed) return
    this.bombArmed = false
    const bombPrice = POWER_ITEMS.find(i => i.type === 'bomb')?.price ?? 0
    const balance = addChips(bombPrice) // full refund — nothing was consumed on the board
    this.chipHud?.update(balance)
    this.hideBombAim()
    this.renderPowerItems()
  }

  /**
   * Fire the purchased bomb at `center`: a free 3×3 blast (no move spent) that runs through the normal
   * detonation → cascade → scoring → objective pipeline via the board's `detonate`. Locks input
   * immediately (state → resolving) so a second tap can't double-fire, then hands the wave to resolveLoop.
   */
  private detonatePurchasedBomb(center: Coord): void {
    this.bombArmed = false
    this.bombsUsed++ // §G4 — counted on DETONATION, so a cancelled (and refunded) aim doesn't burn one
    this.hideBombAim()
    this.clearSelection()
    this.disarmHint()
    this.disarmTwinkle()
    this.state = 'resolving' // lock the board before any await
    const pos = this.cellToXY(center)
    this.specialBirth(center)
    sfx.bombBoom(this.colPan(center.col))
    this.vibrate(30)
    this.punch({ trauma: 0.35, flash: { x: pos.x, y: pos.y, size: CELL * 1.5 } })
    const wave = this.board.detonate(center, 1)
    void this.resolveLoop(wave)
  }

  private buildPieceLayer(deferDeal = false): void {
    // The felt goes down with the layer it lives in; sendToBack inside buildCoatLayer keeps it
    // under every piece that is dealt on top of it.
    this.time.delayedCall(0, () => {
      this.buildCoatLayer()
      this.buildCoatCounter()
    })
    const maskShape = this.make.graphics({ x: 0, y: 0 }, false)
    maskShape.fillStyle(0xffffff)
    maskShape.fillRect(BOARD_X - 4, this.boardTop - 4, BOARD_W + 8, BOARD_W + 8)

    this.pieceLayer = this.add.container(0, 0)
    this.pieceLayer.setMask(maskShape.createGeometryMask())

    this.ring = this.add.sprite(0, 0, 'ring').setVisible(false)
    this.ring.setDisplaySize(CELL * 1.02, CELL * 1.02)
    this.pieceLayer.add(this.ring)

    // §E12 High-Contrast: a thicker two-tone selection ring (dark contrast stroke + bright gold core)
    // drawn once around the origin and repositioned on select — reads on both the bright cushions and
    // the dark separators, where the thin baked gold `ring` alone can wash out. Warm mode uses `ring`.
    if (this.hc) {
      const s = (CELL * 1.06) / 2
      const hg = this.add.graphics().setVisible(false)
      hg.lineStyle(9, 0x241f18, 1)
      hg.strokeRoundedRect(-s, -s, s * 2, s * 2, 16)
      hg.lineStyle(5, 0xffd75e, 1)
      hg.strokeRoundedRect(-s, -s, s * 2, s * 2, 16)
      this.pieceLayer.add(hg)
      this.hcRing = hg
    }

    // Board deal-in (E5, signature moment #2): rain the 64 tiles in column-staggered from the top
    // edge — the layer is grid-masked, so pieces starting above BOARD_Y clip to "fall from above" —
    // with a Back landing overshoot + settle squash. Reduced motion → instant fill (today's behavior).
    if (this.reducedMotion) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const at = { row: r, col: c }
          this.createSprite(this.board.get(at)!, at)
        }
      }
      return
    }

    // §R3 level-intro handoff: on a numbered level with objectives the goal card now OWNS the
    // opening beat — the board stays empty under the intro scrim and assembles via the diagonal
    // build-in wave when the card exits (see playLevelIntro). Gate input; the intro hands back
    // to idle (or a tap-to-skip snaps everything to rest instantly).
    if (deferDeal) {
      this.state = 'resolving'
      return
    }

    this.state = 'resolving' // gate input until the board finishes assembling
    const COL_STAGGER = 40
    const FALL_MS = FALL_BASE_MS + FALL_PER_CELL_MS * ROWS // full-height drop
    const total = ROWS * COLS
    let landed = 0
    for (let c = 0; c < COLS; c++) {
      // dropCells = ROWS → the whole column starts stacked just above the top edge and pours in.
      for (let r = 0; r < ROWS; r++) {
        const at = { row: r, col: c }
        const sprite = this.createSprite(this.board.get(at)!, at, ROWS)
        const to = this.cellToXY(at)
        this.tweens.add({
          targets: sprite,
          y: to.y,
          delay: c * COL_STAGGER,
          duration: FALL_MS,
          ease: 'Back.easeOut',
          onComplete: () => {
            this.settleSquash(sprite, ROWS)
            // §E5/B14: ONE full-height landing thunk per settling column (r===0 fires once/col),
            // panned by column — the board pours in left→right as a rain of thunks, not mush.
            if (r === 0) sfx.land(1, this.colPan(c))
            // B3: one floor-dust puff per column at its DEEPEST (bottom) cell — the whole column pours in
            // together, so this lands in step with the r===0 thunk; full-height drop → max-size puff.
            if (r === ROWS - 1) this.floorDust(to.x, to.y, ROWS)
            if (++landed >= total) {
              this.state = 'idle'
              this.scheduleAutoplay()
              this.armHint()
            }
          },
        })
      }
    }
  }

  private buildParticles(): void {
    const emitters = {} as Record<SymbolType, Phaser.GameObjects.Particles.ParticleEmitter>
    for (const symbol of SYMBOLS) {
      emitters[symbol] = this.add
        .particles(0, 0, symbol, {
          speed: { min: 90, max: 280 },
          angle: { min: 0, max: 360 },
          // ÷2: symbol textures are now baked at 2× native (TEX_SIZE 128→256), so halve the
          // particle scale to keep the burst fragments the same on-screen size.
          scale: { start: 0.15, end: 0.05 },
          alpha: { start: 1, end: 0 },
          lifespan: { min: 300, max: 600 },
          gravityY: 800,
          rotate: { min: -180, max: 180 },
          emitting: false,
        })
        .setDepth(20)
    }
    this.emitters = emitters
    this.sparkEmitter = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 60, max: 360 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.8, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 250, max: 500 },
        gravityY: 600,
        emitting: false,
      })
      .setDepth(21)
  }

  private createSprite(piece: Piece, at: Coord, dropCells = 0): Phaser.GameObjects.Sprite {
    const pos = this.cellToXY(at)
    const y = pos.y - dropCells * CELL
    const sprite = this.add.sprite(pos.x, y, ensurePieceTexture(this, piece))
    sprite.setDisplaySize(PIECE_SIZE, PIECE_SIZE)
    // Specials read as "armed" on the board via a soft additive halo that trails them (synced in
    // update). Added BEFORE the sprite so it sits behind it; keyed by id so it never stacks.
    if (piece.kind !== 'normal' && !this.armedGlows.has(piece.id)) {
      const glow = this.add
        .image(pos.x, y, 'bgglow')
        .setTint(0xf2b234)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(PIECE_SIZE * 1.25, PIECE_SIZE * 1.25)
        .setAlpha(this.reducedMotion ? 0.16 : 0.22)
      this.pieceLayer.add(glow)
      this.armedGlows.set(piece.id, glow)
    }
    // Goal-piece "collect me" tell: a soft cream halo on NORMAL pieces whose symbol is still a
    // needed objective (specials already glow gold — skip them so the two tells never stack).
    // Governor-gated (off at the low tier via count(1)), softened to a static faint halo under
    // reduced-motion; the shimmer + upkeep run in update(). Added behind the sprite.
    if (
      piece.kind === 'normal' &&
      !this.goalGlows.has(piece.id) &&
      quality.count(1) > 0 &&
      this.objectives.some(o => o.remaining > 0 && o.symbol === piece.symbol)
    ) {
      const halo = this.add
        .image(pos.x, y, 'bgglow')
        .setTint(0xfff6e8)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(PIECE_SIZE * 1.4, PIECE_SIZE * 1.4)
        .setAlpha(this.reducedMotion ? 0.14 : 0.18)
      halo.setData('sym', piece.symbol)
      this.pieceLayer.add(halo)
      this.goalGlows.set(piece.id, halo)
    }
    this.pieceLayer.add(sprite)
    this.sprites.set(piece.id, sprite)
    // A clamped piece still matches, so the furniture goes OVER the symbol rather than replacing
    // it — the player has to read the symbol to plan around it. Keyed by id like armedGlows, so it
    // can never stack, and synced/destroyed in update() by the same rule.
    if (piece.locked && !this.lockOverlays.has(piece.id)) {
      const clamp = this.add
        .image(pos.x, y, ensureHazardTexture(this, 'lock'))
        .setDisplaySize(PIECE_SIZE, PIECE_SIZE)
      this.pieceLayer.add(clamp)
      this.lockOverlays.set(piece.id, clamp)
    }
    return sprite
  }

  /**
   * Lay the felt. Drawn into `pieceLayer` and sent to the back, so it rides the same geometry mask
   * as the pieces and always sits beneath them. Cell-keyed rather than piece-keyed: a coat belongs
   * to the SQUARE, and the pieces above it come and go.
   */
  private buildCoatLayer(): void {
    for (const sprite of this.coatCells.values()) sprite.destroy()
    this.coatCells.clear()
    if (this.board.coatsRemaining() === 0) return
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const layers = this.board.coatAt({ row: r, col: c })
        if (layers <= 0) continue
        const pos = this.cellToXY({ row: r, col: c })
        const felt = this.add
          .image(pos.x, pos.y, ensureHazardTexture(this, 'coat', layers))
          .setDisplaySize(CELL, CELL)
        this.pieceLayer.add(felt)
        this.pieceLayer.sendToBack(felt)
        this.coatCells.set(`${r},${c}`, felt)
      }
    }
  }

  /**
   * Play what a wave did to the hazards. Called from the resolve loop right after the clears, so
   * the felt sweeps and the lockbox bursts land on the same beat as the match that caused them.
   * Reduced motion collapses every beat to its finished state, as everywhere else in this scene.
   */
  private playHazardEffects(wave: ClearWave): void {
    const h = wave.hazards
    if (!h) return

    for (const { at, remaining } of h.coatsStripped) {
      const k = `${at.row},${at.col}`
      const felt = this.coatCells.get(k)
      if (!felt) continue
      if (remaining > 0) {
        // Down a layer, not gone: re-skin to the thinner felt.
        felt.setTexture(ensureHazardTexture(this, 'coat', remaining))
        continue
      }
      this.coatCells.delete(k)
      if (this.reducedMotion) {
        felt.destroy()
      } else {
        this.tweens.add({
          targets: felt,
          alpha: 0,
          scale: felt.scale * 1.18,
          duration: 220,
          ease: 'Quad.easeOut',
          onComplete: () => felt.destroy(),
        })
      }
    }

    // A damaged lockbox re-skins to its cracked art so "one more hit" reads without a number.
    for (const { at, hp } of h.blockersDamaged) {
      const piece = this.board.get(at)
      const sprite = piece ? this.sprites.get(piece.id) : undefined
      if (!sprite) continue
      sprite.setTexture(ensureHazardTexture(this, 'blocker', hp))
      sprite.setDisplaySize(PIECE_SIZE, PIECE_SIZE)
      if (!this.reducedMotion) {
        this.tweens.add({ targets: sprite, scale: sprite.scale * 0.9, duration: 90, yoyo: true, ease: 'Quad.easeOut' })
      }
    }

    // Freed pieces drop their clamp. The sprite itself is untouched — only the furniture leaves.
    for (const at of h.unlocked) {
      const piece = this.board.get(at)
      const clamp = piece ? this.lockOverlays.get(piece.id) : undefined
      if (!clamp || !piece) continue
      this.lockOverlays.delete(piece.id)
      if (this.reducedMotion) {
        clamp.destroy()
      } else {
        this.tweens.add({
          targets: clamp,
          alpha: 0,
          scaleX: clamp.scaleX * 1.3,
          angle: 14,
          duration: 240,
          ease: 'Back.easeIn',
          onComplete: () => clamp.destroy(),
        })
      }
    }
    if (h.coatsStripped.length > 0) this.refreshCoatLabel()
  }

  /**
   * Say NO out loud. A swipe that refuses silently is indistinguishable from a dropped input, and
   * the player concludes the game is broken rather than that the piece is held — which is exactly
   * the confusion this mechanic caused on its first outing. The piece shudders against the swipe
   * and the invalid thud plays, borrowing the language the board already uses for a bad swap.
   */
  private refuseSwap(at: Coord): void {
    const piece = this.board.get(at)
    const sprite = piece ? this.sprites.get(piece.id) : undefined
    this.clearSelection()
    sfx.invalidThud()
    if (!sprite || this.reducedMotion) return
    const x0 = sprite.x
    this.tweens.add({
      targets: sprite,
      x: x0 + 6,
      duration: 52,
      yoyo: true,
      repeat: 2,
      ease: 'Sine.easeInOut',
      onComplete: () => sprite.setX(x0),
    })
  }

  /** The sweep counter: how much felt is still on the table. Hidden entirely when there is none. */
  private refreshCoatLabel(): void {
    if (!this.coatLabel) return
    const left = this.board.coatsRemaining()
    this.coatLabel.setText(left > 0 ? `FELT  ${this.coatsTotal - left}/${this.coatsTotal}` : 'TABLE SWEPT')
    this.coatLabel.setColor(left > 0 ? getTheme().goldText : css(getTheme().goldBright))
  }

  /**
   * Per-frame sync for the "armed" halos: keep each glow under its special sprite and breathe its
   * alpha (shared sine so they pulse in step — cheap, no per-glow tween). When a special's sprite
   * is gone (cleared / transformed / reshuffled) its halo is destroyed, so nothing leaks.
   */
  update(time: number, delta: number): void {
    // Trauma screenshake (E6): decay the accumulator and drive a camera offset. Directional when a
    // blast latched a vector; omnidirectional otherwise. Camera scroll shakes ALL scene content
    // (incl. the masked board) as one unit and is free. No-op under reduced motion (trauma never
    // accumulates — addTrauma is gated), so the board sits perfectly still.
    // The BOARD SLAM kick (a deliberate vertical dip) rides ON TOP of the trauma rattle: trauma is the
    // gritty crisp part of the hit, the kick is the clean directional slam-and-spring.
    const kick = this.boardKick.y
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - (delta / 1000) * 2.6)
      const amp = 14 * this.trauma * this.trauma
      let ox: number
      let oy: number
      if (this.traumaDirX !== 0 || this.traumaDirY !== 0) {
        const main = Math.random() * 2 - 1
        const cross = (Math.random() * 2 - 1) * 0.3
        ox = amp * (this.traumaDirX * main - this.traumaDirY * cross)
        oy = amp * (this.traumaDirY * main + this.traumaDirX * cross)
      } else {
        ox = amp * (Math.random() * 2 - 1)
        oy = amp * (Math.random() * 2 - 1)
      }
      if (this.trauma === 0) {
        this.traumaDirX = 0
        this.traumaDirY = 0
        ox = 0
        oy = 0
      }
      this.cameras.main.setScroll(ox, restScrollY() + oy + kick)
    } else if (kick !== 0) {
      this.cameras.main.setScroll(0, restScrollY() + kick) // slam still springing after the rattle died
    } else if (this.cameras.main.scrollX !== 0 || this.cameras.main.scrollY !== restScrollY()) {
      this.cameras.main.setScroll(0, restScrollY())
    }
    // Ambient cabinet glow (C1): breathe off the shared `heartbeat` so it pulses in phase with Home's
    // PLAY halo and every other breather. Skipped under reduced motion (holds the static mid-glow set
    // in buildBackdrop) and while a win surge (flashCabinet) briefly owns the alpha.
    if (this.cabinetGlow && !this.reducedMotion && !this.cabinetSurge) {
      this.cabinetGlow.setAlpha(0.1 + heartbeat.amp() * 0.08) // ~0.1 rest → ~0.18 peak, matching the retired yoyo
    }
    if (this.armedGlows.size > 0) {
      const a = 0.16 + 0.14 * (0.5 + 0.5 * Math.sin(time / 300))
      for (const [id, glow] of this.armedGlows) {
        const sprite = this.sprites.get(id)
        if (sprite && sprite.active) {
          glow.setPosition(sprite.x, sprite.y)
          if (!this.reducedMotion) glow.setAlpha(a)
        } else {
          glow.destroy()
          this.armedGlows.delete(id)
        }
      }
    }
    // Clamps ride their piece and die with it — the SAME upkeep rule as the armed halos above,
    // and skipping it is not cosmetic. A clamp is a separate GameObject keyed by piece id, so
    // without this loop two things go wrong: it stays at the position where the piece was created
    // (so it drifts off as the piece falls), and it survives the piece being matched away — a
    // clamped piece still MATCHES, so this happens constantly. What the player then sees is a
    // clamp sitting on a cell whose piece is long gone, apparently refusing to break no matter
    // what they clear next to it, while the piece that fell in underneath is not clamped at all.
    // That reads as the mechanic being broken, because it is.
    for (const [id, clamp] of this.lockOverlays) {
      const sprite = this.sprites.get(id)
      if (sprite && sprite.active) {
        clamp.setPosition(sprite.x, sprite.y)
      } else {
        clamp.destroy()
        this.lockOverlays.delete(id)
      }
    }
    // Goal halos: keep each under its piece and shimmer its alpha. A per-piece phase (off the
    // stable id) desyncs them into a gentle TWINKLE across the board — visually apart from the
    // armed glow's in-step breathe — and it's lower/cooler so a goal never reads as "armed".
    if (this.goalGlows.size > 0) {
      const gt = time / 480
      for (const [id, glow] of this.goalGlows) {
        const sprite = this.sprites.get(id)
        if (sprite && sprite.active) {
          glow.setPosition(sprite.x, sprite.y)
          if (!this.reducedMotion) glow.setAlpha(0.09 + 0.12 * (0.5 + 0.5 * Math.sin(gt + (id % 13) * 0.5)))
        } else {
          glow.destroy()
          this.goalGlows.delete(id)
        }
      }
    }
    // B4 rare idle twinkle: while the board truly rests (idle state + governor-idle, not reduced motion,
    // not low tier) let ONE random piece gleam every ~8–12s — a single sparse glint, NOT the removed
    // board-wide sweep. The moment anything happens (a touch flips quality.idle() false, or a resolve
    // leaves 'idle') we push the next fire a full interval out and kill any gleam mid-flight, so it
    // disarms instantly and never glints the moment rest resumes.
    if (this.state === 'idle' && !this.reducedMotion && quality.idle() && quality.count(1) > 0) {
      if (!this.twinkleGleam && time >= this.nextTwinkleAt) {
        this.nextTwinkleAt = time + Phaser.Math.Between(8000, 12000)
        this.twinklePiece()
      }
    } else {
      if (this.twinkleGleam) this.disarmTwinkle()
      this.nextTwinkleAt = time + 10000
    }
    // Power bar reads active only while the board rests — dim it (visual "can't buy now") during any
    // resolve/swap so it matches the buy handlers' idle guard. Hidden entirely during aim + on level end.
    if (this.powerBar && this.powerBar.visible) {
      const want = this.state === 'idle' ? 1 : 0.5
      if (this.powerBar.alpha !== want) this.powerBar.setAlpha(want)
    }
  }

  // ----------------------------------------------------------------- input

  private onDown(p: Phaser.Input.Pointer): void {
    if (this.introOpen) return // §E14 — ignore board taps while the first-run card is up
    // The cheat strip claims every gesture that starts below the board (endless, settled board
    // only). Claimed BEFORE the board paths below because it must not read as one: the strip is
    // outside the grid, so `xyToCell` would return null and the tap would silently clear the
    // player's selection seven times over while they entered the code.
    if (this.cheatStripLive(p.worldY)) {
      this.cheatFrom = { x: p.worldX, y: p.worldY }
      this.cheatConsumed = false
      this.dragFrom = null // a strip gesture is never a board drag
      return
    }
    // Bomb aim mode: the tap PLACES the purchased blast instead of selecting a piece. A tap off the
    // board (e.g. the Cancel pill below it) resolves to no cell → the bomb stays armed. Armed only from
    // idle, but guard state anyway so a stray tap can never start a resolve on an unsettled board.
    if (this.bombArmed) {
      if (this.state !== 'idle') return
      const cell = this.xyToCell(p.worldX, p.worldY)
      if (cell) this.detonatePurchasedBomb(cell)
      return
    }
    // §G1 INPUT BUFFER — a gesture started mid-resolve is REMEMBERED, not dropped. Every genre
    // leader lets you line up the next swap while a cascade plays; this scene used to bail here, so
    // a four-deep chain ate ~2s of input and the board felt unresponsive exactly when it was at its
    // most exciting. `resolving` only — never `swapping` (the swap tween is 130ms, too short to aim
    // into), never `ended`/`shuffling` (the board is leaving or being rebuilt).
    if (this.state !== 'idle') {
      if (this.state === 'resolving') {
        const at = this.xyToCell(p.worldX, p.worldY)
        if (at) {
          this.bufferFrom = at
          this.bufferStartX = p.worldX
          this.bufferStartY = p.worldY
          this.bufferConsumed = false
        }
      }
      return
    }
    this.disarmTwinkle() // B4 — the board is being touched; kill any idle gleam instantly
    // Pieces are WORLD objects (rendered at BOARD_X/Y + col/row*CELL). Since the fill-screen change
    // scrolls the main camera by restScrollY() to centre the design box, game-space (p.x/p.y) no
    // longer equals world-space — so hit-test the cell against the camera-converted WORLD point.
    // Phaser sets p.worldX/worldY from the main camera (scroll incl.) before this event fires.
    const cell = this.xyToCell(p.worldX, p.worldY)
    if (!cell) {
      this.clearSelection()
      this.dragFrom = null
      return
    }
    this.disarmHint() // the player is engaging the board — retire the nudge
    this.dragFrom = cell
    this.dragStartX = p.worldX
    this.dragStartY = p.worldY
    this.dragConsumed = false
  }

  private onMove(p: Phaser.Input.Pointer): void {
    // Cheat strip: one swipe per touch, read the instant it clears the distance bar (so the code
    // can be entered as a fast rhythm of flicks without waiting for each finger-up).
    if (this.cheatFrom) {
      if (this.cheatConsumed) return
      const dir = swipeDir(p.worldX - this.cheatFrom.x, p.worldY - this.cheatFrom.y)
      if (!dir) return
      this.cheatConsumed = true
      this.cheatTick(this.cheatFrom.x, this.cheatFrom.y)
      if (this.cheatCode.feed(dir, this.time.now)) this.fireMegaWin()
      return
    }
    // §G1 — a swipe completed during a resolve books the swap for the moment the board settles.
    if (this.state === 'resolving' && this.bufferFrom && !this.bufferConsumed) {
      const bdx = p.worldX - this.bufferStartX
      const bdy = p.worldY - this.bufferStartY
      if (Math.max(Math.abs(bdx), Math.abs(bdy)) >= DRAG_THRESHOLD) {
        this.bufferConsumed = true
        const from = this.bufferFrom
        const to: Coord =
          Math.abs(bdx) > Math.abs(bdy)
            ? { row: from.row, col: from.col + Math.sign(bdx) }
            : { row: from.row + Math.sign(bdy), col: from.col }
        this.bookSwap(from, to)
      }
      return
    }
    if (this.state !== 'idle' || !this.dragFrom || this.dragConsumed) return
    const dx = p.worldX - this.dragStartX // world-space deltas (dragStartX/Y are world; see onDown)
    const dy = p.worldY - this.dragStartY
    if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return
    this.dragConsumed = true
    const from = this.dragFrom
    const target: Coord =
      Math.abs(dx) > Math.abs(dy)
        ? { row: from.row, col: from.col + Math.sign(dx) }
        : { row: from.row + Math.sign(dy), col: from.col }
    if (this.board.inBounds(target)) {
      this.clearSelection()
      void this.trySwap(from, target)
    }
  }

  private onUp(p: Phaser.Input.Pointer): void {
    void p
    // Cheat strip: the finger lifts, the gesture is over. Never falls through to the board paths —
    // a tap on the strip is not a selection, and the code's rhythm must not disturb the board.
    if (this.cheatFrom) {
      this.cheatFrom = null
      return
    }
    // §G1 — a tap-tap pair completed mid-resolve books its swap too, so the two input idioms stay
    // equivalent. A lone tap during a resolve only arms the pair; it never paints a selection ring
    // (the ring is an idle affordance and would sit over a moving board).
    if (this.state === 'resolving') {
      const cell = this.bufferFrom
      if (cell && !this.bufferConsumed) {
        if (this.bufferSelected && Board.areAdjacent(this.bufferSelected, cell)) {
          const from = this.bufferSelected
          this.bufferSelected = null
          this.bookSwap(from, cell)
        } else if (
          this.bufferSelected &&
          this.bufferSelected.row === cell.row &&
          this.bufferSelected.col === cell.col
        ) {
          this.bufferSelected = null
        } else {
          this.bufferSelected = cell
        }
      }
      this.bufferFrom = null
      return
    }
    if (this.state === 'idle' && this.dragFrom && !this.dragConsumed) {
      const cell = this.dragFrom
      if (this.selected && Board.areAdjacent(this.selected, cell)) {
        const from = this.selected
        this.clearSelection()
        void this.trySwap(from, cell)
      } else if (this.selected && this.selected.row === cell.row && this.selected.col === cell.col) {
        this.clearSelection()
      } else {
        this.select(cell)
      }
    }
    this.dragFrom = null
  }

  /**
   * §G1 — record a swap aimed while the board was resolving. Bounds are checked now (cheap, and a
   * swipe off the edge should not occupy the single slot); everything else is re-checked at flush,
   * because the board the player was aiming at is not the board they will get.
   */
  private bookSwap(from: Coord, to: Coord): void {
    if (!this.board.inBounds(to)) return
    this.bookedSwap = { from, to, at: this.time.now }
  }

  /** Drop any booked swap. Called when the level ends and whenever the board is rebuilt. */
  private clearBookedSwap(): void {
    this.bookedSwap = null
    this.bufferFrom = null
    this.bufferSelected = null
    this.bufferConsumed = false
  }

  /**
   * §G1 — replay a booked swap at the idle handoff. Returns true if it started a swap (in which case
   * the caller must NOT arm the hint/autoplay — `trySwap` owns the board again).
   *
   * Two guards, and both matter:
   *  - EXPIRY. A book older than `BUFFERED_SWAP_MS` is intent the player has stopped meaning. Without
   *    this, a swipe made at the start of a long chain fires seconds later, out of nowhere.
   *  - VALIDITY. The pieces under those coordinates have changed — gravity ran. `wouldSwapMatch` is
   *    the same predicate the hint engine and the reshuffle check use, so a booked swap is held to
   *    exactly the standard a live one is. An invalid book is dropped SILENTLY: replaying it into
   *    `trySwap` would thud and shake at a board the player never actually swiped at.
   */
  private flushBookedSwap(): boolean {
    const booked = this.bookedSwap
    this.bookedSwap = null
    if (!booked) return false
    if (this.time.now - booked.at > BUFFERED_SWAP_MS) return false
    if (!this.board.inBounds(booked.from) || !this.board.inBounds(booked.to)) return false
    if (!Board.areAdjacent(booked.from, booked.to)) return false
    if (!this.board.wouldSwapMatch(booked.from, booked.to)) return false
    this.clearSelection()
    void this.trySwap(booked.from, booked.to)
    return true
  }

  // -------------------------------------------------------- the cheat strip (core/cheat.ts)

  /**
   * Is `worldY` on a strip that is currently listening? Endless only, below CHEAT_ZONE_TOP, and only
   * while the board RESTS.
   *
   * The idle requirement is doing real work, not just being tidy. It is what keeps the strip from
   * ever colliding with something else that owns the screen: every modal this scene can raise over
   * the board — the Plinko drop, the Lucky Deal, the result card, a reshuffle — holds the state at
   * `resolving` or `ended` for exactly as long as it is up. So one condition retires the whole class
   * of "the code fired underneath an overlay" bugs, and it means a mega win can never be requested
   * while a previous one is still cascading.
   */
  private cheatStripLive(worldY: number): boolean {
    return this.endless && this.state === 'idle' && !this.introOpen && worldY >= CHEAT_ZONE_TOP
  }

  /**
   * The strip's ONE affordance: a soft gold bloom under the finger, plus the lightest haptic tick.
   *
   * Fires on EVERY swipe the strip reads, right or wrong, and says nothing about progress — so it
   * confirms "that registered" to someone entering the code without hinting to anyone else that
   * there is a code, which is the whole point of a secret. It is mostly there for the haptic: on a
   * phone the player's own thumb covers the bloom, and a blind gesture surface with no feedback at
   * all is indistinguishable from a broken one.
   */
  private cheatTick(x: number, y: number): void {
    this.vibrate(8)
    const dot = this.add.circle(x, y, 7, getTheme().gold, 0.42).setDepth(30)
    this.tweens.add({
      targets: dot,
      alpha: 0,
      scale: this.reducedMotion ? 1 : 2.4,
      duration: 420,
      ease: 'Cubic.easeOut',
      onComplete: () => dot.destroy(),
    })
  }

  /**
   * MEGA WIN — the cheat's payoff. Plants a jackpot chip, a row reel, a column reel and a dice bomb
   * across the middle of the board, then detonates a 5×5 over the lot, so all four chain at once:
   * two whole symbols leave the board, a full row and a full column blow out, and the crater
   * cascades on refill. Paid at MEGA_WIN_MULT for the duration.
   *
   * Deliberately routed through the ORDINARY machinery — `board.plant`, `board.detonate`, then
   * `resolveLoop` — rather than a bespoke scoring path. It costs no move (nothing here touches
   * `movesLeft`, exactly as the purchased bomb doesn't), which is what makes the score runnable: the
   * budget is untouched, so the code can be entered as often as the player has patience for.
   *
   * And every fire ends in a Plinko drop. The run's ordinary once-per-run latch is left standing for
   * ordinary chains; `cheatDropPending` is what lets the cheat stack them, one drop per mega win.
   *
   * The `state` handoff mirrors `detonatePurchasedBomb`: lock to `resolving` before anything can
   * await, and let `resolveLoop` own the way back to idle — including the run's end, if this was
   * fired on the last move.
   */
  private fireMegaWin(): void {
    if (this.state !== 'idle') return // belt-and-braces; cheatStripLive already checked
    this.cheatFires++
    this.log('MEGA WIN', this.cheatFires)
    this.state = 'resolving'
    this.cheatDropPending = true // every mega win ends in a Plinko drop, however many that is
    this.clearSelection()
    this.disarmHint()
    this.disarmTwinkle()

    const centre: Coord = { row: 4, col: 4 }
    const plants: { at: Coord; kind: PieceKind }[] = [
      { at: { row: 3, col: 3 }, kind: 'jackpot' },
      { at: { row: 3, col: 4 }, kind: 'wildReelRow' },
      { at: { row: 4, col: 3 }, kind: 'wildReelCol' },
      { at: centre, kind: 'diceBomb' },
    ]
    for (const p of plants) {
      // ⚠️ `plant` REPLACES the cell with a freshly-minted piece, so the piece that was there stops
      // existing and its sprite is orphaned the instant we plant. `sprites` is keyed by piece id and
      // nothing reaps an id that simply vanished from the grid — the clear path only retires pieces
      // it actually popped, and the transform path only those it morphed. So the old sprite stays on
      // screen forever and the special draws ON TOP of it: pieces visibly stacked on the four centre
      // cells, for the rest of the run, multiplying with every mega win.
      //
      // Retire the outgoing sprite first, exactly as `runWaveEffects` does for `wave.transformed`,
      // then draw the new piece. Deleting from `sprites` is also what lets the armed-halo upkeep in
      // `update()` collect the old glow — it reaps any entry whose id no longer has a live sprite,
      // so a leaked id would leave a gold halo burning over an empty cell too.
      //
      // The other two `board.plant` callers (`applyBoosts`, the `?plant` dev hook) are safe without
      // this: both run during setup, BEFORE any sprite exists, so there is nothing to orphan. This is
      // the only path that plants onto a board the player is already looking at.
      const outgoing = this.board.get(p.at)
      this.board.plant(p.at, p.kind)
      if (outgoing) {
        const old = this.sprites.get(outgoing.id)
        if (old) {
          this.sprites.delete(outgoing.id)
          this.tweens.killTweensOf(old) // Phaser never sweeps tweens for a destroyed target
          old.destroy()
        }
      }
      const planted = this.board.get(p.at)
      if (planted) this.createSprite(planted, p.at)
      this.specialBirth(p.at)
    }

    this.showBoardBanner('★  MEGA WIN  ★')
    sfx.powerOn()
    sfx.jackpotStrike()
    this.vibrate([50, 40, 110])
    const pos = this.cellToXY(centre)
    this.punch({ trauma: 0.45, flash: { x: pos.x, y: pos.y, size: CELL * 2.4 } })

    const base = this.scoreMult
    this.scoreMult = base * MEGA_WIN_MULT
    // `resolveLoop` swallows its own errors and always settles, so the multiplier is always handed
    // back — a leaked ×12 would silently re-price every ordinary match for the rest of the run.
    void this.resolveLoop(this.board.detonate(centre, 2)).then(() => {
      this.scoreMult = base
    })
  }

  private select(at: Coord): void {
    this.clearSelection()
    this.selected = at
    const pos = this.cellToXY(at)
    const ring = this.hc && this.hcRing ? this.hcRing : this.ring
    ring.setPosition(pos.x, pos.y).setVisible(true)
    this.selectedSprite = this.sprites.get(this.board.get(at)!.id) ?? null
    // Selected-piece pulse — gated (§E8): reduced motion relies on the static ring alone for the tell.
    if (this.selectedSprite && !this.reducedMotion) {
      this.selectPulse = this.tweens.add({
        targets: this.selectedSprite,
        scale: PIECE_SCALE * 1.12,
        duration: 240,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
    this.armSelectTelegraph(at) // B2: lean the swappable neighbors in (no-op under reduced motion)
  }

  private clearSelection(): void {
    this.selectPulse?.stop()
    this.selectPulse = null
    this.selectedSprite?.setScale(PIECE_SCALE)
    this.selectedSprite = null
    this.selected = null
    this.ring.setVisible(false)
    this.hcRing?.setVisible(false)
    this.disarmSelectTelegraph() // B2: settle the leaned neighbors back to their exact grid homes
  }

  /**
   * B2 magnetic select telegraph: the ≤4 in-bounds ORTHOGONAL neighbors of the selected cell lean
   * ~3px toward it and Back-settle — a tactile "these are your options" cue that complements the
   * selection ring. Each leaned sprite is stored with its EXACT grid-home position so disarm restores
   * it pixel-perfectly. Reduced motion → no lean (the ring alone carries the tell); ≤4 tiny transform
   * tweens per selection, all cleared before any board change so nothing fights a swap/fall.
   */
  private armSelectTelegraph(at: Coord): void {
    if (this.reducedMotion) return
    const center = this.cellToXY(at)
    const LEAN = 3
    const dirs: Coord[] = [{ row: -1, col: 0 }, { row: 1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }]
    for (const d of dirs) {
      const nAt = { row: at.row + d.row, col: at.col + d.col }
      if (!this.board.inBounds(nAt)) continue
      const piece = this.board.get(nAt)
      if (!piece) continue
      const sprite = this.sprites.get(piece.id)
      if (!sprite || !sprite.active) continue
      const home = this.cellToXY(nAt)
      const dx = center.x - home.x
      const dy = center.y - home.y
      const len = Math.hypot(dx, dy) || 1
      this.leanHomes.push({ sprite, x: home.x, y: home.y })
      this.leanTweens.push(
        this.tweens.add({
          targets: sprite,
          x: home.x + (dx / len) * LEAN,
          y: home.y + (dy / len) * LEAN,
          duration: 220,
          ease: 'Back.easeOut',
        })
      )
    }
  }

  /** Disarm B2: kill any half-finished lean tweens and snap the neighbors back to their grid homes. */
  private disarmSelectTelegraph(): void {
    if (this.leanTweens.length === 0 && this.leanHomes.length === 0) return
    for (const tw of this.leanTweens) tw.stop()
    this.leanTweens = []
    for (const { sprite, x, y } of this.leanHomes) if (sprite.active) sprite.setPosition(x, y)
    this.leanHomes = []
  }

  /**
   * B1 swipe-intent trail: a faint spark follow rides the grabbed piece as it glides on a swap, so the
   * gesture reads as physical intent before the pieces snap. A dedicated follow-emitter (the same idiom
   * as the reel missile trail), reusing the baked `spark` texture and retired the instant the glide
   * resolves. Reduced motion → no trail; governor-capped (off entirely on the low tier via
   * count(1)===0, and its live-particle budget sized by quality.count so it never gets busy).
   */
  private startSwipeTrail(sprite: Phaser.GameObjects.Sprite): void {
    this.stopSwipeTrail() // never stack two trails — a fresh swap owns the follow
    if (this.reducedMotion || quality.count(1) === 0) return
    const trail = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 10, max: 55 },
        scale: { start: 0.4, end: 0 },
        alpha: { start: 0.5, end: 0 },
        lifespan: { min: 150, max: 280 },
        tint: [0xffb01c, 0xffdc5c],
        quantity: 1,
        frequency: 26,
        maxAliveParticles: quality.count(9),
        emitting: true,
      })
      .setDepth(20) // above the tiles/pieces, below the HUD — rides the piece, never a board-wide wash
    trail.startFollow(sprite)
    this.swipeTrail = trail
  }

  /** Retire the B1 trail: stop emitting + following, then free the emitter once its tail has faded. */
  private stopSwipeTrail(): void {
    const trail = this.swipeTrail
    if (!trail) return
    this.swipeTrail = null
    trail.stop()
    trail.stopFollow()
    this.time.delayedCall(320, () => trail.destroy())
  }

  // ------------------------------------------------------------ game flow

  private async trySwap(a: Coord, b: Coord): Promise<void> {
    const pa = this.board.get(a)
    const pb = this.board.get(b)
    if (!pa || !pb) return
    // Hazards gate the move HERE, not only inside `wouldSwapMatch`. That helper is consulted by the
    // hint engine, the reshuffle check and the autoplay — but NOT by the swipe (`onMove`) or
    // tap-tap (`onUp`) paths, which call straight through to this method. Enforcing the rule only
    // in the helper meant a clamped piece could simply be dragged: the lock was visible, taught by
    // an intro card, and completely unenforced against actual input.
    const stuck = pa.locked ? a : pb.locked ? b : pa.kind === 'blocker' ? a : pb.kind === 'blocker' ? b : null
    if (stuck) {
      this.refuseSwap(stuck)
      return
    }
    this.state = 'swapping'
    this.disarmHint() // idle effects yield to the move (§3d composition)
    this.disarmSelectTelegraph() // B2: restore any leaned neighbors before the board animates
    sfx.swap()

    const sa = this.sprites.get(pa.id)!
    const sb = this.sprites.get(pb.id)!
    const posA = this.cellToXY(a)
    const posB = this.cellToXY(b)

    // B1: a faint spark trail rides the grabbed piece across the glide (physical intent), retired the
    // instant the pieces snap. Reduced-motion / low tier → no trail (handled inside the helper).
    this.startSwipeTrail(sa)
    // Anticipation + follow-through (Pass 2, medium): a gentle Back.InOut so each piece winds up ~1-2px
    // against the swap vector, then glides over and SETTLES with a small overshoot — a "load then
    // release" swap in one free curve. Curve-only, same SWAP_MS; reduced motion keeps the flat glide.
    const swapEase = this.reducedMotion ? 'Quad.easeOut' : (v: number) => Phaser.Math.Easing.Back.InOut(v, 1.1)
    await Promise.all([
      this.t({ targets: sa, x: posB.x, y: posB.y, duration: SWAP_MS, ease: swapEase }),
      this.t({ targets: sb, x: posA.x, y: posA.y, duration: SWAP_MS, ease: swapEase }),
    ])
    this.stopSwipeTrail()
    this.board.swap(a, b)

    let wave = this.board.swapActivation(a, b)
    if (!wave) {
      if (this.board.findRuns().length === 0) {
        // Invalid: thud and snap back. No move spent.
        this.board.swap(a, b)
        sfx.invalidThud()
        // Directional thud (P4): recoil the screen ALONG the rejected swap axis, not an undirected
        // wash. Recoil follow-through (P3): the pieces slam home and spring a hair off the invalid
        // "wall" via backOut instead of decelerating to a dead stop — same INVALID_MS, reduced-motion
        // keeps the flat snap (trauma is already gated off inside punch()).
        this.punch({ trauma: 0.22, dirX: posB.x - posA.x, dirY: posB.y - posA.y })
        const invalidEase = this.reducedMotion ? 'Quad.easeIn' : backOut(OVERSHOOT.gentle)
        await Promise.all([
          this.t({ targets: sa, x: posA.x, y: posA.y, duration: INVALID_MS, ease: invalidEase }),
          this.t({ targets: sb, x: posB.x, y: posB.y, duration: INVALID_MS, ease: invalidEase }),
        ])
        this.state = 'idle'
        this.scheduleAutoplay()
        this.armHint()
        return
      }
      wave = this.board.matchWave([b, a])
    }

    this.movesLeft--
    this.moveMade = true
    this.movesText.setText(String(this.movesLeft))
    if (this.movesLeft <= 5) this.movesText.setColor(getTheme().warn)
    // Getting tight — start a gentle looping pulse on the moves number (once, no stacking). Gated
    // (§E8): reduced motion keeps the warn colour above (the real signal), just no pulse.
    if (this.movesLeft <= 3 && !this.movesPulse && !this.reducedMotion) {
      this.movesPulse = this.tweens.add({
        targets: this.movesText,
        scale: 1.08,
        duration: 500,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      })
    }
    await this.resolveLoop(wave)
  }

  /** Play waves until the board settles, then check for win/lose. */
  private async resolveLoop(first: ClearWave | null): Promise<void> {
    this.state = 'resolving'
    try {
      let cascade = 0
      let wave = first
      this.comboPeakTier = 0 // fresh chain — the MEGA strike re-punctuates each new tier this resolve
      this.chainPoints = 0 // ...and a fresh stake for a possible Plinko drop
      while (wave) {
        cascade++
        this.dbgStage = `playWave c${cascade} cl=${wave.cleared.length} tr=${wave.transformed.length} ev=${wave.events.length}`
        this.log(this.dbgStage)
        await this.playWave(wave, cascade)
        this.playHazardEffects(wave) // felt sweeps + lockbox cracks land on the beat of the match
        const falls = this.board.applyGravity()
        const spawns = this.board.refill()
        this.dbgStage = `falls c${cascade} f=${falls.length} s=${spawns.length}`
        this.log(this.dbgStage)
        await this.animateFalls(falls, spawns)
        this.dbgStage = `matchWave c${cascade}`
        this.log(this.dbgStage)
        wave = this.board.matchWave()
      }
      this.megaFinish(cascade) // the "in awe" release — a deep chain erupts once more as it settles
      this.fadeCombo() // E11: the cascade settled — resolve the combo readout (composes with the win peak)
      this.maybeAwardFreeSpins(cascade) // R4: a MEGA-grade chain banks free spins + flies the golden ticket
      this.dbgStage = 'end-checks'
      this.log('end-checks', 'objectivesDone', this.objectives.every(o => o.remaining <= 0), 'movesLeft', this.movesLeft)
      // Endless never "wins" on objectives (it has none) — it ends when moves run out.
      // Coats add the sweep: collecting every goal is no longer enough if felt is still on the
      // table. `coatsRemaining()` is 0 on every hazard-free level, so this reads as before there.
      if (!this.endless && this.objectives.every(o => o.remaining <= 0) && this.board.coatsRemaining() === 0) {
        this.finishWin()
        return
      }
      if (this.movesLeft <= 0) {
        if (this.endless) this.finishEndless()
        // §G2 — the genre's highest-leverage 30 seconds: offer to keep THIS board alive before the
        // level is called. `offerContinue` returns true when it took the screen (it then owns the
        // handback: buy → resume idle, or decline → finishLose). False = nothing to offer, fall
        // straight through to the loss exactly as before.
        else if (!this.offerContinue()) this.finishLose()
        return
      }
      if (!this.board.hasValidMove()) await this.reshuffle()
      // A SUPER-MEGA-grade chain can buy a Plinko drop. Offered only HERE — after the win/lose checks
      // above have returned — so the overlay can never collide with the result card, and only on a
      // board that's about to be playable again. When it opens it OWNS the handback (its CLAIM
      // restores idle), so return rather than falling through to the three lines below.
      if (this.offerPlinko(cascade)) return
      this.state = 'idle'
      // §G1 — hand the board back to a swap the player already aimed, before arming the idle nudges.
      // A flushed swap re-enters `resolveLoop`, which owns the next handoff; arming the hint here too
      // would fight it (and `armHint` on a board that is about to move is a wasted timer).
      if (this.flushBookedSwap()) return
      // §G11 — a first-ever special earns its teach card here, on a settled board, so the card
      // explains a piece the player can actually see sitting there. It owns the handoff too.
      if (this.maybeSpecialIntro()) return
      this.scheduleAutoplay()
      this.armHint()
    } catch (err) {
      // Safety net: trySwap is fire-and-forget (`void this.trySwap`), so an unhandled throw anywhere in
      // the resolve path would leave the board stuck in 'resolving' forever — a permanent input freeze.
      // Log it and recover to a playable idle (the board model stays the source of truth) so the round
      // can continue instead of dead-locking.
      this.log('resolveLoop ERROR', err)
      // Cast: TS narrows `state` to the try's assignments and can't see finishWin/finishLose set 'ended'
      // via a method call — but a throw inside those (after the level ended) must not resurrect the board.
      if ((this.state as GameState) !== 'ended') {
        this.state = 'idle'
        this.scheduleAutoplay()
        this.armHint()
      }
    }
  }

  private async playWave(wave: ClearWave, cascade: number): Promise<void> {
    const transformedKeys = new Set(wave.transformed.map(t => key(t.at)))
    const pops = wave.cleared.filter(c => !transformedKeys.has(key(c.at)))

    // Signature clear blip, once per wave — rises a semitone per cascade step.
    sfx.pop(cascade)

    const clearedIds = new Set(wave.cleared.map(c => c.piece.id))

    // Match-size weighting (E6/E11 first-wave part): a big OPENING match reads as weight instantly —
    // a brighter flash + extra spark + a small trauma kick, BEFORE any cascade (cascades get their
    // own combo beat below). Reduced motion keeps the flash, drops the kick (both gated in punch()).
    if (cascade === 1 && wave.cleared.length >= 5) {
      const bigAt = wave.events[0]?.at ?? pops[0]?.at
      if (bigAt) {
        const bp = this.cellToXY(bigAt)
        this.punch({ trauma: 0.3, flash: { x: bp.x, y: bp.y, size: CELL * 1.3 } })
        if (!this.reducedMotion && quality.count(1) > 0) this.sparkEmitter.explode(quality.count(12), bp.x, bp.y)
      }
    }

    // Effect choreography — charge → graded hitstop → release (E6, signature moment #4). The clear
    // pop of every cell is delayed by the same charge window (below) so the wind-up reads first.
    const hasEvents = wave.events.length > 0
    const chargeMs = hasEvents && !this.reducedMotion ? 70 : 0
    let effectMs = 0
    if (hasEvents) {
      // The deepest event this wave owns the single freeze: reel 0 / bomb ~45 / jackpot·mega ~70ms.
      let hitstopMs = 0
      for (const e of wave.events) {
        if (e.type === 'bomb') hitstopMs = Math.max(hitstopMs, 60) // a heftier freeze so the slam lands
        else if (e.type === 'jackpot') hitstopMs = Math.max(hitstopMs, 70)
      }
      if (cascade >= 4) hitstopMs = Math.max(hitstopMs, 70)

      for (const e of wave.events) {
        this.chargeFlare(e.at) // wind-up on every detonating tile
        // §R3: the jackpot chip's colour-clear earns a charge-up shimmer riding the same wind-up
        // window (gleam + gold swell overlap the release, so the payoff reads charged, not instant).
        if (e.type === 'jackpot') this.jackpotChargeShimmer(e.at)
      }
      let flashes = 0 // §R3 activation-flash budget — ≤3/wave (photosensitivity + fill-rate cap)
      this.time.delayedCall(chargeMs, () => {
        this.hitstop(hitstopMs) // freeze, then release the explosions on the same frame
        for (const e of wave.events) {
          // §R3 activation flash: a soft white radial at the special's cell the moment it fires.
          // Created under the freeze, so it HOLDS at peak through the hitstop and decays on release.
          if (flashes < 3) {
            this.activationFlash(e.at)
            flashes++
          }
          if (e.type === 'reel') this.detonateReel(e.at, e.horizontal, cascade)
          else if (e.type === 'bomb') this.detonateBomb(e.at, e.radius, cascade)
          else this.detonateJackpot()
        }
        // The board reacts: surviving neighbors of the primary blast flinch outward + settle — a heavy
        // bomb/jackpot shoves them harder and DOWNWARD, rippling with the board slam (depth).
        if (wave.events[0]) {
          const ev0 = wave.events[0]
          const heavy = ev0.type === 'bomb' || ev0.type === 'jackpot'
          this.secondaryMotion(ev0.at, clearedIds, heavy ? 1.7 : 1, heavy ? 0.55 : 0)
        }
      })
      effectMs = chargeMs + 340
    } else if (pops.length >= 5) {
      // A chunky normal clear (no special) still shoves its surviving neighbors outward.
      const chunkAt = pops[0]?.at
      if (chunkAt) this.secondaryMotion(chunkAt, clearedIds)
    }

    // Scoring + objectives (specials count as their symbol; jackpot pieces don't). The MODEL
    // (obj.remaining) decrements SYNCHRONOUSLY here so win detection stays exact; the VISIBLE tick +
    // chip pop are deferred to the E10 collect-fly flyer's arrival below, so the decrement reads as
    // "the board fed the counter". We also remember which cleared cells fed each objective (for arc
    // origins). Reduced motion skips the arc and settles the display in place, instantly.
    const changedObjectives = new Set<ObjectiveState>()
    const collectSources = new Map<ObjectiveState, Coord[]>()
    for (const { piece, at } of wave.cleared) {
      if (piece.kind === 'jackpot' || piece.kind === 'blocker') continue
      const obj = this.objectives.find(o => o.symbol === piece.symbol)
      if (obj && obj.remaining > 0) {
        obj.remaining--
        changedObjectives.add(obj)
        const src = collectSources.get(obj)
        if (src) src.push(at)
        else collectSources.set(obj, [at])
      }
    }
    if (this.reducedMotion) {
      // E10 fallback: no arc — the existing instant decrement + chip pop (+ complete stamp).
      for (const o of changedObjectives) this.settleCollect(o)
    } else {
      // Collect-fly (E10): arc a small copy of the cleared symbol from the board to its COLLECT chip,
      // and only THEN tick the counter + pop it. Capped to ≤3 flyers/wave, split greedily across the
      // objectives that changed (representative cells if more cleared); a starved objective settles
      // instantly so the visible count never desyncs from the model.
      let flyBudget = 3
      for (const o of changedObjectives) {
        const sources = collectSources.get(o) ?? []
        const n = Math.min(sources.length, flyBudget)
        if (n <= 0) {
          this.settleCollect(o)
          continue
        }
        flyBudget -= n
        this.flyCollect(o, sources.slice(0, n))
      }
    }
    const wavePoints = wave.cleared.length * POINTS_PER_PIECE * cascade
    this.chainPoints += wavePoints // the stake a Plinko drop multiplies, if this chain earns one
    this.addScore(wavePoints)
    if (cascade >= 2) {
      this.showCombo(cascade)
      // Cascade rumble routed through the single trauma authority (crisp + decayed, never muddy).
      this.punch({ trauma: Math.min(0.5, 0.12 + cascade * 0.06) })
    }
    // The screen inhales with a big beat: a soft one-shot zoom kiss on deep cascades and chunky
    // clears, layered under the trauma shake (which stays the crisp part of the hit). Self-gated
    // (reduced motion / LOW tier → no-op) and amplitude-capped so it reads as breath, never lurch.
    if (cascade >= 3 || pops.length >= 7) this.cameraBreath(Math.min(0.016, 0.006 + cascade * 0.003))

    // Pop cleared sprites, staggered outward from the first effect's epicenter.
    const epicenter = wave.events[0]?.at ?? pops[0]?.at
    // One floating "+N" per wave at the clear epicenter — bigger on chunky cascades.
    if (epicenter) {
      const ep = this.cellToXY(epicenter)
      this.spawnScorePopup(wavePoints, ep.x, ep.y, cascade)
    }
    const promises: Promise<void>[] = []
    // §E3/B14: a light glassy "tink" partners each clear pop, key-locked (an octave above pop's climb)
    // + panned by column, so the cells you see clear right you hear right. Capped so a huge jackpot
    // clear stays a shimmer, not a clatter; the outward stagger spreads them into an arpeggio.
    let tinks = 0
    // §R3 payoff sparkles: in a wave with a SPECIAL payoff, every cleared cell earns a small white
    // star-glint (budgeted per wave, quality.count-scaled, spent at schedule time so a huge clear
    // can never over-spawn); the jackpot's colour-matched victims pop the BIG bright variant.
    const jackpotEvt = wave.events.find((e): e is Extract<BlastEvent, { type: 'jackpot' }> => e.type === 'jackpot')
    let glintBudget = hasEvents && !this.reducedMotion ? quality.count(14) : 0
    for (const { piece, at } of pops) {
      const sprite = this.sprites.get(piece.id)
      if (!sprite) continue
      this.sprites.delete(piece.id)
      // Cleared cells pop AFTER the charge wind-up (chargeMs) so the detonation reads charge→release.
      const delay = chargeMs + (epicenter ? (Math.abs(at.row - epicenter.row) + Math.abs(at.col - epicenter.col)) * 16 : 0)
      const pos = this.cellToXY(at)
      const tink = tinks < 10
      if (tink) tinks++
      const sparkle = glintBudget > 0
      if (sparkle) glintBudget--
      const jackpotHit =
        sparkle && jackpotEvt !== undefined && piece.kind === 'normal' && (jackpotEvt.symbol === null || jackpotEvt.symbol === piece.symbol)
      // Escalating clear richness: baseline burst counts are untouched on wave 1, then each cell earns
      // a few EXTRA fragments/sparks as the chain deepens (capped at +3 waves, `quality.count`-thinned
      // per device) — a deep cascade visibly showers harder without a huge jackpot clear ever clattering.
      const heatBoost = Math.min(cascade - 1, 3)
      this.time.delayedCall(delay, () => {
        if (tink) sfx.clearTink(cascade, this.colPan(at.col))
        if (sparkle) this.payoffGlint(pos.x, pos.y, jackpotHit) // §R3 special-payoff star-sparkle
        this.emitters[piece.symbol]?.explode(6 + quality.count(heatBoost * 3), pos.x, pos.y)
        this.sparkEmitter.explode(4 + quality.count(heatBoost * 2), pos.x, pos.y)
        // Subtle gloss pop — the emptied tile catches light on the clear. Reuses bgglow (ADD,
        // below the emitters), governor-gated for alpha/count, skipped under reduced-motion.
        if (!this.reducedMotion && quality.count(1) > 0) {
          const glow = this.add
            .image(pos.x, pos.y, 'bgglow')
            .setTint(0xffedc2)
            .setBlendMode(Phaser.BlendModes.ADD)
            .setDepth(19)
            .setDisplaySize(CELL * 0.72, CELL * 0.72)
            .setAlpha(0.5 * quality.scale())
          this.tweens.add({
            targets: glow,
            alpha: 0,
            scaleX: glow.scaleX * 1.8,
            scaleY: glow.scaleY * 1.8,
            duration: 190,
            ease: 'Quad.easeOut',
            onComplete: () => glow.destroy(),
          })
        }
      })
      promises.push(
        this.t({
          targets: sprite,
          scale: sprite.scale * 1.4,
          alpha: 0,
          delay,
          duration: CLEAR_MS,
          // Pass 2 (medium): a tiny Back.easeIn squash-dip (~-3.5%) before the piece pops to 1.4x and
          // vanishes — a wind-up on every match-pop. reducedMotion keeps the flat decelerate-out.
          ease: this.reducedMotion ? 'Quad.easeOut' : 'Back.easeIn',
        }).then(() => sprite.destroy())
      )
    }

    // Morph matched pieces into their earned specials.
    let births = 0
    for (const t of wave.transformed) {
      // §G11 — latch the FIRST special of each kind the player ever makes. The card itself waits for
      // the idle handoff (see resolveLoop): interrupting a live cascade to explain the thing that is
      // currently detonating would bury the very moment it is teaching.
      this.noteSpecialMade(t.to.kind)
      const old = this.sprites.get(t.from.id)
      if (old) {
        this.sprites.delete(t.from.id)
        old.destroy()
      }
      const sprite = this.createSprite(t.to, t.at)
      sprite.setScale(0)
      promises.push(
        this.t({ targets: sprite, scale: PIECE_SCALE, delay: 80, duration: 200, ease: backOut(OVERSHOOT.pop) })
      )
      // 3e: a quick gold ring implosion + spark celebrates the birth (cap ≤2/wave).
      if (births < 2) {
        this.specialBirth(t.at)
        births++
      }
    }

    promises.push(new Promise(resolve => this.time.delayedCall(effectMs, () => resolve())))
    await Promise.all(promises)
  }

  /** Tone particle counts down under prefers-reduced-motion (kept ≥1 so the beat still lands). */
  private motionCount(n: number): number {
    return this.reducedMotion ? Math.max(1, Math.ceil(n * 0.4)) : Math.round(n)
  }

  // ---------------------------------------------------- impact & weight (E5/E6)

  /**
   * The single shake/flash authority (KEY CROSS-LENS CALL #1). Every screen kick and impact-frame
   * flash routes through here so reduced-motion (gates trauma/freeze) and a future reduce-flashing
   * toggle (gates the white flash) each live in ONE place.
   */
  private punch(opts: { trauma?: number; dirX?: number; dirY?: number; flash?: { x: number; y: number; size?: number } }): void {
    if (opts.trauma) this.addTrauma(opts.trauma, opts.dirX ?? 0, opts.dirY ?? 0)
    if (opts.flash && !this.reduceFlashing) this.impactFrame(opts.flash.x, opts.flash.y, opts.flash.size)
    // The 3D room feels every hit too: its beams/dust/underglow surge with the impact and decay.
    // Routed through the same single authority so the room can never flash when the screen doesn't.
    // (stagePulse guards reduced-motion / reduce-flashing / poster mode itself; no-op without the room.)
    if (opts.trauma) stagePulse(Math.min(0.6, opts.trauma * 1.4))
  }

  /** Feed the trauma accumulator (clamped) + latch a blast direction. No-op under reduced motion. */
  private addTrauma(amount: number, dirX = 0, dirY = 0): void {
    if (this.reducedMotion) return
    this.trauma = Math.min(1, this.trauma + amount)
    if (dirX !== 0 || dirY !== 0) {
      const len = Math.hypot(dirX, dirY) || 1
      this.traumaDirX = dirX / len
      this.traumaDirY = dirY / len
    }
  }

  /**
   * Impact frame (E6): one cell-sized full-white silhouette (the `fireball` texture tinted white,
   * ADD) flashing α1→0 over ~60ms. CAPPED at ONE concurrent — a stacked detonation shares the live
   * one rather than spawning another (perf + photosensitivity red line). Kept even under reduced
   * motion (the single allowed 1-frame flash); gated only by the reduce-flashing hook (via punch()).
   */
  private impactFrame(x: number, y: number, size = CELL): void {
    if (this.impactFlash && this.impactFlash.active) return // share the one already flashing
    const f = this.add
      .image(x, y, 'fireball')
      .setTint(0xffffff)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(29)
      .setAlpha(1)
      .setDisplaySize(size, size)
    this.impactFlash = f
    this.tweens.add({
      targets: f,
      alpha: 0,
      duration: 60,
      ease: 'Quad.easeOut',
      onComplete: () => {
        if (this.impactFlash === f) this.impactFlash = undefined
        f.destroy()
      },
    })
  }

  /**
   * Graded hitstop (E6, call #2): briefly freeze tweens + timers right before a big blast expands, so
   * the hit registers. reel 0 / bomb ~45 / jackpot·mega ~70ms. Restored on a WALL-CLOCK setTimeout so
   * the restore itself isn't frozen; honours ?turbo via baseTimeScale. One freeze at a time — a hit
   * arriving during an active freeze no-ops (the deepest owns it). Reduced motion → skip.
   */
  private hitstop(ms: number): void {
    if (this.reducedMotion || ms <= 0) return
    const now = performance.now()
    if (now < this.hitstopUntil) return
    this.hitstopUntil = now + ms
    const restore = this.baseTimeScale
    this.tweens.timeScale = 0.0001
    this.time.timeScale = 0.0001
    setTimeout(() => {
      if (performance.now() >= this.hitstopUntil - 1) {
        this.tweens.timeScale = restore
        this.time.timeScale = restore
      }
    }, ms)
  }

  /**
   * Subtle camera breath on a big clear: a one-beat zoom kiss (≈1.01×, yoyo) so the whole screen
   * inhales with the blast — the soft, slow complement to the trauma shake's crisp rattle. One
   * breath at a time (a deeper wave landing mid-breath simply rides the live one), and it composes
   * with hitstop for free (the tween freezes with the timescale and resumes on release). Reduced
   * motion / LOW tier → no-op; the camera already rests at zoom 1, so there is nothing to collapse.
   */
  private cameraBreath(amount: number): void {
    if (this.reducedMotion || quality.tier() === 'low') return
    if (this.cameraBreathTween?.isPlaying()) return
    const cam = this.cameras.main
    cam.setZoom(1)
    this.cameraBreathTween = this.tweens.add({
      targets: cam,
      zoom: 1 + amount,
      duration: D.quick,
      ease: E.press,
      yoyo: true,
      hold: 40,
      onComplete: () => {
        cam.setZoom(1)
        this.cameraBreathTween = null
      },
    })
  }

  /**
   * BOARD SLAM (E6 impact / depth) — the deliberate vertical PUNCH of the whole board as a heavy
   * special goes off: the view jolts DOWN hard, then springs back up through rest and settles, while
   * the board's contact shadow deepens + tightens for the beat (the slab pressed toward its housing →
   * depth). Separate from the random trauma rattle (that's the crisp grit layered ON the slam); this
   * is the clean directional dip. `strength` (~0.6 bomb → 1.3 jackpot) scales the drop + shadow press.
   * Motion-gated like trauma — reduced motion leaves the board perfectly still (audio + flash still land).
   */
  private boardSlam(strength: number): void {
    if (this.reducedMotion) return
    const s = Math.max(0, strength)
    // NEGATIVE scrollY = the board appears to lurch DOWN, then Back-eases up through rest and settles.
    const dip = -(9 + s * 9)
    this.boardKickTween?.stop()
    this.boardKick.y = 0
    this.boardKickTween = this.tweens.chain({
      targets: this.boardKick,
      tweens: [
        { y: dip, duration: 60, ease: 'Quad.easeOut' }, // SLAM — a fast, hard drop
        { y: 0, duration: 300, ease: 'Back.easeOut' }, // spring back up through rest + settle
      ],
      onComplete: () => {
        this.boardKick.y = 0
        this.boardKickTween = null
      },
    })
    // Shadow PRESS — the contact shadow briefly darkens + tightens under the slab, then releases. Reset
    // to base first so an overlapping slam can't compound the transform; the yoyo returns it to rest.
    const sh = this.contactShadow
    if (sh && sh.active) {
      this.tweens.killTweensOf(sh)
      sh.setAlpha(0.3).setScale(this.contactShadowBase)
      this.tweens.add({
        targets: sh,
        alpha: Math.min(0.55, 0.3 + s * 0.16),
        scaleX: this.contactShadowBase * 0.93,
        scaleY: this.contactShadowBase * 0.93,
        duration: 70,
        yoyo: true,
        hold: 30,
        ease: 'Quad.easeOut',
        onComplete: () => {
          if (sh.active) sh.setAlpha(0.3).setScale(this.contactShadowBase)
        },
      })
    }
  }

  /**
   * Cascade escalation tick: four thin additive glow bands hug the SCREEN edges and pulse once per
   * combo wave, heat-ramped in step with the combo readout (warm gold → hot amber → rose at the
   * MEGA peak) and a touch wider/brighter per wave — so the whole room registers a deepening chain,
   * not just the board. Transient by construction (each band destroys itself when its pulse ends).
   * Gates: reduced motion skips whole (a transient's resting state is nothing); reduce-flashing
   * swaps the quick pop for a slower, dimmer swell (a glow, never a strobe); LOW tier skips whole
   * (it's an optional fill-rate layer); `quality.scale()` thins the peak alpha on MED.
   */
  private cascadeEdgeTick(cascade: number): void {
    // The room rides the chain: each deeper cascade surges the beams + dust a notch harder.
    // Before the early-outs on purpose — the 3D layer applies its own calmer gates internally.
    stagePulse(Math.min(0.85, 0.22 + cascade * 0.09))
    if (this.reducedMotion || quality.tier() === 'low') return
    const T = getTheme()
    // Same heat ramp as showCombo, in fill-colour form: x2 warm gold → x3 bright amber → x4 rose →
    // x6+ hot rose. Peak alpha + band thickness keep climbing (higher caps) so a deep chain floods
    // the room harder than the old x4 plateau did — the room "blowing up" scales with the chain.
    const tint = cascade <= 2 ? T.gold : cascade === 3 ? T.goldBright : cascade >= 6 ? T.roseLight : T.rose
    const soft = this.reduceFlashing
    const peak = Math.min(0.44, 0.1 + cascade * 0.045) * (soft ? 0.55 : 1) * quality.scale()
    const H = worldH()
    const cy = viewportCenterY() // visible-viewport centre — keeps the edge rim on the true screen edges after the top-anchor shift (reduces to 640 when centred)
    const th = Math.min(160, 54 + cascade * 12)
    // Centre-x/y · display-w/h for the four edge bands: left, right, top, bottom. Each band's
    // radial core sits ON its screen edge, so the bright inner half bleeds inward and the outer
    // half falls off-screen — a rim of light, not a floating bar.
    const bands: Array<[number, number, number, number]> = [
      [0, cy, th, H],
      [DESIGN_W, cy, th, H],
      [DESIGN_W / 2, cy - H / 2, DESIGN_W, th],
      [DESIGN_W / 2, cy + H / 2, DESIGN_W, th],
    ]
    for (const [x, y, w, h] of bands) {
      const band = this.add
        .image(x, y, 'bgglow')
        .setTint(tint)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(39) // above the board + HUD (≤34), below every overlay scrim (40+)
        .setDisplaySize(w, h)
        .setAlpha(0)
      this.tweens.add({
        targets: band,
        alpha: peak,
        duration: soft ? D.settle : D.quick,
        ease: E.press,
        yoyo: true,
        hold: 30,
        onComplete: () => band.destroy(),
      })
    }
  }

  /**
   * Charge→release wind-up (E6, signature moment #4): the detonating tile scale-punches DOWN (~0.9)
   * and a gold glow flares for ~70ms, so the explosion feels earned (its clear-pop is delayed by the
   * same window in playWave, so the two don't fight). No-op under reduced motion (instant release).
   */
  private chargeFlare(atCoord: Coord): void {
    sfx.charge() // §E6/B14: a short rising tick under the wind-up — audio is never motion-gated
    if (this.reducedMotion) return
    const pos = this.cellToXY(atCoord)
    const piece = this.board.get(atCoord)
    const sprite = piece ? this.sprites.get(piece.id) : undefined
    if (sprite && sprite.active) {
      // Pass 2 anticipation: an anisotropic coil (sides pinch more than the top) so the piece visibly
      // crouches before it blasts — matches settleSquash's squash vocabulary. reducedMotion → chargeFlare early-returns.
      this.tweens.add({ targets: sprite, scaleX: PIECE_SCALE * 0.85, scaleY: PIECE_SCALE * 0.92, duration: 70, ease: 'Quad.easeIn' })
    }
    const flare = this.add
      .image(pos.x, pos.y, 'bgglow')
      .setTint(0xffe6a8)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(24)
      // Pass 2 (medium): the charge glow starts WIDE + dim and GATHERS inward to a hot point during
      // the coil (implodes), so the outward bloom belongs to the release, not the wind-up.
      .setDisplaySize(CELL * 1.7, CELL * 1.7)
      .setAlpha(0)
    this.tweens.add({
      targets: flare,
      alpha: 0.85,
      scaleX: flare.scaleX * 0.5,
      scaleY: flare.scaleY * 0.5,
      duration: 80,
      ease: 'Quad.easeOut',
      onComplete: () => flare.destroy(),
    })
  }

  /**
   * §R3 special activation flash: a soft white radial bloom (~110ms) at the special's cell the
   * moment it fires. Deliberately created UNDER the hitstop freeze, so it holds at peak through the
   * freeze frame and decays on release — the same composition trick as the impact frame. Neutral
   * white by design (the one colour every theme reads as raw energy discharge — mirrors
   * impactFrame). reduce-flashing → a slower, dimmer swell; reduced motion → none. ≤3/wave (caller).
   */
  private activationFlash(atCoord: Coord): void {
    if (this.reducedMotion) return
    const soft = this.reduceFlashing
    const pos = this.cellToXY(atCoord)
    const f = this.add
      .image(pos.x, pos.y, 'bgglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(26)
      .setDisplaySize(CELL * 1.15, CELL * 1.15)
      .setAlpha((soft ? 0.34 : 0.85) * quality.scale())
    this.tweens.add({
      targets: f,
      alpha: 0,
      scaleX: f.scaleX * 2.1,
      scaleY: f.scaleY * 2.1,
      duration: soft ? 360 : 110,
      ease: E.press,
      onComplete: () => f.destroy(),
    })
  }

  /**
   * §R3 jackpot charge-up: the chip shimmers for a breath before the payoff — a white gleam sweeps
   * across its cell while a gold under-glow swells, overlapping the charge window into the release
   * so the colour-clear reads CHARGED, never instant. Never touches the sprite's transform
   * (chargeFlare owns the squeeze — springs must not fight). Reduced motion → none.
   */
  private jackpotChargeShimmer(atCoord: Coord): void {
    if (this.reducedMotion) return
    const T = getTheme()
    const pos = this.cellToXY(atCoord)
    // Gold under-glow swelling beneath the chip, then releasing.
    const glow = this.add
      .image(pos.x, pos.y, 'bgglow')
      .setTint(T.goldBright)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(23)
      .setDisplaySize(CELL * 1.05, CELL * 1.05)
      .setAlpha(0)
    this.tweens.add({
      targets: glow,
      alpha: 0.55 * quality.scale(),
      scaleX: glow.scaleX * 1.5,
      scaleY: glow.scaleY * 1.5,
      duration: 150,
      ease: E.press,
      yoyo: true,
      onComplete: () => glow.destroy(),
    })
    // The gleam: one slim additive blade crossing the chip (the twinklePiece idiom, unmasked —
    // it lives ~210ms over a cell that is about to detonate, so a hair of bleed reads as charge).
    const gleam = this.add
      .image(pos.x - CELL * 0.45, pos.y, 'sweep')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(24)
      .setAngle(14)
      .setDisplaySize(CELL * 0.34, CELL * 0.95)
      .setAlpha(0)
    this.tweens.add({
      targets: gleam,
      x: pos.x + CELL * 0.45,
      alpha: { from: 0.8, to: 0 },
      duration: 210,
      ease: E.glide,
      onComplete: () => gleam.destroy(),
    })
  }

  /**
   * §R3 payoff star-sparkle: a small white star-glint popping on a cleared cell during a SPECIAL
   * payoff — the jackpot's colour-matched conversions get the big bright gold variant. Two beats:
   * pop in on an eager overshoot, then spin-fade to nothing. The per-wave budget (quality.count-
   * scaled hard cap) lives in the caller; reduced motion never schedules one.
   */
  private payoffGlint(x: number, y: number, big: boolean): void {
    const T = getTheme()
    const s = (CELL / 48) * (big ? 0.95 : 0.55) // 48 = the glint texture's baked size
    const star = this.add
      .image(x, y, 'glint')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(24)
      .setTint(big ? T.goldBright : T.sparkleTint)
      .setScale(0)
      .setAngle(Phaser.Math.Between(-30, 30))
    this.tweens.add({
      targets: star,
      scale: s,
      duration: 120,
      ease: backOut(OVERSHOOT.pop),
      onComplete: () =>
        this.tweens.add({
          targets: star,
          scale: 0,
          angle: star.angle + 40,
          alpha: 0,
          duration: 200,
          ease: E.exit,
          onComplete: () => star.destroy(),
        }),
    })
  }

  /**
   * §R3 comet arrival: the goal counter takes the hit of light — a soft additive bloom on the chip
   * plus a star glint popping over its icon (the counter's pop-tick itself is owned by
   * stepCollect/settleCollect, which land right after this). Never reached under reduced motion
   * (the caller keeps today's instant collect exactly). reduce-flashing → dimmer, slower bloom
   * (a swell, not a flash); the whole beat is governor-gated.
   */
  private cometArrival(x: number, y: number): void {
    if (quality.count(1) === 0) return
    const T = getTheme()
    const soft = this.reduceFlashing
    const bloom = this.add
      .image(x, y, 'bgglow')
      .setTint(T.sparkleTint)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(33)
      .setDisplaySize(CELL * 1.1, CELL * 1.1)
      .setAlpha((soft ? 0.3 : 0.6) * quality.scale())
    this.tweens.add({
      targets: bloom,
      alpha: 0,
      scaleX: bloom.scaleX * 1.7,
      scaleY: bloom.scaleY * 1.7,
      duration: soft ? D.pop : D.base,
      ease: E.press,
      onComplete: () => bloom.destroy(),
    })
    const star = this.add
      .image(x, y, 'glint')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(34)
      .setTint(T.goldBright)
      .setScale(0)
      .setAngle(Phaser.Math.Between(-24, 24))
    this.tweens.add({
      targets: star,
      scale: (CELL * 0.7) / 48,
      angle: star.angle + 30,
      alpha: { from: 1, to: 0 },
      duration: D.settle,
      ease: E.press,
      onComplete: () => star.destroy(),
    })
  }

  /**
   * Fall/spawn squash-&-settle (E5, deepened §R3): on landing the piece takes its weight — an
   * instant squash frame (scaleY flattened, scaleX counter-bulged for volume, plus a hair of
   * downward sink so the cushion visibly compresses) that springs back to rest through a
   * calibrated Back overshoot (`backOut(OVERSHOOT.release)`), so scaleY briefly OVER-stretches
   * past rest before settling — the heavy, springy landing. Amplitude ∝ drop distance; timing
   * stays inside the FALL_* rhythm (~130ms tail, same footprint as the old 110ms settle).
   * Any straggler tween on the sprite (a prior squash) is killed first so springs never fight.
   * Reduced motion → none.
   */
  private settleSquash(sprite: Phaser.GameObjects.Sprite, dropCells: number): void {
    if (this.reducedMotion || !sprite.active) return
    const amp = Phaser.Math.Clamp(dropCells / ROWS, 0.2, 1)
    this.tweens.killTweensOf(sprite)
    const restY = sprite.y
    sprite.setScale(PIECE_SCALE * (1 + 0.14 * amp), PIECE_SCALE * (1 - 0.22 * amp))
    sprite.y = restY + CELL * 0.05 * amp // the sink: bottom edge stays planted while the top drops
    this.tweens.add({
      targets: sprite,
      scaleX: PIECE_SCALE,
      scaleY: PIECE_SCALE,
      y: restY,
      duration: 130,
      ease: backOut(OVERSHOOT.release), // overshoot = the counter-stretch rebound before rest
    })
  }

  /**
   * B3 floor-impact dust: ONE soft ground puff per settling COLUMN (co-timed with its land() thunk) — a
   * faint `bgglow` cloud + a few `spark` motes at the deepest-settling cell, sized by drop distance, the
   * visual partner to the audio thunk. Added INTO the board-masked pieceLayer BELOW every piece (addAt 0)
   * so it reads as dust at the tray floor and can never spill past the board rect. Reduced motion → none;
   * `quality.count()`-gated so it drops to nothing on the low tier. Self-destroying.
   */
  private floorDust(x: number, y: number, dropCells: number): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const amp = Phaser.Math.Clamp(dropCells / ROWS, 0.2, 1)
    const T = getTheme()
    const fy = y + CELL * 0.3 // sit the puff at the piece's base, not its centre
    // Soft dust cloud — a low, wide bloom that expands and fades under the pieces.
    const cloud = this.add
      .image(x, fy, 'bgglow')
      .setTint(T.bloom)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDisplaySize(CELL * (0.5 + amp * 0.5), CELL * (0.32 + amp * 0.3))
      .setAlpha(0.3 * amp * quality.scale())
    this.pieceLayer.addAt(cloud, 0) // below every piece; the layer's mask keeps it on the board
    this.tweens.add({
      targets: cloud,
      scaleX: cloud.scaleX * 1.7,
      scaleY: cloud.scaleY * 1.4,
      alpha: 0,
      duration: 300,
      ease: 'Quad.easeOut',
      onComplete: () => cloud.destroy(),
    })
    // A few low, outward-kicked motes settling as they fade.
    const motes = quality.count(1 + Math.round(amp * 2))
    for (let i = 0; i < motes; i++) {
      const mote = this.add
        .image(x, fy, 'spark')
        .setTint(T.sparkleTint)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(7, 7)
        .setAlpha(0.7 * amp)
      this.pieceLayer.addAt(mote, 0)
      this.tweens.add({
        targets: mote,
        x: x + Phaser.Math.Between(-1, 1) * CELL * (0.3 + amp * 0.25),
        y: fy - Phaser.Math.Between(4, 12) * amp,
        scale: 0,
        alpha: 0,
        duration: 260 + Math.random() * 120,
        ease: 'Quad.easeOut',
        onComplete: () => mote.destroy(),
      })
    }
  }

  /**
   * B4 helper: gleam ONE random resting piece with a short masked `sweep` shine — a single sparse glint,
   * deliberately not a board-wide sweep (that was removed as repetitive). The sweep is clipped to the
   * piece's cell by a geometry mask and slides across once, then everything self-destructs via
   * disarmTwinkle. Refs are held so a board touch / resolve can kill it mid-slide.
   */
  private twinklePiece(): void {
    const pool: Phaser.GameObjects.Sprite[] = []
    for (const s of this.sprites.values()) if (s.active && s.visible) pool.push(s)
    if (pool.length === 0) return
    const s = pool[Phaser.Math.Between(0, pool.length - 1)]
    const half = PIECE_SIZE / 2
    // Geometry mask matching the piece cell so the shine can't bleed onto its neighbours.
    const mg = this.make.graphics({ x: 0, y: 0 }, false)
    mg.fillStyle(0xffffff, 1)
    mg.fillRoundedRect(s.x - half, s.y - half, PIECE_SIZE, PIECE_SIZE, 14)
    this.twinkleMask = mg
    const gleam = this.add
      .image(s.x - half, s.y, 'sweep')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(19) // above the pieces (container depth 0), below the clear-burst emitters (20/21)
      .setDisplaySize(PIECE_SIZE * 0.55, PIECE_SIZE)
      .setAlpha(0)
      .setAngle(18)
      .setMask(mg.createGeometryMask())
    this.twinkleGleam = gleam
    // One pass: the shine catches at the left edge and fades as it crosses — never yoyos, never repeats.
    this.twinkleTween = this.tweens.add({
      targets: gleam,
      x: s.x + half,
      alpha: { from: 0.4 * quality.scale(), to: 0 },
      duration: 460,
      ease: 'Sine.easeInOut',
      onComplete: () => this.disarmTwinkle(),
    })
  }

  /** B4 teardown: stop the gleam tween and destroy the sweep + its mask graphics. Safe to call anytime. */
  private disarmTwinkle(): void {
    this.twinkleTween?.stop()
    this.twinkleTween = null
    if (this.twinkleGleam) {
      this.twinkleGleam.clearMask()
      this.twinkleGleam.destroy()
      this.twinkleGleam = null
    }
    this.twinkleMask?.destroy()
    this.twinkleMask = null
  }

  /**
   * Secondary motion (E5): the ring of SURVIVING neighbors around a blast gets shoved ~4–8px outward
   * (falloff by distance) then Back-settles home, so the board reads as physical. Cap ~10 pieces.
   * Reduced motion / weakest governor tier → none.
   */
  private secondaryMotion(epicenter: Coord, clearedIds: Set<number>, force = 1, downBias = 0): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const ep = this.cellToXY(epicenter)
    const CAP = 10
    const RADIUS = 2.4 * CELL
    let nudged = 0
    for (let dr = -2; dr <= 2 && nudged < CAP; dr++) {
      for (let dc = -2; dc <= 2 && nudged < CAP; dc++) {
        if (dr === 0 && dc === 0) continue
        const at = { row: epicenter.row + dr, col: epicenter.col + dc }
        if (!this.board.inBounds(at)) continue
        const piece = this.board.get(at)
        if (!piece || clearedIds.has(piece.id)) continue
        const sprite = this.sprites.get(piece.id)
        if (!sprite || !sprite.active) continue
        const pos = this.cellToXY(at)
        const dx = pos.x - ep.x
        const dy = pos.y - ep.y
        const dist = Math.hypot(dx, dy) || 1
        if (dist > RADIUS) continue
        // Heavy blasts (bomb/jackpot) shove harder (`force`) and add a DOWNWARD component (`downBias`),
        // so the surrounding tiles visibly get driven down into the tray as the board slams — depth.
        const push = (4 + 4 * (1 - dist / RADIUS)) * force
        this.tweens.add({
          targets: sprite,
          x: pos.x + (dx / dist) * push,
          y: pos.y + (dy / dist) * push + downBias * push,
          duration: 60,
          ease: 'Quad.easeOut',
          onComplete: () => {
            if (sprite.active) this.tweens.add({ targets: sprite, x: pos.x, y: pos.y, duration: 220, ease: 'Back.easeOut' })
          },
        })
        nudged++
      }
    }
  }

  /** Jackpot-chip strike (extracted so it composes with the charge→freeze→release orchestration). */
  private detonateJackpot(): void {
    this.jackpotOccurred = true // §E4 — a jackpot this round qualifies the win for the Heartbloom hero beat
    sfx.jackpotStrike()
    // The jackpot's signature is a full-screen cream flash (its own "impact frame") — gate it via the
    // reduce-flashing hook — plus a heavy omnidirectional trauma kick.
    if (!this.reduceFlashing) this.cameras.main.flash(280, 255, 214, 90)
    this.punch({ trauma: 0.95 })
    this.boardSlam(1.3) // the board-wipe strike hits hardest — the deepest slam of the three
    stageFlare() // and the whole ROOM ignites — the slow warm swell behind the strike
  }

  /**
   * Wild-reel line clear as a MISSILE strike: a fireball head streaks out of the epicenter to each
   * end of the row/col trailing sparks, and the whole line ignites in a fire streak. Faster/thicker
   * on higher cascades. Trails cap ~11 sparks each; total ≲30 for the event.
   */
  private detonateReel(atCoord: Coord, horizontal: boolean, cascade: number): void {
    sfx.reelSweep()
    const at = this.cellToXY(atCoord)
    const boost = Math.min(cascade - 1, 4)

    // DIRECTIONAL impact: a horizontal line-blast kicks the screen horizontally (force with a vector,
    // not generic noise) + a crisp white impact frame along the blast axis.
    this.punch({
      trauma: 0.5 + boost * 0.05,
      dirX: horizontal ? 1 : 0,
      dirY: horizontal ? 0 : 1,
      flash: { x: at.x, y: at.y, size: CELL * 1.2 },
    })
    this.boardSlam(0.7 + boost * 0.06) // the line-blast slams the board down as it rips across

    // The line ignites — a warm fire streak flashing across the whole row/col.
    const sweep = this.add
      .image(horizontal ? BOARD_X + BOARD_W / 2 : at.x, horizontal ? at.y : this.boardTop + BOARD_W / 2, 'sweep')
      .setDepth(25)
      .setBlendMode(Phaser.BlendModes.ADD)
    sweep.setDisplaySize(BOARD_W + 24, CELL * (0.72 + boost * 0.05))
    if (!horizontal) sweep.setAngle(90)
    sweep.setAlpha(0)
    this.tweens.add({
      targets: sweep,
      alpha: { from: 0, to: 1 },
      scaleY: sweep.scaleY * 1.3,
      duration: 90,
      yoyo: true,
      hold: 120,
      ease: E.press, // Pass 2 follow-through: snap to full brightness, then the yoyo eases the fade out
      onComplete: () => sweep.destroy(),
    })

    // Missile heads streak out to each end of the line, trailing sparks.
    const dur = 240 - boost * 26
    const dirs: Array<[number, number]> = horizontal ? [[-1, 0], [1, 0]] : [[0, -1], [0, 1]]
    for (const [dx, dy] of dirs) {
      const endX = horizontal ? (dx < 0 ? BOARD_X - 12 : BOARD_X + BOARD_W + 12) : at.x
      const endY = horizontal ? at.y : dy < 0 ? this.boardTop - 12 : this.boardTop + BOARD_W + 12
      const missile = this.add
        .image(at.x, at.y, 'fireball')
        .setDepth(27)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.85 + boost * 0.08)
      const trail = this.add
        .particles(0, 0, 'spark', {
          speed: { min: 20, max: 130 },
          scale: { start: 0.6, end: 0 },
          alpha: { start: 0.9, end: 0 },
          lifespan: { min: 160, max: 320 },
          gravityY: 140,
          tint: [0xffb01c, 0xffdc5c],
          quantity: 1,
          frequency: this.reducedMotion ? 44 : 22,
          emitting: true,
        })
        .setDepth(26)
      trail.startFollow(missile)
      // §R3: the travelling clear reads as LIGHT — a white-hot star glint riding the fireball head
      // + one reused additive streak stretching from the epicenter back to the head (repositioned
      // in onUpdate; nothing is spawned per frame). Reduced motion keeps the plain missile.
      const dress = !this.reducedMotion && quality.count(1) > 0
      const head = dress
        ? this.add
            .image(at.x, at.y, 'glint')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setDepth(28)
            .setDisplaySize(CELL * 0.85, CELL * 0.85)
            .setAlpha(0.95)
        : null
      const streak = dress
        ? this.add
            .image(at.x, at.y, 'sweep')
            .setBlendMode(Phaser.BlendModes.ADD)
            .setDepth(26)
            .setAlpha(0.8)
            .setAngle(horizontal ? 0 : 90)
            .setDisplaySize(8, CELL * 0.5)
        : null
      this.tweens.add({
        targets: missile,
        x: endX,
        y: endY,
        duration: dur,
        ease: 'Sine.easeIn',
        onUpdate: () => {
          head?.setPosition(missile.x, missile.y)
          if (streak) {
            // Tail anchored between origin and head; display width IS the distance travelled.
            streak.setPosition((at.x + missile.x) / 2, (at.y + missile.y) / 2)
            const len = Math.max(8, Math.abs(horizontal ? missile.x - at.x : missile.y - at.y))
            streak.setDisplaySize(len, CELL * 0.5)
          }
        },
        onComplete: () => {
          head?.destroy()
          if (streak) {
            // The streak lingers a beat and collapses — an afterglow, not a hard cut.
            this.tweens.add({
              targets: streak,
              alpha: 0,
              scaleY: streak.scaleY * 0.35,
              duration: 150,
              ease: E.exit,
              onComplete: () => streak.destroy(),
            })
          }
          trail.stop()
          trail.stopFollow()
          missile.destroy()
          this.time.delayedCall(340, () => trail.destroy())
        },
      })
    }
  }

  /**
   * Dice-bomb cell blast as a real EXPLOSION: a white-hot flash core, a fireball bloom, an expanding
   * shockwave ring and a capped fire/debris burst — all scaled by the blast radius + cascade, with
   * a camera punch that hits harder on bigger combos. Particle budget ≤30 (spark ≤20 + fire ≤10).
   */
  private detonateBomb(atCoord: Coord, radius: number, cascade: number): void {
    sfx.bombBoom()
    this.vibrate(30 + Math.min(radius, 3) * 12)
    const at = this.cellToXY(atCoord)
    const boost = Math.min(cascade - 1, 4)
    const power = radius + boost * 0.4

    // Omnidirectional trauma punch (bigger blasts / combos hit harder) + a capped white impact frame.
    this.punch({
      trauma: Math.min(1, 0.45 + radius * 0.12 + boost * 0.04),
      flash: { x: at.x, y: at.y, size: CELL * 1.3 },
    })
    // The board SLAMS down as the bomb goes off — the dip + shadow press give the blast real weight.
    this.boardSlam(0.6 + Math.min(radius, 3) * 0.12 + boost * 0.05)

    // White-hot flash core.
    const flash = this.add
      .image(at.x, at.y, 'bgglow')
      .setTint(0xfff6d9)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(28)
      .setAlpha(0.9)
      .setDisplaySize(CELL * 1.2, CELL * 1.2)
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scaleX: flash.scaleX * (2.2 + power * 0.4),
      scaleY: flash.scaleY * (2.2 + power * 0.4),
      duration: 220,
      ease: 'Quad.easeOut',
      onComplete: () => flash.destroy(),
    })

    // Fireball bloom.
    const ball = this.add
      .image(at.x, at.y, 'fireball')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(27)
      .setScale(0.5)
      .setAlpha(1)
    this.tweens.add({
      targets: ball,
      delay: 20, // Pass 2 overlap: bloom trails the flash core (core → bloom → pressure-wave)
      alpha: 0,
      scaleX: 1.6 + power * 0.6,
      scaleY: 1.6 + power * 0.6,
      duration: 380,
      ease: 'Quad.easeOut',
      onComplete: () => ball.destroy(),
    })

    // Expanding shockwave ring.
    const ring = this.add
      .image(at.x, at.y, 'shockwave')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(26)
      .setAlpha(0.9)
      .setDisplaySize(CELL, CELL)
    this.tweens.add({
      targets: ring,
      delay: 40, // Pass 2 overlap: the pressure wave lands a beat behind core + bloom
      alpha: 0,
      scaleX: ring.scaleX * (3.2 + power * 0.6),
      scaleY: ring.scaleY * (3.2 + power * 0.6),
      duration: 440,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    })

    // §R3 double shockwave: a second, tighter echo ring chasing ~90ms behind the first — the
    // beefier two-beat concussion read. Reduced motion keeps the single ring (the echo is pure
    // extra transient, and its resting state is nothing).
    if (!this.reducedMotion) {
      const echo = this.add
        .image(at.x, at.y, 'shockwave')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(26)
        .setAlpha(0)
        .setDisplaySize(CELL * 0.7, CELL * 0.7)
      this.tweens.add({
        targets: echo,
        alpha: { from: 0.7, to: 0 },
        scaleX: echo.scaleX * (2.6 + power * 0.5),
        scaleY: echo.scaleY * (2.6 + power * 0.5),
        delay: 90,
        duration: 400,
        ease: 'Cubic.easeOut',
        onComplete: () => echo.destroy(),
      })
    }

    // §R3 radial star spray: crisp 4-point glints thrown outward on straight fast radials (reads
    // as light shrapnel, distinct from the ballistic fire debris below) — governor + reduced-motion
    // scaled, one-shot, self-destroying.
    const sprayN = this.motionCount(quality.count(Math.min(12, 6 + radius * 3)))
    if (sprayN > 0) {
      const T = getTheme()
      const spray = this.add
        .particles(0, 0, 'glint', {
          speed: { min: 160, max: 320 + radius * 40 },
          angle: { min: 0, max: 360 },
          scale: { start: 0.7, end: 0 },
          alpha: { start: 1, end: 0 },
          lifespan: { min: 240, max: 420 },
          rotate: { min: -90, max: 90 },
          blendMode: Phaser.BlendModes.ADD,
          tint: [0xffffff, T.sparkleTint, T.goldBright],
          emitting: false,
        })
        .setDepth(28)
      spray.explode(sprayN, at.x, at.y)
      this.time.delayedCall(520, () => spray.destroy())
    }

    // Debris sparks + fiery chunks (capped, one-shot self-destructing emitter).
    this.sparkEmitter.explode(this.motionCount(Math.min(20, 8 + radius * 4 + boost)), at.x, at.y)
    const fire = this.add
      .particles(0, 0, 'fireball', {
        speed: { min: 90, max: 240 + radius * 40 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.9, end: 0 },
        lifespan: { min: 300, max: 560 },
        gravityY: 380,
        tint: [0xffb01c, 0xffd24a, 0xe61f4d],
        emitting: false,
      })
      .setDepth(27)
    fire.explode(this.motionCount(Math.min(10, 5 + radius * 2)), at.x, at.y)
    this.time.delayedCall(680, () => fire.destroy())
  }

  private animateFalls(falls: FallMove[], spawns: Spawn[]): Promise<void[]> {
    const tweens: Promise<void>[] = []
    // §E5/B14: throttle landing thunks to ONE voice per settling COLUMN (≤COLS=8/refill) so the
    // refill reads as a rain of thunks, not mush. Track the deepest drop per column + when it lands.
    // Track the deepest drop per column + when/where it lands, so B3's floor dust can co-fire with the thunk.
    const colDrop = new Map<number, { dist: number; ms: number; x: number; y: number }>()
    const noteCol = (col: number, dist: number, x: number, y: number): void => {
      const cur = colDrop.get(col)
      if (!cur || dist > cur.dist) colDrop.set(col, { dist, ms: FALL_BASE_MS + FALL_PER_CELL_MS * dist, x, y })
    }
    for (const move of falls) {
      const sprite = this.sprites.get(move.piece.id)
      if (!sprite) {
        this.log('fall MISSING sprite', move.piece.id)
        continue
      }
      const to = this.cellToXY(move.to)
      const dist = move.to.row - move.from.row
      noteCol(move.to.col, dist, to.x, to.y)
      tweens.push(
        this.t({
          targets: sprite,
          y: to.y,
          duration: FALL_BASE_MS + FALL_PER_CELL_MS * dist,
          ease: 'Quad.easeIn', // Pass 2 (medium): ACCELERATE downward (gravity) so settleSquash owns the whole landing bounce, not a double-bounce
        }).then(() => this.settleSquash(sprite, dist)) // E5: squash-&-settle on landing
      )
    }
    for (const spawn of spawns) {
      const sprite = this.createSprite(spawn.piece, spawn.at, spawn.dropCells)
      const to = this.cellToXY(spawn.at)
      noteCol(spawn.at.col, spawn.dropCells, to.x, to.y)
      tweens.push(
        this.t({
          targets: sprite,
          y: to.y,
          duration: FALL_BASE_MS + FALL_PER_CELL_MS * spawn.dropCells,
          ease: 'Quad.easeIn', // Pass 2 (medium): refills accelerate in to match the falls above (gravity)
        }).then(() => this.settleSquash(sprite, spawn.dropCells)) // E5: squash-&-settle on landing
      )
    }
    // One height-mapped thunk per column, fired as that column's deepest piece settles, panned by column,
    // with B3's floor-dust puff co-timed to it at the settling cell (sized by the same drop distance).
    for (const [col, { dist, ms, x, y }] of colDrop) {
      this.time.delayedCall(ms, () => {
        sfx.land(Phaser.Math.Clamp(dist / ROWS, 0.15, 1), this.colPan(col))
        this.floorDust(x, y, dist)
      })
    }
    return Promise.all(tweens)
  }

  private async reshuffle(): Promise<void> {
    this.state = 'shuffling'
    sfx.reshuffleSwirl()
    const toast = this.add
      .text(DESIGN_W / 2, this.boardTop + BOARD_W / 2, 'NO MOVES — RESHUFFLING', {
        fontFamily: FONT,
        fontSize: '36px',
        color: getTheme().ink,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(30)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(0,0,0,0.18)', 6, true, true)

    await this.t({ targets: this.pieceLayer, alpha: 0, duration: 220 })
    for (const sprite of this.sprites.values()) sprite.destroy()
    this.sprites.clear()
    this.board.regenerate()
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const at = { row: r, col: c }
        this.createSprite(this.board.get(at)!, at)
      }
    }
    await this.t({ targets: this.pieceLayer, alpha: 1, duration: 220 })
    this.time.delayedCall(500, () => toast.destroy())
  }

  // -------------------------------------------------------------- endings

  private finishWin(): void {
    this.log('finishWin')
    this.state = 'ended'
    this.clearBookedSwap() // §G1 — a swipe aimed during the winning cascade dies with the level
    this.stopMovesPulse()
    this.powerBar?.setVisible(false) // retire the helper shelf — the result card takes the screen
    this.celebrateBoard() // Beat 0: casino light flash + chip/card burst on the still-visible board
    this.vibrate(60)
    // Purchased moves buy a WIN, not a better grade: exclude them from the stars/bonus/reward so a
    // player can't top up moves to farm stars or chips (which would run the closed chip economy away).
    // A clean in-budget run is unaffected (purchasedMoves is 0); only bought-move surplus is discounted.
    const earnedLeftover = Math.max(0, this.movesLeft - this.purchasedMoves)
    // §G3 — graded against the level's own required collect rate, not a fixed half-budget. See
    // `starThresholds` in core/levels.ts for why the constant bar made 3★ unreachable past L32.
    const stars = starsFor(this.spec, earnedLeftover)
    const bonus = earnedLeftover * MOVES_BONUS
    if (bonus > 0) this.addScore(bonus)
    // §E9 new-best: capture the stored best BEFORE recordResult bumps it, then compare the final score.
    // §G4 also reads the pre-win save to tell a FIRST clear from a REPLAY — both facts have to be
    // taken before `recordResult` advances `unlocked` and overwrites the stored star count.
    const prev = loadSave()
    const prevBest = prev.best
    const isReplay = prev.unlocked > this.level
    const beatsBest = stars > (prev.stars[this.level] ?? 0)
    const save = recordResult(this.level, stars, this.score)
    this.newBestThisWin = this.score > prevBest
    // Reward payout — rewards a clean, fast clear and is BANKED to the persistent chip balance.
    // Once per win (finishWin runs exactly once per completed level); endless/losses pay nothing.
    //
    // §G4 REPLAY FAUCET. `DIFFICULTY.economy.replayChipFraction` was written for exactly this and had
    // no reader anywhere, so re-clearing level 1 paid full price forever — an unbounded chip source
    // that quietly devalues the champion purse, the referral reward and every check-in payout. A
    // replay now pays a fraction UNLESS it beats your stored star count, because chasing stars is the
    // whole point of replaying and must stay worth doing at full rate. Replay itself remains free.
    const replayScale = isReplay && !beatsBest ? DIFFICULTY.economy.replayChipFraction : 1
    const chipReward = Math.round((stars * 8 + earnedLeftover * 2) * replayScale)
    this.chipBanked = addChips(chipReward)
    // Paired with the level_start / level_fail below, this is the per-level win rate — the query that
    // separates "level 21 is a wall" from "level 21 is just how far a new player gets in a day".
    // `moves_left` is the earned leftover, not the raw remainder, so a bought win can't read as a
    // comfortable one and flatter a level that is actually hard.
    track(EVENTS.LEVEL_WIN, { level: this.level, stars, moves_left: earnedLeftover })
    // CHAPTER REWARD — a FIRST clear of a chapter-closing level banks its trophy + purse (+ milestone
    // boost) right here, before any celebration animates (core/trophies.ts claim, award-first like
    // every other surface). The ceremony later in this method replays this settled result; replays
    // and already-claimed boundaries get null and fall through to the plain milestone splash.
    const chapterGrant =
      !isReplay && this.level % CHAPTER_LEVELS === 0 ? claimChapter(this.level / CHAPTER_LEVELS) : null
    if (chapterGrant) {
      this.chipBanked = chapterGrant.balance
      track(EVENTS.CHAPTER_REWARD, { chapter: chapterGrant.chapter, purse: chapterGrant.purse, retro: false })
    }
    // Charge the jackpot meter one notch. When it fills, arm the wheel — the win-card Continue then
    // fires it (see continueAfterWin). Persisted immediately, so quitting can't lose progress.
    //
    // §G4 — but only on PROGRESS. Charging on replays made the wheel farmable by grinding an early
    // level in a few seconds each, which is a far better rate than playing the game as intended; the
    // meter is supposed to measure how far you have come, not how many times you pressed retry.
    const meter = isReplay ? prev.jackpotMeter : bumpJackpotMeter()
    this.jackpotHud?.update(meter)
    this.jackpotArmed = jackpotReady(meter)
    // HOT STREAK — every third consecutive win deals the Lucky Deal (core/deal.ts dealReady). Like
    // the jackpot meter directly above, a REPLAY leaves it alone: charging it on replays would make
    // the Deal farmable by re-clearing level 1 on a loop, which is a far better rate than playing
    // the game. A replay does not BREAK the streak either — chasing stars on an old level is
    // something the game wants, so it must not cost you a run of wins you already have.
    const streak = isReplay ? prev.winStreak : bumpWinStreak()
    this.dealArmed = !isReplay && dealReady(streak)
    const totalStars = Object.values(save.stars).reduce((sum, s) => sum + s, 0)
    const showCard = (): void => {
      this.showOverlay(true, stars, bonus, chipReward, false, true)
      this.input.once('pointerdown', () => this.overlaySettle?.())
    }
    // §E9 ALL CLEAR (signature moment #6) — a one-time bespoke crescendo the first time she clears the
    // FINAL level. Latched by finaleSeen so it never repeats; a later L100 replay falls back to the
    // normal milestone splash.
    if (this.level >= LEVEL_COUNT && !save.finaleSeen) {
      markFinaleSeen()
      // Level 300 is also chapter 30's close. The finale keeps the slot it has always owned, then
      // hands off to the car ceremony — "ALL CLEAR → and your grand prize is a car" — before the
      // result card. Both stages are tap-skippable, so the once-ever double bill can be walked out of.
      const after = chapterGrant ? (): void => this.chapterCeremony(chapterGrant, showCard) : showCard
      this.time.delayedCall(420, () => this.allClearFinale(totalStars, after))
      return
    }
    // First clear of a chapter boundary: the trophy ceremony stands in where the milestone splash
    // would have played — same seat, same hand-off to the card, a prize instead of a headline.
    if (chapterGrant) {
      this.time.delayedCall(420, () => this.chapterCeremony(chapterGrant, showCard))
      return
    }
    // Every 10th level is a milestone: a full-screen star-tally splash stands in for Beats 1–2.
    if (this.level % CHAPTER_LEVELS === 0) {
      // The splash already fired the fanfare + heart shower — the card stays calm (celebrate=false)
      // but still runs Beat 4 (elastic entrance + coin roll-up), tap-to-settle.
      this.time.delayedCall(420, () => this.milestoneSplash(totalStars, showCard))
    } else {
      this.runWinSequence(stars, bonus, chipReward)
    }
  }

  /**
   * The chapter trophy ceremony — plays where the milestone splash would, on the first clear of a
   * chapter-closing level. The grant is ALREADY banked (finishWin, award-first); this only performs
   * it, wiring the scene's single freeze authority and the balance pill exactly like the wheel does
   * (the pill is lifted over the ceremony scrim so the purse visibly pours INTO the readout).
   * Wrapped for the same reason offerDeal is: a throw on the way out of a win would strand the
   * player on a dead result card. If anything here fails, the card shows as though no chapter had
   * closed — the player misses a spectacle, never the prize (it is already in the save).
   */
  private chapterCeremony(grant: ChapterGrant, done: () => void): void {
    try {
      const pill = this.chipHud
      const before = grant.balance - grant.purse
      pill?.container.setDepth(63)
      void playChapterCeremony(this, grant, {
        hitstop: ms => this.hitstop(ms),
        chipFlyTo: pill
          ? {
              x: pill.container.x,
              y: pill.container.y,
              onLand: (landed, total) =>
                pill.update(Math.round(before + (grant.balance - before) * (landed / total))),
            }
          : undefined,
      })
        .catch(() => undefined)
        .then(() => {
          pill?.container.setDepth(50)
          this.chipHud?.update(grant.balance)
          done()
        })
    } catch {
      done()
    }
  }

  /**
   * Gate every post-win transition through the Jackpot Wheel when the meter just filled. If armed, the
   * wheel "explodes" in over the win card (an overlay, no scene-swap), pays its chips, and only THEN
   * runs the original transition `go` on CLAIM — so advancing after the fifth win always fires the
   * wheel exactly once. Not armed → straight through. Routing both Continue buttons here covers every
   * win branch (normal / milestone / all-clear all funnel to this card).
   */
  private continueAfterWin(go: () => void): void {
    // Two bonus surfaces can arm off the same win, so they QUEUE rather than race: the wheel fires
    // first (it is the bigger, more automatic spectacle), and the Deal is handed the wheel's own
    // continuation so it opens on the wheel's CLAIM. Both are per-win latches cleared as they fire,
    // so neither can double-open. The collision is rare by construction — the wheel arms every 5th
    // win and the Deal every 3rd, so they coincide once every 15 — and when it happens the player
    // gets a genuine double payday rather than one of the two being silently dropped.
    const afterWheel = this.dealArmed ? () => this.offerDeal(go) : go
    if (!this.jackpotArmed) {
      afterWheel()
      return
    }
    this.jackpotArmed = false
    // R4 payoff hooks: the wheel's detent freeze rides THIS scene's single hitstop authority, and the
    // chip fountain physically lands in the HUD balance pill — lifted above the wheel scrim for the
    // duration so the chips visibly pour INTO the readout, ticking the displayed balance up per landing.
    const pill = this.chipHud
    const before = loadSave().chips // the pre-award balance (openJackpotWheel banks award-first below)
    pill?.container.setDepth(63)
    openJackpotWheel(this, {
      hitstop: ms => this.hitstop(ms),
      chipFlyTo: pill
        ? {
            x: pill.container.x,
            y: pill.container.y,
            onLand: (landed, total) => {
              const target = loadSave().chips // already banked (award-first) — climb toward it honestly
              pill.update(Math.round(before + (target - before) * (landed / total)))
            },
          }
        : undefined,
      onClaim: result => {
        // Deducts one wheel's worth rather than emptying the meter, so a surplus bought from Lucky
        // Slots (which pays jackpot points in batches) queues the next wheel instead of evaporating.
        // Identical to the old reset for a level win, where the meter is always exactly full here.
        this.jackpotHud?.update(spendJackpotCharge(), false)
        pill?.container.setDepth(50) // back to the ChipPill's native HUD depth
        this.chipHud?.update(result.newTotal)
        this.chipBanked = result.newTotal
        afterWheel() // the Deal when this win armed one too, otherwise the caller's own transition
      },
    })
  }

  /**
   * THE LUCKY DEAL — a card pick'em dealt by a three-win HOT STREAK (core/deal.ts).
   *
   * Opens as an in-scene overlay over the win card, exactly like the wheel and the plinko board, and
   * runs the win-card's own continuation on CLAIM so the level flow is unchanged whether it fired or
   * not. The overlay banks everything itself, award-first, the instant the third card turns; all this
   * has to do afterwards is refresh the HUD readouts from the returned totals.
   *
   * Wrapped in try/catch for the same reason `offerPlinko` is (UI_COOKBOOK §11): a throw on the path
   * out of a win would strand the player on a result card with a dead Continue and no way back. If
   * anything here fails, the level advances as though the streak had never armed — the player loses a
   * bonus round they did not know was coming, rather than their session.
   */
  private offerDeal(go: () => void): void {
    this.dealArmed = false
    try {
      track(EVENTS.DEAL_OFFERED, { level: this.level, streak: loadSave().winStreak })
      openDeal(this, {
        hitstop: ms => this.hitstop(ms),
        onClaim: result => {
          this.chipHud?.update(result.newTotal)
          this.chipBanked = result.newTotal
          if (result.spins > 0) this.freeSpinTicket(result.spins) // reuse the golden-ticket beat
          track(EVENTS.DEAL_WON, {
            face: result.face,
            chips: result.chips,
            flips: result.flips,
            fast: result.fast,
            charm: result.charm?.kind ?? 'none',
          })
          go()
        },
      })
    } catch (err) {
      this.log('offerDeal ERROR', err)
      go() // never strand the win card
    }
  }

  /** Reduced-motion (OS query OR in-app override) — delegates to the shared theme authority (§E8). */
  private prefersReducedMotion(): boolean {
    return prefersReducedMotion()
  }

  /**
   * Orchestrates the video-inspired win celebration (Beats 1–4) over the still-visible board,
   * then hands off to the animated result card. The whole thing is TAP-TO-SKIP: the first
   * pointerdown cancels the pending beats and jumps straight to the settled card. Reduced-motion
   * keeps the bloom + card + roll-up but drops the fireworks/confetti.
   */
  private runWinSequence(stars: number, bonus: number, chipReward: number): void {
    const reduced = this.prefersReducedMotion()
    const timers: Phaser.Time.TimerEvent[] = []
    const transient: Phaser.GameObjects.GameObject[] = []
    let cardShown = false
    let skipped = false
    let fanfarePlayed = false
    // B5 — set by the sweep beat to a canceller that snaps the emptying board straight to clean; the
    // skip guard calls it so a tap mid-sweep lands on the settled card without a half-faded board.
    let cancelSweep: (() => void) | null = null

    const at = (ms: number, cb: () => void): void => {
      timers.push(this.time.delayedCall(ms, cb))
    }
    const track = <T extends Phaser.GameObjects.GameObject>(o: T): T => {
      transient.push(o)
      return o
    }
    const showCard = (animate: boolean): void => {
      cardShown = true
      this.showOverlay(true, stars, bonus, chipReward, false, animate)
    }

    const skip = (): void => {
      if (skipped) return
      skipped = true
      for (const t of timers) t.remove(false)
      cancelSweep?.() // B5 — finalize an in-flight board sweep (its flyers are freed with the transient below)
      for (const o of transient) if (o.active) o.destroy()
      if (!fanfarePlayed) sfx.winFanfare()
      if (!cardShown) showCard(false)
      else this.overlaySettle?.()
    }
    this.input.once('pointerdown', skip)

    // BEAT 0 — the Heartbloom hero win (§E4, signature moment #3). Fires ONLY on the biggest wins:
    // a PERFECT (3-star) clear OR a jackpot strike this round. A giant heart of light blooms from
    // board-center under the Maya leitmotif — LAYERED beneath the existing bloom/flash/rank-word/
    // fireworks/coin-payout, never replacing them. Scarce by construction: plain 1–2 star wins never
    // qualify, and it self-guards to one fire per round. Fired synchronously (not via `at`) so an
    // instant tap-skip can't rob the hero moment. Nothing else here is gated on it.
    if (stars >= 3 || this.jackpotOccurred) this.heartbloom()

    // BEAT 1 — screen lights up (warm bloom + cream camera flash).
    at(120, () => {
      const bloom = track(
        this.add
          .image(360, 620, 'bgglow')
          .setTint(0xffe9b0)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(38)
          .setAlpha(0)
          .setScale(14)
      )
      this.tweens.add({
        targets: bloom,
        alpha: 0.55,
        duration: 120,
        ease: 'Quad.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: bloom, alpha: 0, duration: 460, ease: 'Quad.easeIn', onComplete: () => bloom.destroy() }),
      })
      // Win bloom's cream camera flash — gated by the reduce-flashing switch (§E8), like the jackpot flash.
      if (!this.reduceFlashing) this.cameras.main.flash(200, 255, 249, 235)
      sfx.reelSweep()
      if (stars >= 3) sfx.jackpotStrike()
    })

    // BEAT 2 — rank-word wordmark punch (fires the single winFanfare).
    at(200, () => {
      fanfarePlayed = true
      sfx.winFanfare()
      this.winWordmark(stars, track, at)
    })

    // BEAT 3 — fireworks + confetti + a brand heart puff (skipped under reduced-motion).
    if (!reduced) at(350, () => this.winFireworks(track, at))

    // BEAT 3½ — B5 board sweep-clean: the remaining pieces cascade off toward the SCORE readout so the
    // board visibly EMPTIES into the win, landing just as the card enters. Skipped WHOLE under reduced
    // motion (no sweep ⇒ byte-for-byte today's straight-to-card); the skip guard above cancels it
    // mid-flight via the canceller it returns.
    if (!reduced) at(620, () => { cancelSweep = this.sweepBoardClean(track) })

    // BEAT 4 — the result card enters (elastic scale-in) + coin roll-up payout.
    at(1100, () => showCard(true))
  }

  /** Beat 2: a gold-bezel lozenge stamping the rank word (NICE/GREAT/PERFECT) over the board. */
  private winWordmark(stars: number, track: <T extends Phaser.GameObjects.GameObject>(o: T) => T, at: (ms: number, cb: () => void) => void): void {
    const cx = 360
    const cy = 470
    const word = this.rankWord(stars)
    const layer = track(this.add.container(cx, cy).setDepth(46))

    // Slow-spinning gold ray behind the lozenge — static under reduced motion (§E8); the lozenge stays.
    const ray = this.add.image(0, 0, 'sweep').setDisplaySize(560, 96).setAlpha(0.4).setBlendMode(Phaser.BlendModes.ADD)
    if (!this.reducedMotion) this.tweens.add({ targets: ray, angle: 360, duration: 2500, repeat: -1, ease: 'Linear' })

    const T = getTheme()
    const text = this.add
      .text(0, 0, word, { fontFamily: FONT, fontSize: '66px', fontStyle: '900', color: T.navyText })
      .setOrigin(0.5)
      .setStroke('#ffffff', 8)
      .setShadow(0, 3, 'rgba(90,70,20,0.22)', 6, true, true)
    const w = text.width + 104
    const h = 130
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.28)
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 8, w, h, h / 2)
    g.fillStyle(T.gold, 1)
    g.fillRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(-w / 2 + 13, -h / 2 + 13, w - 26, h - 26, (h - 26) / 2)
    g.lineStyle(5, T.goldDeep, 1)
    g.strokeRoundedRect(-w / 2, -h / 2, w, h, h / 2)
    layer.add([ray, g, text])

    layer.setScale(0).setAngle(-6)
    // Back.easeOut overshoots ~1.1 then settles to 1 — the elastic punch, with a -6°→0° tilt.
    this.tweens.add({ targets: layer, scale: 1, angle: 0, duration: 340, ease: 'Back.easeOut' })

    // Hold, then fade up 40px as the card enters.
    at(940, () => {
      if (!layer.active) return
      this.tweens.add({
        targets: layer,
        alpha: 0,
        y: cy - 40,
        duration: 300,
        ease: 'Sine.easeIn',
        onComplete: () => layer.destroy(),
      })
    })
  }

  /** Beat 3: three staggered spark bursts + a capped confetti rain + a brand heart puff. */
  private winFireworks(track: <T extends Phaser.GameObjects.GameObject>(o: T) => T, at: (ms: number, cb: () => void) => void): void {
    stageFlare() // light the whole room for the celebration, decaying under the confetti
    const shots: Array<[number, number, number]> = [
      [200, 360, 0xe61f4d],
      [540, 300, 0x26304d],
      [360, 240, 0xffb01c],
    ]
    shots.forEach(([x, y, tint], i) => {
      at(i * 260, () => {
        const fw = track(
          this.add
            .particles(0, 0, 'spark', {
              speed: { min: 200, max: 520 },
              angle: { min: 0, max: 360 },
              scale: { start: 0.5, end: 0 },
              alpha: { start: 0.95, end: 0 },
              lifespan: { min: 700, max: 1100 },
              gravityY: 120,
              tint,
              emitting: false,
            })
            .setDepth(44)
        )
        fw.explode(24, x, y)
        at(1600, () => {
          if (fw.active) fw.destroy()
        })
      })
    })

    // Confetti rain from a top line — capped to ~40 live squares (10 emits × 4).
    const confetti = track(
      this.add
        .particles(0, 0, 'confetti', {
          x: { min: 60, max: 660 },
          y: 120,
          speed: { min: 40, max: 130 },
          angle: { min: 80, max: 100 },
          gravityY: 220,
          rotate: { min: -180, max: 180 },
          lifespan: 1400,
          tint: [0xffb01c, 0xe61f4d, 0x223056, 0xfffdf7],
          quantity: 4,
          frequency: 60,
          emitting: true,
        })
        .setDepth(43)
    )
    at(600, () => {
      if (confetti.active) confetti.stop()
    })
    at(2200, () => {
      if (confetti.active) confetti.destroy()
    })

    // A small heart puff for brand warmth.
    this.overlayHearts(360, 14, 300)
  }

  /**
   * BEAT 3½ (B5) — the win "board sweep-clean" flourish: arc the REMAINING live pieces off the board
   * toward the SCORE readout in a quick staggered cascade (an outward wave from board-centre) so the
   * board visibly EMPTIES into the win. Reuses flyCollect's lifted-quadratic arc, generalized to every
   * live sprite; the whole board fades as ONE unit under the flyers so uncapped cells never pop. The
   * flyers are throwaway copies (`track`ed as transient) — PURELY COSMETIC: the pieces are already
   * logically resolved, so nothing here touches score / objectives / stars / jackpot / any state.
   *
   * Perf + a11y: the caller only schedules this when motion is allowed; the fly count is capped by
   * `quality.count()` (thinning the herd on low tier, 0 ⇒ no-op) and the score spark is count-gated.
   * Returns a canceller the win sequence's skip guard calls: flyers are freed with the transient list,
   * and this stops the board fade + snaps it clean so a mid-flight tap lands on the settled card.
   */
  private sweepBoardClean(track: <T extends Phaser.GameObjects.GameObject>(o: T) => T): () => void {
    const cx = BOARD_X + BOARD_W / 2
    const cy = this.boardTop + BOARD_W / 2
    const distSq = (x: number, y: number): number => (x - cx) * (x - cx) + (y - cy) * (y - cy)
    // Live board sprites, centre-out (nearest first) so both the stride pick and the stagger read as
    // one expanding wave. sort/filter only READ the sprites — the map is never mutated.
    const live = [...this.sprites.values()].filter(s => s.active && s.visible).sort((a, b) => distSq(a.x, a.y) - distSq(b.x, b.y))
    const flyCap = quality.count(SWEEP_FLIES)
    if (flyCap <= 0 || live.length === 0) return () => {}

    // Aim at the SCORE readout's visual centre (its origin is top-right — see buildHud), matching the
    // scoreMilestone glow so the cascade clearly pours INTO the score.
    const targetX = this.scoreText.x - this.scoreText.width / 2
    const targetY = this.scoreText.y + this.scoreText.height / 2

    // Empty the whole board as one fade UNDER the flyers (separate top-depth copies, so the layer's
    // alpha never touches them). Captured so the canceller can stop + snap it on a skip.
    const fade = this.tweens.add({ targets: this.pieceLayer, alpha: 0, duration: SWEEP_FADE_MS, ease: 'Quad.easeIn' })
    // One spark puff at the readout as the pieces converge (reuses sparkEmitter; count-gated, no flash).
    if (quality.count(1) > 0) this.sparkEmitter.explode(quality.count(8), targetX, targetY)

    // Stride across the centre-sorted list so the capped flyers stay spatially spread over the board.
    const stride = Math.max(1, Math.ceil(live.length / flyCap))
    const maxSq = distSq(BOARD_X, this.boardTop) || 1 // corner→centre reference keeps the wave delay in [0, STAGGER]
    const startScale = PIECE_SCALE
    for (let i = 0; i < live.length; i += stride) {
      const s = live[i]
      const fromX = s.x
      const fromY = s.y
      const delay = (distSq(fromX, fromY) / maxSq) * SWEEP_STAGGER_MS
      // A throwaway copy of the piece's face (its own baked texture) sitting exactly on the original.
      const flyer = track(this.add.image(fromX, fromY, s.texture.key, s.frame.name).setDepth(33).setScale(startScale))
      // Control point lifted above both ends → the same gentle board→readout arc as flyCollect.
      const ctrlX = (fromX + targetX) / 2 + (Math.random() * 2 - 1) * 40
      const ctrlY = Math.min(fromY, targetY) - 80 - Math.random() * 40
      const p = { t: 0 }
      this.tweens.add({
        targets: p,
        t: 1,
        delay,
        duration: SWEEP_ARC_MS + Math.random() * 50,
        ease: 'Sine.easeIn',
        onUpdate: () => {
          if (!flyer.active) return // cancelled mid-flight — skip destroyed the flyer out from under us
          const t = p.t
          const u = 1 - t
          flyer.x = u * u * fromX + 2 * u * t * ctrlX + t * t * targetX
          flyer.y = u * u * fromY + 2 * u * t * ctrlY + t * t * targetY
          flyer.setScale(startScale * (1 - 0.55 * t))
          flyer.rotation = t * 1.1
        },
        onComplete: () => {
          if (flyer.active) flyer.destroy() // self-destroy on arrival; idempotent with the skip destroy
        },
      })
    }

    // Canceller for the skip guard: stop the board fade + snap it empty (the flyers are freed by skip).
    return () => {
      fade.stop()
      this.pieceLayer.setAlpha(0)
    }
  }

  /**
   * The HEARTBLOOM (§E4, signature moment #3) — Viva Maya's ownable hero-win beat. A giant translucent
   * heart of light (the baked `heartglow`, ADD, tinted the theme's warm `bloom`) blooms from board-
   * center, BEATS TWICE (lub-DUB) on a cadence inspired by Home's ~620/340 emblem heartbeat, and
   * streams heart-particles up from its apex — all under `sfx.mayaMotif()`, the 3-note leitmotif heard
   * NOWHERE else. Perf: 1 ADD sprite + a capped heart stream (~12 live), transient, over a win where
   * nothing else competes (~0.9 FSE). Reduced motion: a single STATIC heart of light — no double-beat,
   * no streaming particles — but the motif still plays (audio isn't motion). Caller gates scarcity;
   * this method self-guards to one fire per round.
   */
  private heartbloom(cx = DESIGN_W / 2, cy = this.boardTop + BOARD_W / 2): void {
    if (this.heartbloomFired) return
    this.heartbloomFired = true
    sfx.mayaMotif() // the leitmotif rings in BOTH motion modes — audio is never "motion"
    const glow = this.add
      .image(cx, cy, 'heartglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(39) // above the Beat-1 warm bloom (38), below the rank wordmark (46) — a keystone backdrop
      .setTint(getTheme().bloom)
      .setDisplaySize(560, 560)
    const base = glow.scaleX

    if (this.reducedMotion) {
      // Static heart of light: a single soft appear + hold + fade. No double-beat, no strobing, no stream.
      glow.setScale(base).setAlpha(0)
      this.tweens.add({
        targets: glow,
        alpha: 0.4,
        duration: 220,
        ease: 'Quad.easeOut',
        onComplete: () =>
          this.tweens.add({ targets: glow, alpha: 0, delay: 300, duration: 340, onComplete: () => glow.destroy() }),
      })
      return
    }

    // Bloom open, then a lub-DUB doublet (two Back.easeOut swells), then relax + fade out.
    glow.setScale(base * 0.4).setAlpha(0)
    this.tweens.chain({
      targets: glow,
      tweens: [
        { scale: base, alpha: 0.5, duration: 230, ease: 'Back.easeOut' }, // bloom open
        { scale: base * 1.12, duration: 150, ease: 'Back.easeOut' }, // lub
        { scale: base * 0.99, duration: 90, ease: 'Sine.easeInOut' }, // brief diastole
        { scale: base * 1.2, alpha: 0.56, duration: 160, ease: 'Back.easeOut' }, // DUB (the bigger beat)
        { scale: base * 1.06, alpha: 0, delay: 40, duration: 320, ease: 'Quad.easeIn' }, // relax + fade
      ],
      onComplete: () => glow.destroy(),
    })

    // Heart-particles STREAM up from the bloom's apex — a short capped plume (~12 live) timed to the beat.
    const stream = this.add
      .particles(cx, cy - 160, 'heart', {
        speed: { min: 130, max: 300 },
        angle: { min: 250, max: 290 }, // a narrow upward plume (270 = straight up)
        scale: { start: 0.5, end: 0.12 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 600, max: 1000 },
        gravityY: 360,
        rotate: { min: -90, max: 90 },
        quantity: 1,
        frequency: 45, // ~12 emits over the 560ms window → capped live count
        emitting: true,
      })
      .setDepth(45)
    this.time.delayedCall(560, () => stream.active && stream.stop())
    this.time.delayedCall(1700, () => stream.active && stream.destroy())
  }

  /**
   * W2 third-star flourish: a small gold burst crowning the 3rd star as it dings in on the win card —
   * deliberately a tier below the Heartbloom (giant heart of light + leitmotif) that fires on a
   * PERFECT/jackpot win. Rendered ABOVE the card (depth > 41) with its own transient emitter, since the
   * shared spark emitter sits below it. Reduced motion → nothing (the star stays static); the burst is
   * `quality.count()`-gated to nothing on the low tier and self-destroys.
   */
  private thirdStarBurst(x: number, y: number): void {
    if (this.reducedMotion || quality.count(1) === 0) return
    const T = getTheme()
    // Soft gold bloom behind the star.
    const bloom = this.add
      .image(x, y, 'bgglow')
      .setTint(T.gold)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(44)
      .setDisplaySize(120, 120)
      .setAlpha(0)
    this.tweens.add({
      targets: bloom,
      alpha: { from: 0.7, to: 0 },
      scaleX: bloom.scaleX * 1.8,
      scaleY: bloom.scaleY * 1.8,
      duration: 420,
      ease: 'Quad.easeOut',
      onComplete: () => bloom.destroy(),
    })
    // Capped gold spark crown above the card (own emitter — the shared one renders under the card).
    const burst = this.add
      .particles(0, 0, 'spark', {
        speed: { min: 70, max: 220 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.7, end: 0 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 300, max: 560 },
        gravityY: 260,
        tint: [T.gold, T.sparkleTint],
        emitting: false,
      })
      .setDepth(45)
    burst.explode(quality.count(12), x, y)
    this.time.delayedCall(640, () => burst.destroy())
  }

  private rankWord(stars: number): string {
    return stars >= 3 ? 'PERFECT!' : stars === 2 ? 'GREAT!' : 'NICE!'
  }

  /**
   * §G2 · the move budget a player is allowed to BUY on one level, from `DIFFICULTY.economy
   * .purchasedMovesFrac`. That constant was written as the anti-farm guard for exactly this and had
   * no reader anywhere in the codebase — the shelf and the continue offer both go through here now,
   * so "how much of a level can be bought" has one definition.
   *
   * Endless is uncapped-by-absence: it never reaches the continue offer and has no `spec.moves`
   * budget to take a fraction of.
   */
  private purchasedMoveCap(): number {
    return Math.max(0, Math.floor(this.spec.moves * DIFFICULTY.economy.purchasedMovesFrac))
  }

  /** Moves the player may still buy on this level (cap minus what they have already bought). */
  private purchasedMoveRoom(): number {
    return Math.max(0, this.purchasedMoveCap() - this.purchasedMoves)
  }

  /**
   * §G2 THE CONTINUE OFFER — "you ran out; keep this board for N chips?"
   *
   * This is the beat every leader in the genre builds its fail state around, and the one thing this
   * game's loss loop was missing. Everything it needs already existed: a chip balance, a priced
   * `moves5` helper, an atomic `spendChips`, a live `grantMoves`, and a `purchasedMoves` counter that
   * already excludes bought moves from stars, the moves bonus and the chip reward — so a continue
   * buys a WIN and can never buy a better GRADE. That property is what makes offering this safe.
   *
   * Deliberately only shown when it is ACTIONABLE (affordable and under the buy cap). Candy Crush
   * shows an unaffordable offer because the next tap is a payment sheet; here there is no such tap,
   * so an offer the player cannot take is just a taunt — and the lose card already carries the
   * "you were close" beat with its still-needed row.
   *
   * Returns true if it took the screen and now owns the handback.
   */
  private offerContinue(): boolean {
    if (this.endless) return false
    const item = POWER_ITEMS.find(i => i.type === 'moves5')
    const grant = item?.moves ?? 0
    if (!item || grant <= 0) return false
    if (this.purchasedMoveRoom() < grant) return false
    const chips = loadSave().chips
    if (chips < item.price) return false

    // Felt counts toward what is owed (`levelProgress`), so the level that is one felt square from
    // a win now reaches the offer instead of failing this guard with every goal already ticked.
    const { owed, collected } = this.levelProgress()
    if (owed <= 0) return false

    // REACHABILITY GATE. An offer the extra moves cannot actually cash is worse than no offer: it
    // charges for a loss and teaches the player the button is a con. So calibrate on what THIS player
    // did on THIS board — collected-per-move over the moves they just spent — and only offer when the
    // grant plausibly closes the gap. The 1.4 is deliberate optimism (a late cascade beats the
    // average), not a fudge: at 1.0 a player who needed one lucky chain would never see the offer.
    // Both sides of this comparison count felt, so the rate stays honest: crediting the felt already
    // swept while charging for the felt still owed is what keeps a felt-heavy level from reading as
    // hopeless to a gate that only ever watched the symbols.
    const movesUsed = Math.max(1, this.spec.moves + this.purchasedMoves - this.movesLeft)
    if (owed > (collected / movesUsed) * grant * 1.4) return false

    track(EVENTS.CONTINUE_SHOWN, { level: this.level, price: item.price, chips, near: owed })

    const T = getTheme()
    const reduced = this.reducedMotion
    const cx = DESIGN_W / 2
    const cy = 590
    const halfH = 210
    const w = 520
    // Own scrim rather than `overlayScrim()`: this is the one overlay in the scene that can be
    // DISMISSED back to a live board, so it needs a handle to destroy. `setInteractive` swallows taps
    // on the board underneath, which matters here more than anywhere else — the board is still
    // playable and a stray tap must not reach it while the offer is up.
    this.clearSelection()
    const scrim = this.add
      .rectangle(DESIGN_W / 2, viewportCenterY(), DESIGN_W, worldH(), T.scrim, 0.5)
      .setDepth(40)
      .setInteractive()
    sfx.loseWah()

    const card = this.add.container(cx, cy).setDepth(41)
    const g = this.add.graphics()
    g.fillStyle(T.shadow, 0.25)
    g.fillRoundedRect(-w / 2 + 4, -halfH + 8, w, halfH * 2, 34)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    g.lineStyle(4, T.goldBezel, 1)
    g.strokeRoundedRect(-w / 2, -halfH, w, halfH * 2, 34)
    card.add(g)

    card.add(
      this.add
        .text(0, -150, 'OUT OF MOVES', { fontFamily: FONT, fontSize: '40px', fontStyle: '900', color: T.navyText })
        .setOrigin(0.5)
        .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
    )

    // The stake, stated plainly. The still-needed row is the lose card's job; here the player needs
    // exactly one number to decide, so we show the single nearest goal rather than all three.
    let nearIdx = -1
    let nearRem = Infinity
    this.objectives.forEach((o, i) => {
      if (o.remaining > 0 && o.remaining < nearRem) {
        nearRem = o.remaining
        nearIdx = i
      }
    })
    if (nearIdx >= 0) {
      const near = this.objectives[nearIdx]
      const row = this.add.container(0, -92)
      const label = this.add
        .text(-16, 0, `${near.remaining} more`, { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: T.ink })
        .setOrigin(1, 0.5)
      row.add([label, this.add.image(label.x + 34, 0, near.symbol).setDisplaySize(44, 44)])
      card.add(row)
    }

    const priceRow = this.add.container(0, -30)
    const priceText = this.add
      .text(14, 0, String(item.price), { fontFamily: FONT, fontSize: '34px', fontStyle: '900', color: T.ink })
      .setOrigin(0, 0.5)
    priceRow.add([this.add.image(-10, 0, 'chip').setDisplaySize(40, 40), priceText])
    card.add(priceRow)
    card.add(
      this.add
        .text(0, 12, `you have ${chips.toLocaleString()}`, { fontFamily: FONT, fontSize: '20px', color: T.inkMuted })
        .setOrigin(0.5)
    )

    // One-shot latch: both exits destroy the card, and whichever fires first disables the other, so a
    // double-tap can never both spend chips AND lose the level.
    let settled = false
    const close = (): void => {
      card.destroy()
      scrim.destroy()
    }

    const keepGoing = (): void => {
      if (settled) return
      settled = true
      const balance = spendChips(item.price)
      if (balance === null) {
        // Chips moved under us (another surface spent them). Treat as a decline rather than a silent
        // no-op: the player asked to continue and we could not honour it, so end the level honestly.
        close()
        this.finishLose()
        return
      }
      track(EVENTS.CONTINUE_TAKEN, { level: this.level, price: item.price })
      close()
      this.chipHud?.update(balance)
      sfx.coinCount()
      this.grantMoves(grant)
      this.powerToast(`+${grant} moves`, 'good')
      this.renderPowerItems() // affordability changed — restyle the shelf before it comes back
      this.powerBar?.setVisible(true)
      // Hand the board back exactly the way `resolveLoop` does at its idle handoff.
      this.state = 'idle'
      this.scheduleAutoplay()
      this.armHint()
    }

    const giveUp = (): void => {
      if (settled) return
      settled = true
      close()
      this.finishLose()
    }

    card.add(addPillButton(this, 0, 88, 380, 84, `+${grant} MOVES`, GOLD_PILL, keepGoing))
    card.add(addPillButton(this, 0, 172, 300, 60, 'GIVE UP', GHOST_PILL, giveUp))

    if (!reduced) {
      card.setScale(0.94).setAlpha(0).setY(cy + 18)
      this.tweens.add({ targets: card, scale: 1, alpha: 1, y: cy, duration: 360, ease: E.settle })
    }
    return true
  }

  /**
   * What the level still owes, and what it has already yielded — collect goals PLUS the felt still
   * on the table, as one pair.
   *
   * The win check in `resolveLoop` has always been the conjunction of both terms (every objective
   * met AND `coatsRemaining() === 0`), but the three surfaces that EXPLAIN a shortfall each read
   * `this.objectives` alone. On a level whose LAST outstanding requirement was felt that was not a
   * cosmetic gap: the lose card rendered a row of green checks under the heading STILL NEEDED, and
   * `offerContinue` bailed on `owed <= 0` at precisely the moment one more move would have won the
   * level — the offer withheld exactly where it was worth the most. Every one of them now reads
   * this, so what the game SAYS it wants can no longer disagree with what it actually checks.
   *
   * Felt counts in layers, not squares (a 2-layer coat owes 2), matching `coatsToClear` and the
   * FELT n/m HUD counter. `coatsTotal` is 0 on every hazard-free level and in endless, so both
   * terms collapse to the objectives-only arithmetic that was here before.
   */
  private levelProgress(): { owed: number; collected: number; total: number } {
    return levelProgress(this.objectives, this.board.coatsRemaining(), this.coatsTotal)
  }

  /**
   * §G13 — did this loss actually end within reach? Drives the lose card's copy, which used to
   * assert a near miss on every single loss regardless (the line was seeded by SCORE, a number with
   * no relationship at all to how much goal was left).
   */
  private wasCloseLoss(): boolean {
    const { owed, total } = this.levelProgress()
    return wasNearMiss(owed, total)
  }

  private finishLose(): void {
    this.log('finishLose')
    this.state = 'ended'
    this.clearBookedSwap() // §G1
    this.stopMovesPulse()
    this.powerBar?.setVisible(false) // retire the helper shelf — the result card takes the screen
    spendLifeFor(this.level) // a loss costs a life (grace below level 10; numbered levels only reach finishLose)
    // …and it breaks the HOT STREAK. This is the only thing in the game a loss can take away, and it
    // is deliberately momentum rather than property: no chips, stars or charms are touched, so the
    // mercy rule holds and the cost is entirely "you were two wins from a Deal and now you are three".
    //
    // Silently, on purpose. The streak is shown as FORWARD progress on the win card and on Home, and
    // never as a loss on the lose card: a player who just ran out of moves is being told something
    // kind by `warmLoseLine` right above, and "you also lost your streak of 4" is the one line that
    // would undo it. Home's HOT STREAK clause simply stops being there next time they look, which
    // says the same thing without making the loss screen the one that says it.
    resetWinStreak()
    recordScore(this.score)
    track(EVENTS.LEVEL_FAIL, { level: this.level, reason: 'out_of_moves' })
    this.time.delayedCall(400, () => this.showOverlay(false, 0, 0))
  }

  private finishEndless(): void {
    this.log('finishEndless', 'cheats', this.cheatFires)
    this.state = 'ended'
    this.clearBookedSwap() // §G1
    this.stopMovesPulse()
    // A run that fired the cheat strip's mega win still reaches the race, but only as a PACE score —
    // clamped to ENDLESS_MAX_CHEAT_SCORE inside recordEndless, which is the one place it happens. `posted`
    // is what actually went to the board, and it is what the card has to talk about.
    const paced = this.cheatFires > 0
    const { best, isRecord, week, posted } = recordEndless(this.score, this.endlessDayKey, { paced })
    track(EVENTS.ENDLESS_END, {
      score: this.score,
      posted,
      is_record: isRecord,
      days: week.days,
      cheats: this.cheatFires,
    })
    this.time.delayedCall(450, () => this.showEndlessOverlay(this.score, best, isRecord, week, paced ? posted : null))
  }

  /**
   * A star-milestone celebration (levels 10/20/30…): a big "LEVEL N · ★ totalStars"
   * flourish with a heart shower over the board, then hands off to the result card.
   */
  private milestoneSplash(totalStars: number, done: () => void): void {
    sfx.winFanfare()
    this.time.delayedCall(180, () => sfx.jackpotStrike())
    this.vibrate([80, 50, 120])
    const cx = DESIGN_W / 2
    const cy = 560
    this.overlayHearts(cx, 30, cy - 60)
    const layer = this.add.container(0, 0).setDepth(48)
    const big = this.add
      .text(cx, cy - 44, `LEVEL ${this.level}!`, {
        fontFamily: FONT,
        fontSize: '76px',
        fontStyle: '900',
        color: getTheme().goldText,
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 10)
      .setShadow(0, 4, 'rgba(0,0,0,0.22)', 10, true, true)
      .setScale(0)
    const sub = this.add
      .text(cx, cy + 60, `★  ${totalStars} STARS EARNED  ★`, {
        fontFamily: FONT,
        fontSize: '38px',
        fontStyle: '900',
        color: css(getTheme().rose),
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 8)
      .setAlpha(0)
    layer.add([big, sub])
    this.tweens.add({ targets: big, scale: 1, duration: 360, ease: 'Back.easeOut' })
    // Genuine slide-up (from cy+60 to cy+42) as it fades in.
    this.tweens.add({ targets: sub, alpha: 1, y: cy + 42, duration: 300, delay: 240, ease: 'Sine.easeOut' })
    this.time.delayedCall(1550, () =>
      this.tweens.add({
        targets: layer,
        alpha: 0,
        duration: 300,
        onComplete: () => {
          layer.destroy()
          done()
        },
      })
    )
  }

  /**
   * §E9 ALL CLEAR (signature moment #6) — the one-time grand finale on clearing the FINAL level.
   * A full marquee celebration + the Heartbloom hero beat + a lingering, staggered heart shower + a
   * heartfelt line, with the owner's private sign-off appended ONLY when maya.secretMessage is set
   * (else a clean generic close). Reuses existing emitters/textures; reduced motion → static text +
   * one soft heart puff, no staggered showers. Latched by finaleSeen upstream — plays once, ever.
   */
  private allClearFinale(totalStars: number, done: () => void): void {
    const reduced = this.reducedMotion
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = 520
    sfx.winFanfare()
    this.time.delayedCall(220, () => sfx.jackpotStrike())
    this.vibrate([80, 60, 140, 60, 220])
    this.flashCabinet() // full marquee celebration (bulbs pop + reddish glow surge)
    // The Heartbloom hero beat, centred (self-guards to one fire — may already be lit on a 3★ clear).
    this.heartbloom(cx, cy + 40)
    // A lingering heart shower — staggered bursts (one soft puff under reduced motion).
    this.overlayHearts(cx, reduced ? 12 : 28, cy - 20)
    if (!reduced) {
      this.time.delayedCall(450, () => this.overlayHearts(cx - 150, 20, cy + 60))
      this.time.delayedCall(900, () => this.overlayHearts(cx + 150, 20, cy - 80))
      this.time.delayedCall(1400, () => this.overlayHearts(cx, 24, cy + 20))
    }

    const layer = this.add.container(0, 0).setDepth(48)
    const title = this.add
      .text(cx, cy - 150, 'ALL CLEAR', { fontFamily: FONT, fontSize: '80px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setLetterSpacing(3)
      .setStroke('#ffffff', 10)
      .setShadow(0, 4, 'rgba(0,0,0,0.22)', 10, true, true)
    const tally = this.add
      .text(cx, cy - 78, `★  ${LEVEL_COUNT} LEVELS  ·  ${totalStars} STARS  ★`, {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: css(T.rose),
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 6)
    // The heartfelt line — always-on, non-name. Owner sign-off appended ONLY when secretMessage is set.
    const sign = maya.secretMessage?.trim()
    const heartfelt =
      sign && sign.length > 0
        ? `You finished every level.\nThank you for playing. ♥\n\n${sign}`
        : 'You finished every level.\nThank you for playing. ♥'
    // Drawn over the ALWAYS-cream board (not the backdrop) → use the cream-safe ink (dark on every
    // theme) + a white stroke so it stays legible under the celebration, even on the dark themes.
    const line = this.add
      .text(cx, cy + 150, heartfelt, {
        fontFamily: FONT,
        fontSize: '26px',
        fontStyle: '700',
        color: T.ink,
        align: 'center',
        lineSpacing: 8,
      })
      .setOrigin(0.5)
      .setStroke('#ffffff', 5)
      .setShadow(0, 2, 'rgba(0,0,0,0.18)', 5, false, true)
    layer.add([title, tally, line])

    if (reduced) {
      title.setScale(0.92)
      this.time.delayedCall(2800, () =>
        this.tweens.add({ targets: layer, alpha: 0, duration: 340, onComplete: () => { layer.destroy(); done() } })
      )
      return
    }
    title.setScale(0)
    tally.setAlpha(0)
    line.setAlpha(0).setY(cy + 162)
    this.tweens.add({ targets: title, scale: 1, duration: 420, ease: 'Back.easeOut' })
    this.tweens.add({ targets: tally, alpha: 1, duration: 320, delay: 320, ease: 'Sine.easeOut' })
    this.tweens.add({ targets: line, alpha: 1, y: cy + 150, duration: 420, delay: 720, ease: 'Sine.easeOut' })
    this.time.delayedCall(3800, () =>
      this.tweens.add({ targets: layer, alpha: 0, duration: 360, onComplete: () => { layer.destroy(); done() } })
    )
  }

  /**
   * §E9 special-date dress-up (signature moment #5) — on a configured occasion (once per day) fire a
   * heart-shower over the board, the in-game "it knew" touch. Dormant with the default empty
   * occasions[]. Reduced motion → a single static heart, no shower.
   */
  private maybeOccasion(): void {
    const today = todayKey()
    if (!pendingOccasion(today, loadSave().occasionsSeen)) return
    markOccasionSeen(today)
    if (this.reducedMotion) {
      const h = this.add.image(DESIGN_W / 2, this.boardTop + BOARD_W / 2, 'heartbig').setDisplaySize(90, 90).setDepth(45).setAlpha(0.85)
      this.time.delayedCall(1400, () => h.destroy())
      return
    }
    this.overlayHearts(DESIGN_W / 2, 22, this.boardTop + BOARD_W / 2)
  }

  /** Dim scrim behind an end-of-round overlay (also swallows taps meant for the board). */
  private overlayScrim(): void {
    this.clearSelection()
    // Spotlight scrim, not a flat ink wall — the card above it sits in a pool of light. The hit
    // rect keeps the old rectangle's job of swallowing board taps.
    addFocusScrim(this, { alpha: 0.5, depth: 40 }).hit.setInteractive()
  }

  /** Shared rounded result card, centered at (cx, cy) with half-height halfH. */
  private overlayCard(cx: number, cy: number, halfH: number): void {
    // The board slab's elevation cue applied to the result card: a baked softshadow float under a
    // rich platekit plate. Depth 41 — above the scrim (40), below the card content (42).
    this.add
      .image(cx, cy + 26, 'softshadow')
      .setDisplaySize(520 + 72, halfH * 2 + 72)
      .setAlpha(0.3)
      .setDepth(41)
    const g = this.add.graphics().setDepth(41)
    panelPlate(g, cx - 260, cy - halfH, 520, halfH * 2, 34)
  }

  /** Maya's touch: a shower of hearts bursting from (x, y). */
  private overlayHearts(x: number, count: number, y = 400): void {
    const hearts = this.add
      .particles(0, 0, 'heart', {
        speed: { min: 140, max: 420 },
        angle: { min: 220, max: 320 },
        scale: { start: 0.55, end: 0.15 },
        alpha: { start: 1, end: 0 },
        lifespan: { min: 700, max: 1300 },
        gravityY: 500,
        rotate: { min: -120, max: 120 },
        emitting: false,
      })
      .setDepth(45)
    hearts.explode(count, x, y)
    this.time.delayedCall(1600, () => hearts.destroy())
  }

  private showOverlay(win: boolean, stars: number, bonus: number, chipReward = 0, celebrate = true, animate = true): void {
    this.log('showOverlay', win ? 'win' : 'lose', 'stars', stars, 'bonus', bonus, 'reward', chipReward)
    this.overlaySettle = null
    this.overlayScrim()

    if (win) {
      // celebrate=false when a milestone splash / win sequence already fired the fanfare.
      if (celebrate) {
        sfx.winFanfare()
        this.vibrate(80)
        this.overlayHearts(DESIGN_W / 2, 26)
      }
      this.buildWinCard(stars, bonus, chipReward, animate)
      return
    }

    sfx.loseWah()
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = 590
    const halfH = 230
    const w = 520
    // Everything lives in ONE container (mirroring buildWinCard) so the card can gently scale + fade
    // in as a unit — a calm settle rather than the old hard appear. Depth 41 sits above the scrim (40).
    const card = this.add.container(cx, cy).setDepth(41)

    // Card panel (cream + gold bezel) — inlined from overlayCard at container-relative coords so the
    // backdrop (float shadow included) scales together with the contents during the entrance.
    card.add(this.add.image(0, 26, 'softshadow').setDisplaySize(w + 72, halfH * 2 + 72).setAlpha(0.3))
    const g = this.add.graphics()
    panelPlate(g, -w / 2, -halfH, w, halfH * 2, 34)
    card.add(g)

    // The lose card's content stagger (below) needs the single-alpha surface every child exposes;
    // narrower than the Alpha component so Containers (livesHud, pills) qualify too.
    type Fadeable = Phaser.GameObjects.GameObject & { alpha: number; setAlpha(value?: number): unknown }

    // §E9 warm lose copy — a kind rotating line instead of the cold "OUT OF MOVES". Seeded by score
    // so it stays stable for this result. Navy (not the warn colour) reads as gentle, not an error.
    const loseTitle = this.add
      .text(0, -160, warmLoseLine(this.score, this.wasCloseLoss()), {
        fontFamily: FONT,
        fontSize: '42px',
        fontStyle: '900',
        color: T.navyText,
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
    card.add(loseTitle)

    // Show WHICH symbols still need collecting (icon + count), not bare numbers — a learning player
    // reads "which ones do I still need?" at a glance. A finished goal dims to a green check.
    //
    // Felt is a REQUIREMENT, not decoration, so it takes a slot in this row on any level that has
    // it. Reading `this.objectives` alone was how a player who had ticked every symbol but left one
    // felt square got a STILL NEEDED heading over three green checks — a card that showed nothing
    // outstanding to explain a loss, on the one screen whose entire job is explaining the loss.
    // A real sample of the coat art (not a stand-in glyph) so the row points at the thing on the
    // board; `ensureHazardTexture` is lazy and idempotent, and on a coated level it is already baked.
    const slots: { texture: string; remaining: number }[] = this.objectives.map(o => ({
      texture: o.symbol,
      remaining: Math.max(0, o.remaining),
    }))
    if (this.coatsTotal > 0) {
      slots.push({ texture: ensureHazardTexture(this, 'coat', 1), remaining: this.board.coatsRemaining() })
    }
    const goalRow: Fadeable[] = []
    const stillLabel = this.add
      .text(0, -112, 'STILL NEEDED', { fontFamily: FONT, fontSize: '18px', color: T.inkMuted })
      .setOrigin(0.5)
      .setLetterSpacing(3)
    card.add(stillLabel)
    goalRow.push(stillLabel)
    // "So close" emphasis — the nearest-to-complete goal (smallest count still OWED) gets a soft warm
    // shimmer below, so a loss reads as "you almost had this". Only the single nearest one is picked;
    // nearIdx stays -1 if nothing is owed (never on a real loss), which harmlessly skips the highlight.
    let nearIdx = -1
    let nearRem = Infinity
    slots.forEach((s, i) => {
      if (s.remaining > 0 && s.remaining < nearRem) {
        nearRem = s.remaining
        nearIdx = i
      }
    })
    const slotW = 94
    const x0 = -((slots.length - 1) * slotW) / 2
    let nearIcon: Phaser.GameObjects.Image | undefined
    let nearHalo: Phaser.GameObjects.Image | undefined
    slots.forEach((s, i) => {
      const ox = x0 + i * slotW
      const done = s.remaining <= 0
      if (i === nearIdx) {
        // Soft gold glow radiating from the nearest symbol (ADD, tucked BEHIND the icon). Rests at a
        // static soft alpha under reduced motion; breathes otherwise (gated with the entrance below).
        nearHalo = this.add
          .image(ox, -66, 'bgglow')
          .setTint(T.gold)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDisplaySize(84, 84)
          .setAlpha(this.reducedMotion ? 0.5 : 0.26)
        card.add(nearHalo)
      }
      const icon = this.add.image(ox, -66, s.texture).setDisplaySize(48, 48).setAlpha(done ? 0.4 : 1)
      card.add(icon)
      goalRow.push(icon)
      if (i === nearIdx) nearIcon = icon
      const count = this.add
        .text(ox, -30, done ? '✓' : String(s.remaining), {
          fontFamily: FONT,
          fontSize: '26px',
          fontStyle: '900',
          color: done ? T.ok : T.ink,
        })
        .setOrigin(0.5)
      card.add(count)
      goalRow.push(count)
    })

    const scoreLine = this.add
      .text(0, 10, `SCORE  ${this.score.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: T.ink,
      })
      .setOrigin(0.5)
    card.add(scoreLine)

    // A loss spent a life — show what's left + when the next one lands.
    const livesHud = addLivesHud(this, 0, 56, { size: 28 })
    card.add(livesHud.container)
    const refresh = (): void => livesHud.update(refreshLives())
    refresh()
    this.time.addEvent({ delay: 1000, loop: true, callback: refresh })

    // §G10 — the loss that just spent the last heart used to leave RETRY as a gold PRIMARY button
    // that walked straight into the lives wall: the app's strongest "do this next" style, promising
    // something it could not deliver. When the pool is empty it now says so and offers the refill
    // instead, which is the one action that actually leads anywhere from here.
    // Same destination either way — `create()` already routes an empty pool to `showLivesGate`, so
    // the restart lands there on its own. What changes is that the button stops lying about it.
    // (Routing to `showLivesGate()` directly would draw the gate UNDER this card, which is still at
    // depth 41 — the restart is what actually clears the screen.)
    const outOfLives = refreshLives().lives <= 0
    const retryBtn = addPillButton(
      this,
      0,
      140,
      300,
      72,
      outOfLives ? 'OUT OF HEARTS' : 'RETRY',
      outOfLives ? GHOST_PILL : GOLD_PILL,
      () => startScene(this, 'game', { level: this.level })
    )
    const levelsBtn = addPillButton(this, 0, 140 + 84, 300, 60, 'LEVELS', GHOST_PILL, () => startScene(this,'levelselect'))
    card.add(retryBtn)
    card.add(levelsBtn)

    // Entrance — a gentler, sympathetic beat than the win card's elastic pop: the card EXHALES into
    // place (a soft rise + settle, deliberately no overshoot), and its contents breathe in as a
    // quiet top-down stagger (title → goals → score → lives → buttons) so a loss lands kindly,
    // never as a punchline. Reduced motion → instant card, no stagger (today's feel).
    if (!this.reducedMotion) {
      card.setScale(0.96).setAlpha(0).setY(cy + 22)
      this.tweens.add({ targets: card, scale: 1, alpha: 1, y: cy, duration: 420, ease: E.settle })
      // Content stagger: fade each row up to ITS resting alpha (icons may rest dimmed at 0.4), on
      // top of the card's own unit fade. The halos stay out of it — the near-goal halo's breathe
      // below owns that alpha. Delays stay short so RETRY is never kept from a fast tap.
      const rows: Fadeable[][] = [[loseTitle], goalRow, [scoreLine], [livesHud.container], [retryBtn, levelsBtn]]
      rows.forEach((row, i) => {
        for (const o of row) {
          const resting = o.alpha
          o.setAlpha(0)
          this.tweens.add({ targets: o, alpha: resting, delay: 140 + i * 80, duration: D.settle, ease: E.settle })
        }
      })
      // One quiet heart drifts up off the card's crown and fades — sympathy, not celebration (the
      // full shower stays the win's beat). A lone transient that destroys itself.
      const heart = this.add
        .image(cx, cy - halfH - 6, 'heart')
        .setDisplaySize(34, 34)
        .setDepth(41)
        .setAlpha(0)
      this.tweens.add({
        targets: heart,
        alpha: { from: 0, to: 0.7 },
        y: cy - halfH - 60,
        delay: 520,
        duration: 800,
        ease: E.settle,
        onComplete: () =>
          this.tweens.add({ targets: heart, alpha: 0, y: heart.y - 26, duration: 480, ease: E.exit, onComplete: () => heart.destroy() }),
      })
    }
    // Shimmer the nearest goal once the card has settled — a gentle icon + halo breath (soft tint/
    // scale, never a hard flash). Reduced motion keeps the static highlight above, no breathing.
    if (nearIcon && !this.reducedMotion) {
      this.tweens.add({ targets: nearIcon, scale: nearIcon.scale * 1.08, duration: 900, yoyo: true, repeat: -1, delay: 320, ease: 'Sine.easeInOut' })
      if (nearHalo) {
        this.tweens.add({ targets: nearHalo, alpha: 0.5, duration: 900, yoyo: true, repeat: -1, delay: 320, ease: 'Sine.easeInOut' })
      }
    }
  }

  /**
   * Beat 4 — the win result card: an elastic scale-in entrance (0→1.06→1), the rank-word
   * title, a star row with ascending dings, and the COIN ROLL-UP PAYOUT (a chip pile on a gold
   * disc with chips flying in as a counter rolls 0→chipReward). Everything lives in one container
   * so the card can scale as a unit; `animate=false` builds it fully settled (tap-to-skip lands
   * here). Never occludes the reward number or the Continue button.
   */
  private buildWinCard(stars: number, bonus: number, chipReward: number, animate: boolean): void {
    const T = getTheme()
    const cx = DESIGN_W / 2
    const cy = 610
    const halfH = 300
    const w = 520
    const card = this.add.container(cx, cy).setDepth(41)

    const settleActions: Array<() => void> = []
    const settleTimers: Phaser.Time.TimerEvent[] = []
    const at = (ms: number, cb: () => void): void => {
      settleTimers.push(this.time.delayedCall(ms, cb))
    }

    // Card panel (cream + gold bezel) riding a softshadow float; the win card keeps its brighter
    // `gold` bezel (vs the panels' goldBezel) — that contrast is part of the win read.
    card.add(this.add.image(0, 26, 'softshadow').setDisplaySize(w + 72, halfH * 2 + 72).setAlpha(0.3))
    const g = this.add.graphics()
    panelPlate(g, -w / 2, -halfH, w, halfH * 2, 34, { bezel: T.gold })
    card.add(g)

    // "LEVEL N" gold pill tab straddling the top edge.
    const tab = this.add.container(0, -halfH)
    const tabLabel = this.add
      .text(0, 0, `LEVEL ${this.level}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: T.goldPillText })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    const tw = tabLabel.width + 56
    const tg = this.add.graphics()
    // Real-metal tab, not flat gold — the champion plate's material. r=25 (h/2 − 1, §2c) on the
    // stroke too, so face and bezel share one radius (§2b).
    goldFace(tg, -tw / 2, -26, tw, 52, T, 25)
    tg.lineStyle(3, T.goldDeep, 1)
    tg.strokeRoundedRect(-tw / 2, -26, tw, 52, 25)
    tab.add([tg, tabLabel])
    card.add(tab)

    // Rank-word title.
    const title = this.add
      .text(0, -216, this.rankWord(stars), { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)
    card.add(title)

    // Sharpened entrance stagger: the LEVEL tab and rank word pop in a beat AFTER the card lands
    // (card → tab → title, each with a calibrated overshoot) instead of riding one monolithic
    // scale-in — the eye gets three small arrivals rather than one blob. Reduced motion keeps the
    // instant settled card (the tweens never start); tap-to-skip snaps both to rest via settleActions.
    if (animate && !this.reducedMotion) {
      title.setScale(0.4).setAlpha(0)
      this.tweens.add({ targets: title, scale: 1, alpha: 1, delay: 120, duration: D.pop, ease: backOut(OVERSHOOT.pop) })
      settleActions.push(() => title.setScale(1).setAlpha(1))
      tab.setScale(0)
      this.tweens.add({ targets: tab, scale: 1, delay: 200, duration: D.pop, ease: backOut(OVERSHOOT.pop) })
      settleActions.push(() => tab.setScale(1))
    }

    // §E9 warm subtitle under the rank word — always-on, non-name gentle encouragement (seeded by
    // score so it stays stable for this result). It follows the rank word into place (a quiet fade
    // a beat behind the title's pop) so the pair always reads top-down; instant under reduced motion.
    const subtitle = this.add
      .text(0, -176, warmWinSubtitle(this.score), { fontFamily: FONT, fontSize: '20px', fontStyle: '700', color: T.inkSoft })
      .setOrigin(0.5)
    card.add(subtitle)
    if (animate && !this.reducedMotion) {
      subtitle.setAlpha(0)
      this.tweens.add({ targets: subtitle, alpha: 1, delay: 300, duration: D.settle, ease: E.settle })
      settleActions.push(() => subtitle.setAlpha(1))
    }

    // §E9 NEW BEST! ribbon — a small rose banner across the card's top-left corner on a record score.
    if (this.newBestThisWin) {
      const ribbon = this.add.container(-156, -252).setAngle(-16)
      const rt = this.add.text(0, 0, 'NEW BEST!', { fontFamily: FONT, fontSize: '21px', fontStyle: '900', color: T.onRose }).setOrigin(0.5)
      const rw = rt.width + 40
      const rh = 42
      const rg = this.add.graphics()
      rg.fillStyle(T.shadow, 0.25)
      rg.fillRoundedRect(-rw / 2 + 2, -rh / 2 + 3, rw, rh, rh / 2)
      rg.fillStyle(T.rose, 1)
      rg.fillRoundedRect(-rw / 2, -rh / 2, rw, rh, rh / 2)
      rg.lineStyle(3, T.roseDeep, 1)
      rg.strokeRoundedRect(-rw / 2, -rh / 2, rw, rh, rh / 2)
      ribbon.add([rg, rt])
      card.add(ribbon)
      if (animate) {
        ribbon.setScale(0)
        this.tweens.add({ targets: ribbon, scale: 1, delay: 360, duration: 300, ease: 'Back.easeOut' })
        settleActions.push(() => ribbon.setScale(1))
      }
    }

    // Faint static gold ray behind the star row.
    const ray = this.add.image(0, -122, 'sweep').setDisplaySize(440, 96).setAlpha(0.22).setBlendMode(Phaser.BlendModes.ADD)
    card.add(ray)

    // Star row (earned stars pop in with ascending dings).
    for (let i = 0; i < 3; i++) {
      const earned = i < stars
      const star = this.add.image((i - 1) * 84, -122, 'star').setAlpha(earned ? 1 : 0.22)
      const finalScale = (earned ? 1 : 0.8) * (68 / 128) // 128 = 'star' native size (baked larger for hi-DPI)
      card.add(star)
      if (animate) {
        star.setScale(0)
        const delay = 150 + i * 160
        this.tweens.add({ targets: star, scale: finalScale, delay, duration: 260, ease: 'Back.easeOut' })
        if (earned)
          at(delay, () => {
            sfx.starDing(i)
            // W2: crown the 3rd (max) star with a small gold burst — a tier below the Heartbloom, which
            // already fires on a PERFECT/jackpot win. cx/cy are the card's rest coords; the star sits at
            // local ((i-1)*84, -122). Self-gates to nothing under reduced motion / low tier.
            if (i === 2) this.thirdStarBurst(cx + (i - 1) * 84, cy - 122)
          })
        settleActions.push(() => star.setScale(finalScale))
      } else {
        star.setScale(finalScale)
      }
    }

    // Score + optional moves bonus.
    card.add(
      this.add
        .text(0, -44, `SCORE  ${this.score.toLocaleString()}`, {
          fontFamily: FONT,
          fontSize: '34px',
          fontStyle: '900',
          color: T.navyText,
        })
        .setOrigin(0.5)
    )
    if (bonus > 0) {
      card.add(
        this.add.text(0, -6, `+${bonus.toLocaleString()} moves bonus`, { fontFamily: FONT, fontSize: '20px', color: T.goldText }).setOrigin(0.5)
      )
    }

    // COIN ROLL-UP PAYOUT.
    this.buildCoinPayout(card, chipReward, animate, at, settleActions)

    // Continue buttons. When the jackpot meter just filled, these route through the wheel first
    // (continueAfterWin) so it fires exactly once, then performs the original transition.
    const nextExists = this.level < LEVEL_COUNT
    const nextBtn = addPillButton(this, 0, 176, 300, 72, nextExists ? 'NEXT LEVEL' : 'ALL CLEAR!', GOLD_PILL, () => {
      this.continueAfterWin(() => {
        if (nextExists) startScene(this,'game', { level: this.level + 1 })
        else startScene(this,'levelselect', { fromWin: true })
      })
    })
    // Beat 5: a soft gold glow-ring pulse behind the Continue pill to lead the eye. Gated (§E8):
    // reduced motion rests it at a static soft glow, no pulse.
    const glow = this.add.image(0, 176, 'bgglow').setTint(T.gold).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(360, 150).setAlpha(this.reducedMotion ? 0.28 : 0.18)
    card.add(glow)
    if (!this.reducedMotion) this.tweens.add({ targets: glow, alpha: 0.42, duration: 780, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    card.add(nextBtn)
    card.add(
      addPillButton(this, 0, 176 + 84, 300, 60, 'LEVELS', GHOST_PILL, () =>
        this.continueAfterWin(() => startScene(this,'levelselect', { fromWin: true }))
      )
    )

    // §Jackpot / §Deal — a bonus armed by this win crowns the card with a glowing banner (above the
    // top edge, clear of the LEVEL tab) telegraphing what explodes in on Continue.
    //
    // BOTH can arm on the same win (the wheel every 5th, the Deal every 3rd — so once every 15), and
    // `continueAfterWin` queues them wheel-then-Deal. The banners stack in that same order reading
    // downward, so the crown shows the running order rather than one prize hiding the other.
    const crown = (text: string, fill: number, y: number): void => {
      const ready = this.add.container(0, y)
      const rt = this.add.text(0, 0, text, { fontFamily: FONT, fontSize: '22px', fontStyle: '900', color: T.onRose }).setOrigin(0.5)
      const rw = rt.width + 44
      const rg = this.add.graphics()
      rg.fillStyle(T.shadow, 0.25)
      rg.fillRoundedRect(-rw / 2 + 2, -21 + 3, rw, 42, 21)
      rg.fillStyle(fill, 1)
      rg.fillRoundedRect(-rw / 2, -21, rw, 42, 21)
      rg.lineStyle(3, T.goldBright, 1)
      rg.strokeRoundedRect(-rw / 2, -21, rw, 42, 21)
      const rglow = this.add.image(0, 0, 'bgglow').setTint(fill).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(rw + 60, 90).setAlpha(this.reducedMotion ? 0.3 : 0.2)
      ready.add([rglow, rg, rt])
      card.add(ready)
      if (!this.reducedMotion) this.tweens.add({ targets: rglow, alpha: 0.5, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' })
    }
    const bothArmed = this.jackpotArmed && this.dealArmed
    if (this.jackpotArmed) crown('🎰  JACKPOT READY!', T.rose, -halfH - (bothArmed ? 98 : 50))
    if (this.dealArmed) crown('🃏  LUCKY DEAL READY!', T.navy, -halfH - 50)

    // …and when nothing is armed, the STREAK ITSELF, as forward progress. This line is the whole
    // reason a three-win trigger works: without it a streak is invisible state and the Deal arrives
    // as a surprise every time, which is pleasant but creates no anticipation and gives the next
    // level nothing riding on it. With it, the second win of a run ends on "1 MORE WIN".
    if (!this.dealArmed) {
      const streak = loadSave().winStreak
      if (streak > 0) {
        const left = winsToDeal(streak)
        card.add(
          this.add
            .text(0, 128, `HOT STREAK ${streak}  ·  ${left === 1 ? '1 MORE WIN' : `${left} MORE WINS`} TO A DEAL`, {
              fontFamily: FONT,
              fontSize: '18px',
              fontStyle: '900',
              color: T.goldText,
            })
            .setOrigin(0.5)
            .setLetterSpacing(1)
        )
      }
    }

    // Rose skip/close chip (top-right) — a tap jumps straight to the settled card. It's the one
    // board-adjacent control NOT built via buildPressable (a bespoke round chip), so it speaks the
    // same tactile language by hand: press-thock + quick sink on touch, springy overshoot rise on
    // a release that slides off. (A committed release destroys the chip via overlaySettle, so the
    // sink simply vanishes with it.) Reduced motion keeps the instant chip — no sink/rise tweens.
    if (animate) {
      const close = this.add.container(w / 2 - 40, -halfH + 40)
      const cg = this.add.graphics()
      cg.fillStyle(T.rose, 1)
      cg.fillCircle(0, 0, 22)
      cg.lineStyle(3, T.roseDeep, 1)
      cg.strokeCircle(0, 0, 22)
      const cIcon = this.add.text(0, 0, '»', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.onRose }).setOrigin(0.5)
      // Invisible hit circle grown to the ≥44pt floor (§E8) — the visual chip (r22) is unchanged.
      const cZone = this.add.circle(0, 0, 42, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
      cZone.on('pointerdown', () => {
        sfx.uiPress()
        if (this.reducedMotion) return
        this.tweens.killTweensOf(close)
        this.tweens.add({ targets: close, scale: 0.88, duration: 60, ease: E.press })
      })
      cZone.on('pointerout', () => {
        if (this.reducedMotion || !close.active) return
        this.tweens.killTweensOf(close)
        this.tweens.add({ targets: close, scale: 1, duration: D.settle, ease: backOut(OVERSHOOT.release) })
      })
      cZone.on('pointerup', () => this.overlaySettle?.())
      close.add([cg, cIcon, cZone])
      card.add(close)
      settleActions.push(() => {
        this.tweens.killTweensOf(close) // 3.90 doesn't sweep tweens on destroy — kill the sink/rise first
        close.destroy()
      })
    }

    // One light sweep across the settled card — a specular streak glides over the panel (masked to
    // the card's exact rounded rect, so light travels over the glass and never smears the scene),
    // timed to land just after the star dings. The same "release shine" language as the pressables,
    // scaled up to the hero surface. Self-destroying; a mid-sweep tap-to-skip kills it via
    // settleActions. Gated off under reduced motion and on the LOW tier.
    if (animate && !this.reducedMotion && quality.tier() !== 'low') {
      at(560, () => {
        const mg = this.make.graphics({ x: 0, y: 0 }, false)
        mg.fillStyle(0xffffff, 1)
        mg.fillRoundedRect(cx - w / 2, cy - halfH, w, halfH * 2, 34)
        const shine = this.add
          .image(cx - w / 2 - 90, cy - halfH * 0.3, 'sweep')
          .setDisplaySize(150, halfH * 2.6)
          .setAngle(12)
          .setAlpha(0.38)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setDepth(42)
          .setMask(mg.createGeometryMask())
        const cleanup = (): void => {
          shine.clearMask(true)
          shine.destroy()
          mg.destroy()
        }
        this.tweens.add({ targets: shine, x: cx + w / 2 + 90, duration: 520, ease: E.glide, onComplete: cleanup })
        settleActions.push(() => {
          if (!shine.active) return
          this.tweens.killTweensOf(shine)
          cleanup()
        })
      })
    }

    // Entrance + settle wiring.
    if (animate) {
      card.setScale(0)
      const entrance = this.tweens.add({ targets: card, scale: 1, duration: 320, ease: 'Back.easeOut' })
      settleActions.push(() => {
        entrance.stop()
        card.setScale(1)
      })
      this.overlaySettle = () => {
        for (const t of settleTimers) t.remove(false)
        for (const a of settleActions) a()
        this.overlaySettle = null
      }
    }
  }

  /**
   * The coin payout: a chip pile on a soft gold disc with a counter that rolls 0→chipReward in
   * navy numerals. When animating, ~12 chips fly in from the edges/star row and land on the pile
   * as the counter rolls (scored by sfx.coinCount). Built relative to the card container.
   */
  private buildCoinPayout(
    card: Phaser.GameObjects.Container,
    chipReward: number,
    animate: boolean,
    at: (ms: number, cb: () => void) => void,
    settleActions: Array<() => void>
  ): void {
    const T = getTheme()
    const py = 74
    const pileX = -96

    // Soft gold disc behind the pile.
    card.add(this.add.image(pileX, py, 'bgglow').setTint(T.goldBezel).setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(150, 150).setAlpha(0.5))

    // The resting pile (4–5 chips, slightly fanned).
    const pileOffsets: Array<[number, number]> = [
      [-16, 8],
      [14, 6],
      [-6, -4],
      [8, -12],
      [0, 0],
    ]
    const pileChips = pileOffsets.map(([dx, dy]) => {
      const chip = this.add.image(pileX + dx, py + dy, 'chip').setDisplaySize(46, 46)
      card.add(chip)
      if (animate) chip.setScale(0)
      return chip
    })
    const popPile = (idx: number): void => {
      const chip = pileChips[idx % pileChips.length]
      chip.setScale(46 / 48)
      this.tweens.add({ targets: chip, scale: (46 / 48) * 1.18, duration: 110, yoyo: true, ease: 'Quad.easeOut' })
    }
    settleActions.push(() => pileChips.forEach(c => c.setScale(46 / 48)))

    // Reward label + rolling counter (navy on cream — legible under the celebration).
    card.add(this.add.text(58, py - 34, 'REWARD', { fontFamily: FONT, fontSize: '18px', color: T.inkMuted }).setOrigin(0, 0.5).setLetterSpacing(2))
    const counter = this.add
      .text(58, py + 8, animate ? '0' : String(chipReward), { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: T.navyText })
      .setOrigin(0, 0.5)
    card.add(counter)
    settleActions.push(() => counter.setText(String(chipReward)))

    if (!animate) {
      pileChips.forEach(c => c.setScale(46 / 48))
      this.chipHud?.update(this.chipBanked) // snap the HUD balance to the banked total (no fly-in)
      return
    }
    // A skip mid-roll still lands the balance on the HUD pill.
    settleActions.push(() => this.chipHud?.update(this.chipBanked))

    // Flying chips arc in from the edges/star row and land on the pile, popping it.
    const flyCount = 12
    for (let i = 0; i < flyCount; i++) {
      const fromX = (Math.random() * 2 - 1) * 230
      const fromY = -150 - Math.random() * 40
      const chip = this.add.image(fromX, fromY, 'chip').setDisplaySize(40, 40).setScale(0)
      card.add(chip)
      const delay = 360 + i * 40
      at(delay, () => {
        this.tweens.add({ targets: chip, scale: 40 / 48, duration: 120, ease: 'Quad.easeOut' })
        this.tweens.add({
          targets: chip,
          x: pileX + (Math.random() * 2 - 1) * 14,
          y: py + (Math.random() * 2 - 1) * 10,
          duration: 500 + Math.random() * 180,
          ease: 'Cubic.easeOut',
          onComplete: () => {
            popPile(i)
            chip.destroy()
          },
        })
      })
      settleActions.push(() => chip.destroy())
    }

    // Counter roll-up, scored by the coin tally, with a final haptic tick.
    at(440, () => {
      sfx.coinCount()
      const c = { v: 0 }
      const roll = this.tweens.add({
        targets: c,
        v: chipReward,
        duration: 780,
        ease: 'Cubic.easeOut',
        onUpdate: () => counter.setText(String(Math.round(c.v))),
        onComplete: () => {
          counter.setText(String(chipReward))
          this.vibrate(30)
          // The reward leaps from the pile up to the HUD balance pill, bumping its count.
          const flyer = this.spawnHudFlyChip(card.x + pileX, card.y + py)
          if (flyer) settleActions.push(() => flyer.destroy())
        },
      })
      settleActions.push(() => {
        roll.stop()
        counter.setText(String(chipReward))
      })
    })
  }

  /** Beat 4 tail: a chip flies from the win-card pile to the HUD balance pill, then bumps it. */
  private spawnHudFlyChip(fromX: number, fromY: number): Phaser.GameObjects.Image | undefined {
    if (!this.chipHud) return undefined
    const target = this.chipHud.container
    const chip = this.add.image(fromX, fromY, 'chip').setDisplaySize(46, 46).setDepth(52)
    this.tweens.add({
      targets: chip,
      x: target.x,
      y: target.y,
      scaleX: chip.scaleX * 0.62,
      scaleY: chip.scaleY * 0.62,
      duration: 520,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        if (chip.active) chip.destroy()
        this.chipHud?.update(this.chipBanked)
      },
    })
    return chip
  }

  /**
   * End-of-run card for the endless race — a score attack, no stars.
   *
   * Reads bottom-up as the two things a run now feeds: TODAY'S BEST (the board you were just racing,
   * which closes at midnight Mountain time) and THIS WEEK (that best summed with every other day's, plus the
   * turnout behind it). The week line is the whole reason the daily board exists, so it is on the
   * card rather than a screen away — the run that just ended visibly moved a season total, and a
   * player who has raced 2 of 7 days can see what the other five are worth.
   */
  private showEndlessOverlay(
    score: number,
    best: number,
    isRecord: boolean,
    week: WeekStanding,
    /** What a CHEAT run put on the board, or null on an ordinary run (which posts its score as-is). */
    posted: number | null = null
  ): void {
    this.log('showEndlessOverlay', 'score', score, 'best', best, 'isRecord', isRecord, 'week', week.total, week.days)
    this.overlayScrim()
    const cx = DESIGN_W / 2
    const cy = 590
    if (isRecord) {
      sfx.winFanfare()
      sfx.jackpotStrike()
      this.vibrate([60, 40, 120])
      this.overlayHearts(cx, 28)
    } else {
      // "Time's up" is a finish line, not a failure — a gentle close, no lose-wah.
      sfx.starDing(0)
    }
    // A cheat run wedges one extra line into the middle of the card, so the season block and the
    // buttons below it slide down by `drop`, and the card grows DOWNWARD by the same amount (centre
    // and half-height both +drop/2 → the top edge does not move). Everything above the note is
    // untouched, so an ordinary card is pixel-for-pixel the card that has always shipped.
    const drop = posted === null ? 0 : 30
    this.overlayCard(cx, cy + drop / 2, 262 + drop / 2)

    this.add
      .text(cx, cy - 190, isRecord ? 'NEW BEST!' : "TIME'S UP", {
        fontFamily: FONT,
        fontSize: '48px',
        fontStyle: '900',
        color: isRecord ? getTheme().goldText : getTheme().navyText,
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 3, 'rgba(0,0,0,0.15)', 6, false, true)

    this.add
      .text(cx, cy - 126, 'YOUR SCORE', { fontFamily: FONT, fontSize: '20px', color: getTheme().inkMuted })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(2)
    this.add
      .text(cx, cy - 78, score.toLocaleString(), {
        fontFamily: FONT,
        fontSize: '58px',
        fontStyle: '900',
        color: getTheme().ink,
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)

    this.add
      .text(cx, cy - 4, "TODAY'S BEST", { fontFamily: FONT, fontSize: '20px', color: getTheme().inkMuted })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(2)
    this.add
      .text(cx, cy + 34, best.toLocaleString(), {
        fontFamily: FONT,
        fontSize: '34px',
        fontStyle: '900',
        color: getTheme().goldText,
      })
      .setOrigin(0.5)
      .setDepth(42)

    // A cheat run says what it actually put on the board, as a CAPTION on the best above it — close
    // under that number, at arm's length from the season block below. Without it the card is an
    // unreadable scoreboard after a mega win (a six-figure score over a best that barely moved), and
    // this line is the only place the player is told their run went up capped. When the run came in
    // under the ceiling nothing was clamped, so it says so plainly instead of naming a cap.
    if (posted !== null) {
      this.add
        .text(cx, cy + 68, posted < score ? `CHEAT RUN  ·  CAPPED TO ${posted.toLocaleString()}` : 'CHEAT RUN', {
          fontFamily: FONT,
          fontSize: '16px',
          fontStyle: '900',
          color: css(getTheme().rose),
        })
        .setOrigin(0.5)
        .setDepth(42)
        .setLetterSpacing(1)
    }

    // The season line. `days of DAYS_PER_WEEK` is the nudge: it names the boards still on the table
    // this week without ever scolding a player for the ones they missed.
    this.add
      .text(cx, cy + 84 + drop, `THIS WEEK  ·  ${week.total.toLocaleString()}`, {
        fontFamily: FONT,
        fontSize: '22px',
        fontStyle: '900',
        color: getTheme().inkSoft,
      })
      .setOrigin(0.5)
      .setDepth(42)
      .setLetterSpacing(1)
    this.add
      .text(cx, cy + 116 + drop, `${week.days} of ${DAYS_PER_WEEK} boards raced`, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '19px',
        color: getTheme().inkFaint,
      })
      .setOrigin(0.5)
      .setDepth(42)

    addPillButton(this, cx, cy + 176 + drop, 300, 72, 'PLAY AGAIN', ROSE_PILL, () =>
      startScene(this,'game', { endless: true })
    ).setDepth(42)
    addPillButton(this, cx, cy + 176 + 80 + drop, 300, 60, 'LEVELS', GHOST_PILL, () =>
      startScene(this,'levelselect')
    ).setDepth(42)
  }

  // -------------------------------------------------------------- scoring

  private addScore(points: number): void {
    const gain = points * this.scoreMult
    // §E3/B14: a tiny key-locked tick partners a CHUNKY climb (the in-game readout roll is otherwise
    // silent — the win-card coin roll-up already has coinCount, so we don't double up there). ≥120
    // mirrors scorePunch's chunky threshold, but audio fires in both motion modes.
    if (gain >= 120) sfx.scoreTick()
    this.score += gain
    this.scoreTween?.stop()
    const counter = { v: this.shownScore }
    this.scoreTween = this.tweens.add({
      targets: counter,
      v: this.score,
      duration: 380,
      ease: 'Cubic.easeOut',
      onUpdate: () => {
        this.shownScore = Math.round(counter.v)
        this.scoreText.setText(this.shownScore.toLocaleString())
      },
    })
    // W3: crossing a round milestone (10k/25k/50k…) gets its OWN gold pop — richer than the per-gain
    // scorePunch and mutually exclusive with it, so the two never fight over the readout the same frame.
    // The pointer always advances on a crossing (skipping any it leaps past); the pop is held during play.
    if (this.score >= this.scoreMilestone) {
      const crossed = this.scoreMilestone
      this.scoreMilestone = this.nextScoreMilestone(this.score)
      if (this.state !== 'ended') this.scoreMilestonePop(crossed)
    } else {
      this.scorePunch(gain)
    }
  }

  /**
   * 3c: a scale punch + brief gold tint flash on the SCORE read-out for chunky gains (≥120 pts).
   * Only during a resolve (mutually exclusive with the idle nudge, and skips the finishWin bonus,
   * which runs in 'ended'). Reduced-motion: instant (no punch — the counter still rolls).
   */
  private scorePunch(gain: number): void {
    if (this.reducedMotion || gain < 120 || this.state !== 'resolving' || !this.scoreText) return
    this.scoreText.setColor(css(getTheme().gold))
    this.time.delayedCall(180, () => this.scoreText?.setColor(getTheme().onBackdropInk))
    this.scorePunchTween?.stop()
    this.scoreText.setScale(1)
    this.scorePunchTween = this.tweens.add({
      targets: this.scoreText,
      scale: 1.15,
      duration: 120,
      yoyo: true,
      ease: 'Quad.easeOut',
    })
  }

  /** W3: the smallest 1 / 2.5 / 5 ×10ⁿ milestone strictly above `v` (…10k, 25k, 50k, 100k, 250k, 500k…). */
  private nextScoreMilestone(v: number): number {
    for (let exp = 4; exp < 15; exp++) {
      for (const mant of [1, 2.5, 5]) {
        const m = mant * Math.pow(10, exp)
        if (m > v) return m
      }
    }
    return Math.pow(10, 15) // unreachable for any real score
  }

  /**
   * W3 score-milestone pop: a one-off gold flash + tick + scale kick on the HUD readout when the rolling
   * score crosses a round threshold — a bigger, rarer sibling of scorePunch. Reduced motion → the colour
   * flash + tick only (no scale, no glow); the extra bright glow rides the reduce-flashing gate, and the
   * glow is `quality.count()`-gated. The threshold is passed for future copy but the pop is generic.
   */
  private scoreMilestonePop(_threshold: number): void {
    if (!this.scoreText) return
    const T = getTheme()
    sfx.scoreTick() // reuse the score tick — audio fires in both motion modes
    this.scoreText.setColor(css(T.gold))
    this.time.delayedCall(260, () => this.scoreText?.setColor(getTheme().onBackdropInk))
    if (this.reducedMotion) return
    // Scale kick — a notch beyond scorePunch's 1.15.
    this.scorePunchTween?.stop()
    this.scoreText.setScale(1)
    this.scorePunchTween = this.tweens.add({
      targets: this.scoreText,
      scale: 1.3,
      duration: 160,
      yoyo: true,
      ease: 'Back.easeOut',
    })
    // A brief gold flare over the readout — an extra flash, so it rides the reduce-flashing gate.
    if (!this.reduceFlashing && quality.count(1) > 0) {
      const flare = this.add
        .image(this.scoreText.x - this.scoreText.width / 2, this.scoreText.y + this.scoreText.height / 2, 'bgglow')
        .setTint(T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(5)
        .setDisplaySize(200, 90)
        .setAlpha(0)
      this.tweens.add({
        targets: flare,
        alpha: { from: 0.5, to: 0 },
        scaleX: flare.scaleX * 1.5,
        scaleY: flare.scaleY * 1.5,
        duration: 420,
        ease: 'Quad.easeOut',
        onComplete: () => flare.destroy(),
      })
    }
  }

  /**
   * E11 continuous combo counter: ONE reused readout over the board — not a fresh text per wave. Each
   * new cascade wave PUNCHES it in place (scale pop) and HEAT-RAMPS it warm→hot (x2 warm gold → x3 hot
   * amber → x4+ hot rose/red), with a subtle per-wave scale ramp so a deep chain reads as one rising
   * crescendo that resolves into the win fanfare (see fadeCombo, called when the cascade settles). At
   * x4+ it fires the MEGA peak (jackpot strike + haptic + marquee flash), matching the prior behaviour.
   * Reduced motion keeps the counter + number but drops the punch + colour-pulse (static set).
   */
  private showCombo(cascade: number): void {
    const tier = this.megaTier(cascade)
    const big = tier.t > 0
    // MEGA peak fires on each new TIER reached (x4 MEGA / x6 SUPER / x8 UNREAL), not every wave — a
    // strike that PUNCTUATES the escalation reads far bigger than the same wail becoming wallpaper.
    if (big && tier.t > this.comboPeakTier) {
      this.comboPeakTier = tier.t
      sfx.jackpotStrike()
      this.vibrate(tier.t >= 3 ? [70, 40, 90, 40, 160] : tier.t >= 2 ? [60, 40, 140] : [60, 40, 120])
      this.flashCabinet(tier.t) // pop the marquee harder the deeper the tier
    }
    // §E3/E11/B14: a low bass bed ratchets UP a step per cascade wave and resolves into winFanfare —
    // the audio arc mirrors the visual combo arc. ONE voice, retriggered per wave (never accumulates).
    // Reduced motion drops this sustained riser (E11), matching its dropped colour-pulse.
    if (!this.reducedMotion) sfx.cascadeRiser(cascade)
    // Screen-edge heat tick — the room registers each wave of the chain (self-gated: reduced
    // motion / LOW tier skip it; reduce-flashing softens the pulse into a swell).
    this.cascadeEdgeTick(cascade)
    // The readout keeps CLIMBING every wave — the ×N is the compounding number, the tier renames it
    // MEGA WIN → SUPER MEGA → UNREAL, and the heat + scale keep growing past the old x4 plateau.
    const label = big ? (cascade > 4 ? `${tier.name} ×${cascade}` : tier.name) : `COMBO ×${cascade}`
    // Heat ramp: x2 gold → x3 amber → x4 rose → x6 hot rose → x8 near-white.
    const heat =
      cascade <= 2
        ? getTheme().goldText
        : cascade === 3
          ? css(getTheme().gold)
          : tier.t >= 3
            ? '#fff0f4'
            : tier.t >= 2
              ? css(getTheme().roseLight)
              : css(getTheme().rose)
    const cy = this.boardTop + BOARD_W / 2 - 40
    if (!this.comboText || !this.comboText.active) {
      this.comboText = this.add
        .text(DESIGN_W / 2, cy, label, { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: heat })
        .setOrigin(0.5)
        .setDepth(30)
        .setStroke('#ffffff', 8)
        .setShadow(0, 4, 'rgba(0,0,0,0.2)', 8, true, true)
    }
    const t = this.comboText
    this.comboTween?.stop() // cancel a live punch/fade so waves never stack scale/alpha
    this.comboTween = null
    t.setText(label).setColor(heat).setPosition(DESIGN_W / 2, cy).setAlpha(1)
    // Resting size grows with the chain — the visual crescendo — mega tiers pushing past the old 1.5
    // cap up to ~1.85. Then CLAMP so even the punch peak of a long label ("SUPER MEGA! ×6") never
    // overruns the screen: the medallion's fit trick — cap scale to the width the punch can afford.
    const PUNCH = 1.28
    const want = big ? Math.min(1.85, 1.24 + tier.t * 0.2) : Math.min(1.5, 0.9 + cascade * 0.1)
    const base = Math.min(want, (DESIGN_W - 44) / (PUNCH * Math.max(1, t.width)))
    if (this.reducedMotion) {
      t.setScale(base) // static: number + heat colour, no punch/pulse
      return
    }
    // Punch in place: reset to rest, then a quick scale pop (killed + restarted per wave so no stacking).
    t.setScale(base)
    this.comboTween = this.tweens.add({
      targets: t,
      scale: base * PUNCH,
      duration: 150,
      yoyo: true,
      ease: 'Quad.easeOut',
    })
  }

  /**
   * E11: resolve the combo counter once the cascade settles — a soft fade-up-out of the ONE reused
   * object (not destroyed; the next cascade re-shows it). No-op if nothing showed this resolve.
   * Reduced motion: a brief hold, then an instant hide.
   */
  private fadeCombo(): void {
    sfx.riserResolve() // §E11: the cascade settled — resolve the riser (fades into winFanfare on a win)
    const t = this.comboText
    if (!t || !t.active || t.alpha === 0) return
    this.comboTween?.stop()
    this.comboTween = null
    if (this.reducedMotion) {
      this.time.delayedCall(220, () => t.active && t.setAlpha(0))
      return
    }
    this.comboTween = this.tweens.add({
      targets: t,
      alpha: 0,
      y: t.y - 60,
      delay: 200,
      duration: 420,
      ease: 'Sine.easeIn',
    })
  }

  /**
   * MEGA tiers past the x4 threshold — the escalation the eye reads as "it keeps going". Each deeper
   * band renames the readout (MEGA WIN → SUPER MEGA → UNREAL), and its `t` (1..3) drives the heat
   * colour, scale, strike intensity, and finish size everywhere, so every layer speaks one tier.
   * `t` is 0 below x4 (an ordinary combo, not a mega).
   */
  private megaTier(cascade: number): { t: number; name: string } {
    if (cascade >= 8) return { t: 3, name: 'UNREAL!' }
    if (cascade >= 6) return { t: 2, name: 'SUPER MEGA!' }
    if (cascade >= 4) return { t: 1, name: 'MEGA WIN!' }
    return { t: 0, name: '' }
  }

  /**
   * MEGA FINISH — the "leave you in awe" release. Where the per-wave combo beats BUILD, this one beat
   * fires once as a deep chain SETTLES (called from resolveLoop): the screen erupts a final time —
   * a low boom, a gold shockwave ring blowing out from board centre, a punchy zoom-kiss, a trauma
   * thump, and the biggest marquee re-strike — all sized by the settled depth (tier 1..3). Below x4
   * it no-ops. Fully a11y-gated: reduced motion keeps only the boom + a single static gold bloom
   * (a transient's resting state is nothing); reduce-flashing softens the bright pop into a swell;
   * LOW tier drops the fill-rate shockwave. Every object is transient and self-destroys.
   */
  private megaFinish(cascade: number): void {
    const tier = this.megaTier(cascade).t
    if (tier <= 0) return
    const T = getTheme()
    const cx = BOARD_X + BOARD_W / 2
    const cy = this.boardTop + BOARD_W / 2
    sfx.megaBoom(tier) // the visceral low thump — audio is never motion-gated (§E8)
    this.flashCabinet(1 + tier) // one more, biggest re-strike as the chain lands
    stageFlare() // the room's celebratory swell under the shockwave ring
    if (this.reducedMotion) {
      // Keep only a single soft gold bloom that fades (mirrors the reduced-motion heartbloom) — no
      // expand / zoom / shake. The rolling score + settled board already carry the information.
      const bloom = this.add
        .image(cx, cy, 'bgglow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(T.goldBright)
        .setDepth(28)
        .setDisplaySize(CELL * 3, CELL * 3)
        .setAlpha(0)
      this.tweens.add({ targets: bloom, alpha: 0.4, duration: 200, yoyo: true, hold: 120, onComplete: () => bloom.destroy() })
      return
    }
    // Trauma thump routed through the single authority (composes with the last wave's decay, never
    // a second shake system) + a punchier zoom-kiss than a per-wave breath.
    this.addTrauma(Math.min(0.75, 0.34 + tier * 0.13))
    this.megaZoom(0.02 + tier * 0.012)
    if (quality.tier() === 'low') return // the ring/bloom are an optional fill-rate layer
    const soft = this.reduceFlashing
    // A gold shockwave ring blowing outward from board centre — the awe layer.
    const ring = this.add
      .image(cx, cy, 'shockwave')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.goldBright)
      .setDepth(28)
      .setDisplaySize(CELL, CELL)
      .setAlpha(soft ? 0.4 : 0.85)
    const span = CELL * (9 + tier * 2)
    this.tweens.add({
      targets: ring,
      displayWidth: span,
      displayHeight: span,
      alpha: 0,
      duration: soft ? 640 : 480,
      ease: 'Cubic.easeOut',
      onComplete: () => ring.destroy(),
    })
    // A hot central bloom pulsing under the ring.
    const bloom = this.add
      .image(cx, cy, 'bgglow')
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.gold)
      .setDepth(27)
      .setDisplaySize(CELL * 2.4, CELL * 2.4)
      .setAlpha(0)
    this.tweens.add({
      targets: bloom,
      alpha: (soft ? 0.4 : 0.7) * quality.scale(),
      scale: bloom.scale * 1.8,
      duration: soft ? 560 : 360,
      yoyo: true,
      ease: E.press,
      onComplete: () => bloom.destroy(),
    })
    // A gold spark bloom from the centre (budgeted per device; skipped when flashing is reduced).
    if (!soft && quality.count(1) > 0) this.sparkEmitter.explode(quality.count(10 + tier * 6), cx, cy)
  }

  /**
   * The MEGA-finish zoom-kiss: a punchier one-beat inhale than the per-wave cameraBreath. Reuses the
   * SAME cameraBreathTween slot (stopping any live breath first) so zoom is never driven by two
   * tweens at once, and rests back at 1. Reduced motion / LOW tier → no-op.
   */
  private megaZoom(amount: number): void {
    if (this.reducedMotion || quality.tier() === 'low') return
    this.cameraBreathTween?.stop()
    const cam = this.cameras.main
    cam.setZoom(1)
    this.cameraBreathTween = this.tweens.add({
      targets: cam,
      zoom: 1 + amount,
      duration: D.base,
      ease: E.press,
      yoyo: true,
      hold: 70,
      onComplete: () => {
        cam.setZoom(1)
        this.cameraBreathTween = null
      },
    })
  }

  // --------------------------------------------------------------- helpers

  /**
   * §R3 score medallion — the constant micro-reward: a chunky star-burst coin stamped "+N" minted
   * at the match centroid, popping in on an eager overshoot, floating up ~40px and fading. One per
   * wave; escalates with the cascade — wave 1 mints a small warm-gold coin, deeper waves mint
   * bigger + brighter, rose-tinged at the MEGA peak (the medallion TINT is the accent there: the
   * screen-level MEGA pulse is owned by cascadeEdgeTick, so nothing double-pulses) — and waves 3+
   * add a tiny spark ring. Pooled with a HARD CAP (a mint past the cap recycles the oldest in
   * flight), spark accents governor-scaled. Reduced motion → skip entirely: a transient's resting
   * state is nothing, and the rolling score readout already carries the information.
   */
  private spawnScorePopup(points: number, x: number, y: number, cascade: number): void {
    if (points <= 0 || this.reducedMotion) return
    const T = getTheme()
    const mega = cascade >= 4
    // Heat ramp mirrors showCombo: warm gold → bright gold → rose-tinged at MEGA.
    const tint = mega ? T.roseLight : cascade >= 2 ? T.goldBright : T.gold
    const size = Math.min(1.3, 0.78 + cascade * 0.13) // wave 1 small → deep waves chunky (capped)
    const slot = this.takeMedallion()
    slot.badge.setTint(tint)
    slot.label.setText(`+${points.toLocaleString()}`)
    slot.label.setScale(Math.min(1, 56 / Math.max(1, slot.label.width))) // long totals stay on the coin face
    slot.root.setPosition(x, y).setAlpha(1).setScale(0).setAngle(Phaser.Math.Between(-7, 7)).setVisible(true)
    // Beat 1 — MINT: eager overshoot pop-in, straightening as it lands.
    this.tweens.add({ targets: slot.root, scale: size, angle: 0, duration: D.base, ease: backOut(OVERSHOOT.pop) })
    // Beat 2 — DRIFT: hold a breath, then float up and fade; the slot frees itself on completion.
    this.tweens.add({
      targets: slot.root,
      y: y - 40,
      alpha: 0,
      delay: 300,
      duration: 430,
      ease: E.exit,
      onComplete: () => {
        slot.root.setVisible(false)
        slot.live = false
      },
    })
    // Wave 3+ accent: a tiny expanding spark ring + a few motes — governor-scaled, self-destroying.
    if (cascade >= 3 && quality.count(1) > 0) {
      const ring = this.add
        .image(x, y, 'shockwave')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(27)
        .setTint(tint)
        .setDisplaySize(CELL * 0.5, CELL * 0.5)
        .setAlpha(0.75 * quality.scale())
      this.tweens.add({
        targets: ring,
        alpha: 0,
        scaleX: ring.scaleX * 2.6,
        scaleY: ring.scaleY * 2.6,
        duration: D.pop,
        ease: E.press,
        onComplete: () => ring.destroy(),
      })
      this.sparkEmitter.explode(quality.count(mega ? 8 : 5), x, y)
    }
  }

  /**
   * §R3: check a medallion slot out of the pool — a free slot if one exists, a NEW slot while under
   * the hard cap, else the OLDEST live one recycled (tweens killed before reuse; Phaser 3.90 never
   * sweeps tweens for retargeted objects). Slots live for the whole round and die with the scene.
   */
  private takeMedallion(): MedallionSlot {
    let slot = this.medallionPool.find(s => !s.live)
    if (!slot && this.medallionPool.length < MEDALLION_CAP) {
      const T = getTheme()
      const badge = this.add.image(0, 0, 'medallion').setDisplaySize(CELL * 1.2, CELL * 1.2)
      const label = this.add
        .text(0, 0, '', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: css(T.cardFill) })
        .setOrigin(0.5)
        .setStroke(T.navyText, 5)
      const root = this.add.container(0, 0, [badge, label]).setDepth(28).setVisible(false)
      slot = { root, badge, label, live: false, born: 0 }
      this.medallionPool.push(slot)
    }
    if (!slot) {
      slot = this.medallionPool.reduce((a, b) => (a.born <= b.born ? a : b))
      this.tweens.killTweensOf(slot.root)
    }
    slot.live = true
    slot.born = ++this.medallionSeq
    return slot
  }

  // ------------------------------------------------- R4 · MEGA WIN → FREE SPINS

  /**
   * R4 — a MEGA-grade cascade chain on a NUMBERED level banks bonus wheel pulls (core/daily.ts
   * FREE_SPIN_AWARDS: x4+ → 3, x6+ → 6). Called once per resolve, with the settled chain depth, so a
   * chain that runs 4→6 deep awards its FINAL tier exactly once. Banking is cap-aware
   * (save.addFreeSpins clamps to the daily earn cap + the bank cap and reports what stuck), and the
   * ticket celebration is sized by what was ACTUALLY granted — a capped-out player is never lied to.
   * Endless is excluded by contract (its loop has no daily-economy hooks).
   */
  private maybeAwardFreeSpins(cascade: number): void {
    if (this.endless) return
    const spins = awardFreeSpinsFor(cascade)
    if (spins <= 0) return
    const granted = addFreeSpins(spins, todayKey())
    if (granted <= 0) return
    this.freeSpinTicket(granted)
  }

  // ------------------------------------------------- Plinko bonus drop

  /**
   * A settled chain may buy a Plinko drop. Returns TRUE when the overlay opened — the caller must
   * then stop, because the overlay owns handing the board back (its CLAIM restores idle).
   *
   * Three gates keep this a treat rather than a routine interruption: the chain must reach the
   * mode's bar (x5 on a numbered level — measured, because the x4 MEGA bar lands ~1×/level even
   * played passively and would have fired in most levels), it must win the mode's roll, and only one
   * drop is offered per level. Numbered levels land at ~1 in 7 passive, ~1 in 5 played well.
   *
   * ENDLESS passes its own flag and gets its own, more generous pair (x4, always) — it has no
   * hazards and only 30 moves, so the numbered-level constants halved the rate on the one mode
   * scored purely on points. An UNREAL x8 chain skips the roll in both modes. The per-run latch is
   * unchanged, so endless still shows at most one drop per run. See core/plinko.rate.test.ts, which
   * guards BOTH modes and fails if a curve change ever makes either routine or extinct.
   *
   * The board stays in 'resolving' for the overlay's whole life, so input is already gated; the
   * overlay's interactive scrim is the second layer. Wrapped in try/catch because resolveLoop is
   * reached from a fire-and-forget `void this.trySwap` — a throw here without a recovery would wedge
   * the board in 'resolving' forever (UI_COOKBOOK §11).
   */
  private offerPlinko(cascade: number, force = false): boolean {
    // A MEGA WIN buys its own drop outright (core/cheat.ts): both the once-per-run latch and the
    // qualification roll are bypassed, so a cheat run stacks one drop per mega win it fires instead
    // of the single drop a run is otherwise allowed. Consumed only once the offer really opens, so
    // a chain that somehow scored nothing leaves the owed drop for the next one.
    const forced = force || this.cheatDropPending
    if (this.plinkoUsedThisLevel && !forced) return false
    if (!forced && !shouldOfferPlinko(cascade, Math.random, this.endless)) return false
    const stake = this.chainPoints
    if (stake <= 0) return false
    this.cheatDropPending = false
    this.plinkoUsedThisLevel = true
    // The 2026-07-28 endless retune (5.4% → ~27% passive) was tuned entirely against a simulated
    // board — plinko.rate.test.ts guards the model, not reality. This is the first field measurement
    // of the offer rate, split by mode so the two tunings stay separately readable.
    track(EVENTS.PLINKO_OFFERED, { cascade, endless: this.endless, stake })
    try {
      this.disarmHint() // idle effects yield to the celebration
      this.disarmTwinkle()
      this.clearSelection()
      openPlinko(this, {
        chainPoints: stake,
        // Endless has no wheel to spend a spin on, and a player whose BANK is full can't be paid one —
        // either way the ticket slots leave the pool so the ball can't land on a prize we can't honour.
        //
        // 'plinko' room, not 'mega' room: the drop's own trigger chain (x5+) has just banked its MEGA
        // award through maybeAwardFreeSpins, so the daily allowance is routinely gone by the time we
        // ask — an x6+ chain spends all 6 of it on its own. Asking the daily cap here restruck both
        // SPIN wells as ×8 on essentially every numbered-level drop. See save.FreeSpinSource.
        allowTickets: !this.endless && freeSpinRoom(todayKey(), 'plinko') > 0,
        // Picks the WEIGHT table, not the ticket rule — endless rolls fatter ×10 edges because it is
        // the raced mode. Kept separate from allowTickets on purpose: a numbered-level player with a
        // full spin bank also has allowTickets false, and must not inherit the endless odds.
        endless: this.endless,
        hitstop: ms => this.hitstop(ms),
        onClaim: result => {
          if (result.kind === 'mult' && result.points > 0) {
            this.addScore(result.points) // the single multiplier chokepoint — composes with doubleScore
            const c = this.cellToXY({ row: ROWS >> 1, col: COLS >> 1 })
            this.spawnScorePopup(result.points, c.x, c.y, 4)
          } else if (result.spins > 0) {
            this.freeSpinTicket(result.spins) // reuse the existing golden-ticket beat
          }
          // The other half of the funnel, and the ONLY field check on the slot table. `plinko_played`
          // was in the vocabulary and charted on the dashboard from the start but never actually
          // fired, so "Offered → Dropped" read as a permanent 0% — which looks exactly like real
          // player abandonment. Fired here rather than at roll time, matching DEAL_WON: a drop the
          // player walks out of is genuinely not a drop they played.
          //
          // `endless` is the load-bearing prop. The two modes now roll DIFFERENT weight tables (6% vs
          // 8% on the ×10 edges), so a slot histogram pooled across both measures neither. The admin
          // RPC does not split on it yet — but props are jsonb and cost nothing to carry, and this is
          // the half that cannot be reconstructed later. `mult` is what makes the histogram readable
          // without a copy of the table; `payout` is points, which the ticket wells pay as 0.
          track(EVENTS.PLINKO_PLAYED, {
            slot: result.slot,
            mult: result.mult,
            payout: result.points,
            spins: result.spins,
            endless: this.endless,
          })
          this.handBackBoard()
        },
      })
      return true
    } catch (err) {
      this.log('offerPlinko ERROR', err)
      return false // fall through to the caller's normal idle handback
    }
  }

  /** Restore a playable idle — the tail of resolveLoop, shared with anything that borrows the board. */
  private handBackBoard(): void {
    if ((this.state as GameState) === 'ended') return
    this.state = 'idle'
    this.scheduleAutoplay()
    this.armHint()
  }

  /** A small golden-ticket face (gold slab + inner perforation rule + punched edge notches). */
  private drawTicketFace(g: Phaser.GameObjects.Graphics, w: number, h: number): void {
    const T = getTheme()
    const r = Math.min(14, h * 0.18)
    g.fillStyle(T.shadow, 0.28)
    g.fillRoundedRect(-w / 2 + 3, -h / 2 + 5, w, h, r)
    goldFace(g, -w / 2, -h / 2, w, h, T, r)
    // Inner perforation rule — the "tear here" dashed frame that makes it read TICKET, not pill.
    g.lineStyle(2, T.goldDeep, 0.85)
    g.strokeRoundedRect(-w / 2 + 7, -h / 2 + 7, w - 14, h - 14, r * 0.6)
    // Punched semicircle notches on the two ends (the classic raffle-ticket silhouette).
    g.fillStyle(T.goldDarkest, 0.4)
    g.fillCircle(-w / 2, 0, h * 0.14)
    g.fillCircle(w / 2, 0, h * 0.14)
  }

  /**
   * R4 — the lazy "FREE SPINS ×N" counter: a mini golden ticket + count that sits in the HUD rail,
   * where the flying ticket banks. Minted hidden on first need (the arriving ticket reveals it);
   * subsequent awards just pop + retally it. Depth 43 — above the win scrim, with the meters.
   *
   * Placement history — the top-right corner is NOT free, despite looking it:
   *   y=158 clipped the third objective chip; y=128 was then chosen for the "empty band under
   *   SCORE", but that band does not exist either. The score READOUT runs to y≈122 (a 4-digit score
   *   is ~110px wide, so it reaches left under the badge), the COLLECT tag ends at x≈550, and the
   *   chips start at y=144 — leaving a ~20px hole the 34px badge could not fit. Live result: the
   *   ticket sat on top of the score and butted into COLLECT.
   * So it now parks in the genuinely empty gap of the card rail, between the moves card and the
   * objective cluster (`freeSpinSpot`, measured where that geometry is known), vertically centred
   * with those cards so it reads as part of the same rail. The caption stacks ABOVE the ticket
   * rather than beside it — the sideways caption is what collided with COLLECT, and stacking keeps
   * the whole counter inside the ~92px the narrowest (3-objective) layout leaves.
   */
  private ensureFreeSpinBadge(): { root: Phaser.GameObjects.Container; label: Phaser.GameObjects.Text } {
    if (this.freeSpinBadge) return this.freeSpinBadge
    const T = getTheme()
    const spot = this.freeSpinSpot ?? { x: BOARD_X + BOARD_W - 56, y: 196 }
    const root = this.add.container(spot.x, spot.y).setDepth(43).setAlpha(0)
    const g = this.add.graphics()
    g.setY(9) // ticket sits below the caption; the pair stays optically centred on the container
    this.drawTicketFace(g, 68, 34)
    const label = this.add
      .text(0, 9, `×${loadSave().freeSpins}`, { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: css(T.goldDarkest) })
      .setOrigin(0.5)
    const spinCap = this.add
      .text(0, -18, 'FREE SPINS', { fontFamily: FONT, fontSize: '10px', fontStyle: '900', color: T.goldText })
      .setOrigin(0.5)
    root.add([g, label, spinCap])
    this.freeSpinBadge = { root, label }
    return this.freeSpinBadge
  }

  /**
   * R4 — the "+N FREE SPINS" golden ticket: punches OUT of the MEGA marquee flash (the cabinet
   * re-strikes as it lands), gives one showy twirl, then flies to the corner counter, which pops and
   * retallies. Deliberately a DIFFERENT object from the §R3 score medallions — bigger, ticket-shaped,
   * scene-local graphics (no new baked texture) — so the two reward layers never read as one. All
   * transient, tweens chained tip-to-tail, self-destroying. Reduced motion: the transient's resting
   * state is nothing — the corner counter simply appears retallied (the durable signal).
   */
  private freeSpinTicket(granted: number): void {
    const badge = this.ensureFreeSpinBadge()
    const bank = loadSave().freeSpins
    if (this.reducedMotion) {
      badge.label.setText(`×${bank}`)
      badge.root.setAlpha(1)
      return
    }
    const T = getTheme()
    const tx = DESIGN_W / 2
    const ty = this.boardTop + BOARD_W / 2 - 40 // the MEGA marquee readout's seat — the ticket bursts from it
    const tw = 320
    const th = 128
    const ticket = this.add.container(tx, ty).setDepth(45).setScale(0).setAngle(-8)
    const face = this.add.graphics()
    this.drawTicketFace(face, tw, th)
    const plus = this.add
      .text(0, -24, `+${granted}`, { fontFamily: FONT, fontSize: '52px', fontStyle: '900', color: css(T.goldDarkest) })
      .setOrigin(0.5)
    const capT = this.add
      .text(0, 26, 'FREE SPINS', { fontFamily: FONT, fontSize: '28px', fontStyle: '900', color: css(T.goldDarkest) })
      .setOrigin(0.5)
      .setLetterSpacing(4)
    ticket.add([face, plus, capT])
    // A soft gold aura behind the ticket so it pops off the (possibly busy) MEGA moment.
    const aura = this.add
      .image(tx, ty, 'bgglow')
      .setTint(T.goldBright)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(44)
      .setDisplaySize(tw * 1.9, th * 3)
      .setAlpha(0)
    this.flashCabinet() // the marquee re-strikes — the ticket visibly punches OUT of the MEGA flash
    sfx.starDing(1)
    this.vibrate(24)
    this.tweens.add({ targets: aura, alpha: 0.5, duration: 220, ease: E.press, yoyo: true, hold: 620, onComplete: () => aura.destroy() })
    this.tweens.chain({
      targets: ticket,
      tweens: [
        { scale: 1.06, angle: 3, duration: 300, ease: backOut(OVERSHOOT.pop) }, // punch out of the flash
        { angle: 363, duration: 460, ease: 'Cubic.easeInOut' }, // one showy twirl
        {
          x: badge.root.x,
          y: badge.root.y,
          scale: 0.24,
          angle: 703,
          delay: 170,
          duration: 480,
          ease: 'Cubic.easeIn',
          onStart: () => sfx.whoosh(0.4),
        },
      ],
      onComplete: () => {
        ticket.destroy(true)
        // Bank: the counter reveals/pops + retallies, with a landing spark pinch.
        badge.label.setText(`×${bank}`)
        badge.root.setAlpha(1).setScale(1)
        this.tweens.add({ targets: badge.root, scale: 1.3, duration: 130, yoyo: true, ease: E.press })
        this.sparkEmitter.explode(quality.count(8), badge.root.x, badge.root.y)
        sfx.scoreTick()
      },
    })
  }

  /** Kill the urgent-moves pulse and settle the number back to rest scale (called when a level ends). */
  private stopMovesPulse(): void {
    this.movesPulse?.stop()
    this.movesPulse = null
    this.movesText?.setScale(1)
  }

  private t(config: Record<string, unknown>): Promise<void> {
    return new Promise(resolve => {
      this.tweens.add({ ...config, onComplete: () => resolve() } as unknown as Phaser.Types.Tweens.TweenBuilderConfig)
    })
  }

  /** Board column → equal-power stereo pan (§A8): left column hears left, right hears right (softened 0.7). */
  private colPan(col: number): number {
    return COLS > 1 ? ((col / (COLS - 1)) * 2 - 1) * 0.7 : 0
  }

  /** Haptic buzz, guarded for browsers without the Vibration API + the a11y haptics-off switch (§E8). */
  private vibrate(pattern: number | number[]): void {
    if (hapticsOff()) return
    // §G5 — routed through view/haptics so iOS (no Web Vibration API at all) still gets something.
    vibratePattern(pattern)
  }
}

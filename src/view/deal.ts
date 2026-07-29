import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY, worldH } from '../config'
import type { CharmAward } from '../core/charms'
import { grantCharm } from '../core/charms'
import { todayKey } from '../core/daily'
import type { DealFace, DealFaceId, DealHand } from '../core/deal'
import { DEAL_CARDS, DEAL_MATCH, buildDeck, dealFaces, dealHand, matchAt, settleDeal } from '../core/deal'
import { mulberry32 } from '../core/rng'
import { addChips, addFreeSpins, addPendingBoost, freeSpinRoom, loadSave } from '../core/save'
import type { BoostType } from '../core/types'
import { backOut, E, OVERSHOOT } from './motion'
import { quality } from './quality'
import type { Theme } from './theme'
import { css, getTheme, getThemeId, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
import { ensureGlyphTexture } from './textures'
import { addPillButton, FONT, GOLD_PILL, goldFace } from './ui'
import { vibratePattern } from './haptics'

// ─────────────────────────────────────────────────────────────────────────────
// LUCKY DEAL — the card pick'em. One export for the host: openDeal().
//
// An in-scene overlay container (NOT a Scene), so it bursts over the live win card with no scene-swap
// and hands control straight back on CLAIM — the same shape as view/plinko.ts and view/jackpot.ts,
// built from the same shared toolkit (goldFace, theme tokens, motion eases, sfx cues, the baked
// chip/bulb/shockwave/glint textures) so it reads as native art and restyles across all four themes
// for free. Reduced-motion / reduce-flashing / quality-governor / haptics aware throughout.
//
// ── What is different about this one ─────────────────────────────────────────
// Every other prize surface in the build performs AT the player: the wheel spins, the ball drops, the
// reels land. This one waits for them. The whole screen does nothing at all until a finger picks a
// card, and it is the only reward in the game whose pace and order the player sets.
//
// That changes what the presentation has to do. A wheel has one moment and spends everything on it;
// the Deal has seven or eight small ones, so the choreography is built around the TURN rather than
// the payoff — the lift-and-flip, the pip, and above all the PAIR GLOW, which is what turns "another
// card" into "that is my second cherry". The payoff beat then has something to release.
//
// ── Honesty ──────────────────────────────────────────────────────────────────
// AWARD-FIRST (core/deal.ts): the winning face is rolled and the deck built before the cabinet is on
// screen, and the deck can only ever produce that face — so no reveal is chosen while the player
// watches. The prize is BANKED the instant the third card turns, before a single frame of the
// celebration, so quitting mid-payoff cannot lose it.
//
// And the round PROVES itself: on the match, every card the player never turned flips face-up. The
// count is right there — three of the winner, no more than two of anything else. A rigged-then-hidden
// deck would have no reason to show its hand, so showing it is the cheapest trust the game can buy.
// ─────────────────────────────────────────────────────────────────────────────

export interface DealResult {
  /** The face that matched. */
  face: DealFaceId
  /** Chips banked (headline + pips + fast bonus) — already persisted. */
  chips: number
  /** Free spins ACTUALLY banked under the caps (0 unless the BELL paid). */
  spins: number
  /** Boost queued for the next level, or null. */
  boost: BoostType | null
  /** What the HEART paid, or null — already persisted (core/charms.ts grantCharm). */
  charm: CharmAward | null
  /** Chip balance after banking, so the host can refresh its HUD without re-reading the save. */
  newTotal: number
  flips: number
  fast: boolean
}

export interface DealOpenOpts {
  /** Called once, on CLAIM, after the overlay has torn itself down. The host resumes here. */
  onClaim: (result: DealResult) => void
  /** Optional graded-freeze hook — GameScene passes its `hitstop` so the match rides one authority. */
  hitstop?: (ms: number) => void
}

// ── Layout ───────────────────────────────────────────────────────────────────
// Everything derives from the card size and the gap (cookbook §2b-iii), so the frame, the grid and
// the paytable cannot drift apart when a card size changes.

const COLS = 3
const ROWS = 3
const CARD_W = 152
const CARD_H = 180
const GAP = 14
const CARD_R = 14
const GRID_W = COLS * CARD_W + (COLS - 1) * GAP // 484
const GRID_H = ROWS * CARD_H + (ROWS - 1) * GAP // 568
const BEZEL = 18
const FRAME_W = GRID_W + BEZEL * 2 // 520
const FRAME_H = GRID_H + BEZEL * 2 // 604
const FRAME_R = 28

/** Design-space Y of the cabinet's centre — the container anchor, so it pops about its own middle. */
const BOARD_CY = 620

const TITLE_Y = 186
const SUB_Y = 236
const PAY_Y = 986 // paytable icon row
const PAY_LABEL_Y = PAY_Y + 42
/**
 * Where the prize plate lands — in the paytable's slot, NOT over the cabinet.
 *
 * The first draft centred it on the cabinet, which buried the middle row of cards under the one beat
 * that exists to show them: the whole point of flipping the unturned cards is that the finished table
 * can be counted (three of the winner, at most two of anything else), and a plate parked on top of it
 * takes that back. So the plate takes the paytable's place instead — the paytable has done its job by
 * then, and the nine cards stay readable behind the result all the way to CLAIM.
 */
const PRIZE_Y = 1010
const BUTTON_Y = 1160

/** Card centre (container-local) for grid index i. */
const cardX = (i: number): number => ((i % COLS) - (COLS - 1) / 2) * (CARD_W + GAP)
const cardY = (i: number): number => (Math.floor(i / COLS) - (ROWS - 1) / 2) * (CARD_H + GAP)

/** Radius clamped just UNDER half the smallest side — cookbook §2c; the "−1" is load-bearing. */
const safeR = (r: number, w: number, h: number): number => Math.max(1, Math.min(r, w / 2 - 1, h / 2 - 1))

/** Flip half-duration: the card squashes to nothing, swaps its art, and opens again. */
const FLIP_MS = 130

/**
 * Texture key for a card face's GLYPH. Six of the seven faces reuse the board's own symbol art, so a
 * CHERRY on a card is pixel-identical to a CHERRY on the board — the cheapest possible way to make
 * a bonus round feel like it belongs to the game that launched it. Only the HEART needs its own, and
 * `heartbig` is already baked at boot for the Home emblem.
 */
const glyphKey = (id: DealFaceId): string => (id === 'heart' ? 'heartbig' : id)

/** Short value shown under each face in the paytable strip. */
function payLabel(face: DealFace): string {
  switch (face.prize.kind) {
    case 'chips':
      return String(face.prize.chips)
    case 'spin':
      return 'SPIN'
    case 'boost':
      return 'BOOST'
    case 'charm':
      return 'CHARM'
  }
}

/**
 * Tone a face's plate is painted in — the value ladder, readable at a glance, in the same colour
 * language the plinko wells and the wheel wedges already use: cream for the cheap cards, gold as the
 * value climbs, NAVY for the SPIN (a different currency, not a bigger number), and ROSE for the two
 * richest. A player who has seen the wheel already knows what rose means here.
 */
function toneOf(face: DealFace, T: Theme): { plate: number; ink: string } {
  if (face.prize.kind === 'charm') return { plate: T.rose, ink: T.onRose }
  if (face.prize.kind === 'spin') return { plate: T.navy, ink: '#ffffff' }
  if (face.prize.kind === 'boost') return { plate: T.goldDeep, ink: css(T.goldBright) }
  if (face.prize.kind === 'chips' && face.prize.chips >= 100) return { plate: T.roseDeep, ink: '#ffffff' }
  if (face.prize.kind === 'chips' && face.prize.chips >= 60) return { plate: T.gold, ink: T.goldPillText }
  return { plate: T.cardFillWarm, ink: T.inkSoft }
}

/**
 * Bake the two card stocks ONCE per theme and share them across all nine cards (cookbook §1 — bake
 * once, tween forever). Nine Images on two textures batch to two draw calls; nine live Graphics would
 * not, and would re-tessellate every rounded corner on every open.
 *
 * Keyed by theme id because a theme switch repaints via `scene.restart()` and must not reuse the old
 * palette's stock. Idempotent, so re-opening the Deal is free.
 */
function ensureCardTextures(scene: Phaser.Scene, T: Theme): { back: string; face: string } {
  const back = `dealcard:back:${getThemeId()}`
  const face = `dealcard:face:${getThemeId()}`
  const r = safeR(CARD_R, CARD_W, CARD_H)
  if (!scene.textures.exists(back)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    // Seat + rose stock. The back is the ONLY deep-coloured surface on the screen, which is what makes
    // a face-down grid read as nine unopened things rather than nine blank panels.
    g.fillStyle(T.shadow, 0.25)
    g.fillRoundedRect(0, 4, CARD_W, CARD_H, r)
    g.fillStyle(T.roseDeep, 1)
    g.fillRoundedRect(0, 0, CARD_W, CARD_H, r)
    g.fillStyle(T.rose, 1)
    g.fillRoundedRect(3, 3, CARD_W - 6, CARD_H - 6, safeR(r - 2, CARD_W - 6, CARD_H - 6))
    // Diagonal weave, drawn corner to corner in BOTH directions and left to clip against the texture
    // bounds — `generateTexture` crops at CARD_W/CARD_H, so the lattice needs no mask and the gold
    // border below covers where it runs out at the edge (exactly how a real card back is printed).
    g.lineStyle(2, 0xffffff, 0.1)
    const step = 22
    for (let d = -CARD_H; d < CARD_W + CARD_H; d += step) {
      g.lineBetween(d, 0, d + CARD_H, CARD_H)
      g.lineBetween(d, CARD_H, d + CARD_H, 0)
    }
    // Gold border + a top gloss band, inset so it follows the corner curve (cookbook §2a).
    g.lineStyle(3, T.gold, 0.9)
    g.strokeRoundedRect(9, 9, CARD_W - 18, CARD_H - 18, safeR(r - 6, CARD_W - 18, CARD_H - 18))
    // Centre emblem — a raised gold diamond pip on a dark medallion. Without it the back is a bare
    // patterned rectangle; with it the grid reads unmistakably as NINE PLAYING CARDS at a glance,
    // which is the one thing this screen has to say before the player has turned anything.
    const mx = CARD_W / 2
    const my = CARD_H / 2
    const pip = (dx: number, dy: number, s: number): Array<{ x: number; y: number }> => [
      { x: mx + dx, y: my - 26 * s + dy },
      { x: mx + 19 * s + dx, y: my + dy },
      { x: mx + dx, y: my + 26 * s + dy },
      { x: mx - 19 * s + dx, y: my + dy },
    ]
    g.fillStyle(T.roseDeep, 0.85)
    g.fillCircle(mx, my, 38)
    g.lineStyle(2, T.gold, 0.5)
    g.strokeCircle(mx, my, 38)
    g.fillStyle(0x000000, 0.18)
    g.fillPoints(pip(0, 2.5, 1), true) // pressed seat under the pip
    g.fillStyle(T.goldDeep, 1)
    g.fillPoints(pip(0, 0, 1), true)
    g.fillStyle(T.goldBright, 1)
    g.fillPoints(pip(0, -1.5, 0.78), true) // top-lit crown, same key light as every other surface
    g.fillStyle(0xffffff, 0.1)
    g.fillRoundedRect(6, 4, CARD_W - 12, CARD_H * 0.34, safeR(r - 4, CARD_W - 12, CARD_H * 0.34))
    g.generateTexture(back, CARD_W, CARD_H + 4)
    g.destroy()
  }
  if (!scene.textures.exists(face)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    g.fillStyle(T.shadow, 0.25)
    g.fillRoundedRect(0, 4, CARD_W, CARD_H, r)
    // Cream stock as a shallow top-lit dome — warm belly, lit upper band, gloss sweep (cookbook §3).
    g.fillStyle(T.cardFillWarm, 1)
    g.fillRoundedRect(0, 0, CARD_W, CARD_H, r)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(0, 0, CARD_W, CARD_H * 0.54, { tl: r, tr: r, bl: 0, br: 0 })
    g.fillStyle(0xffffff, 0.34)
    g.fillRoundedRect(8, 5, CARD_W - 16, CARD_H * 0.24, safeR(r - 4, CARD_W - 16, CARD_H * 0.24))
    g.lineStyle(2, T.border, 1)
    g.strokeRoundedRect(1, 1, CARD_W - 2, CARD_H - 2, safeR(r - 1, CARD_W, CARD_H))
    g.lineStyle(1.5, 0xffffff, 0.6)
    g.strokeRoundedRect(3, 2.5, CARD_W - 6, CARD_H - 6, safeR(r - 3, CARD_W, CARD_H))
    g.generateTexture(face, CARD_W, CARD_H + 4)
    g.destroy()
  }
  return { back, face }
}

/** The cabinet the cards sit in — one Graphics, drawn once per open (the plinko cabinet's idiom). */
function drawCabinet(g: Phaser.GameObjects.Graphics, T: Theme): void {
  const x = -FRAME_W / 2
  const y = -FRAME_H / 2
  g.fillStyle(T.shadow, 0.3)
  g.fillRoundedRect(x, y + 9, FRAME_W, FRAME_H, FRAME_R)
  // Cast gold frame — the shared goldFace recipe, so this cabinet is the same metal as the plinko
  // board, the wheel bezel and every hero button in the app.
  goldFace(g, x, y, FRAME_W, FRAME_H, T, FRAME_R)
  // Recessed felt playfield: a dark inset the cards visibly sit IN, with a lit bottom edge so the
  // recess reads as depth rather than as a second flat panel.
  const px = x + BEZEL
  const py = y + BEZEL
  const pr = safeR(FRAME_R - BEZEL + 6, GRID_W, GRID_H)
  g.fillStyle(T.goldDarkest, 1)
  g.fillRoundedRect(px - 4, py - 4, GRID_W + 8, GRID_H + 8, pr + 3)
  g.fillStyle(T.navy, 0.92)
  g.fillRoundedRect(px, py, GRID_W, GRID_H, pr)
  g.lineStyle(2, 0x000000, 0.22)
  g.strokeRoundedRect(px + 1, py + 1, GRID_W - 2, GRID_H - 2, pr - 1)
  g.lineStyle(1.5, 0xffffff, 0.09)
  g.strokeRoundedRect(px + 2, py + 3, GRID_W - 4, GRID_H - 5, pr - 2)
}

/**
 * THE DEAL. Rolls a hand, lays nine cards, and lets the player turn them until three match.
 */
export function openDeal(scene: Phaser.Scene, opts: DealOpenOpts): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const flashOff = reduceFlashing()
  const lowTier = quality.tier() === 'low'
  const cx = DESIGN_W / 2

  // 1) AWARD-FIRST — the hand is settled before a pixel moves. `allowSpins` asks the SAME question
  // the payment will (freeSpinRoom vs addFreeSpins), so a BELL the player can see is always a BELL
  // the game can honour; when it can't, core restrikes it as chips and the paytable says so.
  const save = loadSave()
  const rng = mulberry32((Math.random() * 2 ** 31) | 0)
  const luck = Math.max(0, Math.min(9, save.charmsAllTime))
  // 'mega' — the DEFAULT source, answering to BOTH the daily earn cap and the bank cap.
  //
  // Deliberately not plinko's exemption. That one exists for a specific self-collision: a drop needs
  // an x5+ chain, and that same chain has already banked its MEGA award moments earlier in the same
  // resolve, so under one budget the drop's own trigger routinely emptied the allowance it then
  // needed. Nothing like that happens here — a win streak banks no spins — so the Deal has no claim
  // on the exemption, and taking it anyway would quietly widen a narrowly-argued hole to a second
  // consumer. The flow is tiny either way (BELL is 16% of a hand dealt every third win).
  const allowSpins = freeSpinRoom(todayKey()) > 0
  const faces = dealFaces(allowSpins)
  const faceOf = (id: DealFaceId): DealFace => faces.find(f => f.id === id) ?? faces[0]
  let hand: DealHand = dealHand(rng, allowSpins, luck)
  if (import.meta.env.DEV) {
    // ?face=ID — pin the winning face so every payoff (charm, spin, boost, fast deal) is reachable
    // deterministically from a URL. Mirrors plinko's ?slot=N and the wheel's ?wedge=N.
    //
    // The deck is rebuilt through the REAL `buildDeck`, never hand-assembled: a DEV shortcut that
    // produced a deck the production path could not is worse than no shortcut, because it would
    // silently stop exercising the ≤2 invariant the whole design rests on.
    const want = new URLSearchParams(location.search).get('face')
    const pinned = faces.find(f => f.id === want)
    if (pinned) hand = { face: pinned, deck: buildDeck(rng, pinned.id, faces), luck }
  }

  // 2) Tracked teardown — one call removes everything, killing each part's tweens FIRST (Phaser 3.90
  // never sweeps tweens for destroyed targets, and the bulb chase is repeat:-1).
  const parts: Phaser.GameObjects.GameObject[] = []
  const timers: Phaser.Time.TimerEvent[] = []
  const track = <O extends Phaser.GameObjects.GameObject>(o: O): O => (parts.push(o), o)
  const at = (ms: number, cb: () => void): void => {
    timers.push(scene.time.delayedCall(ms, cb))
  }
  const killDeep = (c: Phaser.GameObjects.Container): void => {
    for (const child of c.list) {
      if (child instanceof Phaser.GameObjects.Container) killDeep(child)
      else scene.tweens.killTweensOf(child)
    }
    scene.tweens.killTweensOf(c)
  }
  const teardown = (): void => {
    for (const t of timers) t.remove(false)
    killDeep(board)
    for (const p of parts) {
      if (p.active) {
        scene.tweens.killTweensOf(p)
        p.destroy()
      }
    }
  }

  // 3) Scrim — dims the win card behind and swallows taps meant for it.
  const scrim = track(
    scene.add
      .rectangle(cx, viewportCenterY(), DESIGN_W, worldH() + 400, T.scrim, reduced ? 0.88 : 0.001)
      .setDepth(60)
      .setInteractive()
  )
  if (!reduced) scene.tweens.add({ targets: scrim, fillAlpha: 0.88, duration: 200, ease: E.press })

  // 4) Title + the rule. The rule line carries the LUCK readout, so the collection's effect on this
  // very hand is stated where the hand is played — a stat on a menu somewhere else would never land.
  const title = track(
    scene.add
      .text(cx, TITLE_Y, 'LUCKY DEAL', { fontFamily: FONT, fontSize: '54px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(6)
      .setStroke(css(T.goldDarkest), 8)
      .setShadow(0, 4, 'rgba(70,45,10,0.5)', 8, false, true)
  )
  const sub = track(
    scene.add
      .text(cx, SUB_Y, luck > 0 ? `MATCH 3 TO WIN  ·  LUCK ${luck}` : 'MATCH 3 TO WIN', {
        fontFamily: FONT,
        fontSize: '22px',
        fontStyle: '900',
        color: css(T.goldBright),
      })
      .setOrigin(0.5)
      .setDepth(62)
      .setLetterSpacing(2)
      .setShadow(0, 2, 'rgba(70,45,10,0.55)', 4, false, true)
  )

  // 5) THE CABINET. Layer order inside the container IS the depth order (containers ignore setDepth).
  const board = track(scene.add.container(cx, BOARD_CY).setDepth(61))
  const cab = scene.add.graphics()
  drawCabinet(cab, T)
  const cardLayer = scene.add.container(0, 0)
  const fxLayer = scene.add.container(0, 0)
  board.add([cab, cardLayer, fxLayer])

  // Crown + apron bulbs along the STRAIGHT part of each edge only (cookbook §2b-ii — past the corner
  // radius the frame has already curved away, and a bulb out at the square corner floats off it).
  const bulbs: Phaser.GameObjects.Image[] = []
  const BULB_RUN = 9
  for (const edgeY of [-FRAME_H / 2 + BEZEL / 2, FRAME_H / 2 - BEZEL / 2]) {
    for (let i = 0; i < BULB_RUN; i++) {
      const bx = -FRAME_W / 2 + FRAME_R + ((FRAME_W - FRAME_R * 2) * i) / (BULB_RUN - 1)
      const b = scene.add
        .image(bx, edgeY, 'bulb')
        .setDisplaySize(12, 12)
        .setTint(i % 2 === 0 ? T.goldBright : T.roseLight)
        .setAlpha(reduced ? 0.85 : 0.45)
      board.addAt(b, 1)
      bulbs.push(b)
    }
  }
  if (!reduced) {
    const CHASE = 1500
    bulbs.forEach((b, i) => {
      scene.tweens.add({
        targets: b,
        alpha: 1,
        duration: CHASE / 2,
        yoyo: true,
        repeat: -1,
        delay: ((i % BULB_RUN) / BULB_RUN) * CHASE,
        ease: E.hero,
      })
    })
  }

  // 6) The nine cards. Each is a small container so the flip can scale the whole card about its own
  // centre while the glyph and pip ride along inside it.
  const stocks = ensureCardTextures(scene, T)
  interface Card {
    root: Phaser.GameObjects.Container
    back: Phaser.GameObjects.Image
    front: Phaser.GameObjects.Container
    ring: Phaser.GameObjects.Graphics | null
    id: DealFaceId
    turned: boolean
  }
  const cards: Card[] = []

  for (let i = 0; i < DEAL_CARDS; i++) {
    const id = hand.deck[i]
    const face = faceOf(id)
    const root = scene.add.container(cardX(i), cardY(i))
    const back = scene.add.image(0, 0, stocks.back)
    const front = scene.add.container(0, 0).setVisible(false)
    const stock = scene.add.image(0, 0, stocks.face)
    // The glyph — the board's own symbol art, so a CHERRY here IS the cherry from the level.
    const glyph = scene.add.image(0, -14, glyphKey(id)).setDisplaySize(id === 'heart' ? 92 : 104, id === 'heart' ? 92 : 104)
    // The pip plate: what turning this card paid, and the face's tone so the value ladder is legible
    // even on a card that turned out not to matter.
    const tone = toneOf(face, T)
    const plate = scene.add.graphics()
    const PW = CARD_W - 34
    const PH = 34
    plate.fillStyle(tone.plate, 1)
    plate.fillRoundedRect(-PW / 2, -PH / 2, PW, PH, safeR(11, PW, PH))
    plate.lineStyle(1.5, 0x000000, 0.13)
    plate.strokeRoundedRect(-PW / 2, -PH / 2, PW, PH, safeR(11, PW, PH))
    plate.setY(CARD_H / 2 - 30)
    const plateText = scene.add
      .text(0, CARD_H / 2 - 30, face.label, { fontFamily: FONT, fontSize: '17px', fontStyle: '900', color: tone.ink })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    front.add([stock, glyph, plate, plateText])
    root.add([back, front])
    cardLayer.add(root)
    cards.push({ root, back, front, ring: null, id, turned: false })
  }

  // 7) The paytable — seven faces and what each pays. A pick'em with a hidden prize table is a
  // slot machine with the glass painted over: the player has to know what they are hoping to turn,
  // or a HEART landing means nothing to them. It reads from the EFFECTIVE table, so a substituted
  // BELL advertises the chips it will actually pay and never a spin that cannot be banked.
  const payIcons: Phaser.GameObjects.Container[] = []
  const PAY_PITCH = 66
  faces.forEach((f, i) => {
    const px = cx + (i - (faces.length - 1) / 2) * PAY_PITCH
    const c = track(scene.add.container(px, PAY_Y).setDepth(62))
    const tone = toneOf(f, T)
    const plate = scene.add.graphics()
    plate.fillStyle(tone.plate, 0.95)
    plate.fillRoundedRect(-27, -27, 54, 54, 13)
    plate.lineStyle(2, T.goldDeep, 0.55)
    plate.strokeRoundedRect(-27, -27, 54, 54, 13)
    const icon = scene.add.image(0, 0, glyphKey(f.id)).setDisplaySize(38, 38)
    const label = scene.add
      .text(0, PAY_LABEL_Y - PAY_Y, payLabel(f), {
        fontFamily: FONT,
        fontSize: '16px',
        fontStyle: '900',
        color: css(T.goldBright),
      })
      .setOrigin(0.5)
      .setLetterSpacing(1)
    c.add([plate, icon, label])
    payIcons.push(c)
  })

  // 8) Turning cards.
  const order: number[] = []
  const seen = new Map<DealFaceId, number>()
  let matched = false
  let busy = false
  let pipRun = 0

  /** A small chip that pops off a turned card and drifts up — the pip, made physical. */
  const pipBurst = (card: Card, value: number): void => {
    if (reduced || lowTier || value <= 0 || !scene.textures.exists('chip')) return
    const wx = board.x + card.root.x
    const wy = board.y + card.root.y - 40
    const chip = track(scene.add.image(wx, wy, 'chip').setDisplaySize(30, 30).setDepth(64))
    const text = track(
      scene.add
        .text(wx + 22, wy, `+${value}`, { fontFamily: FONT, fontSize: '24px', fontStyle: '900', color: css(T.goldBright) })
        .setOrigin(0.5)
        .setDepth(64)
        .setStroke(css(T.goldDarkest), 5)
    )
    for (const o of [chip, text]) {
      scene.tweens.add({ targets: o, y: wy - 54, alpha: 0, duration: 620, ease: 'Cubic.easeOut', onComplete: () => o.destroy() })
    }
  }

  /**
   * PAIR GLOW — the beat the whole round is built on.
   *
   * When a face reaches two, both of its cards get a gold ring and a slow breathe. It costs almost
   * nothing and it is the difference between nine reveals and a game: because the deck holds at most
   * two of any loser, a ring means "this face is one card from being the answer, or it is already
   * dead" — and the player cannot tell which. Every subsequent pick is played against that.
   */
  const ringCard = (card: Card, colour: number, strong: boolean): void => {
    if (card.ring) return
    const g = scene.add.graphics()
    g.lineStyle(strong ? 6 : 4, colour, strong ? 1 : 0.85)
    g.strokeRoundedRect(-CARD_W / 2 - 3, -CARD_H / 2 - 3, CARD_W + 6, CARD_H + 6, safeR(CARD_R + 3, CARD_W + 6, CARD_H + 6))
    card.root.add(g)
    card.ring = g
    if (!reduced) {
      g.setAlpha(0)
      scene.tweens.add({ targets: g, alpha: 1, duration: 200, ease: E.press })
      if (!strong) scene.tweens.add({ targets: g, alpha: 0.45, duration: 900, yoyo: true, repeat: -1, delay: 200, ease: E.hero })
    }
  }

  const turn = (i: number): void => {
    const card = cards[i]
    if (matched || busy || card.turned || !dealt) return
    busy = true
    card.turned = true
    order.push(i)
    retirePrompt()
    const face = faceOf(card.id)
    const count = (seen.get(card.id) ?? 0) + 1
    seen.set(card.id, count)

    const showFace = (): void => {
      card.back.setVisible(false)
      card.front.setVisible(true)
    }

    const landed = (): void => {
      busy = false
      pipBurst(card, face.pip)
      // The turn tick climbs with the run of cards turned, so a long hand builds instead of ticking
      // flat — the cascade-pitch idiom (sfx.pop rises a semitone per wave), borrowed.
      sfx.clearTink(Math.min(6, ++pipRun))
      if (count >= DEAL_MATCH) {
        onMatch(i)
        return
      }
      if (count === 2) {
        // Ring BOTH cards of the new pair, not just this one — the pair is the unit that matters.
        for (const c of cards) if (c.turned && c.id === card.id) ringCard(c, T.goldBright, false)
        sfx.objectiveNear()
        vibrate([14])
      }
    }

    if (reduced) {
      showFace()
      landed()
      return
    }
    sfx.reelClunk(0)
    // The flip: a small lift off the felt, a squash through zero width where the art swaps, and a
    // spring open. Lifting first is what stops it reading as a texture swap — the card leaves the
    // table, turns in the hand, and comes back down.
    scene.tweens.add({ targets: card.root, y: cardY(i) - 12, duration: FLIP_MS, ease: E.press })
    scene.tweens.add({
      targets: card.root,
      scaleX: 0.04,
      duration: FLIP_MS,
      ease: 'Quad.easeIn',
      onComplete: () => {
        showFace()
        scene.tweens.add({
          targets: card.root,
          scaleX: 1,
          duration: FLIP_MS + 40,
          ease: backOut(OVERSHOOT.pop),
        })
        scene.tweens.add({ targets: card.root, y: cardY(i), duration: FLIP_MS + 40, ease: backOut(OVERSHOOT.gentle), onComplete: landed })
      },
    })
  }

  // 9) THE MATCH — bank first, celebrate second.
  let result: DealResult | null = null

  const onMatch = (lastIndex: number): void => {
    matched = true
    const flips = matchAt(hand.deck, order, hand.face.id) + 1
    const payout = settleDeal(hand, order, flips, rng)

    // Everything persisted, in this order, BEFORE a frame of celebration (iron rule #4). Each call is
    // individually atomic (load→mutate→persist) and RE-READS the save, so they compose without
    // clobbering: `grantCharm` may bank a series purse or a duplicate payout into `chips`, and the
    // `addChips` below then adds the hand's own chips on top of that fresh balance rather than on top
    // of a stale one. `newTotal` is therefore the true balance whatever combination paid out.
    const charm = payout.charm ? grantCharm(rng) : null
    // The SAME source `allowSpins` asked about above — what freeSpinRoom promised is what this grants,
    // so a BELL the paytable painted as a SPIN is always a BELL this can pay (save.freespins.test.ts
    // guards that the two agree per source).
    const spins = payout.spins > 0 ? addFreeSpins(payout.spins, todayKey()) : 0
    if (payout.boost) addPendingBoost(payout.boost)
    const newTotal = payout.chips > 0 ? addChips(payout.chips) : loadSave().chips

    result = {
      face: hand.face.id,
      chips: payout.chips,
      spins,
      boost: payout.boost,
      charm,
      newTotal,
      flips: payout.flips,
      fast: payout.fast,
    }

    // Lock the three winners, then prove the deck.
    for (const c of cards) {
      if (c.id === hand.face.id && c.turned) {
        c.ring?.destroy()
        c.ring = null
        ringCard(c, T.rose, true)
        if (!reduced) {
          scene.tweens.add({ targets: c.root, scale: 1.08, duration: 200, yoyo: true, ease: E.hero })
        }
      }
    }
    opts.hitstop?.(reduced ? 0 : 90)
    sfx.jackpotStrike()
    vibrate([50, 40, 90])
    matchBurst(cards[lastIndex])
    at(reduced ? 0 : 380, revealRest)
    at(reduced ? 60 : 760, showPrize)
  }

  const matchBurst = (card: Card): void => {
    if (reduced || flashOff || lowTier || !scene.textures.exists('shockwave')) return
    const wave = scene.add.image(card.root.x, card.root.y, 'shockwave').setBlendMode(Phaser.BlendModes.ADD).setDisplaySize(120, 120).setTint(T.goldBright)
    fxLayer.add(wave)
    scene.tweens.add({
      targets: wave,
      displayWidth: 560,
      displayHeight: 560,
      alpha: 0,
      duration: 520,
      ease: 'Cubic.easeOut',
      onComplete: () => wave.destroy(),
    })
  }

  /**
   * THE PROOF. Every card the player never turned flips face-up, so the finished table shows its
   * whole hand: three of the winner, no more than two of anything else. The rig is only trustworthy
   * if it is checkable, and this is the check — free to build, and the one beat in the game that
   * answers "was that fixed?" with the deck itself rather than with a promise.
   */
  const revealRest = (): void => {
    const rest = cards.filter(c => !c.turned)
    rest.forEach((c, n) => {
      const flip = (): void => {
        c.turned = true
        c.back.setVisible(false)
        c.front.setVisible(true).setAlpha(0.62)
      }
      if (reduced) {
        flip()
        return
      }
      at(n * 70, () => {
        scene.tweens.add({
          targets: c.root,
          scaleX: 0.04,
          duration: 100,
          ease: 'Quad.easeIn',
          onComplete: () => {
            flip()
            scene.tweens.add({ targets: c.root, scaleX: 1, duration: 130, ease: backOut(OVERSHOOT.gentle) })
            sfx.uiTap()
          },
        })
      })
    })
  }

  // 10) The prize banner + CLAIM.
  const showPrize = (): void => {
    if (!result) return
    const lines: string[] = []
    if (result.charm) {
      lines.push(
        result.charm.kind === 'charm'
          ? result.charm.completed
            ? `SERIES COMPLETE!  +${result.charm.purse} CHIPS`
            : `NEW CHARM  ·  ${result.charm.charm.label}`
          : `CHARM ALREADY YOURS  ·  +${result.charm.chips} CHIPS`
      )
    }
    if (result.spins > 0) lines.push(result.spins > 1 ? `+${result.spins} FREE SPINS` : '+1 FREE SPIN')
    if (result.boost) lines.push('BOOST FOR YOUR NEXT LEVEL')
    if (result.chips > 0) lines.push(`+${result.chips} CHIPS`)
    if (result.fast) lines.push(`FAST DEAL!  MATCHED IN ${result.flips}`)

    // The plate is LANDSCAPE — an icon in a left-hand well, the result stacked to its right — because
    // it has to live in the paytable's 150px-tall slot without reaching the cards above or the CLAIM
    // button below. Every prize gets an icon: the charm's own trinket when one was won, otherwise the
    // winning face, so the plate always says WHICH card paid and never looks like it is missing art.
    const headline = `${hand.face.label} × ${DEAL_MATCH}`
    const w = 620
    const h = Math.max(132, 58 + lines.length * 36)
    const c = track(scene.add.container(cx, PRIZE_Y).setDepth(65))
    const g = scene.add.graphics()
    g.fillStyle(T.shadow, 0.4)
    g.fillRoundedRect(-w / 2, -h / 2 + 8, w, h, 26)
    goldFace(g, -w / 2, -h / 2, w, h, T, 26)
    g.fillStyle(T.cardFill, 1)
    g.fillRoundedRect(-w / 2 + 10, -h / 2 + 10, w - 20, h - 20, 18)
    // Icon well — a tinted disc that seats the glyph so it reads as mounted, not pasted on.
    const wellX = -w / 2 + 76
    g.fillStyle(result.charm?.kind === 'charm' ? T.rose : T.cardFillWarm, 1)
    g.fillCircle(wellX, 0, 50)
    g.lineStyle(3, T.goldDeep, 0.7)
    g.strokeCircle(wellX, 0, 50)
    c.add(g)

    const textX = wellX + 74
    const textW = w / 2 - textX - 24
    c.add(
      scene.add
        .text(textX + textW / 2, -h / 2 + 34, headline, { fontFamily: FONT, fontSize: '32px', fontStyle: '900', color: T.goldText })
        .setOrigin(0.5)
        .setLetterSpacing(2)
    )
    lines.forEach((line, i) => {
      c.add(
        scene.add
          .text(textX + textW / 2, -h / 2 + 70 + i * 34, line, {
            fontFamily: FONT,
            fontSize: line.length > 24 ? '19px' : '23px',
            fontStyle: '900',
            color: i === 0 && result?.charm ? css(T.rose) : T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(1)
      )
    })

    // A charm is the only prize in the game you KEEP, so it gets the beat: the trinket itself lands in
    // the well with a spring and a slow rock, over the Maya motif. Everything else shows its face.
    const award = result.charm
    const wonCharm = award && award.kind === 'charm' ? award : null
    const iconKey = wonCharm
      ? ensureGlyphTexture(scene, `charm:${wonCharm.charm.id}`, wonCharm.charm.emoji, 96, 128)
      : glyphKey(hand.face.id)
    const iconSize = wonCharm ? 76 : 68
    const icon = scene.add.image(wellX, 0, iconKey).setDisplaySize(iconSize, iconSize)
    c.add(icon)
    if (wonCharm) {
      if (!reduced) {
        const rest = icon.scale
        icon.setScale(0)
        scene.tweens.add({ targets: icon, scale: rest, duration: 520, delay: 180, ease: backOut(OVERSHOOT.pop) })
        scene.tweens.add({ targets: icon, angle: 9, duration: 1400, yoyo: true, repeat: -1, ease: E.hero, delay: 700 })
      }
      sfx.mayaMotif()
    } else if (result.charm) {
      sfx.coinCount() // a duplicate charm paid chips — the coin cue, not the keepsake one
    }
    if (result.chips > 0) sfx.coinCount()
    sfx.winFanfare()
    if (!reduced) {
      c.setScale(0.7).setAlpha(0)
      scene.tweens.add({ targets: c, scale: 1, alpha: 1, duration: 420, ease: backOut(OVERSHOOT.pop) })
    }
    // The paytable's winning column lights, THEN the whole strip clears out of the plate's way. Its
    // job — "here is what you are chasing" — is finished the moment the result is on screen.
    const winIdx = faces.findIndex(f => f.id === hand.face.id)
    if (reduced) {
      payIcons.forEach(p => p.setVisible(false))
    } else {
      if (winIdx >= 0) scene.tweens.add({ targets: payIcons[winIdx], scale: 1.3, duration: 200, yoyo: true, ease: E.hero })
      payIcons.forEach(p => scene.tweens.add({ targets: p, alpha: 0, scale: 0.7, duration: 260, delay: 140, ease: E.exit }))
    }
    claimBtn.setVisible(true)
    if (reduced) claimBtn.setScale(1)
    else {
      claimBtn.setScale(0)
      scene.tweens.add({ targets: claimBtn, scale: 1, duration: 320, delay: 220, ease: backOut(OVERSHOOT.pop) })
    }
  }

  const claim = (): void => {
    const out = result
    if (!out) return
    teardown()
    opts.onClaim(out)
  }

  const claimBtn = track(
    addPillButton(scene, cx, BUTTON_Y, 300, 84, 'CLAIM', GOLD_PILL, claim, { juice: true }).setDepth(64).setVisible(false)
  )

  // Prompt — replaces the paytable's job of telling the player what to do next.
  const prompt = track(
    scene.add
      .text(cx, BUTTON_Y, 'TAP A CARD', { fontFamily: FONT, fontSize: '28px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setDepth(63)
      .setLetterSpacing(4)
      .setShadow(0, 3, 'rgba(70,45,10,0.5)', 6, false, true)
  )
  if (!reduced) scene.tweens.add({ targets: prompt, alpha: 0.55, duration: 900, yoyo: true, repeat: -1, ease: E.hero })

  /**
   * Retire the prompt on the first turn — it has done its job, and a label pulsing under a live board
   * is exactly the "juicy becomes noisy" failure the motion rules warn about. A hoisted declaration
   * (not a const) so `turn`, defined above, can call it; it only ever RUNS after `prompt` exists.
   */
  function retirePrompt(): void {
    if (order.length !== 1 || !prompt.visible) return // first turn only
    scene.tweens.killTweensOf(prompt)
    if (reduced) prompt.setVisible(false)
    else
      scene.tweens.add({
        targets: prompt,
        alpha: 0,
        y: BUTTON_Y + 10,
        duration: 220,
        ease: E.exit,
        onComplete: () => prompt.setVisible(false),
      })
  }

  const vibrate = (pattern: number[]): void => {
    if (!hapticsOff()) vibratePattern(pattern)
  }

  // 11) Entrance — the cabinet pops, then the cards are DEALT in, one at a time on a short stagger,
  // from the top-left the way a hand is dealt. Input opens only when the last one lands (`dealt`), so
  // a fast finger can't turn a card that is still in the air.
  let dealt = reduced
  const enableInput = (): void => {
    dealt = true
    cards.forEach((c, i) => {
      // Grow the hit-rect to the full card, never smaller than the 44pt floor (cookbook §9).
      c.root
        .setSize(Math.max(CARD_W, 84), Math.max(CARD_H, 84))
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => turn(i))
    })
  }

  if (reduced) {
    board.setScale(1)
    enableInput()
  } else {
    title.setScale(0)
    sub.setAlpha(0)
    prompt.setAlpha(0)
    board.setScale(0.7).setAlpha(0)
    payIcons.forEach(p => p.setScale(0))
    cards.forEach(c => c.root.setScale(0).setAlpha(0))
    scene.tweens.add({ targets: board, scale: 1, alpha: 1, duration: 420, ease: backOut(OVERSHOOT.gentle) })
    scene.tweens.add({ targets: title, scale: 1, duration: 340, delay: 90, ease: 'Back.easeOut' })
    scene.tweens.add({ targets: sub, alpha: 1, duration: 260, delay: 220, ease: E.press })
    cards.forEach((c, i) => {
      scene.tweens.add({
        targets: c.root,
        scale: 1,
        alpha: 1,
        duration: 300,
        delay: 240 + i * 55,
        ease: backOut(OVERSHOOT.pop),
      })
      at(250 + i * 55, () => sfx.uiTap())
    })
    payIcons.forEach((p, i) => {
      scene.tweens.add({ targets: p, scale: 1, duration: 280, delay: 420 + i * 40, ease: backOut(OVERSHOOT.pop) })
    })
    const lastCard = 240 + (DEAL_CARDS - 1) * 55 + 300
    scene.tweens.add({ targets: prompt, alpha: 1, duration: 240, delay: lastCard, ease: E.press })
    at(lastCard, enableInput)
  }

}

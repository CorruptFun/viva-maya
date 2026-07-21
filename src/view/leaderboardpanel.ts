/**
 * WEEKLY RACE leaderboard panel (Round 3) — the display surface over `core/leaderboard.ts`.
 *
 * Visually a sibling of the ui.ts overlays (openHelpPanel / openSettingsPanel): same warm scrim,
 * same cream card with the gold bezel, same depth band (60+), same tap-outside / CLOSE dismissal.
 * What's new is the CHOREOGRAPHY: the card pops in, the ranked rows stagger up top-down, the three
 * podium rows land with calibrated Back pops, a one-shot gold sweep crosses the #1 row (the same
 * release-shine light language the pressables speak), and the signed-in player's own row breathes
 * on the shared heartbeat clock — one organism with the rest of the app.
 *
 * Discipline (the three house guarantees):
 *  1. Reduced motion: every beat collapses to a complete, static resting state (popIn/fadeRise
 *     already collapse; the sweep, shimmer and heartbeat-breathe are skipped outright). The bright
 *     #1 sweep additionally respects reduceFlashing() — there it becomes a slow soft swell.
 *  2. Theme tokens only: the card is cream on all four themes (like every panel), so on-card inks
 *     come from the Theme's on-cream text tokens and all fills/strokes from its number tokens.
 *  3. 60fps: row plates are baked ONCE per (theme, size) into cached textures (identical rows batch
 *     to one draw), transients (the sweep) destroy themselves, tweens are killed before their
 *     targets are destroyed on every state swap, and the only per-frame work is one heartbeat read.
 *
 * Data contract: `core/leaderboard.ts` is read-only API — `fetchWeeklyBoard` never throws and
 * returns an EMPTY board when dormant, so the states resolve as:
 *   signed out (no cloudSession)         → warm "sign in to join" invite
 *   signed in + empty entries            → "be the first on this week's board"
 *   fetch slower than the patience window → quiet error card with RETRY
 *   entries                              → the podium + ranked rows
 * `opts.boardOverride` short-circuits straight to the board state with caller data (screenshots /
 * audits); `opts.simulate` freezes the loading shimmer or forces the error card (DEV harness).
 */
import Phaser from 'phaser'
import { DESIGN_W, worldH } from '../config'
import { sfx } from '../audio/sfx'
import { cloudSession } from '../core/cloud'
import { endlessBestThisWeek, weekKey } from '../core/endless'
import { fetchChampion, fetchWeeklyBoard, previousWeekKey } from '../core/leaderboard'
import type { Champion, LeaderboardEntry, WeeklyBoard } from '../core/leaderboard'
import type { SaveData } from '../core/save'
import { openCloudModal } from './cloudmodal'
import { D, E, OVERSHOOT, backOut, fadeRise, heartbeat, popIn } from './motion'
import { quality } from './quality'
import { getTheme, prefersReducedMotion, reduceFlashing } from './theme'
import type { Theme } from './theme'
import { FONT, GHOST_PILL, GOLD_PILL, ROSE_PILL, addPillButton, goldFace, startScene } from './ui'

// ─────────────────────────────────────────────────────────────────────────────
// Geometry — one fixed, generous card so EVERY state (board, invite, empty, loading, error) lives
// in the same silhouette and the panel never "jumps size" when a fetch resolves.
// ─────────────────────────────────────────────────────────────────────────────

const W = DESIGN_W
const H = 1280
const CARD_W = 640
const CARD_H = 1000
/** Row width inside the card (the card's 36px inner gutters). */
const ROW_W = 568
/** Podium row heights: #1 biggest, #2/#3 matched smaller. */
const POD1_H = 104
const POD23_H = 86
/** Plain ranked-row height + vertical step. */
const ROW_H = 54
const ROW_STEP = 60
/** Content top edge, relative to the card centre (title + week label live above this). */
const CONTENT_TOP = -350
/** How long we wait on the network before quietly offering RETRY (ms, game clock). */
const FETCH_PATIENCE = 8000
/** Texture-bake padding so baked drop shadows aren't clipped. */
const PAD = 10

export interface WeeklyRacePanelOpts {
  /** Render THIS board instead of fetching — deterministic rich data for screenshots/audits. */
  boardOverride?: WeeklyBoard
  /** With boardOverride: the crown-row champion (null = the closed week had none). Live opens fetch it. */
  championOverride?: Champion | null
  /** DEV/testing hook: hold the loading shimmer forever, or open straight onto the error card. */
  simulate?: 'loading' | 'error'
}

/** Crown-row height + gap under it (the "last week's champion" strip above the podium). */
const CROWN_H = 48
const CROWN_GAP = 12

/** Dark-wash check (mirrors ui.ts's private `isDarkTheme`): drives the dark-theme accent rim. */
function isDarkWash(T: Theme): boolean {
  const c = T.washBottom
  const r = ((c >> 16) & 0xff) / 255
  const g = ((c >> 8) & 0xff) / 255
  const b = (c & 0xff) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.4
}

// ─────────────────────────────────────────────────────────────────────────────
// Baked row plates. Each signature bakes once per (theme, kind) into the global TextureManager, so
// ten ranked rows cost ten quads of the same texture — and the #1 plate being an IMAGE is what lets
// the gold sweep ride a bitmap mask of its exact silhouette (the pressables' release-shine recipe).
// ─────────────────────────────────────────────────────────────────────────────

type PlateKind = 'gold' | 'podium' | 'row'

function plateKey(kind: PlateKind, w: number, h: number): string {
  return `race:${kind}:${getTheme().id}:${w}x${h}`
}

/** Bake one row plate: soft down-cast shadow + face + bezel (+ dark-theme accent rim). */
function ensurePlate(scene: Phaser.Scene, kind: PlateKind, w: number, h: number): string {
  const key = plateKey(kind, w, h)
  if (scene.textures.exists(key)) return key
  const T = getTheme()
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = PAD
  const y = PAD
  const r = kind === 'row' ? 14 : 20
  // Shadow falls straight DOWN (the one key light sits above the scene — ui.ts §E7).
  for (let i = 2; i >= 1; i--) {
    g.fillStyle(T.shadow, kind === 'row' ? 0.05 : 0.08)
    g.fillRoundedRect(x, y + i * 2, w, h, r)
  }
  if (kind === 'gold') {
    // The champion's plate is the canonical real-metal gold face (shared with the payline/win tab).
    goldFace(g, x, y, w, h, T, r)
    g.lineStyle(3, T.goldDeep, 1)
    g.strokeRoundedRect(x, y, w, h, r)
  } else {
    // Podium 2/3: warm cream with the gold bezel; plain rows: the quiet alt-card face.
    g.fillStyle(kind === 'podium' ? T.cardFillWarm : T.cardFillAlt, 1)
    g.fillRoundedRect(x, y, w, h, r)
    // Top-lit gloss — a couple of falling-height highlight bands, same trick as the button caps.
    for (let i = 0; i < 3; i++) {
      const bh = h * (0.4 - i * 0.11)
      if (bh < 3) break
      g.fillStyle(T.glossHi, kind === 'podium' ? 0.2 : 0.12)
      g.fillRoundedRect(x + 4, y + 2, w - 8, bh, Math.min(r - 2, bh / 2))
    }
    g.lineStyle(kind === 'podium' ? 3 : 2, kind === 'podium' ? T.goldBezel : T.border, 1)
    g.strokeRoundedRect(x, y, w, h, r)
  }
  // Dark-theme-only lit accent rim along the top inner edge (the neon tell — no-op on cream washes).
  if (isDarkWash(T)) {
    g.fillStyle(T.accent, 0.7)
    g.fillRoundedRect(x + r, y + 3, w - r * 2, 2, 1)
  }
  g.generateTexture(key, w + PAD * 2, h + PAD * 2)
  g.destroy()
  return key
}

/**
 * Rank medallion: a STRUCK-MINTED rank coin — a milled/reeded rim, a recessed engraved numeral field,
 * belly falloff, and a specular pip, so it reads pressed-not-printed. #1 gets the full bright-gold
 * material; #2/#3 are the quieter cream-gold. Theme-token drawn, so it recolours on every theme for
 * free. Exported so the dev atlas ('medals' page) can render #1/#2/#3 at their true row sizes.
 */
export function makeMedal(scene: Phaser.Scene, rank: number, r: number): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const g = scene.add.graphics()
  const g1 = rank === 1
  // Per-rank metal (light falls from the top): #1 hot gold, #2/#3 the quieter cream-gold.
  const rimBase = g1 ? T.goldDeep : T.goldBezel
  const rimLit = T.goldBright
  const rimDark = g1 ? T.goldDarkest : T.goldDeep
  const domeBase = g1 ? T.goldDeep : T.goldBezel
  const domeLit = g1 ? T.gold : T.cardFillWarm
  const domeCrown = g1 ? T.goldBright : T.glossHi
  // Seated contact shadow → coin blank (a deep base offset DOWN so the shaded underside shows low) → rim metal.
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(0, r * 0.96, r * 1.4, r * 0.4)
  g.fillStyle(rimDark, 1)
  g.fillCircle(0, r * 0.05, r)
  g.fillStyle(rimBase, 1)
  g.fillCircle(0, 0, r)
  // Milled/reeded rim — 20 alternating lit/shadowed radial teeth (chunky enough to survive r=26).
  const teeth = 20
  const inR = r * 0.84
  const outR = r * 0.99
  const tw = Math.max(1.4, r * 0.075)
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2 - Math.PI / 2
    const lit = i % 2 === 0
    g.lineStyle(tw, lit ? rimLit : rimDark, lit ? 0.9 : 0.7)
    g.lineBetween(Math.cos(a) * inR, Math.sin(a) * inR, Math.cos(a) * outR, Math.sin(a) * outR)
  }
  // Dark rim groove — the recessed channel between the milled rim and the raised face.
  g.lineStyle(Math.max(1.6, r * 0.055), rimDark, 0.65)
  g.strokeCircle(0, 0, r * 0.8)
  // RAISED DOMED FACE — a deep base, then a lit face offset UP toward the light (offset-disc dome), a
  // warm crown light-pool, and a brighter core high on the dome.
  g.fillStyle(domeBase, 1)
  g.fillCircle(0, r * 0.02, r * 0.76)
  g.fillStyle(domeLit, 1)
  g.fillCircle(0, -r * 0.05, r * 0.71)
  g.fillStyle(domeCrown, g1 ? 0.5 : 0.62)
  g.fillCircle(0, -r * 0.16, r * 0.46)
  g.fillStyle(domeCrown, 0.5)
  g.fillCircle(0, -r * 0.22, r * 0.24)
  // Belly falloff — the lower dome sinks into shadow (kept inside the dome so it never bleeds past the rim).
  g.fillStyle(0x000000, g1 ? 0.13 : 0.08)
  g.fillEllipse(0, r * 0.34, r * 1.05, r * 0.52)
  // Dome bevel: a dark edge ring + a lit inner ring → the face reads raised and minted.
  g.lineStyle(Math.max(1.2, r * 0.04), rimDark, 0.5)
  g.strokeCircle(0, 0, r * 0.75)
  g.lineStyle(Math.max(1, r * 0.03), rimLit, 0.5)
  g.strokeCircle(0, 0, r * 0.7)
  // Engraved numeral cartouche — a pressed recess (dark disc + an inner-top shadow lip + a lit lower
  // bounce) so the numeral sits struck INTO the dome.
  g.fillStyle(rimDark, g1 ? 0.14 : 0.09)
  g.fillCircle(0, r * 0.04, r * 0.44)
  g.fillStyle(0x000000, 0.1)
  g.fillEllipse(0, -r * 0.15, r * 0.64, r * 0.24)
  g.fillStyle(domeCrown, 0.22)
  g.fillEllipse(0, r * 0.24, r * 0.54, r * 0.18)
  // Beaded inner ring — 12 tiny relief dots framing the field (a dark seat + a lit cap offset up).
  const beads = 12
  const bR = r * 0.63
  const bd = Math.max(1, r * 0.05)
  for (let i = 0; i < beads; i++) {
    const ba = (i / beads) * Math.PI * 2 - Math.PI / 2
    const bx = Math.cos(ba) * bR
    const by = Math.sin(ba) * bR
    g.fillStyle(rimDark, 0.5)
    g.fillCircle(bx, by + bd * 0.5, bd + 0.4)
    g.fillStyle(rimLit, g1 ? 0.85 : 0.9)
    g.fillCircle(bx, by - bd * 0.3, bd)
  }
  // Signature: two raised laurel sprigs flanking the numeral (dark seat + a lit cap offset up = relief).
  const lw = Math.max(1.2, r * 0.05)
  const leafLen = r * 0.15
  for (const s of [-1, 1]) {
    const leaves: Array<[number, number]> = [
      [s * r * 0.4, r * 0.28],
      [s * r * 0.44, r * 0.06],
      [s * r * 0.4, -r * 0.16],
    ]
    for (const [lx, ly] of leaves) {
      const ex = lx - s * leafLen * 0.7
      const ey = ly - leafLen * 0.72
      g.lineStyle(lw, T.goldDarkest, 0.5)
      g.lineBetween(lx, ly, ex, ey)
      g.lineStyle(Math.max(1, lw * 0.7), T.goldBright, 0.7)
      g.lineBetween(lx, ly - 0.6, ex, ey - 0.6)
    }
  }
  // Top gloss crescent, a crisp dark outer edge, and a hard specular glint upper-left.
  g.fillStyle(0xffffff, g1 ? 0.13 : 0.16)
  g.fillEllipse(0, -r * 0.42, r * 0.95, r * 0.36)
  g.lineStyle(2, rimDark, 0.75)
  g.strokeCircle(0, 0, r)
  g.fillStyle(0xffffff, 0.7)
  g.fillCircle(-r * 0.28, -r * 0.4, r * 0.09)
  c.add(g)
  const num = scene.add
    .text(0, 1, String(rank), {
      fontFamily: FONT,
      fontSize: `${Math.round(r * (rank === 1 ? 1.05 : 0.95))}px`,
      fontStyle: '900',
      color: rank === 1 ? T.goldPillText : T.goldText,
    })
    .setOrigin(0.5)
  c.add(num)
  return c
}

/** Small rose "YOU" tag pill — the signed-in player's marker on their own row. */
function makeYouTag(scene: Phaser.Scene): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const tw = 58
  const th = 28
  const g = scene.add.graphics()
  g.fillStyle(T.roseDeep, 1)
  g.fillRoundedRect(-tw / 2, -th / 2 + 2, tw, th, th / 2)
  g.fillStyle(T.rose, 1)
  g.fillRoundedRect(-tw / 2, -th / 2, tw, th, th / 2)
  c.add(g)
  c.add(
    scene.add
      .text(0, 0, 'YOU', { fontFamily: FONT, fontSize: '16px', fontStyle: '900', color: T.onRose })
      .setOrigin(0.5)
      .setLetterSpacing(1)
  )
  return c
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the WEEKLY RACE overlay. Fetches this week's board (unless `opts.boardOverride` supplies
 * one) and renders whichever state the data lands in — every state dressed to the same standard.
 * Safe against double-open (a module latch, mirroring the secret-note guard) and against late
 * fetches racing a closed panel (an `alive` flag checked before any state swap).
 */
/** Double-open latch (module-scoped, mirrors HomeScene's `noteOpen` guard). */
let raceOpen = false

export function openWeeklyRacePanel(scene: Phaser.Scene, opts: WeeklyRacePanelOpts = {}): void {
  if (raceOpen) return
  raceOpen = true
  const T = getTheme()
  const still = prefersReducedMotion()
  const layer = scene.add.container(0, 0).setDepth(60)

  // ── Shell: scrim + cream card + title + CLOSE (shared by every state) ──────────────────────
  const scrim = scene.add.rectangle(W / 2, H / 2, W, worldH(), T.scrim, 0.6).setInteractive()
  let alive = true
  const close = (): void => {
    if (!alive) return
    alive = false
    raceOpen = false
    sfx.whoosh() // §E3 B14: the airy sweep partners every panel close
    layer.destroy()
  }
  scrim.on('pointerup', close)
  layer.add(scrim)
  // The scene can be torn down under us (theme restart / navigation) — release the latch + flag.
  layer.once(Phaser.GameObjects.Events.DESTROY, () => {
    alive = false
    raceOpen = false
  })

  // Everything card-shaped lives in cardRoot (origin = card centre) so the pop-in scales from the
  // middle like a dealt card, not from the screen corner.
  const cardRoot = scene.add.container(W / 2, H / 2)
  layer.add(cardRoot)

  const g = scene.add.graphics()
  const cx = -CARD_W / 2
  const cy = -CARD_H / 2
  // Card shadow falls straight down from the one key light (three-pass penumbra, ui.ts recipe).
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(T.shadow, 0.08)
    g.fillRoundedRect(cx, cy + i * 3, CARD_W, CARD_H, 30)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(cx, cy, CARD_W, CARD_H, 30)
  g.lineStyle(4, T.goldBezel, 1)
  g.strokeRoundedRect(cx, cy, CARD_W, CARD_H, 30)
  if (isDarkWash(T)) {
    g.fillStyle(T.accent, 0.85)
    g.fillRoundedRect(cx + 30, cy + 3, CARD_W - 60, 2, 1)
  }
  cardRoot.add(g)

  // Blocker so taps on the card never fall through to the scrim (which closes).
  cardRoot.add(scene.add.rectangle(0, 0, CARD_W, CARD_H, 0xffffff, 0.001).setInteractive())

  const title = scene.add
    .text(0, cy + 58, 'WEEKLY RACE', { fontFamily: FONT, fontSize: '46px', fontStyle: '900', color: T.goldText })
    .setOrigin(0.5)
    .setLetterSpacing(2)
    .setShadow(0, 2, 'rgba(0,0,0,0.12)', 4, false, true)
  const weekLabel = scene.add
    .text(0, cy + 104, '', { fontFamily: 'Arial, sans-serif', fontSize: '22px', color: T.inkMuted })
    .setOrigin(0.5)
  cardRoot.add([title, weekLabel])
  const setWeek = (wk: string): void => {
    weekLabel.setText(`this week's board  ·  ${wk}`)
  }
  setWeek(opts.boardOverride?.week ?? weekKey())

  // Bottom controls: the growth hook (a ghost "invite friends to race" chip — the invite row itself
  // lives in the Gift Store) beside CLOSE. Tracked so newBody() can insert every state UNDER them.
  const controls: Phaser.GameObjects.Container[] = []
  const invite = addPillButton(scene, -129, CARD_H / 2 - 70, 310, 56, 'INVITE FRIENDS', GHOST_PILL, () => {
    startScene(scene, 'store') // the panel dies with the scene; the layer DESTROY hook frees the latch
  })
  cardRoot.add(invite)
  controls.push(invite)
  const closePill = addPillButton(scene, 160, CARD_H / 2 - 70, 240, 68, 'CLOSE', GOLD_PILL, close)
  cardRoot.add(closePill)
  controls.push(closePill)

  // Card entrance: pop in from a dealt-card 0.92 with a gentle spring + a quick fade. Reduced
  // motion → popIn collapses instantly and the alpha is simply set.
  if (still) {
    cardRoot.setAlpha(1)
  } else {
    cardRoot.setAlpha(0)
    scene.tweens.add({ targets: cardRoot, alpha: 1, duration: D.base, ease: E.settle })
    popIn(scene, cardRoot, { from: 0.92, duration: D.pop, overshoot: OVERSHOOT.gentle })
  }

  // ── State machinery: one `body` container per state; tweens registered per-body so every swap
  // stops them BEFORE destroying targets (Phaser 3.90 does not sweep tweens for destroyed objects).
  let body: Phaser.GameObjects.Container | null = null
  let bodyTweens: Phaser.Tweens.Tween[] = []
  let bodyTick: (() => void) | null = null
  const tw = (t: Phaser.Tweens.Tween | null): void => {
    if (t) bodyTweens.push(t)
  }
  const clearBody = (): void => {
    for (const t of bodyTweens) t.stop()
    bodyTweens = []
    if (bodyTick) {
      scene.events.off(Phaser.Scenes.Events.UPDATE, bodyTick)
      bodyTick = null
    }
    body?.destroy()
    body = null
  }
  const newBody = (): Phaser.GameObjects.Container => {
    clearBody()
    body = scene.add.container(0, 0)
    // Insert under the INVITE + CLOSE pills so a landing row can never paint over the buttons.
    cardRoot.addAt(body, cardRoot.getIndex(controls[0]))
    return body
  }
  // The panel closing must also stop body tweens + the heartbeat tick (targets die with the layer).
  layer.once(Phaser.GameObjects.Events.DESTROY, clearBody)

  // The player's own row + halo, captured during buildRow for the heartbeat breathe.
  let youRow: Phaser.GameObjects.Container | null = null
  let youGlow: Phaser.GameObjects.Image | null = null

  // ── State: the ranked board ────────────────────────────────────────────────────────────────
  const showBoard = (board: WeeklyBoard, champ: Champion | null = null): void => {
    const b = newBody()
    setWeek(board.week)
    const fancy = !still && quality.tier() !== 'low'
    const champYou = champ?.you === true

    // Round-3 audit fix: the own-row heartbeat tick below must NOT modulate scale while the row's
    // entrance pop is still in flight (the per-frame setScale was overwriting the Back tween when
    // YOU landed top-3). Flipped true by the you-row's LAST entrance tween completing.
    let youSettled = false

    // Does the player's own row land inside the visible rows, or does the footer carry it?
    // The crown row costs one plain rank so every state keeps the same card silhouette.
    const footerNeeded = board.myRank !== null && !board.entries.slice(0, champ ? 9 : 10).some(e => e.you)
    const plainMax = (footerNeeded ? 6 : 7) - (champ ? 1 : 0)
    const shown = board.entries.slice(0, 3 + plainMax)

    /** Build one row container (plate + medal/rank + name + score [+ YOU dressing]) at rest. */
    const buildRow = (e: LeaderboardEntry, y: number, kind: PlateKind, h: number): Phaser.GameObjects.Container => {
      const row = scene.add.container(0, y)
      // Rose halo UNDER the player's own plate — the heartbeat drives its glow (below).
      if (e.you && scene.textures.exists('bgglow')) {
        const halo = scene.add
          .image(0, 0, 'bgglow')
          .setDisplaySize(ROW_W * 1.12, h * 2.4)
          .setTint(T.rose)
          .setBlendMode(Phaser.BlendModes.ADD)
          .setAlpha(still ? 0.16 : 0.12)
        row.add(halo)
        youGlow = halo
        youRow = row
      }
      const plate = scene.add.image(0, 0, ensurePlate(scene, kind, ROW_W, h))
      row.add(plate)
      if (e.you) {
        // Rose accent ring — the highlight that says "this one is yours" on any plate kind.
        const ring = scene.add.graphics()
        ring.lineStyle(3, T.rose, 0.95)
        ring.strokeRoundedRect(-ROW_W / 2, -h / 2, ROW_W, h, kind === 'row' ? 14 : 20)
        row.add(ring)
      }
      const onGold = kind === 'gold'
      const nameColor = onGold ? T.goldPillText : e.you ? T.ink : kind === 'podium' ? T.ink : T.inkSoft
      const nameSize = kind === 'gold' ? 30 : kind === 'podium' ? 26 : 23
      let nameX = -ROW_W / 2 + 40
      if (kind === 'row') {
        // Plain rows carry a quiet rank numeral instead of a medallion.
        row.add(
          scene.add
            .text(nameX, 0, `#${e.rank}`, { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: T.inkFaint })
            .setOrigin(0.5)
        )
        nameX += 44
      } else {
        const r = kind === 'gold' ? 32 : 26
        const med = makeMedal(scene, e.rank, r)
        med.setPosition(-ROW_W / 2 + 26 + r, 0)
        row.add(med)
        // Medal sub-pop: each coin lands a beat AFTER its plate for the layered two-beat entrance.
        if (fancy) {
          med.setScale(0)
          tw(
            scene.tweens.add({
              targets: med,
              scale: 1,
              duration: D.pop,
              delay: D.base + e.rank * 70 + 130,
              ease: backOut(OVERSHOOT.pop),
            })
          )
        }
        nameX = -ROW_W / 2 + 26 + r * 2 + 22
      }
      const name = scene.add
        .text(nameX, 0, e.name, { fontFamily: FONT, fontSize: `${nameSize}px`, fontStyle: '900', color: nameColor })
        .setOrigin(0, 0.5)
      // Emboss on the gold plate so the champion's name reads etched into the metal.
      if (onGold) name.setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      row.add(name)
      if (e.you) {
        const tag = makeYouTag(scene)
        tag.setPosition(name.x + name.width + 40, 0)
        row.add(tag)
        // Reigning champion's own row wears a small crown beside the YOU tag (gold-crown YOUR row).
        if (champYou) {
          row.add(
            scene.add.text(tag.x + 46, 0, '👑', { fontFamily: 'sans-serif', fontSize: '22px' }).setOrigin(0.5)
          )
        }
      }
      row.add(
        scene.add
          .text(ROW_W / 2 - 26, 0, e.score.toLocaleString(), {
            fontFamily: FONT,
            fontSize: `${kind === 'gold' ? 30 : kind === 'podium' ? 25 : 22}px`,
            fontStyle: '900',
            color: onGold ? T.goldPillText : T.goldText,
          })
          .setOrigin(1, 0.5)
      )
      b.add(row)
      return row
    }

    // Lay the rows out top-down: podium block (with its own breathing room), then the plain ranks.
    // `y` walks the TOP edge of each row; a row is centred at y + h/2 and advances y by h + gap.
    let y = CONTENT_TOP

    // Crown row — "last week's champion · NAME" above the podium. A quiet honour strip on the warm
    // podium plate; when the champion is YOU it lands on the full gold plate with an embossed YOU.
    if (champ) {
      const crownRow = scene.add.container(0, y + CROWN_H / 2)
      crownRow.add(scene.add.image(0, 0, ensurePlate(scene, champYou ? 'gold' : 'podium', ROW_W, CROWN_H)))
      const glyph = scene.add
        .text(-ROW_W / 2 + 38, 1, '👑', { fontFamily: 'sans-serif', fontSize: '26px' })
        .setOrigin(0.5)
      crownRow.add(glyph)
      crownRow.add(
        scene.add
          .text(-ROW_W / 2 + 68, 0, 'last week’s champion', {
            fontFamily: 'Arial, sans-serif',
            fontSize: '20px',
            color: champYou ? T.goldPillText : T.inkMuted,
          })
          .setOrigin(0, 0.5)
      )
      const champName = scene.add
        .text(ROW_W / 2 - 26, 0, champYou ? 'YOU' : champ.name, {
          fontFamily: FONT,
          fontSize: '24px',
          fontStyle: '900',
          color: champYou ? T.goldPillText : T.goldText,
        })
        .setOrigin(1, 0.5)
      if (champYou) champName.setShadow(0, 2, 'rgba(74,51,5,0.35)', 2, false, true)
      crownRow.add(champName)
      b.add(crownRow)
      // The honour strip leads the cascade in, its crown popping a beat after the plate lands.
      tw(fadeRise(scene, crownRow, { rise: 10, delay: D.base - 40, duration: D.settle }))
      if (fancy) {
        glyph.setScale(0)
        tw(scene.tweens.add({ targets: glyph, scale: 1, duration: D.pop, delay: D.base + 220, ease: backOut(OVERSHOOT.pop) }))
      }
      y += CROWN_H + CROWN_GAP
    }
    const rows: Array<{ row: Phaser.GameObjects.Container; pod: boolean }> = []
    let goldPlateRow: Phaser.GameObjects.Container | null = null
    shown.forEach((e, i) => {
      const pod = i < 3
      const kind: PlateKind = i === 0 ? 'gold' : pod ? 'podium' : 'row'
      const h = i === 0 ? POD1_H : pod ? POD23_H : ROW_H
      const row = buildRow(e, y + h / 2, kind, h)
      if (i === 0) goldPlateRow = row
      rows.push({ row, pod })
      // Gaps: 10 inside the podium, 16 between podium and the list, 6 between plain rows.
      y += h + (i < 2 ? 10 : i === 2 ? 16 : ROW_STEP - ROW_H)
    })

    // Entrance: rows stagger-fadeRise top-down; podium rows ADD a Back pop (scale) on top of the
    // rise, biggest spring on #1 — layered, multi-beat, still only transform/alpha tweens.
    rows.forEach(({ row, pod }, i) => {
      const delay = D.base + i * 45
      const isYou = row === youRow
      const popToo = pod && fancy
      tw(
        fadeRise(scene, row, {
          rise: pod ? 16 : 12,
          delay,
          duration: D.settle,
          // The you-row's LAST entrance tween releases the heartbeat (audit fix): the pop below runs
          // longer than the rise when both play, so only the rise-only path hands over here.
          onComplete: isYou && !popToo ? (): void => { youSettled = true } : undefined,
        })
      )
      if (popToo) {
        row.setScale(0.86)
        tw(
          scene.tweens.add({
            targets: row,
            scale: 1,
            duration: D.pop,
            delay,
            ease: backOut(i === 0 ? OVERSHOOT.pop : OVERSHOOT.release),
            onComplete: isYou ? (): void => { youSettled = true } : undefined,
          })
        )
      }
    })

    // One-shot gold sweep across the #1 row — the pressables' release-shine, scaled up to crown the
    // champion. Masked to the gold plate's exact silhouette. reduceFlashing() swaps the travelling
    // bright band for a slow soft swell of warm light; reduced motion / low tier skip entirely.
    if (goldPlateRow !== null && fancy && scene.textures.exists('sweep')) {
      const host: Phaser.GameObjects.Container = goldPlateRow
      const plateImg = host.list.find(
        (o): o is Phaser.GameObjects.Image => o instanceof Phaser.GameObjects.Image && o.texture.key.startsWith('race:gold')
      )
      if (plateImg) {
        if (reduceFlashing()) {
          const swell = scene.add
            .image(0, 0, plateImg.texture.key)
            .setTint(0xffffff)
            .setBlendMode(Phaser.BlendModes.ADD)
            .setAlpha(0)
          host.add(swell)
          tw(
            scene.tweens.add({
              targets: swell,
              alpha: 0.16,
              duration: D.pulse,
              delay: D.base + 320,
              yoyo: true,
              ease: E.hero,
              onComplete: () => swell.destroy(),
            })
          )
        } else {
          const streakW = 96
          const shine = scene.add
            .image(-ROW_W / 2 - streakW, 0, 'sweep')
            .setDisplaySize(streakW, POD1_H * 1.5)
            .setAngle(14)
            .setTint(T.glossHi)
            .setAlpha(0.85)
            .setBlendMode(Phaser.BlendModes.ADD)
          shine.setMask(plateImg.createBitmapMask())
          host.add(shine)
          tw(
            scene.tweens.add({
              targets: shine,
              x: ROW_W / 2 + streakW,
              duration: 460,
              delay: D.base + 340,
              ease: E.glide,
              onComplete: () => {
                shine.clearMask(true)
                shine.destroy()
              },
            })
          )
        }
      }
    }

    // Footer: the player's own rank pinned under the list when they fall outside the shown rows.
    if (footerNeeded && board.myRank !== null) {
      const fh = 52
      const foot = scene.add.container(0, CARD_H / 2 - 136)
      const fg = scene.add.graphics()
      fg.fillStyle(T.cardFillWarm, 1)
      fg.fillRoundedRect(-ROW_W / 2, -fh / 2, ROW_W, fh, fh / 2)
      fg.lineStyle(2.5, T.rose, 0.9)
      fg.strokeRoundedRect(-ROW_W / 2, -fh / 2, ROW_W, fh, fh / 2)
      foot.add(fg)
      const tag = makeYouTag(scene)
      tag.setPosition(-ROW_W / 2 + 46, 0)
      foot.add(tag)
      foot.add(
        scene.add
          .text(-ROW_W / 2 + 86, 0, `your rank  ·  #${board.myRank}`, {
            fontFamily: FONT,
            fontSize: '22px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0, 0.5)
      )
      if (board.myScore !== null) {
        foot.add(
          scene.add
            .text(ROW_W / 2 - 26, 0, board.myScore.toLocaleString(), {
              fontFamily: FONT,
              fontSize: '22px',
              fontStyle: '900',
              color: T.goldText,
            })
            .setOrigin(1, 0.5)
        )
      }
      b.add(foot)
      tw(fadeRise(scene, foot, { delay: D.base + rows.length * 45 + 80, onComplete: (): void => { youSettled = true } }))
      youRow = youRow ?? foot // outside the top rows the FOOTER is "you" — it carries the breathe
    }

    // Own-row heartbeat breathe: one shared-clock read per frame, phase-locked with every hero
    // breather in the app. Skipped under reduced motion (halo already rests at a static warm alpha),
    // and GATED until the row's entrance tweens complete (`youSettled`) so the per-frame setScale
    // can never fight the podium pop mid-flight (Round-3 audit fix).
    if (youRow && !still) {
      const target = youRow
      const halo = youGlow
      bodyTick = (): void => {
        if (!youSettled) return
        const a = heartbeat.amp()
        target.setScale(1 + a * 0.012)
        halo?.setAlpha(0.12 + a * 0.14)
      }
      scene.events.on(Phaser.Scenes.Events.UPDATE, bodyTick)
    }
  }

  // ── State: loading shimmer ─────────────────────────────────────────────────────────────────
  const showLoading = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    // Ghost plates in the exact resting geometry of the board, so the loaded rows land where the
    // shimmer promised them. Soft alpha swell, staggered down the card — governor-gated: the low
    // tier (and reduced motion) hold them at a static mid-alpha instead.
    const heights = [POD1_H, POD23_H, POD23_H, ROW_H, ROW_H, ROW_H, ROW_H]
    const gaps = [10, 10, 16, 6, 6, 6, 6]
    let y = CONTENT_TOP
    heights.forEach((h, i) => {
      const plate = scene.add.image(0, y + h / 2, ensurePlate(scene, 'row', ROW_W, h)).setAlpha(0.55)
      b.add(plate)
      if (!still && quality.tier() !== 'low') {
        tw(
          scene.tweens.add({
            targets: plate,
            alpha: 0.9,
            duration: D.pulse,
            delay: i * 110,
            yoyo: true,
            repeat: -1,
            ease: E.hero,
          })
        )
      }
      y += h + gaps[i]
    })
    const cap = scene.add
      .text(0, y + 34, 'fetching this week’s race…', { fontFamily: 'Arial, sans-serif', fontSize: '21px', color: T.inkFaint })
      .setOrigin(0.5)
    b.add(cap)
    tw(fadeRise(scene, cap, { delay: D.base }))
  }

  // ── State: signed out — the warm invite ────────────────────────────────────────────────────
  const showSignedOut = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    const heroY = -160
    if (scene.textures.exists('bgglow')) {
      const halo = scene.add
        .image(0, heroY, 'bgglow')
        .setDisplaySize(360, 360)
        .setTint(T.gold)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setAlpha(still ? 0.3 : 0.24)
      b.add(halo)
      if (!still) {
        tw(scene.tweens.add({ targets: halo, alpha: 0.4, scale: halo.scaleX * 1.08, duration: D.breath, yoyo: true, repeat: -1, ease: E.hero }))
      }
    }
    const trophy = scene.add.text(0, heroY, '🏆', { fontFamily: 'sans-serif', fontSize: '110px' }).setOrigin(0.5)
    b.add(trophy)
    tw(popIn(scene, trophy, { from: 0.5, delay: D.base, overshoot: OVERSHOOT.pop }))
    if (!still) {
      tw(scene.tweens.add({ targets: trophy, scale: 1.05, duration: D.breath, delay: D.pop + D.base, yoyo: true, repeat: -1, ease: E.hero }))
    }
    const head = scene.add
      .text(0, -10, 'sign in to join the weekly race', {
        fontFamily: FONT,
        fontSize: '30px',
        fontStyle: '900',
        color: T.ink,
        align: 'center',
        wordWrap: { width: CARD_W - 140 },
      })
      .setOrigin(0.5)
    const sub = scene.add
      .text(0, 52, 'one shared board every week —\neveryone gets the same deal.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
        color: T.inkMuted,
        align: 'center',
        lineSpacing: 6,
      })
      .setOrigin(0.5)
    b.add([head, sub])
    tw(fadeRise(scene, head, { delay: D.base + 90 }))
    tw(fadeRise(scene, sub, { delay: D.base + 150 }))
    // NOTE: deliberately no `sheen` opt — its slow-shine timer would outlive a mid-scene close.
    const signIn = addPillButton(scene, 0, 190, 300, 80, 'SIGN IN', GOLD_PILL, () => {
      sfx.whoosh() // §E3 B14: the airy sweep partners the cloud modal opening
      openCloudModal()
    })
    b.add(signIn)
    tw(fadeRise(scene, signIn, { delay: D.base + 220 }))
  }

  // ── State: empty week ──────────────────────────────────────────────────────────────────────
  const showEmpty = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    // The open throne: the #1 gold plate rendered as a soft ghost — an invitation, not a list.
    const ghost = scene.add.container(0, -150)
    const plate = scene.add.image(0, 0, ensurePlate(scene, 'gold', ROW_W, POD1_H)).setAlpha(0.4)
    ghost.add(plate)
    const med = makeMedal(scene, 1, 32)
    med.setPosition(-ROW_W / 2 + 58, 0)
    med.setAlpha(0.55)
    ghost.add(med)
    ghost.add(
      scene.add
        .text(-ROW_W / 2 + 128, 0, 'this spot is open', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.inkFaint })
        .setOrigin(0, 0.5)
    )
    b.add(ghost)
    tw(fadeRise(scene, ghost, { rise: 16, delay: D.base, duration: D.settle }))
    if (!still && quality.tier() !== 'low') {
      ghost.setScale(0.9)
      tw(scene.tweens.add({ targets: ghost, scale: 1, duration: D.pop, delay: D.base, ease: backOut(OVERSHOOT.release) }))
    }
    const star = scene.add.image(0, 6, 'star').setDisplaySize(76, 76)
    b.add(star)
    tw(popIn(scene, star, { from: 0.4, delay: D.base + 160, overshoot: OVERSHOOT.pop }))
    const head = scene.add
      .text(0, 92, 'be the first on this week’s board', {
        fontFamily: FONT,
        fontSize: '29px',
        fontStyle: '900',
        color: T.ink,
        align: 'center',
        wordWrap: { width: CARD_W - 140 },
      })
      .setOrigin(0.5)
    const sub = scene.add
      .text(0, 148, 'finish an endless run and your best lands here.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '22px',
        color: T.inkMuted,
        align: 'center',
      })
      .setOrigin(0.5)
    b.add([head, sub])
    tw(fadeRise(scene, head, { delay: D.base + 220 }))
    tw(fadeRise(scene, sub, { delay: D.base + 280 }))
  }

  // ── State: fetch error — quiet, with RETRY ─────────────────────────────────────────────────
  const showError = (): void => {
    const b = newBody()
    youRow = null
    youGlow = null
    const suit = scene.add.image(0, -140, 'suitDiamond').setDisplaySize(120, 120).setAlpha(0.28)
    b.add(suit)
    tw(popIn(scene, suit, { from: 0.6, delay: D.base, overshoot: OVERSHOOT.gentle }))
    const head = scene.add
      .text(0, -20, 'can’t reach the race right now', { fontFamily: FONT, fontSize: '28px', fontStyle: '900', color: T.inkSoft })
      .setOrigin(0.5)
    const sub = scene.add
      .text(0, 32, 'your best still counts — it syncs when you’re back.', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '21px',
        color: T.inkFaint,
        align: 'center',
        wordWrap: { width: CARD_W - 140 },
      })
      .setOrigin(0.5)
    b.add([head, sub])
    tw(fadeRise(scene, head, { delay: D.base + 60 }))
    tw(fadeRise(scene, sub, { delay: D.base + 120 }))
    const retry = addPillButton(scene, 0, 140, 240, 72, 'RETRY', GHOST_PILL, () => load())
    b.add(retry)
    tw(fadeRise(scene, retry, { delay: D.base + 180 }))
  }

  // ── Resolve: override → instant board; signed out → invite; otherwise fetch with patience ──
  const load = (): void => {
    showLoading()
    const timeout = new Promise<'timeout'>(resolve => {
      scene.time.delayedCall(FETCH_PATIENCE, () => resolve('timeout'))
    })
    // The crown row's champion rides the same patience window as the board (both never throw and
    // resolve null/empty when dormant), so the card composes ONCE with everything it will show.
    void Promise.race([Promise.all([fetchWeeklyBoard(25), fetchChampion(previousWeekKey())]), timeout])
      .then(result => {
        if (!alive) return
        if (result === 'timeout') showError()
        else if (result[0].entries.length > 0) showBoard(result[0], result[1])
        else showEmpty()
      })
      .catch(() => {
        if (alive) showError() // fetchWeeklyBoard never throws; this guards the race plumbing itself
      })
  }

  if (opts.boardOverride) {
    if (opts.boardOverride.entries.length > 0) showBoard(opts.boardOverride, opts.championOverride ?? null)
    else showEmpty()
  } else if (opts.simulate === 'loading') {
    showLoading() // DEV: held forever, so the shimmer can be inspected/screenshotted
  } else if (opts.simulate === 'error') {
    showError()
  } else if (!cloudSession()) {
    showSignedOut() // dormant/signed-out is knowable synchronously — no loading flicker
  } else {
    load()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The Home WEEKLY RACE module — the full-width block that seats the ENDLESS play pill over a live
// standings line ("this week · #R of M · best N"), replacing the v1 trophy chip. One baked cream
// plate (cards stay light on every theme) so the race reads as a first-class destination on Home.
// ─────────────────────────────────────────────────────────────────────────────

/** Module plate geometry (design px) — full-width like the overlay cards (40px side gutters). */
const MODULE_W = 640
const MODULE_H = 132

/** Bake the module's cream plate: soft down-cast shadow + gloss bands + gold bezel (+ dark rim). */
function ensureModulePlate(scene: Phaser.Scene): string {
  const key = `race:module:${getTheme().id}:${MODULE_W}x${MODULE_H}`
  if (scene.textures.exists(key)) return key
  const T = getTheme()
  const g = scene.make.graphics({ x: 0, y: 0 }, false)
  const x = PAD
  const y = PAD
  const r = 26
  for (let i = 3; i >= 1; i--) {
    g.fillStyle(T.shadow, 0.07)
    g.fillRoundedRect(x, y + i * 2, MODULE_W, MODULE_H, r)
  }
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(x, y, MODULE_W, MODULE_H, r)
  // Top-lit gloss — the same falling-height highlight bands the button caps and row plates use.
  for (let i = 0; i < 3; i++) {
    const bh = MODULE_H * (0.42 - i * 0.12)
    if (bh < 3) break
    g.fillStyle(T.glossHi, 0.16)
    g.fillRoundedRect(x + 4, y + 2, MODULE_W - 8, bh, Math.min(r - 2, bh / 2))
  }
  g.lineStyle(3, T.goldBezel, 1)
  g.strokeRoundedRect(x, y, MODULE_W, MODULE_H, r)
  if (isDarkWash(T)) {
    g.fillStyle(T.accent, 0.8)
    g.fillRoundedRect(x + r, y + 3, MODULE_W - r * 2, 2, 1)
  }
  g.generateTexture(key, MODULE_W + PAD * 2, MODULE_H + PAD * 2)
  g.destroy()
  return key
}

// Module-level standings cache: the last live board summary, so a return to Home paints the live
// line instantly and a fetch only refreshes it. Keyed by week — a rolled-over week falls back.
interface RaceLineData {
  week: string
  myRank: number | null
  myScore: number | null
  /** Players on this week's board (the fetched top rows — the whole board at friends scale). */
  total: number
}
let raceLineCache: RaceLineData | null = null

/** DEV: seed the standings-line cache with a deterministic fixture (`?raceline=<variant>`). */
export function devSeedRaceLine(variant: string | null): void {
  const wk = weekKey()
  if (variant === 'out') raceLineCache = { week: wk, myRank: 14, myScore: 1310, total: 25 }
  else if (variant === 'new') raceLineCache = { week: wk, myRank: null, myScore: null, total: 7 }
  else raceLineCache = { week: wk, myRank: 3, myScore: 7300, total: 12 }
}

/**
 * The live standings line — `🏆 this week · #R of M · best N ›` — and the WHOLE line is a
 * pressable that opens the WEEKLY RACE panel. Paints from the module cache instantly, refreshes
 * from `fetchWeeklyBoard` when signed in, and falls back to the save-local line (best this week /
 * "set the pace") when offline, dormant or the board is still empty — never blank, never a spinner.
 */
function addWeeklyRaceLine(scene: Phaser.Scene, x: number, y: number, save: SaveData): Phaser.GameObjects.Container {
  const T = getTheme()
  const still = prefersReducedMotion()
  const container = scene.add.container(x, y)
  const line = scene.add
    .text(0, 0, '', { fontFamily: FONT, fontSize: '20px', fontStyle: '900', color: T.inkSoft })
    .setOrigin(0.5)
  container.add(line)

  const setLine = (data: RaceLineData | null): void => {
    let mid: string
    if (data && data.myRank !== null) {
      const total = Math.max(data.total, data.myRank)
      const best = data.myScore !== null ? ` · best ${data.myScore.toLocaleString()}` : ''
      mid = `this week · #${data.myRank} of ${total}${best}`
    } else if (data && data.total > 0) {
      mid = `this week · ${data.total} racing · set the pace`
    } else {
      // Offline / dormant / empty board — the save-local line the module replaced (never blank).
      const wkBest = endlessBestThisWeek(save)
      mid = wkBest > 0 ? `this week’s board · best ${wkBest.toLocaleString()}` : `new weekly board · set the pace`
    }
    line.setText(`🏆  ${mid}  ›`)
  }
  setLine(raceLineCache && raceLineCache.week === weekKey() ? raceLineCache : null)

  // Refresh from the live board (dormant-safe: fetchWeeklyBoard resolves empty, never throws).
  let alive = true
  container.once(Phaser.GameObjects.Events.DESTROY, () => {
    alive = false
  })
  if (cloudSession()) {
    void fetchWeeklyBoard(25).then(board => {
      if (board.entries.length === 0) return // dormant/empty → keep the fallback line + stale cache
      raceLineCache = { week: board.week, myRank: board.myRank, myScore: board.myScore, total: board.entries.length }
      if (alive) setLine(raceLineCache)
    })
  }

  // The whole line is the tap target (≥44pt tall) → the WEEKLY RACE panel.
  const zone = scene.add
    .rectangle(0, 0, Math.max(300, line.width + 48), 52, 0xffffff, 0.001)
    .setInteractive({ useHandCursor: true })
  container.add(zone)
  zone.on('pointerdown', () => {
    sfx.uiPress()
    if (still) line.setAlpha(0.7)
    else scene.tweens.add({ targets: line, alpha: 0.7, duration: 60, ease: E.press })
  })
  const restore = (): void => {
    scene.tweens.killTweensOf(line)
    line.setAlpha(1)
  }
  zone.on('pointerout', restore)
  zone.on('pointerup', () => {
    restore()
    sfx.uiTap()
    sfx.whoosh() // §E3 B14: the airy sweep partners the panel opening
    openWeeklyRacePanel(scene)
  })
  return container
}

/**
 * Full-width WEEKLY RACE module for Home's ENDLESS block: the baked cream plate, the rose ENDLESS
 * play pill (via `onPlay` — Home owns the navigation), a trophy + "WEEKLY RACE" side dressing, and
 * the live tappable standings line underneath. Returns the container (joins Home's entrance stagger).
 */
export function addWeeklyRaceModule(
  scene: Phaser.Scene,
  cx: number,
  cy: number,
  save: SaveData,
  onPlay: () => void
): Phaser.GameObjects.Container {
  const T = getTheme()
  const still = prefersReducedMotion()
  const container = scene.add.container(cx, cy)
  container.add(scene.add.image(0, 0, ensureModulePlate(scene)))
  // Side dressing flanking the pill: the race's trophy (left) + its name (right), quiet on the plate.
  const trophy = scene.add.text(-232, -24, '🏆', { fontFamily: 'sans-serif', fontSize: '34px' }).setOrigin(0.5)
  container.add(trophy)
  if (!still) {
    // A whisper of life on the trophy — slow hero breathe, phase-free (one tween, killed with the scene).
    scene.tweens.add({ targets: trophy, scale: 1.08, duration: D.breath, yoyo: true, repeat: -1, ease: E.hero })
  }
  container.add(
    scene.add
      .text(232, -24, 'WEEKLY\nRACE', {
        fontFamily: FONT,
        fontSize: '17px',
        fontStyle: '900',
        color: T.goldText,
        align: 'center',
        lineSpacing: 2,
      })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )
  // The rose ENDLESS play pill stays the hero of the block (reparented into the module so the whole
  // block staggers in as one unit — addPillButton's press animates its inner face, so this is safe).
  container.add(addPillButton(scene, 0, -24, 340, 72, 'ENDLESS', ROSE_PILL, onPlay))
  container.add(addWeeklyRaceLine(scene, 0, 40, save))
  return container
}

/**
 * The locked WEEKLY RACE module (unlocked < 30): the same silhouette, dimmed and inert — a quiet
 * signpost ("something is coming right here"), deliberately non-interactive and flourish-free.
 */
export function addWeeklyRaceLockedModule(scene: Phaser.Scene, cx: number, cy: number): Phaser.GameObjects.Container {
  const T = getTheme()
  const container = scene.add.container(cx, cy)
  container.add(scene.add.image(0, 0, ensureModulePlate(scene)).setAlpha(0.5))
  const lock = scene.textures.exists('lock')
    ? scene.add.image(-168, 0, 'lock').setDisplaySize(30, 37).setAlpha(0.5)
    : scene.add.text(-168, 0, '🔒', { fontFamily: 'sans-serif', fontSize: '30px' }).setOrigin(0.5).setAlpha(0.5)
  container.add(lock)
  container.add(
    scene.add
      .text(16, -16, 'WEEKLY RACE', { fontFamily: FONT, fontSize: '26px', fontStyle: '900', color: T.inkFaint })
      .setOrigin(0.5)
      .setLetterSpacing(2)
      .setAlpha(0.8)
  )
  container.add(
    scene.add
      .text(16, 20, 'unlocks at level 30', { fontFamily: 'Arial, sans-serif', fontSize: '19px', color: T.inkFaint })
      .setOrigin(0.5)
      .setAlpha(0.8)
  )
  return container
}

// ─────────────────────────────────────────────────────────────────────────────
// DEV fixtures — deterministic boards for the `?race=<variant>` Home param, screenshots + audits.
// Names are invented handles (email local-part flavoured); nothing here ships to players (the Home
// call site is import.meta.env.DEV-gated, mirroring `?help`).
// ─────────────────────────────────────────────────────────────────────────────

/** Build a fake ranked board: `youAt` marks a visible row as you; `myRank`/`myScore` place you outside. */
function fixtureBoard(youAt: number | null, myRank: number | null, myScore: number | null): WeeklyBoard {
  const names = [
    'goldrush', 'chipqueen', 'lucky.lou', 'marisol', 'austin', 'sunburst',
    'cardshark', 'bellhop', 'renotwin', 'dulce', 'k-money', 'peachy',
  ]
  const entries: LeaderboardEntry[] = names.map((name, i) => ({
    rank: i + 1,
    name,
    score: 9840 - i * 520 - (i * i) % 97, // descending with a little organic wobble
    you: youAt !== null && i + 1 === youAt,
  }))
  const mine = entries.find(e => e.you)
  return {
    week: weekKey(),
    entries,
    myRank: mine ? mine.rank : myRank,
    myScore: mine ? mine.score : myScore,
  }
}

/** A deterministic last-week champion for the crown-row fixtures. */
function fixtureChampion(you: boolean): Champion {
  return { week: previousWeekKey(), name: you ? 'austin' : 'marisol', score: 11240, you }
}

/**
 * Map a `?race=<variant>` value to panel opts (DEV only). '' / unknown → live data path.
 *   rich     → 12 names, you at #5, last week's champion crown row (someone else)
 *   crownyou → 12 names, you at #2 — and YOU are last week's champion (gold crown row + row crown)
 *   out      → 12 names, you at #14 (the pinned "your rank" footer), crown row present
 *   empty    → a played-but-empty week ("be the first")
 *   loading  → the shimmer, held forever
 *   error    → the quiet RETRY card
 */
export function devRaceOpts(variant: string | null): WeeklyRacePanelOpts {
  switch (variant) {
    case 'rich':
      return { boardOverride: fixtureBoard(5, null, null), championOverride: fixtureChampion(false) }
    case 'crownyou':
      return { boardOverride: fixtureBoard(2, null, null), championOverride: fixtureChampion(true) }
    case 'out':
      return { boardOverride: fixtureBoard(null, 14, 1310), championOverride: fixtureChampion(false) }
    case 'empty':
      return { boardOverride: { week: weekKey(), entries: [], myRank: null, myScore: null } }
    case 'loading':
      return { simulate: 'loading' }
    case 'error':
      return { simulate: 'error' }
    default:
      return {}
  }
}

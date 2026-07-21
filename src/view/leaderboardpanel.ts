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
import { weekKey } from '../core/endless'
import { fetchWeeklyBoard } from '../core/leaderboard'
import type { LeaderboardEntry, WeeklyBoard } from '../core/leaderboard'
import { openCloudModal } from './cloudmodal'
import { D, E, OVERSHOOT, backOut, fadeRise, heartbeat, popIn } from './motion'
import { quality } from './quality'
import { getTheme, hapticsOff, prefersReducedMotion, reduceFlashing } from './theme'
import type { Theme } from './theme'
import { FONT, GHOST_PILL, GOLD_PILL, addPillButton, goldFace } from './ui'

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
  /** DEV/testing hook: hold the loading shimmer forever, or open straight onto the error card. */
  simulate?: 'loading' | 'error'
}

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

/** Rank medallion: a small gold coin with the rank numeral — #1 gets the full gold material. */
function makeMedal(scene: Phaser.Scene, rank: number, r: number): Phaser.GameObjects.Container {
  const T = getTheme()
  const c = scene.add.container(0, 0)
  const g = scene.add.graphics()
  // Coin: deep ring → face → top-biased gloss arc. #1 is bright gold; 2/3 are quieter cream-gold.
  g.fillStyle(T.goldDarkest, rank === 1 ? 0.5 : 0.3)
  g.fillCircle(0, 2.5, r)
  g.fillStyle(rank === 1 ? T.gold : T.cardFillWarm, 1)
  g.fillCircle(0, 0, r)
  g.fillStyle(rank === 1 ? T.goldBright : T.glossHi, rank === 1 ? 0.45 : 0.5)
  g.fillCircle(0, -r * 0.22, r * 0.74)
  g.lineStyle(2.5, rank === 1 ? T.goldDeep : T.goldBezel, 1)
  g.strokeCircle(0, 0, r)
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

  cardRoot.add(addPillButton(scene, 0, CARD_H / 2 - 70, 240, 68, 'CLOSE', GOLD_PILL, close))

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
    // Insert under the CLOSE pill so a landing row can never paint over the button.
    cardRoot.addAt(body, cardRoot.length - 1)
    return body
  }
  // The panel closing must also stop body tweens + the heartbeat tick (targets die with the layer).
  layer.once(Phaser.GameObjects.Events.DESTROY, clearBody)

  // The player's own row + halo, captured during buildRow for the heartbeat breathe.
  let youRow: Phaser.GameObjects.Container | null = null
  let youGlow: Phaser.GameObjects.Image | null = null

  // ── State: the ranked board ────────────────────────────────────────────────────────────────
  const showBoard = (board: WeeklyBoard): void => {
    const b = newBody()
    setWeek(board.week)
    const fancy = !still && quality.tier() !== 'low'

    // Does the player's own row land inside the visible rows, or does the footer carry it?
    const footerNeeded = board.myRank !== null && !board.entries.slice(0, 10).some(e => e.you)
    const plainMax = footerNeeded ? 6 : 7 // ranks 4..9 with a footer, 4..10 without
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
      tw(fadeRise(scene, row, { rise: pod ? 16 : 12, delay, duration: D.settle }))
      if (pod && fancy) {
        row.setScale(0.86)
        tw(
          scene.tweens.add({
            targets: row,
            scale: 1,
            duration: D.pop,
            delay,
            ease: backOut(i === 0 ? OVERSHOOT.pop : OVERSHOOT.release),
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
      tw(fadeRise(scene, foot, { delay: D.base + rows.length * 45 + 80 }))
      youRow = youRow ?? foot // outside the top rows the FOOTER is "you" — it carries the breathe
    }

    // Own-row heartbeat breathe: one shared-clock read per frame, phase-locked with every hero
    // breather in the app. Skipped under reduced motion (halo already rests at a static warm alpha).
    if (youRow && !still) {
      const target = youRow
      const halo = youGlow
      bodyTick = (): void => {
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
    void Promise.race([fetchWeeklyBoard(25), timeout])
      .then(result => {
        if (!alive) return
        if (result === 'timeout') showError()
        else if (result.entries.length > 0) showBoard(result)
        else showEmpty()
      })
      .catch(() => {
        if (alive) showError() // fetchWeeklyBoard never throws; this guards the race plumbing itself
      })
  }

  if (opts.boardOverride) {
    if (opts.boardOverride.entries.length > 0) showBoard(opts.boardOverride)
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
// The Home entry chip — a compact trophy medallion seated beside the ENDLESS row.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact trophy chip that opens the weekly-race panel. Speaks the pressable dialect (sink on
 * press, spring back with the calibrated release overshoot, a masked release-shine) on a bespoke
 * round medallion bake — rose-on-gold so it reads as the ENDLESS row's satellite. The plate is
 * baked once per (theme, size) and the glyph rides the sinking face, exactly like ui.ts caps.
 */
export function addWeeklyRaceChip(scene: Phaser.Scene, x: number, y: number, size = 62): Phaser.GameObjects.Container {
  const T = getTheme()
  const still = prefersReducedMotion()
  const r = size / 2

  // Bake the medallion plate: contact shadow → gold coin ring → rose face → top gloss.
  const key = `race:chip:${T.id}:${size}`
  if (!scene.textures.exists(key)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false)
    const c = r + PAD
    for (let i = 2; i >= 1; i--) {
      g.fillStyle(T.shadow, 0.09)
      g.fillCircle(c, c + i * 1.5, r)
    }
    g.fillStyle(T.goldDeep, 1)
    g.fillCircle(c, c, r)
    g.fillStyle(T.roseDeep, 1)
    g.fillCircle(c, c, r - 3.5)
    g.fillStyle(T.rose, 1)
    g.fillCircle(c, c - 1.5, r - 5)
    g.fillStyle(T.roseLight, 0.4)
    g.fillCircle(c, c - r * 0.28, r * 0.62)
    g.lineStyle(2.5, T.goldBezel, 1)
    g.strokeCircle(c, c, r - 1)
    g.generateTexture(key, size + PAD * 2, size + PAD * 2)
    g.destroy()
  }

  const container = scene.add.container(x, y)
  // Soft rose halo so the chip carries a whisper of the race's colour even at rest.
  if (scene.textures.exists('bgglow')) {
    const halo = scene.add
      .image(0, 0, 'bgglow')
      .setDisplaySize(size * 2.1, size * 2.1)
      .setTint(T.rose)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.16)
    container.add(halo)
    if (!still) {
      scene.tweens.add({ targets: halo, alpha: 0.28, duration: D.breath, yoyo: true, repeat: -1, ease: E.hero })
    }
  }
  // The face container sinks on press (plate + glyph together), mirroring buildPressable's grammar.
  const face = scene.add.container(0, 0)
  const plate = scene.add.image(0, 0, key)
  face.add(plate)
  face.add(scene.add.text(0, 1, '🏆', { fontFamily: 'sans-serif', fontSize: `${Math.round(size * 0.46)}px` }).setOrigin(0.5))
  container.add(face)

  // ≥44pt hit target (84 design px — the ui.ts MIN_HIT floor) without growing the art.
  const zone = scene.add.rectangle(0, 0, 84, 84, 0xffffff, 0.001).setInteractive({ useHandCursor: true })
  container.add(zone)

  const fancy = !still && quality.tier() !== 'low'
  let pressTween: Phaser.Tweens.Tween | undefined
  const seat = (toY: number, s: number, dur: number, ease: string | ((v: number) => number)): void => {
    pressTween?.stop()
    if (still) {
      face.setY(toY).setScale(s)
      return
    }
    pressTween = scene.tweens.add({ targets: face, y: toY, scale: s, duration: dur, ease })
  }
  zone.on('pointerdown', () => {
    sfx.uiPress()
    // §E14 haptic unify: the same tiny guarded tap ui.ts pressables give (haptics-off + API-absent safe).
    try {
      if (!hapticsOff() && 'vibrate' in navigator) navigator.vibrate?.(8)
    } catch {
      // no Vibration API — silent no-op
    }
    seat(2, 0.93, 60, E.press)
    if (fancy) {
      // Tap flash — the plate's own silhouette flaring for a beat (the pressables' acknowledgement).
      const flash = scene.add.image(0, 0, key).setTint(0xffffff).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.35)
      face.add(flash)
      scene.tweens.add({ targets: flash, alpha: 0, duration: 260, ease: E.press, onComplete: () => flash.destroy() })
    }
  })
  const rise = (): void => seat(0, 1, 220, still ? 'Back.easeOut' : backOut(OVERSHOOT.release))
  zone.on('pointerout', rise)
  zone.on('pointerup', () => {
    rise()
    if (fancy && scene.textures.exists('sweep')) {
      // Release shine gliding across the medallion, masked to its exact circle.
      const streakW = Math.max(20, size * 0.34)
      const shine = scene.add
        .image(-size / 2 - streakW, 0, 'sweep')
        .setDisplaySize(streakW, size * 1.4)
        .setAngle(14)
        .setTint(0xffffff)
        .setAlpha(0.7)
        .setBlendMode(Phaser.BlendModes.ADD)
      shine.setMask(plate.createBitmapMask())
      face.add(shine)
      scene.tweens.add({
        targets: shine,
        x: size / 2 + streakW,
        duration: 340,
        ease: E.arc,
        onComplete: () => {
          shine.clearMask(true)
          shine.destroy()
        },
      })
    }
    sfx.uiTap()
    sfx.whoosh() // §E3 B14: the airy sweep partners the panel opening
    openWeeklyRacePanel(scene)
  })

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

/**
 * Map a `?race=<variant>` value to panel opts (DEV only). '' / unknown → live data path.
 *   rich    → 12 names, you at #5 (highlight inside the list)
 *   out     → 12 names, you at #14 (the pinned "your rank" footer)
 *   empty   → a played-but-empty week ("be the first")
 *   loading → the shimmer, held forever
 *   error   → the quiet RETRY card
 */
export function devRaceOpts(variant: string | null): WeeklyRacePanelOpts {
  switch (variant) {
    case 'rich':
      return { boardOverride: fixtureBoard(5, null, null) }
    case 'out':
      return { boardOverride: fixtureBoard(null, 14, 1310) }
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

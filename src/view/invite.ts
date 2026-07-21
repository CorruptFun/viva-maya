import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W } from '../config'
import { cloudSession } from '../core/cloud'
import {
  REFEREE_CHIPS,
  REFERRAL_CAP,
  REFERRER_CHIPS,
  claimWelcome,
  fetchMyReferralStats,
  isWelcomePending,
  mintMyCode,
} from '../core/referrals'
import { loadSave } from '../core/save'
import { D, E, OVERSHOOT, breathe, popIn } from './motion'
import { quality } from './quality'
import { css, getTheme, prefersReducedMotion, reduceFlashing } from './theme'
import { FONT, ROSE_PILL, addPillButton } from './ui'

/**
 * Invite & welcome UI (growth phase) — the presentation layer over core/referrals.ts.
 *
 *   - `addInviteCard`   → the rose-accent INVITE FRIENDS row the Gift Store seats above its
 *     purchasables (this row EARNS chips, so it leads the shelf). Handles the whole lifecycle:
 *     signed-out ("sign in to invite"), minting shimmer, minted code + SHARE, and the stats line.
 *   - `maybeShowWelcome` → the referee-side welcome moment ("welcome gift · +150"): checks the
 *     pending latch, claims, and plays a celebration toast + chip-fly into the caller's balance
 *     pill. Exported scene-agnostically so Home/LevelSelect can host the same beat later.
 *
 * Contract notes:
 *   - All cloud reads ride core/referrals.ts' dormant contract — every async resolution re-checks
 *     that its display objects are still alive, so a scene switch mid-fetch can never throw.
 *   - Every tween collapses instantly under prefersReducedMotion(); the celebration's bloom obeys
 *     reduceFlashing() (soft swell variant) and the quality governor.
 */

// Card geometry — mirrors StoreScene's shelf frame so the row reads as part of the same stack.
const CARD_X = 36
const CARD_W = 648
/** Design-space height of the invite card (StoreScene uses this to seat the shelf below). */
export const INVITE_CARD_H = 152

// ---------------------------------------------------------------------------- DEV fixture
/** Forced UI states for screenshots/audits via `?invite=<mode>` (DEV builds only). */
export type InviteFixtureMode = 'in' | 'minting' | 'welcome'

/**
 * Read the `?invite=` DEV fixture (mirrors leaderboardpanel's `?race=` fixtures — the call sites
 * are gated on import.meta.env.DEV here, so nothing ships to players):
 *   in      → mocked signed-in: an instant code + stats, no cloud
 *   minting → mocked signed-in, code held in the "..." shimmer forever
 *   welcome → force the welcome-pending gate (the local claim/grant path stays REAL)
 */
export function inviteFixture(): InviteFixtureMode | null {
  if (!import.meta.env.DEV) return null
  const v = new URLSearchParams(location.search).get('invite')
  return v === 'in' || v === 'minting' || v === 'welcome' ? v : null
}

// ---------------------------------------------------------------------------- share flow
/** Invite link carrying `?ref=CODE` — the exact param core/referrals.ts captureRefFromUrl reads. */
function inviteUrl(code: string): string {
  return `${location.origin}${location.pathname}?ref=${code}`
}

function inviteMessage(code: string): string {
  return `Come play Viva Ton with me! Use my code ${code} and we both win chips 💛`
}

/**
 * SHARE tap: native share sheet where the platform has one, clipboard fallback ("copied!")
 * elsewhere, and a plain code read-back toast when even the clipboard is blocked. Never throws.
 */
function shareInvite(code: string, toast: (msg: string) => void): void {
  const text = inviteMessage(code)
  const url = inviteUrl(code)
  const copyFallback = (): void => {
    const payload = `${text}\n${url}`
    try {
      const clip = navigator.clipboard
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(payload).then(
          () => toast('invite copied — send it to a friend!'),
          () => toast(`your code: ${code}`)
        )
      } else {
        toast(`your code: ${code}`)
      }
    } catch {
      toast(`your code: ${code}`)
    }
  }
  try {
    if (typeof navigator.share === 'function') {
      navigator.share({ title: 'Viva Ton', text, url }).catch((e: unknown) => {
        // AbortError = the player closed the sheet — that's a choice, not a failure; stay quiet.
        if ((e as { name?: string } | null)?.name !== 'AbortError') copyFallback()
      })
    } else {
      copyFallback()
    }
  } catch {
    copyFallback()
  }
}

// ---------------------------------------------------------------------------- invite card
export interface InviteCardOpts {
  /** Toast surface (the Store passes its own, so feedback matches the shelf's voice). */
  toast: (msg: string) => void
}

/**
 * Draw the referral-code ticket into `g`: an EMBOSSED raffle ticket — a recessed rose code well with a
 * directional bevel (a lit cream lip along top+left, a roseDeep shadow along bottom+right) and PUNCHED
 * PERFORATION notches bitten (in the card's own fill) down both short ends, so it reads torn-from-a-
 * strip. The bites are painted LAST in T.cardFill so they punch clean holes in the rose field + border
 * (a real cut, not a dot under a line) — which is why the well sits on the cream card. Drawn from an
 * absolute (x,y); the caller lays the BIG code Text over the centre. `signedIn` dims the inert
 * signed-out state. Exported so the dev atlas ('ticket' page) renders the real ticket, no drift.
 */
export function drawCodeTicket(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  signedIn: boolean
): void {
  const T = getTheme()
  const on = signedIn
  const r = 14
  const rgt = x + w
  const bot = y + h
  const cy = y + h / 2
  // Recessed rose WELL pressed into the cream card.
  g.fillStyle(T.rose, on ? 0.14 : 0.07)
  g.fillRoundedRect(x, y, w, h, r)
  // Concave inner-shadow across the TOP of the well — the code sits engraved below the lip.
  g.fillStyle(T.roseDeep, on ? 0.12 : 0.06)
  g.fillRoundedRect(x + 3, y + 3, w - 6, 15, 10)
  // Faint gloss sweep across the upper half unifies the plate.
  g.fillStyle(0xffffff, on ? 0.06 : 0.04)
  g.fillEllipse(x + w / 2, y + 14, w - 44, 15)
  // Directional emboss bevel: lit cream lip along top + left, roseDeep shadow along bottom + right.
  g.lineStyle(2, T.rim, on ? 0.6 : 0.32)
  g.lineBetween(x + r, y + 2, rgt - r, y + 2)
  g.lineBetween(x + 2, y + r, x + 2, bot - r)
  g.lineStyle(2, T.roseDeep, on ? 0.5 : 0.26)
  g.lineBetween(x + r, bot - 2, rgt - r, bot - 2)
  g.lineBetween(rgt - 2, y + r, rgt - 2, bot - r)
  // Crisp outer rose border — keeps the shipped silhouette.
  g.lineStyle(2, T.rose, on ? 0.45 : 0.22)
  g.strokeRoundedRect(x, y, w, h, r)
  // PUNCHED PERFORATION — card-fill half-circle bites centred ON each short edge. Drawn LAST so they
  // punch a clean gap in the rose field + border (the cream card showing through), reading torn-away.
  const perfR = 5
  const bites = [y + 12, cy, bot - 12]
  g.fillStyle(T.cardFill, 1)
  for (const ny of bites) {
    g.fillCircle(x, ny, perfR)
    g.fillCircle(rgt, ny, perfR)
  }
}

/**
 * The INVITE FRIENDS row — a rose-accent card (ribbon + bezel + rose SHARE pill) that sits ABOVE
 * the purchasables: buying costs chips, inviting EARNS them. Children use absolute coords inside a
 * container resting at (0,0), exactly like StoreScene's boostRow, so the store's entrance stagger
 * moves it as one unit. Returns the container.
 *
 * States (resolved live, never blocking the paint):
 *   signed out → "sign in to invite" in the ticket, SHARE dimmed inert
 *   minting    → "· · ·" shimmer in the ticket until mintMyCode resolves, then the code pops in
 *   minted     → code displayed big; SHARE opens the share sheet / clipboard fallback
 */
export function addInviteCard(
  scene: Phaser.Scene,
  top: number,
  opts: InviteCardOpts
): Phaser.GameObjects.Container {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const fix = inviteFixture()
  const mocked = fix === 'in' || fix === 'minting'
  const signedIn = mocked || cloudSession() !== null
  const y0 = top
  const card = scene.add.container(0, 0)

  // Frame: the shelf's cream card + soft shadow, but with a ROSE bezel and a left rose ribbon —
  // the "this one pays YOU" accent that sets it apart from the gold buy rows below.
  const g = scene.add.graphics()
  g.fillStyle(T.shadow, 0.16)
  g.fillRoundedRect(CARD_X + 3, y0 + 6, CARD_W, INVITE_CARD_H, 24)
  g.fillStyle(T.cardFill, 1)
  g.fillRoundedRect(CARD_X, y0, CARD_W, INVITE_CARD_H, 24)
  g.lineStyle(2.5, T.rose, 0.9)
  g.strokeRoundedRect(CARD_X, y0, CARD_W, INVITE_CARD_H, 24)
  g.fillStyle(T.rose, 0.92)
  g.fillRoundedRect(CARD_X, y0, 12, INVITE_CARD_H, { tl: 24, bl: 24, tr: 0, br: 0 })
  card.add(g)

  // Heart mark — a soft rose glow under a gently breathing heart (breathe() is reduced-motion
  // aware). The one bit of idle life on the card: an invitation, not a price tag.
  if (scene.textures.exists('heartglow')) {
    const glow = scene.add
      .image(88, y0 + 52, 'heartglow')
      .setDisplaySize(84, 84)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(T.roseLight)
      .setAlpha(0.5)
    card.add(glow)
    if (!reduced) {
      scene.tweens.add({
        targets: glow,
        alpha: 0.72,
        duration: D.breath,
        yoyo: true,
        repeat: -1,
        ease: E.hero,
      })
    }
  }
  const heart = scene.add.image(88, y0 + 52, 'heart').setDisplaySize(46, 46)
  card.add(heart)
  breathe(scene, heart, { amount: 0.08, duration: D.breath })

  // Header: title in rose, tail in ink — one line, two voices.
  const title = scene.add
    .text(128, y0 + 20, 'INVITE FRIENDS', { fontFamily: FONT, fontSize: '25px', fontStyle: '900', color: css(T.rose) })
    .setOrigin(0, 0)
  card.add(title)
  card.add(
    scene.add
      .text(128 + title.width + 12, y0 + 27, '— you both win', {
        fontFamily: 'Arial, sans-serif',
        fontSize: '17px',
        fontStyle: 'bold',
        color: T.inkSoft,
      })
      .setOrigin(0, 0)
  )
  card.add(
    scene.add
      .text(128, y0 + 52, `friend gets ${REFEREE_CHIPS} · you get ${REFERRER_CHIPS} + full hearts`, {
        fontFamily: 'Arial, sans-serif',
        fontSize: '16px',
        color: T.inkSoft,
      })
      .setOrigin(0, 0)
  )

  // Code ticket — the code displayed BIG in an embossed raffle ticket (rose well + punched perforation
  // notches, drawCodeTicket). Holds the shimmer while minting, or the signed-out invitation.
  const ticket = scene.add.graphics()
  drawCodeTicket(ticket, 128, y0 + 82, 240, 48, signedIn)
  card.add(ticket)
  const codeText = scene.add
    .text(248, y0 + 107, '', { fontFamily: FONT, fontSize: '30px', fontStyle: '900', color: css(T.roseDeep) })
    .setOrigin(0.5)
    .setLetterSpacing(6)
  card.add(codeText)

  // Stats line — "N of 20 friends joined"; filled in when the fetch lands, hidden until then.
  const stats = scene.add
    .text(128, y0 + 141, '', { fontFamily: 'Arial, sans-serif', fontSize: '13px', color: T.inkFaint })
    .setOrigin(0, 0.5)
  card.add(stats)

  let code: string | null = null
  let shimmer: Phaser.Tweens.Tween | null = null

  const showCode = (c: string): void => {
    if (!codeText.active) return // the scene moved on while the mint was in flight
    code = c
    shimmer?.stop()
    shimmer = null
    codeText.setText(c).setAlpha(1).setFontSize(30).setColor(css(T.roseDeep))
    // The minted code lands with a little spring — the moment the card becomes shareable.
    popIn(scene, codeText, { from: 0.75, overshoot: OVERSHOOT.gentle })
  }

  if (!signedIn) {
    // Graceful signed-out state: a quiet invitation into the cloud flow, everything else dimmed.
    codeText.setText('sign in to invite').setFontSize(17).setColor(T.inkMuted).setLetterSpacing(0)
  } else {
    // "..." shimmer while minting — a slow alpha breath (static mid-alpha under reduced motion).
    codeText.setText('· · ·').setAlpha(reduced ? 0.6 : 0.35)
    if (!reduced) {
      shimmer = scene.tweens.add({
        targets: codeText,
        alpha: 0.9,
        duration: 560,
        yoyo: true,
        repeat: -1,
        ease: E.hero,
      })
    }
    if (fix === 'in') {
      showCode('MAYA7K')
      stats.setText(`3 of ${REFERRAL_CAP} friends joined`)
    } else if (fix !== 'minting') {
      void mintMyCode().then(c => {
        if (c) showCode(c)
        else if (codeText.active && !mocked) {
          // Mint unavailable (offline / dormant) — rest the shimmer on a soft retry hint.
          shimmer?.stop()
          shimmer = null
          codeText.setText('code unavailable — try later').setFontSize(15).setColor(T.inkMuted).setLetterSpacing(0).setAlpha(1)
        }
      })
      void fetchMyReferralStats().then(s => {
        if (s && stats.active) stats.setText(`${s.invited} of ${s.cap} friends joined`)
      })
    }
  }

  // SHARE — the standard rose pressable (press sink/flash/shine all come from buildPressable).
  // Dimmed + inert while signed out; while minting it answers with a patient toast instead.
  const share = addPillButton(
    scene,
    568,
    y0 + 106,
    150,
    58,
    'SHARE',
    ROSE_PILL,
    () => {
      if (code) shareInvite(code, opts.toast)
      else opts.toast('one sec — minting your code…')
    },
    signedIn ? {} : { disabled: true }
  )
  card.add(share)

  return card
}

// ---------------------------------------------------------------------------- welcome moment
export interface WelcomeOpts {
  /** Where the balance pill lives — the chip-fly's landing pad. */
  balanceX: number
  balanceY: number
  /** Called with the NEW chip balance when the grant should show (chips landed / instant path). */
  onBalance: (chips: number) => void
  /** Extra ms before the celebration begins (let a scene's entrance settle). Default 0. */
  delay?: number
}

/**
 * Referee-side welcome moment, exported for any scene: if the one-time welcome grant is pending
 * (referral qualified + latch unclaimed), claim it and play the celebration — a rose toast card
 * ("WELCOME GIFT · +150"), a governor-scaled sparkle, then chips flying into the balance pill
 * (the Store's chip-fly language). Reduced motion: instant toast, instant balance. Never throws;
 * no-ops when dormant. The `?invite=welcome` DEV fixture forces the gate (the grant stays real).
 */
export function maybeShowWelcome(scene: Phaser.Scene, opts: WelcomeOpts): void {
  // Liveness via the shutdown event, not sys.isActive(): this is typically called from create(),
  // where the scene's status is still CREATING (isActive() is false until the first update).
  let gone = false
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    gone = true
  })
  void (async () => {
    try {
      const save = loadSave()
      const pending =
        inviteFixture() === 'welcome' ? !save.referralWelcomeClaimed : await isWelcomePending(save)
      if (!pending || gone) return
      const chips = claimWelcome()
      if (chips === null) return // raced another scene's claim — the latch held, nothing owed
      const start = (): void => playWelcome(scene, chips, opts)
      const wait = opts.delay ?? 0
      if (wait > 0 && !prefersReducedMotion()) scene.time.delayedCall(wait, start)
      else start()
    } catch {
      // celebration is best-effort — the grant (if it happened) rides the save regardless
    }
  })()
}

/** Build + choreograph the welcome toast. The grant has already landed; this is pure spectacle. */
function playWelcome(scene: Phaser.Scene, newBalance: number, opts: WelcomeOpts): void {
  const T = getTheme()
  const reduced = prefersReducedMotion()
  const W = 396
  const H = 128
  const cx = DESIGN_W / 2
  const cy = 520

  // The toast card: a rose panel (the invite brand colour) with the gift line on it.
  const panel = scene.add.container(cx, cy).setDepth(80)
  const g = scene.add.graphics()
  g.fillStyle(T.shadow, 0.28)
  g.fillRoundedRect(-W / 2 + 4, -H / 2 + 8, W, H, 28)
  g.fillStyle(T.rose, 1)
  g.fillRoundedRect(-W / 2, -H / 2, W, H, 28)
  g.lineStyle(3, T.roseDeep, 1)
  g.strokeRoundedRect(-W / 2, -H / 2, W, H, 28)
  panel.add(g)
  panel.add(scene.add.image(-W / 2 + 52, 0, 'heart').setDisplaySize(44, 44))
  panel.add(
    scene.add
      .text(24, -24, 'welcome gift', { fontFamily: FONT, fontSize: '25px', fontStyle: '900', color: T.onRose })
      .setOrigin(0.5)
      .setLetterSpacing(2)
  )
  panel.add(
    scene.add
      .text(24, 18, `+${REFEREE_CHIPS} chips`, { fontFamily: FONT, fontSize: '34px', fontStyle: '900', color: css(T.goldBright) })
      .setOrigin(0.5)
      .setShadow(0, 2, 'rgba(60,10,20,0.45)', 3, false, true)
  )

  const dispose = (): void => {
    scene.tweens.killTweensOf(panel)
    panel.destroy()
  }

  if (reduced) {
    // Instant path: toast rests in place, balance updates immediately, quiet exit on a timer.
    sfx.lifeRestored()
    opts.onBalance(newBalance)
    scene.time.delayedCall(1600, dispose)
    return
  }

  sfx.lifeRestored()
  popIn(scene, panel, { from: 0.55, overshoot: OVERSHOOT.pop })

  // Arrival bloom: a gold ring flash by default; under reduceFlashing (or on LOW) the soft-swell
  // variant — one gentle scale breath on the panel itself, no additive flare.
  if (!reduceFlashing() && quality.tier() !== 'low') {
    const ring = scene.add
      .image(cx, cy, 'ring')
      .setDisplaySize(120, 120)
      .setTint(T.goldBright)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.85)
      .setDepth(79)
    scene.tweens.add({
      targets: ring,
      scale: ring.scale * 3.4,
      alpha: 0,
      duration: D.pop,
      ease: E.settle,
      onComplete: () => ring.destroy(),
    })
  } else {
    scene.tweens.add({
      targets: panel,
      scale: 1.04,
      delay: D.pop,
      duration: D.settle,
      yoyo: true,
      ease: E.hero,
    })
  }

  // Governor-scaled sparkle around the card — transient emitter, destroys itself.
  const n = quality.count(12)
  if (n > 0 && quality.tier() !== 'low') {
    const spark = scene.add
      .particles(0, 0, 'spark', {
        speed: { min: 90, max: 260 },
        angle: { min: 0, max: 360 },
        scale: { start: 0.5, end: 0 },
        alpha: { start: 0.95, end: 0 },
        lifespan: { min: 320, max: 620 },
        emitting: false,
      })
      .setDepth(81)
    spark.explode(n, cx, cy)
    scene.time.delayedCall(750, () => spark.destroy())
  }

  // The deposit: three chips arc from the toast into the balance pill (the Store's chip-fly
  // language — x glides on the arc ease, y accelerates late, a lazy spin sells the coin), the
  // pill pops on the LAST landing, and a small landing sparkle marks the arrival.
  const flyOne = (i: number, last: boolean): void => {
    // Launch from just BELOW the panel rim (half-height 64) so the coins pour out from under it
    // without ever covering the "+150 chips" line inside.
    const c = scene.add.image(cx + (i - 1) * 44, cy + 72, 'chip').setDisplaySize(40, 40).setDepth(82)
    scene.tweens.add({ targets: c, x: opts.balanceX, duration: 460, ease: E.arc })
    scene.tweens.add({ targets: c, angle: -300, duration: 460, ease: E.settle })
    scene.tweens.add({
      targets: c,
      y: opts.balanceY,
      scale: c.scale * 0.5,
      duration: 460,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        c.destroy()
        if (!last) return
        sfx.coinCount()
        opts.onBalance(newBalance)
        const k = quality.count(8)
        if (k > 0 && quality.tier() !== 'low') {
          const land = scene.add
            .particles(0, 0, 'spark', {
              speed: { min: 60, max: 190 },
              angle: { min: 0, max: 360 },
              scale: { start: 0.4, end: 0 },
              alpha: { start: 0.9, end: 0 },
              lifespan: { min: 280, max: 520 },
              emitting: false,
            })
            .setDepth(66)
          land.explode(k, opts.balanceX, opts.balanceY)
          scene.time.delayedCall(650, () => land.destroy())
        }
      },
    })
  }
  scene.time.delayedCall(820, () => flyOne(0, false))
  scene.time.delayedCall(910, () => flyOne(1, false))
  scene.time.delayedCall(1000, () => flyOne(2, true))

  // Exit: the toast drifts up + fades once the chips are away.
  scene.tweens.add({
    targets: panel,
    y: cy - 26,
    alpha: 0,
    delay: 1650,
    duration: 360,
    ease: E.exit,
    onComplete: dispose,
  })
}

import Phaser from 'phaser'
import { sfx } from '../audio/sfx'
import { DESIGN_W, viewportCenterY } from '../config'
import { EVENTS, track } from '../core/analytics'
import { enablePush, pushOfferFlavour, type PushOfferFlavour } from '../core/push'
import { loadSave, markPushOfferSeen } from '../core/save'
import { backOut, OVERSHOOT } from './motion'
import { addFocusScrim, panelPlate } from './platekit'
import { getTheme, prefersReducedMotion } from './theme'
import { addPillButton, FONT, GHOST_PILL, GOLD_PILL, inkShadow } from './ui'

/**
 * The push opt-in card — ONE card, two sets of words.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Web Push has been fully built since the race went daily (core/push.ts, migrations 0011/0012, the
 * endless-push workflow), and the only door to it was a ghost button three taps deep inside
 * Settings → Cloud & Backup. Nothing in the game ever mentioned it. A feature whose entire job is to
 * call players back cannot be reached only by players who were already coming back — that is the
 * audience it is least needed for.
 *
 * ── Why this is a SOFT ASK, and why that is not a workaround ──────────────────
 * `Notification.requestPermission()` gets exactly one shot per install: a denial is effectively
 * permanent, the browser will not ask twice, and undoing it means digging through site settings.
 * So this card is the question, and the browser's prompt is only ever reached by tapping REMIND ME —
 * an explicit gesture, from someone who has just read what the reminder is for. Firing the real
 * prompt on load would convert worse AND burn the ask on everyone who happened to open the app.
 * That constraint is stated at the top of core/push.ts; this card is what it was asking for.
 *
 * ── Why TWO variants, and why they are not two cards ──────────────────────────
 * The offer is spent once per install, so whichever card a player meets is the only one they will
 * ever see — and it has to describe what THEY would actually receive.
 *  - **race** — NEVER MISS A BOARD, on the Home visit after their first race. The reminder's whole
 *    content is "your board closes soon"; offered to somebody who has just played that exact board,
 *    "want a nudge before tomorrow's closes?" answers itself.
 *  - **daily** — A GIFT EVERY MORNING, for a player who has cleared `PUSH_OFFER_LEVEL_WINS` levels
 *    and never opened the race. The ladder is most of the game and a player can live on it for
 *    weeks, so the race-flavoured card would be a promise about a mode they do not use. What they
 *    would really get is the MORNING nudge (`daily_play`, migration 0025): the day's house gift
 *    named in advance, and their JACKPOT wheel when it comes within reach.
 * ⚠️ Which one is `pushOfferFlavour` in core/push.ts, NOT a condition re-derived here — the same
 * split-brain that dealt every resumed level's board twice (see CLAUDE.md) starts exactly this way,
 * with a view re-answering a question the core already answers. Both variants share the volume
 * promise and the off-switch line VERBATIM, from one constant each, for the same reason.
 *
 * ── Why on HOME, either way ──────────────────────────────────────────────────
 * It rides HomeScene's growth-celebration queue rather than the end-of-run chain, for the same
 * reason the race unlock does: that chain is already jackpot → deal → plinko deep, and a fourth card
 * would bury this one behind celebrations that have nothing to do with it. That holds for the level
 * player too — arriving at Home after a win is the calm beat, not the win screen itself.
 *
 * ⚠️ Never opened when `pushSupport()` isn't 'ready' — the gate is `pushOfferDue` in core/push.ts,
 * which lives there rather than here so it can be tested without booting Phaser. An iPhone in a Safari tab
 * cannot subscribe at all (Apple ships Web Push only in an installed PWA), and spending the one-time
 * latch to tell someone that would mean never offering it once they DO install. That case belongs to
 * the install nudge, which already exists.
 */

/** How long the confirmation sits on screen before the card bows out. */
const CONFIRM_HOLD_MS = 1500

/** One rule row: the glyph in the margin, and the fact it belongs to. */
type Rule = readonly [icon: string, text: string]

/**
 * ⚠️ THE VOLUME PROMISE, AND IT IS A PROMISE THE SENDER HAS TO KEEP. It used to read "One nudge
 * before the board closes — and that is the only one you will ever get", which was true of a game
 * with exactly one notification and became a lie the moment a second kind existed. The volume is
 * genuinely unchanged — scripts/send-push.mjs sends at most one per device per race day, enforced by
 * disjoint audiences and a same-day guard — so the honest edit was to promise the VOLUME rather than
 * the single feature. If a future change cannot keep this sentence true, the change is wrong, not
 * the sentence: everyone who ever tapped REMIND ME did so against it, and a notification permission
 * is the one thing in this game a player cannot give back twice.
 *
 * It is ONE constant shared by both variants rather than a line in each, because it is the one
 * sentence in here that is a commitment rather than a description — two copies of it would drift the
 * first time either card was reworded, and the drift would be invisible until somebody complained.
 */
const VOLUME_RULE: Rule = ['⏰', 'At most one nudge a day — never two, and only when there is something waiting']

/** The objection-handler, likewise shared: "how do I stop it" is the question both audiences ask. */
const OFF_SWITCH_RULE: Rule = ['🔕', 'Switch it off, or pick which kind you get, in Settings']

interface OptInCopy {
  /** Big gold line. */
  title: string
  /** Small letterspaced line under it — the two read as one sentence. */
  subtitle: string
  /**
   * Facts, not features — a player deciding whether to hand over notification permission needs to
   * know exactly what they'd get. The volume line is doing real work: "how often" is the objection,
   * so answer it unasked. Kept to one line of type each; the plate is sized from what these actually
   * wrap to, so a longer one costs a taller card rather than a collision.
   */
  rules: readonly Rule[]
  /** What the ✅ says once they are on the list. Names the thing they will actually receive. */
  confirm: string
}

/**
 * ⚠️ Every sentence here has to be true of what `scripts/send-push.mjs` really sends. The daily
 * variant's two middle lines are its `--drop` slot verbatim in spirit: `messageForDrop` names the
 * day's gift (which it can only do because `core/bonusdrop.ts` seeds the roll from the day alone),
 * and `jackpotMessage` fires when `jackpotWinsAway` says the wheel is within reach — "within reach"
 * is the sender's own phrase, borrowed rather than reinvented so the card and the notification
 * cannot describe the same hook two ways.
 */
const COPY: Record<PushOfferFlavour, OptInCopy> = {
  race: {
    title: 'NEVER MISS',
    subtitle: 'A BOARD',
    rules: [
      VOLUME_RULE,
      ['🎁', 'A new board every day, and a house gift on the cabinet to go with it'],
      OFF_SWITCH_RULE,
    ],
    confirm: 'You are on the list. See you before the board closes.',
  },
  daily: {
    title: 'A GIFT',
    subtitle: 'EVERY MORNING',
    rules: [
      VOLUME_RULE,
      ['🎁', 'The morning gift named before you open it — a new one on the cabinet every day'],
      ['🎰', 'A heads-up when your JACKPOT wheel is within reach — that spin always pays'],
      OFF_SWITCH_RULE,
    ],
    confirm: 'You are on the list. See you in the morning.',
  },
}

/**
 * The `surface` prop both variants report under.
 *
 * ⚠️ A NEW PROP VALUE, NEVER A NEW EVENT NAME. The dashboard's SQL views hardcode the names they
 * chart (`name in (...)` across migrations 0014/0015/0021/0022), so a fresh event name is invisible
 * until a new migration ships — and fails silently — whereas a fresh value on an existing prop rides
 * along for free. `'card'` is the value the race card has reported since it shipped and must not
 * move, or the push funnel loses its own history; the level-player moment gets a sibling of it, so a
 * `surface like 'card%'` still means "the card, either audience" while the two remain separable.
 * Settings is the third door and reports `'settings'` (view/cloudmodal.ts).
 */
const SURFACE: Record<PushOfferFlavour, string> = { race: 'card', daily: 'card_leveler' }

export function openPushOptIn(scene: Phaser.Scene): Promise<void> {
  return new Promise<void>(resolve => {
    const T = getTheme()
    const reduced = prefersReducedMotion()
    const W = DESIGN_W
    const layer = scene.add.container(0, 0).setDepth(64)

    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      // Latched on the way OUT, not on the way in — see markPushOfferSeen. Every exit path runs
      // through here (both pills, the scrim, the auto-close), so the offer can never be re-put in
      // front of someone who actually answered it.
      markPushOfferSeen()
      sfx.whoosh()
      layer.destroy()
      resolve()
    }

    const scrimKit = addFocusScrim(scene, { alpha: 0.72 })
    const scrim = scrimKit.hit.setInteractive()
    scrim.on('pointerup', () => finish())
    layer.add([scrim, ...scrimKit.art])

    // Which words. `?pushoffer=daily|race` (DEV) forces one so either can be looked at without
    // manufacturing a save that qualifies for it — HomeScene's gate is `q?.has('pushoffer')`, which
    // a value satisfies just as well as a bare flag, so nothing there needs to know about this.
    let flavour = pushOfferFlavour(loadSave())
    if (import.meta.env.DEV) {
      const want = new URLSearchParams(location.search).get('pushoffer')
      if (want === 'daily' || want === 'race') flavour = want
    }
    const copy = COPY[flavour]

    // Deliberately the race-unlock card's geometry to the pixel — same plate, same icon/title/rule
    // rhythm, same footer band. The two are siblings a player can meet within a week of each other,
    // both explaining the same daily race, and a card that is nearly-but-not-quite the shape of the
    // last one reads as a different, less trustworthy screen. Change one, look at the other.
    // ⚠️ That pairing is about the RACE variant, and it is still exact: the derivation below
    // reproduces the shipped 740 for three two-line rules. The daily variant is a fourth rule taller
    // by construction, which is a deliberately visible difference between two cards nobody sees both
    // of — not a drift in the pair that a player really can compare side by side.
    const px = 46
    const pw = W - 92

    // ⚠️ THE RULE ROWS ARE BUILT AND MEASURED BEFORE THE PLATE, because the plate is sized from them.
    // They WRAP, the daily variant carries four of them where the race variant carries three, and
    // both of those change where the bottom of the card is. Seating a longer card on the literal 740
    // does not clip the footer — the footer is measured DOWN from the plate's own bottom edge, so a
    // plate an inch too short prints the buttons straight through the last rule line. (Same failure,
    // same fix, as the streak card's wrapped footer; see view/streakrewardcard.ts.) They are given
    // their y below, once there is a `pyTop` to measure from, and added to the layer in the same
    // pass so they still sit above the plate in draw order.
    const ruleIcons = copy.rules.map(([icon]) =>
      scene.add.text(px + 40, 0, icon, { fontSize: '29px' }).setOrigin(0, 0.5)
    )
    const ruleLines = copy.rules.map(([, text]) =>
      scene.add
        .text(px + 88, 0, text, {
          fontFamily: FONT,
          fontSize: '19px',
          color: T.inkMuted,
          wordWrap: { width: pw - 128 },
          lineSpacing: 4,
        })
        .setOrigin(0, 0.5)
    )

    // The race card's rhythm, kept exactly: rows 96 apart starting 300 below the plate's top, with
    // 248 of plate left under the last one.
    //
    // ⚠️ The overflow term is measured in LINES, not pixels, and that is the point: copy written to
    // the two-line budget scores 0 and the card that shipped is reproduced to the pixel rather than
    // merely to the eye. A line that busts the budget — a longer reword, a wider glyph, a future
    // variant — buys back exactly its own height in row pitch and plate, instead of quietly
    // overprinting its neighbour on whichever device wraps first.
    const RULE_ROW_PITCH = 96
    const RULE_TOP = 300
    const RULE_TAIL = 248
    const RULE_LINE_BUDGET = 2
    const RULE_LINE_H = 27 // 19px type on 4px lineSpacing — one row of the wrap
    // Seeded at 0, so copy inside the budget contributes nothing and the pitch is untouched.
    const overflow = ruleLines.reduce((m, t) => Math.max(m, t.getWrappedText().length - RULE_LINE_BUDGET), 0)
    const rowPitch = RULE_ROW_PITCH + overflow * RULE_LINE_H
    const ph = RULE_TOP + (ruleLines.length - 1) * rowPitch + RULE_TAIL
    const pyTop = viewportCenterY() - ph / 2

    const g = scene.add.graphics()
    panelPlate(g, px, pyTop, pw, ph, 30)
    layer.add(g)
    // Blocker so taps on the card don't fall through to the scrim behind it.
    layer.add(scene.add.rectangle(W / 2, pyTop + ph / 2, pw, ph, 0xffffff, 0.001).setInteractive())

    // The bell is the hero on BOTH variants — this is a notifications card whichever words it wears,
    // and the shake below is a bell's gesture. A gift box here would read as a prize card, which is
    // exactly what the shake comment says this is not.
    const bell = scene.add.text(W / 2, pyTop + 96, '🔔', { fontSize: '76px' }).setOrigin(0.5)
    layer.add(bell)

    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 182, copy.title, {
            fontFamily: FONT,
            fontSize: '50px',
            fontStyle: '900',
            color: T.goldText,
          })
          .setOrigin(0.5)
          .setLetterSpacing(2),
        'title'
      )
    )
    layer.add(
      inkShadow(
        scene.add
          .text(W / 2, pyTop + 232, copy.subtitle, {
            fontFamily: FONT,
            fontSize: '30px',
            fontStyle: '900',
            color: T.ink,
          })
          .setOrigin(0.5)
          .setLetterSpacing(6)
      )
    )

    ruleLines.forEach((line, i) => {
      const y = pyTop + RULE_TOP + i * rowPitch
      layer.add(ruleIcons[i].setY(y))
      layer.add(line.setY(y))
    })

    // ── The footer: one swappable region, because the ask has four outcomes ────────────────────
    // Rebuilt in place rather than opening a second card, so the answer lands where the question
    // was asked and the player never watches one modal replace another.
    let footer = scene.add.container(0, 0)
    layer.add(footer)
    // The band the race-unlock card puts its "Opened by clearing level 10" note on. Every state
    // below is measured from here, so the plate's bottom margin is one number, not four.
    const footerTop = pyTop + ph - 186

    const setFooter = (build: (into: Phaser.GameObjects.Container) => void): void => {
      footer.destroy()
      footer = scene.add.container(0, 0)
      layer.add(footer)
      build(footer)
    }

    const caption = (text: string, y: number, color: string): Phaser.GameObjects.Text =>
      scene.add
        .text(W / 2, y, text, {
          fontFamily: FONT,
          fontSize: '18px',
          color,
          align: 'center',
          wordWrap: { width: pw - 96 },
          lineSpacing: 4,
        })
        .setOrigin(0.5)

    /** The ask. Telling them the phone's own dialog is next is worth a line: an unexplained system
     *  prompt is the thing people dismiss reflexively. */
    const showOffer = (): void => {
      setFooter(into => {
        into.add(caption('Your phone will ask you to allow it', footerTop, T.inkFaint))
        into.add(addPillButton(scene, W / 2, footerTop + 66, 340, 66, 'REMIND ME', GOLD_PILL, () => ask()))
        into.add(addPillButton(scene, W / 2, footerTop + 140, 220, 50, 'NOT NOW', GHOST_PILL, () => finish()))
      })
    }

    const showWorking = (): void => {
      setFooter(into => {
        into.add(caption('Waiting for your phone…', footerTop + 66, T.inkMuted))
      })
    }

    const showOn = (): void => {
      setFooter(into => {
        const tick = scene.add.text(W / 2, footerTop + 40, '✅', { fontSize: '46px' }).setOrigin(0.5)
        into.add(tick)
        into.add(caption(copy.confirm, footerTop + 116, T.inkMuted))
        if (!reduced) {
          tick.setScale(0.4)
          scene.tweens.add({ targets: tick, scale: 1, duration: 420, ease: backOut(OVERSHOOT.pop) })
          sfx.winFanfare()
        }
      })
      // Bows out on its own — there is nothing left to decide, and a player left holding a DONE
      // button after saying yes is being asked to confirm their own confirmation.
      scene.time.delayedCall(reduced ? 900 : CONFIRM_HOLD_MS, () => finish())
    }

    /** A browser-level denial cannot be undone from in here, so don't offer a button that can't win. */
    const showDenied = (): void => {
      setFooter(into => {
        into.add(
          caption(
            'Notifications are blocked for Viva Maya in your browser settings. You can turn them back on there.',
            footerTop + 34,
            T.inkMuted
          )
        )
        into.add(addPillButton(scene, W / 2, footerTop + 134, 220, 56, 'OK', GHOST_PILL, () => finish()))
      })
    }

    /** A network flake is NOT an answer — offer the retry, and keep the latch unspent until they
     *  leave, so a bad minute of signal doesn't cost them the feature. */
    const showFailed = (): void => {
      setFooter(into => {
        into.add(caption('That did not go through. Worth another try?', footerTop + 4, T.inkMuted))
        into.add(addPillButton(scene, W / 2, footerTop + 68, 320, 62, 'TRY AGAIN', GOLD_PILL, () => ask()))
        into.add(addPillButton(scene, W / 2, footerTop + 140, 200, 48, 'NOT NOW', GHOST_PILL, () => finish()))
      })
    }

    const ask = (): void => {
      showWorking()
      // The gesture requirement is satisfied by this tap: enablePush calls requestPermission first
      // thing, synchronously enough to count as user-activated on every engine that enforces it.
      void enablePush().then(res => {
        if (settled) return
        if (res.ok) {
          track(EVENTS.PUSH_ENABLED, { surface: SURFACE[flavour] })
          showOn()
          return
        }
        track(EVENTS.PUSH_BLOCKED, { reason: res.reason ?? 'failed', surface: SURFACE[flavour] })
        if (res.reason === 'denied') showDenied()
        else showFailed()
      })
    }

    showOffer()
    // All three events carry the SAME surface, so shown → enabled → blocked is a funnel that can be
    // split by audience without joining anything. Same three names as the Settings door, split by
    // this prop rather than by new names — see SURFACE above for why that distinction is load-bearing.
    track(EVENTS.PUSH_SHOWN, { surface: SURFACE[flavour] })

    if (!reduced) {
      layer.setAlpha(0)
      scene.tweens.add({ targets: layer, alpha: 1, duration: 220, ease: 'Sine.easeOut' })
      bell.setScale(0.4)
      scene.tweens.add({ targets: bell, scale: 1, duration: 460, delay: 120, ease: backOut(OVERSHOOT.pop) })
      // A shake, not a fanfare: this is an invitation, not a prize. The celebration is held back for
      // the confirmation, where there is actually something to celebrate.
      scene.tweens.add({
        targets: bell,
        angle: { from: -12, to: 12 },
        duration: 110,
        delay: 520,
        yoyo: true,
        repeat: 2,
        ease: 'Sine.easeInOut',
        onComplete: () => bell.setAngle(0),
      })
      sfx.objectiveNear()
    }
  })
}

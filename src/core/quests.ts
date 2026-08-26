import { dayKey, seedForKey } from './endless'
import { mulberry32 } from './rng'
import { FREE_SPIN_BANK_CAP, loadSave, persistSave } from './save'
import type { QuestState, SaveData } from './save'

/**
 * DAILY QUESTS — three things you can decide to do today, and then be DONE.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Every reward loop in this game is AMBIENT. The jackpot meter fills, the storm charges, the streak
 * ticks, the charm album gathers, the week's standing accretes — all of them are things that HAPPEN
 * TO a player who keeps playing, and not one of them can be finished on purpose in a sitting. The
 * check-in ladder is the closest thing to a closed loop and it takes one tap, so it closes before the
 * player has done anything. The result is a game with sixteen reward systems and no answer at all to
 * "what am I doing tonight?", which is the question a session actually opens with.
 *
 * A quest slate answers it: a short list, drawn for the day, that a player can read, do, and tick
 * off. The value is the TICKING OFF — everything here already paid chips somewhere else; what is new
 * is that a finite amount of play now has an end, and the end is visible from the start.
 *
 * ── INTENT-COMPLETABLE ONLY, AND THAT IS THE WHOLE CATALOG RULE ──────────────
 * Every goal below is something a player can simply DECIDE to finish. Nothing here is gated on luck:
 * no "trigger a Plinko drop" (needs an x5 chain), no "match the Lucky Deal" (deals every third win),
 * no "hit a x6 cascade". Those read identically on a card and are the opposite thing — a lottery
 * ticket with a deadline. A checklist makes exactly one promise, which is that doing the listed thing
 * finishes it, and a single luck-gated row breaks that promise for the whole card: a player who did
 * everything asked and still sees an unticked row learns that the list is decoration.
 *
 * ⚠️ `run_board` is PARTICIPATION, never a score. "Finish a run on today's board" is a quest; "score
 * 10,000 on today's board" is a second, unguarded reason to inflate a self-reported number, and the
 * race's whole defence story (see the migration headers, and core/racesalt.ts) exists because that
 * number is already the softest thing in the game. Nothing in here may ever read a score.
 *
 * ── SEEDED BY THE DAY ALONE (the HOUSE GIFT's rule, for the HOUSE GIFT's reasons) ──
 * `questsForDay` takes the race day key and nothing else, so every player on earth gets the same
 * three goals on the same day, and two of a player's own devices agree without syncing anything. It
 * uses the RACE calendar (core/endless.ts dayKey) rather than `daily.ts todayKey` so the slate rolls
 * over with the board and the gift — one midnight, not three — and so a future sender could name
 * today's quests in a notification the way `--drop` names today's gift.
 *
 * It is therefore globally predictable, and here that is harmless for exactly the reason
 * core/bonusdrop.ts spells out: a quest is not a contest. Knowing that Thursday asks for two level
 * wins beats nobody, and it is a reason to be here on Thursday. ⚠️ **Do not reach for
 * core/racesalt.ts to "fix" it.** Foreknowledge is an advantage on the race BOARD, which is why the
 * salt exists there; the two cases look identical and are opposites.
 *
 * ── THE BUDGET (this catalog is the knob) ────────────────────────────────────
 * A perfect day pays 60–70 chips and one free spin — the win goal (15 or 25) plus 10 plus 15 plus the
 * 20-chip all-clear. Against the existing faucets — the check-in ladder at ~56 chips/day
 * (core/daily.ts CHECKIN_CHIPS), the house gift at ~23, the streak ladder at ~19.5, level wins at
 * ~33 — that is a side dish, and unlike every one of those it cannot be collected by showing up: it
 * costs a level win, a cabinet pull and a race run. `quests.test.ts` pins the ceiling and re-derives
 * it from the catalog; retune by moving a payout here, and re-derive the number rather than widening
 * the bound to make a richer catalog green.
 *
 * ⚠️ NO BOOSTS IN V1, deliberately. A boost reward would ride `pendingBoosts`, which drags in the
 * stash panel's promise, `splitPendingBoosts`' cap rule and iron rule 2 (the daily race stays
 * boost-free) — a lot of surface for a side dish. Chips and one free spin keep the whole feature
 * inside two numbers on the save. The cut is a cut, not an oversight; add boosts later on purpose.
 *
 * ── THE CLAIM LATCH IS THE ONLY LATCH ────────────────────────────────────────
 * A goal's payment and the push of its id into `save.quests.claimed` happen in the SAME statement
 * block, exactly as `advanceDailyRitual` pays the streak purse beside `lastSpinDate` and
 * `grantBonusDrop` banks the gift beside `bonusDropDay`. There is no second definition of "already
 * paid today" to keep in sync with this one, so a caller that fires twice — a retry, a double-tap, a
 * re-entered scene, a resumed level replaying its win — is inert rather than paying twice. ⚠️ The
 * corollary is the same one those two carry: **never lift the payment out to the caller.**
 *
 * ── ANALYTICS ────────────────────────────────────────────────────────────────
 * `EVENTS.QUEST_CLAIM` (core/analytics.ts) is a NEW event name, which means it is invisible to the
 * dashboard until a migration teaches the views about it: 0014/0015/0021/0022 hardcode
 * `name in (...)`, so an unknown event is stored perfectly and charted nowhere. That is the accepted
 * cost here, the same call `bonus_drop` made — this is a new mechanic rather than a new angle on an
 * existing one, so there is no event to ride as a prop, and the rows are in the table from day one
 * for whenever a view catches up. The NAME lives with every other event name, because a second place
 * to spell it is the `BOOST_META` scar in miniature; the PROPS-builder lives here, so the one module
 * that knows what a quest claim IS is what says what a quest claim REPORTS.
 *
 * Merge rule: `mergeQuests` in core/merge.ts — same day means per-goal MAX progress and a UNION of
 * claims; a different day means the later slate wins wholesale. Read it before changing this shape.
 */

/**
 * The three things a quest can be finished BY. A closed vocabulary on purpose: a signal is fed from a
 * scene (see the wiring notes on `recordQuestSignal`), and an open string would let a call site
 * invent a signal no goal consumes, which fails silently and forever.
 *
 * These deliberately echo the analytics event names (`level_win`, and the moments `slot_spin` /
 * `endless_end` sit at) — the same beat, named the same way, so a wiring agent looking for where to
 * call this finds the `track()` line already sitting there. They are NOT the same values: nothing
 * here is sent anywhere, and adding a signal never adds an event.
 */
export type QuestSignal = 'level_win' | 'slots_spun' | 'endless_end'

/** One row of the catalog — a goal a day can ask for. */
export interface QuestGoal {
  /** Stable id. The save's progress key, the claim latch's entry and the analytics prop; never shown. */
  id: string
  /** ALL-CAPS headline on the card's row. */
  label: string
  /** One line saying exactly what finishes it, sized for the row's second line. */
  blurb: string
  /** Row glyph. Must be a FULLY-QUALIFIED emoji — see the BOOST_META icon note. */
  emoji: string
  /** The signal that advances it. */
  signal: QuestSignal
  /** How many of that signal finish it. */
  target: number
  /** Chips paid the moment it is finished. */
  chips: number
}

/**
 * The catalog. ⚠️ THE ORDER OF THIS LIST IS LOAD-BEARING in two separate ways, exactly as
 * `DROP_TABLE` in core/bonusdrop.ts and `PRIZE_WEIGHTS` in core/daily.ts are:
 *
 *  1. `questsForDay` shuffles a pool built by walking it, so reordering it silently re-rolls the
 *     slate for every future day.
 *  2. The drawn goals are RETURNED in this order (see the note at the end of `questsForDay`), so it
 *     is also the order the card's rows are read in.
 *
 * Copy lives here and nowhere else. A view that writes its own label for a goal is the scar
 * `BOOST_META` records — three things called "+5 MOVES" and a player who concluded he was being
 * charged for his own winnings.
 */
const CATALOG: readonly QuestGoal[] = [
  {
    id: 'win_level',
    label: 'WIN A LEVEL',
    blurb: 'Clear any numbered level today.',
    emoji: '🎯',
    signal: 'level_win',
    target: 1,
    chips: 15,
  },
  {
    id: 'win_two',
    label: 'WIN 2 LEVELS',
    blurb: 'Clear two numbered levels today.',
    emoji: '🏅',
    signal: 'level_win',
    target: 2,
    chips: 25,
  },
  {
    id: 'spin_slots',
    label: 'PULL LUCKY SLOTS',
    blurb: 'One pull on the cabinet — the free one counts.',
    emoji: '🎰',
    signal: 'slots_spun',
    target: 1,
    chips: 10,
  },
  {
    id: 'run_board',
    label: "RUN TODAY'S BOARD",
    // ⚠️ FINISH, not score. See the participation warning in the header.
    blurb: "Play a run on today's race board, start to finish.",
    emoji: '🏁',
    signal: 'endless_end',
    target: 1,
    chips: 15,
  },
]

/** The catalog, read-only. Exported for the card and the tests; the draw is `questsForDay`. */
export const QUEST_CATALOG: readonly QuestGoal[] = CATALOG

/**
 * Sets of goals no single day may ask for together, because one subsumes the other. Exactly one
 * member of each group survives the draw, chosen by the day.
 *
 * `win_level` + `win_two` is the only one and it is not optional: a card reading "WIN A LEVEL" above
 * "WIN 2 LEVELS" hands the player one row for free the moment they clear the other, which makes the
 * list look padded and makes the ceiling 85 instead of 70.
 */
const EXCLUSIVE_GROUPS: readonly (readonly string[])[] = [['win_level', 'win_two']]

/** Goals on a day's slate. Three is the whole design: short enough to finish, long enough to be a list. */
export const QUEST_COUNT = 3

/** The claim latch's entry for the ALL-CLEAR bonus. Not a goal id — no catalog row may ever use it. */
export const ALL_CLEAR_ID = 'all'
/** ALL-CAPS headline for the all-clear payout, so no view writes its own. */
export const ALL_CLEAR_LABEL = 'ALL THREE DONE'
/** Chips for finishing the whole slate — the reason the third row is worth doing. */
export const ALL_CLEAR_CHIPS = 20
/** Free spins for finishing the whole slate. Honours the BANK cap only; see `advanceQuests`. */
export const ALL_CLEAR_SPINS = 1

/**
 * The most chips a single day's slate can pay, all three goals plus the bonus. THE BUDGET CONTRACT —
 * `quests.test.ts` re-derives it from the catalog and fails if a retune moves it, so this constant is
 * a statement of intent rather than a cache. Raising it is a decision about the whole chip economy
 * (chips are a lifetime budget: a faucet that grows reprices every Gift Store sink without a single
 * price changing), not a tuning knob.
 */
export const QUEST_CHIP_CEILING = 70

/** A slate nobody has touched. Its `day` of `''` can never equal a real day key, so the next signal rolls it. */
function freshSlate(): QuestState {
  return { day: '', progress: {}, claimed: [] }
}

/**
 * The three goals a given race day asks for. Pure, total and deterministic: same key in, same rows
 * out, on every device and in any future sender.
 *
 * ── The draw ─────────────────────────────────────────────────────────────────
 * One `mulberry32` stream, seeded off `<day>#quests`. The `#quests` suffix namespaces this off the
 * board seed for the reason `bonusdrop.ts`'s `#gift` does: without it the slate and the day's BOARD
 * would be two readings of one 32-bit value, so they would correlate forever and any future change to
 * one would silently move the other.
 *
 * Then, in order: pick one survivor from each exclusive group, and shuffle what is left, taking the
 * first `QUEST_COUNT`.
 *
 * ⚠️ With today's four-row catalog the COMPOSITION is forced — dropping one of the win pair leaves
 * exactly three — so the roll currently decides exactly one thing: which win goal today wants. That
 * is a property of the catalog's size, not of this algorithm, and it is why the general draw is
 * written out rather than replaced by a coin flip: the catalog is the knob, and a fifth row starts
 * the day choosing without a line of this changing.
 */
export function questsForDay(day: string): QuestGoal[] {
  const rng = mulberry32(seedForKey(`${day}#quests`))
  const dropped = new Set<string>()
  for (const group of EXCLUSIVE_GROUPS) {
    if (group.length === 0) continue
    const keep = group[Math.floor(rng() * group.length)]
    for (const id of group) if (id !== keep) dropped.add(id)
  }
  const pool = CATALOG.filter(goal => !dropped.has(goal.id))
  // Fisher-Yates on the pool. A pool SHORTER than QUEST_COUNT simply yields what it has rather than
  // throwing — a defensive floor, like `dropForDay`'s, because this runs inside a scene build.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  const drawn = new Set(pool.slice(0, QUEST_COUNT))
  // Returned in CATALOG order, not in shuffled order, and that is a UI decision made here so no view
  // has to make it: the card is a checklist a player re-reads several times a day, and rows that swap
  // places between visits have to be re-read instead of glanced at. Because the win pair are adjacent
  // in the catalog, the level row is always first, the cabinet second, the board third — every day.
  return CATALOG.filter(goal => drawn.has(goal))
}

/** One row of the card's read view — the goal, how far it has got, whether it is already paid. */
export interface QuestProgress {
  goal: QuestGoal
  /** Units recorded today, CLAMPED to the target so a view can never read "3 / 2". */
  done: number
  /** Finished and paid. `done === target` without this cannot happen; the two are written together. */
  claimed: boolean
}

/** Today's slate as a surface should draw it. */
export interface QuestDayView {
  /** The race day these rows belong to. */
  day: string
  goals: QuestProgress[]
  /** Every goal finished AND paid. */
  allClear: boolean
  /** The all-clear bonus has been paid. */
  bonusClaimed: boolean
  /** Chips still on the table today — unclaimed goals plus the bonus if it is still live. */
  chipsLeft: number
}

/**
 * Today's slate for a save, as a READ. Rolls the day over IN THE RETURNED VIEW ONLY: a save still
 * holding yesterday's slate reads as a fresh, untouched set of today's goals.
 *
 * ⚠️ It does not write, and must never learn to. A read path that repairs the save is a write that
 * happens on render — so it fires from whatever scene happened to draw first, on a save object the
 * caller may be midway through mutating, and it makes "when did the day roll over" depend on which
 * screen the player opened. `advanceQuests` owns the rollover, on a real signal, once.
 */
export function questState(save: SaveData, now = new Date()): QuestDayView {
  const day = dayKey(now)
  const stored = save?.quests
  // Shape-tolerant, like every other reader in this file: a save that never went through coerceSave
  // (a hand-built test fixture, a half-written blob) reads as an untouched slate rather than throwing.
  const live =
    stored && typeof stored === 'object' && stored.day === day && day !== '' ? stored : freshSlate()
  const progress = live.progress && typeof live.progress === 'object' ? live.progress : {}
  const claimed = new Set(Array.isArray(live.claimed) ? live.claimed : [])
  const goals: QuestProgress[] = questsForDay(day).map(goal => {
    const at = progress[goal.id]
    const done = typeof at === 'number' && Number.isFinite(at) ? Math.max(0, Math.floor(at)) : 0
    return { goal, done: Math.min(goal.target, done), claimed: claimed.has(goal.id) }
  })
  const bonusClaimed = claimed.has(ALL_CLEAR_ID)
  const chipsLeft =
    goals.reduce((sum, row) => sum + (row.claimed ? 0 : row.goal.chips), 0) +
    (bonusClaimed ? 0 : ALL_CLEAR_CHIPS)
  return {
    day,
    goals,
    allClear: goals.length > 0 && goals.every(row => row.claimed),
    bonusClaimed,
    chipsLeft,
  }
}

/** What a finished quest actually paid, so a toast can be honest about it. */
export interface QuestGrant {
  /** The goal's id, or `ALL_CLEAR_ID` for the bonus row. */
  id: string
  /** ALL-CAPS headline — the goal's label, or `ALL_CLEAR_LABEL`. */
  label: string
  /** The goal that was finished, or null on the all-clear bonus (which is not a goal). */
  goal: QuestGoal | null
  /** The race day paid — the slate the claim latch was written on. */
  day: string
  /** Chips banked. Always the declared amount; chips have no cap. */
  chips: number
  /** Free spins that actually STUCK, after the BANK cap. Only the all-clear row ever pays any. */
  freeSpins: number
  /** Chip balance AFTER this grant. */
  balance: number
}

/** The result of feeding one signal in. */
export interface QuestAdvance {
  /** Everything that PAID, goal completions first and the all-clear bonus last. Usually empty. */
  grants: QuestGrant[]
  /**
   * Whether the save was actually mutated — the day rolled, a counter moved, or something paid.
   * `recordQuestSignal` persists on exactly this, so a signal that changes nothing costs no write.
   */
  changed: boolean
}

/**
 * Feed one signal into `save`'s slate IN PLACE and return what it paid. The caller persists — this is
 * `grantBonusDrop` to `recordQuestSignal`'s `claimBonusDrop`, and it exists as its own export so a
 * scene already inside its own load→mutate→persist can fold quests into that single write rather than
 * racing it with a second one.
 *
 * ⚠️ ONE CALL IS ONE EVENT. There is no amount parameter and there should not be: the counter in the
 * save is the only record that a level was won, so a caller that batches ("I won 3 since last time")
 * has already lost the information that would make batching safe, and a caller that fires on a render
 * rather than on the beat inflates it. Fire it where the thing happened, once.
 *
 * ⚠️ Free spins are banked by direct mutation rather than through `addFreeSpins`, for the two reasons
 * `grantStreakReward` and `grantBonusDrop` both spell out: that helper does its own
 * loadSave()→persist, which would clobber the caller's in-flight save object, and it answers to
 * FREE_SPIN_DAILY_CAP — a cap that bounds the one FARMABLE source (a marathon session banking cascade
 * awards), which a once-a-day all-clear is not. The BANK cap is still honoured and the grant reports
 * what actually stuck, so a toast can never name a spin the player did not receive.
 */
export function advanceQuests(save: SaveData, signal: QuestSignal, now = new Date()): QuestAdvance {
  const day = dayKey(now)
  const stored = save.quests
  // THE ROLLOVER. A slate belongs to exactly one day: yesterday's progress and yesterday's claims are
  // both dead, so the whole thing is replaced rather than patched. This is also the total-on-junk
  // path — a missing or malformed slate is indistinguishable from an expired one and is treated as one.
  const rolled = !stored || typeof stored !== 'object' || stored.day !== day
  if (rolled) save.quests = { day, progress: {}, claimed: [] }
  const slate = save.quests
  if (!slate.progress || typeof slate.progress !== 'object') slate.progress = {}
  if (!Array.isArray(slate.claimed)) slate.claimed = []

  const goals = questsForDay(day)
  const grants: QuestGrant[] = []
  let changed = rolled

  for (const goal of goals) {
    if (goal.signal !== signal) continue
    // Already paid — the counter is dead, and stepping it further would be the only way a claimed
    // goal's progress could ever disagree with its target.
    if (slate.claimed.includes(goal.id)) continue
    const at = slate.progress[goal.id]
    const next = (typeof at === 'number' && Number.isFinite(at) ? Math.max(0, Math.floor(at)) : 0) + 1
    slate.progress[goal.id] = next
    changed = true
    if (next < goal.target) continue
    // ── THE CLAIM AND THE PAYMENT, IN ONE STATEMENT BLOCK ────────────────────
    // See the header: this latch is the ONLY latch, which is what makes a repeated call inert. Split
    // these two lines across a caller boundary and a retry pays the purse twice.
    slate.claimed.push(goal.id)
    save.chips += goal.chips
    grants.push({
      id: goal.id,
      label: goal.label,
      goal,
      day,
      chips: goal.chips,
      freeSpins: 0,
      balance: save.chips,
    })
  }

  // THE ALL-CLEAR, checked on EVERY signal rather than only on one that completed a goal. The
  // difference matters across devices: finish the last goal on the phone, then open the tablet, and
  // the merge arrives holding all three claims and no bonus — nothing on the tablet will ever
  // "complete" a goal again today, so a bonus gated on a completion would be stranded until tomorrow,
  // when its slate is gone. Gated on the claim latch instead, it simply pays on the next thing the
  // player does. `goals.length > 0` keeps an empty catalog from paying a bonus for nothing.
  if (
    goals.length > 0 &&
    !slate.claimed.includes(ALL_CLEAR_ID) &&
    goals.every(goal => slate.claimed.includes(goal.id))
  ) {
    slate.claimed.push(ALL_CLEAR_ID)
    save.chips += ALL_CLEAR_CHIPS
    const room = Math.max(0, FREE_SPIN_BANK_CAP - (save.freeSpins || 0))
    const freeSpins = Math.min(ALL_CLEAR_SPINS, room)
    if (freeSpins > 0) save.freeSpins = (save.freeSpins || 0) + freeSpins
    changed = true
    grants.push({
      id: ALL_CLEAR_ID,
      label: ALL_CLEAR_LABEL,
      goal: null,
      day,
      chips: ALL_CLEAR_CHIPS,
      freeSpins,
      balance: save.chips,
    })
  }

  return { grants, changed }
}

/**
 * Record that the player just did one of the three things: one atomic load→advance→persist. Returns
 * what it paid, newest last, so a caller can toast each grant; an ordinary signal returns `[]`.
 *
 * AWARD-FIRST per the economy's iron rule 4, like `claimBonusDrop` and `claimInstallReward`: the
 * chips are banked and the latch written BEFORE anything is shown, so a force-quit mid-toast loses
 * nothing and a re-open re-offers nothing.
 *
 * ── WHERE THIS IS CALLED FROM (the wiring contract) ──────────────────────────
 * Fire it on the BEAT, next to the analytics event for the same moment, never from a render:
 *  • `'level_win'`   — a numbered level is won (GameScene, beside `track(EVENTS.LEVEL_WIN, …)`).
 *    ⚠️ Numbered levels only. An endless run is not a level win, and a RESUMED level must not
 *    re-fire it — `levelresume` restores a position, not a victory.
 *  • `'slots_spun'`  — a pull actually resolves on the cabinet (SlotScene, beside the `freeSlotSpin`
 *    / `buySpin` result). The free daily pull counts; the card says so.
 *  • `'endless_end'` — a race run ENDS (GameScene, beside `recordEndless`). Participation only: it
 *    must not read `score`, `posted`, `isRecord` or anything else the run produced.
 */
export function recordQuestSignal(signal: QuestSignal, now = new Date()): QuestGrant[] {
  const save = loadSave()
  const { grants, changed } = advanceQuests(save, signal, now)
  if (changed) persistSave(save)
  return grants
}

/**
 * The props for one claim, shaped like `bonus_drop`'s `{drop, chips, spins, boost}` so the two rows
 * read the same way in a query. The event's NAME is `EVENTS.QUEST_CLAIM` in core/analytics.ts — see
 * the header for why it is charted nowhere until a migration teaches the dashboard views about it,
 * and why that was still the right call.
 *
 * `quest` splits the count by which goal it was — the measurement the catalog is retuned against
 * ("nobody ever finishes the board one" is a fact about the goal, not about quests). `spins` is worth
 * carrying even though only one row ever pays any: a `0` on an `all` row is a free spin the BANK CAP
 * ate, which is invisible from every other angle.
 */
export function questClaimProps(grant: QuestGrant): Record<string, string | number> {
  return { quest: grant.id, chips: grant.chips, spins: grant.freeSpins }
}

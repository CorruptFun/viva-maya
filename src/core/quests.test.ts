import { beforeEach, describe, expect, it } from 'vitest'
import { EVENTS } from './analytics'
import { CHECKIN_CHIPS } from './daily'
import { dayKey, seedForKey } from './endless'
import { mergeSaves } from './merge'
import {
  ALL_CLEAR_CHIPS,
  ALL_CLEAR_ID,
  ALL_CLEAR_LABEL,
  ALL_CLEAR_SPINS,
  QUEST_CATALOG,
  QUEST_CHIP_CEILING,
  QUEST_COUNT,
  advanceQuests,
  questClaimProps,
  questState,
  questsForDay,
  recordQuestSignal,
} from './quests'
import { mulberry32 } from './rng'
import { FREE_SPIN_BANK_CAP, coerceSave, type SaveData } from './save'

/**
 * DAILY QUESTS — the one closed loop in a game made of ambient meters: three things you can decide to
 * do today and then be DONE.
 *
 * Three properties are what this file actually guards, and each has a specific failure behind it:
 *  • THE DRAW is deterministic and never asks for a goal that another goal already contains.
 *  • THE PAYMENT happens exactly once per goal per day, because the claim latch and the chips are
 *    written in one statement block — a double-call must be inert, not generous.
 *  • THE BUDGET stays a side dish. Chips are a lifetime budget, so a faucet that quietly grows
 *    reprices every Gift Store sink without a single price changing.
 */

const KEY = 'viva-maya:v1'

// Fixtures go through the REAL coercion path so they cannot drift from the on-disk shape (the same
// helper shape merge.test.ts and bonusdrop.test.ts use).
const save = (partial: Partial<SaveData> = {}): SaveData => coerceSave(partial)

/** A clock seated in the middle of a race day, so `dayKey` and the key agree in either TZ offset. */
const at = (day: string): Date => new Date(`${day}T18:00:00Z`)

/** The day after a `YYYY-MM-DD` key. */
const nextDay = (day: string): string =>
  new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)

/** The first day in a three-year sweep that draws a given goal. */
function firstDayDrawing(id: string): string {
  const start = Date.UTC(2026, 0, 1)
  for (let i = 0; i < 365 * 3; i++) {
    const day = new Date(start + i * 86400000).toISOString().slice(0, 10)
    if (questsForDay(day).some(g => g.id === id)) return day
  }
  throw new Error(`no day in three years draws ${id}`)
}

/** Every `YYYY-MM-DD` key in a one-year sweep. */
function yearOfDays(): string[] {
  const start = Date.UTC(2026, 0, 1)
  return Array.from({ length: 365 }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10))
}

beforeEach(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    },
  })
  localStorage.removeItem(KEY)
})

describe('the draw', () => {
  it('is deterministic — the same day always asks for the same three things', () => {
    for (const day of ['2026-08-24', '2026-12-31', '2027-02-28']) {
      const first = questsForDay(day)
      const second = questsForDay(day)
      expect(first.map(g => g.id)).toEqual(second.map(g => g.id))
      // The same catalog rows, not copies of them — so a view holding a goal can compare by identity
      // and a catalog edit can never be shadowed by a stale duplicate.
      first.forEach((goal, i) => expect(goal).toBe(second[i]))
    }
  })

  it('draws exactly QUEST_COUNT distinct goals, every day', () => {
    for (const day of yearOfDays()) {
      const ids = questsForDay(day).map(g => g.id)
      expect(ids.length, day).toBe(QUEST_COUNT)
      expect(new Set(ids).size, day).toBe(QUEST_COUNT)
    }
  })

  it('never asks for WIN A LEVEL and WIN 2 LEVELS on the same day', () => {
    // THE exclusion rule. A card holding both hands the player one row for free the moment they clear
    // the other, which makes the list look padded and lifts the day's ceiling from 70 chips to 85.
    for (const day of yearOfDays()) {
      const ids = questsForDay(day).map(g => g.id)
      expect(ids.includes('win_level') && ids.includes('win_two'), day).toBe(false)
      // ...and exactly one of them is always there, so `level_win` is never a signal nothing consumes.
      expect(ids.includes('win_level') || ids.includes('win_two'), day).toBe(true)
    }
  })

  it('uses both sides of the exclusion over a year — neither branch is dead', () => {
    const ids = new Set(yearOfDays().flatMap(day => questsForDay(day).map(g => g.id)))
    expect([...ids].sort()).toEqual(QUEST_CATALOG.map(g => g.id).sort())
  })

  it('is namespaced off the board seed, not drawn from it', () => {
    // `#quests` is what keeps the slate and the day's BOARD from being two readings of one 32-bit
    // value. Sharing a seed would correlate them forever, and would silently move the slate the next
    // time anything touched the board seed. The proof is that dropping the suffix changes the answer
    // on a large share of days; if this ever falls near zero, the suffix has stopped doing anything.
    const winGoalUnsuffixed = (day: string): string => {
      const rng = mulberry32(seedForKey(day))
      const pair = ['win_level', 'win_two']
      return pair[Math.floor(rng() * pair.length)]
    }
    const days = yearOfDays()
    const differ = days.filter(day => {
      const drawn = questsForDay(day).find(g => g.signal === 'level_win')
      return drawn?.id !== winGoalUnsuffixed(day)
    }).length
    // Two independent fair picks disagree ~50% of the time; equality would land this at 0.
    expect(differ / days.length).toBeGreaterThan(0.3)
  })

  it('returns the day’s goals in CATALOG order, so the card’s rows never swap places', () => {
    // A checklist a player re-reads several times a day has to be glanceable: the level row is always
    // first, the cabinet second, the board third. The win pair are adjacent in the catalog, so which
    // one today asks for never moves anything.
    for (const day of yearOfDays()) {
      const drawn = questsForDay(day)
      const catalogOrder = QUEST_CATALOG.filter(g => drawn.includes(g))
      expect(drawn, day).toEqual(catalogOrder)
    }
    expect(questsForDay('2026-08-24').map(g => g.signal)).toEqual([
      'level_win',
      'slots_spun',
      'endless_end',
    ])
  })
})

describe('the catalog', () => {
  it('pays exactly what it says — the payout table, pinned', () => {
    // Re-derive these if a payout is retuned; do NOT edit them to make a richer catalog green. They
    // are the input to the ceiling below, which is the actual economy contract.
    const paid = Object.fromEntries(QUEST_CATALOG.map(g => [g.id, g.chips]))
    expect(paid).toEqual({ win_level: 15, win_two: 25, spin_slots: 10, run_board: 15 })
    const targets = Object.fromEntries(QUEST_CATALOG.map(g => [g.id, g.target]))
    expect(targets).toEqual({ win_level: 1, win_two: 2, spin_slots: 1, run_board: 1 })
    expect(QUEST_CATALOG.map(g => g.label)).toEqual([
      'WIN A LEVEL',
      'WIN 2 LEVELS',
      'PULL LUCKY SLOTS',
      "RUN TODAY'S BOARD",
    ])
  })

  it('is intent-completable only — every goal is finished by a signal a player can decide to fire', () => {
    // The catalog's one rule. A luck-gated row (trigger a Plinko drop, hit an x6 chain) reads
    // identically on a card and is the opposite thing: a lottery ticket with a deadline. One of them
    // breaks the checklist's only promise — that doing the listed thing finishes it — for the whole card.
    const vocabulary = ['level_win', 'slots_spun', 'endless_end']
    for (const goal of QUEST_CATALOG) {
      expect(vocabulary, `${goal.id} is finished by something outside the vocabulary`).toContain(goal.signal)
      expect(goal.target, `${goal.id} can never be finished`).toBeGreaterThanOrEqual(1)
      expect(goal.chips, `${goal.id} pays nothing`).toBeGreaterThan(0)
      expect(goal.id, 'a goal id collides with the all-clear latch').not.toBe(ALL_CLEAR_ID)
      expect(goal.label.length, `${goal.id} has no headline`).toBeGreaterThan(0)
      expect(goal.blurb.length, `${goal.id} never says what finishes it`).toBeGreaterThan(0)
    }
  })

  it('carries no boost on any row, and a perfect day moves nothing but chips and spins', () => {
    // v1 is deliberately chips + one free spin. A boost reward would drag in `pendingBoosts`, the
    // stash panel's promise, `splitPendingBoosts`' cap rule and iron rule 2 (the race stays
    // boost-free) — a lot of surface for a side dish. This pins the cut both ways.
    for (const goal of QUEST_CATALOG) {
      expect(Object.keys(goal).filter(k => /boost/i.test(k)), `${goal.id} carries a boost`).toEqual([])
    }
    const day = firstDayDrawing('win_level')
    const before = save({ chips: 100 })
    const s = save({ chips: 100 })
    for (const signal of ['level_win', 'slots_spun', 'endless_end'] as const) {
      advanceQuests(s, signal, at(day))
    }
    const strip = (x: SaveData): Partial<SaveData> => {
      const copy: Partial<SaveData> = { ...x }
      delete copy.chips
      delete copy.freeSpins
      delete copy.quests
      return copy
    }
    expect(strip(s)).toEqual(strip(before))
    expect(s.pendingBoosts).toEqual([])
    expect(s.heldBoosts).toEqual([])
  })

  it('RUN TODAY’S BOARD is participation and can never read a score', () => {
    // ⚠️ "Score 10,000 on today's board" would be a second, unguarded reason to inflate a
    // self-reported number, and the race's whole defence story exists because that number is already
    // the softest thing in the game. Finishing a run is the quest; what the run scored is not.
    const day = firstDayDrawing('run_board')
    const blank = save()
    const decorated = save({ endlessDays: { [day]: 99_999 }, best: 500_000 })
    const a = advanceQuests(blank, 'endless_end', at(day))
    const b = advanceQuests(decorated, 'endless_end', at(day))
    expect(a.grants.map(g => ({ id: g.id, chips: g.chips }))).toEqual(
      b.grants.map(g => ({ id: g.id, chips: g.chips }))
    )
    expect(a.grants[0]?.chips).toBe(15)
  })
})

describe('the budget', () => {
  it('a perfect day never pays more than QUEST_CHIP_CEILING, and reaches it', () => {
    // THE economy contract, re-derived from the catalog rather than trusted. A ceiling that is never
    // reached is a ceiling nobody is budgeting against; one that is exceeded is a repricing of every
    // Gift Store sink that nobody decided to make.
    const totals = yearOfDays().map(
      day => questsForDay(day).reduce((sum, g) => sum + g.chips, 0) + ALL_CLEAR_CHIPS
    )
    expect(Math.max(...totals)).toBe(QUEST_CHIP_CEILING)
    expect(Math.max(...totals)).toBe(70)
    // The floor is the other half of the spread: the cheap win goal instead of the dear one.
    expect(Math.min(...totals)).toBe(60)
  })

  it('a richest possible day pays the ceiling and exactly one free spin', () => {
    expect(ALL_CLEAR_SPINS).toBe(1)
    const day = firstDayDrawing('win_two')
    const s = save({ chips: 0 })
    for (const signal of ['level_win', 'level_win', 'slots_spun', 'endless_end'] as const) {
      advanceQuests(s, signal, at(day))
    }
    // The ceiling reached through the actual payment path, not just added up off the catalog.
    expect(s.chips).toBe(QUEST_CHIP_CEILING)
    expect(s.freeSpins).toBe(1)
  })

  it('stays a SIDE dish against the check-in ladder', () => {
    // The check-in ladder pays ~56 chips/day for one tap (core/daily.ts CHECKIN_CHIPS). A perfect
    // quest day may be worth a little more than that — it costs a level win, a cabinet pull and a
    // race run, which is four separate acts of play — but never twice one. Re-derive if retuned; do
    // NOT widen the bound to admit a richer catalog.
    const checkinPerDay = CHECKIN_CHIPS.reduce((a, b) => a + b, 0) / CHECKIN_CHIPS.length
    expect(QUEST_CHIP_CEILING).toBeLessThan(checkinPerDay * 1.5)
    expect(QUEST_CHIP_CEILING).toBeGreaterThan(checkinPerDay * 0.5)
  })

  it('questState advertises exactly what is still on the table', () => {
    const day = firstDayDrawing('win_two')
    const s = save()
    const fresh = questState(s, at(day))
    expect(fresh.chipsLeft).toBe(
      questsForDay(day).reduce((sum, g) => sum + g.chips, 0) + ALL_CLEAR_CHIPS
    )
    expect(fresh.allClear).toBe(false)
    expect(fresh.bonusClaimed).toBe(false)
    expect(fresh.goals.map(row => row.done)).toEqual([0, 0, 0])

    advanceQuests(s, 'slots_spun', at(day))
    const after = questState(s, at(day))
    expect(after.chipsLeft).toBe(fresh.chipsLeft - 10)
    expect(after.goals.find(row => row.goal.id === 'spin_slots')?.claimed).toBe(true)
  })

  it('never reports more progress than the target — a view can’t read "3 / 2"', () => {
    const day = firstDayDrawing('win_two')
    const s = save({ quests: { day, progress: { win_two: 9 }, claimed: [] } })
    expect(questState(s, at(day)).goals.find(row => row.goal.id === 'win_two')?.done).toBe(2)
  })
})

describe('the payment', () => {
  it('pays a finished goal once and latches it in the same breath', () => {
    const day = firstDayDrawing('win_level')
    const s = save({ chips: 100 })
    const { grants, changed } = advanceQuests(s, 'level_win', at(day))
    expect(changed).toBe(true)
    expect(grants.map(g => g.id)).toEqual(['win_level'])
    expect(grants[0].chips).toBe(15)
    expect(grants[0].label).toBe('WIN A LEVEL')
    expect(grants[0].day).toBe(day)
    expect(grants[0].balance).toBe(115)
    expect(s.chips).toBe(115)
    expect(s.quests.day).toBe(day)
    expect(s.quests.claimed).toContain('win_level')
  })

  it('is inert the second time — the claim latch IS the only latch', () => {
    // The failure this prevents: a retry, a double-tap, a re-entered scene or a resumed level
    // replaying its win pays the purse twice. There is no second definition of "already paid today"
    // to keep in sync with this one, so the repeat costs nothing and writes nothing.
    const day = firstDayDrawing('win_level')
    const s = save({ chips: 100 })
    advanceQuests(s, 'level_win', at(day))
    const before = JSON.stringify(s)
    const again = advanceQuests(s, 'level_win', at(day))
    expect(again.grants).toEqual([])
    expect(again.changed).toBe(false)
    expect(JSON.stringify(s)).toBe(before)
  })

  it('makes a two-step goal take two signals', () => {
    const day = firstDayDrawing('win_two')
    const s = save({ chips: 0 })
    const first = advanceQuests(s, 'level_win', at(day))
    expect(first.grants).toEqual([])
    expect(first.changed).toBe(true) // the counter moved, so the save must be written
    expect(s.chips).toBe(0)
    expect(s.quests.progress.win_two).toBe(1)
    const second = advanceQuests(s, 'level_win', at(day))
    expect(second.grants.map(g => g.id)).toEqual(['win_two'])
    expect(s.chips).toBe(25)
  })

  it('rolls the whole slate at midnight — yesterday’s progress AND claims are dead', () => {
    const day = firstDayDrawing('win_level')
    const s = save({ chips: 0 })
    advanceQuests(s, 'level_win', at(day))
    expect(s.quests.claimed).toEqual(['win_level'])

    const tomorrow = nextDay(day)
    expect(questsForDay(tomorrow).map(g => g.id)).toContain('spin_slots') // the fixture's assumption
    advanceQuests(s, 'slots_spun', at(tomorrow))
    expect(s.quests.day).toBe(tomorrow)
    expect(s.quests.claimed).toEqual(['spin_slots'])
    expect(s.quests.progress).toEqual({ spin_slots: 1 })
    expect(s.chips).toBe(25) // 15 yesterday + 10 today: the slate resets, the chips do not
  })

  it('pays the ALL-CLEAR once when the last row ticks', () => {
    const day = firstDayDrawing('win_level')
    const s = save({ chips: 0 })
    advanceQuests(s, 'level_win', at(day))
    advanceQuests(s, 'slots_spun', at(day))
    const last = advanceQuests(s, 'endless_end', at(day))
    expect(last.grants.map(g => g.id)).toEqual(['run_board', ALL_CLEAR_ID])
    const bonus = last.grants[1]
    expect(bonus.goal).toBeNull()
    expect(bonus.label).toBe(ALL_CLEAR_LABEL)
    expect(bonus.chips).toBe(ALL_CLEAR_CHIPS)
    expect(bonus.freeSpins).toBe(ALL_CLEAR_SPINS)
    expect(s.chips).toBe(60) // 15 + 10 + 15 + 20 — the FLOOR of the spread; a win_two day tops out at 70
    expect(s.freeSpins).toBe(1)
    expect(questState(s, at(day)).allClear).toBe(true)
    expect(questState(s, at(day)).chipsLeft).toBe(0)

    // ...and never again, however many more signals arrive.
    const before = JSON.stringify(s)
    advanceQuests(s, 'level_win', at(day))
    advanceQuests(s, 'slots_spun', at(day))
    expect(JSON.stringify(s)).toBe(before)
  })

  it('honours the free-spin BANK cap and reports what actually stuck', () => {
    // A bonus that names a spin the player did not receive is the ugliest possible way to pay one.
    const day = firstDayDrawing('win_level')
    const s = save({ freeSpins: FREE_SPIN_BANK_CAP })
    for (const signal of ['level_win', 'slots_spun', 'endless_end'] as const) {
      advanceQuests(s, signal, at(day))
    }
    expect(s.freeSpins).toBe(FREE_SPIN_BANK_CAP)
    expect(questState(s, at(day)).allClear).toBe(true)
    expect(s.chips).toBe(60) // the chips still land — a full bank forfeits the spin, not the bonus
  })

  it('bypasses the daily EARN cap, like every non-farmable source', () => {
    // FREE_SPIN_DAILY_CAP bounds the one farmable source — a marathon session banking cascade
    // awards. A once-a-day all-clear is not that, and letting a day's cascades silently eat it would
    // be the same mistake `grantStreakReward` and `grantBonusDrop` both document.
    const day = firstDayDrawing('win_level')
    const s = save({ freeSpins: 0, freeSpinsDay: '2026-01-01', freeSpinsEarnedToday: 6 })
    for (const signal of ['level_win', 'slots_spun', 'endless_end'] as const) {
      advanceQuests(s, signal, at(day))
    }
    expect(s.freeSpins).toBe(1)
  })

  it('checks the ALL-CLEAR on every signal, not only on one that completed a goal', () => {
    // The cross-device case: finish the last goal on the phone, open the tablet, and the merge
    // arrives holding all three claims and no bonus. Nothing on the tablet will ever "complete" a
    // goal again today, so a bonus gated on a completion would strand until tomorrow — when the slate
    // is gone. Gated on the claim latch, it simply pays on the next thing the player does.
    const day = firstDayDrawing('win_level')
    const s = save({
      quests: { day, progress: {}, claimed: questsForDay(day).map(g => g.id) },
      chips: 0,
    })
    const { grants } = advanceQuests(s, 'slots_spun', at(day))
    expect(grants.map(g => g.id)).toEqual([ALL_CLEAR_ID])
    expect(s.chips).toBe(ALL_CLEAR_CHIPS)
  })

  it('is total on junk — a malformed slate reads as an expired one', () => {
    const day = firstDayDrawing('win_level')
    const s = save()
    ;(s as unknown as { quests: unknown }).quests = 'not a slate'
    expect(() => advanceQuests(s, 'slots_spun', at(day))).not.toThrow()
    expect(s.quests.day).toBe(day)
    expect(s.quests.claimed).toEqual(['spin_slots'])

    const bare = { unlocked: 5 } as unknown as SaveData
    expect(() => questState(bare, at(day))).not.toThrow()
    expect(questState(bare, at(day)).goals.map(row => row.done)).toEqual([0, 0, 0])
  })

  it('drops a slate whose day is junk, rather than repairing it field by field', () => {
    // Progress and claims mean nothing except relative to a day, so a dateless slate is not a damaged
    // slate — it is not a slate. Keeping the claims would let a blob arriving through the origin
    // handoff or a pasted backup code smuggle in claims some later day might honour.
    expect(coerceSave({ quests: { day: 'whenever', progress: { win_two: 2 }, claimed: ['win_two'] } }).quests).toEqual(
      { day: '', progress: {}, claimed: [] }
    )
    expect(coerceSave({ quests: 'nope' }).quests).toEqual({ day: '', progress: {}, claimed: [] })
    expect(coerceSave({}).quests).toEqual({ day: '', progress: {}, claimed: [] })
    // A well-formed slate survives, with junk entries filtered out of both halves.
    expect(
      coerceSave({
        quests: {
          day: '2026-08-24',
          progress: { win_two: 1, bad: 'x' as unknown as number, zero: 0 },
          claimed: ['win_two', 'win_two', 7 as unknown as string],
        },
      }).quests
    ).toEqual({ day: '2026-08-24', progress: { win_two: 1 }, claimed: ['win_two'] })
  })

  it('never aliases DEFAULTS’ slate between two fresh saves', () => {
    const a = coerceSave({})
    const b = coerceSave({})
    a.quests.progress.win_level = 1
    a.quests.claimed.push('win_level')
    expect(b.quests.progress).toEqual({})
    expect(b.quests.claimed).toEqual([])
  })
})

describe('questState — a READ that never writes', () => {
  it('rolls the day over in the returned view only, leaving the save untouched', () => {
    // ⚠️ A read path that repairs the save is a write that happens on render: it fires from whichever
    // scene drew first, on an object the caller may be midway through mutating, and it makes "when
    // did the day roll" depend on which screen the player opened.
    const day = firstDayDrawing('win_level')
    const s = save()
    advanceQuests(s, 'level_win', at(day))
    const stale = JSON.stringify(s)

    const tomorrow = nextDay(day)
    const view = questState(s, at(tomorrow))
    expect(view.day).toBe(tomorrow)
    expect(view.goals.every(row => !row.claimed && row.done === 0)).toBe(true)
    expect(JSON.stringify(s)).toBe(stale)
  })

  it('reads today’s slate on the RACE calendar', () => {
    const now = new Date('2026-08-24T22:00:00Z')
    expect(questState(save(), now).day).toBe(dayKey(now))
    expect(questState(save(), now).goals.map(row => row.goal)).toEqual(questsForDay(dayKey(now)))
  })
})

describe('recordQuestSignal — award-first, through the real save', () => {
  it('pays once across two separate loads of the save', () => {
    // The public door, and the one a scene actually calls. `advanceQuests`' inertness is only useful
    // if it survives the load→persist round trip that separates two taps.
    const now = new Date('2026-08-24T18:00:00Z')
    const day = dayKey(now)
    const goal = questsForDay(day).find(g => g.signal === 'slots_spun')
    expect(goal).toBeDefined()

    const first = recordQuestSignal('slots_spun', now)
    expect(first.map(g => g.id)).toEqual(['spin_slots'])
    const second = recordQuestSignal('slots_spun', now)
    expect(second).toEqual([])
    expect(JSON.parse(localStorage.getItem(KEY) as string).chips).toBe(10)
  })

  it('persists the counter even when nothing paid yet', () => {
    const day = firstDayDrawing('win_two')
    recordQuestSignal('level_win', at(day))
    const stored = JSON.parse(localStorage.getItem(KEY) as string)
    expect(stored.quests).toEqual({ day, progress: { win_two: 1 }, claimed: [] })
    expect(stored.chips).toBe(0)
  })
})

describe('merge', () => {
  it('keeps a claim from the losing save, so a goal can never be paid twice', () => {
    // The full merge pins live in merge.test.ts; this is the behavioural one that matters here —
    // a claim that a merge drops is a purse the next signal pays again.
    const day = firstDayDrawing('win_level')
    const phone = save({ unlocked: 5, quests: { day, progress: { win_level: 1 }, claimed: ['win_level'] } })
    const tablet = save({ unlocked: 90, quests: { day, progress: {}, claimed: [] } })
    const merged = mergeSaves(phone, tablet)
    expect(merged.unlocked).toBe(90) // progress still rides the winner
    expect(merged.quests.claimed).toEqual(['win_level'])
    merged.chips = 0
    expect(advanceQuests(merged, 'level_win', at(day)).grants).toEqual([])
    expect(merged.chips).toBe(0)
  })
})

describe('analytics', () => {
  it('names the event once, and reports what a claim actually paid', () => {
    // ⚠️ A NEW event name is stored perfectly and charted nowhere until a migration teaches the
    // dashboard views about it (0014/0015/0021/0022 hardcode `name in (...)`). Accepted, same as
    // `bonus_drop`: this is a new mechanic, so there is no existing event to ride as a prop.
    //
    // The name lives in the EVENTS vocabulary and nowhere else — this file used to pin a second copy
    // exported from quests.ts, which is the `BOOST_META` scar in miniature.
    expect(EVENTS.QUEST_CLAIM).toBe('quest_claim')
    const day = firstDayDrawing('win_level')
    const s = save()
    advanceQuests(s, 'level_win', at(day))
    advanceQuests(s, 'slots_spun', at(day))
    const { grants } = advanceQuests(s, 'endless_end', at(day))
    expect(questClaimProps(grants[0])).toEqual({ quest: 'run_board', chips: 15, spins: 0 })
    // `spins` on the bonus row is worth carrying even though only that row pays any: a 0 there is a
    // free spin the BANK CAP ate, which is invisible from every other angle.
    expect(questClaimProps(grants[1])).toEqual({ quest: ALL_CLEAR_ID, chips: 20, spins: 1 })
  })
})

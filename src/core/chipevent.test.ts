import { describe, expect, it } from 'vitest'
import { CHIP_EVENTS, activeChipEvent, eventChipReward, eventRemaining, type ChipEvent } from './chipevent'
import { weekEndsAt, weekKey } from './endless'

const at = (iso: string): Date => new Date(iso)

/** The first weekend, by id — the table is append-only, so this row must always be findable. */
const weekend1 = CHIP_EVENTS.find(ev => ev.id === 'double-chips-2026-w36') as ChipEvent

describe('the first DOUBLE CHIPS WEEKEND', () => {
  it('exists, doubles, and is named for the player', () => {
    expect(weekend1).toBeDefined()
    expect(weekend1.mult).toBe(2)
    expect(weekend1.label).toBe('DOUBLE CHIPS WEEKEND')
  })

  it('closes at the exact instant the weekly endless season resets (Monday midnight, RACE_TZ)', () => {
    // Monday 2026-09-07 00:00 America/Edmonton (MDT, UTC−6) — pinned as an instant so a change to
    // the race calendar shows up here as well as in endless.test.ts.
    expect(weekend1.until.toISOString()).toBe('2026-09-07T06:00:00.000Z')
    expect(weekend1.until.getTime()).toBe(weekEndsAt(weekend1.from).getTime())
    // The whole window sits inside ONE race week, so "ends when the board resets" is true of every
    // instant in it, not just the last one.
    expect(weekKey(weekend1.from)).toBe('2026-W36')
    expect(weekKey(new Date(weekend1.until.getTime() - 1))).toBe('2026-W36')
    expect(weekKey(weekend1.until)).toBe('2026-W37')
  })

  it('starts on the deploy afternoon, before the weekend proper', () => {
    expect(weekend1.from.toISOString()).toBe('2026-09-04T21:00:00.000Z')
    expect(weekend1.from.getTime()).toBeLessThan(weekend1.until.getTime())
  })
})

describe('activeChipEvent — a half-open window shared by every device', () => {
  it('is off the instant before it opens and on at the opening instant', () => {
    expect(activeChipEvent(new Date(weekend1.from.getTime() - 1))).toBeNull()
    expect(activeChipEvent(weekend1.from)?.id).toBe(weekend1.id)
  })

  it('is on through the last millisecond of Sunday and off at Monday midnight', () => {
    expect(activeChipEvent(new Date(weekend1.until.getTime() - 1))?.id).toBe(weekend1.id)
    expect(activeChipEvent(weekend1.until)).toBeNull()
    expect(activeChipEvent(at('2026-09-08T12:00:00Z'))).toBeNull()
  })

  it('reads the instant, not the device calendar — Tokyo and Chicago agree', () => {
    // Sunday 23:30 in Edmonton is already Monday 14:30 in Tokyo; both are inside the window.
    const lateSunday = at('2026-09-07T05:30:00Z')
    expect(activeChipEvent(lateSunday)?.id).toBe(weekend1.id)
  })

  it('refuses a broken clock rather than guessing', () => {
    expect(activeChipEvent(new Date(NaN))).toBeNull()
  })

  it('the table never lets two events claim the same instant', () => {
    const rows = [...CHIP_EVENTS].sort((a, b) => a.from.getTime() - b.from.getTime())
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].from.getTime()).toBeGreaterThanOrEqual(rows[i - 1].until.getTime())
    }
    for (const ev of rows) expect(ev.from.getTime()).toBeLessThan(ev.until.getTime())
  })
})

describe('eventChipReward — the multiplier rides the FINAL purse', () => {
  const inside = at('2026-09-05T18:00:00Z')
  const outside = at('2026-09-01T18:00:00Z')

  it('doubles a fresh clear inside the window', () => {
    // 3★ with 5 moves left: 3·8 + 5·2 = 34 base.
    expect(eventChipReward(34, inside)).toEqual({ chips: 68, mult: 2, event: weekend1 })
  })

  it('pays the plain purse outside it', () => {
    expect(eventChipReward(34, outside)).toEqual({ chips: 34, mult: 1, event: null })
  })

  it('keeps §G4 replay discounting in the ratio — a replay quarter doubles to a half, never to full', () => {
    const replay = Math.round(34 * 0.25) // what finishWin passes in for a non-improving replay
    expect(eventChipReward(replay, inside).chips).toBe(replay * 2)
    expect(eventChipReward(replay, inside).chips).toBeLessThan(34)
  })

  it('cannot mint chips from nothing', () => {
    expect(eventChipReward(0, inside).chips).toBe(0)
    expect(eventChipReward(-12, inside).chips).toBe(0)
    expect(eventChipReward(2.7, inside).chips).toBe(4) // floors the base first, then multiplies
  })

  it('treats a ×1 row as no event, so a mis-typed table cannot decorate a plain purse', () => {
    const table: ChipEvent[] = [{ id: 'noop', label: 'NOTHING', mult: 1, from: weekend1.from, until: weekend1.until }]
    expect(eventChipReward(34, inside, table)).toEqual({ chips: 34, mult: 1, event: null })
  })
})

describe('eventRemaining', () => {
  it('counts down in the race panels\' own coarse units', () => {
    expect(eventRemaining(weekend1, at('2026-09-05T00:00:00Z'))).toBe('2d 6h')
    expect(eventRemaining(weekend1, at('2026-09-07T05:12:00Z'))).toBe('48m')
    expect(eventRemaining(weekend1, weekend1.until)).toBe('under a minute')
  })
})

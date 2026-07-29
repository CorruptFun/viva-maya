import { beforeEach, describe, expect, it } from 'vitest'
import {
  CHARMS,
  CHARM_EXCHANGE,
  DUPLICATE_CHIPS,
  LUCK_CAP,
  SERIES_PURSE,
  SERIES_SIZE,
  canAfford,
  grantCharm,
  hasCharm,
  luckOf,
  missingCharms,
  ownedCharms,
  redeemCharms,
  rollCharm,
  seriesComplete,
  seriesLabel,
} from './charms'
import { LIVES_MAX } from '../config'
import { loadSave, persistSave } from './save'
import { mergeSaves } from './merge'
import { mulberry32 } from './rng'

/**
 * The charm collection — the one reward in the game the player KEEPS, so the properties that matter
 * are the ones about not losing it and not paying for it twice: every heart is progress, a completed
 * album pays exactly once, and a second device can never resurrect an album whose purse is banked.
 */

const KEY = 'viva-maya:v1'

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

/** Put the album at an exact state without going through grantCharm. */
function setAlbum(ids: string[], series = 1, allTime = ids.length, chips = 0): void {
  const save = loadSave()
  save.charms = [...ids]
  save.charmSeries = series
  save.charmsAllTime = allTime
  save.chips = chips
  persistSave(save)
}

describe('the catalogue', () => {
  it('is a full 3×3 album with unique ids', () => {
    expect(CHARMS).toHaveLength(SERIES_SIZE)
    expect(SERIES_SIZE).toBe(9)
    expect(new Set(CHARMS.map(c => c.id)).size).toBe(SERIES_SIZE)
  })

  it('never reuses a board symbol id, so a charm can never be confused for a game piece', () => {
    const boardSymbols = ['cherry', 'seven', 'diamond', 'bell', 'bar']
    for (const c of CHARMS) expect(boardSymbols).not.toContain(c.id)
  })
})

describe('rolling a charm', () => {
  it('only ever draws a charm the player is MISSING — every heart is progress', () => {
    // The coupon-collector trap this exists to avoid: a blind roll over all nine would make the last
    // slot of an album take ~9 hearts on average, so the closer you got the worse the game treated you.
    const owned = CHARMS.slice(0, 7).map(c => c.id)
    setAlbum(owned)
    const save = loadSave()
    const rng = mulberry32(9)
    for (let i = 0; i < 500; i++) {
      const drawn = rollCharm(save, rng)!
      expect(owned).not.toContain(drawn.id)
    }
  })

  it('covers every gap given enough rolls (no unreachable slot)', () => {
    setAlbum([])
    const save = loadSave()
    const rng = mulberry32(11)
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) seen.add(rollCharm(save, rng)!.id)
    expect(seen.size).toBe(SERIES_SIZE)
  })

  it('returns null only when the album is full', () => {
    setAlbum(CHARMS.map(c => c.id))
    expect(rollCharm(loadSave(), mulberry32(1))).toBeNull()
  })
})

describe('granting', () => {
  it('fills an album in exactly SERIES_SIZE hearts and never deals a duplicate on the way', () => {
    const rng = mulberry32(4)
    const ids: string[] = []
    for (let i = 0; i < SERIES_SIZE; i++) {
      const award = grantCharm(rng)
      expect(award.kind).toBe('charm')
      if (award.kind === 'charm') ids.push(award.charm.id)
    }
    expect(new Set(ids).size).toBe(SERIES_SIZE)
  })

  it('pays the purse and rolls the series over on the ninth charm — once, atomically', () => {
    setAlbum(CHARMS.slice(0, SERIES_SIZE - 1).map(c => c.id), 1, SERIES_SIZE - 1, 100)
    const award = grantCharm(mulberry32(5))
    expect(award.kind).toBe('charm')
    if (award.kind !== 'charm' || !award.completed) throw new Error('expected a completing charm')
    expect(award.purse).toBe(SERIES_PURSE)
    expect(award.balance).toBe(100 + SERIES_PURSE)

    const after = loadSave()
    expect(after.charms).toEqual([]) // the album resets…
    expect(after.charmSeries).toBe(2) // …into a fresh series…
    expect(after.charmsAllTime).toBe(SERIES_SIZE) // …but the all-time count never resets
    expect(after.chips).toBe(100 + SERIES_PURSE)
  })

  it('completing a series can never LOWER luck — that is why luck reads all-time', () => {
    setAlbum(CHARMS.slice(0, SERIES_SIZE - 1).map(c => c.id), 1, SERIES_SIZE - 1)
    const before = luckOf(loadSave())
    grantCharm(mulberry32(6))
    expect(luckOf(loadSave())).toBeGreaterThanOrEqual(before)
  })

  it('pays chips for a duplicate rather than a blank', () => {
    setAlbum(CHARMS.map(c => c.id), 3, 30, 10)
    const award = grantCharm(mulberry32(7))
    expect(award.kind).toBe('duplicate')
    if (award.kind !== 'duplicate') throw new Error('expected a duplicate')
    expect(award.chips).toBe(DUPLICATE_CHIPS)
    expect(loadSave().chips).toBe(10 + DUPLICATE_CHIPS)
    // A duplicate is not progress — it must not inflate the all-time count that drives luck.
    expect(loadSave().charmsAllTime).toBe(30)
  })
})

describe('luck', () => {
  it('tracks all-time charms and stops dead at the cap', () => {
    setAlbum([], 1, 0)
    expect(luckOf(loadSave())).toBe(0)
    setAlbum([], 2, 5)
    expect(luckOf(loadSave())).toBe(5)
    setAlbum([], 9, 500)
    expect(luckOf(loadSave())).toBe(LUCK_CAP)
  })

  it('is monotone across a long collecting run', () => {
    const rng = mulberry32(12)
    let last = 0
    for (let i = 0; i < 40; i++) {
      grantCharm(rng)
      const now = luckOf(loadSave())
      expect(now).toBeGreaterThanOrEqual(last)
      last = now
    }
    expect(last).toBe(LUCK_CAP)
  })
})

describe('album readouts', () => {
  it('splits owned from missing in catalogue order', () => {
    setAlbum([CHARMS[2].id, CHARMS[0].id])
    const save = loadSave()
    expect(ownedCharms(save).map(c => c.id)).toEqual([CHARMS[0].id, CHARMS[2].id])
    expect(missingCharms(save)).toHaveLength(SERIES_SIZE - 2)
    expect(hasCharm(save, CHARMS[0].id)).toBe(true)
    expect(hasCharm(save, CHARMS[1].id)).toBe(false)
    expect(seriesComplete(save)).toBe(false)
  })

  it('numbers series in roman', () => {
    expect(seriesLabel(1)).toBe('I')
    expect(seriesLabel(4)).toBe('IV')
    expect(seriesLabel(9)).toBe('IX')
    expect(seriesLabel(14)).toBe('XIV')
    expect(seriesLabel(0)).toBe('I') // defensive: a save can never hold series 0
    expect(seriesLabel(40)).toBe('40') // past the numeral table, fall back to digits
  })
})

describe('the exchange', () => {
  const DAY = '2026-07-29'
  const item = (kind: string) => CHARM_EXCHANGE.find(i => i.kind === kind)!

  it('prices everything within reach of one album, so completing never becomes the mug\'s game', () => {
    for (const i of CHARM_EXCHANGE) {
      expect(i.price).toBeGreaterThan(0)
      expect(i.price).toBeLessThan(SERIES_SIZE)
    }
  })

  it('sells nothing the CHIP economy already sells — the two must not compete', () => {
    // A chips option here would put the shelf in direct competition with the SERIES_PURSE and one of
    // the two would always be strictly the wrong choice. Every slot pays a different KIND of thing.
    for (const i of CHARM_EXCHANGE) expect(['spin', 'hearts', 'deal']).toContain(i.kind)
  })

  it('refuses when the album cannot afford it, leaving the save untouched', () => {
    setAlbum([CHARMS[0].id])
    expect(redeemCharms(item('hearts'), DAY)).toBeNull()
    expect(loadSave().charms).toEqual([CHARMS[0].id])
  })

  it('takes the price NEWEST-first and hands over the goods', () => {
    setAlbum([CHARMS[0].id, CHARMS[1].id, CHARMS[2].id])
    const out = redeemCharms(item('hearts'), DAY)!
    expect(out.spent).toEqual([CHARMS[1].id, CHARMS[2].id]) // the two most recently won
    expect(out.charmsLeft).toBe(1)
    expect(loadSave().charms).toEqual([CHARMS[0].id]) // the longest-held one survives
  })

  it('refills the pool for FULL HEARTS', () => {
    setAlbum([CHARMS[0].id, CHARMS[1].id])
    const save = loadSave()
    save.lives = 0
    save.livesAnchor = 12345
    persistSave(save)
    redeemCharms(item('hearts'), DAY)
    expect(loadSave().lives).toBe(LIVES_MAX)
    expect(loadSave().livesAnchor).toBe(0)
  })

  it('banks a real spin for FREE SPIN', () => {
    setAlbum([CHARMS[0].id])
    const out = redeemCharms(item('spin'), DAY)!
    expect(out.spins).toBe(1)
    expect(loadSave().freeSpins).toBe(1)
    expect(loadSave().charms).toEqual([])
  })

  it('REFUSES a spin the bank cannot hold rather than eating the charm', () => {
    // The same "never advertise a prize you can't pay" rule the BELL and the plinko wells follow —
    // and here it matters more, because the player would be handing over a collectible for nothing.
    setAlbum([CHARMS[0].id, CHARMS[1].id])
    const save = loadSave()
    save.freeSpins = 12 // FREE_SPIN_BANK_CAP
    persistSave(save)
    expect(redeemCharms(item('spin'), DAY)).toBeNull()
    expect(loadSave().charms).toHaveLength(2) // untouched
  })

  it('never touches charmsAllTime, so spending can never cost you LUCK', () => {
    // The property that makes the shelf safe to use at all: the worst a purchase can do is set back
    // the ninth slot. It can never make the Deal stingier than it was before you shopped.
    setAlbum([CHARMS[0].id, CHARMS[1].id, CHARMS[2].id], 2, 11)
    const before = luckOf(loadSave())
    redeemCharms(item('deal'), DAY)
    expect(loadSave().charmsAllTime).toBe(11)
    expect(luckOf(loadSave())).toBe(before)
    expect(loadSave().charms).toEqual([]) // …but the album really was charged
  })

  it('re-opens the spent slots for future draws', () => {
    setAlbum(CHARMS.slice(0, 3).map(c => c.id))
    redeemCharms(item('hearts'), DAY)
    const gaps = missingCharms(loadSave()).map(c => c.id)
    expect(gaps).toContain(CHARMS[1].id)
    expect(gaps).toContain(CHARMS[2].id)
    expect(gaps).not.toContain(CHARMS[0].id)
  })

  it('reports affordability without writing anything', () => {
    setAlbum([CHARMS[0].id, CHARMS[1].id])
    const save = loadSave()
    expect(canAfford(save, item('spin'))).toBe(true)
    expect(canAfford(save, item('hearts'))).toBe(true)
    expect(canAfford(save, item('deal'))).toBe(false)
    expect(loadSave().charms).toHaveLength(2)
  })
})

describe('merging two devices', () => {
  const withCharms = (charms: string[], series: number, allTime: number, unlocked = 1) => {
    setAlbum(charms, series, allTime)
    const s = loadSave()
    s.unlocked = unlocked
    return s
  }

  it('unions the album when both devices are on the SAME series', () => {
    const a = withCharms([CHARMS[0].id, CHARMS[1].id], 2, 11, 30)
    const b = withCharms([CHARMS[1].id, CHARMS[5].id], 2, 12, 10)
    const merged = mergeSaves(a, b)
    expect(merged.charmSeries).toBe(2)
    expect(new Set(merged.charms)).toEqual(new Set([CHARMS[0].id, CHARMS[1].id, CHARMS[5].id]))
    expect(merged.charmsAllTime).toBe(12)
  })

  it('never resurrects an album whose purse was already paid', () => {
    // The bug this guards: blind union would hand a Series-II device all nine of the Series-I album
    // it already completed — a second SERIES_PURSE for a completion that happened once.
    const ahead = withCharms([CHARMS[0].id], 2, 10, 5)
    const behind = withCharms(CHARMS.slice(0, 8).map(c => c.id), 1, 8, 40)
    const merged = mergeSaves(behind, ahead)
    expect(merged.charmSeries).toBe(2)
    expect(merged.charms).toEqual([CHARMS[0].id])
    expect(merged.charms.length).toBeLessThan(SERIES_SIZE)
  })

  it('keeps the higher all-time count regardless of which record wins on progress', () => {
    const a = withCharms([], 1, 3, 90) // wins the progress compare
    const b = withCharms([], 1, 25, 2) // but holds the bigger collection history
    expect(mergeSaves(a, b).charmsAllTime).toBe(25)
    expect(mergeSaves(b, a).charmsAllTime).toBe(25)
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
import {
  CASE_FROM,
  COSMETICS,
  DEFAULT_COSMETICS,
  boutiqueOpen,
  buyCosmetic,
  cheapestPrice,
  cosmetic,
  equip,
  equipped,
  equippedAll,
  owns,
  shelf,
  shelfOpen,
  slotGoods,
  starBalance,
  starsEarned,
  starsSpent,
} from './boutique'
import type { CosmeticSlot } from './boutique'
import { ACT2_FROM } from './actII'
import { coerceSave, loadSave, persistSave } from './save'
import type { SaveData } from './save'
import { mergeSaves } from './merge'
import { chasePattern, chipFace, cushionTints, swatch, winTrail } from '../view/cosmetics'
import { THEMES, DEFAULT_THEME_ID } from '../view/theme'

/**
 * THE BOUTIQUE — the star sink.
 *
 * Two of these assertions are the ones that cost a player something real if they break, and neither
 * is visible in review:
 *
 *  1. THE PRICE LIST IS A LEDGER. The balance is DERIVED (`stars earned − price of what is owned`),
 *     so editing a shipped price is not a retune — it silently re-charges or REFUNDS every player
 *     who already owns that item, on their next app open. The GOLDEN table below is the tripwire.
 *  2. THE BALANCE CAN NEVER FALL. `starsEarned` is a sum over `save.stars`, so it is only monotone
 *     while every path that writes that map is monotone — including the cross-device merge. That is
 *     why the `stars` per-key max landed with this feature and is asserted here rather than only in
 *     merge.test.ts: it is the boutique's foundation, not a merge nicety.
 */

const KEY = 'viva-maya:v1'
const EQUIP_KEY = 'viva-maya:boutique'

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
  localStorage.removeItem(EQUIP_KEY)
})

/** A save with `n` stars' worth of cleared levels, and whatever else the case needs. */
function saveWith(stars: number, extra: Partial<SaveData> = {}): SaveData {
  const s = coerceSave({})
  for (let i = 1; i * 3 <= stars; i++) s.stars[i] = 3
  const rest = stars % 3
  if (rest > 0) s.stars[Math.floor(stars / 3) + 1] = rest
  return { ...s, ...extra }
}

/** Persist a save so the module-level writers (buyCosmetic) see it. */
function put(save: SaveData): void {
  persistSave(save)
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the catalogue', () => {
  /**
   * GOLDEN — every shipped id and its price, exactly as sold.
   *
   * ⚠️ A DIFF HERE IS A REFUND (or a surprise charge), NOT A RETUNE. Because the balance subtracts
   * these prices at read time, lowering one hands stars back to everyone who owns it and raising one
   * takes stars they already spent. Add rows freely; never edit or delete one.
   */
  const GOLDEN: [string, number][] = [
    ['cushion.house', 0],
    ['chip.house', 0],
    ['trail.house', 0],
    ['chase.house', 0],
    ['cushion.claret', 60],
    ['trail.goldrush', 70],
    ['chip.ivory', 80],
    ['chase.twincrest', 90],
    ['cushion.emerald', 100],
    ['trail.rosefall', 110],
    ['chip.midnight', 120],
    ['cushion.oxblood', 150],
    ['chase.runner', 170],
    ['chip.obsidian', 190],
    ['cushion.penthouse', 190],
    ['trail.champagne', 200],
  ]

  it('is exactly what shipped, at exactly the prices that shipped', () => {
    expect(COSMETICS.map(c => [c.id, c.price])).toEqual(GOLDEN)
  })

  it('prices the two shelves against the lifetime star cap', () => {
    // 3 stars × 600 levels is the act's designed end — the cap the ladder is priced against. The
    // catalogue must stay comfortably under it, or a completionist buys the shop out and the third
    // star stops being worth chasing on the levels after that.
    const total = COSMETICS.reduce((n, c) => n + c.price, 0)
    expect(total).toBe(1530)
    expect(total).toBeLessThan(1800)
    // And the counter alone must be reachable well inside the ladder that exists today (400 levels
    // → 1,200 stars), or the "opens early" promise is only a promise.
    expect(shelf('counter').reduce((n, c) => n + c.price, 0)).toBe(630)
    expect(shelf('case').reduce((n, c) => n + c.price, 0)).toBe(900)
  })

  it('has one free default per slot, and every default is genuinely free', () => {
    for (const [slot, id] of Object.entries(DEFAULT_COSMETICS) as [CosmeticSlot, string][]) {
      const c = cosmetic(id)
      expect({ slot, found: c !== null, price: c?.price, inSlot: c?.slot }).toEqual({
        slot,
        found: true,
        price: 0,
        inSlot: slot,
      })
    }
    // Nothing else is free — a second free good in a slot would make "the default" ambiguous.
    expect(COSMETICS.filter(c => c.price === 0).map(c => c.id).sort()).toEqual(
      Object.values(DEFAULT_COSMETICS).sort()
    )
  })

  it('uses each id once, and sells something in every slot', () => {
    expect(new Set(COSMETICS.map(c => c.id)).size).toBe(COSMETICS.length)
    for (const slot of Object.keys(DEFAULT_COSMETICS) as CosmeticSlot[]) {
      expect({ slot, forSale: slotGoods(slot).filter(c => c.price > 0).length > 0 }).toEqual({ slot, forSale: true })
    }
    // Ids are `slot.name`, which is what makes an unknown id from a newer client readable in a
    // support log rather than an opaque token.
    for (const c of COSMETICS) expect({ id: c.id, ok: c.id.startsWith(`${c.slot}.`) }).toEqual({ id: c.id, ok: true })
  })

  it('opens the high-roller case on the act’s own front door', () => {
    expect(CASE_FROM).toBe(ACT2_FROM)
  })
})

describe('the derived balance', () => {
  it('is every star earned, less the price of everything owned', () => {
    const save = saveWith(300, { ownedCosmetics: ['cushion.claret', 'chip.ivory'] })
    expect(starsEarned(save)).toBe(300)
    expect(starsSpent(save)).toBe(140)
    expect(starBalance(save)).toBe(160)
  })

  it('charges nothing for a default, however it got into the owned list', () => {
    const save = saveWith(90, { ownedCosmetics: ['cushion.house', 'chase.house'] })
    expect(starBalance(save)).toBe(90)
  })

  it('prices an unknown id at nothing rather than guessing', () => {
    // A save written by a NEWER client can name a cosmetic this build has never heard of. Charging
    // a guess would make two clients looking at the same save disagree about the balance; pricing
    // it at zero means the older build simply cannot show the item it also cannot render.
    const save = saveWith(200, { ownedCosmetics: ['cushion.claret', 'cushion.fromTheFuture'] })
    expect(starBalance(save)).toBe(140)
    expect(owns(save, 'cushion.fromTheFuture')).toBe(true)
    expect(cosmetic('cushion.fromTheFuture')).toBeNull()
  })

  it('never goes negative, even on a save that owns more than it earned', () => {
    // Not reachable through the game — but an imported backup code from a build with a longer
    // catalogue is, and a shop showing "-40 ★" is worse than one showing nothing to spend.
    const save = saveWith(30, { ownedCosmetics: ['trail.champagne', 'chip.obsidian'] })
    expect(starBalance(save)).toBe(0)
  })

  it('survives a junk stars map without throwing or inventing a balance', () => {
    const save = coerceSave({ stars: { 1: 3, 2: 'lots', 3: NaN, 4: -2, 5: 2 } })
    expect(starsEarned(save)).toBe(5)
  })
})

describe('buying', () => {
  it('deducts by owning: the append IS the spend', () => {
    put(saveWith(200))
    expect(starBalance(loadSave())).toBe(200)
    expect(buyCosmetic('cushion.claret')).toBe(140)
    const after = loadSave()
    expect(after.ownedCosmetics).toEqual(['cushion.claret'])
    expect(starBalance(after)).toBe(140)
  })

  it('refuses what it cannot pay for, and leaves the save untouched', () => {
    put(saveWith(50))
    expect(buyCosmetic('cushion.claret')).toBeNull()
    expect(loadSave().ownedCosmetics).toEqual([])
  })

  it('refuses a second purchase of the same good', () => {
    put(saveWith(400))
    expect(buyCosmetic('cushion.claret')).toBe(340)
    expect(buyCosmetic('cushion.claret')).toBeNull()
    expect(loadSave().ownedCosmetics).toEqual(['cushion.claret'])
  })

  it('refuses a default, a free item and an unknown id', () => {
    put(saveWith(400))
    expect(buyCosmetic('cushion.house')).toBeNull()
    expect(buyCosmetic('nope.nothing')).toBeNull()
    expect(loadSave().ownedCosmetics).toEqual([])
  })

  it('keeps the high-roller case shut until the act opens — however rich you are', () => {
    put(saveWith(1200, { unlocked: 200 }))
    expect(shelfOpen(loadSave(), 'case')).toBe(false)
    expect(buyCosmetic('trail.champagne')).toBeNull()
    // …and the counter is open the whole time, which is the point of the two shelves.
    expect(shelfOpen(loadSave(), 'counter')).toBe(true)
    expect(buyCosmetic('cushion.claret')).toBe(1140)

    put(saveWith(1200, { unlocked: CASE_FROM }))
    expect(shelfOpen(loadSave(), 'case')).toBe(true)
    expect(buyCosmetic('trail.champagne')).toBe(1000)
  })
})

describe('the progressive reveal', () => {
  it('opens the door the moment the cheapest thing is in reach, and never closes it again', () => {
    expect(boutiqueOpen(saveWith(0))).toBe(false)
    expect(boutiqueOpen(saveWith(cheapestPrice() - 1))).toBe(false)
    expect(boutiqueOpen(saveWith(cheapestPrice()))).toBe(true)
    // Spent right back down to nothing: the shop stays open, because it is now the only place the
    // thing they bought can be taken off again.
    expect(boutiqueOpen(saveWith(cheapestPrice(), { ownedCosmetics: ['cushion.claret'] }))).toBe(true)
  })

  it('is reachable by a real mid-ladder player, not only by an Act II one', () => {
    // The measured population sits around level 42 (median). At a modest two stars a level that is
    // ~84 stars — the counter has to be open well inside that, or the one item in this slice that
    // reaches today's players reaches nobody.
    expect(cheapestPrice()).toBeLessThanOrEqual(84)
    expect(boutiqueOpen(saveWith(84))).toBe(true)
  })
})

describe('what is worn', () => {
  it('falls back to the house set for anything not owned', () => {
    const poor = saveWith(0)
    expect(equippedAll(poor)).toEqual(DEFAULT_COSMETICS)
    // Equipping something you do not own is refused outright…
    expect(equip(poor, 'cushion.claret')).toBe(false)
    expect(equipped(poor, 'cushion')).toBe(DEFAULT_COSMETICS.cushion)
  })

  it('wears what you own, per slot, without touching the save', () => {
    const rich = saveWith(400, { ownedCosmetics: ['cushion.emerald', 'chase.twincrest'] })
    expect(equip(rich, 'cushion.emerald')).toBe(true)
    expect(equip(rich, 'chase.twincrest')).toBe(true)
    expect(equippedAll(rich)).toEqual({
      ...DEFAULT_COSMETICS,
      cushion: 'cushion.emerald',
      chase: 'chase.twincrest',
    })
    // A look is a per-device preference — nothing about equipping may reach the save blob.
    put(rich)
    expect(loadSave().ownedCosmetics).toEqual(['cushion.emerald', 'chase.twincrest'])
  })

  it('degrades to the house set when ownership goes away under it', () => {
    // The real case: equip on this phone, then restore a backup code from before the purchase (or
    // pull a cloud save that predates it). The look must not survive the ownership.
    const rich = saveWith(400, { ownedCosmetics: ['cushion.emerald'] })
    expect(equip(rich, 'cushion.emerald')).toBe(true)
    expect(equipped(rich, 'cushion')).toBe('cushion.emerald')
    expect(equipped(saveWith(400), 'cushion')).toBe(DEFAULT_COSMETICS.cushion)
  })

  it('ignores a corrupt or foreign equip blob', () => {
    localStorage.setItem(EQUIP_KEY, '{"cushion":42,"nonsense":"x","chip":"chip.ivory"}')
    const rich = saveWith(400, { ownedCosmetics: ['chip.ivory'] })
    expect(equippedAll(rich)).toEqual({ ...DEFAULT_COSMETICS, chip: 'chip.ivory' })
    localStorage.setItem(EQUIP_KEY, 'not json at all')
    expect(equippedAll(rich)).toEqual(DEFAULT_COSMETICS)
  })
})

describe('two devices', () => {
  it('unions the goods, so a purchase on either arrives on both — and is paid for on both', () => {
    const phone = saveWith(300, { ownedCosmetics: ['cushion.claret'] })
    const tablet = saveWith(300, { unlocked: 90, ownedCosmetics: ['chip.ivory'] })
    const merged = mergeSaves(phone, tablet)
    expect(merged.ownedCosmetics.sort()).toEqual(['chip.ivory', 'cushion.claret'])
    // Both spends survive; nothing had to be reconciled, because there is no spend counter.
    expect(starBalance(merged)).toBe(300 - 60 - 80)
  })

  it('takes the best stars PER LEVEL, so a merge can never shrink the balance', () => {
    // The failure this closes: three-star L4 on the phone, one-star it on a tablet that happens to
    // be further unlocked, and a winner-takes-all merge confiscates two stars — a balance the
    // player watches go DOWN having bought nothing.
    const phone: SaveData = { ...coerceSave({}), stars: { 1: 3, 2: 3, 3: 3, 4: 3 }, unlocked: 5 }
    const tablet: SaveData = { ...coerceSave({}), stars: { 1: 3, 2: 3, 3: 3, 4: 1, 5: 3, 6: 2 }, unlocked: 40 }
    const merged = mergeSaves(phone, tablet)
    expect(merged.stars).toEqual({ 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 2 })
    expect(starsEarned(merged)).toBe(17)
    expect(starsEarned(merged)).toBeGreaterThanOrEqual(Math.max(starsEarned(phone), starsEarned(tablet)))
  })

  it('never loses a star to the progress winner, in either direction', () => {
    const a: SaveData = { ...coerceSave({}), stars: { 10: 3 }, unlocked: 2 }
    const b: SaveData = { ...coerceSave({}), stars: { 11: 3 }, unlocked: 99 }
    expect(starsEarned(mergeSaves(a, b))).toBe(6)
    expect(starsEarned(mergeSaves(b, a))).toBe(6)
  })
})

describe('the save field', () => {
  it('defaults to empty and survives every malformed shape', () => {
    expect(coerceSave({}).ownedCosmetics).toEqual([])
    expect(coerceSave({ ownedCosmetics: 'cushion.claret' }).ownedCosmetics).toEqual([])
    expect(coerceSave({ ownedCosmetics: [1, null, 'cushion.claret', 'cushion.claret'] }).ownedCosmetics).toEqual([
      'cushion.claret',
    ])
  })

  it('round-trips through the backup code', () => {
    put(saveWith(300, { ownedCosmetics: ['cushion.claret', 'chip.ivory'] }))
    expect(coerceSave(JSON.parse(JSON.stringify(loadSave()))).ownedCosmetics).toEqual([
      'cushion.claret',
      'chip.ivory',
    ])
  })
})

/**
 * The LOOK half (`view/cosmetics.ts`). Only one assertion here really earns its place — that every
 * good in the catalogue actually resolves to something — because a priced item with no look is a
 * purchase that visibly does nothing, and it is the one failure mode a split like this invites.
 */
describe('every good has a look', () => {
  const T = THEMES[DEFAULT_THEME_ID]

  it('resolves a distinct appearance for every id it sells', () => {
    const seen = new Map<string, string>()
    for (const c of COSMETICS) {
      const s = swatch(c.id, T)
      expect({ id: c.id, pair: s.length }).toEqual({ id: c.id, pair: 2 })
      const k = s.join(',')
      // Two goods that paint the same swatch are two goods a player cannot tell apart on the shelf.
      expect({ id: c.id, clashesWith: seen.get(k) ?? null }).toEqual({ id: c.id, clashesWith: null })
      seen.set(k, c.id)
    }
  })

  it('gives HIGH CONTRAST the board, whatever is equipped', () => {
    const rich = saveWith(400, { ownedCosmetics: ['cushion.oxblood'] })
    put(rich)
    expect(equip(rich, 'cushion.oxblood')).toBe(true)
    expect(cushionTints(T, false)).not.toEqual([T.tileHcA, T.tileHcB])
    // …and with the a11y switch on, the bought table is simply not consulted.
    expect(cushionTints(T, true)).toEqual([T.tileHcA, T.tileHcB])
  })

  it('leaves an unequipped board, chip, trail and marquee exactly as they ship', () => {
    put(saveWith(0))
    expect(cushionTints(T, false)).toEqual([T.tileA, T.tileB])
    expect(winTrail()).toEqual({ tokens: ['chip', 'card'], scales: [0.85, 0.85], tint: null })
    expect(chasePattern()).toBeNull()
    // The house chip face is the original `makeChip` literal, not an approximation of it.
    expect(chipFace(T).rimMain).toBe(0xc4223e)
    expect(chipFace(T).face).toBe(T.cardFillWarm)
  })

  it('keeps every chip face readable — each bevel triple stays in lightness order', () => {
    // Every form on the token (rim, ring, pip) is faked by stacking three tones. Break the order and
    // the bevels invert, which reads as a rendering bug rather than as a different chip.
    const lum = (n: number): number => 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
    for (const c of COSMETICS.filter(x => x.slot === 'chip')) {
      const save = saveWith(400, { ownedCosmetics: [c.id] })
      put(save)
      expect(equip(save, c.id)).toBe(true)
      const f = chipFace(T)
      for (const [d, m, l] of [
        [f.rimDeep, f.rimMain, f.rimLight],
        [f.ringDeep, f.ringMain, f.ringLight],
        [f.pipDeep, f.pipMain, f.pipLight],
      ]) {
        expect({ id: c.id, ordered: lum(d) < lum(m) && lum(m) < lum(l) }).toEqual({ id: c.id, ordered: true })
      }
    }
  })
})

import { loadSave, persistSave } from './save'
import type { SaveData } from './save'

/**
 * THE BOUTIQUE — the star sink. Pure logic, no Phaser: this module names the goods and prices them,
 * `view/cosmetics.ts` decides what each one LOOKS like (the same split `hazardskins.ts` keeps — core
 * names a thing, the view dresses it).
 *
 * ── WHY STARS ──────────────────────────────────────────────────────────────────────────────────
 * Stars have been earned since the game's first week and have never been spendable. They are the
 * only currency in the game with no sink at all, which makes every one after the first a number that
 * goes up and does nothing. Chips buy boosts, charms buy spins and hearts; stars buy a LOOK — a
 * third kind of good, so the boutique deepens the loops that exist instead of adding a new one.
 *
 * ── DERIVE THE BALANCE, STORE ONLY OWNERSHIP ────────────────────────────────────────────────────
 * There is no `stars spent` counter and there must never be one. The save gains exactly ONE field,
 * `ownedCosmetics`, and the balance is computed:
 *
 *     balance = (every star ever earned)  −  (the price of everything owned)
 *
 * That single decision is what makes the whole feature merge-proof, crash-proof and migration-free:
 *
 *  • MERGE-PROOF. `ownedCosmetics` is a monotone set, so it unions across devices like every other
 *    latch (core/merge.ts). A stored balance would be a MAGNITUDE, and two devices that each bought
 *    something would have to have their spends reconciled — the exact "field-wise Frankenstein"
 *    mergeSaves refuses to build. Here, buy a cushion on the phone and a chip face on the tablet and
 *    the merged save owns both and has been charged for both, with no arithmetic at all.
 *  • CRASH-PROOF. A buy is one append. There is no window in which the stars have been deducted but
 *    the item has not arrived (or the reverse) — the deduction IS the item.
 *  • ZERO SERVER MIGRATIONS. The save blob already rides the cloud whole; a new array field needs no
 *    schema change, no guard trigger and no two-phase deploy.
 *
 * ⚠️ THE PRICE LIST IS THEREFORE APPEND-ONLY AND IMMUTABLE. Because the balance is derived from
 * prices at READ time, changing a shipped price retroactively re-charges (or refunds) every player
 * who already owns that item — silently, on their next app open. Removing an id is worse: the owned
 * entry stops costing anything and the player is handed its price back as free balance. Add new rows
 * freely; never edit or delete a shipped one. `boutique.test.ts` pins every shipped price as a
 * GOLDEN table for exactly this reason — a diff there is a REFUND, not a retune.
 *
 * ── WHAT IT MAY SELL ────────────────────────────────────────────────────────────────────────────
 * Cosmetics only, and only ones that change a surface the player looks at:
 *   · CUSHIONS  — the 8×8 board's checkerboard tint pair.
 *   · CHIP FACES— the casino token baked into `chip` (HUD balance, store, win burst, Plinko).
 *   · TRAILS    — what the win celebration throws off the board.
 *   · CHASE     — the marquee's PATTERN (how many crests travel the ring, and how fast). Never its
 *                 COLOUR: the per-theme hue arcs are a theme's identity and `rgb.test.ts` guards
 *                 them, so a bought item that moved a hue could put a colour on a theme that theme
 *                 must never show.
 * Nothing here touches difficulty, rewards, rates or progress. The DEFAULTS stay free forever, and
 * equipping anything you own is free — you are buying the object, never the right to wear it.
 */

/** The four surfaces a cosmetic can dress. One equipped item per slot, always. */
export type CosmeticSlot = 'cushion' | 'chip' | 'trail' | 'chase'

/**
 * Which shelf a good sits on. `counter` opens early (progressive reveal — see `boutiqueOpen`), which
 * is the entire point of the feature: it is the only thing in this slice that reaches a player who
 * is nowhere near Act II. `case` is the high-roller cabinet and stays silhouetted until 301.
 */
export type CosmeticShelf = 'counter' | 'case'

export interface Cosmetic {
  /** Stable id, `slot.name`. NEVER reused, never renamed — it is what `ownedCosmetics` stores. */
  id: string
  slot: CosmeticSlot
  shelf: CosmeticShelf
  /** ALL-CAPS display name. */
  name: string
  /** One short line under the name. */
  blurb: string
  /** Price in stars. 0 = a default, free forever and owned by everyone. IMMUTABLE once shipped. */
  price: number
}

/**
 * The house's own set — free forever, owned by every player from their first launch, and what every
 * slot falls back to. They are in the catalogue rather than hidden away so the boutique can SHOW
 * them: "the one you already have" is a real choice, and a shelf that cannot display the thing you
 * are currently wearing has to invent a second concept to describe it.
 */
export const DEFAULT_COSMETICS: Record<CosmeticSlot, string> = {
  cushion: 'cushion.house',
  chip: 'chip.house',
  trail: 'trail.house',
  chase: 'chase.house',
}

/**
 * THE CATALOGUE. Append-only (see the header). Ordered cheapest-first within each shelf, because the
 * scene renders it in order and the first thing a new customer sees should be the thing they can
 * most nearly afford.
 *
 * Priced against a LIFETIME cap of 1,800 stars (3 × 600 levels, the act's designed end), of which
 * the ladder currently reaches 1,200. The launch catalogue totals 1,530, so nobody buys the shop out
 * — a boutique whose every shelf is empty stops being a reason to earn a third star.
 */
export const COSMETICS: readonly Cosmetic[] = [
  // — free, always owned —
  { id: 'cushion.house', slot: 'cushion', shelf: 'counter', price: 0, name: 'HOUSE FELT', blurb: 'The table you learned on. Follows your theme.' },
  { id: 'chip.house', slot: 'chip', shelf: 'counter', price: 0, name: 'HOUSE CHIP', blurb: 'Rose and gold. The one in your balance today.' },
  { id: 'trail.house', slot: 'trail', shelf: 'counter', price: 0, name: 'CHIPS & CARDS', blurb: 'What the table throws when you win.' },
  { id: 'chase.house', slot: 'chase', shelf: 'counter', price: 0, name: 'ONE LAP', blurb: 'A single swell travelling the cabinet.' },

  // — THE COUNTER: reachable long before Act II. 630 stars for the shelf. —
  { id: 'cushion.claret', slot: 'cushion', shelf: 'counter', price: 60, name: 'CLARET FELT', blurb: 'A dusty rose table, warm under the lamps.' },
  { id: 'trail.goldrush', slot: 'trail', shelf: 'counter', price: 70, name: 'GOLD RUSH', blurb: 'Medallions come off the board on a win.' },
  { id: 'chip.ivory', slot: 'chip', shelf: 'counter', price: 80, name: 'IVORY HOUSE', blurb: 'Cream edge, gold ring — the quiet token.' },
  { id: 'chase.twincrest', slot: 'chase', shelf: 'counter', price: 90, name: 'TWIN CREST', blurb: 'Two lights chase the frame instead of one.' },
  { id: 'cushion.emerald', slot: 'cushion', shelf: 'counter', price: 100, name: 'EMERALD BAIZE', blurb: 'The card-room green, cut for a slot cabinet.' },
  { id: 'trail.rosefall', slot: 'trail', shelf: 'counter', price: 110, name: 'ROSE FALL', blurb: 'Stars and cards, thrown rose.' },
  { id: 'chip.midnight', slot: 'chip', shelf: 'counter', price: 120, name: 'MIDNIGHT CHIP', blurb: 'Navy edge, silver ring. Late-table stock.' },

  // — THE HIGH-ROLLER CASE: silhouetted until 301. 900 stars for the shelf. —
  { id: 'cushion.oxblood', slot: 'cushion', shelf: 'case', price: 150, name: 'OXBLOOD VELVET', blurb: 'The speakeasy table, brought downstairs.' },
  { id: 'chase.runner', slot: 'chase', shelf: 'case', price: 170, name: 'THE RUNNER', blurb: 'Three crests at speed. The cabinet never rests.' },
  { id: 'chip.obsidian', slot: 'chip', shelf: 'case', price: 190, name: 'OBSIDIAN & GOLD', blurb: 'Black edge, gold everything. High-limit stock.' },
  { id: 'cushion.penthouse', slot: 'cushion', shelf: 'case', price: 190, name: 'PENTHOUSE IVORY', blurb: 'Bone and brass, six floors up.' },
  { id: 'trail.champagne', slot: 'trail', shelf: 'case', price: 200, name: 'CHAMPAGNE', blurb: 'Glints and starlight off the top of the board.' },
]

/** First level on which the HIGH-ROLLER CASE opens. The act's own front door — `actII.ts ACT2_FROM`
 *  seen from the shop, kept as a literal here so this module stays dependency-light (nothing about
 *  the boutique should be able to break by importing the act). `boutique.test.ts` asserts they agree. */
export const CASE_FROM = 301

const BY_ID = new Map(COSMETICS.map(c => [c.id, c]))

/** Look one up, or null for an id this build has never heard of (a save written by a newer client). */
export function cosmetic(id: string): Cosmetic | null {
  return BY_ID.get(id) ?? null
}

/** Every good on one shelf, in catalogue order. Defaults are excluded — they are not for sale. */
export function shelf(which: CosmeticShelf): Cosmetic[] {
  return COSMETICS.filter(c => c.shelf === which && c.price > 0)
}

/** Every good in one slot, defaults first — how the boutique renders a slot's row of choices. */
export function slotGoods(slot: CosmeticSlot): Cosmetic[] {
  return COSMETICS.filter(c => c.slot === slot)
}

/** The cheapest thing actually for sale — the bar the progressive reveal is measured against. */
export function cheapestPrice(): number {
  return Math.min(...COSMETICS.filter(c => c.price > 0).map(c => c.price))
}

// ─────────────────────────────────────────────────────────────────────────────
// The balance — derived, never stored.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every star ever earned. `save.stars` is best-of per level and its per-level entries only ever
 * rise (core/save.ts recordResult takes a max, and core/merge.ts takes a per-key max across
 * devices), so this sum is monotone — which is the property the whole derived balance rests on.
 */
export function starsEarned(save: SaveData): number {
  let n = 0
  for (const v of Object.values(save.stars ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) n += Math.floor(v)
  }
  return n
}

/**
 * What the owned set cost. Unknown ids contribute NOTHING on purpose: a save written by a newer
 * client can carry a cosmetic this build has never heard of, and the honest reading of that is "an
 * item I cannot show" rather than "a debt I cannot price". Charging a guess would make the balance
 * differ between two clients looking at the same save.
 */
export function starsSpent(save: SaveData): number {
  let n = 0
  for (const id of new Set(save.ownedCosmetics ?? [])) n += cosmetic(id)?.price ?? 0
  return n
}

/**
 * Stars available to spend. Floored at zero — it cannot go negative through any path the game
 * offers, but an imported backup code from a newer build (more owned than this build can price, or
 * priced differently) is a shape this must survive rather than render as a negative number.
 */
export function starBalance(save: SaveData): number {
  return Math.max(0, starsEarned(save) - starsSpent(save))
}

/** Do you have it? Defaults are owned by everyone, always, without ever entering the save. */
export function owns(save: SaveData, id: string): boolean {
  const c = cosmetic(id)
  if (c && c.price === 0) return true
  return (save.ownedCosmetics ?? []).includes(id)
}

/**
 * Is this shelf open for business? The case is gated on how far the player has climbed, not on what
 * they own — the goods behind the glass are the act's own furniture and arrive with it.
 */
export function shelfOpen(save: SaveData, which: CosmeticShelf): boolean {
  return which === 'counter' || save.unlocked >= CASE_FROM
}

/**
 * Should the boutique's door be shown at all? PROGRESSIVE REVEAL, the same rule Home applies to
 * LEVELS and the GIFT STORE: defer a destination that can do nothing for this player yet.
 *
 * "Can do nothing" means literally that — the door opens the moment the cheapest thing on the
 * counter comes into reach (~25 levels of ordinary play), and never closes again once anything is
 * owned. Deliberately NOT gated on a level: a player who three-stars everything gets there sooner,
 * which is the correct incentive for a shop that sells stars back to them.
 */
export function boutiqueOpen(save: SaveData): boolean {
  return (save.ownedCosmetics ?? []).length > 0 || starBalance(save) >= cheapestPrice()
}

/**
 * Buy one — atomic load → check → append → persist, the `spendChips` discipline. Returns the new
 * balance, or null when it was refused (unknown id, already owned, shelf shut, or short), leaving
 * the save untouched so a caller can never half-buy.
 *
 * There is no "spend" to write: appending the id IS the deduction, because `starBalance` reads the
 * price back out of the catalogue. That is the whole design (see the header).
 */
export function buyCosmetic(id: string): number | null {
  const c = cosmetic(id)
  if (!c || c.price <= 0) return null
  const save = loadSave()
  if (owns(save, id)) return null
  if (!shelfOpen(save, c.shelf)) return null
  if (starBalance(save) < c.price) return null
  save.ownedCosmetics.push(id)
  persistSave(save)
  return starBalance(save)
}

// ─────────────────────────────────────────────────────────────────────────────
// What is WORN — per device, never in the save.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The equipped set lives in localStorage, exactly like the theme picker's does, and deliberately
 * does NOT ride the cloud save.
 *
 * A look is a preference, not progress. The save carries what you OWN, because that was paid for
 * and losing it would be losing something real; which of the things you own you happen to be
 * wearing on this phone is the same class of fact as "reduce motion is on here" — and pushing it
 * through the merge would mean a tablet you opened once could quietly re-dress the phone you play
 * on. Equipping is free and instant precisely so this can be per-device without costing anything.
 */
const EQUIP_KEY = 'viva-maya:boutique'

type EquipMap = Record<CosmeticSlot, string>

function readEquip(): Partial<EquipMap> {
  try {
    const raw = localStorage.getItem(EQUIP_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Partial<EquipMap> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && k in DEFAULT_COSMETICS) out[k as CosmeticSlot] = v
    }
    return out
  } catch {
    return {}
  }
}

/**
 * What is worn in `slot` right now — resolved against OWNERSHIP, so it degrades rather than lies.
 *
 * The fallback matters more than it looks. A device can be wearing something the save no longer
 * says it owns: a restored backup code from before the purchase, a cleared cloud save, a rolled-back
 * build whose catalogue is shorter. In every one of those the honest answer is the house's own set,
 * not a half-applied look the player was never charged for.
 */
export function equipped(save: SaveData, slot: CosmeticSlot): string {
  const id = readEquip()[slot]
  if (id && cosmetic(id) && owns(save, id)) return id
  return DEFAULT_COSMETICS[slot]
}

/** The whole worn set, resolved. What `view/cosmetics.ts` reads once per scene build. */
export function equippedAll(save: SaveData): EquipMap {
  return {
    cushion: equipped(save, 'cushion'),
    chip: equipped(save, 'chip'),
    trail: equipped(save, 'trail'),
    chase: equipped(save, 'chase'),
  }
}

/**
 * Wear something you own. Returns false when refused (unknown id, wrong slot, not owned) so the UI
 * can no-op quietly. Writing through localStorage rather than the save is what makes this free of
 * every merge, cloud-push and cross-device consideration in this file's header.
 */
export function equip(save: SaveData, id: string): boolean {
  const c = cosmetic(id)
  if (!c || !owns(save, id)) return false
  try {
    localStorage.setItem(EQUIP_KEY, JSON.stringify({ ...readEquip(), [c.slot]: id }))
  } catch {
    return false // private mode / storage full — the look simply doesn't stick
  }
  return true
}

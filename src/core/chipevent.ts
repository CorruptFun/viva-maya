// ─────────────────────────────────────────────────────────────────────────────
// CHIP EVENTS — time-boxed multipliers on the level-win purse ("DOUBLE CHIPS WEEKEND").
//
// A promo is a row in a table, not a branch in GameScene: `finishWin` asks `eventChipReward` what a
// win pays and never learns why. The window is a pair of INSTANTS, so every device on earth is in or
// out of the event together regardless of its own clock zone — the same reason the race keys live on
// the RACE_TZ calendar (core/endless.ts) rather than the phone's.
//
// Three rules, each of which was a real question when the first weekend was drawn up:
//
//   · THE WINDOW CLOSES WHEN THE SEASON DOES. `until` is `weekEndsAt(from)` — Monday midnight in
//     RACE_TZ, the instant Sunday's endless board shuts and the weekly totals reset. "Ends Monday at
//     midnight when the board resets" was the owner's spec (2026-09-04), and deriving the edge from
//     the same function the standings use means the promo and the race can never disagree about when
//     the weekend is over. A hand-typed ISO end would be right until the next DST change.
//
//   · THE MULTIPLIER RIDES THE FINAL PURSE, replay fraction included. A replay pays a quarter
//     (`replayChipFraction`, §G4) because re-clearing level 1 forever is an unbounded faucet; doubling
//     that quarter keeps the ratio between a fresh clear and a farm exactly where §G4 put it. Only the
//     LEVEL-WIN purse is touched — quest grants, chapter purses, the champion purse and the storm's
//     payout are not "per level beat", and each is priced against its own faucet.
//
//   · THE START IS A DATE TOO, even though a client that has this code is by definition running the
//     update. A future event needs to be drawn up before its weekend, and a Home card that announced
//     it early would promise a purse the win card does not yet pay.
//
// Iron rule 1 (chips stay earned-only) holds: the event pays more for the same play and nothing is
// purchasable. Iron rule 2 (endless stays boost-free) holds: endless never reaches `finishWin`, so the
// race is untouched — the promo only exists on the numbered levels.
// ─────────────────────────────────────────────────────────────────────────────

import { formatRaceRemaining, weekEndsAt } from './endless'

export interface ChipEvent {
  /** Stable id — analytics prop and the DEV override's name. Never shown. */
  id: string
  /** The name on the Home card and the win card. */
  label: string
  /** Multiplier on the level-win purse. 2 = double. */
  mult: number
  /** Inclusive start instant. */
  from: Date
  /** Exclusive end instant — the first moment the event is OVER. */
  until: Date
}

/**
 * The first Friday-to-Monday run. `from` is the deploy instant (2026-09-04, mid-afternoon on the
 * home clock); `until` is Monday 2026-09-07 00:00 in RACE_TZ = 06:00Z, pinned in `chipevent.test.ts`.
 */
const WEEKEND_1_FROM = new Date('2026-09-04T21:00:00Z')

/**
 * Every event ever scheduled, past ones included — a row is never deleted, so a later reader can
 * date a spike in `level_win.chips`. Windows may not overlap: `activeChipEvent` returns the first
 * match and the test refuses a table where two rows could both claim an instant.
 */
export const CHIP_EVENTS: readonly ChipEvent[] = [
  {
    id: 'double-chips-2026-w36',
    label: 'DOUBLE CHIPS WEEKEND',
    mult: 2,
    from: WEEKEND_1_FROM,
    until: weekEndsAt(WEEKEND_1_FROM),
  },
]

/** The event running at `now`, or null. Half-open window: `from <= now < until`. */
export function activeChipEvent(now = new Date(), table: readonly ChipEvent[] = CHIP_EVENTS): ChipEvent | null {
  const t = now.getTime()
  if (!Number.isFinite(t)) return null
  for (const ev of table) {
    if (t >= ev.from.getTime() && t < ev.until.getTime()) return ev
  }
  return null
}

export interface EventChipReward {
  /** What the win actually pays. */
  chips: number
  /** 1 outside an event. */
  mult: number
  /** The event that multiplied it, or null — so the win card and the analytics prop read one truth. */
  event: ChipEvent | null
}

/**
 * Apply the running event (if any) to a base level-win purse. Integer in, integer out; a base of 0
 * stays 0, so a three-star replay that §G4 already zeroed cannot be resurrected by a multiplier.
 */
export function eventChipReward(base: number, now = new Date(), table: readonly ChipEvent[] = CHIP_EVENTS): EventChipReward {
  const clean = Math.max(0, Math.floor(base))
  const event = activeChipEvent(now, table)
  if (!event || event.mult <= 1) return { chips: clean, mult: 1, event: null }
  return { chips: Math.round(clean * event.mult), mult: event.mult, event }
}

/** "2d 5h" / "48m" until the event closes — the race panels' own coarse countdown, for the same reasons. */
export function eventRemaining(event: ChipEvent, now = new Date()): string {
  return formatRaceRemaining(event.until.getTime() - now.getTime())
}

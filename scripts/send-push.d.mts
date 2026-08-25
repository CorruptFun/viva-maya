/**
 * Types for the pure helpers scripts/send-push.mjs exports for testing.
 *
 * The sender itself is plain .mjs, not TypeScript, because it runs in CI as bare Node against the
 * checked-out repo with no build step — which is also precisely why it carries its own copies of
 * dayKey() and weekKey() rather than importing from src/. Those copies are what
 * src/core/analytics.test.ts pins against core/endless.ts; this declaration is only what lets the
 * test import them under `strict`.
 *
 * Only the side-effect-free helpers are declared. main() is intentionally absent: it sends real
 * notifications, and nothing should be able to reach it from a test.
 */
export declare const RACE_TZ: string
export declare function dayKey(now?: Date): string
export declare function dayEndsAt(now?: Date): Date
export declare function weekKey(now?: Date): string
export declare function weekEndsAt(now?: Date): Date

/**
 * The sender's copy of the HOUSE GIFT roll (src/core/bonusdrop.ts dropForDay), pinned against the
 * app's by src/core/bonusdrop.test.ts.
 *
 * Only the fields the notification actually says out loud are declared, because only those are
 * duplicated: the sender never quotes what a gift PAYS, so it carries no copy of the chips, spins or
 * boost columns to drift from.
 */
export declare function dropForDay(day: string): {
  id: string
  label: string
  emoji: string
  blurb: string
  weight: number
}

/** Only the fields the cadence rules read — the real rows carry the keys and the endpoint too. */
export interface PushSubscriptionRow {
  last_sent_at?: string | null
}

/** Has this device already been sent to on `today`'s race day? The one-a-day rule's backstop. */
export declare function sentToday(sub: PushSubscriptionRow, today: string): boolean

/** May a device this many days absent be nudged again right now? `null` days = unknown, not gone. */
export declare function backoffAllows(
  sub: PushSubscriptionRow,
  awayDays: number | null,
  now: Date
): boolean

/** The streak-in-danger hook: the streak's length when it is alive and unsecured, else null. */
export declare function streakAtRisk(
  info: { streak: number; lastSpinDate: string | null } | null | undefined,
  today: string
): number | null

/**
 * The jackpot chase constants — src/core/jackpot.ts JACKPOT_GOAL and src/core/levels.ts
 * LEVEL_COUNT, duplicated because the sender cannot import src/. Pinned by
 * src/core/pushcadence.test.ts.
 */
export declare const JACKPOT_GOAL: number
export declare const LEVEL_COUNT: number

/** The jackpot-within-reach hook: wins left while the wheel is at most two away (0 = loaded), else null. */
export declare function jackpotWinsAway(
  info: { jackpotMeter?: number } | null | undefined
): number | null

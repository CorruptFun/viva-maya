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
  /** Race day key `sends_count` belongs to (migration 0028); absent on the un-migrated fallback. */
  sends_day?: string | null
  sends_count?: number | null
}

/** Has this device already been sent to on `today`'s race day? The pre-0028 one-a-day fallback. */
export declare function sentToday(sub: PushSubscriptionRow, today: string): boolean

/** How many notifications this device has had on `today`'s race day — 0 when the counter is stale. */
export declare function sendsToday(sub: PushSubscriptionRow, today: string): number

/**
 * The volume promise in code: `DAILY_SEND_CAP` is the number src/view/pushoptin.ts's VOLUME_RULE
 * prints to every player being asked for a notification permission. Change one, change both.
 */
export declare const DAILY_SEND_CAP: number
export declare const MIN_GAP_HOURS: number

/** May this device be sent to at all right now — the day's cap and the minimum gap between sends. */
export declare function budgetAllows(
  sub: PushSubscriptionRow,
  today: string,
  now: Date,
  opts?: { cap?: number; gapHours?: number; legacy?: boolean }
): boolean

/** What `dueForMode` needs to know about one subscriber. Every field is optional and defaults safe. */
export interface PushDueContext {
  /** Days since this device was last seen. `null` is UNKNOWN, never "gone". */
  away?: number | null
  /** Length of a live, unsecured streak (`streakAtRisk`), else null. */
  streakDays?: number | null
  /** Unfinished goals on today's slate (`questsOpen`), else null. */
  questsOpen?: number | null
  /** Does this player have a row on the board this run is about? */
  onBoard?: boolean
  /** Wins left to the jackpot wheel while it is within reach (`jackpotWinsAway`), else null. */
  winsAway?: number | null
}

/**
 * Does this mode have anything to say to this subscriber?
 *
 * ⚠️ The fix for the 2026-08-25 outage, where `drop` (`away >= 2`) and `daily` (`away === 1`)
 * between them left out `away === 0` — every daily-active player — and delivered nothing while
 * reporting a healthy-looking quiet state. src/core/pushcadence.test.ts pins the total property.
 */
export declare function dueForMode(mode: PushMode, ctx?: PushDueContext): boolean

/** Whether the absence backoff applies to this mode — the two broad ones, not the two narrow ones. */
export declare function backoffApplies(mode: PushMode): boolean

/** The quest slate's shape, duplicated from src/core/quests.ts and pinned against it. */
export declare const QUEST_COUNT: number
export declare const ALL_CLEAR_ID: string
export declare const ALL_CLEAR_CHIPS: number
export declare const ALL_CLEAR_SPINS: number

/** Unfinished goals on `today`'s slate — QUEST_COUNT when the slate has not rolled over yet. */
export declare function questsOpen(
  info: { quests?: { day: string; claimed: string[] } | null } | null | undefined,
  today: string
): number | null

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

/**
 * The five scheduled sends, named exactly as they appear in the run's log line, in the tray tag and
 * in the open URL's marker. A union rather than `string` so a sixth mode cannot be typed into
 * `notificationUrl` here without the client's allow-list (`pushSource`, src/core/analytics.ts)
 * being widened in the same change — which is the drift that would otherwise show up as a new
 * mode's attribution reading a silent zero.
 */
export type PushMode = 'drop' | 'quests' | 'daily' | 'laststand' | 'week'

/**
 * Where a tapped notification opens: `./?from=push-<mode>`.
 *
 * Relative, and the marker rides the QUERY rather than the fragment — the fragment carries the
 * origin handoff's entire profile payload (core/originmigrate.ts). The `./?from=` prefix is also
 * public/push-sw.js's same-page test, which is what keeps a tap on an already-open game a FOCUS
 * rather than a reload. Pinned, including against the client half, by src/core/pushcadence.test.ts.
 */
export declare function notificationUrl(mode: PushMode): string

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
export declare function dayKey(now?: Date): string
export declare function dayEndsAt(now?: Date): Date
export declare function weekKey(now?: Date): string
export declare function weekEndsAt(now?: Date): Date

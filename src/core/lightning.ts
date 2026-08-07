/**
 * LIGHTNING ROUND — the run state. Pure logic, no Phaser, mirroring core/endless.ts and core/plinko.ts.
 *
 * The game's first mode with a clock. Everything else here is move-limited and calm — numbered levels
 * are a budget of moves, endless is `ENDLESS_MOVES` — so this is the one place a timer exists, and
 * that is exactly why the rules below are conservative. A match-3 audience largely self-selects for
 * the calm, and a timed mode that punishes is a timed mode people bounce off once and never re-enter.
 *
 * ── THE LOOP ─────────────────────────────────────────────────────────────────
 * Clear `quotaFor(round)` pieces before the round's timer runs out. Meet it and the round ramps —
 * more pieces, less time. Miss it and ⚡ LIGHTNING STRIKES: the board is swapped out under you and a
 * strike is spent. The `MAX_STRIKES`th strike ends the run.
 *
 * ── THE FOUR RULES THAT KEEP IT FROM BEING HORRIBLE ──────────────────────────
 *
 * 1. **The quota ramps on SUCCESS ONLY.** `strike()` does not touch `round`. A player who just failed
 *    a target must never be handed a HARDER one — that is the death spiral, it is the most common way
 *    a timed mode turns miserable, and it costs exactly nothing to avoid. This is the single most
 *    important line in the file and the one a "simplification" is most likely to quietly undo.
 *
 * 2. **Losing costs nothing outside the run.** Nothing here touches hearts, chips, progress or the
 *    save. The mode is free to enter and infinitely repeatable, which is what lets the clock be
 *    exciting instead of expensive. The game's signature mercy rule is that wins are free and only
 *    losses cost a heart; a timed mode charging for a timeout would break it for the players least
 *    able to beat a clock.
 *
 * 3. **Overflow CARRIES, but capped.** Clearing 40 against a 25 quota should feel like it bought you
 *    something — a big cascade is the whole joy of the board — but an uncapped carry lets one monster
 *    chain bank two rounds at once and the ramp stops meaning anything. Capped at `CARRY_FRACTION` of
 *    the next quota, a great chain is a real head start and never a skipped round.
 *
 * 4. **A strike resets the meter to zero.** The strike has to cost something or it is not a threat,
 *    and the reshuffle has already destroyed whatever setup was being built. Carrying progress
 *    through a strike as well would leave it with no teeth at all.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────────
 * No scoring, no leaderboard, no board seed. A lightning board must be RANDOMLY seeded and must not
 * post a race score: the daily race's whole defence rests on one salted board per day, and a second
 * mode reading that seed would widen the surface for nothing. It also means iron rule 3 holds without
 * an argument — a free-spin reward from this mode cannot be farmed off a deterministic board.
 */

/** Pieces the first round asks for. A normal match clears 3–5; a good cascade 15–30. */
export const START_QUOTA = 25
/** Added to the quota each time a round is MET. */
export const QUOTA_STEP = 5
/** Seconds the first round allows — roughly 4–6 moves at an unhurried pace. */
export const START_SECONDS = 25
/** Seconds removed each time a round is MET. */
export const SECONDS_STEP = 1
/** The clock never drops below this, however deep the run goes. */
export const MIN_SECONDS = 12
/**
 * Strikes that end the run. Three are survivable and the fourth is fatal (owner call, 2026-08-07) —
 * a readable amount of rope, and a bad early strike never reads as fatal.
 */
export const MAX_STRIKES = 4
/** Overflow carried into the next round, as a fraction of THAT round's quota. See rule 3. */
export const CARRY_FRACTION = 0.5
/**
 * The nominal move budget handed to a lightning board.
 *
 * Moves are NOT the constraint in this mode — the clock is, and stacking a move budget under a timer
 * is two pressures at once. This exists only because `GameScene` builds every board from a spec that
 * has a `moves` field; it is set far past anything a run can spend, and the scene's out-of-moves arm
 * is guarded off for lightning besides, so it is a belt-and-braces number rather than a real limit.
 */
export const LIGHTNING_MOVES = 9999

/**
 * Levels cleared before the storm opens.
 *
 * ⚠️ A gate, but NOT a tax — and the reasoning is measured rather than felt. As of 2026-08-07 the
 * ungated LUCKY SLOTS cabinet had been opened by 24 of 73 real players (33%), against 40 (55%) for
 * the daily race, which is gated at level 10. The gated thing beat the ungated one by 22 points,
 * because what a gate really buys is a MOMENT — the one-time reveal that says a thing now exists.
 * A door that has always been there is never new, and a thing that is never new is wallpaper.
 *
 * 5 rather than 10 (owner call): it lands BEFORE the race gate, so the storm is the first mode a
 * player meets and the thing that teaches them modes exist at all. Every 5th level is also a breather
 * (half hazard density), so the reveal arrives right after an easy win.
 */
export const LIGHTNING_UNLOCK_LEVEL = 5

/**
 * Is the storm open? True once `LIGHTNING_UNLOCK_LEVEL` has been BEATEN, not merely reached — hence
 * `>`, matching `endlessUnlocked`'s reading of `unlocked` exactly. (`unlocked` is the highest level
 * the player MAY attempt, so sitting on 5 means 5 is unbeaten.)
 */
export function lightningUnlocked(save: { unlocked?: number }): boolean {
  return (save.unlocked ?? 1) > LIGHTNING_UNLOCK_LEVEL
}

export interface LightningRun {
  /** 1-based. Increments ONLY when a quota is met — never on a strike. See rule 1. */
  round: number
  /** Pieces credited toward THIS round's quota, including any carry it started with. */
  cleared: number
  /** Strikes spent. The run ends when this reaches `MAX_STRIKES`. */
  strikes: number
  /** True once the run is finished. A finished run ignores further credit. */
  over: boolean
}

export function startRun(): LightningRun {
  return { round: 1, cleared: 0, strikes: 0, over: false }
}

/** Pieces `round` asks for. Grows without bound; the clock floor is what actually ends deep runs. */
export function quotaFor(round: number): number {
  return START_QUOTA + Math.max(0, Math.floor(round) - 1) * QUOTA_STEP
}

/** Seconds `round` allows, floored at `MIN_SECONDS`. */
export function secondsFor(round: number): number {
  return Math.max(MIN_SECONDS, START_SECONDS - Math.max(0, Math.floor(round) - 1) * SECONDS_STEP)
}

/** Strikes left before the run ends — what the charge track renders. */
export function chargesLeft(run: LightningRun): number {
  return Math.max(0, MAX_STRIKES - 1 - run.strikes)
}

/** Credit cleared pieces toward the current round. Pure; a finished run is untouched. */
export function credit(run: LightningRun, pieces: number): LightningRun {
  if (run.over || pieces <= 0) return run
  return { ...run, cleared: run.cleared + Math.floor(pieces) }
}

/** Has the current round's quota been reached? */
export function quotaMet(run: LightningRun): boolean {
  return !run.over && run.cleared >= quotaFor(run.round)
}

/**
 * Advance to the next round, carrying capped overflow (rule 3). Caller should only reach this when
 * `quotaMet` is true; calling it early simply carries whatever was cleared, which is the safe way for
 * it to be wrong.
 */
export function nextRound(run: LightningRun): LightningRun {
  if (run.over) return run
  const round = run.round + 1
  const overflow = Math.max(0, run.cleared - quotaFor(run.round))
  const carry = Math.min(overflow, Math.floor(quotaFor(round) * CARRY_FRACTION))
  return { ...run, round, cleared: carry }
}

/**
 * Take a strike: the meter resets (rule 4), the round does NOT ramp (rule 1), and the run may end.
 *
 * ⚠️ `round` is deliberately untouched. If a future change makes a strike advance the round "for
 * pacing", it has reintroduced the death spiral this mode was designed around.
 */
export function strike(run: LightningRun): LightningRun {
  if (run.over) return run
  const strikes = run.strikes + 1
  return { round: run.round, cleared: 0, strikes, over: strikes >= MAX_STRIKES }
}

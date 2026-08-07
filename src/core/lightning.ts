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
/**
 * Seconds the first round allows.
 *
 * ⚠️ RETUNED 2026-08-07 off the first real play session. The original 25s opening, −1s step and 12s
 * floor made a run "go longer than it should" and feel lacklustre: the ramp was so gentle that the
 * early rounds were never in doubt, so the tension arrived around round 10 or not at all. A shorter
 * opening with a −2s step puts real pressure on by round 3. Guarded by the ramp tests, which assert
 * the SHAPE (monotonic down, floors above zero) rather than these numbers.
 */
export const START_SECONDS = 20
/** Seconds removed each time a round is MET. */
export const SECONDS_STEP = 2
/** The clock never drops below this, however deep the run goes. */
export const MIN_SECONDS = 10
/**
 * Strikes that end the run — TWO survivable, the third fatal (owner call, 2026-08-07: "less life for
 * sure maybe 3 tries").
 *
 * Was 4, which combined with the gentle clock to make runs sprawl. Three attempts keeps a storm
 * inside a minute or two, which is what a bonus INTERRUPTING a level should be — it has to hand the
 * level back while the player still wants it. Still enough rope that one bad opening board is not
 * the whole run.
 */
export const MAX_STRIKES = 3
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

// ─────────────────────────────────────────────────────────────────────────────
// THE CHARGE — how a storm is EARNED.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pieces a level clears per MOVE. **Measured, not chosen** — swept L3–L296 × 40 seeds through
 * `sim.playLevel().pieces` on 2026-08-07.
 *
 * ⚠️ The measurement is the reason this constant exists at all, and the reason the meter is not a
 * plain piece counter. Raw pieces per level run 115 (L3) → 576 (L250), a **5.0x spread** — so a flat
 * goal would fire a storm every ~9 levels for a beginner and every ~1.7 for a veteran, i.e. rarest
 * for the player who most needs the reward. But that spread is ENTIRELY the move budget growing with
 * the curve: pieces per move is flat at 6.16–6.94 from L8 to L250. Dividing it out normalises the
 * cadence across the whole game by construction.
 *
 * Also measured: a passive policy and a typical one clear near-identical counts (359 vs 363), so this
 * cadence is **skill-independent** — a steady drumbeat, not a reward for playing well. That is right
 * for a trigger (the storm itself is where skill pays), but it means the meter can never honestly be
 * sold as something a better player fills faster.
 */
export const PIECES_PER_MOVE = 6.2

/**
 * Charge needed to bring the storm, in LEVEL-EQUIVALENTS. A level played to its budget contributes
 * about 1.0, so this reads directly as "a storm every three and a half levels".
 */
export const STORM_GOAL = 3.5

/**
 * One wave's contribution to the charge: pieces cleared, as a fraction of what this level's own move
 * budget is expected to clear. Guarded against a zero/absent budget so a malformed spec cannot mint
 * an infinite charge.
 */
export function chargeFor(piecesCleared: number, levelMoves: number): number {
  if (!(levelMoves > 0) || !(piecesCleared > 0)) return 0
  return piecesCleared / (PIECES_PER_MOVE * levelMoves)
}

/** Is the storm owed? */
export function stormDue(charge: number): boolean {
  return charge >= STORM_GOAL
}

/** How full the meter reads, 0..1 — what the in-level charge bar draws. */
export function stormProgress(charge: number): number {
  return Math.max(0, Math.min(1, charge / STORM_GOAL))
}

/**
 * Chips a storm pays for surviving `rounds`.
 *
 * A fixed-size gift with a hard ceiling, never a rate — iron rule 1's whole basis. The floor is
 * deliberate: a storm that paid nothing for a bad run would make an EARNED bonus feel like a test,
 * and the one thing this shape guarantees is that a storm can only ever leave you better off. For
 * scale, a level win pays ~30–60 and one jackpot wheel spin averages ~114.
 */
export const STORM_PAY_FLOOR = 15
/**
 * ⚠️ Raised 20 → 30 alongside the 2026-08-07 ramp retune, and the two must move TOGETHER. A harder
 * clock and one fewer strike mean fewer rounds survived per storm, so holding the per-round rate flat
 * would have quietly cut the whole feature's payout at the same moment it got harder — the worst
 * possible pairing. Round 3 now reaches the cap, which is where a good run should land.
 */
export const STORM_PAY_PER_ROUND = 30
export const STORM_PAY_CAP = 120

export function stormPayout(rounds: number): number {
  const r = Math.max(0, Math.floor(rounds))
  return Math.min(STORM_PAY_CAP, STORM_PAY_FLOOR + r * STORM_PAY_PER_ROUND)
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

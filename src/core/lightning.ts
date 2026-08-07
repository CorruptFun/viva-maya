/**
 * LIGHTNING ROUND — the run state. Pure logic, no Phaser, mirroring core/endless.ts and core/plinko.ts.
 *
 * The game's first mode with a clock. Everything else here is move-limited and calm — numbered levels
 * are a budget of moves, endless is `ENDLESS_MOVES` — so this is the one place a timer exists, and
 * that is exactly why the rules below are conservative. A match-3 audience largely self-selects for
 * the calm, and a timed mode that punishes is a timed mode people bounce off once and never re-enter.
 *
 * ── THE LOOP ─────────────────────────────────────────────────────────────────
 * ONE clock runs the whole storm. Clearing `quotaFor(round)` pieces pays `ROUND_SECONDS` back onto it
 * and asks for a bigger quota next time; a big cascade pays `chainBonusFor(cascade)` on the spot.
 * When the clock empties, the storm takes the board and the run is over. **Time is the one life.**
 *
 * ⚠️ REBUILT 2026-08-07 (owner call: "it should just be one life… you only get one life to see how far
 * you can get. The multiples just feel like it drags"). The mode used to run a FRESH clock per round
 * behind `MAX_STRIKES` = 3 lives, and the two combined into the drag: the quota deliberately never
 * ramps on a failure, so a wall you failed handed you the same round back with a full clock, twice
 * over, before the run could end. Three attempts at one wall is padding, not tension. Collapsing
 * lives and clock into a single resource fixes it at the root — a run now ends the first time the
 * player falls behind, and everything they earn buys them more of the mode instead of another go at
 * the same bit of it.
 *
 * ── THE FOUR RULES THAT KEEP IT FROM BEING HORRIBLE ──────────────────────────
 *
 * 1. **The quota ramps on SUCCESS ONLY.** There is no failure state short of the run ending, so the
 *    death spiral this rule was written against — handing a harder target to a player who just missed
 *    one — is now structurally impossible rather than merely avoided. It is stated anyway because the
 *    obvious "make it harder when they're doing badly" retune would reintroduce it.
 *
 * 2. **Losing costs nothing outside the run.** Nothing here touches hearts, chips, progress or the
 *    save. The mode is free to enter and infinitely repeatable, which is what lets the clock be
 *    exciting instead of expensive. The game's signature mercy rule is that wins are free and only
 *    losses cost a heart; a timed mode charging for a timeout would break it for the players least
 *    able to beat a clock.
 *
 * 3. **Overflow CARRIES, but capped** — and now so does TIME. Clearing 40 against a 25 quota buys a
 *    head start on the next one, capped at `CARRY_FRACTION` so one monster chain is never a skipped
 *    round. Time carries by construction: the clock is never reset, only topped up, so seconds you
 *    did not need are seconds you keep. That carry is the mode's whole reward for playing well and is
 *    the reason `CLOCK_CAP_SECONDS` is set well above the working range rather than snugly around it
 *    — measured, the cap swallows under 2% of all bonus seconds offered, so it reads as a backstop
 *    against a runaway bank and never as a tax on a good run.
 *
 * 4. **Winning time is the only way to get more of it.** There is no free refill, no continue and no
 *    second life. A run's length is exactly the opening grubstake plus what the player earned.
 *
 * ── THE TUNE, AND WHERE IT CAME FROM ─────────────────────────────────────────
 * Measured 2026-08-07 by simulating this loop over 30 seeded hazard-free storm boards (the same
 * `Board(8,8,6)` GameScene builds), costing every move at the animation time the board actually
 * spends — `SWAP_MS` + per-wave (`CLEAR_MS` + `FALL_BASE_MS`) straight out of config.ts — plus a
 * decision time swept from 0.4s (frantic) to 1.4s (deliberate). The board itself clears 4.5
 * pieces/move played carelessly and 8.7 played optimally, and chains ≥x4 land on 1.6%–8.7% of moves.
 *
 * That puts a hard ceiling on the mode: no human can clear faster than ~7.8 pieces/second, because
 * the swap and the cascade animations cost what they cost. The ramp is tuned to cross that ceiling
 * around round 5, which is what ENDS a run — the clock is the visible executioner, but the quota is
 * the one holding the sentence. A schedule whose quota grew slower than the ceiling would produce a
 * run that never ends, and the long slow drain of a big banked clock is precisely what "it drags"
 * felt like. `lightning.test.ts` guards the shape rather than these numbers.
 *
 * Landing zone: 60–100 second runs, 3–5 rounds for a hurried player and 6–9 for a good one.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ────────────────────────────────
 * No scoring, no leaderboard, no board seed. A lightning board must be RANDOMLY seeded and must not
 * post a race score: the daily race's whole defence rests on one salted board per day, and a second
 * mode reading that seed would widen the surface for nothing. It also means iron rule 3 holds without
 * an argument — a free-spin reward from this mode cannot be farmed off a deterministic board.
 */

/** Pieces the first round asks for. A normal match clears 3–5; a good cascade 15–30. */
export const START_QUOTA = 25
/**
 * Added to the quota each time a round is MET — the mode's ONLY difficulty knob.
 *
 * ⚠️ It carries the whole ramp on purpose. The old tune moved two numbers in opposite directions (the
 * quota grew AND the per-round clock shrank), which is two knobs doing one job and leaves the player
 * nothing stable to read. With a flat `ROUND_SECONDS` the deal is legible — "every round pays the
 * same +10s, and every round asks for more" — and there is exactly one constant to retune.
 */
export const QUOTA_STEP = 15
/** Seconds on the clock when the storm opens. The whole run's grubstake, not a per-round allowance. */
export const START_SECONDS = 25
/** Seconds paid onto the clock for MEETING a round's quota. Flat — see `QUOTA_STEP`. */
export const ROUND_SECONDS = 10
/**
 * The clock never banks past this.
 *
 * Sized as a backstop, not a budget: measured, it swallows under 2% of all seconds the mode offers.
 * A cap set near the working range would quietly delete the reward for the exact players earning it
 * — a great chain would pay nothing because they were already doing well — which inverts the whole
 * point of rule 3. What it actually stops is an unbounded bank on a lucky opening turning the ramp
 * into a formality.
 *
 * ⚠️ Held at or above `START_SECONDS + ROUND_SECONDS + the deepest chain bonus`, which is the best a
 * single round can possibly pay. 40 was measured as fine on aggregate and still clipped exactly that
 * case — the one run in a thousand that earns the most is the one it must not shortchange. The test
 * guarding it is the reason this is 45 and not 40; the sweep says the two are otherwise identical.
 */
export const CLOCK_CAP_SECONDS = 45
/** Overflow pieces carried into the next round, as a fraction of THAT round's quota. See rule 3. */
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
 * Seconds a big cascade pays, by the SAME tier ladder the rest of the game already shouts about
 * (`comboTier` in GameScene: x4 MEGA WIN, x6 SUPER MEGA, x8 UNREAL).
 *
 * Deliberately keyed to the existing ladder rather than a private threshold: the player is already
 * being told a chain was big, with a banner and a jackpot strike, so the time award lands on a beat
 * the game has taught since level 1 instead of inventing a second definition of "big".
 *
 * Measured on the storm board, x4 lands on 1.6%–8.7% of moves, x6 on 0.2%–0.8%, and x8 essentially
 * never. So these are EVENTS, not a rate — over a whole run they add up to a handful of seconds for a
 * careless player and something worth chasing for a good one, which is the intended slope. x8 pays a
 * headline number that almost nobody will ever collect, and that is fine: it exists for the one
 * player who does it.
 */
export const CHAIN_TIERS: ReadonlyArray<{ cascade: number; seconds: number }> = [
  { cascade: 8, seconds: 8 },
  { cascade: 6, seconds: 5 },
  { cascade: 4, seconds: 3 },
]

/** Seconds `cascade` earns, or 0 if the chain was not big enough to pay. */
export function chainBonusFor(cascade: number): number {
  for (const tier of CHAIN_TIERS) if (cascade >= tier.cascade) return tier.seconds
  return 0
}

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
 * A fixed-size gift with a hard ceiling, never a rate — iron rule 1's whole basis. For scale, a level
 * win pays ~30–60 and one jackpot wheel spin averages ~114.
 */
/**
 * ⚠️ Raised 15 → 30 alongside the one-life rebuild, and for a reason that is entirely about the
 * rebuild: with three strikes almost nobody ended a storm on zero or one round, so the floor was a
 * theoretical case. One life makes a short run a REAL outcome — a bad opening board, a mistimed
 * entry, a player who has not yet learned the rules — and a storm the player spent three and a half
 * levels earning must never hand back pocket change. The floor is now roughly a level win.
 */
export const STORM_PAY_FLOOR = 30
/**
 * ⚠️ Raised 20 → 30 alongside the 2026-08-07 ramp retune, and the two must move TOGETHER. A harder
 * clock and one fewer strike mean fewer rounds survived per storm, so holding the per-round rate flat
 * would have quietly cut the whole feature's payout at the same moment it got harder — the worst
 * possible pairing. Round 3 reaches the cap, which is where a good run should land.
 */
export const STORM_PAY_PER_ROUND = 30
export const STORM_PAY_CAP = 120

export function stormPayout(rounds: number): number {
  const r = Math.max(0, Math.floor(rounds))
  return Math.min(STORM_PAY_CAP, STORM_PAY_FLOOR + r * STORM_PAY_PER_ROUND)
}

export interface LightningRun {
  /** 1-based. Increments ONLY when a quota is met. See rule 1. */
  round: number
  /** Pieces credited toward THIS round's quota, including any carry it started with. */
  cleared: number
  /** Milliseconds left on the ONE clock. This is the life: at zero, the run is spent. */
  msLeft: number
  /** Milliseconds WON over the run — what the end card reports. Never spent, only totted up. */
  wonMs: number
  /** True once the run is finished. A finished run ignores further credit and further time. */
  over: boolean
}

export function startRun(): LightningRun {
  return { round: 1, cleared: 0, msLeft: START_SECONDS * 1000, wonMs: 0, over: false }
}

/** Pieces `round` asks for. Grows without bound — it is what eventually outruns the player. */
export function quotaFor(round: number): number {
  return START_QUOTA + Math.max(0, Math.floor(round) - 1) * QUOTA_STEP
}

/** Whole seconds left, rounded UP so the clock only reads 0 when it really is spent. */
export function secondsLeft(run: LightningRun): number {
  return Math.ceil(Math.max(0, run.msLeft) / 1000)
}

/** How full the clock reads, 0..1, against its cap — what the time gauge draws. */
export function clockFraction(run: LightningRun): number {
  return Math.max(0, Math.min(1, run.msLeft / (CLOCK_CAP_SECONDS * 1000)))
}

/**
 * Pay time onto the clock, capped, and remember it was won.
 *
 * `wonMs` counts what was actually BANKED rather than what was offered, so the end card can never
 * claim credit for seconds the cap swallowed.
 */
export function addTime(run: LightningRun, seconds: number): LightningRun {
  if (run.over || !(seconds > 0)) return run
  const capMs = CLOCK_CAP_SECONDS * 1000
  // `Math.max` against the current clock so paying INTO an over-cap clock is a no-op rather than a
  // deduction. Unreachable while START_SECONDS < CLOCK_CAP_SECONDS, but a retune that inverted those
  // would otherwise turn every reward into a penalty, silently and only for the best runs.
  const msLeft = Math.max(run.msLeft, Math.min(capMs, run.msLeft + seconds * 1000))
  return { ...run, msLeft, wonMs: run.wonMs + (msLeft - run.msLeft) }
}

/**
 * Spend `ms` of clock. Floors at zero and NEVER sets `over` on its own — see `outOfTime`.
 *
 * ⚠️ The split matters. A cascade that empties the clock and completes the quota in the same breath
 * is one the player earned, so the scene checks the quota first and only then spends the timeout
 * (`GameScene.onLightningIdle`). If draining ended the run here, that tie would go to the house.
 */
export function drain(run: LightningRun, ms: number): LightningRun {
  if (run.over || !(ms > 0)) return run
  return { ...run, msLeft: Math.max(0, run.msLeft - ms) }
}

/** The clock is spent. A run in this state is finished the moment the board settles. */
export function outOfTime(run: LightningRun): boolean {
  return !run.over && run.msLeft <= 0
}

/** End the run. Idempotent. */
export function endRun(run: LightningRun): LightningRun {
  return run.over ? run : { ...run, over: true }
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
 * Advance to the next round: carry the capped overflow (rule 3) and PAY the clock.
 *
 * Caller should only reach this when `quotaMet` is true; calling it early simply carries whatever was
 * cleared and pays anyway, which is the safe way for it to be wrong.
 */
export function nextRound(run: LightningRun): LightningRun {
  if (run.over) return run
  const round = run.round + 1
  const overflow = Math.max(0, run.cleared - quotaFor(run.round))
  const carry = Math.min(overflow, Math.floor(quotaFor(round) * CARRY_FRACTION))
  return addTime({ ...run, round, cleared: carry }, ROUND_SECONDS)
}

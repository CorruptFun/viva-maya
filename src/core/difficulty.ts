/**
 * Every difficulty knob added by the hazard/curve overhaul, in ONE place — pure data, no logic,
 * no imports. This module exists so the whole overhaul is REVERSIBLE without a git revert.
 *
 * ── THE PANIC SWITCH ────────────────────────────────────────────────────────────────────────
 *   hazards.enabled = false   → no coated cells, no blockers, no locked pieces, anywhere.
 *   curve.enabled   = false   → `levelSpec` reproduces the pre-overhaul formula exactly.
 * Both false = the game is byte-for-byte what it was before the overhaul. The unit tests read
 * these same flags, so a flipped flag is proven by `npm test`, not just asserted here.
 *
 * The two are DELIBERATELY independent. Hazards (new board mechanics) and the curve retune
 * (tighter move budgets) are two separate bets; either can be wrong on its own, and rolling one
 * back must never require rolling back the other. Per-mechanic rollback is one more boolean —
 * `hazards.blocker = false` removes blockers and touches nothing else.
 *
 * ── WHY THE DENSITIES LOOK SO LOW ───────────────────────────────────────────────────────────
 * Measured against the real board core: a permanently inert cell (one that can never match) is
 * ~10x more potent per cell than a swap restriction, and the effect is SUPERLINEAR — 2 inert
 * cells cost ~8% of a player's collects-per-move, 4 cost ~20-25%. Blockers are therefore the
 * sharp instrument and are capped hard; locks are near-free and are used for texture.
 *
 * Hazards are also strictly FRONT-LOADED: nothing here ever spawns mid-level (see hazards.ts),
 * so a blocker lives a handful of moves out of a 60-90 move budget and its time-averaged cost is
 * well under its nominal one. That decay is why 6 blockers is the ceiling rather than 12.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────────────────────
 * Numbered levels ONLY. The weekly endless race is excluded for the same reason boosts are: it
 * is a same-board-for-everyone fairness contract, and it has no level number to key a schedule
 * off. `levelSpec` is not even on the endless code path (GameScene builds its endless spec
 * inline), so the curve retune structurally cannot reach it.
 */

/** Behavioural hazard kinds. Names are BEHAVIOURAL, never thematic — appearance is a view-layer
 *  skin (see `view/hazardskins.ts`), so a future seasonal pack can reskin `blocker` as ice with
 *  zero changes below this line. */
export type HazardKind = 'coat' | 'blocker' | 'lock'

export const DIFFICULTY = {
  /**
   * Master + per-mechanic kill switches — and the ROLLOUT control.
   *
   * Shipping locks first is deliberate. Locks are the cheapest mechanic by measurement (~-4% to a
   * player's collects-per-move; a blocker cell is roughly 10x more punishing), and with the other
   * two off the live surface is tiny: `coatsRemaining()` is always 0 so the win condition is
   * untouched, and segment-aware gravity never engages because no blocker ever exists. What is
   * left is one guard in `wouldSwapMatch` plus an overlay.
   *
   * Coats and blockers are BUILT, measured and tested — held back, not missing. Turning either on
   * is one boolean and needs no other change. `hazards.test.ts` forces every mechanic on for its
   * logic assertions and asserts this shipped state separately, so staging can never quietly make
   * the suite test nothing.
   */
  hazards: {
    enabled: true,
    /** A normal symbol that still MATCHES but cannot be SWAPPED until an adjacent clear frees it. */
    lock: true,
    /**
     * A coated table square that clears when any match lands on it. The only win-condition change.
     *
     * §G6 ROLLOUT ADVANCED (from `false`). Locks alone made the live game one mechanic wide across
     * all 300 levels — every level from 8 to 300 was "collect N of 3 symbols" with a slowly rising
     * N, which is the single biggest reason the ladder reads as generated rather than authored.
     * Coats are a genuine SECOND OBJECTIVE ARCHETYPE (clear every covered square — the genre's
     * jelly), and they were already complete end to end: the board term, the FELT n/m HUD counter,
     * the procedural art, the just-in-time intro card and their own fairness gate in
     * feasibility.test.ts. They were staged, not missing.
     *
     * MEASURED ON FLIP (banker proxy, n=120/level, NON-breather levels — every multiple of 5 is
     * halved by `breatherHazardScale`, so sampling L70/L120/L300 measures the wrong thing and was
     * the first attempt's mistake):
     *
     *     level        57     72    118    163    221    299
     *     coat cells    6     10     14     15     16     18
     *     layers        6     10     14     15     19     24
     *     win% delta   -8     -2     -7     +8     -4    -16   (percentage points)
     *     share of failures with felt still on the table:
     *                 19%    15%    27%     8%    23%    51%
     *
     * So felt is a real binding constraint that ramps with the level, at an average cost of ~5pp.
     * The dense `VM_FULL_SWEEP=1` feasibility sweep passes unchanged.
     *
     * ⚠️ READ THOSE DELTAS AS AN UPPER BOUND ON THE HARM, NOT AS AN ESTIMATE. `sim.ts`'s `goalValue`
     * scores ONLY goal symbols, so the proxy cannot see felt and clears it purely by accident — it
     * is the worst possible player at precisely this mechanic, and prioritising the felt is the
     * skill the archetype exists to reward. Do NOT retune this density against these numbers. If it
     * ever does need tuning, make the proxy coat-aware FIRST — and re-baseline
     * `plinko.rate.test.ts` at the same time, because that guard reads the same policy.
     */
    coat: true,
    /**
     * An obstacle that never matches and must be broken by adjacent clears. The sharp instrument.
     *
     * SLICE 0 ROLLOUT ADVANCED (from `false`, 2026-08-04). Blockers were built, arted and
     * feasibility-gated for band 86 and then held back — which left the ladder introducing nothing
     * genuinely new between the 2-layer felt at 151 and the end at 300, exactly the range the
     * mid-game refresh exists to serve. They turn on at their DESIGNED band (86), so the intro ramp,
     * the caps, the 2-hp escalation at 181 and the teach card all run as originally measured; L86
     * becomes a real teaching level (+3 moves) instead of the §G12 dead dip it was while the flag
     * was off. `hazards.test.ts`'s shipped-rollout pin changed in the same commit, on purpose.
     */
    blocker: true,
  },

  /** The move-budget retune. Independent of `hazards` above. */
  curve: { enabled: true },

  /**
   * Goal-archetype rollout — the win-condition siblings of the hazard flags above, with the same
   * contract: per-mechanic boolean, revocable without a git revert, and OFF must mean the spec is
   * byte-identical to today's.
   *
   * `minimum` is HOUSE MINIMUM (Slice 0, 2026-08-04): from `minimumStart`, levels on the fixed
   * cadence L % 10 ∈ {1, 6} carry a score target as a second win term — the plaque replaces the
   * third collect objective, never the move budget (see `levelSpec`). The cadence deliberately
   * avoids every-5th breathers and chapter-closing 10ths.
   */
  goals: { minimum: true, minimumStart: 201 },

  /**
   * ACT II — THE HIGH-ROLLER FLOORS (levels 301+). The third staged-rollout block, same contract as
   * `hazards` and `goals` above: a master switch, one boolean per mechanic, and OFF must mean the
   * game is byte-identical to Act I's. `actII.test.ts` pins the shipped state so a rollout change is
   * a DECISION written down in the same commit, exactly as `hazards.test.ts` does.
   *
   * ⚠️ `enabled: false` does NOT hide levels 301–400. `LEVEL_COUNT` is a CLIENT-ATOMIC constant: it
   * ships in one deploy with its trophy catalogue and its showroom wing, because a `claimChapter`
   * that outran the catalogue would be a crash, not a downgrade. What the switch does is strip Act
   * II's BEHAVIOUR back out — no rail, no floor moods, no elevator — leaving those levels on the
   * plain extended curve. That is why `levels.test.ts`'s panic-switch transcription still covers
   * the whole 1..LEVEL_COUNT range with the act switched off.
   */
  act2: {
    enabled: true,
    /** THE REEL PULL — pull a column one notch, wrapping the bottom piece to the top, for one move. */
    pull: true,
    /** First level carrying the rail. Earns a teaching level like every other band start. */
    pullStart: 301,
    /** Floor moods — per-floor ambiance (view/floormood.ts). Modulates light; never the theme's wash. */
    mood: true,
    /** THE PRIVATE ELEVATOR reveal + the LevelSelect dressing that advertises the act. */
    reveal: true,
    /** THE TELL — the marquee's hue drifting toward the best available move while the board idles. */
    tell: true,
  },

  /** First level at which each mechanic appears. Below `lockStart` the game is untouched. */
  bands: { lockStart: 31, coatStart: 56, blockerStart: 86, lateStart: 121 },

  /** Per-mechanic ramps. `from`/`to` are the level window of the introductory climb and `count` its
   *  [start, end] cell count; above `lateStart` each mechanic creeps on to `lateCount` by L300.
   *  Counts are cell counts on a 64-cell board — see the superlinearity note above for why the
   *  blocker numbers are so much smaller than the others. */
  density: {
    lock: { from: 31, to: 60, count: [3, 8], lateCount: [8, 12] },
    coat: { from: 56, to: 90, count: [6, 14], lateCount: [14, 18] },
    blocker: { from: 86, to: 120, count: [2, 4], lateCount: [4, 5] },
    /** Fraction of coats that get a 2nd layer / blockers that get 2 hp, ramped across the late band. */
    coat2LayerFrom: 151,
    coat2LayerMaxFrac: 0.35,
    blocker2HpFrom: 181,
    blocker2HpMaxFrac: 0.4,
  },

  /** Placement caps that keep cascades alive. A blocker must never be able to wall off a column:
   *  segment-aware gravity keeps chains running, and these caps keep the board open. */
  caps: {
    maxBlockers: 6,
    blockersPerColumn: 1,
    blockersPerRow: 2,
    /** Row 0 is where refills enter — always keep it clean. */
    forbiddenBlockerRows: [0],
  },

  /** The old "+2 moves every 5th level" breather was a 4-5% difficulty DIP, bigger than the trend
   *  gain over the surrounding 15-25 levels — the single largest cause of 31% of levels being
   *  easier than their predecessor. Above the protected band it is replaced by a hazard-LIGHT
   *  beat: same "catch your breath" wave, but the player can actually see it (a cleaner table)
   *  instead of an invisible +2 they never perceive. */
  breatherHazardScale: 0.5,

  /** Extra moves on the level that introduces a mechanic — teaching should be kind. */
  teachingLevelBonusMoves: 3,

  /** Escape-hatch tightenings. Conservative by design; the in-level chip shop is deliberately
   *  kept (it is actively used) — these only stop the degenerate cases. */
  economy: {
    /** `takePendingBoosts` used to drain the ENTIRE bank into one level (~13 boosts: +13 moves and
     *  ~8 pre-planted specials). The surplus now STAYS BANKED, which is strictly better for the
     *  player than today, where it evaporated on whatever level happened to be next. */
    boostApplyMax: 3,
    /** At most one board-clearing jackpot boost per level. */
    jackpotBoostPerLevel: 1,
    /** Replaying an already-cleared level pays this fraction, unless it beats your star count.
     *  Replay itself stays free — it is how you chase stars. */
    replayChipFraction: 0.25,
    /** Purchased moves per level, as a fraction of the level's own budget (14 at L65). */
    purchasedMovesFrac: 0.25,
    maxBombsPerLevel: 3,
  },
} as const

/**
 * Levels that introduce a mechanic — they get `teachingLevelBonusMoves` and that band's floor density.
 *
 * §G12 — gated on the mechanic actually being SWITCHED ON. Before this, a held-back mechanic still
 * bought its band-start level a +3 move bonus, so that level was ~5% easier than its neighbours to
 * teach something that never appears: no hazard on the board, no intro card, and nothing on screen
 * to explain the dip. With blockers still held back, L86 was exactly that.
 */
export function isTeachingLevel(level: number): boolean {
  const { bands, hazards, goals, act2 } = DIFFICULTY
  const hazardTeach =
    hazards.enabled &&
    ((hazards.lock && level === bands.lockStart) ||
      (hazards.coat && level === bands.coatStart) ||
      (hazards.blocker && level === bands.blockerStart))
  // HOUSE MINIMUM's first level teaches a new WIN TERM, so it earns the same gentleness a new
  // hazard band does — gated on its own flag, not on `hazards.enabled` (it is not a hazard).
  // THE REEL PULL teaches a new VERB at `act2.pullStart`, and gets the same courtesy on its own
  // flags: with the act switched off, L301 must be an ordinary level with an ordinary budget.
  return (
    hazardTeach ||
    (goals.minimum && level === goals.minimumStart) ||
    (act2.enabled && act2.pull && level === act2.pullStart)
  )
}

/** True when `level` is below every hazard band (or hazards are off) — i.e. the protected early game. */
export function hazardFreeLevel(level: number): boolean {
  return !DIFFICULTY.hazards.enabled || level < DIFFICULTY.bands.lockStart
}

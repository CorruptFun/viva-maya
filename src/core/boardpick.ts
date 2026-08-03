import { SALT_ACTIVE_FROM, daySaltApplies, seedForKey } from './endless'
import { mulberry32 } from './rng'
import type { Rng } from './rng'
import { playEndless } from './sim'

/**
 * BOARD NORMALISATION — every race day gets a board worth racing.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────────
 * The day seed is a hash, so the board it deals is a lottery, and the lottery is WIDE. Measured over
 * 60 consecutive real days (greedy policy, Plinko held fixed):
 *
 *     min 2,940 · p25 4,720 · p50 8,020 · p75 12,100 · max 18,060      — a 6.1x spread
 *
 * So "how big a score is possible today" was decided mostly by which layout the hash happened to
 * produce, not by the player. On a poor board everyone's ceiling collapses together; on a rich one
 * everyone's inflates. Across a week that noise is far louder than skill, and since the season is
 * the SUM of seven daily bests, it lands directly on who wins the race.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────────────────────────
 * Deterministic rejection sampling. Walk a fixed sequence of candidate keys — `k`, `k#1`, `k#2` … —
 * simulate each, and take the first board whose greedy score lands inside [BAND_LO, BAND_HI].
 * Measured need over those same 60 days: a median of 2 candidates, 90th percentile 4, worst 9, and
 * no day failed to find one inside 40. It is a search, not a redesign: every board it can choose is
 * a board the original generator could already have dealt.
 *
 * ── WHY THIS IS SAFE FOR A SHARED RACE ──────────────────────────────────────────────────────────
 * Everything here is a pure function of the day key and the day's salt, so every player converges on
 * the same choice. Nothing is drawn per-run or per-device.
 *
 * ── ⚠️ THE COUPLING THIS CREATES, STATED PLAINLY ────────────────────────────────────────────────
 * The chosen board now depends on `playEndless`, and therefore on Board mechanics, the scoring rule
 * and the Plinko trigger. A change to ANY of those can shift which candidate wins, which would move
 * the board — and two client versions disagreeing about the board is exactly the failure the salt
 * exists to prevent, except this one would come from our own release rather than a stale cache.
 *
 * `boardpick.test.ts` therefore pins the chosen offsets for a set of known days as GOLDEN VALUES. If
 * you change board mechanics, scoring or Plinko and that test fails, the failure is not the test
 * being brittle — it is telling you the boards moved. Handle it deliberately: ship the change behind
 * a new activation date the way the salt was, rather than re-recording the numbers.
 */

/**
 * The acceptable band for a day's board, in greedy-policy points.
 *
 * Chosen from the measured distribution above: it sits around the raw p50–p75, so a normalised board
 * is a good-but-not-freak one. Widening it weakens the fix; narrowing it costs search time fast
 * (the 10,000–14,000 band needed a median of 4 candidates and a worst case of 20, against 2 and 9
 * here) and starts rejecting boards for being *too generous*, which players experience as the game
 * being stingy rather than as fairness.
 */
export const BAND_LO = 8000
export const BAND_HI = 16000

/**
 * How far the search will walk. The measured worst case over 60 days was 9, so this is ~2.5x
 * headroom; a day that somehow exhausted it falls back to the closest candidate rather than to an
 * arbitrary one, so the answer degrades smoothly instead of off a cliff.
 */
const MAX_TRIES = 24

/**
 * The Plinko stream used while JUDGING a candidate. Fixed on purpose: Plinko is the one random part
 * of a run, and letting it vary would make the quality measurement noisy — the same board could pass
 * or fail depending on a coin flip, and two players could then disagree about which board today is.
 */
const JUDGE_ROLL = 0x1234

/** What a greedy player scores on the board `seed` deals. The quality metric — see the coupling note. */
function quality(seed: number): number {
  return playEndless(seed, 'greedy', mulberry32(JUDGE_ROLL)).score
}

/** Normalisation shares the salt's activation date: ONE board handover, not two. */
export function boardPickApplies(day: string): boolean {
  return day >= SALT_ACTIVE_FROM
}

/**
 * How many candidates deep the chosen board sits for `baseKey` — 0 means the original board already
 * qualified. Exposed (rather than just the seed) so the golden test can pin the offsets themselves,
 * which is the readable form of "did the boards move".
 */
export function pickOffset(baseKey: string): number {
  let bestOffset = 0
  let bestDistance = Infinity
  const mid = (BAND_LO + BAND_HI) / 2
  for (let n = 0; n < MAX_TRIES; n++) {
    const q = quality(seedForKey(n === 0 ? baseKey : `${baseKey}#${n}`))
    if (q >= BAND_LO && q <= BAND_HI) return n
    // Track the near miss, so an exhausted search still returns the most reasonable board rather
    // than falling back to candidate 0 — which is precisely the board we rejected as too poor.
    const d = Math.abs(q - mid)
    if (d < bestDistance) {
      bestDistance = d
      bestOffset = n
    }
  }
  return bestOffset
}

/**
 * Chosen offsets, memoised across scene restarts.
 *
 * The search runs up to MAX_TRIES simulations at ~24ms each on a dev machine and several times that
 * on a phone, so paying it again every time the player replays the day's board would be felt. The
 * answer is a pure function of the key, so caching it is free of risk — and the cache is keyed by
 * the FULL base key (which contains the day and the salt), so it self-invalidates at the handover
 * rather than needing to be pruned on a clock.
 */
const KEY = 'vm.boardpick'
let memo: Record<string, number> | null = null

function loadMemo(): Record<string, number> {
  if (memo) return memo
  memo = {}
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        // Shape-tolerant like every other restore here: a corrupt entry must degrade to "not cached"
        // (a recompute) rather than poison the board with NaN.
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_TRIES) memo[k] = v
      }
    }
  } catch {
    // storage blocked — the in-memory memo still serves this session
  }
  return memo
}

/** `pickOffset`, memoised. Keeps at most a couple of days; keys are long, and only today's is used. */
function cachedOffset(baseKey: string): number {
  const m = loadMemo()
  const hit = m[baseKey]
  if (typeof hit === 'number') return hit
  const n = pickOffset(baseKey)
  m[baseKey] = n
  const keys = Object.keys(m)
  for (const stale of keys.slice(0, Math.max(0, keys.length - 3))) delete m[stale]
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    // storage blocked — the memo above still serves this session
  }
  return n
}

/** The key to hash for `baseKey`'s normalised board. Identity before the activation date. */
export function pickedKey(baseKey: string, day: string): string {
  if (!boardPickApplies(day)) return baseKey
  const n = cachedOffset(baseKey)
  return n === 0 ? baseKey : `${baseKey}#${n}`
}

/**
 * THE RACE BOARD, end to end — the one call GameScene makes.
 *
 * Composes the two mechanisms in the order they have to happen: the salt decides WHICH lottery is
 * being drawn (and cannot be known before the day opens), then the normalisation picks a good ticket
 * out of it. Doing it the other way round would let a poor board be normalised into a good one that
 * an attacker could still have computed in advance.
 *
 * Both are gated on the same activation date, so there is exactly ONE board handover rather than two.
 * Before it, and whenever the salt is missing (offline), this reduces to the original board exactly.
 */
export function endlessBoardRng(day: string, salt?: string | null): Rng {
  const base = salt && daySaltApplies(day) ? `${day}:${salt}` : day
  return mulberry32(seedForKey(pickedKey(base, day)))
}

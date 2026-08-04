import type { SaveData } from './save'

/** Sum of earned stars — a progress signal in the merge tiebreak chain. */
function totalStars(s: SaveData): number {
  return Object.values(s.stars || {}).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0)
}

/**
 * Pick the save to KEEP when local and cloud disagree — the one that is FURTHEST progressed, compared
 * lexicographically by [unlocked, best, totalStars, chips]. Returns a WHOLE record (never a
 * field-wise Frankenstein), and on a dead tie prefers `a` (callers pass LOCAL first), so an identical
 * cloud never clobbers local. Pure + dependency-free so it's trivially unit-testable. (Multi-device
 * divergence beyond this heuristic is a later concern; for one player it simply never loses forward
 * progress — the whole point of cloud save.)
 */
export function mergeSaves(a: SaveData, b: SaveData): SaveData {
  const metrics = (s: SaveData): number[] => [s.unlocked || 1, s.best || 0, totalStars(s), s.chips || 0]
  const ma = metrics(a)
  const mb = metrics(b)
  let winner = a
  for (let i = 0; i < ma.length; i++) {
    if (mb[i] > ma[i]) {
      winner = b
      break
    }
    if (ma[i] > mb[i]) break
  }
  return { ...winner, ...unionLatches(a, b), ...pickHandle(a, b) }
}

/**
 * The chosen race name, reconciled across devices — MOST RECENTLY SET WINS.
 *
 * It rides neither of the other two rules. It is not a magnitude, so it must not travel with the
 * progress winner: rename yourself on the phone, then open a tablet that happens to be further along,
 * and the winner's record would quietly restore the old name — and re-publish it to the boards. Nor is
 * it a monotonic latch like the ones below, because a name legitimately CHANGES (and can be cleared),
 * so there is nothing to union. What makes one side right is only ever recency, hence `handleSetAt`.
 *
 * A dead tie prefers `a` — callers pass LOCAL first — matching mergeSaves' own tie rule. The common
 * recovery case falls out of this for free: a device whose storage was cleared has handleSetAt 0, so
 * the cloud's stamped name wins and core/leaderboard.adoptHandle writes it back to the device.
 */
function pickHandle(a: SaveData, b: SaveData): Partial<SaveData> {
  const at = a.handleSetAt || 0
  const bt = b.handleSetAt || 0
  const win = bt > at ? b : a
  return { handle: win.handle ?? null, handleSetAt: win.handleSetAt || 0 }
}

/**
 * §G14 · the LATCHES, unioned across both saves regardless of which one wins the progress compare.
 *
 * `mergeSaves` deliberately keeps a whole record rather than building a field-wise Frankenstein —
 * that is right for anything with a magnitude (you want ONE self-consistent set of progress
 * numbers). But these fields are not magnitudes. They are monotonic facts about the PLAYER — "has
 * been told this rule", "has claimed this prize" — and a fact like that cannot be undone by
 * arriving at a device with a bigger `unlocked`.
 *
 * Two things were going wrong because they rode the winner:
 *
 *  • TEACH CARDS CAME BACK. See a card, then pull a cloud save that happens to be further along,
 *    and `seenIntro` / `hazardIntros` / `specialIntros` are discarded with the losing record — so
 *    the game re-explains the Wild Reel you learned about last week. This is the one players
 *    actually notice, because being taught something twice reads as the game forgetting them.
 *
 *  • CLAIM LATCHES COULD BE SPENT TWICE. `championWeeks` and `referralWelcomeClaimed` exist
 *    precisely so a second device cannot re-award a prize; losing them to a merge re-opens exactly
 *    the double-award the award-first discipline is built to prevent.
 *
 * Union is always safe here because every one of these only ever grows. `finaleSeen` and the two
 * booleans OR together for the same reason.
 *
 * `endlessDays` joins them under the same rule, one level down: it is a map of per-day BESTS, and a
 * given (player, day) best only ever rises, so taking the max per key can no more lose a score than
 * unioning a latch can un-see a teach card. It is deliberately not the "field-wise Frankenstein" the
 * doc above warns against — no two numbers are blended, each day keeps whichever save saw the better
 * run. It has to work this way now that a WEEK's standing is the SUM of its days: play Tuesday on the
 * phone and Wednesday on the tablet and a winner-takes-all merge would silently halve the week.
 */
function unionLatches(a: SaveData, b: SaveData): Partial<SaveData> {
  const both = (x: string[] = [], y: string[] = []): string[] => Array.from(new Set([...x, ...y]))
  const bothN = (x: number[] = [], y: number[] = []): number[] =>
    Array.from(new Set([...x, ...y])).sort((p, q) => p - q)
  return {
    seenIntro: a.seenIntro || b.seenIntro,
    finaleSeen: a.finaleSeen || b.finaleSeen,
    // Joined late: raceunlockcard.ts always documented this as cloud-latched, but it shipped without
    // a union rule — so a progress-winner merge silently dropped it and the one-time card replayed.
    seenRaceUnlock: a.seenRaceUnlock || b.seenRaceUnlock,
    referralWelcomeClaimed: a.referralWelcomeClaimed || b.referralWelcomeClaimed,
    hazardIntros: both(a.hazardIntros, b.hazardIntros),
    specialIntros: both(a.specialIntros, b.specialIntros),
    occasionsSeen: both(a.occasionsSeen, b.occasionsSeen),
    championWeeks: both(a.championWeeks, b.championWeeks),
    championDays: both(a.championDays, b.championDays),
    raceRecapDays: both(a.raceRecapDays, b.raceRecapDays),
    // Chapter trophies are claim latches like championWeeks, numeric and permanent — losing one to a
    // merge would re-pay a purse; the union also guarantees a trophy earned on either device shows in
    // the showroom on both. Sorted so the showroom and catch-up card read in chapter order.
    chapterRewards: bothN(a.chapterRewards, b.chapterRewards),
    endlessDays: bestPerDay(a.endlessDays, b.endlessDays),
    ...mergeCharms(a, b),
  }
}

/** Per-key max of two daily-best maps — see the `endlessDays` note in `unionLatches`. */
function bestPerDay(
  a: Record<string, number> = {},
  b: Record<string, number> = {}
): Record<string, number> {
  const out: Record<string, number> = { ...a }
  for (const [day, n] of Object.entries(b)) {
    if (typeof n !== 'number' || !Number.isFinite(n)) continue
    const cur = out[day]
    if (typeof cur !== 'number' || !Number.isFinite(cur) || n > cur) out[day] = n
  }
  return out
}

/**
 * CHARMS across two devices — a latch that resets, so plain union is wrong.
 *
 * `charms` holds the CURRENT album only and is emptied when a series completes, which means the ids
 * in it are monotone *within a series* and meaningless across one. Unioning blindly would resurrect a
 * finished album: a device sitting on Series II with two charms, merged against one still on Series I
 * with eight, would come back holding all nine of a series whose purse was already paid — a
 * completion the player gets to bank twice.
 *
 * So compare the SERIES first (it only ever climbs, so the higher one has already absorbed everything
 * below it) and union the ids only when both devices are on the same album. `charmsAllTime` takes the
 * max because it never resets — and because it is what LUCK reads, so losing it would visibly nerf the
 * Deal for a player whose only mistake was owning two phones.
 */
function mergeCharms(a: SaveData, b: SaveData): Partial<SaveData> {
  const seriesA = a.charmSeries || 1
  const seriesB = b.charmSeries || 1
  const charmsAllTime = Math.max(a.charmsAllTime || 0, b.charmsAllTime || 0)
  if (seriesA === seriesB) {
    return {
      charmSeries: seriesA,
      charms: Array.from(new Set([...(a.charms || []), ...(b.charms || [])])),
      charmsAllTime,
    }
  }
  const ahead = seriesA > seriesB ? a : b
  return { charmSeries: ahead.charmSeries, charms: [...(ahead.charms || [])], charmsAllTime }
}

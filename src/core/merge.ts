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
  return { ...winner, ...unionLatches(a, b) }
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
 */
function unionLatches(a: SaveData, b: SaveData): Partial<SaveData> {
  const both = (x: string[] = [], y: string[] = []): string[] => Array.from(new Set([...x, ...y]))
  return {
    seenIntro: a.seenIntro || b.seenIntro,
    finaleSeen: a.finaleSeen || b.finaleSeen,
    referralWelcomeClaimed: a.referralWelcomeClaimed || b.referralWelcomeClaimed,
    hazardIntros: both(a.hazardIntros, b.hazardIntros),
    specialIntros: both(a.specialIntros, b.specialIntros),
    occasionsSeen: both(a.occasionsSeen, b.occasionsSeen),
    championWeeks: both(a.championWeeks, b.championWeeks),
  }
}

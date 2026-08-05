import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_WEEK_CUTOVER,
  adoptHandle,
  anonName,
  applyChapterTiers,
  chaseCopy,
  chaseOvertakes,
  formatStanding,
  getHandle,
  isLegacyWeek,
  levelStanding,
  loadChaseSnapshot,
  mergeTransitionWeek,
  preferredName,
  sanitizeName,
  saveChaseSnapshot,
  setHandle,
} from './leaderboard'
import type { ChaseNeighbour, ChaseSnapshot, ChaseWindow, DailyWeekRow, LegacyWeekRow, LeaderboardEntry } from './leaderboard'
import { coerceSave, loadSave, type SaveData } from './save'

/**
 * Race-name (handle) unit tests — the pure storage + sanitising layer only.
 * The Supabase paths are dormant here by design (no VITE_SUPABASE_* in the test
 * env), so setHandle's fire-and-forget rename resolves as a no-op — exactly the
 * unconfigured production path.
 */

// Minimal localStorage stub for the Node test env (theme.ts-style guarded access).
function stubStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  }
}

beforeEach(stubStorage)
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

describe('sanitizeName', () => {
  it('keeps letters, numbers, spaces and _.- and trims', () => {
    expect(sanitizeName('  Neon_Ghost-77. ')).toBe('Neon_Ghost-77.')
  })
  it('takes only the local part of an email', () => {
    expect(sanitizeName('jane.doe@example.com')).toBe('jane.doe')
  })
  it('strips symbols and emoji', () => {
    expect(sanitizeName('n<e>o#n!👻ghost')).toBe('neonghost')
  })
  it('caps at 24 characters', () => {
    expect(sanitizeName('a'.repeat(40))).toHaveLength(24)
  })
  it('falls back to "player" when nothing survives', () => {
    expect(sanitizeName('@@@')).toBe('player')
    expect(sanitizeName('')).toBe('player')
    expect(sanitizeName(null)).toBe('player')
  })
  it('keeps non-latin letters', () => {
    expect(sanitizeName('Майя-77')).toBe('Майя-77')
  })
})

describe('handle storage', () => {
  it('round-trips a chosen handle, sanitized', () => {
    expect(setHandle('  Neon Ghost!! ')).toBe('Neon Ghost')
    expect(getHandle()).toBe('Neon Ghost')
  })
  it('clears with null or blank input', () => {
    setHandle('ghosty')
    expect(setHandle('')).toBeNull()
    expect(getHandle()).toBeNull()
    setHandle('ghosty')
    expect(setHandle(null)).toBeNull()
    expect(getHandle()).toBeNull()
  })
  it('behaves as unset when storage is unavailable', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(getHandle()).toBeNull()
    expect(setHandle('ghosty')).toBe('ghosty') // sanitized value still returned for the session
  })
})

describe('preferredName', () => {
  it('prefers the chosen handle over everything', () => {
    setHandle('neonghost')
    expect(preferredName()).toBe('neonghost')
  })
  it('falls back to "player" when signed out with no handle', () => {
    // cloudSession() is null in the test env (never signed in).
    expect(preferredName()).toBe('player')
  })
})

/**
 * The ANONYMOUS DEFAULT — what a player who never opened the picker publishes. It replaced the email
 * local-part, which for a Google account is routinely a real name, so these tests are the privacy
 * invariant's front door. (leaderboard.privacy.test.ts pins the other half: that a live session's
 * email cannot reach a board even when one exists.)
 */
describe('anonName', () => {
  it('matches the SQL formula EXACTLY — the shared case asserted by migration 0017', () => {
    // 0017's own self-check runs public.anon_display_name on this uuid and refuses to apply unless it
    // returns this string. The client renders one and the server stores the other, so a drift here
    // would have the board calling a player something the app never showed them. Change both or
    // neither: this line and supabase/migrations/0017_display_name_never_email.sql.
    expect(anonName('7f3a91b2-0000-0000-0000-000000000000')).toBe('Player 7F3A')
  })

  it('is stable for one account and distinct between accounts', () => {
    const a = '9c1e0000-0000-0000-0000-000000000000'
    const b = '2b4d0000-0000-0000-0000-000000000000'
    expect(anonName(a)).toBe(anonName(a))
    expect(anonName(a)).not.toBe(anonName(b))
  })

  it('degrades to "player" rather than inventing a name from junk', () => {
    // Signed out there is no user id, and a half-formed one must not become a public label.
    expect(anonName(null)).toBe('player')
    expect(anonName(undefined)).toBe('player')
    expect(anonName('')).toBe('player')
    expect(anonName('xyz')).toBe('player')
  })

  it('survives sanitizeName unchanged, so it reaches the board as written', () => {
    // Every read path re-sanitizes display_name. If the space or the digits were stripped, the anon
    // name would render differently than the picker's preview promised.
    expect(sanitizeName(anonName('7f3a91b2-0000-0000-0000-000000000000'))).toBe('Player 7F3A')
  })
})

/**
 * The HANDLE BRIDGE — the name lives in its own localStorage key AND in the save. Storage-only was the
 * whole reason a name did not survive a cleared browser or a new phone: the cloud restored the
 * player's progress but had never been told their name, so the boards reverted to the default and the
 * player re-entered it. These tests pin the two halves of the round trip.
 */
describe('handle ↔ save bridge', () => {
  it('writes the name into the SAVE, so it rides cloud sync', () => {
    setHandle('neonghost')
    expect(loadSave().handle).toBe('neonghost')
  })

  it('stamps handleSetAt, so the newest rename wins the cross-device merge', () => {
    const before = Date.now()
    setHandle('neonghost')
    expect(loadSave().handleSetAt).toBeGreaterThanOrEqual(before)
  })

  it('records a CLEARED name as a stamped null, not as "never set"', () => {
    setHandle('neonghost')
    setHandle(null)
    const s = loadSave()
    expect(s.handle).toBeNull()
    expect(s.handleSetAt).toBeGreaterThan(0) // an unstamped clear would lose to any cloud name
  })

  it('reads the save when the dedicated key is missing — a name is not lost with one key', () => {
    setHandle('neonghost')
    localStorage.removeItem('viva-maya:handle')
    expect(getHandle()).toBe('neonghost')
  })

  it('adopts the cloud name over whatever this device had', () => {
    // The recovery path: a rename happened on another device and arrived via the merge.
    setHandle('oldname')
    adoptHandle(coerceSave({ handle: 'phantom', handleSetAt: 9_000 }))
    expect(getHandle()).toBe('phantom')
    expect(preferredName()).toBe('phantom')
  })

  it('does not clobber a local name when the cloud has none', () => {
    // A save from a player who never chose a name must not wipe one this device legitimately holds.
    setHandle('neonghost')
    adoptHandle(coerceSave({}))
    expect(getHandle()).toBe('neonghost')
  })
})

/**
 * LEVEL RACE standing — the whole basis of the ladder's ranking. It decides the rung a player lands
 * on and the stars that break ties on it, and it is the only part of the board pure enough to test
 * without a network, so it gets pinned hard: the off-by-one that would put every player a level
 * ahead, and the shape-tolerance that stops a corrupt save poisoning a PUBLIC row.
 */
const save = (over: Partial<SaveData>): SaveData => ({ unlocked: 1, stars: {}, ...over }) as SaveData

describe('levelStanding', () => {
  it('reads CLEARED as one below unlocked — a fresh save has cleared nothing', () => {
    // `unlocked` is the highest level the player MAY ATTEMPT, so a brand-new save (unlocked 1,
    // attempting level 1) has cleared ZERO. Reporting 1 would place every player who has never
    // finished a level onto the ladder alongside those who legitimately cleared level 1.
    expect(levelStanding(save({ unlocked: 1 })).cleared).toBe(0)
    expect(levelStanding(save({ unlocked: 2 })).cleared).toBe(1)
    expect(levelStanding(save({ unlocked: 48 })).cleared).toBe(47)
  })

  it('never reports a negative rung from a corrupt unlocked value', () => {
    expect(levelStanding(save({ unlocked: 0 })).cleared).toBe(0)
    expect(levelStanding(save({ unlocked: -5 })).cleared).toBe(0)
  })

  it('sums stars across cleared levels', () => {
    expect(levelStanding(save({ unlocked: 4, stars: { 1: 3, 2: 2, 3: 1 } }))).toEqual({ cleared: 3, stars: 6 })
  })

  it('ignores stars recorded ABOVE the cleared mark', () => {
    // The server clamps to 3×cleared anyway; sending a row it has to correct would hide a real
    // desync (stars and unlocked disagreeing) behind a silent server-side fixup.
    expect(levelStanding(save({ unlocked: 3, stars: { 1: 3, 2: 3, 9: 3, 40: 3 } }))).toEqual({ cleared: 2, stars: 6 })
  })

  it('survives a corrupt stars record without emitting NaN', () => {
    // `stars` is restored shape-tolerantly straight from localStorage, so anything can be in there.
    // A NaN would serialize into the public row and sort unpredictably against every other player.
    const dirty = { 1: 3, 2: NaN, 3: 'three', 4: null, 5: undefined, 6: -2, 7: Infinity } as unknown as Record<number, number>
    const s = levelStanding(save({ unlocked: 8, stars: dirty }))
    expect(Number.isFinite(s.stars)).toBe(true)
    expect(s.stars).toBe(3) // only level 1's legitimate 3 survives
    expect(s.cleared).toBe(7)
  })

  it('caps any single level at 3 stars', () => {
    expect(levelStanding(save({ unlocked: 3, stars: { 1: 99, 2: 3 } })).stars).toBe(6)
  })

  it('never exceeds the server ceiling of 3 stars per cleared level', () => {
    // Mirrors `least(new.stars, new.cleared * 3)` in migration 0007. If this ever breaches the
    // ceiling the server silently rewrites our row and the board stops matching the game.
    for (const unlocked of [1, 2, 10, 51, 301]) {
      const stars: Record<number, number> = {}
      for (let i = 1; i < unlocked; i++) stars[i] = 3
      const s = levelStanding(save({ unlocked, stars }))
      expect(s.stars, `unlocked ${unlocked}`).toBeLessThanOrEqual(s.cleared * 3)
    }
  })

  it('tolerates a missing stars record entirely', () => {
    expect(levelStanding({ unlocked: 5 } as SaveData)).toEqual({ cleared: 4, stars: 0 })
  })
})

describe('formatStanding', () => {
  it('shows the rung first, then the mastery that breaks ties on it', () => {
    expect(formatStanding({ cleared: 47, stars: 118 })).toBe('47 · ★118')
    expect(formatStanding({ cleared: 0, stars: 0 })).toBe('0 · ★0')
  })
})

/**
 * The TRANSITION CUTOVER. The daily format shipped mid-week into a weekly race that was already
 * being run, so every week up to the cutover is still settled on the old shared board — otherwise
 * that week's crown goes to whoever won the days AFTER the switch and the players who spent it
 * battling get nothing. This is the one line that decides which source pays out, so it gets pinned:
 * an off-by-one week here silently pays the wrong player 1,000 chips.
 */
describe('isLegacyWeek — which weeks the old board still settles', () => {
  it('settles the cutover week and everything before it', () => {
    expect(isLegacyWeek(LEGACY_WEEK_CUTOVER)).toBe(true)
    expect(isLegacyWeek('2026-W30')).toBe(true)
    expect(isLegacyWeek('2026-W01')).toBe(true)
    expect(isLegacyWeek('2025-W52')).toBe(true)
  })

  it('hands the very next week to the summed-daily season', () => {
    expect(isLegacyWeek('2026-W32')).toBe(false)
    expect(isLegacyWeek('2026-W52')).toBe(false)
  })

  it('orders correctly across a year boundary — the trap in comparing week keys as strings', () => {
    // Zero-padded 'YYYY-Www' sorts chronologically, so a plain <= is safe. If the format ever loses
    // its padding this breaks silently, which is exactly why it is asserted rather than assumed.
    expect(isLegacyWeek('2027-W01')).toBe(false)
    expect(LEGACY_WEEK_CUTOVER).toMatch(/^\d{4}-W\d{2}$/)
  })

  it('is set to the week the switch actually landed in', () => {
    expect(LEGACY_WEEK_CUTOVER).toBe('2026-W31')
  })
})

/**
 * THE TRANSITION MERGE. A cutover week was raced under two rule sets, and both have to count: the
 * shared board its players were promised Monday to Wednesday, and every daily board since. Reading
 * only the shared half froze the week for five days while ten players raced it (production,
 * 2026-07-31); reading only the daily half would have thrown away the race that came before it.
 *
 * This is the function that decides who gets 1,000 chips, so every rule in it is pinned.
 */
describe('mergeTransitionWeek — both halves of the cutover week count', () => {
  const legacy = (user: string, score: number, at: string): LegacyWeekRow => ({
    user_id: user,
    display_name: user,
    score,
    scored_at: at,
  })
  const daily = (user: string, total: number, days: number, at: string): DailyWeekRow => ({
    user_id: user,
    display_name: user,
    total,
    days_played: days,
    last_scored_at: at,
  })

  it('adds a player’s shared-board score to their summed daily bests', () => {
    const [row] = mergeTransitionWeek(
      [legacy('loading', 12_000, '2026-07-28T18:00:00Z')],
      [daily('loading', 8_204, 2, '2026-07-30T23:00:00Z')]
    )
    expect(row.total).toBe(20_204)
    expect(row.days_played).toBe(2)
  })

  it('keeps a player who raced only ONE half — neither cohort is dropped', () => {
    const rows = mergeTransitionWeek(
      [legacy('mondayracer', 15_000, '2026-07-28T18:00:00Z')],
      [daily('newcomer', 9_000, 3, '2026-07-30T23:00:00Z')]
    )
    expect(rows.map(r => r.user_id)).toEqual(['mondayracer', 'newcomer'])
    expect(rows[0].total).toBe(15_000)
    expect(rows[1].days_played).toBe(3)
  })

  it('ranks on the COMBINED total, not on either half alone', () => {
    // Alone, the daily half would crown `sprinter`; the shared half would crown `grinder`.
    const rows = mergeTransitionWeek(
      [legacy('grinder', 14_000, '2026-07-28T12:00:00Z')],
      [daily('sprinter', 15_000, 2, '2026-07-30T12:00:00Z'), daily('grinder', 6_000, 2, '2026-07-30T13:00:00Z')]
    )
    expect(rows.map(r => r.user_id)).toEqual(['grinder', 'sprinter'])
    expect(rows[0].total).toBe(20_000)
  })

  it('breaks a level total on turnout, then on who got there first', () => {
    const tied = mergeTransitionWeek(
      [],
      [daily('spread', 10_000, 4, '2026-07-30T23:00:00Z'), daily('burst', 10_000, 2, '2026-07-29T09:00:00Z')]
    )
    expect(tied.map(r => r.user_id)).toEqual(['spread', 'burst'])

    const level = mergeTransitionWeek(
      [],
      [daily('later', 10_000, 3, '2026-07-30T23:00:00Z'), daily('earlier', 10_000, 3, '2026-07-29T09:00:00Z')]
    )
    expect(level.map(r => r.user_id)).toEqual(['earlier', 'later'])
  })

  it('takes the name from the most recent half, so a rename after the switch shows', () => {
    const [row] = mergeTransitionWeek(
      [{ user_id: 'u1', display_name: 'old name', score: 5_000, scored_at: '2026-07-28T18:00:00Z' }],
      [
        {
          user_id: 'u1',
          display_name: 'new name',
          total: 1_000,
          days_played: 1,
          last_scored_at: '2026-07-30T23:00:00Z',
        },
      ]
    )
    expect(row.display_name).toBe('new name')
    expect(row.last_scored_at).toBe('2026-07-30T23:00:00Z')
  })

  it('drops non-positive and malformed rows rather than seating them on the board', () => {
    const rows = mergeTransitionWeek(
      [legacy('zero', 0, '2026-07-28T18:00:00Z')],
      [daily('nan', Number.NaN, 1, '2026-07-30T23:00:00Z'), daily('real', 500, 1, '2026-07-30T23:00:00Z')]
    )
    expect(rows.map(r => r.user_id)).toEqual(['real'])
  })

  it('survives an unparseable timestamp instead of ranking on NaN', () => {
    const rows = mergeTransitionWeek(
      [],
      [daily('a', 100, 1, 'not-a-date'), daily('b', 100, 1, '2026-07-30T23:00:00Z')]
    )
    expect(rows).toHaveLength(2)
    // The junk timestamp sorts as the epoch — earliest — rather than poisoning the comparison.
    expect(rows[0].user_id).toBe('a')
  })

  it('is empty when the week was raced by nobody', () => {
    expect(mergeTransitionWeek([], [])).toEqual([])
  })
})

describe('applyChapterTiers — the badge decoration is pure and never blocks a board', () => {
  const entry = (name: string): LeaderboardEntry => ({ rank: 1, name, score: 100, you: false })

  it('maps cleared levels to chapters completed via the ids running parallel to the rows', () => {
    const entries = [entry('a'), entry('b'), entry('c')]
    applyChapterTiers(entries, ['ua', 'ub', 'uc'], new Map([['ua', 300], ['ub', 47], ['uc', 9]]))
    expect(entries.map(e => e.chapters)).toEqual([30, 4, 0])
  })

  it('leaves rows without a ladder row unbadged rather than guessing', () => {
    const entries = [entry('a'), entry('b')]
    applyChapterTiers(entries, ['ua', 'ub'], new Map([['ub', 130]]))
    expect(entries[0].chapters).toBeUndefined()
    expect(entries[1].chapters).toBe(13)
  })

  it('an empty map (the fetch failed) is a fully unbadged board, not an error', () => {
    const entries = [entry('a')]
    applyChapterTiers(entries, ['ua'], new Map())
    expect(entries[0].chapters).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// THE CHASE — the pure halves: the copy and the overtake diff.
//
// The network half (`fetchLevelNeighbours`) is dormant in this env by design, exactly as every
// other Supabase path here is. What is tested is the two things that decide what a player SEES: the
// string, and the rule that fires a card beat.
// ─────────────────────────────────────────────────────────────────────────────

describe('chaseCopy — the line the strip prints', () => {
  const near = (name: string, gap: number, key = name): ChaseNeighbour => ({
    name,
    cleared: 100 + gap,
    gap,
    key,
  })
  const win = (above: ChaseNeighbour[], below: ChaseNeighbour[]): ChaseWindow => ({ mine: 100, above, below })

  it('special-cases the singular — the most motivating string in the feature', () => {
    expect(chaseCopy(win([near('Sam', 1)], [])).ahead).toBe('chasing Sam  ·  one level ahead')
  })

  it('pluralises every other gap', () => {
    expect(chaseCopy(win([near('Sam', 5)], [])).ahead).toBe('chasing Sam  ·  5 levels ahead')
  })

  it('leads with the player ahead — the chase pulls, so the strip never leads with a pursuer', () => {
    const copy = chaseCopy(win([near('Sam', 3)], [near('Kim', 2)]))
    expect(copy.line).toBe('chasing Sam  ·  3 levels ahead')
    // The pursuit half is still available to a surface with room — it is just never the headline.
    expect(copy.behind).toBe('Kim is 2 levels behind you')
  })

  it('keeps the strip line inside the width the badge and chevron leave it', () => {
    // The strip's line has ~460px between the badge and the chevron at 21px/900 — about 40 glyphs,
    // 44 at the optimistic end. This is the guard that a hostile handle cannot grow the line: the
    // worst case is a name at the truncation cap plus the widest gap the 400-level ladder allows,
    // and it must stay bounded. Un-cap the name and a 24-char handle takes this to 53.
    const worst = chaseCopy(win([near('Neon_Ghost-77_Extra', 399)], [near('Wilhelmina', 4)]))
    expect(worst.line).toBe('chasing Neon_Ghost-77…  ·  399 levels ahead')
    expect(worst.line.length).toBeLessThanOrEqual(44)
  })

  it('gives a shared sub-line a compact tag, singular intact', () => {
    expect(chaseCopy(win([near('Sam', 5)], [])).tag).toBe('chasing Sam, 5 ahead')
    expect(chaseCopy(win([near('Sam', 1)], [])).tag).toBe('chasing Sam, one level ahead')
    expect(chaseCopy(win([], [near('Kim', 2)])).tag).toBe('top of the ladder')
  })

  it('nobody above reads as an achievement, never as an empty frame', () => {
    expect(chaseCopy(win([], [near('Kim', 2)])).line).toBe('top of the ladder  ·  Kim 2 behind')
    expect(chaseCopy(win([], [])).line).toBe('top of the ladder')
  })

  it('pluralises the pursuit half too', () => {
    expect(chaseCopy(win([], [near('Kim', 1)])).behind).toBe('Kim is one level behind you')
  })

  it('shortens a long handle instead of letting it run under the chevron', () => {
    const copy = chaseCopy(win([near('Neon_Ghost-77_Extra', 2)], []))
    expect(copy.ahead).toBe('chasing Neon_Ghost-77…  ·  2 levels ahead')
  })
})

describe('chaseOvertakes — what fires a YOU PASSED beat', () => {
  const near = (key: string, gap: number): ChaseNeighbour => ({ name: key, cleared: 42 - gap, gap, key })
  const snap = (mine: number, above: string[]): ChaseSnapshot => ({
    mine,
    above: above.map(k => ({ key: k, name: k })),
  })

  it('a cold cache announces nothing — a fresh install must not fabricate a dozen passes', () => {
    const next: ChaseWindow = { mine: 42, above: [], below: [near('sam', 1), near('kim', 3)] }
    expect(chaseOvertakes(null, next)).toEqual([])
  })

  it('someone who was above and is now below fires exactly one, nearest first', () => {
    const prev = snap(40, ['sam', 'kim'])
    const next: ChaseWindow = { mine: 42, above: [], below: [near('sam', 1), near('kim', 2)] }
    const out = chaseOvertakes(prev, next)
    expect(out.map(n => n.key)).toEqual(['sam', 'kim'])
    expect(out[0].key).toBe('sam') // the nearest is the one the card names
  })

  it('a replay announces nothing — no rung advanced, so nobody was passed', () => {
    const prev = snap(42, ['sam'])
    const next: ChaseWindow = { mine: 42, above: [], below: [near('sam', 1)] }
    expect(chaseOvertakes(prev, next)).toEqual([])
  })

  it('a neighbour who advanced too, and is still ahead, is not a pass', () => {
    const prev = snap(40, ['sam'])
    const next: ChaseWindow = { mine: 42, above: [{ name: 'sam', cleared: 45, gap: 3, key: 'sam' }], below: [] }
    expect(chaseOvertakes(prev, next)).toEqual([])
  })

  it('someone who was never above you is not a pass, however far below they now are', () => {
    const prev = snap(40, [])
    const next: ChaseWindow = { mine: 42, above: [], below: [near('kim', 8)] }
    expect(chaseOvertakes(prev, next)).toEqual([])
  })

  it('diffs on the opaque key, so a rename produces silence rather than a false pass', () => {
    const prev: ChaseSnapshot = { mine: 40, above: [{ key: 'a1b2c3d4', name: 'Sam' }] }
    const next: ChaseWindow = { mine: 42, above: [], below: [{ name: 'Samantha', cleared: 41, gap: 1, key: 'a1b2c3d4' }] }
    // Same account, new handle: the pass is still real and the card uses the NEW name.
    expect(chaseOvertakes(prev, next).map(n => n.name)).toEqual(['Samantha'])
  })
})

describe('the chase snapshot round-trip', () => {
  it('persists only the diff fields, and reads back what it wrote', () => {
    const w: ChaseWindow = {
      mine: 42,
      above: [{ name: 'Sam', cleared: 45, gap: 3, key: 'aaaa1111' }],
      below: [{ name: 'Kim', cleared: 40, gap: 2, key: 'bbbb2222' }],
    }
    saveChaseSnapshot(w)
    expect(loadChaseSnapshot()).toEqual({ mine: 42, above: [{ key: 'aaaa1111', name: 'Sam' }] })
  })

  it('reads junk as NO cache — one silent overtake, never a fabricated one', () => {
    localStorage.setItem('viva-maya:chase', '{ not json')
    expect(loadChaseSnapshot()).toBeNull()
    localStorage.setItem('viva-maya:chase', JSON.stringify({ mine: 'forty', above: [] }))
    expect(loadChaseSnapshot()).toBeNull()
  })

  it('is absent on a fresh device', () => {
    expect(loadChaseSnapshot()).toBeNull()
  })
})

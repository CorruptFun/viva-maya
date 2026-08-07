import { describe, expect, it } from 'vitest'
import { mergeSaves } from './merge'
import { coerceSave, type SaveData } from './save'

/**
 * mergeSaves is the heart of "never lose Maya's progress": when the local and cloud saves disagree, it
 * must keep the FURTHEST-progressed one — compared lexicographically by [unlocked, best, totalStars,
 * chips] — and take its PROGRESS as a whole (never a field-wise blend of two saves' numbers). Callers
 * pass LOCAL first, so a dead tie must keep local (an identical cloud can never clobber it). These
 * tests pin exactly that, because a bug here is the one thing that could actually lose her progress.
 *
 * §G14 — the LATCHES are the deliberate exception, and the assertions below moved from `toBe` to
 * `toEqual` to make room for it: every "has seen / has claimed" flag is unioned across BOTH saves
 * regardless of who wins, so the result is the winner's record plus the union. See `unionLatches`
 * in merge.ts for why (teach cards were coming back, and claim latches could be spent twice).
 * The progress guarantee is unchanged — no magnitude is ever blended.
 */

// Build a valid, full v7 SaveData from a partial via the REAL coercion path, so fixtures can never drift
// from the actual on-disk save shape.
const save = (partial: Partial<SaveData>): SaveData => coerceSave(partial)

describe('mergeSaves — furthest-progressed wins', () => {
  it('keeps the higher unlocked level (the primary metric), regardless of argument order', () => {
    const local = save({ unlocked: 40 })
    const remote = save({ unlocked: 50 })
    expect(mergeSaves(local, remote)).toEqual(remote)
    expect(mergeSaves(remote, local)).toEqual(remote)
  })

  it('a fresh device does NOT overwrite real cloud progress — it adopts the cloud save', () => {
    // THE critical case. A new phone signs in with an empty local save while the cloud holds Maya's real
    // progress. merge(local=fresh, remote=real) MUST return the cloud save so the next push mirrors HER
    // progress back — not the empty default. If this ever returned `local`, a reinstall would wipe her.
    const freshLocal = coerceSave({}) // brand-new device: unlocked 1, best 0
    const cloud = save({ unlocked: 47, best: 9000, stars: { 1: 3, 2: 3 }, chips: 120 })
    expect(mergeSaves(freshLocal, cloud)).toEqual(cloud)
  })

  it('on a dead tie, keeps LOCAL (the first arg) so an identical cloud never clobbers it', () => {
    const local = save({ unlocked: 30, best: 500, stars: { 1: 3 }, chips: 10 })
    const remoteEqual = save({ unlocked: 30, best: 500, stars: { 1: 3 }, chips: 10 })
    expect(mergeSaves(local, remoteEqual)).toEqual(local)
  })

  it('breaks ties by best, then total stars, then chips — in that order', () => {
    // unlocked equal → higher best wins
    const bestLo = save({ unlocked: 10, best: 100 })
    const bestHi = save({ unlocked: 10, best: 200 })
    expect(mergeSaves(bestLo, bestHi)).toEqual(bestHi)

    // unlocked + best equal → more total stars wins (1 star vs 6)
    const starsLo = save({ unlocked: 10, best: 100, stars: { 1: 1 } })
    const starsHi = save({ unlocked: 10, best: 100, stars: { 1: 3, 2: 3 } })
    expect(mergeSaves(starsLo, starsHi)).toEqual(starsHi)

    // unlocked + best + stars equal → more chips wins
    const chipsLo = save({ unlocked: 10, best: 100, stars: { 1: 3 }, chips: 10 })
    const chipsHi = save({ unlocked: 10, best: 100, stars: { 1: 3 }, chips: 20 })
    expect(mergeSaves(chipsLo, chipsHi)).toEqual(chipsHi)
  })

  it('lets unlocked dominate: a higher level wins even against a far higher best score', () => {
    const further = save({ unlocked: 50, best: 0 })
    const higherScore = save({ unlocked: 40, best: 99999 })
    expect(mergeSaves(further, higherScore)).toEqual(further)
    expect(mergeSaves(higherScore, further)).toEqual(further)
  })

  it('returns a WHOLE record, never a field-wise blend (documents the known single-player tradeoff)', () => {
    // local is further (unlocked 50) but has spent its chips; cloud is behind (unlocked 40) but chip-rich.
    // "Furthest-progressed wins" keeps local ENTIRE — so local's 0 chips stay; cloud's 999 are NOT grafted
    // in. This is intentional (see merge.ts): the merge never Frankensteins fields across two saves.
    const local = save({ unlocked: 50, chips: 0 })
    const cloud = save({ unlocked: 40, chips: 999 })
    const winner = mergeSaves(local, cloud)
    expect(winner).toEqual(local)
    expect(winner.chips).toBe(0)
  })
})

describe('mergeSaves — robustness', () => {
  it('never throws on minimal/partial objects and defaults missing metrics safely', () => {
    // Post-coerce this shouldn't happen, but the metric guards (|| 1, || 0, stars || {}) must hold even
    // for a stripped-down object, so a weird blob can never crash the boot reconcile.
    const a = { unlocked: 5 } as unknown as SaveData
    const b = { unlocked: 3 } as unknown as SaveData
    expect(() => mergeSaves(a, b)).not.toThrow()
    expect(mergeSaves(a, b).unlocked).toBe(5) // 5 > 3
  })

  it('treats a fully empty/default save as the lowest progress', () => {
    const empty = coerceSave({})
    const some = save({ unlocked: 2 })
    expect(mergeSaves(empty, some)).toEqual(some)
    expect(mergeSaves(some, empty)).toEqual(some)
  })
})

/**
 * §G14 — the latches survive a merge they would otherwise have lost.
 *
 * The bug these pin: `mergeSaves` returned one WHOLE record, so every "has seen / has claimed" flag
 * on the losing save was discarded. Pull a cloud save that happens to be further along and the game
 * re-taught you the Wild Reel you learned last week — and, worse, re-opened claim latches that exist
 * specifically to stop a second device double-awarding a prize.
 */
describe('mergeSaves — latches are unioned, never lost', () => {
  it('keeps teach-card latches from the LOSING save', () => {
    const local = save({ unlocked: 10, seenIntro: true, hazardIntros: ['lock'], specialIntros: ['wildReel'] })
    const cloud = save({ unlocked: 99, specialIntros: ['diceBomb'] }) // further along, but taught less
    const m = mergeSaves(local, cloud)
    expect(m.unlocked).toBe(99) // progress still comes from the winner, whole
    expect(m.seenIntro).toBe(true) // ...but "you already saw this" cannot be undone by progress
    expect(m.hazardIntros).toEqual(['lock'])
    expect([...m.specialIntros].sort()).toEqual(['diceBomb', 'wildReel'])
  })

  it('keeps CLAIM latches from the losing save, so a prize cannot be re-awarded', () => {
    const local = save({
      unlocked: 10,
      championWeeks: ['2026-W30'],
      championDays: ['2026-07-28'],
      raceRecapDays: ['2026-07-26'],
      referralWelcomeClaimed: true,
      finaleSeen: true,
    })
    const cloud = save({
      unlocked: 99,
      championWeeks: ['2026-W31'],
      championDays: ['2026-07-29'],
      raceRecapDays: ['2026-07-27'],
    })
    const m = mergeSaves(local, cloud)
    expect([...m.championWeeks].sort()).toEqual(['2026-W30', '2026-W31'])
    expect([...m.championDays].sort()).toEqual(['2026-07-28', '2026-07-29'])
    // Seen-latch, not a claim — but it unions for the same reason: a second device should not
    // re-show yesterday's result just because it happens to be further along.
    expect([...m.raceRecapDays].sort()).toEqual(['2026-07-26', '2026-07-27'])
    expect(m.referralWelcomeClaimed).toBe(true)
    expect(m.finaleSeen).toBe(true)
  })

  it('is symmetric — argument order never decides which latches survive', () => {
    const a = save({ unlocked: 10, hazardIntros: ['lock'], occasionsSeen: ['2026-02-14'] })
    const b = save({ unlocked: 99, hazardIntros: ['coat'] })
    const ab = mergeSaves(a, b)
    const ba = mergeSaves(b, a)
    expect([...ab.hazardIntros].sort()).toEqual([...ba.hazardIntros].sort())
    expect(ab.occasionsSeen).toEqual(ba.occasionsSeen)
    expect(ab.occasionsSeen).toEqual(['2026-02-14'])
  })

  it('still never blends a MAGNITUDE — only the latches cross records', () => {
    const local = save({ unlocked: 50, chips: 0, best: 10 })
    const cloud = save({ unlocked: 40, chips: 999, best: 99999 })
    const m = mergeSaves(local, cloud)
    expect({ chips: m.chips, best: m.best }).toEqual({ chips: 0, best: 10 })
  })
})

/**
 * The DAILY BESTS map joins the latches, per key. It has to, now that a week's standing is the SUM of
 * its days: play Tuesday on the phone and Wednesday on the tablet, and a winner-takes-all merge would
 * discard one of them and silently halve the week. Each (player, day) best only ever rises, so a
 * per-key max can no more lose a score than unioning a latch can un-see a teach card — and no two
 * numbers are ever blended, which is the rule the merge actually guarantees.
 */
describe('mergeSaves — daily bests survive per day', () => {
  it('keeps the better run for each day, from whichever save had it', () => {
    const local = save({ unlocked: 10, endlessDays: { '2026-07-28': 5000, '2026-07-29': 1200 } })
    const cloud = save({ unlocked: 99, endlessDays: { '2026-07-29': 4400, '2026-07-30': 3100 } })
    const m = mergeSaves(local, cloud)
    expect(m.unlocked).toBe(99) // progress still comes from the winner, whole
    expect(m.endlessDays).toEqual({ '2026-07-28': 5000, '2026-07-29': 4400, '2026-07-30': 3100 })
  })

  it('never lowers a day — a further-progressed save with a worse run cannot clobber it', () => {
    const local = save({ unlocked: 10, endlessDays: { '2026-07-29': 9000 } })
    const cloud = save({ unlocked: 99, endlessDays: { '2026-07-29': 100 } })
    expect(mergeSaves(local, cloud).endlessDays['2026-07-29']).toBe(9000)
  })

  it('is symmetric — argument order never decides which day survives', () => {
    const a = save({ unlocked: 10, endlessDays: { '2026-07-28': 5000, '2026-07-29': 1200 } })
    const b = save({ unlocked: 99, endlessDays: { '2026-07-29': 4400 } })
    expect(mergeSaves(a, b).endlessDays).toEqual(mergeSaves(b, a).endlessDays)
  })

  it('tolerates a save with no map at all', () => {
    const bare = { unlocked: 5 } as unknown as SaveData
    expect(() => mergeSaves(bare, save({ endlessDays: { '2026-07-29': 10 } }))).not.toThrow()
    expect(mergeSaves(bare, save({ endlessDays: { '2026-07-29': 10 } })).endlessDays).toEqual({ '2026-07-29': 10 })
  })
})

/**
 * The RACE NAME — the third merge rule, and the one a player notices fastest, because getting it wrong
 * republishes a name they deliberately changed. It follows neither of the other rules: not the winner's
 * record (a name is not a magnitude) and not a union (a name changes, and can be cleared), so recency
 * decides. See `pickHandle` in merge.ts.
 */
describe('mergeSaves — the race name', () => {
  it('restores a name from the cloud onto a device that has none — the cleared-browser case', () => {
    // THE case behind "I have to set my name again every day": storage was cleared, so this device has
    // no name and no stamp. The cloud has both. If the local null won, the boards would fall straight
    // back to the anonymous default and the player would have to re-enter the name — again.
    const wiped = coerceSave({})
    const cloud = save({ handle: 'neonghost', handleSetAt: 1_700_000_000_000 })
    expect(mergeSaves(wiped, cloud).handle).toBe('neonghost')
  })

  it('keeps the most RECENT rename, even when the other device is further progressed', () => {
    // Renaming on the phone must survive opening a tablet that happens to be deeper into the campaign.
    const renamedOnPhone = save({ unlocked: 5, handle: 'phantom', handleSetAt: 2_000 })
    const staleTablet = save({ unlocked: 90, handle: 'neonghost', handleSetAt: 1_000 })
    expect(mergeSaves(renamedOnPhone, staleTablet).handle).toBe('phantom')
    expect(mergeSaves(staleTablet, renamedOnPhone).handle).toBe('phantom')
  })

  it('propagates a CLEARED name, rather than resurrecting the old one', () => {
    // Clearing is a rename to nothing, and it is stamped like any other, so it must win on recency.
    const cleared = save({ handle: null, handleSetAt: 3_000 })
    const cloud = save({ handle: 'neonghost', handleSetAt: 1_000 })
    expect(mergeSaves(cleared, cloud).handle).toBeNull()
  })

  it('carries the stamp with the name, so the next merge still compares recency', () => {
    const local = coerceSave({})
    const cloud = save({ handle: 'neonghost', handleSetAt: 1_700_000_000_000 })
    expect(mergeSaves(local, cloud).handleSetAt).toBe(1_700_000_000_000)
  })

  it('prefers LOCAL on equal stamps, matching the progress tie rule', () => {
    const local = save({ handle: 'local', handleSetAt: 5_000 })
    const cloud = save({ handle: 'cloud', handleSetAt: 5_000 })
    expect(mergeSaves(local, cloud).handle).toBe('local')
  })
})

describe('mergeSaves — chapter trophies and the race-unlock latch', () => {
  it('unions chapterRewards across both saves, whichever side wins the progress compare', () => {
    // Trophy claims are claim latches like championWeeks: losing one to a merge would re-pay a purse
    // on the next Home visit, and would blank an earned plinth in the showroom until then.
    const phone = save({ unlocked: 45, chapterRewards: [1, 2, 4] })
    const tablet = save({ unlocked: 31, chapterRewards: [2, 3] })
    expect(mergeSaves(phone, tablet).chapterRewards).toEqual([1, 2, 3, 4])
    expect(mergeSaves(tablet, phone).chapterRewards).toEqual([1, 2, 3, 4])
  })

  it('a further-progressed save without trophies cannot blank the other showroom', () => {
    const freshButDeep = save({ unlocked: 200 })
    const trophied = save({ unlocked: 41, chapterRewards: [1, 2, 3, 4] })
    expect(mergeSaves(freshButDeep, trophied).chapterRewards).toEqual([1, 2, 3, 4])
  })

  it('seenRaceUnlock survives losing the progress compare (regression: it was missing from the union)', () => {
    // raceunlockcard.ts has always documented this latch as cloud-synced, but it shipped without a
    // union rule — so a device that had seen the card, merged against a further-progressed one that
    // had not, replayed the one-time reveal. The union is the fix; this pins it.
    const seen = save({ unlocked: 12, seenRaceUnlock: true })
    const deeperUnseen = save({ unlocked: 80, seenRaceUnlock: false })
    expect(mergeSaves(seen, deeperUnseen).seenRaceUnlock).toBe(true)
    expect(mergeSaves(deeperUnseen, seen).seenRaceUnlock).toBe(true)
  })

  it('seenSlotsIntro joins the union — the FREE SPIN reveal plays exactly once per player', () => {
    // Added WITH the field rather than after the bug, like the Act II latches below. The reveal is
    // the fix for a measured discovery failure (24 of 73 players had ever opened the cabinet), so a
    // merge that replayed it would be re-teaching the one thing this card exists to teach once.
    const seen = save({ unlocked: 6, seenSlotsIntro: true })
    const deeperUnseen = save({ unlocked: 90, seenSlotsIntro: false })
    expect(mergeSaves(seen, deeperUnseen).seenSlotsIntro).toBe(true)
    expect(mergeSaves(deeperUnseen, seen).seenSlotsIntro).toBe(true)
  })

  it('lightningBest merges by MAX, not by riding the progress winner', () => {
    // The one RECORD in the union list. A further-along device with a worse storm run must not erase
    // a real personal best — a best that can go down is the one thing a best may never do.
    const goodRun = save({ unlocked: 8, lightningBest: 14 })
    const deeperWorse = save({ unlocked: 200, lightningBest: 3 })
    expect(mergeSaves(goodRun, deeperWorse).lightningBest).toBe(14)
    expect(mergeSaves(deeperWorse, goodRun).lightningBest).toBe(14)
  })

  it('seenLightningUnlock joins the union — the storm reveal plays exactly once', () => {
    const seen = save({ unlocked: 6, seenLightningUnlock: true })
    const deeperUnseen = save({ unlocked: 120, seenLightningUnlock: false })
    expect(mergeSaves(seen, deeperUnseen).seenLightningUnlock).toBe(true)
    expect(mergeSaves(deeperUnseen, seen).seenLightningUnlock).toBe(true)
  })

  it('the Act II latches join the union — the elevator and each floor door play exactly once', () => {
    // seenRaceUnlock's twins, added WITH the fields rather than after the bug (see the note above).
    // The elevator reveal is chained off a once-in-a-lifetime ceremony; replaying it because the
    // player opened a tablet would be the same defect one act up, and more visible.
    const seen = save({ unlocked: 305, seenAct2Reveal: true, floorIntros: ['1'] })
    const deeperUnseen = save({ unlocked: 360, seenAct2Reveal: false, floorIntros: ['2'] })
    for (const merged of [mergeSaves(seen, deeperUnseen), mergeSaves(deeperUnseen, seen)]) {
      expect(merged.seenAct2Reveal).toBe(true)
      expect(merged.floorIntros.slice().sort()).toEqual(['1', '2'])
    }
  })

  it('seenPushOffer joins the union — the race-reminder card is offered once per PLAYER, not per device', () => {
    // A push subscription belongs to a browser install, so the phone and the tablet each need their
    // own — but "do you want to be reminded" is a question about the person, and someone who already
    // said no on the phone should not be asked again by the tablet. Settings → Race reminder is
    // still there per device for whoever wants it on the second one.
    const asked = save({ unlocked: 14, seenPushOffer: true })
    const deeperUnasked = save({ unlocked: 90, seenPushOffer: false })
    expect(mergeSaves(asked, deeperUnasked).seenPushOffer).toBe(true)
    expect(mergeSaves(deeperUnasked, asked).seenPushOffer).toBe(true)
  })

  it('installRewardClaimed joins the union — the install purse can never be paid twice', () => {
    // A CLAIM latch, not a "seen" one: losing it to a progress-winner merge re-pays 150 chips AND a
    // Jackpot Chip, which is the double-award championWeeks sits in this list to prevent. Installing
    // on a phone and then a tablet pays once — the reward buys the first install, not each one.
    const paid = save({ unlocked: 12, installRewardClaimed: true })
    const deeperUnpaid = save({ unlocked: 88, installRewardClaimed: false })
    expect(mergeSaves(paid, deeperUnpaid).installRewardClaimed).toBe(true)
    expect(mergeSaves(deeperUnpaid, paid).installRewardClaimed).toBe(true)
  })

  it('an older save with no seenPushOffer field coerces to "not yet asked", never to "asked"', () => {
    // The field is absent from every save written before 2026-08-06. Coercing the wrong way would
    // silently exclude the entire existing racer cohort — the players with the most reason to want
    // the reminder — from ever being offered it.
    expect(coerceSave({ unlocked: 40 }).seenPushOffer).toBe(false)
  })
})

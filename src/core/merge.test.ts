import { describe, expect, it } from 'vitest'
import { mergeSaves } from './merge'
import { coerceSave, type SaveData } from './save'

/**
 * mergeSaves is the heart of "never lose Maya's progress": when the local and cloud saves disagree, it
 * must keep the FURTHEST-progressed one — compared lexicographically by [unlocked, best, totalStars,
 * chips] — and return it as a WHOLE record (never a field-wise blend). Callers pass LOCAL first, so a
 * dead tie must keep local (an identical cloud can never clobber it). These tests pin exactly that,
 * because a bug here is the one thing that could actually lose her progress.
 */

// Build a valid, full v7 SaveData from a partial via the REAL coercion path, so fixtures can never drift
// from the actual on-disk save shape.
const save = (partial: Partial<SaveData>): SaveData => coerceSave(partial)

describe('mergeSaves — furthest-progressed wins', () => {
  it('keeps the higher unlocked level (the primary metric), regardless of argument order', () => {
    const local = save({ unlocked: 40 })
    const remote = save({ unlocked: 50 })
    expect(mergeSaves(local, remote)).toBe(remote)
    expect(mergeSaves(remote, local)).toBe(remote)
  })

  it('a fresh device does NOT overwrite real cloud progress — it adopts the cloud save', () => {
    // THE critical case. A new phone signs in with an empty local save while the cloud holds Maya's real
    // progress. merge(local=fresh, remote=real) MUST return the cloud save so the next push mirrors HER
    // progress back — not the empty default. If this ever returned `local`, a reinstall would wipe her.
    const freshLocal = coerceSave({}) // brand-new device: unlocked 1, best 0
    const cloud = save({ unlocked: 47, best: 9000, stars: { 1: 3, 2: 3 }, chips: 120 })
    expect(mergeSaves(freshLocal, cloud)).toBe(cloud)
  })

  it('on a dead tie, keeps LOCAL (the first arg) so an identical cloud never clobbers it', () => {
    const local = save({ unlocked: 30, best: 500, stars: { 1: 3 }, chips: 10 })
    const remoteEqual = save({ unlocked: 30, best: 500, stars: { 1: 3 }, chips: 10 })
    expect(mergeSaves(local, remoteEqual)).toBe(local)
  })

  it('breaks ties by best, then total stars, then chips — in that order', () => {
    // unlocked equal → higher best wins
    const bestLo = save({ unlocked: 10, best: 100 })
    const bestHi = save({ unlocked: 10, best: 200 })
    expect(mergeSaves(bestLo, bestHi)).toBe(bestHi)

    // unlocked + best equal → more total stars wins (1 star vs 6)
    const starsLo = save({ unlocked: 10, best: 100, stars: { 1: 1 } })
    const starsHi = save({ unlocked: 10, best: 100, stars: { 1: 3, 2: 3 } })
    expect(mergeSaves(starsLo, starsHi)).toBe(starsHi)

    // unlocked + best + stars equal → more chips wins
    const chipsLo = save({ unlocked: 10, best: 100, stars: { 1: 3 }, chips: 10 })
    const chipsHi = save({ unlocked: 10, best: 100, stars: { 1: 3 }, chips: 20 })
    expect(mergeSaves(chipsLo, chipsHi)).toBe(chipsHi)
  })

  it('lets unlocked dominate: a higher level wins even against a far higher best score', () => {
    const further = save({ unlocked: 50, best: 0 })
    const higherScore = save({ unlocked: 40, best: 99999 })
    expect(mergeSaves(further, higherScore)).toBe(further)
    expect(mergeSaves(higherScore, further)).toBe(further)
  })

  it('returns a WHOLE record, never a field-wise blend (documents the known single-player tradeoff)', () => {
    // local is further (unlocked 50) but has spent its chips; cloud is behind (unlocked 40) but chip-rich.
    // "Furthest-progressed wins" keeps local ENTIRE — so local's 0 chips stay; cloud's 999 are NOT grafted
    // in. This is intentional (see merge.ts): the merge never Frankensteins fields across two saves.
    const local = save({ unlocked: 50, chips: 0 })
    const cloud = save({ unlocked: 40, chips: 999 })
    const winner = mergeSaves(local, cloud)
    expect(winner).toBe(local)
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
    expect(mergeSaves(a, b)).toBe(a) // 5 > 3
  })

  it('treats a fully empty/default save as the lowest progress', () => {
    const empty = coerceSave({})
    const some = save({ unlocked: 2 })
    expect(mergeSaves(empty, some)).toBe(some)
    expect(mergeSaves(some, empty)).toBe(some)
  })
})

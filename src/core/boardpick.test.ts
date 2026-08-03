import { describe, expect, it } from 'vitest'
import { BAND_LO, BAND_HI, endlessBoardRng, pickOffset, pickedKey } from './boardpick'
import { SALT_ACTIVE_FROM, endlessRngForDay, seedForKey } from './endless'
import { mulberry32 } from './rng'
import { percentile, playEndless } from './sim'

/**
 * Guards on board normalisation.
 *
 * ── ⚠️ THE GOLDEN TEST BELOW IS NOT BRITTLE — READ BEFORE RE-RECORDING ─────────────────────────
 * `chooses the same boards it chose when this shipped` pins the offsets the search picks for a set
 * of known days. Those offsets depend on `playEndless`, and therefore on Board mechanics, the
 * scoring rule and the Plinko trigger. If you changed any of those and this test fails, it is
 * telling you THE RACE BOARDS MOVED — not that the numbers need updating.
 *
 * That matters because two client versions disagreeing about the board is exactly the failure the
 * salt exists to prevent, except sourced from our own release instead of a stale cache. Half the
 * players on the new build and half on the old would race different layouts under one leaderboard,
 * and it would look like ordinary results the whole time.
 *
 * If the move is intended, ship it the way the salt shipped: behind a NEW activation date, so the
 * handover happens at a day boundary for everyone at once. Then re-record these.
 */

const DAYS = ['2026-08-04', '2026-08-05', '2026-08-09', '2026-08-17', '2026-09-01', '2026-12-25']

describe('board normalisation', () => {
  it('is dormant before the activation date', () => {
    // Shares the salt's date so there is ONE board handover, not two.
    const before = '2026-08-03'
    expect(pickedKey(before, before)).toBe(before)
    // …and the composed RNG is byte-identical to the original for such a day.
    const a = endlessBoardRng(before)
    const b = endlessRngForDay(before)
    expect(Array.from({ length: 8 }, () => a())).toEqual(Array.from({ length: 8 }, () => b()))
  })

  it('lands every day inside the band once active', () => {
    for (const day of DAYS) {
      const n = pickOffset(day)
      const key = n === 0 ? day : `${day}#${n}`
      const q = playEndless(seedForKey(key), 'greedy', mulberry32(0x1234)).score
      expect(q).toBeGreaterThanOrEqual(BAND_LO)
      expect(q).toBeLessThanOrEqual(BAND_HI)
    }
  })

  it('chooses the same boards it chose when this shipped — see the header', () => {
    // GOLDEN. A failure here means the boards moved. Do not re-record without reading the header.
    expect(DAYS.map(pickOffset)).toEqual([0, 2, 2, 2, 1, 2])
  })

  it('collapses the spread that made some days worth more than others', { timeout: 600000 }, () => {
    // The measurement this whole module exists for. Raw boards over 60 days spanned 6.1x
    // (2,940 … 18,060); normalised they must sit inside the band, so at most BAND_HI/BAND_LO = 2x.
    const raw: number[] = []
    const norm: number[] = []
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.UTC(2026, 7, 4 + i)).toISOString().slice(0, 10)
      raw.push(playEndless(seedForKey(day), 'greedy', mulberry32(0x1234)).score)
      norm.push(playEndless(seedForKey(pickedKey(day, day)), 'greedy', mulberry32(0x1234)).score)
    }
    const rs = [...raw].sort((a, b) => a - b)
    const ns = [...norm].sort((a, b) => a - b)
    const rawSpread = rs[rs.length - 1] / rs[0]
    const normSpread = ns[ns.length - 1] / ns[0]
    console.log(
      `\nBOARD SPREAD ACROSS 40 DAYS\n` +
        `  raw        min ${rs[0].toLocaleString()} · p50 ${percentile(rs, 0.5).toLocaleString()} · max ${rs[rs.length - 1].toLocaleString()}   ${rawSpread.toFixed(1)}x\n` +
        `  normalised min ${ns[0].toLocaleString()} · p50 ${percentile(ns, 0.5).toLocaleString()} · max ${ns[ns.length - 1].toLocaleString()}   ${normSpread.toFixed(1)}x\n`
    )
    expect(normSpread).toBeLessThanOrEqual(BAND_HI / BAND_LO)
    expect(normSpread).toBeLessThan(rawSpread)
  })

  it('only ever picks boards the original generator could have dealt', () => {
    // It is a SEARCH, not a redesign: the chosen key is always a plain key fed to the same hash.
    for (const day of DAYS) {
      const key = pickedKey(day, day)
      expect(key === day || key.startsWith(`${day}#`)).toBe(true)
    }
  })

  it('is a pure function — the same board for everyone', () => {
    for (const day of DAYS) expect(pickOffset(day)).toBe(pickOffset(day))
    const salted = `${SALT_ACTIVE_FROM}:a-server-salt`
    expect(pickedKey(salted, SALT_ACTIVE_FROM)).toBe(pickedKey(salted, SALT_ACTIVE_FROM))
  })

  it('salts first, then normalises — a different salt is a different board', () => {
    const day = '2026-08-20'
    const a = endlessBoardRng(day, 'salt-a')
    const b = endlessBoardRng(day, 'salt-b')
    expect(Array.from({ length: 8 }, () => a())).not.toEqual(Array.from({ length: 8 }, () => b()))
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coerceSave, loadSave, persistSave, type SaveData } from './save'

/**
 * `claimInstallReward` grants real currency, so these are the double-pay tests. Under the economy's
 * iron rule 4 (award-first, latch in the save) the failure that matters is not "the card didn't
 * show" — it is a purse paid twice, or a latch set without the purse.
 *
 * Node environment (vitest.config.ts): `window` and `localStorage` do not exist here, so both are
 * stubbed. That is also the honest default for the standalone check — no `window` must read as "not
 * installed", never as a throw.
 */

interface World {
  /** display-mode: standalone matches, i.e. running from the home screen. */
  standalone?: boolean
  /** iOS Safari's non-standard navigator.standalone — the ONLY signal on iOS. */
  iosStandalone?: boolean
  /** Makes matchMedia throw, to pin the never-throws contract. */
  matchMediaThrows?: boolean
}

const setGlobal = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function stubStorage(): void {
  const store = new Map<string, string>()
  setGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
}

function stubWorld(w: World): void {
  setGlobal('window', {
    matchMedia: w.matchMediaThrows
      ? () => {
          throw new Error('nope')
        }
      : () => ({ matches: w.standalone === true }),
    navigator: { standalone: w.iosStandalone },
  })
  setGlobal('navigator', { standalone: w.iosStandalone, userAgent: 'test', maxTouchPoints: 0 })
}

/** Seeds the save, re-imports against the stubbed world, and claims. */
async function claim(w: World, save: Partial<SaveData> = {}) {
  stubStorage()
  stubWorld(w)
  vi.resetModules()
  const { persistSave: persist } = await import('./save')
  persist(coerceSave(save))
  const mod = await import('./install')
  return { reward: mod.claimInstallReward(), mod }
}

beforeEach(() => {
  stubStorage()
})

afterEach(() => {
  vi.resetModules()
})

describe('claimInstallReward — a one-time purse that must never pay twice', () => {
  it('pays chips and a Jackpot Chip on the first launch of the installed app', async () => {
    const { reward, mod } = await claim({ standalone: true }, { chips: 500 })
    expect(reward).not.toBeNull()
    expect(reward?.chips).toBe(mod.INSTALL_REWARD_CHIPS)
    expect(reward?.boost).toBe('jackpot')
    expect(reward?.balance).toBe(500 + mod.INSTALL_REWARD_CHIPS)
    const after = loadSave()
    expect(after.installRewardClaimed).toBe(true)
    expect(after.chips).toBe(500 + mod.INSTALL_REWARD_CHIPS)
    expect(after.pendingBoosts).toContain('jackpot')
  })

  it('pays exactly once, however many times it is called', async () => {
    // The claim latch is the ONLY thing standing between this and an unbounded faucet: every Home
    // entry calls it, so a latch that failed to stick would pay on every single app open.
    const { reward, mod } = await claim({ standalone: true }, { chips: 0 })
    expect(reward?.chips).toBe(mod.INSTALL_REWARD_CHIPS)
    expect(mod.claimInstallReward()).toBeNull()
    expect(mod.claimInstallReward()).toBeNull()
    expect(loadSave().chips).toBe(mod.INSTALL_REWARD_CHIPS)
    expect(loadSave().pendingBoosts.filter(b => b === 'jackpot')).toHaveLength(1)
  })

  it('refuses in a browser tab — the reward is for installing, not for playing', async () => {
    const { reward } = await claim({ standalone: false }, { chips: 100 })
    expect(reward).toBeNull()
    const after = loadSave()
    expect(after.chips).toBe(100)
    expect(after.installRewardClaimed).toBe(false)
    expect(after.pendingBoosts).toHaveLength(0)
  })

  it('honours iOS’s navigator.standalone, the only install signal Apple exposes', async () => {
    // display-mode is unreliable on iOS; without this branch every iPhone install goes unpaid, on
    // the one platform where installing is hardest and is the sole route to a web push.
    const { reward } = await claim({ standalone: false, iosStandalone: true })
    expect(reward).not.toBeNull()
  })

  it('never pays a save that already carries the latch, even standalone', async () => {
    const { reward } = await claim({ standalone: true }, { chips: 700, installRewardClaimed: true })
    expect(reward).toBeNull()
    expect(loadSave().chips).toBe(700)
  })

  it('returns null rather than throwing when the platform checks blow up', async () => {
    // House contract shared with cloud/analytics/push: never throw into the game. This runs inside
    // Home's celebration queue, so a throw would take every card after it down too.
    const { reward } = await claim({ matchMediaThrows: true })
    expect(reward).toBeNull()
  })

  it('leaves the save byte-identical when it refuses', async () => {
    stubStorage()
    stubWorld({ standalone: false })
    vi.resetModules()
    const seeded = coerceSave({ chips: 250, unlocked: 30, pendingBoosts: ['wildReel'] })
    persistSave(seeded)
    const before = JSON.stringify(loadSave())
    const { claimInstallReward } = await import('./install')
    expect(claimInstallReward()).toBeNull()
    expect(JSON.stringify(loadSave())).toBe(before)
  })
})

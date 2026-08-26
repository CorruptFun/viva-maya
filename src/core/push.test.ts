import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// ⚠️ These two are the PURE half of the module — a constant and a function of the save, with no
// browser API and no env behind either. Importing them statically is therefore safe despite the
// fresh-import dance below: the world-dependent exports are still re-imported per case, and pinning
// the threshold to the exported constant is the point (a test carrying its own 5 would go green
// against a retune that moved the real one).
import { PUSH_OFFER_LEVEL_WINS, pushOfferFlavour } from './push'
import { coerceSave, type SaveData } from './save'

/**
 * `pushOfferDue` decides whether to put the push opt-in card in front of a player — and the card's
 * gold button fires `Notification.requestPermission()`, which every browser grants EXACTLY ONCE per
 * install. A denial is permanent: the browser never asks again and the player has to go into site
 * settings to undo it. So the interesting assertions here are all NEGATIVE. A gate that opens too
 * eagerly does not cause a visual bug, it permanently destroys the feature for that player.
 *
 * There are TWO qualifying moments — a first race, or `PUSH_OFFER_LEVEL_WINS` cleared levels — and
 * they share one latch, so a player meets one card, once, ever. `pushOfferFlavour` decides which of
 * the two sets of words that card wears; it is pinned at the bottom of this file because the copy
 * has to describe the notification that audience would actually receive, and the whole reason the
 * decision lives in core rather than in the card is so it can be checked here.
 *
 * The module reads its config out of `import.meta.env` into consts AT IMPORT TIME, and reads the
 * browser APIs off globals, so every case stubs the world and then imports `./push` fresh. Node
 * environment (vitest.config.ts) — there is no DOM here, which is also the honest default: absent
 * globals must read as 'unsupported', not throw.
 */

type Sub = { endpoint: string } | null

interface World {
  /** Omit to simulate a build with no VAPID key / no Supabase — the dormant contract. */
  configured?: boolean
  hasPushManager?: boolean
  hasServiceWorker?: boolean
  permission?: NotificationPermission
  /** What `getSubscription()` resolves to — a value here means "already subscribed on this device". */
  subscription?: Sub
  /** Makes `getSubscription()` reject, to pin the never-throws contract. */
  subscriptionThrows?: boolean
  userAgent?: string
  maxTouchPoints?: number
  standalone?: boolean
}

const setGlobal = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

function stubWorld(w: World): void {
  const configured = w.configured ?? true
  vi.stubEnv('VITE_SUPABASE_URL', configured ? 'https://example.supabase.co' : '')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', configured ? 'anon-key' : '')
  vi.stubEnv('VITE_VAPID_PUBLIC_KEY', configured ? 'vapid-key' : '')

  const pushManager = {
    getSubscription: w.subscriptionThrows
      ? (): Promise<Sub> => Promise.reject(new Error('nope'))
      : (): Promise<Sub> => Promise.resolve(w.subscription ?? null),
  }

  setGlobal('window', {
    ...(w.hasPushManager ?? true ? { PushManager: function PushManager() {} } : {}),
    matchMedia: () => ({ matches: w.standalone === true }),
  })
  setGlobal('navigator', {
    ...(w.hasServiceWorker ?? true ? { serviceWorker: { getRegistration: () => Promise.resolve({ pushManager }) } } : {}),
    userAgent: w.userAgent ?? 'Mozilla/5.0 (Linux; Android 14) Chrome/126',
    maxTouchPoints: w.maxTouchPoints ?? 0,
    standalone: w.standalone,
  })
  setGlobal('Notification', { permission: w.permission ?? 'default' })
}

/** Re-imports the module against the world just stubbed (its env consts are import-time). */
async function due(w: World, save: Partial<SaveData>): Promise<boolean> {
  stubWorld(w)
  vi.resetModules()
  const { pushOfferDue } = await import('./push')
  return pushOfferDue(coerceSave(save))
}

/** A player who has raced today and has never been asked — the first shape that should say yes. */
const RACED: Partial<SaveData> = { unlocked: 14, endlessDays: { '2026-08-06': 9120 } }

/**
 * `stars` for `n` distinct cleared levels. `recordResult` (core/save.ts) is its only writer and
 * `GameScene.finishWin` its only caller, so one key is one level WON — which is what makes counting
 * keys a win count rather than a proxy for "levels attempted".
 */
const wins = (n: number): Record<number, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [i + 1, 3]))

/** The second shape: a pure level player, at the threshold, who has never opened the race. */
const LEVELER: Partial<SaveData> = {
  unlocked: PUSH_OFFER_LEVEL_WINS + 1,
  stars: wins(PUSH_OFFER_LEVEL_WINS),
}

beforeEach(() => {
  vi.unstubAllEnvs()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('pushOfferDue — the gate on a one-shot, irreversible permission ask', () => {
  it('offers to a player who has raced, on a browser that can actually subscribe', () => {
    return expect(due({}, RACED)).resolves.toBe(true)
  })

  it('never offers twice — the latch is the whole contract', async () => {
    await expect(due({}, { ...RACED, seenPushOffer: true })).resolves.toBe(false)
  })

  it('never offers to a player with neither a race nor the level wins behind them', async () => {
    // `endlessDays` is `{}` until recordEndless writes the first run, which is what makes it the
    // "has raced" signal. Asked with nothing behind it, either card is a notification about an
    // abstraction — the race one about a board they have not played, the morning one about a gift
    // and a jackpot wheel they have not met.
    await expect(due({}, { unlocked: 14 })).resolves.toBe(false)
    await expect(due({}, { unlocked: 14, endlessDays: {} })).resolves.toBe(false)
  })

  it('offers to a pure level player at the threshold — the audience the morning nudge is aimed at', async () => {
    // The reach fix. The ladder is most of the game and a player can live on it for weeks without
    // ever opening the race, so before this the entire level-only audience could reach notifications
    // only by going looking in Settings for a feature nothing had ever mentioned.
    await expect(due({}, LEVELER)).resolves.toBe(true)
  })

  it('does not offer one win short of the threshold', async () => {
    await expect(
      due({}, { unlocked: PUSH_OFFER_LEVEL_WINS, stars: wins(PUSH_OFFER_LEVEL_WINS - 1) })
    ).resolves.toBe(false)
  })

  it('counts WINS, not the unlock frontier — a save with no clears on it is not a level player', async () => {
    // `unlocked` advances on a win too, and reaching for it here is the obvious shortcut. It is
    // wrong twice over: it starts at 1 (so the threshold would mean a different number of wins) and
    // it is the level you may play NEXT, which a merge or a boosted start can move without a clear.
    await expect(due({}, { unlocked: 40, stars: {} })).resolves.toBe(false)
  })

  it('spends ONE latch across both moments — a leveler who was already asked is refused', async () => {
    // The two qualifying moments are two doors to the same single ask, never two asks. A player who
    // answered the race card and later stops racing must not be asked again by the other door.
    await expect(due({}, { ...LEVELER, seenPushOffer: true })).resolves.toBe(false)
  })

  it('still refuses every capability case for a leveler, however many levels have been won', async () => {
    // Widening WHO is offered must not widen WHEN the browser prompt can be reached. Each of these
    // is a case where the card would burn the one-shot ask for nothing, and stars do not change
    // that — an iPhone in a Safari tab still cannot subscribe at 500 wins.
    const iphone: World = {
      hasPushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari',
      standalone: false,
    }
    await expect(due(iphone, LEVELER)).resolves.toBe(false)
    await expect(due({ permission: 'denied' }, LEVELER)).resolves.toBe(false)
    await expect(
      due({ permission: 'granted', subscription: { endpoint: 'https://push.example/abc' } }, LEVELER)
    ).resolves.toBe(false)
    await expect(due({ configured: false }, LEVELER)).resolves.toBe(false)
  })

  it('never offers on an iPhone outside an installed PWA, where subscribing cannot work', async () => {
    // Apple ships Web Push only in a home-screen install. Spending the latch to say so would mean
    // never offering it on the device they go on to install to — that case is the install nudge's.
    const iphone: World = {
      hasPushManager: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari',
      standalone: false,
    }
    await expect(due(iphone, RACED)).resolves.toBe(false)
    // ...and the same iPhone, once installed, IS offered — this is the half that makes the skip a
    // deferral rather than a silent permanent exclusion.
    await expect(due({ ...iphone, hasPushManager: true, standalone: true }, RACED)).resolves.toBe(true)
  })

  it('never offers when the browser has already refused — no button here can undo that', async () => {
    await expect(due({ permission: 'denied' }, RACED)).resolves.toBe(false)
  })

  it('never offers when this device is already subscribed', async () => {
    await expect(
      due({ permission: 'granted', subscription: { endpoint: 'https://push.example/abc' } }, RACED)
    ).resolves.toBe(false)
  })

  it('offers when permission was granted but the subscription is gone (a cleared site, a new SW)', async () => {
    // 'granted' alone is not "it's on": the row and the local subscription can both disappear while
    // the permission survives. Re-offering here costs nothing — the browser will not re-prompt.
    await expect(due({ permission: 'granted', subscription: null }, RACED)).resolves.toBe(true)
  })

  it('stays silent on an unconfigured build and on a browser with no service worker', async () => {
    await expect(due({ configured: false }, RACED)).resolves.toBe(false)
    await expect(due({ hasServiceWorker: false }, RACED)).resolves.toBe(false)
  })

  it('resolves rather than rejecting when the subscription lookup blows up', async () => {
    // Never-throws, same contract as the rest of the module — this runs inside Home's celebration
    // queue and a rejection there would take the rest of the queue down with it.
    //
    // It answers TRUE, and that is the right answer rather than a leak: this path is only reachable
    // with permission already 'granted', so the card's button cannot trigger a fresh prompt and
    // there is no irreversible ask left to protect. Re-offering an unsubscribed-but-permitted device
    // is exactly what repairs it. (`permission: 'default'` never reaches the lookup at all —
    // isPushEnabled short-circuits, which is why this case has to be set up granted.)
    await expect(due({ permission: 'granted', subscriptionThrows: true }, RACED)).resolves.toBe(true)
  })
})

/**
 * The card is spent once per install, so whichever variant a player meets is the only one they will
 * ever see — which makes "which words" a correctness question, not a styling one. A pure level
 * player shown NEVER MISS A BOARD is being sold a mode they have never opened, and would then
 * receive the morning `daily_play` nudge instead: a promise that does not match the delivery, on the
 * one permission a player cannot hand back twice.
 */
describe('pushOfferFlavour — which of the two promises the card is allowed to make', () => {
  it('promises the race to somebody who has raced', () => {
    expect(pushOfferFlavour(coerceSave(RACED))).toBe('race')
  })

  it('promises the morning nudge to a level player who has never raced', () => {
    expect(pushOfferFlavour(coerceSave(LEVELER))).toBe('daily')
  })

  it('lets the race win a tie — it is the board they have direct evidence of', () => {
    expect(pushOfferFlavour(coerceSave({ ...RACED, ...LEVELER, endlessDays: RACED.endlessDays }))).toBe('race')
  })

  it('answers race for a save that qualifies for neither, rather than having no answer', () => {
    // `?pushoffer` (DEV) opens the card straight past the gate on any save at all, so this function
    // has to be total. The historical variant is the safe default.
    expect(pushOfferFlavour(coerceSave({}))).toBe('race')
    expect(pushOfferFlavour(coerceSave({ unlocked: 3, stars: wins(PUSH_OFFER_LEVEL_WINS - 1) }))).toBe('race')
  })
})

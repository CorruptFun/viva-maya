import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coerceSave, type SaveData } from './save'

/**
 * `pushOfferDue` decides whether to put the RACE REMINDER card in front of a player — and the card's
 * gold button fires `Notification.requestPermission()`, which every browser grants EXACTLY ONCE per
 * install. A denial is permanent: the browser never asks again and the player has to go into site
 * settings to undo it. So the interesting assertions here are all NEGATIVE. A gate that opens too
 * eagerly does not cause a visual bug, it permanently destroys the feature for that player.
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

/** A player who has raced today and has never been asked — the one shape that should say yes. */
const RACED: Partial<SaveData> = { unlocked: 14, endlessDays: { '2026-08-06': 9120 } }

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

  it('never offers before the first race — the card is about a board they have not played', async () => {
    // `endlessDays` is `{}` until recordEndless writes the first run, which is what makes it the
    // "has raced" signal. Asked earlier, the reminder is a notification about an abstraction.
    await expect(due({}, { unlocked: 14 })).resolves.toBe(false)
    await expect(due({}, { unlocked: 14, endlessDays: {} })).resolves.toBe(false)
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

# The client event pipe

The contract, then the load-bearing implementation details. A full working reference lives in the
Viva Maya repo at `src/core/analytics.ts` (+ `src/core/analytics.test.ts`) if you have it available
— but everything needed to rebuild it is here.

## Contract (non-negotiable)

1. **Dormant until configured.** No env config (`VITE_SUPABASE_URL`/`_ANON_KEY` or equivalent) →
   every export no-ops. Analytics must never be a reason the app behaves differently.
2. **Never throws into the app.** Every entry point wrapped. Losing a metric is free; breaking a
   feature is not.
3. **Fire and forget.** `track(name, props)` returns void synchronously, does zero network work on
   the caller's frame — it appends to an in-memory queue.

## Structure

```ts
// Canonical vocabulary — THE one source event names come from. Dashboards and funnels import
// this, so a rename breaks at compile time instead of silently flatlining a chart.
export const EVENTS = { APP_OPEN: 'app_open', /* … the product's moments … */
                        CLIENT_ERROR: 'client_error' } as const

interface QueuedEvent {
  device_id: string    // random UUID from localStorage (mint on first run; NOT a fingerprint)
  session_id: string   // random UUID per app open, memory only
  user_id?: string | null  // only while signed in; RLS pins it server-side
  name: string
  props: Record<string, unknown>
  app_version: string  // build stamp injected at build time (e.g. short commit SHA)
  event_id: string     // idempotency key, minted in track(), KEPT across re-queues
}
```

Tuning that has worked: flush at 20 events or 15s (whichever first), queue hard-capped at 200
dropping the OLDEST (during an offline stretch, the recent events describe the player *now*).
Read env lazily (function, not module consts) so tests can stub it.

## The flush — where all the subtlety lives

```ts
async function flush(unloading = false): Promise<void> {
  const batch = queue; queue = []
  const body = JSON.stringify(
    schemaFallback ? batch.map(({ event_id: _d, ...rest }) => rest) : batch)
  try {
    const res = await fetch(`${url}/rest/v1/events${schemaFallback ? '' : '?on_conflict=event_id'}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', apikey: key,
        // Signed-in? send the user's own JWT so RLS admits the user_id; else the publishable key.
        Authorization: `Bearer ${token ?? key}`,
        Prefer: schemaFallback ? 'return=minimal' : 'return=minimal,resolution=ignore-duplicates',
      },
      body,
      keepalive: unloading,   // ← the one flag that makes the quit-flush survive page death
      cache: 'no-store',
    })
    if (!res.ok) {
      if (res.status >= 500) requeue(batch)                    // server trouble: keep
      else if (!schemaFallback && res.status === 400) {        // server predates the event_id column
        schemaFallback = true; requeue(batch)                  // DELAY, never lose (deploy race)
      }                                                        // other 4xx: drop — never acceptable
    }
  } catch { requeue(batch) }                                   // transport: keep
}
```

Why raw `fetch` and not a client SDK: (a) `keepalive` — the unload flush carries "user quit here",
the single most valuable funnel event, and SDKs typically don't expose it; (b) analytics keeps
working even before/without the SDK's lazy chunk loading.

`requeue` = `queue = batch.concat(queue).slice(-MAX_QUEUE)`. `schemaFallback` is session-scoped —
next launch retries ids and heals once the migration is applied.

## Lifecycle wiring (init)

- `visibilitychange` → hidden: `flush(true)`. **The only reliable leaving signal on iOS** —
  `beforeunload`/`unload` do not fire when a PWA is swiped away.
- `pagehide`: `flush(true)` (desktop/bfcache).
- `online`: `flush()` — drain what the offline stretch accumulated.
- Track `app_open` once per open (include `standalone` display-mode — installed usage — and
  language). Session id: use `??=`, not `=`, when initializing — events can legitimately be tracked
  before init runs (e.g. a service-worker update toast), and overwriting splits one session in two.
- Init AFTER auth restore, so a returning signed-in user's first events carry their user id.

## Crash telemetry

```ts
const ERROR_LIMIT = 5; let errorsSent = 0; const seen = new Set<string>()
function reportClientError(message: unknown, extra = {}) {
  try {
    const msg = String(message ?? 'unknown').slice(0, 200)
    if (errorsSent >= ERROR_LIMIT || seen.has(msg)) return
    seen.add(msg); errorsSent++
    track(EVENTS.CLIENT_ERROR, { message: msg, ...extra })
  } catch { /* the reporter must never itself throw */ }
}
window.addEventListener('error', e => reportClientError(e.message, {
  source: basename(e.filename) + ':' + e.lineno,                 // basename only — URLs are bytes, not signal
  stack: String(e.error?.stack ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 300),
}))
window.addEventListener('unhandledrejection', e =>
  reportClientError(e.reason?.message ?? e.reason, { kind: 'promise', /* stack likewise */ }))
```

Caps are the point: one per distinct message, N per session — an error loop in a render frame must
not flood the pipe. The dashboard splits these by `app_version`; that column is what turns
"something broke" into "THIS deploy broke it".

## Opt-out + privacy

A localStorage flag; opting out also clears the queue. Disclose in the privacy page: first-party
only, random id, no fingerprinting, the opt-out location. This honesty is only possible because of
the identity choices above.

## What to test (pure, stubbed fetch — no jsdom needed beyond a localStorage stand-in)

- Opt-out stops collection and discards the queue; opt-in resumes.
- `track` never throws (circular props, empty name, undefined).
- Every event carries a distinct UUID `event_id`; the wire has `on_conflict` + ignore-duplicates.
- 5xx re-queues with the SAME ids (that persistence IS the dedupe).
- First 400 flips fallback and RE-QUEUES; the retry has no ids; a second 400 drops.
- Error telemetry: truncation, per-message dedupe, session cap, never throws.

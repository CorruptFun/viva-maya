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

The wire degrades one rung at a time. `wire` is session-scoped: the next launch starts at `'rpc'`
and heals itself once the migration lands.

```ts
type Wire = 'rpc' | 'direct' | 'legacy'
let wire: Wire = 'rpc'

async function flush(unloading = false): Promise<void> {
  const batch = queue; queue = []
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', apikey: key,
    // Signed-in? send the user's own JWT: it's what auth.uid() reads inside the ingest function
    // (and what RLS checks on the direct rung). Else the publishable key.
    Authorization: `Bearer ${token ?? key}`,
  }
  let url_: string, body: string
  if (wire === 'rpc') {
    url_ = `${url}/rest/v1/rpc/ingest_events`      // the ONLY rung that dedupes
    body = JSON.stringify({ p_events: batch })     // server takes user_id from the JWT
  } else {
    url_ = `${url}/rest/v1/events`                 // plain INSERT policy; no dedupe, but it lands
    headers.Prefer = 'return=minimal'
    body = JSON.stringify(
      wire === 'legacy' ? batch.map(({ event_id: _d, ...rest }) => rest) : batch)
  }
  try {
    const res = await fetch(url_, {
      method: 'POST', headers, body,
      keepalive: unloading,   // ← the one flag that makes the quit-flush survive page death
      cache: 'no-store',
    })
    if (!res.ok) {
      if (res.status >= 500) requeue(batch)                 // server trouble: keep, same rung
      else if (wire === 'rpc') {                            // ANY 4xx — see below
        wire = 'direct'; requeue(batch)                     // DELAY, never lose (deploy race)
      } else if (wire === 'direct' && res.status === 400) { // server predates the event_id column
        wire = 'legacy'; requeue(batch)
      }                                 // legacy 4xx: nothing left to strip — drop is correct
    }
  } catch { requeue(batch) }                                // transport: keep
}
```

⚠️ **Step down on ANY 4xx from the RPC rung, not just the 404 you expect.** Being specific is what
broke this pipe the first time: the fallback was written for the 400 a missing column returns, the
real failure was a 401, and every batch fell through to "drop" — a dedupe bug that was silently a
total-data-loss bug. The lower rung is a strictly more permissive wire, so trying it can only help;
if it fails too the batch still drops, one flush later.

Why raw `fetch` and not a client SDK: (a) `keepalive` — the unload flush carries "user quit here",
the single most valuable funnel event, and SDKs typically don't expose it; (b) analytics keeps
working even before/without the SDK's lazy chunk loading. (c) An SDK's `.upsert()` would put you
straight back on the `on_conflict` path that cannot work here.

`requeue` = `queue = batch.concat(queue).slice(-MAX_QUEUE)`.

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
- Every event carries a distinct UUID `event_id`; the batch goes to the ingest RPC.
- The wire NEVER carries `on_conflict` / `ignore-duplicates` on any rung (pin the regression).
- 5xx re-queues with the SAME ids and does NOT step down a rung (that persistence IS the dedupe).
- A 404 steps down to the direct POST and RE-QUEUES; **a 401 does too** (the status the original
  fallback dropped on — test it explicitly, it is the whole bug).
- On the direct rung a 400 strips the ids; a 400 on the legacy rung finally drops.
- Error telemetry: truncation, per-message dedupe, session cap, never throws.

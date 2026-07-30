# The dashboard

A static page on the app's own origin, reading everything through the one admin RPC. Reference
implementation: Viva Maya `stats.html` + `src/stats/` (model/charts/main split).

## Access model (what makes it safe to host publicly)

- The page holds NOTHING secret: publishable key + the owner's own auth session. The server
  (`admin_analytics`) decides. A stranger gets a sign-in button and a 403.
- Same origin as the app → the auth session is already there (same client-lib defaults / storage
  key). The OAuth redirect back to the dashboard URL must be inside the provider's allow-list
  (usually `https://host/app/**` already covers it).
- When a signed-in NON-admin lands, show them the exact SQL insert to run — with their user id
  filled in. It only helps someone who can already open the SQL editor, i.e. the owner. This beats
  making the owner hunt for their UUID.
- Map refusals: RPC error code `42501` → "not an admin" page; anything else → an error page with
  retry. This page is allowed to SHOW errors — its audience is the owner.

## Build/hosting checklist

- Separate entry point (e.g. a second Vite input), NOT a route in the app — the dashboard ships
  none of the app's engine, the app ships none of the dashboard.
- If the app is a PWA: exclude the dashboard html/js/css from the service-worker precache (players
  must never download the owner's tool) AND add it to the navigate-fallback denylist (or an
  installed PWA answers the dashboard URL with the app shell).
- `<meta name="robots" content="noindex">` — harmless if found, no reason to advertise.
- **XSS rule: every client-originated string (event names, error messages, props values, build
  versions) reaches the DOM via `textContent`/`createTextNode` only.** innerHTML on player-written
  strings is stored XSS aimed specifically at the owner's authenticated session.
- Coerce the RPC payload shape-tolerantly field-by-field with defaults — SQL and TS drift
  independently, and a dashboard that throws on one missing key shows nothing. A pre-migration
  server should degrade to empty panels, not crash.

## Panels worth building first (adapt to the product's questions)

1. **KPI tiles**: active devices (+new, +signed-in), sessions, events, median session length +
   bounce %, client errors (status-colored WITH icon+label, never color alone).
2. **Daily actives** (multi-series line: devices / sessions / new devices) — zero-fill silent days;
   the silence is the signal. Label the timezone; bucket UTC to match the SQL.
3. **Retention** (D1/D7 tiles + cohort table) — show "—" for cohorts whose day hasn't fully
   elapsed; never render ineligible as 0%.
4. **Session length** histogram (fixed buckets, labels owned by the dashboard, indices by the SQL).
5. **The product's core funnel(s)** — steps defined from the client's EVENTS constant (compile-time
   pin + a test), conversion vs previous step, null (not 0%) on zero denominators.
6. **Errors** — table grouped by message, WITH the versions column (the deploy tell), capped rows.
7. **Versions/builds in the wild** — under cached clients every other panel is unreadable without
   knowing who runs what.
8. **Every distinct event name in the window** — the 'unknown' bucket and forged names must be
   VISIBLE (that's how a client-side typo gets caught).

## Rendering rules (with the dataviz skill if available, else these minimums)

- Hand-rolled SVG is fine and dependency-free: 2px lines, bars ≤24px with rounded data-end,
  hairline solid gridlines, categorical colors in fixed slot order, one y-axis ever.
- Hover layer by default: crosshair + all-series tooltip on time charts, per-mark hover/focus with
  a full-slot hit target on bars. Keyboard focus shows the same as hover.
- Every chart gets a table twin (details/summary is enough). Tabular numerals in tables only.
- Rates with zero denominators render as "—", never "0%".
- Filter row above everything (7/14/30/90-day presets); refetch holds the previous render at
  reduced opacity — no skeleton flash.
- Light AND dark palettes as CSS custom properties (prefers-color-scheme), validated against their
  surfaces.

## Model/tests

Keep a pure, DOM-free model module (types + coercion + rate math + funnel assembly + tick/geometry
helpers) with unit tests. The vocabulary-pin test — every funnel step name ∈ EVENTS — is the
load-bearing one: a misspelled step renders as a permanently-zero funnel, which looks exactly like
real data.

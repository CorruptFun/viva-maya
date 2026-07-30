---
name: first-party-analytics
description: >-
  Build a complete first-party product analytics stack — client event pipe, locked-down SQL schema,
  admin dashboard, crash telemetry, retention/funnel metrics, and self-maintaining ops — with no
  third-party trackers. Use this whenever the user wants to measure an app or game they are
  building: "add analytics", "how many people use my app", "where do players quit", "track events",
  "retention/DAU/funnels", "crash reporting", "an admin/stats/metrics dashboard", or "make it
  measurable like a real studio" — even if they don't say the word "analytics". Also use it when
  reviewing or extending an existing events table, telemetry client, or metrics dashboard so the
  hard-won rules below aren't re-broken. Assumes a Postgres-backed API in the shape of
  Supabase/PostgREST (RLS + auto REST + JWT auth), a JS/TS client, and works even when the app is
  a static site with no server.
---

# First-party analytics

A five-layer measurement stack, distilled from a shipped implementation (Viva Maya: PWA game,
Supabase backend, GitHub Pages hosting, solo owner). Every rule here earned its place by breaking
first. Build the layers in order; each is independently shippable.

```
1. SCHEMA    append-only events table + guard trigger        (references/schema.sql)
2. CLIENT    fire-and-forget event pipe + crash telemetry    (references/client.md)
3. READ PATH admin-gated aggregate RPC — never raw rows      (references/schema.sql §admin_analytics)
4. DASHBOARD static page, same origin, chart the questions   (references/dashboard.md)
5. OPS       weekly digest + retention pruning + live verify (references/ops.md)
```

Adapt names/hosts to the project; the invariants below are the skill. When the project already has
some layers, audit them against the invariants instead of rebuilding.

## The invariants (why each exists)

**Identity: a random device UUID, not a fingerprint, not an account.**
Mint a UUID into localStorage on first run. Auth-keyed telemetry only ever sees the minority who
sign in; fingerprinting breaks the privacy promise that lets you disclose analytics honestly. Add
`session_id` (minted per app open, memory only) — it's what turns a flat stream into sessions,
bounce rates, and lengths. `user_id` only while signed in, and RLS must pin it to `auth.uid()` so
it cannot be forged.

**The events table is APPEND-ONLY to every client — an INSERT policy and NO SELECT policy, ever.**
RLS denies what it doesn't allow, so with only INSERT the whole world can write its own events and
read nothing. An event log is a per-device behavioural history; one `for select using (true)` undoes
everything. Corollaries that follow from "no SELECT":
- Any view over the table needs `security_invoker = on` or it re-exposes everything as its owner.
- Any `security definer` function needs `set search_path = public, pg_temp` (hijackable otherwise).
- UPDATE/DELETE policies without a SELECT policy are unreachable (Postgres locates rows via the
  SELECT policy) — if clients must modify rows, use a SECURITY DEFINER RPC, not policies.

**Bound the damage, don't pretend to prevent forgery.**
Rows are self-reported by untrusted clients. A BEFORE INSERT guard trigger: normalise the event
name (lower snake_case, length cap, anything else → a visible `'unknown'` bucket — a typo must
surface, not vanish), bound props (JSON object, ~2KB, else `{}`), force `created_at = now()` (the
client never chooses when), and never THROW — a bad row degrades, because an error here goes back
into the game loop.

**The client pipe never throws, never blocks, and is dormant until configured.**
`track()` is synchronous void: append to a queue, return. Batch flush (size + interval), hard queue
cap dropping OLDEST (recent events describe the player now). No env config → every export no-ops.
Flush on `visibilitychange→hidden` and `pagehide` with `keepalive: true` — this is the only path
that captures "player quit here" on iOS, and it's why raw `fetch` beats a client SDK that doesn't
expose keepalive. Re-drain on `online`. Ship a working opt-out. Stamp every event with the build
version — under cached clients (PWAs especially), a metric that moves after a deploy is unreadable
without knowing who runs which code.

**Idempotent ingestion: client-minted `event_id` + nullable unique index + a DEFINER function.**
A flush whose response is lost gets re-sent and would double count. Mint a UUID per event. The
column stays NULLABLE with a FULL (not partial) unique index: old clients insert id-less rows
forever (NULLs never collide), and `ON CONFLICT (event_id)` can only infer a whole-column index.

⚠️ **Do NOT dedupe with a PostgREST upsert on the table** — not `?on_conflict=event_id`, not
`Prefer: resolution=ignore-duplicates`, not `resolution=merge-duplicates`. On a write-only table it
is refused `42501 → 401` on **every** send, including the first, when nothing conflicts. `ON
CONFLICT` makes PostgreSQL require SELECT rights on the target, so the rewriter folds the table's
**SELECT policies** in as an extra `WITH CHECK` on the new row; a write-only table has none, so the
check is built from an empty policy list and becomes a constant false. The tell is an error naming
no policy: `new row violates row-level security policy for table "events"`.
It is **not** a missing UPDATE policy — adding one changes nothing (measured). And no SELECT policy
can fix it: the check runs against the *new* row, so it must be `using (true)`, which republishes
the whole behavioural log to everyone holding the publishable key. Same root cause as an UPDATE or
DELETE that silently matches zero rows on a write-only table, arriving through INSERT.

**Dedupe server-side instead**: one `SECURITY DEFINER` function taking the whole batch as jsonb and
doing `insert … on conflict (event_id) do nothing`. It sees the conflicting row the caller may not,
it is atomic (immune to a resend racing its own original, which an `EXISTS` check is not), and the
table keeps zero SELECT and zero UPDATE policies. Take `user_id` **from the verified JWT, never the
payload** — a definer function bypasses RLS, so the "you may only claim your own uid" policy is not
protecting that path any more. **Return the number of rows actually inserted**: that is the only way
to prove the dedupe from outside without a service key, i.e. the only way to verify it in prod.
Also revoke the platform's default `UPDATE`/`DELETE` grants on the table, so append-only doesn't
rest on the policy list alone.

Client resilience for deploy races: degrade one rung at a time — RPC → direct table POST → direct
POST with ids stripped — RE-QUEUEING at every step, so a client ahead of its migration delays events
instead of losing them. Step down on **any** 4xx, not just the status you predicted: the original
version of this bug dropped a day of events because it only handled 400 and the real failure was
401.

**Crash telemetry is part of analytics, and it is capped.**
`window.onerror` + `unhandledrejection` → a `client_error` event (message truncated, first stack
frames, source basename). Hard caps: N per session, one per distinct message — an error loop must
not flood the pipe. On the dashboard, split errors BY BUILD VERSION: that's what turns "something
broke" into "this deploy broke it". Without this layer, a broken deploy is silence.

**Reads go through ONE admin-gated SECURITY DEFINER RPC returning AGGREGATES ONLY.**
A static site has nowhere to keep a secret; the service key never touches a browser. The RPC
checks `auth.uid()` against an `app_admins` table (RLS on, ZERO policies, so only the service
role/SQL editor can grant membership) and also admits the `service_role` JWT claim so server-side
ops jobs report the same numbers. Everything the RPC touches is hostile: `jsonb_typeof` before
every cast, `round(x::numeric)::int` (a forged `21.5` must not error the whole payload), length-cap
strings, LIMIT every grouped list. Bucket days/hours in EXPLICIT UTC so the RPC and any SQL views
can never disagree. Refuse with errcode `42501` so the dashboard can tell "not an admin" from
"broken".

**Compute the honest denominators.**
Rates with zero denominators are null ("no data"), never 0%. D1/D7 retention counts only devices
whose day0+N has FULLY elapsed — folding in yesterday's cohort drags every number toward zero.
Difficulty/win rates need a sample floor before flagging anything. Funnels are defined against the
client's canonical EVENTS constant (one vocabulary, compile-time pinned, tested) — a funnel built
on a misspelled name renders as a permanently-zero step, indistinguishable from real 0%.

**The dashboard is a static page on the app's own origin.**
Same origin → it reuses the app's existing auth session (same client lib defaults). Keep it out of
any PWA/service-worker precache (users must not download the owner's tool) and out of the SPA
navigate-fallback. Every string that originated in a client (event names, error messages, props
values, versions) reaches the DOM via `textContent` only — innerHTML on player-written strings is
stored XSS aimed at the owner's session. Give every chart a table twin. Follow the dataviz skill
for form/color if available.

**Ops make it self-maintaining; a dashboard nobody opens is decoration.**
A weekly CI job (the CI already holds the service key for other jobs, or add it as a secret):
1) run retention pruning (`prune_events(90)` — grant EXECUTE to service_role; never auto-schedule
deletion inside a migration), and 2) build a digest by calling the SAME admin RPC — never a second
aggregation that drifts — and deliver it where the owner already looks (one continuously-updated
issue beats a weekly new-issue firehose; the ⚠ lines are your alerting: zero events = dead pipe,
client errors, unknown-name spikes).

**Verify against the LIVE API, checking effects, not status codes.**
A shell script of probes (see references/ops.md): every "must be refused" paired with a control
probe against a missing table (an empty `[]` is ambiguous otherwise), and every write assertion
verified by its EFFECT via row count (PostgREST answers 204 whether it deleted one row or zero).
Run it locally while writing migrations and against production the moment they're applied.

**Deploys are two-phase.** Schema first, client second. Any client change that sends a new column
to a server that doesn't have it yet gets rejected per-batch — and cached/PWA clients mean OLD
clients keep writing for weeks, so schema changes must always tolerate the previous wire shape.

## Procedure for a fresh project

1. Read `references/schema.sql`; adapt table/function names and the event-name vocabulary to the
   project; apply via the project's migration flow. Include the verify probes from day one.
2. Read `references/client.md`; implement the pipe (or port the reference), wire `track()` calls at
   the moments the product's real questions live (opens, starts, wins/fails/quits, funnel steps,
   monetization beats, errors). Fewer, well-chosen events beat exhaustive logging.
3. Read `references/dashboard.md`; build the static dashboard against the RPC. Start with: KPI
   tiles, daily actives, retention, session length, the product's core funnel, errors, versions.
4. Read `references/ops.md`; add the weekly digest + prune job and the verify script.
5. Write tests for the pure pieces: vocabulary pinning, rate math with zero denominators,
   coercion of the RPC payload (shape-tolerant — SQL and the client drift independently), and the
   client pipe's queue/flush/fallback behaviour with a stubbed fetch.

## Definition of done

- [ ] Anonymous device id + session id + optional RLS-pinned user id
- [ ] Append-only table, guard trigger, no SELECT policy anywhere (verify script proves it live)
- [ ] Client pipe: dormant / never-throws / batches / keepalive unload flush / opt-out / version stamp
- [ ] Idempotent ingestion with deploy-race fallback (delay, never lose)
- [ ] Crash telemetry, capped, split by build on the dashboard
- [ ] Admin RPC: aggregates only, hostile-input hardened, UTC buckets, 42501 on refusal
- [ ] Dashboard: same-origin, precache-excluded, textContent-only, table twins, honest denominators
- [ ] Weekly digest from the same RPC + scheduled pruning
- [ ] Tests: vocabulary pin, coercion, rate math, queue/flush/fallback

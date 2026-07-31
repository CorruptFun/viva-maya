# Analytics & Push Notifications

Two systems added 2026-07-28, both built on the existing Supabase project. Code is the source of
truth; this explains the *why* and lists the activation steps that are **human-only**.

## Why they exist

Before this, the only telemetry was the two leaderboards, and both require a Google sign-in. That
meant **8 known accounts against ~10–12 believed-active players** — every signed-out player was
invisible, and none of "how many opened the game", "where do players quit", "did a referral ever
convert" could be answered. Separately, the endless race resets weekly (now Monday midnight
America/Edmonton) and nothing told
anyone; the one measured churn (a W30 player absent from W31) crossed exactly that boundary.

## Part 1 — Analytics

| Piece | Where |
| --- | --- |
| Table + RLS + rollup views | `supabase/migrations/0010_events.sql` |
| Client | `src/core/analytics.ts` (`track`, `EVENTS`) |
| Opt-out UI | `src/view/cloudmodal.ts` → "Gameplay stats" |
| Tests | `src/core/analytics.test.ts` |
| **Dashboard** (admin-gated read path) | `supabase/migrations/0014_analytics_dashboard.sql` + `stats.html` + `src/stats/` |
| **Hardening** (dedupe, retention, sessions, crash telemetry, service-role gate) | `supabase/migrations/0015_analytics_hardening.sql` |
| **Dedupe in the guard trigger** (catches any plain insert — every cached client) | `supabase/migrations/0018_event_dedupe_in_guard.sql` |
| **Idempotent ingest RPC** (atomic dedupe + the path the current client uses) | `supabase/migrations/0019_events_idempotent_ingest.sql` |
| **Weekly ops** (prune + digest to a pinned issue) | `.github/workflows/analytics-weekly.yml` + `scripts/analytics-digest.mjs` |

**The table is append-only to every client.** `0010` grants INSERT and *no SELECT at all* — RLS denies
what it doesn't allow, so a visitor holding the publishable key can write their own events and read
nothing. This is deliberate and must stay that way: it is the direct lesson of `0008`/`0009`, where
`referral_codes` shipped `for select using (true)` and every invite code plus its owner's auth UUID
was dumpable. An event log is worse to leak than invite codes — it is a per-device behavioural
history. Read it from the SQL editor (service role bypasses RLS); never add a SELECT policy.

**Anonymous by construction.** `device_id` is a random UUID minted in localStorage — not derived from
anything about the device or person. `user_id` is set only while signed in and RLS pins it to
`auth.uid()`, so it cannot be forged. Disclosed in `public/privacy.html`, with a working opt-out.

### ⚠️ A declared event is not a sent event

A name can be in `EVENTS`, drawn as a funnel step in `src/stats/model.ts`, and aggregated by the
admin RPC — and still be fired by **nothing**. The funnel then renders a permanent **0%**, which is
the worst available failure here: it does not look broken, it looks like real player abandonment.
`plinko_played` sat in exactly that state for the whole life of the dashboard (declared, charted,
and given a whole slot histogram in the RPC), and was only wired up on 2026-07-31.

The old vocabulary test could not catch it — it compared `FUNNEL_DEFS` against `EVENTS`, both
TypeScript, so a step naming a perfectly canonical event that nothing sends passed easily. The pin
that bites is in `src/stats/model.test.ts` ("every funnel step is actually FIRED somewhere"): it
globs the **source text** of every non-test `.ts` under `src/` and looks for a real `track()` call.
Source text, because senders are spread across scenes, views and lazily-imported core modules — two
of them fire through `import('./analytics').then(a => a.track(a.EVENTS.X))`, which no static import
would reveal.

It carries a `KNOWN_UNSENT` list, and that list is the current debt — **still unsent as of
2026-07-31**: `signin_shown`, `install_shown`, `install_accepted`, `referral_captured`. So the
sign-in funnel is missing its own denominator, the whole PWA-install funnel is dead, and invites
show only `share_clicked` → `referral_registered`. Read those four as "no data", never as 0%. The
test fails if a fifth appears, and also fails if a listed one gets wired and is left on the list.

Reading the events it DOES have is a Vite `?raw` glob, not `node:fs`: this project compiles with
`types: ["vite/client"]` and no `@types/node`, so a `node:fs` import type-checks under vitest and
then breaks `npm run build`.

**Reading it — the dashboard.** The everyday read path is
<https://corruptfun.github.io/viva-maya/stats.html> — daily actives, the level funnel with a wall
detector, every conversion funnel (sign-in, install, push, continue, invites, update toast, Deal,
Plinko), sessions by hour, build propagation. Sign in with the owner Google account (the same
session the game holds); the range presets re-query the live table.

How it reads a table with **no SELECT policy**: it does not. `0014` adds `admin_analytics(p_days)`,
a `SECURITY DEFINER` RPC (the `0012` shape, applied to reads) that answers **aggregates only** —
never raw rows — and only to user ids listed in `app_admins`, a table with RLS on and zero
policies, writable solely from the SQL editor. The events table keeps the exact `0010` posture; the
service key still never leaves the server side; a stranger who finds the page gets a sign-in button
and a 403. Anyone signed in but not listed is shown the exact `insert` to run (with their user id)
— which only helps them if they can already open the SQL editor, i.e. they are you.

**Reading it — SQL.** For ad-hoc questions the dashboard doesn't answer, the two `0010` views,
owner-only (`security_invoker = on` — a view over an RLS table *without* that flag runs as its
owner and re-exposes everything, which would silently undo the no-SELECT decision):

```sql
select * from public.events_daily order by day desc limit 30;
select * from public.events_level_funnel where starts > 5 order by win_pct asc limit 20;
```

`events_level_funnel` is the one commissioned by this work: on 2026-07-28 three of seven players sat
at exactly 21 levels cleared, which is either a difficulty wall or one day's progress. A wall shows
as a win rate that falls off a cliff at one level and recovers after it. **Give it a week of data
before concluding anything** — seven players is not a sample.

**Retention.** `prune_events(keep_days)` exists but is *not* scheduled; a migration that silently
starts deleting production rows on a timer is a bad surprise. Once pg_cron is enabled:

```sql
select cron.schedule('prune-events','0 4 * * *',$$select public.prune_events(90)$$);
```

## Part 2 — Push

| Piece | Where |
| --- | --- |
| Subscription table | `supabase/migrations/0011_push_subscriptions.sql` |
| Service-worker handlers | `public/push-sw.js` (via `workbox.importScripts` in `vite.config.ts`) |
| Client opt-in | `src/core/push.ts` + `src/view/cloudmodal.ts` → "Race reminder" |
| Sender | `scripts/send-push.mjs` |
| Schedule | `.github/workflows/endless-push.yml` — 01:00 UTC = 6–7 PM at home, the evening before each midnight-Mountain close. Tue–Sun on the UTC calendar (= Mon–Sat evenings at home) is today's board (`--daily`); Monday 01:00 UTC (= Sunday evening at home) is the weekly season. The two never overlap: a player must never get two notifications in one evening |

**Why a GitHub Actions cron:** GitHub Pages is static, so there is no server to run a timer on, and
Web Push needs an authenticated application server to sign each message. Actions already deploys this
repo, so it adds no new infrastructure and holds the VAPID private key as a secret. Its scheduler can
run 10–30 min late, which is irrelevant — the message says "in N hours", computed at run time.

**⚠️ `dayKey()` and `weekKey()` are duplicated** in `scripts/send-push.mjs` (it runs as bare Node in CI and cannot
import from `src/`). A drift there is silent and total: a wrong key reads an empty board and sends
everyone the generic copy while nothing errors. `src/core/analytics.test.ts` pins the two together
across three years of dates plus the rollover and ISO-year edges. **Do not delete that test.**

**⚠️ Subscribe/unsubscribe go through `SECURITY DEFINER` RPCs (`0012`), never direct table writes.**
PostgreSQL requires rows to be visible under a **SELECT** policy before `UPDATE`/`DELETE` can locate
them — the lookup is governed by the SELECT policy, not the UPDATE one. `0011` intentionally grants
no SELECT (endpoints must never be enumerable), so the direct `DELETE` returned **204 having deleted
nothing** and the upsert never refreshed rotated keys. Both failed silently. If you ever add another
write-only table that clients must also modify, it needs the same RPC shape. Do not "fix" it by
adding `using (true)` — that republishes every endpoint.

**iOS:** Web Push works only in an *installed* PWA (16.4+). `pushSupport()` returns `needs-install`
for that case and the UI says "Add to Home Screen first" rather than showing a dead button.

**A denied notification permission is permanent** — the browser will not ask twice. That is why the
prompt is only ever reached from an explicit tap on a control that has already explained itself, and
never fired on load.

---

# Activation — steps only a human can do

Migrations on this project are applied **by hand**; CI only builds Pages.

### 1. Apply the migrations — **via the SQL editor, NOT `sb push`**

Both are additive (new tables only) — they take nothing away, so the two-phase rule that governed
`0008`/`0009` does not apply and they can land in either order, before or after the client deploy.

> ### ⚠️ Do not reach for `sb push` here
>
> `0009_referral_codes_not_enumerable.sql` is currently on an explicit **HOLD**
> (`supabase/migrations/.hold`) because referral links are circulating: tightening `referral_codes`
> while an old cached client is still live makes its SELECT return zero rows for a real code, which
> `maybeRegisterReferral` reads as a definitive rejection and so **clears the stash — destroying the
> referral instead of retrying**.
>
> **`sb push` is all-or-nothing.** It will refuse outright while `0009` is held; and if the hold were
> released to get `0010`/`0011` in, it would apply `0009` too — exactly the outcome the hold exists
> to prevent. Applying these two by hand in the SQL editor sidesteps the coupling completely and
> leaves `0009` held until the `15c9cec` client has propagated.

Paste `0010_events.sql` and `0011_push_subscriptions.sql` into the SQL editor:
<https://supabase.com/dashboard/project/deskabqqxqqibxjffwmb/sql/new>

Then verify against production:

```bash
scripts/verify-rls.sh https://deskabqqxqqibxjffwmb.supabase.co <publishable-key>
```

Each "must be refused" assertion is paired with a control probe so an empty result can't be
confused with a missing table. Expect `21 passed, 0 failed` with a secret key in the environment
(`15 passed` + 4 SKIP-labelled effect checks without one).

### 1b. Turn on the dashboard (`0014` — additive, any order vs the client deploy)

1. Paste `0014_analytics_dashboard.sql` into the SQL editor (same caveat: **not `sb push`** while
   the `0009` hold stands).
2. Grant your account: sign in at <https://corruptfun.github.io/viva-maya/stats.html> — it will
   answer "not an analytics admin" and print the exact statement with your user id filled in, e.g.

   ```sql
   insert into public.app_admins (user_id, note) values ('<your-auth-uuid>', 'owner')
   on conflict (user_id) do nothing;
   ```

   (Or find the id under Authentication → Users first.) Run it in the SQL editor, reload the page.
3. Re-run `scripts/verify-rls.sh` — it now also proves anon can call neither `admin_analytics` nor
   read `app_admins`.

The dashboard needs no keys of its own: it uses the publishable key baked into the build plus your
Google session, and the server decides. Locally, `npm run dev` + `.env.local` serves it at
`http://localhost:5173/stats.html` against whatever stack the env points at.

### 1c. Hardening (`0015` + `0018` + `0019`) — dedupe, retention, sessions, crash telemetry, weekly ops

Paste `0015_analytics_hardening.sql`, **then `0018_event_dedupe_in_guard.sql`, then
`0019_events_idempotent_ingest.sql`** into the SQL editor, together — `0015` alone is not a working
state (see 1d). What they add:

- **`events.event_id` + a unique index** — idempotent ingestion. A flush whose response is lost is
  re-sent with the same ids and inserts nothing the second time. Old cached clients keep writing
  id-less rows forever; the nullable column + full unique index make all generations coexist.
  ⚠️ The column and index are right, but the *wire shape* 0015 specified to use them
  (`?on_conflict=event_id` + `Prefer: resolution=ignore-duplicates`) can never execute against this
  table. **Applying `0015` alone takes analytics dark** — it is `0018` and `0019` that make the
  dedupe work. See 1d before applying any of them.
- **`admin_analytics` v2** — new `retention` (exact-day D1/D7 with honest eligibility), `sessions`
  (median length, bounce rate, five duration buckets) and `errors` (uncaught-exception rollup,
  split by build) sections, all rendered by the dashboard. The gate now also admits the
  **service_role JWT** so the digest reports the same numbers — no second aggregation to drift.
- **`client_error` events** — `core/analytics.ts` reports uncaught exceptions and unhandled
  rejections, hard-capped (5/session, one per distinct message, truncated) so an error loop can't
  flood the pipe. A broken deploy now shows up as a red tile instead of silence.
- **Weekly ops** — `analytics-weekly.yml` (Mondays 14:00 UTC) runs `prune_events(90)` with the
  service key (0015 grants it EXECUTE — scheduling finally happens, without pg_cron) and posts a
  digest to the run summary **and a single reusable issue titled "📊 Analytics digest"** (updated
  in place; the comment ping is what reaches your phone). Needs the same `SUPABASE_SERVICE_KEY`
  secret the push sender already uses — no new setup.

Then re-run `scripts/verify-rls.sh` (see the counts above — the dedupe check proves the effect by
insert count, not status code).

### 1d. Why the dedupe takes two migrations (`0018` + `0019`)

**If you apply `0015` and stop, the analytics pipe goes silent.** Not double-counted — *empty*.

`0015` designed the dedupe as a PostgREST upsert straight at the table
(`POST /rest/v1/events?on_conflict=event_id` with `Prefer: resolution=ignore-duplicates`). That
request is refused `42501 → 401` on every send, including the first, when nothing conflicts:

> `ON CONFLICT` makes PostgreSQL require SELECT rights on the target, so the rewriter folds the
> table's **SELECT policies** in as an extra `WITH CHECK` on the row being inserted. `events` has
> none — that is `0010`'s most important line — so the check is built from an empty policy list and
> becomes a constant false. The error names no policy, because there is no policy.

It is **not** a missing UPDATE policy (adding one changes nothing — measured), and it cannot be
fixed with a SELECT policy: the check runs against the *new* row, so it would have to be
`using (true)`, which republishes the entire behavioural log to every holder of the publishable
key. This is the same root cause as `0016`, arriving through INSERT instead of UPDATE/DELETE.

The client treats a 4xx that isn't 400 as "this batch will never be accepted" and **drops** it, so
under `0015` alone every event of every session was discarded. The live bundle already ships that
wire shape; it heals when players pick up a build from this revision or later.

Two migrations answer it, from opposite directions, and **both ship** because they cover different
clients:

- **`0018` — dedupe inside the guard trigger.** The trigger is already `SECURITY DEFINER`, so it can
  see the row the caller cannot: a duplicate `event_id` returns `NULL` and the row is silently
  skipped. This catches **any plain insert**, which is what every old cached bundle sends and will
  keep sending for as long as it stays installed. Its one gap is a true concurrent resend — two
  inserts racing past the same `exists()` check — which `0015`'s unique index then catches as a
  `409`.
- **`0019` — `ingest_events(p_events jsonb)`.** A `SECURITY DEFINER` RPC taking the whole batch,
  doing `on conflict (event_id) do nothing`. Atomic, so it has no race to lose, and it is the path
  the current client uses. It also hardens what it can:
  - `user_id` is taken from the **verified JWT** and the payload's is ignored — a definer function
    bypasses RLS, so `0010`'s `auth.uid() = user_id` policy is not protecting this path;
  - the default `UPDATE`/`DELETE` grants Supabase hands `anon`/`authenticated` on `events` are
    **revoked**, so the append-only guarantee no longer rests on the policy list alone;
  - it **returns how many rows it actually inserted**, which is what lets `verify-rls.sh` prove the
    dedupe against production without a secret key (`1` then `0`).

Neither adds a SELECT or UPDATE policy; `0010`'s INSERT policy is untouched. Both are purely
additive, so they are safe in any order relative to the client deploy.

The client (`src/core/analytics.ts`) degrades one rung at a time —
`rpc → direct POST → direct POST with ids stripped` — re-queueing at every step, so a client ahead
of its migrations delays events instead of losing them. **Any** 4xx steps it down, never just the
status we predicted: guessing 400 is what let the original bug throw away data, and the reachable
set is wider than it looks (400 unknown column, 401 the impossible upsert, 404 a server without the
RPC, 409 the trigger-dedupe race above).

### 2. Set the repo variables and secrets

The VAPID keypair is generated and stored at `~/.secrets/viva-maya/` on the mac-mini.

```bash
gh variable set VITE_VAPID_PUBLIC_KEY -R CorruptFun/viva-maya < ~/.secrets/viva-maya/vapid-public.key
gh secret   set VAPID_PRIVATE_KEY     -R CorruptFun/viva-maya < ~/.secrets/viva-maya/vapid-private.key
gh variable set VAPID_SUBJECT         -R CorruptFun/viva-maya --body "mailto:you@example.com"
```

The **service-role key** (Supabase dashboard → Project Settings → API) is the only way to read
`push_subscriptions`, since `0011` grants SELECT to nobody. It must be a **secret**, never a variable
— unlike the publishable key it must never be readable from the client or the repo UI:

```bash
gh secret set SUPABASE_SERVICE_KEY -R CorruptFun/viva-maya
```

⚠️ The public key must be set **before** the client deploy, or the opt-in silently can't subscribe.
The private key must be the pair of it — a mismatch makes every send fail 403.

### 3. Deploy, then dry-run the sender

Push to `main` as usual. Then, from the Actions tab, run **Endless race reminders** manually with
`dry_run: true` — it prints exactly what each subscriber would receive and sends nothing.

### Local testing

`supabase/config.toml` is committed, so a throwaway local stack works:

```bash
supabase start && supabase db reset   # applies every migration from scratch
scripts/verify-rls.sh local
```

Point the app at it with a `.env.local` holding `VITE_SUPABASE_URL=http://127.0.0.1:54321` plus the
local publishable key from `supabase status`. `.env.local` is gitignored. Delete it when done — a
stale one pointing at a stopped stack makes cloud save look broken.

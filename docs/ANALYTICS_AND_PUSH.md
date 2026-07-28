# Analytics & Push Notifications

Two systems added 2026-07-28, both built on the existing Supabase project. Code is the source of
truth; this explains the *why* and lists the activation steps that are **human-only**.

## Why they exist

Before this, the only telemetry was the two leaderboards, and both require a Google sign-in. That
meant **8 known accounts against ~10–12 believed-active players** — every signed-out player was
invisible, and none of "how many opened the game", "where do players quit", "did a referral ever
convert" could be answered. Separately, the endless race resets Monday 00:00 UTC and nothing told
anyone; the one measured churn (a W30 player absent from W31) crossed exactly that boundary.

## Part 1 — Analytics

| Piece | Where |
| --- | --- |
| Table + RLS + rollup views | `supabase/migrations/0010_events.sql` |
| Client | `src/core/analytics.ts` (`track`, `EVENTS`) |
| Opt-out UI | `src/view/cloudmodal.ts` → "Gameplay stats" |
| Tests | `src/core/analytics.test.ts` |

**The table is append-only to every client.** `0010` grants INSERT and *no SELECT at all* — RLS denies
what it doesn't allow, so a visitor holding the publishable key can write their own events and read
nothing. This is deliberate and must stay that way: it is the direct lesson of `0008`/`0009`, where
`referral_codes` shipped `for select using (true)` and every invite code plus its owner's auth UUID
was dumpable. An event log is worse to leak than invite codes — it is a per-device behavioural
history. Read it from the SQL editor (service role bypasses RLS); never add a SELECT policy.

**Anonymous by construction.** `device_id` is a random UUID minted in localStorage — not derived from
anything about the device or person. `user_id` is set only while signed in and RLS pins it to
`auth.uid()`, so it cannot be forged. Disclosed in `public/privacy.html`, with a working opt-out.

**Reading it.** Two views, owner-only (`security_invoker = on` — a view over an RLS table *without*
that flag runs as its owner and re-exposes everything, which would silently undo the no-SELECT
decision):

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
| Client opt-in | `src/core/push.ts` + `src/view/cloudmodal.ts` → "Weekly race reminder" |
| Sender | `scripts/send-push.mjs` |
| Schedule | `.github/workflows/weekly-push.yml` — Sunday 18:00 UTC |

**Why a GitHub Actions cron:** GitHub Pages is static, so there is no server to run a timer on, and
Web Push needs an authenticated application server to sign each message. Actions already deploys this
repo, so it adds no new infrastructure and holds the VAPID private key as a secret. Its scheduler can
run 10–30 min late, which is irrelevant — the message says "in N hours", computed at run time.

**⚠️ `weekKey()` is duplicated** in `scripts/send-push.mjs` (it runs as bare Node in CI and cannot
import from `src/`). A drift there is silent and total: a wrong key reads an empty board and sends
everyone the generic copy while nothing errors. `src/core/analytics.test.ts` pins the two together
across three years of dates plus the rollover and ISO-year edges. **Do not delete that test.**

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

11 checks, each "must be empty" assertion paired with a control probe so an empty result can't be
confused with a missing table. Expect `11 passed, 0 failed`.

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

Push to `main` as usual. Then, from the Actions tab, run **Weekly race reminder** manually with
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

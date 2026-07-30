# Ops: digest, pruning, live verification

The layer that keeps the stack honest after everyone stops thinking about it. Reference
implementation: Viva Maya `.github/workflows/analytics-weekly.yml`, `scripts/analytics-digest.mjs`,
`scripts/verify-rls.sh`.

## Weekly digest + prune (one CI job)

Schedule: weekly, a morning the owner actually reads (cron is UTC — convert, and remember a fixed
UTC hour drifts ±1h across DST).

**Prune step.** `POST /rest/v1/rpc/prune_events {"keep_days":90}` with the service key (the
function is EXECUTE-granted to service_role only). `continue-on-error: true` — a prune hiccup must
not cost the week's digest, but echo the result into the run summary so a red step is still seen.
Never auto-schedule deletion from inside a migration; a visible CI job is the right home.

**Digest step.** A bare-Node script (no deps, built-in fetch) that calls **the same admin RPC the
dashboard renders** — the service_role JWT is admitted by the function's gate for exactly this.
One source of truth: a digest that re-aggregates independently WILL drift from the dashboard, and
then neither is trusted. Output markdown:

- ⚠ alert lines first — this is your alerting, not a separate system:
  - zero events in the window / yesterday → the pipe may be dead (check the last deploy)
  - any client errors → include top message + which builds
  - 'unknown' events present → a client is sending a name the guard doesn't recognise
- headline table: devices (+new/+signed-in), sessions (median length, bounce %), D1/D7 retention
  (returned/eligible), the product's worst funnel steps (with sample sizes), top build share
- a link to the dashboard

**Delivery.** Append to the CI run summary always; additionally upsert ONE reusable issue
("📊 Analytics digest") by title — edit the body, add a short comment (the comment is what triggers
the phone notification). A new-issue-per-week firehose trains the owner to ignore it.

Secrets: the service key lives ONLY in CI secrets (never a repo variable, never the client). If CI
already sends push/emails for the product, the key is already there.

## Live verification script

A shell script of curl probes run (a) against a local stack while writing migrations, (b) against
production the moment they're applied. "It worked locally" and "production is safe" are different
statements; this script turns one into the other. Rules learned the hard way:

1. **Pair every "must be refused" with a control probe** against a table that does not exist. An
   empty `[]` is otherwise ambiguous between "RLS refused you" and "the table isn't there" — which
   look identical and mean opposite things about your security.
2. **Check EFFECTS, not status codes, for writes.** PostgREST answers 204 whether it deleted one
   row or zero (a version of this script once passed for weeks against an unsubscribe that never
   deleted anything). Prove the dedupe by row count, prove a delete by counting what's left —
   these need the service key; label them SKIP when it isn't provided.
3. Probe list for this stack:
   - control: missing table reports the "no such table" error, not `[]`
   - anon CAN append an event (analytics would be dead otherwise)
   - anon CANNOT read events (append-only holds)
   - anon CANNOT attribute an event to another user_id
   - any views over events are not readable by anon
   - anon CANNOT call the admin RPC (grant-level 42501)
   - anon CANNOT read the admins table
   - anon CANNOT *rewrite* an event — append-only holds against UPDATE, not just SELECT
   - anon CAN call the ingest RPC with a batch, twice
   - the ingest RPC returns 1 then 0 for the same event_id — dedupe proven by the RETURNED count,
     so this assertion runs against production without a secret key on the command line
   - [secret] duplicate event_id stored ONCE — counted
   - [secret] a forged `user_id` in the RPC payload is IGNORED (definer function reads the JWT)
   - anon CANNOT call prune
4. Exit non-zero on any failure; print counts.

## Migration discipline

- Two-phase always: schema before the client that needs it. Cached/PWA clients mean the OLD wire
  shape keeps arriving for weeks — every schema change must tolerate it (nullable columns, guard
  normalisation, additive-only).
- Verify migrations against a real scratch Postgres before shipping: create the roles
  (anon/authenticated/service_role), stub `auth.users` + `auth.uid()`/role GUCs, apply the real
  files, seed realistic AND hostile rows (forged types, floats where ints expected, junk names),
  and assert both the numbers and all the refusal paths. Backdate seeded timestamps via UPDATE
  (the guard forces created_at on INSERT).
- Number migrations against the latest on the DEFAULT branch at merge time — parallel work
  collides on numbers; renaming a file is free (an already-applied database doesn't care about
  filenames), colliding numbers in the repo confuse humans forever.

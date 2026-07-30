# first-party-analytics — eval iteration 2 (2026-07-30)

Six evals (the original three + three new: off-stack Fastify/Postgres, forensic
dashboard-debugging, Capacitor WebView lifecycle), 1 run per configuration, blinded A/B
grading, every SQL claim verified by graders against a live Supabase Postgres 17.6.
Full artifacts: `~/Creative/fpa-eval-workspace/iteration-2/` (benchmark.json/md, per-run
grading + timing), review page `iteration-2-review.html`.

## Scores

| Eval | With skill | Baseline |
| --- | --- | --- |
| 1 · greenfield-pwa-supabase | 8/8 | 8/8 |
| 2 · fix-insecure-telemetry | 7/7 | 7/7 |
| 3 · nextjs-privacy-funnels | 6/6 | **4/6** |
| 4 · express-postgres-no-supabase *(new)* | 9/9 | **8/9** |
| 5 · dashboard-numbers-wrong *(new)* | 9/9 | **8/9** |
| 6 · mobile-webview-game *(new)* | 10/10 | 10/10 |
| **Total** | **49/49 (100%)** | **45/49 (91.8%)** |

Cost: +36% time (2052s ± 401 vs 1512s ± 250), +46% tokens (255k ± 38 vs 175k ± 27) —
narrower than iteration 1's 2× because the baseline verified on real Postgres unprompted
this round. n=1 per config per eval: per-eval deltas are directional; the aggregate rests
on 98 independently graded assertions.

## The discrimination problem, now measured

45 of 49 assertion pairs passed in BOTH configs; zero failed in both. The model does the
structural work unprompted (append-only RLS, no third-party, keepalive flush, server-side
gating, guard triggers, capped crash telemetry). Only 4 assertions discriminated, in three
themes — **honest denominators** (baseline failed twice, independently, on different
stacks), **vocabulary drift** (exact repeat of iteration 1), **idempotency** (baseline's
retry rewrite added a duplicate vector). Every discriminating failure is
silent-until-it-bites; iteration 3 assertions should keep probing silent-wrong-number
classes, not structure.

## Skill fixes applied from this round (same commit as this file)

1. **Generalised the write-only-table trap** from "never upsert" to the mechanism: any
   read-back (`ON CONFLICT`, `RETURNING`, supabase-js `.insert().select()` →
   `return=representation`) is refused; `Prefer: return=minimal` is a correctness
   requirement. Scoped explicitly: on an owner/definer connection `on conflict do nothing`
   is right (eval 4's with-skill run wrote that scoping itself; verified live on scratch
   Supabase Postgres as anon).
2. **`revoke … from public` is a no-op for functions on Supabase** — default privileges
   grant EXECUTE to anon/authenticated/service_role directly; roles must be revoked by
   name or `prune_events(90)` stays anon-callable (confirmed 3× independently, verified
   live). Added to invariants + ops.md + schema.sql:263 annotation. viva-maya itself
   already did the three-way revoke (`0010_events.sql`).
3. **Receive time ≠ occurrence time**: forced `created_at = now()` collapses an
   offline-drained queue onto the reconnect instant (eval 5 fixture: 10,861 collisions,
   490 impossible funnel orders). Skill now teaches the split — trusted `received_at` +
   `occurred_at` derived from a server-clamped client **age** (a duration survives a wrong
   device clock; eval 6's with-skill run invented this around the old rule and flagged it).
4. **A vocabulary pin must cross the language boundary** — eval 3's with-skill run pinned
   TS against a TS copy, which cannot catch the SQL-only rename that caused eval 5's
   silent loss. The pin test must read the other side's source text.

## Operational notes for iteration 3

- Eval 2's fixture migration has a real defect (`for insert using (true)`) — kept
  deliberately; note it in that eval's expected_output so graders treat "run notices the
  migration could never have applied" as signal.
- Name harness containers with a random suffix and tell eval/grading agents not to
  create or remove containers: an agent's own scratch Postgres collided with
  `fpa-eval-pg` and destroyed the seeded eval-5 DBs mid-run (comparison survived by luck).
- Grading tree/aggregator shape requirements are in iteration-1-results.md and still hold.
- Round-2 trigger evals (20 queries, 10 should-trigger) are authored and awaiting owner
  approval: `trigger-eval-set.json` + `trigger-eval-review.html` in the workspace.

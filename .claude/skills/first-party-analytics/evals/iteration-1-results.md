# first-party-analytics — eval iteration 1 (2026-07-30)

Three test projects, each built by independent agents with and without the skill, graded on
evidence against the assertions in `evals.json` (SQL claims verified on a scratch Postgres 16).

## Scores

| Eval | With skill | Baseline |
| --- | --- | --- |
| greenfield-pwa-supabase (SvelteKit habit-tracker PWA) | 8/8 | 7/8 |
| fix-insecure-telemetry (canvas game retrofit/audit) | 7/7 | 6/7 |
| nextjs-privacy-funnels (Next.js SaaS funnels) | 6/6 | 5/6 |
| **Total** | **21/21 (100%)** | **18/21 (85.5%)** |

Cost: with-skill runs ≈2× tokens/time (~250k vs ~125k tokens; ~40 vs ~19 min) — almost entirely
the scratch-Postgres verification the skill mandates, which is also what caught every real bug.
n=1 per config per eval, so treat deltas as directional.

## Baseline failure modes (what the skill's value concentrated in)

1. Funnel event names re-typed as string literals across UI and SQL — silent drift risk, no
   pinning test (nextjs).
2. Opt-out implemented as an exported function no UI ever calls (greenfield).
3. Raw per-player rows (incl. nicknames) still SELECT-able by admin browser sessions — the
   dashboard read aggregates, but the grant exposed the rows (fix-insecure).

All three are silent-until-it-bites classes; every loud/structural assertion (append-only RLS,
no third-party, keepalive-ish flush, service key server-side) passed in BOTH configs — the model
does those unprompted, so those assertions don't discriminate. Iteration 2 should probe harder
edges instead.

## Bugs the loop found in the SKILL itself (fixed 2026-07-30, commit 923e4da)

1. **ON CONFLICT dedupe was impossible**: Postgres refuses ANY `INSERT ... ON CONFLICT` for a
   caller with no SELECT policy. Three with-skill agents hit it independently on real Postgres.
   Would have 403'd every live batch once viva-maya's 0015 was applied — caught first. Skill now
   teaches guard-trigger dedupe (see SKILL.md invariant + references/schema.sql).
2. Bare column alias (`::date day` without `AS`) in references/schema.sql — PG16 parse error.

## Operational notes for the next iteration runner

- Workspace layout: the review viewer (`eval-viewer/generate_review.py`) discovers any dirs
  containing `outputs/`; the benchmark aggregator (`scripts/aggregate_benchmark.py`) instead
  requires `eval-*/<config>/run-N/grading.json` AND a `summary` block
  (`{passed, failed, total, pass_rate}`) inside each grading.json — the grader shape alone
  (`expectations: [{text, passed, evidence}]`) aggregates to 0%. Build a shim tree or write both.
- Capture `total_tokens`/`duration_ms` from each task notification into `timing.json` immediately.
- A scratch Postgres works in the remote container: `useradd scratchpg`, run initdb/pg_ctl via
  `su -s /bin/bash scratchpg` under /home/scratchpg (root can't run postgres; the scratchpad isn't
  traversable by other users). Stub roles anon/authenticated/service_role + `auth.uid()`/role GUCs.
- Give eval subagents their own project dirs and pre-place fixture repos for retrofit cases; the
  insecure-game fixture recipe is described in evals.json eval #2.
- One with-skill agent glimpsed the concurrently-written 0018 migration in the host repo mid-run
  (it had already found the issue independently). Isolate harder if that matters: worktree
  isolation or copy the skill out of the repo.
- No user feedback rounds were collected in iteration 1 (viewer delivered; owner did not submit
  feedback.json) — don't block iteration 2 waiting for one.

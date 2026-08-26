-- ============================================================================
-- 0028_push_daily_budget.sql
--
-- ⚠️ NUMBERED 0028, NOT 0026, AND THE GAP IS DELIBERATE — DO NOT CLOSE IT.
-- 0026 and 0027 are spoken for by the parked paid-entry branch
-- (claude/player-monetization-referral-mdz8ii: 0026_paid_entry_and_referral_cash,
-- 0027_contact_email_and_recovery), deliberately unapplied and unmerged because
-- paid entry is not ready. Those two were themselves renumbered once already to
-- dodge a collision at 0025.
--
-- Taking 0026 here would record version '0026' in
-- supabase_migrations.schema_migrations, and a duplicate of an ALREADY-APPLIED
-- remote version is not an error — it is SILENTLY SKIPPED, and it passes
-- `db push --dry-run` while being skipped. The paid-entry migration would then
-- never land while every surface reported success; CLAUDE.md records that exact
-- failure measured on 2026-08-25. So this takes the next number ABOVE the parked
-- pair and leaves them free to apply in order whenever that branch is unparked.
-- (`--include-all` is what then picks them up despite being numbered below this.)
-- A SEND BUDGET PER DEVICE PER RACE DAY — the accounting that lets the game
-- send MORE than one notification a day without that becoming "as many as the
-- crons happen to fire".
--
-- WHY: 0025 bounded volume to one-a-day by CONSTRUCTION — the two slots had
-- disjoint audiences, and `last_sent_at` was checked against the current race
-- day as a same-day boolean. That worked, and it also had a failure mode nobody
-- had measured: the two weekday slots between them covered "was not here
-- yesterday" and "was here exactly yesterday", so a player who opens the game
-- EVERY day sat at `away === 0` forever and matched NEITHER. Four subscribers,
-- all daily-active, received nothing at all from 2026-08-25 (the day the
-- activity split shipped) until this change — the sender reported
-- `4 opted in · 4 held back · 0 due` every run and that read as a correct quiet
-- state rather than as the whole audience being unreachable.
--
-- The owner's call (2026-08-26) is that the game should nudge a few times
-- through the day for gameplay encouragement, so the disjoint-audience
-- construction is deliberately being given up. What replaces it has to be a
-- real bound rather than an emergent one, because the thing being spent is a
-- notification permission a player cannot give back twice.
--
-- WHAT THIS ADDS: a per-device, per-RACE-DAY send counter.
--   · `sends_day`   the race day key (core/endless.ts dayKey) the counter is for
--   · `sends_count` how many notifications that device was sent on that day
-- The sender resets the counter when `sends_day` no longer matches today, so
-- there is nothing to sweep and no second job to run.
--
-- ⚠️ WHY A COUNTER AND NOT JUST A MINIMUM GAP. A gap between sends bounds the
-- RATE but not the TOTAL: add a fifth cron and a gap-only rule quietly admits a
-- fifth notification, with nothing anywhere refusing it. The card
-- (src/view/pushoptin.ts VOLUME_RULE) prints a number to every player who is
-- deciding whether to hand over the permission, and a printed number that is
-- merely how the schedule currently happens to work out is a promise waiting to
-- be broken by a one-line YAML edit. The sender enforces BOTH: the gap stops
-- two landing back to back, the counter stops the day exceeding what the card
-- says. `DAILY_SEND_CAP` in scripts/send-push.mjs is the same number the card
-- prints — change one, change both.
--
-- ⚠️ THE RACE DAY, NOT `now() - interval '24 hours'`. "Three a day" has to mean
-- three per BOARD, matching the day the gift, the quest slate and the
-- leaderboard partition all roll on (midnight America/Edmonton). A rolling
-- 24-hour window would let the 9pm last-call and the next morning's 9am gift
-- both count against the same window while belonging to different days.
--
-- TWO-PHASE (0008/0009): purely additive, and unusually safe even by that
-- standard — these two columns are written by the SENDER alone and read by
-- nothing in the client bundle. No cached client can be holding code that
-- depends on them, so there is no phase to wait for and no client deploy this
-- has to land beside.
--
-- ⚠️ The sender is nonetheless TOLERANT of this migration not being applied,
-- which is the opposite of the call 0025 made, and the difference is which way
-- the fallback errs. 0025's `--drop` filter degraded toward blasting the WRONG
-- AUDIENCE, so failing loudly was right. Here the fallback is the pre-existing
-- one-notification-per-race-day rule, which is strictly QUIETER than the new
-- behaviour — it under-sends rather than over-sends, and under-sending is the
-- side a notification budget should fail toward. A 400 on these columns logs a
-- warning and drops back to `sentToday`; the run still delivers.
--
-- Idempotent-friendly: safe to re-run.
-- Rollback: alter table public.push_subscriptions
--             drop column if exists sends_day,
--             drop column if exists sends_count;
--           (The sender then falls back to one-a-day on its own — see above.)
-- ============================================================================

alter table public.push_subscriptions
    add column if not exists sends_day text,
    add column if not exists sends_count integer not null default 0;

comment on column public.push_subscriptions.sends_day is
    'Race day key (YYYY-MM-DD, America/Edmonton) that sends_count belongs to. '
    'The sender resets the counter when this no longer matches today.';

comment on column public.push_subscriptions.sends_count is
    'Notifications sent to this endpoint on sends_day. Bounded by DAILY_SEND_CAP '
    'in scripts/send-push.mjs, which is the number src/view/pushoptin.ts prints '
    'on the opt-in card.';

-- No RLS change. 0011 grants no SELECT to anyone and the write policies are
-- unchanged; these columns are reached only by the service-role sender, exactly
-- like `last_sent_at` and `failure_count` beside them.

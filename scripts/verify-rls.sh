#!/usr/bin/env bash
# ============================================================================
# verify-rls.sh — prove the exposure rules of 0010/0011/0014/0015/0019 against a LIVE API.
#
# Written because this matrix has to run at least twice: once against a local
# stack while writing the migrations, and again against production the moment
# the owner applies them. Migrations are applied BY HAND on this project (CI
# only builds Pages), so "it worked locally" is never the same statement as
# "production is safe" — this script is what turns one into the other.
#
# USAGE
#   scripts/verify-rls.sh local
#   scripts/verify-rls.sh <url> <publishable-key> [secret-key]
#
# The secret key is OPTIONAL and only enables the two sender-side checks. Never
# pass a production secret key on a shared machine's command line — export it as
# VM_SECRET_KEY instead, or just skip those checks (they are labelled SKIP).
#
# EVERY "must be empty" assertion is paired with a CONTROL probe against a table
# that does not exist. Without the control, an empty [] is ambiguous between
# "RLS refused you" and "the table isn't there at all" — and those two look
# identical from the client while meaning opposite things about your security.
# ============================================================================
set -uo pipefail

case "${1:-}" in
  local)
    URL="http://127.0.0.1:54321"
    KEY="$(supabase status -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("ANON_KEY",""))')"
    SECRET="$(supabase status -o json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("SERVICE_ROLE_KEY",""))')"
    ;;
  "")
    echo "usage: $0 local | $0 <url> <publishable-key> [secret-key]" >&2; exit 2 ;;
  *)
    URL="$1"; KEY="${2:?publishable key required}"; SECRET="${3:-${VM_SECRET_KEY:-}}" ;;
esac

PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n     got: %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33m–\033[0m SKIP %s\n' "$1"; }

anon()   { curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@"; }
anonc()  { curl -s -o /dev/null -w '%{http_code}' -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@"; }
svc()    { curl -s -H "apikey: $SECRET" -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' "$@"; }
# Body AND status in one request, so a check can assert the RETURNED VALUE without spending a
# second write to learn the status code. Sets $BODY and $CODE.
anonbc() {
  local r; r="$(curl -s -w $'\n%{http_code}' -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' "$@")"
  CODE="${r##*$'\n'}"; BODY="${r%$'\n'*}"
}
# A PostgREST filter value has to be URL-encoded, and an endpoint is a whole https:// URL.
# It worked unencoded by luck: `:` and `/` survive, but a push service is free to mint an
# endpoint containing `,` or `&`, either of which would silently re-parse as filter syntax.
urlenc() { python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"; }

DEV="11111111-1111-1111-1111-111111111111"
SES="22222222-2222-2222-2222-222222222222"
EP="https://fcm.googleapis.com/fcm/send/verify-rls-$(date +%s)"
EPQ="$(urlenc "$EP")"

echo "Verifying $URL"
echo
echo "── control (makes every 'empty' below meaningful) ───────────────"
c=$(anon "$URL/rest/v1/vm_no_such_table?select=*")
case "$c" in *PGRST205*) ok "a missing table reports PGRST205, not []" ;;
             *) bad "control probe did not report a missing table" "$c" ;; esac

echo
echo "── events: append-only ──────────────────────────────────────────"
c=$(anonc -X POST "$URL/rest/v1/events" -d "{\"device_id\":\"$DEV\",\"session_id\":\"$SES\",\"name\":\"rls_probe\",\"props\":{\"level\":1}}")
[ "$c" = "201" ] && ok "anon CAN append an event ($c)" || bad "anon cannot append — analytics would be dead" "$c"

c=$(anon "$URL/rest/v1/events?select=*")
[ "$c" = "[]" ] && ok "anon CANNOT read events (append-only holds)" || bad "EVENTS ARE READABLE — behavioural history is exposed" "$c"

c=$(anon -X POST "$URL/rest/v1/events" -d "{\"device_id\":\"$DEV\",\"session_id\":\"$SES\",\"name\":\"forged\",\"user_id\":\"33333333-3333-3333-3333-333333333333\"}")
case "$c" in *42501*) ok "anon CANNOT attribute an event to another user" ;;
             *) bad "user_id can be forged" "$c" ;; esac

# ⚠️ REGRESSION GUARD (0019). The idempotent-ingest bug looked exactly like "the upsert just needs
# an UPDATE policy" — it did not (an UPDATE policy changes nothing; the blocker was the absent
# SELECT policy), and adding one would have made an event log rewritable by the very clients that
# write it. 0019 also revokes the UPDATE/DELETE grants Supabase hands out by default, so a
# permissive policy added in haste still cannot land a write.
# A status assertion is sufficient HERE, and only here: with the grant revoked the refusal is an
# unambiguous 42501. Were it left to the policy list alone, PostgREST would answer 204/0-rows and
# this check would pass while proving nothing — the exact trap documented in the push section.
c=$(anon -X PATCH "$URL/rest/v1/events?device_id=eq.$DEV" -d '{"name":"rewritten"}')
case "$c" in *42501*) ok "anon CANNOT rewrite an event (append-only holds)" ;;
             *) bad "EVENTS ARE MUTABLE — a client can rewrite events it already sent" "$c" ;; esac

for v in events_daily events_level_funnel; do
  c=$(anon "$URL/rest/v1/$v?select=*")
  case "$c" in *42501*|"[]") ok "view $v is not readable by anon" ;;
               *) bad "VIEW $v LEAKS the events table" "$c" ;; esac
done

echo
echo "── analytics dashboard (0014): admin-gated, admin list unreadable ──"
# The RPC must refuse the anon role at the GRANT level (42501) — a signed-in
# non-admin is refused inside the function instead, which this script cannot
# probe (it holds no user JWT); the page itself shows that path as "not an
# admin". If 0014 isn’t applied yet this reports PGRST202 (no such function),
# which also fails the check — apply, then re-verify.
c=$(anon -X POST "$URL/rest/v1/rpc/admin_analytics" -d '{"p_days":7}')
case "$c" in *42501*) ok "anon CANNOT call admin_analytics" ;;
             *) bad "ADMIN ANALYTICS ANSWERS ANON — aggregates are public" "$c" ;; esac

c=$(anon "$URL/rest/v1/app_admins?select=*")
case "$c" in *42501*) ok "anon CANNOT read app_admins (grant revoked)" ;;
             *) bad "app_admins IS REACHABLE — the admin list should not even be queryable" "$c" ;; esac

echo
echo "── events hardening (0015/0018/0019): idempotent ingest, private retention ───"
# ⚠️ 0015 specified the dedupe as a PostgREST upsert (`?on_conflict=event_id` +
# `resolution=ignore-duplicates`) straight at the table. That shape can NEVER work here and this
# script is the thing that caught it: ON CONFLICT makes PostgreSQL require SELECT rights on the
# target, which folds the table's SELECT policies in as an extra WITH CHECK on the new row —
# and `events` deliberately has none, so the check is a constant false and every send is 401.
# The only policy that satisfies it is `for select using (true)`, i.e. publishing the whole
# behavioural log. 0019 moved the conflict handling into a SECURITY DEFINER function instead;
# the probe below deliberately exercises THAT path, because it is the one the client now uses.
EID=$(python3 -c 'import uuid;print(uuid.uuid4())')
# $1 = event_id, $2 = extra JSON fields (leading comma), e.g. ',"user_id":"…"'
ev() { printf '{"p_events":[{"device_id":"%s","session_id":"%s","name":"rls_probe","event_id":"%s"%s}]}' "$DEV" "$SES" "$1" "${2:-}"; }

anonbc -X POST "$URL/rest/v1/rpc/ingest_events" -d "$(ev "$EID")"; n1="$BODY"; s1="$CODE"
anonbc -X POST "$URL/rest/v1/rpc/ingest_events" -d "$(ev "$EID")"; n2="$BODY"; s2="$CODE"
case "$s1/$s2" in
  20*/20*) ok "anon CAN ingest a batch via ingest_events, twice ($s1/$s2)" ;;
  *)       bad "idempotent ingest rejected — is 0019 applied?" "$s1/$s2 — $n1" ;;
esac
# The EFFECT, not the status (the send-push lesson below): both sends answer 200 whether or not the
# second row was ignored. ingest_events RETURNS how many rows it actually inserted, so 1-then-0 is
# proof by itself — which is what finally makes this assertion runnable against PRODUCTION, where
# nobody should be putting the secret key on a command line.
case "$n1/$n2" in
  1/0) ok "duplicate event_id stored ONCE (dedupe proven by the returned insert count)" ;;
  *)   bad "DEDUPE DID NOTHING — a re-sent batch double-counts" "inserted $n1 then $n2" ;;
esac
# THE OTHER HALF, and it is not redundant: 0018 dedupes inside the guard trigger, which catches any
# PLAIN insert — so it is what every OLD CACHED BUNDLE relies on, none of which will ever call the
# RPC. 0019's path above is the atomic one the current client uses. Both ship; both are probed.
# Plain inserts on purpose here: an on_conflict/upsert shape is refused outright on this table (the
# root cause above), so a 401/403 on these means someone reintroduced an upsert.
# The STATUS is a real assertion in this one case, because the two outcomes are distinguishable:
# with the trigger the duplicate is silently skipped (201), and WITHOUT it the 0015 unique index
# catches the same insert and PostgREST answers 409. So this works with no secret key either.
TID=$(python3 -c 'import uuid;print(uuid.uuid4())')
tev="{\"device_id\":\"$DEV\",\"session_id\":\"$SES\",\"name\":\"rls_probe\",\"event_id\":\"$TID\"}"
t1=$(anonc -X POST "$URL/rest/v1/events" -d "$tev")
t2=$(anonc -X POST "$URL/rest/v1/events" -d "$tev")
case "$t1/$t2" in
  20*/20*)  ok "guard trigger dedupes a plain re-sent insert ($t1/$t2)" ;;
  20*/409)  bad "TRIGGER DEDUPE MISSING — is 0018 applied? (the unique index caught it instead)" "$t1/$t2" ;;
  *)        bad "id-carrying plain insert rejected — are 0015+0018 applied?" "$t1/$t2" ;;
esac
if [ -n "${SECRET:-}" ]; then
  n=$(svc "$URL/rest/v1/events?event_id=eq.$EID&select=id" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')
  [ "$n" = "1" ] && ok "…and exactly one row is really there (confirmed by count)" \
    || bad "DEDUPE DID NOTHING — a re-sent batch double-counts" "$n rows"
else
  skip "dedupe row-count confirmation (needs a secret key; the count check above already proved it)"
fi

# ingest_events is SECURITY DEFINER, so RLS is NOT what protects user_id on this path — the
# function reading it from the VERIFIED JWT and ignoring the payload is. A definer function that
# trusted the row would let any anonymous visitor attribute events to any account: strictly worse
# than the hole 0010's policy closes, and invisible without checking the stored value.
FID=$(python3 -c 'import uuid;print(uuid.uuid4())')
anon -X POST "$URL/rest/v1/rpc/ingest_events" \
     -d "$(ev "$FID" ',"user_id":"33333333-3333-3333-3333-333333333333"')" >/dev/null
if [ -n "${SECRET:-}" ]; then
  got=$(svc "$URL/rest/v1/events?event_id=eq.$FID&select=user_id" \
        | python3 -c 'import json,sys;d=json.load(sys.stdin);print("MISSING" if not d else (d[0]["user_id"] or "null"))')
  [ "$got" = "null" ] && ok "ingest_events IGNORES a forged user_id (attribution comes from the JWT)" \
    || bad "THE RPC ATTRIBUTED AN EVENT TO ANOTHER USER — definer function trusts the payload" "$got"
else
  skip "RPC forged-user_id check (needs a secret key to read the stored row back)"
fi

c=$(anon -X POST "$URL/rest/v1/rpc/prune_events" -d '{"keep_days":90}')
case "$c" in *42501*) ok "anon CANNOT run retention pruning" ;;
             *) bad "PRUNE IS REACHABLE BY ANON — anyone could empty the event log" "$c" ;; esac

echo
echo "── push_subscriptions: write-only, endpoints are bearer secrets ──"
# ⚠️ EVERY assertion below checks the EFFECT, never just the status code.
# The original version of this script checked `20*` on the unsubscribe and passed for weeks against
# a subscription that was never actually removed: PostgREST answers 204 whether it deleted one row
# or zero, and with no SELECT policy the DELETE could never locate the row at all (fixed in 0012).
# A status-code assertion on a write is not a test — it only proves the request was well-formed.
c=$(anonc -X POST "$URL/rest/v1/rpc/register_push_subscription" \
     -d "{\"p_endpoint\":\"$EP\",\"p_p256dh\":\"BProbeKeyMaterial00000000\",\"p_auth\":\"probeAuth1234\",\"p_device_id\":\"$DEV\"}")
case "$c" in 20*) ok "anon CAN register a subscription via RPC ($c)" ;;
             *) bad "anon cannot subscribe — push would be dead" "$c" ;; esac

c=$(anon "$URL/rest/v1/push_subscriptions?select=*")
[ "$c" = "[]" ] && ok "anon CANNOT enumerate subscriptions" || bad "PUSH ENDPOINTS ARE ENUMERABLE — anyone can notify every player" "$c"

# Re-register with DIFFERENT key material, then prove the stored row actually changed. Verified via
# the sender's own view (service role) when available; otherwise the round-trip below still proves
# the row is reachable, because unsubscribe would report "already gone" if it were not.
anonc -X POST "$URL/rest/v1/rpc/register_push_subscription" \
  -d "{\"p_endpoint\":\"$EP\",\"p_p256dh\":\"BRotatedKeyMaterial11111\",\"p_auth\":\"rotatedAuth9\",\"p_device_id\":\"$DEV\"}" >/dev/null
if [ -n "${SECRET:-}" ]; then
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EPQ&select=p256dh" \
        | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["p256dh"] if d else "MISSING")')
  [ "$got" = "BRotatedKeyMaterial11111" ] && ok "re-register REFRESHES the stored key (rotation works)" \
    || bad "re-register did not update the row — rotated keys would be silently ignored" "$got"
fi

# The real unsubscribe test: delete, then prove it is GONE by counting rows.
# ⚠️ SCOPED TO THE ENDPOINT, because that is what unsubscribe_push deletes by. This counted
# `device_id` until 2026-07-30 and cost a full diagnostic round trip: every run mints a fresh
# endpoint but reuses the one probe device_id, so a single stranded row from ANY earlier run
# failed this check forever. It conflates "this delete failed" with "unrelated debris exists" —
# opposite conclusions, and it prints the alarming one. The real leftover was a 2026-07-28
# orphan from a PRE-0016 run, back when unsubscribe was a direct DELETE that matched zero rows
# and so could never remove itself. The delete under test was working the whole time.
# The device-wide count is still worth having — it just gets its OWN check, at the end.
anonc -X POST "$URL/rest/v1/rpc/unsubscribe_push" -d "{\"p_endpoint\":\"$EP\"}" >/dev/null
if [ -n "${SECRET:-}" ]; then
  left=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EPQ&select=endpoint" \
         | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')
  [ "$left" = "0" ] && ok "anon CAN unsubscribe — row is actually GONE (verified by count)" \
    || bad "UNSUBSCRIBE DID NOTHING — player keeps getting notifications after opting out" "$left rows left"
else
  skip "unsubscribe effect check (needs a secret key to count rows)"
fi

if [ -n "${SECRET:-}" ]; then
  # Needs its OWN row: the unsubscribe check above deleted the previous one (that is the point of
  # it), so without re-registering here these two assertions read "?" and fail for the wrong reason.
  anonc -X POST "$URL/rest/v1/rpc/register_push_subscription" \
    -d "{\"p_endpoint\":\"$EP\",\"p_p256dh\":\"BProbeKeyMaterial00000000\",\"p_auth\":\"probeAuth1234\",\"p_device_id\":\"$DEV\"}" >/dev/null
  svc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EPQ" -d '{"failure_count":7}' >/dev/null
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EPQ&select=failure_count" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["failure_count"] if d else "?")')
  [ "$got" = "7" ] && ok "sender CAN record delivery bookkeeping" || bad "sender cannot write failure_count — dead endpoints never retire" "$got"

  anonc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EPQ" -d '{"failure_count":0}' >/dev/null
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EPQ&select=failure_count" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["failure_count"] if d else "?")')
  [ "$got" = "7" ] && ok "client CANNOT clear its own failure_count" || bad "client forged delivery bookkeeping" "$got"
  # Leave nothing behind: this script is run against production.
  anonc -X POST "$URL/rest/v1/rpc/unsubscribe_push" -d "{\"p_endpoint\":\"$EP\"}" >/dev/null

  # …and PROVE nothing was left behind, by this run or any earlier one. This is the
  # device-wide count that used to masquerade as the unsubscribe assertion above; it is real
  # signal, it just had the wrong label on it. Not cosmetic bookkeeping: a stranded probe row
  # sits in the sender's audience and gets a real delivery attempt on every send — the
  # 2026-07-28 orphan was found carrying failure_count=1 from exactly that.
  # A leftover here is swept with the public RPC (no secret key needed), which doubles as an
  # independent proof of the opt-out path on a row this run did not create:
  #   curl -s -X POST -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  #        -H 'Content-Type: application/json' "$URL/rest/v1/rpc/unsubscribe_push" \
  #        -d '{"p_endpoint":"<the endpoint printed below>"}'
  stale=$(svc "$URL/rest/v1/push_subscriptions?device_id=eq.$DEV&select=endpoint")
  n=$(printf '%s' "$stale" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)))')
  [ "$n" = "0" ] && ok "no probe subscriptions left behind (this run or earlier ones)" \
    || bad "PROBE ROWS STRANDED IN push_subscriptions — they ride along in every real send" "$n left: $stale"
else
  skip "sender-side bookkeeping checks (no secret key given)"
fi


echo
echo "── paid entry (0025): MONEY IS NOT SELF-REPORTED ────────────────"
# ⚠️ THE MOST IMPORTANT SECTION IN THIS FILE, and the reason is that it asserts the OPPOSITE of
# everything above it. `events` must be anon-writable or analytics is dead; `push_subscriptions`
# must be anon-writable or push is dead. These four tables must be anon-UNwritable or the game is
# free and the referral program pays out to whoever asks — an entitlement a client can insert is a
# $3.99 product given away, and a `referral_earnings` row a client can insert is real money wired
# to a stranger's bank account.
#
# They carry SELECT policies for their owner and deliberately NO insert/update/delete policy for
# any role, so every write below must come back 42501. A 201 here is not a failing test, it is an
# incident: someone has added a write policy to make a client feature work, and the feature was
# wrong. The reads must come back [] — meaningful because the control probe at the top of this
# script proves a missing table reports PGRST205 instead.
FORGED="44444444-4444-4444-4444-444444444444"

for t in entitlements referral_earnings payout_accounts payouts; do
  c=$(anon "$URL/rest/v1/$t?select=*")
  [ "$c" = "[]" ] && ok "anon CANNOT read $t" || bad "$t IS READABLE BY ANON — payment history is exposed" "$c"
done

c=$(anon -X POST "$URL/rest/v1/entitlements" -d "{\"user_id\":\"$FORGED\",\"status\":\"paid\",\"source\":\"forged\"}")
case "$c" in *42501*) ok "anon CANNOT mint an entitlement (the paywall holds)" ;;
             *) bad "ENTITLEMENTS ARE WRITABLE — anyone can grant themselves the game" "$c" ;; esac

c=$(anon -X POST "$URL/rest/v1/referral_earnings" \
     -d "{\"referrer_user_id\":\"$FORGED\",\"referee_user_id\":\"$DEV\",\"tier\":0,\"amount_cents\":169,\"stripe_payment_intent\":\"pi_forged\",\"available_at\":\"2020-01-01T00:00:00Z\"}")
case "$c" in *42501*) ok "anon CANNOT mint a commission (the ledger holds)" ;;
             *) bad "THE COMMISSION LEDGER IS WRITABLE — anyone can pay themselves real money" "$c" ;; esac

c=$(anon -X POST "$URL/rest/v1/payouts" -d "{\"user_id\":\"$FORGED\",\"amount_cents\":999999,\"idempotency_key\":\"forged\"}")
case "$c" in *42501*) ok "anon CANNOT request a payout row" ;;
             *) bad "PAYOUTS ARE WRITABLE — anyone can queue a transfer to themselves" "$c" ;; esac

c=$(anon -X POST "$URL/rest/v1/payout_accounts" -d "{\"user_id\":\"$FORGED\",\"stripe_account_id\":\"acct_forged\",\"payouts_enabled\":true}")
case "$c" in *42501*) ok "anon CANNOT attach a payout destination" ;;
             *) bad "PAYOUT ACCOUNTS ARE WRITABLE — anyone can redirect someone else's earnings" "$c" ;; esac

# The hold is the chargeback defence, so the column that carries it must be unreachable too — an
# UPDATE that could pull `available_at` back to the past would let a commission be withdrawn the
# moment it is written, which is the whole attack the hold exists to stop.
c=$(anon -X PATCH "$URL/rest/v1/referral_earnings?tier=eq.0" -d '{"available_at":"2020-01-01T00:00:00Z","status":"available"}')
case "$c" in *42501*) ok "anon CANNOT shorten the hold on a commission" ;;
             *) bad "THE HOLD IS CLIENT-WRITABLE — chargeback protection is defeated" "$c" ;; esac

# Both verdict RPCs are granted to `authenticated` only. They are SECURITY DEFINER and answer for
# auth.uid(), so an anon caller would be asking about a null user — but the grant is what makes
# that unreachable rather than merely uninteresting.
for f in my_access my_cash_summary; do
  c=$(anon -X POST "$URL/rest/v1/rpc/$f" -d '{}')
  case "$c" in *42501*) ok "anon CANNOT call $f" ;;
               *) bad "$f ANSWERS ANON — is 0025 applied with its grants?" "$c" ;; esac
done

# …and the one function that IS public, so a failure above can be told apart from "0025 was never
# applied at all". If this reports PGRST202 the migration is missing, not misconfigured.
c=$(anon -X POST "$URL/rest/v1/rpc/paywall_active_from" -d '{}')
case "$c" in *PGRST202*) bad "0025 IS NOT APPLIED — every check in this section is meaningless" "$c" ;;
             *) ok "0025 is applied (paywall_active_from answers: $c)" ;; esac

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1

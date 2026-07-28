#!/usr/bin/env bash
# ============================================================================
# verify-rls.sh — prove the exposure rules of 0010/0011 against a LIVE API.
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

DEV="11111111-1111-1111-1111-111111111111"
SES="22222222-2222-2222-2222-222222222222"
EP="https://fcm.googleapis.com/fcm/send/verify-rls-$(date +%s)"

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

for v in events_daily events_level_funnel; do
  c=$(anon "$URL/rest/v1/$v?select=*")
  case "$c" in *42501*|"[]") ok "view $v is not readable by anon" ;;
               *) bad "VIEW $v LEAKS the events table" "$c" ;; esac
done

echo
echo "── push_subscriptions: write-only, endpoints are bearer secrets ──"
c=$(anonc -X POST "$URL/rest/v1/push_subscriptions" \
     -d "{\"endpoint\":\"$EP\",\"p256dh\":\"BProbeKeyMaterial00000000\",\"auth\":\"probeAuth1234\",\"device_id\":\"$DEV\"}")
[ "$c" = "201" ] && ok "anon CAN register a subscription ($c)" || bad "anon cannot subscribe — push would be dead" "$c"

c=$(anon "$URL/rest/v1/push_subscriptions?select=*")
[ "$c" = "[]" ] && ok "anon CANNOT enumerate subscriptions" || bad "PUSH ENDPOINTS ARE ENUMERABLE — anyone can notify every player" "$c"

c=$(anonc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP" -d '{"week_race":false}')
case "$c" in 20*) ok "anon CAN toggle its own week_race (unsubscribe works, $c)" ;;
             *) bad "anon cannot change its own prefs — cannot opt out" "$c" ;; esac

if [ -n "${SECRET:-}" ]; then
  svc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP" -d '{"failure_count":7}' >/dev/null
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP&select=failure_count" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["failure_count"] if d else "?")')
  [ "$got" = "7" ] && ok "sender CAN record delivery bookkeeping" || bad "sender cannot write failure_count — dead endpoints never retire" "$got"

  anonc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP" -d '{"failure_count":0}' >/dev/null
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP&select=failure_count" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["failure_count"] if d else "?")')
  [ "$got" = "7" ] && ok "client CANNOT clear its own failure_count" || bad "client forged delivery bookkeeping" "$got"
else
  skip "sender-side bookkeeping checks (no secret key given)"
fi

# Clean up after ourselves REGARDLESS of whether a secret key was supplied — this script is meant to
# be run against production, and a probe row left in push_subscriptions is litter the sender would
# then try (and fail) to deliver to. anon holds DELETE on anonymous rows, so no secret is needed.
# (The probe EVENT row cannot be removed — the table is append-only by design. One clearly-named
# `rls_probe` row per run is the accepted cost of verifying production for real.)
curl -s -o /dev/null -X DELETE -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP"

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1

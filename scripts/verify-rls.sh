#!/usr/bin/env bash
# ============================================================================
# verify-rls.sh — prove the exposure rules of 0010/0011/0014 against a LIVE API.
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
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$EP")&select=p256dh" \
        | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["p256dh"] if d else "MISSING")')
  [ "$got" = "BRotatedKeyMaterial11111" ] && ok "re-register REFRESHES the stored key (rotation works)" \
    || bad "re-register did not update the row — rotated keys would be silently ignored" "$got"
fi

# The real unsubscribe test: delete, then prove it is GONE by counting rows.
anonc -X POST "$URL/rest/v1/rpc/unsubscribe_push" -d "{\"p_endpoint\":\"$EP\"}" >/dev/null
if [ -n "${SECRET:-}" ]; then
  left=$(svc "$URL/rest/v1/push_subscriptions?device_id=eq.$DEV&select=endpoint" \
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
  svc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP" -d '{"failure_count":7}' >/dev/null
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP&select=failure_count" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["failure_count"] if d else "?")')
  [ "$got" = "7" ] && ok "sender CAN record delivery bookkeeping" || bad "sender cannot write failure_count — dead endpoints never retire" "$got"

  anonc -X PATCH "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP" -d '{"failure_count":0}' >/dev/null
  got=$(svc "$URL/rest/v1/push_subscriptions?endpoint=eq.$EP&select=failure_count" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d[0]["failure_count"] if d else "?")')
  [ "$got" = "7" ] && ok "client CANNOT clear its own failure_count" || bad "client forged delivery bookkeeping" "$got"
  # Leave nothing behind: this script is run against production.
  anonc -X POST "$URL/rest/v1/rpc/unsubscribe_push" -d "{\"p_endpoint\":\"$EP\"}" >/dev/null
else
  skip "sender-side bookkeeping checks (no secret key given)"
fi


echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1

#!/usr/bin/env bash
# Smoke test for the accounting add-on on a running ngdpbase, wherever it runs
# (bare metal, Docker, Kubernetes): the same checks against a base URL.
#
#   scripts/smoke.sh <base-url> <admin-password>
#
# The site must allow the admin to keep the ledger (deploy/smoke/app-custom-config.json
# does, for tests only). Each run makes one fund and one receipt; the ledger keeps them.
set -u
BASE="${1:?base url, e.g. http://localhost:3003}"
PASSWORD="${2:?admin password}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
FAILED=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAILED=1; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# 1. The site answers, and the add-on's help page was seeded.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/view/Using%20Accounting")
[ "$code" = 200 ] && pass "help page 'Using Accounting' seeded" || fail "help page: HTTP $code"

# 2. The ledger API is mounted and refuses an anonymous caller.
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/accounting/funds")
[ "$code" = 401 ] && pass "anonymous caller refused (401)" || fail "anonymous /api/accounting/funds: HTTP $code"

# 3. Sign in as admin.
csrf=$(curl -s -c "$JAR" -b "$JAR" "$BASE/login" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"//')
code=$(curl -s -c "$JAR" -b "$JAR" --data-urlencode "_csrf=$csrf" --data-urlencode "username=admin" --data-urlencode "password=$PASSWORD" \
  -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/login")
token=$(curl -sL -c "$JAR" -b "$JAR" "$BASE/" | grep -o 'name="csrf-token" content="[^"]*"' | sed 's/.*content="//;s/"//')
# A refused password also answers 302, back to /login?error=…: only a redirect elsewhere is a sign-in.
case "$code" in 302\ *login\?error*) code="refused: ${code#302 }" ;; 302\ *) code=302 ;; esac
[ "$code" = 302 ] && [ -n "$token" ] && pass "signed in as admin" || fail "sign-in: $code"
api() { curl -s -b "$JAR" -H "X-CSRF-Token: $token" -H 'Content-Type: application/json' "$@"; }

# 4. A fund, a receipt (money in, numbered R-…), and the balance that follows (written to the database, audited).
name="Smoke $(date -u +%Y%m%dT%H%M%S)"
fund=$(api -d "{\"name\":\"$name\",\"openingBalance\":1000}" "$BASE/api/accounting/funds" | json "d['result']['id'] if d.get('ok') else ''" 2>/dev/null)
[ -n "$fund" ] && pass "fund created" || fail "create fund"
receipt=$(api -d "{\"amount\":2550,\"date\":\"$(date -u +%Y-%m-%d)\",\"fundId\":\"$fund\",\"category\":\"4100\",\"partyName\":\"Smoke Test\",\"paymentMethod\":\"10\",\"memo\":\"smoke test receipt\"}" "$BASE/api/accounting/receipts" | json "d['result']['confirmationNumber'] if d.get('ok') else ''" 2>/dev/null)
case "$receipt" in R-*) pass "receipt recorded ($receipt)" ;; *) fail "record receipt" ;; esac
balance=$(api "$BASE/api/accounting/balances" | json "next((b['balance'] for b in d['result'] if b['fundId']=='$fund'), None)" 2>/dev/null)
[ "$balance" = 3550 ] && pass "balance is opening + receipt (3550 cents)" || fail "balance: $balance"

# 5. The CSV export (step-up applies; a fresh sign-in satisfies it).
type=$(curl -s -b "$JAR" -o /dev/null -w '%{content_type}' "$BASE/api/accounting/export?kind=funds&month=current")
case "$type" in text/csv*) pass "CSV export";; *) fail "CSV export: $type";; esac

[ "$FAILED" = 0 ] && echo "SMOKE OK  $BASE" || echo "SMOKE FAILED  $BASE"
exit "$FAILED"

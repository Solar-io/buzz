#!/usr/bin/env bash
# ============================================================================
# smoke-buzz-dev.sh — prove the Buzz DEV relay is actually serving.
#
# Read-only. Safe to run any time, including against a stack you did not start.
# Exits non-zero on the first failed check so it is usable as a gate.
#
# Every assertion here was executed against a real ghcr.io/block/buzz relay on
# 2026-08-23 and the expected values recorded from that run — see
# docs/evidence/BUZZ-W1-SMOKE-2026-08-23.md. They are not guesses.
#
# Usage: ./deploy/buzz/smoke-buzz-dev.sh [--port N] [--json]
# ============================================================================
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

PORT=""; JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown flag: $1" ;;
  esac
done

if [ -z "$PORT" ]; then
  ENVF="$BUZZ_CHECKOUT/deploy/compose/.env"
  [ -f "$ENVF" ] || die "no $ENVF and no --port; cannot tell which port to probe"
  PORT="$(grep -E '^BUZZ_HTTP_PORT=' "$ENVF" | cut -d= -f2-)"
fi
BASE="http://127.0.0.1:$PORT"
need curl; need jq

PASS=0; FAIL=0
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then printf '  PASS  %-34s %s\n' "$1" "$3"; PASS=$((PASS+1))
  else printf '  FAIL  %-34s expected=%s actual=%s\n' "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi
}
checkn() { # name, actual-nonempty
  if [ -n "$2" ] && [ "$2" != "null" ]; then printf '  PASS  %-34s %s\n' "$1" "$2"; PASS=$((PASS+1))
  else printf '  FAIL  %-34s (empty)\n' "$1"; FAIL=$((FAIL+1)); fi
}

step "Buzz DEV smoke — $BASE"

check "_liveness"  "ok"    "$(curl -fsS -m 5 "$BASE/_liveness" 2>/dev/null || echo ERR)"
check "_readiness" "ready" "$(curl -fsS -m 5 "$BASE/_readiness" 2>/dev/null | jq -r '.status // "ERR"' 2>/dev/null || echo ERR)"

NIP11="$(curl -fsS -m 5 -H 'Accept: application/nostr+json' "$BASE/" 2>/dev/null || echo '{}')"
check  "nip11 software"   "https://github.com/block/buzz" "$(printf '%s' "$NIP11" | jq -r '.software // "ERR"')"
checkn "nip11 version"    "$(printf '%s' "$NIP11" | jq -r '.version // ""')"
# Posture assertions. These are the two that make it a CLOSED relay; a false
# here means the relay is open to anyone who can reach the tailnet port, which
# is exactly the ADR-038 mistake in a new coat.
check  "auth_required"    "true" "$(printf '%s' "$NIP11" | jq -r '.limitation.auth_required // "ERR"')"
check  "restricted_writes" "true" "$(printf '%s' "$NIP11" | jq -r '.limitation.restricted_writes // "ERR"')"
# `self` is the relay's own pubkey, derived by the relay from
# BUZZ_RELAY_PRIVATE_KEY. Non-empty proves the key was accepted and parsed.
checkn "relay self pubkey" "$(printf '%s' "$NIP11" | jq -r '.self // ""')"

# Migrations. A relay can answer /_readiness with an empty schema, so check the
# table count rather than trusting readiness alone.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q postgres; then
  PG="$(docker ps --format '{{.Names}}' | grep postgres | head -1)"
  N="$(docker exec "$PG" psql -U buzz -d buzz -tAc \
        "select count(*) from information_schema.tables where table_schema='public';" 2>/dev/null | tr -d ' ' || echo 0)"
  if [ "${N:-0}" -ge 50 ]; then printf '  PASS  %-34s %s tables\n' "migrations applied" "$N"; PASS=$((PASS+1))
  else printf '  FAIL  %-34s %s tables (expected >=50)\n' "migrations applied" "${N:-0}"; FAIL=$((FAIL+1)); fi
fi

# ── The check that decides whether a human can connect at all ───────────────
# A relay can pass every check above and still serve nothing, because the
# community is keyed on host:port and an unmatched Host 404s. Probe with the
# host the relay itself was configured with.
ENVF="$BUZZ_CHECKOUT/deploy/compose/.env"
if [ -f "$ENVF" ]; then
  RELAY_HOST="$(grep -E '^RELAY_URL=' "$ENVF" | cut -d= -f2- | sed -E 's#^[a-z]+://##')"
  if [ -n "$RELAY_HOST" ]; then
    CODE="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $RELAY_HOST" "$BASE/" || echo 000)"
    check "community bound to $RELAY_HOST" "200" "$CODE"
    WEB="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $RELAY_HOST" -H 'Accept: text/html' "$BASE/" || echo 000)"
    if grep -q '^BUZZ_SERVE_GIT_WEB_GUI=true' "$ENVF" 2>/dev/null; then
      check "browser gets HTML at /" "200" "$WEB"
    else
      printf '  SKIP  %-34s BUZZ_SERVE_GIT_WEB_GUI is not true\n' "browser gets HTML at /"
    fi
  fi

  # ── Pairing (NIP-AB) ──────────────────────────────────────────────────────
  # The desktop's "start pairing" resolves `pairing_relay_url` from NIP-11 and
  # the QR the phone scans carries that URL. Empty or 404 here is exactly the
  # "WebSocket connection failed: HTTP error: 404 Not Found" failure measured
  # 2026-08-24. Probe notes: 101 comes back only over HTTP/1.1 — over TLS curl
  # negotiates h2 by ALPN and h2 has no Upgrade, so the tailnet probe MUST
  # force --http1.1 (measured: without it the check reads 200 and lies).
  PAIR_URL="$(printf '%s' "$NIP11" | jq -r '.pairing_relay_url // ""')"
  if [ -n "$PAIR_URL" ]; then
    printf '  PASS  %-34s %s\n' "nip11 pairing_relay_url" "$PAIR_URL"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-34s (empty — phone pairing will 404)\n' "nip11 pairing_relay_url"; FAIL=$((FAIL+1))
  fi
  PAIRING_PORT="$(grep -E '^BUZZ_PAIRING_PORT=' "$ENVF" 2>/dev/null | cut -d= -f2-)"
  if [ -n "$PAIRING_PORT" ]; then
    CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
      "http://127.0.0.1:$PAIRING_PORT/pair" || true)"
    check "pairing sidecar WS upgrade" "101" "${CODE:-000}"
    if [ -n "$RELAY_HOST" ]; then
      CODE="$(curl -s -m 3 --http1.1 -o /dev/null -w '%{http_code}' \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
        -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
        "https://$RELAY_HOST/pair" || true)"
      check "tailnet /pair WS upgrade" "101" "${CODE:-000}"
    fi
  else
    printf '  SKIP  %-34s no BUZZ_PAIRING_PORT in .env\n' "pairing sidecar WS upgrade"
  fi
fi

printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$JSON" = "1" ] && printf '{"pass":%d,"fail":%d,"base":"%s"}\n' "$PASS" "$FAIL" "$BASE"
[ "$FAIL" -eq 0 ] || exit 1

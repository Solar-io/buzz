#!/bin/bash
# D-029 buzz-push-gateway dev bring-up (runbook: PLANS/D029_IOS_WRAPPER_SCOPING.md,
# "Thursday bring-up runbook" section). Idempotent: recreates the container.
# Env sourced at runtime — no credentials in this file or in the image.
#
# Real-credential swap (the pre-agreed 30-sec step at the CO .p8 handoff):
#   1. Replace $STAGING/key.p8 with the real APNs key (chmod 600).
#   2. TEAM_ID=<10-char> APNS_KEY_ID=<10-char> ./deploy/push-gateway-up.sh
set -euo pipefail

PROJECT_ID=534404e2-9d94-44cf-95be-645bce71cfc7   # Infisical: buzz
STAGING="$HOME/.buzz/.scratch/d029-gateway-staging" # mounts key.p8 + AppleAppAttestRootCA.pem (both sha-verified)
IMAGE="${IMAGE:-buzz-push-gateway:d029}"

: "${INFISICAL_TOKEN:=$(~/.config/infisical/refresh-token.sh --print)}"
GRANT=$(infisical secrets get BUZZ_PUSH_GRANT_KEYS --plain --env=dev --projectId "$PROJECT_ID")
TOKEN=$(infisical secrets get BUZZ_PUSH_TOKEN_KEYS --plain --env=dev --projectId "$PROJECT_ID")
RT_PASS=$(infisical secrets get BUZZ_PUSH_RUNTIME_DB_PASSWORD --plain --env=dev --projectId "$PROJECT_ID")
DB_PASS=$(docker inspect buzz-dev-postgres-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
[ -n "$GRANT" ] && [ -n "$TOKEN" ] && [ -n "$DB_PASS" ] && [ -n "$RT_PASS" ] || { echo "secret fetch failed" >&2; exit 9; }
RUNTIME_ROLE=buzz_push_runtime
ADMIN_URL="postgres://buzz:${DB_PASS}@postgres:5432/buzz_push_gateway"
RUNTIME_URL="postgres://${RUNTIME_ROLE}:${RT_PASS}@postgres:5432/buzz_push_gateway"

# Pass 1: migrations + least-privilege grants (idempotent; admin URL, DDL pass).
docker run --rm --network buzz-dev_buzz-net \
  -e DATABASE_URL="$ADMIN_URL" -e BUZZ_PUSH_RUNTIME_DATABASE_ROLE="$RUNTIME_ROLE" \
  "$IMAGE" --migrate-only

docker rm -f buzz-push-gateway 2>/dev/null || true
docker run -d --name buzz-push-gateway \
  --network buzz-dev_buzz-net \
  -p 6359:8080 -p 127.0.0.1:6360:8081 \
  -v "$STAGING:/secrets:ro" \
  --restart unless-stopped \
  -e BUZZ_PUSH_GRANT_KEYS="$GRANT" \
  -e BUZZ_PUSH_TOKEN_KEYS="$TOKEN" \
  -e BUZZ_PUSH_PUBLIC_DELIVERY_URL=https://push.buzz.xyz/v1/deliveries/apns \
  -e BUZZ_PUSH_MAX_GRANT_LIFETIME_SECONDS=2592000 \
  -e BUZZ_PUSH_ENABLED_PROFILES=buzz-ios-sandbox \
  -e "DATABASE_URL=$RUNTIME_URL" \
  -e BUZZ_PUSH_APP_ATTEST_APP_ID="${TEAM_ID:-PLACEHOLDER-TEAMID}.cloud.noet.buzz" \
  -e BUZZ_PUSH_APP_ATTEST_ROOT_CERT_PATH=/secrets/AppleAppAttestRootCA.pem \
  -e BUZZ_PUSH_APNS_KEY_PATH=/secrets/key.p8 \
  -e BUZZ_PUSH_APNS_KEY_ID="${APNS_KEY_ID:-PLACEHOLDER-KEYID}" \
  -e BUZZ_PUSH_APNS_TEAM_ID="${TEAM_ID:-PLACEHOLDER-TEAMID}" \
  -e BUZZ_PUSH_APNS_TOPIC=cloud.noet.buzz \
  "$IMAGE"

sleep 3
docker logs --tail 20 buzz-push-gateway
curl -sf -m 5 http://127.0.0.1:6360/health >/dev/null && echo "HEALTH-OK on :6360"

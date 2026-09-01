#!/usr/bin/env bash
# ============================================================================
# install-buzz-dev.sh — ONE-TIME bootstrap of the Buzz DEV relay on crichton.
#
# Idempotent: safe to re-run. It will NOT regenerate secrets that already
# exist (that would change the relay's identity and orphan every membership).
#
# What it does, in order:
#   1. Guards (finalize hook, test runner, docker reachable)
#   2. Resolves the port block from infra/port-registry.json, ALLOCATING one
#      (collision-checked + atomic) if buzz does not have one yet
#   3. Clones/updates the buzz checkout at a pinned commit
#   4. Mints owner + relay keypairs (once) and the random secrets (once)
#   5. Renders deploy/compose/.env from our template
#   6. Installs the launchd wrapper + plist (com.dev.buzz-relay)
#   7. Stops. It does NOT start anything — that is deploy-buzz-dev.sh.
#
# Usage:
#   ./deploy/buzz/install-buzz-dev.sh [--dry-run] [--no-allocate]
# ============================================================================
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --no-allocate) export BUZZ_NO_ALLOCATE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown flag: $a" ;;
  esac
done

guard_not_finalize_hook
guard_not_under_test

step "[1/7] Preflight"
detect_docker
need git; need jq; need openssl
log "docker: $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
log "compose: $(docker compose version --short 2>/dev/null)"

step "[2/7] Ports (from $PORT_REGISTRY — allocated if absent, never guessed)"
ensure_port_block
RELAY_PORT="$(registry_port primary)"
HTTPS_PORT="$(registry_port https)"
PAIRING_PORT="$(registry_port pairing)"
[ "$RELAY_PORT" != "$HTTPS_PORT" ] || die "primary and https ports must differ (see the :6000/:6001 note in CLAUDE.md)"
[ "$RELAY_PORT" != "$PAIRING_PORT" ] || die "primary and pairing ports must differ (pairing is a second listener)"
assert_not_bad_port "$RELAY_PORT" "relay bind"
assert_not_bad_port "$HTTPS_PORT" "tailnet front door"
assert_not_bad_port "$PAIRING_PORT" "pairing sidecar bind"
log "relay bind        127.0.0.1:$RELAY_PORT"
log "tailnet front door       :$HTTPS_PORT"
log "pairing sidecar   127.0.0.1:$PAIRING_PORT (fronted at :$HTTPS_PORT/pair)"

step "[3/7] Buzz checkout"
BUZZ_PIN="${BUZZ_PIN:-}"
if [ ! -d "$BUZZ_CHECKOUT/.git" ]; then
  run git clone "$BUZZ_REPO_URL" "$BUZZ_CHECKOUT"
else
  log "already cloned: $BUZZ_CHECKOUT"
  # Tolerant: a fetch only matters when BUZZ_PIN asks for a specific commit.
  # A transient network failure must not abort an otherwise fine re-install.
  run git -C "$BUZZ_CHECKOUT" fetch --tags origin || warn "git fetch failed — continuing with the checkout as-is"
fi
if [ -n "$BUZZ_PIN" ]; then
  # This one is NOT tolerant: if a pin was named and we cannot reach it, the
  # install would silently produce a different version than the one requested.
  run git -C "$BUZZ_CHECKOUT" checkout --detach "$BUZZ_PIN" \
    || die "cannot check out BUZZ_PIN=$BUZZ_PIN (fetch may have failed)"
fi
[ "$DRY_RUN" = "1" ] || log "HEAD: $(git -C "$BUZZ_CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo '?')"

step "[4/7] Secrets + keys (generated ONCE, never rotated by a re-run)"
run mkdir -p "$BUZZ_RUNTIME_DIR/keys"
run chmod 700 "$BUZZ_RUNTIME_DIR" "$BUZZ_RUNTIME_DIR/keys" 2>/dev/null || true
SECRETS_FILE="$BUZZ_RUNTIME_DIR/secrets.env"

if [ -f "$SECRETS_FILE" ]; then
  log "reusing existing secrets: $SECRETS_FILE"
elif [ "$DRY_RUN" = "1" ]; then
  log "[DRY_RUN] would mint owner + relay keypairs and 5 random secrets"
else
  read -r OWNER_SEC OWNER_PUB < <("$BUZZ_KIT_DIR/lib/nostr-keygen.sh")
  read -r RELAY_SEC RELAY_PUB < <("$BUZZ_KIT_DIR/lib/nostr-keygen.sh")
  umask 077
  printf '%s\n' "$OWNER_SEC" > "$BUZZ_RUNTIME_DIR/keys/owner.secret"
  printf '%s\n' "$OWNER_PUB" > "$BUZZ_RUNTIME_DIR/keys/owner.pub"
  printf '%s\n' "$RELAY_PUB" > "$BUZZ_RUNTIME_DIR/keys/relay.pub"
  cat > "$SECRETS_FILE" <<SEC
OWNER_PUBKEY=$OWNER_PUB
RELAY_PRIVATE_KEY=$RELAY_SEC
GIT_HOOK_HMAC_SECRET=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
REDIS_PASSWORD=$(openssl rand -hex 16)
S3_ACCESS_KEY=$(openssl rand -hex 12)
S3_SECRET_KEY=$(openssl rand -hex 32)
SEC
  chmod 600 "$SECRETS_FILE"
  log "minted owner pubkey: $OWNER_PUB"
  warn "BACK UP $SECRETS_FILE AND $BUZZ_RUNTIME_DIR/keys/ — losing them means a new relay identity."
  warn "TODO(Sam): move these into Infisical (project 534404e2-9d94-44cf-95be-645bce71cfc7, env=dev, path /buzz) and have this script read them from there instead. See README.md §Secrets."
fi

step "[5/7] Render deploy/compose/.env"
COMPOSE_DIR="$BUZZ_CHECKOUT/deploy/compose"
[ "$DRY_RUN" = "1" ] || [ -d "$COMPOSE_DIR" ] || die "no $COMPOSE_DIR — is the checkout complete?"
# NOTE: `|| true` is load-bearing. Under `set -e` a failing command
# substitution inside an assignment aborts the script, and `tailscale` is
# absent from launchd's minimal PATH and from any non-tailnet host — so
# without this the installer dies here with no message at all. (It did.)
TAILNET_HOST="${TAILNET_HOST:-}"
if [ -z "$TAILNET_HOST" ]; then
  TAILNET_HOST="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty' 2>/dev/null | sed 's/\.$//' || true)"
fi
# GUESS: crichton's tailnet name, from CLAUDE.md. Overridable with TAILNET_HOST.
[ -n "$TAILNET_HOST" ] || TAILNET_HOST="crichton.tailb3d4b8.ts.net"
log "tailnet host: $TAILNET_HOST"

if [ "$DRY_RUN" = "1" ]; then
  log "[DRY_RUN] would render $COMPOSE_DIR/.env from env/buzz-dev.env.template"
else
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  umask 077
  sed \
    -e "s|__BUZZ_IMAGE__|${BUZZ_IMAGE:-$BUZZ_IMAGE_DEFAULT}|g" \
    -e "s|__TAILNET_HOST__|$TAILNET_HOST|g" \
    -e "s|__HTTPS_PORT__|$HTTPS_PORT|g" \
    -e "s|__RELAY_PORT__|$RELAY_PORT|g" \
    -e "s|__PAIRING_PORT__|$PAIRING_PORT|g" \
    -e "s|__OWNER_PUBKEY__|$OWNER_PUBKEY|g" \
    -e "s|__RELAY_PRIVATE_KEY__|$RELAY_PRIVATE_KEY|g" \
    -e "s|__GIT_HOOK_HMAC_SECRET__|$GIT_HOOK_HMAC_SECRET|g" \
    -e "s|__POSTGRES_PASSWORD__|$POSTGRES_PASSWORD|g" \
    -e "s|__REDIS_PASSWORD__|$REDIS_PASSWORD|g" \
    -e "s|__S3_ACCESS_KEY__|$S3_ACCESS_KEY|g" \
    -e "s|__S3_SECRET_KEY__|$S3_SECRET_KEY|g" \
    -e "s|__POSTGRES_PORT__|$(registry_port postgres)|g" \
    -e "s|__REDIS_PORT__|$(registry_port redis)|g" \
    -e "s|__MINIO_API_PORT__|$(registry_port minio_api)|g" \
    -e "s|__MINIO_CONSOLE_PORT__|$(registry_port minio_console)|g" \
    -e "s|__ADMINER_PORT__|$(registry_port adminer)|g" \
    -e "s|__PROMETHEUS_PORT__|$(registry_port prometheus)|g" \
    "$BUZZ_KIT_DIR/env/buzz-dev.env.template" > "$COMPOSE_DIR/.env"
  chmod 600 "$COMPOSE_DIR/.env"
  cp -f "$COMPOSE_DIR/.env" "$BUZZ_RUNTIME_DIR/buzz-dev.env"
  # buzz's own run.sh refuses any remaining CHANGE_ME. Fail here instead, with
  # a better message, rather than at first start.
  ! grep -qE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*(CHANGE_ME|__[A-Z_]+__)' "$COMPOSE_DIR/.env" \
    || die "rendered .env still has unsubstituted placeholders — template/installer are out of sync"
  log "wrote $COMPOSE_DIR/.env (0600)"
fi

step "[6/7] launchd wrapper"
DEV_SERVICES_DIR="${EVIE_DEV_SERVICES_DIR:-$HOME/.config/dev-services}"
run mkdir -p "$DEV_SERVICES_DIR"
run install -m 0755 "$BUZZ_KIT_DIR/launchd/buzz-relay-dev.sh" "$DEV_SERVICES_DIR/buzz-relay-dev.sh"
PLIST="$HOME/Library/LaunchAgents/com.dev.buzz-relay.plist"
if [ "$DRY_RUN" = "1" ]; then
  log "[DRY_RUN] would write $PLIST"
else
  mkdir -p "$(dirname "$PLIST")"
  sed -e "s|__WRAPPER__|$DEV_SERVICES_DIR/buzz-relay-dev.sh|g" \
      -e "s|__LOGDIR__|$BUZZ_RUNTIME_DIR|g" \
      "$BUZZ_KIT_DIR/launchd/com.dev.buzz-relay.plist.template" > "$PLIST"
  log "wrote $PLIST (not loaded — deploy-buzz-dev.sh loads it)"
fi

step "[7/7] Done — nothing started"
cat <<MSG

  Install complete. NOTHING IS RUNNING YET, on purpose.

  Next:
    ./deploy/buzz/deploy-buzz-dev.sh          # start + front door + health gate
    ./deploy/buzz/smoke-buzz-dev.sh           # prove it

  Owner pubkey : $(cat "$BUZZ_RUNTIME_DIR/keys/owner.pub" 2>/dev/null || echo '(dry run)')
  Secrets      : $SECRETS_FILE  ← BACK THIS UP
MSG

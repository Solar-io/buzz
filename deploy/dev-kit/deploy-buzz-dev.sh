#!/usr/bin/env bash
# ============================================================================
# deploy-buzz-dev.sh — start / restart / reconcile the Buzz DEV stack.
#
# SCOPE: `com.dev.buzz-*` and the compose project only. It never enumerates,
# drains or boots out a `com.dev.evie-*` label, and it never touches either
# evie-ui checkout. The two stacks are disjoint by construction — see the note
# in lib/common.sh.
#
# Usage:
#   ./deploy/buzz/deploy-buzz-dev.sh [--dry-run] [--restart-only] [--stop]
#                                    [--no-front-door] [--status]
# ============================================================================
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MODE=deploy; FRONT_DOOR=1
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --restart-only) MODE=restart ;;
    --stop) MODE=stop ;;
    --status) MODE=status ;;
    --no-front-door) FRONT_DOOR=0 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown flag: $a" ;;
  esac
done

guard_not_finalize_hook
guard_not_under_test
detect_docker; need jq

COMPOSE_DIR="$BUZZ_CHECKOUT/deploy/compose"
[ -f "$COMPOSE_DIR/.env" ] || die "no $COMPOSE_DIR/.env — run ./deploy/buzz/install-buzz-dev.sh first"
RELAY_PORT="$(grep -E '^BUZZ_HTTP_PORT=' "$COMPOSE_DIR/.env" | cut -d= -f2-)"
PAIRING_PORT="$(grep -E '^BUZZ_PAIRING_PORT=' "$COMPOSE_DIR/.env" | cut -d= -f2-)"
HTTPS_PORT="$(registry_port https 2>/dev/null || echo '')"

# -p is NOT optional. buzz's deploy/compose/compose.yml hardcodes
# `name: buzz-prod`, so without an explicit project name a DEV stack comes up
# calling itself "buzz-prod" — and a real Buzz prod stack on this same host
# would then land in the SAME project and fight it for containers and volumes.
# evie-ui already runs dev and prod co-resident on crichton; assume Buzz will
# too, and keep the projects disjoint from day one.
compose() { (cd "$COMPOSE_DIR" && docker compose -p "$BUZZ_COMPOSE_PROJECT" --env-file .env -f compose.yml -f "$BUZZ_KIT_DIR/compose.loopback.yml" -f "$BUZZ_KIT_DIR/compose.pairing.yml" "$@"); }

case "$MODE" in
  status)
    step "Buzz DEV status"; compose ps; exit 0 ;;
  stop)
    step "Stopping Buzz DEV"
    run bash -c "cd '$COMPOSE_DIR' && docker compose -p '$BUZZ_COMPOSE_PROJECT' --env-file .env -f compose.yml -f '$BUZZ_KIT_DIR/compose.loopback.yml' -f '$BUZZ_KIT_DIR/compose.pairing.yml' down"
    launchctl bootout "gui/$(id -u)/com.dev.buzz-relay" 2>/dev/null || true
    log "stopped (volumes preserved — 'docker compose down -v' would destroy data)"
    exit 0 ;;
esac

step "[1/4] Compose config validation"
if [ "$DRY_RUN" = "1" ]; then log "[DRY_RUN] would validate + start"; else
  compose config >/dev/null || die "compose config invalid — fix .env before starting"
  log "config OK"
fi

step "[2/4] Bring the stack up"
# `--wait` blocks on every service healthcheck, so a failed start is an
# immediate non-zero here rather than a mystery 30 seconds later.
if [ "$MODE" = "restart" ]; then
  run bash -c "cd '$COMPOSE_DIR' && docker compose -p '$BUZZ_COMPOSE_PROJECT' --env-file .env -f compose.yml -f '$BUZZ_KIT_DIR/compose.loopback.yml' -f '$BUZZ_KIT_DIR/compose.pairing.yml' restart"
else
  run bash -c "cd '$COMPOSE_DIR' && docker compose -p '$BUZZ_COMPOSE_PROJECT' --env-file .env -f compose.yml -f '$BUZZ_KIT_DIR/compose.loopback.yml' -f '$BUZZ_KIT_DIR/compose.pairing.yml' up -d --wait"
fi

step "[3/4] Health gate"
if [ "$DRY_RUN" = "1" ]; then log "[DRY_RUN] would poll /_readiness"; else
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -m 3 "http://127.0.0.1:$RELAY_PORT/_readiness" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  # NOTE: curl is used deliberately here — this is a LOCAL liveness probe, not
  # an app client. Anything in-app that dials this port must still respect
  # shared/bad-ports.ts; curl does not implement that list and will happily
  # hide a bad-port choice. The installer is where that gets caught.
  [ "$ok" = "1" ] || { compose logs --tail 40 relay >&2 || true; die "relay never became ready on :$RELAY_PORT"; }
  log "relay ready on 127.0.0.1:$RELAY_PORT"

  # Pairing sidecar: compose --wait already gated on its healthcheck; this
  # re-check from the host proves the published loopback port answers too.
  if [ -n "$PAIRING_PORT" ]; then
    pok=0
    for _ in $(seq 1 15); do
      if bash -ec "exec 3<>/dev/tcp/127.0.0.1/$PAIRING_PORT" 2>/dev/null; then pok=1; break; fi
      sleep 2
    done
    [ "$pok" = "1" ] || { compose logs --tail 20 pairing-relay >&2 || true; die "pairing-relay never answered on 127.0.0.1:$PAIRING_PORT"; }
    log "pairing-relay ready on 127.0.0.1:$PAIRING_PORT"
  else
    warn "no BUZZ_PAIRING_PORT in .env — pairing sidecar not deployed (phone pairing will 404)"
  fi
fi

step "[4/4] Tailnet front door"
if [ "$FRONT_DOOR" != "1" ]; then
  log "skipped (--no-front-door)"
elif [ -z "$HTTPS_PORT" ]; then
  warn "no https port in the registry — front door not configured"
elif [ "$DRY_RUN" = "1" ]; then
  log "[DRY_RUN] would: tailscale serve --bg --https=$HTTPS_PORT http://127.0.0.1:$RELAY_PORT"
else
  # Same shape as deploy-dev.sh step 5 for evie-ui, including the sudo -n
  # fallback: `tailscale serve` needs root unless this user is the configured
  # operator. Failure is a warning, not fatal — the stack is up either way.
  if tailscale serve status 2>/dev/null | grep -q ":$HTTPS_PORT.*127.0.0.1:$RELAY_PORT"; then
    log "tailscale serve already maps :$HTTPS_PORT -> 127.0.0.1:$RELAY_PORT"
  else
    tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$RELAY_PORT" 2>&1 | tail -3 \
      || sudo -n tailscale serve --bg --https="$HTTPS_PORT" "http://127.0.0.1:$RELAY_PORT" 2>&1 | tail -3 \
      || warn "tailscale serve failed — check: tailscale serve status"
  fi
  # Pairing path mount on the SAME https port the relay uses. Deliberately not
  # a second tailnet port: the phone is already admitted to :$HTTPS_PORT by
  # whatever tailnet ACL governs the relay, and a second port would be a second
  # ACL decision someone has to remember to make. The desktop's legacy pairing
  # fallback ALSO tries <relay>/pair, so this mount fixes that path as well.
  if [ -n "$PAIRING_PORT" ]; then
    if tailscale serve status 2>/dev/null | grep -q "/pair.*127.0.0.1:$PAIRING_PORT"; then
      log "tailscale serve already mounts :$HTTPS_PORT/pair -> 127.0.0.1:$PAIRING_PORT"
    else
      # Path mounts are --set-path on tailscale ≥1.98 (a bare `/pair` positional
      # is "invalid argument format" — measured). Keep the flag pinned here so
      # the failure mode stays diagnosable.
      tailscale serve --bg --https="$HTTPS_PORT" --set-path=/pair "http://127.0.0.1:$PAIRING_PORT" 2>&1 | tail -3 \
        || sudo -n tailscale serve --bg --https="$HTTPS_PORT" --set-path=/pair "http://127.0.0.1:$PAIRING_PORT" 2>&1 | tail -3 \
        || warn "tailscale serve /pair mount failed — check: tailscale serve status"
    fi
  fi
  tailscale serve status 2>/dev/null | head -10 || true
fi

# launchd keeps the stack up across reboots. compose already has
# `restart: unless-stopped`, so this unit's real job is "after login, make
# sure the docker runtime is awake and the project is up".
PLIST="$HOME/Library/LaunchAgents/com.dev.buzz-relay.plist"
if [ -f "$PLIST" ] && [ "$DRY_RUN" != "1" ]; then
  launchctl bootout "gui/$(id -u)/com.dev.buzz-relay" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || warn "could not bootstrap com.dev.buzz-relay"
fi

cat <<MSG

  Buzz DEV is up.
    relay      http://127.0.0.1:$RELAY_PORT
    pairing    ${PAIRING_PORT:+http://127.0.0.1:$PAIRING_PORT -> tailnet :${HTTPS_PORT:-?}/pair}
    tailnet    https://$(grep -E '^BUZZ_DOMAIN=' "$COMPOSE_DIR/.env" | cut -d= -f2-):${HTTPS_PORT:-?}
    verify     ./deploy/buzz/smoke-buzz-dev.sh
MSG

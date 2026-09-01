#!/usr/bin/env bash
# ============================================================================
# buzz-relay-dev.sh — launchd wrapper for the Buzz DEV stack on crichton.
#
# Installed to ~/.config/dev-services/ by install-buzz-dev.sh, alongside
# evie-ui's own dev launchers. It is a SEPARATE FILE with a separate label; it
# shares that directory but nothing else.
#
# ⚠️ THE SAME TRAP THAT BITES evie-ui APPLIES HERE: launchd runs the INSTALLED
#    copy of this file. Editing deploy/buzz/launchd/buzz-relay-dev.sh in the
#    repo changes nothing until install-buzz-dev.sh re-installs it. Durable
#    config belongs in this file, not on a deploy command line.
#
# launchd gives a minimal PATH and no login keychain, so the docker CLI and
# whatever provides its daemon socket have to be found explicitly.
# ============================================================================
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.docker/bin"

BUZZ_CHECKOUT="${BUZZ_CHECKOUT:-$HOME/software_development/projects/buzz}"
# Must match deploy-buzz-dev.sh — see the -p note there.
BUZZ_COMPOSE_PROJECT="${BUZZ_COMPOSE_PROJECT:-buzz-dev}"
COMPOSE_DIR="$BUZZ_CHECKOUT/deploy/compose"
LOG_DIR="${BUZZ_RUNTIME_DIR:-$HOME/.evie/buzz}"
# The loopback override lives with the kit, in the evie-ui checkout.
KIT_DIR="${BUZZ_KIT_DIR:-$HOME/software_development/projects/buzz/deploy/dev-kit}"
mkdir -p "$LOG_DIR"

say() { printf '[%s] [buzz-relay-dev] %s\n' "$(date -u +%FT%TZ)" "$*"; }

[ -f "$COMPOSE_DIR/.env" ] || { say "FATAL: no $COMPOSE_DIR/.env — run install-buzz-dev.sh"; exit 1; }

# MEASURED 2026-08-23 on crichton: the docker provider is DOCKER DESKTOP
# (/usr/local/bin/docker -> /Applications/Docker.app). colima and OrbStack are
# NOT installed, so their branches were removed. Docker Desktop starts at login
# on its own, but this unit can win the race against the daemon, so wait rather
# than fail fast — and nudge the app if it is not coming.
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if [ "$i" = "1" ]; then
    say "docker not reachable yet; waiting (up to 5 min)"
    if [ -d /Applications/Docker.app ]; then
      say "attempting: open -a Docker"
      /usr/bin/open -a Docker >/dev/null 2>&1 || true
    fi
  fi
  sleep 5
done
docker info >/dev/null 2>&1 || { say "FATAL: docker daemon never became reachable"; exit 1; }

cd "$COMPOSE_DIR"
say "bringing up compose project (up -d --wait)"
exec docker compose -p "$BUZZ_COMPOSE_PROJECT" --env-file .env -f compose.yml -f "$KIT_DIR/compose.loopback.yml" up --wait

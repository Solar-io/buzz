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
# Boot-time overlay list. This MUST stay in step with COMPOSE_FILES in
# deploy/dev-kit/deploy-buzz-dev.sh — a file present in one and not the other
# means the stack a reboot brings up differs from the stack a deploy brings up,
# silently. It has already drifted twice: compose.web.yml was added to the
# INSTALLED copy on 2026-08-29 and never committed to the repo copy, so the
# next install-buzz-dev.sh would have reverted it (and the deploy script's own
# comment records that this exact omission caused the 2026-09-01 outage); and
# compose.pairing.yml plus compose.push-gateway.yml were never here at all.
#
# Each is guarded by `[ -f ]` rather than listed unconditionally: this runs at
# login with nobody watching, and an overlay missing from the checkout should
# degrade to a smaller stack rather than fail the whole boot.
#
# if/then, NOT `[ -f x ] && arr+=(...)`: under `set -e` a false test makes the
# compound return 1 and takes the whole script with it.
EXTRA_COMPOSE=()
if [ -f compose.web.yml ]; then
  EXTRA_COMPOSE+=(-f compose.web.yml)
fi
if [ -f "$KIT_DIR/compose.pairing.yml" ]; then
  EXTRA_COMPOSE+=(-f "$KIT_DIR/compose.pairing.yml")
fi
if [ -f compose.push-gateway.yml ]; then
  EXTRA_COMPOSE+=(-f compose.push-gateway.yml)
fi
say "bringing up compose project (up -d --wait)"
exec docker compose -p "$BUZZ_COMPOSE_PROJECT" --env-file .env -f compose.yml -f "$KIT_DIR/compose.loopback.yml" ${EXTRA_COMPOSE[@]+"${EXTRA_COMPOSE[@]}"} up --wait

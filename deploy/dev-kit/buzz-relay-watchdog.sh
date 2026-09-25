#!/usr/bin/env bash
# ============================================================================
# buzz-relay-watchdog.sh — periodic liveness check for the Buzz DEV relay.
#
# Installed to ~/.config/dev-services/ by install-buzz-dev.sh, next to
# buzz-relay-dev.sh, and driven by launchd (com.dev.buzz-relay-watchdog) on a
# StartInterval. ⚠️ SAME TRAP as the supervisor: launchd runs the INSTALLED
# copy. Editing the repo copy changes nothing until install-buzz-dev.sh runs.
#
# WHY THIS EXISTS (2026-09-25). com.dev.buzz-relay is RunAtLoad-only and
# compose carries `restart: unless-stopped`, so between them the stack survives
# login and container crashes. Neither covers the case that actually happened:
# Docker Desktop itself went away (quit from its own UI at 00:24 local, no
# crash, no reboot), taking every container with it. The desktop app and all
# 23 buzz-acp agents stayed up and simply logged
# `relay reconnect failed: HTTP error: 502` every 53s for six hours. Nothing
# noticed until a human asked.
#
# SCOPE: detect and repair the two layers below the relay — the Docker daemon
# and the compose project. It deliberately does NOT touch the desktop app, the
# agents, or the tailscale front door: the agents reconnect on their own once
# the relay answers (measured: all seats resubscribed within ~90s), and a
# front-door failure needs `tailscale serve` judgment rather than a blind
# restart, so it is reported and left alone.
# ============================================================================
set -euo pipefail

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.docker/bin"

BUZZ_CHECKOUT="${BUZZ_CHECKOUT:-$HOME/software_development/projects/buzz}"
KIT_DIR="${BUZZ_KIT_DIR:-$BUZZ_CHECKOUT/deploy/dev-kit}"
LOG_DIR="${BUZZ_RUNTIME_DIR:-$HOME/.evie/buzz}"
STATE_DIR="$LOG_DIR/watchdog"

RELAY_URL="${BUZZ_RELAY_URL:-http://127.0.0.1:6350}"
FRONT_DOOR="${BUZZ_FRONT_DOOR:-https://crichton.tailb3d4b8.ts.net:6351}"

# Flap guard. A watchdog that repairs on every tick during a genuine outage
# turns one broken thing into a restart loop, and the restart loop is harder to
# diagnose than the outage. Cap repairs per rolling window and then go quiet
# except for the log line saying so.
MAX_REPAIRS="${BUZZ_WATCHDOG_MAX_REPAIRS:-3}"
REPAIR_WINDOW_SECS="${BUZZ_WATCHDOG_REPAIR_WINDOW:-3600}"

# How long to wait for each layer to come back before declaring the repair
# failed. Docker Desktop cold start measured at ~15s on crichton; the compose
# project comes up in well under a minute with `--wait`.
DOCKER_WAIT_SECS="${BUZZ_WATCHDOG_DOCKER_WAIT:-180}"
RELAY_WAIT_SECS="${BUZZ_WATCHDOG_RELAY_WAIT:-120}"

mkdir -p "$LOG_DIR" "$STATE_DIR"

say() { printf '[%s] [buzz-relay-watchdog] %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Optional notification. Left as an env-provided webhook rather than wired to a
# secret store on purpose: this script runs precisely when the machine is in a
# bad state, so it must not depend on anything that can itself be down.
# NOTE the User-Agent — Cloudflare 403s the default curl/urllib UA on Discord.
notify() {
  local msg="$1"
  [ -n "${BUZZ_WATCHDOG_WEBHOOK:-}" ] || return 0
  curl -fsS --max-time 5 \
    -H 'Content-Type: application/json' \
    -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' \
    -d "$(printf '{"content":%s}' "$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g; s/^/"/; s/$/"/')")" \
    "$BUZZ_WATCHDOG_WEBHOOK" >/dev/null 2>&1 || say "notify failed (non-fatal)"
}

docker_ok() { docker info >/dev/null 2>&1; }

relay_ok() {
  [ "$(curl -s -m 5 "$RELAY_URL/_liveness" 2>/dev/null)" = "ok" ]
}

front_door_ok() {
  [ "$(curl -sk -m 8 -o /dev/null -w '%{http_code}' "$FRONT_DOOR/_liveness" 2>/dev/null)" = "200" ]
}

# ── Flap guard helpers ──────────────────────────────────────────────────────
# One line per repair attempt, epoch seconds. Entries older than the window are
# dropped on read, so the file never needs pruning elsewhere.
repairs_in_window() {
  local ledger="$STATE_DIR/repairs" now cutoff
  [ -f "$ledger" ] || { echo 0; return; }
  now=$(date +%s)
  cutoff=$((now - REPAIR_WINDOW_SECS))
  awk -v c="$cutoff" '$1 > c' "$ledger" > "$ledger.tmp" 2>/dev/null || : > "$ledger.tmp"
  mv "$ledger.tmp" "$ledger"
  wc -l < "$ledger" | tr -d ' '
}

record_repair() { date +%s >> "$STATE_DIR/repairs"; }

# ── Repair steps ────────────────────────────────────────────────────────────
start_docker() {
  [ -d /Applications/Docker.app ] || { say "FATAL: /Applications/Docker.app missing"; return 1; }
  say "docker daemon unreachable; launching Docker Desktop"
  /usr/bin/open -a Docker >/dev/null 2>&1 || true
  local waited=0
  while [ "$waited" -lt "$DOCKER_WAIT_SECS" ]; do
    sleep 5; waited=$((waited + 5))
    if docker_ok; then say "docker reachable after ${waited}s"; return 0; fi
  done
  say "FATAL: docker still unreachable after ${DOCKER_WAIT_SECS}s"
  return 1
}

start_relay() {
  say "relay not answering on $RELAY_URL; running deploy-buzz-dev.sh --restart-only"
  if ! "$KIT_DIR/deploy-buzz-dev.sh" --restart-only >>"$LOG_DIR/buzz-relay-watchdog.repair.log" 2>&1; then
    say "deploy-buzz-dev.sh --restart-only exited non-zero (see buzz-relay-watchdog.repair.log)"
  fi
  local waited=0
  while [ "$waited" -lt "$RELAY_WAIT_SECS" ]; do
    if relay_ok; then say "relay healthy after ${waited}s"; return 0; fi
    sleep 5; waited=$((waited + 5))
  done
  say "FATAL: relay still not answering after ${RELAY_WAIT_SECS}s"
  return 1
}

# ── Main ────────────────────────────────────────────────────────────────────
# Happy path is silent apart from nothing at all: a watchdog that logs a line
# every tick buries the ticks that matter. Only degraded states and repairs are
# written, so any content in this log is a real event.
healthy=true
docker_ok || healthy=false
if $healthy; then relay_ok || healthy=false; fi

if $healthy; then
  # Clear the "currently down" marker so the next outage is reported as new.
  rm -f "$STATE_DIR/down-since"
  # The front door is checked only when the relay itself is fine, because a
  # dead relay makes :6351 fail too and would double-report one fault.
  if ! front_door_ok; then
    say "WARN: relay is healthy on $RELAY_URL but front door $FRONT_DOOR is not 200 — tailscale serve, see IF_BUZZ_IS_BROKEN.md §3.3 (not auto-repaired)"
    notify "⚠️ Buzz: relay healthy but tailnet front door :6351 is down (needs \`tailscale serve\` attention)"
  fi
  exit 0
fi

[ -f "$STATE_DIR/down-since" ] || date -u +%FT%TZ > "$STATE_DIR/down-since"
down_since=$(cat "$STATE_DIR/down-since" 2>/dev/null || echo unknown)

attempts=$(repairs_in_window)
if [ "$attempts" -ge "$MAX_REPAIRS" ]; then
  say "DEGRADED since $down_since; $attempts repairs already attempted in the last ${REPAIR_WINDOW_SECS}s — standing down, needs a human"
  exit 0
fi

record_repair
say "unhealthy (down since $down_since); repair attempt $((attempts + 1))/$MAX_REPAIRS"

if ! docker_ok && ! start_docker; then
  notify "🔴 Buzz relay DOWN: Docker daemon unreachable and Docker Desktop would not start. Agents cannot reach the relay."
  exit 1
fi

if relay_ok; then
  say "relay recovered once docker was back; no compose restart needed"
  notify "✅ Buzz relay recovered: Docker Desktop was down and has been restarted."
  rm -f "$STATE_DIR/down-since"
  exit 0
fi

if start_relay; then
  say "repair succeeded"
  notify "✅ Buzz relay recovered by watchdog (was down since $down_since)."
  rm -f "$STATE_DIR/down-since"
  exit 0
fi

notify "🔴 Buzz relay DOWN since $down_since and the watchdog could not bring it back. See ~/.evie/buzz/buzz-relay-watchdog.log"
exit 1

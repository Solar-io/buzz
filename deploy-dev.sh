#!/usr/bin/env bash
# ============================================================================
# deploy-dev.sh — the standard fleet entry point for the Buzz DEV stack.
#
# This is a THIN DISPATCHER, not a second deploy implementation. The real work
# has always lived in deploy/dev-kit/deploy-buzz-dev.sh, which knows the five
# layered compose files, the front door and the health gate; duplicating any of
# that here is how the two drift and how the 2026-09-01 outage happened. Every
# stack flag is passed straight through.
#
# WHY IT EXISTS (2026-09-25). Two reasons, both about the entry point rather
# than the deploy:
#
#   1. Fleet convention is `<repo>/deploy-dev.sh`. Buzz kept its script under
#      deploy/dev-kit/, so every tool that looks for the standard name missed
#      it — including ~/.claude/hooks/pre-deploy-validation.sh, which refuses
#      `launchctl bootstrap` in a repo with no root-level deploy-dev.sh. That
#      made the launchd units un-loadable by an agent, which is exactly how
#      com.dev.buzz-relay-watchdog ended up installed-but-not-running.
#
#   2. Nothing owned "make sure the launchd units are LOADED". install-buzz-dev.sh
#      writes the plists and says so; deploy-buzz-dev.sh brings up compose. The
#      gap between them was silent, and a watchdog that is not loaded is a
#      watchdog that does not exist.
#
# Usage:
#   ./deploy-dev.sh                  # load launchd units, then full dev deploy
#   ./deploy-dev.sh --restart-only   # bounce the stack, no rebuild
#   ./deploy-dev.sh --detach-status  # READ-ONLY status; touches nothing
#   ./deploy-dev.sh --units-only     # only reconcile the launchd units
#   ./deploy-dev.sh --stop|--status|--dry-run|--no-front-door   # passthrough
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$REPO_ROOT/deploy/dev-kit"
STACK_SCRIPT="$KIT_DIR/deploy-buzz-dev.sh"
RELAY_URL="${BUZZ_RELAY_URL:-http://127.0.0.1:6350}"

UNITS=(com.dev.buzz-relay com.dev.buzz-relay-watchdog)

say() { printf '[deploy-dev] %s\n' "$*"; }

# ── READ-ONLY STATUS, HANDLED FIRST ─────────────────────────────────────────
# This early-exit block is load-bearing beyond convenience: the deploy guard's
# allowlist (deploy_flags_are_inert) greps THIS FILE for exactly this shape
# before it will treat `--detach-status` as inert. Keep the spelling
# `if [ "$_arg" = "--detach-status" ]`, keep it before any mutation, and keep
# the handler genuinely read-only — it reads state and prints, nothing else.
for _arg in "$@"; do
  if [ "$_arg" = "--detach-status" ]; then
    printf 'relay      : %s\n' "$(curl -s -m 5 "$RELAY_URL/_liveness" 2>/dev/null || echo unreachable)"
    printf 'readiness  : %s\n' "$(curl -s -m 5 "$RELAY_URL/_readiness" 2>/dev/null || echo unreachable)"
    for _u in "${UNITS[@]}"; do
      if launchctl list 2>/dev/null | grep -q "[[:space:]]$_u\$"; then
        printf 'unit       : %s loaded\n' "$_u"
      else
        printf 'unit       : %s NOT LOADED\n' "$_u"
      fi
    done
    exit 0
  fi
done

# ── Launchd units ───────────────────────────────────────────────────────────
# Idempotent by design: this runs on every deploy, so "already loaded" is the
# normal case and must not be an error. bootstrap returns 5 (EALREADY) for an
# already-loaded label; that is success here, not failure.
reconcile_units() {
  local uid plist rc loaded=0 booted=0
  uid="$(id -u)"
  for u in "${UNITS[@]}"; do
    plist="$HOME/Library/LaunchAgents/$u.plist"
    if [ ! -f "$plist" ]; then
      say "WARN: $plist missing — run ./deploy/dev-kit/install-buzz-dev.sh to write it; skipping"
      continue
    fi
    if launchctl list 2>/dev/null | grep -q "[[:space:]]$u\$"; then
      loaded=$((loaded + 1))
      continue
    fi
    set +e
    launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null
    rc=$?
    set -e
    if [ "$rc" -eq 0 ] || [ "$rc" -eq 5 ]; then
      say "loaded $u"
      booted=$((booted + 1))
    else
      say "WARN: could not load $u (launchctl rc=$rc)"
    fi
  done
  say "launchd units: $loaded already loaded, $booted newly loaded"
}

UNITS_ONLY=0
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --units-only) UNITS_ONLY=1 ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

[ -x "$STACK_SCRIPT" ] || { say "FATAL: $STACK_SCRIPT missing or not executable"; exit 1; }

reconcile_units

if [ "$UNITS_ONLY" = "1" ]; then
  say "--units-only: not touching the stack"
  exit 0
fi

say "delegating to deploy/dev-kit/deploy-buzz-dev.sh ${PASSTHROUGH[*]:-(full deploy)}"
exec "$STACK_SCRIPT" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

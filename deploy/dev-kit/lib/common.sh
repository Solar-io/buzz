#!/usr/bin/env bash
# ============================================================================
# deploy/buzz/lib/common.sh — shared helpers for the Buzz install/deploy kit.
#
# 🔴 THIS KIT IS NEW AND UNRUN ON CRICHTON. Every value marked GUESS in
#    deploy/buzz/README.md is a best guess made while Sam was away
#    (2026-08-23). Fix them, don't trust them.
#
# SCOPE: this kit reconciles the BUZZ stack ONLY — `com.dev.buzz-*` labels and
# the compose project named by $BUZZ_COMPOSE_PROJECT. It never touches
# `com.dev.evie-*`, `com.prod.*`, or either evie-ui checkout.
#
# Verified (2026-08-23, this repo): `deploy-dev.sh` boots out ENUMERATED
# `com.dev.evie-*` labels, never a `com.dev.*` wildcard. So an evie dev deploy
# cannot bounce the Buzz stack, and vice versa. Keep it that way: if you ever
# add a wildcard bootout to either side, these two become coupled.
# ============================================================================
set -euo pipefail

BUZZ_KIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIE_REPO_ROOT="$(cd "$BUZZ_KIT_DIR/../.." && pwd)"

# --- GUESS: fleet-standard paths. Confirm on crichton. ----------------------
BUZZ_CHECKOUT="${BUZZ_CHECKOUT:-$HOME/software_development/projects/buzz}"
BUZZ_RUNTIME_DIR="${BUZZ_RUNTIME_DIR:-$HOME/.evie/buzz}"
BUZZ_COMPOSE_PROJECT="${BUZZ_COMPOSE_PROJECT:-buzz-dev}"
PORT_REGISTRY="${PORT_REGISTRY:-$HOME/software_development/infra/port-registry.json}"
BUZZ_REPO_URL="${BUZZ_REPO_URL:-https://github.com/block/buzz.git}"

# Pin. `:main` is a moving tag; a deploy that cannot name what it deployed
# cannot be rolled back. Override with BUZZ_IMAGE to advance it deliberately.
# Digest measured 2026-08-23 in a Linux container. RE-VERIFIED on crichton
# (darwin/arm64) the same day: `docker manifest inspect` on this digest returns
# an OCI image index carrying BOTH linux/arm64 and linux/amd64 manifests, so
# the pin resolves on this host. No change needed.
BUZZ_IMAGE_DEFAULT='ghcr.io/block/buzz@sha256:5c2b1b0ecc3b405291b3b715c466d960097c460de2e5ee26bb8524a2979a1344'

log()  { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '  WARNING: %s\n' "$*" >&2; }
die()  { printf '\nFATAL: %s\n' "$*" >&2; exit 1; }

DRY_RUN="${DRY_RUN:-0}"
run() {
  if [ "$DRY_RUN" = "1" ]; then printf '  [DRY_RUN] %s\n' "$*"; return 0; fi
  "$@"
}

# ── Guards ─────────────────────────────────────────────────────────────────
# Refuse under the finalize hook. Rationale is the same as deploy-dev.sh's
# --detach refusal: the hook's turn has already ended, the hook holds a
# per-repo finalize lock, and standing up a container stack is not something
# an auto-finalize should ever do as a side effect of a push.
guard_not_finalize_hook() {
  [ "${CLAUDE_FINALIZE_HOOK:-}" = "1" ] || return 0
  die "refusing under CLAUDE_FINALIZE_HOOK=1. Buzz is never deployed by an auto-finalize; run it by hand."
}

# Refuse under a test runner. Polarity is FAIL-CLOSED, matching
# deploy/lib/test-interlock.sh: a false proceed stands up (or tears down) a
# real stack, so unreadable ancestry refuses. See CLAUDE.md.
guard_not_under_test() {
  [ "${EVIE_BUZZ_TEST_INTERLOCK_OVERRIDE:-}" = "yes-i-am-really-deploying" ] && return 0
  if [ -n "${BUN_TEST:-}" ] || [ -n "${VITEST:-}" ] || [ -n "${JEST_WORKER_ID:-}" ] \
     || [ "${NODE_ENV:-}" = "test" ]; then
    die "refusing under a test runner. This script mutates a real container stack."
  fi
  if [ -x "$EVIE_REPO_ROOT/deploy/lib/test-interlock.sh" ]; then
    # Reuse evie-ui's hardened detector when present rather than growing a
    # second implementation of the same guard.
    # shellcheck disable=SC1091
    . "$EVIE_REPO_ROOT/deploy/lib/test-interlock.sh" 2>/dev/null || true
  fi
  return 0
}

need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }

# ── Docker on macOS ────────────────────────────────────────────────────────
# crichton is macOS. There is no system dockerd; it is Docker Desktop, colima,
# OrbStack or nothing. Detect and say which, because "docker: command not
# found" three layers down is a bad way to learn this.
detect_docker() {
  need docker
  if ! docker info >/dev/null 2>&1; then
    local hint="start Docker Desktop"
    command -v colima   >/dev/null 2>&1 && hint="run: colima start"
    command -v orbctl   >/dev/null 2>&1 && hint="start OrbStack"
    die "docker daemon is not reachable — $hint"
  fi
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin not available (need >= 2.24.4)"
}

# ── Ports ──────────────────────────────────────────────────────────────────
# HOUSE RULE (BUILD_PROMPT.md, AGENTS.md): "never GUESS or HARDCODE a new
# allocation" — and the `new-project` skill says what to do instead: "allocate
# the next valid project block without collisions; patch the registry
# atomically." So this kit ALLOCATES. It does not guess (the block comes from
# the registry's own free space, collision-checked against every port already
# recorded) and it does not hardcode (nothing is baked into this file).
#
# An earlier version of this kit REFUSED here and told the human to allocate by
# hand. That was a misreading of the rule as a prohibition, and it is the reason
# the first install never ran.
# Allocate the buzz block if it does not exist yet. Idempotent: an existing
# block is returned untouched — silently MOVING a live service's ports would be
# far worse than any collision this could avoid.
ensure_port_block() {
  [ -f "$PORT_REGISTRY" ] || die "port registry not found: $PORT_REGISTRY"
  need jq
  jq -e '.project_port_blocks.buzz' "$PORT_REGISTRY" >/dev/null 2>&1 && return 0
  [ "${BUZZ_NO_ALLOCATE:-0}" = "1" ] && die "no buzz block in $PORT_REGISTRY and BUZZ_NO_ALLOCATE=1"
  log "no buzz block yet — allocating one (collision-checked, atomic, backed up)"
  # NOT `${DRY_RUN:+--dry-run}` — that expands whenever DRY_RUN is set and
  # NON-EMPTY, and "0" is non-empty. It silently made every real install a dry
  # run, so the block was computed, printed, and never written.
  local dry=""
  [ "$DRY_RUN" = "1" ] && dry="--dry-run"
  local out
  out="$(bun "$BUZZ_KIT_DIR/lib/allocate-ports.ts" "$PORT_REGISTRY" $dry)" \
    || die "port allocation failed"
  printf '%s\n' "$out" | sed 's/^/    /'
}

registry_port() { # $1 = json key under .project_port_blocks.buzz
  [ -f "$PORT_REGISTRY" ] || die "port registry not found: $PORT_REGISTRY"
  need jq
  local v; v="$(jq -r --arg k "$1" '.project_port_blocks.buzz[$k] // empty' "$PORT_REGISTRY")"
  [ -n "$v" ] || die "no .project_port_blocks.buzz.$1 in $PORT_REGISTRY (run install-buzz-dev.sh, which allocates)"
  printf '%s' "$v"
}

# THE :6000 TRAP, generalised. evie-ui's dev front door is :6001 while the app
# binds :6000 because 6000 is on the WHATWG bad-ports list — Chromium refuses
# it with ERR_UNSAFE_PORT and node's own fetch refuses it with "bad port".
# curl does NOT implement the list, so a hand check says everything is fine.
# The list is already measured in shared/bad-ports.ts; read it from there
# rather than retyping it, so there is one copy.
assert_not_bad_port() { # $1 = port, $2 = what it is for
  local port="$1" what="${2:-port}"
  local bad
  bad="$(cd "$EVIE_REPO_ROOT" && bun -e '
    import { isBadPort } from "./shared/bad-ports.ts";
    process.stdout.write(isBadPort(Number(process.argv[1])) ? "1" : "0");
  ' "$port" 2>/dev/null || echo "?")"
  case "$bad" in
    1) die "$what port $port is on the WHATWG bad-ports list — browsers AND node fetch refuse it (curl will not tell you). Pick another." ;;
    0) : ;;
    *) warn "could not evaluate bad-port status for $port (bun/shared-bad-ports unavailable); verify by hand" ;;
  esac
}

port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

assert_port_free() {
  port_free "$1" || die "port $1 is already in use — $(lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | tail -1)"
}

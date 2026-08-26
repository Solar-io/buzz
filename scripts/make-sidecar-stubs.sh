#!/usr/bin/env bash
# Debug-run helper: tauri's build.rs refuses to compile without the sidecar
# binaries present. For a `pnpm tauri dev` spike the sidecars are never
# spawned, so empty stubs are enough. NOT used for release builds — run
# scripts/bundle-sidecars.sh for those. Run from the repo root: scripts/make-sidecar-stubs.sh (binaries/ is gitignored).
set -euo pipefail
cd "$(dirname "$0")"
for b in buzz buzz-acp buzz-agent buzz-backend-kubernetes buzz-dev-mcp git-credential-nostr; do
  touch "${b}-aarch64-apple-darwin"
done
echo "stubs created"

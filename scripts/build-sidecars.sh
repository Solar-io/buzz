#!/usr/bin/env bash
# Compile the real sidecar binaries and copy them into desktop/src-tauri/binaries.
#
# This exists because `touch`ing the sidecar paths is enough to satisfy Tauri's
# externalBin check: a stubbed release bundle builds, signs and launches while
# every sidecar inside it is a zero-byte file. Release bundles must use this
# script; scripts/make-sidecar-stubs.sh is only for check/clippy/test runs.
#
# Crate list mirrors the "Build sidecars" step in .github/workflows/release.yml.
set -euo pipefail

# bundle-sidecars.sh and cargo's target/ layout are both relative to the repo
# root, so anchor there rather than trusting the caller's cwd.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$script_dir/.."

HOST=$(rustc -vV | sed -n 's|host: ||p')
TARGET=${1:-$HOST}

CRATES=(buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz-cli)
if [[ "$TARGET" != *windows* ]]; then
    CRATES+=(buzz-backend-kubernetes)
fi

args=()
for crate in "${CRATES[@]}"; do
    args+=(-p "$crate")
done

echo "Building sidecars for $TARGET: ${CRATES[*]}"
cargo build --release --target "$TARGET" "${args[@]}"

"$script_dir/bundle-sidecars.sh" "$TARGET"

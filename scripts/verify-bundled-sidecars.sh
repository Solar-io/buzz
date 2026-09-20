#!/usr/bin/env bash
# Prove the sidecars INSIDE a built macOS .app are the binaries we just compiled.
#
# The failure this guards against is silent: Tauri accepts zero-byte sidecar
# placeholders, and a bundle carrying a stale or empty buzz-acp launches and
# looks healthy while the agent harness is missing or from another build.
# mtime cannot tell you this (`touch` sets it); only the bytes can.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$script_dir/.."

HOST=$(rustc -vV | sed -n 's|host: ||p')
TARGET=${1:-$HOST}

if [[ "$TARGET" != *apple-darwin* ]]; then
    echo "verify-bundled-sidecars: only macOS bundles are checked; skipping $TARGET"
    exit 0
fi

APP="desktop/src-tauri/target/${TARGET}/release/bundle/macos/Buzz.app"
SRC_DIR="target/${TARGET}/release"
SIDECARS=(buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz buzz-backend-kubernetes)

if [[ ! -d "$APP" ]]; then
    echo "Error: no app bundle at $APP" >&2
    exit 1
fi

failed=0
for bin in "${SIDECARS[@]}"; do
    bundled="$APP/Contents/MacOS/$bin"
    built="$SRC_DIR/$bin"
    if [[ ! -s "$bundled" ]]; then
        echo "FAIL $bin: missing or empty inside the bundle" >&2
        failed=1
        continue
    fi
    if [[ ! -f "$built" ]]; then
        echo "FAIL $bin: no freshly built binary at $built to compare against" >&2
        failed=1
        continue
    fi
    if cmp -s "$bundled" "$built"; then
        echo "ok   $bin ($(shasum -a 256 "$bundled" | cut -c1-12))"
    else
        echo "FAIL $bin: bundled copy differs from $built (stale sidecar)" >&2
        failed=1
    fi
done

if [[ $failed -ne 0 ]]; then
    echo "Bundled sidecars do not match this build. Do not ship this bundle." >&2
    exit 1
fi
echo "All sidecars in $APP match this build."

#!/usr/bin/env bash
# Prints the effective iOS bundle identifier prefix for this checkout.
#
# The tracked default lives in mobile/ios/Flutter/Debug.xcconfig as
# BUNDLE_ID_PREFIX. A downstream/internal build overrides it by writing
# BUNDLE_ID_PREFIX (or, for the older documented spelling, BUNDLE_IDENTIFIER)
# into the gitignored mobile/ios/Flutter/AppOverrides.xcconfig, which both
# xcconfigs #include? last.
#
# Scripts that need to name installed apps (worktree identity, cleanup) must
# resolve the prefix through here rather than hardcoding it, or they silently
# stop matching the moment a checkout overrides the identifier.
set -euo pipefail

prefix_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
flutter_dir="$prefix_repo_root/mobile/ios/Flutter"

read_setting() {
    # $1: file, $2: setting name. Prints the value, or nothing.
    [[ -f "$1" ]] || return 0
    sed -n "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*\(.*[^[:space:]]\)[[:space:]]*$/\1/p" "$1" | tail -n 1
}

value="$(read_setting "$flutter_dir/AppOverrides.xcconfig" BUNDLE_ID_PREFIX)"
[[ -n "$value" ]] || value="$(read_setting "$flutter_dir/AppOverrides.xcconfig" BUNDLE_IDENTIFIER)"
[[ -n "$value" ]] || value="$(read_setting "$flutter_dir/Debug.xcconfig" BUNDLE_ID_PREFIX)"

if [[ -z "$value" ]]; then
    echo "mobile-bundle-id-prefix: no BUNDLE_ID_PREFIX in $flutter_dir/Debug.xcconfig" >&2
    exit 2
fi
printf '%s\n' "$value"

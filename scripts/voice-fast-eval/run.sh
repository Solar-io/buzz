#!/usr/bin/env bash
# Voice fast lane handoff eval (VOICE_FAST_PATH_2026-10-07 §9 AC4, WP4).
# Test tooling, not shipped. Makes 30 small live calls to OmniRoute.
#
# Usage: scripts/voice-fast-eval/run.sh [persona-file]
#   persona-file  the agent's system prompt (e.g. Kaiya's, exported from the
#                 desktop's managed-agents.json). Omit to eval the rules alone.
# Env passthrough: BUZZ_VOICE_FAST_BASE_URL, BUZZ_VOICE_FAST_PROBE_AGENT,
#                  BUZZ_VOICE_FAST_MODEL, BUZZ_VOICE_FAST_API_KEY.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ "${1:-}" != "" ]; then
  export BUZZ_VOICE_FAST_EVAL_PERSONA="$1"
fi
exec cargo test -p buzz-acp --lib voice_fast_handoff_eval -- --ignored --nocapture

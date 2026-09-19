# One-click web DM voice calls

Sam's 2026-09-19 request replaces the web room-selection flow with a Call
button in a one-to-one agent DM. Private TTL rooms remain transport details;
the permanent DM must never become the audio room because room shutdown
archives the transport channel.

## Completed behavior

- [x] Resolve exactly one known agent from the selected one-to-one DM.
- [x] One click creates the private room, joins audio, admits that agent,
  confirms the roster, and enables voice and spoken replies automatically.
- [x] Keep the DM selected; remove channel huddle creation, room sidebar
  navigation, and separate join/agent-selection steps.
- [x] Preserve per-agent voice, dock/floating controls, mute, leave, and
  navigation during the call.
- [x] Reject duplicate/concurrent starts, surface failed setup, and prevent
  cancelled microphone continuations from taking over a newer call.
- [x] Retry transient relay admission limits with the same signed event,
  bounded retries, the server's delay, and cancellation checks.

## Evidence

Source commits: `a97c114654` and `d8f9168e54`. The full web package suite
passed 2,567 tests; TypeScript and the production build passed. Disabling
the wrong-agent guard made its named regression test fail, then restoring
the guard returned the focused suite to 6/6.

Muted, headed Chromium against the real relay exercised one click through
microphone audio, STT, the hidden-room transcript with the exact agent
mention, a deterministic agent reply, and TTS playback capture. The DM URL
remained unchanged and Leave removed the call controls. A same-tick double
click produced one unique room. Microphone denial produced a visible
error and no active call. A normal channel exposed no call/join controls.
The served `index-CpMzlAOd.js` bundle also passed the complete voice loop.

Local receipts are retained under `logs/dm-call-20260919/`, including
`served-happy-final.json`, `d8f9168-duplicate.json`, and
`web-tests-d8f9168.log`. These are synthetic desktop-browser checks;
they do not establish physical iPhone behavior or real-agent response latency.

Sam separately authorized the relay setting
`BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=50`, corresponding to 250
WebSocket requests/events per five-second window per identity. Separate
message-per-minute limits are unchanged. The relay used the same image,
passed voice gates before and after recreation, and accepted 60 read-only
COUNT requests in 0.058 seconds with no rate refusals. Configuration and
database backups were taken before that operational change.

The scheduled voice regression harness must use this DM entry point;
the old channel-huddle interaction is intentionally no longer a web path.

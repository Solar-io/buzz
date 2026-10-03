# Fish audio P4 native iOS

Native Fish voices now use the same selection, owner-assignment, channel-override and TTS bridge paths as ElevenLabs. The contract remains channel override > owner 30183 > agent 30182 > derived Chatterbox.

Scope: plan §4.9, in `claude/fish-ios-native`, based on P2 `e06e30927`. Source commit: `70461e54c`. Root `AGENTS.md`, `VISION.md`, `VISION_AGENT.md`, root testing guidance and `ios-web/native/TESTING.md` apply; this checkout has no iOS path-local `AGENTS.md`.

## Files and behavior

- `ios-web/native/Sources/BuzzNative/NativeVoicePolicy.swift`: admit `fish:` plus 16–64 ASCII alphanumeric characters in the shared 30182/30183 body parser. Both cloud-key patterns use strict `\z` end anchors.
- `ios-web/native/Sources/BuzzNative/NativeAgentVoice.swift`: admit Fish channel overrides; extract the existing effective-route calculation into `bridgeVoice(for:)`, called by `playNext()` and exercised through the real override setter. The bridge still receives the engine and unprefixed voice id.
- `ios-web/native/Tests/BuzzNativeTests/NativeBehaviorTests.swift`: six new tests, reading P2's unchanged `test-fixtures/voice/voice-key-grammar.json`. Each accepted key exercises selection, assignment, prefix splitting and bridge routing. Reject cases reach both parsers as serialized raw keys, including newline/Unicode values. Counts are hardcoded: Fish 4 accept/19 reject; ElevenLabs 4 accept/18 reject.
- `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`: P4 checklist and handoff evidence.

## Runner and counts

Xcode 26.6 / build 17F113 on crichton. The documented standalone package scheme uses the existing dedicated simulator `Buzz Capacitor QA call-link` on iOS 26.5:

```sh
cd ios-web/native
xcodebuild -scheme BuzzNative \
  -destination 'platform=iOS Simulator,id=9775DF01-8E72-4E52-9900-E6D6B5CA0E9B' \
  -derivedDataPath ../build-fish-p4 \
  -parallel-testing-enabled NO CODE_SIGN_IDENTITY=- test
```

| Run | Discovered | Passed | Skipped | Assertion failures | Result |
|---|---:|---:|---:|---:|---|
| P2 baseline | 40 | 31 | 9 | 0 | `TEST SUCCEEDED` |
| Strict-anchor implementation | 46 | 37 | 9 | 0 | `TEST SUCCEEDED` |
| Restored after all four mutations | 46 | 37 | 9 | 0 | `TEST SUCCEEDED` |

`NativeVoicePolicyTests` grows from 11 to 17 passing tests with no skips. All six new tests run. The nine unchanged skips are eight app-host-dependent Keychain/app-shell cases plus the physical read-only smoke case. A standalone runner does not establish app-hosted Keychain or physical playback acceptance; no physical-device build/install, deployment or push is part of this phase.

## Mutation proof

Each mutation starts from committed source, runs the complete package suite and restores the exact original bytes with a fresh mtime. All mutants exit 65, retain 46 discovered tests and nine skips, and fail the named behavior test rather than compilation. The restored full suite exits 0.

| Mutation | Named failed test in `NativeVoicePolicyTests` | Assertion failures | Receipt |
|---|---|---:|---|
| Remove Fish parser admission | `testFishVoiceGrammarAcceptsSharedVectors` | 1 | `logs/fish-ios-mutation-admission.log` |
| Loosen Fish id grammar to `.+` | `testFishVoiceGrammarRejectsSharedVectors` | 24 | `logs/fish-ios-mutation-grammar.log` |
| Remove Fish from the native override engine list | `testFishChannelOverrideUsesNativeBridgeRouteAndClears` | 2 | `logs/fish-ios-mutation-override.log` |
| Revert both cloud-key end anchors to `$` | `testFishVoiceGrammarRejectsSharedVectors`, `testElevenVoiceGrammarRejectsSharedVectors` | 8 | `logs/fish-ios-mutation-end-anchor.log` |

Each log has a matching `logs/fish-ios-mutation-*.diff`. Complete output is collected in the project's `logs/verification.log`; baseline, fixed and restored logs are `logs/fish-ios-baseline.log`, `logs/fish-ios-fixed.log` and `logs/fish-ios-restored.log`. Xcode result bundles are retained under `logs/fish-ios-xcresults/` after removing generated build artifacts.

## Bug and implementation adjustment

The new shared reject tests initially fail against simulator Foundation: `$` accepts an otherwise valid cloud key followed by LF or U+0085. Both selection and assignment admitted those values. Strict `\z` anchors fix Fish and the pre-existing ElevenLabs mismatch with the relay's raw ASCII grammar. That ElevenLabs anchor correction is the only added behavioral change beyond Fish admission. The internal route extraction preserves the existing logic and avoids testing a replica of the native override path.

The remaining plan-level iOS acceptance is a later build with P3's web bundle followed by device-assisted Fish preview and native-huddle playback. The P4 implementation and simulator done condition are complete.

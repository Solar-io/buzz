# Native iOS behavioral tests

The `BuzzNativeTests` app-hosted Xcode scheme exercises the actual native package and the bundled app. Use a dedicated simulator: identity tests enroll a deterministic test key and forget it afterward. Never run them in a simulator or device holding a real user's identity.

From the repository root, after building/syncing the web bundle:

```sh
xcodebuild -project ios-web/ios/App/App.xcodeproj \
  -scheme BuzzNativeTests \
  -destination 'platform=iOS Simulator,id=<dedicated-simulator-uuid>' \
  -derivedDataPath ios-web/build-qa \
  CODE_SIGN_IDENTITY=- test
```

Simulator ad-hoc signing is intentional. Disabling signing or running Keychain tests in a standalone `xctest` process yields `errSecMissingEntitlement` and does not test the app's Keychain behavior. The hosted suite exercises real SecItem enrollment/removal, explicit lock, signed-event integrity, NIP44 peer/ciphertext authentication, native Opus encode/decode with nonzero PCM energy, jitter wraparound, talker bounds, roster admission/revisions/epochs, voice transcript/echo/chunk policy, strict metadata types, and the WKWebView main-frame origin boundary. Its bundled-app assertions inspect both initial setup and the authenticated phone shell using a disposable native identity and deliberately unavailable relay; they capture no screen pixels.

The package's `BuzzNative` scheme also runs from this directory. That standalone runner skips the two Keychain cases and two app-rendering cases explicitly. It is useful for isolated audio/protocol/bridge mutation tests, but its passing result cannot replace app-hosted evidence.

Physical-device acceptance remains separate: APNs/App Attest delivery, cold/warm notification taps against the real gateway, lock/background two-way audio with a remote peer and agent, OS interruptions, and network/audio-route changes. Neither simulator PCM nor a valid event signature proves those workflows. See [the acceptance contract](../../docs/plans/2026-09-19-capacitor-test-contract.md).

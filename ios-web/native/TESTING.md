# Native iOS behavioral tests

The `BuzzNativeTests` app-hosted Xcode scheme exercises the actual native package and the bundled app. Use a dedicated simulator whose name contains `Buzz Capacitor QA`: identity tests enroll a deterministic test key and forget it afterward. All identity-mutating fixture methods now refuse physical devices and other simulator names. Never place a real user's identity in this simulator.

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

## In-place Flutter upgrade

`FlutterIdentityMigrationTests` exercises active/single/ambiguous selection, public-only choice descriptors, public-key mismatch, secure relay validation, actual legacy-service Keychain migration/readback, retained Flutter records, older storage formats, existing native identity preservation, and the forget marker. Its Keychain fixture refuses any pre-existing legacy accounts, removes only its named fixture accounts, and restores the prior migration/defaults markers. It never runs on a physical device.

## Physical read-only smoke

Run only after the owner authorizes physical execution and the in-place upgrade backup is verified. The phone must be unlocked normally, Developer Mode/trust ready, and reachable through the intended network. Use the same bundle identifier, signing team and Debug/sandbox or Release/production configuration as the cutover build. App-hosted `xcodebuild test` installs a test-host build: it does not simply attach to an arbitrary installed app. Do not mix configurations or signing identities merely to run this check.

The exact filter is:

```text
-only-testing:BuzzNativeTests/DeviceReadOnlySmokeTests/testRestoredIdentityAndAuthenticatedConnection
```

For the authorized Debug/sandbox cutover, from the repository root:

```sh
TEST_RUNNER_BUZZ_SMOKE_EXPECTED_PUBKEY='<expected public identity>' \
xcodebuild -project ios-web/ios/App/App.xcodeproj \
  -scheme BuzzNativeTests -configuration Debug \
  -destination 'platform=iOS,id=<authorized-device-udid>' \
  -only-testing:BuzzNativeTests/DeviceReadOnlySmokeTests/testRestoredIdentityAndAuthenticatedConnection \
  -derivedDataPath ios-web/build-device-smoke \
  -resultBundlePath logs/device-readonly-smoke.xcresult \
  DEVELOPMENT_TEAM='<existing signing team>' CODE_SIGN_IDENTITY='Apple Development' test
```

The separate class has no fixture setup. It reads the native bridge's public identity, optionally compares it to the expected identity, checks the configured secure relay and connected authenticated shell, and performs one signed `/query` for that identity's public kind-0 profile. It records notification authorization and whether a native APNs token is already present. Token presence is inspected with a local result sink, avoiding debug bridge logging of the token itself. The receipt contains public identity, relay, authorization status, token-present boolean and query status; no profile/message content, token, signing key or auth header is logged by the test.

This method neither calls migration directly nor enrolls, forgets, unlocks, requests notification permission, starts audio, or locks the phone. The app's ordinary startup may run its authorized migration. No notification permission prompt is accepted automatically. Notification delivery, cold/warm taps and background audio still require their separate authorized workflows; a successful read-only smoke is not their proof.

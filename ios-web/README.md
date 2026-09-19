# Buzz Web for iOS

This is a separate Capacitor application containing the shared `web/` client.
Flutter source remains under `mobile/` for rollback. The default bundle
identifier `com.buzz.web` supports a separate installation. Sam authorized an
in-place replacement using the existing `cloud.noet.buzz` identity; the local
signing override selects that identity. Install over the previous application,
never uninstall it first: the app container and legacy Keychain records are
preserved. Gateway replacement uses only Capacitor profiles, with the old
container/image retained by the guarded cutover workflow.

Inventory **all** installed Buzz bundle identifiers before calling a cutover a
replacement. Flutter's tracked default is `com.buzz.buzzMobile`; a local
`AppOverrides.xcconfig` can instead select `cloud.noet.buzz`. Those can coexist
and have different saved accounts. Updating one does not remove the other.
Verify the restored public identity against the owner's intended account before
retiring another installation. A connected relay or APNs token alone does not
prove the correct account was restored.

When native identity storage is empty, setup can restore the verified active
Flutter community entirely inside Swift. It validates the key/public-key pair
and secure relay, asks for a public community choice when ambiguous, and never
returns secret material to JavaScript. Existing native identities are never
overwritten. Flutter records remain for rollback, while a one-time marker
prevents them from resurrecting an explicitly forgotten native identity.
Flutter drafts/preferences are preserved in the backup, not translated into
web-client preferences. Pair/import remains the fallback if restoration fails.

## Build

From the repository root, activate Hermit and install the workspace dependencies:

```sh
. ./bin/activate-hermit
pnpm install
pnpm --filter buzz-ios-web build
pnpm --filter buzz-ios-web build:simulator
```

`build` typechecks/builds the shared web bundle and runs Capacitor sync. It does
not load a remote web application: `server.url` is intentionally absent. Do not
add it for release builds. `build:simulator` produces
`ios-web/build/Build/Products/Debug-iphonesimulator/App.app` without signing.

Operators may provide **public service URLs**, never credentials, through
`VITE_RELAY_URL`, `VITE_STT_URL`, `VITE_TTS_URL`, and
`VITE_PUSH_GATEWAY_URL` when running `build`. Resolve deployment addresses from
the infrastructure port registry. The first launch then offers one Connect
confirmation; URL fields live under Advanced. Connection settings remain
editable on the device. Saving leaves an active call and revokes the old push
registration before changing communities. Native relay/STT use `wss`; TTS and
push use `https`.

**Pairing QRs carry service URLs**: a QR code generated on a browser running this
client embeds the relay address, speech service URLs, and push gateway address
(when configured). Scanning a pairing QR on the native app automatically applies
those addresses, along with the signing key — no manual entry needed. The push
gateway may be omitted from the QR (if `VITE_PUSH_GATEWAY_URL` was unset at
build time); set it manually in Settings → Identity and connection after
pairing if needed.

## Signing and distribution

Put local signing values in gitignored `ios-web/Signing.local.xcconfig`:

```xcconfig
DEVELOPMENT_TEAM = YOUR_VERIFIED_TEAM
BUZZ_BUNDLE_ID = your.unique.buzz.web
```

Both Debug and Release consume the override. The default Debug APNs entitlement
is `development`; Release uses `production`. App Attest uses `production` in both
because the gateway verifies the production attestation environment. The native
plugin reports `buzz-capacitor-ios-sandbox` in Debug and
`buzz-capacitor-ios-production` in Release; configure the matching gateway
profile for the chosen bundle id. Co-installation requires a distinct topic;
the explicitly authorized `cloud.noet.buzz` replacement requires disabling all
legacy gateway profiles before reusing that topic.

For a device SDK compile without signing or account changes:

```sh
xcodebuild -project ios-web/ios/App/App.xcodeproj -scheme App \
  -sdk iphoneos -configuration Release -derivedDataPath ios-web/build-device \
  CODE_SIGNING_ALLOWED=NO build
```

A physical installation needs a profile and certificate for the chosen bundle
id with Push Notifications and App Attest enabled. A simulator app or an unsigned
device compile is not an installable signed release. Once distribution and
provisioning are authorized, open with `pnpm --filter buzz-ios-web open`, select
the provisioned target, and archive with Xcode (or `xcodebuild archive` using the
same scheme and Release configuration). Export using the organization's chosen
distribution method and its local ExportOptions plist. Do not grant automatic
provisioning/account writes merely to get an unsigned build to pass.

## Native boundaries

- Identity import/pairing enrolls in app-scoped Keychain
  `WhenUnlockedThisDeviceOnly`. Signing and NIP44 encryption/decryption use pinned
  NostrSDK 0.45.1. There is no native secret-key getter. Explicit Lock survives
  relaunch; device authentication unlocks it. Forget first stops the call and
  revokes the push lease; failure retains the identity for retry.
- The Capacitor message-handler gate checks both main-frame identity and the
  exact `capacitor://localhost` origin. Remote file/site frames cannot call
  native plugins. External top-level links use the system browser.
- `NativeHuddle` owns Opus capture/playback, the audio websocket, authentication,
  epoch/revision fences, reconnect, mute and audio routing. `NativeAgentVoice`
  owns the separate relay, signed agent membership, STT PCM websocket, signed
  final-transcript publication, and TTS playback. Web JavaScript only supplies
  controls/presentation; foreground snapshots restore the UI. Native voice
  requires the configured speech services and live authorized agent membership.
- APNs contains only an opaque wake identifier. The web client authenticates a
  request to `/api/push/wakes/{wake_id}` before opening a channel/message. Invalid
  or expired wakes go to Inbox. App Attest enrollment, token rotation, renewal,
  and revoke use the existing gateway contracts and encrypted NIP-PL leases.
- Agent/harness management is excluded from the native navigation. Chat,
  Thinking, encrypted observation, forums, Inbox, reminders, projects, files,
  workflows, and approvals use the shared client.

The reused native audio source is split into `HuddleAudioTypes.swift` and
`HuddleAudioEngine.swift`, adapted from `mobile/ios/Runner/HuddleAudioEngine.swift`
at base `1199b86a67`. The original Flutter source is unchanged.

## Verification

Run the complete shared-web suite and build after any interface change:

```sh
pnpm --filter buzz-web test
pnpm --filter buzz-web build
pnpm --filter buzz-ios-web sync
pnpm --filter buzz-ios-web build:simulator
```

Evidence belongs in this checkout's `logs/`. Native XCTest covers real product
crypto/storage/wire/bridge methods where available; use its app-hosted target
for Keychain entitlement behavior. A package-only test process lacks the app's
Keychain entitlement.

Run the app-hosted native suite on a **dedicated** simulator UUID:

```sh
BUZZ_IOS_TEST_SIMULATOR=<your-test-simulator-uuid> pnpm --filter buzz-ios-web test:native
```

The command refuses a missing/invalid destination and never erases a device.
It uses ad-hoc simulator signing so the hosted app has its Keychain entitlement.
The repository's existing `just ci` does not invoke this new native suite.

Release acceptance also requires a physical iPhone: explicit pairing, cold and
warm notification-to-thread navigation, denied-permission recovery, APNs token
rotation/revocation, and **two-way human/agent audio while locked/backgrounded**.
Exercise interruption, headset changes, mute, network loss/reconnect, re-entry,
and logout. Simulator builds, foreground microphones, or just recording audio
do not establish background agent conversation or APNs delivery.

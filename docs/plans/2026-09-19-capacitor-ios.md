# Buzz iOS: shared web application with native services

Sam authorized implementation on 2026-09-19. The primary interface is the existing web client, packaged with Capacitor; native services provide push and background huddles. Agent/harness management is excluded. The later explicit app/gateway cutover authorization is recorded below; Flutter source, the PWA and other installed applications/data are not deletion targets.

## Scope and completion checklist

An item is complete only with implementation and the relevant verification. An unchecked item may have implemented code; the remaining acceptance work is stated explicitly. Simulator, unit and backend receipts do not establish physical-device workflows. No scope item has been deferred or dropped.

- [x] Architecture: native/web interfaces, identity/origin boundaries, reuse map and failure behavior documented in [the native boundaries](../../ios-web/README.md#native-boundaries), [test contract](2026-09-19-capacitor-test-contract.md) and [NIP-PL extension](../nips/NIP-PL.md).
- [x] Reproducible Capacitor shell with bundled web assets and build/sync scripts. Simulator builds, signed device installation, bundled origin and native bridge have been exercised.
- [ ] Explicit relay configuration, authenticated HTTP/media/WS access, safe navigation and deep links: implemented; connection and signed read reached the physical relay, but expected-identity acceptance failed. Complete the intended-account media/deep-link journeys.
- [ ] Native secure identity enrollment/pairing, remembered identity, lock/forget and Flutter migration: implemented. Real simulator Keychain and migration fixtures pass, including retained legacy records and no resurrection after Forget. Physical restoration produced a different public key from the expected Sam identity; resolve this before marking acceptance complete.
- [ ] Shared channel/DM read/send, new DM/channel, member actions, drafts, uploads and search: shared interfaces retained; complete the intended-account phone journeys.
- [ ] Shared forum/daily/alerts, Inbox/decision cards, reminders, projects/issues, settings and Thinking: retained; complete the phone acceptance inventory. Agent/harness management remains excluded.
- [ ] Phone action affordances, compact composer/header/navigation and browser compatibility: implemented and covered by shared tests plus a simulator drawer journey. Actual keyboard, touch, layout and full browser regression journeys remain unproved.
- [ ] Native push capability, App Attest enrollment, encrypted lease publication, opt-in/out, renewal and token rotation: implemented; gateway/relay guarded cutover observed. Backend and client tests pass for these boundaries; physical APNs enrollment/delivery and lifecycle acceptance remain open.
- [ ] Cold/warm notification-to-conversation/thread navigation after authentication: implemented with authenticated opaque-wake resolution; physical notification-tap proof remains open.
- [x] Reused native Swift media engine and Opus codec component: actual simulator encode/decode produces non-silent PCM. This completes component verification only; hardware routing and background calls remain separate below.
- [ ] Native huddle transport/auth/reconnect and session ownership independent of WebView JavaScript: implemented, with tested roster/admission/revision/epoch guards. Live native transport interoperability and reconnect during WebView suspension remain unproved.
- [ ] Human/agent voice while backgrounded, mute/leave/routes/interruption behavior: implemented; transcript/echo/chunk policy tests pass. Physical two-way human/agent audio, interruption and route-change evidence remain open.
- [ ] Foreground rehydration and teardown on leave/logout/community change: snapshot/cleanup paths implemented. Complete a live-call background/foreground and teardown journey.
- [ ] Full affected-package checks and final QA: web, native component and targeted backend receipts exist, with meaningful mutation failures. The broad Rust run was not wholly green; its unresolved failures are recorded below. Physical acceptance is also incomplete.
- [ ] Real-device two-way locked/background audio and APNs notification-to-thread proof: not established.
- [x] Signed build/package and installation/release instructions: [build/signing guide](../../ios-web/README.md) and [native test/device-smoke guide](../../ios-web/native/TESTING.md) supplied; signed `cloud.noet.buzz` installed under the authorized local cutover. This is not a claim of successful intended-account migration or wider distribution.
- [ ] All QA findings resolved, final verifier/handoff completed and task worktree cleaned up: scoped implementation/test commits exist, but the physical identity failure and remaining acceptance work prevent a completion claim. Task worktree cleanup remains open while intended-account correction is in progress.

## Initial evidence

### Authorized cutover update

Sam subsequently authorized replacing the unused Flutter app and gateway
(2026-09-19, event `e7b172efdb595608840e633ebde1e73185edf763790fe7d2bd801c58e3073b96`).
The local installation can reuse `cloud.noet.buzz`, with the old gateway/image
and database backed up first. This supersedes the initial co-installation
requirement for this deployment; the source still supports a separate bundle.
Flutter source and existing app data are not deleted. Same-topic gateway
configuration is accepted only when every enabled profile is Capacitor.
The cutover includes the relay's necessary push integration and exact signed
gateway URL; pairing/database containers are not replacement targets.

### Observed state on 2026-09-19

The guarded gateway/relay cutover and installation of signed `cloud.noet.buzz`
were performed. The physical app inventory contains both `com.buzz.buzzMobile`
(**Buzz**) and `cloud.noet.buzz` (**Buzz Web**). Installing the latter is not
evidence that every Flutter installation was replaced or that the former app's
identity was migrated. Flutter source and retained legacy records remain.

Bundle provenance was subsequently confirmed: the tracked Flutter default in
`mobile/ios/Flutter/Debug.xcconfig` is `com.buzz.buzzMobile`, while the canonical
checkout's local `AppOverrides.xcconfig` selects `cloud.noet.buzz`. The latter
was an older Flutter installation and is the one replaced by Buzz Web. The
initial preflight filtered only `cloud.noet.buzz` and missed the other installed
Buzz application. Future cutover inventory must include every relevant bundle
identifier before selecting the installation and identity to preserve; see
[the application guide](../../ios-web/README.md).

The exact read-only physical smoke failed two assertions: the restored public
key began `446f1aeb…`, rather than expected Sam key `25f1ade…`, and the signed
own-profile query returned HTTP 200 with zero kind-0 profiles. The bundled
origin, native bridge and connected shell checks passed; those successes do
not close the identity failure. App-target provenance is now known; the open
work is correcting the intended account. At this checkpoint Sam was asked to
open the correct existing app and pair the intended identity, and further
source work was paused. The origin of the restored key beyond the older
installation is not established here.
Evidence: `logs/capacitor-physical-smoke.log`,
`logs/capacitor-installed-apps-current.json` and
`logs/capacitor-device-install.json` in the implementation worktree.

Sam then reported that the Settings route's only exit control was obscured on
the native phone. The route bypassed `AppShell` despite the wrapper using
`contentInset: "never"`; its header therefore lacked the safe-area treatment
already used by the conversation shell. The Settings page now owns a
safe-area-aware, non-scrolling header and a dedicated scrolling body with a
bottom safe-area inset. The narrow-viewport journey passed, the full web suite
passed 2,606 tests, and removing the constrained layout made the named mobile
regression fail. The signed `cloud.noet.buzz` build containing this change was
installed in place and launched on the physical iPhone on 2026-09-19; the
install preserved the application container. A human visual confirmation on
the physical screen remains distinct from the successful install/launch
receipt.

- Initial base: `1199b86a67` (2026-09-19 canonical main).
- Isolated branch: `codex/buzz-ios-capacitor-20260919`.
- Prior analysis: `~/.buzz/RESEARCH/BUZZ_WEB_IOS_FUNCTIONALITY_ANALYSIS_2026-09-19.md` and `BUZZ_IOS_WRAPPER_RECOMMENDATION_2026-09-19.md`.
- Original audio reuse source: `mobile/ios/Runner/HuddleAudioEngine.swift` and Flutter bridge `HuddleMediaPlugin.swift`; Flutter transport/session remains Dart under `mobile/lib/shared/huddle/`. The Capacitor application adds its own Swift session/transport under `ios-web/native/`.
- Native push enrollment: `mobile/ios/Runner/AppDelegate.swift` / `mobile/lib/shared/push/`; existing gateway/relay contract must be reused.
- Origin, auth, native voice and push adaptations are implemented; acceptance is bounded by the checklist and evidence above.
- The initial implementation scope excluded deployment by default. The later explicit cutover authorization covers the described gateway/relay and app replacement; it does not authorize deletion of another app or its data.

## Validation record

Evidence goes in this worktree's `logs/verification.log` and focused supporting artifacts. Test output must reflect actual executed checks. Physical-device availability observed during preflight is not a completed runtime test.

| Evidence | What it establishes | Remaining limit |
| --- | --- | --- |
| `logs/capacitor-merged-web-tests.log` at the merged `cd6f4b401…` checkpoint | Full shared-web suite: 2606 passed, zero failed; TypeScript check completed | Unit/type checks do not replace phone journeys |
| `logs/migration-qa-native.log` / `.xcresult`; `logs/migration-qa-smoke-final.log` / `.xcresult` | 26 hosted simulator tests passed; the added physical-only method was explicitly skipped on simulator. Seven migration tests use actual legacy-service SecItem fixtures and verify readback, preservation and Forget behavior | Fixture identity success does not establish the intended user's physical migration |
| `logs/migration-qa-selection-{mutant,restored}.log` / `.xcresult` | Wrong-community selection broke the named test; restored production logic passed | Mutation used a temporary package copy, not the installed app |
| `logs/backend-qa-integration.log`, `backend-qa-gateway-restored.log` | Real SQL wake ownership/lease/deletion tests; HTTP auth/replay/membership checks; full gateway PostgreSQL renewal/rotation tests | No physical APNs delivery proof |
| `logs/backend-qa-mutant-{author,topic,payload}.log`, `native-qa-mutants.log`, `web-qa-mutant-{plaintext,ack}.log` and corresponding restored runs | Named tests detect broken wake ownership, profile/topic/payload mapping, frame/epoch gates, ciphertext publication and negative acknowledgments | These are bounded mechanisms, not complete user journeys |
| `logs/capacitor-deployment-final-tests.log`, `capacitor-deployment-mutation.log` | Guarded cutover/rollback automation tests: 14 passed with mutation evidence | Deployment success alone does not validate identity, notifications or audio |
| `logs/capacitor-physical-smoke.log` | Actual device launch/connection and signed read occurred; expected identity and nonempty own-profile checks failed | Physical acceptance remains open |
| `logs/settings-e2e.log`, `logs/mutation-settings-e2e.log`, `logs/settings-exit-install.json`, `logs/settings-exit-launch.json` | Settings header/exit stays reachable after mobile scrolling; the test fails when the constrained layout is removed; the corrected signed app installed and launched in place | Install/launch does not by itself visually inspect the physical screen |

The earlier broad Rust run (`logs/backend-qa-full.log`,
`logs/backend-qa-integration.log`) was not wholly green: relay had 1020 passes,
one mesh echo HTTP-504 failure and 50 ignored tests; the DB ignored run had
200 passes and nine failures. Three push matcher failures passed individually
in fresh databases, demonstrating fixture interference. The remaining six
roster, ownership-limit, observer-retention and mention-index failures were
not resolved or successfully baseline-reproduced in that QA task. The dedicated
gateway run including PostgreSQL passed 28 tests plus the new integration test.
Do not summarize these receipts as an all-green repository-wide Rust suite.

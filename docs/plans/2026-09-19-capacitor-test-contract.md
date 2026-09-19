# Capacitor iOS acceptance contract

This contract maps the scope in [2026-09-19-capacitor-ios.md](2026-09-19-capacitor-ios.md) to observable behavior. It is a test specification, not an execution receipt. Agent/harness management and unrelated Flutter/PWA changes are excluded. Existing human interactions with agents, Thinking, and huddle speech remain in scope.

## Evidence rules

- Every result records case ID, exact commit and dirty-tree state, command/workflow, test count, device/OS, app build, relay origin, observed result, and artifact path. Read `git rev-parse HEAD` in the same shell as an automated check. Record changed-file hashes when workers are still editing.
- Store actual output in this worktree's `logs/verification.log`; screenshots, test reports, and redacted traces stay under its `logs/` or `test-results/`. Never include private keys, auth tags, APNs tokens, attestation artifacts, or recorded private conversations in artifacts.
- Distinguish automated seam tests, simulator workflow, and physical-device evidence. A successful build, registered plugin, screenshot, notification injection, connected socket, or advancing counter alone cannot prove end-to-end delivery.
- A guard earns coverage only after a named test fails when its actual production mechanism is broken and passes after restoration. Mutate only a QA-owned disposable checkout, never the implementation worktree while another agent is editing it. Record mutant, failing test, restoration, and baseline test count.
- Use authorized test identities/channels on existing development endpoints. Do not restart services, change production, create public access, or read a project database directly. Report missing credentials/signing/device access precisely.
- Run the full affected-package suites using their supported runners, then the repository-required checks. Web uses `cd web && pnpm test`, not bare `bun test`. Any native test command must execute tests, not merely compile the test target.

## Shell, origin and identity

| ID | Behavioral acceptance | Evidence level |
| --- | --- | --- |
| SH-01 | Repository scripts produce a reproducible iOS app from the shared web bundle. Install and launch it with the web frontend server unavailable; bundled UI appears, including an honest disconnected state if relay access is also unavailable. Asset URLs resolve locally, not to a development server. | Build + simulator |
| SH-02 | Relay configuration is explicit for the native origin. Login, NIP-42 WebSocket auth, query/publish, NIP-98 upload, and signed private-media retrieval use the intended relay. No request silently targets `capacitor://localhost`, a different community, or an insecure/public fallback. Exercise an actual accepted send and retrieve it from an independent client. | Seam + simulator/live relay |
| SH-03 | External links open through the approved external browser boundary. Untrusted iframe/external pages cannot invoke the native identity/audio/push bridge; malformed or foreign-origin deep links cannot replace relay configuration or sign requests to arbitrary hosts. | Seam + simulator |
| SH-04 | Existing desktop browser and PWA still initialize without native plugins. Native capability detection chooses the actual platform implementation and fails visibly when a required bridge is absent; no fake successful native operation. | Full web suite + browser |
| AU-01 | Existing key enrollment/pairing signs in as the expected public key. Invalid key, rejected pairing and failed Keychain write preserve the prior identity or leave a clear signed-out state. No plaintext secret is added to localStorage, IndexedDB, preferences, URLs, analytics, or logs by the native path. | Seam + simulator |
| AU-02 | Remembered identity survives app process termination and relaunch through native secure storage. Nonremembered identity follows the documented enrollment/lock policy. Keychain access errors do not create another identity, silently discard credentials, or pretend to be authenticated. | Native tests + simulator |
| AU-03 | Verify the chosen Keychain accessibility policy against real OS screen lock: an active authorized background call can perform the auth/signing it needs. Explicit in-app lock and OS screen lock have separate documented behavior. Explicit lock must not immediately undo itself through remembered-key auto-unlock. | Seam + physical |
| AU-04 | Upgrading an existing web identity migrates or re-enrolls through the documented path without losing identity. Any legacy storage is removed only after the native write succeeds. Reload during migration remains recoverable. | Seam + simulator |

## Shared UI and navigation

Use a compact phone and a larger phone, portrait and landscape. Exercise touch without hover, software keyboard open/closed, multiline input, a long message/code block, light/dark appearance and increased text size. Add a WebKit/touch lane for regression coverage, while retaining desktop-browser checks; emulation is not a replacement for WKWebView or physical iPhone evidence.

| ID | Behavioral acceptance | Evidence level |
| --- | --- | --- |
| UI-01 | Channel/DM read and send; edit/delete own message; react/unreact; reply to root and nested reply; share/copy link; remind later. Actions are visibly discoverable and reachable by touch, not hover-dependent. Destructive actions require the existing confirmation. | Component + simulator/live relay |
| UI-02 | New DM, new channel, channel discovery and member actions remain reachable. Restricted actions show relay denial rather than false success. Changes appear on a second client. | Simulator/live relay |
| UI-03 | Composer, send button, attachment/mention/emoji controls and thread close/back remain visible above the keyboard and safe areas. Opening/closing keyboard or rotating does not lose text, jump away from older reading position, or trap content. | Simulator + physical keyboard check |
| UI-04 | Drawer selection closes the drawer. Back unwinds thread/forum/detail/overlay before leaving its parent conversation; dismissing restores scroll/draft state. Cold launch and warm links resolve the intended root/reply. Search-to-message lands on and highlights the selected message. | Routing tests + simulator |
| UI-05 | Text, uploaded attachments and mention selections survive channel switches and app relaunch under the documented draft policy. Pick, preview, remove, upload and send supported images/video/files; capture camera/Photos/Files behavior. HEIC/MOV/audio either follow an implemented supported path or show an accurate actionable rejection, never a silent drop. Denied permission and failed upload preserve the draft. | Full web suite + simulator + physical media |
| UI-06 | Forum/daily/alerts content, Inbox and decision cards, reminders, projects/issues, settings and Thinking retain their existing shared-client behavior. Exercise one real read/action per applicable surface, including decision response and reminder navigation. | Simulator/live relay |
| UI-07 | VoiceOver can discover and activate primary controls; dialogs/drawer have correct focus entry/return and do not expose obscured controls as active. No clipped controls or horizontal page overflow at tested widths. | Simulator accessibility + physical sample |

Relay acceptance is authoritative: `publish()` resolving `{ok:false}` must retain a retryable draft and display its reason. A nested reply must use the actual thread root, not the selected child as a new root. These are live relay checks as well as unit assertions.

## Native push and notification navigation

Reuse the existing gateway/relay protocol, including byte-exact App Attest transcripts, installation, delegated endpoint grant, and signed kind `30350` lease. A raw APNs token is not a relay endpoint grant. Relevant references: `mobile/lib/shared/push/push_enrollment_service.dart`, `push_wire.dart`, `push_attest_channel.dart`, and `crates/buzz-push-gateway/`.

| ID | Behavioral acceptance | Evidence level |
| --- | --- | --- |
| PU-01 | Opt-in requests permission in a user action. Allowed, denied, not-determined, unsupported App Attest and absent descriptor/profile/token each produce the correct state and recovery. Late token arrival is handled without requiring repeated permission prompts. | Seam + simulator; real authorization on device |
| PU-02 | Installed signed app completes descriptor discovery, challenge/attestation, installation, delegation and relay lease acceptance with its actual bundle/profile/environment. A message independently published in an authorized test channel produces a real APNs notification. Unsupported profile/signing is reported explicitly. | Physical + live gateway/relay |
| PU-03 | Token rotation advances the protocol epoch/generation and replaces delivery authority; stale token callbacks or duplicate enrollment cannot revive an old endpoint. Relaunch, lease expiry/renewal, transient failure and retry retain monotonic state without duplicate notifications. | Native/service seam; physical repeat delivery |
| PU-04 | Tap a root-message notification and a reply notification with app foregrounded, backgrounded and terminated. Correct community/channel/root/selected reply is visible exactly once after bootstrap. When identity is locked, queue the intent until authentication; do not expose message content early or lose the intent. | Routing seam + injected simulator payload + real physical APNs taps |
| PU-05 | Reject malformed IDs, contradictory root/channel, unauthorized target and foreign community. Deleted/expired target shows a useful fallback. Duplicate tap events do not create duplicate navigation entries. A tap received before bridge listeners attach is retained and consumed after readiness. | Seam + simulator |
| PU-06 | Opt-out publishes accepted inactive lease at a newer generation, stops further enrollment and clears local scheduling/presentation as applicable. Revocation failure is visible and retryable; offline opt-out must not claim confirmed server revocation. An unrelated device's lease remains intact. | Seam + live relay/device |

Simulator push injection proves payload routing only. It does not establish APNs entitlement, App Attest, provider delivery, sandbox/production matching or real-device background receipt.

## Native huddle media, transport and agent voice

The existing Swift media engine is a reuse source, not a complete huddle client: Flutter transport/auth/session currently live in Dart. Required ownership includes microphone, Opus encode/decode, socket/auth, reconnect, room lifecycle and foreground state snapshot. Inspect `mobile/ios/Runner/HuddleAudioEngine.swift`, `mobile/lib/shared/huddle/huddle_auth.dart`, `huddle_transport.dart`, `huddle_wire.dart` and `huddle_session.dart` against the new native implementation.

| ID | Behavioral acceptance | Evidence level |
| --- | --- | --- |
| HU-01 | Join authenticates to the configured relay using its challenge and correct parent/ephemeral room IDs, negotiates supported protocol, and transmits/receives compatible Opus frames with an independent existing client. Wrong challenge, admission denial and malformed frames fail cleanly without starting an unauthorized mic. | Wire/auth tests + simulator/live peer + physical audio |
| HU-02 | Native code owns both audio and transport. Pause/suspend WebView execution during an established call: a remote peer still hears new human speech and the device still plays new remote speech. Also force a reconnect during JS suspension; fresh native challenge signing and room admission recover. | Native seam + physical |
| HU-03 | Join from foreground, then lock the screen and separately switch apps. Sustain each for at least five minutes, exchange newly spoken, distinct phrases in both directions, and confirm at both endpoints. Record timestamps and redacted packet/playout metrics; counters alone do not prove audible speech. | Physical with independent peer |
| HU-04 | Human speech reaches the existing agent STT/message path and the agent's new response is audible while backgrounded/locked. Verify both transport and agent routing. Voice mode off, agent speech off and half-duplex settings remain respected. No renderer callback/timer may be required for the background path. | Native seam + physical/live authorized agent |
| HU-05 | Mute, hold-to-talk release/cancel, playback mute and explicit leave act on native state. Rejoining or reconnecting does not unmute a previously muted/held mic. No duplicate capture, socket, agent message or playback stream after rapid join/leave/rejoin. | Native tests + simulator + physical |
| HU-06 | Bluetooth/headset/speaker changes, input removal, OS audio interruption and interruption end preserve accurate call state. Resume only when permitted; failure offers a clear recovery. Exercise Wi-Fi/cellular handover and temporary network loss while foregrounded and locked. | Native state tests + physical |
| HU-07 | Foreground UI obtains an authoritative native snapshot after backgrounding or WebView recreation: room, connection, mute/hold/output/error and participants agree with reality. It attaches listeners without creating a second call or resetting preferences. An ended remote room cannot appear active. | Bridge tests + simulator + physical |
| HU-08 | Explicit leave, logout, forget and community/identity change stop capture/playback, close native sockets, cancel reconnect and agent speech work, and publish lifecycle cleanup where possible. Delayed callbacks from an old call cannot restart it or join under the next identity. | Race/state tests + simulator/live relay |

Force-quitting the whole app is a termination/recovery case, not a promise of continuing background audio. Record lock/background tests without a debugger keeping execution artificially alive. Include supported iOS versions and real routes tested; do not infer universal device support from simulator audio.

## Logout, forget and retained state

| ID | Behavioral acceptance | Evidence level |
| --- | --- | --- |
| EX-01 | Explicit logout immediately prevents new authenticated operations, ends native call ownership and handles push revocation before losing needed signing authority. A queued push tap cannot reauthenticate or reveal the old account. Relaunch follows the documented logged-out policy. | Seam + simulator |
| EX-02 | Forget removes the selected device/account identity from Keychain and web caches/remembered credentials according to policy; it cannot auto-restore on relaunch. Push/transport cleanup is attempted, unconfirmed remote revocation reported accurately, and no raw key retained merely to retry it. Another identity/device is unaffected. | Native storage tests + simulator + physical receipt check |
| EX-03 | Logout/forget racing with enrollment, token rotation, message send, audio reconnect or deferred push intent cannot recreate credentials/lease/call state. Delayed callback belongs to its original session generation and is discarded. | Deterministic race tests |

## Test seams and failure demonstrations

Favor small injected boundaries that run shipped code: Keychain adapter with realistic error codes; native bridge registration/event buffering; clock/randomness for retry; URLSession/WebSocket transport; APNs/authorization/App Attest provider; push gateway requests and relay publisher; native audio route/interruption events; deep-link intent queue and router; agent voice transport. A fake must execute the callbacks the production caller depends on.

Useful mutations, each mapped to a named behavioral test:

- Resolve publish refusal as success: UI-01 must fail draft/sent-state assertions.
- Route native HTTP/WS to bundled origin: SH-02 must fail observed destination/auth.
- Make Keychain deletion a no-op: EX-02 must fail relaunch identity absence.
- Drop cold-start notification before listener registration: PU-04 must fail target navigation.
- Reuse stale push generation or use raw APNs token in lease: PU-03/PU-02 must fail strict protocol acceptance.
- Disable native reconnect or require JS for challenge signing: HU-02 must fail suspended-renderer recovery.
- Drop native Opus uplink or downlink: HU-01/HU-03 must fail the corresponding independent endpoint observation.
- Let old-session callbacks run after leave/logout: HU-08/EX-03 must fail absence of restarted capture/socket.

Assert nonzero test and assertion counts. Use literal expected wire fields/bytes in independent fixtures, not constants imported from the implementation under test. Audio, push and navigation tests must reach the real entry point; source-text matching does not establish these behaviors.

## Execution prerequisites and handoff

The implementation must supply the native package/scheme, repeatable build/test/sync commands, supported OS range, relay configuration, bridge interfaces, and chosen identity/lock semantics. Physical runs additionally need an authorized iPhone, signing profile/entitlements and advertised gateway app profile, an authorized test identity/channel, an independent audio peer, and the existing agent speech route. Missing prerequisites block only their dependent cases; report remaining physical proof explicitly rather than marking it complete from mocks.

Acceptance requires SH/AU/UI/PU/HU/EX case results with no unresolved blocker against the authorized scope, full affected-package/build checks, the named failure demonstrations, simulator workflows, and physical APNs plus locked/background two-way human/agent audio evidence. Release instructions must distinguish simulator build, installable signed device build and authorized distribution. This contract does not authorize production deployment or distribution to additional people.

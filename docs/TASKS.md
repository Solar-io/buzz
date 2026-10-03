- [x] Work row context: title → own in-turn message → trigger/parent precedence, bounded history fetching, unit boundaries, two mutation kills, and desktop/phone fixtures.
- [x] Parity W11a: Library tabs (Definitions, Teams, Catalog, Snapshots) and one New agent menu.
- [x] Parity W11a: Blank create cards using existing create wire contract and built-in defaults; linked/team creation stays locked for P2.
- [x] Parity W11a: behavioral regressions, fail-first proof, web checks and built-app 1440/390 screenshots. Evidence: [W11a report](TEST_REPORTS/parity-w11a.md).
- [ ] Parity W11a: live throwaway-agent creation/start acceptance with an authorized owner signer and a reporting desktop. The coding shell has no Buzz signing credentials; the live browser reports no desktop for its identity.
- [x] QA 63eeb8a14: 4,081 unit tests, static/build checks, Work E2E, Agent Brave, request census, edge cases and precedence mutation. Findings: docs/TEST_REPORTS/qa-work-63eeb8a14/test-report-2026-10-02.md.
- [x] QA-WORK-001 (High): fixed — live kind-9 subscription for running turns and Done turns inside a 90 s grace (`liveSlots`); regression `web/tests/e2e/work-activity.spec.ts`.
- [ ] QA-WORK-002 (Medium): prune lifetime activity/tried maps when pair windows/channels expire; add churn coverage.
- [ ] QA-WORK-003 (Medium): keep fenced-code language markers out of meaningful row summaries; define non-text fallbacks.

Parity W8a roster:
- [x] Read-only roster with team/model/effort, observer Working and catalog Claimed status.
- [x] Counted status chips, team/name filters and existing stale-registration set.
- [x] Content-width table columns and phone list, accessible selection.
- [x] Row lifecycle/Open/Message/snapshot/Unregister and targeted bulk lifecycle.
- [x] Bulk channel adds, confirmation, desktop acknowledgement/refusal receipts and safe unregister guards.
- [x] Required web checks, named mechanism mutations and built-app 1440/390 screenshots.
- [ ] W8a live acceptance: throwaway agents and private-channel checks need an enrolled owner signing environment. Evidence: [W8a handoff](TEST_REPORTS/parity-w8a.md).

- [x] Parity A1: implement pubkey > display name > wildcard > env resolution for each turn knob; add marked-turn `voiceModel`; wire both harness call sites.
- [x] Parity A1: add six named regressions plus tier/type edge cases; show mechanism mutations failing with unchanged test counts.
- [x] Parity A1: run web baseline/final, typecheck/build/size checks and buzz-acp tests/clippy; record handoff and commits. Evidence: [A1 report](TEST_REPORTS/parity-a1.md).
- [ ] Parity A1 release acceptance (plan: after R3): a throwaway agent's pubkey-keyed `voiceModel` changes the next marked turn's observed model without a restart.
- [x] Daily Digest implementation: row above Links, fixed in-app web target, phone title/selection, shared LRU and native iframe lifecycle; 4,097 unit tests, typecheck, build and touched-file Biome pass.
- [x] Daily Digest acceptance: four named mutation failures at an unchanged 4,097 tests, restored full checks pass, desktop/phone Agent Brave workflows render the live edition and retain its frame. Evidence: [Daily Digest report](TEST_REPORTS/daily-digest.md).

- [x] W6: settings IA, owner landing, phone root, agent search/redirect, desktop report footer; existing controls remain reachable. Evidence: docs/TEST_REPORTS/w6-settings-ia.md.
- [x] Parity W4 implementation: Stream/Forum creation, lifetime presets, sidebar reachability, mutation proof and 1440/390/375 browser checks. Evidence: TEST_REPORTS/parity-w4.md.
- [ ] Parity W4 live acceptance: create private Forum and 24 h channels on the live relay with an enrolled test identity. This coder session has no BUZZ_PRIVATE_KEY/BUZZ_AUTH_TAG and Agent Brave has no Nostr extension.

W1 channel settings:
- [x] About sheet (480 desktop / full-screen phone), header and Members entry points; Members / Workflows placeholders.
- [x] Metadata parsing and name / purpose / visibility / lifetime edits; Joining and Type read-only.
- [x] Archive / Unarchive with archived controls and composer locked; join / leave / delete through existing event helpers.
- [x] Canvas, local Save as template, existing notification mute preference.
- [x] Required web gates, named fail-first proof and 1440 / 390 screenshots (both applied themes asserted).
- [ ] W1 live-relay acceptance in a private test channel using an authorized test signer. The coding shell has no Buzz signing credentials; local built-app acceptance uses the mock relay. See TEST_REPORTS/parity-w1.md.

- [x] Parity W7: SettingSelect inherited/set/dirty, reset, timing, locked/offline states.
- [x] Parity W7: ModelSelect catalog groups/search/custom ids and DurationSelect presets/custom seconds.
- [x] Parity W7: immutable per-agent drafts, explicit clears, summaries and inverse plans.
- [x] Parity W7: desktop-ack save receipts/Undo, concurrency three, timeout and partial-failure retention.
- [x] Parity W7: TanStack navigation/unload guard with Keep editing / Discard.
- [x] Parity W7: 24 added behavioral tests, nine built mutations, required web checks and 1440/390 component screenshots. Evidence: [W7 report](TEST_REPORTS/parity-w7.md).

## Codex usage in web Vitals

- [x] Add the shared no-header /v1/codex poll and null-preserving parser.
- [x] Add sidebar and phone Codex readings plus quota/credits/usage details in the pop-out.
- [x] Cover zero, unknown, stale, unlimited and endpoint failure; demonstrate six named mutation failures with an unchanged test count.
- [x] Run required web static checks, 4,107 passing units/build, and six passing Codex E2E cases; full work-shell retains four existing failures. [Evidence](TEST_REPORTS/codex-vitals.md).

- [x] W9a: agent header, roster stepping, URL tabs, lifecycle/menu and existing settings access.
- [x] W9a: Right now live model switch/cancel, channel add then start and remove, Memory/Activity; locked Logs.
- [x] W9a: phone sub-pages, responsive cards, behavioural/mutation tests, scoped web gates and screenshots. Evidence: [W9a report](TEST_REPORTS/w9a-agent-screen.md).
- [ ] W9a live acceptance: read-only Acid Burn comparison, then test-channel add/remove and cancellation on a throwaway agent. Needs an approved owner signing environment; this coder shell has no BUZZ_PRIVATE_KEY. Local mock journeys cover the client wiring.

## Fish audio P2

- [x] Shared Fish/ElevenLabs voice-key vectors (4 accept and 19/18 reject respectively).
- [x] Relay selection (30182): Fish grammar, validation errors and fixture coverage.
- [x] Relay assignment (30183): reuse selection grammar and cover Fish vectors.
- [x] CLI select/assign Fish prefix, payload and compiled command help.
- [x] Relay-backed E2E Fish acceptance/readback case implemented and compiled.
- [x] Nine named mutation failures with fixed test counts, restored source, strict Clippy and formatting.
- [ ] Clean unfiltered relay + CLI gate: CLI 483 pass; relay lib 1047 pass / 2 fail / 64 ignored. Parent control reproduces mesh echo 504; telemetry callsite failure is intermittent. [Evidence](TEST_REPORTS/fish-relay-cli.md).
- [ ] Execute the Fish E2E case against an isolated relay containing this patch.
- [x] Live baseline QA: HTTP 200 Buzz page and 46-row ElevenLabs JSON; Agent Brave Settings/Voice/ElevenLabs/filter/Cancel flow, inspected screenshot and console/network receipts. Fish integration acceptance remains open.
## P3 Fish Audio web and voice library

Evidence: [P3 report](TEST_REPORTS/fish-web.md): 4,175 baseline / 4,212 final tests, 34 mutation kills, scoped static/build checks and built Settings Agent Brave workflow.

- [x] Fish selection grammar, precedence, summaries, bridge routing and huddle overrides.
- [x] Shared A–Z comparator, Fish tabs and pinned removed selections in Settings, assignment, profile and huddle pickers.
- [x] Signed bridge library API, input validation, usage census and mutation invalidation.
- [x] Settings Voice library card: curated lists, provider browse/search, add/remove confirmation, admin/read-only controls.
- [x] Shared grammar vectors, behavior tests, exact baseline/final counts, mechanism mutation proof, typecheck, scoped Biome and build.

## Fish audio P4 native iOS

- [x] Accept Fish selection/assignment keys on the shared grammar and retain existing voice precedence.
- [x] Admit Fish channel overrides through NativeAgentVoice's existing bridge route.
- [x] Cover Fish and ElevenLabs shared grammar vectors with fixed case counts, plus Fish routing and override behavior; strict end anchors reject trailing LF/U+0085 on both engines.
- [x] Native simulator suite: 40 → 46 discovered, 31 → 37 passing, nine unchanged skips; four named mutation failures with unchanged counts, restored suite green. [P4 evidence](TEST_REPORTS/fish-ios-native.md). Physical builds/installs, deployment and push are outside this phase.
- [x] P4 live baseline QA: Buzz HTML and 46-voice ElevenLabs JSON at HTTP 200; Agent Brave Settings → voice picker → ElevenLabs → filter Roger → Cancel; screenshot inspected, console/network receipts captured and owned tab closed. Changed Swift acceptance remains simulator-native.

## Background Work rail jobs (2026-10-03)

- [x] QA-JOB-001: reserved second-line labels for abnormal job/turn outcomes, preserving normal completion layout. Six browser geometry cases fail before the fix and pass after; 4,225 web units, build and all 13 Work-status cases pass. [Evidence](TEST_REPORTS/qa-job-001.md).

- [x] Core: third job namespace, shared lifecycle validation and regression cases.
- [x] SDK: validated job builder and address helper.
- [x] Relay: validator coverage and ignored private-channel/concurrent/replacement E2E cases.
- [x] CLI: job start/beat/end, channel detection/binding, monotonic writes and terminal refusal.
- [x] ACP: guard that restart sweeps ignore jobs.
- [x] Web: parser/store, Running/Done jobs, labels and independent turn/reaction rows.
- [x] Web: mock relay smoke in both themes, with live job completion.
- [x] Manifest and handoff documentation.
- [x] Baseline/final required suites, builds, lint/format, mechanism mutation failures and clean committed branch.

Scope excludes fleet scripts/plugin, live relay/DB, installation, deployment and service restarts.

Background-job evidence: [work-rail-jobs report](TEST_REPORTS/work-rail-jobs.md). Added job checks pass with named mutation failures; full just test passes on repeat. The existing relay mesh echo 504 and CLI all-target test-loop lint remain separate open repository gates.

W5a canvas editing:
- [x] Markdown Edit / Save / Clear with signed channel-scoped append events and relay refusal handling.
- [x] Empty-canvas and phone reachability through About > Canvas; live echo and second-viewer rendering through mocked relay traffic.
- [x] Behaviour tests, fail-first proof, required web checks, and 1440 / 390 screenshots. Evidence: [W5a report](TEST_REPORTS/parity-w5a.md).
- [ ] W5a live acceptance: edit and clear a private test channel canvas with an enrolled throwaway identity; verify a second browser receives both updates. The worktree has no live test signing credentials.

W2 people in channel Members (in progress):
- [ ] Preserve roles from the live replacement roster; exact membership and community moderation tag builders.
- [ ] Members/People rows, admin role changes and removal, last-owner guard, member search.
- [ ] Add People with per-person roles and per-person relay refusals.
- [ ] Community-only timeout/ban menus, reason entry, authority and archived-state guards.
- [ ] Full web gates, named mechanism reversion proof, built-app checks and 1440/390/375 screenshots.
- [ ] Private live-relay channel acceptance with a second authorized test identity.
- [ ] W3: agent/people partition, safe unregistered detection and existing-agent picker.
- [ ] W3: accepted membership then acknowledged start; bounded bulk start/stop and confirmed cleanup.
- [ ] W3: observer status, model/effort, row settings/message/instruction/stop/remove entry points.
- [ ] W3: behavioral and fail-first tests, web gates, built-app 1440/390 screenshots and handoff.
# Parity W5b

- [x] Channel Workflows tab: scoped rows/run status and create/edit YAML; preserve identity and revision.
- [x] W5b behavioural tests, mutations, required web checks and built-app responsive acceptance. [Evidence](TEST_REPORTS/parity-w5b.md).
- [ ] W5b live private-channel create/edit with an enrolled signer.

W9b1 agent settings cards:
- [x] Model & thinking: grouped model picker, runtime-specific Provider/API key, read-only locked Effort.
- [x] Runtime: preset/custom picker, locked inheritance, Turns at once, duration presets/custom/reset, Start with Buzz Desktop, honest blind controls.
- [x] Who can instruct: named people picker, locked Nobody, desktop warning copy and placement.
- [x] W7 draft/save/navigation integration, targeted desktop acknowledgements, safe local timeout echo and phone sub-pages.
- [x] Required web checks, named fail-first regressions, built-app browser journeys and 1440/390 screenshots; commit and handoff.

- [ ] W9b1 live desktop acceptance: throwaway-agent Idle 30 min and Anyone save/reload against the real desktop. Local client evidence uses mocked desktop acknowledgements. See [W9b1 report](TEST_REPORTS/parity-w9b1.md).
- [x] Safe markdown details: recognise blank/nonblank body boundaries, own-line summaries, open, missing close, nested blocks, literal code, formatted labels and unrelated HTML in both clients.
- [x] Safe markdown details: wire desktop chat and web chat/Pulse, preserve downstream markdown features and inherited styling.
- [x] Safe markdown details: record both baseline/final test counts, typechecks, palette/text checks, DOM/browser acceptance and named mutation failures. Evidence: [details renderer report](TEST_REPORTS/markdown-details.md).

P0 — owner-admin protocol foundation:
- [x] Advertise catalog v5 capabilities; preserve older catalog readers.
- [x] Parse requirements and timestamps; refuse unsupported or stale writes before applying.
- [x] Ping response and structured, byte-budgeted acknowledgements.
- [x] Web capability intersection and sealed command/ack transport.
- [x] Mounted/focus desktop presence, offline locks, and connection footer.
- [x] Shared fixture corpus, fail-first regressions, static/build checks, responsive browser evidence.

P0 evidence: `docs/TEST_REPORTS/parity-p0.md`.

P0 verifier follow-up:
- [x] Preserve enablement and sending for all eight v4 admin commands; keep named v5 requirements locked.
- [x] Persist replay receipts before save; verify restart, >500 requests, concurrent delivery and failure boundaries.
- [x] Compose presence checks into the W6/W9a Settings routes after the main merge.
- [x] Run required web/desktop checks and named fail-then-pass mutations; commit evidence.

Evidence: [P0 verifier fixes](TEST_REPORTS/parity-p0-verifier-fixes.md).

W8a integration with current main:
- [x] Compose roster with Library, New agent creation, DetailPane, W9b1 and connection footer; retain every Playwright spec.
- [x] Carry P0 desktop presence lock through row mutations and bulk lifecycle/confirmation controls.
- [x] Verify a named row-lock regression fails with the lock removed and passes after restoration.
- [x] Run full web unit/static/build gates and all six requested E2E groups; inspect 1440/390 screenshots.
- [x] Commit the integration and record handoff evidence.

W8a integration evidence: [current-main composition](TEST_REPORTS/parity-w8a.md#current-main-integration--2026-10-03); 4,373 units and 37 browser cases pass, including restored row-lock proof.

## Vitals shared account forecast (2026-10-03)

- [x] Record first-empty times, handoffs and next-reset usage from the existing combined simulation.
- [x] Use that forecast in the sidebar, headline, account lines and row dry text; preserve fallback behavior.
- [x] Live-number and low-burn regressions, named simulation-withdrawal mutation proof, full web counts/static/build checks.
- [x] Render the fixture at 1440 and 390 widths and capture screenshots; commit with the required trailers.
- [ ] Resolve the contradictory A-time criterion: the unchanged allocator gives 18:56:55Z, while the requested 19:13Z uses A's solo rate. No approval to change allocation or waive that criterion was received. [Receipt](TEST_REPORTS/vitals-account-runway.md).

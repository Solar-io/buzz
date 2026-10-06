2026-10-02 — Work row context

The pure Work join attaches own-message previews; `whatLine` keeps title/activity/ask precedence. Done rows preserve 30624 start/end times, including when merged with metrics. Agent history uses one request per pair, up to ten bounded turn filters, preserving older Done windows beside a running turn. Target fetching stores the NIP-10 parent and tries it once for short triggers.

Validation: TypeScript and scoped Biome passed; 4,081 unit tests passed with zero failures; the web build passed; all five Work status browser tests passed (desktop/phone, both themes, queued parent recovery). Removing the start-time bound failed `running row ignores a message before startedAt and keeps its trigger fallback`; disabling parent recovery failed `a short trigger "Yes" uses its reply parent on running, queued and done rows`. Both mutant runs executed 4,081 tests, and the restored code passed the full checks. Receipts are in the worktree's `logs/verification.log` and `logs/final-checks.log`. Browser tests use a mocked relay; the supplemental Agent Brave attempt did not complete its persistent-login fixture setup. There is no separate `web/AGENTS.md` in this checkout; the root guide governs the web client.

2026-10-02 — Independent QA of 63eeb8a14

NO GO: QA-WORK-001 reproduces a Done-only row stuck on the pickup after a final reply arrives after history EOSE, despite its timestamp being ended + 5 seconds. The terminal history closes and its query key never renews. The final event is present in the fixture store. QA-WORK-002 records maps retaining historical pairs, and QA-WORK-003 records fenced code showing only `typescript`.

Validation: original 4,081 unit tests pass; tsc/build/scoped Biome pass. Existing status E2E: 5/5; work-shell: 10/14, with four old Vitals `B dry` expectations mismatching the existing `both dry` headline. New QA cases: Running Yes/parent and request census pass; delayed final fails. A 120.001-second census recorded 17 total REQs, 12 activity renewals, all activity requests closed. Agent Brave loaded the built fixture, showed the pickup/final lines and zero console errors; its claimed tab was closed. The title-over-activity mutation killed one named test, then passed after exact-byte restoration.

Evidence and reproduction command: docs/TEST_REPORTS/qa-work-63eeb8a14/test-report-2026-10-02.md. New tests remain uncommitted in web/tests/e2e/work-activity-qa.spec.ts; mockRelay.ts has an uncommitted optional frame observer. No production implementation, main checkout, deployment, or production web-dist was changed. Three feature follow-ups are in TASKS.md and BUGLOG.md.

2026-10-02 — QA-WORK-001 fixed: WorkProvider keeps a live kind-9 subscription (no limit, bounded by since) for running turns and Done turns that ended within 90 s (`liveSlots`, `LIVE_GRACE_S`), adding without pruning older Done windows (≤50 per slot). QA spec promoted to `web/tests/e2e/work-activity.spec.ts` (smoke project), 3/3; disabling the live effect fails the grace case. 4083 unit tests pass.

2026-10-02 — Parity A1: turn knobs by pubkey and file voice models

`text`, `voice`, and `voiceModel` resolve independently from exact lowercase pubkey, case-insensitive legacy name, wildcard, then environment. Present blank/`unset` masks lower tiers. Model overrides stay on marked turns and use the existing catalog/apply/restore path. The prompt path uses `ctx.agent_keys`; native steering receives the read loop's own pubkey. `pool.rs` remains exactly 11,798 lines; inline routing tests moved to `voice_turn_tests.rs`.

Source commits: `45324ab722b0c936d860ea1ebb7cc9d7f3cfc553`, `b08423ef676c87ae90862d275bd95da791dd8880`. Twelve new tests include an isolated subprocess that edits its scratch config and resolves the new model/effort on the next turn in the same process. Five mutations exercised 51 routing tests each; disabling both A1 mechanisms failed all six required regressions. Restored full suite: 1,021 unit plus nine integration tests; strict Clippy, Rust build/format, and required web checks passed (4,092 tests before/after). [Full handoff](TEST_REPORTS/parity-a1.md) lists evidence and the after-R3 live acceptance procedure.

2026-10-02 — Daily Digest sidebar destination

The sidebar has a Newspaper row below Forums and above Links. A fixed digest target resolves through WebLayer to the tailnet edition, with the phone title "Daily Digest", shared selection and four-frame LRU. Native iPhone embeds the cookie-free edition and retains it behind conversation navigation; Files/Links keep their existing native login browser. Coverage includes fixed target/URL, reducer switching/hide/LRU, the real sidebar's order and selection, and the native iframe lifecycle. Initial full web checks: 4,097 tests pass, TypeScript and touched-file Biome pass; build passes.

Daily Digest acceptance: remapping digest frame keys to `link:` fails four named tests with the total unchanged at 4,097; exact restoration passes all 4,097 plus TypeScript. Agent Brave checks pass at 1440×960 and 390×844 using a page-local socket fixture and the real, unmocked edition page, including phone title and Back, desktop conversation-click hide, and retained iframe. The temporary preview and claimed browser tab were removed after the checks. [Evidence and boundary](TEST_REPORTS/daily-digest.md).

2026-10-02 — W6 settings IA

Added the thirteen-group IA and owner landing (self registry or a catalog within six hours plus five minutes), phone root navigation without Keyboard, agent name search, validated agent/tab selectors, the old agent route redirect, and a last-reported desktop footer. Existing agent controls and Library panels render inside Settings. Voice and channel templates have separate panes. The target-agent page is the specified placeholder for W9a; Defaults, routing and drafts have no premature navigation entries.

Evidence: docs/TEST_REPORTS/w6-settings-ia.md. Unit counts: 4,092 before, 4,099 after. All 27 settings smoke cases pass. Unit mutations fail four named cases with 4,099 tests unchanged; a redirect mutation fails both desktop and phone redirects with seven W6 cases unchanged. TypeScript, all 19 changed web-file Biome checks, build, local-main file-size ratchet, palette and scoped px-text checks pass. Global px-text still names two unchanged parent files. Agent Brave and smoke fixtures use throwaway keys with mocked relay traffic; screenshots at 1440 and 390 show no overlap or horizontal overflow. Receipts live in logs/verification.log.

2026-10-02 — Parity W4

Channel creation now has native radio segments for Stream/Forum and a lifetime select. `newChannelRequest.ts` builds the existing relay request; ongoing omits ttl. `useChannelLists` admits the four creation TTL presets while preserving the scratch section and hidden transport rooms. The existing expiry badge describes temporary streams; parent-linked scratch semantics are unchanged.

The baseline ran 4,092 tests (one existing speech-order timing failure); restored final code passes 4,101. Typecheck, build, scoped Biome, scoped px-text, palette and file-size checks pass. Full Biome still reports the 30 existing errors; full px-text reports two existing files. Forcing stream and omitting ttl failed five named unit tests and six of nine browser tests, with counts unchanged; restoration passed 4,101/4,101 and 9/9. Screenshots in `.scratch/screenshots/` cover 1440, 390 and 375 widths. Agent Brave initially passed the nine cases, then its mock WebSocket interception sent real connections to the preview origin; headed Playwright reproduced the final built workflows successfully. Live acceptance is still blocked by missing test credentials. Full receipts and next steps: docs/TEST_REPORTS/parity-w4.md.

Final size-check note: main advanced while W4 ran, shrinking its repos.tsx under the ceiling. The current-main comparison consequently flags the worktree's untouched 1,001-line file; it is byte-identical to starting main `301cc5348`. The check against that immutable phase base passes. See the report's two size receipts when integrating concurrent phases.

2026-10-02 — Parity W1 channel settings

The channel header and phone bar open a 480 px / full-screen settings sheet; the facepile opens its Members placeholder. About sends only changed metadata fields, writes purpose without touching scratch about, and clears Lifetime with the desktop's empty TTL tag. Joining and Type are read-only. Existing helpers handle rename, delete, join and leave; Canvas opens the existing document pane, Save as template captures metadata and canvas in the existing local store, and Notifications exposes the existing mute/default preference.

The selected conversation has a separate channel-scoped metadata subscription. Addressable metadata ties use the event ID. Archival disables all About controls except Unarchive, and a context disables inline thread reply boxes as well as the main composer. The browser workflow first caught editable inline replies; removing the context guard reproduces that named failure.

Evidence: 4,092 baseline unit tests and 4,102 restored tests; a combined metadata/archive mutant fails all five required named tests with the same 4,102 count. Four built-app browser workflows pass at 1440 and 390 in both fixed palettes, with actual theme assertions and screenshots in .scratch/w1. The attached-browser WebSocket fixture failed after sign-in; the supported headed Playwright fallback supplied the final UI evidence. The coding shell has no Buzz signing credentials, so private-channel acceptance against the real relay remains for the authorized tester. Full receipts: TEST_REPORTS/parity-w1.md and logs/verification.log.

2026-10-02 — Parity W7: shared settings controls and draft model

Built SettingSelect, ModelSelect, DurationSelect and SaveBar, plus per-agent draft/clear/inverse planning, a three-command save runner with 30-second acknowledgement uncertainty, and TanStack navigation protection. The sender must await a desktop acknowledgement; consuming phases supply validated wire fields and clear sentinels. Failed agent edits remain after partial success; duplicate display names retain separate receipts by pubkey/field.

Validation: 4,092 web tests before and 4,116 after (24 new); typecheck/build/scoped Biome and token checks succeeded. Nine built mutations each ran 24 tests and produced the named failures; restored 24/24 and build succeeded. Agent Brave exercised the actual compiled components with simulated acknowledgements, model reset/Undo, refusal/retry and navigation prompts at 1440 and 390; screenshots/logs are local to the worktree. Size and global px-text failures are byte-identical to the W7 baseline. [Detailed report and file/commit inventory](TEST_REPORTS/parity-w7.md).

2026-10-03 — W11a resume: Library and Blank agent creation

Preserved source `b8aecddb3` and the interrupted tests/checklist. AgentsAdminPage keeps the W9a Settings routes alongside local create-draft protection. Blank creation uses Card wrappers, existing identity/access/env sections and W7 native model/runtime/duration pickers; W9b's later cards were absent from the updated parent. Definition/team entries stay locked for P2. Snapshot import uses the existing preview and a file input outside the dropdown's lifetime.

Creation waits for a desktop acknowledgement with an agent key before opening its Settings route, preserves drafts on refusal, handles 30-second uncertainty and late acknowledgements, and blocks unsaved navigation. The sidebar test stub now supplies the router blocker export reached through these imports. The community catalog browser fixture is signed so its real verifier remains exercised.

Evidence: 4,252 baseline unit tests and 4,268 restored tests, all passing. Sixteen new unit regressions fail in their bodies with the same 4,268 count under mechanism withdrawal. Rebuilt timeout/tab/navigation mutations fail all five W11a browser cases; restoration passes those plus seven W6 regressions (12/12) in Agent Brave. Typecheck, build and all 18 changed-file Biome checks pass. Global lint has 28 errors outside those files; px-text/default size checks flag unchanged parent files, while CHECK_FILE_SIZES_BASE=main succeeds. Eight distinct screenshots at 1440/390 were inspected for overlap/overflow. Raw outputs: logs/verification.log and .scratch/w11a/. [W11a handoff](TEST_REPORTS/parity-w11a.md).

Real-desktop creation/start remains open: the coding CLI lacks BUZZ_PRIVATE_KEY, and the read-only live browser visit reports no desktop/registrations for its identity. An authorized tester needs the owner's reporting desktop and a throwaway agent. Mock acknowledgements prove the client/wire flow, not process startup.

2026-10-02 — Codex usage in web Vitals

Added the /v1/codex contract parser and a shared simple GET poll. Codex has its own weekly bar below Claude and above crichton, a compact phone reading in Claude's column, and pop-out plan/windows/credits plus Today/Last 7 days direct/routed calls, compact tokens and list costs. Unknown readings remain null; 0% stays visible; stale readings are marked. The enlarged pop-out scrolls within the viewport.

TypeScript, scoped Biome, build and 4,107 unit tests pass. A committed-parser null-to-zero mutation failed six named tests at the same 4,107 count; the restored suite passes. Six new browser cases pass; full work-shell has 14 passes, two visual-only skips and the four pre-existing B dry expectations left intact. Agent Brave could not intercept the WebSocket mock (independent echo canary also failed), so final E2E used the headed isolated fallback. Hub acceptance is mocked against the supplied contract. [Full evidence](TEST_REPORTS/codex-vitals.md).

2026-10-02 — W9a agent screen shell

Added `features/agents/settings/agent-screen/` and replaced the W6 target placeholder. Roster rows now navigate to the same URL screen as settings search. Right now reads terminal-aware turns and conversation-scoped harness model snapshots; channel membership acceptance precedes targeted Start, and refused membership never starts an agent. Memory reuses its existing owner reader; Activity gained an inline presentation. Existing settings remain in a disclosure for W9b. Logs stays locked until S2. Owner-key restoration gates screen mount; current single-desktop reports gate desktop mutations without claiming liveness.

Unit counts: 4,099 before, 4,112 after, all passing. All 16 W6/W9a smoke journeys passed in shared Agent Brave. Four named unit cases failed with 13 tests unchanged; three named browser cases failed with nine tests unchanged after mechanism mutations. Restored builds/tests, typecheck, all 17 changed-file Biome checks, the file-size ratchet, palette and scoped px-text checks passed. The two global px-text findings are unchanged parent files. Screenshots at 1440, 1000, 390 and 375 were inspected; no overlap/overflow was found. [W9a handoff](TEST_REPORTS/w9a-agent-screen.md) gives source commits, paths and receipts; detailed output is in `logs/verification.log`.

The real-relay read-only Acid Burn comparison and throwaway channel/cancel checks need an approved owner signing environment. This coder shell has no BUZZ_PRIVATE_KEY; the focus-status attempt returned that auth error. Requested a file path/launch method, not a key value. Keep the local mock evidence separate from desktop/relay acceptance.

2026-10-02 — Fish audio P2 relay + CLI

Implemented `fish:[A-Za-z0-9]{16,64}` in the shared 30182/30183 payload validator and the CLI prefix builder/help. Added shared Fish/ElevenLabs grammar vectors and a Fish E2E accept/readback case. Existing agent-voice tests moved into ingest_agent_voice_tests.rs; all original assertions remain except the updated engine list. CLI: 480 → 483 tests. Relay lib: 1107 → 1113, final 1047 pass / 2 fail / 64 ignored; all 22 agent-voice cases pass. Nine mutations fail named tests with unchanged counts. Clippy/format/CLI help pass; E2E compiles and has nine ignored cases. Mesh echo timeout reproduces on parent sources; serial tests still fail it. Telemetry OFF-filter assertion is intermittent. The clean full-suite gate and isolated E2E execution remain open. Fixture commit: a7bcdd0f8; implementation: 54a36bb43; help regression: 052791e09. [Full files, commands and receipts](TEST_REPORTS/fish-relay-cli.md).

2026-10-03 — P2 live baseline QA supplement

The real Buzz page at :6351/repos/ and :6366/voices/eleven return HTTP 200 (Buzz HTML and 46 voice rows). Agent Brave clicked Settings → Voice & audio → Choose voice → ElevenLabs, filtered Roger and cancelled; screenshot inspected and tab closed. Browser requests show both voice lists at 200; recurring :6881/api/host-stats 401s remain visible. HTTP client traces, snapshot, screenshot and console/network logs are in logs/p2-live-*. These checks cover the served baseline; Fish save/playback remains unverified, and the two full-suite failures remain open. [QA supplement](TEST_REPORTS/fish-relay-cli.md).

2026-10-02 — P3 Fish Audio web and curated voice library

Fish engine unions/parsers, speech routing and huddle overrides now cover every web surface. Voice library offers provider browse/search, id/URL add, signed remove with assignment/self/device-room census and admin-only controls. A shared comparator sorts all lists; removed current voices keep their label, pin to the first picker row and show a badge. Optional huddle labels and effective profile selections preserve that behavior across the local/relay layers.

Baseline/final: 4,175 / 4,212 passing web tests (+37), typecheck, 35-file Biome/lint and build. All 34 mechanism mutations fail named tests at unchanged counts and restore exactly. Agent Brave drove the built Settings page against fake relay and bridge boundaries at desktop/phone widths, verifying real NIP-98 signatures, assignment, preview, remove confirmation, pin/badge and read-only controls with zero page/console errors. The synthetic-host harness excludes PWA registration. Shared grammar vectors match P2 byte-for-byte. Release operator should integrate with P1/P2 before live provider/relay acceptance and iOS rebuilding. [Detailed receipt, full file inventory and mutation log](TEST_REPORTS/fish-web.md).

2026-10-02 — Fish audio P4 native iOS

Native selections and owner assignments accept `fish:[A-Za-z0-9]{16,64}`. Channel overrides admit Fish and strip its prefix for the existing TTS bridge, preserving override > owner > agent > derived precedence. `NativeAgentVoice.bridgeVoice(for:)` extracts the existing playback route so the real override setter is exercised by tests. Raw Fish/ElevenLabs vectors cover both event parsers and routing with fixed 4/19 and 4/18 case counts. The simulator revealed that `$` accepted trailing LF/U+0085, so both cloud-key patterns use a strict `\z` end anchor.

Standalone native suite: 40 → 46 discovered, 31 → 37 passed, nine unchanged app-host/device skips. Voice-policy suite: 11 → 17, all pass. Removing Fish parser admission, loosening its grammar, removing override admission and reverting both strict end anchors each fail named tests with 46 tests still discovered. Restored sources pass the full suite. Source commit: `70461e54c`. [Report, files, runner and mutation receipts](TEST_REPORTS/fish-ios-native.md). This P4 coding handoff covers simulator-native behavior; physical Fish playback is the plan's later acceptance step.

2026-10-03 — P4 live baseline QA supplement

Buzz `/repos/` returned HTTP/2 200 with its HTML and asset `index-DuGYm_0H.js`; ElevenLabs JSON returned 200 and 46 rows. Agent Brave clicked Settings → Voice & audio → Choose voice → ElevenLabs, filtered Roger and cancelled; the screenshot was inspected, dialog dismissal checked and claimed tab closed. Voice-list browser requests were 200. Six existing host-stats 401s were recorded. Exact HTTP client traces are in `logs/fish-ios-live-*-http.log`; a bounded relay-log check had no entry correlated to the probe marker. [P4 report](TEST_REPORTS/fish-ios-native.md) distinguishes this served web baseline from the changed native Swift route and later physical Fish playback.

2026-10-03 — Background Work rail jobs

Built the job namespace, shared lifecycle validator, SDK builder and signed CLI start/beat/end with optional channel detection/turn binding. Beats refuse terminal heads, end is idempotent, and missing heads are recreated from role/start flags. The web rail keeps jobs independent of turns/reactions, excludes seat chat summaries and moves silent jobs to dropped after 300 seconds. ACP production behavior is unchanged; its bound-job sweep guard pins exclusion.

Counts: core 301 → 311 plus two unchanged doctests; SDK 269 → 271; CLI 483 → 490; ACP 1021 → 1022 plus nine unchanged integrations; web 4213 → 4225. Relay lib 1113 → 1115 discovered, with its existing mesh echo 504 persisting; telemetry failed only in baseline. Isolated relay E2E 3 → 5 and browser Work-status 5 → 7 pass. All 35 compiling mutations fail named tests at unchanged selection counts and restore bytes/mtimes. The actual release CLI accepts start/beat/end, refuses a late beat at exit 1, and returns unchanged on repeat end. Full just test passes on repeat after an unrelated steering failure; direct control of that unchanged agent file passes 20/20. Production-target Clippy passes; all-target Clippy finds the unchanged claims_gate.rs:878 lint.

Temporary private databases, fresh keys, relay process and .env are removed on every exit. Agent Brave could not intercept the WebSocket canary; headed Playwright supplied browser coverage. Fleet scripts/plugin and the relay-first rollout are separate from this coding scope. Every mutation and receipt is documented in TEST_REPORTS/work-rail-jobs.md.

2026-10-03 — QA-JOB-001 Done outcome clipping

Shared Done rows put abnormal outcomes at the start of their second line and preserve successful rows. Untitled failures gain a second line. Commit `8e42370` includes the UI and six browser geometry cases using realistic long names; the helper checks label/text rectangles against every clipping ancestor without horizontally scrolling the label. All six fail on the original layout and pass with the fix; full Work-status 13/13, web units 4,225/4,225 and build pass. Rail/full/phone screenshots in both themes are under logs/qa-job-001-fix. Agent Brave WebSocket canaries timed out; supported headed Playwright supplied browser acceptance. See TEST_REPORTS/qa-job-001.md for commands, fail-first evidence and unchanged file-size findings.

2026-10-02 — Parity W5a canvas editing

Canvas has Edit with a markdown textarea, Save, Cancel and confirmed Clear. The builder follows buzz-sdk's regular 40100 event with one h tag; blank content clears. Publish refusals remain visible with the draft intact, and rendered content changes through the canvas subscription's echo. Members can write while connected in an unarchived channel. Rapid same-second edits advance beyond the current canvas timestamp; remote updates preserve the draft with a replacement warning.

About > Canvas reaches an empty canvas, and phones open the same view in a full-screen sheet. These required RightPaneHost/CanvasPane additions extend the plan's two-file list without adding another feature. Web unit counts: 4,123 before, 4,132 after. Typecheck, build, all eleven touched web-file Biome checks, file-size, palette and scoped text-token checks pass. Full Biome's 28 errors and global px-text's two violations are in unchanged parent files. A wire mutation kills four named unit tests with 4,132 tests unchanged; disabling empty/phone reachability kills all four built-app browser workflows, which pass again after restoration. One native-dialog CDP error was addressed in the test driver by accepting and asserting the page-local confirmation; unit tests exercise both confirm outcomes. Twelve screenshots cover Edit, Saved and Clear at 1440/390 in both palettes, with no horizontal overflow. Tests run on Agent Brave with independent browser contexts and mocked relay traffic. Live private-channel acceptance requires enrolled test credentials absent in this worktree. Full report: TEST_REPORTS/parity-w5a.md; receipts: logs/verification.log; screenshots: .scratch/w5a/.

2026-10-03 — Parity W5b channel workflows

Built the sheet Workflows tab, channel-scoped rows/latest run badges, and YAML create/owner edit. Edits preserve workflow identity and expected revision; draft retries retain their UUID. Live syntax/shape errors lock Save, relay refusals stay verbatim and text-only, and membership/archive/offline state locks writes. The existing YAML reader now reports source lines and rejects duplicate keys/documents while treating prototype keys as data.

Web units: 4,225 before and 4,243 after; 18 new tests. Fifteen compiling unit mutations kill all 18 added tests by name with 45 tests selected. A built sheet-branch mutation kills all four browser journeys. Required TypeScript, scoped Biome, build and local-main file-size checks pass; default size/px checks flag unchanged baseline files. Agent Brave exercises signed create/edit/live echo, run status and refusals in both themes; twelve inspected artboards cover 1440/390 with 375 geometry assertions. See TEST_REPORTS/parity-w5b.md and logs/verification.log.

Live private-channel acceptance still requires an enrolled signer: this coding shell returns BUZZ_PRIVATE_KEY required. Starting base is 8b73b15b526cafc88dcb34ba279b26348ef6ed83; local main gained W2/W5a during the run. Compose the sheet Workflows and Members branches from their parents during integration.

2026-10-03 — W9b1 agent settings cards

W9b1 builds Model & thinking, Runtime and Who can instruct cards, with W7 desktop-ack drafts, guarded navigation, named people, runtime-specific sealed API-key patches and scoped timeout echoes. Unreadable values remain blind; later-phase controls stay locked. Validation: 4,252 → 4,265 units, typecheck/build/22-file Biome and 15 W9a/W9b1 browser cases; nine named component mutations and one screen-reversion browser failure. [W9b1 evidence](TEST_REPORTS/parity-w9b1.md). Actual desktop application remains a separate acceptance task.

The resumed adapter layer was preserved. Only the W9b1 task-list additions conflicted with the integration base; both parents were composed without dropping entries. Timeout echoes are browser-authored and scoped to owner, relay, agent and machine; secrets never enter drafts, receipts or storage. Phone sub-pages share one draft. Tests include actual command decryption, acknowledgement/refusal/reload, people names, guards and stale locks. A fixture registry/catalog timeout occurred once in the final combined browser run; the unchanged repeat passed all 15 cases. Keep that intermittent observation in the handoff.


2026-10-03 — Safe details/summary chat markdown

Desktop and web share the constrained remarkDetails implementation: optional bare open, native summaries with inline markdown, same-parser markdown bodies, nesting and missing-close containment. All other HTML stays escaped. Pulse cards inherit MarkdownContent. Source: a2542b7fc; DOM/browser regressions: fcfcab3.

Desktop units 5,762 → 5,779; web 4,252 → 4,272, both full suites green at four workers. Both typechecks, web build, touched-file Biome, palette and desktop text checks pass. The web global text check retains the parent's two unrelated px literals; changed-source scan passes. A no-op mutation fails 13/31 desktop and 16/20 web selected cases, and restoration passes at unchanged counts. Two Agent Brave built-client cases with mocked relay events verify both shapes by mouse and keyboard in both palettes. [Report and receipt paths](TEST_REPORTS/markdown-details.md).

2026-10-02 — Parity P0: catalog v5 caps, guarded owner-admin application, structured bounded acks, ping/presence, and offline controls. Web tests 4092 -> 4107; desktop 5762 -> 5769. Guard mutations killed 7 web and 6 desktop tests without changing total counts; the rebuilt hook-wiring mutant failed the browser online assertion, then the restored scenario passed. Agent Brave screenshots cover 1440 and 390, with 375 overflow also checked. Main advanced during the run, so size comparisons use the phase base 301cc534824; moving-main and pre-existing px-text findings are explained in docs/TEST_REPORTS/parity-p0.md. Root CLAUDE is a symlink to AGENTS. W6/W7 are separate phases; reuse the presence lock API when composing them.

2026-10-03 — P0 verifier fixes: merge parent 66bc5b0c8 incorporated in ed43126c9; changes 0c7883d59, 192c026db and 8a6736502. Preserve enablement and sealed sending for all eight legacy v4 admin actions, with v4 presence still unknown and named v5 requirements locked. Persistent owner/machine replay receipts are claimed before save, retained through the freshness window and never count-evicted; storage failures refuse application. Compose the P0 gates/footer with W6/W9a and remove the obsolete AgentsSection wrapper. Web 4,277 and desktop 5,775 tests pass. All sixteen new tests fail under targeted mutations at unchanged counts; the rebuilt Agent Brave scenario fails on the v4 disabled Stop with the fix reverted, then passes restored. Both typechecks, scoped Biome, build and size check against merged main pass. Default origin/main size base is stale and flags two unchanged main files; use CHECK_FILE_SIZES_BASE=66bc5b0c8. Full receipts, at-most-once crash semantics and R1 acceptance boundary: docs/TEST_REPORTS/parity-p0-verifier-fixes.md.

2026-10-03 — W11b definition extras

Library definitions now edit/clear ordered name pools and duplicate the saved relay head into a private fresh UUID named "(copy)". Copies preserve prompt/configuration bytes and remove catalog-sharing tags. Definition edits validate raw text before name normalization and preserve prompt whitespace, closing the previous leading-FEFF stripping bypass. Name pool entries reject invisible formatting before trimming.

Q5 resolved from PersonaShareDialog and the native snapshot encoder: targeted sharing materializes local definitions/global defaults into a PNG snapshot, then delivers a DM attachment. The external PLAN phase list, W11b/L3 sections and coverage matrix assign it to L3 under the approved contingency. Amendment receipt: TEST_REPORTS/parity-w11b-plan.patch.

Baseline 4,345 / restored 4,355 units, 21 focused tests and eight headed browser cases pass. Six mechanism withdrawals fail named unit tests; restoring the original editor and rebuilding fails the pool workflow, whose restored selection passes. TypeScript, build, touched-file Biome, palette, scoped px-text and local-main size checks pass. Broad lint/text/default size gates retain unchanged baseline failures. Agent Brave WebSocket interception failed a canary; headed fallback supplied inspected 1440/390 screenshots in both asserted palettes. Live reconciliation requires an authorized owner signer and reporting desktop. Full receipt: TEST_REPORTS/parity-w11b.md; raw output: logs/verification.log.

2026-10-03 — Parity W8a roster

Finished the interrupted roster work using existing admin wire paths and W9a URL navigation. Added live owner tombstone application, acknowledgement timeout/unmount safety, offline locks, readable phone filters and reachable wide columns. Before/after web counts: 4,252 / 4,278; final eight Agent Brave workflows pass, including actual snapshot download and DM navigation. Six named unit mutants fail at 26 tests each; two rebuilt-browser mutants fail their selected case. Screenshots and receipts live under .scratch/w8a/ and logs/verification.log. The existing speech-order timing case and shared-browser transient failures are documented in TEST_REPORTS/parity-w8a.md. Live throwaway-agent acceptance remains for an enrolled owner test environment.

2026-10-03 — W8a integration with current main

Composed W8a's roster with main's Library/New agent/CreateAgentScreen/DetailPane, P0 presence boundaries/footer, W9b1 cards and W5b. Presence gates now disable row mutations and bulk lifecycle/confirmation controls. Fixed stale Unregister's empty-claim lock by checking all receiving desktops; other unclaimed mutations stay locked. Updated W11a/P0 roster selectors. Source commits: 9ca341a56 and c2a086670.

All 4,373 web units, typecheck, 26-file Biome, restored build and all 37 requested browser cases pass. A rebuilt one-case lock-withdrawal mutation fails at the row Start control; restoration passes. Shared Brave's standalone WebSocket canary failed, so E2E used the isolated headed fallback. Inspected 1440/390 roster screenshots and full evidence: [W8a integration receipt](TEST_REPORTS/parity-w8a.md#current-main-integration--2026-10-03). The scoped integration has no remaining tasks; earlier live-relay acceptance stays separate.

2026-10-03 — Vitals per-account simulation

The combined forecast now carries per-account first-empty times, whether they precede the next reset, next-reset usage and takeover provenance. VitalsBlock computes one forecast for its short text and panel; account lines and the lower hot-account dry text use it. Existing combined-runway assertions remain unchanged. The trace is a non-enumerable property to preserve the previous result object's enumerable shape.

The exact 14:21:30Z fixture gives A empty at 18:56:54.909Z and the pool/B empty Sun 21:40:48.202Z. The current allocator sends A the sum of A+B demand; the requested A≈19:13Z instead uses A's solo burn. Those requirements conflict. Allocation was preserved; an optional clarification was requested, with no answer received. The A≈19:13Z acceptance criterion remains unresolved, without approval to defer or waive it.

Web baseline 4,320; eight added tests give 4,328. Typecheck, four-file Biome and build pass. Ignoring the simulation in accountLines fails four named tests with the same full-suite count; restoring source returns the suite to green. Headed Playwright with the existing shell/mock-relay helpers covers 1440/390, matching sidebar/headline/lines, lower-row timing, bounds and dismissal. Agent Brave's WebSocket canary timed out; its owned tab was closed. Screenshots were inspected and both isolated contexts closed. [Exact commands, fixture math, mutation names and local artifacts](TEST_REPORTS/vitals-account-runway.md).

2026-10-03 — Parity W9b2

Identity/upload, linked Library entry, patch-only environment rows and confirmed removal are integrated into the existing W7/W9b1 draft. Secret values never enter draft receipts/storage. Active shared hooks and Library/creation/roster responsibilities were extracted before removing the four legacy module paths. Public settings keep their existing version gates. Source checks and the built Agent Brave journeys pass; the operator acceptance item needs an authorized test owner signer. Full counts, mutation kills, artifact paths and deviations: [W9b2 report](TEST_REPORTS/parity-w9b2.md).

2026-10-03 — W9b2 current-main composition

Source `5e66e7718` composes W9b2 parent `14a53f7b1` with main parent `775f6db5f`. AgentManagementSection now uses W8a RosterTable with P0 presence controlLock; the duplicate AgentRosterList is removed and its shared working dot lives in AgentWorkingDot. All Library/create/footer/navigation/cards and both parents' Playwright registrations are preserved. 4,421 units and 50 requested browser cases pass, as do TypeScript, 39-file Biome and build. Withdrawing the composed lock fails the named row-disable case; exact restoration/rebuild passes. The first combined run had one pre-assertion navigation timeout; the unchanged named and full reruns pass. [Full receipt](TEST_REPORTS/parity-w9b2.md#w9b2-composition-with-current-main--2026-10-03).

2026-10-03 — Huddle archive discovery

Grace-fire archives now refresh kind:39000 and evict channel subscriptions, preserving the end outcome and normal-call silence. Startup reconciliation repairs archived, non-deleted channels using database-resolved community/host contexts, keyset pagination and 100-row batches; errors are logged and the worker never blocks startup. The fork manifest separates the upstreamable grace fix from the fork-local backfill.

Library inventory: 1,115 before, 1,119 after (four added Postgres-gated tests, explicitly executed). Serial baseline and final both have 1,050 passes and the same mesh echo failure; ignored counts are 64 and 68. All 18 huddle tests and 13 binary tests pass after restoration. Removing the emit call and removing the selector archived-tag predicate each fail their named test with the full inventory unchanged at 1,119. Strict Clippy and formatting pass. Full-suite completion remains blocked by the unchanged mesh test; no gate waiver was approved. Scope excludes deployment, live-database access and canonical-checkout writes. [Commands and receipts](TEST_REPORTS/huddle-archive-discovery.md).

2026-10-03 — Huddle archive runtime QA

The rebuilt worktree relay returned readiness HTTP 200 with {"status":"ready"}; request-specific GET logs show status 200 and 11 ms. Agent Brave manual sign-in, private parent selection and message send rendered, and the persisted message was read back. A real audio join/disconnect triggered the 30 s grace and a valid archived=true kind:39000. The web transport room was already TTL-filtered, so live sidebar disappearance and desktop acceptance are not claimed. Optional host-stats CSP errors were observed; no page exceptions. Owned tab/process/container/database and generated key fixtures were cleaned up. [Runtime receipt](TEST_REPORTS/huddle-archive-discovery.md#isolated-runtime-qa).

2026-10-03 — Web layout bugs vcrxm3xrk920 / je8htrkcvrcd

Canvas width is capped against the shell row after the resizable sidebar, reserving 400px chat and the resize handle; a row below 723px uses the existing pane as an overlay. Phone sheets and explicit expansion retain their paths. Hover toolbars no longer translate above their message, protecting the preceding open thread reply box. Painted regression coverage is in web/tests/e2e/conversation-layout.spec.ts; evidence is collected under .scratch/layout-bugs/.

Web layout verification: 4,421 units before/after; typecheck/build, five-file Biome and original-base file-size check pass. Full lint retains its two baseline errors. All 18 new painted regressions and six related Canvas workflows pass after three compiling mutations fail six named tests. Agent Brave captured both bugs at 1440/1280/1054/900 and proved reply input clicks, sidebar-driven overlay and explicit expansion; its owned tab and local server are closed. The runner used the supported headed fallback after Brave WebSocket canary failure. See TEST_REPORTS/web-layout-bugs.md for commits, counts, exact commands and .scratch/layout-bugs/ receipts.

2026-10-03 — QA-WEB-LAYOUT-001 narrow toolbar follow-up

Source `a286ae533` uses message-row container queries to drop quick reactions progressively, preserves More actions, bounds narrow toolbars and reduces padding for a 32px compact bar. Four new painted cases in conversation-layout.spec.ts cover both palettes: every visible 1054px/Canvas action lies inside chat and receives pointer input; clicking 👍 emits the correct kind-7 event and renders its echoed chip; grouped bars remain within their rows while quick reactions restore as width grows.

4,421 units, typecheck, four-file Biome, file-size and build pass. The restored original E2E selection passes 28/28 in headed fallback. Reverting the containment fix fails both named 1054px cases at x=152.31 against chat x=263; restoring 3px padding fails both compact cases at height 36px against 32px. Agent Brave independently paints/clicks the built fixture UI; its owned tab and preview process are closed. All mutations match the committed source after restoration. See TEST_REPORTS/web-layout-bugs.md#qa-web-layout-001-follow-up and .scratch/layout-toolbar/ for receipts. The existing live-relay acceptance boundary remains separate from this coding follow-up.

2026-10-03 — Work dock usable minimum

Source 5efb88b7f shares the existing 320px Work/Canvas minimum and 723px row-query overlay. Narrow Work now overlays rather than clipping beside 400px chat. Back to chat closes Canvas, selects Work and folds the rail; both tabs stay reachable, folded reopening works, and widening restores the preferred width.

Twelve painted tab/sidebar cases replace two Canvas-only cases. Baseline reproduces squeezed Work and missing Back. Three rebuilt mechanism mutations produce eight named failures with unchanged selection counts. Restored source matches the commit and 38 selected browser workflows pass. All 4,421 units, TypeScript, build, touched-file Biome and the baseline-based size gate pass. Agent Brave WebSocket canary timed out, so the documented isolated headed fallback supplied the painted runs and inspected screenshots. Receipts: .scratch/work-dock/ and logs/verification.log. Report: TEST_REPORTS/web-layout-bugs.md#work-dock-minimum-follow-up--2026-10-03.


2026-10-03 — Item capture attachments x5fq4jncejx5

Description now supports multi-file Attach, file/image paste and drop using the shared composer queue, transport and tray. Completion inserts filename markdown at the live selection; pending uploads lock create, body updates enforce 16,384 UTF-8 bytes, and removed/closed uploads cannot insert later. Expanded Notes uses the timeline signed-media/lightbox renderer; no body edit view exists. The Web chat client manifest row carries the change.

4,421 -> 4,437 units, typecheck/build, eleven-file Biome and the base-relative size gate pass. Full lint retains two baseline errors. Seven unit mechanism withdrawals fail named tests at 16 cases; the create-wire body mutation fails its single browser case. Restored direct Agent Brave workflows pass at 1440/390, with six inspected screenshots. MCP sign-in actionability timeouts supply no acceptance claim; relay/media responses in the passing checks were mocked because this shell lacks an enrolled signer. See TEST_REPORTS/item-attachments.md and logs/verification.log for handoff details and raw paths.

2026-10-03 — Hidden DM resurface

Incoming kind-9/40002 messages restore other active hidden DM members asynchronously, with full relay-signed NIP-DV snapshots. Sender/later hides, duplicates, non-chat kinds and streams retain their state. A one-shot, tenant-resolved, 100-viewer worker repairs historical hides and retries stale snapshots; retained chat still qualifies after soft deletion. Source/test handoff: 847fada6e, 9e742679c, 0bcf72d3c, 9bd2b9200 and 1b19d1e1a. Eleven new PG tests, ten real NIP-DV cases, two built-relay startup checks and twenty compiling mutation kills pass. Final relay inventory 1,128 (1,051 pass / 77 ignored), DB 325 (113 pass / 212 ignored), test client 296 (6 pass / 290 ignored). Standard Clippy/build/fmt and just test pass; parent controls identify intermittent mesh echo 504 and the existing broader Clippy ordering error. [Handoff and rollout command](TEST_REPORTS/dm-resurface.md).


2026-10-03 — OAuth-expired ACP batch recovery

ACP retains auth-failed messages in a pubkey-keyed atomic journal, probes every 60 seconds without retry-budget cost, caps parking at six hours and posts one threaded notice per channel until success/dead-letter. Startup restores unexpired work with original receipt order and cancelled context. Queue and Drop modes share recovery; ordinary error/quota paths retain their behavior. 1,022 -> 1,032 units plus nine integrations, strict Clippy and fmt pass. Removing the new classifier arm fails the named regression; restored full suite passes. [Evidence and journal path](TEST_REPORTS/oauth-auth-parking.md).


2026-10-03 — OAuth parking QA round 2

Auth notices now persist suppression after signed HTTP publication returns `accepted:true`; failures clear the pending token and retry on a probe or journal reconstruction. The startup queue constructor and actual result-handler notice gate have named regressions. Three added tests give 1,035 units plus nine integrations; startup-load removal, handler gate bypass, early suppression, classifier-arm removal and ignoring HTTP 200 refusal each fail a named test. Strict Clippy/fmt and restored suite receipts are in [the OAuth report](TEST_REPORTS/oauth-auth-parking.md#round-2--accepted-notice-acknowledgement-and-production-wiring). A binary kill/restart fixture exceeds the bounded fixture scope; combined ACP-process restart acceptance remains unverified.


2026-10-04 — ACP account-aware quota failover

Actual slot accounts are marked out with timezone-parsed reset deadlines. Account availability lives in `.buzz/state/pool-status.json` (`BUZZ_POOL_STATUS_PATH` override), using the existing claims sidecar lock plus atomic replacement. Routing rereads shared state, prefers assigned, otherwise an available sibling, otherwise earliest reset. Repeated errors retain the earlier active deadline to prevent sliding fallback deadlines causing flip loops. Pre-turn checks preserve even Drop-mode batches and request the existing crash-free overflow respawn before any session RPC. Ledger records mark_out, flip, return_assigned and all_out with exact deadlines.

1,035 → 1,043 units and nine integrations pass; final release build, strict Clippy and formatting pass. Replacing actual-slot attribution with assigned attribution fails `auth_pool::tests::incident_quota_on_a_returns_to_available_b` (FlipTo A instead of B), with one test executed and 1,042 filtered; restored full inventory remains 1,043. [Handoff and receipts](TEST_REPORTS/auth-pool-account-aware.md).

2026-10-04 — Live sidebar QA

Expanded Channels and DMs in an owned Agent Brave tab and captured three screenshots, SQL histories, sanitized rows and console output. Bundle index-BsVfa0lu.js matches installed index; /health returns 200 ok. Account menu says Crash Override, so Sam-specific ranking cannot be certified. Console records 18 host-stats 401 errors. No messages sent, identity changed or source modified; owned tab closed. [Report](TEST_REPORTS/test-report-2026-10-04-1021.md).

2026-10-04 — Voice streamed replies, web chain (plan steps 0, 4, 5)

Web side of streamed voice replies. Agent kind-24820 segments are spoken sentence by sentence through `player.speakStream`, with one request prefetched ahead, including a segment that arrives mid-play. The tagged final kind:9 speaks only the unspoken tail. An untagged CLI copy is suppressed at ≥60% word overlap within 20 s. Barge-in cuts the stream. Setting localStorage `buzz.voice.streamedReplies=false` restores today's path. Nothing changes until a harness emits 24820. Latency: `window.__buzzVoiceLatency` (t0/tSeg0/tTts0/tAudio0) and buzz-tts-bridge `[tts] at=<ISO>` (infra commit dad252e; it takes effect only after `./deploy-dev.sh --restart-only` in `infra/buzz-tts-bridge`). Web tests: 4,473 → 4,517. Mutations M1–M21 each turn a named test red. M22, the hook-level cut on interrupt, is an equivalent mutant: the stopped stream's queue has no consumer. `speak()` fallback now re-speaks from the failed sentence rather than from the start.


2026-10-05 — Left-nav unread redesign, phases 0–3

Implements docs/LEFT_NAV_ARCHITECTURE_REVIEW.md §3–4 (Sam chose the full redesign). Branch commits: phase 0 `921c42171`, phase 1 `ca326ba7a`, phase 2 `3481f29a7`, same-second fix `ab05b6eb5`, phase 3 `befb230b2`.

What exists now: `web/src/features/activity/` holds the conversation-activity store (one counting subscription family for every conversation, DMs first and `critical`), the read-marker store (the only copy of read markers and the inbox overlay; NIP-RS merges/publishes through it), the page-attention gate (`useMarkShownSeen`: visible + focused + not covered; iOS app visibility only) and the unread trace (`window.__buzzUnreadTrace`, 200 entries, marker sources `open`/`menu`/`evict`/`storage`/`sync:<slot>/<client>`). The rail lifts unread rows past the six-row cutoff ("N more · K unread") and holds only the row under the pointer and its neighbours.

Divergences found while building I1 on the real hooks: (1) the desktop app marks its active conversation read with no visibility/focus gate and publishes it (`desktop/src/features/channels/ui/useChannelOpenReadState.ts`) — with Buzz.app running on crichton it is a live cause-A source the web gate cannot stop; (2) a second message in the same second was dropped (no toast, no count) — fixed; (3) "Mark read" used the 39000 time and left the row unread — fixed; (4) a window that opened empty at the marker never toasted its next message — fixed by I2. Next report: dump `window.__buzzUnreadTrace` in the PWA.

Verification: web units 4,523 (+1 todo) → 4,539, 0 fail; tsc and Biome clean on touched files; smoke e2e 278 → 280 tests, failures limited to the five pre-existing ones (messages slash ×2, parity roster, work-shell rail ×2) — shelf 104 failed once at 00:0x because its fixture collapses "today" timestamps right after midnight, and passed on re-run. Mutation proofs for I1–I5 are in the coder report.


2026-10-06 — Left-nav QA round (22-scenario matrix)

QA's `web/tests/e2e/unread-scenarios.spec.ts` (42 runs) failed 12; all pass now. Fixes, one commit each: mute is one rule everywhere (no toast, pill, OS notification, badge or sound — this reverses the older "mute only silences sound" rule); a row is unread exactly when the store counts unread; DM rows have Mark read; reconnect replay rounds count but never toast (`RelaySession.onConnectionLost` → `beginReplay`); adding a conversation opens its own batch instead of re-subscribing all, and a message created after the feed started is live even before EOSE (`liveSince`); "in thread" toast copy; folded DM header shows the unread count; NotificationRuntime rides the store's `onArrival`; `isViewingConversation` (pageAttention.ts) is the one "looking at it" rule for markers, toasts and OS notifications. Spec #21 now expects Channels3 (it counted the muted DM). Units 4,551 pass; smoke e2e 322: 314 pass, 3 skip, 5 pre-existing failures (messages slash ×2, parity roster, work-shell rail ×2).


2026-10-05 — Canvas: edit shared files on disk, agent box (branch claude/canvas-edit)

The Canvas file pane now reads the share's `host:path` file through stash's `locate` / `GET /file` / `PUT /file` (stash adds CORS for those three routes, separate stash branch). It previews the disk copy ("Live · crichton", "Edited since shared", "View shared version"), polls with `mtimeMs` every 3 s while visible (304 = nothing), and edits in a plain Textarea with a Preview tab, Save/Cancel, Cmd-S/Esc, a changed-on-disk banner and a 409 panel (show theirs / overwrite with the server digest / copy draft). Ten read-only reasons. Disk mode runs only for a share by the viewer or a known agent (`diskTrusted`), because the path comes from an event any member can author and the read/write uses the viewer's stash session. The comment box is the agent box: To: the agent author, else a picker over agent members (last agent replier, then sole agent), else a plain note; messages end with `[file: name · host:path]`, which the thread shows as a chip. A dirty draft offers Save and send (PUT before publish). The base prompt tells agents to act on a trailer only when it names the file they themselves shared in that thread's root. Web unit 4,517 → 4,541; buzz-acp lib 1,077 → 1,078; e2e canvas-file-edit 11 + shelf 12 green. Mutation proofs in the coder report.

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

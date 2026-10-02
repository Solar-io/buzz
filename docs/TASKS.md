- [x] Work row context: title → own in-turn message → trigger/parent precedence, bounded history fetching, unit boundaries, two mutation kills, and desktop/phone fixtures.
- [x] QA 63eeb8a14: 4,081 unit tests, static/build checks, Work E2E, Agent Brave, request census, edge cases and precedence mutation. Findings: docs/TEST_REPORTS/qa-work-63eeb8a14/test-report-2026-10-02.md.
- [x] QA-WORK-001 (High): fixed — live kind-9 subscription for running turns and Done turns inside a 90 s grace (`liveSlots`); regression `web/tests/e2e/work-activity.spec.ts`.
- [ ] QA-WORK-002 (Medium): prune lifetime activity/tried maps when pair windows/channels expire; add churn coverage.
- [ ] QA-WORK-003 (Medium): keep fenced-code language markers out of meaningful row summaries; define non-text fallbacks.

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

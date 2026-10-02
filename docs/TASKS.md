- [x] Work row context: title → own in-turn message → trigger/parent precedence, bounded history fetching, unit boundaries, two mutation kills, and desktop/phone fixtures.
- [x] QA 63eeb8a14: 4,081 unit tests, static/build checks, Work E2E, Agent Brave, request census, edge cases and precedence mutation. Findings: docs/TEST_REPORTS/qa-work-63eeb8a14/test-report-2026-10-02.md.
- [x] QA-WORK-001 (High): fixed — live kind-9 subscription for running turns and Done turns inside a 90 s grace (`liveSlots`); regression `web/tests/e2e/work-activity.spec.ts`.
- [ ] QA-WORK-002 (Medium): prune lifetime activity/tried maps when pair windows/channels expire; add churn coverage.
- [ ] QA-WORK-003 (Medium): keep fenced-code language markers out of meaningful row summaries; define non-text fallbacks.

- [ ] Parity A1: implement pubkey > display name > wildcard > env resolution for each turn knob; add marked-turn `voiceModel`; wire both harness call sites.
- [ ] Parity A1: add six named regressions plus tier/type edge cases; show mechanism mutations failing with unchanged test counts.
- [ ] Parity A1: run web baseline/final, typecheck/build/size checks and buzz-acp tests/clippy; record handoff and commits.

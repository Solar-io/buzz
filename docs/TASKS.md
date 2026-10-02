- [x] Work row context: title → own in-turn message → trigger/parent precedence, bounded history fetching, unit boundaries, two mutation kills, and desktop/phone fixtures.
- [x] QA 63eeb8a14: 4,081 unit tests, static/build checks, Work E2E, Agent Brave, request census, edge cases and precedence mutation. Findings: docs/TEST_REPORTS/qa-work-63eeb8a14/test-report-2026-10-02.md.
- [x] QA-WORK-001 (High): fixed — live kind-9 subscription for running turns and Done turns inside a 90 s grace (`liveSlots`); regression `web/tests/e2e/work-activity.spec.ts`.
- [ ] QA-WORK-002 (Medium): prune lifetime activity/tried maps when pair windows/channels expire; add churn coverage.
- [ ] QA-WORK-003 (Medium): keep fenced-code language markers out of meaningful row summaries; define non-text fallbacks.

- [x] Parity A1: implement pubkey > display name > wildcard > env resolution for each turn knob; add marked-turn `voiceModel`; wire both harness call sites.
- [x] Parity A1: add six named regressions plus tier/type edge cases; show mechanism mutations failing with unchanged test counts.
- [x] Parity A1: run web baseline/final, typecheck/build/size checks and buzz-acp tests/clippy; record handoff and commits. Evidence: [A1 report](TEST_REPORTS/parity-a1.md).
- [ ] Parity A1 release acceptance (plan: after R3): a throwaway agent's pubkey-keyed `voiceModel` changes the next marked turn's observed model without a restart.

- [x] W6: settings IA, owner landing, phone root, agent search/redirect, desktop report footer; existing controls remain reachable. Evidence: docs/TEST_REPORTS/w6-settings-ia.md.

- [x] W9a: agent header, roster stepping, URL tabs, lifecycle/menu and existing settings access.
- [x] W9a: Right now live model switch/cancel, channel add then start and remove, Memory/Activity; locked Logs.
- [x] W9a: phone sub-pages, responsive cards, behavioural/mutation tests, scoped web gates and screenshots. Evidence: [W9a report](TEST_REPORTS/w9a-agent-screen.md).
- [ ] W9a live acceptance: read-only Acid Burn comparison, then test-channel add/remove and cancellation on a throwaway agent. Needs an approved owner signing environment; this coder shell has no BUZZ_PRIVATE_KEY. Local mock journeys cover the client wiring.

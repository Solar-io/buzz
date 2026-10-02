- [x] Work row context: title → own in-turn message → trigger/parent precedence, bounded history fetching, unit boundaries, two mutation kills, and desktop/phone fixtures.
- [x] QA 63eeb8a14: 4,081 unit tests, static/build checks, Work E2E, Agent Brave, request census, edge cases and precedence mutation. Findings: docs/TEST_REPORTS/qa-work-63eeb8a14/test-report-2026-10-02.md.
- [x] QA-WORK-001 (High): fixed — live kind-9 subscription for running turns and Done turns inside a 90 s grace (`liveSlots`); regression `web/tests/e2e/work-activity.spec.ts`.
- [ ] QA-WORK-002 (Medium): prune lifetime activity/tried maps when pair windows/channels expire; add churn coverage.
- [ ] QA-WORK-003 (Medium): keep fenced-code language markers out of meaningful row summaries; define non-text fallbacks.

P0 — owner-admin protocol foundation:
- [x] Advertise catalog v5 capabilities; preserve older catalog readers.
- [x] Parse requirements and timestamps; refuse unsupported or stale writes before applying.
- [x] Ping response and structured, byte-budgeted acknowledgements.
- [x] Web capability intersection and sealed command/ack transport.
- [x] Mounted/focus desktop presence, offline locks, and connection footer.
- [x] Shared fixture corpus, fail-first regressions, static/build checks, responsive browser evidence.

P0 evidence: `docs/TEST_REPORTS/parity-p0.md`.

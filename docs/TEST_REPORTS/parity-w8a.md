# W8a roster handoff — 2026-10-03

W8a implements the read-only agent roster, counted filters, content-width layouts, row menus, bulk lifecycle/channel actions, and desktop acknowledgement receipts. The interrupted work was preserved; current main was brought into this branch, composing the roster with W9a's URL navigation from both parents.

- Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-172232`
- Branch: `codex/buzz-codex-20261002-172232`
- Latest source commit: `6b3eb0fe9`
- Integration parent: `66bc5b0c8`; integration commit: `2d1367a75`.

## Task Completion Summary

| Field | Value |
|---|---|
| Changes | Responsive roster and filters; read-only values; targeted lifecycle and channel actions; ack/refusal/timeout receipts; live unregister deletion. |
| Artifacts | 22 web files listed below; docs/TASKS.md, docs/PROJECT_STATUS.md, docs/LAST_CHAT.md, this report; logs/verification.log; .scratch/w8a/. |
| Bugs | Unregister ghost/replayed rows; stale desktop controls; abandoned ack waits; cramped phone search; unreachable wide columns. |
| Unit Tests | Pass: 4,252 before, 4,278 after; 26 new behavioral tests. |
| E2E Tests | Pass: 8/8, built Vite preview through Agent Brave, simulated relay/desktop boundaries. |
| Next Action | stop |
| Next Reason | Coder implementation and local acceptance contract complete; handoff ready for the tester. |
| Blockers | Real-relay acceptance requires an owner signing environment; BUZZ_PRIVATE_KEY is absent in this coding shell. |
| Remaining Tasks | 1 live acceptance run against throwaway agents and a private channel. |
| % Complete | 100% of coder scope; live acceptance remains. |
| GitHub Updated | not needed — excluded from this task |
| Snapshot Taken | not needed |
| TASKS.md Updated | complete |

## Verification

Before adding W8a behavioral tests, the integrated worktree ran 4,252/4,252. The final `pnpm --dir web test` runs 4,278/4,278, zero skipped/cancelled. The same loader is used for focused mutation runs.

`pnpm --dir web typecheck`, Biome on all 22 changed web files, `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs`, `pnpm --dir web build`, palette literals, and changed-file px-text checks all succeed. Desktop and Rust sources were not changed by W8a. Git diff whitespace checks and the scan for actual git conflict-marker lines (including diff3 base markers) are clean.

The global px-text command still reports `GeometryDiagnosticOverlay.tsx:34` and `CustomGradientThemeEditor.tsx:136`; both are byte-identical to the integration parent. The existing speech-order test failed one full run on its 60 ms timing window: its test and implementation are unchanged from that parent, its isolated suite passes 64/64, and the final full suite passes. Shared Brave also produced an intermittent dialog-protocol error and a click timeout; the final unchanged-bundle rerun passes all eight workflows. Logs retain these failed attempts as well as the successful receipts.

The browser spec covers counted/team/name/model filters; wide columns and dropping them at a 1000 px viewport; W9a agent URL navigation; two-machine Restart, both acks and Working cycles; stale Unregister, live removal and late replay; row Stop/refusal and actual JSON snapshot download; successful/refused two-key channel adds; offline locks; row Start and Message into a served DM; and phone selection/overflow.

Screenshots inspected for overlap and clipping:
- `.scratch/w8a/screenshots/roster-1440.png` (1440 × 960)
- `.scratch/w8a/screenshots/roster-390.png` (390 × 844, bulk selection)
- Export artifact: `.scratch/w8a/screenshots/acid-snapshot.json`

## Fail-first evidence

Every mechanism was committed before mutation and restored from its immutable commit afterward. These six mutants preserve the focused test count at 26; each named test fails, and restoration passes 26/26.

| Disabled mechanism | Named failing test | Baseline / mutant count |
|---|---|---|
| stale-filter | `Not on any desktop equals the findStaleAgents set` | 26 / 26 |
| content-width | `width 1000 drops Runtime and Acct` | 26 / 26 |
| machine-target | `bulk Restart sends one restart per selected agent targeted at its machine` | 26 / 26 |
| tombstone-removal | `desktop unregister tombstone removes the row and blocks late head replay` | 26 / 26 |
| ack-wait | `roster receipts wait for application acknowledgements and quote refusals` | 26 / 26 |
| offline-unregister | `Unregister locks when all desktop reports are stale` | 26 / 26 |

Two built-app mutations rebuild `dist` before testing:
- Remove the registry's kind-5 subscription: `W8a stale bulk Unregister removes only its row and rejects late replay` fails at the row-removal assertion. Selected count stays 1; restoring the subscription/build passes.
- Restore the narrow Settings container: `W8a desktop roster is reachable, filtered, read-only and opens the agent URL` fails because Runtime is unreachable. Selected count stays 1; restoring the container/build passes all 8 workflows.

## Implementation decisions and plan deviations

The plan's `lib/rosterView.ts` lives under `settings/lib/`, alongside W7's settings helpers. The existing author-signed, self-sealed command sender and NIP-29 member-add helper are reused; no wire extension is required. Runtime is read from linked definitions; unavailable account/runtime values show an em dash. Working comes from recent observer evidence; Claimed remains a historical desktop claim, with no invented Running/Stopped/Crashed chips before S1.

The code requires one recent claiming desktop for lifecycle commands, and the existing v2 gate for Restart. Unregister additionally requires the existing authoritative cleanup set, no machine claim, and at least one recent desktop report. Bulk commands deduplicate keys, run three at a time, await application acks for 30 seconds, quote refusals as text, and keep peer successes. Closing the roster settles waits and prevents unsent batch commands from being published.

Tracing the desktop's existing unregister path revealed NIP-09 coordinate tombstones, which the old registry hook never observed. `registryEvents.ts` and `useAgentRegistry.ts` now apply owner-scoped deletion floors, protect newer re-creations, and reject foreign/malformed coordinates. Settings' roster container expands so the >=1100 px Runtime/Acct branch can actually render; agent detail and Library retain their existing width limits. Row Open preserves W9a's URL path.

The approved roster/hex/status-ring treatment uses existing semantic tokens. Selecting rows replaces filters with the bulk toolbar. Read-only fields and missing S1 attention data stay within W8a; inline editing and batch saves are W8b.

## Source commits

- `6b3eb0fe9 fix(web): lock stale unregister commands when desktops are offline`
- `0388e8b4c feat(web): expose wide roster columns and verify all row actions`
- `fd43fb0f3 test(web): verify roster status after leaving bulk mode`
- `123dd3804 fix(web): keep roster filters and status readable on phones`
- `219296150 fix(web): apply roster unregister tombstones and cover user workflows`
- `92e85030b feat(web): finish responsive agent roster and acknowledgement controls`
- `2d1367a75 Merge branch 'main' into codex/buzz-codex-20261002-172232`
- `67889a093 feat(web): add roster row actions and channel picker`
- `6ebf9b3bb feat(web): add roster projections and bulk lifecycle controls`

## Changed web files

- `web/playwright.config.ts`
- `web/src/features/agents/lib/registryEvents.test.mjs`
- `web/src/features/agents/lib/registryEvents.ts`
- `web/src/features/agents/settings/lib/rosterActions.ts`
- `web/src/features/agents/settings/lib/rosterSnapshot.ts`
- `web/src/features/agents/settings/lib/rosterView.test.mjs`
- `web/src/features/agents/settings/lib/rosterView.ts`
- `web/src/features/agents/settings/lib/useRosterActions.test.mjs`
- `web/src/features/agents/settings/lib/useRosterActions.ts`
- `web/src/features/agents/settings/roster/BulkAddChannelDialog.tsx`
- `web/src/features/agents/settings/roster/BulkBar.test.mjs`
- `web/src/features/agents/settings/roster/BulkBar.tsx`
- `web/src/features/agents/settings/roster/RosterFilters.tsx`
- `web/src/features/agents/settings/roster/RosterRow.tsx`
- `web/src/features/agents/settings/roster/RosterRowMenu.tsx`
- `web/src/features/agents/settings/roster/RosterTable.tsx`
- `web/src/features/agents/ui/AgentsAdminPage.tsx`
- `web/src/features/agents/useAgentRegistry.ts`
- `web/src/features/auth/ui/SettingsPage.tsx`
- `web/tests/e2e/helpers/mockRelay.ts`
- `web/tests/e2e/helpers/rosterFixture.ts`
- `web/tests/e2e/settings-w8a.spec.ts`

## Live acceptance handoff

Use the plan's target `https://crichton.tailb3d4b8.ts.net:6351` with an enrolled owner test identity. Create two throwaway agents and a private channel, confirm model/team projections, restart both while observing Working cycles, unregister a throwaway stale key and confirm removal, then check the phone list. Browser evidence here exercises the real compiled client/signing/decryption paths with simulated desktop responses; it does not establish that a physical desktop restarted an agent.

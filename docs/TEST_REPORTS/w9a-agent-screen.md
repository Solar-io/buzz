# W9a agent screen — coder handoff

W9a adds the owner agent screen inside Settings: roster stepping, header actions,
URL tabs, live controls, channel membership, Memory and inline Activity. Logs is
the specified locked surface until S2. Settings-card, voice, protocol and
sealed-state phases are outside this change.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-164224`

Branch: `codex/buzz-codex-20261002-164224`

Source commits:

- `b85ea07ef64c750fa5bab93074f1246d9fd0fb14` — shell and controls.
- `957c03d2cba7722b540042e67def2b81f6f7a44c` — behavioural tests and integration.
- `5079072763ac62cd3b9e9ac0dec4eb19704f1cb0` — phone layout and live model state.
- `d9b52f08f112cc1a4c2b3dfdcb7520d6bad4dfb4` — accessible channel-tab labels and compact layout.
- `416eee9d7319d83c49df722a034eb9443806561a` — shared Agent Brave test fixture.

## Changed files (21)

```text
docs/LAST_CHAT.md
docs/PROJECT_STATUS.md
docs/TASKS.md
docs/TEST_REPORTS/w9a-agent-screen.md
web/playwright.config.ts
web/src/features/agents/settings/agent-screen/AgentChannelsCard.tsx
web/src/features/agents/settings/agent-screen/AgentChannelsTab.tsx
web/src/features/agents/settings/agent-screen/AgentHeader.tsx
web/src/features/agents/settings/agent-screen/AgentScreen.test.mjs
web/src/features/agents/settings/agent-screen/AgentScreen.tsx
web/src/features/agents/settings/agent-screen/AgentTabs.tsx
web/src/features/agents/settings/agent-screen/RightNowCard.tsx
web/src/features/agents/settings/agent-screen/agentChannelActions.ts
web/src/features/agents/settings/agent-screen/agentScreenModel.ts
web/src/features/agents/ui/AgentActivityPanel.tsx
web/src/features/agents/ui/AgentConfigPanel.tsx
web/src/features/agents/ui/AgentsAdminPage.tsx
web/src/features/auth/ui/SettingsPage.tsx
web/tests/e2e/helpers/agentBraveTest.ts
web/tests/e2e/settings-w6.spec.ts
web/tests/e2e/settings-w9a.spec.ts
```

## Behaviour and scope

- Roster/search selection opens `?group=agents&agent=<pk>&tab=<tab>`.
  Previous/next follows `buildRoster` order without wrapping. Foreign or unknown
  keys expose no controls. The screen waits for owner-key restoration before
  mounting its owner-scoped subscriptions.
- Header: hex avatar with working ring, team/definition badges, Message, Stop,
  Restart, and a menu with Start, Export snapshot and confirmed Unregister.
  Existing configuration/deletion controls remain in the Agent settings
  disclosure for W9b to replace; no new settings-card editors were built.
- Right now uses terminal-aware `activeTurns`; silence stays visible and a
  completion ends its own turn. Queue count is hidden without WorkProvider.
  The live model comes from the matching conversation's harness snapshot.
- Switching/cancellation use the existing encrypted owner-to-agent control path.
  Channel add publishes bot membership, waits for relay acceptance, re-queries
  membership, then sends targeted Start. Refused adds never start. Remove sends
  only channel-scoped removal. Desktop acks/refusals/timeouts remain visible;
  relay acceptance is not presented as desktop application success.
- Without a current, single claiming desktop report, lifecycle/configuration
  and membership controls are disabled. Reports are historical evidence, not
  an online claim. Definitive stopped/crashed status awaits S1.
- Desktop has five URL tabs. Below 1280, side cards form a strip. Phone has three
  segments, 44 px targets, a collapsed Right now disclosure and Memory/Activity
  sub-pages. Activity reuses the existing panel with an inline presentation.

## Required checks

All checks used this worktree with Hermit active. Receipts below are in `logs/`.

| Check | Output | Receipt |
|---|---|---|
| `pnpm --dir web test` before | 4,099 tests, all pass | `w9a-unit-before.log` |
| `pnpm --dir web test` after restoration | 4,112 tests, all pass; +13 | `w9a-unit-final.log` |
| `pnpm --dir web typecheck` | exit 0 | `w9a-typecheck-final.log` |
| Biome on all changed web TS/TSX/MJS | 17 files, no errors/fixes, exit 0 | `w9a-biome-final.log` |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | exit 0 | `w9a-size-final.log` |
| `pnpm --dir web build` after restoration | exit 0; existing chunk/import warnings | `w9a-build-final.log` |
| Palette ratchet | no new literals | `w9a-palette-final.log` |
| px-text on 12 changed TS source files | no violations | `w9a-px-scoped.log` |
| W6 + W9a Playwright smoke | 16/16 pass (7 W6 + 9 W9a) | `w9a-e2e-final-candidate.log` |
| Restored W9a Playwright smoke | 9/9 pass | `w9a-e2e-restored.log` |

The full px-text check reports the unchanged parent files
`GeometryDiagnosticOverlay.tsx:34` and `CustomGradientThemeEditor.tsx:136`.
Both literals were confirmed in base `ef7a3ef35`; no baseline was changed.
Desktop TypeScript and Rust were not touched.

```sh
BUZZ_E2E_CDP=http://127.0.0.1:9222 PLAYWRIGHT_PORT=6390 \
  pnpm --dir web exec playwright test tests/e2e/settings-w9a.spec.ts \
  tests/e2e/settings-w6.spec.ts --project=smoke
```

These runs use fresh contexts in shared Agent Brave and real client signing,
encryption and decryption against `mockRelay.ts`. The fixture checks membership
tags, targeting, desktop acks, model snapshots and terminal updates. It does not
execute a real desktop or prove relay authorization. An owned preview server
served the worktree's built bundle and returned HTTP 200.

## Mutation proof

Implementation/tests were committed first. Test code stayed unchanged during
mutations. `git restore` restored committed source; each browser run rebuilt.

Unit mutation disabled roster stepping, skipped Start after membership, and
removed Logs update copy. Total stayed **13**: **9 pass / 4 fail**:

- `‹ › steps through roster order without wrapping at either edge`
- `Channels add publishes 9000 then start, waiting for membership acceptance`
- `an accepted add still refreshes when starting fails, with an honest partial outcome`
- `Logs tab is locked with update copy when read.log cap missing`

Browser mutation disconnected header selection, skipped Start and changed Logs
copy. The mutant compiled. Total stayed **9**: **6 pass / 3 fail**:

- `W9a ‹ › steps through roster order and keeps URL selection on Back`
- `W9a Channels add publishes 9000 then targeted start, and removes with 9001`
- `W9a Logs stays locked, Memory and inline Activity are reachable and reloadable`

Receipts: `w9a-mutation-unit.log`, `w9a-mutation-build.log`,
`w9a-mutation-e2e.log`. After restoration: 4,112 unit and 9 W9a browser tests,
all passing. The broad conflict scan matched only five pre-existing Markdown/TLA
equals delimiters; the exact merge-marker scan and whitespace diff are clean.

## Screenshots and remaining acceptance

Built-app screenshots in the worktree's `.scratch/`:

- `w9a-agent-1440.png` (1440 × 960)
- `w9a-agent-390.png` (390 × 844)
- `w9a-agent-375.png` (375 × 844)
- `w9a-agent-1000.png` (1000 × 960)

Visual inspection and browser assertions found no header/tab overlap or horizontal
overflow. Compact cards align below the header; all four PNG hashes differ.
Phone keeps Right now collapsed to leave the model summary and Channels near
the top. Settings editors belong to W9b and Voice to W10. Logs remains locked
until the S2 reader exists; W9a introduces no new protocol or sealed-state reader.

The plan's real-relay Acid Burn comparison and throwaway-agent add/remove/cancel
acceptance still need an approved owner signing environment. This shell has no
`BUZZ_PRIVATE_KEY`; the focus-status attempt returned that auth error. The coder
requested an approved environment file path/launch method rather than a key
value. No working agent was used as a write target. No acceptance item was waived.

Detailed output is consolidated in the project's `logs/verification.log`.

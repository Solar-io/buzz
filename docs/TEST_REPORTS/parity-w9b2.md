# Parity W9b2 coding receipt

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-093359`
Branch: `codex/buzz-codex-20261003-093359`

Identity & instructions, blind patch-only Environment variables, and Remove are part of the W9b1 screen draft. Phone rows open dedicated sub-pages. Avatar Change uploads through Blossom, validates the server descriptor and stages the URL. Linked instructions open the exact Library definition; standalone instructions and names use the existing update builder. Unregister preserves the local key; Delete confirms the channel count and both actions await desktop apply acknowledgement. Failed writes retain the draft/confirmation. Environment values stay in transient form state, outside W7 drafts/receipts/storage, and clear after successful acknowledgement. No full environment replacement is reachable from these cards.

The four old module paths are gone. Shared admin command/ack logic lives in `ui/useAdminCommands.tsx`; the existing roster list lives in `ui/AgentRosterList.tsx`; `settings/AgentManagementSection.tsx` retains the creation and Library flows and routes every selected agent to the new screen.

## Verification

| Required check | Actual output |
| --- | --- |
| `pnpm --dir web test`, baseline | 4,345 tests, 4,345 pass, 0 fail/skipped |
| `pnpm --dir web test`, final | 4,357 tests, 4,357 pass, 0 fail/skipped (+12) |
| Restored focused suite | 12 tests, all pass |
| `pnpm --dir web typecheck` | exit 0 |
| Touched-file Biome | Checked 37 files, no fixes/errors |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | exit 0 |
| `pnpm --dir web build` | exit 0; existing chunk-size/dynamic-import warnings |
| `pnpm --dir web check:palette-literals` | no new literals; four files below baseline |
| `pnpm --dir web check:px-text` | two existing violations in untouched GeometryDiagnosticOverlay / CustomGradientThemeEditor; no changed file violation |
| Extra repo-wide `pnpm --dir web check` | 28 errors in untouched files; none in this phase's files |
| W9b2 smoke on Agent Brave CDP, rebuilt dist | 5 passed (45.6 seconds) |
| W9b1 regression smoke on Agent Brave CDP | all six passed in the combined run; combined run's W9b2 failures were subsequently fixed/retested |
| Read-only live baseline | HTTP 200 Buzz HTML; Agent Brave rendered the live Buzz shell |

Desktop TS and Rust are untouched. No changes to relay/protocol capabilities. All four marker forms and whitespace were scanned; existing Markdown/TLA separator headings are not merge markers.

### Fail-first evidence

Each source mechanism was committed before mutation. These nine deliberate regressions failed named tests with **12 tests still executed**; restore used `git restore -- <path>` and the restored suite passes. Full output is in `logs/verification.log` and `.scratch/w9b2-mutant-*.log`.

| Reverted/broken mechanism | Named failing tests |
| --- | --- |
| Restore full-replace environment semantics | adding one row sends envVarsPatch; deleting sends K:null; environment and API-key patches combine |
| Replace removal null with empty string | deleting sends K:null without clearing other variables |
| Remove reserved-key validation | reserved, blank, invalid and duplicate keys refuse the environment patch |
| Omit identity edits | identity updates name, prompt and avatar through the existing command builder |
| Remove environment receipt masking | environment receipts never contain variable values |
| Restore a prompt editor for linked agents | linked identity opens the exact Library definition and hides standalone prompt |
| Remove avatar staging | avatar Change uploads and stages the server-validated image URL |
| Skip desktop ack on removal | Delete confirms the channel count and waits for desktop ack; Unregister keeps the key and a refused ack preserves the confirmation |
| Restore the legacy AgentConfigPanel bytes from the parent commit | no source module imports the retired agent pages and all four files are removed |

The first linked-prompt mutant exposed expensive DOM-object assertion formatting; changing the assertion to a boolean made the failure bounded. An incomplete timeout run is not counted as evidence. The browser fixture uses the product's Stay signed in control for its disposable test identity and handles already-dismissed CDP teardown dialogs; assertions remain active.

### Screenshots and geometry

Saved in `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-093359/.scratch/w9b2/`:

- `w9b2-desktop-1440.png`
- `w9b2-identity-390.png`
- `w9b2-environment-390.png`
- `w9b2-remove-confirm-390.png`

All four were visually inspected against the approved mockup: no horizontal overflow or overlapping controls. Browser assertions check non-empty control counts, bounds within the viewport and 44-pixel phone controls. Existing W9b1 screenshots are also preserved there. The identity avatar uses the existing hex treatment.

### Deviations and remaining acceptance

- The plan called all four legacy files dead, but main still used three for shared command hooks, roster creation/cleanup and Library. Their active responsibilities were extracted before deleting those paths; W8a's roster redesign is not added here.
- An additive `definition` Settings search key is needed to open the selected definition directly. Existing route redirects are retained.
- The web's palette token for the approved blue banner is `info`; that existing token is used.
- The coding shell has no `BUZZ_PRIVATE_KEY` (focus-status attempt returned the explicit auth error). Live FOO set/remove and destructive throwaway-agent acceptance therefore remain an operator check with an authorized owner signer and reporting desktop. Mocked-relay tests cover signed owner commands, sealed request/ack traffic and actual built UI reachability. The read-only live baseline is not change acceptance.

## Commits

```text
5a0338443 feat(web): add identity env and removal agent settings cards
89c04aeec test(web): retain disposable identity across agent settings reloads
2c683b9ef test(web): bound failed DOM assertions and stabilize settings fixture
646b1d7ac fix(web): align agent identity and removal with phone design
```

## File inventory

`git diff --name-status 5a0338443^` (subsequent documentation receipt commit adds this report and the append-only handoff/status entries):

```text
M	docs/TASKS.md
M	web/playwright.config.ts
M	web/src/features/agents/lib/adminV4Compatibility.test.mjs
R069	web/src/features/agents/ui/AgentsAdminPage.tsx	web/src/features/agents/settings/AgentManagementSection.tsx
M	web/src/features/agents/settings/CreateAgentScreen.tsx
M	web/src/features/agents/settings/agent-screen/AgentChannelsCard.tsx
M	web/src/features/agents/settings/agent-screen/AgentHeader.tsx
M	web/src/features/agents/settings/agent-screen/AgentScreen.tsx
M	web/src/features/agents/settings/agent-screen/cards/AgentSettingsCards.tsx
A	web/src/features/agents/settings/agent-screen/cards/EnvVarsCard.test.mjs
A	web/src/features/agents/settings/agent-screen/cards/EnvVarsCard.tsx
A	web/src/features/agents/settings/agent-screen/cards/IdentityCard.tsx
A	web/src/features/agents/settings/agent-screen/cards/RemoveCard.tsx
M	web/src/features/agents/settings/agent-screen/cards/agentSettingsFields.ts
M	web/src/features/agents/settings/agent-screen/cards/awaitSettingsAck.ts
M	web/src/features/agents/settings/agent-screen/cards/cardChangeText.ts
A	web/src/features/agents/settings/agent-screen/cards/envPatch.ts
A	web/src/features/agents/settings/agent-screen/cards/retiredPages.test.mjs
M	web/src/features/agents/settings/agent-screen/cards/useAgentCardDraft.ts
M	web/src/features/agents/settings/lib/settingsSave.ts
M	web/src/features/agents/settings/useBlankAgentCreate.ts
D	web/src/features/agents/ui/AgentConfigPanel.tsx
M	web/src/features/agents/ui/AgentCreateForm.tsx
R096	web/src/features/agents/ui/AgentRosterSidebar.tsx	web/src/features/agents/ui/AgentRosterList.tsx
M	web/src/features/agents/ui/DefinitionEditorSection.tsx
M	web/src/features/agents/ui/DefinitionsPanel.tsx
M	web/src/features/agents/ui/HarnessSelect.tsx
M	web/src/features/agents/ui/SnapshotPreviewProvider.tsx
R093	web/src/features/agents/ui/AgentAdminPanel.tsx	web/src/features/agents/ui/useAdminCommands.tsx
M	web/src/features/auth/ui/SettingsPage.tsx
M	web/src/features/auth/ui/settings/ClaudePoolsSection.test.mjs
M	web/src/features/auth/ui/settings/ClaudePoolsSection.tsx
M	web/src/features/auth/ui/settings/settingsGroups.ts
M	web/src/features/channels/ui/AddChannelMembersDialog.tsx
M	web/src/features/dms/ui/NewDmDialog.tsx
M	web/src/features/sidebar/ui/ChannelSidebar.tsx
A	web/tests/e2e/helpers/agentSettingsFixture.ts
M	web/tests/e2e/settings-w9b1.spec.ts
A	web/tests/e2e/settings-w9b2.spec.ts
```

## W9b2 composition with current main — 2026-10-03

Source: `5e66e7718be7b5ef56b3a8f5cd02a9944a8027c6`, composed from W9b2 parent `14a53f7b1` and main parent `775f6db5f`. The renamed `settings/AgentManagementSection.tsx` uses W8a's `RosterTable` with profiles, team filters, observer/claim/stale status, row menus, bulk lifecycle and P0 `controlLock`. Its create flow retains `DesktopControlBoundary`; the standalone footer and embedded Settings navigation remain. Identity/Environment/Remove and W9b1 cards stay intact, as do W11a/W11b Library flows and main's other additions.

`AgentRosterList.tsx` is removed. Its shared working indicator is retained in `ui/AgentWorkingDot.tsx` for member and DM pickers. Stale cleanup is covered by W8a's filter/actions, and the old owner profile form duplicated Account. The four retired legacy paths remain absent; roster action imports now use the extracted `ui/useAdminCommands.tsx` hook.

The documentation conflicts were reconstructed from main plus W9b2's proven append-only changes, preserving every entry. The Playwright configuration keeps all 33 W9b2-parent and 35 main-parent registered specs (36 in the union).

| Check | Result |
| --- | --- |
| `pnpm --dir web test` | 4,421 tests; 4,421 pass, zero failures/skips; +12 over main's 4,409 |
| `pnpm --dir web typecheck` | exit 0 |
| Changed-file Biome | 39 files, no errors/fixes in the final check |
| `pnpm --dir web build` | exit 0; existing bundle-size and dynamic-import warnings |
| All eight requested E2E groups, served rebuilt dist via Agent Brave CDP | 50 passed, zero failures/skips (3.8 minutes) |
| Named composition-lock mutation | 1 failed with lock removed; same 1 passed after restore/rebuild |
| All four conflict-marker forms | none; five existing Markdown/TLA separators are unchanged |

The initial full E2E run passed 49 cases and timed out on W9b1's API-key fixture `page.goto` before assertions. That unchanged case passed alone, then all 50 passed together without runner or assertion changes. Both full-run logs are retained.

Mutation proof removes only the composed `RosterTable`'s `controlLock` prop, after committing the composition. The compiling/rebuilt mutant fails **W8a desktop presence lock disables roster row actions and bulk lifecycle until recovery**, at `settings-w8a.spec.ts:291`: expected disabled, received enabled for Start. Restored source matches the committed bytes, and the rebuilt named case and complete final suite pass.

Raw output: `logs/w9b2-integration-{unit,typecheck,biome,build,e2e,e2e-final,api-key-repeat,lock-mutant,lock-restored,mutant-build,restored-build}.log`; output excerpts appended to `logs/verification.log`. Fresh 1440/390 roster screenshots in `.scratch/w8a/screenshots/` were inspected, along with the W9b2 phone Environment screenshot. Browser suites use their own contexts and an unused loopback preview port; the additional MCP inspection tab was closed.

The earlier live owner/desktop acceptance item remains separate from this requested source-integration gate.

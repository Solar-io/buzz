# W9b1 agent settings cards

Built Model & thinking, Runtime and Who can instruct on W9a's agent screen, using W7 drafts, guarded navigation and desktop acknowledgement receipts. Unreadable settings stay in the blind disclosure. Known timeout edits move into the card and survive reload through a browser-authored, scoped session echo. API keys stay in transient form state and sealed patch commands; receipts show names and readable values.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-172750`
Branch: `codex/buzz-codex-20261002-172750`
Validated source commit: `b5682a27cff93464df499e8a3c1943d7efac8497`
Resumed adapter commit: `f064afdbe`; integration base: `66bc5b0c8`.

## Validation

| Check | Result |
|---|---|
| `pnpm --dir web test` before / after | 4,252 / 4,265, all passing; 13 new tests |
| `pnpm --dir web typecheck` | exit 0 |
| Changed-file Biome | 22 files, no fixes or errors |
| `pnpm --dir web build` | exit 0; existing large-chunk warning |
| `node web/scripts/check-file-sizes.mjs` | raw default fails on two unchanged baseline files |
| Same size command with `CHECK_FILE_SIZES_BASE=main` | exit 0 |
| Palette | exit 0; touched legacy removal color uses coral |
| Global px-text | two unchanged baseline findings |
| W9a + W9b1 smoke, shared Agent Brave | 15 passing: nine W9a, six W9b1 |
| Desktop / Rust | not touched |

Raw size resolves upstream base `ef0d2025683869418e8eee22ac5b5ac16c5198b7`, where ChannelTimeline (1,010 lines) and relay-session (1,325 lines) look new. Local-main pinning gives the correct ratchet. The global px-text findings are `GeometryDiagnosticOverlay.tsx:34` and `CustomGradientThemeEditor.tsx:136`; all four files are byte-identical to local main.

One final combined browser run had a fixture-load timeout before the API-key interaction: the error snapshot had neither the registry agent nor the catalog. The unchanged repeat passed all 15 tests. Both outputs are retained; no claim is made that the intermittent cause is resolved.

## Fail-first proof

Every mutation started from committed source, rebuilt the bundle, and restored source with `git restore`. Each of these ran the same 13 component tests and failed the named test:

- `idle-builtin`: idle built-in renders 15 min — built in (exit 1).
- `longest-builtin`: idle built-in renders 15 min — built in (exit 1).
- `custom-seconds`: Custom… 7 min sends idleTimeoutSeconds 420 (exit 1).
- `clear-sentinel`: reset sends 0 (clear sentinel) (exit 1).
- `access-warning`: warning renders after the people picker for allowlist and directly under the selector for anyone (exit 1).
- `provider-scope`: provider/key controls only appear for Buzz Agent and Goose; Effort stays locked (exit 1).
- `effort-lock`: provider/key controls only appear for Buzz Agent and Goose; Effort stays locked (exit 1).
- `unreported`: unreported durations stay collapsed and never masquerade as current built-ins (exit 1).
- `named-receipts`: runtime inheritance is locked and Turns at once forwards a number (exit 1).

Restoring the integration screen from base `66bc5b0c8` removed W9b1 reachability while leaving its component modules intact. The single selected browser test, `W9b1 idle 30 min and Anyone survive acknowledged save and reload`, ran and failed on the missing `model-thinking-card`. The restored suite passes. Mutation stdout and build logs are in `.scratch/w9b1/mutant-*`; receipts are appended to `logs/verification.log`.

## Built workflows and screenshots

The mock relay checks the client's actual self-sealed commands and supplies desktop acknowledgements. Journeys cover idle 30 minutes plus Anyone after save/reload; custom 7-minute input and named allowlist selection; relay acceptance before desktop apply; refusal without an echo; API-key patch-only privacy; navigation guard; stale-desktop locks. The phone checks horizontal bounds, 44 px text-input/select targets and save-bar geometry.

- `.scratch/w9b1/desktop-1440.png`
- `.scratch/w9b1/phone-390.png`
- `.scratch/w9b1/phone-runtime-390.png`
- `.scratch/w9b1/phone-access-375.png`

Inspected the images: no horizontal overflow or header/card overlap. The sticky save bar occupies the bottom dock; underlying content remains scrollable.

## Scope decisions and remaining acceptance

- Standalone runtime, startup and timeouts are absent from today's public projection. They remain blind until edited; only timeout echoes persist. These echoes are not decrypted desktop state.
- Preset choices come from the claiming desktop's catalog, with the existing preset mirror as fallback. Custom arguments retain the existing whitespace-separated builder contract; P1b owns richer runtime settings.
- The existing W6 Settings page hides the phone tab bar. W9b1 docks its save bar at the viewport edge there and checks against the tab bar when one exists.
- W9b2's Identity/Environment/Remove controls remain in the legacy disclosure. Its overlapping model/runtime/access/effort controls are hidden on this screen; their other legacy consumers remain intact.
- Effort, Nobody, clears for model/provider, and runtime inheritance remain locked for their named later phases. No relay, desktop or ACP source is changed.

One acceptance task remains: apply Idle 30 minutes and Anyone on a throwaway agent through an actual Buzz Desktop, then reload and verify the public access projection plus timeout echo. The coder shell lacks an owner signing key. Agent Brave could render the served live baseline, but that is a different bundle from this local worktree. The completed browser evidence uses a mock relay/desktop and does not prove real desktop application.

## File inventory

- `docs/TASKS.md`
- `web/playwright.config.ts`
- `web/src/features/agents/AGENTS.md`
- `web/src/features/agents/settings/agent-screen/AgentScreen.tsx`
- `web/src/features/agents/settings/agent-screen/cards/AgentSettingsCards.tsx`
- `web/src/features/agents/settings/agent-screen/cards/ModelThinkingCard.test.mjs`
- `web/src/features/agents/settings/agent-screen/cards/ModelThinkingCard.tsx`
- `web/src/features/agents/settings/agent-screen/cards/RuntimeCard.test.mjs`
- `web/src/features/agents/settings/agent-screen/cards/RuntimeCard.tsx`
- `web/src/features/agents/settings/agent-screen/cards/WhoCanInstructCard.test.mjs`
- `web/src/features/agents/settings/agent-screen/cards/WhoCanInstructCard.tsx`
- `web/src/features/agents/settings/agent-screen/cards/agentSettingsFields.ts`
- `web/src/features/agents/settings/agent-screen/cards/awaitSettingsAck.ts`
- `web/src/features/agents/settings/agent-screen/cards/cardChangeText.ts`
- `web/src/features/agents/settings/agent-screen/cards/cardTestHelpers.mjs`
- `web/src/features/agents/settings/agent-screen/cards/cardTypes.ts`
- `web/src/features/agents/settings/agent-screen/cards/useAgentCardDraft.ts`
- `web/src/features/agents/settings/agent-screen/cards/useInstructionPeople.ts`
- `web/src/features/agents/ui/AgentConfigPanel.tsx`
- `web/src/features/agents/ui/ProviderApiKeyField.tsx`
- `web/src/shared/ui/settings/DurationSelect.tsx`
- `web/src/shared/ui/settings/ModelSelect.tsx`
- `web/src/shared/ui/settings/SettingSelect.tsx`
- `web/tests/e2e/settings-w9b1.spec.ts`
- `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`, and this report contain the handoff.

## Source commits

```
b5682a27c test(web): assert named receipts and phone touch targets
131f1c1c1 fix(web): render named receipts and phone-sized inputs
6f1dac4eb fix(web): label custom runtimes and mirror provider choices
a7de34411 style(web): use semantic removal color in legacy settings
a7a9a8890 fix(web): gate extended writes and size startup switch
7ca71150d test(web): exercise duration clear planning and channel people
72122f227 test(web): pin hidden unreported effort
599699d46 fix(web): refine settings provenance and phone fixtures
bdeecc3bb test(web): cover W9b1 cards and owner settings journeys
fbaf8de60 feat(web): wire agent cards to shared settings drafts
073540c43 feat(web): implement W9b1 agent settings cards
4cbed96b0 chore: incorporate main before W9b1 settings cards
f064afdbe feat(web): add agent card draft and acknowledgement adapters
```

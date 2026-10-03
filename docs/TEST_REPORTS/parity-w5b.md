# W5b: channel workflows

Built the channel settings Workflows tab, scoped definition rows with latest run status, and YAML create/owner-edit flows. The existing signed event path carries raw YAML; edits retain the workflow UUID, channel and `expected-revision`. New draft retries retain their UUID. Relay refusal text remains visible verbatim without closing the editor.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-082219`  
Branch: `codex/buzz-codex-20261003-082219`  
Starting main: `8b73b15b526cafc88dcb34ba279b26348ef6ed83`

Implementation/test commits: `f0b6eaf3c`, `cd2707493`, `79a12bbc8`, `321894f28`.

## Files

- `web/src/features/channels/ui/channel-sheet/{ChannelSettingsSheet.tsx,ChannelSettingsSheet.test.mjs,WorkflowsTab.tsx,WorkflowsTab.test.mjs}`
- `web/src/features/workflows/lib/{workflowPublish.ts,workflowPublish.test.mjs,yaml.ts}`
- `web/src/features/workflows/ui/WorkflowEditor.tsx`
- `web/src/features/workflows/useWorkflowRuns.ts`
- `web/tests/e2e/channel-workflows.spec.ts`, `web/playwright.config.ts`
- `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`, this report

## Checks

| Check | Evidence |
|---|---|
| `pnpm --dir web test` | Starting main 4,225/4,225; implementation 4,243/4,243; 18 added tests, no skips |
| `pnpm --dir web typecheck` | Exit 0 |
| Biome on changed web files | Clean |
| `node web/scripts/check-file-sizes.mjs` | Default upstream base flags unchanged ChannelTimeline (1,010) and relay-session (1,325); ratchet against starting main and `CHECK_FILE_SIZES_BASE=main` exits 0 |
| `pnpm --dir web check:palette-literals` | No new literals |
| `pnpm --dir web check:px-text` | Two unchanged baseline violations in GeometryDiagnosticOverlay and CustomGradientThemeEditor; changed UI uses named rem tokens |
| `pnpm --dir web build` | Exit 0; restored builds also compile; existing chunk-size/dynamic-import warnings |
| Built-app smoke | Four Agent Brave/CDP create/edit/validation/refusal journeys in dark/light at 1440/390; additional 375 geometry checks |

Desktop and Rust files were not touched, so their suites do not apply. No PR was created, so the repository-wide `just ci` PR gate does not apply to this scoped coding handoff.

## Mechanism proof

Fifteen compiling unit mutations preserve all 45 tests in the focused selection (18 new tests, existing YAML and About tests). Every added test was observed failing by name with its mechanism broken. Sources were restored through `git checkout --`, byte equality was checked, and the restored 45 tests and build pass. Details: `logs/verification.log`, `logs/w5b-mutation-summary.json`, `logs/w5b-mutant-*.log`.

| Mutation | Named failures (abbreviated) |
|---|---|
| wrong event kind | create uses a fresh UUID; Save signs and publishes |
| replace edit/draft UUID | edit keeps the same d tag; editing preserves id/revision; both retry identity tests |
| blank expected revision | edit keeps the same d tag; editing preserves id/revision |
| remove channel guard | edit refuses moving into another channel |
| remove invalid-template guard | invalid YAML cannot produce a publish template |
| remove name validation | local shape validation; prototype key stays plain data |
| remove byte cap | size bounded by UTF-8 bytes |
| remove source line context | syntax errors include the offending line |
| assign prototype key as an inherited value | authored prototype key is plain data |
| remove channel row filter | rows exclude other channels |
| remove owner edit gate | rows restrict editing to author |
| remove editor validation | invalid YAML disables Save and shows the line |
| ignore relay refusal | refusal text/draft retention; retry identity |
| remove write/connect gates | read-only/offline states; loss of connection locks editor |
| disable Cancel callback | Cancel returns to list without publishing |

An initial line-diagnostic mutant failed compilation and was replaced with a compiling mutation; it is not counted. Cancel's initial assertion attempted to diff a React DOM object and timed out. The equivalent boolean assertion bounds diagnostics; its final mutation fails by name at the same 45-test count. The timed-out child process was identified by this worktree's cwd and stopped.

A sixteenth compiling mutation disables the sheet's Workflows branch. All four named browser journeys fail at the missing workflow heading, with four tests still selected. The source bytes are restored and the app rebuilt; the restored four browser journeys pass again. Evidence: `logs/w5b-e2e-mutant.log`, `logs/w5b-e2e-mutation-run.log`, `logs/w5b-build-restored.log`, `logs/w5b-e2e-restored.log`.

## Browser and screenshots

The smoke spec uses the existing `mockRelay.ts`, real browser key signing and signed-event verification. It echoes accepted definitions to live subscriptions, supplies run rows, refuses a schema-invalid action and checks the exact displayed verdict. Channel membership is seeded explicitly: the first fixture omitted it and correctly left writes disabled; fixing the fixture makes all four journeys pass. An unnecessary headed retry was stopped; the successful acceptance run uses Agent Brave.

The twelve distinct screenshots are `.scratch/w5b/w5b-{list,invalid,refusal}-{1440,390}-{dark,light}.png`. All twelve were visually inspected for overlap/clipping against the approved channel-sheet design. Controls remain inside the viewport, textarea/Save/Cancel targets are at least 44 high, and both sheet and document have no horizontal overflow at 1440, 390 and 375 widths. The existing W1 sheet geometry and tabs remain the host for W5b.

## Live acceptance and integration notes

The live target `/repos/` returned HTTP/2 200 (`logs/w5b-live-http.log`). This coder shell has no `BUZZ_PRIVATE_KEY`; `buzz users set-status --text W5b` returns the explicit auth error. Real private-channel create/edit acceptance remains open for an enrolled signing seat. Mocked browser acceptance proves client wiring and signatures, not relay validation or workflow execution. No user approved deferring this gate; it remains listed in TASKS.

The plan's writer paths exist. The canonical SDK update additionally requires `expected-revision`, which this implementation mirrors. The existing YAML subset parser is retained and now adds source-line errors, duplicate-key/document checks and safe prototype-key handling; full schema validation stays on the relay. No new dependency or HTTP endpoint was introduced. Latest runs poll every 15 seconds only while the channel tab is mounted. The web-as-admin direction is the fork divergence already approved in PLAN §9.

Local main advanced with W2/W5a during this run. Review this phase against its starting SHA above. Its sheet Workflows branch must be composed with W2's Members branch when integrated; preserve both from the parents. This coding seat does not perform that integration.

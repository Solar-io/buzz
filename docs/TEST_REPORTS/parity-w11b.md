# W11b definition extras

Built name-pool editing/clearing and private duplication in Library. Specific-people sharing moves to L3 under the plan's explicit Q5 contingency. One live desktop reconciliation item remains.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-093404`. Branch: `codex/buzz-codex-20261003-093404`. Starting SHA: `ba0d962003910f73b3000d1c9ccd71bec66dc9f7`.

## Implementation and scope

Name pools preserve order and repeated names; Clear removes the optional `name_pool` field. Duplicate signs a new 30175 with a fresh UUID `d`, a `(copy)` name, identical prompt bytes and preserved configuration/unknown keys. It removes catalog-sharing tags. Relay refusals retain drafts and never open a nonexistent copy. Raw text validation precedes name normalization; prompts retain layout whitespace. This closes the old leading-U+FEFF stripping bypass. Malformed duplicate prompt/pool wire types are rejected.

Q5 evidence: `desktop/src/features/agents/ui/PersonaShareDialog.tsx` calls `useEncodeAgentSnapshotForSendMutation` with `format: "png"`, then snapshot send/DM creation. `desktop/src/shared/api/tauriPersonas.ts` invokes `encode_agent_snapshot_for_send`; `desktop/src-tauri/src/commands/personas/snapshot.rs:232` loads local definitions, instances and global defaults. This needs desktop-local state. PLAN.md's phase list, W11b/L3 sections, Q5 and coverage row 33 were amended; [receipt](parity-w11b-plan.patch). No new sharing wire format was invented.

Interior bidi validation already existed; W11b reuses the Rust-mirrored validator and guards raw-before-trim behavior. Disabling validation kills the new bidi regression. Root and agent-local rules govern this checkout; CLAUDE.md and additional package-root guides are absent. The approved mockups specify the existing Settings shell/palettes/phone Library destination, without a separate name-pool design. Existing components, semantic colors and rem text are reused. No desktop/Rust source changed.

## Verification

| Check | Result | Scratch receipt |
|---|---|---|
| Web baseline | 4,345 pass, 0 fail | `w11b-baseline-valid.log` |
| Restored web suite | 4,355 pass, 0 fail (+10) | `w11b-restored-suite.log` |
| Definition tests | 21 pass | `w11b-focused-final.log` |
| Typecheck / eight-file Biome | exit 0 | `w11b-typecheck-receipt.log`, `w11b-biome-receipt.log` |
| Default file-size command | exit 1: unchanged ChannelTimeline 1010 / relay-session 1325 versus divergent origin/main | `w11b-size-default-receipt.log` |
| Size ratchet against main / starting SHA | exit 0, both | `w11b-size-main-receipt.log`, `w11b-size-original-receipt.log` |
| Palette / scoped px-text | exit 0, both | `w11b-palette-receipt.log`, `w11b-px-scoped.log` |
| Global px-text | exit 1: unchanged GeometryDiagnosticOverlay / CustomGradientThemeEditor | `w11b-px-receipt.log` |
| Broad web check | 28 errors before and after; changed files clean | `w11b-baseline-broad-valid.log`, `w11b-broad-check-receipt.log` |
| Build | exit 0; existing chunk/import warnings | `w11b-restored-build.log` |
| Built-app journeys | 8 pass | `w11b-final-e2e.log` |

Receipts live in `.scratch/` and `logs/verification.log`. The initial exact `pnpm --dir web test` stalled in an unchanged relay-session child. Controlled baseline/final runs use the same supported runner with `--test-concurrency=2 --test-timeout=45000 --test-force-exit`; all tests execute with zero skips/cancellations. Baseline uses the starting commit archived with docs/fixtures and dependencies. Incomplete archive attempts that failed module loading are excluded from proof.

Smoke browser tests use rebuilt dist, an unused OS-selected preview port, signed publications and mock-relay echoes. Agent Brave's isolated WebSocket canary returned `passed:false,error:true`; the supported headed Playwright fallback passed. Mock traffic proves client behavior, not real relay/native reconciliation. Claimed tool tab and test contexts were closed.

All source was committed before mutation and restored with git checkout. Six withdrawals fail named tests at unchanged selected counts:

| Mechanism withdrawn | Named failure | Count |
|---|---|---|
| Fresh coordinate | duplicate gets a new d and identical prompt bytes | 20 |
| Pool writes | name pool round-trips; clear; order/invisible rejection | 20 |
| Raw validation | prompt bytes survive edits and leading invisible formatting is never stripped | 20 |
| Verbatim prompt | prompt bytes survive edits and leading invisible formatting is never stripped | 20 |
| Definition validation | bidi character in prompt is rejected with a message | 21 |
| Wire-type validation | duplicate rejects malformed prompt and name pool wire types | 21 |

The first four ran before the final malformed-wire regression was added. The original editor was also restored and rebuilt: `W11b saved name pool and private duplicate survive reload at 1440 dark` fails on the missing Name pool control (one selected test); the restored selection passes (one). No module-load error counts as a mutation kill. Detailed output: `.scratch/w11b-mutation-*.log`, `w11b-ui-withdrawn-e2e.log`, `w11b-ui-restored-selected.log`.

Four distinct, inspected screenshots under `.scratch/w11b/screenshots/`: `definition-1440-dark.png`, `definition-1440-light.png`, `definition-390-dark.png`, `definition-390-light.png`. Actual palette and no horizontal overflow are asserted; settled controls show no overlap/clipping. `hashes.json` records distinct hashes.

## Handoff

One item remains: with an authorized owner signer/reporting desktop, create a throwaway definition on the live target, duplicate it, edit/clear its pool and confirm both definition and ordered names in desktop after reconcile. This shell has no Buzz signing credentials; focus-status publication returned auth_error. A read-only Agent Brave check rendered the live Buzz app.

Changed files, plus this report:

```text
docs/LAST_CHAT.md
docs/PROJECT_STATUS.md
docs/TASKS.md
docs/TEST_REPORTS/parity-w11b-plan.patch
web/playwright.config.ts
web/src/features/agents/AGENTS.md
web/src/features/agents/lib/personaEdit.test.mjs
web/src/features/agents/lib/personaEdit.ts
web/src/features/agents/ui/DefinitionDuplicate.tsx
web/src/features/agents/ui/DefinitionEditorSection.tsx
web/src/features/agents/ui/DefinitionNamePool.tsx
web/src/features/agents/ui/DefinitionsPanel.tsx
web/tests/e2e/settings-w11b.spec.ts
```

Implementation commits:

```text
b59f7aaed docs(web): record native sharing dependency for L3
fecba200f fix(web): preserve definition review validation before normalization
13b723f80 test(web): format definition parity browser coverage
c038accac feat(web): add definition name pools and duplication
```

The final receipt commit contains the settled screenshot harness and handoff docs.

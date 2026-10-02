# Parity W7: shared controls and settings drafts

W7 builds the reusable setting controls, screen draft, acknowledgement save flow and navigation guard from PLAN.md §6. Product screens consume these in W8b/W9b, where the plan assigns release acceptance.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-163309`

Branch: `codex/buzz-codex-20261002-163309`

Baseline: `d956cee5f`

## Implementation

- `SettingSelect`: resolved default in the closed picker; default-first options; inherited/set/dirty indicators, reset, prior value, timing, offline and update-needed states. Native controls preserve phone pickers; reset targets are 44 × 44 at phone widths.
- `ModelSelect`: supplied In use / Runtime-discovered / Mesh groups, usage counts, search and Other model id entry. No static model catalog.
- `DurationSelect`: minute/hour presets and validated custom input, emitting whole seconds.
- `SaveBar`: every change and timing group, Sending, desktop refusal text, acknowledged Saved and Undo. Receipts use pubkey/field identities, including duplicate display names.
- Draft library: immutable per-agent/field map, original-value comparison, explicit clears, per-agent atomic plans and inverse plans.
- Save hook: three concurrent commands, 30-second acknowledgement timeout, partial successes preserved and failed edits retained. Uncertain timeouts require checking status before retry. The supplied sender must resolve a desktop acknowledgement; relay acceptance is insufficient.
- TanStack `useBlocker` guard: agent/search/route changes and native unloads; Keep editing / Discard; a save in flight cannot be discarded.

The consuming command builder supplies each field's clear sentinel and validates/cap-gates the plan. Model clears are tested as `null` per §5.4; timeout resets are tested as `0`. No protocol surface is extended by W7.

## Files

Implementation:

```
web/src/shared/ui/settings/SettingSelect.tsx
web/src/shared/ui/settings/ModelSelect.tsx
web/src/shared/ui/settings/DurationSelect.tsx
web/src/shared/ui/settings/SaveBar.tsx
web/src/features/agents/settings/lib/settingsDraft.ts
web/src/features/agents/settings/lib/settingsSave.ts
web/src/features/agents/settings/lib/useSettingsDraft.ts
web/src/features/agents/settings/lib/useSettingsNavGuard.ts
web/src/features/agents/settings/ui/SettingsNavGuard.tsx
```

Behavioral tests:

```
web/src/features/agents/settings/lib/settingsDraft.test.mjs
web/src/features/agents/settings/lib/useSettingsDraft.test.mjs
web/src/features/agents/settings/lib/navGuard.test.mjs
web/src/shared/ui/settings/SettingSelect.test.mjs
```

Handoff documents: this report, `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, and appended `docs/LAST_CHAT.md`.

## Required checks

| Check | Actual result |
|---|---|
| `pnpm --dir web test`, before | 4,092 tests; 4,092 pass; 0 fail |
| `pnpm --dir web test`, after | 4,116 tests; 4,116 pass; 0 fail; 24 added |
| `pnpm --dir web typecheck` | Exit 0 |
| Biome on all changed source/test files | 13 files; no fixes/errors |
| `pnpm --dir web build` | Exit 0; restored build also succeeds after mutations |
| File-size check against `main` | Inherited failure: `src/app/routes/repos.tsx` has 1,001 lines by the checker |
| Raw `node web/scripts/check-file-sizes.mjs` | Origin merge-base comparison also flags unchanged ChannelTimeline (1,010) and relay-session (1,325) |
| File-size check against W7 base `d956cee5f` | Exit 0 |
| Global px-text | Two inherited failures: GeometryDiagnosticOverlay and CustomGradientThemeEditor |
| Px-text on both W7 directories | Exit 0 |
| Palette literals | No new literals |
| Conflict markers / whitespace | No four-flavour conflict markers; diff check clean |
| Desktop / Rust | Untouched; checks not applicable |

All five files implicated by the inherited gates are byte-identical to the W7 baseline. The `main` comparison moves as concurrent phases land; W7 adds no growth to the offending files. Logs: `logs/w7-inherited-gates.log`, `logs/w7-file-sizes.log`, `logs/w7-raw-sizes.log`, `logs/w7-scoped-sizes.log`, `logs/w7-px-text.log`, `logs/w7-scoped-px.log`, `logs/w7-palette.log`, `logs/w7-biome.log`, `logs/w7-typecheck.log`, `logs/w7-build.log`, and the complete before/after unit logs.

## Mutation proof

Implementation was committed before mutation. Nine mechanism mutations were built and tested with the same 24-test W7 runner. Every mutant exited nonzero with named failures; every restore used `git checkout --` and byte equality checks. The final restored run passed 24/24; its build succeeded.

| Disabled mechanism | Named failure evidence |
|---|---|
| State classification | `SettingSelect renders inherited, set and dirty states with default-first and reset` |
| Model groups | `model picker groups supplied models and counts; Other submits a trimmed id` |
| Concurrency limit | `batch sends at concurrency three and preserves partial success receipts` |
| Stable receipt keys | `duplicate display names keep both change receipts without duplicate React keys` |
| Draft count, clear and original comparison | `3 edits on 3 agents summarises "3 changes on 3 agents"`; `reset of a set value produces a clear, not an omission`; `editing back to the original value is not dirty` |
| Locked callback guard | `locked never fires onChange` |
| Navigation blocking | `switching agent with a dirty draft prompts` |
| Desktop verdict handling | `refused ack retains only failed agent edits and retry does not resend successes`; `silent desktop times out honestly and a late ack cannot turn it into Saved` |
| Duration conversion | `duration presets show minutes/hours and custom hours send seconds` |

Actual output is appended to `logs/verification.log`. Individual test/build logs are `logs/w7-mutation-*.log`; the reproducible local driver is `.scratch/w7-mutate.py`. Node uses the repository loader for the focused runs, matching the supported full runner.

## Browser evidence and scope

Agent Brave exercised a separately built Vite fixture importing the actual W7 components and hooks, with simulated desktop acknowledgements. Checks covered search, custom hours, draft summaries, Sending → Saved, refusal/retry, model reset and acknowledged Undo, and both navigation choices. The final fixture reported no page errors. Tabs were closed and the temporary loopback preview stopped.

Screenshots, inspected for layout and horizontal overflow:

- `.scratch/w7-1440.png`: 1440 viewport / 1440 scroll width; zero controls outside the viewport.
- `.scratch/w7-390.png`: 390 viewport / 375 content width (scrollbar); zero controls outside the viewport.
- `.scratch/w7-390-lower.png`: lower controls remain reachable beneath the sticky save bar.

Browser receipts: `logs/w7-browser.log`. Fixture sources: `web/.scratch/w7.{html,tsx,css,config.mjs}`; built output: `.scratch/w7-dist/`. These are local evidence artifacts. W8b/W9b own mounting the controls in the product screens and relay-backed acceptance against throwaway agents.

## Plan adaptations

- Existing shared Button/Input/Dialog controls and the installed TanStack router source were used; Node's router server export is accommodated by testing the real blocker with `RouterContextProvider` and memory history. The built browser fixture separately exercises the real router/dialog.
- The web token for design blue is `info-ink`; W7 uses that existing token. No palette or px exceptions were added.
- `settingsSave.ts`, `useSettingsNavGuard.ts` and `SettingsNavGuard.tsx` split acknowledgement processing and the guard out of the draft hook. No other phase's UI or protocol was implemented.
- `CLAUDE.md` is a symlink to root `AGENTS.md`. There are no path-local guides for web, desktop root or buzz-acp; root guidance governs these files.

## Source commits

`c0e320532`, `8ed05dbea`, `62a62615f`, `8780f822f`, `e18b3ab73`, `7f86a20fd`, `5c0ec385a`.

## Task Completion Summary

| Field | Value |
|---|---|
| Changes | W7 selectors, drafts, save receipts/Undo and navigation protection |
| Artifacts | 13 source/test files, four handoff documents; local logs/screenshots above |
| Bugs | Prevents dropped clears, silent draft loss, false Saved feedback and duplicate-name receipt keys |
| Unit Tests | pass — 4,116 total; 24 new; nine mutation checks |
| E2E Tests | pass — built component fixture in Agent Brave; product acceptance belongs to W8b/W9b |
| Next Action | stop |
| Next Reason | W7 complete; consumer integration and acceptance belong to later phases |
| Blockers | None for W7; inherited global gate failures documented |
| Remaining Tasks | 0 in W7 |
| % Complete | 100% of W7 scope |
| GitHub Updated | not needed for this coding handoff |
| Snapshot Taken | not needed |
| TASKS.md Updated | complete |

# W5a — channel Canvas editing

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-171014`  
Branch: `codex/buzz-codex-20261002-171014`  
Starting commit: `c7640c6f7a7643746c80cdb2ffb6dda36e69c60e`  
Implementation: `8cad63ef7`; initial regression coverage: `af0a417ee`.

The existing document view offers a markdown textarea, Save, Cancel and confirmed Clear. `buildCanvasEvent(channelId, markdown)` mirrors `buzz-sdk::build_set_canvas`: regular kind 40100, exactly one `h` tag, and unchanged markdown content. Empty content clears. Signing uses the existing web identity path. Relay refusals retain the draft and quote the error; rendered changes arrive through the live subscription. Member/connection/archive guards lock writes. Rapid writes advance beyond the current document timestamp, and external updates warn without replacing an open draft.

About > Canvas keeps empty documents selectable; below the dock breakpoint the same view opens in a full-screen sheet. The approved mockups specify this entry rather than a separate editor design; the editor uses existing components, tokens and text sizes.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --dir web test` before | 4,123 tests; all pass, zero fail/skip |
| `pnpm --dir web test` after restoration | 4,132 tests; all pass, zero fail/skip |
| `pnpm --dir web typecheck` | Exit 0 |
| Biome check, all 11 touched web files | Exit 0, no fixes |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | Exit 0 |
| `pnpm --dir web build` | Exit 0; existing chunk-size/dynamic-import warnings |
| Palette / scoped px-text | No new literals; six changed source files have no text violations |
| Built-app smoke on Agent Brave | Four pass: 1440/390 × dark/light |
| Desktop / Rust | Not applicable |

Each browser case creates a canvas through About, verifies the real event signature and channel scope, holds the echo to prove an OK alone does not replace content, delivers it to two independently signed-in browser contexts, exercises a refusal retaining the draft, and clears both views. Phone cases reopen the empty document. Page/document width assertions find no horizontal overflow.

Full Biome reports 28 existing errors, 10 warnings and 9 infos; all four diagnosed source files are byte-identical to the starting commit. Global px-text flags two unchanged files: `GeometryDiagnosticOverlay.tsx` and `CustomGradientThemeEditor.tsx`. Detailed output and byte comparisons are in `logs/w5a-biome-existing-errors.log`, `logs/w5a-existing-errors-proof.log` and `logs/w5a-px-text-scoped.log`.

One restored browser run hit a native-confirmation CDP error (`No dialog is showing`). The test driver now accepts `window.confirm` within its own page and asserts the exact prompt. Unit tests exercise cancellation and acceptance; the corrected four-case browser run passes.

## Fail-first proof

Changes were committed before mutation. Tests were unchanged during each mutation; implementation files were restored with Git. The browser bundle was rebuilt before mutant and restored runs.

1. Change the builder to a `d` tag with blank content. All 4,132 unit tests execute; four fail:
   - `clear emits empty content with h tag`
   - `canvas set preserves raw markdown and appends a regular scoped event`
   - `a save shows the new canvas content after the echo, not the publish OK`
   - `Clear confirms and appends empty content; the empty canvas stays editable after echo`
2. Restore the prior empty-canvas listing rule and prevent the phone sheet from opening when ready. The mutant builds successfully; all four `canvas edit at <width> <theme>: create, echo to second viewer, refusal and clear` browser tests fail at the missing document. Restored code passes all four.

An initial literal-false mutation broke TypeScript narrowing and was rejected by the build; it is excluded from the mutation evidence.

Receipts: `logs/verification.log`, `logs/w5a-mutation-wire.log`, `logs/w5a-mutation-reachability-e2e.log`, `logs/w5a-unit-final.log`, `logs/w5a-build-final.log`, `logs/w5a-typecheck-final.log`, `logs/w5a-biome-final.log`, and `logs/w5a-e2e-restored.log`.

## Screenshots and remaining acceptance

Twelve distinct PNGs in `.scratch/w5a/`: `w5a-{edit,saved,clear}-{1440,390}-{dark,light}.png`, all 960 px tall. Visual checks cover the dock, phone sheet, editor, rendered markdown and clear state; no overlap or horizontal overflow was found.

Traffic uses `tests/e2e/helpers/mockRelay.ts` and throwaway keys. This proves the built client, signing and subscriptions; live relay authorization remains unverified. The shell confirmed `BUZZ_PRIVATE_KEY` is unavailable. The shared-browser live session was checked read-only, without exporting or reusing its identity. The sole remaining acceptance task is for an enrolled throwaway identity to edit and clear its own private channel on `https://crichton.tailb3d4b8.ts.net:6351`, with both updates reaching a second browser.

## Files and deviations

Changed web files:

- `web/src/features/canvas/lib/channelCanvas.ts` and `.test.mjs`
- `web/src/features/canvas/useCanvasEdit.ts`
- `web/src/features/canvas/ui/ChannelCanvasView.tsx` and `.test.mjs`
- `web/src/features/canvas/ui/ChannelCanvasSheet.tsx`
- `web/src/features/canvas/ui/CanvasPane.tsx`
- `web/src/features/shell/ui/RightPaneHost.tsx` and `.test.mjs`
- `web/tests/e2e/canvas-edit.spec.ts`
- `web/playwright.config.ts`

Handoff files: root `AGENTS.md`, `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`, and this report. Logs and screenshots are local artifacts.

The plan names two implementation files, but the shell did not render empty canvases and its phone sheet handled only files. The `RightPaneHost`/`CanvasPane` wiring and channel document sheet are necessary for W5a's empty-canvas and phone workflow. Write state is isolated in `useCanvasEdit`. No wire-contract or feature-scope change was needed.

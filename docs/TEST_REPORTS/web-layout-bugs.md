# Web conversation layout fixes — 2026-10-03

Both vcrxm3xrk920 and je8htrkcvrcd reproduce on the baseline and are corrected.
Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-124429`.
Branch: `codex/buzz-codex-20261003-124429`.
Baseline: `228ae06c4bab0026f2ba4bd810b788d15b32fb14`.
Source commits: `58e03845f`, `13ffc34e1`.

## Changes

Read root AGENTS.md, VISION.md, TESTING.md, the web redesign plan, and
FORK_MANIFEST.md. No web-root AGENTS.md or package-local TESTING.md exists.
The carried Web redesign series row describes these fixes. Commit
`5965d66ad` introduced the Work/Canvas dock; the current shared stored dock
width could consume all but 238px of chat at a 1054px viewport.

Dock sizing now leaves 400px for the main column and 3px for its resize handle.
The stored preferred width survives; it can occupy more space when the window
grows. This also protects chat after returning from Canvas to Work, which shares
that preference. The shell row is an inline-size query container, so a resized
sidebar participates in the decision. If that row is below 723px (400px chat +
320px Canvas + handle), Canvas overlays the row and hides its resize handle;
its Work tab returns to chat. Existing below-lg document sheets and explicit
full-width expansion remain reachable. This preserves readable conversation
and channel documents within the product's existing responsive shell.

Message actions stay at the top of their own row instead of translating upward
by half their height. Their hover, focus, menu and touch paths remain. The
preceding open thread's input no longer falls underneath the neighbour's bar.

## Baseline and restored checks

All commands run with Hermit activated, from this worktree's `web/` directory.
Full outputs are in `.scratch/layout-bugs/`; collected receipts are in the
project's `logs/verification.log`.

| Command | Before | After |
|---|---|---|
| `pnpm test` | 4,421 pass, zero fail/skip | 4,421 pass, zero fail/skip |
| `pnpm typecheck` | exit 0 | exit 0 |
| `pnpm build` | exit 0 | exit 0, including final restored build |
| `pnpm lint` | 2 errors, 10 warnings, 9 infos | same 2 errors, 10 warnings, 9 infos |
| Biome check on all five affected web files | — | pass |
| `CHECK_FILE_SIZES_BASE=228ae06c4bab0026f2ba4bd810b788d15b32fb14 pnpm check:file-sizes` | — | pass |

The unchanged lint errors are `timelineCache.ts:500` (iterable callback return)
and `timelinePrefetch.ts:121` (implicit-any variable). Existing build warnings
about mixed static/dynamic imports and chunk size remain. This change does not
repair those baseline issues.

Added 18 painted regressions: both fixed palettes at all four requested widths,
plus two narrow-row overlay cases. No new jsdom/source-text checks were added:
jsdom cannot paint the CSS geometry or prove the reply input receives clicks.
The restored command below passes **24/24**: 18 new cases and six existing
channel-Canvas editing/file-preview workflows.

```sh
PLAYWRIGHT_PORT=18901 pnpm test:e2e:smoke conversation-layout canvas-edit shelf \
  --headed --grep 'conversation width|Neighbour toolbar|Canvas overlays|Canvas:|canvas edit'
```

Agent Brave's attached tools are absent from this session's callable catalog.
Its configured MCP server was called through an SDK client at CDP `:9225`
(same browser ID as `:9222`). `browser_tabs new` claimed the screenshot tab;
`browser_run_code_unsafe` drove the real worktree Vite server at
`http://127.0.0.1:18900`. Both ports were free and absent from the port registry.
The UI used synthetic relay events and an ephemeral test identity.

The standard runner's Brave contexts could not intercept relay WebSockets:
18 cases failed before reaching their assertions. A default-context trial also
failed at relay setup, after correcting its missing base URL. An independent
attached-browser canary returned `intercepted:false`, `echo:"timeout"` for a
new context. Automated regressions therefore used the supported isolated headed
fallback. These setup failures are recorded separately from mutation failures.
The MCP-owned Brave page did support its relay interception and completed the
required before/after visual checks and actual reply-input interaction.

## Mutation proof

Source was committed before mutations. Every mutant built successfully before
its named browser tests ran; only the changed source was restored from Git.
Each selection discovered two tests (one per palette), both previously passing;
both failed on the specified assertion. The final restored 24-case run passes.

| Withdrawn mechanism | Named failing test (buzz and buzz-dark) | Actual failure | Receipt |
|---|---|---|---|
| Remove new responsive CSS block | Canvas preserves conversation width at 1054 | expected >=400px; received 238px | `.scratch/layout-bugs/mutation-width.log` |
| Restore `-translate-y-1/2` | Neighbour toolbar leaves thread reply clickable at 1054 | bar top 353.765625px; row top 371.765625px | `.scratch/layout-bugs/mutation-toolbar.log` |
| Remove Canvas dock class wiring | Canvas overlays a row too narrow for both panes | expected absolute; received sticky | `.scratch/layout-bugs/mutation-overlay.log` |

## Agent Brave geometry and screenshots

With a 260px sidebar and 540px stored dock preference:

| Viewport | Chat before | Chat after | Adjacent reply-box overlap before / after |
|---|---:|---:|---|
| 1440px | 624px | 624px | yes / no |
| 1280px | 464px | 464px | yes / no |
| 1054px | 238px | 400px | yes / no |
| 900px | 627px | 627px | yes / no |

At 900px Canvas uses the existing full-screen document sheet; the table reports
chat geometry behind it. Closing the sheet restores the visible conversation.
No horizontal page overflow occurs at any width. With a 480px sidebar at 1054px,
Canvas overlays the 561px row and returning to Work leaves 400px chat. Explicit
expansion still measures x=480px, width=574px on that viewport. A real mouse
click and text entry focus the thread input; hovering its neighbour preserves
that focus. `elementFromPoint` hits the input while the toolbar is shown.

Screenshots in `.scratch/layout-bugs/`:

- `before-canvas-{1440,1280,1054,900}.png`
- `after-canvas-{1440,1280,1054,900}.png`
- `before-toolbar-{1440,1280,1054,900}.png`
- `after-toolbar-{1440,1280,1054,900}.png`
- `after-overlay-1054.png`

There are 17 captures and 16 distinct hashes. The before/after 900px Canvas
captures are identical because that existing sheet retains the same pixels;
they are an unchanged-state comparison. Key narrow-window, overlay and sheet
captures were visually inspected. Raw geometry and interaction results are in
`.scratch/layout-bugs/browser-results.json`; actual attached MCP calls and tab
cleanup are in `.scratch/layout-bugs/attached-mcp.jsonl`.

The owned Brave tab, SDK client, temporary fixture files and local dev server
were cleaned up. The shared browser and unrelated tabs remain. All mutations
are restored. No work remains within the assigned two-bug scope; the baseline
lint errors remain documented above. Fleet focus-status publication was
unavailable because this coding shell has no Buzz signing credentials.

# Web conversation layout fixes — 2026-10-03

Both vcrxm3xrk920 and je8htrkcvrcd reproduce on the baseline and are corrected.
Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-124429`.
Branch: `codex/buzz-codex-20261003-124429`.
Baseline: `228ae06c4bab0026f2ba4bd810b788d15b32fb14`.
Source commits: `58e03845f`, `13ffc34e1`; QA follow-up: `a286ae533`.

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

## QA-WEB-LAYOUT-001 follow-up

QA's evidence in `.scratch/qa-layout/web-layout-bugs.md` and
`reaction-checks.json` reproduces on `8a63b8131`: with Canvas open at 1054px,
the 368.69px toolbar extends left of the 400px conversation. The new painted
regression fails in both palettes: the 👍 button starts at **152.31px**, while
chat starts at **263px**.

`a286ae533` makes each message row an inline-size query container. Quick
reactions disappear from the end of their priority order as the row narrows;
the narrowest rows hide the group and its divider. Feedback retains its
accessible name while its visual label gives way to the icon. Add reaction,
Reply, Feedback and More actions remain available. A row-relative maximum
width and wrapping bound the bar in exceptionally narrow rows. This follows
the existing container-query idiom in `redesign.css`, including indented
thread rows rather than relying on viewport width.

The optional compact-row tidy is included: 1px padding around the existing
28px controls and 1px border gives a **32px** bar, removing the 4px overhang.
Click targets retain their existing size.

Four new painted cases in `conversation-layout.spec.ts` cover both palettes:

- `Neighbour toolbar stays inside conversation width and reacts at 1054`:
  Canvas is open, chat is exactly 400px, every visible toolbar button lies
  within chat and its centre receives pointer input. A real 👍 click emits
  exactly one kind-7 event for the correct target/viewer, then its echoed
  reaction renders as the viewer's pressed chip. More actions stays visible.
- `Neighbour toolbar adapts to conversation width and fits compact rows`:
  1054/1280/1320/1360/1400/1440px retain 1/1/2/3/4/5 quick reactions. Both
  toolbar and grouped row measure 32px, with all four toolbar edges inside
  the row. The first combined attempt assumed two reactions at 1280px; live
  measurements showed the row was only 300.64px, and that test expectation
  was corrected before the successful run.

Hermit was activated for all commands. Receipts are in
`.scratch/layout-toolbar/` and appended to `logs/verification.log`.

| Check | Result | Receipt |
|---|---|---|
| `pnpm test` | 4,421 discovered/pass; zero fail/skip | `unit.log` |
| `pnpm typecheck` | exit 0 | `typecheck.log` |
| `pnpm build` | exit 0, including final restored bundle | `restored-e2e.log` |
| Four-file Biome check | exit 0 | `biome.log` |
| File-size check against `8a63b8131` | exit 0 | `file-sizes.log` |
| Original E2E selection with four added cases | **28/28 pass**, zero skips | `restored-e2e.log` |

Exact restored command (supported isolated headed fallback):

```sh
env -u BUZZ_E2E_CDP PLAYWRIGHT_PORT=18901 \
  pnpm --dir web test:e2e:smoke conversation-layout canvas-edit shelf \
  --headed --grep 'conversation width|Neighbour toolbar|Canvas overlays|Canvas:|canvas edit'
```

Source was committed before mutation and rebuilt on every run. Each selection
discovered two tests, one per palette; those exact tests passed before the
mutation. Restoring the committed source and rebuilding passes all 28 cases.

| Mutation | Named failure in both palettes | Assertion | Receipt |
|---|---|---|---|
| Restore all three source files from `8a63b8131` | `Neighbour toolbar stays inside conversation width and reacts at 1054` | button x >=263; received 152.3125 | `mutation-containment.log` |
| Restore 3px toolbar padding only | `Neighbour toolbar adapts to conversation width and fits compact rows` | height 32px; received 36px | `mutation-height.log` |

Agent Brave also painted the freshly built worktree bundle at 1054px and
completed a real 👍 click with the viewer's reaction chip rendered. Chat spans
x=263–663; its five visible controls span x=345–515. The grouped row and bar
both measure 32px. `brave-geometry.json` and visually inspected
`toolbar-1054.png` retain that evidence. Its owned tab and temporary preview
server were closed. UI fixtures simulate relay traffic; these checks do not
claim live relay authorization or persistence. Existing build warnings remain.

## Work dock minimum follow-up — 2026-10-03

Baseline: `bd758eebe`; source: `5efb88b7f`. Worktree:
`/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-140351`.

Sam's deployed `index-DyAuqtK1.js` left Work only 142px at 1054×900 with a
480px sidebar. The local baseline builds the same bundle and reproduces a
158px Work dock in the fixed-palette fixture. Both Work regressions fail the
hardcoded 320px width assertion; both Canvas regressions fail on the missing
Back to chat control (`baseline-e2e.log`, four discovered/failing).

The existing `WORK_WIDTH_MIN = 320` is the usable content minimum for Work's
rows, scope controls and top-level tabs. Open Work and Canvas now share one
dock class in `RightPaneHost.tsx` and the existing **723px** shell-row query in
`redesign.css`; no second threshold or JavaScript width observer was added.
Both retain the 400px chat reservation and shared preferred width when they
fit beside chat. Folded Work remains a 48px strip rather than an overlay.

The overlay's visible **Back to chat** button closes Canvas, selects Work and
folds the rail. Tab switching keeps Work and Canvas readable. The document
selection and 540px stored width survive folding, reopening and widening.
Below-lg sheets and explicit Canvas expansion retain their existing paths.

Twelve painted cases replace the two earlier Canvas-only overlay cases
(ten net additions). Both asserted palettes exercise each tab with sidebar
480 at 1054 and sidebar 260 at 1054/1280. They check actual sidebar width,
320px dock/400px chat bounds, populated Needs-you rows, fully uncut tabs whose
centres receive pointer input, overlay/handle/Back visibility, real Back and
composer clicks, folded-rail reopening, no page overflow, and restoration of
the 540px preferred width at 1440. The selection retains toolbar/input/reaction
coverage and six Canvas editing/file-preview workflows.

Hermit was activated for all checks. Raw output is in `.scratch/work-dock/`;
collected output is appended to `logs/verification.log`.

| Check | Result | Receipt |
|---|---|---|
| `pnpm test` | 4,421 discovered/pass; zero fail/skip | `unit.log` |
| `pnpm typecheck` | exit 0 | `typecheck.log` |
| `pnpm build` through the E2E script | exit 0 for fixed and all mutant bundles | E2E logs |
| Three-file Biome check | exit 0 | `biome.log` |
| File-size check against `bd758eebe` | exit 0 | `file-sizes.log` |
| Fixed E2E selection | 38/38 pass, zero skips | `fixed-e2e.log` |
| Restored E2E selection and final build | 38/38 pass, zero skips; build exit 0 | `restored-e2e.log` |
| Final narrow cases before mutations | 4/4 pass | `pre-mutation-e2e.log` |
| Preview HTTP request | HTTP/1.1 200 OK | `preview-http.log` |

Source was committed before mutation. Each mutant built successfully and ran
the same named tests that passed before withdrawal. Restore uses the source
commit; Git confirms all three source/test files match it.

| Withdrawn mechanism | Named failing cases (both palettes) | Failure | Receipt |
|---|---|---|---|
| Remove Work from shared dock-class wiring | `work dock stays usable with sidebar 480 at 1054` (2/2) | expected width ≥320px; received 158px | `mutation-work-overlay.log` |
| Remove Back's rail-collapse call | `canvas dock stays usable with sidebar 480 at 1054` (2/2) | after Back, expected sticky/folded; received absolute | `mutation-back-to-chat.log` |
| Lower the shared threshold to 500px | Work and Canvas `dock stays usable with sidebar 480 at 1054` (4/4) | expected absolute; received sticky | `mutation-shared-threshold.log` |

Agent Brave's attached WebSocket interception canary returned `timeout`; its
owned tab was closed. Painted tests therefore use the documented isolated
**headed** fallback with synthetic relay events and an ephemeral identity.
A dynamically allocated, unoccupied loopback preview port avoids another
worktree's server. This proves fixture-client geometry and interaction;
live-relay persistence is outside these checks.

`shots/dock-{work,canvas}-{480-1054,260-1054,260-1280}-{buzz,buzz-dark}.png`
contains twelve captures. Representative narrow Work/Canvas and wider Work
captures were visually inspected. Build output retains the existing mixed
static/dynamic-import and chunk-size warnings. Fleet focus-status publication
was unavailable because this coding shell lacks Buzz signing credentials.

Final restored command (from the worktree root; preview-port contains the
dynamically allocated test port):

```sh
PLAYWRIGHT_PORT="$(cat .scratch/work-dock/preview-port)" \
  SHOTS_DIR="$PWD/.scratch/work-dock/shots" env -u BUZZ_E2E_CDP \
  pnpm --dir web test:e2e:smoke conversation-layout canvas-edit shelf --headed \
  --grep 'conversation width|Neighbour toolbar|dock stays usable|Canvas:|canvas edit'
```

All twelve dock captures have distinct SHA-256 hashes (`shot-hashes.json`).
The runner's preview processes and the owned browser tab were cleaned up.
The coding and local-verification scope is complete.

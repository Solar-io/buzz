# Safe details markdown renderer

The web and desktop message renderers recognise `<details><summary>…</summary>`
blocks with an optional bare `open` attribute. Other HTML remains escaped; no
general HTML renderer or new dependency is introduced.

The desktop `remarkDetails.ts` is the reference. The web copy is byte-identical
below its WEB COPY header, and both packages execute the same 16 plugin tests.
Bodies swallowed into a CommonMark HTML block are re-parsed using the owning
remark processor's parser and GFM extensions. The plugin runs before downstream
transforms, preserving spoilers, mentions, callouts, links and hard breaks.
Summary labels support inline markdown, including bold and inline code; labels
that parse as multiple blocks fall back to plain text.

Both renderers use native details/summary elements: closed by default, pointer
cursor, native disclosure marker, inherited text size, `text-foreground`, and a
token-based top margin on the first body block. Pulse NoteCard and every branch
of AgentActivityCard already use the web MarkdownContent and inherit this change.

## Regression coverage

The shared tests use the actual react-markdown parser and compare hardcoded
mdast trees, with source positions omitted. All nine requested shapes are covered:
blank-separated body; single HTML-node body; summary on its own line; open;
missing close bounded by its parent; nesting; literal fenced/inline code; emoji
and formatted label; and unchanged unrelated HTML. Additional cases exercise
summary in a separate HTML block, nested single-node and split-node bodies,
closing tags inside a body fence, incomplete summaries, rejected HTML attributes,
GFM tables/links and escaped HTML inside the body.

Desktop's actual nodeCache stack additionally verifies mentions, spoilers and
hard breaks in re-parsed bodies. Four web DOM tests render the shipped component,
assert `details > summary`, list contents, default/open state, bold/mention label,
escaped script/div text, callouts, spoilers and table cells. Only application
service boundaries are stubbed, not the markdown renderer or parser.

## Verification

| Package | Before | After | Typecheck |
| --- | ---: | ---: | --- |
| Desktop | 5,762 | 5,779 | `pnpm typecheck`, exit 0 |
| Web | 4,252 | 4,272 | `pnpm typecheck`, exit 0 |

Both final package suites run through `pnpm test --test-concurrency=4`, without
skips or exclusions. Desktop has 81 suites; web has none declared. Web baseline
is the original worktree parent `66bc5b0c8`, checked in a disposable worktree
using the installed dependency graph; that disposable worktree was removed.

An initial unrestricted concurrent web/desktop baseline hit existing timing
failures in `playBridgeResponse stops when shouldStop signals` and
`health sweep: a retry-exhausted sub on a live socket is re-REQd without a reconnect`.
The web child left its session timers alive, so the owned processes were stopped.
The parent baseline and final web suite pass with four test workers; neither
timing mechanism was changed. The initial receipt is `logs/details-web-before.log`.

Two Agent Brave browser cases run the built web client in both fixed palettes
using the existing mocked WebSocket relay. An agent kind-9 fixture reaches the
real channel message row with both requested body shapes. Each starts closed,
has a native disclosure marker and hidden list, expands on summary click,
collapses on the next click, and expands by Enter. Cursor, marker/display and
body margin are asserted from computed styles. Test-owned browser contexts and
the temporary preview server are closed. This is built-client acceptance with
mock relay traffic, rather than a production relay write.

`pnpm build` for web, touched-file Biome checks, desktop `check:px-text` and web
`check:palette-literals` pass. The global web px-text check reports exactly the
same two violations on the parent and final tree: GeometryDiagnosticOverlay.tsx:34
and CustomGradientThemeEditor.tsx:136 (`text-[10px]`). A scan of the changed web
sources using the repository's `runPxTextCheck` passes. No palette/text exceptions
were added. The conflict-marker scan and plugin/test copy comparisons pass.

## Mutation proof

After committing the implementation, both plugin transformers were replaced
with a no-op. Desktop still discovers 31 selected tests, with 13 named failures;
web still discovers 20, with 16 named failures. These include both `remarkDetails:
blank-line body is a closed details with a markdown list` and `remarkDetails:
single HTML node body is re-parsed as a markdown list`, plus the real renderer
integration tests. Code/other-HTML tests remain green under the no-op.

Restoring the committed plugin bytes returns desktop 31/31 and web 20/20 to
green. Final full-suite counts above are recorded after restoration. Receipts
are in `logs/details-{desktop,web}-mutation.log`, `*-restored.log`, `*-after.log`,
`logs/details-browser.log` and `logs/verification.log`.

Source: `a2542b7fc`; DOM/browser regressions: `fcfcab3`. The requested coding
scope is complete with no deferred feature. Fleet status publishing lacked
`BUZZ_PRIVATE_KEY`; browser acceptance uses generated fixture identities.

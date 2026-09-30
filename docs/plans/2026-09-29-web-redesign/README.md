# Web redesign: canvas copy

A copy of the design-of-record canvas, taken 2026-09-30 from
<https://claude.ai/artifact/K2Jb3SufvUFXbq6rwWbb7u> so build agents can read the
exact markup, color tokens and layouts offline. The plan is
[`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md); each phase
names the artboards it must match.

- `canvas.json` lists every artboard with its size and title.
- Each `*.dc.html` is one artboard: a self-contained HTML page whose
  `<helmet><style>` block holds the theme tokens (`.th` = light, `.th.dark` =
  dark). Most artboards take a `theme` prop in their `data-props`.
- The data inside the artboards (names, numbers, messages) is sample data. The
  layout, tokens, states and copy patterns are what count.

Per-phase design docs from the architect land in this folder as
`phase-N.md`.

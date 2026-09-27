# Stage-mode wire corpus (Agent Stage Mode v1)

The normative description of the `["stage", …]` tag on kind-9 messages,
executed as a test by **both** implementations:

| Consumer | File | Command |
|---|---|---|
| TypeScript (web client) | `web/src/features/stage/lib/stageTag.fixtures.test.mjs` | `cd web && pnpm test` |
| Rust (`buzz stage …`) | `crates/buzz-cli/src/commands/stage_tag.rs` | `cargo test -p buzz-cli` |

Same mechanism as `../decision-cards/`: change a bound or an error message on
one side only and exactly one suite goes red.

## `limits.json`

Every numeric cap, plus `cases` (the case count). TS asserts `STAGE_LIMITS`
deep-equals the file minus `cases`; Rust asserts each `STAGE_MAX_*`. **Both**
assert `cases.json.length === cases`, so a fixture path that silently resolves
to nothing is a loud failure rather than zero cases passing.

Lengths are UTF-16 code units on both sides.

Note: with real relay media URLs (~110 chars) a manifest row is ~200 units,
so the 8192-unit tag cap binds before `maxParts` (roughly 35-40 frames). The
builder refuses an over-cap manifest before anything is published.

## `cases.json`

```jsonc
{
  "name": "…",
  "payload": { … },      // the raw tag value as a JSON value
  "payloadRaw": "…",     // OR the raw tag value as TEXT (1.0 / 1e0 / lone surrogates)
  "expect": "accept" | "reject",
  "canonical": { … },    // accept: what the builder re-emits after parsing
  "reason": "…"          // reject: substring BOTH error messages contain
}
```

Accept: parse the raw value, rebuild it, compare structurally to `canonical`
(known keys only; `hold` omitted when true; `voice` always emitted).

## Adding a case

1. Add it to `cases.json`.
2. Bump `cases` in `limits.json` and the accept/reject counts in both drivers.
3. Run both suites.

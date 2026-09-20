# Decision-card wire corpus (D-035 v1 + v2)

The normative description of the `["card", …]` tag payload, executed as a test
by **both** implementations of it:

| Consumer | File | Command |
|---|---|---|
| TypeScript (web client) | `web/src/features/channels/lib/decisionCardFixtures.test.mjs` | `cd web && pnpm test` |
| Rust (`buzz messages send --card`) | `crates/buzz-cli/src/commands/card.rs` | `cargo test -p buzz-cli` |

Two validators of one wire format drift. v1 guarded against that with a comment
asking people to be careful. This corpus is the mechanism that replaces it:
change a bound or an error message on one side only, and exactly one suite goes
red.

## `limits.json`

Every numeric cap, plus `caseCount`.

- TS asserts `CARD_LIMITS` deep-equals this file minus `caseCount`.
- Rust asserts each `CARD_MAX_*` constant equals its entry.
- **Both** assert `cases.json.length === caseCount`.

That last assertion is not ceremony. A driver whose fixture path silently
resolves to nothing runs zero cases and reports success — the inert-harness
failure. Pinning the count makes an empty corpus a loud failure instead.

`maxTagBytes` is measured in **UTF-16 code units** on both sides (JS `.length`
parity — `utf16_len` in Rust), not bytes; the key name predates v2 and is kept
for continuity with `CARD_LIMITS`.

## `cases.json`

An array of cases. Each is one author payload — exactly the JSON a caller
passes to `buzz messages send --card` — and what the **builder** must do with
it.

```jsonc
{
  "name": "human-readable case name",
  "payload": { … },        // author input (a non-object payload is legal here)
  "payloadRaw": "…",       // OR the same input as raw JSON TEXT; wins when present
  "expect": "accept" | "reject",

  // accept only:
  "canonical": { … },      // the wire payload the builder emits, as an OBJECT
  "fallback": "…",         // the exact fallback `content` the builder emits

  // reject only:
  "reason": "…",           // substring BOTH implementations' error messages contain

  // optional, TypeScript only (Rust ships no parser):
  "parseRaw": "accept" | "reject"   // what parseCardTags does with the RAW payload
}
```

`payloadRaw` exists because some inputs cannot survive a trip through a JSON
*value*. A lone surrogate (`"\ud800"`) would make **this file** undecodable by
`serde_json`, and a numeric spelling (`1e0`) is normalized away by both parsers
— so the case carries the payload as TEXT, escaped once more, and both drivers
hand that text to the builder verbatim. Exactly one of `payload` /
`payloadRaw` is required; the count test asserts it.

Invisible trim characters are written as `﻿` / `\u0085` escapes rather than
as themselves. A raw U+FEFF in a fixture is unreadable in review and one stray
editor save from vanishing.

`canonical` is compared **structurally**, not as a string: `serde_json::Map` is
ordered alphabetically by default while `JSON.stringify` preserves insertion
order, and JSON object key order carries no meaning on the wire. Every field,
its value and its presence/absence are still pinned exactly.

`parseRaw` exists because the builder and the parser deliberately disagree in
four documented places. Three are render-side leniency — two recommended
options in one question (the parser keeps the first), an over-long body (the
parser drops the body, not the card), and a multi-question interview with no
title (the parser borrows question one's text) — where the builder refuses the
send so the shape cannot reach the wire, while an already-published one still
renders. The fourth is the other direction: an absent version field, which the
builder defaults to v1 and always emits, and which the parser refuses outright.
Cases that exercise those carry an explicit `parseRaw` expectation, so each
asymmetry is a tested fact rather than a comment.

`parseRaw` does a second job: it pins the places the two must **agree** on an
input the `canonical` payload cannot exercise, because the canonical is already
normalized. A title padded with U+FEFF and U+0085 is over its bound until both
sides trim the same set; a v1 `description` is ignored rather than validated; a
version written `1.0` is the number 1. Without `parseRaw` those only ever reach
the builder.

For accept cases the TS driver additionally round-trips: the canonical parses,
`serializeCardPayload` of the parsed card re-parses to an identical card, and
`cardFallbackText` of the parsed card equals `fallback`.

## Adding a case

1. Add it to `cases.json`.
2. Bump `caseCount` in `limits.json`.
3. Run both suites. Hand-check the `fallback` text you added by reading it — it
   is what every plain nostr client shows, so it has to read as a complete,
   answerable question set on its own.

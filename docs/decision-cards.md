# Decision cards — the wire contract

A **decision card** is a structured question an agent sends into a channel or a
DM, which the Buzz web client renders as a tappable card and every other client
renders as ordinary readable text. This document is the contract. The normative,
executable version of it is the fixture corpus at
`test-fixtures/decision-cards/`, which both implementations run as tests:

| Implementation | Source | Test command |
|---|---|---|
| Authoring (CLI) | `crates/buzz-cli/src/commands/card.rs` | `cargo test -p buzz-cli` |
| Rendering (web) | `web/src/features/channels/lib/decisionCard.ts` | `cd web && pnpm test` |

If this document and the corpus ever disagree, the corpus is right.

## The event

A card is an **ordinary kind 9**. Nothing about it is a new event kind, a new
relay behaviour or a new permission.

- `content` — human-readable fallback text, generated from the payload. Buzz
  Desktop and every plain nostr reader show exactly this, so it must read as a
  complete, answerable question set on its own.
- one author tag — `["card", "<compact JSON>"]`. The relay passes unknown author
  tags through verbatim (they are signature-covered), so no relay change was
  ever needed.
- the usual `h` / `p` / `e` tags. **`--mention <pubkey>` is what puts the card in
  someone's Asks inbox**: outside a 2-party DM, a card with no p-tag is a
  broadcast and belongs to nobody.

An **answer** is an ordinary kind 9 reply whose NIP-10 reply-marker `e` tag names
the card event. That is the whole "answered" test.

## Payload v1 — one question

```json
{
  "v": 1,
  "title": "Ship the claims fix?",
  "body": "Second bounce needed.",
  "options": [
    { "id": "now", "label": "Relaunch now" },
    { "label": "Let it ride", "recommended": true }
  ]
}
```

Unchanged since 2026-09-16 and unchanged by v2. Existing cards in the wild
render and answer exactly as they always did.

## Payload v2 — an interview

```json
{
  "v": 2,
  "title": "Ship the claims fix",
  "body": "Context that applies to every question.",
  "questions": [
    {
      "id": "scope",
      "header": "Scope",
      "question": "Which surfaces?",
      "body": "Web is the iOS bundle too.",
      "multiSelect": true,
      "options": [
        { "id": "web", "label": "Web", "description": "The SPA", "recommended": true },
        { "label": "Desktop" }
      ]
    },
    { "question": "When?", "options": [{ "label": "Now" }, { "label": "Later" }] }
  ]
}
```

Field names mirror Claude Code's `AskUserQuestion` tool schema (`question`,
`header`, `options`, `label`, `description`, `multiSelect`) so an agent that
knows one knows the other.

### Bounds

Every number here lives in `test-fixtures/decision-cards/limits.json` and is
asserted by both suites.

| Key | Value | Notes |
|---|---|---|
| `maxTagBytes` | 16384 | the serialized tag payload, in UTF-16 units |
| `maxTitleChars` | 120 | |
| `maxBodyChars` | 4000 | interview-level body |
| `maxQuestions` | 6 | v2 |
| `maxQuestionChars` | 300 | |
| `maxQuestionBodyChars` | 1000 | |
| `maxHeaderChars` | 12 | progress-chip label |
| `maxOptions` | 8 | **per question**; minimum 2 |
| `maxLabelChars` | 200 | |
| `maxDescriptionChars` | 200 | |
| `maxIdChars` | 40 | |

Ids are render keys, not identity promises: omit them and the reader derives
positional `"0"`, `"1"`, … .

### String fields

Every string field is bounded in **UTF-16 code units** (JS `.length`; `utf16_len`
in Rust), so one emoji costs 2.

**Trimming is an explicit set, not the language's default:** Unicode
`White_Space` **∪ U+FEFF**. Neither built-in is that set and the two disagree in
both directions — `String.prototype.trim` strips U+FEFF and leaves U+0085 (NEL),
`str::trim` strips U+0085 and leaves U+FEFF — so each side declares the set
itself (`CARD_TRIM_CHARS`, same code points in the same order) and never calls
its own `trim()` on a card field. A field is measured AFTER that trim: a label
of only U+FEFF is empty and refused by both, and a 120-character title padded
with either character is still 120.

**Unpaired surrogates are refused** in any string field, by both sides. A lone
`"\ud800"` is not valid UTF-8: `JSON.stringify` escapes it rather than failing,
so the tag looks fine, while `serde_json` cannot decode it at all — the CLI
could not read back a card the web builder had emitted. The two reach that
refusal at different layers (the web builder checks the payload; Rust's JSON
decode refuses first) and report the same message.

Everything else rides the wire verbatim, deliberately — including
display-hostile-but-legal characters like RTL overrides (U+202E), ZWJ (U+200D)
and combining marks. Those are author text; the answer to them is **bidi
isolation where a label is rendered**, which belongs to the UI phases, not to
the wire format.

### Version rules

- `v` is **optional on input** — every shipped `--card` invocation omits it — and
  **always present on output**. With no `v`, a `questions` key selects v2 and
  anything else is v1.
- The reader requires `v` and accepts only `1` or `2`. `v: 3`, `v: "2"` and a
  missing `v` all fall back to the `content` text. That is deliberate: a client
  that does not understand a card shows the question rather than half of it.
- `v` is a JSON **number equal to** 1 or 2 — not a spelling of one. `1`, `1.0`
  and `1e0` are the same JSON value, and a JS parser cannot tell them apart
  without re-reading the raw text, so the Rust builder matches by value
  (integral, in range) rather than by serde's storage type. `1.5` is not a
  version.
- A single-question v2 payload may omit `title` (it borrows the question's
  text). More than one question **must** be titled.

### One parsed shape

`parseCardTags` normalizes both versions into one structure — a v1 card becomes
an interview of exactly one question whose text is the card title. There is one
parser, one bounds validator, one Rust mirror and one renderer; nothing
downstream branches on the version.

### Authoring is stricter than rendering

The reader is total: every malformed shape returns "not a card" and the message
renders as plain markdown. It is also lenient in three specific places, where
the builder refuses instead — so a self-contradicting card cannot reach the wire
but an already-published one still renders:

| Situation | Builder | Reader |
|---|---|---|
| two options marked `recommended` in one question | refuses the send | keeps the first marker |
| a body over its bound | refuses the send | drops the body, keeps the card |
| no `title` on a multi-question interview | refuses the send | borrows question one's text |

Each asymmetry is a `parseRaw` case in the corpus, not a comment.

### v1 has no `description`

`description` is a **v2** field. A v1 payload carrying the key is not a v1 card
with an extra field — v1 shipped on 2026-09-16 without one, so a published v1
card that happens to carry it must render exactly as it did then. Both sides
therefore **ignore it on v1**: the reader never validates it (a malformed one
cannot reject the card) and the builder drops it from canonical v1 output rather
than refusing the send. On v2 it is part of the format and validated strictly.

## Answering one

An answer is **one** ordinary kind 9 reply per submission — never one per
question. Its NIP-10 reply marker names the card, which is the whole
"answered" test, and it p-tags the card's author so the asker is notified
once.

It carries **both halves**, and which half matters depends on who is reading:

| Half | Read by |
|---|---|
| `content` | the asking agent's LLM, Buzz Desktop, every plain nostr reader |
| `["card-answer", "<compact JSON>"]` | the Buzz web client, and any structured reader |

### The content — the contract with the agent

```
**Which surfaces?** — Web only
**Which extras?** — Docs, Tests
**When?** — after the release

_Note: Also keep the CLI unchanged._
```

Exactly:

- **One line per question OF THE CARD, in author order** — answered or not.
  An omitted line would make "this question was not asked" and "this question
  was not answered" the same text.
- The line is `**<question text>** — <answer>`. An unanswered question's
  answer is the literal `_(not answered)_`.
- A multi-select answer is its chosen labels comma-joined on that one line,
  **in card option order** (not tap order), so identical choices produce
  identical bytes.
- A typed answer is the typed text, in the same shape as a chosen label.
- An optional interview note is one trailing `_Note: …_` paragraph after a
  blank line. Nothing else appears.
- **Line separators are collapsed to a single space** in every string that
  reaches this text — question text, option labels, typed answers, the note.
  Card text otherwise rides the wire verbatim, but the content contract is
  ONE LINE PER QUESTION, and a newline inside a label would silently split one
  line into two with no way for any reader to reattach them.

A partial prepends one line and a blank line:

```
Answered 2 of 4 — the rest are still open.

**Which surfaces?** — Web only
**Which extras?** — _(not answered)_
**When?** — Now
**Anything else?** — _(not answered)_
```

It leads, so an agent that reads only the first line still learns the
interview is unfinished.

### The tag — the machine half

```json
{
  "v": 2,
  "c": "<card event id>",
  "a": [
    { "q": "scope", "o": ["web"] },
    { "q": "extras", "o": ["docs", "tests"] },
    { "q": "when", "t": "after the release" }
  ],
  "n": "Also keep the CLI unchanged.",
  "done": true
}
```

Keys are short because nobody reads them. `q` is a question id and `o` holds
option ids — the thing `content` cannot carry and v1 never transmitted at all
(v1 sent the label verbatim, so a client could only recover the choice by
string-matching labels back onto the card). `t` is a typed answer and excludes
`o`. `c` is redundant with the reply-marker e-tag and nothing branches on it.

There is no v1 answer payload. `v` must be the number `2`.

| Key | Bound |
|---|---|
| `c` | 64 chars (a nostr event id) |
| `a` | 1–6 entries, one per answered question, no duplicate `q` |
| `q` | 40 chars |
| `o` | 1–8 unique ids, each 40 chars |
| `t` | 200 chars — an option label's bound, so typing cannot smuggle in more than choosing could |
| `n` | 2000 chars |
| whole payload | 16384 chars, the same self-cap as the card |

### `done` is derived, never asserted

`done` is `answers.length === card.questions.length`. The builder computes it
and **no caller can set it**: the failure being guarded is an agent acting on
2 of 4 answers as though the interview concluded, and a caller able to pass
`done: true` alongside a gap is a caller able to manufacture exactly that.
"Send what I have" needs no such power — a submission with a gap IS a partial.

### The badge rule

An ask clears when:

```
reply.kind === 9
  ∧ reply.author === me
  ∧ reply.replyToId === cardId
  ∧ ( no card-answer tag  ∨  cardAnswer.done === true )
```

The first arm keeps **v1 bit-identical**: a reply with no `card-answer` tag is
content-agnostic and complete. A plain "yes", an Asks-inbox chip, and the
"answer in chat instead" path all clear the badge exactly as they did before
v2 existed. That arm is not a compatibility shim to be tidied away later — it
is the whole reason typing freely still works.

A `done:false` partial leaves the ask **lit**. A lit badge and a stalled agent
is a recoverable state; a confidently-wrong agent is not.

### Absent is not the same as unreadable

A `card-answer` tag that is PRESENT and cannot be read — a future `v:3`, a
corrupt payload, two tags on one event — parses to `done:false`, not to "no
tag". We know an answer claims to be here and we know it does not claim to be
complete, so the badge stays lit. Assuming completeness from a payload we
could not read is the one direction that loses the ask.

### Superseding an answer

A user who later completes a partial publishes a **second** answer event with
`done:true`. Answers are never edited in place, and only `done:true` answers
are recorded as clearing the card — so replay order does not matter.

### Authoring is stricter than rendering, here too

The answer builder refuses what the card RENDERER tolerates, and the list is
short because each entry is a way to publish an ambiguous machine payload:

| Situation | Builder |
|---|---|
| an option id that is not on the card | refuses |
| a question id the card does not have | refuses |
| two answers for one question | refuses |
| a single-select question given two options | refuses |
| a multi-select question with nothing chosen | refuses — that is "not answered", not an answer |
| both `o` and `t` for one question | refuses |
| **a card whose question ids, or one question's option ids, collide** | refuses |

That last one is a real hole in the card format rather than a hypothetical:
`parseCardTags` fills omitted ids positionally (`"0"`, `"1"`, …) and takes
explicit ones verbatim, so a card declaring `id: "1"` on question 0 produces
two questions both called `"1"`. The `content` stays unambiguous (it keys on
question text in author order), so this is not a reason to refuse to RENDER —
but two `{"q":"1"}` entries cannot be told apart, so it is a reason to refuse
to BUILD. Such a card is still answerable through the plain-text path, and the
web client falls back to it automatically.

## Sending one

```bash
buzz messages send --channel <uuid|#slug> --mention <askee-pubkey> --card '{
  "title": "Ship the claims fix",
  "questions": [
    {"header":"Scope","question":"Which surfaces?","options":[{"label":"Web"},{"label":"Web + desktop"}]},
    {"question":"When?","options":[{"label":"Now"},{"label":"After the release"}]}
  ]
}'
```

`--card` also takes `@file.json` or `-` (stdin), which is the sane way to pass
anything with shell metacharacters in it. With no `--content`, the fallback text
is generated from the card.

### Refining — a second card, not a branch

There is no conditional branching inside a card. To follow up, send a **second
card in the same thread**, replying to the answer you got:

```bash
buzz messages send --channel <uuid> --mention <askee> \
  --reply-to <the answer event's id> --card '{…round 2…}'
```

The NIP-10 thread root is what ties the rounds together — no extra field, no new
tag, no relay filter. A round-2 card sent as a new top-level message is a
different interview by definition and shows up as a second inbox row.

## What has NOT changed

- No relay changes. Discovery is client-side (the relay cannot filter the
  multi-char `card` tag — NIP-01 generic filters are single-letter), and answer
  detection is `#e` on the card id.
- No new event kind. Cards and answers are kind 9.
- No `desktop/` changes. Buzz Desktop renders the `content` fallback, which for
  a v2 card is a complete, answerable question set.
- The CLI is the only producer. A second producer would double the validation
  surface the corpus exists to protect.

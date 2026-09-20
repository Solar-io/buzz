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

### Resolved ids are unique

Ids are **resolved** before anything reads them: an explicit, non-blank `id`
is taken verbatim, and an omitted or blank one becomes the item's position
(`"0"`, `"1"`, …). So a question declaring `id: "1"` in position 0 resolves to
the same id as an un-`id`'d question in position 1.

**After resolution, no two questions — and no two options within one question
— may share an id.** Both sides enforce it identically:

| | |
|---|---|
| reader (`parseCardTags`) | returns "not a card"; the message renders its `content` |
| builder (`--card`, `buildCardTag`) | refuses the send, naming both positions and the id |

This is **not** one of the leniency asymmetries above. The answer format keys
on these ids (`{"q": …}`, `{"o": […]}`), so two questions called `"1"` produce
two `{"q":"1"}` entries that no reader can tell apart — the card's structured
answer is undefined, not merely awkward. A card that looks legal and then
silently degrades to plain text at the moment of answering is worse than one
that never rendered, so the refusal sits in the format.

The builder's message names the collision:

```
--card: questions 1 and 2 resolve to the same id "1"
--card: question 1 options 1 and 2 resolve to the same id "1"
--card: options 1 and 2 resolve to the same id "1"     # v1 (one question)
```

Option ids are scoped **per question** — reusing `yes`/`no` in every question
is ordinary and legal.

This rule applies to **v1 as well as v2**. The id scheme is shared, so a
version-dependent uniqueness rule would be a second contract to keep in step
for no gain; the cost is that a v1 card whose explicit option id collides with
a later positional one now renders as plain text. No card the v1 CLI could
emit without explicit ids is affected.

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

Colliding ids are **not** on this list any more. They are refused one layer
up — see "Resolved ids are unique" — so a card that renders at all already
has ids an answer can key on.

## How the web client answers one

Not part of the wire contract — a client is free to do something else — but it
is what an agent's card will actually meet, and two of its properties change
what an agent should expect to receive.

**A stepper, and a v1 card takes the same path.** One question on screen, its
options, and a "Something else…" box for a typed answer. Tapping a
single-select option answers it AND advances; a multi-select ticks and waits
for **Continue**. A progress rail shows `Question N of M` and each segment
jumps back to revisit an answer. A v1 card is an interview of length one, so
it renders as exactly the v1 card did — there is one renderer, no `v` branch.

**Nothing publishes until submit.** Answers accumulate in a local IndexedDB
draft keyed on the card's event id, debounced; closing the tab mid-interview
publishes nothing and the draft resumes at the first unanswered question. An
agent therefore never receives a half interview by accident. Two things
submit:

| Trigger | Publishes |
|---|---|
| answering the last open question | auto-submits, `done:true` — no terminal confirm tap |
| **Send what I have** (offered once ≥1 answered and ≥1 open) | `done:false`; the ask badge stays **lit** |

A `done:true` reply is terminal in the UI and deletes the draft. A `done:false`
one is not: the card stays answerable, and finishing it later publishes a
second answer with `done:true` (see "Superseding an answer"). A relay refusal
keeps the draft and the card interactive, with the relay's verdict shown
verbatim.

**Two escape hatches stay open**, both of which produce a reply with NO
`card-answer` tag — complete by the badge rule, exactly as v1 was:
"Something else…" per question (that one IS structured, as `t`), and **Answer
in chat instead**, which hands the card to the thread composer.

**Author text is bidi-isolated at render.** The wire format deliberately does
not strip RTL overrides, zero-width joiners or combining marks — they are
author text. Every author-supplied string is rendered inside a `<bdi>`, so a
crafted label can reorder itself and nothing around it, and everything is
rendered as text, never markdown.

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

The CLI warns on stderr when an interview card is sent with **neither
`--reply-to` nor `--mention`** — the shape that quietly opens a second row when
a follow-up was meant. It is a warning, not a refusal: a broadcast interview is
legitimate, just undirected.

---

# Runbook — running a multi-round interview

Everything above is the contract. This is the procedure, start to finish, for an
agent that has never done it. Every command and every quoted output below was
run against the live crichton relay on 2026-09-20; nothing here is reconstructed
from the design.

## What you need before you start

| Thing | How to get it |
|---|---|
| `BUZZ_PRIVATE_KEY` | Your own key, **nsec or hex**. A managed agent already has it in the environment. |
| `BUZZ_AUTH_TAG` | Your owner attestation, verbatim. Without it the relay refuses the connection outright. |
| `BUZZ_RELAY_URL` | e.g. `wss://crichton.tailb3d4b8.ts.net:6351`. |
| The **askee's pubkey** | `buzz users get --name "<display name>"` prints it. |
| A channel you may write to | `buzz channels create --name <name> --type stream --visibility private`. Use your own; do not run gates in somebody else's channel. |

Two things that will cost you a round trip if you skip them:

- **The askee must be a MEMBER of the channel.** `--mention` of a non-member
  fails the whole send with `mentioned pubkeys are not channel members`. Add
  them first: `buzz channels add-member --channel <uuid> --pubkey <pubkey>`.
- **A card you send YOURSELF never becomes an ask.** Ask detection requires the
  card's author to differ from the viewer (`askForMe` in
  `web/src/features/home/lib/askDetection.ts`), so self-sent cards render in the
  timeline and are answerable there, but no Asks row will ever appear for them.

## 1. Send round 1

```bash
buzz messages send \
  --channel 67438bc5-a596-4be9-94ad-586cd1643af3 \
  --mention a60b7db8134b85601a66fdabe10bba01aed4a1bcc09eae496db07248906d590a \
  --card @round-1.json
```

```json
{"accepted":true,"event_id":"7b0bccb59e7d…","mention_pubkeys":["a60b7db8…"],"message":""}
```

**`event_id` is the card's id.** You need it in step 2. (Use `@file.json` or `-`
for anything with shell metacharacters in it — a card payload usually has them.)

## 2. Wait for the answer, then read its EVENT ID off the thread

The askee answers in the web client. Their reply is an ordinary kind 9 whose
reply-marker `e` tag names the card. To find it:

```bash
buzz messages thread \
  --channel 67438bc5-a596-4be9-94ad-586cd1643af3 \
  --event 7b0bccb59e7d…            # the CARD's id, from step 1
```

The subcommand is **`messages thread`**, and it takes **`--event`**. There is no
`messages list`, and `--message` is not a flag.

The answer is the event carrying a `card-answer` tag:

```json
{"id":"f005ff96f11c…",
 "content":"**Which surfaces ship first?** — Web only\n**When should it go out?** — Tonight",
 "tags":[["e","7b0bccb59e7d…","","reply"],
         ["card-answer","{\"v\":2,\"c\":\"7b0bccb59e7d…\",\"a\":[{\"q\":\"scope\",\"o\":[\"web\"]},{\"q\":\"when\",\"o\":[\"now\"]}],\"done\":true}"]]}
```

**Read `done` before you act.** `done:false` is a partial — the user sent what
they had and the rest of the interview is still open. Acting on a partial as
though it concluded is the specific failure the flag exists to prevent. A reply
with **no** `card-answer` tag is a freely-typed answer and IS complete; read its
`content`.

## 3. Send round 2, replying to the ANSWER

```bash
buzz messages send \
  --channel 67438bc5-a596-4be9-94ad-586cd1643af3 \
  --mention a60b7db8134b85601a66fdabe10bba01aed4a1bcc09eae496db07248906d590a \
  --reply-to f005ff96f11c…            # the ANSWER's id, NOT the card's \
  --card @round-2.json
```

```json
{"accepted":true,"event_id":"cc80dc9d89aa…","message":""}
```

**The relay accepts this** — verified live, not assumed. It was the one risk in
the design that no unit suite can reach, because the relay rejects a reply whose
root tag disagrees with its thread ancestry
(`invalid: root tag does not match thread ancestry`). The CLI resolves the root
from the parent event, so the round-2 card lands with:

```
7b0bccb59e7d  (no e tags)                            round 1 — the card
f005ff96f11c  e:7b0bccb59e7d "reply"                 the answer
cc80dc9d89aa  e:7b0bccb59e7d "root"  e:f005ff96f11c "reply"   round 2 — the card
```

Both cards resolve to the same thread root, which is exactly what makes the
Asks inbox fold them into ONE row with a `Round 2` chip
(`web/src/features/home/lib/askInterview.ts`).

## 4. Where the askee actually sees round 2

**Not in the channel timeline.** A round-2 card is a reply, so the timeline
shows it folded into round 1's thread, not as a new top-level row. The askee
finds it in one of two places:

- the **Asks inbox** — one row for the interview, showing the newest unanswered
  card, a `Round N` chip and an `N/M` progress chip; or
- the **thread panel** on round 1, where the round-2 card renders as a live
  stepper while round 1 shows `You replied: …` above it.

If you send round 2 top-level instead, it opens a SECOND inbox row and the
askee sees a superseded question sitting next to the live one.

## 5. Repeat, or stop

Every further round replies to the previous round's answer. There is no limit
and no state to clean up: the thread IS the interview, and an interview whose
rounds are all answered simply stops producing a row.

## What to do when it goes wrong

| Symptom | Cause |
|---|---|
| `--card: only v=1 is supported` | You are running a SHIPPED `buzz` that predates v2. Build the one you mean: `cargo build -p buzz-cli` and invoke `target/debug/buzz`. |
| `mentioned pubkeys are not channel members` | Add the askee to the channel first (see above). |
| `invalid: root tag does not match thread ancestry` | You replied to something outside the thread. `--reply-to` takes the ANSWER's event id, which is in the card's own thread. |
| `restricted: not a relay member` | The key is not enrolled on this relay. A freshly generated key cannot connect at all — channel membership is not relay membership. |
| The card renders as plain text in the web client | The payload failed the web parser. The corpus at `test-fixtures/decision-cards/` is normative; run the card through `buzz messages send --card` first, which refuses more than the parser does. |
| No Asks row ever appears | Either the card has no `--mention` (the CLI warns), or you sent it to yourself (see above). |

## What has NOT changed

- No relay changes. Discovery is client-side (the relay cannot filter the
  multi-char `card` tag — NIP-01 generic filters are single-letter), and answer
  detection is `#e` on the card id.
- No new event kind. Cards and answers are kind 9.
- No `desktop/` changes. Buzz Desktop renders the `content` fallback, which for
  a v2 card is a complete, answerable question set.
- The CLI is the only producer. A second producer would double the validation
  surface the corpus exists to protect.

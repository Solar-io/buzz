# Phase 5 — Items: backend design (relay kind, SDK, CLI)

Architect design for the backend half of Phase 5 in
[`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md). The web Items
page is the designer's; this doc fixes the wire format it reads. Line refs are
to `df7363b9a`. Implementation seat: `coder`.

## Decisions

| # | Decision | Why |
|---|---|---|
| D5.1 | **Kind `30623` = Item** (addressable). `KIND_ITEM` in `buzz-core/src/kind.rs`. | Next free number after `30622` (NIP-DV). Upstream NIPs assign only 30617/30618 in 30610–30629 (checked 2026-09-30). Not used anywhere in the repo; the one hit is `hiddenDms.test.mjs:100`, which uses 30623 as a "wrong kind" fixture. That stays correct. |
| D5.2 | **Visibility follows the source channel.** The source-channel reference **is** the `h` tag. With `h` the item is stored channel-scoped. Without `h` it is community-global. | The relay already stores `channel_id` from `h` (`ingest.rs:2851`), gates reads to the reader's accessible channels (`req.rs:1177` `apply_channel_scope_to_query`), and filters fan-out by access (`event.rs` `filter_fanout_by_access`). A bug filed from a private channel or DM stays private with **no new read gating in `req.rs`**. |
| D5.3 | **Optional `h`.** The kind goes in neither `is_global_only_kind` (`ingest.rs:635`) nor `requires_h_channel_scope` (`ingest.rs:733`). | Items with no source channel (filed from a shell) must be allowed. |
| D5.4 | **Multi-writer by fold, not by relay authority.** Anyone who may write the item's channel publishes their own head at `(author, 30623, d)`. Clients fold heads by **`(h, d)`**. The newest `created_at` wins; on a tie the lowest event id wins (NIP-01). | An agent files, Sam closes, and another agent picks it up. Those are three authors, and addressable events are keyed per author. Alternative considered: relay-authored canonical items via a command kind (the NIP-29 9002→39000 pattern). That gives one head per item, but costs a relay handler, a command kind and an authorization model. Rejected for v1: the fold is ~20 lines, and the relay already enforces who may write via channel membership. |
| D5.5 | **`h` is part of the item's identity.** A head with a different `h` is a different item. | This makes `#h` pre-filtering exact and makes "move an item to another channel" impossible by construction. |
| D5.6 | **Fold before filter.** Clients and the CLI never pre-filter at the relay by a *mutable* field (`#p` owner, status, type). They only pre-filter by `kinds`, `#h` and `#d`. | A `#p`-filtered query returns only heads naming that owner. It would miss the newer head that reassigned the item and show stale ownership. |
| D5.7 | Scope **`Scope::MessagesWrite`**. | Same as issues and messages. Agents already hold it. Channel-scoped tokens can write h-scoped items and are refused for global ones (existing rule, `ingest.rs:2866`). |
| D5.8 | `d` = 12-char lowercase Crockford base32 (60 random bits). Display id = the first 5 chars. The CLI accepts any unique prefix of 4 or more chars. | Nostr has no sequence counter, so the canvas's `#88` cannot be produced honestly. **Orchestrator: confirm the short-hash display id.** |
| D5.9 | Project: optional `a` (`30621:<pk>:<d>`) plus an optional `project` display-name tag. | Real projects like "Evals" may have no `30621` event. The label keeps the table readable without a join. |
| D5.10 | No delete in v1. `done` is terminal in the UI, and NIP-09 kind 5 still works per author. | Deleting one author's head just resurfaces another author's head, so deletion is misleading under D5.4. |
| D5.11 | Kind 30623 is not added to `PUSH_KINDS`. | Assignment notification is out of scope. The Work tab surfaces `needs-you` items. |

## Merge order (Phases 5, 6 and 8)

1. **Reservation commit (R), landed on `main` first.** It is tiny and done by
   the Phase 5 coder:
   - `kind.rs`: `KIND_ITEM = 30623` and `KIND_AGENT_TASK_STATUS = 30624`, their
     `ALL_KINDS` entries, and their const asserts.
   - The web kind constants are **not** part of R.
   - It changes no behavior. With no scope arm, both kinds are still refused as
     `unknown event kind`.
2. **Phase 5** and **Phase 8** branch from R and can run in parallel. They
   don't overlap in `ingest.rs`:
   - Phase 5 adds its scope arm after `KIND_PROJECT` (:541) and its validator
     dispatch after the project block (:3217).
   - Phase 8 adds its arm after `KIND_AGENT_TURN_METRIC` (:456) and its dispatch
     after the metric block (:3131).
   - Each puts its validator in its own new file.
   - The only shared line is the `use buzz_core::kind::{…}` import at :15–37.
     Merge Phase 5 first; Phase 8 then rebases a one-line import conflict.
3. **Phase 6** merges after Phase 5 (plan order). It shares `buzz-cli/src/lib.rs`
   `enum Cmd` and `commands/mod.rs` with Phases 5 and 8, which is an additive
   conflict. It touches `req.rs` and `buzz-db` (`#t`), which no other phase
   does.
4. **Base prompt:** each phase adds its own lines with its own command (plan
   §4 rule 2). Separate paragraphs rebase cleanly.

## Wire format — kind 30623

```jsonc
{
  "kind": 30623,
  "content": "<optional markdown body: repro steps, notes; <= 16 KiB>",
  "tags": [
    ["d", "7f3k2m9qa1bc"],                 // required, exactly 1, ^[0-9a-hjkmnp-tv-z]{12}$
    ["h", "<channel uuid>"],               // optional, at most 1, MUST parse as UUID (see risk R1)
    ["type", "bug"],                       // required, exactly 1: bug | backlog
    ["status", "open"],                    // required, exactly 1: open | progress | needs-you | done
    ["title", "Composer drops the draft…"],// required, exactly 1, 1..=200 chars after trim
    ["summary", "The draft is discarded…"],// optional, at most 1, <= 500 chars
    ["created", "1759190400"],             // required, exactly 1, unix secs, <= now+600; copied forward on every edit
    ["p", "<reporter hex>", "", "reporter"], // required, exactly 1; copied forward
    ["p", "<owner hex>", "", "owner"],       // optional, at most 1
    ["e", "<source message id>", "", "source"], // optional, at most 1, 64 lowercase hex
    ["a", "30621:<pk>:<project-d>"],       // optional, at most 1, must start "30621:"
    ["project", "Buzz web"]                // optional, at most 1, <= 80 chars
  ]
}
```

Any other `p` tag, a `p` without a role, or a duplicate of any single-valued tag
is rejected. Unknown extra tags are allowed (forward compatibility). All
rejections use the prefix `invalid: item: <rule>`.

**Fold (the single normative definition, implemented in `buzz-core` and mirrored in web):**
1. Group heads by `(h or "", d)`.
2. The winner is the head with the max `created_at`. On a tie, the lowest `id` wins.
3. `updated_by` = the winner's pubkey, `updated_at` = the winner's `created_at`.
   `created`, `reporter` and `e` come from the winner. Writers copy them forward,
   so they don't change.

**Query for the Items page (~150 items, one request):**
`["REQ", s, {"kinds":[30623], "limit": 1000}]`. That returns every head in the
reader's accessible channels plus the global ones. 1000 is the relay's
advertised `max_limit` (`buzz-db/src/event.rs:25`). With at most 3 editors per
item that covers about 330 items. When a response returns exactly 1000 events,
page back with `until`. The channel view uses `{"kinds":[30623], "#h":[ch]}`.

## File-by-file change map

**`crates/buzz-core`**
- `src/kind.rs`: add `KIND_ITEM: u32 = 30623` with a doc comment after
  `KIND_PROJECT` (:800). Add it to `ALL_KINDS` (:803). Add const asserts beside
  :1080: `is_parameterized_replaceable(KIND_ITEM)`, `<= u16::MAX`. *(Lands in the
  shared reservation commit; see Merge order.)*
- **New** `src/item.rs`: constants (`ITEM_TYPES`, `ITEM_STATUSES`, the length
  bounds), `pub fn validate_item_event(&Event) -> Result<(), ItemRejection>`,
  `pub struct ItemHead` and `pub fn fold_items(&[Event]) -> Vec<ItemHead>`.
  Register it in `src/lib.rs`. This is the one validator. The relay calls it at
  ingest, and the SDK calls it on every event it builds, so the two can't drift.

**`crates/buzz-relay`**
- `src/handlers/ingest.rs`:
  - import `KIND_ITEM` (:15–37).
  - `required_scope_for_kind`: add a new arm `KIND_ITEM => Ok(Scope::MessagesWrite)`
    directly **after** the `KIND_PROJECT` arm (:541). Phase 8 edits a different
    hunk.
  - In `ingest_event_inner`, right after the `KIND_PROJECT` block (:3217–3220),
    add `if kind_u32 == KIND_ITEM { item_ingest::validate(&event)? }`. The
    validator runs **before** membership is used, but after `channel_id` is
    resolved. Nothing else changes: generic h-membership (:2907–2950), the
    archived-channel check (:3077), and addressable persistence
    (`replace_parameterized_event`, :3574, which already takes `channel_id`)
    all apply as-is.
- **New** `src/handlers/item_ingest.rs`: a thin wrapper that maps
  `buzz_core::item::ItemRejection` to `IngestError::Rejected("invalid: item: …")`.
  Keeping it in its own file keeps `ingest.rs` hunks small.
- `src/handlers/req.rs`: **no change** (see D5.2). Covered by the tests below.

**`crates/buzz-sdk`**
- **New** `src/items.rs`, re-exported from `lib.rs` (:15–19). Don't grow the
  4870-line `builders.rs`.
  - `pub struct ItemDraft { d, channel: Option<Uuid>, item_type, status, title, summary, body, created, reporter, owner, source_event, project_coord, project_name }`
  - `pub fn build_item(draft: &ItemDraft, created_at: Timestamp) -> Result<EventBuilder, SdkError>`
    emits tags in the order shown above, then self-checks with
    `buzz_core::item::validate_item_event` on an unsigned template.
  - `pub fn new_item_id() -> String` (Crockford base32, 12 chars).
  - `pub fn next_created_at(prev: Option<Timestamp>) -> Timestamp` =
    `max(now, prev+1)`. Used for read-modify-write, so an edit always
    supersedes the head it read.

**`crates/buzz-cli`**
- `src/lib.rs`: add `Items(ItemsCmd)` to `enum Cmd` (:178) and the
  `ItemsCmd` subcommand enum. Dispatch in `commands/mod.rs`.
- **New** `src/commands/items.rs`. Reuse `fetch_events` (`messages.rs:297`, make
  it `pub(crate)`), `resolve_channel_id` (`messages.rs:120`) and
  `channel_ref::resolve_channel_uuid` (`channel_ref.rs:149`).

### CLI shape

```
buzz items add --type bug|backlog --title <t> [--summary <s>] [--body <md>|-]
               [--from-event <id>] [--channel <uuid|#slug|name>] [--project <slug|name|coord>]
               [--owner <me|hex|npub|name>] [--status open|progress|needs-you]
buzz items list [--status <csv>|all] [--type bug|backlog] [--owner <me|…|none>]
                [--channel <…>] [--project <…>] [--limit N]
buzz items get <id>
buzz items update <id> [--title] [--summary] [--body] [--type] [--status] [--project]
buzz items assign <id> <me|hex|npub|name|none>
buzz items done <id>
```

- `add`:
  - `--from-event` resolves the source event's channel into `h` and sets `e`.
    Passing both `--from-event` and a different `--channel` is exit 1.
  - With neither, the item is global.
  - `reporter` = the signer, `created` = now, `status` defaults to `open`.
  - `--project` resolves against visible `30621` heads by `d` or name. A match
    sets `a` + `project`. Otherwise `project` is set as a label and stderr says
    so.
- Mutating verbs:
  1. Fetch `{"kinds":[30623], "#d":[d]}` (`#d` is pushed for NIP-33-only filters,
     `req.rs:938`).
  2. Fold, apply the patch, and publish your own head. Copy `h`, `created`,
     `reporter` and `e` forward, and use `created_at = next_created_at(winner)`.
  3. A relay stale-replacement rejection is exit **5**.
  4. An id prefix that is unknown or ambiguous is exit 1, and the error lists
     the candidates.
- `assign` refuses an assignee who isn't a member of the item's `h` channel
  (exit 1, "assignee cannot see this item"). This check is client-side. The
  relay has no concept of it.
- `list`:
  1. Fetch `{"kinds":[30623], "limit":1000}`, adding `#h` only for `--channel`.
  2. Fold **then** filter.
  3. The default `--status` is every status except `done`.
  4. Sort newest `updated_at` first.

**JSON output.** `list` prints an array. `get`/`add`/`update`/`assign`/`done`
print one object. The writes add the standard write fields.

```json
{"id":"7f3k2m9qa1bc","short":"7f3k2","type":"bug","status":"progress",
 "title":"…","summary":"…","body":"…","channel_id":"<uuid>|null",
 "source_event_id":"<hex>|null","project":{"coordinate":"30621:…|null","name":"Buzz web|null"},
 "owner":"<hex>|null","reporter":"<hex>","created":1759190400,
 "updated_at":1759194000,"updated_by":"<hex>","event_id":"<hex>",
 "coordinate":"30623:<author hex>:7f3k2m9qa1bc",
 "accepted":true,"message":""}
```

## Base prompt (`crates/buzz-acp/src/base_prompt.md`)

Two changes, landed with the Phase 5 CLI and not before (plan §4 rule 2):

1. Add a row to the CLI table after `buzz issues` (:26):
   `| \`buzz items\` | \`add\`, \`list\`, \`update\`, \`assign\`, \`done\` |`
2. Add this paragraph after the `buzz issues assign` paragraph (:36):

> File bugs and backlog you discover — in any project, repo-backed or not — with `buzz items add --type bug|backlog --title "<one line>" --summary "<one or two sentences a reader can act on>" --from-event <triggering event id>`. Always pass `--summary`; it is the line people read in the Items table. `--from-event` links the item to the message it came from and keeps it visible only to that channel's members. Update your own items as work moves: `buzz items update <id> --status progress`, `buzz items update <id> --status needs-you` when a person must decide, and `buzz items done <id>` when it is verified. Use `buzz issues` only for issues on a Buzz-hosted git repository.

**Phase 2 base-prompt text** (cards and callouts). Phase 2 has no backend doc,
so its text is fixed here. It goes under `### General` (:69) and lands with
Phase 2:

> - When you need a person to choose between options, send a decision card rather than prose: `buzz messages send --channel <uuid> --card @card.json --mention <their pubkey>`. The `--mention` is what puts the card in their Asks inbox; a card without it is only a message. Offer 2–8 concrete options and mark the one you recommend.
> - End any yes/no question with the explicit choices, e.g. "Reply yes or no."
> - Mark verification status with GitHub callouts on their own lines: `> [!NOTE]` for verified facts and tested work, `> [!WARNING]` for anything untested, assumed, or risky. Never put a callout on work you did not verify.

## Test contract

Every test below must be seen to fail under its named mutation. Commit before
mutating (AGENTS.md). For Rust, `touch` the file after restoring it (AGENTS.md
gotcha 9).

| Test (file) | Asserts | Mutation it must catch |
|---|---|---|
| `buzz-core/src/kind.rs::no_duplicate_kind_values` (existing) | 30623 is unique | add a second `30623` constant |
| `buzz-core/src/item.rs::item_kind_is_addressable_30623` | hardcoded `30623`, `is_parameterized_replaceable` | change the constant |
| `item.rs::rejects_non_uuid_h` | `["h","general"]` rejected | drop the UUID check. Mutant: the item goes global; see R1 |
| `item.rs::rejects_second_h` / `rejects_second_status` / `rejects_unroled_p` / `rejects_two_reporters` | each rejected | remove the corresponding cardinality check |
| `item.rs::rejects_unknown_type_and_status` | `type=task`, `status=closed` rejected | widen either enum |
| `item.rs::title_bounds` | 0 chars and 201 chars rejected, 200 accepted (hardcoded literals) | off-by-one on the bound |
| `item.rs::fold_picks_newest_head_across_authors` | A@t1 open, B@t2 done → done, `updated_by=B` | fold keyed by `(author,d)` |
| `item.rs::fold_tie_breaks_on_lowest_id` | same `created_at` → lowest id | flip the comparator |
| `item.rs::fold_separates_same_d_in_different_channels` | two items | fold keyed by `d` only |
| `buzz-relay ingest.rs::item_requires_messages_write_scope` | `Ok(Scope::MessagesWrite)` | delete the arm (→ unknown kind) |
| `ingest.rs::item_is_neither_global_only_nor_h_required` | both predicates false | add it to either list |
| `buzz-sdk items.rs::build_item_roundtrips_through_core_validator` | built event passes `validate_item_event` | drop a required tag in the builder |
| `items.rs::next_created_at_strictly_supersedes` | prev=now+5 → now+6 | return `now` |
| **e2e** `buzz-test-client/tests/e2e_items.rs::item_in_private_channel_hidden_from_non_member` | A (member) publishes an h-scoped item. B (non-member) gets it neither via `{kinds:[30623]}` nor `{ids:[…]}` nor live fan-out | store it with `channel_id=None` |
| e2e `::global_item_visible_to_community_member` | no `h` → B sees it | — (positive control for the above) |
| e2e `::non_member_cannot_write_item_into_private_channel` | `restricted: not a channel member` | skip membership for `KIND_ITEM` |
| e2e `::second_author_head_coexists_and_folds` | A creates, B marks done, both heads are stored, fold = done | — |
| e2e `::malformed_item_rejected_with_prefix` | message starts `invalid: item:` | remove the validator dispatch |
| CLI `commands/items.rs::list_folds_before_filtering_by_owner` (unit, fixture heads) | item reassigned A→B: `--owner A` excludes it | filter before fold |
| CLI `::update_copies_identity_tags_forward` | `h`, `created`, `reporter` and `e` are unchanged on the new head | rebuild tags from args only |
| CLI `::id_prefix_ambiguous_is_usage_error` | exit 1 lists both | take the first match |

**CLI round trip (live, crichton relay, private test channel).** Follow AGENTS.md
"Driving the real web client": run `target/debug/buzz` from the worktree with an
attested key.
1. `items add --type bug --title T --summary S --from-event <msg>`, then
   `items list --channel <ch>`. The item shows `status=open` and
   `channel_id=<ch>`.
2. `items update <short> --status progress`, then `items assign <short> me`,
   then `items done <short>`. `list --status all` shows `done`, `owner=me`, and
   `updated_at` increasing each time.
3. A second attested identity that isn't a member of the channel runs
   `items list` and gets `[]`.

Log it to the worktree's `logs/verification.log`.

## Acceptance

1. The relay accepts a valid 30623, rejects each malformed shape with
   `invalid: item:`, and needs `MessagesWrite`.
2. A non-member can't read an h-scoped item by kind, id or subscription. A
   global item is readable by every member.
3. The CLI round trip above passes live, and the non-member identity sees `[]`.
4. `{"kinds":[30623],"limit":1000}` against a 150-item / 300-head seeded fixture
   returns in one EOSE. The web's 150-item filter budget (<100 ms) is measured
   by the designer.
5. The Rust lanes pass: `cargo test -p buzz-core -p buzz-sdk -p buzz-cli -p buzz-relay`,
   `just test` (relay touched), and clippy + fmt.

## Restarts

- **Relay:** rebuild and redeploy with `./deploy-dev.sh` from the repo root.
  Kind acceptance is compiled in, so the old relay rejects 30623 as `unknown
  event kind`.
- **CLI:** agents only see `buzz items` once the installed `~/.local/bin/buzz`
  is rebuilt (`cargo build --release -p buzz-cli`).
- **ACP:** the base prompt is `include_str!`'d (`buzz-acp/src/lib.rs:2240`), so
  the base-prompt change needs a `buzz-acp` release rebuild and a restart of
  the managed agents.

## Risks

- **R1: a silently global item.** `extract_channel_id` (`ingest.rs:564`) ignores
  an `h` that isn't a UUID, and the event would store as *global*. That makes a
  private-channel bug community-readable. The validator must reject a non-UUID
  `h`, and `rejects_non_uuid_h` pins it.
- **R2: last-write-wins clobber.** Two editors in the same second can clobber
  each other. The read-modify-write with `next_created_at` makes a sequential
  editor win deterministically. True concurrent edits lose one of the two, and
  that is accepted for ~150 items.
- **R3: any channel member can edit any item in that channel.** This is
  intended (team board). The fold records `updated_by`, so the UI can show who
  changed it.
- **R4: frozen items in archived channels.** Items in an archived channel become
  read-only (`ingest.rs:3087`). Show them as-is.
- **R5: head growth.** Done items accumulate. Past ~330 items the 1000 page
  fills, and the web must page with `until`. The designer's query code has to
  handle a full page.

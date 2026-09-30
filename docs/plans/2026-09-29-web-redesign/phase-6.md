# Phase 6 — Shelf and `buzz share`: backend design (CLI, relay query)

Architect design for the backend half of Phase 6 in
[`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md). Line refs are
to `df7363b9a`. Implementation seat: `coder`. The Shelf page, file tabs and
previewers are the designer's; this doc fixes what they read.

## Decisions

| # | Decision | Why |
|---|---|---|
| D6.1 | **No new kind.** A share is an ordinary kind 9 message with an `imeta` per file and a shelf marker. | Chat rendering, threads-as-comments (plan: "Comments on a file are thread replies"), channel visibility, edit and delete all come for free. |
| D6.2 | **The marker is `["t","shelf"]`, not a bare `["shelf"]`.** | NIP-01 filters only match single-letter tags. The Shelf page can't query a `["shelf"]` tag at all. **This departs from the plan's wording. Orchestrator: confirm.** |
| D6.3 | **Push `#t` into SQL before `LIMIT`** (relay change). | Today `#t` is post-filtered after the SQL `LIMIT` (`req.rs:938` doc: "Anything else (multi-#p, #t …) requires post-filtering"). So `{"kinds":[9],"#t":["shelf"],"limit":200}` would scan the newest 200 messages and answer nearly empty. Mirror the existing `#a` JSONB-containment pushdown exactly (`req.rs:1099`, `buzz-db/src/event.rs:81,482,656,911`). |
| D6.4 | **The relay stays the validator.** `buzz share` uploads through the relay's generic path (`PUT /upload`, which dispatches image / video / generic by sniff at `api/media.rs:377–420`). There is no client allowlist. | The relay already denies active content and executables (`validation.rs:87`), stores text/markdown/CSV with no magic bytes as `application/octet-stream` (`validation.rs:229`), and serves every non-image, non-video file as an attachment with `nosniff` and `CSP default-src 'none'` (`api/media.rs:687`). |
| D6.5 | **`filename` goes in `imeta`** (`filename <basename>`). The web parser already reads it (`web/src/features/channels/lib/imetaEntries.ts:73`). | Markdown and HTML without magic bytes arrive as `m application/octet-stream`. The previewer must choose by the filename extension, and `m` stays the truthful stored type. |
| D6.6 | `["path","<host>:<abs path>"]` is added by default. `<host>` = the short hostname (`whoami`, already in `Cargo.lock`). `--no-path` opts out. | "Open in Files" jumps there when `<host>` matches the configured Files host. Paths reveal directory layout to channel members, which is acceptable on this tailnet-only community. The opt-out exists for sensitive paths. |
| D6.7 | `buzz share` takes 1–10 paths and produces one message. `--summary` becomes the message prose. | This mirrors `messages send --file` (multi-file loop at `messages.rs:901–916`). |
| D6.8 | Reuse the whole `messages send` path (the hold gate, mention preflight, session stamp and card-tag ordering) through a new `ShareAttachment` param, the same way `buzz stage` does with `StageAttachment` (`messages.rs:738`). | One send path, not two. |

## Wire format — a share (kind 9)

```jsonc
{ "kind": 9,
  "content": "<summary prose>\n[report.md](https://<relay>/media/<sha>.bin)\n![image](https://<relay>/media/<sha>.png)",
  "tags": [
    ["h", "<channel uuid>"],
    ["imeta", "url …", "m application/octet-stream", "x <sha256>", "size 1234", "filename report.md"],
    ["imeta", "url …", "m image/png", "x …", "size …", "dim 800x600", "blurhash …", "filename chart.png"],
    ["t", "shelf"],
    ["path", "crichton:/Users/sgallant/…/report.md"],   // one per file, same order as imeta; omitted with --no-path
    ["session", "<slot>"]                                // existing managed-session stamp, when present
  ] }
```

Rules:
- The content link for a non-inline file is `\n[<filename>](<url>)`. That's
  byte-compatible with the web's `attachmentMarkdown` (`attachmentMarkdown.ts:53`).
  Images use `![image]` and video uses `![video]`, as today.
- `filename`:
  - the basename only
  - control characters and newlines removed, `]` and `)` escaped in the link
    label
  - at most 255 bytes
- Tag order is `imeta…`, `t`, then `path…`, all before the session stamp. That
  matches the card/stage slot convention (`messages.rs:919–939`).

**Shelf query (web):** `{"kinds":[9],"#t":["shelf"],"limit":200}`, plus
`until` to page, and `#h` for the channel filter. Rows group by day, newest
first. Sender and type filters run client-side from `pubkey` and `imeta`.

## File-by-file change map

**`crates/buzz-cli`**
- `src/client.rs`:
  - `build_imeta_tag` (:47): change it to
    `build_imeta_tag(d: &BlobDescriptor, filename: Option<&str>)`, appending
    `filename …` last. Update both call sites: `messages.rs:909` passes the
    `--file` basename, so `messages send --file` gains `filename` too, and
    `messages.rs:760` (stage) passes `None`. The test at `messages.rs:1516`
    updates with it.
  - Add `pub fn sanitize_share_filename(&Path) -> Result<String, CliError>`.
  - `upload_file` (:1126): split it as
    `upload_file_with(path, UploadMode::{Media, Any})`, with `upload_file`
    becoming `Media`, so existing behavior is unchanged. In `Any` mode:
    - skip the `ALLOWED_MIMES` check (:1145)
    - images still go through `sanitize_image_for_upload` (:1156–1170)
    - the client-side size precheck uses the relay generic cap, 100 MB
      (`buzz-media/src/config.rs:40`), for non-image, non-video files
    - **never** fall back to legacy `/media/upload` (:1234–1249), which rejects
      generic files. A 404/405 on `/upload` is exit 2 with "relay does not
      support generic file uploads".
    - relay 4xx rejections (a blocked type, too large) surface the relay's
      message verbatim, as exit 1
- `src/commands/messages.rs`:
  - add `pub struct ShareAttachment { files: Vec<(BlobDescriptor, String /*filename*/)>, paths: Vec<String> }`
    and `SendMessageParams.share: Option<ShareAttachment>` (:712)
  - in the send path, emit the imeta tags plus link lines for share files, then
    `["t","shelf"]` and the `path` tags, in the slot described above
  - `--file` sends are otherwise unchanged
- **New** `src/commands/share.rs`, `buzz share <path>... --channel <uuid|#slug|name> [--summary <text>|-] [--reply-to <id>] [--mention <pk>]... [--no-path]`:
  1. Reject directories and missing files (exit 1).
  2. Upload each file with `UploadMode::Any`.
  3. Build `ShareAttachment` and call `messages::send_message`.
  4. Output is the send JSON plus `"files":[{"filename","url","mime","size","sha256"}]`.
- `src/lib.rs`: add `Share(ShareArgs)` to `enum Cmd` (:178). Dispatch in
  `commands/mod.rs`.

**`crates/buzz-relay`**, the `#t` pushdown:
- `src/handlers/req.rs`:
  - in `filter_to_query_params` (:1023), next to the `#a` block (:1099), build
    `t_tags` from `filter.generic_tags[t]`
  - in `filter_fully_pushable` (:938), add a `"t" => {}` arm and fix the doc
    comment
- `crates/buzz-db/src/event.rs`:
  - `EventQuery.t_tags: Option<Vec<String>>` (beside `a_tags`, :81), defaulting
    to `None` (:140)
  - an empty-vec short-circuit (beside :538 and :815)
  - `push_tag_containment(…, "t", …)` in both query builders (beside :656 and
    :911)
- Check `count.rs` and `api/bridge.rs` for any hand-built `EventQuery` literal
  that needs the new field. The compiler will list them.

**`crates/buzz-acp/src/base_prompt.md`**, landed with this phase:
1. Replace the table row `| \`buzz upload\` | \`file\` |` (:28) with
   `| \`buzz share\` | \`<path>...\` |` followed by the upload row unchanged.
2. Add this bullet under `### General` (:69):

> - Share deliverables — reports, HTML pages, images, logs, exports — with `buzz share <path> --channel <current-channel-uuid> --summary "<what it is and what to look at>"`, never by pasting a local path or the file's contents. The file lands on the channel's Shelf with a preview; replies to that message are comments on the file.

## Test contract

Commit before mutating, and `touch` after restoring.

| Test | Asserts | Mutation it must catch |
|---|---|---|
| `buzz-cli client.rs::imeta_includes_filename_last` | the tag ends with `filename report.md` (hardcoded) | drop the push |
| `client.rs::imeta_without_filename_is_unchanged` | exact 5-field tag, byte-equal to today's | always push `filename` |
| `client.rs::share_filename_strips_controls_and_dirs` | `../a\nb].md` becomes `a b\].md` (a hardcoded expected value) | skip the sanitizer |
| `client.rs::any_mode_accepts_markdown_media_mode_rejects` | against the wiremock relay (the pattern of `upload_body_loss_is_retried_with_same_file_bytes`, :2310), `.md` bytes reach `PUT /upload` in `Any` mode and give `unsupported file type` in `Media` mode | gate `Any` on `ALLOWED_MIMES` |
| `client.rs::any_mode_never_uses_legacy_endpoint` | a 404 on `/upload` gives an error, and there are zero requests to `/media/upload` | keep the fallback |
| `client.rs::any_mode_still_sanitizes_images` | an EXIF JPEG in `Any` mode is stripped (reuse `upload_sanitizes_exif_jpeg_before_upload`, :2401) | skip sanitize in `Any` |
| `commands/share.rs::share_event_tags_in_order` | tag sequence `h, imeta, imeta, t:shelf, path, path` | put `t` before imeta, or drop it |
| `share.rs::no_path_flag_omits_path_tags` | no `path` tag | ignore the flag |
| `share.rs::content_links_generic_file_by_filename` | the content contains `[report.md](url)` | emit `![image]` for every file |
| `buzz-relay req.rs::t_tag_is_pushed_into_sql_like_a_tag` (mirror :2288) | `q.t_tags == Some(["shelf"])` | not wiring `t_tags` |
| `req.rs::t_filter_is_fully_pushable` | `filter_fully_pushable` is true for `#t` | remove the arm |
| `buzz-db event.rs::t_tag_filter_narrows_the_query_before_the_limit` (mirror :2215) | seed 5 shelf and 300 plain kind-9s; `limit 5` returns all 5 shelf events | push nothing (post-filter) |
| e2e `buzz-test-client/tests/e2e_media_extended.rs::generic_markdown_upload_served_as_attachment` | a `.md` upload gets `Content-Disposition: attachment` and `nosniff` | — (guards D6.4) |
| e2e `e2e_relay.rs::shelf_query_finds_old_share_behind_newer_messages` | a share followed by 250 plain messages: `{"#t":["shelf"],"limit":10}` returns it | the post-filter regression |
| `buzz-acp lib.rs::shared_base_prompt_teaches_buzz_share` | the prompt contains `buzz share <path> --channel` | delete the bullet |

**Live check** (crichton relay, private test channel, `target/debug/buzz`):
1. `buzz share a.md b.html c.png --channel <ch> --summary "test"`. The JSON
   lists 3 files.
2. `curl -sI` each URL. `.md`/`.html` return `attachment`; the `.png` returns
   `inline`.
3. `POST /query {"kinds":[9],"#t":["shelf"],"#h":["<ch>"],"limit":5}` returns
   the share.
4. The web Shelf row renders (designer's half).

Log it to `logs/verification.log`.

## Acceptance

1. `buzz share` uploads `.md`, `.html`, `.png`, `.pdf` and `.csv`. Each `imeta`
   carries `filename`, and the message carries `["t","shelf"]`.
2. `.svg`, `.js` and executables are refused by the relay, and the CLI prints
   the relay's reason with exit 1. There is no client-side allowlist.
3. The Shelf query returns shares older than the newest 1000 channel messages.
   That proves the pushdown.
4. `messages send --file` output is unchanged except for the added `filename`.
5. Rust lanes: `cargo test -p buzz-cli -p buzz-db -p buzz-relay`, `just test`,
   clippy + fmt.

## Restarts

- **Relay:** `./deploy-dev.sh` for the `#t` pushdown. Before it lands, Shelf
  results are silently incomplete.
- **CLI:** rebuild `~/.local/bin/buzz`.
- **ACP:** a release rebuild plus an agent restart for the base-prompt bullet.

## Risks

- **HTML preview.** The relay serves HTML as an inert download, and that stays.
  The web previewer must fetch the bytes and render them via
  `iframe srcdoc` with `sandbox="allow-scripts"` and **no**
  `allow-same-origin` (plan Phase 6). It must never point an iframe at the
  media URL. That test is the designer's, and it is mandatory.
- **Media GET auth.** Generic blobs may need Blossom GET auth (the CLI signs
  one, `client.rs:351`). The web previewer must reuse the existing FileCard
  fetch path rather than a bare `<iframe src>`.
- **`#t` containment cost.** There's no GIN index on tags. The containment runs
  inside the (community, kind, channel) scan, the same cost profile `#a`
  already accepted. If Shelf queries exceed 200 ms at Sam's volume, add a
  partial index on shelf-tagged kind 9 rows in a follow-up migration. Don't
  add one speculatively.
- **Path disclosure** is accepted on a tailnet-only relay. `--no-path` is the
  escape hatch.

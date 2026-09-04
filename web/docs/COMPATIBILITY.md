# Web client compatibility — stock vs modified Buzz components

The web client is designed to run against a **stock Buzz relay** and a
**stock Buzz Desktop** wherever possible. Some features depend on fork
patches. This matrix tracks every feature's dependency tier so operators
know exactly what they must modify — and what they can skip.

**Tiers**

- **Stock** — works with upstream relay + upstream desktop, unmodified.
- **Fork: relay** — needs the relay patch listed (our `crates/buzz-relay` +
  `crates/buzz-core` changes); the web feature degrades or does not work on
  a stock relay.
- **Fork: desktop** — needs the desktop change listed; the feature is inert
  until the owner's desktop is updated.
- **External** — depends on infrastructure outside Buzz entirely.

> Maintaining this doc: every web feature that adds a relay or desktop
> dependency updates this file in the same PR. If a row's dependency is
> removed (patch upstreamed), move it to Stock and note the upstream release.

## Matrix

| Feature | Tier | Notes |
|---|---|---|
| Messaging: timeline, threads, markdown, edit/delete, reactions, typing, unread, drafts | Stock | Core NIP-01/29/42 protocol. |
| Composer: formatting toolbar, @mentions, emoji, `:code:` | Stock | |
| Channels: create/join/leave, rename (9002), delete (9008), private padlock | Stock | |
| DMs: open, groups, local hide | Stock | Hide is client-local by design (desktop parity). |
| Search (⌘K + sidebar field, NIP-50) | Stock | |
| Media: upload, rendering, mosaic, zoomable lightbox, file cards | Stock | Reads NIP-92 `imeta` (`dim`, `m`, `size`, `filename`) off the event; no relay change. |
| Link previews — rendering a received card, and authoring one | **Built; authoring needs a relay endpoint** | Rendering is a pure client render of the sender's `link-preview` snapshot tags. Authoring cannot be done in a browser at all, so it goes through a new relay unfurl route; see below. |
| Huddle voice (start/join, Opus) | Stock | 48100/48102 + WebCodecs. |
| Profile editor (kind 0) | Stock | |
| Agent registry view (30177 list, status dots) | Stock | 30177 is community-readable upstream. |
| Live agent control (switch model, cancel turn) | Stock | Owner→agent 24200 control frames — existing protocol. |
| Web app hosting itself | Stock | `BUZZ_WEB_DIR` static serving is an upstream relay feature. |
| Thinking panel — live telemetry | Stock | Frames arrive as they're sent. |
| Thinking panel — history after reload | **Fork: relay** | Observer-frame retention patch (`af996b981`): stock relays don't retain kind-24200s, so a reload loses prior turns. Without it: live-only. |
| Remote agent admin — create/update/delete/start/stop, harness assignment | **Fork: desktop** | Kinds 24201/24202 listener + applier (see below). Commands sent without an updated desktop honestly time out ("no desktop responded"). |
| Remote agent admin — privacy gate | **Fork: relay** | `AUTHOR_ONLY_KINDS` += 24201/24202 so sealed command traffic doesn't fan out to other members. Without it: commands still work (generic ephemeral path) with weaker privacy. |
| Remote agent admin — machine targeting (`target` on 24201) | **Fork: desktop** | Only the addressed desktop applies a command. Without it, every updated desktop applies every create → duplicate agents on multi-desktop owners. Legacy commands (no `target`) still broadcast. |
| Live harness catalog (create/edit dropdowns) | **Fork: desktop** + **Fork: relay** | Desktops publish kind-30180 catalogs (d = hostname; harness list + locally-runnable agents). Without it: static preset fallback + "apply on" picker hidden; stale cleanup falls back to duplicate-name detection only. |
| Stale-registration cleanup | **Fork: desktop** (relay tier optional) | Bulk `unregister` commands (24201): kind-5 tombstone + NIP-IA archive of the registration only — no process stop, no record removal, no key wipe. Keeper prefers catalog-claimed keys (liveness over recency). 30180 `agents` claims power the "not reported by any desktop" reason; without catalogs, duplicate-name detection still works (newest-`updatedAt` keeper). |
| Agents in the main left bar + edit form | Stock UI | Renders from the 30177 registry (Stock tier); editing rides the remote-admin rows above. |
| Files panel | **External** | Embeds a file-manager web app by URL (`web/src/features/files/webPanels.ts`). Bring your own URL; nothing Buzz-side is required. |
| Notifications: desktop notifications, tab badge, per-device settings | Stock | Live kind:9 REQ scoped by `#h`. A `#p`-only filter gets history and never goes live — `fan_out_scoped` consults the global `(kind, #p)` index only for channel-less events — and scope is resolved per-REQ, so bundling a `#p` filter with an `#h` one un-lives both. Channel ids are chunked at `MAX_EXPLICIT_CHANNEL_VALUES` (128). |
| Home inbox: mentions, DMs, threads, clear | Stock | DMs come from `#h` over the viewer's own DM channels, not `#p` — a DM is an ordinary kind:9 with no `p` tag, since `p` is written only for explicit mentions. Selecting a row deliberately does not mark it read. |
| Pulse: everyone / following / liked / agents / mine, compose, upvote, reply | Stock | kind:1 notes; "Agents" is the feed filtered to the kind:30177 registry with 300s burst grouping. Kind 1 carries no `h` tag, so the global index applies. Search is a client-side filter over the loaded feed — the desktop's magnifier has no handler, so there was nothing to port. |
| Reminders: create, presets, snooze, complete, cancel, due alert, jump | Stock | kind:30300 (NIP-ER), NIP-44 self-encrypted, author-only; `not_before` is materialised into a column the relay's scheduler polls, so reminders sync across clients. Needs the unlocked local key — a NIP-07-only session cannot derive the NIP-44 conversation key, and the panel says so. Writes desktop's target shape for parity and additionally accepts NIP-ER's documented shape on read. |
| Projects and issues: NIP-MP fold, issues, status transitions, comments | Stock | kind:30621 projects, NIP-34 kind:1621 issues, 1630-1633 status. Both NIP-MP enumeration modes; mode 1's composite cursor exists only on the NIP-98 HTTP bridge, so the bridge is preferred and doubt is shown rather than thrown. Issues are enumerated by kind and matched client-side because the relay post-filters `#a` after the SQL LIMIT. PRs/patches, reviews, branches, assignment, the activity feed and repo management are not built (Sam, 2026-09-04). |
| Workflows: list, run history + step trace, manual trigger, approvals | Stock | kind:30620 definitions plus the relay's `/workflows/{id}/runs` and `.../runs/{run}/approvals` NIP-98 reads — both upstream, neither in FORK_MANIFEST.md. Kinds 46001-46012 are declared and never emitted; history lives in a DB table. Approvals are wired but inert until WF-08: the executor's approval gate is a TODO and nothing mints a pending approval. Editing is deliberately read-only (Sam, 2026-09-04); the web has no YAML writer, so `lib/yaml.ts` reads the schema's subset in-tree. |
| Archive: export a channel's history to JSON or Markdown | Stock | An export, not desktop's background mirror — a browser has no silent filesystem, and the card says so. Walks the relay through `until` windows rather than the 500-event timeline cache, which stores parsed rows with no sig, pubkey envelope or raw tags and so could never be re-verified. Ceilings 20,000 events / 400 pages; hitting one still produces a file, keeps the newest history and labels itself truncated. |
| Video chat | **Not built** | Desktop's is not peer video: it is an Anam-hosted AI avatar whose brain is a Buzz agent, and it needs the client to run an inbound HTTP server (`DEFAULT_PORT` 6371) reachable from Anam's cloud through the Tauri Funnel. A browser tab cannot listen on a socket, and the relay has no WebRTC of any kind — its only realtime media transport is Opus audio. Desktop-only by construction, not by effort. |
| Presence: heartbeat, idle-to-away, manual override | Stock | The client published presence once on connect while `buzz-pubsub` expires it after 180s and expects a beat every 60s, so every web user went offline for everyone else three minutes after page load and never came back. Now a heartbeat, ten-minute idle-to-away, a per-pubkey manual override, and an offline publish on `pagehide`. |
| Community members: roster, roles, add/remove, invites | Stock | kind:13534 roster with 9030/9031/9032 mutations. The capability matrix mirrors the relay's `relay_admin.rs` arm by arm because the rules are not symmetric: an admin may remove a plain member but not a fellow admin, only the owner may promote, and the owner row is untouchable on every path. Desktop labels every row `Joined <date>` from the snapshot's `created_at`, which is the date of the last membership change for everyone — not reproduced; the web states the roster's "as of" once. |
| Search: operators, four result kinds, keyboard navigation | Stock | `from:` `in:` `after:` `before:`, actions/channels/people/messages, lexeme-accurate highlighting, recent searches. The panel previously had no keyboard navigation at all — every result was mouse-only. An unresolved operator refuses to search rather than widening into a different question. People come from the community roster, the relay-native stand-in for desktop's Tauri user directory. |
| Web panels: tabbed dock, user-added sites, session restore | Stock | The single hard-coded Files iframe becomes a dock whose tabs stay mounted (`inert` + opacity, never unmounted), so switching preserves scroll, form state and the embedded site's session. Panel URLs are checked against a scheme allowlist, which they previously were not. |
| Profile: NIP-05 verification, follow, nicknames, presence/role rows, recent activity | Stock | NIP-05 handles were rendered unverified, which is an impersonation surface, and are now verified against the domain. Desktop still renders them unverified. Animated-avatar capture, the avatar mask editor, managed-agent/persona management and Nostr identity binding are Tauri surfaces (~8,000 of desktop's 19,967 profile lines) and are not ported. |
| Threads: real nesting, relay descendant counts | Stock | Parent-keyed children, descendant rollups, expand-on-demand, a six-level indent clamp, and the kind:39005 summary overlay. Timeline rows previously showed the buffer-local direct-reply count, so a root with 40 replies could announce "2 replies". Where desktop's `getThreadReference` returns `parentId: null` for a NIP-10-conformant reply carrying only a root marker — hoisting a foreign client's reply onto the main timeline — this resolves it to the root. |
| Chat header: topic, member count, roster, join, expiry, huddle | Stock | `topic`, `purpose` and `ttl_deadline` have always been on the wire and web ignored them. Exactly one detail field renders rather than all three concatenated. Terminal, web panels, video chat and the update indicator are Tauri-only. |
| Huddle: participant roster, mic meter, device picker, push-to-talk | Stock | A browser can fully join — web already speaks the relay's WebSocket Opus protocol through WebCodecs. `HUDDLE_ENDED_KIND` was 48102, which is `KIND_HUDDLE_PARTICIPANT_LEFT`; the end kind is 48103, so a huddle was retired the first time anyone left and one that actually ended never was. A *global* push-to-talk hotkey is impossible: a page cannot observe keystrokes it does not have focus for. In-page hold-to-talk and Space-while-focused are built. |
| Onboarding: NIP-49 backup, restore at the gate, reveal nsec, first-run checklist | Stock | `activeSignerSource()` is filled asynchronously from IndexedDB and two components sampled it once at mount, so on any load with a stored key the backup card claimed the user was on an extension and the checklist dropped its one critical item — for exactly the users who needed it. Key generation into the OS keychain, phone recovery via the pair-relay sidecar, ACP runtime discovery, and the keyring-locked/relaunch screens are native states with no browser equivalent. |
| Settings: experiments, shortcuts, invites, templates, backup, archive | Stock | Voice (9 Tauri calls plus local STT models), mesh compute, hosted communities, mobile pairing and the desktop updater have no browser equivalent. The relay exposes no invite *list* endpoint — only mint and claim — so the Invites card can show a code it just minted but cannot enumerate existing ones. |
| Channel templates | Stock | CRUD, duplicate, roster authoring from live 30175/30176, apply, agent provisioning via 24201 + kind:9000, and JSON export/import byte-compatible with desktop's `channel-templates.json`. This is the only way to create a forum from the browser: `NewChannelDialog` never sends `channel_type`. Desktop ships no built-in templates despite having the flag, so neither does this. `canvasTemplate` is stored and exported but never applied — web has no canvas surface, and the card says so. |
| Identity archive | Stock | 9035/9036 requests, relay-signed 13535 snapshot with fail-open on every error path, NIP-OA owner gate with real BIP-340 verification, self-exempt predicate. |
| Appearance: colour mode, accent, font size, density, link-preview style, thread layout | Stock | Two controls needed no new plumbing — `mode`/`setMode` and `setAccent` already existed in ThemeProvider and nothing rendered them. Font size stays tokenized as a type-scale ratio in `globals.css`, so the 13/14/15px contract still follows Cmd +/- zoom rather than freezing against it. Desktop's glass background is a native `NSVisualEffectView`: a page cannot blur what is behind the browser. |
| Custom emoji: add, rename, remove | Stock | Read-modify-write on the caller's own kind:30030, uploading through the same Blossom path the composer already uses. Rename is not on the wire — it is the same republish with one shortcode changed. `CustomEmojiImage` used a plain `<img src>`, but `GET /media/{sha}` runs `authenticate_media_read` and an `<img>` cannot sign, so every relay-hosted emoji rendered broken; relay URLs now route through `fetchSignedMedia`. |
| Image paste and attachments | Stock | Already present before this wave and verified end to end against the live relay: a pasted PNG uploads with real progress, lands in the attachment tray, and renders in the timeline. A malformed upload surfaces the relay's 422 in the row rather than swallowing it. |

## Link previews — how authoring works (measured 2026-09-03, built 2026-09-04)

Buzz link previews are **not** a recipient-side unfurl. The desktop resolves
metadata once, **at send time**, and ships the result inside the event as
sender-authored tags; recipients render those tags and never contact the
external site. That split decides what the web client can and cannot do, and
the two halves land in different tiers.

**Receiving is stock and needs nothing from the relay.** The relay already
accepts and validates the tags — `validate_link_preview_tags` in
`crates/buzz-relay/src/handlers/ingest.rs` — so they arrive on the event like
any other tag. The shape is an 11-element tag:

```
["link-preview", "snapshot", "1", <canonical https URL>, <title>, <site>,
 <description>, <image URL>, <image sha256>, <favicon URL>, <favicon sha256>]
```

with `["link-preview", "none"]` as the per-message suppression marker (the
relay rejects a message that carries both). The canonical URL must appear in
the message body, and both media pairs must point at image blobs in this
relay's own store. Rendering these is pure presentation: no fetch, no CORS,
no relay endpoint. What is missing on the web side is only plumbing — the
timeline's `TimelineMessage` (`features/channels/lib/messageBuffer.ts`) keeps
`imetaByUrl` and drops the rest of the event's tags, so the tags never reach
`MarkdownContent`.

**Authoring one in a browser needs the relay, and now has it.** Producing a
snapshot means fetching an arbitrary third-party page, parsing its OpenGraph
tags, then fetching its preview image and favicon and putting both in this
relay's media store. The desktop does all of that in native Rust —
`fetch_link_preview_metadata`, registered in `desktop/src-tauri/src/lib.rs` —
where the same-origin policy does not apply. A browser cannot: a cross-origin
`fetch` of a page that sends no `Access-Control-Allow-Origin` is unreadable,
and an opaque `no-cors` response cannot be parsed or re-uploaded.

So the web client gained a relay endpoint instead:
`POST /link-preview/unfurl` (`crates/buzz-relay/src/api/link_preview.rs`),
NIP-98 + membership like the other bridge routes. It resolves the page behind
an SSRF fence (https only, resolved addresses checked against
`is_private_ip`, addresses pinned into the client so a rebind cannot slip
past, every redirect hop re-gated, bounded size/time/redirects/concurrency),
re-encodes the image and favicon, stores them as this relay's own blobs, and
returns the fields a snapshot tag needs. `204` means the page had nothing
worth showing. A relay that can do this advertises `link_preview: { unfurl }`
and the `buzz-link-preview` extension in NIP-11, so a client talking to an
older or upstream relay simply does not offer the feature.

The web half lives in `features/channels/lib/`:
`linkPreviewCandidates.ts` (which links get offered), `relayLinkPreview.ts` +
`linkPreviewCapability.ts` (transport and capability), `linkPreviewSnapshot.ts`
(building the 11-part tag, and re-checking every rule ingest applies — a bad
tag rejects the whole message, not just the tag), and
`useComposerLinkPreviews.ts` (debounce, cache, suppression). The composer shows
what it is about to attach, with a "Preview off" control that emits
`["link-preview","none"]`. Sending is never held up waiting for a third-party
site: an unresolved link just sends as a plain link.

One reader-side defect fell out of building it. `LinkPreviewCards` rendered
snapshot assets with a plain `<img src>`, but those assets are relay blobs and
`GET /media/{sha256}` runs `authenticate_media_read` — an `<img>` cannot sign a
NIP-98 header, so every relay-hosted preview image rendered broken. Exactly the
custom-emoji bug, and fixed the same way: through `fetchSignedMedia`.

## Fork changes, per feature

### Thinking-panel history (relay)

- **What**: retain kind-24200 observer frames (ephemeral-window → retained
  with capped per-agent history).
- **Where**: `crates/buzz-relay` retention path, commit `af996b981`.
- **Upstream intent**: candidate for an upstream PR (config-gated retention).

### Remote agent admin (desktop)

- **What**: a TypeScript-layer listener in Buzz Desktop that subscribes to
  kind-24201 (owner-signed, NIP-44-sealed agent-admin commands), verifies the
  signer is the owner's own key, applies create/update/delete/start/stop
  through the desktop's existing save paths (`createManagedAgent` & friends),
  and publishes a kind-24202 ack.
- **Where**: `desktop/src/features/agents/` (branch `claude/owner-admin-channel`).
- **Wire contract**: `web/src/features/agents/lib/adminCommands.ts` is the
  authoritative shape (create/update/delete/start/stop envelopes). The kinds
  are ephemeral (20000-band), so no relay storage behavior is assumed.
- **Security model**: the owner key is the admin credential — same trust
  domain as every other owner-signed write. Sealed payloads keep prompts/env
  off the wire in the clear.
- **Upstream intent**: candidate for upstream as an optional "remote admin"
  capability (opt-in setting).

### Admin-command privacy gate (relay)

- **What**: `crates/buzz-core/src/kind.rs` — add `KIND_OWNER_ADMIN_COMMAND`
  (24201) and `KIND_OWNER_ADMIN_ACK` (24202) to `AUTHOR_ONLY_KINDS`.
- **Why**: generic ephemeral fan-out would expose command timing/size to any
  community member with an open subscription; contents are sealed, but the
  gate removes the metadata too.

### Desktop catalog (kind 30180)

- **What**: each Buzz Desktop publishes a parameterized-replaceable
  kind-30180 event (d tag = hostname) describing its harness catalog
  (`{id, label, source: builtin|preset|custom, availability}` per entry —
  never commands, args, env, or paths) and the agent pubkeys it can run
  locally. The web uses it for the create/edit harness dropdowns, the
  "apply on" machine picker, and stale-registration detection.
- **Where**: `crates/buzz-core/src/kind.rs` (`KIND_DESKTOP_CATALOG`),
  relay ingest scope (UsersWrite), desktop publisher
  `desktop/src/features/agents/useDesktopCatalogPublisher.ts`, web consumer
  `web/src/features/agents/lib/desktopCatalog.ts`.
- **Wire contract**: content shape pinned in
  `web/src/features/agents/lib/desktopCatalog.ts` + tests; the 24201
  envelope's optional `target` field (hostname) selects the applying
  desktop (`ownerAdminProtocol.ts` on the desktop side).
- **Upstream intent**: candidate for upstream as an opt-in "fleet catalog"
  alongside the remote-admin capability.

## Deployment notes for self-hosters

1. Stock relay + stock desktop: everything in the **Stock** tier works as-is.
   Deploy the web bundle with `BUZZ_WEB_DIR`.
2. Fork relay: build the relay from this repository (the patches above are
   on `main`), or cherry-pick the listed commits onto upstream.
3. Fork desktop: build Buzz Desktop from this repository (or cherry-pick the
   admin-listener commits) and install it on the machine that runs your
   agents. The web side needs nothing further.

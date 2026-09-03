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
| Link previews — rendering a received card | **Stock, not built** | Purely a client render of the sender's `link-preview` snapshot tags. No relay change needed; see below. |
| Link previews — authoring one when sending | **Blocked in a browser** | Needs a server-side unfurl the relay does not expose. See below. |
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
| Stale-registration cleanup | **Fork: desktop** (relay tier optional) | Bulk forceRemoteDelete over existing 24201 delete commands. 30180 `agents` claims power the "not reported by any desktop" reason; without catalogs, older-duplicate detection still works. |
| Agents in the main left bar + edit form | Stock UI | Renders from the 30177 registry (Stock tier); editing rides the remote-admin rows above. |
| Files panel | **External** | Embeds a file-manager web app by URL (`web/src/features/files/webPanels.ts`). Bring your own URL; nothing Buzz-side is required. |

## Link previews — feasibility, measured 2026-09-03

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

**Authoring one in a browser is blocked, and not by anything we can patch in
the web client.** Producing a snapshot means fetching an arbitrary
third-party page, parsing its OpenGraph tags, then fetching its preview image
and favicon and uploading both to Blossom. The desktop does all of that in
native Rust — `fetch_link_preview_metadata`, registered in
`desktop/src-tauri/src/lib.rs` and called from
`desktop/src/shared/lib/useResolvedLinkPreviews.ts` — where the same-origin
policy does not apply. A browser cannot: a cross-origin `fetch` of a page that
sends no `Access-Control-Allow-Origin` is unreadable, and an opaque `no-cors`
response cannot be parsed or re-uploaded. The relay exposes no unfurl route
either (`crates/buzz-relay/src/router.rs` lists the whole HTTP surface:
NIP-11/NIP-05, `/events`, `/query`, `/count`, GIF search, invites,
moderation, webhooks, Blossom media, git, health — nothing that fetches a
remote URL on a client's behalf).

So a web client can only ever author previews with **a new relay endpoint**
(server-side unfurl returning OG metadata, ideally uploading the images to
Blossom in the same call), or a general CORS proxy. Both are relay changes,
and a relay change is a product decision, not a client one. Until that
decision is taken, the honest behaviour on the web is what ships today: links
render as links, and messages sent from the web simply carry no snapshot
tags — which the desktop already handles, since a message without them shows
a plain link there too.

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

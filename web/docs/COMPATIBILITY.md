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
| Media: upload, rendering, lightbox | Stock | |
| Huddle voice (start/join, Opus) | Stock | 48100/48102 + WebCodecs. |
| Profile editor (kind 0) | Stock | |
| Agent registry view (30177 list, status dots) | Stock | 30177 is community-readable upstream. |
| Live agent control (switch model, cancel turn) | Stock | Owner→agent 24200 control frames — existing protocol. |
| Web app hosting itself | Stock | `BUZZ_WEB_DIR` static serving is an upstream relay feature. |
| Thinking panel — live telemetry | Stock | Frames arrive as they're sent. |
| Thinking panel — history after reload | **Fork: relay** | Observer-frame retention patch (`af996b981`): stock relays don't retain kind-24200s, so a reload loses prior turns. Without it: live-only. |
| Remote agent admin — create/update/delete/start/stop, harness assignment | **Fork: desktop** | Kinds 24201/24202 listener + applier (see below). Commands sent without an updated desktop honestly time out ("no desktop responded"). |
| Remote agent admin — privacy gate | **Fork: relay** | `AUTHOR_ONLY_KINDS` += 24201/24202 so sealed command traffic doesn't fan out to other members. Without it: commands still work (generic ephemeral path) with weaker privacy. |
| Files panel | **External** | Embeds a file-manager web app by URL (`web/src/features/files/webPanels.ts`). Bring your own URL; nothing Buzz-side is required. |

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

## Deployment notes for self-hosters

1. Stock relay + stock desktop: everything in the **Stock** tier works as-is.
   Deploy the web bundle with `BUZZ_WEB_DIR`.
2. Fork relay: build the relay from this repository (the patches above are
   on `main`), or cherry-pick the listed commits onto upstream.
3. Fork desktop: build Buzz Desktop from this repository (or cherry-pick the
   admin-listener commits) and install it on the machine that runs your
   agents. The web side needs nothing further.

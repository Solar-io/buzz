# Fork Manifest

This repo is a fork of [block/buzz](https://github.com/block/buzz) carrying a small
patch series on top of upstream `main`. This file is the single source of truth for
what we carry, why, and how to rebuild after an upstream release. **Update it whenever
the series changes.**

The installed `/Applications/Buzz.app` and the local relay (`com.dev.buzz-relay`) are
always built from this checkout — an official update installed over the app bundle
would silently wipe everything listed here.

## Carried patches on `main`

Referenced by subject, not SHA — SHAs change on every rebase.

| Series | Commits | What | Why | Upstream plan |
|---|---|---|---|---|
| Video chat | 5 commits, `video_chat module scaffold` → `style(desktop): biome format VideoChatPanel` | Tauri Rust module (`desktop/src-tauri/src/video_chat/`: SSE, speech sanitizer, turn relay) + React panel (`desktop/src/features/videoChat/`), wired to the evie-anam-adapter on :6370 | Anam video-chat in agent DMs | Carried — niche to our Anam stack |
| Shared instructions | 1 commit, `feat(agents): shared instructions global layer for all agent prompts` | Global instruction layer injected into every agent prompt; touches `crates/buzz-acp/*` + `desktop/src-tauri/src/managed_agents/*` + agents UI | All agents share a base instruction layer | Carried — product-specific behavior |

Dropped 2026-08-24: one auto-commit noise commit and a stray `logs/verification.log`
(squashed out during the cleanup rebase; `logs/` is now gitignored).

## Unmerged branches

- `claude/cli-upload-sanitizer` — `fix(cli): sanitize image uploads to the relay's
  metadata-free contract`. Genuine CLI fix, **upstream-able as-is**; PR it when ready.
- `claude/agent-a558d15607582d17e` — stale session auto-commit branch (pre-cleanup
  history). Safe to delete.

## Build tags

Every build we install gets an annotated tag: `nest-<upstream-version>-<yyyymmdd>`.
Current installed build: **`nest-0.5.18-20260824`** (upstream 0.5.18 base, commit
series as of 2026-08-24, upstream main `0720f5380`).

## Remotes

- `origin` → `https://github.com/block/buzz.git` — upstream, read-only
- `nest` → `https://github.com/Solar-io/buzz.git` — our fork. **Push `main` + tags
  here after every series change.** Off-machine backup + the base for upstream PRs.

## Rebuild procedure (after an upstream release)

1. `git fetch origin`
2. `git rebase origin/main` — known conflict hot spots:
   `pnpm-lock.yaml`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/Cargo.toml`,
   `desktop/package.json`
3. Build: `cd desktop && pnpm tauri:build` (frontend `tsc && vite build` runs inside it)
4. Install the built `.app` over `/Applications/Buzz.app`
5. If relay/backend binaries changed: restart `com.dev.buzz-relay`
6. Tag `nest-<version>-<yyyymmdd>`, update this manifest, commit, push `main` + tag
   to the `nest` remote
7. Verify the nest stays quiet: buzz-services watchdogs/alerts monitor the relay and
   CLI contract surfaces continuously — a rebuild that breaks the contract surfaces
   alerts within minutes. Spot-check `buzz messages get` from a session.

## Downstream contract surfaces (consumed by buzz-services)

buzz-services (separate repo) integrates only through: relay events (Nostr kinds),
the `buzz` CLI, agent keys, MCP protocol. It carries no patches against this repo.
Any change here to CLI flags, event kinds, or env vars is a contract change for it.

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
| Video chat | 6 commits, `video_chat module scaffold` → `fix(desktop): show the video-chat trigger in the inline DM header` | Tauri Rust module (`desktop/src-tauri/src/video_chat/`: SSE, speech sanitizer, turn relay on loopback :6371) + React panel (`desktop/src/features/videoChat/`); Tailscale Funnel 443 → app :6371 (standalone adapter retired 2026-08-24) | Anam video-chat in agent DMs | Carried — niche to our Anam stack |
| Shared instructions | 1 commit, `feat(agents): shared instructions global layer for all agent prompts` | Global instruction layer injected into every agent prompt; touches `crates/buzz-acp/*` + `desktop/src-tauri/src/managed_agents/*` + agents UI | All agents share a base instruction layer | Carried — product-specific behavior |

Dropped 2026-08-24: one auto-commit noise commit and a stray `logs/verification.log`
(squashed out during the cleanup rebase; `logs/` is now gitignored).

## Unmerged branches

- `claude/cli-upload-sanitizer` — `fix(cli): sanitize image uploads to the relay's
  metadata-free contract`. **Superseded by upstream PR
  [block/buzz#5690](https://github.com/block/buzz/pull/5690)** (avi-xyz, opened 2026-08-12,
  OPEN, awaiting review): same bug, better architecture — new shared `buzz-image`
  leaf crate uniting sanitizer and validator instead of our CLI-local port. Do not
  PR ours; verify theirs (see WORK_LOGS 2026-08-24) and retire this branch once
  #5690 lands.
- `claude/agent-a558d15607582d17e` — stale session auto-commit branch (pre-cleanup
  history). Safe to delete.

## Build tags

Every build we install gets an annotated tag: `nest-<upstream-version>-<yyyymmdd>`
(suffixed `-2`, `-3`… for additional same-day builds).
Current installed build: **`nest-0.5.18-20260824-2`** (upstream 0.5.18, series on
upstream `17af15eff`, incl. the inline DM-header video-chat trigger fix). Installed
on crichton and aeryn; `buzz-desktop` sha256 `c569fafa…54cb12` on both. The tag
always marks what the installed app contains; `main` is the series head.

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

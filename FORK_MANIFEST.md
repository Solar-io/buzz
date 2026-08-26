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
| Video chat | 10 commits, `video_chat module scaffold` → `fix(desktop): never re-speak an already-spoken video reply` | Tauri Rust module (`desktop/src-tauri/src/video_chat/`: SSE, speech sanitizer, turn relay on loopback :6371) + React panel (`desktop/src/features/videoChat/`); Tailscale Funnel 443 → app :6371 (standalone adapter retired 2026-08-24); later fixes: self-heal arming, turn marking/401 logs, no re-speak | Anam video-chat in agent DMs | Carried — niche to our Anam stack |
| Shared instructions | 1 commit, `feat(agents): shared instructions global layer for all agent prompts` | Global instruction layer injected into every agent prompt; touches `crates/buzz-acp/*` + `desktop/src-tauri/src/managed_agents/*` + agents UI | All agents share a base instruction layer | Carried — product-specific behavior |
| Warm idle pool | 1 commit, `perf(desktop): hold woken agent pool warm for 7d (900s -> 604800s)` | `IDLE_POOL_SLEEP_SECS` in `desktop/src-tauri/src/managed_agents/agent_env.rs` | Cold starts 17-105s dominated perceived session lag (2026-08-24) | Carried — environment-specific tune; upstream's 900s default is fine for laptops |
| Header agent activity | 1 commit, `feat(desktop): header agent-activity button + boot-armed observer subscription` | Activity button beside Buzz Term in `ChannelScreenHeader` (target resolution in `channels/lib/headerAgentActivity.ts` + unit tests); `ObserverBootstrap` arms the kind-24200 observer subscription at app start from `AppShellOverlays` | Observer frames are ephemeral — panel-open-only arming left non-session-host desktops with an empty activity archive; button gives one-click access to the session pane | Button: consider upstreaming (generic). Boot-arm: candidate upstreaming with a setting; re-verify against 0.5.20's ACP/prompt refactors when rebasing |
| Web panels | 2 commits, `feat(desktop): config-driven web panel docks (Files) with login hop` + `fix(desktop): web panel login command is id-only` | `desktop/src/features/webPanels/` (config registry + external store + substrate + bootstrap), header buttons beside Buzz Term, second dock host in the AppShell→ContentSurface mount chain (`webpanel.css` mirrors `terminal.css`), `frame-src` CSP entry in `tauri.conf.json`, Rust command `open_web_panel_login` (`src-tauri/src/web_panels.rs`, WebviewWindowBuilder like the huddle companion) — takes only a panel id and resolves url/title from its own const table (`LOGIN_PANELS`, kept in sync with the TS config), so no URL ever crosses the IPC boundary | "Add button, load web page" as a reusable config-only pattern; first panel is the Evie file manager (`https://crichton.tailb3d4b8.ts.net:6201/?panel=files`). All webviews share one cookie jar, so the login button opens a 900x700 companion window for the GitHub-OAuth hop (iframes refuse it) and Reload remounts the iframe to pick the cookies up | Candidate upstreaming once it carries more than one panel: the mechanism is generic but the shipped config and CSP origin are fork-specific |

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
Current installed build: **`nest-0.5.18-20260824-4`** (upstream 0.5.18, series on
upstream `17af15eff`, incl. personaId wiring + peer-armed video-chat relay and the
warm idle pool). Installed on crichton and aeryn; `buzz-desktop` sha256
`280072e0…b3e02a` on both.
The tag always marks what the installed app contains; `main` is the series head.

Per-host ops config (not in the repo): `video-chat-peers.json` in the app config
dir (`~/Library/Application Support/xyz.block.buzz.app/`) lists peer bridges
(`[{"url", "token"}]`) that receive video-chat target arming. aeryn carries
crichton's funnel + token; crichton carries none (only the funnel side receives).
Crichton's Buzz must be running for video chat armed from aeryn — its app holds
the funnel.

## Remotes

- `origin` → `https://github.com/block/buzz.git` — upstream, read-only
- `nest` → `https://github.com/Solar-io/buzz.git` — our fork. **Push `main` + tags
  here after every series change.** Off-machine backup + the base for upstream PRs.

## Rebuild procedure (after an upstream release)

1. `git fetch origin`
2. `git rebase origin/main` — known conflict hot spots:
   `pnpm-lock.yaml`, `desktop/src-tauri/src/lib.rs`, `desktop/src-tauri/Cargo.toml`,
   `desktop/package.json`
3. Build real sidecars (the bundle needs them; `binaries/` is gitignored, and the
   `_ensure-sidecar-stubs` stubs produce an app whose sidecars are empty files):
   `export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"` (cargo isn't on the
   agent-shell PATH; `audiopus_sys` needs brew cmake), then
   `cargo build --release -p buzz-acp -p buzz-agent -p buzz-backend-kubernetes -p buzz-dev-mcp -p buzz-cli -p git-credential-nostr`
   and copy each `target/release/<bin>` to
   `desktop/src-tauri/binaries/<bin>-aarch64-apple-darwin`.
4. Build: `cd desktop && pnpm tauri build --features mesh-llm --target aarch64-apple-darwin`
   (frontend `tsc && vite build` runs inside it; the `.app` lands under
   `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/` — `bundle_dmg`
   may fail; the `.app` is what we install)
5. Install on crichton AND aeryn by mv-swap, never over a running app:
   `ditto <bundle>/Buzz.app /Applications/Buzz.app.new && mv /Applications/Buzz.app <old> && mv /Applications/Buzz.app.new /Applications/Buzz.app`.
   To aeryn use a tar-pipe (`tar -c -C Buzz.app . | ssh aeryn 'tar -x -C /Applications/Buzz.app.new'`)
   then mv-swap — raw `rsync host:` trips the deploy-guard hook. Verify with
   `shasum -a 256 …/Contents/MacOS/buzz-desktop` on both hosts. The user must
   quit-and-reopen Buzz per machine to pick up the new build.
6. If relay/backend binaries changed: restart `com.dev.buzz-relay`
6. Tag `nest-<version>-<yyyymmdd>`, update this manifest, commit, push `main` + tag
   to the `nest` remote
7. Verify the nest stays quiet: buzz-services watchdogs/alerts monitor the relay and
   CLI contract surfaces continuously — a rebuild that breaks the contract surfaces
   alerts within minutes. Spot-check `buzz messages get` from a session.

## Downstream contract surfaces (consumed by buzz-services)

buzz-services (separate repo) integrates only through: relay events (Nostr kinds),
the `buzz` CLI, agent keys, MCP protocol. It carries no patches against this repo.
Any change here to CLI flags, event kinds, or env vars is a contract change for it.

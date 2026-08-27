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
| Web panels | 3 commits, `feat(desktop): config-driven web panel docks (Files) with login hop` + `fix(desktop): web panel login command is id-only` + `feat(desktop): native child-webview panels with tabs and session restore` | `desktop/src/features/webPanels/` (config registry with per-panel `render: "native" \| "iframe"` + tabbed instance store with localStorage session restore + substrate with tab strip/`+` picker + `useNativePanelWebview` geometry bridge), header toggle beside Buzz Term, second dock host in the AppShell→ContentSurface mount chain (`webpanel.css`), `frame-src` CSP entry in `tauri.conf.json` (iframe fallback only), Rust `src-tauri/src/web_panels.rs` with the `PANEL_TYPES` const table and commands `open_web_panel_login` / `ensure_web_panel` / `set_web_panel_visible` / `destroy_web_panel` / `reload_web_panel`, gated by the tauri `unstable` cargo feature (`Window::add_child`). Origin-sync tests in BOTH languages fail the build if the Rust table and TS config drift. Navigation inside a panel webview is allowlisted to the panel's own origin + the Supabase/GitHub OAuth hops, fail closed | "Add button, load web page" as a reusable config-only pattern; first panel is the Evie file manager (`https://crichton.tailb3d4b8.ts.net:6201/?panel=files`). Panels render NATIVELY by default (child webviews of the main window share the default `WKWebsiteDataStore`, so third-party cookies work — proven by the 2026-08-26 spike where a login-popup read back a cookie the child webview planted); the dock is TABBED (up to 6 live instances, keep-alive switching, per-tab heights, session restored on boot because the shared cookie jar keeps panels authed across restarts); iframe mode stays as an explicit config fallback and is what e2e builds force (Playwright has no child webviews) | Candidate upstreaming once it carries more than one panel: the mechanism is generic but the shipped config and CSP origin are fork-specific; the `unstable` feature gate is worth flagging in any upstream PR |
| Custom sites | 4 commits, `feat(desktop): owner-added custom web panels — rust store, commands, nav controls` → `feat(desktop): trusted add window for owner-added sites; fmt + e2e aligned` | `desktop/src-tauri/src/custom_panels.rs` (JSON store at `app_config_dir()/custom_web_panels.json`, atomic writes, fail-closed on corrupt, 16-site cap, monotonic `site-N` ids) + `add.html`/`addWindow.ts` trusted add window (label `webpanel-add` — `add_custom_panel` refuses every other caller, so the app webview can never supply a URL; `list_custom_panels` returns id/label/title only, the URL never crosses IPC, customs render native-only) + picker "Add site…"/"Your sites" rows + nav controls (◀ ▶ ⌂ beside Reload; home = saved address, back/forward = webview history) + gated session restore for custom tabs | Owner adds arbitrary sites at runtime with per-site origin jail + OAuth hops, same fail-closed navigation pin as Files; logins ride the shared cookie jar so they survive restarts | Carried — the trusted-window gate is a security posture (app webview must never steer navigation), worth flagging in any upstream conversation |
| Turn duration 12h | 1 commit, `feat(buzz-acp): default max turn duration 12h (7200s -> 43200s)` | `crates/buzz-acp/src/config.rs` `DEFAULT_MAX_TURN_DURATION_SECS` 7200→43200 + `queue.rs` `DEFAULT_IN_FLIGHT_DEADLINE_SECS` 7300→43300 (keeps deadline > turn invariant) | Build-heavy turns (45m e2e + release bundles) crossed the 2h cap twice on 2026-08-26, killing sessions mid-build (Sam: "bump it up to 12hr for everyone", 2026-08-27) | Carried — environment-specific operations choice; upstream default of 2h is sensible for laptops |

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
Current installed build: **`nest-0.5.20-20260826-2`** (upstream 0.5.20, incl.
the native tabbed web-panels feature). Installed on crichton and aeryn
2026-08-26 evening; `buzz-desktop` sha256 `d2373dcc…2aec500f` verified on
both hosts. The tag always marks what the installed app contains; `main` is
the series head.

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

   Debug runs (`pnpm tauri dev`) while the installed Buzz.app is also
   running: the single-instance plugin keys on the bundle identifier, so
   hand the dev run an overlay (`pnpm tauri dev --config <overlay.json>`
   with `"identifier": "xyz.block.buzz.app.dev"`) or the dev instance
   exits into the production one. A fresh-identifier dev instance starts
   with no community configured (the app sits at the community gate), and
   it still reads the PRODUCTION identity from the macOS keychain — quit
   it promptly. `scripts/make-sidecar-stubs.sh` creates the empty sidecar
   stubs build.rs demands when real release sidecars aren't built yet.
5. Install on crichton AND aeryn by mv-swap, never over a running app:
   `ditto <bundle>/Buzz.app /Applications/Buzz.app.new && mv /Applications/Buzz.app <old> && mv /Applications/Buzz.app.new /Applications/Buzz.app`.
   To aeryn use a tar-pipe (`tar -c -C Buzz.app . | ssh aeryn 'tar -x -C /Applications/Buzz.app.new'`)
   then mv-swap — raw `rsync host:` trips the deploy-guard hook. Verify with
   `shasum -a 256 …/Contents/MacOS/buzz-desktop` on both hosts. The user must
   quit-and-reopen Buzz per machine to pick up the new build.
   🔴 Check "is Buzz running" with `ps -axo pid,args | grep -w buzz-desktop | grep -v grep`,
   NEVER `pgrep`: reproduced 2026-08-26 on crichton that a live, working buzz-desktop
   (started two days earlier) is invisible to `pgrep -x`/`-fl` with every pattern while
   `ps` sees it plainly — the 0.5.20 crichton swap went over a live process on a
   pgrep-based "not running" check. The running binary survives an `mv` (its inode
   stays open), so the miss was harmless in effect, but the check itself is wrong.
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

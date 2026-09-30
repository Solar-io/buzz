# Phase 7 design: terminal + host stats service, and the Buzz Terminal page

Architect seat, 2026-09-30. Parent plan: [`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md)
§ Phase 7. Artboards: **Terminal**, **PhoneTerminal**, **Vitals** (crichton rows).
Sources read: evie-ui @ `c6b45c08` (`app/term/*`, `app/web/term-hub.ts`,
`app/web/routes/host-stats.ts`, `app/public/js/term-*.js`, ADR-018/019/022/026/027/081/101 and the
xterm-pinning ADR near line 4427); stash @ `fb71db6` (auth, deploy, launchd); the Files extraction
design `~/.buzz/PLANS/FILES_STANDALONE_APP_DESIGN_2026-09-23.md`; `infra/port-registry.json`;
herdr 0.7.4 on crichton (`herdr api schema`, `herdr session list --json`).

**Working name: `hatch`.** It is a placeholder until Sam picks (§1). Every identifier below derives
from it (`com.dev.hatch`, `hatch_session`, `HATCH_*`, `VITE_HATCH_URL`), so a rename is mechanical.

**Routing.** Service milestones S0–S3 → `coder`. Web milestones W1–W3 → `designer`. Tester runs
with `cwd` = the implementer's worktree. The security review (§9) is a hard gate before prod.

---

## 0. Summary

A new Bun service on crichton, extracted from evie-ui the way stash was. It serves three things and
nothing else: the `/ws/term` PTY socket (evie's terminal backend, copied verbatim), a read-only
projection of herdr's workspaces/tabs/agents, and host vitals (CPU, GPU, memory, every local disk).
It runs co-resident as dev and prod instances under launchd, loopback-bound, fronted only by
`tailscale serve`. Auth is stash's Supabase + GitHub PKCE module, copied, with three changes that
matter for a shell: a WebSocket Origin gate, `SameSite=Strict` on the session cookie, and a scrubbed
PTY environment.

The Buzz web Terminal page mounts a ported `term-xterm.js` (split into modules under the 1000-line
ceiling) through a thin React wrapper, with vendored xterm 5.5.0 and its batch-matched addons. The
Vitals sidebar rows poll `/api/host-stats` every 10 s.

**Key trade-off.** Buzz web (`:6351`) and the service (`:6881`) share the host
`crichton.tailb3d4b8.ts.net`. Different ports make them cross-origin but **same-site**. So the
session cookie can be `Strict` and still ride `fetch(credentials:'include')` and the WS handshake.
That removes the cross-site WebSocket hijack that `SameSite=None` would open. The cost: cookies are
host-scoped, not port-scoped, so every other service on that host also receives the session cookie
(§8, R1).

---

## 1. Name (Sam picks)

The collision pass ruled out these names:
- **helm**: collides with helm-core and Kubernetes Helm.
- **pulse**: an existing Buzz feature dir.
- **deck**: Steam Deck.
- **conn**: reads as "con".
- **shell / tty / term / vitals**: on-the-nose.

| Candidate | Why |
|---|---|
| **hatch** | The small door into the ship's workings. You open it to get at the engine room. One syllable, spells itself. Namesake: pypa's `hatch` Python build tool (flagged, different space). |
| **keel** | The backbone under everything, which is what crichton is for the fleet. Clean, no tech namesake of note. |
| **stoke** | You tend the fire: watch the gauges, feed the shell. A verb, like `stash`, `sift`, `thunk`. |

Votes: **hatch** first (quietly apt, sits well next to stash), **stoke** second. The ledger row is
appended only after Sam picks.

---

## 2. Requirements

**Functional**
1. On the desktop web (1440 px) and phone (390×844), open Terminal, land in herdr's shared
   `default` session, run a command, and see its output.
2. Reset view is a soft reset (close 4002). It clears and repaints and never kills the shell.
3. The shell survives a page close, a tailnet drop and a service restart. It lives in the herdr
   server, and ADR-022/027 are unchanged.
4. Spaces, tabs and agents render in native chrome from `/api/herdr`.
5. The Vitals crichton rows show CPU, GPU, Mem and Disk, refreshed every 10 s. The expanded Vitals
   view lists every local disk, load, uptime, memory pressure and the top GPU processes.
6. Kill switch off shows a disabled state, never a dead black box.

**Non-functional**
- Tailnet only, with no LAN Caddy vhost, no Funnel and no public route.
- The service's own PTY memory bound matches evie's ADR-019/026 (bounded `readSync` pump, caps 16
  connections and 4 sinks).
- `/api/host-stats` p95 < 50 ms. It serves a cached sample and never spawns per request.
- Collector cost < 1% of one core while nobody is polling. The collector is lazy (§5.4).
- Single user (Sam). The email allowlist is mandatory.

**Assumptions** (marked)
- A1: herdr 0.7.4 keeps `--session` launch-or-attach and `session list --json` compatible with the
  evie code written against 0.7.3. S0 verifies this.
- A2: iOS Safari sends a `SameSite=Strict` cookie on a same-host, cross-port `fetch` and WS
  handshake, as Chrome does. S0 verifies this, and it is the gate for §6.2.
- A3: Only Sam's user-owned devices reach crichton on the tailnet.

---

## 3. Ports and secrets

**Proposed block `hatch`: 6870–6919.** It is the next free 50-block after stash (6820–6869).
The registry has nothing in 6870–6919 (only stash's `6869` end marker), and `lsof` shows no
listener in 6870–6999. Layout mirrors stash:

| Port | Use |
|---|---|
| 6870 | dev app (Bun, loopback `127.0.0.1`) |
| 6871 | dev front door: `tailscale serve --https=6871 → 127.0.0.1:6870` |
| 6879 | dev **web preview** front door: `tailscale serve --https=6879 → vite dev`, so the designer gets a same-site HTTPS origin for live checks (the dev server's `http://localhost` origin is cross-site and can never carry a Strict cookie) |
| 6880 | prod app (loopback) |
| 6881 | prod front door (tailscale serve). **This is `VITE_HATCH_URL`.** |
| 6872–6878, 6882–6919 | reserved |

Nothing is edited yet. The coder adds the block in S3, with `app/config.ts` as the only place a port
default lives.

**Secrets (Infisical, env `dev`, folder `/hatch`)**
- `SUPABASE_URL` and `SUPABASE_ANON_KEY` only, as secret imports into the folder. The process then
  receives exactly two secrets, both needed for token verification.
- No new secrets. No LLM and no OpenRouter.
- The launcher's minted `INFISICAL_TOKEN` must not reach the PTY (§6.4).

---

## 4. Repo layout, and what is copied versus rewritten

Repo `~/software_development/projects/hatch` (GitHub `Solar-io/hatch`, private), single branch
`main`. Prod is a pinned checkout `…/hatch-prod`, the same model as stash.

**History.** Run `git filter-repo` on a fresh evie-ui clone, keeping `app/term/**`,
`app/web/term-hub*.ts`, `patches/node-pty@1.1.0.patch`, `scripts/build-node-pty.sh`,
`docs/plans/PTY-BOUNDED-READER.md` and `docs/test-contracts/pty-terminal-phase1.md`. Include former
paths (`git log --follow`). The fallback, as stash did: a plain copy with a provenance commit
("extracted from evie-ui @c6b45c08"), after at most an hour of fighting filter-repo.

```
hatch/
  AGENTS.md  CLAUDE.md(@AGENTS.md)  package.json  bun.lock  bunfig.toml  tsconfig.json
  patches/node-pty@1.1.0.patch            COPY verbatim
  scripts/build-node-pty.sh               COPY verbatim (postinstall; build/Release probed first)
  app/logger.ts                           COPY from stash
  app/config.ts                           NEW: trimmed stash config + evie TerminalConfig and
                                          resolveTermSession() copied verbatim (FORBID_DEFAULT etc.)
  app/server.ts                           NEW (~150 lines): Bun.serve, dispatch, websocket handlers
  app/term/pty.ts session.ts herdr.ts reaper.ts          COPY verbatim, plus their 6 test files
  app/web/term-hub.ts (+ term-hub.test.ts)               COPY; edits in §4.1
  app/web/auth.ts pkce.ts session-cookie.ts secret-compare.ts (+ tests)   COPY from stash; §4.1
  app/web/routes/auth.ts                  COPY from stash; add GET /auth/signed-in
  app/web/cors.ts                         NEW: exact-origin CORS and the Origin gate
  app/web/kill-switch.ts                  NEW: env + runtime file switch
  app/web/pty-env.ts                      NEW: PTY environment allowlist
  app/web/routes/host-stats.ts            PORT evie's, then extend (§5.4)
  app/host/{cpu,gpu,memory,disks,collector}.ts           NEW pure parsers + a lazy sampler
  app/web/routes/herdr.ts                 NEW: snapshot → DTO, and focus actions
  app/web/routes/term-upload.ts           NEW: paste-to-upload sink
  deploy/launchd/{com.dev.hatch.plist,com.prod.hatch.plist,hatch-dev.sh,hatch-prod.sh}  ADAPT stash
  deploy-dev.sh  deploy-prod.sh  deploy/*.test.ts        ADAPT stash
  docs/DECISIONS.md                       carry ADR-018/019/022/026/027/101 text, plus new ADRs §10
```

### 4.1 Edits to the copied files (the only ones allowed)

| File | Edit |
|---|---|
| `term-hub.ts` | Import paths. Message strings `EVIE_UI_*` → `HATCH_*`. `resolveTermUpgrade` gains an `originOk` precondition, checked **before** auth, and a runtime kill-switch read. Clamp `resize` and the upgrade `cols`/`rows` to 1–1000 / 1–500. Today only `> 0` is checked, so `cols=1e9` reaches `TIOCSWINSZ`. New close code **4004** (terminal disabled at runtime). Everything else is byte-identical, including 1000/1013/4001/4002/4003 semantics and the order-is-load-bearing comments. |
| `session.ts` | Takes a `ptyEnv` from `pty-env.ts` instead of inheriting `process.env` (§6.4). No other change. |
| stash `auth.ts` | Add `checkWebSocket(req, ip)`, the same resolver as `checkApi`. Log line says hatch. Refuse to **start** with the terminal enabled and an empty email allowlist. Stash only warns; for a shell that is fatal. |
| stash `session-cookie.ts` | Names `hatch_session` / `hatch_pkce`. Session cookie is `SameSite=Strict; Secure` over HTTPS; PKCE stays `Lax` (it must survive the cross-site return from supabase.co). Max-Age 7 days (stash has 30). |
| `herdr.ts` | Unchanged. `HERDR_PREFIX` stays `evie-term-` so the legacy per-id tests keep their no-leak guard. Nothing in runtime uses the per-id path. |

**Drift rule** (goes in AGENTS.md). `app/term/*` and `term-hub.ts` are copies of evie-ui's, and the
auth files are copies of stash's. A security fix to either side must be ported to the other while
both exist. evie-ui's terminal stays dormant (flag off). Deleting it is out of scope (Q9).

---

## 5. Endpoints

One `Bun.serve` on `127.0.0.1:<port>`. Dispatch order:
1. `/healthz`
2. auth routes
3. CORS preflight
4. the gate (Origin, then identity)
5. routes, or the `/ws/term` upgrade

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | `{ok, version}`. No host data. |
| `GET /auth/github?redirectTo=/path` | none | PKCE start. `redirectTo` stays **path-only** (stash `safeNext`). |
| `GET /auth/callback` | none | Code exchange, sets `hatch_session`. |
| `GET /auth/signed-in` | none | Static page. Posts `{type:'hatch:signed-in'}` to `window.opener` for each allowlisted Buzz origin, then `window.close()`. Fallback text: "Signed in. Return to Buzz." |
| `POST /api/auth/signout` | session + Origin | Clears the cookie and evicts the token cache. |
| `GET /api/me` | session | `{email, terminal:{enabled, reason?}, session:{name, shared}}`. |
| `GET /api/host-stats` | session | Host DTO (§5.4). |
| `GET /api/herdr` | session | herdr DTO (§5.3). |
| `POST /api/herdr/focus` | session + Origin | `{kind:'workspace'\|'tab'\|'agent', id}` (Q7). |
| `POST /api/term/upload?name=` | session + Origin | Raw bytes, ≤ 25 MB, one file. Returns `{path}`. |
| `WS /ws/term?id&cols&rows` | Origin, then session, then kill switch | The unchanged protocol (§5.1). |

### 5.1 `/ws/term`: protocol unchanged

- **Binary frames** carry raw PTY bytes both ways, and are never decoded server-side.
- **Text frames** carry JSON control messages: `resize{cols,rows}`, `kill`, `reset`, `ping` (answered
  `pong`), and `attach` (a no-op). Unknown types are ignored.

**Close codes**, with the client behaviour the web page must implement:

| Code | Meaning | Client |
|---|---|---|
| 1000 | Private PTY exited (the user typed `exit`) | "Shell exited". No reconnect. |
| 1011 | PTY spawn failed | Error state and a Retry button. |
| 1013 | Capacity or backpressure | "At capacity". No auto-reconnect. |
| 4001 | Hard reset (per-id mode only) | Rotate the id and reconnect. |
| 4002 | Soft reset (shared session) | Clear the emulator and reconnect with the **same** id. |
| 4003 | herdr client exited, shell alive | Backoff reconnect. |
| **4004** | **Kill switch flipped at runtime** (new) | Disabled state. No reconnect. |
| 1006 / upgrade refused | Transport drop, or an HTTP 401/403 on upgrade | `GET /api/me`: 401 → sign-in, 403 → not authorized, `terminal.enabled=false` → disabled, otherwise backoff. |

### 5.2 CORS and the Origin gate (`cors.ts`)

- `HATCH_ALLOWED_ORIGINS` is an exact list.
  - Prod: `https://crichton.tailb3d4b8.ts.net:6351`.
  - Dev: prod's entry plus `https://crichton.tailb3d4b8.ts.net:6879`.
  - No `*`, no suffix match, no reflection.
- Allowed origin gets `Access-Control-Allow-Origin: <that origin>`,
  `Access-Control-Allow-Credentials: true` and `Vary: Origin`. A disallowed origin gets **no** CORS
  headers.
- Preflight (`OPTIONS`) allows `GET, POST`, header `content-type`, and `Max-Age: 600`.
- **The server enforces Origin itself.** CORS only stops the browser reading a response; it does not
  stop a request from executing.
  - Every non-GET, and every `/ws/term` upgrade, needs `Origin ∈ allowlist`.
  - A missing Origin is accepted only from a genuine local service (loopback ∧ ¬proxied, the stash
    trust rule).
  - The WS check is the one that matters. Browsers apply no CORS to WebSockets, so without it any
    page Sam visits could drive a shell with his cookie.

### 5.3 `/api/herdr`

The server runs `herdr api snapshot` with argv only, never a shell, bounded at 2 s, and caches the
result for 2 s. It projects the snapshot into a stable DTO so herdr's private, versioned protocol
(protocol 16, `schema_version 1`) never reaches the web:

```
{ v:1, running:boolean, session:'default', protocol:number,
  workspaces:[{id,label,branch?,focused}], tabs:[{id,workspaceId,label,focused}],
  agents:[{id,label,workspaceId,tabId?,agent?:'claude'|'codex'|…,status:'idle'|'working'|'blocked'|'done'|'unknown',since?}] }
```

- **herdr not running** (connection refused): `{running:false}` with status 200, never 500.
- **Unknown `schema_version`**: `{running:true, unsupported:true}`, and the page hides the chrome
  lists but keeps the terminal.
- **`/focus`**: the `id` must exist in a fresh snapshot, or the server returns 400 and spawns
  nothing. It runs `herdr {workspace|tab|agent} focus <id>`. S0 measures whether focus is
  per-client or server-global. If global, clicking in the web chrome also moves Sam's CLI view.
  That is consistent with ADR-022, but Sam decides (Q7).

### 5.4 `/api/host-stats`

A lazy collector samples every 10 s while any request arrived in the last 60 s, and stops otherwise.
Requests read the cached sample. CPU % is the delta between two collector ticks, with no sleep in
the request path. Every probe keeps evie's rules: absolute binary paths (launchd PATH lacks
`/usr/sbin`), a spawn timeout with kill, and fail-soft to `null` with a one-time warning.

```
{ v:1, host:'crichton', sampledAt, uptimeSec, load:[l1,l5,l15],
  cpu:{percent|null},
  gpu:{percent|null, renderer|null, tiler|null, top:[{pid,name,percent}]|null},
  mem:{usedBytes,totalBytes,percent, pressure:'normal'|'warn'|'critical'|null},
  disks:[{name, mount, kind:'internal'|'external', readOnly, totalBytes, usedBytes, freeBytes, percent}],
  primaryDisk:'/System/Volumes/Data' }
```

| Field | Source (no root) |
|---|---|
| CPU | `os.cpus()` delta (evie). |
| Load, uptime | `os.loadavg()`, `os.uptime()`. |
| GPU % | `/usr/sbin/ioreg -r -d 1 -c IOAccelerator`, `PerformanceStatistics."Device Utilization %"`. Also carries `Renderer`/`Tiler Utilization %`. Verified live today. |
| GPU top processes | `ioreg -l -w0 -c AGXDeviceUserClient`: `IOUserClientCreator` ("pid N, name") plus `AppUsage[].accumulatedGPUTime` (ns). Per-process % = Δtime / Δwall between ticks. Best effort, `null` on parse failure. 61 clients seen today; the coder measures the spawn cost and drops it if it exceeds 50 ms. |
| Memory | evie's `vm_stat` + `sysctl vm.page_pageable_internal_count` (Activity Monitor formula). Pressure from `sysctl kern.memorystatus_vm_pressure_level` (1/2/4). |
| Disks | `/bin/df -P -k -l`, **local only**, so a dead network mount cannot hang the probe. Keep `/System/Volumes/Data` (named from `diskutil info -plist` `VolumeName`) and `/Volumes/*`. Drop `/` (the sealed system snapshot always reads ~1%) and the other `/System/Volumes/*`. Drop disk images (`diskutil info -plist`: virtual/disk-image, e.g. `/Volumes/Blender` at 100%). Cache `diskutil` per device node. |

The sidebar Disk row uses `primaryDisk`. The expanded Vitals view lists all disks; today that means
Data and `crichton-backups`.

The artboard's "6 Buzz services up · tts bridge restarted 2h ago" line is **not** in the Phase 7
brief. It is Q5; do not build it unasked.

### 5.5 `/api/term/upload`

This carries evie's paste-a-file-into-the-terminal feature (`term-paste-upload.js`). Files land in
`~/.hatch/uploads/YYYY-MM-DD/<sanitized>` (stash `sanitizeUploadName`), with a numeric suffix on
collision, never an overwrite. The endpoint returns the absolute path, which the client injects as
a bracketed paste. It never writes outside that dir.

---

## 6. Security-critical decisions

1. **Perimeter.**
   - Bun binds `127.0.0.1` only.
   - The only proxy is `tailscale serve`: no Caddy vhost, no Funnel.
   - Trust stays **LOOPBACK ∧ ¬PROXIED** (stash): every proxied request needs a session.
   - `deploy-*.sh` fails if `~/dev-apps/Caddyfile` references 6870/6880, or if
     `tailscale funnel status` lists 6871/6881.
2. **Cookie and cross-origin model.**
   - `hatch_session` is `HttpOnly; Secure; SameSite=Strict; Path=/`, with a 7-day life.
   - It works because `:6351` and `:6881` are same-site; site ignores ports.
   - **Rejected: `SameSite=None`**, which the brief suggested. It is only needed for a cross-site
     embed (e.g. a future Tauri `tauri://` origin). It would let any site Sam visits send his cookie
     on a WS to the shell, leaving the Origin check as the sole wall.
   - A2 is verified in S0. If iOS Safari withholds Strict on cross-port requests, fall back to
     `Lax`. `Lax` behaves the same for same-site subresources, so the threat model is unchanged.
     Never fall back to `None`.
3. **Sign-in from Buzz.**
   - On 401, the page shows "Sign in to crichton". The button calls
     `window.open(<URL>/auth/github?redirectTo=/auth/signed-in)` as a top-level window. GitHub
     refuses iframes, and the PKCE cookie needs a top-level return.
   - `/auth/signed-in` posts a message to its opener, and the page re-checks `/api/me` on that
     message (checking `event.origin` is the service's origin) and on `focus`/`visibilitychange`.
   - No token ever appears in a URL, and there is no absolute-URL redirect, so no open redirect.
   - Supabase redirect URLs `https://crichton.tailb3d4b8.ts.net:6871/auth/callback` and
     `:6881/auth/callback` are added via the Management API (one-time, S3).
4. **PTY environment is scrubbed.** This deliberately reverses ADR-018's accepted risk, for the
   new service only (Q8).
   - The PTY gets an allowlist: `HOME USER LOGNAME SHELL PATH LANG LC_* TERM=xterm-256color
     COLORTERM=truecolor TMPDIR`, plus evie's reaper marker.
   - `INFISICAL_TOKEN`, `SUPABASE_*` and every `HATCH_*` stay out.
   - Caveat: if herdr's server is already running, the shell has **its** environment, not ours.
     The scrub protects the case where our spawn starts the server.
5. **Authorization.**
   - The email allowlist is mandatory. The service refuses to start with the terminal on and an
     empty list.
   - The Supabase project is shared and holds loginable test users (stash auth comment).
   - No `x-api-key` or service identities.
   - **Recommended second factor (Q3):** require `Tailscale-User-Login ∈ HATCH_ALLOWED_TAILNET_USERS`
     on proxied requests. The header is only trustworthy because §6.1 guarantees tailscale serve is
     the only proxy; stash could not use it because of its LAN Caddy path. Tagged or shared nodes
     get no such header and are refused.
6. **Kill switch, two levers.**
   - `HATCH_TERMINAL_ENABLED` defaults off and is read at boot.
   - A runtime file `~/.hatch/terminal.disabled` is checked on every upgrade and by a 2 s sweep
     that closes live terminal sockets with 4004. It turns a shell off without a deploy.
   - Host stats and herdr introspection are unaffected by either lever.
7. **Dev does not type into Sam's shell.**
   - Dev: `HATCH_TERM_SESSION=hatch-dev` and `HATCH_TERM_FORBID_DEFAULT=1` (evie's lever).
   - Prod: `default`, shared with Sam's CLI by design (ADR-022).
   - Separate reaper registry files per instance.
8. **Input bounds.**
   - `cols`/`rows` are clamped. The id stays `[A-Za-z0-9_-]{1,64}`.
   - Caps: 16 connections, 4 sinks.
   - Upload: ≤ 25 MB, fixed dir.
   - herdr ids are validated against the snapshot and passed as argv, never through a shell.
9. **Audit.**
   - One log line per `/ws/term` open and close: email, `Tailscale-User-Login`, the XFF client IP,
     user-agent, close code and uptime.
   - One line per upload and per focus.
   - Cookie and Authorization headers are never logged (asserted by a test).

---

## 7. Operations

| | dev | prod |
|---|---|---|
| launchd | `com.dev.hatch` | `com.prod.hatch` |
| checkout | `…/projects/hatch` (canonical `main`) | `…/projects/hatch-prod` (pinned) |
| app / front door | `127.0.0.1:6870` / `:6871` | `127.0.0.1:6880` / `:6881` |
| launcher | `~/.config/dev-services/hatch-dev.sh` | `~/.config/prod-services/hatch-prod.sh` |
| herdr session | `hatch-dev` (FORBID_DEFAULT) | `default` |
| terminal flag | on | off until the §9 review passes and Sam says go |
| logs | `~/Library/Logs/hatch/com.dev.hatch.{out,err}.log` | `…/com.prod.hatch.*` |

**Launchers** are adapted from stash: mint `INFISICAL_TOKEN`, then
`infisical run --path=/hatch -- bun run app/server.ts` with an absolute PATH.

**Deploy scripts** are stash's shape on `shared-infra/lib/deploy-common.sh`:
- They read ports from the registry and check secret **names** only.
- They take `--dry-run` and `--restart-only`.
- `deploy-prod.sh --yes` runs only from the canonical checkout and refuses under
  `CLAUDE_FINALIZE_HOOK=1`.
- Health is checked at `127.0.0.1:<app>/healthz` and `https://crichton…:<door>/healthz`.
- They also run the §6.1 Caddy/Funnel check.

**One-time host setup** (operator, printed by the script when missing):
- `tailscale serve --bg --https=6871 http://127.0.0.1:6870`, and the same for 6881→6880.
- `tailscale serve --bg --https=6879 http://127.0.0.1:<vite port>`, dev only, while previewing.

**Rollback**
- Stop the service: `launchctl bootout gui/$(id -u)/com.prod.hatch`, remove the plist, then
  `tailscale serve --https=6881 off`.
- Revert a bad promotion by checking out the prior SHA in `hatch-prod`, then
  `deploy-prod.sh --yes --restart-only`.
- The shell survives either, because it lives in herdr's server.

**Web config.** `web/.env.production` gains `VITE_HATCH_URL=https://crichton.tailb3d4b8.ts.net:6881/`.
Unset hides the Terminal nav item and the crichton Vitals rows (plan §1, "intentional tension").

---

## 8. The Buzz web side (designer)

`web/src/features/terminal/`:

| Piece | Source | Notes |
|---|---|---|
| `web/public/vendor/xterm/*` | **byte-copy** of evie's vendor dir: `xterm.js` (hash-matched `@xterm/xterm@5.5.0`), `addon-fit.js`, `addon-clipboard.js`, `addon-webgl.js` (0.18.0), `addon-canvas.js` (0.7.0), `xterm.css`, `LICENSE` | Add a `MANIFEST.json` with sha256 and version per file. Never mix in the 0.19.0/0.11.0 (xterm 6) batch. The files load only on the Terminal route: script tags injected by the emulator, never in the main bundle. `xterm`/`fit`/`clipboard` are required; `webgl`/`canvas` are optional (a failed load degrades, per the ADR). |
| `emulator/` (ESM `.js` plus a hand-written `emulator.d.ts`) | **port** of `term-xterm.js` (2134 lines), split under the 1000-line ceiling: `transport.js` (WS, close codes, reconnect, keepalive), `renderer.js` (WebGL → Canvas → DOM chain, context-loss bound 3, activated **after** `term.open()` and after the font gate), `input.js` (keys, touch, smart period, soft/hardware keyboard), `boot.js` (mount, dispose, fit, public API) | Drop `drawers.js`/`getDrawer`, the `window.__evieTerm*` globals, `showLoginOverlay` (becomes an `onAuthRequired` callback), `EVIE_UI_DEBUG` and `location.host` (becomes the configured URL). localStorage key becomes `buzz.terminal.id`. |
| `emulator/` helpers | **copy** `term-keys.js` (1222 lines: split in two), `term-touch.js`, `term-glyph-contrast.js`, `term-smart-period.js`, `term-soft-keyboard.js`, `term-hardware-keyboard.js`, `core/ws-keepalive.js`, `term-esc.js`, with their tests | Test runner is `pnpm test` (node + jsdom loader), not bun. The tests are ported alongside. |
| `emulator/theme.js` | **rewrite** of `core/term-theme.js`. Drop `term-themes.js` (1814 lines). | ANSI palette and cursor come from the Buzz tokens on the artboard (`--term`, `--term-ink`, `--term-dim`, `--term-add*`, `--term-hl`, `--term-warn`, `--term-tab`). Re-theme live on light/dark switch. |
| `emulator/paste-upload.js` | **rewrite** of `term-paste-upload.js` | Keep the bracketed-paste split (`splitOversizedBracketedPaste`, the ADR-101 lesson). Replace the fs-upload, sidebar-dropzone and fs-transfer imports with an injected `upload(file) → path` that POSTs to `/api/term/upload`. |
| `ui/KeyBar.tsx` | **port** of `term-pad.js` (593 lines), React | esc, tab, ctrl (latch), ↑ ↓ ← → per PhoneTerminal. Keys send exact bytes (`\x1b`, `\t`, `\x1b[A`…). Hide/show toggle (ADR-081). |
| `ui/TerminalPage.tsx` | new | Header "Terminal · herdr · crichton" with a connection pill. Left rail: Spaces, then Agents grouped by space with status. Tab strip from the focused space. Emulator mount. States: signed-out, not-authorized, disabled, herdr-stopped ("opening starts it"), connecting, connected, reconnecting, at-capacity, shell-exited. Reset view sends `reset` and expects 4002. |
| `ui/Xterm.tsx` | new, thin | `useEffect` mounts `boot.mount(el, {url, onState, onAuthRequired, upload})` and disposes on unmount. No React state per byte. |
| `lib/hatchClient.ts` | new | `me()`, `herdr()`, `hostStats()`, `focus()`, all `credentials:'include'`. Forgiving like `usageHub.ts`: failures give `null`, never `0`. |
| Vitals rows | new, in the Phase 1 Vitals block | Poll `hostStats()` every 10 s, paused while `document.hidden`. `null` renders "—", never 0%. Older than 30 s shows "stale"; unreachable shows "crichton · offline". |

**Service worker trap** (from the ADR). Any e2e that blocks a vendor asset must bypass the SW
(`Network.setBypassServiceWorker`), or a cached copy makes it pass falsely.

**Phone.** The PhoneTerminal artboard shows no left rail. Tabs become a chip row under the header,
and the key bar docks above the soft keyboard. Carry evie's iOS keyboard-lift behaviour
(`term-soft-keyboard.js`).

---

## 9. Security review checklist (the gate before any prod flag-on)

The reviewer records evidence for each line in `docs/SECURITY-REVIEW-phase7.md` in the hatch repo.
Sam signs off.

- [ ] `lsof` shows Bun listening on 127.0.0.1 only. No Caddy vhost targets 6870/6880. `tailscale funnel status` shows neither front door.
- [ ] Unauthenticated `curl` to the front door returns 401 on `/api/*`, and the `/ws/term` upgrade fails. `/healthz` reveals nothing beyond `{ok,version}`.
- [ ] A WS upgrade with a valid cookie and `Origin: https://evil.example` → 403, zero PTYs spawned (spawn counter).
- [ ] A WS upgrade with a valid cookie and **no** Origin through the proxy → 403.
- [ ] A POST from a disallowed origin → 403, and no side effect (upload dir unchanged, herdr not called).
- [ ] CORS never answers with `*` or a reflected unlisted origin. `Vary: Origin` is present.
- [ ] Cookie flags on the wire: `hatch_session` `HttpOnly; Secure; SameSite=Strict`, 7 d. `hatch_pkce` `Lax`, 10 min.
- [ ] A Supabase user outside the allowlist → 403. The service refuses to start with the terminal on and an empty allowlist.
- [ ] (If Q3 is adopted) a proxied request without an allowlisted `Tailscale-User-Login` → 403.
- [ ] Typing `env` in the PTY shows no `INFISICAL_TOKEN`, `SUPABASE_*` or `HATCH_*` (with a server started by our spawn).
- [ ] The kill-switch file closes a live socket with 4004 within 3 s, and a new upgrade → 403. The env flag off means no PTY at all.
- [ ] Resize `cols=1000000` is clamped; there is no crash and no `TIOCSWINSZ` error spam.
- [ ] Upload: `../`, absolute names, >25 MB and collisions are all refused or suffixed; nothing is written outside `~/.hatch/uploads`.
- [ ] herdr focus with an unknown id or a shell metacharacter id → 400, no spawn.
- [ ] Logs contain the open/close audit lines and no Cookie or Authorization values.
- [ ] Cookie exposure (R1): check that no other `tailscale serve`/Caddy service on the crichton host logs request Cookie headers (Buzz relay, stash, usage bridges, Daily Edition). List each one checked.
- [ ] Sign-out evicts the verify cache: the old access token is refused immediately, not after 60 s.
- [ ] The dev instance is proven to attach `hatch-dev`, never `default`.

---

## 10. Test contract

Each mechanism gets a named test, a mutation that must turn it red, and a restore. Commit before
mutating, report test **counts**, and baseline the carried evie suites first
(`bun test --isolate`).

**Service**

| # | Test | Mutation that must fail it |
|---|---|---|
| S-1 | WS upgrade with a disallowed or missing Origin → 403 with 0 spawns | Delete the `originOk` precondition |
| S-2 | CORS exact echo, `Vary`, never `*` | Reflect any Origin |
| S-3 | Non-GET from a disallowed origin → 403, upload dir unchanged | Rely on CORS alone (drop the server check) |
| S-4 | Env flag off → 403 and 0 spawns. Runtime file → live socket closed with 4004 | Invert the flag. Drop the sweep. |
| S-5 | PTY env excludes `INFISICAL_TOKEN`/`SUPABASE_*`/`HATCH_*`, with a real spawn and a fresh per-id herdr server | Pass `process.env` |
| S-6 | Allowlist: off-list email → 403. Empty list with the terminal on → boot exit 78 | Return `true` from `isAllowedEmail` |
| S-7 | Cookie flags (Strict session, Lax pkce, names) | `SameSite=None` |
| S-8 | Soft reset closes 4002, and a marker PID in the shared session survives reset **and** socket close | Close 1000 on reset. Kill the session. |
| S-9 | Resize clamp | Remove the clamp |
| S-10 | Carried evie suites green at their evie counts: pty, detach, adversarial (frozen-consumer RSS bound), osc52-copy, reaper, reattach-modes, term-hub | evie's own mutation notes apply (e.g. swap `readSync` for `Bun.file().stream()`) |
| S-11 | Host parsers on **captured fixtures** with hardcoded expected values (ioreg GPU, AGX clients, `df -P -k -l`, `vm_stat`, `diskutil` plist, pressure sysctl) | Read `Renderer` instead of `Device Utilization %`. Keep `/` in disks. Include the disk image. |
| S-12 | A probe binary that sleeps → field `null` within the deadline, and the request is not delayed | Remove the timeout kill |
| S-13 | Collector is lazy: no spawns after 60 s without requests | Start it unconditionally |
| S-14 | herdr: fixture snapshot → DTO. Connection refused → `{running:false}` 200. Unknown schema → `unsupported`. Focus with an unknown id → 400, 0 spawns | Pass the raw snapshot through. Skip id validation. |
| S-15 | Upload traversal, size, collision | Drop `sanitizeUploadName` |
| S-16 | The logger redacts Cookie and Authorization | Log raw headers |
| S-17 | `deploy-dev.sh --dry-run` takes its ports from the registry and fails on a Caddy vhost for 6870 | Hardcode the port. Skip the check. |

**Web** (`cd web && pnpm test`, assert the count)

| # | Test | Mutation |
|---|---|---|
| W-1 | Transport feeds `Uint8Array` to xterm; a UTF-8 codepoint split across two frames renders intact | `TextDecoder` per frame |
| W-2 | Close-code table (§5.1) with a fake WS: each code gives its state and its reconnect or no-reconnect | Reconnect on 1000. Rotate the id on 4002. |
| W-3 | Vitals poller: 10 s interval, paused when hidden, `null` renders "—", stale at 30 s | Coerce `null` to 0 |
| W-4 | Terminal nav and Vitals crichton rows are absent when `VITE_HATCH_URL` is unset | Always render |
| W-5 | Vendor `MANIFEST.json` sha256 matches every file | Swap in addon-webgl 0.19.0 |
| W-6 | Renderer chain: the webgl script 404s → canvas → DOM, and the terminal still boots (e2e with SW bypass) | Put webgl in the required tier |
| W-7 | Key bar bytes, including the ctrl latch | Wrong escape |
| W-8 | Sign-in: 401 → button, `postMessage` from the service origin → re-check. A message from another origin is ignored | Skip the `event.origin` check |

**Live** (Agent Brave, own tab, closed after). Run at 1440 and 390×844, light and dark, against the
dev front door and the `:6879` web preview (§11).

---

## 11. Acceptance criteria

**Service (S0–S3)**
1. From the dev web preview, a signed-in Sam opens a shell on `hatch-dev`: `echo $((6*7))` prints
   `42` within 2 s of connect.
2. Reset view gives close 4002. A `sleep 9999 &` started before the reset has the same PID after it,
   and after a service `--restart-only`.
3. `/api/host-stats` agrees with the host, sampled within 15 s:
   - CPU within ±10 points of `top -l 2 -n 0` (idle-based).
   - GPU within ±10 points of `ioreg` Device Utilization.
   - Memory within ±2 % of Activity Monitor's formula.
   - Each disk within ±0.5 % of `df`.
   - p95 < 50 ms over 100 calls.
4. Every §9 line passes with recorded evidence.
5. S-1…S-17 are green, and each named mutation turned its test red.

**Web Terminal page (W1–W2)**
1. Matches the Terminal and PhoneTerminal artboards in both themes. Spaces, agents and tabs are
   populated from live herdr.
2. Every state in §8 is reachable and shows its own copy. Kill switch off shows the disabled state
   within 3 s.
3. On the phone, the key bar sends esc, tab, ctrl-C and arrows correctly in a TUI (e.g. `htop`), and
   the soft keyboard does not cover the prompt.
4. A paste over 1 KB and a pasted image file both arrive intact. The ADR-101 bracketed closing
   marker is present.
5. W-1…W-8 are green, and the test count is asserted.

**Vitals (W3)**
1. The crichton rows show CPU/GPU/Mem/Disk from the live service and refresh every 10 s. They pause
   in a hidden tab (network panel shows no requests).
2. Stopping the service shows "crichton · offline" within 20 s, never 0%.
3. The expanded view lists Data and `crichton-backups`, and no disk images.

---

## 12. Implementation plan

| Step | Seat | Content | Depends on |
|---|---|---|---|
| **S0 spike** (½ day) | coder | Prove A2 on Chrome and iOS Safari: a throwaway Bun on 6870/6871 sets a Strict cookie; a page served on 6879 reads it by `fetch` and WS. Verify herdr 0.7.4 against the copied `herdr.ts` (`--session`, `session list --json`, snapshot shape, focus scope). Get a patched node-pty build in a fresh repo. | none |
| **S1** | coder | Repo extraction; server; auth copy with §4.1 edits; Origin gate; kill switch; env scrub; clamp. Carried suites green at baseline counts. S-1…S-10, S-16. | S0 |
| **S2** | coder | Host collectors, `/api/host-stats`, `/api/herdr`, focus, upload, CORS. S-11…S-15. | S1 |
| **S3** | coder | Registry block, launchd, launchers, deploy scripts and tests, dev tailscale serve, Supabase redirect URLs (Management API). Dev live. S-17. | S1 |
| **W1** | designer | Vendor, emulator split and port, `Xterm.tsx`, `TerminalPage` desktop, sign-in flow. W-1, W-2, W-5, W-6, W-8. | S3 (dev live); build against a mock WS first |
| **W2** | designer | Phone layout, `KeyBar`, paste-upload. W-7. | W1, S2 |
| **W3** | designer | Vitals rows and expanded view. W-3, W-4. | S2, S3, Phase 1 Vitals block |
| **Review** | architect or a fresh reviewer seat | §9 checklist with evidence | S1–S3, W1–W2 |
| **Prod** | orchestrator on Sam's go | `deploy-prod.sh --yes`, prod tailscale serve, flag on, `VITE_HATCH_URL` in `.env.production`, web redeploy | Review signed |

S2/S3 can run in parallel after S1. W1 can start on a mock WS as soon as S1's protocol is frozen
(it is: unchanged plus 4004).

---

## 13. Risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Host-scoped cookies.** `hatch_session` (access plus refresh token) is sent to *every* port on `crichton.tailb3d4b8.ts.net`: the Buzz relay, stash, bridges. Any of them logging Cookie headers leaks a shell credential. | High if it happens | §9 log audit; 7-day life; sign-out evicts. Alternative: a separate hostname (a Caddy `.internal` name). It is cross-site, so it would need `SameSite=None` plus the Origin gate as the only wall. Rejected as the worse trade. |
| R2 | herdr's snapshot is a private, unstable protocol (0.7.3 → 0.7.4 already happened) | Chrome lists break | DTO projection, a schema-version check that degrades to terminal-only, fixture tests. The terminal path uses only the CLI. |
| R3 | Splitting 2134-line `term-xterm.js` for the file-size ceiling regresses subtle fixes (echo trap, mode init, ADR-101 paste) | Terminal misbehaves | Port evie's `term-reconnect*`, `term-keys`, `term-touch`, `term-paste-upload` tests first, then split under green. Splits follow existing seams. |
| R4 | node-pty patched build or a Bun upgrade regresses the `readSync` pump (ADR-019) | OOM or a dead terminal | Carried canary tests; `assertPatchedBinding()`; pin Bun in the launcher as stash does. |
| R5 | Shared `default` session: web input lands in Sam's live CLI shell | Surprise | By design (ADR-022). Dev is isolated (§6.7). |
| R6 | Service-worker cache masks vendor failures | False green | SW bypass in e2e (ADR). |
| R7 | iOS Safari cookie behaviour (A2) | Phone cannot auth | S0 proves it first; Lax fallback. |
| R8 | Two copies of the terminal code (evie dormant, hatch live) | Security drift | Drift rule in both AGENTS.md files. Q9 on deleting evie's copy. |

---

## 14. Open questions for Sam

1. **Name:** hatch, keel or stoke (votes: hatch, then stoke).
2. **Port block 6870–6919** (layout in §3). OK to register?
3. **Tailnet identity as a second factor** (§6.5)? Recommended yes.
4. **`SameSite=Strict`** instead of the `None` in the brief (§6.2)? Recommended yes. A future Tauri
   embed would reopen this.
5. **Vitals "N Buzz services up"** line from the artboard: build it (launchd plus docker probe, a
   config list), or leave it out of Phase 7?
6. **Session life 7 days** (stash uses 30)?
7. **herdr focus from the web chrome.** If S0 finds focus is server-global, clicking a tab in Buzz
   also moves your CLI herdr view. Allow it, or make the chrome read-only?
8. **Scrub the PTY environment** (§6.4)? It reverses evie ADR-018's accepted risk for the new
   service.
9. **evie-ui's terminal code:** leave it dormant under the drift rule (recommended), or delete it
   once hatch is live?

## Architecture verdict

**Safe to start with caveats.** S0 must prove A2 (Strict cookie across ports on iOS Safari) and
herdr 0.7.4 compatibility before S1. Q2 (port block) needs Sam's yes before the S3 registry edit.
Prod flag-on is gated on the §9 review and Sam's sign-off. Everything else is concrete enough to
build.

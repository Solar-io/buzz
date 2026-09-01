# `deploy/dev-kit/` — Buzz DEV relay on crichton

> **MOVED 2026-09-01** — this kit now lives in the buzz repo at `deploy/dev-kit/`
> (canonical home; copied from `evie-ui/deploy/buzz/`, which is now an inert copy
> pending deletion). Reason: Buzz's relay stack layered its compose overlay from the
> evie-ui checkout — a cross-repo dependency; Buzz now owns its deployment kit.
> `launchd/buzz-relay-dev.sh` KIT_DIR default repointed accordingly. Two constraints
> this placement honors: (1) upstream (block/buzz) has no `deploy/dev-kit/` path, so
> rebases cannot collide; (2) if the repo is ever open-sourced beyond the web UI,
> this kit needs a scrub pass first — it names crichton/aeryn throughout. The
> `buzz-mcp-interposer` wrapper here is currently UNWIRED (BUZZ_ACP_MCP_COMMAND is
> empty on all live seats) and still execs `$EVIE_REPO/agent/harness/` sources if
> ever activated — that is evie-ui functionality by design, not a kit dependency.

Install + deploy kit for a **self-hosted Buzz relay**, standing up W1 of
`docs/plans/BUZZ-MIGRATION-PLAN.md`. Written 2026-08-23 while Sam was out, so
**read §Guesses before running anything.**

```bash
./deploy/buzz/install-buzz-dev.sh --dry-run   # see the whole plan, touch nothing
./deploy/buzz/install-buzz-dev.sh             # allocate ports, clone, mint keys, render .env, launchd
./deploy/buzz/deploy-buzz-dev.sh              # start + tailnet front door + health gate
./deploy/buzz/smoke-buzz-dev.sh               # 8 assertions, exit non-zero on any failure
```

## What is verified vs. what is a guess

The stack itself was **actually stood up and smoke-tested** (Linux container,
2026-08-23) — 8/8 checks green against `ghcr.io/block/buzz:main` v0.2.1, 61
tables migrated, a second keypair minted and registered. Full record:
[`docs/evidence/BUZZ-W1-SMOKE-2026-08-23.md`](../../docs/evidence/BUZZ-W1-SMOKE-2026-08-23.md).

### 🔴 GUESSES — fix these first

| # | Guess | Where | How to fix |
|---|---|---|---|
| 1 | **Ports** are ALLOCATED automatically from `infra/port-registry.json` on first install — collision-checked against every port already recorded, aligned, bad-port-filtered, atomic, backed up. Idempotent: an existing `buzz` block is never moved. `--no-allocate` opts out | `lib/allocate-ports.ts` | Nothing to do. Review the block it picked if you care where it landed |
| 2 | **Checkout path** `~/software_development/projects/buzz` | `lib/common.sh` | `BUZZ_CHECKOUT=…` or edit |
| 3 | **Runtime dir** `~/.evie/buzz` (matches the deploy-detach convention) | `lib/common.sh` | `BUZZ_RUNTIME_DIR=…` |
| 4 | **Docker provider.** crichton is macOS — no system dockerd. The wrapper waits up to 5 min and tries `colima start` if colima is present | `launchd/buzz-relay-dev.sh` | Confirm which provider crichton runs; delete the branch that doesn't apply |
| 5 | **Owner identity.** The installer mints a *fresh* owner keypair | `install-buzz-dev.sh` step 4 | If Sam has a Nostr identity that should own this relay, set `RELAY_OWNER_PUBKEY` and delete `keys/owner.secret` |
| 6 | **Secrets live in a 0600 file**, not Infisical | `$BUZZ_RUNTIME_DIR/secrets.env` | Move to Infisical (`534404e2-…`, env `dev`, path `/buzz`) and read them the way `evie-ui-dev.sh` does. Marked TODO in the installer |
| 7 | **Image pin digest** resolved on x86_64 | `lib/common.sh:BUZZ_IMAGE_DEFAULT` | Re-resolve on crichton (arm64) |
| 8 | **`com.dev.buzz-relay` is the right label family** | `launchd/` | See §Blast radius — this one I did check |

## Blast radius — why this cannot disturb evie-ui

Checked, not assumed (2026-08-23):

- **`deploy-dev.sh` boots out *enumerated* `com.dev.evie-*` labels — never a `com.dev.*` wildcard.**
  So an evie dev deploy will not bounce `com.dev.buzz-relay`, and this kit only ever names
  `com.dev.buzz-*` and its own compose project.
- This kit **never** touches `evie-ui-prod`, `com.prod.*`, `:6000`, `:6200`, or evie's drain gate.
- It shares one directory with evie — `~/.config/dev-services/` — and adds exactly one file there
  (`buzz-relay-dev.sh`). Note `deploy-dev.sh --restart-only` reconciles that directory; it rewrites
  *its own* files, not ours.

⚠️ **If anyone ever changes either side to a `com.dev.*` wildcard bootout, these two stacks become
coupled and this paragraph becomes false.**

## Guards

Both scripts refuse under `CLAUDE_FINALIZE_HOOK=1` (Buzz is never stood up as a side effect of a
push) and under a test runner. The test-runner polarity is **fail-closed**, matching
`deploy/lib/test-interlock.sh` — a false proceed mutates a real container stack, so unreadable
ancestry refuses. Override for a genuine false refusal only:
`EVIE_BUZZ_TEST_INTERLOCK_OVERRIDE=yes-i-am-really-deploying`.

## The port trap, again

`assert_not_bad_port()` reads `shared/bad-ports.ts` — the *measured* WHATWG list — and refuses a
front-door or bind port on it. This is the `:6000`/`:6001` lesson generalised: `curl` does not
implement that list, so a hand check will tell you a bad port is fine while node's `fetch` and
every Chromium browser refuse it. The installer is the only place that catches this; the smoke
test uses `curl` and *cannot*.

## One thing the bundle gets wrong for this host

buzz's `deploy/compose/compose.yml` publishes the relay with no host IP, so it binds **0.0.0.0** —
right for the VPS it targets, wrong for crichton, which is on a LAN as well as the tailnet. Left
alone it puts the relay on the LAN without passing `tailscale serve`. `compose.loopback.yml`
re-pins it to `127.0.0.1` and `deploy-buzz-dev.sh` applies it automatically. It uses the
`!override` tag deliberately — a plain `ports:` would *append* and collide. Details and the
measurement are in the evidence doc.

## How you actually connect to it

Not obvious, and getting it wrong looks like a broken deploy:

- **The relay is not a web app.** A browser gets a **git web GUI** (`/`, `/repos`, `/repos/*`)
  plus invite landing pages (`/invite/<code>`), and only when `BUZZ_SERVE_GIT_WEB_GUI=true`
  (upstream default is `false`; the template sets it true). Channels, chat, huddles and agents
  are in the **Tauri desktop app** under the buzz checkout's `desktop/`, or in `buzz-cli`.
- **The Host header must match `RELAY_URL` exactly, port included.** The relay keys its single
  community on `host:port` and fails closed on anything else with a deliberately generic
  `404 relay: no community is configured for this host`. `127.0.0.1:6100` does not match
  `crichton.tailb3d4b8.ts.net:6101`, and neither does the same name without the port.
  ⚠️ Verify on crichton that `tailscale serve` forwards the original Host rather than rewriting
  it to the loopback target — if it rewrites, the front door 404s.
- `smoke-buzz-dev.sh` covers both (10 assertions).

## The hook bridge (W2 — built and verified)

`agent/harness/buzz-hook-bridge.ts` serves `_Stop` and `_PostCompact` as MCP tools, answered by
the **same** `runHooks()` that governs Claude seats and the Codex bridge. One policy, a third
executor.

```bash
bun agent/harness/buzz-hook-bridge.ts --print-config    # the mcpServers block to paste
BUZZ_SRC=~/software_development/projects/buzz \
  ./deploy/buzz/verify-hook-bridge.sh                   # drive a real buzz-agent, 6 assertions
bun test agent/harness/buzz-hook-bridge.test.ts         # 35 unit tests, no buzz needed
```

Two things will bite you when wiring it up, both measured:

- **`buzz-agent` `env_clear()`s its MCP children.** Only `PASSTHROUGH_ENV` survives, and
  `EVIE_HARNESS_HOOKS` is not on it — while the substrate defaults **OFF** (ADR-091). Declare it
  in the server's `env` block or the bridge runs, lists both tools, and answers every `_Stop`
  with `""` forever. `deploy/buzz/evie-hooks-mcp` bakes it in.
- **`buzz-acp` supports exactly ONE MCP server**, with `args: []` and an env it controls. Hence
  the `evie-hooks-mcp` wrapper (self-contained, zero args) — and hence the fact that under
  `buzz-acp` today you get hooks **or** `buzz-dev-mcp`'s shell/file tools, not both. Driving
  `buzz-agent` directly over ACP has no such limit. The fix for the deployed shape is the
  interposer in the plan's §4.1.

## The MCP interposer (W3 — blocking authority, built and verified)

`agent/harness/buzz-mcp-interposer.ts` is a stdio MCP server that Buzz launches **instead of**
`buzz-dev-mcp`. It spawns the real `buzz-dev-mcp` as a child and proxies JSON-RPC both ways, so
the agent keeps every tool it had — and gains the real `PreToolUse` hooks in front of every
`tools/call`. **A hook that denies means the call is never forwarded and the child never sees it.**
That is authoritative today, with no Buzz changes, because refusing to forward is something a
proxy can simply do (plan §4.1, option 2).

### Point Buzz at it

```bash
BUZZ_ACP_MCP_COMMAND=/Users/sgallant/software_development/projects/evie-ui/deploy/buzz/buzz-mcp-interposer
```

That path is a **zero-argument, self-contained** launcher, and it has to be: `buzz-acp`'s
`build_mcp_servers()` hardcodes `args: vec![]` and an env it controls, so neither `serve` nor
`EVIE_HARNESS_HOOKS` can be handed in. Everything is baked into the wrapper.

**It supersedes `evie-hooks-mcp` for any `buzz-acp`-driven agent.** `buzz-acp` passes exactly ONE
MCP server, which forced a choice between hooks and shell/file tools; the interposer is one server
that is both. Keep `evie-hooks-mcp` only where something else already provides the tools.

For `buzz-agent` driven directly (where args survive), `bun agent/harness/buzz-mcp-interposer.ts
--print-config` prints the `mcpServers` block.

### What it does, precisely

| Request | Behaviour |
|---|---|
| `tools/list` | The child's tools, **verbatim** — nothing renamed, reshaped or dropped. `EXTRA_TOOLS` in the module is the append point for tools we add later; it is empty today on purpose |
| `tools/call` (`shell`, `str_replace`, `read_file`, `view_image`) | Projected to Claude's tool + **argument** names, run through the shared `runHooks()`, then forwarded — or refused |
| `tools/call` (`todo`) | Deliberately ungated (no filesystem or process effect; no matcher selects `TodoWrite`) |
| `tools/call` (an unknown tool) | **Gated anyway.** No matcher names it, so it is fail-open by construction — but a tool added upstream can never arrive *exempt* |
| `tools/call` with **no `id`** | Gated like any other, and **dropped** rather than forwarded if a hook denies. A notification cannot be answered, but it can still ask for a tool to run; `buzz-dev-mcp` ignores one, a future child might not |
| `_Stop` / `_PostCompact` | Answered by evie's `runHooks()`, then **chained to the child's** so its open-todo text still reaches the agent. Governance arriving must not make the agent forget its todos |
| everything else | Passed through untouched |

The tool-name/arg projection lives with the others, in `agent/harness/projection.ts`
(`BUZZ_TOOL_PROJECTION`), and it is a **second table** rather than more rows in `TOOL_PROJECTION`
because `read_file` is a name in both surfaces and because Buzz's `read_file` and `view_image` both
land on `Read`. The arg rename is the load-bearing half: the hooks read `.tool_input.file_path` and
`.tool_input.command`, so renaming only the tool would ship a gate that matches nothing.

### The fail policy — split on purpose, and do NOT "fix" it

Exported as `FAIL_POLICY` so it can be asserted rather than inferred:

- **explicit hook deny → fail CLOSED.** The call is refused. So is an `ask`: this runtime is
  headless, and silently allowing an approval request would make Buzz *more* permissive than a
  Claude seat while looking governed.
- **a hook that errors, times out, is unreadable, or exits non-zero without a verdict → fail OPEN,
  loudly on stderr.** Plan §4.4: the interposer is a governance guard where a false refusal bricks
  legitimate work, so it proceeds when inconclusive. The relay `pre-receive` hook is the
  authorization boundary and refuses when inconclusive. They are deliberately opposite polarities.

  That last case used to be **silent**, which is the worst version of fail-open. Claude Code's
  contract makes any non-zero-but-not-2 exit a non-blocking allow, so a guard dying with `exit 127`
  was the same object as a guard that ran and approved. `parseHookOutput` now records `status` and
  `stderr` on such an allow — additively, verdict unchanged, a status-0 allow byte-identical to
  before — which is what lets the interposer say so, and mark the decision `hook-error` rather than
  `no-objection`. All three runtimes get the diagnostic.

A denial comes back as an MCP **tool** error (`isError: true`, text prefixed `EVIE POLICY DENY`,
plus a machine-readable `_meta["evie/policy"]`) rather than a JSON-RPC error, because that is the
channel whose content reaches the model — a reason string the agent never sees cannot do its job.
The action is refused either way; the child is never called.

### Prove it

```bash
bun test agent/harness/buzz-mcp-interposer.test.ts   # 61 unit tests, no Buzz needed
./deploy/buzz/verify-interposer.sh                   # 9 assertions against the REAL buzz-dev-mcp
```

`verify-interposer.sh` asserts at the **filesystem**, not at the reply string — the forbidden
command writes a sentinel and the test is that the sentinel is absent — and it runs the whole thing
a second time with `EVIE_HARNESS_HOOKS=0` to show the same command then *does* run. Without that
second pass, an unconditional refusal would look identical to a working gate.

### One bypass that already got through, so you know the shape

A tool call may omit `workdir`. Until the server set its own `projectCtx`, that produced a
**relative** `file_path` in the hook payload — and the two guards behave differently on one:

- `pre-enforce-worktree.sh` normalizes against the payload `cwd` and was **not** evaded. That is
  precisely why the hole hid.
- `pre-protect-governance.sh` matches absolute prefixes and does **not** normalize, so
  `str_replace {path: "hooks/pre-enforce-worktree.sh"}` with no `workdir` went straight past it and
  reached the child. Declaring `workdir` on the same call was denied.

The fix is one line in `buildInterposerContext` (`projectCtx: { worktreeRoot: cwd }`), and the
regression cover goes through **that function**, not a copy of it — every earlier projection test
passed `worktreeRoot` explicitly, which proved the projection *can* absolutize and never that the
running server *does*. The live verifier covers it too, at the filesystem.

⚠️ **Writing a test for this on macOS**: `mktemp -d` returns `/var/folders/…` while `process.cwd()`
returns the symlink-resolved `/private/var/folders/…`. A hook matching an unresolved prefix stops
matching for the server-cwd case only, which reads exactly like a bypass and is not one. The
verifier pins `pwd -P` once, up front.

### The one thing that can route around it

`buzz-agent`'s only in-process tool that bypasses MCP is `load_skill`, and it is read-only — which
is what makes gating the MCP boundary a *complete* gate rather than a partial one. Configure a
**second** MCP server, though, and the agent simply uses that one instead. Under `buzz-acp` that
cannot happen (one server, by construction); driving `buzz-agent` directly it can, so keep
`MAX_MCP_SERVERS` at one and pair with an allowlist.

## Files

```
install-buzz-dev.sh          one-time bootstrap; idempotent; never re-mints existing secrets
deploy-buzz-dev.sh           start / --restart-only / --stop / --status / --no-front-door
smoke-buzz-dev.sh            read-only; assertions incl. pairing; usable as a gate
lib/common.sh                guards, port-registry resolution, bad-port check, docker detection
lib/nostr-keygen.sh          secp256k1 x-only keypair via openssl (verified against the relay)
compose.loopback.yml         pins the relay to 127.0.0.1 (the bundle binds 0.0.0.0) — see evidence
compose.pairing.yml          NIP-AB pairing sidecar (same image, buzz-pair-relay) — see below
env/buzz-dev.env.template    rendered into <buzz>/deploy/compose/.env
launchd/buzz-relay-dev.sh    launchd wrapper (installed to ~/.config/dev-services/)
launchd/com.dev.buzz-relay.plist.template
agents/mint-agent-key.sh     one keypair per agent + buzz-admin add-member
evie-hooks-mcp               self-contained launcher for the hook bridge (BUZZ_ACP_MCP_COMMAND)
verify-hook-bridge.sh        drives a real buzz-agent + fake LLM; the W2 exit criterion
buzz-mcp-interposer          zero-arg launcher for the W3 interposer (BUZZ_ACP_MCP_COMMAND)
verify-interposer.sh         drives the launcher + the real buzz-dev-mcp; the W3 exit criterion
```

## Phone pairing (NIP-AB sidecar — why compose.pairing.yml exists)

Measured 2026-08-24: "start pairing" on the desktop died with
`WebSocket connection failed: HTTP error: 404 Not Found`. Chain of cause:

1. The desktop probes the relay's NIP-11 doc for `pairing_relay_url` — the
   designed discovery for the dedicated pairing relay. Our relay advertised
   none, because the sidecar was never deployed.
2. Fall back heuristic: NIP-43 in `supported_nips` ⇒ try `<relay>/pair` (a
   compatibility convention for *foreign* relays). Our relay advertises NIP-43
   because `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true` — NIP-43 means *relay
   membership* in this codebase, not pairing. `crates/buzz-relay/src/nip11.rs`
   knows about the collision ("advertising it on open relays misroutes pairing
   peers to a non-existent /pair sidecar") but membership mode advertises it
   legitimately, so the heuristic fires anyway.
3. `wss://…:6351/pair` → 404. The main relay has never had a `/pair` route.

The fix is the deployment shape the Helm chart already uses
(`deploy/charts/buzz/templates/pairing-relay.yaml`): run
`/usr/local/bin/buzz-pair-relay` from the same pinned image as a sidecar, and
advertise it. The sidecar is deliberately unauthenticated — a fresh phone has
no identity to NIP-42-auth with (the identity arrives *via* pairing); the
tailnet front door is its only boundary. Wiring:

- `compose.pairing.yml` — sidecar on loopback `BUZZ_PAIRING_PORT` (registry
  key `pairing`, 6358), in-container `0.0.0.0:5000`.
- `BUZZ_PAIRING_RELAY_URL=wss://<host>:<https-port>/pair` in the .env — the
  relay picks it up via upstream's `env_file: .env` and advertises it in
  NIP-11. Same host:port as the main relay on purpose: the phone is already
  admitted there by whatever tailnet ACL governs the relay, so no second ACL
  decision exists to forget.
- `tailscale serve` mounts `/pair` on the relay's https port → the sidecar's
  loopback port. This also makes the desktop's legacy `/pair` fallback
  resolve, since both paths now agree.
- `smoke-buzz-dev.sh` asserts the advertisement and a 101 WS upgrade both
  loopback and through the tailnet front door. NOTE: the tailnet probe must
  force `--http1.1` — over TLS curl negotiates h2 by ALPN, h2 has no Upgrade,
  and the check silently reads 200.

Upstream paper cut (not ours to fix locally): the desktop's NIP-43⇒`/pair`
heuristic conflates membership with pairing; on a membership relay without an
advertised `pairing_relay_url` it produces this 404 instead of a diagnosable
message.

## Next, once this is up

W4 in the plan: **relay-side governance** — the changelog rule and the HEAD-vs-`origin/main` rule
at `/internal/git/policy`, where the `pre-receive` hook is fail-closed and enforces for humans and
agents alike. W2 (the hook bridge) and W3 (the interposer) are built; see above.

Still open from §4.5: **approvals**. The interposer refuses an `ask` because there is nowhere to
send it. Buzz is good ground for the fix — a signed approval event by a named keypair is stronger
than our SQLite grant — but it is a design, not a port.

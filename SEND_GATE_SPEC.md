# Send-Path Gate — spec for coder

## The bug (context, do not re-derive)

One agent identity ran TWO LIVE pool slots with sessions on the same channel
(Sam's DM `c183da8e`). Both sessions answered Sam's mentions — four duets on
2026-09-11 (18:18, 18:36–18:51, 19:17, 19:19), one of them with the sibling
DENYING it was the duplicate, giving Sam three conflicting narratives. Full
evidence: memory `duplicate-evie-pools-2026-09-10.md`, `#general` thread
2026-09-11 (Evie's handoff + three spec-input messages), live claims file
`~/.buzz/WORKING_STATE/evie.claims.json`.

The dispatch-time guards from `claude/claim-router-fold` (Guard A in-pool,
Guard B claims-file, both in `dispatch_pending`, `crates/buzz-acp/src/lib.rs`
~line 3744) do NOT cover this shape: both sessions were already dispatched and
composing. A session that answers from a mention-wake reads no convention file
before it speaks (proven four times tonight). The gate must live on the SEND
path — the chokepoint every agent reply already passes through.

**Key architecture fact (verified):** agent replies are published by the child
session via the `buzz` CLI (`crates/buzz-cli/src/commands/messages.rs`,
`cmd_send_message` → `buzz_sdk::build_message` → relay). The harness does NOT
proxy sends. So: the harness WRITES ground-truth claims (it owns session
lifecycle in-process); the CLI ENFORCES them on send.

## Design — writer / enforcer / annex

### 1. Writer: harness dumps task_map as turn claims (`buzz-acp`)

New module `crates/buzz-acp/src/claims_writer.rs` (sibling of `claims.rs`;
keep `claims.rs` itself untouched — it is the Guard B reader and its contract
is pinned).

- **Turn claims** mirror `task_map`: one entry per in-flight prompt task —
  `{slot, channel, started_at, last_seen_at, acp_session}`. `slot` is a
  stable per-slot id `<boot-id>:<agent_index>`; generate one `boot-id`
  (Uuid) at harness startup.
  - Add `started_at: std::time::SystemTime` to `TaskMeta`
    (`crates/buzz-acp/src/pool.rs` ~line 59) and set it where the meta is
    inserted at dispatch (`lib.rs` `dispatch_pending` / heartbeat claim path).
- **Write points** (all in the main loop's thread of control — `pool` is
  exclusively owned there; do NOT introduce a side-thread writer):
  1. after a claim is granted in `dispatch_pending` (task inserted),
  2. after `handle_prompt_result` removes the task (turn over),
  3. a slow pulse (60 s) in the main loop that re-stamps `last_seen_at` for
     every live task — ONLY while `task_map` is non-empty (no churn on an
     idle pool). Find the existing interval arms in the main `select!` loop
     and add one in the same style; the re-stamp updates `last_seen_at` to
     now, so a live turn stays fresh and a dead harness's claims decay
     without any mtime heuristics.
- **File format** — read-modify-write of the existing JSON doc, ADDING a
  `managed` key, PRESERVING every other key byte-for-value:

```json
{
  "watching": ["…"],            // existing convention keys — NEVER touched
  "composing": null,            // NEVER touched
  "convention": "…",            // NEVER touched
  "yielded": { … },             // NEVER touched (policy annex)
  "blackout_log": [ … ],        // NEVER touched (policy annex)
  "managed": {
    "pool": "<boot-id>",
    "pid": 12345,
    "updated_at": "2026-09-12T00:40:00Z",
    "turns": [
      {"slot": "<boot-id>:0", "channel": "<uuid>",
       "started_at": "…", "last_seen_at": "…", "acp_session": "…"}
    ],
    "superseded": [
      {"channel": "<uuid>", "holder": "<boot-id>:0",
       "by": "<boot-id>:1", "at": "…"}
    ]
  }
}
```

- **Preservation is the contract** (Evie's pin #1): deserialize to
  `serde_json::Value`, mutate/insert only `managed`, serialize back. A
  malformed doc the writer cannot parse as JSON: write a fresh doc containing
  ONLY `managed` plus the original raw text under `"_unparseable_before"` —
  never silently destroy policy text. `yielded` / `blackout_log` /
  `convention` must survive every write (this is tested).
- **Atomicity** (Evie's pin #1): write to `.<name>.tmp` in the same
  directory + `std::fs::rename` (atomic on macOS/Linux). Around the full
  read-modify-write cycle take an advisory `flock` on a sidecar
  `<name>.lock` file (create if missing; `libc::flock` — check `libc` is
  already in the workspace deps before adding anything; if it is not,
  `rustix`-free std spinlock via `create_new` retry is NOT acceptable —
  report and use `libc`). Same lock discipline in the CLI (below) — one
  protocol, both sides.
- **Path resolution:** reuse the `claims.rs` rules
  (`BUZZ_ACP_CLAIMS_FILE` override → `$HOME/.buzz/WORKING_STATE/<slug>.claims.json`,
  slug from `BUZZ_ACP_DISPLAY_NAME` via the existing `agent_slug()`). One
  difference from the reader: the WRITER may create the file when it does not
  exist (expose a `resolve_claims_file_for_write()`); the reader's
  exists-check semantics stay exactly as they are.
- **Slot env injection:** pass `BUZZ_ACP_SESSION_ID=<boot-id>:<agent_index>`
  in `extra_env` at the production spawn site (`spawn_and_init`,
  `lib.rs` ~5314 — note it already takes `agent_index`). Respect the
  operator-wins rule used by `AcpClient::spawn` (don't fight an
  already-set var — but this key is harness-owned; set it unconditionally in
  the `extra_env` slice the CALLER builds, and document that).
- **Env flag kill-switch:** `BUZZ_ACP_CLAIMS_WRITER=0` disables the writer
  entirely (ops escape hatch; default on). The reader/gate side keys on the
  file, not the flag.

### 2. Enforcer: gate + stamp + supersede (`buzz-cli`)

New module `crates/buzz-cli/src/claims_gate.rs`.

**Activation condition:** the gate is active for a send only when BOTH
`BUZZ_ACP_SESSION_ID` (managed session) is set AND a resolvable claims file
exists. Otherwise: pass-through, no I/O beyond the existence check. The CLI
is unmanaged for humans and ad-hoc shells — never gated. Until a pool runs
the new writer, `managed` is absent → the gate no-ops (this is the staged
rollout: CLI ships first as a no-op).

**The check** (`cmd_send_message`, before building/signing, for kinds
9 / 45001 / 45003):

- Read the file (under the same sidecar flock; fail-open on missing,
  unreadable, malformed, unparseable timestamps → send proceeds, log at
  `debug`/silent — a wedged claims file must never wedge a DM).
- Collect `managed.turns` where `channel == target` AND `slot != self` AND
  `last_seen_at` within **10 minutes** (constant, mirroring
  `claims::COMPOSING_TTL_SECS`).
- Void any claim that has a matching fresh `managed.superseded` entry
  (same channel + holder).
- If any claim survives → **bounce**.

**Gate composing, not watching** (Evie's pin #2): only `managed.turns`
entries gate. `watching` / `composing` / annex keys are coordination policy
— the gate never reads them. The watcher+composer room-sharing pattern is
preserved.

**Bounce is terminal, not transient** (Evie's pin #2): emit a structured
error that no reasonable agent reads as retry-shaped:

- New `CliError::Held` variant (exit code **6**; document in the CLI's exit
  code table). stdout/stderr JSON:
  `{"held": true, "channel": "…", "holder_slot": "<boot-id>:0",
    "claim_age_secs": 42, "ttl_secs": 600, "supersede_command": "buzz messages send … --supersede",
    "advice": "This is a hold, not a failure. Another session of you is mid-turn in this channel. Stand down — a bounce answers 'should I speak?' and no is a complete reply."}`
- The human-readable stderr line carries the same three facts the spec
  promises: holder slot-id, claim age, channel.
- The `advice` string IS the agent-side convention, self-describing at the
  point of failure. Also add one paragraph to `cmd_send_message`'s clap
  `long_about`/docs and to `crates/buzz-cli` docs where exit codes are
  listed (find the existing table).

**`--supersede` flag** (documented dead-holder escape, Evie's pin #3):
`buzz messages send --supersede …` skips the hold check for THIS send and,
under the flock, appends `{channel, holder, by: self-slot, at}` to
`managed.superseded` (prune to the most recent 20) before publishing. The
supersede record is itself stamped with the superseding slot — worst-case
arbitration is inspectable from any client. If the writer is dead (file
stale), supersede still works: it is a CLI write, not a harness write.

**Identity stamp** (Evie's pin #4): when `BUZZ_ACP_SESSION_ID` is set,
append `["session", "<slot>"]` to the outgoing event's tags for kinds
9 / 45001 / 45003. `buzz_sdk::build_message` takes `media_tags` as its last
parameter — extend the CLI to append the session tag to the tags slice it
passes (do NOT change `build_message`'s signature; the SDK builder is
`allow_self_tagging` and relays store arbitrary tags — verify tag
passthrough with one look at relay event validation, and note where you
checked). Also surface `session_slot` in the CLI's success JSON output.

### 3. What must NOT change

- `crates/buzz-acp/src/claims.rs` reader semantics, TTLs, and its tests —
  Guard B contract is pinned, including the live-writer-shape test.
- Guard A / Guard B dispatch behavior in `lib.rs`.
- The convention keys (`watching`, `composing`, `convention`, `yielded`,
  `blackout_log`, and any future annex keys) — preserved untouched by the
  writer.
- `try_claim` Pass 1/Pass 2, queue internals, heartbeat path.
- Human/unmanaged CLI sends: zero new behavior when the env is absent.

## Tests (each must be shown to fail against the unguarded code first)

`buzz-acp`:
1. Writer preserves annex: pre-seed a claims file with
   `watching`/`composing`/`convention`/`yielded`/`blackout_log` (use the LIVE
   shape from `~/.buzz/WORKING_STATE/evie.claims.json` 2026-09-11 19:26 as
   the fixture), run a write → all pre-existing keys byte-for-value intact,
   `managed` added. Mutation: replace read-modify-write with fresh-doc
   overwrite → test fails.
2. Writer atomicity: concurrent writes (two tasks racing through the flock)
   never interleave — file always parses, last writer wins. Mutation: drop
   the flock → torn/interleaved doc possible (assert parse-after-every-write
   in a loop).
3. Pulse re-stamp keeps a live turn fresh and clears it after turn end:
   claim present while task in `task_map`, `last_seen_at` advancing; gone
   after `handle_prompt_result`. Mutation: remove the turn-end write →
   stale claim persists.

`buzz-cli`:
4. Gate bounces on fresh foreign turn claim: managed env set, claims file
   with `managed.turns` entry (other slot, channel C, `last_seen_at` now) →
   `cmd_send_message` returns `Held` (exit 6 shape), no network call (assert
   the client is never invoked — use the existing test seam for the client
   or factor the gate into a pure function and test THAT; prefer the pure
   `evaluate_hold(claims_json, channel, self_slot, now) -> Option<Hold>`.
   Mutation: disable the check → no Hold.
5. Stale claim does not bounce (`last_seen_at` 11 min old).
6. Own-claim does not bounce (same slot id).
7. Superseded claim does not bounce (matching `managed.superseded`).
8. Fail-open: malformed JSON, missing file, absent `managed` key → no hold.
   Unmanaged (env unset) → no file I/O beyond exists-check (assert via the
   pure-function split: gate not even consulted).
9. Stamp: with env set, the built event carries `["session", "<slot>"]`;
   without, it does not. (Test the tag-append helper.)
10. Supersede write: appends + prunes to 20 under flock; preserves annex
    keys.

## Build & verify

- `cargo check -p buzz-acp -p buzz-cli` then
  `cargo test -p buzz-acp` and `cargo test -p buzz-cli` — FULL crates, never
  a scoped single-module run. Quote both summary lines.
- `cargo clippy -p buzz-acp -p buzz-cli` — no new warnings.
- Style: match the tracing voice of `claims.rs`/`lib.rs`; doc comments on
  new public API; no `unsafe`; no new `unwrap()`/`expect()` in production
  paths; no new dependencies unless the flock note above forces `libc` (then
  justify it in the report).

## Sequencing (context — do not implement, just do not break it)

spec merge → CLI ships (no-op) → voluntary writers stand down (Evie, ops) →
pool restart (Sam's go) → writer activates. The writer must therefore be
SAFE to run alongside voluntary writers from day one (it is:
read-modify-write + preserve + atomic rename), and the CLI must be safe
BEFORE any writer exists (it is: no `managed` key → no-op).

## Infra context

Read first:
/Users/sgallant/claude-glm/projects/-Users-sgallant--buzz/f9342119-f2c2-4d99-8d9a-6ad8cd90076c/tool-results/hook-bf74911a-cf74-4616-9a68-8354be5c618f-stdout.txt
(infrastructure rules — applies to you fully).

You are the worker: do the reading, edits, and test runs yourself; do not
spawn further agents.

Work IN THIS worktree (your cwd):
/Users/sgallant/software_development/.evie-worktrees/buzz-send-gate
(branch `claude/send-path-gate`, based on main @ 8f13628a9). FIRST ACTION:
run `pwd && git rev-parse --show-toplevel && ls SEND_GATE_SPEC.md` — if that
is not this worktree, STOP and report instead of proceeding. Commit with a
conventional message and `-s` (DCO). Repo rules are in `AGENTS.md` at the
worktree root — read it before editing.

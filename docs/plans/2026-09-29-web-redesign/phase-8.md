# Phase 8 — Agent task status: backend design (kind, ACP, CLI)

Architect design for the backend half of Phase 8 in
[`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md). Line refs are
to `df7363b9a`. Implementation seat: `coder`. Work-tab rendering is the
designer's; this doc fixes what it reads.

## Decisions

| # | Decision | Why |
|---|---|---|
| D8.1 | **New addressable kind `30624` = Agent Task Status.** Do **not** reuse job kinds 43001/43003/43004. | The job kinds (`kind.rs:643–653`; the brief's `634–644` is stale) are *regular* events. Every turn would append 2 or more rows forever, and the Work tab would fold a growing stream. Their protocol meaning (a job requested by a third party, auth chains) also doesn't fit a harness reporting its own turn. They are unwired too: there is no `required_scope_for_kind` arm, so reuse would save no relay work. An addressable head per (agent, channel) holds the current state in one row, is served in one query, and is replaced in place. Keep 43xxx for a future job protocol. |
| D8.2 | **Two `d` namespaces under one kind.** `turn:<channel uuid>` is written **only by ACP** (lifecycle). `detail:<channel uuid>` is written **only by `buzz status set`** (title/progress). Both carry the same `turn` id. | This removes every read-modify-write race between the harness and the agent. The harness never has to read the agent's title, and the CLI never overwrites lifecycle. |
| D8.3 | **Detail binds to a turn.** The CLI reads the current lifecycle head and stamps its `turn` id. Clients show detail **only when `detail.turn == lifecycle.turn`**. | Honesty (VISION_ACTIVITY): a title from a previous turn can never show on a new turn. The `buzz` subprocess can't learn the turn id from its env, because the agent process env is fixed at spawn. |
| D8.4 | **`h`-scoped.** `h` = the turn's channel, so channel members read it through the existing channel gating (the same mechanism as Phase 5 D5.2). Heartbeat turns (no channel) publish nothing. | Observer frames 24200 stay owner-only and unchanged. This is the member-readable projection. |
| D8.5 | **Staleness is shown, not hidden.** While a turn runs, ACP re-publishes the lifecycle head every **60 s**. Clients render `running` whose `created_at` is older than **180 s** as "stalled — no heartbeat". | This covers a harness `kill -9` for non-owner readers, who don't get the observer frames' liveness. It runs on its own ticker, so it still works when `BUZZ_ACP_TURN_LIVENESS_SECS=0`. |
| D8.6 | **Monotonic `created_at`.** One `StatusClock` per turn: `next = max(now_secs, last + 1)`. | Status submits are spawned tasks and can arrive out of order. The relay's addressable stale-write protection then keeps the terminal head, because its `created_at` is always the highest. |
| D8.7 | **Terminal state from the drop guard.** `TurnCompletionGuard` gains an outcome slot. `run_prompt_task` sets it on the known paths. If it's unset at drop, the result is `error` (a panic, or an unhandled path). | This covers every exit path, the same reason the guard exists for `turn_completed`. |
| D8.8 | **Startup sweep.** When the pool starts, ACP queries its own `{"kinds":[30624],"authors":[self],"limit":500}`. Every `turn:*` head still `running` gets an `error` head with `["reason","harness-restart"]`. | Without it, a restarted harness leaves "running" heads that only age into "stalled". |
| D8.9 | Scope `Scope::MessagesWrite`. Best-effort publishing: a 3 s timeout, a WARN on failure, and it never fails a turn. | Same posture as the 44200 metric (`pool.rs:5410`). |

"Done today" for non-owners becomes a query for terminal `turn:` heads with
`since` = local midnight. That resolves the Phase 1 caveat that 44200 is
owner-encrypted.

## Wire format — kind 30624

**Lifecycle (ACP):**
```jsonc
{ "kind": 30624, "content": "",
  "tags": [
    ["d", "turn:<channel uuid>"],          // exactly 1; uuid MUST equal h
    ["h", "<channel uuid>"],               // exactly 1, UUID
    ["turn", "<turn_id>"],                 // exactly 1, 1..=128 of [A-Za-z0-9._:-]
    ["state", "running"],                  // exactly 1: running | done | error | cancelled
    ["started", "1759190400"],             // exactly 1, unix secs
    ["ended", "1759190500"],               // exactly 1 iff state != running; absent while running
    ["e", "<first triggering event id>", "", "trigger"], // optional, at most 1, 64 lowercase hex
    ["session", "<pool slot index>"],      // optional, <= 32 chars; ACP's slot (`agent.index`, pool.rs:2458)
    ["reason", "harness-restart"]          // optional, only with state=error, <= 64 chars
  ] }
```

**Detail (`buzz status set`):**
```jsonc
{ "kind": 30624, "content": "<optional note, <= 2 KiB>",
  "tags": [
    ["d", "detail:<channel uuid>"], ["h", "<channel uuid>"], ["turn", "<turn_id>"],
    ["title", "Fix composer draft loss"],  // optional, <= 120 chars
    ["progress", "2", "3"]                 // optional; integers, 0 <= done <= total, 1 <= total <= 100
  ] }                                      // at least one of title/progress required
```

Rejections are prefixed `invalid: task-status: <rule>`.

**Client rule** (normative; implemented in the web by the designer):
1. Group by `(author, h)`.
2. `L` = the `turn:` head, `D` = the `detail:` head.
3. Row state is:
   - **Running** if `L.state=running` and `now − L.created_at ≤ 180`.
   - **Stalled** if `L.state=running` and it's older than that.
   - Otherwise **Done / Error / Cancelled**, taken from `L.state`.
4. Show title and progress only if `D.turn == L.turn`.
5. Queries: Everywhere = `{"kinds":[30624],"since":now−86400}`; This channel adds
   `#h`.

## File-by-file change map

**`crates/buzz-core`**
- `src/kind.rs`: `KIND_AGENT_TASK_STATUS: u32 = 30624`, next to
  `KIND_ITEM`. Add `ALL_KINDS` and the const asserts. *(Shared reservation
  commit. See [phase-5.md § Merge order](phase-5.md#merge-order-phases-5-6-and-8).)*
- **New** `src/task_status.rs`: enums `TaskState`, `StatusNamespace`;
  `validate_task_status_event(&Event)`; `parse_task_status(&Event) -> TaskStatusHead`.
  Register it in `lib.rs`. This is the single validator, used by relay, SDK and
  CLI.

**`crates/buzz-relay`**
- `src/handlers/ingest.rs`:
  - Add an arm `KIND_AGENT_TASK_STATUS => Ok(Scope::MessagesWrite)` directly
    **after** the `KIND_AGENT_TURN_METRIC` arm (:456). That's a different hunk
    from Phase 5's arm at :541.
  - Add the validator dispatch right after the `KIND_AGENT_TURN_METRIC` block
    (:3131–3166).
  - Don't touch the global-only or h-required lists. `h` is required *by the
    validator*, not by `requires_h_channel_scope`. That keeps the list diff
    zero and the error message kind-specific.
- **New** `src/handlers/task_status_ingest.rs`: maps the rejection to
  `IngestError::Rejected`.

**`crates/buzz-sdk`**
- **New** `src/task_status.rs`: `build_task_lifecycle(channel, turn_id, state, started, ended, trigger, session, reason, created_at)`
  and `build_task_detail(channel, turn_id, title, progress, note, created_at)`.
  Both self-validate through `buzz_core::task_status`.

**`crates/buzz-acp`**
- **New** `src/task_status.rs`:
  - `trait TaskStatusSink: Send + Sync { fn publish(&self, ev: nostr::Event); }`.
    The prod impl spawns `rest_client.submit_event` with a 3 s timeout, copying
    `publish_agent_turn_metric` (`pool.rs:5354–5426`). Tests use a recording
    sink.
  - `struct StatusClock(AtomicU64)`.
  - `struct TurnStatusPublisher { sink, keys, channel, turn_id, started, trigger, session, clock }`
    with `running()`, `refresh()` and `terminal(state, reason)`.
- `src/pool.rs`, `run_prompt_task` (:2447):
  - After `observe("turn_started")` (:2476–2487), and only for
    `PromptSource::Channel`: build a `TurnStatusPublisher` and call
    `running()`. `trigger` = the first `triggering_event_ids` entry.
  - Pass it into `TurnCompletionGuard::new` (:2494). Add fields
    `status: Option<TurnStatusPublisher>` and
    `outcome: Arc<Mutex<Option<TaskState>>>`.
  - Set `outcome` where the prompt result is classified (the existing
    StopReason / error / timeout / cancel handling that feeds
    `acp_stop_to_core`, :5225):
    - EndTurn / MaxTokens / MaxTurnRequests / Refusal → `done`
    - Cancelled → `cancelled`
    - timeout / error → `error`
  - `TurnCompletionGuard::drop` (:5210): after emitting `turn_completed`, call
    `status.terminal(outcome.unwrap_or(Error))`. Use
    `tokio::runtime::Handle::try_current()`; if there's no runtime, log a WARN
    and skip.
  - Spawn a status-refresh future beside `run_turn_liveness` (:5082), with an
    interval of `STATUS_REFRESH = 60s`. It shares the same close-flag pattern as
    `LivenessState`/`LivenessGuard` (:5126–5180), so a refresh can't be
    *emitted* after the guard closes. Out-of-order *arrival* is handled by
    D8.6.
- `src/lib.rs`: the startup sweep (D8.8), at pool start where the relay
  connection is established. Use `RestClient::query` (`relay.rs:417`).

**`crates/buzz-cli`**
- `src/lib.rs`: `Status(StatusCmd)` with `Set { --channel, --title, --progress <done/total>, --note }`.
- **New** `src/commands/status.rs`, `buzz status set --channel <uuid|#slug|name> [--title …] [--progress 2/3] [--note …|-]`:
  1. Resolve the channel.
  2. Fetch the own lifecycle head `{"kinds":[30624],"authors":[self],"#d":["turn:<ch>"]}`.
  3. If there's no head or `state != running`, exit **1** with "no running turn in
     this channel". That stops status claims made outside a turn.
  4. Publish detail with that `turn`. Output `{event_id, accepted, message, turn}`.

**Base prompt** (`buzz-acp/src/base_prompt.md`), landed with this phase:
1. Add a CLI table row: `| \`buzz status\` | \`set\` |`.
2. Add a bullet under `### General` (:69):

> - Your running/done state is published for you automatically. For long work, add a title and progress people can read at a glance: `buzz status set --channel <current-channel-uuid> --title "<what you are doing>" --progress 2/5`. Update progress only when a step is actually finished — never estimate ahead.

## Test contract

Commit before mutating, and `touch` after restoring (AGENTS.md gotcha 9). Run
ACP tests with the three `BUZZ_ACP_*` vars unset (AGENTS.md gotcha 7).

| Test | Asserts | Mutation it must catch |
|---|---|---|
| `buzz-core task_status.rs::kind_is_addressable_30624` | hardcoded `30624` | change the constant |
| `::rejects_d_channel_mismatch` | `d=turn:<A>`, `h=<B>` rejected | drop the equality check |
| `::rejects_ended_while_running` / `::requires_ended_when_terminal` | both rejected | drop either rule |
| `::rejects_progress_done_gt_total` / `::rejects_total_zero` | rejected | loosen the bounds |
| `::detail_requires_title_or_progress` | an empty detail is rejected | drop the rule |
| `buzz-relay ingest.rs::task_status_requires_messages_write_scope` | `Ok(MessagesWrite)` | delete the arm |
| e2e `buzz-test-client/tests/e2e_task_status.rs::member_reads_agent_status_non_member_cannot` | an agent in a private channel publishes; a member sees it, a non-member doesn't (kind query, `ids`, live) | store with `channel_id=None` |
| e2e `::older_created_at_does_not_replace_terminal` | done@t+2, then running@t+1 → the head stays done | the stale-write check. Positive control for D8.6 |
| ACP `pool.rs::status_running_then_done_on_end_turn` (recording sink) | exactly `[running, done]`, the same `turn`, strictly increasing `created_at` | remove the drop-guard publish |
| ACP `::status_error_when_outcome_unset_at_drop` | a panic or unset path yields `error` | default to `done` |
| ACP `::status_cancelled_on_cancel` | `cancelled` | map Cancelled→done |
| ACP `::no_status_for_heartbeat_turn` | the sink stays empty for `PromptSource::Heartbeat` | publish unconditionally |
| ACP `::no_refresh_after_guard_drop` (paused tokio time, same shape as `test_liveness_stops_before_completion_frame` :8377) | the last published head is terminal | skip the close-flag check |
| ACP `::refresh_runs_with_liveness_disabled` | a refresh is published at 60 s with `turn_liveness_interval=0` | hang the refresh off the liveness ticker |
| ACP `::status_clock_is_strictly_monotonic` | three publishes in the same second → t, t+1, t+2 | return `now` |
| ACP `::startup_sweep_marks_stale_running_as_error` | a fixture head `running` → an `error` head with `reason=harness-restart` | skip the sweep |
| CLI `commands/status.rs::set_refuses_without_running_turn` | exit 1 | publish anyway |
| CLI `::set_stamps_lifecycle_turn_id` | `detail.turn == lifecycle.turn` | generate a fresh id |
| `buzz-acp lib.rs::shared_base_prompt_teaches_status_set` | the prompt contains `buzz status set --channel` | delete the bullet |

**Live check** (crichton relay, private test channel, the harness built from
the worktree):
1. Mention a managed agent. Within 5 s a `turn:` head with `state=running` is
   visible from a second member identity (`POST /query`).
2. Have the agent run `buzz status set --progress 1/2`. The detail appears
   within 2 s with a matching `turn`.
3. When the turn ends, the head is `done` with `ended`.
4. `kill -9` the harness mid-turn. The head goes stale (older than 180 s). On
   restart, the sweep writes `error`.

## Acceptance

1. A scripted turn produces Running → Done with no agent-side code, and a
   non-owner channel member can read it.
2. `buzz status set` progress is readable within 2 s. The detail never shows
   against a later turn.
3. A killed harness shows as stalled within 180 s, and as `error` after the
   restart sweep.
4. The Rust lanes pass: `cargo test -p buzz-core -p buzz-sdk -p buzz-cli -p buzz-relay`,
   `env -u … cargo test -p buzz-acp`, `just test`, and clippy + fmt.

## Restarts

- **Relay:** `./deploy-dev.sh`. The old relay rejects 30624 as an unknown kind.
  ACP publishing is best-effort, so a lagging relay only drops status.
- **`buzz-acp`:** `cargo build --release -p buzz-acp`, then restart every
  managed agent. Emission is compiled in.
- **CLI:** rebuild the installed `~/.local/bin/buzz` for `buzz status`.

## Risks

- **Write volume.** One replace per turn start and end, plus one every 60 s per
  running turn. With about 10 agents that's under 1 write/s. Acceptable. Don't
  lower `STATUS_REFRESH` without measuring it.
- **Drop-time spawn.** Spawning from `Drop` during a runtime shutdown loses the
  terminal head. The sweep (D8.8) is the backstop.
- **Clock skew between hosts** doesn't matter. Both `d` namespaces are written
  by processes on the agent's host, and binding is by turn id, not by time.
- **Agents in open channels they haven't joined** can still publish: the
  open-channel write fallback is `ingest.rs:786`. That's consistent with how
  they post messages.

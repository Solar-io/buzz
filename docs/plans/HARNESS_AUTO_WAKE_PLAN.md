# Harness auto-wake: background work, restarts, and session ownership

Status: plan. Not implemented.
Date: 2026-10-06. Author: architect (Opus 5.5). Base: fork `main` @ `2ee698216`.

Problem (diagnosed 2026-10-06 from live transcripts): managed Claude Code seats end a
turn to wait for background work, and nothing wakes them again. There are three causes:

1. Background subagents and background processes. When the work finishes, the seat is
   woken only if its ACP session is still alive.
2. Restarts. A restart gives the seat a fresh session with no history, and no
   restart-time wake reaches seats that were idle and waiting.
3. Base prompt. The `[Base]` text tells a fresh session that earlier work belongs to
   "a different session of you".

---

## 1. Summary

The diagnosis needed two corrections once the code was read. Both change the design.

- **When the session is alive, the wake already works.** Claude Code turns a
  `<task-notification>` into its own follow-up turn inside the live process.
  Evidence: transcript `~/.claude/projects/-Users-sgallant--buzz/88c18118-….jsonl`.
  At 2026-10-06T18:06:40Z it records `origin.kind = "task-notification"`, and the
  seat goes on working without a Buzz event. Acid Burn's `ea2fc754-…jsonl` shows the
  same thing at 19:35:50Z.
  **The failure is that the session dies before the work finishes.** Three things kill
  it: a respawn (idle timeout, exit, or quota), a harness restart, or an app restart.
  Background Bash and subagents die with the process group.
- **The harness itself kills sessions that are waiting on background subagents.**
  `claude-agent-acp` 0.79.0 keeps `session/prompt` open while a background subagent is
  live. The buzz-acp idle timer (900 s) treats that silence as a hang. It cancels the
  turn, respawns the process, and kills the subagent.
  Live instance: Acid Burn launched `Agent run_in_background=true` at 19:35:16Z
  (`0a51f24a-…jsonl`). The harness log
  `agents/logs/a60b7db8…log:6435-6437` then shows: 19:53:23Z idle timeout (900 s),
  requeue, respawn of agent 0.

There are three fixes, smallest first:

| # | Fix | Where |
|---|---|---|
| F3 | Rewrite the base prompt's Session Model section: earlier work in this channel belongs to this session | `crates/buzz-acp/src/base_prompt.md` |
| F1 | Do not idle-time-out a turn that is held for a background subagent. The 12 h hard cap still applies | `crates/buzz-acp/src/acp.rs` |
| F2 | Resume journal. Record each turn and each live background task durably. When a session is lost (respawn, harness restart or app restart), deliver one resume turn to that channel | new `crates/buzz-acp/src/resume.rs`, plus hooks in `acp.rs`, `pool.rs`, `lib.rs` |

F2 uses the same pattern as the existing auth-parking journal (`auth_parking.rs`) and
the existing requeue framing (`queue.rs` `CancelReason`). It adds no new wire kinds,
relay changes or desktop changes.

---

## 2. Code paths per cause (fork `main` @ 2ee698216)

### Cause 1: background work finishes after its session has died

| Fact | Citation |
|---|---|
| The harness reads agent stdout only while a request is in flight. Between turns nobody reads, so between-turn `session/update`s stay in the pipe until the next prompt | `crates/buzz-acp/src/acp.rs:1451` `read_until_response`, `:1514` `session/update` arm |
| A helper for draining buffered lines exists but nothing calls it | `acp.rs:1400` `drain_stale_responses` (`#[allow(dead_code)]`) |
| The harness does not advertise the AIR `asyncTasks` capability. The adapter therefore never emits `async_task_spawned` / `async_task_state_update`, so the harness cannot tell that background work is outstanding | `acp.rs:491-512` `build_client_capabilities`; adapter `dist/async-tasks.js:2-4,347-430`, `dist/air-extension.js:7-10,50-60` (`_meta.jetbrains.air = {version:1, capabilities:[…]}`) |
| The adapter holds the prompt open for live background subagents. Background shells are never held | adapter 0.79.0 `dist/acp-agent.js:240-246` `isHeldOpen`/`deferredSettle`, `:2232-2248` `turnAwaitingSubagents` |
| The idle timer resets only on stdout lines, so a quiet held turn trips it | `acp.rs:1640` (doc comment), `:1677` `read_until_response_with_idle_timeout`; default `config.rs:28` `DEFAULT_IDLE_TIMEOUT_SECS = 900` |
| An idle timeout cancels the turn, respawns the process (killing every session and background child on it) and requeues the batch | `pool.rs:3713-3747` ("Timeout triggers respawn"), `lib.rs:4956-4990` (respawn on `Timeout`/`AgentExited`), `pool.rs:5067` `requeue_batch_if_queue` |
| Idle sessions on a respawned slot are dropped with no requeue, because they have no batch | `lib.rs:4956+`, `pool.rs` `AgentState::invalidate_all` |
| Detached `nohup`/`&`/`setsid` children produce no notification at all, and Claude Code reaps them about 2 min after the call | Out of harness reach. See F3 prompt line and Open question 6 |
| Before 2026-10-04, the codex path booked its own wake: on job end it booked a due-now buzz-services reminder that mentions the launching key | `~/.claude/scripts/codex-work.sh:214-238` → `buzz-services/src/reminders/cli.ts add --at +0m --mention <self>` |

### Cause 2: restarts

| Fact | Citation |
|---|---|
| Nothing durable survives a harness restart except auth-failed turns | `lib.rs:1908-1918` `startup_event_queue` loads only `load_auth_parked`; `auth_parking.rs:1-2,23-34` |
| The relay does not replay events from before startup | `lib.rs:2033-2042` startup watermark; `relay.rs:1146-1159` `channel_since`, `:1280-1293` |
| Every session after a restart is a fresh `session/new`. The harness never calls `session/load` | `acp.rs:792` |
| Shutdown cancels in-flight prompts and persists nothing | `lib.rs:3648-3697` |
| The only restart-aware code marks the previous process's `running` kind-30624 heads as `error`/`harness-restart`. It does not wake anyone, and no consumer reacts to it | `task_status.rs:1-12,305-388`; `lib.rs:2290-2299` |
| Desktop restore spawns harnesses lazily. Its own comment says a mid-turn session is not resumed | `desktop/src-tauri/src/managed_agents/restore.rs:342-354` |
| The "resume" that does exist is in-process only. A batch whose turn hit `Timeout`/`AgentExited` is requeued and re-delivered after respawn. It is lost if the harness process itself dies | `lib.rs:4836` `queue.requeue(batch)` |
| A lazy pool wakes on queued work, so batches replayed from a journal will wake it | `lib.rs:2522-2526` `queue.has_flushable_work()` |

The diagnosis said the resume message reaches mid-flight turns and skips idle-waiting
seats. In code it is narrower than that. Only the in-process requeue exists. After a
**harness or app restart**, neither mid-flight seats nor idle-waiting seats receive
anything.

### Cause 3: base prompt

| Fact | Citation |
|---|---|
| The text is compiled in, so a fix needs a harness rebuild | `crates/buzz-acp/src/base_prompt.md:3-7`, `lib.rs:2262` `include_str!` |
| Nothing in `~/Library/Application Support/xyz.block.buzz.app/agents/` contains it; it only arrives as `[Base]` | grep, 2026-10-06 |
| Upstream deleted the section in `674c173eb` (block/buzz#6732, 2026-08-31). The fork is 313 commits behind `origin/main` | `git log -S "leave execution with the owning session" origin/main` |
| An env override replaces the whole prompt. It works as an interim fix without a rebuild, but is not recommended | `config.rs:439` `BUZZ_ACP_BASE_PROMPT_FILE` |

---

## 3. Design

### F3: base prompt (ship first: it is text only, independent, and has the least risk)

Replace `base_prompt.md:3-7` with:

```markdown
## Session Model

You are one per-channel session of your agent identity. Sessions share your core memory, your workspace on disk, and the relay; they do not share conversation context.

Earlier work in this channel is yours. Sessions restart and lose their context, so if the thread or your workspace shows you started something here — a plan, a build, a background job — this session owns it now: rebuild state from the thread, workspace, and memory, and carry it on. Work started in a different channel belongs to that channel's session; leave it there unless asked to take it over.

Long-running work must use your tool's background mode so its completion re-enters this session. A detached process (`nohup`, `&`, `setsid`) cannot wake you.
```

The last paragraph is optional (Open question 6). Line 81 ("resume silently") stays.

### F1: do not idle-kill held background turns

In `AcpClient`, record which turns are background-held:

- In `handle_session_update` (`acp.rs:2175`), set `turn_has_background_subagent = true`
  when a `tool_call` update carries `rawInput.run_in_background == true`. Phase 0
  confirms the field name on 0.79.0.
- In `read_until_response_with_idle_timeout` (`acp.rs:1677`), once that flag is set the
  idle deadline becomes `background_idle_timeout`. The flag resets when the turn starts.
- Add `--background-idle-timeout` / `BUZZ_ACP_BACKGROUND_IDLE_TIMEOUT`. The default is
  7200 s (Open question 3). `0` restores today's behaviour. The value is clamped below
  `max_turn_duration`, which keeps the invariant at `config.rs:1141`.
- Steering still works into a held turn, so the seat stays responsive to people while
  it waits.

**Trade-off.** A stuck subagent now holds the slot for up to 2 h instead of 15 min.
That is better than the alternative: today the harness kills real work on every silent
step longer than 15 min (a long build, for example).

### F2: resume journal

**Store.** `resume.rs` follows the `auth_parking.rs` pattern. The file is
`$BUZZ_ACP_RESUME_FILE`, defaulting to `~/.buzz/WORKING_STATE/resume/<pubkey>.json`,
alongside `auth-parked/`. `BUZZ_ACP_RESUME=0` disables the feature. Writes are atomic:
write a temp file, then rename. A corrupt or missing file logs a warning and is treated
as empty, as in `auth_parking.rs:94-98`. There is one entry per channel:

```json
{ "channel_id": "…", "kind": "in_turn" | "background",
  "events": [SavedEvent…],            // the batch's original signed events (auth_parking::SavedEvent)
  "tasks": [{ "id": "…", "title": "…", "output_file": "…?", "tool_call_id": "…?" }],
  "recorded_at": 1696600000, "resumes": 0 }
```

**Detecting outstanding work.** Advertise
`_meta.jetbrains.air = {version: 1, capabilities: ["asyncTasks"]}` in
`build_client_capabilities`. Adapters that do not know `_meta` keys ignore them.
`handle_session_update` then keeps a per-session map of live tasks:

- `async_task_spawned` adds a task.
- `async_task_state_update` with a terminal state removes it.

Subagents need no tracking. While one is live, the prompt is held (F1), so the turn is
still `in_turn`.

**Write points.**

| Event | Journal action | Site |
|---|---|---|
| Batch dispatched | Upsert `in_turn` with the batch's events, `resumes` kept. This is write-ahead, so it also survives SIGKILL | `pool.rs:2566` `run_prompt_task` entry |
| Natural completion with live tasks for the session | Convert to `background` with those tasks | `pool.rs:3617` |
| Natural completion with no live tasks | Delete the entry | `pool.rs:3617` |
| `Cancel` / `Rotate` (batch dropped by design) | Delete the entry | `pool.rs:5080` `requeue_cancelled_batch` |
| `Timeout` / `AgentExited` (batch requeued in-process) | Keep the entry. The requeued dispatch rewrites it | `lib.rs:4836` |
| Terminal task update read at any later prompt | Remove the task. If none are left, delete the entry | `acp.rs:2175` |
| Graceful shutdown, for idle slots | Drain buffered stdout through `handle_session_update` (repurpose `drain_stale_responses`, 250 ms cap), then shut down | `lib.rs:3690-3697` |

**Delivery.** A session is lost on startup or on a slot respawn. In both cases,
`ResumeJournal::take(channels)` turns entries into `FlushBatch`es, using the same
`SavedEvent`→`BatchEvent` restore as `auth_parking`.

- **At startup:** in `startup_event_queue` (`lib.rs:1908`), next to `load_auth_parked`.
- **On respawn:** at `lib.rs:4956`, for the channels whose sessions lived on that slot.

Each batch carries a new `CancelReason::Resume` with its own `MergeFraming` (beside
`queue.rs:2020-2040`):

```
[What you were working on — your previous session ended before it finished]
<original request events>
Note: Your session was restarted and lost its context. Background work still running
at that point was stopped with it: <title> (output: <path>) …  Check the thread and
those outputs, then continue. If the result is already delivered, do nothing and post nothing.
```

The prompt already fetches recent channel/thread context, so the fresh session sees
recent history without `session/load`. If a live message for the channel is already
queued, the existing merge logic folds the resume into it as `cancelled_events`.

**Storm and duplicate controls.** All are enforced in `resume.rs`:

- **TTL.** Drop entries with `recorded_at` older than 12 h, which equals the max turn.
- **Per-agent cap.** At most 3 resume batches per startup, newest first. Each dropped
  entry gets one WARN log line.
- **Crash-loop guard.** Increment `resumes` on take. If it is 2 or more, drop the entry
  and log, so that a turn which kills the harness cannot loop.
- **Fleet jitter.** Startup resume batches get a `retry_at` delay of
  `hash(pubkey) mod 90 s`. A fleet restart then spreads its resumes over about 90 s
  instead of firing all at once. The existing quota failover handles any overflow.
- **Idle seats are not touched.** An agent without an entry gets no turn.

**Alternatives considered:**

- **A. Claude Code Stop/SubagentStop hook books a buzz-services reminder** (the
  codex-work pattern). This lives outside the fork and makes a relay post for every
  wake. A wake booked at task end dies with the process, so it does not cover cause 2.
  Rejected as the main mechanism; kept as the fallback for codex jobs.
- **B. Persist ACP session ids and `session/load` them after a restart.** This restores
  full context. It does not fix cause 1, because the background children are already
  dead. It also depends on the adapter and replays very large transcripts. Deferred, and
  worth revisiting after the upstream rebase (#7578 session scope).
- **C. An idle-time stdout reader that wakes seats live.** Not needed: the CLI already
  wakes itself in-process (Summary). It would add a second reader on the pipe and a race
  over who owns the pipe.

---

## 4. FORK_MANIFEST rows

| Series | What | Upstream plan |
|---|---|---|
| **Harness auto-wake** (new): `feat(buzz-acp): background-held turns use a background idle timeout` + `feat(buzz-acp): resume journal — re-deliver lost turns and background work after respawn/restart` | F1 + F2 (`acp.rs`, `pool.rs`, `lib.rs`, `queue.rs`, `config.rs`, new `resume.rs`) | **Generic; upstream-PR candidate.** No product-specific surface. The default journal path is fork-specific; upstream would get the path from desktop via app data, as the auth-parking file would. Expect conflicts with upstream #7340/#7459/#7578 in `pool.rs`/`lib.rs` |
| **Base prompt session ownership** (new): `fix(buzz-acp): earlier channel work belongs to the current session` | F3, `base_prompt.md` | **Drop at next rebase.** Upstream removed the section (#6732). Shared Instructions carry the rule after that |

Gap found: the fork-only auth-parking / auth-pool series (`7a1eedbd9`, `b2ee23406`,
`ac9976a7a`, …) has no manifest row. F2 builds on it, so add a row in the same commit.

---

## 5. Tests

Each test must fail on today's code. To prove it, run the test on `2ee698216` (or
revert the one production line) and record the named failure in the PR.

| ID | Test (seam) | Fails today because |
|---|---|---|
| T1 | `lib.rs` base-prompt tests (beside `:5351`): prompt lacks `leave execution with the owning session` and contains `Earlier work in this channel is yours` | Line 7 has the old text |
| T2 | `acp.rs`: `build_client_capabilities()["_meta"]["jetbrains"]["air"]` has `version == 1` and `capabilities ∋ "asyncTasks"` | Not advertised (`:491`) |
| T3 | Scripted bash agent (pattern `acp.rs:3777`) with `idle_timeout = 1s`: emits `tool_call{rawInput:{run_in_background:true}}`, sleeps 3 s, then answers `end_turn`. Expect `Ok(EndTurn)` | Returns `Err(IdleTimeout)` |
| T3b | Same as T3 without the flag: still `Err(IdleTimeout)` | Guards against simply disabling the idle timer |
| T4 | `run_prompt_task` with a scripted agent emitting `async_task_spawned`, then `end_turn`. The journal has a `background` entry for the channel with that task. A second prompt whose script first emits `async_task_state_update{state:"completed"}` deletes it | No journal exists |
| T5 | Modelled on `lib.rs:9585` `startup_event_queue_replays_original_request`: a seeded journal (1 `in_turn`, 1 `background`) yields 2 batches with `CancelReason::Resume`, and `format_prompt` contains the resume header and the task output path. A second startup yields 0 | Nothing is replayed |
| T6 | 5 entries, one past TTL, give exactly the 3 newest live ones. An entry with `resumes = 2` is dropped | No caps exist |
| T7 | Kill-switch: `BUZZ_ACP_RESUME=0` produces no file and no replay | Passes today; it is a regression guard, labelled as such |
| L1 | Live on a dev build (`BUZZ_ACP_IDLE_TIMEOUT=60` to shorten the run): a seat runs `sleep 300` with `run_in_background` and ends its turn. Restart the agent from desktop. Within about 2 min the seat posts its resumption in that channel | Today: silence |
| L2 | Live: start a background `Agent` doing a 2 min silent step. With `idle=60` the turn survives and completes | Today: idle kill and respawn (as in the Acid Burn log) |
| L3 | Live control: idle seats with no journal produce 0 kind-9 in the 5 min after a fleet restart | Storm guard |

Also run `cargo test -p buzz-acp`, `cargo clippy -p buzz-acp --all-targets -D warnings`,
and assert the test count, not only pass/fail.

---

## 6. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Duplicate wake.** A task finished, the in-process follow-up handled it, then the harness died before reading the terminal update, leaving a stale entry | One wasted turn, no message | Shutdown drain; framing says "if delivered, do nothing and post nothing"; `resumes` cap |
| **Wake storm after a fleet restart.** Settings changes restart every seat | N × up to 3 turns at once, quota spike | 90 s jitter, cap of 3, 12 h TTL, idle seats untouched, existing quota failover |
| **Token cost.** Every resume is a full turn (base prompt + context) | A daily restart costs about one turn per channel with unfinished work | Only channels with recorded unfinished work are resumed. Expected to be cheaper than today, where Sam has to nudge each seat by hand and pay a turn plus his time. The `resumes` counter is logged, so per-seat cost can be audited |
| **Crash loop.** A resumed turn kills the harness | Repeated respawns | Dropped after 2 resumes |
| **Held turn pinned by a stuck subagent** (F1) | Slot busy for up to 2 h | Steering still answers people; 12 h hard cap remains; knob set to `0` reverts |
| **Adapter drift.** A future `claude-agent-acp` renames `rawInput.run_in_background` or the AIR task updates | Detection silently stops | T3/T4 pin today's shapes. Phase 0 records the adapter version; log one WARN per process if a `Bash` tool result says "running in background" but no `async_task_spawned` follows |
| **Non-Claude harnesses** (codex, goose) | No AIR tasks, so only `in_turn` entries | Still covers mid-turn restarts; harmless otherwise |
| **Rebase conflict.** 313 upstream commits are pending, several in `pool.rs`/`lib.rs` | Extra rebase work | Keep F2 inside `resume.rs`, with thin call-site hooks |

---

## 7. Implementation plan

0. **Confirm (0.5 d, no code).** On a scratch agent with
   `BUZZ_ACP_IDLE_TIMEOUT=60` and `RUST_LOG=acp::wire=debug`:
   - Capture the exact `tool_call` payload for `Agent run_in_background`.
   - Check that the held turn idle-kills (L2 baseline).
   - Check that a background `Bash` completion runs an autonomous follow-up with no harness turn.
   - Check that a restart loses it (L1 baseline).
   - Record the adapter version.
1. **F3:** base prompt + T1. Rebuild the sidecar. Shared Instructions can drop their override afterwards.
2. **F1:** knob + detection + T3/T3b.
3. **F2:**
   1. `resume.rs` store + T6/T7.
   2. Capability + task tracking + T2/T4.
   3. Write points.
   4. Startup and respawn delivery + framing + T5.
   5. Shutdown drain.
4. **Ship:** run `just desktop-release-build` (verify the sidecar bytes) and the live checks L1–L3. Add the manifest rows, tag `nest-…`, mv-swap the install (needs Sam's okay to restart Buzz).

Rollback: `BUZZ_ACP_RESUME=0` and `BUZZ_ACP_BACKGROUND_IDLE_TIMEOUT=0` restore today's
behaviour without a rebuild. A full rollback is the previous `Buzz.app.bak-*`.

---

## 8. Open questions for Sam

1. Should every **mid-turn** turn cut by a restart resume, including deliberate settings
   restarts? Or only turns with background work?
2. Are the caps right: TTL 12 h, 3 resumes per agent per restart, 90 s jitter?
3. Background idle ceiling for held subagent turns: 2 h, or none (12 h hard cap only)?
4. Journal location: `~/.buzz/WORKING_STATE/resume/` (next to `auth-parked/`), or the
   Buzz app-data dir?
5. Should the resume turn stay silent unless it has something to say (the current
   "resume silently" rule)? Or post one line such as "picked back up after restart"?
6. Should the base prompt also tell seats that detached `nohup`/`&` jobs can never wake
   them, or should that stay in Shared Instructions?
7. Build on fork `main` now, or rebase onto `origin/main` (313 commits, including the
   upstream thread-session and session-scope work) first?

## 9. Verdict

F3 and F1 are ready to implement. F2 is safe to start after Phase 0 confirms the adapter
payload shapes and Sam answers Q1–Q3.

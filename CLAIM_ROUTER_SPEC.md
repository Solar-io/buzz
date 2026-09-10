# Claim-Router Fold — spec for coder

## The bug (context, do not re-derive)

Buzz agents run as a pool of N ACP session slots for one agent identity
(`crates/buzz-acp/src/pool.rs`, `AgentPool`). When a mention arrives for a
channel, `dispatch_pending` (`crates/buzz-acp/src/lib.rs`, ~line 3725) pops the
channel's batch and calls `pool.try_claim(Some(channel_id))`:

- **Pass 1** prefers an idle slot that already has a session for the channel.
- **Pass 2** falls back to ANY idle slot.

If the channel-holding slot is mid-turn (checked out, present in
`pool.task_map`), Pass 1 misses and Pass 2 hands the mention to a cold boot
slot with no conversation state. Observed 2026-09-10 18:07-18:14 (Sam DM):
two agent replies inside a minute, and the boot answered an image question
without opening the image. After the boot's turn it too holds a session for
the channel, so future mentions flip-flop between holder and boot — this is
the recurring "two of me" seam.

## The fix — two guards at one dispatch point

### Guard A — in-pool fold (deterministic, no I/O)

In `dispatch_pending`, after `pool.try_claim(Some(channel_id))` returns an
agent, if that claim was an **affinity miss** (`affinity_hit == false`, already
computed just above) AND the pool has another slot checked out on this same
channel (add a pool helper):

```rust
// pool.rs
/// Whether any slot is checked out (mid-turn) on this channel.
pub fn is_channel_checked_out(&self, channel_id: Uuid) -> bool {
    self.task_map.values().any(|m| m.channel_id == Some(channel_id))
}
```

then DECLINE to dispatch: mirror the existing `pool_exhausted` path exactly —
`return_agent(agent)`, `queue.requeue_preserve_timestamps(batch)`,
`queue.mark_complete(channel_id)`, `break`. Do NOT `continue` (flush_next
would re-return the same batch → live-loop). The held batch flushes on the
next `dispatch_pending` call, which the main loop fires when the holder's
task completes or new events arrive. Verify that assumption in the code
(find the `dispatch_pending` call sites) and state where they are in your
report.

Order matters: check `is_channel_checked_out` BEFORE calling `try_claim`
(cheapest correct form: if `!affinity_hit && pool.is_channel_checked_out(cid)`
skip `try_claim` entirely and take the decline path). Heartbeat claims
(`try_claim(None)`) are unaffected.

### Guard B — cross-process fold via claims file (fail-open)

A second seam shape is cross-process: a window-hours session in another
process/instance holds the room; this process's pool knows nothing about it.
Agent sessions mark their claim in a JSON file (convention live since 9/9,
Evie's half — she marks before she speaks; this router is the other half):

Path: `${BUZZ_ACP_CLAIMS_FILE}` env override, else
`$HOME/.buzz/WORKING_STATE/<agent-slug>.claims.json` if it exists, else Guard B
is disabled (no error). Derive `<agent-slug>` from the agent config name
already available where the pool is built (lowercased, spaces→dashes is fine;
Evie's is literally `evie`). If deriving cleanly is intrusive, a static env
var alone is acceptable — say so in the report.

Shape (live example, `~/.buzz/WORKING_STATE/evie.claims.json`):

```json
{
  "watching": ["<channel-uuid>", "..."],
  "composing": {"channel": "<channel-uuid>", "at": "2026-09-10T18:26:00-05:00", "note": "..."},
  "convention": "..."
}
```

Fold rule — in `dispatch_pending`, only on an affinity miss for `channel_id`:

- Fold (decline, same path as Guard A) if EITHER:
  - `composing.channel == channel_id` and `composing.at` parsed within the
    last **10 minutes**, OR
  - `watching` contains `channel_id` and the claims **file mtime** is within
    the last **15 minutes** (mtime is the heartbeat: the holder rewrites the
    file on each mark; a dead session's claim goes stale and stops folding).
- Otherwise dispatch normally. **Stale claim = no claim.**

**Fail-open is mandatory:** missing file, unreadable file, malformed JSON,
unparseable timestamp, any I/O error → treat as no claim, dispatch normally,
log at `debug` (NOT warn — this can be probed per-dispatch). A corrupt claims
file must never wedge a DM. Guard B must never fire on an affinity HIT (the
in-pool holder wins over any file claim) and never for the heartbeat path.

Read the file synchronously (`std::fs`) — it is tiny and this path is rare
(affinity miss only). Do not cache across dispatch calls for longer than one
`dispatch_pending` invocation's lifetime is fine; a simple per-call read is
preferred for correctness.

### What must NOT change

- `try_claim` Pass 1/Pass 2 semantics when no guard fires.
- The heartbeat path (`try_claim(None)` at lib.rs ~4403).
- Queue internals (`queue.rs`) — no changes expected there.
- The existing `pool_exhausted` decline path behavior.

## Tests (crates/buzz-acp tests, mirroring existing test style in the crate)

Every test must be shown to fail against the unguarded code — run it once
with the guard commented out or on a stash, then green with it in. Report
which mutation each test detects.

1. **Guard A holds the batch:** slot 0 mid-turn on channel C (present in
   task_map), slot 1 idle, batch queued for C → after `dispatch_pending`, the
   batch is NOT given to slot 1 (slot 1 still idle in its slot), batch still
   queued. Mutation: remove Guard A → slot 1 gets the batch → test fails.
2. **Guard A releases after holder returns:** same setup, then clear the
   task_map entry (holder completed) → next `dispatch_pending` claims the
   returned holder slot (affinity Pass 1), not a boot.
3. **Other channels not starved:** channel C held mid-turn, channel D free
   with an idle slot → D dispatches in the same `dispatch_pending` call.
4. **Guard B composing fold:** claims file with fresh `composing` on C,
   `BUZZ_ACP_CLAIMS_FILE` pointed at a temp file, affinity miss, pool idle →
   batch held. Same file with `at` 11 minutes old → dispatches.
5. **Guard B watching fold + staleness:** `watching` contains C, file mtime
   now → held; mtime 16 min old → dispatches.
6. **Guard B fail-open:** malformed JSON file → dispatches, no panic, no
   warn-level log spam. Missing file → dispatches.
7. **Affinity hit bypasses Guard B:** fresh composing claim on C AND an idle
   in-pool slot already holds C's session → dispatches to that slot
   immediately (file must not delay it).

Use `filetime` or `std::fs::File::set_times`-equivalent already in the
workspace deps for mtime control in tests; if no such dep exists, restructure
the mtime check so tests can inject a "now"/mtime source (a small
`ClaimsPolicy` struct with a `now()` closure keeps it testable — prefer this
if dep addition is needed).

## Build & verify

- `cargo check -p buzz-acp` then `cargo test -p buzz-acp` (full crate, never
  a scoped single-module run) — all green, and quote the summary line.
- `cargo clippy -p buzz-acp` no new warnings.
- Match surrounding code style: tracing patterns, doc-comment voice, existing
  error handling. No new deps unless the testability note forces one — then
  justify it.

## Infra context

Read first:
/Users/sgallant/claude-glm/projects/-Users-sgallant--buzz/09e12f70-9f82-4bc4-a81b-2f53b2ef9365/tool-results/hook-aa160da2-0e9b-4807-8628-e644ea45e264-stdout.txt
(infrastructure rules). You are the worker: do the reading, edits, and test
runs yourself; do not spawn further agents.

Work in THIS worktree:
/Users/sgallant/software_development/.evie-worktrees/buzz-claim-router
(branch claude/claim-router-fold, based on main @ 093160409). Commit with a
conventional message when tests are green.

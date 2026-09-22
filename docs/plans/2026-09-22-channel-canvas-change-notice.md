# Design: propagate channel-canvas changes to already-seated agents

Status: implementation-ready design. All code claims verified by reading buzz main at `d196ccf1b` (this worktree's HEAD); line numbers are current as of that commit.

Incident being fixed: a rule was added to #general's canvas (kind 40100) at 08:32 CDT 2026-09-22 telling agents not to pile onto an owned topic. #general then took 190 messages in ~6 hours, mostly agent-to-agent correction loops. The rule reached nobody already seated. Sam approved the fix direction ("option one" — refresh the channel's canvas when it changes so agents actually see updated rules).

---

## SUMMARY

The canvas reaches an agent exactly once, at session creation, as a metadata pointer — and nothing ever tells a seated agent the revision moved. The fix is a two-part mechanism:

1. **Notice the change**: add a second NIP-01 filter object (`{"kinds":[40100], "#h":["<channel>"]}`) to the harness's existing per-channel subscription.
2. **Deliver it**: a **one-shot per-turn `[Channel Canvas — updated]` section** carrying the new revision ID, timestamp, and capped content, rendered into the next turn's user message for that channel.

Sessions are never touched: a new narrow `SessionState::refresh_channel_canvas` updates only the canvas cache and arms the notice, in explicit contrast to `invalidate_channel` (pool.rs:174), which stays untouched and unused on this path.

### Vision reading (product intent)

- VISION_SOVEREIGN.md:45–52 makes canvas content *readable reference material for agents* (the architecture doc a newcomer reads before writing a line of code).
- VISION.md:165 makes the *CLI the canonical access path* for canvas operations.
- The current pointer satisfies neither once the canvas changes — it tells an agent "you know this canvas" about a revision it can no longer trust, and reading the new text requires knowing to run a CLI command with no trigger to do so.
- This design serves both readings: the change notice carries the content inline (capped), so the common case — a short rule like the 08:32 one — reaches seated agents with zero CLI hops, while `buzz canvas get` (verified real: `crates/buzz-cli/src/lib.rs:825`, dispatch at 2170) remains canonical for full reads and the truncation fallback.
- VISION_AGENT.md contains nothing about harness standing-context behavior (it describes `buzz-agent`'s own context-summarization loop, lines 13, 61–65). No vision tension.

---

## 1. Chosen approach and rejected alternatives

### Chosen: subscription-noticed, one-shot per-turn change notice

B's signal path + A's delivery vehicle, with C's content in the delta only.

Why this shape:

- **Refreshing the cache alone (pure B) provably does nothing for seated agents.** For modern agents the canvas is baked into the system prompt at `session/new` (`create_session_and_apply_model` → `composed_system_prompt`, pool.rs:1083, 2105–2130) and is never re-delivered (pool.rs:2609–2611: "Standing context is fixed for the life of a session"). For legacy agents it rides the first user message only, gated by `standing_context_sent` (queue.rs:1674). A cache refresh only helps sessions created *later*. This is precisely why the 08:32 rule reached nobody.
- **Per-turn full canvas (pure A) is unbounded and anti-architectural.** Canvases are doc-sized (VISION_SOVEREIGN: "the architecture doc"). Re-sending one every turn makes standing framing "the newest and most-repeated text in the window" — the exact harm queue.rs:1548–1557 documents as the reason standing context is sent once. But A's *vehicle* (a per-turn user-message section) is the only channel that reaches modern and legacy agents alike, so the delta uses it.
- **Content instead of pointer at session creation (pure C) doesn't fix staleness** — it's still frozen at creation — and moves doc-sized payloads into system prompts. Adopted only for the change notice, capped.

### Rejected alternatives, concretely

| Alternative | Rejection reason (evidence) |
|---|---|
| **(A) canvas as per-turn standing context** | Unbounded prompt growth; contradicts the once-per-session standing-context invariant (queue.rs:1548–1557, pool.rs:2609–2611); no change signal, so it pays every turn for a rare event. |
| **(B) cache refresh only** | No effect on any seated agent (system prompt fixed at session/new; legacy gated by `standing_context_sent`, queue.rs:1674). Only future sessions benefit — the incident unchanged. |
| **(C) inject content at session creation** | Same staleness; system-prompt size risk for doc canvases. Kept as an open product question, not part of this fix. |
| **`invalidate_channel` as the refresh path** | Destroys the session and its conversation context (pool.rs:174–180 removes sessions, turn_counts, core/canvas sections, deliveries) — the stated non-negotiable. The owner-only `!rotate` (lib.rs:2884–2911) remains the explicit, human-invoked way to get that. |
| **Global kind-40100 subscription (the membership precedent)** | The membership sub works because its events are `#p`-addressed to the agent (relay.rs:3256–3282). Canvas events are h-scoped, not p-addressed; a global `kinds:[40100]` REQ would need unscoped-query admission (unverified against the p-gate) and would deliver every channel's canvas writes to every harness, losing the per-channel read scoping the message subscription already has. The per-channel second filter object gets identical effect through existing machinery: same sub id (`ch-<uuid>`), same reconnect replay, same `channel_id_from_sub_id` routing (relay.rs:2170). |

---

## 2. How the canvas-change signal arrives (the crux, verified)

1. **Subscription.** `send_subscribe` (relay.rs:3191–3227) builds one REQ filter from `ChannelFilter` (`kinds`, always `#h`, `#p` only when `require_mention`). In Mentions mode (default) the `#p` conjunction means adding 40100 to `kinds` alone would *not* deliver canvas events — the relay-side AND of `kinds` + `#p` excludes un-addressed canvas writes. **The change: append a second filter object `{"kinds":[40100], "#h":["<channel>"]}` to the same REQ.** NIP-01 multiple filters in one REQ are OR-ed; the relay parses up to 10 (buzz-relay/src/protocol.rs:11–12, 103–119). No new sub id, no `handle_ws_message` routing change, and reconnect replay is free because BgState re-issues the stored subscription wholesale.
2. **Relay side: no changes needed.** Canvas writes are `ChannelsWrite`-scoped, h-tag-required events (ingest.rs:517; `requires_h_channel_scope(KIND_CANVAS)` asserted in event.rs tests ~1240). Fan-out is generic NIP-01 filter matching over open subscriptions (buzz-core's filter matching, per AGENTS.md crate map), so an open `ch-<uuid>` sub whose second filter matches delivers the event.
3. **Harness main loop.** The event arrives as a normal `BuzzEvent` on `event_rx` (handle_ws_message → `record_event` → `event_tx`, relay.rs:2170–2179; dedup/watermark/backpressure handling identical to messages). The main loop gains an interception branch for `kind_u32 == KIND_CANVAS`, placed **after** the `ignore_self` drop (lib.rs:2809–2812 — an agent's own `buzz canvas set` should not notify itself, matching message semantics) and **before** `filter::match_event`/`queue.push` (lib.rs:2956–2980), so a canvas write is consumed by the harness and never becomes a prompt trigger. Guarded by `subscribed_channel_ids.contains(&ch)` and `!is_dm_channel(...)` (lib.rs:293 — fail-closed on unresolved channels, same stance as the fetch path's DM check at pool.rs:2437–2439).
4. **Validation.** Extract the pure core of `canvas_section_from_query_response` (pool.rs:3649–3756) into `canvas_section_from_event(&nostr::Event, channel_uuid) -> Option<CanvasRevisionInfo>`; the query path calls it after array extraction + deserialization, and the push path calls it directly. Identical checks for both paths: signature verify, kind 40100, h-tag match, timestamp range, blank-content detection. A malformed or tampered event logs at `warn` and is dropped — fail-open, exactly like the fetch path (pool.rs:3580–3586).
5. **No re-fetch.** The pushed event *is* the new revision. `fetch_canvas_section` (pool.rs:3590) is not called on this path — zero added relay queries.

---

## 3. Exact changes, file by file

### `crates/buzz-acp/src/relay.rs`

- `send_subscribe` (~3191): append the canvas filter object unconditionally; update the doc comment (3182–3190) to say the channel sub is a two-filter OR: message/mention filter + canvas filter without `#p`.
- Tests near 4442: assert the REQ JSON contains both objects (see test strategy, mutation M1).

### `crates/buzz-acp/src/pool.rs`

- **`SessionState` (~131–155):**
  - Change `canvas_sections: HashMap<Uuid, String>` → `HashMap<Uuid, CachedCanvas>` where `CachedCanvas { section: String, revision_id: String, created_at: u64 }`. Touch points: 151 (decl), 177/190 (invalidate — behavior unchanged), 210 (`has_channel_state`), 2427 (`needs_canvas` guard — unchanged), 2456–2464 (read for `agent_canvas` — now `.section`), 2503–2505 (commit pending — wraps fetched string), plus tests at 8890ff. The struct gives LWW-by-`created_at` and expresses "cleared" as entry removal without string re-parsing.
  - New field `canvas_pending_notice: HashMap<Uuid, CanvasNotice>`; cleared by `invalidate_channel`/`invalidate_all` (a replacement session gets freshness at creation, so no double delivery).
- **New `SessionState::refresh_channel_canvas(&mut self, cid, revision: CanvasRevisionInfo) -> bool`:** LWW-apply the cache (replace / insert / remove-on-blank) and arm `canvas_pending_notice[cid]`. **Must not touch `sessions`, `turn_counts`, `deliveries`** — the doc comment must say why and name `invalidate_channel` as the thing this is deliberately not.
- **`CanvasNotice`** (new small struct): `{ channel_id, revision_id, created_at, rendered_section: String }`, built by a new pure `canvas_notice_from_event(&nostr::Event, channel_uuid) -> CanvasNotice` that reuses the shared validator, renders via a new pure `render_canvas_notice_section(...)`, and caps content at **4096 bytes** with a `[…truncated, N bytes total — buzz canvas get --channel <uuid>]` marker; blank content renders a "canvas was cleared" notice.
- **`AgentPool::note_canvas_changed(&mut self, channel_id, notice)`** (new, next to `invalidate_channel_sessions` at 908): arms the notice on every **idle** agent that holds a live session for the channel (agents without sessions get freshness free at session creation; arming them would duplicate). Returns a count for logging.
- **`run_prompt_task` (~2799–2896):** for `PromptSource::Channel(cid)`, read `agent.state.canvas_pending_notice.get(cid)` and pass the pre-rendered string as `FormatPromptArgs::canvas_notice: Option<&str>` (mirrors how `agent_canvas` is a pre-rendered string — queue stays rendering-thin).
- **Consumption:** at both success-commit sites that call `record_channel_delivery_success` (pool.rs:3144, 3198), also call a tiny `consume_canvas_notice(&mut agent.state, cid)`. Failed/cancelled/timeout paths leave it armed — the retry re-renders it, same semantics as `pending_delivered_event_ids` (pool.rs:2796–2798).
- Refactor + new pure fns live beside `canvas_section_from_query_response` (3587–3769); tests beside the existing canvas tests (8901ff; `make_canvas_event_value` fixture reused).

### `crates/buzz-acp/src/queue.rs`

- `FormatPromptArgs` (1505–1546): new `pub canvas_notice: Option<&'a str>` — `Option` keeps `Default` derived and every existing test call site compiling.
- `format_prompt` (1649): if `Some`, push the notice section **first** (before the standing-context block and `[Context]`) — it is ephemeral, high-salience, and must not be buried under thread context. Update the section-order doc at 1627–1648. The per-section-block convention means the desktop "Prompt context" panel and the observer size-trimmer count/handle it for free (1639–1645).
- `StandingContext` (1562–1616): **unchanged** — the notice is not standing context.

### `crates/buzz-acp/src/lib.rs`

- Main loop: the `KIND_CANVAS` interception branch (placement per §2.3); calls `pool.note_canvas_changed(...)` when `pool_ready`, and records `pending_canvas_updates: HashMap<Uuid, CanvasNotice>` (LWW per channel, bounded by channel count) for checked-out agents — the `removed_channels` pattern (declared lib.rs:2419, applied to returning agents at lib.rs:4647–4649).
- `handle_prompt_result` (~4647): beside the removed-channels strip, apply `pending_canvas_updates` to the returning agent (arm only if it holds a live session for the channel). Refresh the idle cache the same way.
- Startup/dynamic subscribe sites (lib.rs:2173, 2754) need **no change** — the filter object is appended inside `send_subscribe`.

---

## 4. Reach, fail-open, and cost

- **Modern agents** (system-prompt path — `@agentclientprotocol/claude-agent-acp` unconditionally, `protocol_version >= 2`, goose post-probe: pool.rs:266–280): reached by the per-turn notice section, which `format_prompt` emits regardless of `has_system_prompt_support`.
- **Legacy agents** (first-message path): same section, same path — it is emitted even when `standing_context_sent` is true because it is not part of `StandingContext`.
- **Fail-open:** invalid event → `warn` + drop (§2.4); the filter append lives inside the existing REQ write, so a failure there already triggers the existing reconnect path; interception is pure in-memory work. Nothing on this path can block a turn or a send.
- **Bounded cost:** zero added relay queries (push carries the revision); one extra filter object per channel REQ; notice payload capped at 4 KiB, delivered at most once per change per agent; `pending_canvas_updates` is one entry per channel, overwritten LWW.

---

## 5. Test strategy (each names the mutation it kills)

Run with `env -u BUZZ_ACP_LAZY_POOL -u BUZZ_ACP_IDLE_POOL_SLEEP -u BUZZ_ACP_SESSION_ID cargo test -p buzz-acp` (AGENTS.md gotcha 7).

1. **`canvas_refresh_preserves_session_and_turn_counts`** (pool.rs) — seat a session + turn count + delivery state, apply `refresh_channel_canvas`, assert `sessions`/`turn_counts`/`deliveries` intact and the cache updated. **Mutation M2: make `refresh_channel_canvas` delegate to `invalidate_channel` (or clear `sessions`) — this test must fail.** This is the pin on the non-negotiable constraint.
2. **`channel_req_carries_canvas_filter_without_mention_gate`** (relay.rs, beside the 4442 REQ tests) — assert the REQ contains two filter objects: the message filter (with `#p` in Mentions mode) and `{"kinds":[40100],"#h":[…]}` with no `#p`. **Mutation M1: delete the appended filter object — must fail.**
3. **`format_prompt_includes_canvas_notice_for_modern_and_legacy`** (queue.rs) — two runs of `format_prompt` (`has_system_prompt_support` true/false, `standing_context_sent` true), assert both prompts contain `[Channel Canvas — updated]` with the revision ID, and that it is the first section. **Mutation M3: drop the `canvas_notice` field or gate it behind `standing_context_sent` — must fail.**
4. **`consume_canvas_notice_clears_only_after_success`** (pool.rs) — state-helper test mirroring the `mark_channel_delivery_success` tests at 7159ff. **Mutation M4: remove the consume call — a "notice never consumed → re-delivered every turn" test must fail.**
5. **`blank_canvas_clears_cache_and_arms_cleared_notice`** (pool.rs) — refresh with blank content: cache entry absent, armed notice renders "cleared". **Mutation M5: skip the blank branch — must fail.**
6. **Shared-validator equivalence** — parametrize the existing `canvas_section_from_query_response` tests (8893–9007) over both entry points so the push path inherits the tamper/partial-event coverage.
7. **Live e2e (manual, per AGENTS.md live-relay discipline)** — own private channel on the crichton relay: seat an agent (mention it), `buzz canvas set` a rule, post a second mention, assert the seated session's next prompt contains the notice (observer `prompt_context_delivery` frame / desktop Prompt context panel) **and that the session ID is unchanged**.

---

## 6. Risks, blast radius, verified vs inferred

### Verified vs inferred

Every file:line claim above was read at buzz main `d196ccf1b`. **Inferred, flag for review:**

- (a) OR-semantics of multi-filter REQ at *match* time — parsing is verified (protocol.rs:103–119), matching is standard NIP-01 via buzz-core but the matcher itself was not read; test 2 plus the live e2e covers it.
- (b) No relay-side dedup/LWW oddities for rapid successive canvas writes — mitigated harness-side by `created_at` LWW.

### Risks

- **Prompt injection via canvas content** — any channel member can write a canvas (`ChannelsWrite`, ingest.rs:517), and the notice inlines member-authored text. This is the *same* trust level as ordinary messages, which are already delivered verbatim in `[Event]`; the validator prevents a misbehaving relay from spoofing anything beyond genuinely published, signed content. The fetch path is equally author-agnostic today.
- **Watermark interaction** — canvas events now flow through `record_event` and advance the per-channel replay watermark like any channel event; SINCE_SKEW_SECS = 5 (relay.rs:59) cushions the same way it does for messages. Consistent, but worth a reviewer's eye.
- **SessionState shape change** (`String` → `CachedCanvas`) touches ~6 production sites and the 8890ff tests — contained, but it is the bulk of the diff.
- **Could not verify:** whether any current fleet seat actually runs a legacy (protocol v1) agent — the mechanism covers both regardless; whether Sam wants the *session-creation* pointer upgraded to capped content too (open question below).

### Reviewer checklist

1. `refresh_channel_canvas` provably cannot remove sessions.
2. Interception sits after `ignore_self` and before `match_event`.
3. Notice section first, and absent when nothing is armed.
4. Consumption only on the two success sites (3144/3198).
5. REQ shape in Mentions *and* All mode.
6. DM/unsubscribed guards on the interception branch.
7. Content cap applied at arm time, not render time.

### Follow-up decisions taken

- **Wildcard (`SubscribeMode::All`) delivery is lazy.** Canvas writes used to match the wildcard rule and give those agents an immediate turn carrying the raw canvas; after this change the notice rides the next turn instead. The owner chose the lazy trade on 2026-09-22. No fleet seat runs All mode today (all 35 running seats are `mentions`), so nothing changes in practice. Recorded in the code comment at `crates/buzz-acp/src/lib.rs` (commit `d3be48855`), not denied there.

### Open questions

1. Should session-creation inject capped canvas *content* instead of the pointer (fuller VISION_SOVEREIGN reading)? Recommend as a follow-up decision, not this change.
2. Should inline notice content be operator-disableable (`--no-canvas-inline`)? Default on; flag only if a community objects.
3. Confirm the 4 KiB cap against Sam's real canvases.

---

## Verdict

**Ready for implementation.** The signal path, delivery seam, and commit discipline all reuse proven machinery (membership interception, `pending_delivered_event_ids`, `removed_channels`), and the one hard constraint — never kill a session — has a named mutation-killing test (M2).

# OAuth-expired ACP batch recovery

The classifier preserves legacy auth patterns and adds `Failed to authenticate` and `OAuth session expired`. Quota routing stays separate. Auth-failed requests are retained in both Queue and Drop modes.

`AUTH_PROBE_DELAY` is 60 seconds; probes consume no normal retries. `AUTH_PARK_CAP_SECS` is 21,600 seconds from the first auth failure. Expiry during a probe posts a re-send notice. First failure attempts the existing threaded notice per channel; only accepted publication enables durable suppression. Failed delivery retries on the next probe or restart. Success or dead-letter resets suppression.

Journal: `$HOME/.buzz/WORKING_STATE/auth-parked/<agent-pubkey>.json`; override: `BUZZ_ACP_AUTH_PARKED_FILE`. Writes use a private (0600), synced temporary file plus atomic rename. Missing/corrupt/unwritable state logs and continues. Startup drops expired entries without notices and re-enqueues valid work with original signed timestamps, receipt order and cancelled context. Entries stay durable while probes run and are removed on success/dead-letter. Queue-depth pressure preserves parked requests.

## Verification

Base `fce4921ae3bae973641b7e960ec6dc31afaa7bd6`: **1,022 units + 9 integrations = 1,031 tests**. Final: **1,032 units + 9 integrations = 1,041 tests**, all pass (+10).

- `cargo test -p buzz-acp`: `logs/auth-base.log`, `logs/auth-restored-final.log`. Hermit activated; unset only `BUZZ_ACP_LAZY_POOL`, `BUZZ_ACP_IDLE_POOL_SLEEP`, `BUZZ_ACP_SESSION_ID` to avoid known injected-env interference.
- `cargo clippy -p buzz-acp --all-targets -- -D warnings`: clean, `logs/auth-clippy-final.log`.
- `cargo fmt` applied; `cargo fmt --check`: clean, `logs/auth-fmt.log`.
- Committed-source mutation removed the `Failed to authenticate` classifier arm. Named test `error_outcome_emission_tests::is_auth_error_matches_production_oauth_expiry` failed (one selected test, 1,030 filtered; unchanged inventory at that revision). Restored from commit and touched source to invalidate the Rust cache; final full suite passes. Receipt: `logs/auth-mutation.log`.
- Cases cover >10 auth failures without retry-budget cost, exact six-hour expiry, channel notice decisions, journal round-trip/removal, fresh restart and successful result handling in both modes, expired/corrupt/missing/unwritable files, queue pressure, preserved receipt order after probes and cancelled-batch throttling.

Non-auth timeout/cancel retry decisions and quota/pool routing keep existing behavior. Live logged-out Claude/relay acceptance was not exercised; crate socket tests and direct handler/journal regressions supply the coding evidence.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-210840`.
Branch: `codex/buzz-codex-20261003-210840`.
Source commits: `7a1eedbd9`, `8356c1b3b`, `4beb68818`.

## Round 2 — accepted notice acknowledgement and production wiring

QA's HIGH finding was reproduced by reinstating suppression before delivery: a real signed `POST /events` returning HTTP 500 persisted a noticed channel and failed `error_outcome_emission_tests::failed_notice_retries_then_persists_acceptance`.

`AuthParking` now shares its journal state between the event loop and publication task under one mutex. Pending notices have process-local generation tokens, so concurrent probes cannot schedule duplicates. Only a successful HTTP submission with JSON `accepted:true` records and immediately persists `noticed_channels`; build/sign/HTTP/timeout failures and relay refusals clear pending state. Pending tokens are absent from the journal, so a restart retries unacknowledged delivery. A late completion after success/dead-letter cannot suppress a later outage. Journal writes and event-loop updates use the same lock, preventing the publication task from writing a stale snapshot.

`post_failure_notice` returns its publication outcome. The actual auth branch of `handle_prompt_result` uses that outcome to acknowledge the journal. Non-auth notices retain their best-effort dispatch. `tokio_main` constructs its queue through `startup_event_queue`, which loads the agent-specific journal before normal event processing.

Three new named regressions run shipped code:

- `startup_event_queue_replays_original_request`: the startup constructor restores the original signed event identity; successful completion removes replay eligibility.
- `real_handler_notices_once_per_channel_after_acceptance`: repeated real handler failures publish exactly one notice per channel, including a second channel and reconstruction after acceptance. The local HTTP relay records `/events`, verifies Nostr signatures and checks channel tags.
- `failed_notice_retries_then_persists_acceptance`: HTTP 500 leaves the journal unsuppressed; a same-process retry receives HTTP 200 with `accepted:false`; reconstructed startup retries successfully; another reconstruction emits no duplicate. Completion waits poll the actual pending delivery state under a two-second deadline rather than guessing HTTP completion timing.

The handler fixtures create real `PromptResult` errors using the production OAuth-expiry string and use the shipped signed HTTP publisher. They do not claim to exercise an ACP subprocess emitting that error.

The relay bridge (`crates/buzz-relay/src/api/bridge.rs`, `submit_event_authed`) can return HTTP 200 with `accepted:false`. The publisher checks the acceptance field rather than treating every 2xx response as delivery.

### Mutation evidence

Changes were committed before mutation. Each mutant compiled, executed one named test with 1,034 filtered units (unchanged 1,035-unit inventory), and failed an assertion. Sources were restored byte-for-byte with fresh mtimes before subsequent checks.

| Mutation | Named failure | Receipt |
|---|---|---|
| Remove `load_auth_parked` call inside the extracted production startup constructor | `error_outcome_emission_tests::startup_event_queue_replays_original_request` — startup replay missing | `logs/oauth-round2-mut-startup.log` |
| Replace actual handler `else if notice` with `else if true` | `error_outcome_emission_tests::real_handler_notices_once_per_channel_after_acceptance` — duplicate first-channel notice occupies second-channel slot | `logs/oauth-round2-mut-notice-gate.log` |
| Persist noticed channel in `park`, before delivery | `error_outcome_emission_tests::failed_notice_retries_then_persists_acceptance` — HTTP 500 persists suppression | `logs/oauth-round2-mut-suppression.log` |
| Remove `Failed to authenticate` classifier arm | `error_outcome_emission_tests::is_auth_error_matches_production_oauth_expiry` — isolated production classifier phrase rejected | `logs/oauth-round2-mut-classifier.log` |
| Accept every HTTP 200 regardless of JSON acceptance | `error_outcome_emission_tests::failed_notice_retries_then_persists_acceptance` — HTTP 200 refusal persists suppression | `logs/oauth-round2-mut-acceptance.log` |

Startup evidence covers the constructor called by `tokio_main`; it is not a claim that a unit test launches `tokio_main` or would detect replacing the constructor call itself with an unrelated queue constructor.

### Required checks and bounded fixture decision

Final restored count: **1,035 units + 9 integrations = 1,044 passing tests** (three additions over QA's 1,041). Full command: `source bin/activate-hermit; env -u BUZZ_ACP_LAZY_POOL -u BUZZ_ACP_IDLE_POOL_SLEEP -u BUZZ_ACP_SESSION_ID cargo test -p buzz-acp`. Raw output: `logs/oauth-round2-restored-final.log`. Strict `cargo clippy -p buzz-acp --all-targets -- -D warnings` and `cargo fmt --check` receipts: `logs/oauth-round2-clippy-final.log`, `logs/oauth-round2-fmt-final.log`; aggregate receipt: `logs/verification.log`.

The optional binary kill/restart E2E is **skipped**. Existing tests provide ACP socket and relay socket fixtures separately, but no harness combining process launch/restart, channel discovery/NIP-42 traffic, signed HTTP publication and a fake ACP session/prompt agent. Building that controller and protocol fixture exceeds a modest addition. The bounded fixture added here proves real handler/publication behavior and journal reconstruction; OS-process restart and ACP-to-handler error propagation remain unverified together.

Recovery retains the existing at-least-once crash boundary: acceptance before the local acknowledgement is persisted, or agent side effects before successful-request journal cleanup, can replay after a crash. Atomic rename/write failure and separate concurrent harness processes retain the existing documented durability limits.

Source commits: `ed93ccecf` (delivery acknowledgement and three regressions), `941cea7af` (failed-delivery reconstruction coverage), `c03c06578` (explicit relay acceptance and HTTP 200 refusal coverage).

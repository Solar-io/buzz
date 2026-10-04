# ACP account-aware quota failover

Implemented in `auth_pool.rs`, the quota result handler in `lib.rs`, and the pre-turn guard in `pool.rs`. Source commit: `ac9976a7a`.

- Mark the slot's actual account out, falling back to its assignment only when no spawn attribution exists.
- Parse month/day/time or next time-only occurrence in the message's IANA timezone; use configured cooldown when parsing fails. Existing chrono-tz dependency supplies timezone rules.
- Reload `.buzz/state/pool-status.json` on routing decisions; `BUZZ_POOL_STATUS_PATH` overrides it. Missing/corrupt files mean available. Writers reuse `claims_writer::with_claims_lock`, merge under the stable sidecar lock, and replace with a unique temporary file plus rename.
- Prefer assigned, then an available sibling, then earliest reset with deterministic ties and all_out receipts. Keep the earlier active deadline on repeated errors, avoiding sliding cooldown flip loops. Overflow disabled preserves assigned routing.
- Respawn changed routes through `spawn_overflow_respawn_task` without crash accounting. Before a turn's first RPC, a shared-state check requests the same path and preserves its untouched batch, including Drop mode. Reset expiry therefore restores assignment on the next turn/spawn.
- Ledger records actual mark_out and selected flip/return_assigned/all_out, with exact reset timestamps.

## Verification

All commands activate `. ./bin/activate-hermit`. Test invocations unset `BUZZ_ACP_LAZY_POOL`, `BUZZ_ACP_IDLE_POOL_SLEEP`, and `BUZZ_ACP_SESSION_ID` to avoid the documented managed-shell artifacts.

| Check | Result | Receipt |
| --- | --- | --- |
| `cargo test -p buzz-acp` before | 1,035 units + 9 integrations | `logs/auth-pool-before.log` |
| Restored `cargo test -p buzz-acp` | 1,043 units + 9 integrations, zero failures | `logs/auth-pool-final.log` |
| `cargo build --release -p buzz-acp` | succeeds | `logs/auth-pool-release-final.log` |
| `cargo clippy -p buzz-acp --all-targets -- -D warnings` | succeeds | `logs/auth-pool-clippy-final.log` |
| `cargo fmt --all -- --check` | succeeds | `logs/auth-pool-fmt.log` |

The tests cover supplied weekly/time-only reset forms and fallback, B→A, the A→available-B incident, both-out earliest resets in either direction, expiry, shared-file reload/corruption, concurrent writers, path overrides, disabled/custom auth, ledger attribution, actual quota-handler respawn and pre-turn RPC avoidance with batch retention. The subprocess check uses an inert cat adapter; no real account quota was consumed. Fleet/device E2E was outside this coding handoff.

## Mutation proof

Source was committed before mutation. Replacing `slot_pool(slot).unwrap_or_else(...)` with the assigned pool reproduces the account-attribution defect.

`cargo test -p buzz-acp auth_pool::tests::incident_quota_on_a_returns_to_available_b -- --exact` fails by name: actual `FlipTo("A")`, expected `FlipTo("B")`. One test executes; 1,042 are filtered, preserving the 1,043-test inventory. Exit code 101. Receipt: `logs/auth-pool-mutation.log`.

Restored from the source commit, touched the file to invalidate cargo's mtime cache, and reran the full suite and release build. Source matches the committed implementation exactly.

`logs/verification.log` contains extracted real test results and raw mutation/build/lint output. The repository marker scan finds only pre-existing Markdown underline/TLA separator lines; the changed files have no conflict markers. No blockers or remaining implementation tasks.

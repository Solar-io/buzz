# OAuth-expired ACP batch recovery

The classifier preserves legacy auth patterns and adds `Failed to authenticate` and `OAuth session expired`. Quota routing stays separate. Auth-failed requests are retained in both Queue and Drop modes.

`AUTH_PROBE_DELAY` is 60 seconds; probes consume no normal retries. `AUTH_PARK_CAP_SECS` is 21,600 seconds from the first auth failure. Expiry during a probe posts a re-send notice. First failure posts the existing threaded notice once per channel; success or dead-letter resets suppression, which survives restart.

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

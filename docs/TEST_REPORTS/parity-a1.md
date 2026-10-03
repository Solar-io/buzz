# Buzz parity A1 — runtime implementation and test evidence

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-161205`

Branch: `codex/buzz-codex-20261002-161205`; base: `301cc5348`.

Source commits:
- `45324ab722b0c936d860ea1ebb7cc9d7f3cfc553` — pubkey lookup, file voice models, harness wiring, tests.
- `b08423ef676c87ae90862d275bd95da791dd8880` — marked-turn positive control for the unmarked model regression.

## Implementation

Each knob resolves independently: exact lowercase 64-character pubkey hex > case-insensitive display name > `*` > environment. Missing keys fall through; present blank/`unset` values mask lower tiers. Invalid efforts preserve the existing warn/no-override behavior. Non-string model values warn and mask lower tiers. `voiceModel` applies to `[voice] ` and `[video] ` turns through the existing catalog validation, apply, and restoration path. The file is read afresh each turn.

Files changed:
- `crates/buzz-acp/src/voice_turn.rs`: identity/model resolution and module documentation.
- `crates/buzz-acp/src/voice_turn_tests.rs`: extracted existing tests and 12 new regressions.
- `crates/buzz-acp/src/pool.rs`: pass the harness's own pubkey at prompt dispatch.
- `crates/buzz-acp/src/lib.rs`: pass the read loop's own pubkey into native steering and update existing seam-test calls.
- `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`, and this report: task and test handoff.

## Checks and outputs

Rust test commands unset `BUZZ_ACP_LAZY_POOL`, `BUZZ_ACP_IDLE_POOL_SLEEP`, and `BUZZ_ACP_SESSION_ID`, as required by the repo guide.

| Command | Result | Local evidence |
|---|---|---|
| `pnpm --dir web test` before / after | 4,092 / 4,092 passed; zero failures | `logs/a1-web-before.log`, `logs/a1-web-after.log` |
| `pnpm --dir web typecheck` | Exit 0 | `logs/a1-web-typecheck.log` |
| `pnpm --dir web build` | Built successfully; existing chunk/dynamic-import warnings | `logs/a1-web-build.log` |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | Exit 0 | `logs/a1-web-size.log` |
| `CHECK_FILE_SIZES_BASE=main pnpm --dir desktop check:file-sizes` | Exit 0 | `logs/a1-desktop-size.log` |
| Biome check on changed paths | Exit 0; zero supported files (`.rs`/`.md`) | `logs/a1-biome.log` |
| `cargo test -p buzz-acp` before / restored final | 1,009 / 1,021 unit tests; nine integration tests in both; zero failures | `logs/a1-rust-before.log`, `logs/a1-rust-after.log` |
| `cargo test -p buzz-acp voice_turn::tests` | 51 passed | `logs/a1-routing.log` |
| `cargo clippy -p buzz-acp --all-targets -- -D warnings` | Clean | `logs/a1-clippy.log` |
| `cargo build -p buzz-acp` | Built successfully | `logs/a1-rust-build.log` |
| `cargo fmt --all -- --check` | Exit 0 | `logs/a1-fmt.log` |

Desktop TS tests and UI screenshots are not applicable to this Rust-only phase. The TS/public-effort fixture corpus does not parse `agent-effort.json`, so it was not extended.

## Mutation proof

Source was committed before mutations. Each run executed the same 51 routing tests; tests were left intact. Restoration used `git checkout --` and an exact-content comparison. Receipts: `logs/verification.log`; raw outputs: `logs/a1-mutant-*.log`.

| Mutation | Passed / failed |
|---|---|
| Ignore pubkey entry | 43 / 8 |
| Ignore legacy name entry | 42 / 9 |
| Ignore file model | 42 / 9 |
| Allow model on unmarked turns | 48 / 3 |
| Restore pre-A1 resolution by disabling pubkey and file-model layers | 40 / 11 |

The last mutation failed all six required named tests: `pubkey_entry_beats_name_entry`, `name_entry_still_applies_without_pubkey_entry`, `renamed_agent_keeps_pubkey_entry`, `voice_model_from_file_beats_env`, `voice_model_unset_masks_env`, and `voice_model_ignored_on_unmarked_turn`. The restored complete crate suite and strict Clippy passed afterwards.

## Code-driven adjustments

`try_native_steer` has no key/context parameter in the base implementation; propagating the already-calculated own pubkey through this helper was necessary in addition to changing its resolver call. Existing seam tests supply a fixture pubkey. `pool.rs` remains exactly 11,798 lines with argument-only edits.

`voice_turn.rs` originally had 1,177 lines. Moving its inline tests to a sibling file leaves the implementation at 583 lines and the test file at 875, preserving the existing test names.

## Release acceptance procedure (plan: after R3)

On a throwaway agent in a private test channel, set a pubkey-keyed `voiceModel` to a model in its discovered catalog. Send a `[voice] ` turn and verify the model in the turn metric/observer frame. Edit the file and repeat without restarting, then rename the agent and verify the same pubkey setting still applies. This release-time live check is the one remaining acceptance item; local file reload and rename behavior are covered by the runtime tests.

# Fish audio P2 — relay, CLI and shared grammar vectors

Fish voice selections and owner assignments now accept `fish:[A-Za-z0-9]{16,64}`. The CLI routes `fish:` through its existing selection/assignment builder, preserves default/custom labels and exposes Fish in both command help screens. Relay validation checks grammar only; library membership and library administration stay at the bridge, as the plan requires.

Implementation is complete. The required clean full-suite gate is blocked by the failures below. No scope was dropped or approved for deferral.

## Files and commits

- `crates/buzz-relay/src/handlers/ingest.rs`
- `crates/buzz-relay/src/handlers/ingest_agent_voice_tests.rs`
- `crates/buzz-cli/src/commands/voices.rs`
- `crates/buzz-cli/src/lib.rs`
- `crates/buzz-test-client/tests/e2e_agent_voice.rs`
- `test-fixtures/voice/voice-key-grammar.json`
- `docs/TASKS.md`
- `docs/PROJECT_STATUS.md`
- `docs/LAST_CHAT.md`
- `docs/TEST_REPORTS/fish-relay-cli.md`

```text
052791e09 test(voice): pin exact fish prefix in CLI help
54a36bb43 feat(voice): accept fish selections and owner assignments
a7bcdd0f8 test(voice): add shared fish and eleven key grammar vectors
```

The fixture commit is independent so other phases can cherry-pick it. All commits have DCO signoff and the requested final co-author trailer.

## Verification

| Command / target | Baseline | Final |
| --- | --- | --- |
| `cargo test -p buzz-relay -p buzz-cli`: CLI lib | running 480; 480 pass | running 483; 483 pass, 0 fail (+3 tests) |
| Same command: relay lib | running 1107; 1043 pass, 64 ignored | running 1113; 1047 pass, 2 fail, 64 ignored (+6 tests) |
| Same command: relay binary | running 13; 13 pass | not reached after relay-lib failure |
| `cargo clippy -p buzz-relay -p buzz-cli -- -D warnings` | — | exit 0, no warnings |
| `cargo fmt -p buzz-relay -p buzz-cli -p buzz-test-client -- --check` | — | exit 0 |
| `cargo test -p buzz-test-client --test e2e_agent_voice --no-run` | — | compiles |
| `cargo test -p buzz-test-client --test e2e_agent_voice` | — | running 9; 0 pass, 9 ignored (relay-backed execution skipped) |
| `cargo run -p buzz-cli -- voices select --help` / `voices assign --help` | — | both exit 0 and show Fish keys/examples |

Final crate run used no name filters. All 22 agent-voice relay tests and all 10 CLI voice tests passed within that run.

Full-suite failures:

- `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo`: expected HTTP 200, got 504 after the echo timeout. Reproduced by temporarily restoring the unchanged pre-P2 Rust files and rerunning the full unfiltered command: CLI 480 pass; relay lib 1042 pass, 1 fail, 64 ignored. Exact source bytes and fresh mtimes were restored afterwards.
- `telemetry::tests::trace_context_lookup_does_not_enable_callsites`: the ERROR callsite was enabled despite the OFF filter. This untouched test failed intermittently in implementation/final runs; it passed in the parent control. Its cause was not established by this work.

A serial full run (`RUST_TEST_THREADS=1`, no name filter) still failed the mesh echo case: CLI 483 pass; relay lib 1048 pass, 1 fail, 64 ignored. The registered Buzz Redis port, read from port-registry.json (6353), refused a bounded connection probe; the default Redis used by opportunistic relay tests is separate. No service configuration was changed to hide the failures.

`just test` and live `--ignored` E2E execution remain unrun: they need a suitable test infrastructure and an isolated relay running this patch. The new Fish E2E case asserts both accepted publish and exact content/id readback. A generated identity requires a test relay admitting fresh members.

## Mutation proof

Changes were committed before mutation. Each run checked the test count, cargo exit 101 and the named failure; every source/fixture was restored byte-for-byte with a fresh mtime.

| Mechanism broken | Named test that failed | Tests executed |
| --- | --- | --- |
| relay-fish-arm | `agent_voice_fish_vectors_accept` | 22 |
| relay-fish-grammar | `agent_voice_fish_vectors_reject` | 22 |
| assignment-shared-grammar | `agent_voice_assignment_fish_uses_30182_grammar` | 22 |
| relay-key-cap | `agent_voice_fish_reports_key_length_limit` | 22 |
| relay-engine-error | `agent_voice_payload_rejects_unknown_engine` | 22 |
| cli-fish-prefix | `selection_body_fish` | 10 |
| cli-fish-help | `voices_select_and_assign_help_offer_fish` | 10 |
| cli-prefix-error | `selection_body_fish_empty_id_and_unknown_prefix_refused` | 10 |
| fixture-nonvacuous | `agent_voice_fish_vectors_reject` | 22 |

Relay mutation command: `cargo test -p buzz-relay --lib handlers::ingest::agent_voice_tests::` (22 tests). CLI mutation command: `cargo test -p buzz-cli --lib commands::voices::tests::` (10 tests). Full output is in `logs/p2-mutation-*.log`; structured receipts are in `logs/p2-mutations.json`. `logs/verification.log` aggregates the actual command output, including failed and parent-control runs.

## Plan differences and handoff

- Existing agent-voice tests moved from ingest.rs to `ingest_agent_voice_tests.rs`, mounted through `#[path]`. This avoids enlarging ingest.rs (6549 → 6163 lines); the new test module is 568 lines. Every original assertion is retained apart from the required five-engine error wording. The fixture include now lives in that module rather than inline in ingest.rs.
- Added CLI help/error regression tests and a fixture-count mutation beyond the plan's minimum. The CLI deliberately leaves complete ID grammar enforcement to the relay, exactly like ElevenLabs.
- The required clean full-suite gate is unresolved. Reproduce/fix the mesh test environment or existing test and investigate the intermittent telemetry failure, then rerun the exact unfiltered two-crate command. Execute the Fish E2E case on an isolated updated relay afterwards.

Shared vectors contain Fish 4 accept / 19 reject and ElevenLabs 4 accept / 18 reject cases: inclusive boundaries, wrong prefixes, empty/short/overlong IDs, punctuation, whitespace, controls and non-ASCII characters. The consumers pin those counts so an empty corpus cannot pass.

## Live baseline QA — 2026-10-03 02:24–02:28 UTC

HTTP application check:

- `GET https://crichton.tailb3d4b8.ts.net:6351/repos/?qa=fish-p2-20261002`: HTTP 200, `content-type: text/html; charset=utf-8`, body is the Buzz document (`<title>Buzz</title>`, `<meta name="description" content="Buzz web client" />`, asset `/assets/index-DuGYm_0H.js`). The `/repos` form first returns 308 to `/repos/`.
- `GET https://crichton.tailb3d4b8.ts.net:6366/voices/eleven`: HTTP 200; JSON body contains 46 voices. First row: `{"id":"CwhRBWXzGAHq8TQ4Fs17","label":"Roger - Laid-Back, Casual, Resonant (american)"}`.
- Actual request/response logs: `logs/p2-live-http-trace.log` and `logs/p2-live-eleven-trace.log`; response headers/body are saved alongside them. These are client HTTP traces. A bounded `docker logs --since 10m --tail 3000 buzz-dev-relay-1` search found no matching request entry; there is no correlated server-log claim.

Agent Brave check:

- Claimed a new tab at the real `:6351/repos` app, which rendered its authenticated shell and live channel data.
- Clicked Buzz menu → Settings → Voice & audio → Choose voice → ElevenLabs. Filtered by `Roger`; the Roger row with Preview/Select appeared. Clicked Cancel and verified zero dialogs and the voice-settings headings remained. No voice selection was confirmed.
- Final page: `https://crichton.tailb3d4b8.ts.net:6351/repos/settings?group=voice`.
- Browser network log records `/voices/chatterbox` and `/voices/eleven` HTTP 200. Screenshot `logs/p2-live-voice-picker.png` was visually inspected; snapshot: `logs/p2-live-voice-picker.md`; browser requests: `logs/p2-live-network.log`.
- Console: recurring HTTP 401 from the separate `:6881/api/host-stats` endpoint, recorded in `logs/p2-live-console.log`. The checked picker rendered and filtered despite these errors.
- The claimed tab was closed; other agents' tabs were left alone.

This verifies the current served application's voice-browsing flow. It does not verify the Fish save/playback path from this patch. The served picker observed here has Chatterbox and ElevenLabs tabs; Fish integration acceptance still requires a suitable isolated relay/client containing the relevant phase changes. The two full-suite failures and both open handoff tasks remain unresolved.

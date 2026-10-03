# Hidden DM resurface

Accepted kind-9/40002 chat restores every other active, hidden DM member and
publishes each viewer's full, relay-signed NIP-DV snapshot. The sender's hide
stays unchanged. Duplicates, non-chat kinds and streams do not resurface.
The work runs after fan-out in a background task; database/publication errors
warn without delaying or rejecting acceptance. Hides newer than acceptance
are preserved.

The one-shot startup worker repairs historical hides when a retained peer chat
has `created_at > hidden_at`. A later soft deletion still counts: it does not
reverse the chat's acceptance-time effect. Removed memberships and deleted
channels are excluded. Stale snapshots listing an already-unhidden DM remain
candidates, allowing publication retries on subsequent boots. The worker
deduplicates viewers, resolves tenants from DB rows, pages at 100 viewers,
advances past failures, and does not block startup.

Reused prior art: the accepted-event ingest seam, existing
`publish_dm_visibility_snapshot`, moderation-notice unhide convention, and
`archived_discovery` startup-worker pattern. NIP-DV and FORK_MANIFEST mark the
semantics as a carried fork extension. No new migration, endpoint, kind or
dependency was needed.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-170941`.
Base: `ee1edd60b`. Source/test commits, each with the requested co-author and
Signed-off-by trailers:

- `847fada6e` — resurface implementation, startup repair and initial regressions.
- `9e742679c` — persistable membership-event fixture.
- `0bcf72d3c` — multiple hidden group-DM recipients.
- `9bd2b9200` — live snapshots retain unrelated hidden DMs.
- `1b19d1e1a` — retained accepted-message semantics in backfill.

## Artifacts

- `crates/buzz-db/src/dm.rs`, `lib.rs`: conditional UPDATE RETURNING, historical repair, candidate paging and two isolated PG regressions.
- `crates/buzz-relay/src/handlers/dm_visibility.rs`, `dm_visibility_tests.rs`: asynchronous snapshots, startup worker and nine isolated PG regressions.
- `crates/buzz-relay/src/handlers/ingest.rs`, `handlers/mod.rs`, `main.rs`: accepted-message hook and one-shot startup wiring.
- `crates/buzz-test-client/tests/e2e_nostr_interop.rs`, `e2e_nostr_interop/dm_resurface.rs`: two real-relay NIP-DV regressions.
- `docs/nips/NIP-DV.md`, `FORK_MANIFEST.md`, `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`: protocol, series and handoff.
- [Mutation receipts](dm-resurface-mutations.json): all 20 names, execution/filter counts and raw-log paths.

## Verification

Raw receipts are under this worktree's `logs/`, prefixed `dm-resurface-`.

| Check | Before | Final | Log suffix |
|---|---|---|---|
| `cargo test -p buzz-db` | 323 library cases: 113 pass, 210 ignored; 1 integration pass | 325: 113 pass, 212 ignored; 1 integration pass | db-before.log / db-after.log |
| `RUST_TEST_THREADS=1 cargo test -p buzz-relay` | 1,119 library cases: 1,051 pass, 68 ignored; 13 binary pass | 1,128: 1,051 pass, 77 ignored; 13 binary pass | relay-before.log / relay-after.log |
| `cargo test -p buzz-test-client` | 294: 6 pass, 288 ignored | 296: 6 pass, 290 ignored; interop inventory 28 to 30 | test-client-before.log / test-client-after.log |
| PG DB DM selection, `--include-ignored` | 4 hash units | 6 pass: 4 hash units + 2 PG tests | db-pg-restored.log |
| PG relay DM selection, `--ignored` | 0 | 9 pass | relay-pg-restored.log |
| Live NIP-DV, `--ignored` | 8 existing cases | 10 pass, including both additions | e2e-restored.log |
| `just test` | — | 2,036 pass, 763 ignored across its steps | just-test.log |
| Scoped standard Clippy, `-D warnings` | — | DB, relay and test client pass | clippy-standard.log |
| Formatting / original-base size gate | — | pass | format.log / file-sizes.log |
| Built relay / actual readiness | — | build pass / HTTP 200 | runtime-build.log / readiness.log |

An intermediate full relay run and a parent-source control both failed the
unchanged `api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo`
(504 versus 200). The initial and final unfiltered serial runs passed. The
parent failure is retained in `relay-parent-control.log`; no gate was waived.

The broader `--all-targets -D warnings` Clippy check still fails on existing
`crates/buzz-db/src/push_wake.rs` test-module ordering. The parent reproduces
it in `clippy-db-parent-control.log`. That unrelated file was not changed;
the standard scoped command passes.

All PG additions actually ran on SQLx-created disposable databases on the
documented `buzz-postgres` localhost:5432 fixture server. Runtime/E2E used its
separate `dm_resurface_e2e_20261003_170941` DB and an owned Redis container.
The live `buzz-dev-postgres-1` DB was not accessed. Ports 5418–5421 came from
the registry's reserved testing block.

HTTP and NIP-42 WebSocket paths prove unsolicited signed snapshot delivery,
preservation of the rest of the hidden set and sender state, and accepted
reaction/edit/delete exclusions. A built-relay startup restored a historical
hide; a second boot preserved the snapshot ID (`startup.log` and
`runtime-restart1/2.log`). A premature rerun failed before readiness with
connection refusals (`e2e-unready.log`); the final passing run followed actual
readiness. These checks establish protocol behavior; physical-client sidebar
acceptance is a separate rollout check.

## Mutation proof

Every mutation followed a source commit, compiled, executed exactly one
named test and failed an assertion/timeout. Inventories stayed fixed: 1,127
relay or 324 DB tests filtered out. Source bytes were restored with fresh
mtimes before the next check. Final full/focused suites ran after restoration.

The [JSON receipt](dm-resurface-mutations.json) records each named failure:
ingest hook; live/backfill snapshot publication; all group recipients;
sender/removed-member/later-hide preservation; non-message/stream exclusions;
duplicate/empty-change handling; backfill kind/time/author predicates;
retained soft-deleted chat; stale-snapshot retry; second-boot idempotence;
and nonblocking acceptance under a DB lock. All 20 mutants were killed.

## Reproduction commands

```sh
. ./bin/activate-hermit
cargo test -p buzz-db
RUST_TEST_THREADS=1 cargo test -p buzz-relay
cargo test -p buzz-test-client
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
  cargo test -p buzz-db --lib dm::tests -- --include-ignored --test-threads=1
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
  cargo test -p buzz-relay --lib dm_visibility::tests -- --ignored --test-threads=1
RELAY_URL=ws://localhost:5418 \
  cargo test -p buzz-test-client --test e2e_nostr_interop nipdv -- --ignored --test-threads=1
cargo clippy -p buzz-db -p buzz-relay -p buzz-test-client -- -D warnings
cargo fmt --all --check
CHECK_FILE_SIZES_BASE=ee1edd60b just file-size-check
```

For an authorized rollout, first build the Linux relay image from this source
and persist its `BUZZ_IMAGE` pin in the canonical `deploy/compose/.env`. Then:

```sh
cd /Users/sgallant/software_development/projects/buzz
./deploy-dev.sh --no-front-door
```

The dispatcher loads the configured image and gates readiness. Image building
and pinning are prerequisites; `--restart-only` bounces existing containers.
This command is supplied for the orchestrator's rollout.

Owned runtime ports, Redis container and runtime database were cleaned up;
generated relay key and test env were removed (`cleanup.log`). Successful
SQLx test cleanup left no retained databases for this change. Actual check
output is also aggregated in `logs/verification.log`.

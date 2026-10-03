# Huddle archive discovery

Grace-fire archives now refresh relay-signed NIP-29 discovery before evicting
channel subscriptions. Clients can read `archived=true` on kind:39000; a
normal call end adds no system message. Discovery errors are logged without
changing `GraceArchiveOutcome`.

A background startup worker repairs archived, non-deleted channels whose
latest relay-signed metadata omits `archived=true`, including missing metadata.
The selector uses community and d-tag boundaries, Nostr timestamp/id ordering,
and the existing community write guard. Each row carries its database-resolved
community and host. Keyset pagination caps each batch at 100 and advances past
failed rows. Errors never block startup; successful repairs stop matching.
FORK_MANIFEST.md distinguishes the upstreamable grace fix from this fork-local
repair. Existing reaper/discovery/eviction helpers were reused.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-125102`.
Tests used the designated Postgres fixture server, which Docker publishes from
`buzz-postgres` on localhost:5432. The four new tests use separate SQLx-created
databases and the guarded migration wrapper. The live `buzz-dev-postgres-1`
container has no host port mapping and was not accessed. Deployment and
canonical-checkout changes are outside this handoff's scope.

## Verification

| Check | Result | Receipt |
|---|---|---|
| Baseline `cargo test -p buzz-relay` | 1,115 library tests: 1,049 passed, 2 failed, 64 ignored | `logs/huddle-archive-baseline.log` |
| Serial baseline `RUST_TEST_THREADS=1 cargo test -p buzz-relay` | 1,050 passed, 1 failed, 64 ignored | `logs/huddle-archive-baseline-serial.log` |
| Final same serial command | 1,119 library tests: 1,050 passed, 1 failed, 68 ignored | `logs/huddle-archive-final.log` |
| Postgres huddle suite after mutation restoration | 18 passed, including all four additions | `logs/huddle-archive-restored.log` |
| `cargo test -p buzz-relay --bin buzz-relay` | 13 passed | `logs/huddle-archive-main.log` |
| `cargo clippy -p buzz-relay -- -D warnings` | Exit 0, clean | `logs/huddle-archive-clippy.log` |
| `cargo fmt --all --check` | Exit 0 | `logs/huddle-archive-format.log` |

The persistent full-suite failure is unchanged:
`api::mesh_demo::tests::demo_join_forwarded_arm_round_trips_echo` returns HTTP
504 where its assertion expects 200. The default baseline also failed
`telemetry::tests::trace_context_lookup_does_not_enable_callsites`; serialization
removes that failure. The requested full-suite pass is **not achieved**, and no
waiver or deferral was approved. These unrelated source paths were not edited.

The full command stops on the library failure, so binary tests were run explicitly.
Client UI/E2E testing was outside this relay-only test handoff; no live UI behavior
is claimed. Actual check output is collected in `logs/verification.log`.

## Mutation proof

The implementation was committed as `8061aaee9c2d05cfdc85b601676c0c55d796be30`
before mutations. Each mutation compiled and ran exactly one named test with
1,118 filtered out (the library inventory stayed 1,119). Source was restored from
the commit with Git, updating mtimes, before the next check.

| Mutation | Named test and failure | Receipt |
|---|---|---|
| Remove the new discovery emit call from `archive_empty_huddle` | `grace_fire_archive_refreshes_archived_metadata_and_evicts_subscriptions`: expected archived tag `Some("true")`, got `None` | `logs/huddle-archive-mutation-emit.log` |
| Remove the selector's archived-tag predicate | `archived_discovery_selector_uses_latest_metadata_and_excludes_live_deleted_and_repaired_channels`: returns an already-repaired channel as an extra candidate | `logs/huddle-archive-mutation-selector.log` |

The grace-fire test also failed before adding the fix, with the same missing
archived-tag assertion (`logs/huddle-archive-reproduction.log`). Restored tests
prove a later, valid relay signature; subscription eviction; no normal-end chat
noise; latest-snapshot selection; active/deleted/repaired exclusions; wrong-signer
and neighboring-community isolation; missing metadata; cursor pagination;
101-channel repair across two tenants; unchanged event ids on a second run; and
fail-open database errors.

Reproduce the Postgres suite:

```sh
. ./bin/activate-hermit
DATABASE_URL=postgres://buzz:buzz_dev@localhost:5432/buzz \
  cargo test -p buzz-relay --lib audio::transcript_tests -- --ignored --test-threads=1
```

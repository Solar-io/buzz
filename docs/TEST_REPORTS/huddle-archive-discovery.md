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
An isolated running relay and Agent Brave golden path were exercised after the QA
check. Runtime evidence and the sidebar acceptance boundary are below. Actual
check output is collected in `logs/verification.log`.

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

## Isolated runtime QA

Built this worktree's relay (`cargo build -p buzz-relay`) and web bundle
(`pnpm install --frozen-lockfile`, `pnpm build`), then ran the built relay on
loopback ports 5410/5411/5412 and a disposable Redis container on 5413. These
ports came from the registry's reserved testing block. A fresh database,
`huddle_archive_qa_20261003_125102`, was created only on the designated
`buzz-postgres` test server; the live DB was not accessed. This was a temporary
foreground test process, with no service or deployment changes.

HTTP: `http://127.0.0.1:5410/_readiness` returned **200**, body
`{"status":"ready"}`. The request ran between 18:23:04.583839Z and
18:23:04.607246Z. The relay logged GET processing at 18:23:04.595177Z and
completion at 18:23:04.606834Z, status 200, latency 11 ms. Raw headers/body and
correlated logs are in `logs/huddle-archive-http-readiness.log`,
`logs/huddle-archive-http-receipt.json` and
`logs/huddle-archive-request-logs.json`.

Agent Brave URL:
`http://127.0.0.1:5410/repos?c=1a58dd26-6cda-435a-9ee0-8f05d55c525d`.
Clicked manual sign-in with a generated test identity, selected **QA parent**,
entered **QA golden path: real relay message**, and pressed Enter. The message
rendered and its persisted kind:9 was read back through the running relay. The
accessibility snapshot showed the parent channel, both messages and the composer.
The inspected screenshot is `.scratch/huddle-archive-live/parent-golden.png`.
There were zero page exceptions. Console errors included the test origin's CSP
refusal of the optional external host-stats service; this is not a clean-console
claim.

A real audio WebSocket authenticated, joined the fixture huddle and disconnected.
The relay logged the 30 s grace firing at **18:21:37.745748Z** and archive at
**18:21:37.748083Z**. `POST http://127.0.0.1:5410/query` returned **200** and a
new kind:39000 event, id
`961c05b571eda87db726071264d81665af4b05433a6b15c2463909430fee5a8e`,
with `["archived","true"]`; its relay signature verified. The parent still held
exactly two kind:9 messages (seed plus browser send), with no end-of-call chat
noise. Raw before/join/after responses are in
`logs/huddle-archive-live-end-call.log`.

The web sidebar omitted the ended room, but it had already hidden that transport
room under its existing TTL rule. An attempt to give the isolated fixture a
listed lifetime and observe it live timed out. Therefore its post-end absence
is **not** proof of live sidebar disappearance. Desktop/physical-client acceptance
remains unmeasured. The verified runtime mechanism is the grace-fire metadata
refresh, and the verified UI golden path is parent-channel messaging.

Cleanup: closed the owned Brave tab, sent SIGTERM only to the verified worktree
relay PID 77519, stopped/removed the owned disposable Redis container, and dropped
only the fresh QA database. The original full-suite baseline blocker is unchanged.

# P0 verifier fixes

The eight existing owner-admin actions remain enabled and send against a v4
catalog: create, update, delete, unregister, start, stop, restart and
set_claude_pools. Legacy v2/v3 version gates remain authoritative for their
controls. V4 presence remains unknown; the web does not invent an online status.
Named v5 requirements still lock older desktops. V5 controls retain ping-based
presence checks, including in a mixed v4/v5 fleet.

Desktop claims persistent owner/machine-scoped request receipts synchronously
before any asynchronous save. Receipts use persistent WebKit localStorage with
a key outside the disposable-cache prefixes. They survive hook remounts and app
restarts. Mutation receipts expire only after issuedAt + 300 seconds, retaining
the inclusive freshness boundary. Ping receipts last six minutes. A full store
(4,096 live receipts), unavailable storage, or corrupt data refuses new commands;
no live receipt is evicted to admit another. Duplicate requests return conflict.
This is at-most-once application: a crash or save failure after reservation
requires a new request rather than reapplying the original.

Main parent `66bc5b0c8` was incorporated with merge commit `ed43126c9`. Conflict
resolutions were composed from both parents: append-only documentation retains
both sets of additions, Playwright registers both sets of specs, and P0 presence
behavior is composed with W6 Settings and W9a AgentScreen. The accounts editor
checks its selected machine; the Settings footer reports actual ping presence
while Agents, Accounts or Library is mounted. The obsolete AgentsConnectionSettings
wrapper was removed because W6 replaced its AgentsSection export and routes.

## Checks

| Check | Result |
| --- | --- |
| `pnpm --dir web test` | 4,277 tests pass, no failures/cancellations |
| `pnpm --dir desktop test` | 5,775 tests pass, no failures/cancellations |
| Web/desktop `typecheck` | Exit 0 |
| Scoped Biome | 12 web files, 6 desktop files; exit 0 |
| Web build | Exit 0; existing chunk/dynamic-import warnings |
| Size ratchet, merged main base | Exit 0 |
| Agent Brave served-app scenario | 1/1 passes: v5 online/offline/recovery, v4 enabled and sealed Stop send, phone 390/375, unmount cleanup |
| Rust | No Rust implementation changes in this follow-up; main's existing changes were inherited |

The default size command uses the stale origin/main merge-base `ef0d2025683` and
flags ChannelTimeline (1,010 lines) and relay-session (1,325) as new files. Both
are byte-identical to the merged main parent. The supported
`CHECK_FILE_SIZES_BASE=66bc5b0c8 node web/scripts/check-file-sizes.mjs` checks this
branch against that main parent and passes. No size ceiling was changed.

## Fail-then-pass evidence

All implementation changes were committed before mutations. Every source was
restored byte-for-byte from its committed version. Mutation runs retained their
test counts and had zero cancellations.

| Mutation | Named failures | Count |
| --- | --- | --- |
| Revert v4 compatibility logic to merge commit's implementation | All eight `v4 <action> stays enabled and sends through the admin hook` tests; mixed-fleet test | 9 failures / 16 tests |
| Let v4 grant named capabilities | Forged-cap v5 requirement refusal; old-desktop unknown presence | 2 failures / 16 tests |
| Bypass persisted replay claim | Recent replay after simulated restart; >500 commands; reserve-before-save/concurrent delivery; storage failure/corruption | 4 failures / 6 tests |
| Expire receipts at the inclusive freshness boundary | Freshness boundary/expiry/owner-machine isolation | 1 failure / 6 tests |
| Remove live-receipt capacity rejection | Full store refuses new writes without forgetting live ids | 1 failure / 6 tests |
| Revert v4 compatibility, rebuild, run Agent Brave | Same served-app scenario fails its v4 Stop enablement assertion (expected enabled, received disabled) | 1 failure / 1 test |

Restored focused runs: web 16/16 and desktop 24/24. Restored full suites and
rebuilt browser scenario pass as listed above. This covers all ten new web tests
and all six new desktop tests, as well as the changed real workflow assertion.

## Receipts and commits

Receipts are in this worktree's `logs/verification.log`, `logs/p0-web-final.log`,
`logs/p0-desktop-final.log`, `logs/p0-final-exits.json`,
`logs/p0-mutant-v4-{legacy,requires}.log`, `logs/p0-mutant-replay-*.log`,
`logs/p0-browser-mutant.log`, and `logs/p0-browser-final.log`.

- `0c7883d59` — compatibility, persistent replay receipts, regressions and Settings composition.
- `192c026db` — extend the existing pools test's signer import seam for presence.
- `8a6736502` — preserve lock feedback and update the browser scenario for W9a's header actions.

Physical desktop release/relaunch acceptance belongs to R1. This follow-up uses
a disposable identity, mocked relay/desktop acknowledgements in the real served
web application, and a simulated replay-store restart. It adds no deploy script
or external-state mutation.

# Web channel membership refresh

The browser roster previously read a kind-39002 snapshot through a `#d`-only
subscription and accumulated its pubkeys. That subscription receives no live
channel events, so an added agent never became the composer's automatic mention
recipient, and removals could not remove a member from the roster.

`useChannelMembers` now refetches the latest kind-39002 snapshot after a
`member_joined`, `member_left`, or `member_removed` kind-40099 notice. Each
snapshot replaces the roster; older snapshots and cancelled requests cannot
overwrite it. Existing member-name and role handling is preserved.

The open conversation passes its timeline through the route's mention-roster
adapter, reusing the timeline's existing channel-scoped system-message
subscription. Standalone roster consumers use a kind-40099 `#h` subscription
starting at the current second. The roster request also carries `#h`, allowing
it to receive a replacement stored after the notice-triggered fetch. Both
add-member comments now describe the refetch mechanism.

Files:

- `web/src/features/channels/hooks.ts`
- `web/src/features/channels/hooks.members.test.mjs`
- `web/src/features/huddle/useHuddleMentionMembers.ts`
- `web/src/app/routes/repos.tsx`
- `web/src/features/channels/lib/addChannelMembers.ts`
- `web/src/features/channels/ui/AddChannelMembersDialog.tsx`
- `docs/web-channel-members-refresh.md`

## Verification evidence

The baseline at `4c04f82b87c7fad71c2273a7736237cad434af30` ran 4,051 web
tests with no failures. The restored implementation ran 4,058 tests with no
failures, including seven new tests executing the real hooks and RelaySession
against a scripted WebSocket. `pnpm --dir web typecheck` and `pnpm --dir web
build` exited 0. Biome checked all six changed source/test files without fixes.

After committing the implementation, temporarily restoring the five original
source files caused all seven named regression tests to fail (test count stayed
seven). Restoring the fix passed all seven. These include:

- `member_joined refetches the roster and adds the new agent`
- `member_left refetches and removes a pubkey absent from the newest roster`
- `member_removed refetches and removes a pubkey absent from the newest roster`
- `composer soleAgent sees a joined agent through the existing timeline subscription`

A second mutation restored additive merging alone. With the notice subscription
still working, four of seven tests failed: both removal tests, snapshot ordering,
and the composer's removal assertion. The original implementation bytes were
restored before the final 4,058-test run.

Agent Brave exercised this worktree's built client with mocked relay WebSocket
traffic: the main composer initially had no notification hint; a join produced
`Gilfoyle will be notified`; sending then produced a signed message carrying the
agent's `p` tag; a removal cleared the hint. Three roster requests covered
initial load, join, and removal, with one channel system-message subscription.
This validates client reachability, not live-relay acceptance.

`pnpm --dir web check` exited 1 with 30 errors, 10 warnings, and 9 informational
diagnostics. Restoring the original source and running the same command produced
the same baseline findings, including huddle trace fixture formatting and lint
findings in unrelated timeline/settings files. The full-check requirement
therefore remains blocked by existing repository diagnostics.

Receipts are in the project's `logs/verification.log`, with separate baseline,
final-suite, mutation, typecheck, build, formatting, and browser logs beside it.
The requested `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, and `docs/LAST_CHAT.md`
were absent; this document provides the handoff context.

## QA timing correction

The tester seat exercised the served worktree build in Agent Brave and found
that the relay emits its kind-40099 membership system message before storing
the replacement roster (`side_effects.rs`, `handle_put_user` and
`handle_remove_user`). A refetch can therefore return the previous roster.
Its controlled browser reproduction left both joins and removals stale for
more than two seconds; after removal, the next message still tagged the agent.

The roster request now includes `#h` alongside `#d`, so it receives the later
kind-39002 replacement through live channel fan-out. The relay matches `#h`
against `StoredEvent.channel_id` when the signed roster has no `h` tag
(`buzz-core/src/filter.rs`); its stored-event query uses the same channel
scope. No polling or timing delay is needed.

Two additional real-hook regressions simulate a notice, a refetch of the old
snapshot, then a channel-scoped live replacement. Both failed before this
correction and passed afterwards: nine focused tests total. The original
seven regression and mutation results above describe the first implementation.

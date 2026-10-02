# Codex usage in web Vitals

The shared Vitals poller reads `/v1/codex` beside pace and runway, with a
no-header GET and the existing timeout/refresh cadence. HTTP, network, JSON
and schema failures resolve to null. The parser preserves measured zero,
unknown values, stale readings, optional windows, credits and usage buckets.

Codex has its own weekly bar below Claude's combined reading, above crichton,
and shares Claude's phone column. The pop-out adds the plan, weekly and short
windows, credits, and four Today/Last 7 days × Direct/Routed rows. List costs
stay distinct from subscription spend; incomplete totals have a footnote and
estimated costs have `~`. The taller pop-out scrolls within the viewport, and
its usage table scrolls horizontally on phones.

## Checks

Run from `web/`, with the repo's Hermit environment active:

| Check | Result |
| --- | --- |
| `pnpm exec tsc --noEmit -p .` | exit 0 |
| `pnpm exec biome check src/features/vitals tests/e2e` | 45 files; no fixes; exit 0 |
| `pnpm test` | 4,107 tests; 4,107 pass; 0 fail |
| `pnpm build` | exit 0; existing chunk/dynamic-import warnings |
| `pnpm exec playwright test work-shell.spec.ts --grep 'Codex Vitals' --headed` | 6 pass |
| `pnpm exec playwright test work-shell.spec.ts --headed` | 14 pass; 4 existing failures; 2 visual-only skips |

The four failures are the existing `B dry` expectations (desktop Work rail
and phone Channels, each in both Buzz themes). The current combined headline
says `both dry`. Those assertions were left unchanged, as requested.

The six new browser cases exercise zero usage and section order, stale usage
and unlimited credits, a 500 refresh clearing the old number while retaining
Claude, absent weekly quota retaining the usage table, and the phone layout in
both themes. Phone checks assert two columns and no document/strip overflow.
The hub and relay are mocked at their network boundaries; this does not claim
live acceptance of the separately built hub endpoint.

Agent Brave was tried first. Both an independent `routeWebSocket` echo canary
and the existing shell fixtures failed to intercept WebSockets there. The
six Codex-only cases passed on that browser, but its wider shell run had 12
connection-related failures. The final runs therefore use the skill's headed,
isolated browser fallback. Claimed canary tabs and test contexts were closed;
the shared browser was left running.

## Mutation proof

After committing the implementation, the parser's invalid-number fallback
was changed from null to zero. `pnpm test` still executed 4,107 tests and
failed six Codex tests, including **Codex null or malformed numeric fields
never become zero** and **Codex missing or invalid required counters reject
the bucket, never invent zero**. The parser was restored byte-for-byte; the
restored full suite passed all 4,107 tests.

## Receipts

Local command output is in the worktree's `logs/verification.log`, with
individual `logs/codex-vitals-*.log` files for static checks, build, units,
mutation, and browser runs. Feature screenshots are under
`logs/codex-vitals-screenshots/`.

This checkout has no separate `web/AGENTS.md` or `web/TESTING.md`; the root
guides apply. The session's focus-status command returned an auth error
because `BUZZ_PRIVATE_KEY` was not supplied; it did not affect local checks.

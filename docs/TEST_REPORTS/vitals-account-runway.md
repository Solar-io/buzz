# Vitals per-account forecast

The sidebar, combined headline, account forecast lines and hot-account dry text now use one `combinedRunway` result. The account trace records `dryAt`, `beforeReset`, the effective next reset, simulated `projectedAtReset`, and takeover source/time. The existing demand, allocation, horizon and headline fields retain their behavior. The trace is non-enumerable to preserve the original result object's enumerable shape and all existing deep-equality assertions.

Accounts without a simulated trace retain the existing hub/pace fallback. Unknown readings are still unknown. Surviving-account percentages include work arriving from other accounts and stop at the account's own next reset. A first empty moment after that reset is recorded without being described as empty before it.

## Fixture and unresolved criterion

The fixture passes these wire readings through `parseRunway` and `vitalsSummary`, then computes the outlook at **2026-10-03T14:21:30Z**:

| Account | Used | Burn/hour | Next reset | Solo hub dry/usage |
| --- | --- | --- | --- | --- |
| A, default/active | 0.83 | 0.0233 | 2026-10-06T12:59Z | dry 2026-10-03T19:13Z |
| B, parked | 0.01 | 0.00139 | 2026-10-08T20:00Z | no dry time; 0.21 at reset |

Weekend factor is 1.5. A's reset is first, so the unchanged allocator puts all pool demand on A: **3.7035% per weekend hour**. Its 17% remaining lasts **4h 35m 25s**, giving **18:56:54.909Z**. Total remaining capacity is 116%, lasting **31h 19m 18s**, giving **Sun 2026-10-04T21:40:48.202Z**. These expected instants are hardcoded with one-minute/three-minute tolerances; assertions do not derive them from production constants.

Thus the exact numbers produce **A Sat 1:56 PM / B Sun 4:40 PM CDT**. B's line says it takes over from A and never says it will survive to Thursday's reset. The supplied 4:42 PM estimate differs by about two minutes, inside the requested tolerance.

**The requested A≈19:13Z within one minute is incompatible with preserving the allocator.** A's solo 3.495% weekend burn gives about 19:13:21Z, but that is not the pool's allocation. Clarification was requested; no answer or approval to change allocation/waive the criterion was received. The code preserves the explicitly requested headline behavior, and this one acceptance criterion remains open.

Low-burn coverage projects A at about **85%** and B at about **2%** at their respective resets, instead of reusing the hub's solo projections. Another fixture proves spillover in a surviving B's **76%** next-reset usage. Tests also cover a reset-coincident empty moment, already-empty accounts, stale-reset refill, absent simulation and actual rendered-panel wiring.

## Verification

Commands run from `web/` after activating Hermit:

| Check | Result |
| --- | --- |
| Baseline `pnpm test` | 4,320 discovered/pass; zero fail/skip |
| Final/restored `pnpm test` | 4,328 discovered/pass; zero fail/skip |
| Focused supported node runner, `vitalsMath.test.mjs` | 23 discovered/pass; zero fail |
| `pnpm typecheck` | exit 0 |
| `pnpm build` | exit 0; existing dynamic-import/chunk-size warnings |
| `pnpm exec biome check` on four changed Vitals files | four checked; no fixes; exit 0 |
| Headed Playwright live-fixture browser scenarios | two pass; zero page errors |

## Mutation proof

After committing the implementation, the `accountLines` projection lookup was replaced with `null`, restoring its solo-hub behavior. The full supported `pnpm test` runner still discovers **4,328** tests: **4,324 pass / 4 fail**. The failing names are:

- `account lines: Oct 3 parked B takes over from A and never claims it won't run dry`
- `Vitals panel: the live fixture wires its combined result to the rendered account lines`
- `account lines: surviving pool uses simulated reset percentages instead of solo projections`
- `combined accounts: spillover is included in a survivor's next-reset percentage`

The source is restored byte-for-byte in `finally`; the restored full suite passes all 4,328 tests. Both the standalone line formatter and the actual panel wiring fail under the withdrawal.

## Visual method and artifacts

Agent Brave was tried first with an owned tab and a WebSocket echo canary. That canary returned `timeout`; the owned canary tab was closed without closing the shared browser. The supported fallback launches isolated **headed** Playwright Chromium and uses the repo's `openShell`/mock-relay helpers against this worktree's built `dist/` on a temporary free port from Buzz's registry block. The existing Codex fixture is retained; unrelated notification overlays are hidden only for screenshot capture.

The exact Claude readings are intercepted at the usage-hub HTTP boundary. The served UI is exercised through its real Vitals trigger. At **1440×960** and **390×844**, checks assert short text, headline, both lines, lower-row empty time, popover/document bounds and dismissal. Both contexts and the isolated browser are closed in `finally`. The PNGs were visually inspected: the B handoff wraps cleanly on the phone, and neither viewport has horizontal overflow.

Local worktree artifacts:

- `logs/verification.log`: aggregate actual outputs.
- `logs/vitals-baseline-tests.log`, `vitals-final-tests.log`, `vitals-focused-tests.log`, `vitals-mutation-tests.log`, `vitals-restored-tests.log`.
- `logs/vitals-typecheck.log`, `vitals-restored-typecheck.log`, `vitals-build.log`, `vitals-restored-build.log`, `vitals-biome.log`.
- `logs/vitals-browser-check.mjs`, `vitals-browser.log`.
- `logs/vitals-screenshots/vitals-1440.png` and `vitals-390.png`, plus their rendered text receipts.

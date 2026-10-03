# QA-JOB-001: readable Done outcomes

Abnormal job and turn outcomes now start their own second line, before the
truncated work title. Untitled failures also receive that line. Ordinary
completed rows keep their existing markup, typography and 34/44 px layout.
Implementation commit: `8e42370`.

The new Work-status fixtures use seat **Independent Release QA Seat**, channel
**Independent Job QA and Release Engineering**, and GPT coder jobs. They cover
`error · worker-failed`, `error · timeout`, `cancelled`, `dropped · no heartbeat`,
an untitled `error · harness-restart` turn, and ordinary titled/untitled completion.
Both themes exercise the 1440×900 rail/full Work page and 390×844 phone page.

## Fail-first proof

Before any product-code change, all six new cases fail on clipping assertions.
For example, the light rail's worker-failed label ends at **x=1812.32**,
outside the viewport and its truncated headline. All four job outcomes and
the foreground turn fail named bounds checks. The helper checks the label
element and its text range against every clipping ancestor and the viewport;
it requires nonzero dimensions and an actual clipping ancestor. It scrolls
the enclosing row, because scrolling the label itself can horizontally move
the clipped headline and conceal the defect.

The final unchanged six assertions pass after rebuilding the fixed product.
Before/after logs and screenshots live in `logs/qa-job-001-fix/`, with check
output also appended to `logs/verification.log`.

## Checks

| Check | Result |
|---|---|
| `cd web && pnpm test` | 4,225 tests; 4,225 pass; zero failures/skips |
| `cd web && pnpm build` | TypeScript and Vite pass |
| New visibility cases before fix | 6 tests; 6 fail on painted clipping |
| Full `work-status` spec after fix | 13 tests; 13 pass, including all six visibility cases |
| Biome on four changed TS/TSX files | Pass |

Browser command: `pnpm exec playwright test --project=smoke --headed work-status`.
For the fail-first run add `--grep "Done outcomes stay painted"`.
`PLAYWRIGHT_PORT=6399` selects an available port inside Buzz's registered range;
`SHOTS_DIR` points to this project's `logs/qa-job-001-fix/before` or `after`.
The runner serves this worktree's freshly built bundle and mocks only the
relay/ancillary service boundaries through the existing fixture harness.

Agent Brave's MCP and direct-CDP WebSocket echo canaries both timed out. The
supported isolated **headed** Playwright fallback supplied browser coverage.
The temporary Brave tabs were closed. Dependency links referring to QA's
removed scratch checkout were regenerated from the frozen lockfile.

Visually inspected screenshots:

- [Dark Done rail](../../logs/qa-job-001-fix/after/done-outcomes-rail-buzz-dark.png)
- [Phone Work](../../logs/qa-job-001-fix/after/done-outcomes-phone-buzz.png)
- [Full Work](../../logs/qa-job-001-fix/after/done-outcomes-full-buzz.png)

All four outcomes are simultaneously readable. Successful rows retain their
ordinary presentation, the long headline/title truncates, and no horizontal
page overflow or page errors occur in the six new cases.

The optional repository-wide file-size check retains two unchanged findings:
`ChannelTimeline.tsx` (1,010 lines) and `relay-session.ts` (1,325). Their diff
against the starting commit `7e1168f47` is empty; neither belongs to this fix.

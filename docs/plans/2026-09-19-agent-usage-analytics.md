# Agent usage analytics

Sam authorized a finished usage analytics product on 2026-09-19. The supplied
OmniRoute Usage page is the reference for information architecture, density,
visual hierarchy, interactions, charts and tables. This is not an MVP or a
placeholder dashboard. Buzz chrome, theme tokens, typography and accessibility
remain authoritative.

Reference artifacts:

- `/Users/sgallant/MEGA/shared_files/dropbox/OmniRoute — AI Gateway for Multi-Provider LLMs (9_19_2026 4：06：33 PM).html`
- `/Users/sgallant/.buzz/.scratch/omniroute-analytics-20260919.png`
- `/Users/sgallant/.buzz/.scratch/omniroute-analytics-full.png`

## Completion checklist

An item is complete only when the implementation and its relevant verification
exist. No item may be dropped without Sam's explicit approval.

### Product surface

- [ ] Dedicated, deep-linkable full-page `Agents → Usage` view.
- [ ] Reference-order page structure and card/table density inside Buzz chrome.
- [ ] Searchable agent multi-select with Select all, Clear, avatars, names and
      pubkey fallback.
- [ ] One, many and all-agent selections recompute every KPI, chart, table,
      highlight, coverage value and export row.
- [ ] Agent selection and range survive reload, back/forward and copied links.
- [ ] `1D`, `7D`, `30D`, `90D`, `YTD`, `All` and validated custom ranges.
- [ ] Four headline KPIs: total, input, output and estimated cost.
- [ ] Infrastructure, Performance and Highlights summary bands.
- [ ] Calendar heatmap, busiest-day card and weekday chart.
- [ ] Input/output/cost timeline with exact-value pointer and keyboard access.
- [ ] Provider-cost visualization.
- [ ] Service-tier distribution with explicit Unknown/Not reported coverage.
- [ ] Ranked model usage visualization.
- [ ] Account/subscription and agent distribution visualizations.
- [ ] Provider, provider-by-date, agent and model sortable/searchable tables.
- [ ] Provider-diversity score, shares, recent window and honest coverage.
- [ ] CSV export of the filtered data.
- [ ] Loading, updating, empty, disabled, partial, unknown, stale and error states.
- [ ] Accessible table/text alternatives for charts; no color-only encoding.
- [ ] Responsive layouts at 375, 768, 1024, 1440 and 2560 widths.
- [ ] Light/dark themes, reduced motion, keyboard-only use, screen readers and
      maximum supported text zoom.

### Telemetry and accounting

- [ ] Preserve current encrypted owner-only NIP-AM kind `44200` contract and
      historical compatibility.
- [ ] Add optional observed provider/account/service-tier attribution; never
      infer provider or account from model text.
- [ ] Add optional per-provider-call observations with token/cache/cost,
      latency, fallback and cost-provenance fields.
- [ ] Add stable owner-defined subscription/account identifiers plus encrypted
      display labels; never store an API key or credential as identity.
- [ ] Carry the effective model for Claude/Codex turns when the standard ACP
      usage payload omits it, without claiming a billing identity.
- [ ] Preserve exact `u64` handling and per-field incomplete/unknown semantics.
- [ ] Never double-count request observations and aggregate turn totals.
- [ ] Keep wire-reported and manifest-estimated costs visibly distinct.
- [ ] Record stop reason, request coverage and request-breakdown completeness.
- [ ] Add additive, crash-idempotent archive schema migration and raw backfill.
- [ ] Add rebuildable per-request projection table and required scan indexes.
- [ ] Add one transaction-consistent analytics query supporting multi-agent
      filters and adaptive hourly/daily/weekly/monthly buckets.
- [ ] Resolve display names/avatars from current profiles while retaining
      historical pubkey fallback.
- [ ] Truthfully label kind-44200 report count as Turns unless complete provider
      request coverage exists.

### Verification and delivery

- [ ] Rust unit tests for validation, buckets, grouping, completeness, cost
      provenance, reconciliation and diversity math.
- [ ] SQLite migration, crash repair, backfill, orphan and 100,000-row
      performance tests.
- [ ] Publisher tests proving attribution is emitted only when observed.
- [ ] React tests for all filter/range/sort/export/error/partial interactions.
- [ ] E2E screenshots in light/dark and at reference desktop/mobile widths.
- [ ] Named mutations for agent filtering, unknown-to-zero coercion,
      double-counting, cost provenance, cumulative deltas, sorting and DST.
- [ ] Live isolated-relay proof from two agents through encrypted ingestion,
      archive restart and one/many/all dashboard filtering.
- [ ] No source file over the repository ceiling; formatting, lint, typecheck,
      full affected suites and repository build pass.
- [ ] Documentation reconciled after integration and delivery.

## Truthful reference mapping

The reference's API-key dimension becomes **Agent**, because the Buzz agent
pubkey is the accountable identity. Its account dimension becomes the stable
owner-defined subscription/account label. Unsupported Fast/Flex, fallback or
latency fields render `— Not reported` with coverage until a publisher actually
observes them; absence is never displayed as zero. Reference navigation for
Evals, Search, Combo Health, Cache Health and Route Trace is unrelated product
chrome and is not copied into this Usage page.

## Security and rollback

Usage payloads remain NIP-44 encrypted to the owner. Event tags disclose no
provider, account, model, channel, cost or token information. Request
observations contain metrics only—never prompts, outputs, tool calls, URLs,
headers or credentials. Schema changes are additive projections over archived
raw events, so application rollback needs no destructive down-migration.

## Integration status — 2026-09-19

The backend telemetry, additive archive projection, transaction-consistent
analytics query, and full desktop Usage surface are integrated on the feature
branch. The page is routed at `/agents/usage`, persists filters in the URL,
supports the specified ranges and agent selection semantics, exports filtered
CSV, and renders the summary, coverage, chart, highlight, and table surfaces
with explicit unknown and partial states.

Local integration evidence:

- 13 focused Tauri analytics tests pass, including the 100,000-row query,
  migration repair, filtering, incomplete data, cost provenance, cumulative
  reconciliation, provider diversity, and DST boundaries.
- The complete desktop unit suite passes (5,714 tests), including usage filter,
  range, sorting, export, exact `u64`, coverage, and keyboard interaction tests.
- Desktop TypeScript typecheck and production build pass.
- Focused Biome checks pass for every usage analytics frontend and integration
  file.

Independent browser QA, named mutation runs, isolated-relay proof, and final
verification remain delivery gates; this integration record does not claim
those later stages have passed.

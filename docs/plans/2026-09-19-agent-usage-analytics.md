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

Walked item by item on 2026-09-20: **37 of 45 checked, 8 left open.** Every
checked box names the evidence it rests on. **Seven of the eight open boxes are
verification gaps, not missing features** — the code is there and was seen
working; what is absent is a test or measurement that pins it, so the box stays
empty rather than taking an unearned tick. The eighth (documentation reconciled
after delivery) is not this branch's to claim. Nothing here is descoped; the
open items are stated so they can be closed or explicitly deferred by Sam.

### Product surface

- [x] Dedicated, deep-linkable full-page `Agents → Usage` view. — route
      `app/routes/agents.usage.tsx`; `agent-usage.spec.ts` navigates
      `/#/agents/usage` and the state survives `page.reload()`.
- [x] Reference-order page structure and card/table density inside Buzz chrome. —
      the five responsive `agent-usage.spec.ts` runs assert no horizontal
      overflow inside the app shell and capture
      `test-results/agent-usage/usage-{375,768,1024,1440,2560}.png`.
- [ ] Searchable agent multi-select with Select all, Clear, avatars, names and
      pubkey fallback. — Select all, Clear and checkbox selection are covered by
      `agent-usage.spec.ts`; the picker's own `Search agents` box and its avatars
      are asserted nowhere (`UsageControls` has no unit test).
- [x] One, many and all-agent selections recompute every KPI, chart, table,
      highlight, coverage value and export row. —
      `agent-usage.spec.ts::one many all none filter every analytics dimension`,
      `analytics.test.mjs::one many all and none produce distinct global snapshots`,
      `analytics_tests.rs::filters_every_section_and_preserves_unknown_fields`,
      and the live-relay proof's one/many/all reconciliation.
- [x] Agent selection and range survive reload, back/forward and copied links. —
      `agent-usage.spec.ts::back and forward restore date and agent selection`
      plus the reload in the one/many/all test and
      `analytics.test.mjs::URL multi-selection is transmitted to the analytics query`.
- [x] `1D`, `7D`, `30D`, `90D`, `YTD`, `All` and validated custom ranges. —
      `analytics.test.mjs::all presets and custom inclusive last day create exact boundaries`
      and `::invalid and reversed dates fail before IPC`;
      `agent-usage.spec.ts::custom validation range URL sort search and export`.
- [x] Four headline KPIs: total, input, output and estimated cost. —
      `usage.test.mjs::headline reports turns…` and `::headline never invents
      total tokens…`; `agent-usage.spec.ts` asserts `usage-total` and
      `usage-cost`.
- [x] Infrastructure, Performance and Highlights summary bands. — the themed
      `agent-usage.spec.ts` runs measure `.usage-summary-band:nth-child(2) dd`
      and `:nth-child(3) dd` and fail if either selector stops matching; all
      three bands are in the captured screenshots.
- [x] Calendar heatmap, busiest-day card and weekday chart. — all three render in
      the captured page; the data behind them is pinned by
      `analytics_tests.rs::dst_short_day_assigns_next_midnight_to_next_day`
      (day and weekday groups) and
      `analytics.test.mjs::calendar boundaries preserve spring and fall DST`.
- [x] Input/output/cost timeline with exact-value pointer and keyboard access. —
      `usage.test.mjs::timeline focus reveals exact values and arrows move real focus`.
- [x] Provider-cost visualization. — the cost-by-provider-and-source card renders
      in the captured page over the provider aggregation pinned by
      `analytics_tests.rs::filters_every_section_and_preserves_unknown_fields`.
- [x] Service-tier distribution with explicit Unknown/Not reported coverage. —
      `usage.test.mjs::the service-tier share is a dash when there are no turns to divide by`;
      `agent-usage.spec.ts::empty disabled unknown and retry states remain truthful`;
      the tier coverage note renders in the captured page.
- [x] Ranked model usage visualization. — ranked by total tokens in the captured
      page; ranking pinned by `agent_usage_tests.rs::d6_*` and
      `compute_series_ranks_known_total_before_unknown_total`.
- [x] Account/subscription and agent distribution visualizations. — both donuts in
      the captured page; `accounts.test.mjs::a seeded account renders as
      provisional and a confirmed one does not` drives the legend.
- [x] Provider, provider-by-date, agent and model sortable/searchable tables. —
      all four render with sort controls and search boxes in the captured page;
      `usage.test.mjs::table headers change numeric order and search scopes
      visible rows` and `agent-usage.spec.ts::custom validation range URL sort
      search and export`.
- [x] Provider-diversity score, shares, recent window and honest coverage. —
      `usage.test.mjs::diversity reports percent scale and never fabricates empty
      recent score`;
      `analytics_tests.rs::provider_diversity_is_normalized_shannon_and_does_not_infer_model`
      and `::complete_request_diversity_preserves_ninety_nine_to_one_weighting`.
- [x] CSV export of the filtered data. —
      `analytics.test.mjs::CSV preserves unknown cells exact integers quotes and
      prevents formula execution`,
      `accounts.test.mjs::CSV export carries the account dimension and its
      confirmation state`, and the export in `agent-usage.spec.ts`.
- [ ] Loading, updating, empty, disabled, partial, unknown, stale and error states.
      — six of the eight are covered (`agent-usage.spec.ts::empty disabled unknown
      and retry states…` and `::loading and error states expose retry…`, partial
      by the I/O-ratio and `+` marker tests). The `Updating usage…` indicator and
      the `isStale` banner in `AgentUsagePage.tsx` have no assertion at any layer.
- [ ] Accessible table/text alternatives for charts; no color-only encoding. — the
      timeline's `aria-live` exact-value readout is asserted
      (`usage.test.mjs`), the tables carry `sr-only` captions, and every partial
      or seeded state is text rather than colour (asserted in
      `accounts.test.mjs` and the I/O-ratio tests). The two disclosure tables
      (`View daily data`, `View timeline data`) are asserted nowhere.
- [x] Responsive layouts at 375, 768, 1024, 1440 and 2560 widths. — five
      `agent-usage.spec.ts` runs, each asserting
      `scrollWidth <= clientWidth + 1` and capturing a screenshot. (The capture
      is viewport-height: the page scrolls inside its own container.)
- [x] Light/dark themes, reduced motion, keyboard-only use, screen readers and
      maximum supported text zoom. — two themes × `agent-usage.spec.ts::theme
      …, maximum text zoom and reduced motion` and `::theme …, every themed
      surface resolves to a real colour` (luminance-banded per theme, so light
      cannot pass on a dark render); keyboard focus and arrow navigation in
      `usage.test.mjs`; both suites address controls through the accessibility
      tree (`getByRole` with accessible names) rather than by CSS selector.

### Telemetry and accounting

- [x] Preserve current encrypted owner-only NIP-AM kind `44200` contract and
      historical compatibility. — `mod_agent_metric_tests.rs` (routing and
      fail-closed decrypt), the live-relay proof (owner decrypts, outsider
      cannot), and a telemetry-less legacy payload still counted in
      `analytics_tests.rs::wire_and_manifest_costs_keep_distinct_provenance`.
- [x] Add optional observed provider/account/service-tier attribution; never
      infer provider or account from model text. — `buzz-acp`
      `analytics_attribution_reads_only_explicit_nonsecret_labels`;
      `analytics_tests.rs::provider_diversity_is_normalized_shannon_and_does_not_infer_model`;
      `usage_attribution_tests.rs::agents_differing_only_by_model_share_one_account`.
- [x] Add optional per-provider-call observations with token/cache/cost,
      latency, fallback and cost-provenance fields. —
      `analytics_tests.rs::complete_requests_partition_dimensions_without_double_counting`
      (per-request tokens and latency) and
      `::inconsistent_requests_remain_subordinate_and_are_flagged`.
- [x] Add stable owner-defined subscription/account identifiers plus encrypted
      display labels; never store an API key or credential as identity. —
      `usage_attribution_tests.rs::credentials_in_env_vars_never_reach_the_seeded_row`
      and `buzz-acp` `analytics_attribution_never_reads_a_credential_variable`.
- [x] Make a derived account identity structurally distinguishable from an
      owner-confirmed one in storage, on the wire, and in the UI. —
      `analytics_tests.rs::seeded_and_confirmed_accounts_are_reported_apart`,
      `::an_account_without_a_confirmation_flag_is_provisional`,
      `::one_seeded_report_keeps_a_mostly_confirmed_account_provisional`;
      `buzz-acp` `analytics_attribution_distinguishes_seeded_from_confirmed_accounts`;
      four `accounts.test.mjs` tests; `agent-usage.spec.ts::a seeded account
      reads as provisional until the owner confirms it`.
- [ ] Carry the effective model for Claude/Codex turns when the standard ACP
      usage payload omits it, without claiming a billing identity. — implemented:
      `crates/buzz-acp/src/acp.rs` keeps an observed `usage_models` map filled
      from `session/new`, `session/set_model` and `current_model_update`, applied
      only when `usage.model.is_none()`. **No test touches `usage_models` or
      `observe_usage_model` at all**, so the fallback is unverified.
- [x] Preserve exact `u64` handling and per-field incomplete/unknown semantics. —
      `agent_usage_p4a_tests.rs::adjacent_pair_at_u64_max_computes_normally` and
      `::duplicate_at_u64_max_needs_no_successor_probe`;
      `analytics_tests.rs::unknown_token_fields_are_not_coerced_to_zero`;
      `analytics.test.mjs::decimal counters preserve all u64 digits`,
      `::unknown usage is distinct from reported zero` and `::numeric sorting
      distinguishes adjacent values above MAX_SAFE_INTEGER`.
- [x] Never double-count request observations and aggregate turn totals. —
      `analytics_tests.rs::complete_requests_partition_dimensions_without_double_counting`,
      shown to fail (60 vs 30) under the double-counting mutation below.
- [x] Keep wire-reported and manifest-estimated costs visibly distinct. —
      `analytics_tests.rs::wire_and_manifest_costs_keep_distinct_provenance`,
      shown to fail (1.0 vs 0.5) under the provenance mutation below;
      `usage.test.mjs::provenance displays wire estimates unknown separately`.
- [ ] Record stop reason, request coverage and request-breakdown completeness. —
      request coverage and breakdown completeness are asserted
      (`coverage.complete_request_reports`, `inconsistent_request_reports` and
      `request_observation_count` in `analytics_tests.rs`). Stop reason is
      recorded end to end and rendered by `UsageSummary.tsx`, but no test
      asserts the `stopReasons` dimension and the analytics mock never supplies
      it, so that section is never exercised.
- [x] Add additive, crash-idempotent archive schema migration and raw backfill. —
      `analytics_tests.rs::migration_backfill_restart_and_orphan_repair_are_idempotent`
      and `::missing_request_projection_is_rebuilt_from_canonical_archive`, plus
      `store_migration_tests.rs`.
- [x] Add rebuildable per-request projection table and required scan indexes. —
      the same rebuild test, the indexes in `store.rs`'s `SCHEMA`, and
      `analytics_tests.rs::hundred_thousand_rows_keep_exact_totals_with_bounded_query_time`.
- [x] Add one transaction-consistent analytics query supporting multi-agent
      filters and adaptive hourly/daily/weekly/monthly buckets. —
      `analytics_tests.rs::boundaries_accept_dst_and_adaptive_months_reject_invalid_input`,
      `::filters_every_section_and_preserves_unknown_fields`, and the
      100,000-row query. The single-`unchecked_transaction` property itself has
      no dedicated test; it is read off `analytics.rs::query`.
- [ ] Resolve display names/avatars from current profiles while retaining
      historical pubkey fallback. — implemented in `AgentUsagePage.tsx`
      (`displayName` → `name` → `truncatePubkey`). The e2e mock supplies no
      profiles, so only the fallback branch ever runs and even that is not
      asserted (it is visible in the captured page); the current-profile
      resolution path is unverified.
- [x] Truthfully label kind-44200 report count as Turns unless complete provider
      request coverage exists. — `usage.test.mjs::headline reports turns and
      leaves unknown requests unreported`; the captured page reads
      `2 Turns · Requests not reported`.

### Verification and delivery

- [x] Rust unit tests for validation, buckets, grouping, completeness, cost
      provenance, reconciliation and diversity math. — `analytics_tests.rs`,
      `agent_usage_tests.rs`, `agent_usage_p4a_tests.rs` (validation, buckets,
      the accounting ladder, diversity, provenance, reconciliation).
- [x] SQLite migration, crash repair, backfill, orphan and 100,000-row
      performance tests. — `analytics_tests.rs::migration_backfill_restart_and_orphan_repair_are_idempotent`,
      `::missing_request_projection_is_rebuilt_from_canonical_archive`,
      `::hundred_thousand_rows_keep_exact_totals_with_bounded_query_time`,
      `store_migration_tests.rs`.
- [x] Publisher tests proving attribution is emitted only when observed. — the
      four `analytics_attribution_*` tests in `crates/buzz-acp/src/usage.rs` and
      `pool.rs::test_real_publisher_leaves_unobserved_service_tier_unknown`.
- [x] React tests for all filter/range/sort/export/error/partial interactions. —
      filter, range, sort, export and partial in `analytics.test.mjs`,
      `usage.test.mjs` and `accounts.test.mjs`; error and retry at the e2e layer
      in `agent-usage.spec.ts::loading and error states expose retry without
      invented metrics` rather than in a unit test.
- [x] E2E screenshots in light/dark and at reference desktop/mobile widths. —
      `usage-{375,768,1024,1440,2560}.png` and `usage-light-zoom.png` /
      `usage-dark-zoom.png` under `desktop/test-results/agent-usage/`.
- [x] Named mutations for agent filtering, unknown-to-zero coercion,
      double-counting, cost provenance, cumulative deltas, sorting and DST. —
      all seven run on 2026-09-20, each with the named test it broke and the
      observed failure value; see the mutation table below and
      `logs/test-results/usage-named-mutations-20260920.log`.
- [x] Live isolated-relay proof from two agents through encrypted ingestion,
      archive restart and one/many/all dashboard filtering. — all four sub-parts
      in one run; see the section below and
      `logs/test-results/usage-live-relay-full-20260920.log`.
- [ ] No source file over the repository ceiling; formatting, lint, typecheck,
      full affected suites and repository build pass. — typecheck, the full
      affected suites and both builds pass, and the file-size ratchet now prints
      exactly the entry set `main` prints. But that entry set is 10 files over
      the ceiling on `main` already, `cargo fmt --check` fails on `main` too
      (26 hunks under the pinned rustfmt 1.9.0) with 21 further hunks in this
      branch's own new files, `clippy -D warnings` is red on `main` with 20
      errors, and biome reports 3 pre-existing format errors in unrelated files.
      None of that is this feature's doing and none of it can be asserted as
      passing, so the box stays open.
- [ ] Documentation reconciled after integration and delivery. — not this
      branch's to claim: by the repository's own rule, the reconciliation
      against git happens after integration, and writing it here in advance is
      exactly the expiring status the rule forbids.

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

What has since been built and measured, each recorded below with its evidence:
an independent browser QA pass and its three fixes; named mutations for all
seven subjects the checklist lists, each with the test it broke; and the live
isolated-relay proof covering two agents, encrypted ingestion, owner-only
decryption, an archive restart and one/many/all filtering. This record
describes what exists in the tree and what was measured locally.

Built-in Claude/Codex ACP responses currently do not expose an observed service
tier. Their publishers therefore leave `serviceTier` absent and the dashboard
reports it as Not reported; it is never inferred from model, provider, or
account text. The optional wire field remains available for publishers that do
receive an explicit tier from their provider.

## Owner-editable subscription attribution — 2026-09-19

Sam approved seeding the labels that are observable and correcting them in place
("take option one"). The dashboard's account dimension had nothing to group by:
of 49 managed agent records, effectively none carried usage attribution, and
hand-typing three environment variables 49 times is not a usable answer.

### The constraint that shaped the design

NIP-AM forbids inferring provider, account or tier from a model name, pricing
identity, credential, subscription quota, or URL, and `harness_policy` says the
same of harness ids: they "are runtime profile identifiers, not capability
claims". So `claude-code-glm` may not be read as provider `zai`, and model `opus`
may not be read as `anthropic`. A silently-guessed label would corrupt exactly
the subscription comparison the page exists to support.

The resolution: **a seeded value is structurally distinguishable from an
owner-confirmed one in storage, on the wire, and in the UI.**

- **Storage.** `ManagedAgentRecord.usage_attribution` carries `provider`,
  `account_id`, `account_label` and `confirmed` (default false).
  `managed_agents::usage_attribution` owns the derivation and its rules.
- **Wire.** `UsageAttribution.accountConfirmed` is optional and additive; absent
  reads as unconfirmed, and it is invalid without an `accountId`. No archive
  migration was needed — the projection stores the serialized telemetry and the
  raw events stay canonical.
- **UI.** A provisional account reads `… · seeded — unconfirmed` in the donut
  legend, the account breakdown table, its search box and the CSV
  (`owner_confirmed` column), from one helper so they cannot disagree. Text, not
  colour. Coverage reports confirmed identities apart from attributed ones. An
  account is confirmed only when **every** turn in it is — one seeded report
  keeps the whole account provisional, because its totals are the sum of all of
  them.

### What seeding reads, and what it refuses to read

Reads: the structured `runtime` profile identifier; the structured `provider`
field as recorded configuration; an explicitly-configured gateway base URL from
`env_vars` (host and port only — userinfo, path, query and fragment are discarded
before anything is stored, because a URL is where credentials hide); and the
credential the readiness gate requires for that runtime, by **name** only, from
the single table `readiness::credentials` now shares with the gate itself.

Refuses: the model identifier (there is no input on `ObservedAgentConfig` that
could carry it), any credential value, and the harness id read as a provider —
`provider` is populated only from the structured field, so a custom `claude-*`
profile is seeded with **no** provider rather than a guessed one.

With today's credential table the credential name is a function of
`(runtime, provider)`, so it cannot currently split a group those two did not
already split. It is carried because it is the observed *requirement*, and it
will discriminate the moment a runtime's requirement stops being derivable from
them. That is stated rather than presented as coverage.

### Seeded grouping produced for the 49 records on this machine

Measured by running the shipped `seed_records` over a copy of the real
`managed-agents.json` (49 records): 43 rows seeded, 6 left absent, and a second
pass wrote 0.

| Account id | Agents | Members |
|---|---|---|
| `harness=claude-code-glm` | 32 | 16 definitions + their 16 instances (Sheldon Cooper, Bones, Trevor Lefkowitz, Soup Nazi, ESP32, Lord Nikon, Dwight Schrute, Ted Lasso, Gilfoyle, Evie Video Gateway, Rebecca Bloomwood, Cereal Killer, Phantom Phreak, Dinesh, QA Agent, Jared Dunn) |
| `harness=claude;credential=claude-cli-login` | 6 | Acid Burn, Crash Override, Richard Hendricks — definition + instance each |
| `harness=claude-code-glm;gateway=token-plan.ap-southeast-1.maas.aliyuncs.com` | 2 | Work KVM definition + instance |
| `harness=buzz-agent;provider=openai-compat;gateway=pilot.tailb3d4b8.ts.net:6250` | 2 | Evie definition + instance |
| `harness=buzz-agent` | 1 | Aeryn Local definition |
| *(absent — no account at all)* | 6 | **Pollen, Fizz, Honey** and their instances |

Every seeded row is `confirmed: false`.

Three things this measurement confirms. The 21 `opus` and 12 `fable`
`claude-code-glm` agents land in **one** account, because the model is never a
signal. The Work KVM and Evie *instances* join their definitions' gateway
accounts even though neither carries `OPENAI_COMPAT_BASE_URL` in its own
`env_vars` — the definition env layer is resolved exactly as a spawn would
resolve it, so an instance is never split from the subscription it actually
uses. And the three `runtime=null` builtins and their instances are the proof
case: they come out of seeding with the field **absent**, not with a
placeholder, not in a shared bucket, and not as zero.

Seeding runs last in the boot migration chain (after the steps that materialize
and reconcile runtime/provider), fills only an *absent* row, and is therefore
idempotent: an owner-confirmed row and an owner's explicit "this is not a
subscription" both survive every later launch.

### Precedence and the restart badge

At spawn the four `BUZZ_USAGE_*` variables are derived from the row and then the
layered user env is written, so an explicit per-agent or per-persona entry still
wins — the escape hatch `env_vars`'s module header promises for every knob with a
dedicated UI field. `effective_usage_attribution` is the one place that
precedence lives, read by both the spawn and the spawn-config snapshot, so
confirming a label raises the restart badge and the badge cannot disagree with
the running process. The keys are stripped from the snapshot's `env` map so
attribution has exactly one representation there, mirroring `effort_level`.

### Owner edit surface

Three commands: read the grouping, confirm/rename/clear one account across every
agent filed under it, and move or clear a single agent. Editing **is** confirming
— there is no separate flag a caller could forget, so no path writes an owner
value that still reads as seeded. Clearing every field records "no subscription
identity", which seeding will not undo.

### Evidence

The counts below were re-measured on 2026-09-20; the earlier ones in this
section (2,943 Rust / 5,725 frontend / 13 Playwright) had been overtaken by
later commits on the branch.

- Rust, desktop: 2,954 pass in the lib binary, 0 fail, 18 ignored, plus 7 in
  `tests/csp.rs` and 3 in `tests/rodio_mixer_diagnostic.rs` — 2,964 passing
  across all five binaries. (36 were new across seeding, the absent case, spawn
  precedence, validation, grouping, the IPC surface, restart and respawn.)
- Rust, the two crates this touches: `buzz-core` 271 in its lib binary plus 2
  doc-tests, and `buzz-acp` 942 in its lib binary plus 9 in
  `tests/pool_lifecycle_state.rs`, both with the three `BUZZ_ACP_*` pool
  variables unset per `AGENTS.md`'s gotcha 7.
- Frontend: the complete desktop unit suite passes at 5,729 tests, 81 suites,
  0 fail, plus `tsc --noEmit`, the production build, and focused Biome checks.
- Playwright `agent-usage.spec.ts`: 15 pass — 6 behavioural, 5 responsive widths,
  and 2 themes × 2 (text zoom / reduced motion, and themed-surface colour).
- Named mutations were run and each is recorded with the test it broke below.

### Mutation results

| Mutation | Named test that failed |
|---|---|
| `runtime=null` yields a `harness=unknown` placeholder instead of `None` | `runtime_null_yields_absent_attribution_not_a_placeholder` (+4 others) |
| Derived attribution written **after** the user env at spawn | `spawn_lets_an_explicit_env_var_override_the_derived_mapping` |
| `effective_usage_attribution` ignores the user-env override | `effective_attribution_resolves_per_key` |
| `seed_absent_attribution` overwrites an existing row | `seeding_never_overwrites_an_existing_row` |
| Boot migration re-seeds over an owner decision | `seeding_is_idempotent_and_preserves_owner_decisions` |
| `apply_persona_snapshot` clears the row on every start | `restarting_an_instance_does_not_rewrite_its_confirmed_row` |
| `accountRowLabel` renders seeded and confirmed alike | 3 frontend tests + the Playwright confirm-flow test |

**One mutation did NOT fail a test, and that is the most useful result here.**
Replacing the create-path call's definition-slug argument with `None` — severing
respawn inheritance while keeping the call — survived both the unit suite and
`clippy -D warnings`. `create_managed_agent` has no test harness in this repo;
the established pattern tests the pure resolvers it calls, and
`resolve_created_avatar_url` carries the identical exposure. Fully deleting the
call *is* caught, by clippy's unused-import error. The call site was restructured
to key off `record.persona_id` — the field spawn resolution and the orphan checks
already depend on — which narrows the silent-mutation surface but does not close
it. The covering check is a real create-from-confirmed-definition against the
running app.

### Known limitations

- Archived reports are unchanged by a confirmation. The dashboard's account
  labels update only as agents restart and publish with the new derived
  environment; the page's coverage note reflects the mapping immediately but does
  not retroactively relabel history. That is the honest behaviour, not a bug.
- The file-size ratchet note here described a state that has since been
  corrected, and is kept only so the sequence reads straight. This change had
  added 6 lines across 4 files the ratchet had pinned
  (`discovery/tests.rs` +1, `migration.rs` +2, `managed_agents/runtime.rs` +2,
  `spawn_snapshot/tests.rs` +1) for a required struct field and two module
  wirings, which made `discovery/tests.rs` and `migration.rs` read as *new*
  violations because they were over the ceiling but static on `main`. All six
  lines were bought back on 2026-09-20 (see the ratchet-parity commit):
  `node desktop/scripts/check-file-sizes.mjs` now prints the identical 10
  entries with the identical counts here as it does on `main`.

## Independent QA remediation — 2026-09-19

An independent QA pass raised four defects. Three were fixed; the fourth was
taken to Sam and declined. What each one turned out to be:

### Boot seeding — the untested layer, not a broken one

QA read a 28-record dev store after two app boots, found no `usage_attribution`
rows and no `seed-usage-attribution:` log line, and concluded the per-record
decision was failing. It was not: feeding that exact store through the shipped
`seed_records` seeds 22 rows and leaves 6 absent, and running the real app from
this branch against a copy of it seeds 22 of 28 in the instance's own store and
22 of 28 in the canonical dev store it shares, with both log lines present and
the rows still in place afterwards. A second launch seeds 0 of 28 in each and
rewrites neither file.

The measured boot therefore did not contain this code. No `buzz-desktop` binary
carrying it existed before the boot artifacts QA inspected were written, and the
pre-feature binary still on disk at
`projects/buzz/desktop/src-tauri/target/debug/buzz-desktop` resolves to exactly
the data directory QA read — it contains `patch-json-records` and no
`seed-usage-attribution` string at all.

Two real defects sat behind the wrong conclusion, and both are fixed.

- **The file and directory layer had no tests.** Every test called the pure
  `seed_records`. Removing the write entirely left 2,948 desktop tests green.
  Ten `on_disk` tests now drive real stores in temp directories, following
  `materialize`'s `*_in_file` pattern, and `seed_target_dirs` /
  `seed_usage_attribution_in_dirs` are split out so the directory resolution is
  reachable without an `AppHandle`.
- **The no-op branches were silent.** A missing store logged nothing, and a pass
  that seeded zero rows returned without a word, so "ran and found nothing to do"
  and "never ran" produced identical logs. Every branch now reports.

### I/O ratio — marked, not declined

The ratio dropped `incomplete` while both its band-neighbours propagated it, and
it divides a complete input total by a partial output total. **The decision is to
mark it, not to decline to compute it**: the figure is still useful to an owner,
and the rest of the page marks partial values rather than hiding them. The marker
is `(partial)` rather than `+` because `+` asserts a lower bound, and a partial
denominator makes the displayed ratio an *upper* bound — so `+` here would be a
new false claim rather than the propagation of an existing one. An absent input
or output, or a reported zero output, still renders `—`.

### Light-theme contrast

All three light dimension values were below 4.5:1 for normal-size text, and they
colour values and axis labels, not only chart fills. They are darkened along
their own hue and saturation rather than replaced, so the page keeps the same
three colours. The theme test asserted only root font size and horizontal
overflow — facts identical in both themes — so it could not fail on a colour
regression; it now emulates the colour scheme, proves which theme rendered from
the measured surface luminance, and asserts computed contrast per token.

### Archived-usage author trust — BOTH REMEDIES DECLINED BY THE OWNER

**Status: declined owner decision, 2026-09-19. This is an accepted risk, not an
oversight.**

Two facts compose: `accountConfirmed` is read from the publisher-supplied
`BUZZ_USAGE_ACCOUNT_CONFIRMED` and is never checked against the owner's own
local `usage_attribution` record at read time
(`crates/buzz-acp/src/usage.rs:66-69`), and the archive subscription for kind
44200 is `{kinds:[44200], #p:[owner]}` with no author allowlist, so
`agent_pubkey` is whoever signed the event and is never intersected with the
owner's managed-agent list (`desktop/src-tauri/src/archive/mod.rs:449-470`).

**Consequently, archived usage is forgeable: any nostr key can publish a kind
44200 event p-tagged to the owner and appear on this dashboard as an agent with
attacker-chosen provider, account, token counts, cost and `confirmed: true`.**

Both candidate remedies were put to Sam and both were declined:

- Treat `confirmed` as trustworthy only when it matches the owner's own local
  `usage_attribution` record for that agent, rendering an unmatched
  publisher-asserted `confirmed` as provisional — would go at
  `crates/buzz-acp/src/usage.rs:66-69`.
- Restrict the archive subscription to the owner's managed-agent authors — would
  go at `desktop/src-tauri/src/archive/mod.rs:449-470`.

Envelope hygiene is unaffected and unchanged: tags carry only `p` and `agent`,
content is NIP-44 encrypted to the owner, and request observations add only
latency and fallback and are never added to parent turn totals.

### The page's theme tokens did not apply — every themed surface was invisible

`usage.css` consumed the app's semantic theme tokens as bare values —
`background: var(--card)`, `color: var(--foreground)`,
`border: 1px solid var(--border)`, and the same for `--muted`, `--accent`,
`--primary`, `--ring` and `--muted-foreground`. Those tokens hold bare HSL
triplets and are consumed everywhere else in the repo as `hsl(var(--card))`, so
every one of those declarations was an invalid value and was dropped. The
computed background of `.usage-card` in the running page was `rgba(0, 0, 0, 0)`:
the cards had no surface, no border and no muted text of their own, and the page
showed through to the app shell's background.

**79 declarations in `usage.css`** are now wrapped, plus **5 bare `var(--muted)`
references in `UsageCharts.tsx`** inline styles — the donut's empty state and
three `color-mix()` heatmap fills, which were invalid for the same reason and
left the heatmap with no cells at all. The three `--usage-*` dimension tokens are
the opposite case and stay unwrapped: they hold full hex colours declared in
`usage.css` itself, and wrapping them is what would break them. `--popover` and
`--secondary` are never referenced by this page. Nothing was restyled; the fix
only makes the existing declarations take effect.

### Contrast re-measured against the surfaces that now exist

The earlier light-contrast fix measured against the nearest non-transparent
ancestor, because that was what was actually behind the text. With real card
surfaces the backdrop changed, so all six values were re-measured — and the
basis in the old header comment was wrong twice over: the running Buzz themes
derive their palette from GitHub Light / GitHub Dark at runtime, so the light
card is `#ffffff`, not theme.css's static Catppuccin Latte `#eff1f5`, and the
dark card is `#24292e`, not the `#1a1a1a` page the transparent cards had been
showing through to.

| Token | Light on `#ffffff` | Dark on `#24292e` |
|---|---|---|
| `--usage-input` | 5.35:1 | 4.75:1 |
| `--usage-output` | 5.37:1 | 7.73:1 |
| `--usage-cost` | 5.34:1 | 8.02:1 |

All six clear WCAG AA 4.5:1 for normal-size text, so no value needed darkening
further. Dark `--usage-input` is the tightest and it moved the wrong way — from
5.64:1 against the page to 4.75:1 against the card — so it is the one to
re-check if either the card token or that hex ever changes. Row-hover and
bar-hover blends were checked too (lowest 10.59:1). The dimension colours sit
only on card surfaces; the `--muted` surfaces they would fall below AA against
(3.95:1 dark) carry decorative fills, never text.

### The check that was missing

`agent-usage.spec.ts` gains `theme light|dark, every themed surface resolves to
a real colour`: five samples — card background, card border, page background, a
`--muted` chip, and one unwrapped `--usage-*` fill — asserted non-transparent,
then luminance-banded per theme so the light case cannot pass on a dark render.
Mutating `.usage-card`'s `background` back to bare `var(--card)` fails both
named tests with `computed to rgba(0, 0, 0, 0)` while all 13 pre-existing tests
still pass, which is the measurement of why this defect survived a green suite.
The inverse mutation — wrapping `--usage-input`, a hex token, in `hsl()` — fails
the fifth sample, so the test pins both directions.

## Named mutations for the seven checklist subjects — 2026-09-20

The checklist names seven subjects: agent filtering, unknown-to-zero coercion,
double-counting, cost provenance, cumulative deltas, sorting and DST. Each one
below was run the same way — break the production mechanism, run the named test,
confirm it fails and that the failure *value* names the mechanism, restore the
file, confirm `git status --short` is empty. Tests for several of these already
passed, which is not the same thing, and is why this was run.

Full commands and verbatim output:
`logs/test-results/usage-named-mutations-20260920.log`.

| Subject | Mutation | Named test that failed | Observed failure |
|---|---|---|---|
| Agent filtering | `analytics::query`'s row filter ignores `selected` | `archive::analytics::tests::filters_every_section_and_preserves_unknown_fields` | `assertion failed: !single.summary.usage.input_tokens.incomplete` — agent `b`'s absent count leaked into agent `a`'s selection |
| Unknown-to-zero coercion | `TokenAccumulator::add`'s `Unknown` arm writes `Some(0)` instead of marking incomplete | `archive::analytics::tests::unknown_token_fields_are_not_coerced_to_zero` | `left: Some("0")` / `right: None` |
| Double-counting | each complete request observation is also added to `summary` | `archive::analytics::tests::complete_requests_partition_dimensions_without_double_counting` | `left: Some("60")` / `right: Some("30")` — the turn's 30 plus its 10 + 20 requests |
| Cost provenance | `manifest-estimated` costs indexed into the `wire-reported` bucket | `archive::analytics::tests::wire_and_manifest_costs_keep_distinct_provenance` | `left: Some(1.0)` / `right: Some(0.5)` — an estimate blended into a bill |
| Cumulative deltas | `window_probe_keys` stops emitting the `turnSeq - 1` predecessor key | `archive::analytics::tests::analytics_cumulative_accounting_uses_predecessor_outside_window` | `left: Some("999")` / `right: Some("20")` — the ladder fell to the turn-reported value instead of `110 - 90` |
| Sorting | `sortUsageRows`'s direction multiplier inverted | `table headers change numeric order and search scopes visible rows` (`usage.test.mjs:73`) | `actual [B, A, Not reported]` / `expected [A, B, Not reported]` at line 87 — nulls still last, only the direction broken |
| DST | civil-day index computed as `(at - day_boundaries[0]) / 86_400` instead of through the supplied boundaries | `archive::analytics::tests::dst_short_day_assigns_next_midnight_to_next_day` | `left: 1` / `right: 0` — the 23-hour spring-forward day put the next day's first report back on day 0 |

**All seven produced a named failure, and none was an equivalent mutant.** One
candidate was rejected *as* an equivalent mutant rather than counted: flipping
`bucket`'s `partition_point(|b| *b <= at)` to `*b < at` cannot be detected by
the DST test, whose event sits one second past the boundary, so no half-open
versus closed change can move it. The mutation used instead — a hardcoded
86,400-second day — is the assumption those boundaries exist to defeat.

Both runners were verified before being trusted: the Rust selection reported
`running 6 tests` (6 ran, 2,965 filtered, so the filter matched rather than
matching nothing), and the frontend file reported `tests 7`.

Earlier per-subject mutation logs from commit `fcb46339` survive under
`logs/test-results/mutations-fcb46339/`. They are superseded by the runs above,
which were made against the current head of the branch.

## Live isolated-relay proof — 2026-09-20

All four sub-parts the checklist names are delivered in one run:
`archive::live_usage_relay_tests::live_two_agent_usage_survives_restart_and_filters_one_many_all`
(`desktop/src-tauri/src/archive/live_usage_relay_tests.rs`), against the
repository's own isolated harness — Compose project `buzz-harness` with its own
Postgres/Redis/MinIO and a relay built from this branch on `:3030`
(`scripts/start-isolated-test-relay.sh`), whose database is dropped and
recreated at launch. Nothing reads or writes the real relay or
`~/.buzz/archive/archive.db`. Commands and verbatim output:
`logs/test-results/usage-live-relay-full-20260920.log`.

The single result line, wrapped:

```
LIVE_USAGE_PASS relay=ws://localhost:3030
  owner=2b67da53… agent_a=453665c0… agent_b=9f615cf6…
  published=2 owner_served=2 outsider_served=0
  outsider_closed=restricted: p-gated events require #p matching your pubkey
  owner_decrypted=2 outsider_decrypted=0
  persisted=2 rows_after_restart=2
  one_a_input=1000 one_b_input=22 many_input=1022 all_input=1022
  none_reports=0 available_agents=2
```

| Sub-part | Evidence |
|---|---|
| Two agents publish encrypted kind 44200 | `published=2`; two distinct keys, each on its own NIP-42-authenticated socket, each event carrying only `p` and `agent` tags over a NIP-44 ciphertext. The relay's own database shows both rows with `public_tag_count=2` and the private provider/account labels absent from the stored content. |
| Ingestion, owner decrypts, outsider cannot | `owner_served=2 owner_decrypted=2`, and two independent refusals of the outsider: the relay closed its owner-scoped filter with `restricted: p-gated events require #p matching your pubkey`, and the outsider key also failed to decrypt the ciphertexts the owner had already fetched. The archived row is asserted to be plaintext, so the owner-only decrypt-at-ingest demonstrably ran. |
| Archive restart | `persisted=2 rows_after_restart=2` — ingested through the shipped `plan_archive` → `commit_archive`, the connection dropped, the same file reopened with the production `store::open_archive_db`, and the rows counted and queried again. |
| One / many / all filtering | `one_a_input=1000`, `one_b_input=22` (asserted to differ, so the selections discriminate), `many_input=1022`, `all_input=1022`, cleared selection `none_reports=0` with `available_agents=2` still offered. `1000 + 22 = 1022 = many = all`. |

**The proof was shown to fail, three ways**, each a production mutation run
against the same live relay and then reverted:

| Mutation | Assertion that failed |
|---|---|
| `pipeline.rs` routes kind 44200 down the ephemeral path | `live_usage_relay_tests.rs:432` — `one owner_p bucket`, `left: 0` / `right: 1` |
| `store.rs`'s `open_archive_db` opens an in-memory database instead of the file | `live_usage_relay_tests.rs:495` — `both rows must survive closing and reopening the archive`, `left: 0` / `right: 2` |
| `analytics.rs`'s row filter ignores the agent selection | `live_usage_relay_tests.rs:516` — `one agent, one turn`, `left: 2` / `right: 1` |

The middle one is the important one: it is what makes the restart sub-part an
assertion about durability rather than a formality.

Two things this proof does not claim. The relay refuses a kind-44200 whose `p`
tag is not the agent's *registered* owner, so each agent presents the owner's
NIP-OA `auth` tag on its AUTH event and the relationship is materialized the way
production materializes it — the first attempt here was rejected with
`restricted: agent-turn-metric \`p\` tag must be the registered owner of this
agent`, which is how that requirement was found. And production's
`query_buckets` re-asks the relay over the authed HTTP `/query`, which needs an
`AppState`; this test fills the bucket's `returned_ids` from the owner's own live
REQ against the same relay, so the relay still answers "which of these match
this owner-scoped filter" but the HTTP transport is not the one exercised.

The test is gated on `BUZZ_LIVE_USAGE_RELAY` and prints `LIVE_USAGE_SKIP`
without it, because the ordinary suite has no relay.

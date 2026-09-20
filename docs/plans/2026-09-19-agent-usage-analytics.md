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
- [ ] Make a derived account identity structurally distinguishable from an
      owner-confirmed one in storage, on the wire, and in the UI.
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

- Rust: 2,943 desktop tests pass (36 new across seeding, the absent case, spawn
  precedence, validation, grouping, the IPC surface, restart and respawn), plus
  the full `buzz-core` suite at 271 tests and the full `buzz-acp` suite at 942.
- Frontend: the complete desktop unit suite passes (5,725 tests, 12 new), plus
  `tsc --noEmit`, the production build, and focused Biome checks.
- Playwright `agent-usage.spec.ts`: 13 pass (the 12 existing plus a confirm-flow
  test that drives the real editor through the mock IPC bridge).
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
- The repository file-size ratchet was already failing on this branch before this
  change (11 files over the 1000-line ceiling at the preceding commit). This
  change adds 10 lines across 5 of those already-over files
  (`commands/agents.rs` +4, `migration.rs` +2, `managed_agents/runtime.rs` +2,
  `discovery/tests.rs` +1, `spawn_snapshot/tests.rs` +1) for an unavoidable
  required struct field and two module wirings. `types.rs` and
  `personas/snapshot/import.rs`, which this change would otherwise have pushed
  *over* the ceiling, were kept under it.

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
  Nine `on_disk` tests now drive real stores in temp directories, following
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

**78 declarations in `usage.css`** are now wrapped, plus **5 bare `var(--muted)`
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

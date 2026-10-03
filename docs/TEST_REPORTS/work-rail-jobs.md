# Background Work rail jobs — 2026-10-03

Built sections 2–8 and 10 of the supplied plan: the kind-30624 `job:` validator and SDK builder; signed CLI start/beat/end; relay validation and private-channel E2E coverage; an ACP sweep guard; and separate web Running/Done jobs with deterministic engine/role labels and a 300-second dropped cutoff. The product follows VISION_ACTIVITY's visible work and honest outcomes. No authorization paths changed.

Fleet scripts/plugin, global CLI installation and deployment belong to the separate relay-first rollout. This session uses only its provisioned worktree and disposable integration infrastructure; it never writes to the existing relay or databases, restarts an existing service, or edits ~/.claude or claude-mods.

## Suite counts and results

Counts include ignored cases where stated. Raw output is in the worktree's gitignored `logs/` directory and consolidated into `logs/verification.log`.

| Suite | Before | After | Result |
| --- | ---: | ---: | --- |
| buzz-core unit | 301 | 311 | pass; two doctests also pass in both runs |
| buzz-sdk unit | 269 | 271 | pass |
| buzz-cli unit | 483 | 490 | pass; one unchanged ignored doctest |
| buzz-relay lib | 1113: 1047 pass / 2 fail / 64 ignored | 1115: 1050 pass / 1 fail / 64 ignored | mesh echo timeout remains; telemetry callsite test failed in baseline and passed in final |
| buzz-acp unit | 1021 | 1022 | pass, with the three harness pool env vars unset |
| buzz-acp integration | 9 | 9 | pass |
| web unit | 4213 | 4225 | pass |
| Work-status browser smoke | 5 | 7 | pass, headed, including two job themes and existing phone cases |
| isolated relay task-status E2E | 3 existing cases | 5 | pass, all ignored cases explicitly executed |
| buzz-agent fake_llm control | 20 discovered in just test (19 pass / 1 fail) | 20 | pass on direct rerun; this crate is unchanged |

Focused case counts: core task_status 15 → 25, SDK 3 → 5, CLI status 10 → 17, relay task_status 2 → 4, ACP task_status 7 → 8, and the four Work unit files 46 → 58. These are selections of the full suites above; every mutation preserves the final selection's count. The relay E2E baseline runs the three existing cases, with the two new cases filtered out.

`pnpm build`, release CLI build, production-target Clippy for all five changed crates, Rust format, changed-file Biome and the file-size ratchet against d17900f3f pass. All-target Clippy finds the unchanged `claims_gate.rs:878` needless-range-loop lint. Full relay tests stop on the baseline mesh echo 504. `just test` runs against fresh Postgres/Redis containers: eleven steps passed; workspace integration stopped on `buzz-agent/tests/fake_llm.rs::steer_folds_into_active_turn_without_cancelling`. A direct rerun of that unchanged file passes 20/20. The repeat of `just test` passes all 12 steps, including workspace integration.

The shared Agent Brave WebSocket interception canary returned a socket error, so mocked browser acceptance used the supported headed Playwright fallback. Both applied theme classes are asserted. Four distinct job screenshots are in `web/.scratch/job-shots/`; Running and Done screenshots were inspected.

## Runtime CLI and isolation

The release binary's real `status job` help exposes all three commands. With a generated signer in a new private channel on the temporary relay: start, beat and end acknowledge acceptance; a late beat exits 1 with `job already ended`; repeat end exits 0 with `unchanged:true`. All six command receipts are in `logs/job-isolated-cli-*.log`.

Test ports are selected from the registered Buzz block, after checking availability. The fixture creates uniquely named temporary Postgres/Redis containers with no existing volumes, runs a loopback relay with fresh signing material and a private worktree .env, and removes the process, containers and .env on all exit paths. A wrapper routes legacy test-script container names to these private containers, never the installed stack. Media/object-store endpoints are disabled for this status-only test.

Private-channel denial is accepted only as explicit `CLOSED` with `restricted: not a channel member`, or empty EOSE. Timeouts are failures. The two added E2E cases fail when only the relay binary's job namespace is disabled while the prebuilt test client remains unchanged: 3 pass / 2 fail, total 5. Restoring the relay produces 5/5 passing.

## Named mutation proof

All changes were committed before mutation. Each mutation restores original bytes and refreshes mtimes. One initial UI mutation failed TypeScript compilation; it is excluded from mutation kills and was replaced with a compiling renderer mutation. The table lists all 34 valid unit/browser mutations, plus the relay E2E mutation above. There are 35 named kills total.

| Mutation | Fixed count | Named failing tests |
| --- | --- | --- |
| web-job-accept | 58 | `done jobs use independent keys alongside the same agent turn`; `silent running jobs drop after 300 seconds and a late beat revives them`; `job errors cancellations and Done channel scope remain honest`; `job rows use the literal 300 second cutoff and never stall`; `job rows keep three distinct concurrent keys and sort newest starts first`; `job parser accepts every field and optional launching turn`; `job parser rejects invalid ids roles bindings and lifecycle fields`; `three jobs in one author channel stay independent of turn stores and replace by NIP order`; `jobs prune below the day floor and retain triggers for queued suppression`; `a background job never suppresses the seat reaction or borrows its latest chat`; `finished jobs count in Done only after the status REQ is ready` |
| web-job-reject | 58 | `job parser rejects invalid ids roles bindings and lifecycle fields` |
| web-stale-cutoff | 58 | `silent running jobs drop after 300 seconds and a late beat revives them`; `job rows use the literal 300 second cutoff and never stall` |
| web-job-fold | 58 | `job errors cancellations and Done channel scope remain honest`; `job rows keep three distinct concurrent keys and sort newest starts first`; `three jobs in one author channel stay independent of turn stores and replace by NIP order` |
| web-engine | 58 | `job rows keep three distinct concurrent keys and sort newest starts first`; `engine labels are deterministic by model prefix` |
| web-job-prune | 58 | `jobs prune below the day floor and retain triggers for queued suppression` |
| rust-job-accept | 25 | `job_turn_optional_but_valid`; `job_lifecycle_rules_match_turn`; `accepts_job_running_and_terminal`; `job_model_and_title_bounds`; `job_id_bounds_and_charset` |
| rust-job-reject | 25 | `job_requires_role`; `job_rejects_progress_session_content`; `job_d_channel_must_equal_h`; `job_turn_optional_but_valid`; `job_lifecycle_rules_match_turn`; `accepts_job_running_and_terminal`; `job_model_and_title_bounds`; `job_role_charset`; `job_id_bounds_and_charset` |
| rust-turn-backcompat | 25 | `turn_and_detail_unchanged`; `accepts_running_and_terminal_lifecycle` |
| cli-auto-freshness | 17 | `start_auto_channel_picks_single_running_turn` |
| cli-after-end | 17 | `end_is_idempotent`; `beat_refuses_after_end` |
| cli-monotonic | 17 | `beat_created_at_is_monotonic` |
| cli-recreate | 17 | `job_id_default_matches_charset`; `beat_recreates_from_flags_without_head`; `clip_title_is_char_safe` |
| cli-title | 17 | `clip_title_is_char_safe` |
| cli-id | 17 | `job_id_default_matches_charset` |
| acp-sweep | 8 | `sweep_ignores_job_heads` |
| sdk-job-accept | 5 | `build_job_roundtrips_through_core_validator` |
| sdk-job-reject | 5 | `build_job_refuses_invalid_input` |
| relay-job-accept | 4 | `accepts_job_head` |
| relay-job-prefix | 4 | `job_rejection_is_prefixed`; `rejection_is_prefixed_invalid_task_status` |
| web-job-render | 7 | `[smoke] › tests/e2e/work-status.spec.ts:149:5 › desktop 1440 · buzz › background jobs get their own Running rows, coexist, and finish into Done`; `[smoke] › tests/e2e/work-status.spec.ts:149:5 › desktop 1440 · buzz-dark › background jobs get their own Running rows, coexist, and finish into Done` |
| core-channel | 25 | `job_d_channel_must_equal_h` |
| core-job-length | 25 | `job_id_bounds_and_charset` |
| core-role-required | 25 | `job_requires_role` |
| core-role-length | 25 | `job_role_charset` |
| core-model-length | 25 | `job_model_and_title_bounds` |
| core-job-turn | 25 | `job_turn_optional_but_valid` |
| core-job-progress | 25 | `job_rejects_progress_session_content` |
| core-job-session | 25 | `job_rejects_progress_session_content` |
| core-job-content | 25 | `job_rejects_progress_session_content` |
| web-job-suppression | 58 | `a background job never suppresses the seat reaction or borrows its latest chat` |
| web-job-latest | 58 | `a background job never suppresses the seat reaction or borrows its latest chat` |
| web-job-done-ready | 58 | `finished jobs count in Done only after the status REQ is ready` |
| web-job-done-rows | 58 | `done jobs use independent keys alongside the same agent turn`; `silent running jobs drop after 300 seconds and a late beat revives them`; `job errors cancellations and Done channel scope remain honest`; `finished jobs count in Done only after the status REQ is ready` |

The accept/reject mutations disable the job arm or validation checks. Granular mutants widen literal bounds, drop role requirements, skip channel/turn checks and separately admit forbidden progress/session/content. CLI mutants remove terminal refusal, freshness, monotonic timestamps, fallback creation, character clipping and valid generated ids. Web mutants remove parsing, independent folding/pruning, engine labels, the literal cutoff, separate reaction rows, chat exclusion, Done readiness/rows and rendered job labels. The ACP mutant removes the namespace filter.

## Remaining repository gates

- The existing relay mesh echo test returns 504 instead of 200, before and after this feature.
- The existing CLI claims-gate test loop fails strict all-target Clippy. Production-target Clippy passes.
- The first broad integration run hit an unchanged agent steering test; its direct control and the complete `just test` repeat pass.

All requested job behaviors and added tests are implemented. These broader repository failures are reported as failures, not counted as successful verification or deferred by user approval.

`just-test` aggregate: 1842 passed / 1 failed / 436 ignored across 25 reported test targets. These are first/repeated feature-tree runs, not a main-branch baseline; the first workspace run stopped early on failure.

`just-test-restored` aggregate: 2036 passed / 0 failed / 757 ignored across 71 reported test targets. These are first/repeated feature-tree runs, not a main-branch baseline; the first workspace run stopped early on failure.

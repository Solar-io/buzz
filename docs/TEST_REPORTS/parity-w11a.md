# W11a: Library and Blank agent creation

W11a relocates the existing Definitions, Teams, Catalog and snapshot-import panels into four Library tabs, replaces duplicate creation buttons with one New agent menu, and builds Blank creation from settings cards. Definition/team creation stays locked for P2, including when a desktop advertises its named capability.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-172238`.
Branch: `codex/buzz-codex-20261002-172238`.
Specification: `buzz-agent-mgmt-parity/PLAN.md` §3, §5, §6 W11a and §7; approved `design/SETTINGS_REDESIGN.md` and settings/agent mockups.

## Implementation and preserved work

The interrupted run's source commit `b8aecddb3` and uncommitted tests/checklist were preserved. The updated parent is `66bc5b0c802cf469c961c183293e883c5eea89d3`; conflict-resolution commit `bf9f8a3c0` preserves W9a agent routes and W11a local draft protection from both parents. AgentsAdminPage navigation was the only conflicting file.

Blank creation sends the existing owner-signed, self-sealed `create` command through `createAgentRequest.ts`, targeted to the chosen desktop. Built-ins are Buzz Agent, owner-only instructions, ten simultaneous turns, 900-second idle timeout, 43,200-second longest turn and start-with-desktop enabled. Creation requests `spawnAfterCreate: true`. Unsupported timeout fields are locked and omitted for older desktops. Optional model/provider, custom runtime, environment and avatar fields retain their existing wire handling.

Relay acceptance leaves the form waiting. Only a desktop acknowledgement with an agent key opens the W9a agent route. Refusal keeps the draft and quotes the error. At 30 seconds the form reports uncertainty and prevents duplicate submission; a late acknowledgement still works. Router exits, agent selection and local Cancel preserve dirty drafts until explicit discard. The snapshot input lives outside the transient dropdown, so menu dismissal cannot erase its selected file.

Code/test commits after the preserved source: `34366e315`, `fd79ce67d`, `27954f493`, `52196d59d`. The latter three correct the signed catalog fixture and improve screenshot evidence.

## Checks

Raw command output, including failed initial runs, is retained in this worktree's `logs/verification.log`; individual runs are under `.scratch/w11a/`.

| Check | Result |
| --- | --- |
| `pnpm --dir web test`, baseline without the new phase tests | 4,252 tests, all pass |
| `pnpm --dir web test`, restored implementation | 4,268/4,268 pass; 16 added phase regressions |
| `pnpm --dir web typecheck` | Exit 0 |
| Biome on all 18 changed web files | 18 checked, no fixes, exit 0 |
| `pnpm --dir web build`, restored implementation | TypeScript and Vite build succeed; existing chunk/dynamic-import warnings |
| Agent Brave, rebuilt app, W11a plus W6 smoke specs | 12/12 pass: five W11a cases plus seven navigation regressions |
| `node web/scripts/check-file-sizes.mjs` | Default origin/main baseline flags untouched ChannelTimeline.tsx and relay-session.ts |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | Exit 0; both flagged files are byte-identical to the integrated main parent |
| `pnpm --dir web check:palette-literals` | No new literals; one file below baseline |
| `pnpm --dir web check:px-text` | Two unchanged baseline files: GeometryDiagnosticOverlay.tsx and CustomGradientThemeEditor.tsx; no phase file is flagged |
| `pnpm --dir web check` | 28 errors outside the changed-file set; scoped Biome is clean |
| Desktop / Rust | No phase changes; checks not applicable |

The first baseline exposed a sidebar-test router stub missing `useBlocker`, newly imported through the creation screen. Adding the inert router export restored its seven real sidebar cases (the test count rose from 4,246 to 4,252). The initial full after-count was 4,268 with two timing failures in huddle speech tests while browser checks ran; the final restored run passes all 4,268. The first Library browser fixture was rejected by the catalog's real signature verifier; signing its publication fixed both Library cases without changing that verifier.

## Fail-first evidence

Every source mutation started from committed code and was restored with `git checkout --`; no test was mutated.

1. Unit mechanism withdrawal: prevent valid creation requests, remove definition/team locks and the pre-v5 capability restriction, remove Snapshots, prevent snapshot-file delivery and remove parsed capabilities. All **16 new named tests fail**, with **4,268 total / 4,252 pass / 16 fail**. Both required regressions fail by name:
   - `From a definition is locked with update copy without create.linked` — expected disabled entry, received an enabled entry.
   - `blank create sends create with name, prompt, runtime and the chosen idle timeout` — expected one sent command, received zero.
   The other ten creation/error/timeout/runtime cases and four menu/library/parser cases also fail in their test bodies; no module-load failure occurred.
2. Built UI mutations: force idle timeout to 900 despite selecting 1,800, remove Snapshots, and bypass the router draft guard. The rebuilt app runs the same **five W11a tests, all failing**. Both creation tests show the decrypted wire request's `900` versus expected `1800`; both Library tests show three tabs versus four; the refusal/navigation test sees no discard dialog. Restoration and rebuilding restore **12/12 W11a + W6 cases**.

Logs: `mutation-unit.log`, `mutation-build.log`, `mutation-e2e.log`, `restored-build.log`, `restored-e2e.log`, `restored-unit.log` in `.scratch/w11a/`.

## UI evidence

Agent Brave drives the real built settings routes, manual key enrollment and encrypted admin commands. The existing `installMockRelay` supplies desktop acknowledgements and pushes replacement catalog/registration events. The Catalog fixture is Schnorr-signed and Snapshot upload opens the real preview dialog. These checks exercise client reachability and command handling; they do not run a desktop agent process.

At both 1440×960 and 390×844, screenshots were inspected for clipping/overlap, and the specs assert `document.documentElement.scrollWidth <= innerWidth`. Eight screenshot hashes are distinct. The runtime shots are cropped to their subject card because scrolling both lower sections on desktop otherwise captured the same pixels.

All paths are relative to the worktree:

- `.scratch/w11a/screenshots/blank-1440.png` and `blank-390.png`
- `.scratch/w11a/screenshots/blank-runtime-1440.png` and `blank-runtime-390.png`
- `.scratch/w11a/screenshots/blank-access-1440.png` and `blank-access-390.png`
- `.scratch/w11a/screenshots/library-1440.png` and `library-390.png`

## Scope and remaining acceptance

W9b settings cards were not present in the integrated parent. Blank creation therefore uses a small Card wrapper, the established shared identity/access/environment sections and W7 native settings pickers. Their rhythm/tokens follow the approved design; implementing W9b itself is outside W11a. Existing teams still use the code's 30176 owner-only path; no new team wire action was introduced. No new create action or protocol extension is needed here.

The required real-relay throwaway creation/start check remains open. `buzz users set-status --text W11a` returned the actual authentication error `BUZZ_PRIVATE_KEY is required`. A read-only visit to the specified live Settings target showed no desktop report or owner-agent registrations for that browser identity. A mock success proves the signed request, acknowledgement and roster flow, not real process startup.

The authorized acceptance runner needs an owner signer whose Buzz Desktop reports into the test community. From Settings › Agents › New agent › Blank agent, create a uniquely named throwaway, choose runtime and idle timeout, wait for the desktop acknowledgement, verify its roster entry and actual desktop process, then remove the throwaway. Verify all four Library tabs against that owner's existing data. This is an acceptance item, not an approved deferral.

## Changed files

Web implementation:

- `web/src/features/agents/settings/{CreateAgentCard,CreateAgentScreen,CreateRuntimeCard,LibraryTabs,NewAgentMenu}.tsx`
- `web/src/features/agents/settings/{blankAgentDefaults,useBlankAgentCreate}.ts`
- `web/src/features/agents/lib/desktopCatalog.ts`
- `web/src/features/agents/ui/{AgentRosterSidebar,AgentsAdminPage,ImportSnapshotButton}.tsx`

Verification:

- `web/src/features/agents/settings/{CreateAgentScreen.test,NewAgentMenu.test,w11aTestSupport}.mjs`
- `web/src/features/sidebar/ui/ChannelSidebar.layout.test.mjs`
- `web/tests/e2e/{settings-w11a,settings-w6}.spec.ts`
- `web/playwright.config.ts`

Handoff: this report, `docs/TASKS.md`, appended `docs/PROJECT_STATUS.md` and `docs/LAST_CHAT.md`; local screenshots and verification logs are kept in the worktree.

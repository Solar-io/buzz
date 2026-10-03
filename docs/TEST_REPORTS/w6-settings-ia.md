# W6 settings IA

Implemented the W6 information architecture with existing controls embedded in Settings. The rail contains Agents / You / Community / Data & security, with thirteen groups. Phone settings opens a root list with Agents first and no Keyboard. Agent targets use validated 64-hex keys and known tabs; search finds names and Enter opens the target placeholder. Old agent links and shell entry points reach Settings. Claude accounts, Library, Voice and channel templates have their own sections. The desktop footer reads catalog `updated_at` as historical reporting, with no claim of online status. Advanced includes the desktop-only options line, and moved copy uses plain language.

- Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-161159`
- Branch: `codex/buzz-codex-20261002-161159`
Implementation commit: `b921e7a04`

## Validation

| Check | Result |
| --- | --- |
| `pnpm --dir web test`, before | 4,092 tests; 4,092 pass; 0 fail |
| `pnpm --dir web test`, final restored code | 4,099 tests; 4,099 pass; 0 fail |
| `pnpm --dir web typecheck` | exit 0 |
| Biome on all 19 changed web source/test/config files | 19 checked; no fixes or errors |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | exit 0; no output; `repos.tsx` reduced from 1,001 to 997 lines |
| `pnpm --dir web build` | exit 0; existing large-chunk/dynamic-import warnings |
| `pnpm --dir web check:palette-literals` | no new literals |
| Shared px-text guard scoped to touched source basenames | exit 0; no output |
| Global `pnpm --dir web check:px-text` | two parent failures: `GeometryDiagnosticOverlay.tsx:34` and `CustomGradientThemeEditor.tsx:136`, both `text-[10px]`; both files byte-identical to the parent |
| Settings smoke (`settings.spec.ts` + `settings-w6.spec.ts`) | 27 / 27 pass, including 7 new W6 cases |
| Agent Brave | built app at 1440×960 and 390×844; no horizontal overflow; phone navigation and Gilfoyle search exercised; owned tab closed |
| Desktop / Rust | no files changed in either surface |

The smoke fixture exercises owner and non-owner identities; the non-owner receives valid foreign catalogs and registry events but no self-authored records. It waits for the registry/catalog requests before asserting landing. Existing card tests follow the new Channels pane. Browser traffic uses a mocked relay and throwaway identities. This evidence covers the built worktree UI, not a production or physical-iOS release.

## Fail-first proof

After committing the implementation, disabled owner landing and agent-name group matching and changed the footer's historical label to `online`. The same 4,099-test suite failed these four named tests:

- `owners land on Agents while explicit Account links keep their target`
- `settings search finds the Agents group through an agent name`
- `never reports online from catalog age alone`
- `desktop footer formats seconds, minutes, hours and days`

Restored the implementation from the signed commit. A second mutation changed the old agent-route redirect to Account; rebuilt the bundle and ran all seven W6 smoke cases. Five passed and two failed:

- `W6 /repos/agents redirects to group=agents`
- `W6 old agent link also redirects on a phone`

Restored the route, rebuilt, and reran the complete settings smoke group: 27 pass. The restored unit suite also passes all 4,099 cases. Full outputs and named failures are retained in `logs/verification.log`, `logs/w6-unit-mutant.log` and `logs/w6-route-mutant.log`.

## Screenshots

- `.scratch/w6-settings-1440.png` — desktop settings rail and agent controls.
- `.scratch/w6-settings-390.png` — phone root list.
- `.scratch/w6-brave-1440.png` and `.scratch/w6-brave-390.png` — additional Agent Brave captures.

Inspected both final smoke screenshots for text overlap and horizontal overflow. The root list scrolls vertically and preserves its header.

## Plan details and deviations

- The actual settings files live under `features/auth/ui/settings/`, not a standalone `features/settings/` nav module.
- No W6 freshness duration was specified. A self-authored catalog is fresh for six hours (the existing heartbeat interval) plus five minutes of clock tolerance; any self-authored registry entry establishes ownership. No catalog age implies desktop liveness.
- Agent screen and roster redesigns stay with W9a and W8; this phase embeds the existing controls. Future Defaults, routing and drafts links are omitted as specified.
- The shell menu also needed its native-iOS exclusion removed and its agent link retargeted, alongside the two `repos.tsx` callers.

## Changed files

- `docs/TASKS.md`
- `web/playwright.config.ts`
- `web/src/app/routes/repos.agents.tsx`
- `web/src/app/routes/repos.settings.tsx`
- `web/src/app/routes/repos.tsx`
- `web/src/features/agents/lib/desktopConnection.test.mjs`
- `web/src/features/agents/lib/desktopConnection.ts`
- `web/src/features/agents/settings/DesktopConnectionFooter.tsx`
- `web/src/features/agents/ui/AgentConfigPanel.tsx`
- `web/src/features/agents/ui/AgentRosterSidebar.tsx`
- `web/src/features/agents/ui/AgentsAdminPage.tsx`
- `web/src/features/auth/ui/SettingsPage.tsx`
- `web/src/features/auth/ui/settings/MiscSections.tsx`
- `web/src/features/auth/ui/settings/SettingsNav.tsx`
- `web/src/features/auth/ui/settings/settingsGroups.test.mjs`
- `web/src/features/auth/ui/settings/settingsGroups.ts`
- `web/src/features/auth/ui/settings/settingsSearch.test.mjs`
- `web/src/features/sidebar/ui/SidebarAppMenu.tsx`
- `web/tests/e2e/settings-w6.spec.ts`
- `web/tests/e2e/settings.spec.ts`
- `docs/TEST_REPORTS/w6-settings-ia.md`

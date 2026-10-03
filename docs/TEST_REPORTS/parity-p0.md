# P0 — owner-admin protocol foundation

The [verifier follow-up](parity-p0-verifier-fixes.md) supersedes the legacy-control
compatibility and replay behavior below and records the checks after composition
with W6/W9a.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-161202`  
Branch: `codex/buzz-codex-20261002-161202`  
Base: `301cc5348242ce92b0046d5ec7cc4ebd0249ae0c`

Implemented catalog v5 and the single desktop capability list (`ping`, `ack.result`,
`requires`, `fresh`); parsed capability requirements and timestamps; refused
unsupported and stale mutations before applying; added non-mutating ping results
and structured, UTF-8-budgeted acknowledgements. The web reads named caps, checks
all claiming machines, preserves ack results, probes desktop presence while an
Agents view is mounted and on focus, and locks controls before signing/queueing.
Existing Agents and Claude-account settings carry the connection footer and
published-value lock boundary. Mutating-command feedback waits 30 seconds.

Validation:

| Check | Result |
| --- | --- |
| Web unit tests | 4,092 before; 4,107 after; 4,107 restored, zero failures/cancellations |
| Desktop unit tests | 5,762 before; 5,769 after; 5,769 restored, zero failures/cancellations |
| TypeScript | Web and desktop: exit 0 |
| Scoped Biome | 26 web files, 10 desktop files and both fixture JSON files: exit 0 |
| File sizes | Both packages pass against the original phase base |
| Web build | Final restored bundle builds; existing chunk/dynamic-import warnings |
| Palette | No new literals; AgentAdminPanel below its old baseline |
| Px text | Two original violations in GeometryDiagnosticOverlay and CustomGradientThemeEditor; P0 adds none |
| Browser | One served-app scenario in Agent Brave, actual NIP-44 commands/acks via mockRelay; online/offline/recovery, old-catalog lock, color distinction, no queued mutation, 390/375 no document overflow, unmount stops probes |
| Rust | No Rust files changed |

Mutation evidence (committed implementation first; original source restored with
`git checkout --`):

- Desktop: disabling requirement/freshness/ping guards, catalog v5, and the ack
  byte budget fails **6 named tests**, with **5,769 tests still executed**:
  wire shape, shared corpus, unknown cap refusing create, stale timestamp refusing
  apply, ping caps, and oversized UTF-8 result refusal.
- Web: disabling v5/all-machines gates, offline transition, sealed `requires`,
  and ack extensions fails **7 named tests**, with **4,107 tests still executed**:
  structured result preservation, sender requirements, owner/request-matched
  transport, v4 capabilities, capability intersection, missed-ping/recovery, and
  old-desktop unknown presence.
- UI: replacing the hook's published presence map with an empty map, rebuilding,
  and running the same browser scenario fails its **online assertion** while a
  catalog and footer exist. Restoring, rebuilding and rerunning passes.
- Old-web compatibility was run on the original parser before implementation:
  a v5 catalog with unknown fields preserves its harnesses and agents.

Screenshots, inspected for overlap/overflow:

- `.scratch/p0-online-1440.png`
- `.scratch/p0-offline-1440.png`
- `.scratch/p0-online-390.png`
- `.scratch/p0-offline-390.png`

Deviations and boundaries:

- There are no web/, desktop/, or crates/buzz-acp/ top-level AGENTS files on this
  base; the root guide and desktop/features/agents guide apply. Root CLAUDE is a
  symlink to AGENTS.
- W6/W7 are not on this phase's base, so presence is connected to the existing
  Agents page and Agents settings group through reusable boundaries. Their
  future controls can consume `lock()`/`byMachine`; P0 does not build their IA.
- `main` advanced concurrently. Its current size ratchet reports untouched
  `web/src/app/routes/repos.tsx` as 998 -> 1001; that file is byte-identical to
  this phase's base. The original-base ratchet passes. See the original and
  moving-base receipts; no unrelated file was edited to hide this difference.
- The standard smoke spec is registered. Here its same scenario and original
  helper source ran through Agent Brave's code tool, with TypeScript transpilation
  and an assertion adapter, in a disposable browser context. Bundling/minifying
  the whole driver lost its WebSocket mock behavior; unminified helper execution
  passes. This is a test-driver limitation, not app acceptance from a mock marker.
- Probes are every 30 seconds with two 10-second misses. Without a focus probe,
  the worst quit-to-offline delay can be 70 seconds, despite the plan's 60-second
  live acceptance wording. The focus-driven browser check observes offline at
  approximately 40 seconds. Keep this timing distinction for R1 acceptance.
- Physical quit/relaunch and the live owner's desktop checks belong to the
  separately authorized R1 application release. This run used a disposable
  identity, agent registry fixture, and mocked desktop acknowledgements.
- The fleet focus-token CLI call lacked BUZZ_PRIVATE_KEY. No credentials were
  taken from another process; this does not prevent local build verification.

Receipts: `logs/verification.log`, `logs/p0-final-static.log`,
`logs/p0-pinned-base-checks.log`, `logs/p0-final-size-palette.log`,
`logs/p0-web-mutant.log`, `logs/p0-desktop-mutant.log`,
`logs/p0-browser-receipt.log`, and `.scratch/p0-browser-plain.js`.

Implementation and test commits:

```text
7e4451b7d test(web): stabilize presence acceptance and format shared fixtures
d8fbeb17c fix(web): render desktop connection states with the existing palette tokens
06b5d7f07 test(web): exercise desktop presence and offline controls through the served app
666470156 test(agents): share v5 owner admin fixtures and transport regressions
1578860e2 feat(web): lock agent controls while desktop presence is unconfirmed
e65743f45 feat(web): monitor desktop presence and expose offline control locks
c642bb38f feat(web): negotiate desktop capabilities and preserve structured admin acks
e64e8c81c feat(agents): guard owner admin commands with v5 capabilities and freshness
```

Files changed from the phase base (45):

- `AGENTS.md`
- `desktop/src/features/agents/AGENTS.md`
- `desktop/src/features/agents/desktopCatalogContent.test.mjs`
- `desktop/src/features/agents/desktopCatalogContent.ts`
- `desktop/src/features/agents/ownerAdminCaps.ts`
- `desktop/src/features/agents/ownerAdminProtocol.test.mjs`
- `desktop/src/features/agents/ownerAdminProtocol.ts`
- `desktop/src/features/agents/ownerAdminProtocolV5.ts`
- `desktop/src/features/agents/ownerAdminV5.test.mjs`
- `desktop/src/features/agents/useOwnerAdminCommands.ts`
- `desktop/src/shared/api/ownerAdminAck.ts`
- `desktop/src/shared/api/tauriOwnerAdmin.ts`
- `docs/LAST_CHAT.md`
- `docs/PROJECT_STATUS.md`
- `docs/TASKS.md`
- `docs/TEST_REPORTS/parity-p0.md`
- `docs/nips/NIP-AP.md`
- `test-fixtures/owner-admin/cases.json`
- `test-fixtures/owner-admin/limits.json`
- `web/playwright.config.ts`
- `web/src/features/agents/lib/admin/protocolV5.ts`
- `web/src/features/agents/lib/admin/request.ts`
- `web/src/features/agents/lib/adminCommandLock.ts`
- `web/src/features/agents/lib/adminCommands.test.mjs`
- `web/src/features/agents/lib/adminCommands.ts`
- `web/src/features/agents/lib/adminCommandsSend.ts`
- `web/src/features/agents/lib/adminCommandsTransport.test.mjs`
- `web/src/features/agents/lib/desktopCaps.test.mjs`
- `web/src/features/agents/lib/desktopCaps.ts`
- `web/src/features/agents/lib/desktopCatalog.ts`
- `web/src/features/agents/lib/desktopCatalogV5Compatibility.test.mjs`
- `web/src/features/agents/lib/desktopPresence.ts`
- `web/src/features/agents/lib/pendingCommands.test.mjs`
- `web/src/features/agents/lib/pendingCommands.ts`
- `web/src/features/agents/ui/AgentAdminPanel.tsx`
- `web/src/features/agents/ui/AgentRosterSidebar.tsx`
- `web/src/features/agents/ui/AgentsAdminPage.tsx`
- `web/src/features/agents/ui/AgentsConnectionSettings.tsx`
- `web/src/features/agents/ui/DesktopConnectionFooter.tsx`
- `web/src/features/agents/ui/DesktopControlBoundary.tsx`
- `web/src/features/agents/useDesktopPresence.test.mjs`
- `web/src/features/agents/useDesktopPresence.ts`
- `web/src/features/auth/ui/SettingsPage.tsx`
- `web/src/features/auth/ui/settings/ClaudePoolsSection.tsx`
- `web/tests/e2e/owner-admin-presence.spec.ts`

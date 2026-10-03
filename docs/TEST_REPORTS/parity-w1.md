# Parity W1: channel settings and About

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-161156`  
Branch: `codex/buzz-codex-20261002-161156`  
Starting commit: `301cc5348242ce92b0046d5ec7cc4ebd0249ae0c`

W1 builds the sheet over the conversation, desktop and phone entry points, About edits and actions, and the Members / Workflows placeholders. The existing Work / Canvas pane model is preserved. No other parity phase is implemented here.

## Implementation and compatibility

- Name, Purpose, Visibility, Lifetime and Archive use owner/member-signed channel events through the existing relay session. Permissions remain the relay's decision, and its rejection text is shown inline.
- Purpose changes only the `purpose` tag. Scratch `about` and its parent marker are preserved. Header descriptions prefer topic, then purpose, then about.
- Ongoing sends `['ttl', '']`, matching the desktop writer and relay validation. Zero is rejected by the current relay. Presets are 24 hours, 72 hours, 7 days and 30 days.
- Joining comes from the metadata's `closed` flag, independently of visibility; Type and Joining are read-only. No writable joining tag exists in the inspected desktop/relay paths.
- An archived channel permits only Unarchive in About. The main composer is replaced with the archived notice; inline reply composers are disabled and sends are guarded.
- Selected-channel metadata carries both `#d` and `#h` in a separate subscription, supplementing global history. Cached metadata gains an optional event ID for the NIP-33 tie breaker without restarting global discovery on every selection.
- Save as template uses the existing IndexedDB template store and captures channel metadata plus the loaded canvas. Notifications uses the existing per-channel mute/default preference; the app has no separate per-channel Everything/Mentions setting to relocate.

Prior implementations checked: desktop ChannelManagementSheet and channel command/event writers, relay 9002 validation and discovery emission, web channelAdmin, ChannelMembersButton, channel preferences, Canvas and template storage. The sheet uses the approved 06/06b layout, existing Dialog focus trap, tokens and rem text sizes.

## Checks

| Check | Output |
|---|---|
| `pnpm --dir web test`, baseline | 4,092 tests; 4,092 pass; 0 fail |
| `pnpm --dir web test`, restored implementation | 4,102 tests; 4,102 pass; 0 fail |
| `pnpm --dir web typecheck` | exit 0 |
| Scoped Biome on all 18 changed web source/config/test files | 18 checked; no fixes; exit 0 |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | exit 0; route remains 999 lines |
| Default `node web/scripts/check-file-sizes.mjs` | pre-existing over-limit ChannelTimeline (1010) and relay-session (1325), measured against its older origin/main merge-base; neither changed in W1 |
| `pnpm --dir web check:palette-literals` | No new literals; exit 0 |
| `pnpm --dir web check:px-text` | Existing `text-[10px]` findings in GeometryDiagnosticOverlay and CustomGradientThemeEditor; neither changed in W1 |
| `pnpm --dir web check` | 31 existing errors outside the touched files; scoped check above passes |
| `pnpm --dir web build` | exit 0; existing dynamic-import and chunk-size warnings |
| W1 smoke browser tests, built bundle | 4/4 pass, headed fallback; 38.5 seconds |
| Exact conflict-marker scan (all four forms) | no matches |
| Desktop / Rust | no files changed by W1; not applicable |

The broad marker-prefix scan finds existing Markdown setext headings and TLA module terminators. The exact seven-character conflict delimiter scan has no matches.

Browser cases exercise Purpose and its header update, archive/unarchive and locked controls, TTL/expiry, facepile-to-Members routing, and disabled inline replies. Both fixed palettes are asserted on `<html>` before capture; the fixture supplies five members including four agents. At 390 the sheet starts at x=0 and is 390 wide; at 1440 it starts at x=960 and is 480 wide. Both the sheet and document pass `scrollWidth <= clientWidth`. Screenshots were inspected for overlap and clipping.

The live acceptance target is `https://crichton.tailb3d4b8.ts.net:6351`. **No live relay write acceptance is claimed:** the coding shell has no Buzz signing credentials (`buzz users set-status` returned `BUZZ_PRIVATE_KEY is required`). The final workflow evidence uses the built worktree bundle and `helpers/mockRelay.ts`. The authorized tester still needs the plan's private-channel round-trips and second-browser reload check. Existing working channels and agents were not used for writes.

## Failure proofs

The implementation was committed before mutation, and owned files were restored with `git restore --source=HEAD` afterward.

One combined unit mutation changes archive/purpose to `about`, doubles numeric TTL values, and removes the archived About lock. The full supported runner executes **4,102 tests**, with 4,097 pass and exactly these five failures:

1. `archive emits exactly [["h",id],["archived","true"]]`
2. `purpose edit never touches about`
3. `ttl preset 7d emits 604800`
4. `archive button publishes 9002 archived=true and shows Unarchive after the 39000 update`
5. `archived channel disables rename`

A separate browser mutation disables the Composer context guard. After rebuilding, the single selected `channel sheet About at 1440 dark: edit, archive, lifetime and members` case fails at `toBeDisabled`: the inline `Reply in thread…` textarea is enabled. The restored code was rebuilt; all four final browser cases pass. This proves the inline-reply check executes the shipped composer.

## Artifacts

Logs are local to this worktree: `logs/verification.log`, `w1-baseline.log`, `w1-restored.log`, `w1-mutation.log`, `w1-inline-mutation.log`, `w1-e2e.log`, `w1-typecheck.log`, `w1-build.log`, `w1-biome.log`, `w1-repo-check.log`, `w1-file-sizes.log`, `w1-file-sizes-main.log`, `w1-px-text.log`, `w1-palette.log` (all individual logs also under `logs/`).

Screenshots:

- `.scratch/w1/w1-about-1440-dark.png`
- `.scratch/w1/w1-about-1440-light.png`
- `.scratch/w1/w1-about-390-dark.png`
- `.scratch/w1/w1-about-390-light.png`

Implementation/test commits: `06e78eb62`, `e2f354836`, `56a5e478b`, `da30b55a7`, `29dc15fee`, `164ac020f`, `1372c8016`.

Changed files (relative to the starting commit; documentation is the final handoff unit):

```text
docs/TASKS.md
docs/PROJECT_STATUS.md
docs/LAST_CHAT.md
docs/TEST_REPORTS/parity-w1.md
web/playwright.config.ts
web/src/app/routes/repos.tsx
web/src/features/channels/lib/channelFromEvent.ts
web/src/features/channels/lib/channelMetadataEdit.ts
web/src/features/channels/lib/channelMetadataEdit.test.mjs
web/src/features/channels/lib/useMessageActions.ts
web/src/features/channels/ui/ChannelHeader.tsx
web/src/features/channels/ui/ChannelMembersButton.tsx
web/src/features/channels/ui/ChannelReadOnlyContext.ts
web/src/features/channels/ui/Composer.tsx
web/src/features/channels/ui/DmComposerActions.tsx
web/src/features/channels/ui/channel-sheet/AboutTab.tsx
web/src/features/channels/ui/channel-sheet/ChannelSettingsHeader.tsx
web/src/features/channels/ui/channel-sheet/ChannelSettingsSheet.tsx
web/src/features/channels/ui/channel-sheet/ChannelSettingsSheet.test.mjs
web/src/features/channels/useChannels.ts
web/src/features/commands/ui/CommandComposer.tsx
web/tests/e2e/channel-sheet.spec.ts
```

Deviations: TTL clear uses empty string rather than zero; Notifications exposes existing mute/default semantics; route wiring uses ChannelSettingsHeader to stay below the route's file-size limit; Agent Brave's WebSocket interception failed after sign-in, so the supported headed Playwright fallback produced final UI evidence.

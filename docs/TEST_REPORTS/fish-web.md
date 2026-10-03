# P3 Fish Audio web verification

Fish Audio is selectable in Settings, owner assignment, profile and huddle controls. The shared Voice library supports ElevenLabs/Fish provider browse/search, id/URL addition, signed soft removal with a usage census, and read-only non-admin sessions. Every picker, curated list and provider browse list uses the same case-insensitive numeric English comparator. Removed selections retain their labels, remain pinned/selectable/previewable and show a badge.

Code reference: `46b8d1e52` on `claude/fish-web`. Scope: plan §4.7–4.8 and the shared grammar corpus. Baseline: **4,175** tests. Final: **4,212** tests, **37 added**, zero failures/skips/cancellations.

## Verification

- Worktree dependency install: `pnpm install --frozen-lockfile`; independent dependencies, no canonical node_modules symlink.
- From `web/`: `pnpm test` (the supported Node loader); 4,212/4,212 pass. `pnpm typecheck` passes.
- `pnpm exec biome check <changed TS/TSX/MJS files>` and `pnpm exec biome lint <same files>`: 35 files, clean. `pnpm build` passes.
- `python3 web/scripts/mutate-fish-voices.py`: 34/34 mutations killed by named behavioral tests, each with the same count as its baseline. Every changed source restored byte-for-byte; all targeted restored suites pass.
- Agent Brave: the actual built Settings page with fake relay/bridge boundaries, 1440×1000 and 390×844. Ten checks cover card reachability, curated sorting, Fish URL addition, public search, preview, owner 30183 publishing, usage confirmation, soft-removal badge/pinned row and read-only controls. Two real NIP-98 signatures verified with `nostr-tools.verifyEvent`; POST hash matches exact request bytes. Zero page/console errors. Owned tabs closed; temporary loopback preview stopped.
- Grammar file is byte-identical to P2's `buzz-fish-relay/test-fixtures/voice/voice-key-grammar.json`: Fish 4 accept/19 reject; ElevenLabs 4 accept/18 reject, with explicit count guards.

Receipts: `logs/verification.log`, `logs/fish-web-baseline.log`, `logs/fish-web-final.log`, `logs/fish-web-mutations.log`, `logs/fish-mutations/receipts.json`, `logs/fish-web-brave.json`, `logs/fish-web-desktop.png`, `logs/fish-web-phone.png`. Reusable browser harness: `web/tests/e2e/fish-voice-brave.mjs` (Agent Brave; fixture argument supplies the disposable identity, transpiled existing mock relay and loopback preview URL).

## Inventory and implementation choices

The §4.8 engine/parser/routing inventory was inspected in full. `voiceCatalog.ts` stays Pocket-catalog-only; `agentVoiceApi.ts`, `agentSpeechPlayer.ts` and `voicePreview.ts` already carry engine-tagged keys generically, proved with new Fish publish/PCM tests. `agentConfigCard.ts` uses shared summaries rather than a literal engine switch.

Small additions to the plan: store an optional huddle override label so a later removal can preserve it; pass the effective assignment/self-selection and label through the profile hook; keep agent name/voice/badge readable on phones; accept ElevenLabs voice-library URLs carrying `voiceId` as well as ids. The card's shared rows and mutation invalidation are separate modules. The plan's schematic grammar snippet was expanded using P2's exact file instead of inventing separate vectors.

The browser harness suppresses PWA registration for its synthetic host; PWA behavior is outside the voice workflow. Fake relay OK and silent PCM establish client wiring, not live relay grammar, provider sound quality or native iOS playback. Those release checks require the P1/P2 integrations and the iOS install. Library-admin UI reads `/healthz.libraryAdmins`; the bridge enforces Sam's configured pubkey. P3 has no remaining implementation items.

## Mutation log

Both counts must match; every row records a real failing named test followed by source restoration. Complete failures and raw runner output are in the receipts above.

| Mechanism broken | Baseline/mutant count | Named failing test |
|---|---:|---|
| fish-parse | 8/8 | fish grammar vectors accept the shared corpus |
| fish-grammar | 8/8 | fish grammar vectors reject the shared corpus |
| fish-precedence | 8/8 | fish assignment shares selection grammar and effective voice precedence |
| fish-summary-preview | 8/8 | fish summaries and preview preserve the selected engine and stored label |
| fish-display-name | 8/8 | fish summaries and preview preserve the selected engine and stored label |
| fish-bridge-request | 8/8 | fish bridge mapping and speech disposition route the bare model id |
| fish-speech-disposition | 8/8 | fish bridge mapping and speech disposition route the bare model id |
| fish-huddle-prefs | 8/8 | fish override round-trips with its stored label and remains the channel winner |
| sort-every-engine | 21/21 | engineVoiceOptions sorts chatterbox case-insensitively with numeric and accented labels |
| sort-chatterbox | 21/21 | engineVoiceOptions sorts chatterbox case-insensitively with numeric and accented labels |
| sort-numeric | 21/21 | engineVoiceOptions sorts chatterbox case-insensitively with numeric and accented labels |
| fish-tabs | 8/8 | Settings picker, agent assignment and profile picker sort each engine's rendered rows |
| fish-initial-tab | 21/21 | withCurrentPinned keeps a removed current voice first and the sorted library below it |
| fish-option-equality | 21/21 | withCurrentPinned keeps a removed current voice first and the sorted library below it |
| sort-pinned-voice | 21/21 | withCurrentPinned keeps a removed current voice first and the sorted library below it |
| pin-settings-dialog | 8/8 | removed Fish remains pinned, previewable and confirmable with its stored label |
| pin-huddle-popover | 8/8 | huddle popover sorts all engines and preserves the removed labelled override |
| library-post-payload | 5/5 | add signs NIP-98 over the exact body and invalidates mounted libraries |
| library-delete-auth | 5/5 | remove signs the exact DELETE URL without a payload and keeps selections intact |
| library-forbidden-message | 5/5 | library 403 maps to only the voice-library admin and failed edits never invalidate |
| library-engine-url | 3/3 | library mutations refresh every mounted engine hook and abort stale fetches |
| library-public-query | 5/5 | available covers own Fish models and encoded length-bounded public search |
| fish-url-input | 4/4 | parseVoiceInput accepts Fish ids and provider URLs and refuses malformed inputs |
| usage-local-rooms | 4/4 | inUseBy includes owner assignments, agent choices and every matching device room |
| usage-card-wiring | 8/8 | remove confirmation names assignment, self-selection and device room without altering them |
| library-refresh | 3/3 | library mutations refresh every mounted engine hook and abort stale fetches |
| library-admin-hint | 3/3 | library admin affordance uses bridge allowlist and changes with the signed-in identity |
| library-readonly-ui | 8/8 | Voice library curated lists sort both providers and read-only sessions have no mutation controls |
| library-row-sorting | 8/8 | provider browse rows sort case-insensitively for ElevenLabs and Fish |
| agent-removed-badge | 5/5 | Agent voices preserves a removed Fish label, shows its badge and passes it to assignment |
| self-removed-badge | 8/8 | provider Browse adds a Fish model to the curated list and self voice badges soft removal |
| profile-picker-selection | 8/8 | profile card opens the Fish picker with the effective stored selection and label |
| fish-preview-post | 1/1 | Fish preview posts its own engine and bare model id and schedules bridge PCM |
| fish-player-post | 14/14 | Fish selection reaches real player POST and records fish-bridge playback |

## Files changed (41)

- `docs/LAST_CHAT.md`
- `docs/PROJECT_STATUS.md`
- `docs/TASKS.md`
- `docs/TEST_REPORTS/fish-web.md`
- `test-fixtures/voice/voice-key-grammar.json`
- `web/scripts/mutate-fish-voices.py`
- `web/src/features/agents/useAgentConfigCard.ts`
- `web/src/features/auth/ui/SettingsPage.tsx`
- `web/src/features/huddle/lib/bridgeSpeech.ts`
- `web/src/features/huddle/lib/huddleAgentSpeech.ts`
- `web/src/features/huddle/lib/huddlePrefs.ts`
- `web/src/features/huddle/ui/HuddleSettingsPopover.tsx`
- `web/src/features/huddle/useHuddleAgentSpeech.ts`
- `web/src/features/profile/ui/AgentConfigSection.tsx`
- `web/src/features/voice/hooks.ts`
- `web/src/features/voice/lib/agentVoiceApi.test.mjs`
- `web/src/features/voice/lib/agentVoiceSelection.ts`
- `web/src/features/voice/lib/agentVoiceSummary.ts`
- `web/src/features/voice/lib/chatterboxRoster.ts`
- `web/src/features/voice/lib/fishVoice.test.mjs`
- `web/src/features/voice/lib/voiceLibraryApi.test.mjs`
- `web/src/features/voice/lib/voiceLibraryApi.ts`
- `web/src/features/voice/lib/voiceLibraryModel.test.mjs`
- `web/src/features/voice/lib/voiceLibraryModel.ts`
- `web/src/features/voice/lib/voiceLibraryRevision.ts`
- `web/src/features/voice/lib/voicePrecedence.ts`
- `web/src/features/voice/ui/AgentVoicesCard.test.mjs`
- `web/src/features/voice/ui/AgentVoicesCard.tsx`
- `web/src/features/voice/ui/VoiceEngineTabs.tsx`
- `web/src/features/voice/ui/VoiceLibraryCard.tsx`
- `web/src/features/voice/ui/VoiceLibraryRows.tsx`
- `web/src/features/voice/ui/VoicePickerDialog.test.mjs`
- `web/src/features/voice/ui/VoicePickerDialog.tsx`
- `web/src/features/voice/ui/VoiceSettingsCard.tsx`
- `web/src/features/voice/ui/voicePickerOptions.test.mjs`
- `web/src/features/voice/ui/voicePickerOptions.ts`
- `web/src/features/voice/ui/voicePreview.test.mjs`
- `web/src/features/voice/ui/voiceSurfaces.test.mjs`
- `web/src/features/voice/useAgentSpeechPlayer.test.mjs`
- `web/src/features/voice/voiceLibraryHooks.test.mjs`
- `web/tests/e2e/fish-voice-brave.mjs`

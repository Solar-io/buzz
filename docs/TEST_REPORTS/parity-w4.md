# Parity W4: Forum and Lifetime creation

Implemented the W4 creation controls and existing relay wire contract. Live acceptance requires an enrolled test identity unavailable to this coder session.

Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261002-161229`.
Branch: `codex/buzz-codex-20261002-161229`.
Implementation commits: `ba1260fd7`, `a57665c20`, `e08e83e76`, `8bac51d3a` (DCO signed).

## Behavior

- Stream/Forum radio segments; native Lifetime select: Ongoing, 24 h, 72 h, 7 days, 30 days.
- Private creation remains the default. Names use the existing canonicalizer; purpose uses `about`.
- Existing create request includes `channel_type`, and positive lifetimes include `ttl` seconds. Ongoing omits `ttl`.
- Controls lock while publishing. A refusal retains the draft and surfaces relay wording; acceptance resets type/lifetime and opens the new channel through the existing metadata refresh.
- The sidebar includes creation lifetime presets; scratch and transport-room handling retain their existing distinctions.

## Verification

| Check | Result |
| --- | --- |
| `pnpm --dir web test`, baseline | 4,092 tests: 4,091 pass, one existing `enabled utterances are spoken in arrival order` timing failure |
| `pnpm --dir web test`, final restored code | 4,101 tests, 4,101 pass, zero fail/skip/cancel |
| `pnpm --dir web typecheck` | exit 0 |
| Biome on all six touched web files | exit 0, no fixes needed |
| `CHECK_FILE_SIZES_BASE=main node web/scripts/check-file-sizes.mjs` | exit 0 |
| `pnpm --dir web build` | exit 0 |
| Palette check / px-text on touched UI | exit 0 |
| Full `pnpm --dir web check` | 30 existing errors; touched files clean |
| Full px-text | two existing `text-[10px]` occurrences: GeometryDiagnosticOverlay and CustomGradientThemeEditor; confirmed on parent commit |
| Headed smoke: `new-channel.spec.ts` | 9/9, widths 1440/390/375 |
| Live target HTTP read | HTTP/2 200; this proves availability only |

Browser cases exercise the actual built app, create/sign/publish requests, materialize relay metadata without live metadata fan-out, open ForumView, show expiry, navigate away/back, retain rejected drafts and reset accepted drafts. All form controls checked for touch height; form geometry checked for horizontal overflow. Screenshots were visually inspected. Browser relay responses are mocked: no claim about live relay authorization or persistence.

Agent Brave initially passed 9/9. Subsequent attached runs failed because mock WebSocket interception bypassed the fixture and attempted real connections to the preview origin. The headed Playwright fallback passed the final built code. The runner owns and closes its test contexts; the separately claimed Agent Brave tab was closed.

## Mutation proof

Committed before mutation. In `newChannelRequest.ts`, temporarily forced `channel_type` to stream and removed TTL emission. Rebuilt the app before the mutation browser run.

- Unit count stayed **4,101**: 4,096 pass / **5 fail**. Named failures: `forum + 7 days emits channel_type forum and ttl 604800`, and `lifetime 86400/259200/604800/2592000 emits exactly ... seconds`.
- Browser count stayed **9**: 3 pass / **6 fail**. `dialog creates a forum with 7 days and opens ForumView` and `24 h stream shows expiry and remains reachable in Channels` failed at all three widths.
- Restored from the committed implementation, rebuilt, then passed **4,101/4,101** unit and **9/9** browser cases.

Raw outputs, diff and combined receipt: `logs/w4-*.log`, `logs/w4-mutation.diff`, `logs/verification.log`.

## Screenshots

`.scratch/screenshots/w4-new-forum-{1440,390,375}.png`
`.scratch/screenshots/w4-created-forum-{1440,390,375}.png`
`.scratch/screenshots/w4-created-24h-{1440,390,375}.png`

The compact rows use existing tokens and rem text. Phone creation actions fit above Vitals and the tab bar. The sidebar retains vertical scrolling at shorter heights.

## Files and plan deviations

- `web/src/features/channels/ui/NewChannelDialog.tsx`
- `web/src/features/channels/lib/newChannelRequest.ts`
- `web/src/features/channels/lib/newChannelRequest.test.mjs`
- `web/src/features/channels/lib/useChannelLists.ts`
- `web/tests/e2e/new-channel.spec.ts`
- `web/playwright.config.ts`
- `AGENTS.md`, `docs/TASKS.md`, `docs/PROJECT_STATUS.md`, `docs/LAST_CHAT.md`, this report.

The plan's “scratch expiry” means the existing generic temporary-channel badge here: actual scratch channels require a parent marker. W4 does not invent that marker. `useChannelLists.ts` was an additional necessary change: otherwise every finite channel disappeared from the sidebar. There is no separate path-local guide in web/ or crates/buzz-acp/ in this checkout. No desktop or Rust files were touched.

## Remaining acceptance

One item remains: with an enrolled test identity, use this built web app against `wss://crichton.tailb3d4b8.ts.net:6351`, create private Forum and 24 h channels, and verify real metadata readback, ForumView and expiry. The session lacks `BUZZ_PRIVATE_KEY`/`BUZZ_AUTH_TAG`; the browser has no Nostr extension. No existing channel or working agent was used for tests.

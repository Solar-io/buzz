# Daily Digest sidebar destination

The Newspaper row sits below Forums and above Links. It opens the fixed
tailnet edition in the shared main-pane web layer, using a distinct `digest`
target, the title "Daily Digest" and the existing four-frame LRU. Conversation
navigation hides it without reloading. The cookie-free edition stays embedded
on native iPhone; Files and Links keep their existing browser sign-in behavior.

The fixed URL lives only in `web/src/features/webPanels/lib/dailyDigest.ts`:
`https://crichton.tailb3d4b8.ts.net:6450/edition/latest.html`.

## Verification

- `cd web && pnpm test && pnpm typecheck`: 4,097 tests, 4,097 pass, no failures
  or skips; TypeScript exits 0. Same result after restoring the mutation.
- Biome checks all nine touched source/test files with no fixes required.
- `pnpm build` exits 0.
- Agent Brave: two workflow checks, 1440×960 desktop and 390×844 phone. Both
  render the live edition's "Daily Edition sections" tablist from inside the
  iframe at the exact URL. The row is above Links. Desktop selection clears
  on conversation click and returning reuses the same iframe node. Phone's
  top bar says "Daily Digest"; Back returns to Channels, then a conversation
  opens, retaining the same iframe. Reducer and real-sidebar unit tests also
  cover row order below Forums and selection through the shared store.
- Native-iPhone unit coverage proves the iframe uses the exact URL, makes no
  native browser call, and stays mounted behind the conversation. This is
  simulated native-platform coverage, not a physical-device check.

The browser runs this worktree's built bundle in a temporary loopback preview.
Conversation data uses the existing Work fixture over a page-local socket
fixture; the edition is fetched from its real tailnet server. Playwright's
WebSocket interception did not deliver fixtures through this attached browser,
so the page-local transport was used. Host-stat CORS errors are a preview-origin
limitation, unrelated to the edition. These checks cover client behavior and
live embedding, not relay authorization or a production rollout.

## Mutation proof

The implementation was committed as `c44ac0089` before mutation. `webViewKey`
was changed to return `link:daily-digest` for a digest target. `pnpm test`
exited 1 with **4,097 tests, 4,093 pass, four fail**:

1. `Daily Digest has a fixed target, title and edition URL`
2. `Daily Digest replaces Files and hides for a conversation without losing its frame`
3. `Daily Digest shares the four-frame LRU and refreshes on another click`
4. `native iOS: Daily Digest stays embedded at its fixed URL with no browser hop`

`git restore --source=HEAD -- web/src/features/webPanels/lib/activeWebView.ts`
restored the committed implementation; the file diff was empty. The full test
and typecheck command then passed with the same 4,097-test total. Expectations
pin literal target, URL and frame keys, rather than deriving expected values
from the implementation.

Raw receipts are in this worktree's `logs/verification.log`,
`logs/daily-digest-mutation.log`, `logs/daily-digest-restored.log`,
`logs/daily-digest-biome.log`, `logs/daily-digest-build.log` and
`logs/daily-digest-browser.log`.

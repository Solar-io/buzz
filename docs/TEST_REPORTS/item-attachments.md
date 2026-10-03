# Item capture attachments — x5fq4jncejx5

Item capture now has a separate markdown Description field with multi-file Attach, image/file paste and file drop. It uses the message composer's `useComposerAttachments`, `ComposerAttachmentTray`, type filter and `uploadBlob` transport, including size limits, image/MP3 metadata processing, progress and relay rejection text. Upload batches share one serial queue. Removing a row or closing the editor suppresses late insertion and releases previews.

Upload completion inserts filename markdown at the current textarea selection, preserves surrounding edits and restores the caret. Images use `![name](url)`; other types use `[name](url)`. Labels/destinations are escaped, and insertion plus submission enforce the fixed 16,384-byte UTF-8 body bound. The create button and form handler both wait for pending uploads. `useItemActions.create` carries the body into kind 30623. Expanded Notes uses the timeline's `MarkdownContent`, signed media fetch, file links and image lightbox, including when a captured source message also exists. Item detail has no existing body-edit control to extend.

This extends the carried **Web chat client** series in `FORK_MANIFEST.md` and the existing kind-30623 Items surface. Worktree: `/Users/sgallant/software_development/.evie-worktrees/buzz-codex-20261003-143343`; branch: `codex/buzz-codex-20261003-143343`; base: `138be3959`.

## Checks

| Check | Result |
| --- | --- |
| `cd web && pnpm test` | 4,421 before; 4,437 after; 16 added; zero failures/skips |
| Focused insertion/capture suite | 16/16, using the supported Node loader and real editor/queue/form |
| `pnpm typecheck`, `pnpm build` | Pass |
| `pnpm lint` | Two errors, ten warnings and nine infos before and after; baseline findings retained |
| Biome on all eleven touched web files | Pass |
| `CHECK_FILE_SIZES_BASE=138be3959 pnpm check:file-sizes` | Pass |
| Agent Brave browser suite | 2/2: light desktop 1440 and dark phone 390 |
| Diff/conflict scan | Clean diff; no exact seven-character conflict markers. Broad scan also finds five unchanged Markdown/TLA equals separators |

Browser command: `BUZZ_E2E_CDP=http://127.0.0.1:9222 PLAYWRIGHT_PORT=<owned-preview-port> SHOTS_DIR=../.scratch/item-attachments/screenshots pnpm exec playwright test item-attachments.spec.ts --project=smoke`. The preview port was selected in Buzz's registry block; the server served this worktree on loopback. Agent Brave ran the fixture workflow in owned isolated contexts, closed by the runner. The built-client check covers the actual picker button, synthetic `ClipboardEvent` image paste, document drop, pending create lock, kind-30623 body, two decoded inline images, file link and full image dialog. Upload/media routes assert signed Nostr authorization headers. A decode timing race in the test was corrected by waiting for both images' natural dimensions before capture.

## Mutation receipts

Changes were committed before mutations. Every row below ran all 16 focused tests, failed named behavior tests and restored the source bytes. The final restored selection passes 16/16.

| Withdrawn mechanism | Named failure example |
| --- | --- |
| Image markdown marker | `item markdown embeds images with their filename and links every other type` |
| Insertion UTF-8 bound | `item insertion enforces the fixed 16384 byte bound on multibyte prose` |
| Pending button lock | `capture waits for pending uploads in both button and direct form submission` |
| Pending form-handler guard | Same named capture test, through dispatched form submit |
| Upload completion callback | `file paste uploads a document once and text paste retains browser behavior` |
| Caret restoration | `completion uses the current cursor and preserves prose typed while uploading` |
| Late-completion guard | `closing the dialog invalidates an upload and unmount releases previews` |

A separate compiling/built mutation changed `useItemActions.create` to publish an empty body. The named desktop browser workflow failed on expected `![button.png]` versus empty event content (one test selected). Exact restoration/rebuild returns both browser workflows to green. An earlier redundant cursor-fallback mutation survived; that fallback was removed, and no coverage claim is made for it.

Raw receipts: `logs/verification.log`, `.scratch/item-attachments/{baseline-tests,final-tests,baseline-lint,final-lint,focused,typecheck,build,scoped-biome,file-sizes,browser}.log`; all seven named mutation outputs, `mutations.json`, `mutation-restored.log`, and `wire-mutation{,-summary}.log` in the same directory. Six inspected, distinct screenshots: `screenshots/{capture,detail,lightbox}-{buzz-1440,buzz-dark-390}.png`.

## Acceptance boundary

Relay and media responses were mocked. The real upload preparation/signing and media-fetch/rendering code executed; authenticated relay storage, its validation/refusals and persistence were not exercised. This coding shell has no `BUZZ_PRIVATE_KEY`/enrolled signer (`buzz users set-status` returned the explicit required-key error). Operator acceptance needs an enrolled test identity.

The requested attached MCP tools were absent from the callable catalog. A temporary SDK connection to the attached MCP on Agent Brave claimed and closed its own tabs, but its manual-sign-in click repeatedly hit an actionability timeout; that route supplies no acceptance claim. Direct Agent Brave CDP supplied the two passing workflows above. MCP attempts are recorded in `.scratch/item-attachments/mcp-browser.log`; no global browser configuration was changed.

Source commits: `d94fde920`, `88c5280bd`, `84646462c`, `5d283b423`, `5d8395ab7`, `9b7943e7e` (decode wait). All include the requested Claude coauthor and SamGallant DCO trailers. The next agent should exercise an enrolled relay identity before declaring operational acceptance.

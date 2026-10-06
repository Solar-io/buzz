# Left nav architecture review: "toast fires, DM row shows no unread"

Reviewed at `main` @ `c85f2529e` (2026-10-05). The deployed bundle at `:6351` is
`index-Do8hnTz4.js`, the same file as the canonical `web/dist`. Branch
`claude/nav-arch-review`. Reproduction tests are in
`web/src/features/sidebar/lib/dmToastVsRow.test.mjs`.

## 1. Summary

**The toast and the DM row do not miss each other on the wire.** One relay
event reaches both. I mounted the two real hooks (`useDms` for the row and
`useChannelActivity` for the toast) on a real `RelaySession` over a fake
socket. Their identical filters collapse into one shared wire subscription
(`subscription-share.ts`), and a single live kind-9 both fires the toast
handler and flips `dmRowUnread` to true. Test 1 shows this. Re-introducing the
09-17 bug (dropping DM samples after EOSE) makes that test fail on its row
assertion, so the test is live.

That leaves only two ways a toasted DM can show no indicator. Both exist in
the current code, and both got much more visible on 10-03.

| # | Mechanism | Status |
|---|---|---|
| A | **The read marker is advanced by a client nobody is looking at.** `repos.tsx:198-210` marks the *open* conversation seen whenever a message lands. There is no gate on `document.visibilityState`, window focus, or a web view covering the conversation. NIP-RS (`readStateSync.ts`, 5 s debounce) then max-merges that marker into every other client. Any second Buzz client (phone app, another Brave window or tab, the desktop app) that has the DM open will mark each arrival read and push that within ~5 s. The client showing the toast then computes `isUnread(marker ≥ msg) = false` (`rowUnread.ts:52-58`). | Mechanism proven in code and test 2. That it caused tonight's report is **inferred**: the relay shows two live NIP-RS slots for Sam publishing 5 s apart at 22:46:36 and 22:46:41. That is the "client A marks, client B converges" signature. |
| B | **The row is not rendered.** Since `ae53bc2f1` (10-03, "DMs now go through the same ranker (previously pure recency)…"), a DM with new traffic moves up only if `unread === true`. Otherwise it keeps its A–Z slot. The DM section shows 6 rows (`sectionList.ts:17`); Sam has **68 DMs**, so 62 sit behind "N more". On top of that, `useHeldKeys` (`useSidebarOrder.ts`, wired at `ChannelSidebar.tsx:611-612`) freezes the whole order while the pointer rests anywhere on the scrolling nav. Even a correctly unread DM stays below the fold until the pointer leaves. The section header shows its unread dot only when the section is **collapsed** (`sectionHeaderState`). | **Proven** by test 3 (hold + truncation hides a newly unread DM), with a failing `todo` contract test. |

B is also what made A look like "nothing happened". Before 10-03, any DM with
new activity floated to the top by recency and was visible even when A had
already cleared its unread state. After 10-03 the same DM stays at its
alphabetical position, usually behind "62 more".

**This is a regression of a symptom class, not of one line.** The same report
("toast fired, no re-sort AND no unread dot") was fixed once in `3035233bb`
(09-17), where the DM sampler dropped post-EOSE events. That path is fixed
and proven. The new exposure comes from:

- `1b46c8927` (09-20): NIP-RS cross-device markers, layered on the
  already-ungated `markSeen`.
- `cf9a37717` (09-28): 6-row truncation.
- `296fb72f2` (09-29): pointer hold.
- **`ae53bc2f1` (10-03): DMs leave recency order. This is the commit that
  turned A into an invisible failure.**

**Confidence:** high that A and B are the only two routes (the data path is
proven clean). Which one fired tonight is medium-confidence and not
determined. The DB shows exactly one DM arrival that could have toasted in the
PWA in the 30 min before 22:42: `1cd5e97d` at 22:38:53 from `4898b1ff`. That
DM was in Sam's top-4 recently-written, so it would have been rendered, which
points at A for that one. If Sam meant earlier DMs, or DMs on another device,
this is unresolved. Ask him which DM and roughly when, and whether the
"toast" was the in-app top-right card or a macOS banner. A Web Push banner
(`push-enrollment.ts:329`, `#p` kind-9) arrives through the push gateway, not
this client's socket.

### Other defects found on the way (all proven by reading; the third by test)

1. **The DM unread count goes stale.** `useUnreadCount.ts` makes a one-shot
   REQ keyed on `(channelId, lastSeenAt)` and unsubscribes at EOSE. New
   arrivals never re-run it, so the pill freezes at its mount value. Because
   NIP-01 `since` is inclusive, it also counts the already-read message
   sitting at the marker. Channel rows use the live counting feed; DM rows do
   not.
2. **Two definitions of "new".** The toast fires only when an event *beats a
   prior sample* (`channelActivity.ts:170-172`). The row is unread whenever
   the newest message is newer than the marker. So the **first message in a
   never-messaged DM dots the row but never toasts** (test 4). That is the
   reverse of tonight's symptom, from the same root.
3. **There is no diagnostic trail.** Nothing records why a marker moved
   (local open, NIP-RS from slot X, or the "Mark read" menu). Tonight's report
   cannot be decided from evidence for this reason.

## 2. Why the sidebar keeps breaking

**Unread and recency for one DM row come from up to 9 independent sources of
truth**, each with its own lifecycle, and they are only reconciled at render
time inside `ChannelSidebar`.

| Source | Owner | Feeds |
|---|---|---|
| 39000 channel list (`updatedAt`) | `useChannels` | fallback recency |
| DM newest-sample feed | `useDmActivity` (`dms/hooks.ts`) | row dot, preview, recency |
| DM toast feed (twin sub, different "live" rule) | `MessageToasts` → `useChannelActivity` | toasts, sounds |
| Per-row one-shot count REQ | `useUnreadCount` (×68 rows) | DM pill number |
| Channel counting feed | `useChannelActivity` (repos.tsx) | channel dots and counts, channel toasts |
| Read markers, copy 1 | `repos.tsx` `useState(loadReadState)` | rows, counts |
| Read markers, copy 2 (re-read on focus) | `useInboxReadState` | inbox, Work |
| NIP-RS merge (writes localStorage behind React) | `readStateSync.ts` | both copies, via a window event |
| Own sends, visit scores, prefs/mute, hidden-DM snapshot, favorites sync | five more hooks | order, visibility |

Then **three presentation-state layers** (open-item snapshot, pointer hold,
6-row truncation) can each hide or freeze a correct fact.

The recurring failure has one shape: a fix lands in one source (the 09-17
sampler, 09-27 recount, 09-11 in-flight key), and the next feature adds a
consumer or presentation layer that reads a *different* source or masks the
fact (10-03 ranking). There is no single invariant like "if a toast showed,
the row shows" that any test checks across the whole path.

**Test coverage is unit-pure where the bugs live.** 133 sidebar and DM tests
exist, and nearly all import a pure function.

| Gap | Shape |
|---|---|
| No test mounted `useDms` / `useDmActivity` before this review | the row's actual data source, untested |
| No test for `MessageToasts` or `useUnreadCount` | toast and pill paths, untested |
| `ChannelSidebar.layout.test.mjs` feeds rows by props | **replica under test**: the data path never runs |
| `sectionList` and `sectionOrder` are tested separately, never together with the hold | the combination that hides rows is never exercised |
| `tests/e2e/sidebar-order.spec.ts` seeds unread statically and **moves the mouse away** (`page.mouse.move(1000,100)`) before asserting | it explicitly avoids the hold that bites the user, and never pushes a live arrival |
| No e2e of "live DM arrives → toast AND row badge" | **unreachable feature**: no test runs the real thing end to end |

## 3. Target design: one conversation-activity store

**Contract.** One framework-free store,
`web/src/features/activity/conversationActivity.ts`, owns everything "new
since you looked" for every conversation (stream, forum, DM). It is fed by
**one** batched subscription family. Toasts, sounds, OS notifications,
sidebar rows, the phone tab badge, inbox and Work all read from it through
`useSyncExternalStore` selectors. Nothing else may open a kind-9 activity REQ
or write a read marker.

```
RelaySession ──(one counting feed: #h batches, since=marker, live)──▶ ConversationActivityStore
                                                                   │  state[id] = { newest, unreadCount, marker, markerSource }
ReadMarkerStore ◀── markSeen(id, ts, source) ── visible timeline   │  events: arrival(entry), markerMoved(id, from, to, source)
     ▲   └── NIP-RS merge (source = "sync:<slot>")                 │
     └──────────────────────────────────────────────────────────── ▼
        selectors: useConversation(id) · useUnreadTotals() · onArrival(handler)
        consumers: DmNavRow / SidebarNavButton · MessageToasts · NotificationRuntime · PhoneTabBar · Inbox
```

**Invariants (every one is a test):**

- **I1. Toast implies row.** When `onArrival` fires for message *m* in *c*,
  `useConversation(c).unread` is true in the same commit. A later clear must
  come with a `markerMoved` whose `to ≥ m.created_at`.
- **I2. Same definition of "live".** "Live" means arrived after this feed's
  first EOSE, from a foreign author, not a wake for someone else, and
  `created_at > marker`. It no longer depends on beating a prior sample, so
  the first message in a fresh DM both toasts and dots.
- **I3. Markers advance only when seen.**
  - Local `markSeen` requires the conversation to actually be on screen:
    `visibilityState === "visible"` AND `document.hasFocus()` AND not covered
    by a web view (`shownId`).
  - When a hidden conversation becomes visible, it is marked then.
  - NIP-RS merges carry `source: "sync:<slot>"`.
  - All moves go into a 200-entry ring buffer (`window.__buzzUnreadTrace`), so
    the next report can be decided in one look.
- **I4. One count.** The DM pill and the channel pill both read `unreadCount`
  from the store. `useUnreadCount` is deleted.
- **I5. Unread is never hidden.** Under hold or truncation, unread rows are
  always within the shown slice (lifted like the selected row). "N more"
  reads "N more · K unread" when K > 0. The hold may delay *moving* a row but
  never hides an unread one.

**Trade-offs.**

- One store means one module that every surface depends on. That is
  acceptable because it is pure, framework-free, and node-testable (the
  `channelActivity.ts` handlers already are).
- Gating `markSeen` on focus means a message read on a second monitor while
  another app has focus stays unread until you click into Buzz. That is
  Slack's behavior and the honest one.
- Alternative considered: keep separate feeds and add cross-checks. Rejected,
  because it is how we got nine sources.
- Alternative considered: restore pure recency for DMs. That would fix the
  visibility half (B) cheaply, but it contradicts Sam's 10-03 sort spec, so it
  is offered only as phase-0 fallback (b) below, not the plan.

## 4. Implementation plan

**Phase 0: hotfixes (one subsystem each, ≤1 day; ship before the refactor)**

1. `sectionList.ts` `truncateSection`: also lift every row where
   `isUnread(item)` into `shown`, and add a "· K unread" suffix to
   `moreLabel`. `SidebarSection` already receives `isUnread`.
   - **AC:** flip the `todo` contract test in `dmToastVsRow.test.mjs` to a
     plain test, and it passes.
   - **AC:** a 68-DM fixture with one unread at A–Z position 40 renders that
     row while held.
2. `repos.tsx:198-210`: gate `markSeen` on `document.visibilityState ===
   "visible" && document.hasFocus() && shownId === channelId`. Re-run on
   `visibilitychange` and `focus`.
   - **AC:** a hidden-tab jsdom test shows no marker move. Making it visible
     moves the marker. Mutating the gate fails that test.
3. Unread trace ring buffer: `markerMoved {id, from, to, source}` and
   `arrival {id, eventId, toasted, rowUnread}`.
   - **AC:** `window.__buzzUnreadTrace` exists in the prod bundle and shows
     the source of the last move.
4. (b) Fallback, only if Sam prefers it: DMs rank unread → recency → A–Z.

**Phase 1: unify the feed (Substantial: architect done, so coder, then tester)**

1. Create `features/activity/conversationActivity.ts` (the store, wrapping
   the existing `createChannelActivityHandlers` in counting mode for **all**
   ids, DMs included) and `useConversationActivity.ts` (selectors).
2. Mount it once in `repos.tsx`, in place of the current
   `useChannelActivity(channelActivityIds, …)`.
3. Delete `useDmActivity`'s subscription. `useDms` becomes a selector over the
   store (DM samples and recency). Delete `MessageToasts`' `dmFeed`; it
   registers `onArrival` once. Delete `useUnreadCount`; `DmNavRow` reads
   `unreadCount`.
4. Change the live rule in `channelActivity.ts:170` to I2 ("after first
   EOSE"), keeping the wake floor.
5. **AC:** one REQ family per id set (count REQs on the fake wire: 7 batches
   for 68 DMs plus channel batches, not 3×).
6. **AC:** I1, I2 and I4 tests pass on the real hooks.
7. **AC:** existing `channelActivity.test.mjs` T-cases pass unchanged.

**Phase 2: one marker store.** Fold the `repos.tsx` readState, the
`useInboxReadState` copy and the NIP-RS merge into `readMarkers.ts`, with a
subscribe API and `markSeen(id, ts, source)`. NIP-RS writes through it instead
of writing localStorage and firing a window event.

- **AC:** no `loadReadState()` call outside the store.
- **AC:** an NIP-RS merge re-renders rows without a window event.

**Phase 3: presentation and e2e.**

1. Replace the whole-nav pointer hold with a per-row hold (only the row under
   the pointer and its neighbors keep position), still subject to I5.
2. Add `tests/e2e/unread-live.spec.ts`: mockRelay `push()` of a live DM while
   viewing another channel, with the **mouse resting on the sidebar**. Assert
   the toast is visible, `dm-row-badge` is visible with count 1, a second push
   makes it 2, and opening the DM clears it.
3. Add a two-context spec: context B has the DM open but hidden, and A's
   badge must stay.

Rollback: each phase is one merge. Phase 1 swaps a hook behind identical
props, so reverting the merge commit restores the old feeds.

## 5. QA "tear it apart" plan

Setup: mockRelay e2e plus a live check on `:6351` with two agents DMing a test
identity. Run every row with the **mouse resting on the sidebar** and again
with it away. Fixture: ≥ 20 DMs so truncation is in play.

| # | Scenario | Expected, user-visible |
|---|---|---|
| 1 | DM arrives while viewing another channel | Toast within 1 s. DM row moves into the visible slice with bold name and pill "1". A second message makes the pill "2". |
| 2 | DM arrives while viewing that DM | No toast, no pill. The timeline shows the message. The marker advances. |
| 3 | DM arrives while that DM is open but the tab is hidden or the window unfocused | OS notification (if enabled). On return: the pill shows N, then clears once the DM is visible and focused. |
| 4 | App backgrounded for 10+ min (socket throttled or dropped), 3 DMs arrive | On foreground, within 5 s of reconnect: pill shows 3, the row is in the visible slice, and **no** replayed toast storm (at most one summary toast or none). |
| 5 | PWA reload with 2 unread DMs | After load: both rows visible with correct counts. No toasts for backlog. |
| 6 | Muted DM receives a message | No toast, no sound. The row is not bold, with no pill (or a muted grey count, per spec). The phone badge excludes it. |
| 7 | Agent DM receives a message | Toast carries the hex mark. Row and pill as in #1. Running pill and unread pill both visible. |
| 8 | Brand-new DM, never opened, first message | DM appears in the list, **toasts**, and the row is visible with pill "1". |
| 9 | Hidden ("Remove from list") DM receives a message | The relay resurfaces it. Row appears with pill, plus a toast. |
| 10 | Channel (non-DM) message | Same as #1 for channel rows. Forum: the post shows on the Forums disclosure dot. |
| 11 | Thread reply in a DM | Counts as unread in that DM (per spec), toast says "in thread", row pill increments. |
| 12 | Own send from another device into a DM | No toast, no pill. The row's "recently wrote" rank lifts it into the top four. |
| 13 | DM read on device B (visible and focused) | Device A clears the pill within ~6 s. The trace shows `source: sync:<slot>`. |
| 14 | DM open on device B but B hidden or locked | Device A **keeps** the pill (I3). |
| 15 | Scheduled wake addressed to another member | No toast, no pill, no re-sort. |
| 16 | Wake addressed to the viewer | Toast and pill. |
| 17 | 8 unread DMs (more than visibleItems) | All 8 rendered, or "N more · K unread" visible. Newest first. |
| 18 | DMs section collapsed | Header unread dot plus count. Expanding shows the unread rows at the top. |
| 19 | "Mark as read" from the row menu | Pill clears. The trace shows `source: menu`. Synced to device B. |
| 20 | Favorited DM | Behaves as #1 inside Favorites. |
| 21 | Phone layout: Channels tab badge | Equals the number of rows showing a pill, always (one definition). |
| 22 | Relay drops one batch sub (CLOSED rate-limited) | The health sweep heals it within 60 s, and a missed message appears with a pill. |

Pass bar: every row passes with the mouse on and off the nav. Every
pill/toast discrepancy is reported with a `window.__buzzUnreadTrace` dump.

## 6. Open questions for Sam

1. Which DM(s), and roughly when? Was the "toast" the in-app card or a macOS
   banner? What other Buzz clients were running (phone app, desktop app,
   other Brave windows)?
2. Phase 0(b): keep the 10-03 sort spec and fix visibility with I5
   (recommended), or return DMs to pure recency?

## 7. Verdict

**Ready for implementation.**

- Phase 0 is small and independently shippable. Items 1–2 close both routes;
  item 3 makes the next report diagnosable.
- Phase 1 is the structural fix. It removes three of the nine sources and the
  dual "live" definition.
- Do not start more sidebar features until I1 to I5 are tests.

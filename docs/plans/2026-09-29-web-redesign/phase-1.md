# Phase 1 — New shell, palette, Work tab v1

Architect design for Phase 1 of [`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md).
Implementer: **`designer`** seat. Builds on the Phase 0 seams
([`phase-0.md`](phase-0.md)): `RightPaneHost`, `rightPaneLayout`,
`ShellProviders`, the fixed-palette path, and the §2.3 token table (the canvas
→ Tailwind translation you read the artboards with). Line refs are at
`df7363b9a` *before* Phase 0 — re-find them after Phase 0 lands.

Artboards: **Main**, **Vitals**, **Toasts**, **PhoneWork**, **PhoneChannel**.
Canvas font sizes are px; use `text-badge` (10), `text-2xs` (11), `text-xs`
(12), `text-sidebar-meta` (13), `text-sm` (14) — `pnpm check:px-text` rejects
literals.

---

## 1. File-by-file change map

### 1.1 New feature `web/src/features/work/` (all files < 400 lines)

| File | Kind | Responsibility |
|---|---|---|
| `lib/workTypes.ts` | types | `NeedRow`, `RunRow`, `QueuedRow`, `DoneSummary`, `WorkFeed`, `WorkScope` |
| `lib/needsYou.ts` | pure | merge the four sources → `NeedRow[]`, sort, chip filter, counts (§2.1–2.3) |
| `lib/approvalEvents.ts` | pure | 46010/46011/46012 → pending approvals (§2.1 source 3) |
| `lib/activeTurns.ts` | pure | observer frames → active turns + stalled rule (§2.4) |
| `lib/queuedReactions.ts` | pure | 👀/💬 reactions + kind-5 deletions → queued / reaction-running (§2.5) |
| `lib/turnMetrics.ts` | pure | decrypted 44200 payload → `DoneSummary` for today (§2.6) |
| `lib/workFeed.ts` | pure | `buildWorkFeed(inputs, now, scope, channelId)` — the single join |
| `lib/workQueries.ts` | pure | REQ filter builders (approvals, reactions, metrics), `#h` chunking via `chunkChannelIds` from `home/lib/inboxQuery.ts` |
| `lib/workPrefs.ts` | pure + storage | scope, per-section collapse, active right tab, work-rail width/collapse (try/catch storage) |
| `lib/ownSends.ts` | module | LRU (200) of event ids the viewer signed — agent-done toast filter (§5) |
| `WorkProvider.tsx` | provider | the three new subscriptions + decrypt; exposes `useWorkFeed()` |
| `useWorkFeed.ts` | hook | reads `useAsks()`, `useRemindersQuery`, `useObserverStore()`, provider state → `buildWorkFeed` |
| `useWorkToasts.ts` | hook | needs-you + agent-done toasts (§5) |
| `ui/WorkTab.tsx` | ui | header (title, scope toggle, collapse) + four sections; `fullPage` prop for phone/tablet |
| `ui/NeedsYouSection.tsx`, `ui/NeedRow.tsx`, `ui/NeedActions.tsx` | ui | chips, rows, inline expand (answer card / grant-deny / open / snooze) |
| `ui/RunningSection.tsx`, `ui/QueuedSection.tsx`, `ui/DoneSection.tsx` | ui | as the Main artboard |
| `ui/WorkRailCollapsed.tsx` | ui | 44 px strip: need count (hex badge), running count, expand |

### 1.2 New feature `web/src/features/vitals/`

| File | Responsibility |
|---|---|
| `lib/vitalsMath.ts` | pure v1 math over `Pace` (§4) |
| `ui/VitalsBlock.tsx` | shaded `bg-vit` box, one combined bar, "N% free" |
| `ui/VitalsPopover.tsx` | per-account rows with elapsed tick, pace lines, "Usage hub ↗" |

Reuses `features/usage/lib/usageHub.ts` (`fetchPace`, `USAGE_HUB_URL`) and
`paceFormat.ts` (`activeStatus`, `formatClock`, `isParked`). **Delete**
`features/usage/ui/ClaudePaceCard.tsx` and `ClaudePaceCard.test.mjs` (report the
test-count delta; T1-16..18 replace them).

### 1.3 Edited files

| File (size before P1) | Change |
|---|---|
| `features/shell/rightPaneLayout.ts` (P0) | Tab model (§3). `RightTab` "thinking"\|"thread" → `RightTabId` "work"\|"thread"\|"activity" |
| `features/channels/lib/dmPaneToggles.ts` (129) + its 12 tests | 🧠 / Replies toggles act on `RightTabId` (🧠: activity ↔ previous; Replies: thread ↔ previous). Update tests by name, don't delete |
| `features/channels/useDmRightPane.ts` (146) | holds `active: RightTabId`, `previous`, persisted via `workPrefs` |
| `features/shell/ui/RightPaneHost.tsx` (P0) | tab strip (only when ≥2 tabs; one tab renders the "Work" title per Main), Work tab, collapsed strip |
| `app/ShellProviders.tsx` (P0) | mount `<WorkProvider channels selfPubkey agentPubkeys>` inside `AsksProvider` |
| `app/routes/repos.tsx` (≤900 after P0) | pass `channelId` + `onOpen` into the host; phone tab wiring. Budget ≤ 60 lines, stays < 1000 |
| `app/reposSearch.ts` | add `"work"` to `SHELL_VIEWS` (`:13-20`) |
| `app/ShellViewPane.tsx` | `case "work": <WorkTab fullPage/>` |
| `features/channels/lib/lastConversationScope.ts` | phone (`(width < 48rem)`) bare `/repos` → `view=work` (§6, decision D3) |
| `shared/layout/AppShell.tsx` | `phoneTabBar?: ReactNode` rendered after the row, `md:hidden`; phone bar shows a back chevron instead of the hamburger when a conversation is open |
| new `shared/layout/PhoneTabBar.tsx` | §6 |
| `features/sidebar/ui/ChannelSidebar.tsx` (591) | workspace header; Jump (existing ⌘K field, restyled); nav Inbox + Files (+ Work row `lg:hidden`); `<VitalsBlock/>` replaces `<ClaudePaceCard/>` at **`:580`** (plan said `:504`). Target ≤ 650 |
| `features/sidebar/ui/SidebarWithBadges.tsx` | pass needs count for the Work row |
| `shared/theme/fixed-palettes.ts` | `FIXED_THEME_FOR = { buzz: "buzz-light", "buzz-dark": "buzz-dark" }` — the one-line switch |
| `shared/styles/palettes.css` | final values after visual review against Main (tokens may be tuned here only) |
| `shared/ui/sonner.tsx` | restyle; `visibleToasts={3}`; stack header (§5) |
| new `shared/ui/notify.ts` | toast variants (§5) |
| `features/channels/lib/messageToast.ts`, `ui/MessageToasts.tsx` | `notify.message` |
| `features/reminders/useReminderNotifications.ts` | `notify.feedbackDue` (`:82`) |
| `features/channels/ui/Composer.tsx` (~935 after P0) | send-failure toasts (`:769`, `:772` pre-P0) → `notify.sendError`. Must not grow |
| `features/channels/lib/useMessageActions.ts` | `onSigned` also records into `ownSends` |

Palette literals: every surface above is written on tokens. Replace
`text-amber-*/emerald-*/red-*` **on these files only**; the other ~60 files are
out of scope (phase-0 §6, open question).

---

## 2. Work tab data model

One pure join, `buildWorkFeed`, fed by one hook. Nothing in `ui/` derives data.

```ts
type WorkScope = "everywhere" | "channel";
interface WorkFeed {
  needs: NeedRow[];                 // sorted, scope-filtered, NOT chip-filtered
  needCounts: { all: number; approvals: number; asks: number; feedback: number; overdue: number };
  running: RunRow[];                // live first, then stalled
  queued: QueuedRow[];              // oldest first ("next" = queued[0])
  done: DoneSummary | { state: "locked" | "unavailable" };
}
```

### 2.1 Needs-you sources

| # | Source | Rows | Clears when | Kind / chip |
|---|---|---|---|---|
| 1 | `useAsks().interviews` (`home/AsksProvider.tsx`) — already folded per thread, unanswered only | one per interview | existing answer detection (`askQueries`, `cardAnswered.ts`) | `ask` / Asks |
| 2 | `useAsks().feed` → `buildInboxItems` (`home/lib/inboxItem.ts:127`) with `inboxReadPredicate(readState, loadInboxReadState())` | items whose categories include `mention` and **not** `dm`, `unreadCount > 0`, representative message has **no card** (a card is source 1) | read — viewing the channel past it or opening the row (`markInboxMessagesRead`) | `mention` / Asks |
| 3 | **New** relay subscription, kinds **46010/46011/46012** (§2.7) → `approvalEvents.ts` | a 46010 with no 46011/46012 carrying the **same `approval` tag** | grant/deny event arrives; or on expand, `useRunApprovals` (`workflows/useWorkflowRuns.ts:122`) reports non-pending → row drops | `approval` / Approvals |
| 4 | `useRemindersQuery(self)` (`reminders/hooks.ts:54`), `status === "pending"` | all pending reminders | done/cancel/snooze via `useReminderMutations` | `feedback` / Feedback |

DMs are **not** Needs-you rows (agent DMs are conversational volume; the Inbox
still has them). Summary text for feedback: `useReminderSummary`
(`reminders/hooks.ts:170`), which already falls back to the truncated preview
when buzz-summary-bridge (:6368) is down.

```ts
interface NeedRow {
  key: string;                 // "ask:<cardId>" | "mention:<conversationId>" | "approval:<ref>" | "feedback:<d>"
  kind: "approval" | "ask" | "mention" | "feedback";
  chip: "approvals" | "asks" | "feedback";
  channelId: string | null;    // null only for note-only feedback
  actorPubkey: string | null;  // who is asking / whose workflow
  title: string;               // card title | message preview | approval text | summary
  at: number;                  // unix s: createdAt, or notBefore for feedback
  expiresAt: number | null;    // approvals only, when known
  overdueBy: number | null;    // feedback only: now − notBefore when > 0
  open: { channelId: string; messageId: string } | { view: "reminders" } | null;
}
```

### 2.2 Sort rules (`sortNeeds`, total and stable)

1. Approvals with `expiresAt − now ≤ 3600` first, soonest expiry first.
2. Then rank: `approval` = `ask` = 0, `mention` = 1, `feedback` = 2.
3. Rank 0 and 1: newest `at` first.
4. Rank 2: overdue first, **most overdue first**; then upcoming, soonest due first.
5. Tie-break: `key` ascending.

The first visible row renders expanded with its actions; one expanded row at a
time. Show 6, then "Show N more".

### 2.3 Scope, chips and counts

- **Everywhere / This channel** — `scope` persisted (`buzz.work.scope.v1`,
  default `everywhere`). "This channel" keeps rows whose `channelId` equals the
  open conversation; it is disabled (and behaves as Everywhere) on view pages.
  Same rule for Running, Queued and Done.
- Chips filter the **list** only. Header count = `needCounts.all` = rows after
  scope, so the badge never counts something the list can't show (the
  `inboxFilter.ts` 2026-09-17 complaint). `overdue` = feedback rows with
  `overdueBy > 0`.
- Section collapse persisted per section (`buzz.work.collapsed.v1`).

### 2.4 Running: the stalled rule

`agentWorkingState` (`agents/lib/observerEvents.ts:411`) is **not** usable: it
returns `working:false` after 180 s of silence — it hides a stalled turn, which
VISION_ACTIVITY forbids. New reducer `activeTurns(byAgent, nowS)` over
`useObserverStore().byAgent` (ports the semantics of desktop
`activeAgentTurnsStore.ts`):

- Group frames by `(agentPubkey, turnId)`; ignore frames with null `turnId`
  except `agent_panic`.
- Turn **ends** on `turn_completed` or `turn_error` with that `turnId`, or an
  `agent_panic` newer than the turn's last frame.
- `startedAt` = latest parsed `frame.startedAt` for the turn (the harness stamps
  it on every frame; survives a reload mid-turn when `turn_started` is outside
  the 300 s live lookback, `observerFilters.ts:13`), else earliest `createdAt`.
- `lastBeatAt` = newest `createdAt` among the turn's frames. `turn_liveness`
  (ACP emits every `BUZZ_ACP_TURN_LIVENESS_SECS`, default 10 s,
  `pool.rs:5082`) is the floor that keeps a quiet turn alive; every other frame
  also counts.
- **Stalled** ⇔ `now − lastBeatAt > LIVENESS_BUDGET_S = 25` (2.5 × interval, same
  as desktop `REMOVE_AFTER_MS`). Shown as coral "no heartbeat · 1m 20s",
  **never removed** for silence. The row gets a **Dismiss** (local tombstone by
  `turnId`, cleared on reload). After 10 min silent it reads "lost · last seen …".
- `channelId` null (heartbeat turns) → Everywhere only, labelled "heartbeat".
- Sort: live rows newest `startedAt` first, then stalled rows. Header:
  "Running 4 · 1 stalled".
- **Visibility:** 24200 is owner-encrypted — Running shows the viewer's own
  agents only (plan §Risks). Reaction-derived rows (§2.5) cover others without
  timing claims.
- Tick: reuse `useTick` (`agents/ui/WorkingBadge`) at 1 s while any row is live.

```ts
interface RunRow {
  agentPubkey: string; turnId: string | null; channelId: string | null;
  startedAt: number | null; lastBeatAt: number | null;
  state: "live" | "stalled" | "lost" | "reacting"; source: "observer" | "reaction";
}
```

### 2.5 Queued (and reaction-running)

ACP reacts 👀 when an event is queued and 💬 while prompting, removing both
(kind 5) when the turn ends (`pool.rs:5004-5024`; reactions carry only an `e`
tag, the relay derives the channel so `#h` filters match — the timeline's own
`olderPageFilter` relies on the same).

- Subscription (§2.7): `{kinds:[7,5], authors:<known agents>, "#h":<chunk>, since: now−7200}`.
- A reaction is **alive** unless a kind-5 from its author `e`-references it.
- **Queued** ⇔ alive 👀 on event E by agent A, no alive 💬 by A on E, no
  observer turn of A whose `turn_started.payload.triggeringEventIds` includes E,
  and age ≤ `QUEUED_TTL_S = 7200` (ACP documents a cosmetic stale-👀 race; past
  2 h we stop claiming it).
- **Reaction-running** ⇔ alive 💬 by A on E with **no** observer turn for
  (A, channel). State `reacting`: "working · since 3:12", no elapsed heartbeat,
  never "stalled" (no liveness data to judge by). An observer row for the same
  (agent, channel) wins.
- Collapsed summary per Main: "Queued 6 · next: → Lord Nikon · #flight-path".
  Target previews load lazily on expand (`ids` REQ, cached).

### 2.6 Done today (kind 44200) — decryptable, verified by code

NIP-AM: agent-authored, `p`=owner, **NIP-44 v2 with (agent key, owner key)**
— the same pair as 24200 frames the web already decrypts in
`ObserverProvider.decodeFrame`. The relay serves
`{kinds:[44200],"#p":[self]}` to the owner (`handlers/req.rs:1432`). No `h`
tag, so the global `#p` index delivers history **and** live (inverse of
`inboxQuery.ts` rule 1). ACP publishes on every turn exit (`pool.rs:2875-3486`).

- Filter `{kinds:[44200], "#p":[self], since: localMidnight}`.
- `DoneSummary = { count, last: {agentPubkey, channelId, at, stopReason} | null, locked }`,
  count = distinct `turnId` (fallback event id).
- Undecryptable → `locked` count, never counted as done. Key not unlocked →
  section state `locked`. REQ `CLOSED` → `unavailable` (section hidden, not "0").
- v1 rows read "Acid Burn · #engineering · 3:12 PM · end_turn". The canvas's
  "finished jitter buffer QA · 212 passed" needs task titles — **Phase 8**.

### 2.7 WorkProvider subscriptions

Mounted once in `ShellProviders` (same discipline as `AsksProvider`); each
re-subscribe keyed on a sorted id set, debounced 2 s.

| REQ | Filter(s) | Why separate |
|---|---|---|
| approvals history | `{kinds:[46010,46011,46012], "#p":[self], since: now−14d, limit:500}` | `#p`-only = history only (`inboxQuery.ts` rule 1) |
| approvals live (per 128-id chunk) | `{kinds:[46010,46011,46012], "#h":chunk, "#p":[self], since:now}` | `#h` puts it in the channel index |
| reactions (per chunk) | `{kinds:[7,5], authors:agents, "#h":chunk, since:now−7200}` | never mixed with an `#h`-less filter (rule 2) |
| metrics | `{kinds:[44200], "#p":[self], since:localMidnight}` | channel-less, global index is live |

`agents` = `knownAgentPubkeys` from the route (`repos.tsx:585-591`), sorted,
capped at 100. Relay limits: 128 `#h` values/REQ, 10 filters/REQ, 1000/filter.

---

## 3. Right-pane tab model

```ts
type RightTabId = "work" | "thread" | "activity";
function rightPaneTabs(i: RightPaneInput): RightTabId[] =
  ["work", ...(threadOpen ? ["thread"] : []), ...(i.agentDm && !i.paneHidden ? ["activity"] : [])];
```

- **≥ lg:** the host is always docked (Work rail), except when the web layer is
  active (Phase 4 changes that) or the rail is collapsed. **Work is always tab 1.**
- Opening a thread ("N replies") → `active = "thread"`, remembering `previous`.
  Closing it → `previous` if still present, else `"work"`.
- Entering an agent DM with the pane not hidden → `active = "activity"` once per
  entry (today's default: the thinking pane opens). 🧠 toggles activity ↔
  previous; Replies toggles thread ↔ previous.
- The thread's **Focus** layout (`ThreadPanel` `useThreadLayout`) stays an
  overlay, not a tab.
- **Width:** decision D1 — Work rail has its own width (`buzz.work-width.v1`,
  default 380 per Main, min 320, max 520); thread/activity keep the shared
  thread width (default 600). Host width = active tab's width.
- **Collapse:** Work header button → `WorkRailCollapsed` (44 px); persisted
  `buzz.work.rail-collapsed.v1`. A new need row pulses the strip's badge.
- **< lg:** no docked host. Thread/activity keep their existing sheets; Work is
  `?view=work` (sidebar row at md–lg, tab bar below md).

---

## 4. Vitals v1 (`vitalsMath.ts`, existing `/v1/pace` only)

Live sample 2026-09-30 11:10Z: A `usedFraction .02`, `elapsed .132`,
`projected .165`; B `.33`, `.805`, `.595`; both `state:"known"`, `basis:"trailing-24h"`.

| Output | Rule | Sample |
|---|---|---|
| `used` | mean of `usedFraction` over accounts with `state==="known"` and non-null value (parked accounts included — they are capacity). Assumes equal quota per account | .175 |
| `free` | `1 − used`, shown as "82% free" | 82% |
| `coverage` | `known / total`; < 1 → "1 of 2 accounts" note | 2/2 |
| `paceMultiplier` (per account) | `usedFraction / elapsedFraction`, **null when `elapsedFraction < 0.05`**; line "B is running at 1.6× its pace" only when ≥ 1.1 | A .15, B .41 → no line |
| "fills around …" | `etaFullAt` non-null and before `resetsAt` → `formatClock(etaFullAt)` | none |
| "resets with ~N% unused" | `projectedAtReset < 0.98` and `etaFullAt` null → `N = round((1 − projectedAtReset)·100)` | A 84%, B 40% |
| per-account bar tick | `elapsedFraction` | A 13%, B 80% |
| colour | `activeStatus(pace)` (paceFormat) → ok `work`, warn `honey-ink`, critical `need` | ok |
| staleness | "updated Ns ago" from `computedAt`; refetch every 5 min and on popover open | |

Hidden until later phases: the runway text ("~2h 50m of active use", "You
won't run dry" — Phase 4), crichton rows (Phase 7). Hub unreachable → the block
shows "Claude · usage unavailable", never 0%.

---

## 5. Toasts (`shared/ui/notify.ts`, sonner 2, top-right kept)

| Variant | Raised by | Duration | Actions | Timer line |
|---|---|---|---|---|
| `message` | `MessageToasts` (`MESSAGE_TOAST_DURATION_MS` 6000) | 6000 | Open (Reply/Feedback join in Phase 2 — no control that lies) | yes |
| `agentDone` | `useWorkToasts`: `turn_completed` for a turn whose `triggeringEventIds` ∩ `ownSends` ≠ ∅, channel not open | 6000 | Open | yes |
| `needsYou` | `useWorkToasts`: an approval/ask row that **arrived after the feed settled**, Work tab not visible | ∞ | Approve / Review, or Open | no |
| `feedbackDue` | `useReminderNotifications` | ∞ | Open, Snooze 1h | no |
| `sendError` | Composer send failure | ∞ | Retry, Copy error | no — body is `result.message` **verbatim** |
| default | the ~220 existing `toast.*` calls | sonner default | unchanged | no |

- Timer line: CSS `scaleX(1→0)` over the duration, `animation-play-state:
  paused` while hovered (sonner pauses its timer on hover — they must agree).
- Stack: `visibleToasts={3}`; a "N more · Clear all" header reads `useSonner()`
  and calls `toast.dismiss()`. `mobileOffset` unchanged (`sonner.tsx:19`).
- Agent-done is deliberately narrow: every agent's every turn would flood a
  20-agent fleet. Unknown trigger author → no toast.

---

## 6. Phone (< md, 390×844)

- `PhoneTabBar` (fixed bottom, safe-area padding): **Work** (badge
  `needCounts.all`), **Channels** (badge = unread conversations), **More**
  (sheet: Inbox, Reminders, Files, Settings, Agents — all exist). Items/Shelf
  join in Phases 5/6.
- Tab derives from the URL: `view=work` → Work; no `c`, no `view` → Channels
  (renders `{sidebar}` as a page, as the drawer does today); More is a sheet.
- Hidden while a conversation is open (PhoneChannel shows none); the phone bar
  then shows a back chevron to the last tab.
- Home (D3): bare `/repos` on a phone lands on `view=work` instead of the last
  conversation.
- Existing decision-card rule stands: cards open as a bottom sheet
  (AGENTS.md, "Decision cards on a phone").

---

## 7. Test contract

Record the baseline count after Phase 0. Commit before mutating; judge kills by
unchanged total count + named failures (AGENTS.md "Mutation proof"). Hardcode
expected values — never express them via the constant under test.

| ID | File · test name | Guards | Mutation that must fail it |
|---|---|---|---|
| T1-1 | `work/lib/needsYou.test.mjs` · `merges asks, mentions, approvals and feedback with chip counts` | the join | drop source 2 (mentions) |
| T1-2 | · `a card that p-tags me is one ASK row, never also a MENTION` | dedupe | remove the no-card guard on mentions |
| T1-3 | · `sort: blocking newest-first, then mentions, then feedback most-overdue-first` | §2.2 | swap the feedback comparator |
| T1-4 | · `approval expiring within the hour pins above a newer ask` | rule 1 | delete rule 1 |
| T1-5 | · `This channel keeps only the open channel; note-only feedback is Everywhere-only` | scope | treat `channelId null` as matching |
| T1-6 | · `header count equals rows under All; overdue counts only due feedback` | badge = rows | compute `all` before the scope filter |
| T1-7 | `work/lib/approvalEvents.test.mjs` · `a grant with the same approval tag clears the 46010; a grant for another ref does not` | clearing key | match on `run` tag instead of `approval` |
| T1-8 | `work/lib/activeTurns.test.mjs` · `a turn with only turn_liveness pings every 10 s is live at t+120 s` | **the plan's mutation** | exclude `turn_liveness` from `lastBeatAt` |
| T1-9 | · `a turn silent for 26 s is stalled and still listed` (budget hardcoded 25) | never hidden | filter stalled turns out |
| T1-10 | · `turn_completed/turn_error end one turn; agent_panic ends all of that agent's turns` | terminals | ignore `agent_panic` |
| T1-11 | · `startedAt comes from frame.startedAt when turn_started is outside the window` | reload mid-turn | use earliest `createdAt` only |
| T1-12 | `work/lib/queuedReactions.test.mjs` · `👀 without 💬 is queued; a kind-5 or a 💬 removes it; older than 2 h drops` | queued rule | skip deletion matching |
| T1-13 | `work/lib/turnMetrics.test.mjs` · `counts distinct turnIds since local midnight; undecryptable is locked, not done` | honesty | count locked events |
| T1-14 | `work/lib/workFeed.test.mjs` · `an observer turn wins over a 💬 row for the same agent and channel` | merge | drop the dedupe |
| T1-15 | `shell/rightPaneLayout.test.mjs` (extend) · `Work is always the first tab; closing a thread returns to the previous tab` | tab model | append work last |
| T1-16 | `vitals/lib/vitalsMath.test.mjs` · `free = 1 − mean(known usedFraction); stale excluded and coverage reported` (fixture A .02/B .33 → .825) | combined bar | count a stale account as 0 |
| T1-17 | · `pace multiplier is null when elapsedFraction < 0.05` | divide-by-small | remove the guard |
| T1-18 | · `resets-unused hidden when etaFullAt is set` | copy rule | drop the `etaFullAt` check |
| T1-19 | `shared/ui/notify.test.mjs` · `sendError shows result.message verbatim and never auto-dismisses` | send-path rule | `.trim().slice(0,80)` the message |
| T1-20 | · `message and agentDone dismiss at 6000 ms` | durations | 4000 |
| T1-21 | `shared/theme/fixed-palettes.test.mjs` (edit T0-8 by name) · `buzz and buzz-dark resolve to the fixed palettes` | the switch | empty the map |
| T1-22 | `shared/layout/phoneTabBar.test.mjs` · `tab bar hidden while a conversation is open` | phone nav | always render |
| T1-23 | `channels/lib/dmPaneToggles.test.mjs` (12 tests, updated by name) | toggles on `RightTabId` | 🧠 sets `thread` |

Harness guards: T1-8..11 assert the fixture frame count > 0; T1-1 asserts every
source contributed ≥ 1 row before counting.

## 8. Acceptance

**Gates:** `pnpm test` (count vs baseline, ClaudePaceCard delta reported),
`pnpm build`, `pnpm check`, `CHECK_FILE_SIZES_BASE=main pnpm check:file-sizes`.

**Visual:** Main, Vitals (popover open), Toasts (all five variants stacked),
PhoneWork, PhoneChannel — each at its artboard size, `buzz` and `buzz-dark`,
beside the artboard. Plus one non-Buzz theme (`catppuccin-mocha`) at 1440 to
prove the Work rail reads on derived neutrals.

**Live** (crichton relay, Agent Brave, private channel of your own; AGENTS.md
"Driving the real web client" and "E2E against crichton"):

| # | Check | Pass |
|---|---|---|
| L1 | Identity S (CLI, attested) sends `--card --mention <viewer V>` in a channel both are members of | row in V's Needs you ≤ 5 s; answering from the row publishes (`result.ok`, root rule) and the row clears |
| L2 | Message an agent the viewer **owns** | Running row ≤ 5 s after `turn_started`; elapsed ticks; ends on `turn_completed` |
| L3 | Message an agent the viewer doesn't own | `reacting` row from 💬, no elapsed/stalled claim |
| L4 | Two messages to one agent back-to-back | second shows in Queued, leaves when its turn starts |
| L5 | `curl` `/v1/pace` vs popover | numbers match §4 rules |
| L6 | Send into a channel the viewer isn't a member of | `sendError` toast with the relay's text verbatim |
| L7 | 44200 | Done count > 0 after L2 completes; else record `locked`/`unavailable` and why |
| L8 | Theme switch buzz → catppuccin-mocha → buzz-dark | no stale colours (inspect `html` inline style is empty on buzz themes) |

Stalled is proven by T1-8/T1-9, not live (would need killing a live harness).

## 9. Risks and plan corrections

**Plan items that were wrong**
- **Workflow approvals via `useWorkflowRuns.ts`** — no "pending for me"
  endpoint exists; it would cost one NIP-98-signed request per workflow per
  poll. Relay-signed **46010–46012** carry the approver/owner `p` tag and the
  `approval` ref — Nostr-first per AGENTS.md. HTTP is used only on expand.
- **"Running: `agentWorkingState`"** — it hides stalled turns (180 s cut-off).
  Replaced by `activeTurns` (§2.4).
- **44200** — decryptable (§2.6), but has no title/progress: Done rows are
  agent · channel · time until Phase 8.
- **`ClaudePaceCard` at `ChannelSidebar.tsx:504`** → `:580`.
- **"The agents honeycomb card is removed"** — no such card exists in web (it
  is a desktop surface); nothing to remove.
- **Live "card p-tagged to Sam"** — the Agent Brave session is an agent
  identity; the check is "p-tagged to the viewer" (L1). An observer Running
  check (L2) needs the viewer to **own** the agent.

**Risks**
- Running is owner-only (24200); non-owners see reaction rows only.
- Stale 👀 after a crash can show a false Queued row for ≤ 2 h (TTL bound).
- Four new REQ families; account with >128 channels multiplies chunks. Keyed,
  debounced re-subscribes as in `AsksProvider`.
- Phone navigation changes (tab bar, back chevron, landing) are the most
  user-visible behaviour change in the phase.
- `buzz`/`buzz-dark` users (the default) change look on deploy — intended.

**Decisions for the orchestrator (defaults chosen; say if wrong)**
- **D1** Work rail width separate from the thread width (380 vs 600).
- **D2** Mentions go under the **Asks** chip with a `MENTION` badge; DMs are
  not Needs-you rows.
- **D3** Phone bare `/repos` lands on Work, not the last conversation.
- **D4** Sidebar **Reminders** nav row removed (Feedback lives in Work; the
  Reminders view stays reachable from Work, More and ⌘K).
- **D5** `buzz`/`buzz-dark` names are repurposed to the fixed palettes; the old
  fleet-derived look is not kept as a separate theme.

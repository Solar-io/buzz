# Phase 2 — Conversation: commands, ⌘K, readable messages, cards, inline threads

Designer's change map and test contract for Phase 2 of
[`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md), plus the four
Phase 1 carry-overs and three Phase 1 QA findings. Builds on
[`phase-1.md`](phase-1.md) (tokens, `RightPaneHost`, `WorkProvider`, `notify`).

Artboards: **Main** (header, inline thread, hover toolbar, composer),
**Message**, **Commands**, **Jump**, **PhoneAsk**, **PhoneChannel**, **Toasts**.

## 1. Point of view

A conversation is where Sam decides things. Every change below either removes
a step between reading and deciding (quick replies, Feedback in one click,
threads that open where they are) or makes an agent's long message scannable
(table cards, callouts, file tiles). Nothing is added that the data can't
back: no task titles, no progress bars, no scratch rows (Phases 3 and 8).

## 2. Change map

### 2.1 New

| File | Responsibility |
|---|---|
| `features/commands/lib/commands.ts` | the registry: `{id, args, group, describe, when(ctx), run(ctx, args)}`; ships `/remind`, `/handoff`, `/status` only |
| `features/commands/lib/parseCommand.ts` | `parseCommand(text)` → `null` (ordinary message) \| `{name, args}`; `commandQuery(text, caret)` for the list; `resolveCommand` → known / unknown |
| `features/commands/lib/remindWhen.ts` | `[when]` parser for `/remind` (30m, 2h, 1d, tomorrow, 3pm, monday); empty → `quickRemindDueAt` |
| `features/commands/lib/remindTarget.ts` | "the last message aimed at me" in a buffer |
| `features/commands/ui/CommandList.tsx` | the popover (Commands artboard) |
| `features/channels/lib/quickReply.ts` + `quickReply.corpus.ts` | explicit yes/no detector and its fixture corpus (positives and negatives) |
| `features/channels/lib/inlineThread.ts` | `inlineThreadRef`, reply chip summary, the collapsed window of a long thread |
| `features/channels/ui/InlineThread.tsx` | chip → replies → reply box, under the root row |
| `features/channels/ui/QuickReplies.tsx`, `HandoffChip.tsx`, `ChannelHeader.tsx`, `RunningStrip.tsx` | Message / Main / PhoneChannel pieces |
| `features/channels/ui/MarkdownTable.tsx`, `Callout.tsx`, `FileTileGroup.tsx` | readable-message renderers |
| `shared/lib/remarkCallouts.ts` | `> [!NOTE\|TIP\|IMPORTANT\|WARNING\|CAUTION]` → `<callout>` |
| `shared/lib/plainText.ts` | markdown → one plain line (tables, callouts, fences) for toasts and previews |
| `features/reminders/lib/feedback.ts` | `feedbackDueAt` (tomorrow 9:00 AM local) and its confirmation copy |
| `features/work/lib/channelMarkers.ts` | per-channel `{needs, running}` for sidebar markers |
| `shared/ui/toastStack.ts` | phone rules and the stack header's position |

### 2.2 Edited

| File | Change |
|---|---|
| `channels/ui/useComposerSuggestions.ts`, `ComposerSuggestionLists.tsx` | third trigger `command`; keyboard: ↑↓ choose, Tab complete, ↵ run, Esc close |
| `channels/ui/Composer.tsx` | a command line is **never** passed to `send`; unknown → inline error; Main composer frame (field + tool row + hint), phone compact form, `variant="inline"` for the thread reply box |
| `channels/lib/quickSwitcher.ts`, `channels/ui/SearchPanel.tsx`, `search/ui/SearchResultRow.tsx` | ghost completion + Tab, `#` `@` `/` scopes, recents, Top hit, "Search messages for …" |
| `channels/ui/MarkdownContent.tsx` | table card, callouts, file tile group |
| `channels/ui/MessageRow.tsx`, `MessageActionBar.tsx` | AGENT chip, needs-you wash, quick replies, handoff chip, toolbar with Feedback |
| `channels/ui/DecisionCard.tsx`, `CardInterview.tsx`, `CardInterviewSheet.tsx`, `CardSummaryTile.tsx` | restyle; compact answered state; PhoneAsk sheet; "send to Feedback" |
| `channels/ui/ChannelTimeline.tsx` | `ThreadPreview` out, `InlineThread` in (file must shrink: 1049 → < 1049) |
| `shell/rightPaneLayout.ts`, `useShellRightPane.ts`, `ui/RightPaneHost.tsx`, `channels/useDmRightPane.ts`, `lib/dmPaneToggles.ts`, `ui/ChannelActionsBar.tsx` | the thread tab and the Replies toggle leave; tabs are Work and Thinking |
| `reminders/ui/RemindMeLaterProvider.tsx` | `sendToFeedback(target)` |
| `work/ui/NeedActions.tsx`, `QueuedSection.tsx`, `lib/turnMetrics.ts`, `lib/workTypes.ts` | one-click Feedback bell; per-turn Done rows |
| `sidebar/ui/SidebarNavButton.tsx`, `ChannelSidebar.tsx`, `SidebarWithBadges.tsx` | need / running markers on channel rows |
| `shared/ui/sonner.tsx`, `BuzzToast.tsx`, `notify.ts`, `work/useWorkToasts.ts`, `channels/lib/channelActivity.ts` | QA findings (§5) |
| `app/routes/repos.tsx` | header, inline thread state, command context; must stay < 1000 |

### 2.3 Removed

`ThreadPanel.tsx`, `DetachedThreadPanel.tsx`, `useOpenThread.ts`,
`lib/openThread.ts` and their tests; the Thread layout preference (a setting
with nothing left to lay out). Report the test-count delta.

## 3. Behaviour rules

**Commands.** A draft is a command when its first character is `/` followed
by a letter. Leading whitespace is the escape hatch (sends as text).
`/usr/local` is not a command (a second `/` in the first token). A known
command runs and clears the draft; an unknown one shows
"Unknown command /x — not sent" and leaves the draft. `send` is not called on
either path.

- `/remind [when]` — reminder (kind 30300) on the newest message in this
  conversation from someone else that mentions me (any message from someone
  else in a DM). No `when` → +1 day (`quickRemind.ts`).
- `/handoff @seat <task>` — one kind 9 message: content `@Seat <task>`, the
  seat's `p` tag, and `["handoff", <seat pubkey>]`. Rows with that tag render
  the HANDOFF chip; its status is the agent's own 👀 / 💬 receipt, nothing else.
- `/status` — Work, scoped to this channel (the rail at lg, the page below).

**Quick replies.** Only when the message is from someone else, the detector
says yes/no, and the viewer has sent nothing after it in that conversation.
Yes / No send an ordinary threaded reply (`inlineThreadRef`) that p-tags the
asker; Feedback files it. Detector accepts: "yes or no", "yes/no", "(y/n)",
"reply yes or no". It refuses everything else, including plain `?`.

**Inline threads.** `rootId = message.rootId ?? message.replyToId ?? message.id`;
`replyToId = message.id`. Collapsed: "N replies · last 3:29 PM". Expanded:
every descendant oldest-first (long threads show the last 6 behind "Show N
earlier"), then the reply box. Expanding a row that is not the last one
pauses follow-the-tail so the thread grows downward. A reply permalink
expands its root's thread.

**Feedback.** One click → kind 30300, due tomorrow 9:00 AM local
(`nextDayAt9am(now, 1)`), toast "Sent to Feedback · due tomorrow 9:00 AM".
Replaces the hover bar's "+" (that +1 day behaviour is `/remind`).

**Callouts.** NOTE → leaf (tested), TIP → neutral, IMPORTANT → info,
WARNING → honey (untested), CAUTION → coral. Text after the marker on the
same line is the title.

## 4. Carry-overs

- **Channel header** (md+): title, topic, facepile (members popover), expiry
  badge. Phone: the top bar gains "N members · M agents".
- **Sidebar markers**: coral hex + count when the channel has needs-you rows,
  else pulsing amber hex (+ count when > 1) when agents are running there.
- **PhoneChannel**: running strip under the header; compact composer
  (`/`, field, send).
- **Done rows**: one row per finished turn today (agent · channel · time ·
  stop reason), newest first, 6 then "Show N more".

## 5. Phase 1 QA findings

1. **Phone toasts cover Work.** Below 600 px one toast shows at a time, and
   needs-you / feedback-due toasts are not raised while a Work surface is on
   screen (the row is already there).
2. **Stack header** sits under the last visible toast (Toasts artboard), and
   the approval toast reads "**Workflow** needs your approval" on a need-ringed
   mark.
3. **Previews** go through `plainText`: no `---` rows, no pipes.

## 6. Test contract

Commit before mutating; a kill = same total count, named failures.

| ID | File · test | Mutation that must fail it |
|---|---|---|
| T2-1 | `commands/lib/parseCommand.test.mjs` · `a slash line is a command; a leading space or a path is a message` | treat `/usr/local` as a command |
| T2-2 | `commands/lib/commands.test.mjs` · `an unknown command resolves to unknown, never to text` | return null for unknown names |
| T2-3 | `channels/ui/Composer.commands.test.mjs` · `a command is never passed to send` | call `send` before the command check |
| T2-4 | `commands/lib/remindWhen.test.mjs` · `30m, 2h, tomorrow and 3pm resolve to hardcoded instants; junk is null` | drop the past-time roll-forward |
| T2-5 | `commands/lib/commands.test.mjs` · `/handoff needs a resolved seat and a task, and tags the seat` | drop the handoff tag |
| T2-6 | `channels/lib/quickReply.test.mjs` · `every positive fixture is detected` (count asserted) | require "reply" in the pattern |
| T2-7 | · `every negative fixture is refused` (count asserted) | accept any trailing `?` |
| T2-8 | · `buttons close once I have replied` | ignore my later messages |
| T2-9 | `channels/lib/inlineThread.test.mjs` · `a reply to a reply carries the thread root` | `rootId = message.id` |
| T2-10 | · `a long thread shows the last six and counts the rest` | window of all |
| T2-11 | `reminders/lib/feedback.test.mjs` · `due is tomorrow 9:00 local, whatever the hour` | `+24h` |
| T2-12 | `shared/lib/remarkCallouts.test.mjs` · `the five markers become callouts; an unknown marker stays a quote` | accept any `[!X]` |
| T2-13 | `shared/lib/plainText.test.mjs` · `a table becomes cells, without the separator row` | keep the separator row |
| T2-14 | `channels/lib/jump.test.mjs` · `# @ / scope the list; the ghost completes the top prefix hit` | ghost on substring hits |
| T2-15 | · `empty query lists recents, newest first` | sort by score |
| T2-16 | `work/lib/channelMarkers.test.mjs` · `needs outrank running; channel-less rows mark nothing` | count null channels |
| T2-17 | `work/lib/turnMetrics.test.mjs` · `done rows are one per turn, newest first, locked excluded` | include locked |
| T2-18 | `shell/rightPaneLayout.test.mjs` · `the strip is Work, then Thinking — a thread is never a tab` | push a thread tab |
| T2-19 | `shared/ui/toastStack.test.mjs` · `a phone shows one toast; Work on screen suppresses needs-you and feedback-due` | always raise |
| T2-20 | `channels/lib/markdownTable.test.mjs` · `numeric columns right-align; a mixed column does not` | align every column |
| T2-21 | `channels/ui/DecisionCard.sheet.test.mjs` · `a v1 card says its question once: in the header, not again in the body` | ignore `titleShown` |
| T2-22 | · `Not now, send to Feedback files the ask, closes the sheet and answers nothing` | keep the sheet open |
| T2-23 | `app/reposSearch.test.mjs` · `?reply= only counts alongside the message it replies to` | accept `reply` without `m` |

End to end: `tests/e2e/messages.spec.ts` (new) drives every surface above
against the mocked relay at 1440 and 390 in both fixed palettes;
`work-shell.spec.ts` replaces the thread-tab case with the inline thread and
asserts the reply is rooted at the ask.

## 7. Deviations from the plan

- **Scratch ranking in ⌘K** waits for Phase 3 (no scratch channels exist).
- **Ask sheet** keeps answer-and-advance (tap an option → next question). The
  PhoneAsk "Next · choice" button appears only on a question that already
  has an answer (a revisit via Edit or a segment), where it moves on without
  re-choosing; on an open question it would add the tap Sam's flow removed.
- **Task titles and progress** on Running / Done / handoff stay out until
  Phase 8 supplies them.
- **Threads are inline only.** The thread tab, the Replies toggle, the
  detached thread window and Settings → Thread layout are gone rather than
  kept as an option: two ways to read a thread was the confusion.
- **Feedback replaces the hover bar's "+"** (quick remind). `/remind` with no
  time keeps the old +1 day; "Remind me at…" stays in the ⋯ menu.
- **⌘K commands prefill the composer** (`/handoff `) instead of running from
  the panel: every command needs the channel's context and most need text.
- **A message toast's Reply** lands on `?m=<id>&reply=1`: the thread's reply
  box in a channel, the composer in a DM.
- **A /handoff seat is picked from the @ list.** Typed names resolve against
  the member roster, whose names are short keys until picked.

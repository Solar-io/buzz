# Web client redesign: action-first shell — phased build plan

Owner request (Sam, 2026-09-29). Pinned at buzz `34643677d` (worktree
`buzz-web-redesign-f7eba8`, branch `claude/buzz-web-redesign-f7eba8`). Line
references are to that SHA.

**Design of record:** the "Buzz Web Redesign" canvas,
<https://claude.ai/artifact/K2Jb3SufvUFXbq6rwWbb7u>. Each phase below names the
artboards it must match. The canvas uses sample data; the layout, tokens,
states and copy patterns are what count.

**Handoff rule.** Coder, tester and designer prompts must embed the
infrastructure rules file verbatim, per its own sub-agent injection rule. This
plan cites the rules it depends on (ports, tailnet-only access, deploy
discipline, Agent Brave) and does not repeat them.

---

## 1. Product-contract check (AGENTS.md)

- **VISION.md, Home Feed:** "@mentions, items needing action, channel activity,
  agent updates." The Work tab is that surface, moved into the right pane so
  it sits beside every conversation.
- **VISION_ACTIVITY.md:** Running rows come from the harness's turn lifecycle,
  not from agents remembering to report. "Never go dark" and "honesty over
  guessing" apply: idle and stalled are shown states, and a row never claims
  progress the data doesn't carry.
- **Prefer Nostr events:** Items and agent task status are new or reused event
  kinds. The only HTTP added is outside the relay: a usage-hub endpoint, and a
  crichton service for the terminal and host stats. Both are tailnet-only.
- **Intentional tension:** Terminal, host metrics and Files are specific to
  Sam's crichton, not community features. Each is driven by config (a URL per
  service, like today's `VITE_FILES_PANEL_URL`). The nav item doesn't render
  when the URL is unset. The web client's remit already grew past the repo
  browser with web panels, so this follows that precedent.

## 2. Decisions already made (Sam, 2026-09-29)

| Topic | Decision |
|---|---|
| Right pane | Replaces the thread pane. It's a tab strip; **Work** is always the first tab and defaults to **Everywhere**. |
| Right pane tabs (2026-09-30) | Exactly two top-level tabs, **Work** and **Canvas**. Opened files and the channel canvas are sub-tabs UNDER Canvas, never tabs beside Work. Opening a file switches the pane to Canvas; Work is unchanged. |
| Threads | Inline under the message. Kept, but de-emphasised. |
| Needs you | Decision cards, workflow approvals, @mentions and PR-merge asks, plus **Feedback** (reminders), with filter chips. Feedback is not a separate section. |
| Feedback | One button on any message sends it to Feedback, with an AI summary (today's reminders plus summaries). |
| Agent status | OK to add a task-status event. |
| `/new` | Copies members and agents only, never history. |
| `/exit` | Destroys the scratch channel. No summary back to the parent. |
| Items | A table of bugs and backlog across all projects (~100–150). Columns: type, item + AI summary, project, source channel, source (agent or person), owner, status, age. Agents may file items. Statuses: Open, In progress, Needs you, Done. |
| Claude usage | Better design plus more intelligence from existing data. One combined bar. Runway = free share across both accounts ÷ average use **per active hour** over the last **48 h**. |
| Vitals | Bottom-left of the sidebar. Claude, then a divider, then crichton CPU/GPU/Mem/Disk. Shaded box in both themes. |
| Look | Light and dark. Dark is neutral charcoal with muted accents. The agents honeycomb card is removed. |
| Nav | Inbox, Items, Shelf, Files, Terminal. |
| Files | The stash app, embedded, styled by Buzz's theme. |
| Terminal | A full page matching the canvas, resurrecting evie-ui's terminal code. |
| Toasts | Stay top-right (where they are today), restyled. |
| Messages | GitHub-style `> [!NOTE]` / `> [!WARNING]` callouts; tables on their own surface. |
| Sharing | Add `buzz share`. |
| Phone | 25% of use. Every phase ships its phone layout. |

## 3. What exists vs. what's new

| Capability | Exists today | New work | Phase |
|---|---|---|---|
| Shell with right pane | `AppShell` has sidebar + main only; right panes are inlined in `routes/repos.tsx` (1046 lines) | Right-pane slot + tab model | 0–1 |
| Palette | Tokens exist, but `ThemeProvider` derives them from Shiki themes at runtime; ~22 hardcoded hex | Fixed `buzz-light` / `buzz-dark` palettes; tokenize the hex | 0–1 |
| Needs you | Asks (`askDetection.ts`), mentions (`inboxQuery.ts`), reminders 30300 + summary bridge, workflow approvals (HTTP) | One merged list with filters | 1 |
| Running / Queued / Done | Observer frames 24200 (owner-only, turn_started/completed/liveness), 👀/💬 reactions, turn metric 44200 | Join them in the Work tab | 1 |
| Task title / progress | Job kinds 43001–43006 are defined; nothing produces them | ACP emits status; `buzz status set` | 8 |
| Slash commands | None; mention/emoji popovers exist | Registry + `/` trigger | 2 |
| ⌘K | `quickSwitcher.ts` + `SearchPanel.tsx` (substring/prefix) | Inline completion, scopes, recents | 2 |
| Scratch channels | Relay supports `ttl` on 9007/9002, sliding deadline, archive reaper; only huddles create them | `/new` `/exit` `/keep` flows, member copy | 3 |
| Files | Web panel iframe via `VITE_FILES_PANEL_URL`; stash has a theme consumer, but only allows Tauri origins; Buzz web never pushes the theme | Embed in main column + theme push | 4 |
| Claude runway | `/v1/pace` (CORS ok). `quota_sample` history every 10 min | `/v1/runway` endpoint | 4 |
| Items | NIP-34 issues 1621 (repo-bound, no type/summary/source) | New addressable kind, CLI, page | 5 |
| Shelf / previews | `buzz upload`, `imeta`, `FileCard`; CLI MIME allowlist is images/video/wav only, and no `filename` | `buzz share`, Shelf page, preview tabs | 6 |
| Terminal | evie-ui code on disk; **no process serves `/ws/term` today** (evie-ui disabled, herdr stopped) | Extracted crichton service + Buzz page | 7 |
| Host stats + GPU | Died with evie-ui; GPU readable via `ioreg` without root | Endpoint on the Phase 7 service | 7 |
| Cards used by agents | CLI `--card` works; the ACP base prompt never mentions it | Base-prompt guidance | 2 |

## 4. Rules for every phase

1. **Make room before adding.** `repos.tsx` (1046), `Composer.tsx` (1071) and
   `ChannelTimeline.tsx` (1049) are over the 1000-line ceiling and may not
   grow. Extract first. Run the ratchet with `CHECK_FILE_SIZES_BASE=main`.
2. **No control that lies.** A nav item, command or button appears only once
   its phase ships. Until then the palette and nav simply don't list it.
3. **Both themes, both sizes.** Check every screen in light and dark at 1440 px
   and 390×844 against the named artboards.
4. **Gates.** `cd web && pnpm test` (assert the test count), `pnpm build` (the
   only typecheck), `pnpm check`, and the file-size check. `just ci` lanes for
   Rust changes, plus `just test` when the relay is touched.
5. **Prove the tests.** For each new mechanism, break it, watch a named test
   fail, and restore it. Commit before mutating (AGENTS.md, "Mutation proof").
6. **Live check.** Run one real check per phase against the crichton relay
   through Agent Brave, following "Driving the real web client against the
   real relay" in AGENTS.md. Send-path work must check `result.ok` and the
   thread-root rule.
7. **Routing (CLAUDE.md).** UI work goes to the `designer` seat, backend to
   `coder`, and new kinds get an architect review first. The tester runs with
   `cwd` = the coder's worktree.

---

## Phase 0 — Make room (no visible change) · M

**Build**
- Add a right-pane slot to `web/src/shared/layout/AppShell.tsx`: sidebar |
  main | right. Width comes from the existing `useThreadPaneWidth` /
  `--thread-width`.
- Move the right-pane switching (`ThreadPanel`, `AgentActivityPanel`,
  `useDmRightPane`) out of `repos.tsx` into a `RightPane` host with a tab
  model. Its first two tabs are the existing thread and activity panels.
- Split `Composer.tsx`: move popover wiring into a `useComposerSuggestions`
  hook that owns mention and emoji today and takes a third trigger later.
- Theme: add a fixed-palette path to `ThemeProvider` (`applyThemeByName`,
  `adaptive-theme.ts`) so a theme can set tokens directly instead of deriving
  them from Shiki. Add the semantic tokens the canvas uses to `globals.css`
  and `tailwind.config.js`: `work`, `need`, `vit`, `honey-*`, `coral-*`,
  `leaf-*`, `blue-*`.
- Replace the ~22 hardcoded hex values in the 8 `.tsx` files with tokens.

**Done when:** the existing themes are unchanged (screenshot pair per theme);
`repos.tsx` and `Composer.tsx` are smaller; the test count is unchanged; and
there are no new file-size or px-text violations.

## Phase 1 — New shell, palette, Work tab v1 · L

Artboards: **Main**, **Vitals**, **Toasts**, **PhoneWork**, **PhoneChannel**.

**Build**
- **Palettes.** `buzz-light` (from the buzz-A reference) and `buzz-dark` (neutral
  charcoal, muted amber/coral) become the defaults. The Shiki themes stay
  selectable.
- **Sidebar.**
  - Workspace header, Jump, and nav: Inbox, plus Files now, since the panel
    exists today. Items, Shelf and Terminal join as their phases ship.
  - Channels and DMs as today.
  - The **Vitals** block replaces `ClaudePaceCard` at `ChannelSidebar.tsx:504`.
- **Vitals v1** (existing data only).
  - One combined Claude bar from `/v1/pace`: used = mean of `usedFraction`,
    free = 1 − used. The runway text stays hidden until Phase 4.
  - The popover shows per-account rows and the pace intelligence `/v1/pace`
    already supports:
    - pace multiplier = `usedFraction` ÷ `elapsedFraction`
    - "full around …" from `etaFullAt`
    - "resets with ~N% unused" from `projectedAtReset`
  - The crichton rows stay hidden until Phase 7.
- **Right pane.** Tab strip with **Work** first. The thread tab stays until
  Phase 2 moves threads inline.
- **Work tab v1**, following VISION_ACTIVITY's rules.
  - **Needs you**, with All / Approvals / Asks / Feedback chips:
    - asks from `askDetection.ts`
    - mentions from `inboxQuery.ts`
    - reminders from 30300, with `reminderSummary.ts` via buzz-summary-bridge
      (:6368)
    - workflow approvals from `useWorkflowRuns.ts`
  - The top item expands inline with its actions. Rows open their source
    message.
  - **Running:** `agentWorkingState` from observer frames 24200, plus 💬
    reactions. Stalled = no `turn_liveness` within the liveness budget, shown
    as "no heartbeat", never hidden.
  - **Queued:** events carrying the ACP 👀 reaction with no reply yet.
  - **Done today:** kind 44200 turn metrics, if the web client can decrypt them
    (verify first; if not, this section waits for Phase 8).
  - Everywhere / This channel toggle. Collapse state is saved per section.
- **Toasts.** Restyle `shared/ui/sonner.tsx` and keep `position="top-right"`.
  - Message and agent-done toasts dismiss themselves (6 s, with a timer line).
  - Needs-you, feedback-due and send-error toasts stay until acted on.
  - Send-error toasts show `result.message` verbatim.
- **Phone.** Bottom tab bar (Work, Channels, then Items/Shelf/More as they
  ship) using `usePhoneLayout`. Work is the phone home screen.

**Done when:**
- The views match the artboards in both themes and both sizes.
- Live: a real card p-tagged to Sam appears in Needs you and clears once
  answered.
- Live: a working agent appears in Running within 5 s of `turn_started`.
- Tests cover the merge/sort of Needs you and the stalled rule. Mutation:
  dropping the liveness check makes a named test fail.

## Phase 2 — Conversation: commands, ⌘K, readable messages, cards · L

Artboards: **Main** (thread, hover toolbar), **Message**, **Commands**,
**Jump**, **PhoneAsk**.

**Build**
- **Slash registry** in `web/src/features/commands/`.
  - Each entry: `{id, args, when(ctx), run(ctx, args)}`.
  - The `/` trigger goes through `useComposerSuggestions` and
    `ComposerSuggestionLists`.
  - A command is never sent as message text. An unknown command shows an
    inline error.
  - Ships with `/remind [when]` (reuses `quickRemind.ts`), `/handoff @seat
    <task>` (mention plus handoff marker) and `/status` (opens Work filtered to
    this channel).
- **⌘K.** Extend `quickSwitcher.ts` and `SearchPanel.tsx`:
  - inline ghost completion, with Tab to accept
  - `#` / `@` / `/` scopes
  - recents when the query is empty
  - scratch channels ranked with their parents
  - a last row "Search messages for …"
- **Readable messages.**
  - Markdown tables render in a card with a header row and right-aligned
    numbers.
  - `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION]` become callouts.
  - Multiple attachments render as a tile group.
- **Quick replies.** Only for explicit patterns ("yes or no", "Reply yes or
  no", a trailing `?` with offered options). Yes / No / Feedback buttons send
  an ordinary reply. Never guess, and never fabricate a card.
- **Ask cards.**
  - Restyle `DecisionCard.tsx` (v1/v2), with a compact answered state.
  - Phone opens it as a bottom sheet. AGENTS.md records that the inline
    stepper can't fit at 390 px.
- **Inline threads.**
  - Replace the thread tab with in-place expansion: a "N replies · last …"
    chip, then the replies and a reply box.
  - Keep `rootId = message.rootId ?? replyToId ?? id`.
- **Feedback button.** In the hover toolbar and on Work rows. One click
  creates a kind 30300 reminder with a default due of tomorrow 9:00 AM, which
  can be changed from the snooze menu.
- **Agent guidance** in `crates/buzz-acp/src/base_prompt.md`:
  - when you need a choice from a person, send `--card` with `--mention`
  - mark tested/untested work with `> [!NOTE]` / `> [!WARNING]`
  - end yes/no questions with explicit options

**Done when:**
- Live: sends against the real relay pass, including a threaded reply to a
  reply.
- Commands never reach the wire as text.
- The quick-reply detector has a fixture corpus with negative cases.
- An agent under the new base prompt sends a card unprompted in a scripted
  test channel.

## Phase 3 — Scratch channels · M

Artboards: **Commands**, **Main** (Scratch section).

**Build** (client only; the relay already supports every step)
- **`/new [name]`**
  1. Send kind 9007: private, name `<parent>-scratch-N`, with
     `["ttl","259200"]` as a 72 h *idle* safety net (the deadline slides on
     every event).
  2. Read the parent's kind 39002 and send one kind 9000 per member (people and
     agents, plain member role).
  3. Record the parent link in channel metadata.
  4. Navigate into the new channel.
- **`/exit`**
  - Leave immediately and show a 10-second Undo toast. When it expires, send
    kind 9008 (delete, owner only; the creator is the owner).
  - Only offered inside a scratch channel.
- **`/keep [name]`:** kind 9002 with `["ttl",""]`, plus a rename if a name is
  given.
- **UI.**
  - Sidebar Scratch section.
  - Header badge "SCRATCH · cloned from #parent".
  - `ephemeralChannel.ts` countdown when the idle expiry is under 1 h.

**Done when:** live on the real relay, in a private test channel:
- create, copy members, and verify via 39002
- mention an agent in the scratch channel; it answers
- `/exit`, then check the channel is gone
- `/keep` clears the TTL

## Phase 4 — Files embedded + Claude runway · M

Artboards: **Files**, **Vitals**. Two small changes outside this repo, plus
the web side.

**Build**
- **stash**
  - Add the Buzz web origin to `EMBED_ORIGINS` (`app/public/js/shell/theme.js:42-46`).
  - Send `frame-ancestors 'self' <list>` per its design §4.2. Today it sends
    none, so any origin can frame it.
  - Confirm or add a `?path=` deep link for "Open in Files".
- **Buzz web**
  - `WebFrameHost.tsx` posts `{type:"buzz:theme", v:1, mode, tokens}` on
    `files:ready` and on every theme change. `targetOrigin` = the panel
    origin. Tokens follow the §4.2 table.
  - The Files nav item renders the panel in the main column (not the overlay),
    with a collapsed Work strip on the right.
- **usage-hub** (`~/software_development/projects/usage-hub`): new
  `GET /v1/runway`, with CORS for the Buzz web origin.
  - Per account, take 48 h of `quota_sample` for the same window
    `/v1/pace` reports as `basis`.
  - Active interval = a pair of consecutive samples (10 min cadence) where
    `used_fraction` rose **and** `resets_at` didn't change.
  - Rate = Σ increases ÷ (active intervals × 10 min).
  - Runway = Σ free across accounts ÷ rate.
  - Returns `{freeFraction, ratePerActiveHour, activeHours, runwayHours,
    basis, computedAt}`. `runwayHours` is null under 3 active intervals.
- **Vitals** shows "45% free · ~2h 50m of active use". The popover shows the
  method line and "you won't run dry" when the next reset comes before the
  runway ends.

**Done when:**
- Theme switch repaints Files within 250 ms (the §4.2 acceptance test).
- A hostile theme payload is rejected (stash's existing test).
- Runway unit tests cover a fixture with a reset crossing. Mutation: removing
  the `resets_at` guard makes a named test fail.
- Live `curl` returns the new fields.

## Phase 5 — Items · L

Artboards: **Items**, **Commands** (`/bug`, `/backlog`).

**Build**
- **New addressable kind** (recommended). The architect picks the number from
  the free range in `kind.rs`, near 30621.
  - `d` = item id.
  - Tags: `type` (bug|backlog), `status` (open|progress|needs-you|done),
    `title`, `summary`, `a` → project 30621, `e` → source message, a
    source-channel reference, `p` owner, `p` reporter.
  - Addressable, so ~150 items come back from one query without folding
    separate status events.
  - Wire it the way commit `71265ca36` did for 44200: `ALL_KINDS`,
    `required_scope_for_kind` (`ingest.rs:438`), routing, and read gating in
    `req.rs`. The architect decides whether visibility follows the source
    channel's membership.
- **SDK + CLI.** `buzz items add|list|update|assign|done` (`--type`,
  `--project`, `--from-event`, `--summary`), JSON output, with builders in
  `buzz-sdk`.
- **Web.** Items page per the canvas:
  - tabs, filters, table, inline expand, bulk bar
  - `/bug` and `/backlog` commands; each posts a confirmation row linking the
    item
  - "Hand to an agent" posts a handoff mention in the source channel
  - "Open a scratch channel for it" (from Phase 3)
- **AI summary.** Supplied by the filing agent, or else from
  buzz-summary-bridge on the source message.
- **Agent guidance** (base prompt): file bugs and backlog with `buzz items add`.
- NIP-34 repo issues stay as they are. Showing them in Items is out of scope.

**Done when:**
- Relay ingest and scope tests pass for the new kind.
- CLI round trip (add → list → update).
- Live: `/bug` from the web and `buzz items add` from an agent both appear.
- A 150-item fixture filters in under 100 ms.

## Phase 6 — Shelf and sharing · L

Artboards: **Shelf**, **Preview**, **Message** (file tiles).

**Build**
- **CLI `buzz share <path> [--channel] [--summary]`**
  - Use the relay's generic-file upload path instead of the image/video/wav
    allowlist (`client.rs:77`). The relay stays the validator.
  - Add `filename` to `imeta` (`build_imeta_tag`, `client.rs:47`).
  - Publish kind 9 with a `["shelf"]` marker.
  - When sharing from crichton's disk, add `["path","crichton:<abs path>"]` so
    "Open in Files" can jump there.
- **Web**
  - **Shelf page.** Query share messages across channels; filter by type,
    sender and channel; newest first, grouped by day.
  - **File tabs.** Opening a file from chat or the Shelf adds a tab beside Work
    in the right pane, with expand-to-full.
  - **Previewers:** markdown, image, code (Shiki), PDF (native), and HTML in a
    sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`).
    Preview and Source only; a "Changes" view waits until versions exist.
  - **Comments** on a file are thread replies to its share message, shown
    under the preview.
- **Agent guidance:** share deliverables with `buzz share`, don't paste paths.

**Done when:**
- An agent shares `.md`, `.html` and `.png` files; each gets a Shelf row, a
  tile, and a preview beside the chat.
- A test proves the HTML preview can't read the parent's storage or cookies.
- Live check passes.

## Phase 7 — Terminal + host stats · L

Artboards: **Terminal**, **PhoneTerminal**, **Vitals** (crichton rows).

**Build**
- **New crichton service**, extracted from evie-ui the way stash was. Sam
  names it (the `sam-naming` skill) and it gets its own port-registry block.
  - Copy `app/term/{pty,session,herdr,reaper}.ts` and `app/web/term-hub.ts`
    as-is: Bun with node-pty 1.1.0's native binding, the same frame protocol
    and close codes.
  - `/ws/term`: unchanged protocol.
  - `/api/herdr`: spaces, tabs and agents from herdr's socket API.
  - `/api/host-stats`: port evie's `host-stats.ts` (`os.cpus`,
    `vm_stat`+`sysctl`, `df` for every disk), plus GPU from
    `ioreg -r -d 1 -c IOAccelerator` ("Device Utilization %").
  - Operations: launchd `com.dev.*` / `com.prod.*`, `tailscale serve`, and
    `deploy-dev.sh` / `deploy-prod.sh` on the shared `dc::` library.
  - Auth: reuse stash's auth module (no custom auth), plus an env kill switch
    like `EVIE_UI_TERMINAL_ENABLED`.
- **Web**
  - Terminal page with native chrome per the canvas (spaces, agents, tabs
    from `/api/herdr`).
  - The emulator ports `term-xterm.js` as an ES module mounted by a thin React
    component: vendored xterm 5.5 + fit/clipboard/webgl, never mixed with 6.x
    addons.
  - Phone key bar from `term-pad.js`.
  - Reset = soft reset (close code 4002), which never kills the session.
  - The Vitals crichton rows poll `/api/host-stats` every 10 s.
- **Note:** herdr's `default` session is the same shell as Sam's command-line
  herdr (ADR-022). Typing in both lands in one shell, by design.

**Done when:**
- Live on desktop and phone: open, run a command, reset view, and the session
  survives.
- Kill switch off shows a disabled state.
- A security review is required before prod (shell access over the tailnet).
- Host stats agree with `top` and `ioreg` within tolerance.

## Phase 8 — Work tab v2: titles, progress, approvals · M

Artboards: **Main** (Running rows with progress), **PhoneWork**.

**Build**
- **ACP status.** Publishes task status at its turn guards (`pool.rs:2468-2494`)
  with no agent cooperation. Recommended: reuse job kinds 43001/43003/43004,
  `h`-scoped so channel members can read it.
- **`buzz status set --title … --progress 2/3`** for optional detail. Work
  rows show title and progress segments.
- **PR-merge approval** is a convention, not a new kind: a decision card that
  references the PR event (1618), listed as APPROVAL.
- **Workflow approvals** already list in Work. Real gating depends on
  workflow-engine item WF-08 (VISION.md: the executor doesn't yet persist or
  resume approvals).

**Done when:** a scripted agent turn shows Running → Done with its title, with
no agent-side code. `buzz status set` progress appears within 2 s.

---

## Order and parallelism

- **Phases 0 → 1 → 2 → 3** are client-only on today's relay and ship value
  first. Phase 2's base-prompt change is the one backend touch.
- After Phase 1, **4, 5, 7 and 8** touch different subsystems (stash +
  usage-hub; relay + CLI kind; new service; ACP) and can run in parallel
  worktrees. **Phase 6** follows 5, since both change `buzz-cli` commands.

## Assumed defaults (say if any is wrong)

1. Items use a **new addressable kind**, not extended NIP-34 issues.
2. `/exit` deletes (kind 9008) after a **10-second undo**; there is no archive
   copy.
3. The Feedback button's default due time is **tomorrow 9:00 AM**.
4. Scratch channels expire after **72 h idle** unless `/keep` is used.
5. The terminal and host stats share **one new crichton service**.

## Risks

- **Theme path.** Every screen depends on the fixed-palette change in Phase 0.
  Verify existing themes by screenshot before moving on.
- **Visibility of Running.** Observer frames are owner-only. Running shows
  Sam's agents only, which is everyone today. Phase 8 makes status readable
  by channel members.
- **Summary bridge dependency.** Feedback and Items summaries depend on
  buzz-summary-bridge (:6368). If it's down, fall back to a truncated preview
  (already implemented).
- **Terminal security.** A web shell on the tailnet: kill switch, auth, and a
  security review are mandatory.

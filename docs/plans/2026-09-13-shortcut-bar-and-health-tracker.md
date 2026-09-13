# Design — Per-channel shortcut bar (web) + "kept" daily health tracker + MCP

Owner request (Sam, 2026-09-13). Everything below is pinned at buzz `952f6a790`
(worktree `buzz-shortcut-bar`, branch `claude/shortcut-bar-tracker`). Line
references are to that SHA.

**Mandatory handoff rule for the coder prompt.** The orchestrator's prompt to
the coder MUST embed the full contents of the infrastructure rules file
(`/Users/sgallant/claude-glm/projects/-Users-sgallant--buzz/d0e3948b-8936-4dd5-82c7-6dd6b028ac75/tool-results/hook-19c57d96-063a-479a-ac0c-3b22309143a5-stdout.txt`)
verbatim, per its own "Sub-agent injection rule". This doc does not duplicate
it; it only cites the rules it depends on (hosts, port registry, tailscale-only
access, deploy discipline, Agent Brave).

**Product-contract check (AGENTS.md §Product Contract).** VISION.md says
"Prefer Nostr events over new HTTP endpoints" — Feature 1 reuses kind 30078
(NIP-78 app data) with **zero relay changes**, which is exactly that guidance.
VISION.md's encryption section positions NIP-44 E2EE as "a future consideration
for DMs"; encrypting a personal-preference blob to self does not contradict it
— it is the established desktop pattern (`desktop/src/features/channels/readState/readStateManager.ts`,
seven 30078 features, `desktop/src/shared/constants/kinds.ts:44-53`). The web
client's remit has already grown past "repo browser" (webPanels/Files dock);
this design follows that precedent. Intentional tension to name: the shortcut
bar is per-user chrome, not collaboration state — it lives in user-scoped
global events, never in channel events, so it adds nothing to other members'
views. Feature 2 is entirely outside the buzz repo (separate app + MCP on the
pilot relay), consistent with the fleet's ummm/thunk pattern; its only Buzz
touchpoint is being *embeddable* in the dock (trust model below).

---

## FEATURE 1 — Per-channel/DM shortcut bar (web client, relay-backed)

### Verdict: reuse kind 30078. No new kind. No relay changes.

- `crates/buzz-core/src/kind.rs:75` — `KIND_READ_STATE: u32 = 30078` (NIP-78).
- `crates/buzz-relay/src/handlers/ingest.rs:441` — 30078 requires only
  `Scope::UsersWrite`; `:633` area (`is_global_only_kind`) lists it global-only
  (no `h` tag — a stray `h` must NOT be added).
- Parameterized-replaceable per `(pubkey, kind, d)` — the relay keeps only the
  newest event per coordinate. A new kind would require Rust changes, a relay
  rebuild and a relay redeploy for a feature that is pure client data. Rejected.
- **Measured relay byte cap:** `MAX_EVENT_CONTENT_BYTES = 256 * 1024`
  (262,144 bytes) at `ingest.rs:2239`, applies to event `content` for all
  kinds. (The 61,440-byte cap at `ingest.rs:1280` is diff events only — kind
  40008 — do not confuse the two.) Our client-side budget (below) is far under
  it. NIP-44 v2 ciphertext expands plaintext ~1.5x; 16 KB plaintext ≈ 25 KB
  ciphertext ≈ 10% of the cap, with the expansion headroom to spare.

### Pinned data format

One blob per user, one event per user — **never per-channel `d` tags** (any
member can query another user's 30078 `d` tags in plaintext; per-channel tags
would leak which channels Sam uses; one opaque `d` leaks nothing).

- kind: `30078`
- tags: `[["d","shortcut-bar"],["t","shortcut-bar"]]` (mirrors desktop's
  `d="read-state:<slot>"` + `t="read-state"` shape)
- content: NIP-44-v2-encrypted-to-self JSON (web helper:
  `web/src/shared/lib/nostr-signer.ts:129-141` `nip44EncryptTo` /
  `nip44DecryptFrom` — these require the **unlocked local key**; NIP-07-only
  sessions throw; see edge case E5)

Plaintext blob:

```json
{
  "v": 1,
  "shortcuts": {
    "<channelId>": [
      { "id": "sc:1", "label": "kept", "url": "https://…", "mode": "overlay" }
    ]
  }
}
```

- `<channelId>` is the channel UUID — **the same `channel.id` for channels AND
  DMs.** DMs are channels with a server-minted UUID (`command_executor.rs:297`
  `handle_dm_open` → `state.db.open_dm` → `channel.id: Uuid`; web
  `channelFromEvent.ts` reads it from the 39000 `d` tag). Override of the
  suggested `dm:<pubkey>` key: unnecessary (UUIDs already unique) and wrong for
  group DMs (2–9 participants have no single pubkey). Component derives the
  key as `channel.id` — nothing else.
- `mode`: `"window" | "overlay"`.
- Shortcut `id`: `"sc:<n>"`, `n` = max existing + 1 across the whole blob
  (allocate like `nextCustomPanelId`, `panelRegistry.ts:194`).
- **Caps (enforced at add/edit time, in `lib/shortcutBlob.ts`):**
  - `MAX_SHORTCUTS_PER_CHANNEL = 12` (matches `MAX_CUSTOM_PANELS` convention)
  - label ≤ 32 chars after trim; URL ≤ 512 chars
  - blob plaintext serialized ≤ `SHORTCUT_BLOB_BUDGET_BYTES = 16_384` — reject
    the add with a toast naming the budget, never publish an over-budget blob
  - a channel whose list becomes empty has its key REMOVED from the blob
    (prune-on-write keeps the blob small and keeps dead channels from leaking)
- **LWW:** publish with `created_at = max(now, maxFetchedCreatedAt + 1)`
  (desktop `readStateManager.ts:690-743` pattern); track `maxFetchedCreatedAt`
  from every event seen (stored + live). Fold live/stored events newest-wins
  (`reduceStatusEvents` pattern, `statusEvent.ts:154`).

### Pinned UI

Placement: right cluster of `ChannelHeader.tsx:177`
(`ml-auto flex shrink-0 items-center gap-1.5`), as its FIRST child — i.e.
after the name/description, before Join/Members/Huddle — satisfying "between
the channel name and the huddle button".

- `ChannelHeader` gets one new optional prop: `actions?: React.ReactNode`,
  rendered as the first element of the right cluster. The shortcut feature
  stays self-contained in its own folder; the header does not import it.
  Order stays: actions → Join → Members → Huddle → 🧠.
- Buttons: **labeled pills** (Sam wants them "visually in front of me"), style
  family of the existing Join pill (`text-2xs`, `rounded-full border`), label
  truncated at `max-w-24`, `title` tooltip = `"<url> — opens in <mode>"`.
  `data-testid="shortcut-<id>"`.
- `+` icon button at the end (`data-testid="shortcut-bar-add"`) opens the
  add dialog.
- **Add/Edit dialog** (`ShortcutDialog.tsx`): clone of
  `webPanels/ui/AddSiteDialog.tsx` (Radix Dialog, same error-row pattern,
  `data-testid="shortcut-dialog"`, fields `shortcut-url` / `shortcut-label`,
  plus mode picker). No `@radix-ui/react-radio-group` in web deps — use two
  styled radio `<input>`s or a Radix `DropdownMenu`; pick native radios
  wrapped in labels, simplest and accessible. Keep AddSiteDialog's trust
  warning sentence (iframe-in-this-origin) adapted.
- **Edit/Remove affordance:** Radix `ContextMenu` on each shortcut pill
  (`@radix-ui/react-context-menu` is already a web dep) with items
  "Edit…" and "Remove". Matches repo convention (channel context menus).
- URL validation: **reuse `normalizePanelUrl`** from
  `webPanels/lib/panelRegistry.ts` (cross-feature import is established —
  `webPanels/hooks.ts` imports `filesConfig`). Same trust model: Sam's own
  config, but `javascript:`/`data:`/`blob:` stay rejected. Re-validate on
  blob read like `sanitizeCustom` does.
- **Window mode:** plain `<a href={url} target="_blank" rel="noreferrer noopener">`
  styled as the pill.
- **Overlay mode:** click sets overlay state at the shell (below); the dock's
  `focusOrOpen` semantics apply (repeat click focuses the existing tab).
- Hidden entirely when: `channel.ttlSeconds !== null` (ephemeral — same
  reasoning as the huddle's, `ChannelHeader.tsx:202-206`), or signer is not
  the local key (E5).

### Overlay = the Files dock layout, middle pane

`repos.tsx` today: `filesOpen ? <FilesPanel onClose/> : view panes… : current ?
<channel column>` (`repos.tsx:657-658`, FilesPanel at `:380` area wraps
`WebPanelDock`). The shortcut overlay is the SAME shape: a middle-pane dock
host, not a dialog.

- New state at the shell: `const [shortcutOverlay, setShortcutOverlay] =
  useState<string | null>(null)` — the clicked panel id, or `null`. It is
  cleared by `selectChannel` (overlay never survives a channel switch).
- Render order: `filesOpen ? FilesPanel : shortcutOverlay !== null && current ?
  <ShortcutOverlay channelId={current.id} initialPanelId={shortcutOverlay}
  onClose={() => setShortcutOverlay(null)} /> : … existing branches`.
- `ShortcutOverlay` renders `WebPanelDock` with a shortcut-scoped dock whose
  panel registry = the overlay-mode shortcuts of THAT channel; the clicked
  panel is opened (or focused) on mount. Header of the dock (tabs row) is
  WebPanelDock's own — identical layout to Files, per Sam: "the layout after
  the Files app opens is fine."
- Back affordance: the dock's existing X / Escape (`onClose` returns to the
  conversation). No extra chrome.

### Generalizing the dock store WITHOUT changing Files

Current: `webPanels/hooks.ts` holds one module-scope store (customs + session)
and `WebPanelDock.tsx:34` calls `useWebPanelDock()` directly.

- Extract `webPanels/lib/dockStore.ts`: `createDockStore({ storageKey })`
  returning `{ subscribe, getSnapshot, getPanels, setPanels, open, focusOrOpen,
  close, activate, setScope(scope), resetForTests }`. `setPanels` prunes
  unknown panel ids (`pruneUnknownPanels`). Sessions persist per **scope**
  (a map `{version:1, byScope:{[scope]: PersistedSession}}` under
  `storageKey`).
- `useWebPanelDock()` becomes a thin wrapper: a files store with
  `storageKey = "buzz:web-panel-session.v1"` (KEY UNCHANGED), scope
  `"files"`, registry from `allPanels(filesUrl, customs)`, plus the existing
  `addSite`/`removeSite`. Its public interface and both localStorage keys
  (`buzz:web-panels.v1`, `buzz:web-panel-session.v1`) must remain byte-
  compatible — the existing unit tests (`panelSession.test.mjs`) and the
  parity e2e must pass UNMODIFIED.
- New consumer: `features/shortcut-bar/hooks.ts` → `useShortcutDock(channelId)`:
  `createDockStore({ storageKey: "buzz:shortcut-overlay-sessions.v1" })`,
  scope = `channelId`, registry = overlay-mode shortcuts as `WebPanelDef`
  (`{id, label, url, custom: true}`). Per-channel scope = each channel's
  overlay restores its own tab set across opens (iframes still die on close —
  only the tab LIST persists, same as Files across reloads).
- `WebPanelDock.tsx`: `export function WebPanelDock({ onClose, dock }: {
  onClose: () => void; dock?: WebPanelDockApi })`; body uses
  `dock ?? useWebPanelDock()` (default keeps every existing caller/test
  working). `PanelOpener` renders the per-panel remove button only when
  `dock.removeSite` is defined, and the `+`/AddSite only when `dock.addSite`
  is defined — the shortcut dock shows neither (panels come from the bar).
  Type: split `WebPanelDockApi` (core) from the Files extension
  (`addSite`/`removeSite` optional).

### Feature-1 file plan

NEW (`web/src/features/shortcut-bar/`):

| File | Contents |
|---|---|
| `lib/shortcutBlob.ts` | Pure: `ShortcutDef` ({id,label,url,mode}), `ShortcutBarBlob`, `serializeShortcutBlob`/`parseShortcutBlob` (validates every entry with `normalizePanelUrl`, drops bad ones), caps + `SHORTCUT_BLOB_BUDGET_BYTES`, `nextShortcutId`, `addShortcut(blob, channelId, input)` / `updateShortcut` / `removeShortcut` (all returning `{ok}\|{ok:false,reason}`), empty-channel pruning. Import-free except `panelRegistry.ts`. |
| `lib/shortcutEvent.ts` | Pure: `KIND_SHORTCUT_BAR = 30078`, `SHORTCUT_BAR_D_TAG = "shortcut-bar"`, `buildShortcutEventTags()`, `nextShortcutCreatedAt(maxFetched, now)` (LWW), `reduceShortcutEvents` newest-wins fold over `{created_at}` shells. |
| `lib/shortcutBlob.test.mjs`, `lib/shortcutEvent.test.mjs` | node:test units (pattern: `webPanels/lib/*.test.mjs`). |
| `hooks.ts` | `useShortcutBar(channelId)`: self-subscribe `{kinds:[30078], authors:[self], "#d":["shortcut-bar"], limit:1}` (machinery: `relay-session.ts:730-757`; self pubkey via `useOwnPubkey`); decrypt with `nip44DecryptFrom`; module-scope optimistic overlay + rollback (pattern: `user-status/hooks.ts:180-208`); `mutateShortcuts(fn)` = read→transform→budget-check→encrypt→sign(`created_at` LWW)→optimistic→publish→rollback-on-fail. Also exposes `canUse` (E5) and `blocked` (E6). |
| `ui/ShortcutBar.tsx` | The header section: pills + `+` + ContextMenu + dialog mount. Props: `{ channelId }` — self-wiring, so `repos.tsx` stays thin. |
| `ui/ShortcutDialog.tsx` | Add/Edit dialog (AddSiteDialog clone + mode radios + edit prefill). |
| `ui/ShortcutOverlay.tsx` | Middle-pane host: `useShortcutDock(channelId)`, open-or-focus `initialPanelId`, render `<WebPanelDock dock={...} onClose/>`. |

TOUCHED:

| File | Change |
|---|---|
| `web/src/features/channels/ui/ChannelHeader.tsx` | Add `actions?: React.ReactNode` prop; render as first child of the right cluster. (~6 lines.) |
| `web/src/app/routes/repos.tsx` | `shortcutOverlay` state (+ clear in `selectChannel`), render `<ShortcutBar channelId={current.id} onOpenOverlay={setShortcutOverlay}/>` in `ChannelHeader actions`, add the overlay branch to the main-pane conditional. **Budget: ≤ 40 added lines — the file is at 942/1000 (`just file-size-check` gate). If it doesn't fit, move the pane-swap conditional into a small `features/shortcut-bar/ui/MainPaneSwitch.tsx`-style helper rather than bumping anything.** |
| `web/src/features/webPanels/hooks.ts` | Refactor onto `createDockStore` (public API + storage keys unchanged). |
| `web/src/features/webPanels/lib/dockStore.ts` (new) | The store factory above. |
| `web/src/features/webPanels/ui/WebPanelDock.tsx` | Optional `dock` prop; conditional add/remove affordances. |
| `web/tests/e2e/shortcut-bar.spec.ts` (new) | See test plan. |

### Feature-1 edge cases (each needs a test or an explicit QA check)

- **E1 LWW conflicts:** whole-blob replacement, newest `created_at` wins.
  Monotonic `created_at = max(now, maxFetched+1)`. Two devices editing between
  syncs: second publish wins, first device's edits are silently dropped —
  acceptable for a single-user config surface; documented here, not "solved".
- **E2 Cap enforcement:** add/edit rejected at 12/channel, label>32, url>512,
  or over-budget blob — user-facing reason string, no publish attempted.
- **E3 Byte budget:** 16,384-byte plaintext budget vs the measured 262,144-byte
  relay content cap (`ingest.rs:2239`). Stated in the toast on breach.
- **E4 Empty channels pruned** on write; a blob with zero shortcuts is still
  published (it is the delete-all), `{v:1, shortcuts:{}}`.
- **E5 Anonymous / NIP-07-only sessions:** NIP-44-to-self needs the unlocked
  local key; `nip44DecryptFrom` throws otherwise. Pin: the bar renders only
  when `activeSignerSource() === "local"`; otherwise it is hidden entirely
  (no read-only mode — the content is opaque ciphertext anyway). Sam always
  signs in with the enrolled local key.
- **E6 Undecryptable / future-version blob:** if an event exists but decrypt
  fails or `v` is unknown-higher, show the empty bar but REFUSE writes
  (tooltip/toast "Shortcut data unreadable on this device") so we never
  clobber an unreadable newer blob.
- **E7 Overlay lifecycle:** channel switch closes the overlay; Escape/X
  returns to the conversation; per-channel tab session persists in
  `localStorage` (`buzz:shortcut-overlay-sessions.v1`).
- **E8 Embed refusal:** the dock's 8s stall banner (`WebPanelDock.tsx:15`)
  is the detector; "Open in a real tab" is the escape hatch. See QA-Q4.

### Feature-1 test plan

Unit (`pnpm test` in `web/`, node:test):

- `shortcutBlob`: parse/serialize roundtrip; invalid URL entries dropped on
  read; per-channel cap; label/URL length caps; budget rejection at exactly
  16,384; empty-channel pruning; id allocation skips gaps. **Mutation-proof:**
  hardcode expected JSON strings, not derived ones; include one over-budget
  and one `javascript:` case that MUST fail.
- `shortcutEvent`: newest-wins fold with out-of-order arrival; `created_at`
  monotonicity vs `maxFetched`.

E2E (`web/tests/e2e/shortcut-bar.spec.ts`, mockRelay — pattern
`forum.spec.ts`): seed a 39000 channel + a 30078 whose content the spec
encrypts in Node (`nostr-tools/nip44`, self key the spec generated):

1. signIn at `/repos?c=<id>` → seeded shortcut pill visible (decrypt path).
2. `+` → dialog → `javascript://evil.example/…` rejected with the http(s)
   error (same string as AddSiteDialog).
3. Add overlay-mode shortcut → pill appears (optimistic); `relay.published`
   contains kind 30078 with `d=shortcut-bar`; **the spec decrypts the
   published content with the same secret key and asserts the exact JSON**.
4. Click overlay pill → `web-panel-dock` visible with that tab; X returns to
   the composer.
5. Window-mode pill asserts an `a[target=_blank][rel~="noopener"]`.
6. Reload with the published event re-seeded → pill persists (relay-copy
   path, no optimism).
7. `pageErrors` empty at the end (dock precedent).

Rust e2e: **none required** — zero relay changes; the 30078 path is already
exercised by desktop usage. (Template exists at
`crates/buzz-test-client/tests/e2e_user_status.rs` if ever needed.)

QA session MUST verify live (Agent Brave, real web client, Sam's enrolled
session — claim a new tab, close it on every exit path):

- Q1 Real relay round-trip: add a shortcut to a real channel; hard-reload;
  it persists; open the client in a second tab (same session) and see it
  without re-adding (live REQ fan-out).
- Q2 Edit + Remove via context menu publish correctly (reload → gone).
- Q3 Overlay layout matches Files (tabs row, stall banner absent for kept).
- Q4 kept embeds (Feature 2 URL) without the stall banner. If it stalls,
  headers on the tailscale-serve path are blocking framing — file it, do not
  silently accept.
- Q5 **Cleanup REQUIRED:** remove all QA shortcuts via the UI so the live
  blob ends in the desired real state (optionally exactly one: `kept` →
  overlay). The relay keeps only the newest 30078 per coordinate — cleanup is
  a normal publish, nothing to delete server-side.

### Feature-1 acceptance checklist

1. `cd web && pnpm test` green, including new blob/event suites with at least
   one test each that FAILS when the URL allowlist or the budget check is
   removed (run that mutation once, show the failure, revert).
2. Existing `webPanels` unit tests and `parity-surfaces.spec.ts` dock spec
   pass UNMODIFIED (Files unchanged).
3. `pnpm test:e2e` green including `shortcut-bar.spec.ts` steps 1–7.
4. `just check` (web lanes: biome, file-size, pubkey-truncation, px-text)
   passes; `repos.tsx` stays ≤ 1000 lines.
5. Live QA Q1–Q5 above, with Q5 cleanup evidenced (final blob state screenshotted
   or read back).
6. No relay crate is touched: `git diff --stat 952f6a790 -- crates/` is empty.

---

## FEATURE 2 — "kept" daily health task tracker + MCP server

Provisional name (`kept`), rename-cheap: it appears in the repo dir, one
launchd label, one port-block note, one relay category, one MCP id. Renaming =
search-replace across those five places.

### Repo + conventions (clone ummm, measured 2026-09-13)

- New repo `/Users/sgallant/software_development/projects/kept` — `git init`,
  `AGENTS.md`, `README.md`. bun + Next.js 15 + React 19 + better-sqlite3 (WAL,
  `data/kept.db` gitignored), phone-first, no auth, tailnet-only. Clone ummm's
  `src/lib/db.ts` singleton+CREATE TABLE pattern, `layout.tsx`+`globals.css`
  styling approach and `manifest.webmanifest` (PWA) — ummm carries no tailwind;
  keep it dependency-light the same way.
- **Ports: ALREADY RESERVED — do not edit the registry again.**
  `port-registry.json` `project_port_blocks.kept` = 6660-6709, primary 6660,
  dev_ui 6661, status PLANNED (verified present today). scripts:
  `"dev": "next dev -H 127.0.0.1 -p 6661"`, `"start": "next start -H 127.0.0.1 -p 6660"`
  (bind 127.0.0.1 — tailscale serve is the only front door; ummm's 0.0.0.0 is
  NOT copied).
- Front door: `tailscale serve --bg --https=6660 http://127.0.0.1:6660` →
  `https://crichton.tailb3d4b8.ts.net:6660`. That URL is Sam's shortcut-bar
  entry and the MCP base URL. (`--https=6661` additionally for ad-hoc dev UI.)

### Schema + time (pinned)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  emoji TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS completions (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  day TEXT NOT NULL,              -- 'YYYY-MM-DD' in America/Chicago at write time
  ts TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC instant
  UNIQUE(task_id, day)
);
```

- **"Today" is computed server-side only**, as the current calendar date in
  `America/Chicago` via `Intl.DateTimeFormat('en-CA', {timeZone:'America/Chicago'})`
  → `YYYY-MM-DD`. Every write derives `day` this way; `GET /api/state` returns
  `today` so UI and MCP never guess. DST caveat (state it in AGENTS.md): the
  day boundary is local-midnight Chicago; a 00:30 confirm counts for the NEW
  day; spring-forward days are 23h, fall-back 25h — day STRINGS are what
  streaks count, so both are correct by construction.
- Idempotency: confirm = `INSERT INTO completions(task_id, day) VALUES(?,?)
  ON CONFLICT(task_id, day) DO NOTHING`; unconfirm = single-row
  `DELETE … WHERE task_id=? AND day=?`. **Inherited ummm lesson (AGENTS.md
  2026-09-13): never bulk-clean a live DB while a human is using it; every
  mutation is single-row and idempotent per (task_id, day).**
- Seed: ZERO tasks. Tasks arrive via UI or MCP (help-team agents will add
  them). No destructive task deletion anywhere — `deactivate` only.

### UI (single screen, `src/app/page.tsx`)

Client component over `GET /api/state`: today's active tasks as big tap cards
(emoji + label + "Did you … today?" phrasing), tap = confirm (optimistic,
then POST), tap a confirmed card = unconfirm (mistake tolerance). Per task:
month grid strip (filled/unfilled days, current day outlined) + current
streak number. Year view = secondary toggle (12 mini-months of dots).
Inline add-task form (label + optional emoji). Everything phone-first.

### API (clone ummm's route shapes)

- `GET /api/state` → `{ today, tasks:[{id,label,emoji,active,sort_order,
  doneToday, streak, month:[{day,done}] }], now }` (active tasks only in the
  main list; inactive listed separately for management).
- `POST /api/mutate` — single action-switch endpoint, actions:
  `confirm {taskId}` (day optional, defaults to today; allowed for backfill),
  `unconfirm {taskId, day?}`, `task_add {label, emoji?, sortOrder?}`,
  `task_update {taskId, label?, emoji?, sortOrder?}`,
  `task_deactivate {taskId}`. All single-row.

### MCP server (clone thunk/mcp — measured)

- `mcp/index.js`: node + `@modelcontextprotocol/sdk` + `zod`, stdio, thin HTTP
  client over the app API. No auth layer (tailnet-gated single user — same
  posture as ummm; state the trust boundary in AGENTS.md). Env:
  `KEPT_SERVICE=https://crichton.tailb3d4b8.ts.net:6660` (LE-backed tailscale
  cert; plain `fetch`, no TLS flags). Pin thunk's dependency versions so
  pilot's `/usr/bin/node` stays compatible.
- Tools (names + zod shapes pinned):

| Tool | Input | Output |
|---|---|---|
| `list_tasks` | `{ activeOnly?: boolean }` | tasks with labels, streaks, doneToday |
| `get_today` | `{}` | `{ today, tasks:[{label, done}] }` |
| `get_adherence` | `{ taskId: number, period: z.enum(["month","year"]), anchor?: string }` (anchor `YYYY-MM`/`YYYY`, default current) | `{ task, days:[{day,done}], doneCount, streak }` |
| `add_task` | `{ label: string, emoji?: string }` | created task |
| `update_task` | `{ taskId: number, label?: string, emoji?: string, sortOrder?: number }` | updated task |
| `deactivate_task` | `{ taskId: number }` | ok |

No delete tool. Adherence answers "did he do it today / every day this month /
every day this year" directly from `days`.

- `mcp/register.py` (clone thunk's): backs up
  `/home/sgallant/software_development/infra/mcp-relay/config/{servers,hierarchy}.json`
  with `.bak.<stamp>-kept-add`, appends the server entry
  (`transport: stdio`, `command: /usr/bin/node`,
  `args: ["/home/sgallant/mcp-servers/kept/index.js"]`, `lazyStart: true`),
  and a `misc > kept` category with one tool record per tool; then
  `sudo systemctl restart mcp-relay.service` on pilot.

### Feature-2 file plan (all NEW, in the kept repo)

`package.json` · `src/lib/db.ts` (schema above + streak/month helpers) ·
`src/lib/day.ts` (Chicago today; pure, unit-tested) · `src/lib/day.test.ts`
+ `src/lib/streak.test.ts` (bun test; DST-adjacent date-string cases) ·
`src/app/layout.tsx` + `globals.css` + `manifest.webmanifest` ·
`src/app/page.tsx` · `src/app/api/state/route.ts` ·
`src/app/api/mutate/route.ts` · `AGENTS.md` (schema, live-DB lesson, tz rule,
deploy + MCP runbook) · `README.md` · `deploy/launchd/com.dev.kept.plist` ·
`deploy-dev.sh` · `mcp/index.js` · `mcp/register.py` · `.gitignore`
(`data/`, `node_modules/`, `.next/`, `logs/`).

`deploy-dev.sh` copies the `buzz-services/deploy-dev.sh` discipline: host
guard (crichton only) → `bun test` gate → install plist into
`~/Library/LaunchAgents` → `launchctl bootout` → **wait for the label to
disappear (poll ≤10s)** → `bootstrap` (one retry) → poll `launchctl list`
30s → health check `curl -fsS http://127.0.0.1:6660/api/state`. Logs under
the project's `logs/`. Never hand-roll restarts outside this script.

### Feature-2 edge cases

- Undo: second tap unconfirms — only TODAY's row (never bulk).
- Backfill/late confirm: `confirm {taskId, day}` allowed via MCP only; UI
  only ever writes today (prevents fat-finger history edits).
- tz boundary: pinned above; UI re-renders on focus/visibility so a tab left
  open across local midnight rolls to the new day.
- Concurrent write safety: single-row upserts + WAL; no read-modify-write of
  aggregates — streaks computed on read.

### Feature-2 test plan

- `bun test`: day-string math (fixed instants around Chicago midnight and
  both DST transitions), streak calc, month-grid builder.
- Smoke: `curl -fsS http://127.0.0.1:6660/api/state` returns `today` =
  Chicago date.
- QA live (Agent Brave, tab hygiene as above): phone-width viewport — add
  task, confirm, reload (still confirmed), tap-again undo; year view; then
  via the relay on pilot: `list_tasks`, `get_today`, `get_adherence`
  month; `add_task` appears in UI after refresh. Cleanup: deactivate QA-only
  tasks, unconfirm QA confirms (single-row only).

### Feature-2 acceptance checklist

1. `bun test` green incl. DST day-string cases; one test shown to fail when
   the tz is changed to UTC (mutation evidence).
2. `deploy-dev.sh` end-to-end: label `com.dev.kept` loaded, health check 200.
3. `https://crichton.tailb3d4b8.ts.net:6660` reachable on the tailnet, PWA
   installable on phone-width.
4. Relay shows the 6 tools under `misc/kept`; `get_today` answers with
   Chicago's date; `get_adherence` returns per-day flags for a month with at
   least one seeded confirm+unconfirm cycle.
5. Schema matches this doc exactly (`sqlite3 data/kept.db .schema`).
6. `git -C …/port-registry` diff empty (registry untouched by this work).

---

## Rollout / deploy (dependency order) — orchestrator executes

Feature 2 first (the shortcut needs a live URL to point at):

1. **kept app**: build on crichton (`bun install && bun run build`), run
   `./deploy-dev.sh`, add `tailscale serve --bg --https=6660 http://127.0.0.1:6660`.
   Rollback: `launchctl bootout gui/$(id -u)/com.dev.kept`; remove the serve
   mapping (`tailscale serve status` to list, then current CLI's remove form);
   data dir untouched.
2. **MCP registration**: rsync `mcp/` → `pilot:/home/sgallant/mcp-servers/kept/`,
   run `python3 mcp/register.py` ON pilot, restart `mcp-relay.service`,
   verify the 6 tools appear. Rollback: restore both `.bak.<stamp>-kept-add`
   files, restart the relay service.
3. **Web bundle** (buzz repo): merge `claude/shortcut-bar-tracker` → main;
   from the MERGED SHA: `cd web && pnpm build`, then
   `rsync -a --delete web/dist/ /Users/sgallant/.evie/buzz/web-dist/`
   (relay ServeDir reads per-request — no relay restart). **Ride-along audit
   first:** `git log --since="<last web deploy>" -- web/` — if unrelated
   web/ commits ride along, either accept them knowingly or deploy from a
   tree that excludes them; say which in the handoff. Rollback: the deploy
   keeps `web-dist.bak.<stamp>` (copy before rsync); restore it, no restart.
4. **Shortcut creation** (end of QA): in the REAL client with Sam's session,
   add to `help-team`: label `kept`, URL
   `https://crichton.tailb3d4b8.ts.net:6660`, mode overlay — this is also
   QA Q5's end state.

## Open questions (none blocking; defaults chosen)

- kept's real name (Sam's pick) — rename is mechanical (five places listed).
- Exact public URL of the live OSS-relay web client was not verifiable from
  the repo (deploy target `~/.evie/buzz/web-dist` is from fleet memory); QA
  knows the door it tests through.
- Whether tailscale serve injects framing-hostile headers — resolved
  empirically at QA Q4; the dock's stall banner is the detector.
- `tailscale serve` single-mapping removal syntax varies by CLI version —
  check `tailscale serve --help` at rollback time (do NOT `tailscale serve off`,
  it would drop every mapping including ummm's).

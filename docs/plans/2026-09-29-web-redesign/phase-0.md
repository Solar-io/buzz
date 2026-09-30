# Phase 0: make room (no visible change)

Architect design for Phase 0 of [`../2026-09-29-web-redesign.md`](../2026-09-29-web-redesign.md).
Implementer: `coder` seat. Line references are to **`df7363b9a`**, not the plan's
`34643677d`. Other agents change `web/` on main today, so re-run each `sed -n`
before you edit. If a block has moved, follow the code and not these numbers.

**Goal.** Phase 0 moves structure and adds mechanism. Nothing the user can see
changes in any theme or at any width. Phase 1 builds on every seam named here.

**Out of scope.** Visual changes, new nav items, the Work tab, turning on the
fixed palettes, and Tailwind palette literals (`bg-amber-500` and similar, in
about 69 files). §6 covers those literals.

---

## 1. File-by-file change map

Current sizes: `repos.tsx` 1044, `Composer.tsx` 1071, `ChannelTimeline.tsx`
1049 (not touched in this phase, and it must not grow), `AppShell.tsx` 251.

### 1.1 `web/src/shared/layout/AppShell.tsx` (251 → about 280)

Add three optional props. Callers that don't pass them render exactly as today.

```ts
rightPane?: ReactNode;                 // rendered after <main>, inside the new row
rowRef?: (el: HTMLDivElement | null) => void; // the pane-width ResizeObserver target
rowClassName?: string;                 // "buzz-conversation-row" when a channel is open
rowStyle?: CSSProperties;              // { "--thread-width": `${w}px` }
```

New structure (desktop). The phone bar keeps spanning the full column width:

```
div.buzz-app-shell (flex h-dvh)
├─ aside (sidebar) + ResizeHandle          unchanged (AppShell.tsx:171-189)
└─ div.flex-1.flex-col                     unchanged (AppShell.tsx:192)
   ├─ header (phone bar)                   unchanged (AppShell.tsx:196-226)
   └─ div[ref=rowRef].flex.min-h-0.flex-1  NEW: the "shell row"
      ├─ main.buzz-content-scrollbar.min-w-0.flex-1.overflow-y-auto   (was :227)
      └─ {rightPane}
```

- `main` gains `min-w-0`. Without it a long timeline row would push the pane
  off-screen once the pane is a sibling of `main`.
- `rowClassName` must be `buzz-conversation-row` **only** when a conversation is
  open. The custom-gradient theme pads that class at lg
  (`globals.css:73-92`). The view pages never had it, and must not get it now.
- The drawer (`AppShell.tsx:234-248`) is unchanged.

### 1.2 New: `web/src/features/shell/rightPaneLayout.ts` (pure, about 90 lines)

The show/hide rules from `repos.tsx:944-1009` and the view-page rule from
`repos.tsx:773-788`, moved without change and made table-testable. Phase 1
extends this file into the tab model (phase-1 §3).

```ts
export type PaneSurface = "conversation" | "view" | "none";
export interface RightPaneInput {
  surface: PaneSurface;
  threadRoot: boolean;   // a thread in the OPEN channel resolved (repos.tsx:339-342)
  detached: boolean;     // a kept-open thread from another channel (repos.tsx:686-696)
  agentDm: boolean;      // dmAgentPubkey !== null
  rightTab: "thinking" | "thread";
  paneHidden: boolean;   // dmPaneHidden
  webLayerActive: boolean;
}
export interface RightPaneLayout {
  hostVisible: boolean;       // false => host renders `hidden` (still mounted)
  handle: boolean;            // repos.tsx:944 — threadOpen || agentDm (surface=conversation only)
  threadDocked: boolean;      // :958 threadRoot && (!agentDm || rightTab==="thread")
  detached: boolean;          // :973 (conversation) and view pages (WithThreadPane had no handle)
  threadMobileOnly: boolean;  // :974 threadRoot && agentDm && rightTab==="thinking"
  activity: boolean;          // :988 agentDm && !paneHidden && (!threadOpen || rightTab==="thinking")
}
export function rightPaneLayout(input: RightPaneInput): RightPaneLayout;
```

Keep the existing quirks, because this phase must not change what users see:

- A handle renders when `agentDm && paneHidden && !threadOpen`, even though no
  pane is shown.
- View pages get the detached thread but **no** resize handle.

`hostVisible = !webLayerActive`. Today the WebLayer (`WebFrameHost.tsx:117`,
`absolute inset-0 z-20`) covers the whole conversation row, pane included.
With the pane outside `main`, the host has to hide itself to get the same
result. Use `display:none` and keep it mounted, so the thread composer draft
survives.

### 1.3 New: `web/src/features/shell/useShellRightPane.ts` (about 120 lines)

Owns the pane state the route currently holds inline:

| Moves from `repos.tsx` | Lines |
|---|---|
| `useThreadPaneWidth(channelId, false)` + `sidePanelDrag` (`usePointerDrag`) | 343-366 |
| `useDmRightPane({...})` | 635-653 |
| `threadChannel`, `detachedThread` element, `threadOpen` | 685-697 |

It returns:

- `panes`, for `DmComposerActions`
- `openThreadTab(id)`, which replaces the inline `setThreadRootId(id); setRightTab("thread")` at `:851-854`
- `row: { ref, style }` for AppShell
- `hostProps`, for `RightPaneHost`

`threadRootId`, `setThreadRootId`, `source` and `openThread` stay in the route
(`useOpenThread`, `:313-314`), because the permalink effect at `:320-324`
reads them before the pane is involved. The hook takes them as arguments.

### 1.4 New: `web/src/features/shell/ui/RightPaneHost.tsx` (about 140 lines)

Renders the handle (the `:947-956` markup, classes unchanged, including
`buzz-side-panel-resize-handle`), the docked `ThreadPanel`, the detached
thread, the `mobileOnly` `ThreadPanel`, and `AgentActivityPanel`, driven by
`rightPaneLayout()`. The prop objects are the ones used at `:959-1008` today,
grouped as `conversation={{ root, buffer, members, profiles, agentPubkeys,
strictMentions, selfPubkey, permalinkMessageId, onPermalinkSettled, send }}`
and `activity={{ agentPubkey, agentName, profile, frames, lockedCount,
connected, working }}`. The panels themselves (`ThreadPanel.tsx`,
`AgentActivityPanel.tsx`) are **not** edited. They already own their dock and
overlay chrome (`ThreadPanel.tsx:26-29,172-183`, `AgentActivityPanel.tsx:372-380`),
and a `fixed inset-0` overlay does not care where its DOM parent is.

### 1.5 New: `web/src/app/ShellProviders.tsx` (about 90 lines)

Takes the provider stack at `repos.tsx:709-758` as it is:

- `AsksProvider`
- `NotificationRuntime`
- `StageRoute`
- `MessageToasts`
- `RemindMeLaterProvider`
- `ProfileActionsProvider` and its three callbacks

Its props are the values those components read today. Phase 1 mounts
`WorkProvider` here, which is why it has to be extracted now.

### 1.6 `web/src/app/routes/repos.tsx` (1044 → target ≤ 900)

- Remove the blocks listed in §1.3 and §1.5, plus the WithThreadPane branch
  (`:773-788`, replaced by a bare `<ShellViewPane …/>`), the row div
  (`:790-794`, its `ref`/`style` now go to AppShell), and `:944-1009`.
- Pass `rightPane`, `rowRef`, `rowClassName`, `rowStyle` to `<AppShell>` (`:759`).
- Drop the imports that become unused: `:34-39`, `:53`, `:63-68`, `:79`.
- Budget: Phase 1 needs about 60 lines here (WorkProvider props, phone tab
  wiring, the Work tab input). Stop at ≤ 900 so that fits.

### 1.7 `web/src/features/channels/ui/DetachedThreadPanel.tsx`

Delete `WithThreadPane` (`:85-118`) and its only caller. Update the doc comment
at `ShellViewPane.tsx:13`. `DetachedThreadPanel` itself is unchanged.

### 1.8 New: `web/src/features/channels/ui/useComposerSuggestions.ts` (about 210 lines)

This hook owns the autocomplete. Phase 2 adds `/` as a third trigger without
editing `Composer.tsx` again.

| Moves from `Composer.tsx` | Lines |
|---|---|
| `popupIndex` state | 202 |
| `mentionDismissed` state | 207 |
| `namedMembers`, `query`, re-arm effect, `suggestions` | 366-413 |
| `applySuggestion` | 428-445 |
| `emojiToken`, `emojiMatches`, `emojiIndex`, `applyEmojiMatch` | 509-528 |
| popup key handling (mention and emoji branches) | 785-837 |
| `setPopupIndex(0)` resets | 982, 991 |

Shape:

```ts
interface SuggestionTrigger<Item> {
  id: "mention" | "emoji";              // Phase 2 adds "command"
  detect(text: string, caret: number): string | null;   // token or null
  items(token: string): Item[];
  apply(item: Item): void;              // closes over applyText/focusAt
}
export function useComposerSuggestions(opts: {
  text: string; selection: Selection;
  members: ChannelMember[]; profiles: Map<string, Profile>;
  applyText(next: string): void; focusAt(start: number, end?: number): void;
  onPickMention(name: string, pubkey: string): void;  // Composer keeps mentionPicks (draft + send read it)
}): {
  listProps: ComponentProps<typeof ComposerSuggestionLists>;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean; // true = handled, caller returns
  rearmMention(): void;   // the @ button (Composer.tsx:1018)
  resetHighlight(): void; // focus/blur (Composer.tsx:982,991)
};
```

Keep the precedence as it is: the first trigger with a token wins, and emoji
detection only runs when there is no mention token (`Composer.tsx:510-513`).
Escape dismisses a mention until the token changes. Keep the
`biome-ignore` rationale from `:390`. It still applies.

`Composer.tsx` goes from 1071 to about 935. `mentionPicks` (`:211`) stays in
the Composer, because draft persistence (`:322-338`) and `submit` (`:703-762`)
read it.

### 1.9 Theme mechanism (see §2)

| File | Change | Size after |
|---|---|---|
| `shared/theme/fixed-palettes.ts` (new) | Palette ids, `FIXED_THEME_FOR` map (**empty in Phase 0**), `PALETTE_META_BG`, `resolveThemeApplication()` | about 80 |
| `shared/styles/palettes.css` (new) | `:root[data-palette="buzz-light"]` and `:root[data-palette="buzz-dark"]` blocks, with the canvas values | about 170 |
| `shared/styles/globals.css` | `@import "./palettes.css"` after the tailwind imports; add the new semantic tokens (§2.3) to `:root` (`:511`) and `.dark` (`:564`) | 968 → about 1030 (not governed by the ratchet; CSS isn't in `check-file-sizes.mjs`) |
| `shared/theme/adaptive-theme.ts` | Export `DERIVED_VAR_NAMES`. Emit the six neutral semantic tokens from bg/fg (§2.3) | 302 → about 330 |
| `shared/theme/ThemeProvider.tsx` | `applyThemeByName` branches on `resolveThemeApplication`, plus `clearDerivedVars()`, `applyPalette()`, and first-paint cache v3 | 493 → about 540 |
| `tailwind.config.js` | Color keys for the new tokens (§2.3) | +30 |

### 1.10 Hardcoded hex: 4 files to fix, 4 to leave

The plan's "~22 hex in 8 files" counts comments and data. Only 10 hex values
are painted colors:

| File:line | Today | Change |
|---|---|---|
| `features/repos/ui/ReposPage.tsx:50,128,149` | `bg-[#F3F3F3] dark:bg-[#171717]` | `bg-surface-neutral` |
| `features/repos/ui/RepoDetailPage.tsx:71,247,267` | same | same |
| `features/repos/ui/RepoBlobViewer.tsx:264,274` | same | same |
| `features/invite/ui/InvitePage.tsx:201` | `linear-gradient(180deg, #D7D72E 0%, #D7E7F6 100%)` | `var(--invite-gradient-from)` / `var(--invite-gradient-to)` |

The new tokens are fixed per polarity in `globals.css`:

- `--surface-neutral: 0 0% 95.29%` (light) / `0 0% 9.02%` (dark). These are
  exactly #F3F3F3 and #171717, so nothing visibly changes.
- `--invite-gradient-from: #D7D72E` and `--invite-gradient-to: #D7E7F6` in
  `:root`, the same values as today. The invite page is the same in both
  polarities today, so both values live in `:root`.

Leave these alone:

- `AccentPicker.tsx:27-35`: swatch data the user picks from, not styling.
- `ThreadParticipantStack.tsx:57,59`: `#fff` inside a CSS mask, where it
  means alpha, not a color.
- `GroupAvatar.tsx:15`, `tooltip.tsx:42,45`, `ThemeProvider.tsx:179`: comments.

---

## 2. Fixed-palette theme mechanism

### 2.1 Why CSS and not inline vars

The engine writes derived vars **inline** on `<html>` (`ThemeProvider.tsx:164-173`),
and the accent layer removes its inline properties when the accent is null
(`:226-242`). If a fixed palette were written inline too, then
`applyAccent(null)` would delete the palette's `--primary`, `--sidebar-primary`
and `--sidebar-active`. So palettes are **stylesheet blocks selected by an
attribute**, and the provider switches the attribute:

- Specificity is `:root[data-palette]` (0,2,0), above `.dark` / `:root`. Both
  sit in `@layer base`, so the palette beats the stylesheet defaults.
- Inline still beats any selector. The user accent (inline) therefore still
  overrides the palette's `--primary`, which is what we want. It also means
  every derived inline var has to be **removed** when a palette activates.

### 2.2 Resolution and apply path

```ts
// fixed-palettes.ts
export type PaletteId = "buzz-light" | "buzz-dark";
export const PALETTE_IS_DARK: Record<PaletteId, boolean>;
export const PALETTE_META_BG: Record<PaletteId, string>;   // "#FDFCF9", "#141414"
export const FIXED_THEME_FOR: Partial<Record<SyntaxThemeName, PaletteId>> = {}; // Phase 1: {buzz:"buzz-light","buzz-dark":"buzz-dark"}
export type ThemeApplication =
  | { kind: "fixed"; palette: PaletteId; isDark: boolean }
  | { kind: "derived"; shikiName: SyntaxThemeName };
export function resolveThemeApplication(
  name: string, map = FIXED_THEME_FOR,
): ThemeApplication;
```

`applyThemeByName(name)` in `ThemeProvider.tsx:255-266`:

1. `resolveThemeApplication(name)`.
2. **fixed**:
   - `clearDerivedVars()`, which removes every name in `DERIVED_VAR_NAMES` from `root.style`.
   - Set `root.dataset.palette = id`.
   - Set the `.dark` / `.light` class and `colorScheme`, as `applyVars` does now.
   - Set the theme-color metas from `PALETTE_META_BG[id]`.
   - Return `{name, isDark, vars: {}, palette: id}`.
3. **derived**: `delete root.dataset.palette`, then the current path
   (`loadThemeData`, `extractThemeInfo`, `createThemeVars`, `applyVars`).
4. The custom-gradient branch (`:365-386`) is unchanged. Custom gradients stay
   derived themes.

**First paint.** Bump `THEME_CACHE_KEY` to `buzz-theme-cache-v3` (`:61`). The
`ThemeCache` type gains `palette?: PaletteId`. In the `isDark` initializer
(`:318-346`), a cached `palette` sets `data-palette` plus class/meta before
React paints. A v2 entry is ignored and the provider reconciles as it does
today.

**Syntax highlighting is unchanged.** `CodeBlock.tsx:111-112` resolves
`resolveShikiThemeName(appliedThemeName)`, so `buzz` / `buzz-dark` keep
github-light / github-dark code colors whichever palette paints the chrome.

**Existing Shiki themes keep working.** They resolve `derived`, which removes
`data-palette`, so `palettes.css` never matches them, and the path is the one
they take today. When a derived theme is active, the palette blocks match
nothing.

**`palettes.css` must be complete.** Each block defines **every** name in
`DERIVED_VAR_NAMES`, not only the canvas tokens. The huddle tokens have no
stylesheet default at all (`grep -c huddle- globals.css` = 0), so a missing
one would unstyle the huddle controls. The palette blocks also define
`--primary`, `--primary-foreground`, `--sidebar-primary*`, `--sidebar-active*`
and `--radius`. A test enforces this (T0-9).

### 2.3 Tokens: names, values, Tailwind keys

The canvas uses its own var names. This table is the translation, and the
Phase 1 designer uses it to read the artboards. All values are HSL triplets,
like every other shadcn token (`hsl(var(--x))` in `tailwind.config.js`), so
`/opacity` modifiers work. Canvas hex is converted with the existing `hexToHsl`.

**Canvas vars mapped onto existing shadcn tokens** (the palette blocks set these):

| Canvas | shadcn var | buzz-light | buzz-dark |
|---|---|---|---|
| `--bg` | `--background` | #FDFCF9 | #141414 |
| `--side` | `--sidebar-background` | #F2EFE8 | #181818 |
| `--card` | `--card` | #FFFFFF | #1D1D1D |
| `--ink` | `--foreground`, `--card-foreground`, `--popover-foreground` | #1B1A16 | #E7E5E1 |
| `--muted` (text) | `--muted-foreground` | #6B655A | #8E8B85 |
| `--line` | `--border`, `--sidebar-border` | #E6E2D8 | #262626 |
| `--line2` | `--input` | #D6D1C5 | #333333 |
| `--hover` | `--accent`, `--sidebar-accent` | #F4F1EA | #1B1B1B |
| `--chip` | `--secondary`, `--muted` | #F2EFE8 | #262626 |
| `--sel` | `--sidebar-active` (fg = `--ink`) | #FFFFFF | #222222 |
| `--btn` / `--btn-ink` | `--primary` / `--primary-foreground` | #1B1A16 / #FDFCF9 | #E7E5E1 / #141414 |
| `--need` | `--destructive` | #E0553A | #C8674F |
| Toasts `--card` | `--popover` | #FFFFFF | #1F1F1F |

**New semantic tokens** (added in Phase 0 to `globals.css` `:root` / `.dark` and to
`palettes.css`):

| CSS var | Tailwind key (class example) | light | dark | Derived themes |
|---|---|---|---|---|
| `--sunk` | `sunk` (`bg-sunk`) | #F7F5F0 | #191919 | engine: `elevate(-0.03)` |
| `--chip` | `chip` | #F2EFE8 | #262626 | engine: = `--secondary` |
| `--ink-2` | `ink-2` (`text-ink-2`) | #45423B | #BDBAB4 | engine: mix(fg, bg, 0.25) |
| `--faint` | `faint` | #A7A194 | #5F5D59 | engine: mix(comment, bg, 0.45) |
| `--line-2` | `line-2` (`border-line-2`) | #D6D1C5 | #333333 | engine: = `--input` |
| `--rail` | `rail` | #F7F5F0 | #171717 | engine: = `--sunk` |
| `--vit` | `vit` | #E8E4DA | #1B1B1B | engine: mix(chrome, fg, 0.06) |
| `--work` / `--work-foreground` | `work` (`bg-work text-work-foreground`) | #EBA21A / #1B1A16 | #C9A24E / #141414 | static fallback |
| `--need` / `--need-foreground` | `need` | #E0553A / #FFFFFF | #C8674F / #141414 | static |
| `--honey-soft\|wash\|line\|ink` | `honey.{soft,wash,line,ink}` | FCF0D2 FEF8E8 F0DDA6 7F5200 | 2A2518 1A1916 3A3322 D9B56A | static |
| `--coral-soft\|wash\|line\|ink` | `coral.{…}` | FBE6DF FDF3EF F2A594 A2301A | 2E1F1B 1B1716 4A2C25 E39A8A | static |
| `--leaf`, `--leaf-soft`, `--leaf-ink` | `leaf.{DEFAULT,soft,ink}` | 2E9A68 DFF1E7 1C6644 | 5BAE82 18231C 8CCBA5 | static |
| `--info-soft\|line\|ink` | `info.{soft,line,ink}` | E7EEF8 C8D6EB 1F4E8C | 1A1F27 2A3342 A5BEDF | static |
| `--idle-ring`, `--idle-hex`, `--idle-hex-ink` | `idle.{ring,hex,"hex-ink"}` | D5D0C4 E3DFD4 5E594F | 3A3A3A 2C2C2C 9A978F | static |
| `--human`, `--human-ink` | `human.{DEFAULT,ink}` | CFE3D3 33291F | 2C3B31 CFE3D6 | static |
| `--elev-shadow` | `boxShadow.elev` | rgba(27,26,22,.35) | rgba(0,0,0,.6) | static (a whole color, not a triplet) |
| `--surface-neutral` | `surface-neutral` | #F3F3F3 | #171717 | static (§1.10) |

"Static" means the value comes from `globals.css` `:root` / `.dark`, so a Catppuccin user
gets the canvas's amber/coral/leaf on their own neutrals. "engine" means
`createThemeVars` emits it, so the neutrals follow the user's theme. Add the
engine ones in `adaptive-theme.ts` next to `--secondary` (`:255`).

**Renamed from the plan:**

- `blue-*` becomes `info-*`. Tailwind already has a `blue` palette, and
  `text-blue-500` is in use three times. A `colors.blue` key under `extend`
  risks shadowing or merging with it under the v4 `@config` shim.
- `ring-idle` / `hex-idle` become `idle.*`, which gives readable classes
  (`bg-idle-hex`).

**Canvas drift, resolved:** `Main.dc.html` is the source of truth.

- Vitals dark `--vit` #1E1E1E and PhoneWork dark `--rail` #141414 are sampling
  drift. Use Main's #1B1B1B and #171717.
- The toast surfaces (card #1F1F1F, chip #2A2A2A, line #2A2A2A, line2 #363636)
  are *elevated* surfaces. They map to `--popover` and hairlines on popover,
  not to `--card`.

---

## 3. Test contract

Run with `cd web && pnpm test`. That is the only supported runner (AGENTS.md
§Testing); `bun test` produces false failures. Record the **baseline count** at
`df7363b9a` before you start. Phase 0 ends at baseline plus the new tests
below, with nothing removed. The plan says "the test count is unchanged",
which is wrong, because Phase 0 adds tests.

Commit before each mutation. Revert with `git checkout -- <file>` and check
that the total count is unchanged (AGENTS.md "Mutation proof").

| ID | File | Test name | Guards | Mutation that must fail it |
|---|---|---|---|---|
| T0-1 | `features/shell/rightPaneLayout.test.mjs` | `conversation: every combination matches the pre-extraction rules` | The move of `repos.tsx:944-1009` keeps the same behavior. Table over all 2⁵ values of (threadRoot, detached, agentDm, rightTab, paneHidden), with **hardcoded** expected rows transcribed from the old JSX, not computed | Drop `!agentDm \|\|` from `threadDocked` |
| T0-2 | same | `handle renders for a hidden agent-DM pane with no thread` | The kept quirk (§1.2) | Change `handle` to `threadDocked \|\| detached \|\| activity` |
| T0-3 | same | `view surface: detached thread docks with no handle` | The WithThreadPane parity | Set `handle: true` for `surface:"view"` |
| T0-4 | same | `web layer hides the host but keeps it mounted` | `hostVisible` | `hostVisible: true` always |
| T0-5 | `features/channels/ui/useComposerSuggestions.test.mjs` (jsdom, the `Composer.test.mjs` pattern) | `typing "@al" lists matching members, Enter inserts "@Alice " and records the pick` | Mention trigger + `onPickMention` | Drop the `onPickMention` call in `apply` |
| T0-6 | same | `":smi" lists emoji only when no @ token is open` | Precedence (`Composer.tsx:510-513`) | Remove the `query !== null ? null :` guard |
| T0-7 | same | `Escape dismisses the mention list until the token changes` | The re-arm effect (`:391-393`) | Delete the re-arm effect |
| T0-8 | `shared/theme/fixed-palettes.test.mjs` | `resolveThemeApplication: mapped names are fixed, everything else derived` | Resolution. Uses an injected map `{buzz:"buzz-light"}`, and asserts `FIXED_THEME_FOR` is **empty** in Phase 0 | Return `fixed` for any name starting with `buzz` |
| T0-9 | same | `palettes.css defines every derived var in both palettes` | Completeness (§2.2). Parses the CSS file, and asserts `DERIVED_VAR_NAMES.length > 20` first so the loop can't run empty | Delete `--huddle-control-surface` from the buzz-dark block |
| T0-10 | same | `PALETTE_META_BG equals each palette's --background` | The one value duplicated between TS and CSS | Change `#141414` in the TS map |
| T0-11 | `shared/theme/ThemeProvider.palette.test.mjs` (jsdom) | `fixed → derived → fixed leaves no stale inline var and restores data-palette` | `clearDerivedVars` and removing the attribute | Skip `clearDerivedVars()` |
| T0-12 | same | `accent null does not remove a palette's --primary` | The reason §2.1 exists: `getComputedStyle(root).getPropertyValue("--primary")` still equals the palette value | Move `--primary` from `palettes.css` into an inline `applyVars` call |
| T0-13 | `shared/theme/adaptive-theme.test.mjs` (extend) | `emits sunk/chip/ink-2/faint/line-2/rail/vit for light and dark inputs` | The engine emits the neutral tokens | Delete the `--faint` line |
| T0-14 | existing `Composer.test.mjs`, `ComposerDictationHandle.test.mjs`, `DetachedThreadPanel.test.mjs`, `ThreadPanel.test.mjs`, `dmPaneToggles.test.mjs` | unchanged, all green | The extractions keep behavior | n/a (a regression guard, not new) |

Harness checks:

- For T0-9, assert the CSS file resolves and parses to two blocks before
  iterating.
- For T0-1, assert the table has 32 rows.

## 4. Gates

- `cd web && pnpm test`, with the count recorded against the baseline.
- `pnpm build`. It is the only typecheck (`pnpm test` strips types).
- `pnpm check`: biome, px-text, pubkey-truncation. Compare any failure against
  a clean `main` checkout before you assume you caused it.
- `CHECK_FILE_SIZES_BASE=main pnpm check:file-sizes`. `repos.tsx` must be ≤ 900
  and `Composer.tsx` must be < 1000.

## 5. Acceptance: screenshot pairs

"No visible change" is measured, not eyeballed.

**Setup.**

- Build `main` (`df7363b9a` or its merge-base) and the branch. Run each with
  `pnpm dev --port <A>` / `--port <B>` from its own checkout, with
  `VITE_RELAY_URL=wss://crichton.tailb3d4b8.ts.net:6351`.
- Sign in on **both** origins with the attested agent key (AGENTS.md "Driving
  the real web client", items 2-3). Use `http://localhost:<port>`, not
  `127.0.0.1`.
- Use your own private channel (create it) with fixed content:
  - 5 messages
  - one thread with 2 replies
  - one DM with an agent that has observer frames (for the activity pane)
- Pass `--viewport` at 1440×900 and 390×844.

**States.** 12 states × 4 themes = 48 pairs. The themes are `buzz` (light),
`buzz-dark`, `catppuccin-mocha` and `custom-gradient-dark`.

1. channel, no pane
2. channel + thread docked
3. agent DM, activity pane
4. agent DM, thread tab
5. agent DM, pane hidden
6. Inbox view + detached thread
7. Files open over a conversation with a thread open
8. drag-resize the pane 100 px, then reload (the width persists)
9. phone: channel
10. phone: thread sheet
11. phone: thinking sheet
12. ReposPage and InvitePage (`/repos/browse`, `/invite/<code>`)

**Pass condition.** For each pair, compare with ImageMagick `compare -metric AE
-fuzz 1%` or `pixelmatch`. Mask timestamps and the typing row. The result
must be **0 differing pixels** outside the masks. Post any non-zero diff as
an image pair, with its explanation, in the report.

Agent Brave rules apply: claim your own tab and close it on every exit path.
If `browser_tabs new` crashes, see the memory note about reusing a tab.

## 6. Risks, and what the plan got wrong

**Risks.**

- **The right pane moves out of `main`.** Stacking and scroll are the main
  risk. A `fixed` overlay is unaffected, but `min-w-0` is required on `main`
  (§1.1). The Files overlay must still cover the full row, which is why the
  host hides while the web layer is active.
- **`useThreadPaneWidth` observes a new element.** It used to observe the
  conversation row. The AppShell row has the same width while a conversation
  is open, and on view pages it now always has a width, where before it fell
  back to `innerWidth`. The clamps are identical when a pane is shown. State 8
  covers this.
- **Palette inline/attribute interplay (§2.1).** T0-11 and T0-12 cover it.

**Plan items that were wrong.**

- **The hex count.** It is 10 painted values in 4 files. The plan's number
  counts comments, accent swatch data and CSS masks. The larger problem is
  the **Tailwind palette literals** used as status colors. Some examples:
  - `text-amber-600 dark:text-amber-400`
  - `bg-emerald-500`
  - `text-red-400`

  There are about 69 files. They won't follow `buzz-light`/`buzz-dark`.
  Phase 1 migrates the ones on surfaces it redesigns (§7 of phase-1). The
  rest are a follow-up (see Open question 1).
- **The token names** `blue-*`, `ring-idle` and `hex-idle` are renamed (§2.3).
- **"`repos.tsx` (1046)".** It is 1044 at `df7363b9a`.
- **"The test count is unchanged".** It should read "baseline plus the new
  tests, none removed".

**Open questions for the orchestrator.**

1. Add a `check:palette-literals` ratchet in Phase 0, like `check:px-text`,
   so new `amber-/emerald-/red-` literals can't land while Phase 1 migrates?
   The recommendation is yes. It costs about 40 lines, and without it the
   fixed palette decays.

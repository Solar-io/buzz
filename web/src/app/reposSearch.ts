/**
 * `/repos` search params, split out of `routes/repos.tsx` (which sits at the
 * file-size ceiling) so the Stage param could be added without growing it.
 */

/**
 * Panes the shell can show instead of a channel.
 *
 * These are `?view=` rather than routes because a route unmounts the sidebar,
 * and the sidebar is what holds the channel subscriptions every pane reads
 * from. It also keeps each pane linkable.
 */
export const SHELL_VIEWS = [
  // Work is the docked right rail at lg; below it, this page (and the phone's
  // home screen). `channels` is the phone tab bar's channel list page.
  "work",
  "channels",
  "inbox",
  "items",
  "workflows",
  "pulse",
  "reminders",
  "projects",
  "onboarding",
  // herdr on crichton through hatch (Phase 7). Shown only when configured.
  "terminal",
] as const;
export type ShellView = (typeof SHELL_VIEWS)[number];

export interface ReposSearch {
  c?: string;
  m?: string;
  view?: ShellView;
  /**
   * Agent Stage Mode: the open event id of a Stage overlaid on channel `c`
   * (design §7). Not a SHELL_VIEW — it overlays a channel rather than
   * replacing it, so Back exits and the view stays linkable.
   */
  stage?: string;
  /**
   * With `m`: land ready to reply — the thread's reply box in a channel,
   * the composer in a DM. A message toast's Reply sets it.
   */
  reply?: true;
  /**
   * With `view=items`: open this item (its `d`) expanded — the confirmation
   * row's "Open" and a shared link land on it.
   */
  item?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ITEM_ID = /^[0-9a-hjkmnp-tv-z]{12}$/;

export function validateReposSearch(
  search: Record<string, unknown>,
): ReposSearch {
  return {
    c: typeof search.c === "string" ? search.c : undefined,
    // Permalink target: scroll to and flash this message once it loads.
    m: typeof search.m === "string" ? search.m : undefined,
    // The inbox is a view of the same shell, not a separate route: a route
    // would unmount the sidebar, and the shell is what holds the channel
    // subscriptions every pane reads from.
    view: SHELL_VIEWS.includes(search.view as ShellView)
      ? (search.view as ShellView)
      : undefined,
    stage:
      typeof search.stage === "string" && HEX64.test(search.stage)
        ? search.stage
        : undefined,
    reply:
      typeof search.m === "string" &&
      (search.reply === true || search.reply === "1" || search.reply === 1)
        ? true
        : undefined,
    item:
      search.view === "items" &&
      typeof search.item === "string" &&
      ITEM_ID.test(search.item)
        ? search.item
        : undefined,
  };
}

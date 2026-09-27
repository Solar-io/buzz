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
  "inbox",
  "workflows",
  "pulse",
  "reminders",
  "projects",
  "onboarding",
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
}

const HEX64 = /^[0-9a-f]{64}$/;

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
  };
}

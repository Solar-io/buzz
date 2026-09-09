/**
 * The ⌘K palette's action entries — extracted from the repos shell so the
 * route file stays under the repo's file-size ceiling. Still a shell
 * concern in spirit: every entry is something only the shell can do (open
 * a view, raise a dialog); this module just builds the list.
 */

import type { QuickCandidate } from "./quickSwitcher.ts";

/** The shell-owned navigation/dialog hooks the palette actions call. */
export interface PaletteActionDeps {
  /** Open one of the shell's non-channel views (?view=). */
  openView: (view: PaletteView) => void;
  openSettings: () => void;
  openAgents: () => void;
  /** Raise the new-channel dialog. */
  onNewChannel: () => void;
  /** Raise the new-DM dialog. */
  onNewDm: () => void;
  /** Raise the Files overlay. */
  onOpenFiles: () => void;
}

/** Shell views reachable from the palette (mirrors the route's ShellView). */
export type PaletteView =
  | "inbox"
  | "onboarding"
  | "projects"
  | "pulse"
  | "reminders"
  | "workflows";

/** Actions the ⌘K palette offers alongside channel jumps, in palette order. */
export function paletteActions(deps: PaletteActionDeps): QuickCandidate[] {
  return [
    {
      id: "action:new-channel",
      kind: "action" as const,
      label: "New channel",
      keywords: ["create", "add", "channel"],
      onSelect: deps.onNewChannel,
    },
    {
      id: "action:new-dm",
      kind: "action" as const,
      label: "New message",
      keywords: ["dm", "direct", "message", "person"],
      onSelect: deps.onNewDm,
    },
    {
      id: "action:inbox",
      kind: "action" as const,
      label: "Inbox",
      keywords: ["inbox", "mentions", "unread", "home"],
      onSelect: () => deps.openView("inbox"),
    },
    {
      id: "action:onboarding",
      kind: "action" as const,
      label: "Getting started",
      keywords: ["onboarding", "welcome", "setup", "checklist", "backup"],
      onSelect: () => deps.openView("onboarding"),
    },
    {
      id: "action:projects",
      kind: "action" as const,
      label: "Projects",
      keywords: ["project", "issue", "board", "backlog", "repo"],
      onSelect: () => deps.openView("projects"),
    },
    {
      id: "action:pulse",
      kind: "action" as const,
      label: "Pulse",
      keywords: ["pulse", "notes", "feed", "social"],
      onSelect: () => deps.openView("pulse"),
    },
    {
      id: "action:reminders",
      kind: "action" as const,
      label: "Reminders",
      keywords: ["reminder", "remind", "later", "snooze", "due"],
      onSelect: () => deps.openView("reminders"),
    },
    {
      id: "action:workflows",
      kind: "action" as const,
      label: "Workflows",
      keywords: ["workflow", "automation", "runs", "trigger"],
      onSelect: () => deps.openView("workflows"),
    },
    {
      id: "action:files",
      kind: "action" as const,
      label: "Files",
      keywords: ["files", "browse"],
      onSelect: deps.onOpenFiles,
    },
    {
      id: "action:settings",
      kind: "action" as const,
      label: "Settings",
      keywords: ["settings", "preferences", "theme", "appearance"],
      onSelect: deps.openSettings,
    },
    {
      id: "action:agents",
      kind: "action" as const,
      label: "Agents",
      keywords: ["agents", "bots"],
      onSelect: deps.openAgents,
    },
  ];
}

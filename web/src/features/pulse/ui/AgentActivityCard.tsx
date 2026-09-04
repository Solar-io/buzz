import { useState } from "react";
import { Bot, ChevronDown, ChevronRight } from "lucide-react";

import type { Profile } from "@/features/channels/hooks";
import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import { MarkdownContent } from "@/features/channels/ui/MarkdownContent";
import { cn } from "@/shared/lib/cn";
import { truncatePubkey } from "@/shared/lib/pubkey";
import { relativeTime } from "@/shared/lib/relative-time";

import type { AgentNoteGroup } from "../lib/groupAgentNotes.ts";

const EMPTY_MENTIONS: ReadonlySet<string> = new Set<string>();

/**
 * Presence for the agent whose burst this card shows.
 *
 * The desktop reads a `status` field off the relay's agent list. The web has
 * no such command, so this is kind:20001 presence — the same signal the DM
 * rows use. Presence is ephemeral, so an agent that has not broadcast since
 * this tab opened reads as `offline` rather than being drawn as online on no
 * evidence.
 */
export type AgentActivityStatus = "online" | "away" | "offline";

const STATUS_DOT: Record<AgentActivityStatus, string> = {
  online: "bg-emerald-500",
  away: "bg-amber-500",
  offline: "bg-muted-foreground/50",
};

const STATUS_LABEL: Record<AgentActivityStatus, string> = {
  online: "Online",
  away: "Away",
  offline: "Offline",
};

function StatusDot({ status }: { status: AgentActivityStatus }) {
  return (
    <span
      aria-label={STATUS_LABEL[status]}
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        STATUS_DOT[status],
      )}
      role="img"
    />
  );
}

/**
 * One agent's burst of notes, collapsed into a single card — the desktop's
 * `AgentActivityCard`.
 *
 * Collapsed, the card shows only the NEWEST note; expanding numbers the whole
 * run. That is the point of the Agents tab: an agent posting eight progress
 * notes in two minutes is one piece of activity, and rendering it as eight
 * rows buries every other agent in the feed.
 */
export function AgentActivityCard({
  group,
  profile,
  status,
}: {
  group: AgentNoteGroup;
  profile: Profile | undefined;
  status: AgentActivityStatus;
}) {
  const [expanded, setExpanded] = useState(false);
  const label =
    profile?.displayName?.trim() ||
    profile?.name?.trim() ||
    truncatePubkey(group.pubkey);
  const isSingle = group.notes.length === 1;
  const summary = group.notes[0];

  return (
    <article
      className="border-b border-border/40 px-1 py-4"
      data-testid={`pulse-agent-group-${group.pubkey}`}
    >
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <AuthorAvatar
            label={label}
            picture={profile?.avatar}
            pubkey={group.pubkey}
          />
          <Bot
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 h-4 w-4 rounded-full bg-background p-0.5 text-muted-foreground"
          />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">
            {label}
          </span>
          <StatusDot status={status} />
          <span className="shrink-0 text-2xs text-muted-foreground">
            {relativeTime(group.latestAt)}
          </span>
        </div>
        {isSingle ? null : (
          <button
            aria-expanded={expanded}
            className="flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-2xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            data-testid={`pulse-agent-expand-${group.pubkey}`}
            onClick={() => setExpanded((open) => !open)}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight aria-hidden className="h-3.5 w-3.5" />
            )}
            {group.notes.length} updates
          </button>
        )}
      </div>

      {isSingle || !expanded ? (
        <div className="ml-11 mt-1.5 text-sm">
          <MarkdownContent
            content={summary.content}
            mentionNames={EMPTY_MENTIONS}
          />
        </div>
      ) : (
        <ol className="ml-11 mt-2 space-y-2">
          {group.notes.map((note, index) => (
            <li
              className="flex gap-2 rounded-xl border border-border/50 bg-muted/20 px-3 py-2"
              key={note.id}
            >
              <span className="mt-0.5 shrink-0 text-2xs font-medium text-muted-foreground">
                {index + 1}.
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <MarkdownContent
                  content={note.content}
                  mentionNames={EMPTY_MENTIONS}
                />
                <p className="mt-1 text-2xs text-muted-foreground">
                  {relativeTime(note.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

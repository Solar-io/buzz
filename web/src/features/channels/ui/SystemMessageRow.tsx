import type { TimelineMessage } from "../lib/messageBuffer.ts";
import type { Profile } from "../hooks.ts";
import { authorLabel } from "./ChannelTimeline.tsx";
import {
  describeSystemEvent,
  systemEventFromContent,
  type SystemEventDescription,
} from "../lib/systemEvent.ts";

/**
 * Kind-40099 system row (desktop `SystemMessageRow`, membership + moderation
 * paths only).
 *
 * Desktop's centered membership treatment: no card, no hover wash, small muted
 * caption constrained to a readable measure. Moderation tombstones use the same
 * centering but keep a bordered plate — a removal is a statement the room needs
 * to notice, not a passing membership note.
 *
 * Deliberately NOT ported (out of scope for this pass): membership grouping
 * ("A and B joined"), the avatar stack, and reactions on system rows.
 */

/**
 * Caption for a system message, or null when nothing should render.
 * Exported so the timeline can drop the row entirely rather than mounting an
 * empty virtualized item for a payload it cannot describe.
 */
export function describeSystemMessage(
  message: TimelineMessage,
  profiles: Map<string, Profile>,
): SystemEventDescription | null {
  return describeSystemEvent(
    systemEventFromContent(message.content),
    (pubkey) => (pubkey ? authorLabel(pubkey, profiles) : "Someone"),
  );
}

export function SystemMessageRow({
  description,
}: {
  description: SystemEventDescription;
}) {
  if (description.moderated) {
    return (
      <div className="flex justify-center px-2 pb-2 pt-4">
        <div
          className="flex min-w-0 max-w-[min(40rem,80%)] flex-col gap-0.5 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-center"
          data-testid="system-message-row"
        >
          <p className="text-xs font-medium text-muted-foreground">
            {description.title}
          </p>
          <p className="text-xs leading-4 text-muted-foreground/80">
            {description.action}
          </p>
          {description.reasonCode && (
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/60">
              {description.reasonCode}
            </p>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-center px-2 pb-2 pt-4">
      <p
        className="min-w-0 max-w-[min(40rem,80%)] text-left text-xs font-normal leading-4 text-muted-foreground/70"
        data-testid="system-message-row"
      >
        <span className="font-medium text-muted-foreground">
          {description.title}
        </span>{" "}
        {description.action}
      </p>
    </div>
  );
}

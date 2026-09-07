import type { TimelineMessage } from "../lib/messageBuffer.ts";
import type { Profile } from "../hooks.ts";
import { authorLabel } from "./ChannelTimeline.tsx";
import {
  describeSystemEvent,
  systemEventFromContent,
  type SystemEventDescription,
} from "../lib/systemEvent.ts";

/**
 * Kind-40099 system row (desktop `SystemMessageRow`, membership + deletion
 * paths only).
 *
 * Desktop's centered membership treatment: no card, no hover wash, small muted
 * caption constrained to a readable measure.
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

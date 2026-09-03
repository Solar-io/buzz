import { Brain, Headphones } from "lucide-react";
import { toast } from "sonner";
import type { ChannelSummary } from "@/features/channels/useChannels";
import { startHuddle } from "@/features/huddle/lib/huddleLifecycle";
import type { RelaySession } from "@/shared/api/relay-session";

/** Props for {@link ChannelHeader}. */
export interface ChannelHeaderProps {
  /** The channel currently open in the main pane. */
  channel: ChannelSummary;
  /** Resolved title — DMs use participant names, channels use "# name". */
  title: string;
  /** Live relay session, used to publish the huddle-start event. */
  session: RelaySession;
  /** A huddle room landed: open it and re-REQ the channel list. */
  onHuddleStarted: (channelId: string) => void;
  /** Set when this DM has an agent counterpart — shows the 🧠 toggle. */
  agentPubkey: string | null;
  /** Reveal the thinking panel in the right pane. */
  onOpenThinking: () => void;
}

/**
 * The channel body's top bar: title, topic, the start-huddle action, and the
 * DM thinking-panel toggle.
 */
export function ChannelHeader({
  channel,
  title,
  session,
  onHuddleStarted,
  agentPubkey,
  onOpenThinking,
}: ChannelHeaderProps) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-secondary px-4">
      <h1 className="truncate text-base font-semibold">{title}</h1>
      {channel.type !== "dm" && channel.about && (
        <p className="hidden truncate text-sm text-muted-foreground sm:block">
          {channel.about}
        </p>
      )}
      {channel.ttlSeconds === null && (
        <button
          type="button"
          aria-label="Start a huddle in this channel"
          title="Start huddle"
          className="ml-auto shrink-0 rounded p-1.5 text-sm text-muted-foreground hover:bg-accent"
          onClick={() => {
            void startHuddle(session, { parentChannelId: channel.id })
              .then((result) => {
                if (result.ok && result.channelId) {
                  toast.success(result.message);
                  onHuddleStarted(result.channelId);
                } else {
                  toast.error(result.message);
                }
              })
              .catch(() => toast.error("Could not start the huddle."));
          }}
        >
          <Headphones aria-hidden className="h-4 w-4" />
        </button>
      )}
      {agentPubkey && (
        <button
          type="button"
          aria-label="Toggle thinking panel"
          title="Thinking"
          className="shrink-0 rounded-full border border-border p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onOpenThinking}
        >
          <Brain aria-hidden className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

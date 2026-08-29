import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";

/**
 * Thread view: the root message, every reply in the channel buffer, and a
 * composer that replies into the thread (NIP-10 root/reply tags).
 */
export function ThreadPanel({
  root,
  buffer,
  members,
  profiles,
  onClose,
  send,
}: {
  root: TimelineMessage;
  buffer: MessageBuffer;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  onClose: () => void;
  send: ComposerProps["send"];
}) {
  const replies = [
    ...buffer.filter(
      (m) =>
        m.rootId === root.id || (m.rootId === null && m.replyToId === root.id),
    ),
  ].sort((a, b) => a.createdAt - b.createdAt);
  const threadMessages = [root, ...replies];
  const lastReply = replies[replies.length - 1] ?? root;

  return (
    <aside className="flex w-full flex-col border-l border-border md:w-96 md:shrink-0">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Thread</span>
        <button
          type="button"
          aria-label="Close thread"
          className="rounded p-1 text-sm text-muted-foreground hover:bg-accent"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ChannelTimeline
          messages={threadMessages}
          profiles={profiles}
          replyCounts={new Map()}
          onOpenThread={() => {
            // Threads are flat in Phase 1: every reply targets the root.
          }}
        />
      </div>
      <Composer
        members={members}
        profiles={profiles}
        threadRef={{ rootId: root.id, replyToId: lastReply.id }}
        onClearThread={onClose}
        send={send}
      />
    </aside>
  );
}

type ComposerProps = Parameters<typeof Composer>[0];

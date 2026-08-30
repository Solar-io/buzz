import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message on a rounded card, every reply in the channel
 * buffer, and a composer that replies into the thread (NIP-10 root/reply
 * tags).
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
    // Below lg the thread is a full-screen sheet (safe-area aware) — a third
    // column at phone/tablet widths is what crushed the timeline. lg+: docked.
    <aside className="fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:inset-auto lg:z-auto lg:w-96 lg:shrink-0 lg:border-l lg:border-border lg:pt-0">
      <header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">Thread</span>
        <span className="text-xs text-muted-foreground">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </span>
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
            // Threads are flat: every reply targets the root.
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

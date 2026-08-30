import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message on a rounded card, every reply in the channel
 * buffer, and a composer that replies into the thread (NIP-10 root/reply
 * tags). At lg+ the panel docks right; its width comes from the shared
 * --thread-width CSS variable the shell maintains (drag handle there).
 */
export function ThreadPanel({
  root,
  buffer,
  members,
  profiles,
  onClose,
  send,
  onSelectThinkingTab,
  mobileOnly,
}: {
  root: TimelineMessage;
  buffer: MessageBuffer;
  members: ChannelMember[];
  profiles: Map<string, Profile>;
  onClose: () => void;
  send: ComposerProps["send"];
  /** DMs offer a Replies ↔ Thinking switch in the header. */
  onSelectThinkingTab?: () => void;
  /** Overlay on small screens only — used when the DM right pane shows the
   *  thinking tab at lg but a thread was opened from the timeline. */
  mobileOnly?: boolean;
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
    // column at phone/tablet widths is what crushed the timeline. lg+: docked,
    // unless mobileOnly (DM thinking-tab case: overlay on phones, hidden at lg).
    <aside
      className={
        mobileOnly
          ? "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:hidden"
          : "fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:inset-auto lg:z-auto lg:w-[var(--thread-width)] lg:shrink-0 lg:border-l lg:border-border lg:pt-0"
      }
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-[#272736] px-4">
        <span className="text-base font-semibold">Replies</span>
        {onSelectThinkingTab && (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onSelectThinkingTab}
          >
            Thinking
          </button>
        )}
        <span className="text-xs text-muted-foreground">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </span>
        <button
          type="button"
          aria-label="Close thread"
          className="ml-auto rounded p-1 text-sm text-muted-foreground hover:bg-accent"
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
          flat
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

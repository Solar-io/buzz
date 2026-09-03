import { useEffect, useState } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import {
  replyTargetMessage,
  resolveThreadReplyRef,
  threadRepliesOf,
} from "../lib/threadTarget.ts";
import { authorLabel, ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message on a rounded card, every reply in the channel
 * buffer, and a composer that replies into the thread (NIP-10 root/reply
 * tags). At lg+ the panel docks right; its width comes from the shared
 * --thread-width CSS variable the shell maintains (drag handle there).
 *
 * The composer's NIP-10 `reply` marker names the message the author chose to
 * respond to — the thread root by default, or whichever reply the reader
 * picked with its ↩ button. It is NOT the newest reply: that made every reply
 * claim the last message as its parent and made replying mid-thread
 * impossible. See lib/threadTarget.ts.
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
  const replies = threadRepliesOf(buffer, root.id);
  const threadMessages = [root, ...replies];
  const lastReply = replies[replies.length - 1] ?? root;
  // Auto-tail (Sam 8/31): thread-heavy agents have long threads — the panel
  // must open on the NEWEST reply, not the root. The timeline's tailKey
  // handles it now that the list is virtualized.

  // Which message the composer is replying to. Null = the thread itself,
  // whose NIP-10 parent is the root. Cleared whenever a different thread
  // opens so a selection can never carry over to another root.
  const [selectedReplyId, setSelectedReplyId] = useState<string | null>(null);
  const rootId = root.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: rootId is the reset trigger, not a value read inside the effect
  useEffect(() => {
    setSelectedReplyId(null);
  }, [rootId]);

  const threadRef = resolveThreadReplyRef(rootId, replies, selectedReplyId);
  const target = replyTargetMessage(rootId, replies, selectedReplyId);
  const targetLabel = target
    ? authorLabel(target.authorPubkey, profiles)
    : null;

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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-secondary px-4">
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
      <ChannelTimeline
        messages={threadMessages}
        profiles={profiles}
        replyCounts={new Map()}
        // Inside a thread the row's ↩ button picks the reply TARGET rather
        // than opening a nested thread — threads here are flat.
        onOpenThread={(message) => setSelectedReplyId(message.id)}
        activeRootId={threadRef.replyToId}
        flat
        tailKey={`${rootId}:${lastReply.id}:${replies.length}`}
      />
      <Composer
        members={members}
        profiles={profiles}
        threadRef={threadRef}
        replyTargetLabel={targetLabel}
        onClearThread={() => {
          // Esc steps back one level: drop a mid-thread target first, and
          // only close the panel once the composer is aimed at the thread.
          if (selectedReplyId) {
            setSelectedReplyId(null);
            return;
          }
          onClose();
        }}
        send={send}
      />
    </aside>
  );
}

type ComposerProps = Parameters<typeof Composer>[0];

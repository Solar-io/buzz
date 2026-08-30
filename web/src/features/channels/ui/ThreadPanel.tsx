import { useEffect, useState } from "react";
import type { MessageBuffer, TimelineMessage } from "../lib/messageBuffer.ts";
import type { ChannelMember, Profile } from "../hooks.ts";
import { ChannelTimeline } from "./ChannelTimeline.tsx";
import { Composer } from "./Composer.tsx";

const THREAD_WIDTH_KEY = "buzz.thread-width.v1";
const DEFAULT_THREAD_WIDTH = 384;
const MIN_THREAD_WIDTH = 288;
const MAX_THREAD_WIDTH = 640;

function loadThreadWidth(): number {
  const stored = Number.parseFloat(
    globalThis.localStorage?.getItem(THREAD_WIDTH_KEY) ?? "",
  );
  if (
    Number.isFinite(stored) &&
    stored >= MIN_THREAD_WIDTH &&
    stored <= MAX_THREAD_WIDTH
  ) {
    return stored;
  }
  return DEFAULT_THREAD_WIDTH;
}

/**
 * Thread view in the desktop client's shape: a "Thread" header with the reply
 * count, the root message on a rounded card, every reply in the channel
 * buffer, and a composer that replies into the thread (NIP-10 root/reply
 * tags). At lg+ the panel docks right with a drag-resizable left edge.
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
  const [width, setWidth] = useState<number>(() => loadThreadWidth());

  useEffect(() => {
    globalThis.localStorage?.setItem(
      THREAD_WIDTH_KEY,
      String(Math.round(width)),
    );
  }, [width]);

  return (
    // Below lg the thread is a full-screen sheet (safe-area aware) — a third
    // column at phone/tablet widths is what crushed the timeline. lg+: docked,
    // drag-resizable via the left-edge handle.
    <>
      <div
        aria-label="Resize thread panel"
        role="separator"
        aria-orientation="vertical"
        className="relative z-10 hidden w-1 shrink-0 cursor-col-resize border-r border-border bg-transparent transition-colors hover:bg-white/15 active:bg-white/25 lg:block lg:-ml-px"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            setWidth((previous) =>
              Math.min(
                MAX_THREAD_WIDTH,
                Math.max(MIN_THREAD_WIDTH, previous - event.movementX),
              ),
            );
          }
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
      <aside
        className="fixed inset-0 z-40 flex flex-col bg-background pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:inset-auto lg:z-auto lg:w-[var(--thread-width)] lg:shrink-0 lg:border-l lg:border-border lg:pt-0"
        style={{ ["--thread-width" as string]: `${width}px` }}
      >
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
    </>
  );
}

type ComposerProps = Parameters<typeof Composer>[0];

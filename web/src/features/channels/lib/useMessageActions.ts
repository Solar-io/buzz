import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  deleteChannelMessage,
  editChannelMessage,
  sendChannelMessage,
  sendReaction,
  sendTypingIndicator,
} from "@/features/channels/hooks";
import { clearDraft, saveDraft } from "@/features/channels/lib/drafts.ts";
import type { ChannelSummary } from "@/features/channels/useChannels";
import type { RelaySession } from "@/shared/api/relay-session";

/** Result shape the composer and forum views expect from a publish. */
export interface MessageSendResult {
  ok: boolean;
  message: string;
}

/** Everything the composer / timeline may publish, for one open channel. */
export interface MessageSendOptions {
  content: string;
  mentionPubkeys: string[];
  threadRef: { rootId: string; replyToId: string } | null;
  mediaTags: string[][];
  /** Event kind — chat default 9; forum views pass 45001/45003. */
  kind?: number;
}

/** The message currently being edited, prefilled into the composer. */
export interface EditingMessage {
  id: string;
  original: string;
}

/** What {@link useMessageActions} needs from the channel shell. */
export interface MessageActionsInput {
  /** Live relay session every publish goes through. */
  session: RelaySession;
  /** The open channel, or null when nothing is selected. */
  current: ChannelSummary | null;
  /** The open channel's id, or "" — the reset trigger for edit state. */
  channelId: string;
  /** Viewer's key; DM peers are auto-tagged on every send. */
  selfPubkey: string | null;
}

/** Everything the timeline, composer and forum body can do to messages. */
export interface MessageActions {
  editing: EditingMessage | null;
  setEditing: (editing: EditingMessage | null) => void;
  onReact: (messageId: string, emoji: string) => void;
  onEdit: (message: { id: string; content: string }) => void;
  onDelete: (messageId: string) => void;
  editSend: (content: string) => Promise<MessageSendResult>;
  onShare: (messageId: string) => void;
  onComposerText: (text: string) => void;
  send: (options: MessageSendOptions) => Promise<MessageSendResult>;
  /**
   * Messages signed and in flight to the relay, keyed by their real event id.
   * The timeline renders these as "Sending…" until the relay acknowledges.
   */
  pendingIds: ReadonlySet<string>;
}

/**
 * Publish-side actions for the open channel: react, edit, delete, share,
 * typing/draft bookkeeping, and the send used by the timeline, the composer,
 * the thread panel and the forum body.
 */
export function useMessageActions({
  session,
  current,
  channelId,
  selfPubkey,
}: MessageActionsInput): MessageActions {
  const onReact = useCallback(
    (messageId: string, emoji: string) => {
      void sendReaction(session, { targetEventId: messageId, emoji });
    },
    [session],
  );
  // Edit mode: ✎ prefills the composer with the original text; submit sends a
  // kind-40003 overlay. Cancelled/switching channels clears it.
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the reset trigger by design
  useEffect(() => {
    setEditing(null);
  }, [channelId]);
  const onEdit = useCallback(
    (message: { id: string; content: string }) =>
      setEditing({ id: message.id, original: message.content }),
    [],
  );
  const onDelete = useCallback(
    (messageId: string) => {
      if (!current) {
        return;
      }
      void deleteChannelMessage(session, {
        channelId: current.id,
        targetEventId: messageId,
      });
    },
    [session, current],
  );
  const editSend = useCallback(
    (content: string) => {
      if (!current || !editing) {
        return Promise.resolve({ ok: false, message: "Nothing to edit." });
      }
      return editChannelMessage(session, {
        channelId: current.id,
        targetEventId: editing.id,
        content,
      }).then((result) => {
        if (result.ok) {
          clearDraft(current.id);
        }
        return result;
      });
    },
    [session, current, editing],
  );
  // Permalink: copies the channel + message URL to the clipboard.
  const onShare = useCallback(
    (messageId: string) => {
      if (!current) {
        return;
      }
      const url = `${globalThis.location.origin}/repos?c=${current.id}&m=${messageId}`;
      void navigator.clipboard
        ?.writeText(url)
        .then(() => toast.success("Link copied"))
        .catch(() => toast.error("Could not copy the link."));
    },
    [current],
  );
  // Typing broadcast: one kind-20002 frame per 3s while the composer has text.
  // Draft persistence rides along — every text change stores the channel's
  // draft (empty text clears it), independent of the typing throttle.
  const lastTypingSent = useRef(0);
  const onComposerText = useCallback(
    (text: string) => {
      if (channelId !== "") {
        saveDraft(channelId, text);
      }
      if (!text.trim() || channelId === "") {
        return;
      }
      const now = Date.now();
      if (now - lastTypingSent.current < 3000) {
        return;
      }
      lastTypingSent.current = now;
      void sendTypingIndicator(session, channelId, null);
    },
    [session, channelId],
  );

  /**
   * Ids of messages signed but not yet acknowledged by the relay.
   *
   * Keyed by the event's real id, which signing produces before publishing —
   * so when the relay echoes the message back it upserts the same row rather
   * than appearing as a second copy. An id leaves the set on acknowledgement
   * or on failure; a failed send also surfaces its error, so a row cannot sit
   * marked "Sending…" forever.
   */
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const settlePending = useCallback((id: string) => {
    setPendingIds((previous) => {
      if (!previous.has(id)) return previous;
      const next = new Set(previous);
      next.delete(id);
      return next;
    });
  }, []);

  const send = (options: MessageSendOptions) => {
    if (!current) {
      return Promise.resolve({ ok: false, message: "No channel selected." });
    }
    // A sent message consumes the channel's draft.
    // DMs always tag the other participants — the desktop client and CLI do
    // this too, so the peer's harness wakes on the message even without an
    // explicit @mention in the text (a web-sent DM once arrived untagged and
    // the agent never reacted to it).
    const dmPeers =
      current.type === "dm"
        ? current.participantPubkeys.filter((pk) => pk !== selfPubkey)
        : [];
    const mentionPubkeys = Array.from(
      new Set([...options.mentionPubkeys, ...dmPeers]),
    );
    let signedId: string | null = null;
    return sendChannelMessage(session, {
      channelId: current.id,
      content: options.content,
      mentionPubkeys,
      threadRef: options.threadRef,
      mediaTags: options.mediaTags,
      kind: options.kind,
      onSigned: (event) => {
        signedId = event.id;
        setPendingIds((previous) => new Set(previous).add(event.id));
      },
    })
      .then((result) => {
        if (result.ok) {
          clearDraft(current.id);
        }
        if (signedId) {
          settlePending(signedId);
        }
        return result;
      })
      .catch((error: unknown) => {
        if (signedId) {
          settlePending(signedId);
        }
        throw error;
      });
  };

  return {
    editing,
    setEditing,
    onReact,
    onEdit,
    onDelete,
    editSend,
    onShare,
    onComposerText,
    send,
    pendingIds,
  };
}

import { useRef, useState } from "react";

import { useChannelMembers } from "@/features/channels/hooks";
import { useWorkContext } from "@/features/work/workContext.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { signNostrEvent } from "@/shared/lib/nostr-signer";
import {
  buildCanvasEvent,
  type ChannelCanvasDoc,
} from "./lib/channelCanvas.ts";

/** Canvas writes use the same signing, publish verdict and membership path as chat. */
export function useCanvasEdit(channelId: string, doc: ChannelCanvasDoc | null) {
  const { session, status } = useRelaySession();
  const work = useWorkContext();
  const members = useChannelMembers(channelId);
  const channel = work?.channels.find((item) => item.id === channelId);
  const canEdit =
    status === "open" &&
    channel !== undefined &&
    !channel.archived &&
    members.some((member) => member.pubkey === work?.selfPubkey);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseId, setBaseId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const start = () => {
    setDraft(doc?.content ?? "");
    setBaseId(doc?.eventId ?? null);
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const write = async (content: string) => {
    if (!canEdit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const event = await signNostrEvent({
        ...buildCanvasEvent(channelId, content),
        // Successive edits within one second must beat the current canvas,
        // regardless of its event-id tie breaker.
        created_at: Math.max(
          Math.floor(Date.now() / 1000),
          (doc?.updatedAt ?? 0) + 1,
        ),
      });
      const result = await session.publish(event);
      if (!result.ok)
        throw new Error(result.message || "Could not save the canvas.");
      // The live subscription supplies the document; an OK is not an echo.
      setEditing(false);
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not save the canvas.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return {
    canEdit,
    editing,
    draft,
    setDraft,
    busy,
    error,
    start,
    cancel,
    changedElsewhere: editing && baseId !== (doc?.eventId ?? null),
    save: () => write(draft),
    clear: () => {
      if (window.confirm("Clear the canvas for everyone in this channel?"))
        void write("");
    },
  };
}

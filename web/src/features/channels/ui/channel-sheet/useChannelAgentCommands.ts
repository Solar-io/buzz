import { useEffect, useRef } from "react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  sendAdminCommand,
  useAdminAckWatcher,
} from "@/features/agents/lib/adminCommandsSend";
import type {
  AdminAckEnvelope,
  AdminCommand,
} from "@/features/agents/lib/adminCommands";

/** Resolve only desktop apply acknowledgements; relay acceptance is not success. */
export function useChannelAgentCommands() {
  const { session, status } = useRelaySession();
  const acks = useAdminAckWatcher(session, status);
  const latest = useRef(acks);
  latest.current = acks;
  const waiting = useRef(new Map<string, (ack: AdminAckEnvelope) => void>());
  useEffect(() => {
    for (const [id, settle] of waiting.current) {
      const ack = acks.get(id);
      if (ack) settle(ack);
    }
  }, [acks]);
  useEffect(
    () => () => {
      for (const [requestId, settle] of waiting.current) {
        settle({
          type: "agent_admin_ack",
          requestId,
          ok: false,
          error:
            "The channel settings were closed. The command may still apply.",
        });
      }
    },
    [],
  );
  return async (command: AdminCommand, target: string): Promise<string> => {
    if (status !== "open")
      throw new Error("Connect to the relay to change agents.");
    const result = await sendAdminCommand(session, command, { target });
    if (!result.ok)
      throw new Error(result.message || "The relay refused the command.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          settle({
            type: "agent_admin_ack",
            requestId: result.requestId,
            ok: false,
            error: `No answer from ${target.replace(/\.local$/, "")} — it may still apply. Check status after reload.`,
          }),
        30_000,
      );
      const settle = (ack: AdminAckEnvelope) => {
        clearTimeout(timer);
        waiting.current.delete(result.requestId);
        if (ack.ok) resolve();
        else reject(new Error(ack.error || "Buzz Desktop refused the change."));
      };
      waiting.current.set(result.requestId, settle);
      const early = latest.current.get(result.requestId);
      if (early) settle(early);
    });
    return result.requestId;
  };
}

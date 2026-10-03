import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  buildCreateCommand,
  type CreateAgentFormValue,
} from "../lib/createAgentRequest";
import type { useAdminCommands } from "../ui/AgentAdminPanel";

/** Await the desktop verdict; a relay OK alone never completes creation. */
export function useBlankAgentCreate({
  admin,
  value,
  target,
  timeoutsEnabled,
  onCreated,
}: {
  admin: ReturnType<typeof useAdminCommands>;
  value: CreateAgentFormValue;
  target: string | null;
  timeoutsEnabled: boolean;
  onCreated: (pubkey: string) => void;
}) {
  const [sending, setSending] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const completed = useRef<string | null>(null);
  const inFlight = useRef(false);
  const ack = requestId ? admin.acks.get(requestId) : undefined;
  useEffect(() => {
    if (!requestId || ack) return;
    const timer = window.setTimeout(() => setUncertain(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [requestId, ack]);
  useEffect(() => {
    if (!ack || !requestId || completed.current === requestId) return;
    completed.current = requestId;
    setUncertain(false);
    if (ack.ok && ack.agentPubkey) {
      toast.success(`Created ${value.name.trim()}`);
      onCreated(ack.agentPubkey);
    } else if (ack.ok) {
      // It may exist already; do not enable a duplicate create.
      setError(
        "The desktop accepted creation without an agent key. Check the roster after reload.",
      );
    } else {
      setError(ack.error || "The desktop rejected the create.");
      setRequestId(null);
    }
  }, [ack, requestId, onCreated, value.name]);

  const submit = async () => {
    if (inFlight.current || requestId) return;
    const built = buildCreateCommand(
      timeoutsEnabled
        ? value
        : {
            ...value,
            idleTimeoutSeconds: "",
            maxTurnDurationSeconds: "",
          },
    );
    if ("error" in built) {
      setError(built.error);
      return;
    }
    inFlight.current = true;
    setSending(true);
    setError("");
    try {
      const id = await admin.send(
        built.command,
        `Create ${value.name.trim()}`,
        target ? { target } : undefined,
      );
      if (id) setRequestId(id);
      else
        setError(
          "The command was not sent. Check the relay connection and try again.",
        );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not send the command.",
      );
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return {
    submit,
    error,
    uncertain,
    waiting: requestId !== null && !ack,
    succeeded: Boolean(ack?.ok && ack.agentPubkey),
    disabled: sending || requestId !== null,
    busy: sending || (requestId !== null && !ack && !uncertain),
    sending,
  };
}

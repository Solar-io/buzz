import { useState } from "react";
import { toast } from "sonner";
import type { RelaySession } from "@/shared/api/relay-session";
import { sendAdminCommand, useAdminAckWatcher } from "../lib/adminCommandsSend";
import type { AdminAckEnvelope, AdminCommand } from "../lib/adminCommands";

/**
 * Remote agent administration (kinds 24201/24202): owner commands the web
 * seals and sends, the owner's Buzz Desktop applies through its own save
 * paths, acks flow back.
 *
 * Phase 1 shrank this module to the two pieces every surface shares: the
 * `useAdminCommands` send/ack hook and `PendingCommandsStrip` (the pending +
 * ack + timeout feedback, page-level so an ack is visible from both panes).
 * The forms moved to AgentCreateForm.tsx / AgentConfigPanel.tsx and the
 * harness dropdown to HarnessSelect.tsx.
 */

interface PendingCommand {
  requestId: string;
  summary: string;
  sentAt: number;
}

const ACK_TIMEOUT_MS = 20_000;

export function useAdminCommands(
  session: RelaySession | null,
  status: string,
): {
  send: (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ) => Promise<string | null>;
  pending: PendingCommand[];
  acks: Map<string, AdminAckEnvelope>;
} {
  const acks = useAdminAckWatcher(session, status);
  const [pending, setPending] = useState<PendingCommand[]>([]);

  const send = async (
    command: AdminCommand,
    summary: string,
    options?: { target?: string },
  ): Promise<string | null> => {
    if (!session) {
      toast.error("Not connected to the relay.");
      return null;
    }
    try {
      const result = await sendAdminCommand(session, command, options);
      if (!result.ok) {
        toast.error(result.message || "The relay refused the command.");
        return null;
      }
      setPending((previous) => [
        ...previous,
        { requestId: result.requestId, summary, sentAt: Date.now() },
      ]);
      // Acks clear their pending row; stragglers age out.
      window.setTimeout(() => {
        setPending((previous) =>
          previous.filter(
            (entry) => Date.now() - entry.sentAt < ACK_TIMEOUT_MS * 4,
          ),
        );
      }, ACK_TIMEOUT_MS * 4);
      return result.requestId;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not send the command.",
      );
      return null;
    }
  };

  return { send, pending, acks };
}

/**
 * Page-level pending-command strip. A "?" row that ages out does NOT mean
 * failure: a command targeted at one machine is silently ignored by every
 * other desktop, and a sleeping target never acks at all — hence the "Is
 * Buzz running?" hint rather than an error verdict.
 */
export function PendingCommandsStrip({
  pending,
  acks,
}: {
  pending: PendingCommand[];
  acks: Map<string, AdminAckEnvelope>;
}) {
  if (pending.length === 0) {
    return null;
  }
  return (
    <ul className="space-y-1">
      {pending.map((entry) => {
        const ack = acks.get(entry.requestId);
        const timedOut = !ack && Date.now() - entry.sentAt > ACK_TIMEOUT_MS;
        return (
          <li
            key={entry.requestId}
            className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5 text-xs"
          >
            <span
              className={
                ack
                  ? ack.ok
                    ? "h-2 w-2 shrink-0 rounded-full bg-emerald-500"
                    : "h-2 w-2 shrink-0 rounded-full bg-red-500"
                  : "h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/50"
              }
            />
            <span className="min-w-0 flex-1 truncate">
              {entry.summary}
              {ack && !ack.ok && (
                <span className="text-red-400"> — {ack.error ?? "failed"}</span>
              )}
              {timedOut && (
                <span className="text-amber-400">
                  {" "}
                  — no desktop responded. Is Buzz running?
                </span>
              )}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {ack ? (ack.ok ? "applied" : "error") : timedOut ? "?" : "sent"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

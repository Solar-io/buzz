import { useEffect, useRef, useState } from "react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/shared/ui/dialog";
import type { RosterRow } from "../../../lib/roster";
import type { useAdminCommands } from "../../../ui/useAdminCommands";
import { awaitSettingsAck } from "./awaitSettingsAck";

/** Removal is explicit and never treated as complete on relay acceptance alone. */
export function RemoveCard({
  row,
  admin,
  channelCount,
  disabled,
  onRemoved,
  hidden,
  requestedAction,
  onRequestHandled,
}: {
  row: RosterRow;
  admin: ReturnType<typeof useAdminCommands>;
  channelCount: number;
  disabled: boolean;
  onRemoved: () => void;
  hidden?: boolean;
  requestedAction?: "delete" | "unregister" | null;
  onRequestHandled?: () => void;
}) {
  const [action, setAction] = useState<"delete" | "unregister" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const ackRef = useRef(admin.acks);
  ackRef.current = admin.acks;
  useEffect(() => {
    if (!requestedAction) return;
    setAction(requestedAction);
    setError(null);
    onRequestHandled?.();
  }, [requestedAction, onRequestHandled]);
  const remove = async () => {
    if (!action || disabled || busy || uncertain || row.machines.length !== 1)
      return;
    setBusy(true);
    setError(null);
    try {
      const requestId = await admin.send(
        {
          action,
          request: {
            pubkey: row.pubkey,
            ...(action === "delete" ? { forceRemoteDelete: true } : {}),
          },
        },
        `${action === "delete" ? "Delete" : "Unregister"} ${row.name}`,
        { target: row.machines[0] },
      );
      if (!requestId) {
        setError("The relay did not accept the command.");
        return;
      }
      const ack = await awaitSettingsAck(requestId, () => ackRef.current);
      if (!ack.ok) {
        setError(ack.error ?? "The desktop did not apply the command.");
        setUncertain(ack.timedOut === true);
        return;
      }
      setAction(null);
      onRemoved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not remove the agent.",
      );
    } finally {
      setBusy(false);
    }
  };
  const count = `${channelCount} ${channelCount === 1 ? "channel" : "channels"}`;
  return (
    <section
      className={`${hidden ? "hidden" : ""} space-y-4 rounded-xl border border-coral-line bg-card p-4`}
      data-testid="remove-card"
    >
      <h2 className="text-sm font-semibold">Remove {row.name}</h2>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Unregister takes it off the relay. The key and settings stay on Buzz
          Desktop so you can bring it back.
        </p>
        <Button
          variant="outline"
          className="min-h-11 shrink-0"
          disabled={disabled || busy || uncertain}
          onClick={() => {
            setError(null);
            setAction("unregister");
          }}
        >
          Unregister
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Delete stops it, removes it from {count} and destroys its key. This
          cannot be undone.
        </p>
        <Button
          variant="outline"
          className="min-h-11 shrink-0 border-coral-line text-coral-ink"
          disabled={disabled || busy || uncertain}
          onClick={() => {
            setError(null);
            setAction("delete");
          }}
        >
          Delete…
        </Button>
      </div>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogTitle>
            {action === "delete" ? "Delete" : "Unregister"} {row.name}?
          </DialogTitle>
          <DialogDescription>
            {action === "delete"
              ? `Stops this agent, removes it from ${count}, and permanently destroys its key. This cannot be undone.`
              : "The key and settings stay on Buzz Desktop. This only removes the relay registration."}
          </DialogDescription>
          {busy && (
            <p role="status" className="text-sm">
              Waiting for Buzz Desktop…
            </p>
          )}
          {error && (
            <p role="alert" className="break-words text-sm text-coral-ink">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={disabled || busy || uncertain}
              onClick={() => void remove()}
            >
              {action === "delete" ? "Confirm delete" : "Confirm unregister"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

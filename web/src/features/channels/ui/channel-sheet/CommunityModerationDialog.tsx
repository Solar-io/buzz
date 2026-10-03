import { useState } from "react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";

export function CommunityModerationDialog({
  action,
  label,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  action: "timeout" | "ban";
  label: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (seconds: number, reason: string) => void;
}) {
  const [seconds, setSeconds] = useState("86400");
  const [reason, setReason] = useState("");
  const verb = action === "ban" ? "Ban" : "Time out";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{verb} from community</DialogTitle>
          <DialogDescription className="break-words">
            {label} will{" "}
            {action === "ban"
              ? "lose access to the whole community"
              : "be unable to post anywhere in the community for this duration"}
            . The reason is recorded in the audit trail.
          </DialogDescription>
        </DialogHeader>
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && reason.trim()) onSubmit(Number(seconds), reason);
          }}
        >
          {action === "timeout" && (
            <label className="block space-y-1 text-sm">
              Duration
              <select
                aria-label="Timeout duration"
                className="block min-h-11 w-full rounded-lg border border-border bg-card px-3 text-sm"
                disabled={busy}
                value={seconds}
                onChange={(event) => setSeconds(event.target.value)}
              >
                <option value="3600">1 hour</option>
                <option value="86400">24 hours</option>
                <option value="604800">7 days</option>
              </select>
            </label>
          )}
          <label
            htmlFor="community-moderation-reason"
            className="block space-y-1 text-sm"
          >
            Reason
            <Textarea
              id="community-moderation-reason"
              aria-label="Reason"
              required
              maxLength={1000}
              disabled={busy}
              className="resize-y"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="break-words text-sm text-coral-ink">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="min-h-11"
              disabled={busy || !reason.trim()}
            >
              {busy ? "Applying…" : `${verb} from community`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

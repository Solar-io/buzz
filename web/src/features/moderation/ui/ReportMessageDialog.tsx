import { Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";
import { useModerationActions } from "../hooks.ts";
import { REPORT_CATEGORIES, type ReportType } from "../lib/reportEvent.ts";

/**
 * Member-facing NIP-56 report flow: pick a category, optionally add context,
 * submit. The relay queues the report for this community's moderators and
 * never fans it out, so there is no optimistic row and nothing to reconcile —
 * the toast is the whole feedback loop.
 *
 * Self-contained by design (it wires its own publish action rather than taking
 * a callback), so the action bar only has to know the two target ids.
 */
export function ReportMessageDialog({
  open,
  onOpenChange,
  authorPubkey,
  eventId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Author of the reported message — the `p` tag target. */
  authorPubkey: string;
  /** Reported message event id — the `e` tag target. */
  eventId: string;
}) {
  const { submitReport } = useModerationActions();
  const [category, setCategory] = useState<ReportType | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Reset each time the dialog opens so one report's selection never leaks
  // into the next.
  useEffect(() => {
    if (open) {
      setCategory(null);
      setNote("");
      setSubmitting(false);
    }
  }, [open]);

  const submit = async () => {
    if (!category || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await submitReport({
        authorPubkey,
        eventId,
        reportType: category,
        note: note.trim() || undefined,
      });
      toast.success("Report submitted to community moderators");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to submit report",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[420px]"
        data-testid="report-message-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="h-4 w-4" aria-hidden="true" />
            Report message
          </DialogTitle>
          <DialogDescription>
            Reports go to this community's moderators for review. The author is
            not told who reported them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          {REPORT_CATEGORIES.map((item) => (
            <Button
              key={item.value}
              type="button"
              variant={category === item.value ? "default" : "outline"}
              className="justify-start"
              aria-pressed={category === item.value}
              data-testid={`report-category-${item.value}`}
              disabled={submitting}
              onClick={() => setCategory(item.value)}
            >
              {item.label}
            </Button>
          ))}
        </div>

        <div className="space-y-2">
          <label
            htmlFor="report-note"
            className="text-sm font-medium text-muted-foreground"
          >
            Additional context (optional)
          </label>
          <Textarea
            id="report-note"
            data-testid="report-note"
            placeholder="Add anything that helps moderators…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            className="resize-none"
            disabled={submitting}
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            data-testid="report-submit"
            onClick={() => void submit()}
            disabled={!category || submitting}
          >
            {submitting ? "Submitting…" : "Submit report"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { Check, Clock, CircleDashed, SkipForward, X } from "lucide-react";

import { Badge, type BadgeProps } from "@/shared/ui/badge";
import { statusLabel, statusTone } from "../lib/workflowRuns.ts";

const TONE_VARIANT: Record<string, BadgeProps["variant"]> = {
  success: "success",
  failure: "destructive",
  active: "info",
  waiting: "warning",
  muted: "secondary",
};

/** Pill for a run or step status, coloured by the status's tone. */
export function WorkflowStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={TONE_VARIANT[statusTone(status)] ?? "secondary"}>
      {statusLabel(status)}
    </Badge>
  );
}

/**
 * Glyph for a step status.
 *
 * The badge already carries the status in words; this repeats it as shape as
 * well as colour, so the trace stays readable without relying on hue alone.
 */
export function WorkflowStatusIcon({ status }: { status: string }) {
  const className = "h-4 w-4 shrink-0";
  switch (statusTone(status)) {
    case "success":
      return <Check aria-hidden className={`${className} text-emerald-500`} />;
    case "failure":
      return <X aria-hidden className={`${className} text-destructive`} />;
    case "waiting":
      return <Clock aria-hidden className={`${className} text-amber-500`} />;
    case "active":
      return (
        <CircleDashed
          aria-hidden
          className={`${className} animate-spin text-blue-500 [animation-duration:2.4s]`}
        />
      );
    default:
      return (
        <SkipForward
          aria-hidden
          className={`${className} text-muted-foreground`}
        />
      );
  }
}

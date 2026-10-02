import { Check, LoaderCircle } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

/** Receipt states: success is reserved for a desktop acknowledgement. */
export type SaveBarState =
  | { status: "idle" }
  | { status: "sending"; machines: readonly string[] }
  | { status: "saved"; machines: readonly string[]; savedAt: number }
  | {
      status: "error";
      uncertain?: boolean;
      errors: readonly {
        machine: string;
        agentName?: string;
        error: string;
        timedOut?: boolean;
      }[];
    };

/** Plain-text summaries and explicit draft/save actions. */
export interface SaveBarProps {
  summary: string;
  changes: readonly string[];
  effectSummary: string;
  state: SaveBarState;
  onSave: () => void;
  onDiscard: () => void;
  onUndo?: () => void;
  onEdit?: () => void;
  disabled?: boolean;
}

/** Persistent draft/ack receipt. Only a desktop ack may render Saved. */
export function SaveBar({
  summary,
  changes,
  effectSummary,
  state,
  onSave,
  onDiscard,
  onUndo,
  onEdit,
  disabled,
}: SaveBarProps) {
  if (changes.length === 0 && state.status === "idle") return null;
  const sending = state.status === "sending";
  return (
    <section
      aria-label="Settings changes"
      aria-busy={sending}
      className={cn(
        "sticky bottom-4 z-20 mt-5 flex min-w-0 flex-wrap items-center gap-3 rounded-xl border bg-card p-3 shadow-xl",
        state.status === "error"
          ? "border-coral-line"
          : state.status === "saved"
            ? "border-leaf-line"
            : "border-honey-line",
      )}
    >
      <div
        className="min-w-0 flex-1 basis-48 break-words"
        aria-live="polite"
        aria-atomic="true"
      >
        {state.status === "idle" && (
          <p className="text-sm font-semibold">{summary}</p>
        )}
        {sending && (
          <p className="flex items-center gap-2 text-sm font-semibold text-honey-ink">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            Sending to {state.machines.join(", ")}…
          </p>
        )}
        {state.status === "saved" && (
          <p className="flex items-center gap-2 text-sm font-semibold text-leaf-ink">
            <Check aria-hidden="true" className="size-4" />
            Saved on {state.machines.join(", ")} ·{" "}
            {new Date(state.savedAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        )}
        {state.status === "error" &&
          state.errors.map((error) => (
            <div key={`${error.machine}:${error.agentName ?? ""}`}>
              {!error.timedOut && (
                <p className="text-sm font-semibold text-coral-ink">
                  {error.machine} refused the change
                  {error.agentName ? ` to ${error.agentName}` : ""}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-coral-ink">
                {error.error}
              </p>
            </div>
          ))}
        {changes.length > 0 && (
          <ul className="mt-1 space-y-1 text-xs text-foreground">
            {changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
        {effectSummary && (
          <p className="mt-1 text-xs text-muted-foreground">{effectSummary}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {state.status === "saved" ? (
          onUndo && (
            <Button variant="outline" onClick={onUndo} disabled={disabled}>
              Undo
            </Button>
          )
        ) : state.status === "error" && onEdit ? (
          <Button
            variant="outline"
            onClick={onEdit}
            disabled={disabled || state.uncertain}
          >
            Edit
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={onDiscard}
              disabled={disabled || sending}
            >
              Discard
            </Button>
            <Button
              onClick={onSave}
              disabled={
                disabled ||
                sending ||
                changes.length === 0 ||
                (state.status === "error" && state.uncertain)
              }
            >
              Save changes
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

import { CornerUpLeft, Pencil, X } from "lucide-react";
import { replyExcerpt } from "../lib/replyExcerpt.ts";

/**
 * The banner above the composer input.
 *
 * The web client showed one grey line — "Replying in thread — Esc clears" —
 * which named neither the person nor the message. This is the desktop's
 * `ComposerReplyEditBanner`: the target author in foreground weight, a
 * one-line excerpt of what they said underneath, and an explicit dismiss
 * control next to the Esc hint (a keyboard-only affordance is not a control).
 *
 * Edit takes precedence over reply, matching the desktop's own ordering.
 */
export function ComposerReplyBanner({
  author,
  body,
  onDismiss,
}: {
  author: string;
  /** Raw message content — excerpted here, never rendered as markdown. */
  body?: string;
  onDismiss: () => void;
}) {
  const excerpt = body ? replyExcerpt(body) : "";
  return (
    <div
      data-testid="composer-reply-banner"
      className="mb-1.5 flex items-start gap-2 rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
    >
      <CornerUpLeft aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground">
          Replying to {author}
        </p>
        {excerpt ? (
          <p
            className="truncate text-muted-foreground/80"
            data-testid="composer-reply-excerpt"
          >
            {excerpt}
          </p>
        ) : null}
      </div>
      <span className="shrink-0 self-center text-2xs uppercase tracking-wide text-muted-foreground/70">
        Esc
      </span>
      <button
        type="button"
        aria-label="Cancel reply"
        title="Cancel reply"
        className="-mr-1 shrink-0 self-center rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onDismiss}
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

/** The edit-mode counterpart, same shape so the composer does not jump. */
export function ComposerEditBanner({ onCancel }: { onCancel: () => void }) {
  return (
    <div
      data-testid="composer-edit-banner"
      className="mb-1.5 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
    >
      <Pencil aria-hidden className="h-4 w-4 shrink-0" />
      <p className="min-w-0 flex-1 truncate font-medium text-foreground">
        Editing message
      </p>
      <span className="shrink-0 text-2xs uppercase tracking-wide text-muted-foreground/70">
        Esc
      </span>
      <button
        type="button"
        aria-label="Cancel edit"
        title="Cancel edit"
        className="-mr-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onCancel}
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}

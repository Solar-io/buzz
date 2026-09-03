import { type ReactNode, useState } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * A click-to-reveal spoiler span.
 *
 * Hidden state blurs and blanks the text rather than removing it, so the row
 * keeps its height and revealing does not reflow the conversation around it.
 *
 * Deliberately one-way: once revealed it stays revealed for the life of the
 * row. A re-hide control invites a reader to think the content is now
 * concealed from anyone looking over their shoulder, which it is not — it was
 * on screen. The honest affordance is "you chose to see this".
 *
 * `user-select: none` while hidden stops a select-all from lifting the text
 * straight out of an unopened spoiler.
 */
export function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);

  if (revealed) {
    return <span className="rounded-[3px] bg-muted/40 px-0.5">{children}</span>;
  }

  return (
    <button
      type="button"
      aria-label="Reveal hidden text"
      onClick={(event) => {
        // The span often sits inside a link or a row with its own click
        // target; revealing must not also follow it.
        event.preventDefault();
        event.stopPropagation();
        setRevealed(true);
      }}
      className={cn(
        "cursor-pointer rounded-[3px] bg-foreground/80 px-0.5 align-baseline",
        "text-transparent transition-colors select-none",
        "hover:bg-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </button>
  );
}

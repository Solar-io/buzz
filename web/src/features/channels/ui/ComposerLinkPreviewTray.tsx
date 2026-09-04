import { X } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import type { ComposerPreviewCard } from "../lib/useComposerLinkPreviews.ts";

/**
 * What the author is about to attach to their message.
 *
 * A Buzz link preview is *sender-authored*: the card that appears here is the
 * card every recipient will see, resolved once, now, and shipped inside the
 * event. So it has to be visible before sending, and dismissible — that is the
 * whole reason `["link-preview","none"]` exists on the wire.
 *
 * No image is rendered here on purpose. The stored preview image is a
 * relay blob behind a signed GET, and a transient tray is not worth the extra
 * authenticated fetch per keystroke-settled link; the title and host say what
 * is being attached.
 */
export function ComposerLinkPreviewTray({
  cards,
  onSuppress,
}: {
  cards: ComposerPreviewCard[];
  onSuppress: () => void;
}) {
  if (cards.length === 0) {
    return null;
  }
  return (
    <div
      className="mb-1.5 flex flex-wrap items-center gap-1.5"
      data-testid="composer-link-preview-tray"
    >
      {cards.map((card) => (
        <span
          className={cn(
            "flex min-w-0 max-w-xs items-center gap-1.5 rounded-md border border-border/70 bg-card/60 px-2 py-1",
            card.state === "resolving" && "opacity-60",
          )}
          data-link-preview-state={card.state}
          data-testid="composer-link-preview-card"
          key={card.href}
        >
          <span className="min-w-0 flex-1 truncate text-xs">
            {card.state === "resolving" ? (
              <span className="text-muted-foreground">
                Resolving {hostOf(card.href)}…
              </span>
            ) : (
              <>
                <span className="font-medium">{card.title}</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {card.site || hostOf(card.href)}
                </span>
              </>
            )}
          </span>
        </span>
      ))}
      <button
        aria-label="Send without link previews"
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent/40 hover:text-foreground"
        data-testid="composer-link-preview-suppress"
        onClick={onSuppress}
        title="Send without link previews"
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
        Preview off
      </button>
    </div>
  );
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

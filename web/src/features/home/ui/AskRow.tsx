import { HelpCircle, MessageSquare, AtSign } from "lucide-react";

import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { formatTime } from "@/features/channels/lib/dateFormatters.ts";
import { cn } from "@/shared/lib/cn";
import type { AskItem } from "../lib/askDetection.ts";

/**
 * One ASK row (D-035 follow-on): a decision card addressed to the viewer,
 * still waiting on an answer. Shows what Sam asked the surface for — card
 * title (bold), asking agent (avatar + name), channel/DM label, age, and the
 * recommended option as a preview line. Every row in the list is unanswered,
 * so each carries the unread-dot treatment.
 *
 * Tapping the row is the existing permalink jump (`?c=&m=`), NOT a detail
 * selection: the card lives in its channel timeline (or thread panel), which
 * is where answering happens.
 */
export function AskRow({
  ask,
  channelLabel,
  channelType,
  profiles,
  onOpen,
}: {
  ask: AskItem;
  /** Display name of the ask's channel, already `#`-prefixed for streams. */
  channelLabel: string;
  channelType: AskItem["channelType"];
  profiles: Map<string, Profile>;
  onOpen: () => void;
}) {
  const label = authorLabel(ask.authorPubkey, profiles);
  const isDm = channelType === "dm";
  // Preview: the recommended option when one is marked, else the first
  // option — but only the marked one is STYLED as recommended.
  const recommended = ask.card.options.find(
    (option) => option.recommended === true,
  );
  const preview = recommended ?? ask.card.options[0];
  return (
    <div
      data-testid={`ask-row-${ask.id}`}
      data-unread="true"
      className={cn(
        "rounded-xl transition-colors",
        "hover:bg-muted/60 focus-within:bg-muted/60",
      )}
    >
      <button
        type="button"
        data-testid={`ask-row-open-${ask.id}`}
        onClick={onOpen}
        className={cn(
          "flex w-full gap-3 rounded-xl px-3 py-2 text-left",
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <div className="relative shrink-0 pt-0.5">
          <AuthorAvatar
            pubkey={ask.authorPubkey}
            label={label}
            picture={profiles.get(ask.authorPubkey)?.avatar}
            size="md-sm"
          />
          <span
            data-testid="ask-row-unread-dot"
            aria-hidden
            className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <HelpCircle
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 self-center text-primary"
            />
            <span className="truncate text-sm font-semibold text-foreground">
              {ask.card.title}
            </span>
            <span className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground">
              {isDm ? (
                <MessageSquare aria-hidden className="h-3 w-3 shrink-0" />
              ) : (
                <AtSign aria-hidden className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{channelLabel}</span>
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-2xs text-muted-foreground">
              {formatTime(ask.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            <span className="text-foreground/70">{label}</span> asks
            {preview && (
              <>
                {recommended ? " — Recommended: " : " — "}
                <span
                  className={cn(
                    recommended && "font-medium text-foreground/80",
                  )}
                >
                  {preview.label}
                </span>
              </>
            )}
          </p>
        </div>
      </button>
    </div>
  );
}

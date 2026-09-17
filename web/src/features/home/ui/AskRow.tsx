import { useState } from "react";
import {
  Check,
  HelpCircle,
  MessageSquare,
  AtSign,
  TriangleAlert,
} from "lucide-react";

import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { formatTime } from "@/features/channels/lib/dateFormatters.ts";
import { sendCardAnswer } from "@/features/channels/lib/cardAnswer.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
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
 * selection: the card lives in its channel timeline (or thread panel), where
 * the full card — options, type-your-own, error states — renders.
 *
 * ## Inline one-tap answers
 *
 * The option buttons answer right from the list via `sendCardAnswer`, the
 * same builder the timeline card uses (one implementation of the thread-ref
 * and publish-verdict rules). The state machine mirrors DecisionCard's,
 * including the honest `result.ok` check — publish() RESOLVES `{ok:false}`
 * on a relay rejection. The badge is deliberately NOT cleared here: it clears
 * when the relay echo arrives through the answer REQ and the answered
 * predicate matches, so a badge can never claim less than the relay agreed to
 * store.
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
  const { session } = useRelaySession();
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "sending" }
    | { phase: "sent"; answer: string }
    | { phase: "error"; answer: string; message: string }
  >({ phase: "idle" });
  const label = authorLabel(ask.authorPubkey, profiles);
  const isDm = channelType === "dm";
  // Preview: the recommended option when one is marked, else the first
  // option — but only the marked one is STYLED as recommended.
  const recommended = ask.card.options.find(
    (option) => option.recommended === true,
  );
  const preview = recommended ?? ask.card.options[0];

  async function answer(optionLabel: string) {
    if (state.phase === "sending" || state.phase === "sent") {
      return;
    }
    setState({ phase: "sending" });
    try {
      const result = await sendCardAnswer(session, ask, optionLabel);
      if (!result.ok) {
        setState({
          phase: "error",
          answer: optionLabel,
          message: result.message || "relay rejected the reply",
        });
        return;
      }
      setState({ phase: "sent", answer: optionLabel });
    } catch (error) {
      setState({
        phase: "error",
        answer: optionLabel,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
      {state.phase === "sent" ? (
        <p
          data-testid={`ask-row-answered-${ask.id}`}
          className="mb-2 flex items-center gap-1.5 px-3 text-xs font-medium text-primary"
        >
          <Check className="size-3" aria-hidden />
          You replied: {state.answer}
        </p>
      ) : (
        <div className="mb-2 flex flex-wrap gap-1.5 px-3">
          {ask.card.options.map((option) => (
            <button
              key={option.id}
              type="button"
              data-testid={`ask-row-answer-${ask.id}-${option.id}`}
              disabled={state.phase === "sending"}
              onClick={() => answer(option.label)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs",
                "transition-colors hover:border-primary/50 hover:bg-primary/5",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {option.label}
              {option.recommended === true && (
                <span className="text-2xs font-medium uppercase tracking-wide text-accent-foreground/80">
                  ★
                </span>
              )}
            </button>
          ))}
          {state.phase === "sending" && (
            <span className="self-center text-xs text-muted-foreground/70">
              Sending…
            </span>
          )}
          {state.phase === "error" && (
            <span
              data-testid={`ask-row-error-${ask.id}`}
              className="flex items-center gap-1 text-xs text-destructive"
            >
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              {state.message || "Reply failed"} — try again
            </span>
          )}
        </div>
      )}
    </div>
  );
}

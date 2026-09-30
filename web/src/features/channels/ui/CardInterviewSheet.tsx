import type { ReactNode } from "react";
import { CircleHelp, X } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/shared/ui/sheet";
import {
  interviewView,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import type { DecisionCard } from "../lib/decisionCard.ts";
import { AuthorAvatar } from "./AuthorAvatar.tsx";
import { CardInterview } from "./CardInterview.tsx";

/** Who is asking — the sheet's header (PhoneAsk: "ESP32 asks"). */
export interface CardAsker {
  pubkey: string;
  label: string;
  picture?: string | null;
}

/**
 * The phone answering surface: the SAME {@link CardInterview} body, hosted in
 * a bottom sheet instead of the timeline row (PhoneAsk artboard).
 *
 * This component is a container and nothing else. It holds no interview state
 * and decides nothing about sequencing — one interaction implementation
 * renders in both hosts, so a rule fixed for the desktop stepper is fixed for
 * the phone by construction. What it adds is the header: who is asking, what
 * the interview is called, and a close button a thumb can hit.
 *
 * ## Dismissing is not answering
 *
 * Backdrop tap, Escape, the handle, the ✕ and a downward drag all close the
 * sheet and publish NOTHING; the draft is untouched, so reopening resumes
 * where the user left off. That is the card's "nothing publishes until the
 * user submits" rule seen from the container — a sheet that published on
 * close would hand the agent a half-answer for the price of a stray tap.
 * "Not now, send to Feedback" is the one exit that DOES something, and what
 * it does is file a reminder — still no answer.
 */
export function CardInterviewSheet({
  card,
  state,
  open,
  onOpenChange,
  onChange,
  onSubmit,
  busy,
  onAnswerInChat,
  footer,
  asker,
  onFeedback,
  inFeedback,
}: {
  card: DecisionCard;
  state: CardInterviewState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (next: CardInterviewState) => void;
  /** See `CardInterviewProps.onSubmit` — the state is passed, never re-read. */
  onSubmit: (state: CardInterviewState) => void;
  busy: boolean;
  onAnswerInChat?: () => void;
  /** Publish status (sending / partial / relay refusal), pinned to the foot. */
  footer?: ReactNode;
  /** The card's author; absent where the host has no profile to hand. */
  asker?: CardAsker | null;
  onFeedback?: () => void;
  inFeedback?: boolean;
}) {
  const view = interviewView(card, state);
  // The interview's name is worth a line only when it is not simply the
  // question the sheet is about to show in large type.
  const subtitle =
    view.total > 1 && card.title !== view.question.question
      ? card.title
      : view.total === 1
        ? "1 question"
        : `${view.total} questions`;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-testid="card-interview-sheet"
        onDismiss={() => onOpenChange(false)}
        footer={footer}
        className="rounded-t-3xl bg-card"
      >
        <div className="flex items-center gap-2.5">
          {asker ? (
            <AuthorAvatar
              pubkey={asker.pubkey}
              label={asker.label}
              picture={asker.picture ?? undefined}
              size="sm"
              className="size-7"
            />
          ) : (
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-info-soft text-info-ink">
              <CircleHelp aria-hidden className="size-4" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-base font-bold">
              {asker ? (
                <>
                  <bdi>{asker.label}</bdi> asks
                </>
              ) : (
                "Decision"
              )}
            </SheetTitle>
            <SheetDescription className="truncate font-mono text-2xs">
              <bdi>{subtitle}</bdi>
            </SheetDescription>
          </div>
          <button
            type="button"
            data-testid="card-interview-sheet-close"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="-mr-2.5 grid size-11 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-sunk hover:text-foreground"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <div className="mt-2 pb-2">
          <CardInterview
            card={card}
            state={state}
            onChange={onChange}
            onSubmit={onSubmit}
            busy={busy}
            onAnswerInChat={onAnswerInChat}
            variant="sheet"
            onFeedback={onFeedback}
            inFeedback={inFeedback}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

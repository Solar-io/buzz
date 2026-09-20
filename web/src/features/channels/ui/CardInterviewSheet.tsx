import type { ReactNode } from "react";

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
import { CardInterview } from "./CardInterview.tsx";

/**
 * The phone answering surface: the SAME {@link CardInterview} body, hosted in
 * a bottom sheet instead of the timeline row.
 *
 * This component is a container and nothing else. It holds no interview state
 * and decides nothing about sequencing — one interaction implementation
 * renders in both hosts, so a rule fixed for the desktop stepper is fixed for
 * the phone by construction. The only thing it adds is a title/progress
 * header, which the inline card gets from the row around it.
 *
 * ## Dismissing is not answering
 *
 * Backdrop tap, Escape, the handle and a downward drag all close the sheet and
 * publish NOTHING; the draft is untouched, so reopening resumes where the user
 * left off. That is the card's "nothing publishes until the user submits" rule
 * seen from the container — a sheet that published on close would hand the
 * agent a half-answer for the price of a stray tap.
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
}) {
  const view = interviewView(card, state);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-testid="card-interview-sheet"
        onDismiss={() => onOpenChange(false)}
        footer={footer}
      >
        <SheetTitle>
          <bdi className="min-w-0 break-words">
            {card.title || view.question.question}
          </bdi>
        </SheetTitle>
        <SheetDescription>
          {view.total === 1
            ? "1 question"
            : `${view.total} questions · ${view.answeredCount} answered`}
        </SheetDescription>
        <div className="mt-2">
          <CardInterview
            card={card}
            state={state}
            onChange={onChange}
            onSubmit={onSubmit}
            busy={busy}
            onAnswerInChat={onAnswerInChat}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

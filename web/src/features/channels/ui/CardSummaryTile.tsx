import { cn } from "@/shared/lib/cn";
import {
  interviewView,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import type { DecisionCard } from "../lib/decisionCard.ts";

/**
 * What a decision card looks like IN THE TIMELINE on a phone: a tile, not a
 * stepper.
 *
 * The tile is deliberately a fixed, small height — title, question count, a
 * progress bar and one full-width button — because the row it occupies lives
 * inside a bottom-pinned virtualized scroller where every pixel of growth is
 * taken off the top of the card (measured at 390×844: an inline card grew to
 * 1071 px in a 617 px scroller and put its own title 358 px above the
 * viewport). A tile cannot grow when a question is answered, because
 * answering does not happen here — it happens in the sheet.
 *
 * Author text is rendered inside `<bdi>` for the same reason `CardInterview`
 * does it: the wire format passes RTL overrides through verbatim, and
 * isolation is the render-phase half of that decision.
 */
export function CardSummaryTile({
  card,
  state,
  onOpen,
  busy,
}: {
  card: DecisionCard;
  /** The live draft, so the button can say "Resume" and mean it. */
  state: CardInterviewState;
  onOpen: () => void;
  busy: boolean;
}) {
  const view = interviewView(card, state);
  const started = view.answeredCount > 0;
  return (
    <div data-testid="card-summary-tile" className="flex flex-col gap-2">
      <p className="min-w-0 break-words text-sm font-semibold leading-snug">
        <bdi className="min-w-0 break-words">
          {card.title || view.question.question}
        </bdi>
      </p>

      <div className="flex flex-col gap-1">
        <p
          data-testid="card-summary-progress"
          className="text-xs text-muted-foreground"
        >
          {view.total === 1
            ? "1 question"
            : `${view.total} questions · ${view.answeredCount} answered`}
        </p>
        {view.total > 1 && (
          <ol className="flex min-w-0 items-center gap-1" aria-hidden>
            {card.questions.map((question, index) => (
              <li key={question.id} className="flex min-w-0 flex-1">
                <span
                  className={cn(
                    "h-1.5 w-full rounded-full",
                    index < view.answeredCount
                      ? "bg-primary/60"
                      : "bg-muted-foreground/20",
                  )}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      <button
        type="button"
        data-testid="card-summary-answer"
        disabled={busy}
        onClick={onOpen}
        className="flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {started ? `Resume — ${view.answeredCount} of ${view.total}` : "Answer"}
      </button>
    </div>
  );
}

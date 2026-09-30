import { cn } from "@/shared/lib/cn";
import {
  interviewView,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import type { DecisionCard } from "../lib/decisionCard.ts";

/**
 * What a decision card looks like IN THE TIMELINE on a phone: a tile, not a
 * stepper. The card's header bar (in `DecisionCard`) carries the title; the
 * tile is the count, a progress bar and one full-width button.
 *
 * The tile is deliberately a fixed, small height because the row it occupies
 * lives inside a bottom-pinned virtualized scroller where every pixel of
 * growth is taken off the top of the card (measured at 390×844: an inline
 * card grew to 1071 px in a 617 px scroller and put its own title 358 px
 * above the viewport). A tile cannot grow when a question is answered,
 * because answering does not happen here — it happens in the sheet.
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
      <div className="flex flex-col gap-1.5">
        <p
          data-testid="card-summary-progress"
          className="font-mono text-2xs text-muted-foreground"
        >
          {view.total === 1
            ? "1 question"
            : `${view.total} questions · ${view.answeredCount} answered`}
        </p>
        {view.total > 1 && (
          <ol
            className="grid min-w-0 gap-1"
            style={{
              gridTemplateColumns: `repeat(${view.total}, minmax(0, 1fr))`,
            }}
            aria-hidden
          >
            {card.questions.map((question, index) => (
              <li
                key={question.id}
                className={cn(
                  "h-1 rounded-full",
                  index < view.answeredCount ? "bg-foreground" : "bg-border",
                )}
              />
            ))}
          </ol>
        )}
      </div>

      <button
        type="button"
        data-testid="card-summary-answer"
        disabled={busy}
        onClick={onOpen}
        className="flex h-11 w-full items-center justify-center rounded-[10px] bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {started ? `Resume — ${view.answeredCount} of ${view.total}` : "Answer"}
      </button>
    </div>
  );
}

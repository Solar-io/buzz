import { Check, Pencil } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import {
  answerSummary,
  back,
  interviewView,
  isAnswered,
  skipTo,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import type { DecisionCard, DecisionCardOption } from "../lib/decisionCard.ts";

/**
 * The pieces of the decision-card stepper that both hosts draw — the inline
 * card on a desktop row and the phone sheet (Message and PhoneAsk artboards).
 * Presentation only: every transition is a `cardInterview.ts` function the
 * caller hands in.
 */

/**
 * One author-supplied string. Bidi-isolated, as `CardInterview` documents:
 * a stray U+202E inside a label may reorder that label and nothing around it.
 */
export function AuthorText({ children }: { children: string }) {
  return <bdi className="min-w-0 break-words">{children}</bdi>;
}

export type InterviewVariant = "inline" | "sheet";

/**
 * "Question N of M" plus one segment per question — answered segments in
 * ink, the current one in the work colour, the rest a hairline.
 *
 * The segments are the revisit affordance: each is tappable and carries its
 * answer in the label, so changing an earlier answer costs one tap. The
 * count is announced politely — advancing is otherwise a silent change.
 */
export function ProgressRail({
  card,
  state,
  onJump,
  busy,
  variant,
}: {
  card: DecisionCard;
  state: CardInterviewState;
  onJump: (next: CardInterviewState) => void;
  busy: boolean;
  variant: InterviewVariant;
}) {
  const view = interviewView(card, state);
  const count = (
    <p
      data-testid="card-interview-progress"
      aria-live="polite"
      className={cn(
        "font-mono text-2xs text-muted-foreground",
        variant === "sheet" ? "mt-1.5" : "mb-1.5",
      )}
    >
      Question {view.index + 1} of {view.total}
      {view.answeredCount > 0 && ` · ${view.answeredCount} answered`}
    </p>
  );
  return (
    <div className="flex flex-col">
      {variant === "inline" && count}
      <ol
        className="grid min-w-0 gap-1"
        style={{
          gridTemplateColumns: `repeat(${card.questions.length}, minmax(0, 1fr))`,
        }}
      >
        {card.questions.map((question, index) => {
          const answered = isAnswered(state, question.id);
          const active = index === view.index;
          const summary = answerSummary(question, state.answers[question.id]);
          return (
            <li key={question.id} className="flex min-w-0">
              <button
                type="button"
                data-testid={`card-interview-step-${index}`}
                aria-current={active ? "step" : undefined}
                aria-label={
                  answered
                    ? `Question ${index + 1}, answered: ${summary}`
                    : `Question ${index + 1}, not answered`
                }
                title={summary || undefined}
                disabled={busy}
                onClick={() => onJump(skipTo(card, state, index))}
                // A 4 px bar inside a 16 px hit area: thin to look at, not
                // to aim at.
                className="group flex h-4 w-full items-center disabled:cursor-not-allowed"
              >
                <span
                  className={cn(
                    "h-1 w-full rounded-full transition-colors",
                    active
                      ? "bg-work"
                      : answered
                        ? "bg-foreground group-hover:bg-foreground/70"
                        : "bg-border group-hover:bg-line-2",
                  )}
                />
              </button>
            </li>
          );
        })}
      </ol>
      {variant === "sheet" && count}
      {variant === "inline" &&
        card.questions.some((question) => question.header) && (
          <p className="mt-0.5 truncate text-2xs text-muted-foreground">
            <AuthorText>{view.question.header ?? ""}</AuthorText>
          </p>
        )}
    </div>
  );
}

/**
 * The answer just given, one tap from being changed (PhoneAsk: "Language:
 * English · Edit"). Only in the sheet, where the question it answers has
 * scrolled away with the advance.
 */
export function PreviousAnswer({
  card,
  state,
  onChange,
  busy,
}: {
  card: DecisionCard;
  state: CardInterviewState;
  onChange: (next: CardInterviewState) => void;
  busy: boolean;
}) {
  const previous = card.questions[state.index - 1];
  if (!previous || !isAnswered(state, previous.id)) {
    return null;
  }
  const summary = answerSummary(previous, state.answers[previous.id]);
  return (
    <button
      type="button"
      data-testid="card-interview-previous"
      disabled={busy}
      onClick={() => onChange(back(state))}
      className="flex min-h-10 w-full items-center gap-2 rounded-[10px] bg-sunk px-3 text-left text-sm text-ink-2 disabled:opacity-60"
    >
      <Check aria-hidden className="size-3.75 shrink-0 text-leaf-ink" />
      <span className="min-w-0 truncate">
        <AuthorText>{previous.header ?? previous.question}</AuthorText>:{" "}
        <b className="font-semibold text-foreground">
          <AuthorText>{summary}</AuthorText>
        </b>
      </span>
      <span className="ml-auto shrink-0 text-xs font-semibold text-info-ink">
        Edit
      </span>
    </button>
  );
}

// A radio in a radiogroup (single) or a checkbox (multi): the state is
// aria-checked either way, which is what a screen reader announces.
function optionRole(multi: boolean, active: boolean) {
  return { role: multi ? "checkbox" : "radio", "aria-checked": active };
}

/**
 * One option: a radio (single) or checkbox (multi) mark, the label, its
 * description and the Recommended pill. `min-h-11` is the touch floor — a
 * long label grows the row rather than clipping.
 */
export function OptionRow({
  option,
  multi,
  active,
  busy,
  variant,
  onPick,
}: {
  option: DecisionCardOption;
  multi: boolean;
  active: boolean;
  busy: boolean;
  variant: InterviewVariant;
  onPick: () => void;
}) {
  const sheet = variant === "sheet";
  return (
    <button
      type="button"
      data-testid={`card-interview-option-${option.id}`}
      {...optionRole(multi, active)}
      disabled={busy}
      onClick={onPick}
      className={cn(
        "flex min-h-11 w-full items-start overflow-hidden text-left",
        sheet
          ? "gap-3 rounded-xl px-3.5 py-3"
          : "gap-2.5 rounded-[10px] px-3 py-2",
        "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        "disabled:cursor-not-allowed disabled:opacity-60",
        // The selected row takes a 2 px ink border; the inset shadow draws
        // the second pixel so the row does not shift by one when chosen.
        active
          ? "border border-foreground bg-sunk shadow-[inset_0_0_0_1px_hsl(var(--foreground))]"
          : "border border-border bg-card hover:border-line-2 hover:bg-sunk",
      )}
    >
      <Mark multi={multi} active={active} sheet={sheet} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5",
            sheet ? "text-base font-semibold" : "text-sm font-medium",
          )}
        >
          <span className="min-w-0 break-words">
            <AuthorText>{option.label}</AuthorText>
          </span>
          {option.recommended === true && (
            <span
              data-testid="decision-card-recommended"
              className="shrink-0 rounded-full bg-honey-soft px-1.5 font-mono text-badge font-semibold uppercase tracking-wide text-honey-ink"
            >
              Recommended
            </span>
          )}
        </span>
        {option.description && (
          <span
            className={cn(
              "mt-0.5 min-w-0 break-words leading-snug text-muted-foreground",
              sheet ? "text-sm" : "text-xs",
            )}
          >
            <AuthorText>{option.description}</AuthorText>
          </span>
        )}
      </span>
    </button>
  );
}

/** "Something else…": the typed-answer escape hatch, as an empty option. */
export function SomethingElseRow({
  busy,
  variant,
  onOpen,
}: {
  busy: boolean;
  variant: InterviewVariant;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="card-interview-something-else"
      disabled={busy}
      onClick={onOpen}
      className={cn(
        "flex min-h-11 w-full items-center gap-2.5 border border-dashed border-line-2 bg-transparent text-left text-muted-foreground hover:text-foreground disabled:opacity-60",
        variant === "sheet"
          ? "min-h-12 rounded-xl px-3.5 text-base"
          : "rounded-[10px] px-3 text-sm",
      )}
    >
      <Pencil aria-hidden className="size-3.5 shrink-0" />
      Something else…
    </button>
  );
}

function Mark({
  multi,
  active,
  sheet,
}: {
  multi: boolean;
  active: boolean;
  sheet: boolean;
}) {
  const size = sheet ? "size-5" : "size-4";
  if (multi) {
    return (
      <span
        aria-hidden
        className={cn(
          "mt-0.5 grid shrink-0 place-items-center rounded-[5px] border-2",
          size,
          active
            ? "border-foreground bg-foreground text-background"
            : "border-line-2",
        )}
      >
        {active && <Check className="size-3" strokeWidth={3} />}
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 grid shrink-0 place-items-center rounded-full border-2",
        size,
        active ? "border-foreground" : "border-line-2",
      )}
    >
      <span
        className={cn(
          "rounded-full",
          sheet ? "size-2.5" : "size-2",
          active ? "bg-foreground" : "bg-transparent",
        )}
      />
    </span>
  );
}

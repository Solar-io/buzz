import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, CornerDownLeft, Pencil } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import {
  answerSummary,
  back,
  commitMultiSelect,
  interviewView,
  isAnswered,
  select,
  setNote,
  skipTo,
  toggle,
  typeAnswer,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import { ANSWER_LIMITS } from "../lib/cardAnswerTag.ts";
import type { DecisionCard } from "../lib/decisionCard.ts";

/**
 * The decision-card stepper BODY: progress, one question, its options, the
 * typed-answer escape hatch and the interview note.
 *
 * It owns no state and no IO. `DecisionCard.tsx` holds the
 * {@link CardInterviewState} (so the draft writer and the publish state
 * machine see every transition) and this component turns it into pixels and
 * events. The sequencing rules all live in `cardInterview.ts`; nothing here
 * decides what "next" means.
 *
 * A v1 card takes this path unchanged — it is an interview of length one, so
 * the progress rail collapses to nothing, the question heading is the card's
 * title, and what renders is the v1 card. There is deliberately no branch on
 * `card.v`: one parser, one renderer, and a v2 payload is never a second code
 * path.
 *
 * ## Author text is BIDI-ISOLATED, and that is this layer's job
 *
 * The wire format deliberately does not strip legal-but-display-hostile
 * characters — RTL overrides (U+202E), zero-width joiners, combining marks —
 * because they are author text and a format has no business rewriting it
 * (`decisionCard.ts`). It defers the answer to the render phase, which is
 * here. Every author-supplied string (title, question, body, option label,
 * description, header) is rendered inside a `<bdi>`, whose default
 * `unicode-bidi: isolate` closes the directional run at the element boundary:
 * a stray U+202E inside an option label can reorder that label and cannot
 * reach the button around it, the question above it or the chrome beside it.
 *
 * Two things ride along with it. Author text is rendered as TEXT, never
 * markdown, so a crafted label cannot inject a link into the confirmed state
 * (v1's rule, kept). And every author string sits in a `break-words`,
 * `overflow-hidden` box, so a long combining-mark run makes a tall row rather
 * than an escaped one.
 */

/** One author-supplied string. See the bidi note above — do not inline this. */
function AuthorText({ children }: { children: string }) {
  return <bdi className="min-w-0 break-words">{children}</bdi>;
}

export interface CardInterviewProps {
  card: DecisionCard;
  state: CardInterviewState;
  onChange: (next: CardInterviewState) => void;
  /**
   * Publish the given state. The state is passed EXPLICITLY, never read back
   * out of a ref by the host: auto-submit fires inside the same handler that
   * answered the last question, and `setState` has not re-rendered by then —
   * a host reading its own latest-state ref publishes the interview one
   * answer short, every time, and says "Answered 3 of 4" about a completed
   * one. Measured, not theorised (five red tests on the first wiring).
   *
   * Whether this closes the interview is the ANSWER BUILDER's to derive, not
   * this component's to assert; there is deliberately no `partial` flag here.
   */
  onSubmit: (state: CardInterviewState) => void;
  /** Disabled while a publish is in flight. */
  busy: boolean;
  /** Footer escape hatch; absent where replying in chat is not a navigation. */
  onAnswerInChat?: () => void;
}

export function CardInterview({
  card,
  state,
  onChange,
  onSubmit,
  busy,
  onAnswerInChat,
}: CardInterviewProps) {
  const view = interviewView(card, state);
  const question = view.question;
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const typedRef = useRef<HTMLInputElement | null>(null);

  // A new question gets a closed, empty text box. Keyed on the question id
  // rather than the index so revisiting question 2 clears what was typed for
  // question 3 — an index would collide across cards in the same timeline.
  const lastQuestionId = useRef(question.id);
  useEffect(() => {
    if (lastQuestionId.current !== question.id) {
      lastQuestionId.current = question.id;
      setTyping(false);
      setDraft("");
    }
  }, [question.id]);

  useEffect(() => {
    if (typing) {
      typedRef.current?.focus();
    }
  }, [typing]);

  /**
   * Answering the LAST open question completes the interview, and a complete
   * interview auto-submits — Sam's flow is answer-and-advance, so there is no
   * terminal confirm tap. The check is on the state the transition PRODUCED,
   * never on the one it started from.
   */
  function apply(next: CardInterviewState) {
    onChange(next);
    if (interviewView(card, next).isComplete) {
      onSubmit(next);
    }
  }

  function submitTyped() {
    const text = draft.trim();
    if (text.length === 0) {
      return;
    }
    apply(typeAnswer(card, state, question.id, draft));
  }

  const multi = question.multiSelect;
  const chosen = new Set(view.current?.optionIds ?? []);
  const selectedCount = chosen.size;

  return (
    <div data-testid="card-interview" className="flex flex-col gap-2">
      {view.total > 1 && (
        <ProgressRail card={card} state={state} onJump={onChange} busy={busy} />
      )}

      <div className="flex items-start gap-1.5">
        {view.canGoBack && (
          <button
            type="button"
            data-testid="card-interview-back"
            aria-label="Previous question"
            disabled={busy}
            onClick={() => onChange(back(state))}
            className="-ml-1 mt-px flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
        )}
        <p className="min-w-0 text-sm font-bold leading-snug">
          <AuthorText>{question.question || card.title}</AuthorText>
        </p>
      </div>

      {question.body && (
        <p className="min-w-0 break-words text-sm leading-snug text-muted-foreground">
          <AuthorText>{question.body}</AuthorText>
        </p>
      )}
      {view.index === 0 && card.body && (
        <p className="min-w-0 break-words text-sm leading-snug text-muted-foreground">
          <AuthorText>{card.body}</AuthorText>
        </p>
      )}

      {/* The typed-answer box sits ABOVE the option stack: on a phone the
          keyboard comes up from the bottom, and an input under the options
          would be the thing it covers. */}
      {typing && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            submitTyped();
          }}
        >
          <input
            ref={typedRef}
            data-testid="card-interview-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy}
            placeholder="Your own answer…"
            aria-label={`Your own answer to: ${question.question}`}
            // Bounded like an option LABEL, not like the interview note:
            // typing must not smuggle in more than choosing could, and the
            // answer builder refuses anything past this.
            maxLength={ANSWER_LIMITS.maxTextChars}
            className="h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary/50"
          />
          <button
            type="submit"
            data-testid="card-interview-send-typed"
            disabled={busy || draft.trim().length === 0}
            aria-label="Send your own answer"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CornerDownLeft className="size-4" aria-hidden />
          </button>
        </form>
      )}

      <fieldset className="flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="sr-only">{question.question}</legend>
        {question.options.map((option) => {
          const active = chosen.has(option.id);
          return (
            <button
              key={option.id}
              type="button"
              data-testid={`card-interview-option-${option.id}`}
              aria-pressed={multi ? active : undefined}
              disabled={busy}
              onClick={() =>
                multi
                  ? onChange(toggle(card, state, question.id, option.id))
                  : apply(select(card, state, question.id, option.id))
              }
              className={cn(
                // 2.75rem — the touch-target floor, which is why this is
                // min-h and not a fixed height: a long label grows the row.
                "flex min-h-11 w-full items-center gap-2 overflow-hidden rounded-lg border bg-background px-3 py-2 text-left text-sm",
                "transition-colors hover:border-primary/50 hover:bg-primary/5",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                "disabled:cursor-not-allowed disabled:opacity-60",
                active && "border-primary bg-primary/10",
              )}
            >
              {multi && (
                <span
                  aria-hidden
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40",
                  )}
                >
                  {active && <Check className="size-3" />}
                </span>
              )}
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="min-w-0 break-words">
                  <AuthorText>{option.label}</AuthorText>
                </span>
                {option.description && (
                  <span className="min-w-0 break-words text-xs text-muted-foreground">
                    <AuthorText>{option.description}</AuthorText>
                  </span>
                )}
              </span>
              {option.recommended === true && (
                <span
                  data-testid="decision-card-recommended"
                  className="ml-auto shrink-0 rounded bg-accent/50 px-1.5 py-0.5 text-badge font-medium uppercase tracking-wide text-accent-foreground/80"
                >
                  Recommended
                </span>
              )}
            </button>
          );
        })}

        {!typing && (
          <button
            type="button"
            data-testid="card-interview-something-else"
            disabled={busy}
            onClick={() => setTyping(true)}
            className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-dashed bg-background px-3 py-2 text-left text-sm text-muted-foreground hover:border-primary/50 hover:text-foreground disabled:opacity-60"
          >
            <Pencil className="size-3.5 shrink-0" aria-hidden />
            Something else…
          </button>
        )}
      </fieldset>

      {multi && (
        <button
          type="button"
          data-testid="card-interview-continue"
          disabled={busy || selectedCount === 0}
          onClick={() => apply(commitMultiSelect(card, state, question.id))}
          className="flex min-h-11 w-full items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {selectedCount === 0
            ? "Choose at least one"
            : `Continue (${selectedCount} selected)`}
        </button>
      )}

      {/* The interview-level note is offered on the LAST question only — it
          is the closest analogue to Claude Code's freeform `response`, and
          asking for it on every question would read as a fifth question. */}
      {view.total > 1 && view.index === view.total - 1 && (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Anything else?
          <input
            data-testid="card-interview-note"
            value={state.note}
            onChange={(event) => onChange(setNote(state, event.target.value))}
            disabled={busy}
            placeholder="Optional note for the whole interview"
            maxLength={ANSWER_LIMITS.maxNoteChars}
            className="h-8 min-w-0 rounded-lg border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary/50"
          />
        </label>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {view.canSendPartial && (
          <button
            type="button"
            data-testid="card-interview-send-partial"
            disabled={busy}
            onClick={() => onSubmit(state)}
            className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            Send what I have ({view.answeredCount} of {view.total})
          </button>
        )}
        {onAnswerInChat && (
          <button
            type="button"
            data-testid="card-interview-answer-in-chat"
            disabled={busy}
            onClick={onAnswerInChat}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline disabled:opacity-50"
          >
            Answer in chat instead
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Question N of M" plus one segment per question.
 *
 * The segments are the revisit affordance — an answered question collapses to
 * its segment, which is tappable and carries its answer in the tooltip/label,
 * so going back to change one costs a tap rather than N chevrons. Segment
 * labels are the question's `header` (≤12 chars, Claude Code's bound) when
 * the author supplied one.
 *
 * The count is announced `aria-live="polite"`: advancing is a silent visual
 * change otherwise, and a screen-reader user would only ever hear the new
 * question with no sense of where they are in the set.
 */
function ProgressRail({
  card,
  state,
  onJump,
  busy,
}: {
  card: DecisionCard;
  state: CardInterviewState;
  onJump: (next: CardInterviewState) => void;
  busy: boolean;
}) {
  const view = interviewView(card, state);
  return (
    <div className="flex flex-col gap-1">
      <p
        data-testid="card-interview-progress"
        aria-live="polite"
        className="text-xs font-medium text-muted-foreground"
      >
        Question {view.index + 1} of {view.total}
        {view.answeredCount > 0 && ` · ${view.answeredCount} answered`}
      </p>
      <ol className="flex min-w-0 items-center gap-1">
        {card.questions.map((question, index) => {
          const answered = isAnswered(state, question.id);
          const active = index === view.index;
          const summary = answerSummary(question, state.answers[question.id]);
          return (
            <li key={question.id} className="flex min-w-0 flex-1">
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
                className={cn(
                  "h-1.5 w-full rounded-full transition-colors disabled:cursor-not-allowed",
                  active
                    ? "bg-primary"
                    : answered
                      ? "bg-primary/40 hover:bg-primary/60"
                      : "bg-muted-foreground/20 hover:bg-muted-foreground/40",
                )}
              />
            </li>
          );
        })}
      </ol>
      {card.questions.some((question) => question.header) && (
        <p className="truncate text-2xs text-muted-foreground/70">
          <AuthorText>{view.question.header ?? ""}</AuthorText>
        </p>
      )}
    </div>
  );
}

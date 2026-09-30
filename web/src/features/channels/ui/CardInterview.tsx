import { useEffect, useRef, useState } from "react";
import { Bell, ChevronLeft, CornerDownLeft } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import {
  answerSummary,
  back,
  commitMultiSelect,
  interviewView,
  select,
  setNote,
  skipTo,
  toggle,
  typeAnswer,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import { ANSWER_LIMITS } from "../lib/cardAnswerTag.ts";
import type { DecisionCard } from "../lib/decisionCard.ts";
import {
  AuthorText,
  OptionRow,
  PreviousAnswer,
  ProgressRail,
  SomethingElseRow,
  type InterviewVariant,
} from "./CardInterviewParts.tsx";

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
 * Two layouts, one behaviour (web redesign Phase 2): `inline` is the card in
 * a desktop row (Message artboard); `sheet` is the phone bottom sheet
 * (PhoneAsk artboard) — a larger question, the last answer one tap from
 * Edit, and Back / Next as thumb-sized buttons at the foot. Both keep
 * answer-and-advance: choosing a single-select option IS the next step, so
 * the sheet's Next only appears on a question that already has an answer
 * (a revisit), where it moves on without changing it.
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
  /** Card row (default) or phone sheet — see the module doc. */
  variant?: InterviewVariant;
  /**
   * The host already shows `card.title` above this body (the card's header
   * bar). A question whose text IS the title — every v1 card, and a v2
   * card's first question when the author gave no title — then does not
   * repeat it.
   */
  titleShown?: boolean;
  /** "Not now, send to Feedback" — the sheet's way out that files the ask. */
  onFeedback?: () => void;
  /** The card is already filed; the Feedback button says so. */
  inFeedback?: boolean;
}

export function CardInterview({
  card,
  state,
  onChange,
  onSubmit,
  busy,
  onAnswerInChat,
  variant = "inline",
  titleShown = false,
  onFeedback,
  inFeedback = false,
}: CardInterviewProps) {
  const view = interviewView(card, state);
  const question = view.question;
  const sheet = variant === "sheet";
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
  const heading = question.question || card.title;
  const showHeading = !(titleShown && heading === card.title);
  // A revisited single-select question already carries an answer; Next
  // moves on without re-choosing it. (An unanswered one advances on the tap.)
  const nextLabel =
    !multi && view.current !== null && view.index < view.total - 1
      ? answerSummary(question, view.current)
      : null;

  const backButton = (
    <button
      type="button"
      data-testid="card-interview-back"
      disabled={busy}
      onClick={() => onChange(back(state))}
      className={
        sheet
          ? "h-12 w-24 shrink-0 rounded-xl border border-line-2 bg-card text-base font-semibold text-foreground hover:bg-sunk disabled:opacity-50"
          : "-ml-1 mt-px flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
      }
      aria-label={sheet ? undefined : "Previous question"}
    >
      {sheet ? "Back" : <ChevronLeft className="size-4" aria-hidden />}
    </button>
  );

  const primary = multi ? (
    <button
      type="button"
      data-testid="card-interview-continue"
      disabled={busy || selectedCount === 0}
      onClick={() => apply(commitMultiSelect(card, state, question.id))}
      className={cn(
        "flex min-w-0 items-center justify-center rounded-xl bg-primary px-3 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
        sheet ? "h-12 flex-1 text-base" : "min-h-10 w-full text-sm",
      )}
    >
      <span className="truncate">
        {selectedCount === 0
          ? "Choose at least one"
          : `Continue (${selectedCount} selected)`}
      </span>
    </button>
  ) : nextLabel !== null ? (
    <button
      type="button"
      data-testid="card-interview-next"
      disabled={busy}
      onClick={() => onChange(skipTo(card, state, view.index + 1))}
      className={cn(
        "flex min-w-0 items-center justify-center rounded-xl bg-primary px-3 font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40",
        sheet ? "h-12 flex-1 text-base" : "min-h-10 w-full text-sm",
      )}
    >
      <span className="truncate">
        Next · <AuthorText>{nextLabel}</AuthorText>
      </span>
    </button>
  ) : null;

  return (
    <div
      data-testid="card-interview"
      className={cn("flex flex-col", sheet ? "gap-3" : "gap-2.5")}
    >
      {view.total > 1 && (
        <ProgressRail
          card={card}
          state={state}
          onJump={onChange}
          busy={busy}
          variant={variant}
        />
      )}

      {sheet && view.index > 0 && (
        <PreviousAnswer
          card={card}
          state={state}
          onChange={onChange}
          busy={busy}
        />
      )}

      {(showHeading || (!sheet && view.canGoBack)) && (
        <div className="flex items-start gap-1.5">
          {!sheet && view.canGoBack && backButton}
          {showHeading && (
            <p
              className={cn(
                "min-w-0",
                sheet
                  ? "mt-1 text-xl font-bold leading-tight tracking-tight"
                  : "text-sm font-semibold leading-snug",
              )}
            >
              <AuthorText>{heading}</AuthorText>
            </p>
          )}
        </div>
      )}

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
            className={cn(
              "min-w-0 flex-1 rounded-[10px] border border-line-2 bg-card px-3 outline-none placeholder:text-muted-foreground focus-visible:border-foreground",
              sheet ? "h-11 text-base" : "h-9 text-sm",
            )}
          />
          <button
            type="submit"
            data-testid="card-interview-send-typed"
            disabled={busy || draft.trim().length === 0}
            aria-label="Send your own answer"
            className={cn(
              "flex shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
              sheet ? "size-11" : "size-9",
            )}
          >
            <CornerDownLeft className="size-4" aria-hidden />
          </button>
        </form>
      )}

      <fieldset
        role={multi ? undefined : "radiogroup"}
        className={cn(
          "flex min-w-0 flex-col border-0 p-0",
          sheet ? "gap-2" : "gap-1.5",
        )}
      >
        <legend className="sr-only">{question.question}</legend>
        {question.options.map((option) => (
          <OptionRow
            key={option.id}
            option={option}
            multi={multi}
            active={chosen.has(option.id)}
            busy={busy}
            variant={variant}
            onPick={() =>
              multi
                ? onChange(toggle(card, state, question.id, option.id))
                : apply(select(card, state, question.id, option.id))
            }
          />
        ))}
        {!typing && (
          <SomethingElseRow
            busy={busy}
            variant={variant}
            onOpen={() => setTyping(true)}
          />
        )}
      </fieldset>

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
            className="h-9 min-w-0 rounded-[10px] border border-line-2 bg-card px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-foreground"
          />
        </label>
      )}

      {sheet
        ? (view.canGoBack || primary) && (
            <div className="mt-1 flex gap-2">
              {view.canGoBack && backButton}
              {primary}
            </div>
          )
        : primary}

      {sheet && onFeedback && (
        <button
          type="button"
          data-testid="card-interview-feedback"
          disabled={busy || inFeedback}
          onClick={onFeedback}
          className="inline-flex h-10 items-center gap-1.5 self-center px-3 text-sm font-semibold text-muted-foreground hover:text-foreground disabled:opacity-60"
        >
          <Bell aria-hidden className="size-3.75" />
          {inFeedback ? "In Feedback" : "Not now, send to Feedback"}
        </button>
      )}

      {(view.canSendPartial || onAnswerInChat) && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-3 gap-y-1",
            sheet && "justify-center",
          )}
        >
          {view.canSendPartial && (
            <button
              type="button"
              data-testid="card-interview-send-partial"
              disabled={busy}
              onClick={() => onSubmit(state)}
              className="text-xs font-semibold text-info-ink hover:underline disabled:opacity-50"
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
      )}
    </div>
  );
}

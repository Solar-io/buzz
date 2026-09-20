import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import {
  sendCardAnswer,
  sendCardInterviewAnswer,
  type CardInterviewTarget,
} from "./cardAnswer.ts";
import { cardReplySummary } from "./cardAnswered.ts";
import {
  clearCardDraft,
  createCardDraftWriter,
  loadCardDraft,
} from "./cardDraft.ts";
import {
  answerSummary,
  emptyInterviewState,
  interviewDraft,
  interviewView,
  startInterview,
  type CardInterviewState,
} from "./cardInterview.ts";
import type { TimelineMessage } from "./messageBuffer.ts";

/**
 * Answering a decision card, minus the rendering — draft restore, draft
 * persistence, the publish state machine, and the two rules that are only
 * ever allowed to exist once.
 *
 * ## Why a hook rather than a component
 *
 * Two surfaces answer the same card: the timeline card (`DecisionCard.tsx`,
 * inline stepper or phone sheet) and the Asks-inbox row (`AskRow.tsx`, which
 * opens the same sheet from the inbox). They render nothing alike and share
 * every rule, so the rules live here and the components own only their
 * layout. The alternative — the inbox re-implementing submit — is how the two
 * surfaces would come to disagree about what "answered" means, which is the
 * same defect `cardAnswered.ts` exists to prevent one layer down.
 *
 * ## The two rules
 *
 * **Terminal is DERIVED FROM THE EVENT.** `answer` is my published reply, read
 * off the timeline by the caller. When it is present the card is terminal on
 * the FIRST render, before any effect runs and regardless of what happened in
 * this mount — component state dies with the mount, and the timeline is a
 * virtualizer that unmounts rows on scroll (measured 2026-09-20: an answered
 * card came back answerable, ready to publish a SECOND `done:true` answer to a
 * card the agent had already acted on).
 *
 * **The submitted state is PASSED IN, never re-read.** Auto-submit fires
 * inside the same handler that answered the last question, and React has not
 * re-rendered by then, so a `latest.current` ref still holds the previous
 * state. Reading one published every completed interview an answer short —
 * five named tests said so before the argument replaced the ref.
 */

export type CardAnswerPhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; summary: string }
  | { kind: "partial"; answered: number; total: number }
  | { kind: "error"; message: string };

export interface CardAnswerFlow {
  /** The live draft — what the stepper renders. */
  state: CardInterviewState;
  /** Record a state transition and schedule the debounced draft write. */
  update: (next: CardInterviewState) => void;
  /** Publish `next`. The CALLER supplies the state; see the module doc. */
  submit: (next: CardInterviewState) => void;
  phase: CardAnswerPhase;
  /** A publish is in flight — every control disables on it. */
  busy: boolean;
  /**
   * The answer to render in place of the interview, or null while the card is
   * still open. The published event outranks this mount's own `phase`, so a
   * remount and a reload land on the same rendering.
   */
  sentSummary: string | null;
}

export function useCardAnswerFlow({
  target,
  answer = null,
  onPublished,
}: {
  /** The card event plus its parsed payload. `AskItem` satisfies it. */
  target: CardInterviewTarget;
  /**
   * MY answer to this card, if the host carries one. `null` when unanswered,
   * and when the host cannot know — which degrades to answer-once-per-mount
   * rather than to a wrong claim.
   */
  answer?: Pick<TimelineMessage, "content" | "cardAnswer"> | null;
  /** Fired once a submission closed the interview — hosts close their sheet. */
  onPublished?: () => void;
}): CardAnswerFlow {
  const { session } = useRelaySession();
  const [state, setState] = useState<CardInterviewState>(emptyInterviewState);
  const [phase, setPhase] = useState<CardAnswerPhase>({ kind: "idle" });

  const card = target.card;
  const cardId = target.id;
  const writer = useMemo(() => createCardDraftWriter(cardId), [cardId]);

  // The target and the completion callback are read at SUBMIT time, through
  // refs, so a host that rebuilds either object every render (the timeline
  // spreads `{...message, card}`) does not re-run the effects below.
  const targetRef = useRef(target);
  targetRef.current = target;
  const publishedRef = useRef(onPublished);
  publishedRef.current = onPublished;

  /**
   * The published answer's summary, or null. Derived every render from the
   * event — never copied into state, because state is what a remount throws
   * away.
   */
  const publishedSummary = useMemo(
    () => (answer ? cardReplySummary(card, answer) : null),
    [card, answer],
  );

  // Restore the draft, once per card. `cancelled` guards the ordinary React
  // race: the read is async, and a card that scrolls out of the virtualized
  // timeline mid-read would otherwise have its restored state applied to an
  // unmounted tree.
  useEffect(() => {
    let cancelled = false;
    void loadCardDraft(cardId).then((stored) => {
      if (!cancelled) {
        setState(startInterview(card, stored));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [card, cardId]);

  // Unmount is the one moment a pending debounced write must not be lost —
  // scrolling a card out of the virtualizer unmounts it.
  useEffect(() => () => writer.flush(), [writer]);

  // A card answered somewhere else (another device, or this one before a
  // reload) has nothing left to resume. Dropping the draft here is what keeps
  // it from outliving the interview it belonged to; the answer itself is on
  // the relay and is not what is being deleted.
  useEffect(() => {
    if (publishedSummary === null) {
      return;
    }
    writer.cancel();
    void clearCardDraft(cardId);
  }, [publishedSummary, writer, cardId]);

  const update = useCallback(
    (next: CardInterviewState) => {
      setState(next);
      writer.schedule(next);
    },
    [writer],
  );

  const sending = useRef(false);

  const submit = useCallback(
    (current: CardInterviewState) => {
      void (async () => {
        const self = targetRef.current;
        if (sending.current || phase.kind === "sent") {
          return;
        }
        // Belt and braces against the defect this flow is built around: a
        // card the wire says is answered never publishes a second answer,
        // even if something managed to render an interview over the top of it.
        if (publishedSummary !== null) {
          return;
        }
        const view = interviewView(self.card, current);
        if (!view.canSubmit) {
          return;
        }
        const finish = (summary: string) => {
          writer.cancel();
          void clearCardDraft(self.id);
          setPhase({ kind: "sent", summary });
          publishedRef.current?.();
        };
        const plainSummary = () =>
          self.card.questions
            .map((question) =>
              answerSummary(question, current.answers[question.id]),
            )
            .filter((line) => line.length > 0)
            .join(" · ");
        sending.current = true;
        setPhase({ kind: "sending" });
        try {
          const result = await sendCardInterviewAnswer(
            session,
            self,
            interviewDraft(self.card, current),
          );
          if (!result.ok) {
            setPhase({
              kind: "error",
              message: result.message || "relay rejected the reply",
            });
            return;
          }
          // `done` is DERIVED by the answer builder — this is the only place
          // the flow learns whether the submission closed the interview, and
          // it is deliberately not re-derived here.
          if (result.answer?.done === true) {
            finish(plainSummary());
            return;
          }
          setPhase({
            kind: "partial",
            answered: result.answer?.answers.length ?? view.answeredCount,
            total: self.card.questions.length,
          });
        } catch (error) {
          // The structured builder THROWS on a draft it will not publish.
          // Fall back to a plain-text reply of the same answers rather than
          // going dead: a reply with no `card-answer` tag is COMPLETE by the
          // badge rule, which is exactly v1's behaviour, so an answer that
          // cannot be structured must never become an answer that cannot be
          // sent.
          const plain = plainSummary();
          if (plain.length === 0) {
            setPhase({
              kind: "error",
              message: error instanceof Error ? error.message : String(error),
            });
            return;
          }
          try {
            const result = await sendCardAnswer(session, self, plain);
            if (!result.ok) {
              setPhase({
                kind: "error",
                message: result.message || "relay rejected the reply",
              });
              return;
            }
            finish(plain);
          } catch (fallbackError) {
            setPhase({
              kind: "error",
              message:
                fallbackError instanceof Error
                  ? fallbackError.message
                  : String(fallbackError),
            });
          }
        } finally {
          sending.current = false;
        }
      })();
    },
    [session, phase.kind, publishedSummary, writer],
  );

  return {
    state,
    update,
    submit,
    phase,
    busy: phase.kind === "sending",
    // The wire first: an answer that exists outranks anything this mount
    // believes.
    sentSummary:
      publishedSummary ?? (phase.kind === "sent" ? phase.summary : null),
  };
}

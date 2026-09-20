import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { sendCardAnswer, sendCardInterviewAnswer } from "../lib/cardAnswer.ts";
import {
  clearCardDraft,
  createCardDraftWriter,
  loadCardDraft,
} from "../lib/cardDraft.ts";
import {
  answerSummary,
  emptyInterviewState,
  interviewDraft,
  interviewView,
  startInterview,
  type CardInterviewState,
} from "../lib/cardInterview.ts";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { CardInterview } from "./CardInterview.tsx";

/**
 * D-035 decision card: renders the `["card", …]` tag payload of a kind 9
 * message as an answerable interview — a stepper that shows one question,
 * drops the user into the next as soon as one is answered, and publishes ONE
 * ordinary kind 9 reply carrying both halves of the answer (the deterministic
 * per-question `content` every plain client reads, and the `card-answer` tag
 * carrying option ids and the derived `done` flag).
 *
 * **A v1 card takes exactly this path**, as an interview of length one. That
 * single-parser/single-renderer property is the spine of the whole design, so
 * there is deliberately no `card.v` branch anywhere below: one question with
 * no progress rail IS the v1 card, and the reply it publishes is structurally
 * identical to what v1 produced except that it now carries ids.
 *
 * ## Nothing publishes until the user submits
 *
 * Answering a question mutates local state and a debounced IndexedDB draft
 * (`cardDraft.ts`) and sends nothing. A partial interview therefore never
 * reaches the agent by accident — the failure worth preventing is an agent
 * acting on 2 of 4 answers as though the interview concluded. Two things
 * submit: answering the last open question (auto-submit; Sam's flow is
 * answer-and-advance, so no terminal confirm tap) and the explicit "Send what
 * I have", which publishes `done:false` and leaves the ask badge LIT.
 *
 * ## Terminal only when complete
 *
 * A `done:true` submission is terminal and deletes the draft. A `done:false`
 * one is not: the card stays answerable so completing it later publishes a
 * second answer, `done:true` wins, and the badge clears then. A relay refusal
 * keeps the draft and the card interactive, with `result.message` verbatim —
 * `publish()` RESOLVES `{ok:false}` on a FAILED or an ack timeout rather than
 * throwing (caught live 9/16), so a caller that treats resolution as success
 * renders a false sent state.
 */
export function DecisionCard({
  message,
  onAnswerInChat,
}: {
  message: TimelineMessage;
  /**
   * The dismiss-and-type path: hand the conversation back to the composer
   * with the card as the reply target. Absent where replying to the card is
   * not a navigation the host can perform (a flat thread pane), in which case
   * the footer link is not rendered rather than rendered dead.
   */
  onAnswerInChat?: () => void;
}) {
  const card = message.card;
  const { session } = useRelaySession();
  const [state, setState] = useState<CardInterviewState>(emptyInterviewState);
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; summary: string }
    | { kind: "partial"; answered: number; total: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const cardId = message.id;
  const writer = useMemo(() => createCardDraftWriter(cardId), [cardId]);

  // Restore the draft, once per card. `cancelled` guards the ordinary React
  // race: the read is async, and a card that scrolls out of the virtualized
  // timeline mid-read would otherwise have its restored state applied to an
  // unmounted tree.
  useEffect(() => {
    if (!card) {
      return;
    }
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

  const update = useCallback(
    (next: CardInterviewState) => {
      setState(next);
      writer.schedule(next);
    },
    [writer],
  );

  /**
   * Publish `current`, which the CALLER supplies.
   *
   * Never re-read from component state or from a latest-state ref: auto-submit
   * fires inside the same handler that answered the last question, and React
   * has not re-rendered by then. The first wiring here did read a ref and
   * published the interview one answer short — every completion went out as
   * "Answered 3 of 4", and five named tests said so.
   */
  const sending = useRef(false);

  async function submit(current: CardInterviewState) {
    if (!card || sending.current || phase.kind === "sent") {
      return;
    }
    const view = interviewView(card, current);
    if (!view.canSubmit) {
      return;
    }
    sending.current = true;
    setPhase({ kind: "sending" });
    try {
      const result = await sendCardInterviewAnswer(
        session,
        { ...message, card },
        interviewDraft(card, current),
      );
      if (!result.ok) {
        setPhase({
          kind: "error",
          message: result.message || "relay rejected the reply",
        });
        return;
      }
      // `done` is DERIVED by the answer builder — this is the only place the
      // component learns whether the submission closed the interview, and it
      // is deliberately not re-derived here.
      if (result.answer?.done === true) {
        writer.cancel();
        void clearCardDraft(cardId);
        setPhase({
          kind: "sent",
          summary: card.questions
            .map((question) =>
              answerSummary(question, current.answers[question.id]),
            )
            .filter((line) => line.length > 0)
            .join(" · "),
        });
        return;
      }
      setPhase({
        kind: "partial",
        answered: result.answer?.answers.length ?? view.answeredCount,
        total: card.questions.length,
      });
    } catch (error) {
      // The structured builder THROWS on a draft it will not publish. Fall
      // back to a plain-text reply of the same answers rather than going
      // dead: a reply with no `card-answer` tag is COMPLETE by the badge
      // rule, which is exactly v1's behaviour, so an answer that cannot be
      // structured must never become an answer that cannot be sent.
      const plain = card.questions
        .map((question) =>
          answerSummary(question, current.answers[question.id]),
        )
        .filter((line) => line.length > 0)
        .join(" · ");
      if (plain.length === 0) {
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      try {
        const result = await sendCardAnswer(session, message, plain);
        if (!result.ok) {
          setPhase({
            kind: "error",
            message: result.message || "relay rejected the reply",
          });
          return;
        }
        writer.cancel();
        void clearCardDraft(cardId);
        setPhase({ kind: "sent", summary: plain });
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
  }

  if (!card) {
    return null;
  }

  const busy = phase.kind === "sending";
  const title = card.questions.length > 1 ? card.title : null;

  return (
    <div
      data-testid="decision-card"
      className="my-1 max-w-xl rounded-xl border bg-muted/20 px-3 py-2.5"
    >
      {title && (
        <p className="mb-1.5 min-w-0 break-words text-sm font-semibold leading-snug">
          {/* Author text, bidi-isolated for the reason CardInterview documents. */}
          <bdi>{title}</bdi>
        </p>
      )}

      {phase.kind === "sent" ? (
        <p
          data-testid="decision-card-sent"
          className="flex items-start gap-1.5 text-sm font-medium text-primary"
        >
          <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">
            You replied: <bdi>{phase.summary}</bdi>
          </span>
        </p>
      ) : (
        <>
          <CardInterview
            card={card}
            state={state}
            onChange={update}
            onSubmit={(next) => void submit(next)}
            busy={busy}
            onAnswerInChat={onAnswerInChat}
          />

          {phase.kind === "partial" && (
            <p
              data-testid="decision-card-partial"
              className="mt-1.5 text-xs text-muted-foreground"
            >
              Sent {phase.answered} of {phase.total} — the rest are still open.
            </p>
          )}
          {phase.kind === "error" && (
            <p
              data-testid="decision-card-error"
              className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive"
            >
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
              Reply failed ({phase.message}) — try again.
            </p>
          )}
          {busy && (
            <p className="mt-1.5 text-xs text-muted-foreground/70">Sending…</p>
          )}
        </>
      )}
    </div>
  );
}

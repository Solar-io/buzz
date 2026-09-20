import { useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import {
  isRenderableCard,
  type DecisionCard as DecisionCardPayload,
} from "../lib/decisionCard.ts";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { useCardAnswerFlow } from "../lib/useCardAnswerFlow.ts";
import { CardInterview } from "./CardInterview.tsx";
import { CardInterviewSheet } from "./CardInterviewSheet.tsx";
import { CardSummaryTile } from "./CardSummaryTile.tsx";

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
 * ## What lives here, and what does not
 *
 * Everything about ANSWERING — draft restore, draft persistence, the publish
 * state machine, the terminal-from-the-event rule and the pass-the-state rule
 * — is `lib/useCardAnswerFlow.ts`, because the Asks inbox answers the same
 * card from a row that shares no layout with this one. This component owns
 * the timeline presentation and nothing else: the phone/desktop split, the
 * title line, and where the publish status is drawn.
 *
 * ## Nothing publishes until the user submits
 *
 * Answering a question mutates local state and a debounced IndexedDB draft
 * and sends nothing. A partial interview therefore never reaches the agent by
 * accident — the failure worth preventing is an agent acting on 2 of 4
 * answers as though the interview concluded. Two things submit: answering the
 * last open question (auto-submit; Sam's flow is answer-and-advance, so no
 * terminal confirm tap) and the explicit "Send what I have", which publishes
 * `done:false` and leaves the ask badge LIT.
 */
export function DecisionCard({
  message,
  answer = null,
  onAnswerInChat,
}: {
  message: TimelineMessage;
  /**
   * MY answer to this card, if the timeline carries one — the reply whose
   * `e`-marker names this card and which `answeredByMe` calls complete.
   * `null` when unanswered, and when the host cannot know (a surface that
   * renders a card with no buffer around it), which degrades to today's
   * answer-once-per-mount behaviour rather than to a wrong claim.
   */
  answer?: TimelineMessage | null;
  /**
   * The dismiss-and-type path: hand the conversation back to the composer
   * with the card as the reply target. Absent where replying to the card is
   * not a navigation the host can perform (a flat thread pane), in which case
   * the footer link is not rendered rather than rendered dead.
   */
  onAnswerInChat?: () => void;
}) {
  // The narrowing guard sits OUTSIDE the stateful body: a card-less message
  // renders nothing, and an early return may not precede hooks.
  //
  // `isRenderableCard` rather than truthiness: this component reads
  // `card.questions` unconditionally, and a card that reached it without
  // going through the parser (a pre-v2 timeline-cache shape — the 2026-09-20
  // blank-boot crash) must render nothing rather than take the app down with
  // it. The timeline row falls back to the markdown content when this
  // returns null.
  const card = message.card;
  if (!isRenderableCard(card)) {
    return null;
  }
  return (
    <CardBody
      message={message}
      card={card}
      answer={answer}
      onAnswerInChat={onAnswerInChat}
    />
  );
}

function CardBody({
  message,
  card,
  answer,
  onAnswerInChat,
}: {
  message: TimelineMessage;
  card: DecisionCardPayload;
  answer: TimelineMessage | null;
  onAnswerInChat?: () => void;
}) {
  /**
   * Is the phone sheet open? Only reachable below `md`, where the timeline
   * row is a tile — but held here rather than in the tile because closing it
   * is a consequence of PUBLISHING.
   */
  const [sheetOpen, setSheetOpen] = useState(false);
  const flow = useCardAnswerFlow({
    target: { ...message, card },
    answer,
    // A completed interview is terminal, so the sheet has nothing left to
    // show. (The terminal branch unmounts it anyway; closing it explicitly is
    // what makes Radix release the body scroll-lock through its own close
    // path rather than through an unmount.)
    onPublished: () => setSheetOpen(false),
  });

  const { phase, busy } = flow;
  const title = card.questions.length > 1 ? card.title : null;

  const titleLine = title ? (
    <p className="mb-1.5 min-w-0 break-words text-sm font-semibold leading-snug">
      {/* Author text, bidi-isolated for the reason CardInterview documents. */}
      <bdi>{title}</bdi>
    </p>
  ) : null;

  /**
   * Publish status. Rendered in exactly ONE place at a time — inline under
   * the stepper, or in the sheet's footer while the sheet is open — so a
   * relay verdict is never two elements carrying the same testid.
   */
  const status = (
    <>
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
  );

  return (
    <div
      data-testid="decision-card"
      className="my-1 max-w-xl rounded-xl border bg-muted/20 px-3 py-2.5"
    >
      {flow.sentSummary !== null ? (
        <>
          {titleLine}
          <p
            data-testid="decision-card-sent"
            className="flex items-start gap-1.5 text-sm font-medium text-primary"
          >
            <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 break-words">
              You replied: <bdi>{flow.sentSummary}</bdi>
            </span>
          </p>
        </>
      ) : (
        <>
          {/*
            The phone/desktop split is a CSS BREAKPOINT, not `matchMedia`.
            Both hosts render and Tailwind's `md:` decides which is visible,
            so there is no JS media query to be wrong on the first paint, no
            resize listener, and no hydration mismatch — the layout is correct
            before any effect has run. The cost is that both subtrees exist in
            the DOM; the hidden one is `display:none`, so it contributes no
            height to the virtualized row and nothing focusable to the tab
            order.
          */}
          <div className="hidden md:block">
            {titleLine}
            <CardInterview
              card={card}
              state={flow.state}
              onChange={flow.update}
              onSubmit={flow.submit}
              busy={busy}
              onAnswerInChat={onAnswerInChat}
            />
          </div>

          <div className="md:hidden">
            <CardSummaryTile
              card={card}
              state={flow.state}
              busy={busy}
              onOpen={() => setSheetOpen(true)}
            />
          </div>

          {!sheetOpen && status}

          {/*
            Mounted only while open (Radix portals nothing otherwise), so the
            desktop path costs nothing and the option testids inside it are
            unambiguous exactly when the sheet is being driven.
          */}
          <CardInterviewSheet
            card={card}
            state={flow.state}
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            onChange={flow.update}
            onSubmit={flow.submit}
            busy={busy}
            onAnswerInChat={
              onAnswerInChat
                ? () => {
                    // Leaving for the composer means leaving the sheet: the
                    // reply target is the conversation behind it.
                    setSheetOpen(false);
                    onAnswerInChat();
                  }
                : undefined
            }
            footer={status}
          />
        </>
      )}
    </div>
  );
}

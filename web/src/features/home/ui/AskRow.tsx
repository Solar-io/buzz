import { useState } from "react";
import {
  Check,
  HelpCircle,
  Layers,
  MessageSquare,
  AtSign,
  TriangleAlert,
} from "lucide-react";

import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import { CardInterviewSheet } from "@/features/channels/ui/CardInterviewSheet";
import type { Profile } from "@/features/channels/hooks";
import { authorLabel } from "@/features/channels/lib/authorLabel.ts";
import { formatTime } from "@/features/channels/lib/dateFormatters.ts";
import { sendCardAnswer } from "@/features/channels/lib/cardAnswer.ts";
import { interviewView } from "@/features/channels/lib/cardInterview.ts";
import { useCardAnswerFlow } from "@/features/channels/lib/useCardAnswerFlow.ts";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import { cn } from "@/shared/lib/cn";
import type { AskItem } from "../lib/askDetection.ts";
import type { AskInterview } from "../lib/askInterview.ts";

/**
 * One ASK row (D-035 follow-on): a decision card addressed to the viewer,
 * still waiting on an answer. Shows what Sam asked the surface for — card
 * title (bold), asking agent (avatar + name), channel/DM label, age, and a
 * preview line.
 *
 * ## One row per INTERVIEW, not per card
 *
 * An agent refines by sending a second card in the same thread, so the row's
 * unit is the interview (`askInterview.ts`) and what it renders is the newest
 * card still waiting. Two rows for one thread would present a superseded
 * question as though it were still live. The `Round N` chip says which round
 * this is, and `+N earlier` admits when an older question in the same thread
 * is also still open — the inbox never silently drops something it is
 * counting.
 *
 * Tapping the row is the existing permalink jump (`?c=&m=`), NOT a detail
 * selection: the card lives in its channel timeline (or thread panel), where
 * the full card renders.
 *
 * ## Two answering affordances, chosen by the card
 *
 * A ONE-question card keeps the v1 one-tap chips: tapping an option publishes
 * a plain reply immediately, which is a complete answer by the badge rule and
 * is exactly what shipped before v2. A MULTI-question card cannot be answered
 * in one tap, so it gets an Answer button that opens the same
 * {@link CardInterviewSheet} the phone timeline uses — one interaction
 * implementation, three hosts.
 *
 * Both paths honour the same publish discipline: `publish()` RESOLVES
 * `{ok:false}` on a relay rejection, so `result.ok` is checked and
 * `result.message` surfaced verbatim, and the badge is deliberately NOT
 * cleared here — it clears when the relay echo arrives through the answer REQ
 * and the answered predicate matches, so a badge can never claim less than
 * the relay agreed to store.
 */
export function AskRow({
  interview,
  channelLabel,
  channelType,
  profiles,
  onOpen,
}: {
  interview: AskInterview;
  /** Display name of the ask's channel, already `#`-prefixed for streams. */
  channelLabel: string;
  channelType: AskItem["channelType"];
  profiles: Map<string, Profile>;
  onOpen: () => void;
}) {
  const ask = interview.ask;
  const label = authorLabel(ask.authorPubkey, profiles);
  const isDm = channelType === "dm";
  const questions = ask.card.questions;
  const multi = questions.length > 1;
  // Preview: the recommended option when one is marked, else the first —
  // but only the marked one is STYLED as recommended.
  const options = questions[0]?.options ?? [];
  const recommended = options.find((option) => option.recommended === true);
  const preview = recommended ?? options[0];

  return (
    <div
      data-testid={`ask-row-${ask.id}`}
      data-unread="true"
      className={cn(
        "rounded-xl transition-colors",
        "hover:bg-muted/60 focus-within:bg-muted/60",
      )}
    >
      <button
        type="button"
        data-testid={`ask-row-open-${ask.id}`}
        onClick={onOpen}
        className={cn(
          "flex w-full gap-3 rounded-xl px-3 py-2 text-left",
          "focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        <div className="relative shrink-0 pt-0.5">
          <AuthorAvatar
            pubkey={ask.authorPubkey}
            label={label}
            picture={profiles.get(ask.authorPubkey)?.avatar}
            size="md-sm"
          />
          <span
            data-testid="ask-row-unread-dot"
            aria-hidden
            className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <HelpCircle
              aria-hidden
              className="h-3.5 w-3.5 shrink-0 self-center text-primary"
            />
            <span className="truncate text-sm font-semibold text-foreground">
              {ask.card.title}
            </span>
            <span className="flex min-w-0 shrink items-center gap-1 text-2xs text-muted-foreground">
              {isDm ? (
                <MessageSquare aria-hidden className="h-3 w-3 shrink-0" />
              ) : (
                <AtSign aria-hidden className="h-3 w-3 shrink-0" />
              )}
              <span className="truncate">{channelLabel}</span>
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-2xs text-muted-foreground">
              {formatTime(ask.createdAt)}
            </span>
          </div>
          <InterviewChips interview={interview} />
          <p className="mt-0.5 truncate text-sm text-muted-foreground">
            <span className="text-foreground/70">{label}</span> asks
            {multi ? (
              <> — {questions.length} questions</>
            ) : (
              preview && (
                <>
                  {recommended ? " — Recommended: " : " — "}
                  <span
                    className={cn(
                      recommended && "font-medium text-foreground/80",
                    )}
                  >
                    {preview.label}
                  </span>
                </>
              )
            )}
          </p>
        </div>
      </button>
      {multi ? (
        <AskInterviewAnswer ask={ask} onAnswerInChat={onOpen} />
      ) : (
        <AskOneTapAnswer ask={ask} options={options} />
      )}
    </div>
  );
}

/**
 * `Round N`, `N/M` and `+N earlier` — rendered only when each has something
 * to say, so a v1 single-question ask row is pixel-identical to what shipped
 * before interviews existed.
 */
function InterviewChips({ interview }: { interview: AskInterview }) {
  const { round, earlier, progress } = interview;
  const showRound = round > 1;
  const showProgress = progress.total > 1;
  if (!showRound && !showProgress && earlier === 0) {
    return null;
  }
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
      {showRound && (
        <span
          data-testid={`ask-row-round-${interview.ask.id}`}
          className="rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary"
        >
          Round {round}
        </span>
      )}
      {showProgress && (
        <span
          data-testid={`ask-row-progress-${interview.ask.id}`}
          className="rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-2xs text-muted-foreground"
        >
          {progress.answered}/{progress.total}
        </span>
      )}
      {earlier > 0 && (
        <span
          data-testid={`ask-row-earlier-${interview.ask.id}`}
          className="flex items-center gap-1 text-2xs text-muted-foreground"
        >
          <Layers aria-hidden className="h-3 w-3 shrink-0" />+{earlier} earlier
        </span>
      )}
    </span>
  );
}

/**
 * The v1 affordance, unchanged: one tap publishes one plain reply whose
 * content is the option label verbatim. No `card-answer` tag, which is what
 * makes it complete by the badge rule — the same thing typing "yes" in the
 * channel does.
 */
function AskOneTapAnswer({
  ask,
  options,
}: {
  ask: AskItem;
  options: AskItem["card"]["questions"][number]["options"];
}) {
  const { session } = useRelaySession();
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "sending" }
    | { phase: "sent"; answer: string }
    | { phase: "error"; answer: string; message: string }
  >({ phase: "idle" });

  async function answer(optionLabel: string) {
    if (state.phase === "sending" || state.phase === "sent") {
      return;
    }
    setState({ phase: "sending" });
    try {
      const result = await sendCardAnswer(session, ask, optionLabel);
      if (!result.ok) {
        setState({
          phase: "error",
          answer: optionLabel,
          message: result.message || "relay rejected the reply",
        });
        return;
      }
      setState({ phase: "sent", answer: optionLabel });
    } catch (error) {
      setState({
        phase: "error",
        answer: optionLabel,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (state.phase === "sent") {
    return (
      <p
        data-testid={`ask-row-answered-${ask.id}`}
        className="mb-2 flex items-center gap-1.5 px-3 text-xs font-medium text-primary"
      >
        <Check className="size-3" aria-hidden />
        You replied: {state.answer}
      </p>
    );
  }
  return (
    <div className="mb-2 flex flex-wrap gap-1.5 px-3">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`ask-row-answer-${ask.id}-${option.id}`}
          disabled={state.phase === "sending"}
          onClick={() => answer(option.label)}
          className={cn(
            "flex items-center gap-1.5 rounded-full border bg-background px-2.5 py-1 text-xs",
            "transition-colors hover:border-primary/50 hover:bg-primary/5",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          {option.label}
          {option.recommended === true && (
            <span className="text-2xs font-medium uppercase tracking-wide text-accent-foreground/80">
              ★
            </span>
          )}
        </button>
      ))}
      {state.phase === "sending" && (
        <span className="self-center text-xs text-muted-foreground/70">
          Sending…
        </span>
      )}
      {state.phase === "error" && (
        <span
          data-testid={`ask-row-error-${ask.id}`}
          className="flex items-center gap-1 text-xs text-destructive"
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          {state.message || "Reply failed"} — try again
        </span>
      )}
    </div>
  );
}

/**
 * The multi-question affordance: the inbox becomes an answering surface
 * rather than a jump-to-channel link.
 *
 * `useCardAnswerFlow` is the SAME flow the timeline card runs — draft
 * restore, the debounced draft write, the derived `done` flag and the
 * pass-the-state submit rule — so an interview half-answered here and
 * finished in the channel (or the other way round) resumes rather than
 * restarts. `AskItem` is a `CardInterviewTarget` by construction, which is
 * what lets the inbox publish a structurally identical answer.
 *
 * `answer` is deliberately NOT passed: the inbox holds no timeline buffer, so
 * it cannot know whether a reply exists, and the flow degrades to
 * answer-once-per-mount rather than to a wrong claim. An answered ask stops
 * being a row at all once the relay echo lands.
 */
function AskInterviewAnswer({
  ask,
  onAnswerInChat,
}: {
  ask: AskItem;
  onAnswerInChat: () => void;
}) {
  const [open, setOpen] = useState(false);
  const flow = useCardAnswerFlow({
    target: ask,
    onPublished: () => setOpen(false),
  });
  const view = interviewView(ask.card, flow.state);

  const status = (
    <>
      {flow.phase.kind === "partial" && (
        <p
          data-testid={`ask-row-partial-${ask.id}`}
          className="text-xs text-muted-foreground"
        >
          Sent {flow.phase.answered} of {flow.phase.total} — the rest are still
          open.
        </p>
      )}
      {flow.phase.kind === "error" && (
        <p
          data-testid={`ask-row-error-${ask.id}`}
          className="flex items-center gap-1 text-xs text-destructive"
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          Reply failed ({flow.phase.message}) — try again.
        </p>
      )}
      {flow.busy && (
        <p className="text-xs text-muted-foreground/70">Sending…</p>
      )}
    </>
  );

  if (flow.sentSummary !== null) {
    return (
      <p
        data-testid={`ask-row-answered-${ask.id}`}
        className="mb-2 flex items-start gap-1.5 px-3 text-xs font-medium text-primary"
      >
        <Check className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span className="min-w-0 break-words">
          You replied: <bdi>{flow.sentSummary}</bdi>
        </span>
      </p>
    );
  }

  return (
    <div className="mb-2 flex flex-col gap-1 px-3">
      <button
        type="button"
        data-testid={`ask-row-open-interview-${ask.id}`}
        disabled={flow.busy}
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-h-8 w-full items-center justify-center rounded-lg border border-primary/40 bg-primary/5 px-3 text-xs font-medium text-primary",
          "transition-colors hover:bg-primary/10",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {view.answeredCount > 0
          ? `Resume — ${view.answeredCount} of ${view.total}`
          : "Answer"}
      </button>
      {!open && status}
      <CardInterviewSheet
        card={ask.card}
        state={flow.state}
        open={open}
        onOpenChange={setOpen}
        onChange={flow.update}
        onSubmit={flow.submit}
        busy={flow.busy}
        onAnswerInChat={() => {
          setOpen(false);
          onAnswerInChat();
        }}
        footer={status}
      />
    </div>
  );
}

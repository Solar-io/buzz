import { useState } from "react";
import { Bell, Check, TriangleAlert } from "lucide-react";
import { useRemindMeLater } from "@/features/reminders/ui/RemindMeLaterProvider";
import { cn } from "@/shared/lib/cn";
import type { TimelineMessage } from "../lib/messageBuffer.ts";
import { YES_NO_CHOICES } from "../lib/quickReply.ts";

/**
 * Yes / No / Feedback under a message that explicitly asked for one (web
 * redesign Phase 2; Main and PhoneChannel artboards).
 *
 * The buttons are a shortcut for typing, nothing more: a choice is sent as an
 * ORDINARY reply — the word itself, threaded under the question and p-tagging
 * whoever asked, so an agent's harness wakes on it exactly as it would on a
 * typed "Yes". No card is fabricated and nothing is recorded that a plain
 * client could not read. Feedback files the question for later instead.
 *
 * Whether the buttons appear at all is decided upstream
 * (`openQuickReplies`): only for an explicit yes/no ask aimed at the viewer,
 * and only until they have said anything since. Once a choice is sent the
 * row says what was answered; the reply then shows in the thread like any
 * other.
 *
 * Send failures show the relay's words here, under the buttons — the
 * composer's draft is not involved, so its error toast is not the place.
 */
export function QuickReplies({
  message,
  onAnswer,
}: {
  message: TimelineMessage;
  /** Send `choice` as a reply to `message`; resolves with the relay's verdict. */
  onAnswer: (choice: string) => Promise<{ ok: boolean; message: string }>;
}) {
  const { sendToFeedback, feedbackPending, pendingEventIds } =
    useRemindMeLater();
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "sending"; choice: string }
    | { kind: "sent"; choice: string }
    | { kind: "error"; text: string }
  >({ kind: "idle" });
  const inFeedback = pendingEventIds.has(message.id);

  const answer = async (choice: string) => {
    setPhase({ kind: "sending", choice });
    try {
      const result = await onAnswer(choice);
      // `publish()` resolves {ok:false} on a relay refusal — it does not
      // throw. Treating resolution as success would show a false "answered".
      setPhase(
        result.ok
          ? { kind: "sent", choice }
          : {
              kind: "error",
              text: result.message || "The relay rejected the reply.",
            },
      );
    } catch (error) {
      setPhase({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (phase.kind === "sent") {
    return (
      <p
        data-testid="quick-reply-sent"
        className="mt-2 flex items-center gap-1.5 text-sidebar-meta text-ink-2"
      >
        <Check aria-hidden className="size-3.5 shrink-0 text-leaf-ink" />
        You answered {phase.choice}
      </p>
    );
  }

  const sending = phase.kind === "sending";
  const button =
    "h-11 rounded-[10px] px-4 text-sm font-semibold transition-colors disabled:opacity-50 md:h-8 md:rounded-lg md:text-sidebar-meta";
  return (
    <div className="mt-2" data-testid="quick-replies">
      <div className="flex items-center gap-2 md:gap-1.5">
        {YES_NO_CHOICES.map((choice, index) => (
          <button
            key={choice}
            type="button"
            data-testid={`quick-reply-${choice.toLowerCase()}`}
            disabled={sending}
            onClick={() => void answer(choice)}
            className={cn(
              button,
              "min-w-0 flex-1 md:flex-none",
              index === 0
                ? "border border-primary bg-primary text-primary-foreground hover:opacity-90"
                : "border border-line-2 bg-card text-foreground hover:bg-accent",
            )}
          >
            {choice}
          </button>
        ))}
        <button
          type="button"
          data-testid="quick-reply-feedback"
          aria-label={inFeedback ? "In Feedback" : "Send to Feedback"}
          title="Send to Feedback: reply later, with an AI summary"
          disabled={sending || feedbackPending || inFeedback}
          onClick={() =>
            sendToFeedback({
              eventId: message.id,
              channelId: message.channelId,
              preview: message.content,
              authorPubkey: message.authorPubkey,
            })
          }
          className={cn(
            button,
            "inline-flex shrink-0 items-center justify-center gap-1.5 border border-dashed border-line-2 bg-transparent px-0 text-ink-2 hover:bg-accent max-md:w-11 md:px-3",
          )}
        >
          {inFeedback ? (
            <Check aria-hidden className="size-4 md:size-3.5" />
          ) : (
            <Bell aria-hidden className="size-4 md:size-3.5" />
          )}
          <span className="hidden md:inline">
            {inFeedback ? "In Feedback" : "Feedback"}
          </span>
        </button>
        <span className="ml-auto hidden text-xs text-muted-foreground lg:inline">
          or type a reply
        </span>
      </div>
      {phase.kind === "error" && (
        <p
          role="alert"
          data-testid="quick-reply-error"
          className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-coral-ink"
        >
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          Not sent — {phase.text}
        </p>
      )}
    </div>
  );
}

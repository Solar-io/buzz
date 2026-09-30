import { Bell } from "lucide-react";
import { useState } from "react";

import { sendCardAnswer } from "@/features/channels/lib/cardAnswer.ts";
import { interviewView } from "@/features/channels/lib/cardInterview.ts";
import { useCardAnswerFlow } from "@/features/channels/lib/useCardAnswerFlow.ts";
import { CardInterviewSheet } from "@/features/channels/ui/CardInterviewSheet";
import type { AskItem } from "@/features/home/lib/askDetection.ts";
import { useReminderMutations } from "@/features/reminders/hooks";
import { useRemindMeLater } from "@/features/reminders/ui/RemindMeLaterProvider";
import type {
  Reminder,
  ReminderTarget,
} from "@/features/reminders/lib/reminderTypes.ts";
import type { TimelineMessage } from "@/features/channels/lib/messageBuffer.ts";
import { useWorkflowActions } from "@/features/workflows/useWorkflowActions";
import { useRelaySession } from "@/shared/api/RelaySessionProvider";
import type { NeedRow } from "../lib/workTypes.ts";
import { ActionButton, type ActionSize, Verdict } from "./ActionButton";

export type { ActionSize };

/**
 * The expanded row's actions (phase-1 §2.2: the first visible row renders
 * expanded). Every write checks its verdict and shows the relay's words on
 * failure; nothing clears optimistically — a row leaves when the relay's own
 * echo (an answer, a 46011/46012, a reminder update) says it is done.
 */

function FeedbackBell({
  size,
  target,
}: {
  size: ActionSize;
  target: ReminderTarget | null;
}) {
  const { openReminder } = useRemindMeLater();
  if (!target) {
    return null;
  }
  return (
    <ActionButton
      size={size}
      label="Send to Feedback"
      onClick={() => openReminder(target)}
    >
      <Bell
        aria-hidden
        className={size === "rail" ? "size-3.25" : "size-4.5"}
      />
    </ActionButton>
  );
}

function AskActions({
  ask,
  size,
  onOpen,
}: {
  ask: AskItem;
  size: ActionSize;
  onOpen: () => void;
}) {
  const { session } = useRelaySession();
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; answer: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [sheetOpen, setSheetOpen] = useState(false);
  const flow = useCardAnswerFlow({
    target: ask,
    onPublished: () => setSheetOpen(false),
  });
  const questions = ask.card.questions;
  const options = questions.length === 1 ? (questions[0]?.options ?? []) : [];
  const target: ReminderTarget = {
    eventId: ask.id,
    channelId: ask.channelId,
    preview: ask.card.title,
    authorPubkey: ask.authorPubkey,
  };

  if (phase.kind === "sent" || flow.sentSummary !== null) {
    return (
      <Verdict
        text={`Sent: ${phase.kind === "sent" ? phase.answer : flow.sentSummary}`}
      />
    );
  }

  const answer = async (label: string) => {
    setPhase({ kind: "sending" });
    try {
      const result = await sendCardAnswer(session, ask, label);
      setPhase(
        result.ok
          ? { kind: "sent", answer: label }
          : {
              kind: "error",
              message: result.message || "The relay rejected the reply.",
            },
      );
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const view = interviewView(ask.card, flow.state);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {options.length > 0 && options.length <= 4 ? (
          options.map((option, index) => (
            <ActionButton
              key={option.id}
              size={size}
              grow={size === "page"}
              tone={
                option.recommended === true ||
                (index === 0 && !options.some((o) => o.recommended))
                  ? "primary"
                  : "secondary"
              }
              disabled={phase.kind === "sending"}
              onClick={() => void answer(option.label)}
            >
              {option.label}
            </ActionButton>
          ))
        ) : (
          <ActionButton
            size={size}
            grow={size === "page"}
            tone="primary"
            disabled={flow.busy}
            onClick={() => setSheetOpen(true)}
          >
            {view.answeredCount > 0
              ? `Resume ${view.answeredCount}/${view.total}`
              : questions.length > 1
                ? `Answer ${questions.length} questions`
                : "Answer"}
          </ActionButton>
        )}
        {/* On the phone card the title itself opens the message. */}
        {size === "rail" && (
          <ActionButton size={size} tone="dashed" onClick={onOpen}>
            Open
          </ActionButton>
        )}
        <FeedbackBell size={size} target={target} />
      </div>
      {phase.kind === "error" && <Verdict error text={phase.message} />}
      {flow.phase.kind === "error" && (
        <Verdict error text={flow.phase.message} />
      )}
      <CardInterviewSheet
        card={ask.card}
        state={flow.state}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onChange={flow.update}
        onSubmit={flow.submit}
        busy={flow.busy}
        onAnswerInChat={() => {
          setSheetOpen(false);
          onOpen();
        }}
      />
    </div>
  );
}

function ApprovalActions({
  approvalRef,
  size,
  onReview,
}: {
  approvalRef: string;
  size: ActionSize;
  onReview: () => void;
}) {
  const { decideApproval } = useWorkflowActions();
  const [phase, setPhase] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "sent"; approved: boolean }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const decide = async (approved: boolean) => {
    setPhase({ kind: "sending" });
    try {
      await decideApproval(approvalRef, approved);
      setPhase({ kind: "sent", approved });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  if (phase.kind === "sent") {
    return (
      <Verdict
        text={`${phase.approved ? "Approved" : "Denied"} — waiting for the relay to confirm`}
      />
    );
  }
  return (
    <div>
      <div className="flex gap-1.5">
        <ActionButton
          size={size}
          tone="primary"
          grow={size === "page"}
          disabled={phase.kind === "sending"}
          onClick={() => void decide(true)}
        >
          Approve
        </ActionButton>
        <ActionButton
          size={size}
          grow={size === "page"}
          disabled={phase.kind === "sending"}
          onClick={() => void decide(false)}
        >
          Deny
        </ActionButton>
        <ActionButton size={size} tone="dashed" onClick={onReview}>
          Review
        </ActionButton>
      </div>
      {phase.kind === "error" && <Verdict error text={phase.message} />}
    </div>
  );
}

function FeedbackActions({
  reminder,
  size,
  onOpen,
  selfPubkey,
}: {
  reminder: Reminder;
  size: ActionSize;
  onOpen: () => void;
  selfPubkey: string | null;
}) {
  const { snooze, complete } = useReminderMutations(selfPubkey);
  const error = snooze.error ?? complete.error;
  return (
    <div>
      <div className="flex gap-1.5">
        <ActionButton
          size={size}
          tone="primary"
          grow={size === "page"}
          onClick={onOpen}
        >
          Open
        </ActionButton>
        <ActionButton
          size={size}
          grow={size === "page"}
          disabled={snooze.isPending}
          onClick={() =>
            snooze.mutate({
              reminder,
              notBefore: Math.floor(Date.now() / 1000) + 3_600,
            })
          }
        >
          Snooze 1h
        </ActionButton>
        <ActionButton
          size={size}
          tone="ghost"
          disabled={complete.isPending}
          onClick={() => complete.mutate(reminder)}
        >
          Done
        </ActionButton>
      </div>
      {error ? <Verdict error text={error.message} /> : null}
    </div>
  );
}

function MentionActions({
  message,
  size,
  onOpen,
  onMarkRead,
}: {
  message: TimelineMessage;
  size: ActionSize;
  onOpen: () => void;
  onMarkRead: () => void;
}) {
  return (
    <div className="flex gap-1.5">
      <ActionButton
        size={size}
        tone="primary"
        grow={size === "page"}
        onClick={onOpen}
      >
        Open
      </ActionButton>
      <ActionButton size={size} grow={size === "page"} onClick={onMarkRead}>
        Mark read
      </ActionButton>
      <FeedbackBell
        size={size}
        target={{
          eventId: message.id,
          channelId: message.channelId,
          preview: message.content,
          authorPubkey: message.authorPubkey,
        }}
      />
    </div>
  );
}

export function NeedActions({
  row,
  size,
  selfPubkey,
  onOpen,
  onOpenView,
  onMarkRead,
}: {
  row: NeedRow;
  size: ActionSize;
  selfPubkey: string | null;
  onOpen: () => void;
  onOpenView: (view: "workflows" | "reminders") => void;
  onMarkRead: () => void;
}) {
  switch (row.source.kind) {
    case "ask":
      return (
        <AskActions
          ask={row.source.interview.ask}
          size={size}
          onOpen={onOpen}
        />
      );
    case "approval":
      return (
        <ApprovalActions
          approvalRef={row.source.approval.ref}
          size={size}
          onReview={() => onOpenView("workflows")}
        />
      );
    case "feedback":
      return (
        <FeedbackActions
          reminder={row.source.reminder}
          size={size}
          onOpen={onOpen}
          selfPubkey={selfPubkey}
        />
      );
    case "mention":
      return (
        <MentionActions
          message={row.source.item.message}
          size={size}
          onOpen={onOpen}
          onMarkRead={onMarkRead}
        />
      );
  }
}

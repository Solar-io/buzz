import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { useReminderMutations, useRemindersQuery } from "../hooks.ts";
import { feedbackConfirmation, feedbackDueAt } from "../lib/feedback.ts";
import { pendingTargetEventIds } from "../lib/reminderFilters.ts";
import type { ReminderTarget } from "../lib/reminderTypes.ts";
import { RemindMeLaterDialog } from "./RemindMeLaterDialog.tsx";

interface RemindMeLaterContextValue {
  /** Raise the create dialog for one message. */
  openReminder: (target: ReminderTarget) => void;
  /**
   * "Send to Feedback": one click files the message as a reminder due
   * tomorrow 9:00 AM local — no dialog. Same mutation as the dialog, so the
   * reminder is indistinguishable from one made there at that time, and it
   * can be moved from the snooze menu like any other.
   */
  sendToFeedback: (target: ReminderTarget) => void;
  /** A Feedback write is in flight — its buttons disable on this. */
  feedbackPending: boolean;
  /**
   * Publish a reminder at an explicit time (the `/remind` command). Rejects
   * with the relay's words; the caller shows them.
   */
  createReminder: (input: {
    target: ReminderTarget;
    notBefore: number;
  }) => Promise<void>;
  /** Event ids of messages that already carry a pending reminder. */
  pendingEventIds: ReadonlySet<string>;
}

const RemindMeLaterContext = createContext<RemindMeLaterContextValue>({
  openReminder: () => {},
  sendToFeedback: () => {},
  feedbackPending: false,
  createReminder: async () => {
    throw new Error("Reminders are not available here.");
  },
  pendingEventIds: new Set<string>(),
});

/**
 * The shell's handle on reminders, for everything below it that files one:
 * the hover bar's Feedback button, quick replies, Work rows, toasts and the
 * `/remind` command.
 *
 * A context rather than props because the triggers live several components
 * below the shell (a hover bar inside a timeline row) and both the dialog and
 * the success toast have to outlive that row — a dialog mounted in the row
 * would unmount the moment the pointer leaves it.
 */
export function useRemindMeLater(): RemindMeLaterContextValue {
  return useContext(RemindMeLaterContext);
}

export function RemindMeLaterProvider({
  children,
  selfPubkey,
}: {
  children: ReactNode;
  selfPubkey: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ReminderTarget | null>(null);

  const openReminder = useCallback((next: ReminderTarget) => {
    setTarget(next);
    setOpen(true);
  }, []);

  // The dialog's own mutation hook: its success invalidates the shared
  // reminders query, so Work, the panel and the message tint all update.
  const { create } = useReminderMutations(selfPubkey);
  // `create.isPending` only flips on the next render, so a double-click could
  // land two calls before the button disables. The ref closes that window.
  const inFlight = useRef(false);
  const createMutate = create.mutate;
  const sendToFeedback = useCallback(
    (next: ReminderTarget) => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      const notBefore = feedbackDueAt(Date.now());
      createMutate(
        { target: next, notBefore },
        {
          onSuccess: () => {
            toast.success(feedbackConfirmation(notBefore));
          },
          // Same text as the dialog's failure path — including the
          // ReminderKeyUnavailableError message for extension-signer sessions.
          onError: (error) => {
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to send to Feedback",
            );
          },
          onSettled: () => {
            inFlight.current = false;
          },
        },
      );
    },
    [createMutate],
  );
  const feedbackPending = create.isPending;

  const createMutateAsync = create.mutateAsync;
  const createReminder = useCallback(
    async (input: { target: ReminderTarget; notBefore: number }) => {
      await createMutateAsync(input);
    },
    [createMutateAsync],
  );

  const reminders = useRemindersQuery(selfPubkey).data;
  const pendingEventIds = useMemo(
    () => pendingTargetEventIds(reminders ?? []),
    [reminders],
  );

  const value = useMemo(
    () => ({
      openReminder,
      sendToFeedback,
      feedbackPending,
      createReminder,
      pendingEventIds,
    }),
    [
      openReminder,
      sendToFeedback,
      feedbackPending,
      createReminder,
      pendingEventIds,
    ],
  );

  return (
    <RemindMeLaterContext.Provider value={value}>
      {children}
      <RemindMeLaterDialog
        onOpenChange={setOpen}
        open={open}
        selfPubkey={selfPubkey}
        target={target}
      />
    </RemindMeLaterContext.Provider>
  );
}

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
import {
  quickRemindConfirmation,
  quickRemindDueAt,
} from "../lib/quickRemind.ts";
import { pendingTargetEventIds } from "../lib/reminderFilters.ts";
import type { ReminderTarget } from "../lib/reminderTypes.ts";
import { RemindMeLaterDialog } from "./RemindMeLaterDialog.tsx";

interface RemindMeLaterContextValue {
  /** Raise the create dialog for one message. */
  openReminder: (target: ReminderTarget) => void;
  /**
   * The hover bar's "+": create a reminder due one day from now, no dialog.
   * Same mutation as the dialog, so the reminder is indistinguishable from
   * one made there with a +24h custom time.
   */
  quickRemind: (target: ReminderTarget) => void;
  /** A "+" reminder is in flight — the button disables on this. */
  quickRemindPending: boolean;
  /** Event ids of messages that already carry a pending reminder. */
  pendingEventIds: ReadonlySet<string>;
}

const RemindMeLaterContext = createContext<RemindMeLaterContextValue>({
  openReminder: () => {},
  quickRemind: () => {},
  quickRemindPending: false,
  pendingEventIds: new Set<string>(),
});

/**
 * The message action bar's handle on reminders.
 *
 * A context rather than props because the trigger lives several components
 * below the shell (the hover bar inside a timeline row) and the dialog has to
 * outlive that row — a dialog mounted in the row would unmount the moment the
 * pointer leaves it. The "+" quick reminder lives here for the same reason:
 * its success toast must not depend on the row staying mounted.
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
  // reminders query, so the panel, nav badge and message tint all update.
  const { create } = useReminderMutations(selfPubkey);
  // `create.isPending` only flips on the next render, so a double-click could
  // land two calls before the button disables. The ref closes that window.
  const quickInFlight = useRef(false);
  const createMutate = create.mutate;
  const quickRemind = useCallback(
    (next: ReminderTarget) => {
      if (quickInFlight.current) {
        return;
      }
      quickInFlight.current = true;
      const notBefore = quickRemindDueAt(Date.now());
      createMutate(
        { target: next, notBefore },
        {
          onSuccess: () => {
            toast.success(quickRemindConfirmation(notBefore));
          },
          // Same text as the dialog's failure path — including the
          // ReminderKeyUnavailableError message for extension-signer sessions.
          onError: (error) => {
            toast.error(
              error instanceof Error
                ? error.message
                : "Failed to create the reminder",
            );
          },
          onSettled: () => {
            quickInFlight.current = false;
          },
        },
      );
    },
    [createMutate],
  );
  const quickRemindPending = create.isPending;

  const reminders = useRemindersQuery(selfPubkey).data;
  const pendingEventIds = useMemo(
    () => pendingTargetEventIds(reminders ?? []),
    [reminders],
  );

  const value = useMemo(
    () => ({ openReminder, quickRemind, quickRemindPending, pendingEventIds }),
    [openReminder, quickRemind, quickRemindPending, pendingEventIds],
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

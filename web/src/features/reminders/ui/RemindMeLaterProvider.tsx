import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useRemindersQuery } from "../hooks.ts";
import { pendingTargetEventIds } from "../lib/reminderFilters.ts";
import type { ReminderTarget } from "../lib/reminderTypes.ts";
import { RemindMeLaterDialog } from "./RemindMeLaterDialog.tsx";

interface RemindMeLaterContextValue {
  /** Raise the create dialog for one message. */
  openReminder: (target: ReminderTarget) => void;
  /** Event ids of messages that already carry a pending reminder. */
  pendingEventIds: ReadonlySet<string>;
}

const RemindMeLaterContext = createContext<RemindMeLaterContextValue>({
  openReminder: () => {},
  pendingEventIds: new Set<string>(),
});

/**
 * The message action bar's handle on reminders.
 *
 * A context rather than props because the trigger lives several components
 * below the shell (the hover bar inside a timeline row) and the dialog has to
 * outlive that row — a dialog mounted in the row would unmount the moment the
 * pointer leaves it.
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

  const reminders = useRemindersQuery(selfPubkey).data;
  const pendingEventIds = useMemo(
    () => pendingTargetEventIds(reminders ?? []),
    [reminders],
  );

  const value = useMemo(
    () => ({ openReminder, pendingEventIds }),
    [openReminder, pendingEventIds],
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

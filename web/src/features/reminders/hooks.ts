import { useEffect } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { useRelaySession } from "@/shared/api/RelaySessionProvider";

import { countDue } from "./lib/reminderFilters.ts";
import {
  cancelReminder,
  completeReminder,
  createReminder,
  fetchReminders,
  snoozeReminder,
} from "./lib/reminderService.ts";
import {
  KIND_EVENT_REMINDER,
  type Reminder,
  type ReminderTarget,
} from "./lib/reminderTypes.ts";

/**
 * Local re-check cadence.
 *
 * NIP-ER makes the client the final authority on `not_before` — a relay may
 * serve early, late, or not at all — so this poll exists even though the
 * relay advertises push due-delivery. Thirty seconds matches the desktop.
 */
export const REMINDER_POLL_MS = 30_000;

export const remindersQueryKey = (pubkey: string): QueryKey => [
  "reminders",
  pubkey,
];

/**
 * The one source of truth for a viewer's reminders.
 *
 * Panel, badge, message tint and the fire-on-due runtime all read this query,
 * so an invalidation from any mutation keeps every surface in step — and, as
 * importantly, the poll makes `countDue` re-evaluate, so a reminder that
 * crosses its due time while the app sits idle surfaces within the interval
 * instead of on the next navigation.
 */
export function useRemindersQuery(selfPubkey: string | null) {
  const { session, status } = useRelaySession();
  return useQuery<Reminder[]>({
    enabled: status === "open" && !!selfPubkey,
    queryKey: remindersQueryKey(selfPubkey ?? ""),
    queryFn: () => fetchReminders(session, selfPubkey as string),
    staleTime: 15_000,
    refetchInterval: REMINDER_POLL_MS,
  });
}

/**
 * A live `kind:30300` subscription that invalidates the query on any arrival.
 *
 * This is what makes the relay's push due-delivery reach the UI. NIP-ER's
 * due signal is not a new event — the relay re-sends the SAME reminder when
 * `not_before` passes — so nothing about the local cache changes on its own;
 * the arrival is the signal, and invalidating is how it becomes visible. It
 * also carries cross-device edits: snoozing on the desktop lands here without
 * waiting out the poll.
 *
 * `authors` is required by the relay for a 30300-only filter, and `since` is
 * deliberately absent: `since` compares against `created_at`, not
 * `not_before`, so bounding it would filter out a reminder created last week
 * that comes due today.
 */
export function useReminderSync(selfPubkey: string | null): void {
  const { session, status } = useRelaySession();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (status !== "open" || !selfPubkey) {
      return;
    }
    return session.subscribe(
      { kinds: [KIND_EVENT_REMINDER], authors: [selfPubkey] },
      {
        onEvent: () => {
          void queryClient.invalidateQueries({
            queryKey: remindersQueryKey(selfPubkey),
          });
        },
      },
    );
  }, [session, status, selfPubkey, queryClient]);
}

/** How many reminders are due right now — the nav badge's number. */
export function useDueReminderCount(selfPubkey: string | null): number {
  const query = useRemindersQuery(selfPubkey);
  return countDue(query.data ?? [], Math.floor(Date.now() / 1_000));
}

/**
 * Every reminder write, each invalidating the shared query on success.
 *
 * A mutation that skipped the invalidation would leave the panel showing the
 * pre-write state until the next poll — which for a snooze means the row
 * stays in Overdue for up to thirty seconds after the user moved it.
 */
export function useReminderMutations(selfPubkey: string | null) {
  const { session } = useRelaySession();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: remindersQueryKey(selfPubkey ?? ""),
    });
  };

  const requirePubkey = (): string => {
    if (!selfPubkey) {
      throw new Error("Sign in to manage reminders.");
    }
    return selfPubkey;
  };

  const create = useMutation({
    mutationFn: (input: {
      target?: ReminderTarget;
      note?: string;
      notBefore: number;
    }) => createReminder(session, requirePubkey(), input),
    onSuccess: invalidate,
  });

  const snooze = useMutation({
    mutationFn: (input: { reminder: Reminder; notBefore: number }) =>
      snoozeReminder(session, requirePubkey(), input.reminder, input.notBefore),
    onSuccess: invalidate,
  });

  const complete = useMutation({
    mutationFn: (reminder: Reminder) =>
      completeReminder(session, requirePubkey(), reminder),
    onSuccess: invalidate,
  });

  const cancel = useMutation({
    mutationFn: (reminder: Reminder) =>
      cancelReminder(session, requirePubkey(), reminder),
    onSuccess: invalidate,
  });

  return { create, snooze, complete, cancel };
}

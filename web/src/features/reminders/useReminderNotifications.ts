import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  useNotificationPermission,
  useNotificationSettings,
} from "@/features/notifications/hooks";

import { notify } from "@/shared/ui/notify";
import {
  decisionToastSuppressed,
  isPhoneViewport,
  workPageOnScreen,
} from "@/shared/ui/toastStack";

import {
  remindersQueryKey,
  useReminderMutations,
  useRemindersQuery,
} from "./hooks.ts";
import { readWatermark, writeWatermark } from "./lib/dueWatermark.ts";
import { reminderAlertCopy } from "./lib/reminderAlert.ts";
import { dueSince } from "./lib/reminderFilters.ts";
import { reminderDestination } from "./lib/reminderNavigation.ts";
import type { Reminder } from "./lib/reminderTypes.ts";

/** How often the page re-checks whether anything has come due. */
export const REMINDER_CHECK_INTERVAL_MS = 30_000;

export interface ReminderNotificationOptions {
  selfPubkey: string | null;
  /** Raise the reminders panel; wired to the toast's action button. */
  onOpenPanel?: () => void;
  /** Jump to the reminded message — a single due reminder's Open. */
  onOpenMessage?: (channelId: string, messageId: string) => void;
}

/**
 * Fire-on-due detection, mounted once at the shell.
 *
 * Two surfaces, deliberately, because they have different gates:
 *
 *  - an in-app toast, ALWAYS. It needs no permission, it is the surface a
 *    user actually sees while working in the tab, and it is the only one a
 *    browser test can observe — an OS notification is drawn outside the page.
 *  - an OS notification, only when the viewer has switched desktop
 *    notifications on AND the browser has granted permission. Both facts come
 *    from `features/notifications` rather than being re-derived here: this
 *    hook never calls `Notification.requestPermission`, so it cannot fight
 *    the message runtime over the prompt.
 *
 * The watermark advances on EVERY check, including ones where both surfaces
 * were suppressed. Re-enabling notifications later must not replay a backlog
 * of reminders that came due while they were muted — the panel and the badge
 * already carry that history.
 */
export function useReminderNotifications(
  options: ReminderNotificationOptions,
): void {
  const { selfPubkey, onOpenPanel, onOpenMessage } = options;
  const query = useRemindersQuery(selfPubkey);
  const { snooze } = useReminderMutations(selfPubkey);
  const queryClient = useQueryClient();
  const settings = useNotificationSettings();
  const permission = useNotificationPermission();

  // Everything the interval callback reads but must not restart it.
  const latest = useRef({
    reminders: query.data,
    settings,
    permission,
    onOpenPanel,
    onOpenMessage,
    snooze: snooze.mutate,
  });
  latest.current = {
    reminders: query.data,
    settings,
    permission,
    onOpenPanel,
    onOpenMessage,
    snooze: snooze.mutate,
  };

  // The query is `undefined` until it first resolves. Firing off that empty
  // state would advance the watermark past every reminder that came due while
  // the tab was closed — the exact window this feature exists for.
  const resolvedRef = useRef(false);
  if (query.data !== undefined) {
    resolvedRef.current = true;
  }

  useEffect(() => {
    if (!selfPubkey) {
      return;
    }

    const fire = (due: Reminder[]) => {
      const copy = reminderAlertCopy(due);
      if (!copy) {
        return;
      }
      const current = latest.current;

      // Sticky (the redesign's feedback-due toast): it stays until acted
      // on. One due reminder opens its message and can be snoozed from the
      // toast; a batch opens the panel.
      const only = due.length === 1 ? due[0] : null;
      const destination = only
        ? reminderDestination(only.content.target)
        : null;
      // Phase 1 QA: over the phone's Work page the toast would land on the
      // very row it names, covering it. The row is the notice there.
      const covered = decisionToastSuppressed("feedbackDue", {
        workVisible: false,
        workPage: workPageOnScreen(),
        phone: isPhoneViewport(),
      });
      if (!covered) {
        notify.feedbackDue(
          {
            context: only ? "" : `${due.length} reminders`,
            body: copy.body,
            ai: false,
            onOpen: () => {
              const now = latest.current;
              if (destination && now.onOpenMessage) {
                now.onOpenMessage(destination.channelId, destination.messageId);
              } else {
                now.onOpenPanel?.();
              }
            },
            onSnooze: only
              ? () =>
                  latest.current.snooze({
                    reminder: only,
                    notBefore: Math.floor(Date.now() / 1_000) + 3_600,
                  })
              : undefined,
          },
          copy.tag,
        );
      }

      if (
        !current.settings.desktopEnabled ||
        current.permission !== "granted"
      ) {
        return;
      }
      try {
        const notification = new Notification(copy.title, {
          body: copy.body,
          tag: copy.tag,
          icon: "/assets/icons/icon-192.png",
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
          latest.current.onOpenPanel?.();
        };
      } catch {
        // Some browsers refuse a Notification constructed outside a service
        // worker (mobile Chrome). The toast already fired; nothing to recover.
      }
    };

    const check = () => {
      if (!resolvedRef.current) {
        return;
      }
      const now = Math.floor(Date.now() / 1_000);
      const watermark = readWatermark(window.localStorage, selfPubkey, now);
      fire(dueSince(latest.current.reminders ?? [], watermark, now));
      writeWatermark(window.localStorage, selfPubkey, now);
      // Liveness tick: re-render every `countDue` consumer so a reminder that
      // crossed its due time while the tab sat idle surfaces on this interval
      // rather than on the next navigation.
      void queryClient.invalidateQueries({
        queryKey: remindersQueryKey(selfPubkey),
      });
    };

    check();
    const interval = window.setInterval(check, REMINDER_CHECK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [selfPubkey, queryClient]);
}

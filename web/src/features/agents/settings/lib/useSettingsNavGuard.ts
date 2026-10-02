import { useBlocker } from "@tanstack/react-router";

/** Guard route/search changes (including agent switches) and native unloads. */
export function useSettingsNavGuard({
  count,
  screenName,
  discard,
  busy = false,
}: {
  count: number;
  screenName: string;
  discard: () => void;
  busy?: boolean;
}) {
  const blocker = useBlocker({
    shouldBlockFn: () => count > 0 || busy,
    enableBeforeUnload: count > 0 || busy,
    withResolver: true,
  });
  return {
    open: blocker.status === "blocked",
    prompt: `Discard ${count} ${count === 1 ? "change" : "changes"} to ${screenName}?`,
    keepEditing: () => blocker.reset?.(),
    discardAndProceed: () => {
      if (busy) return;
      discard();
      blocker.proceed?.();
    },
  };
}

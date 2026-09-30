import { useEffect, useRef } from "react";

/**
 * `?m=<id>&reply=1` — land on a message ready to answer it (a message
 * toast's Reply, web redesign Phase 2). In a channel that is the message's
 * inline thread with the caret in its reply box; in a DM, where the
 * conversation IS the reply, it is the composer.
 *
 * Fires once per message id, and only once the permalink has resolved to a
 * row (`topLevelId`): acting before the message loads would open a thread
 * on nothing. The flag is dropped from the URL with `m` by the permalink
 * cleanup, so a reload does not re-focus.
 */
export function useReplyIntent(options: {
  reply: true | undefined;
  messageId: string | undefined;
  /** The permalink's row — the message itself, or its thread's root row. */
  topLevelId: string | null;
  isDm: boolean;
  replyInThread: (rowId: string) => void;
  focusComposer: () => void;
}) {
  const handled = useRef<string | null>(null);
  const { reply, messageId, topLevelId, isDm } = options;
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!reply || !messageId || topLevelId == null) {
      return;
    }
    if (handled.current === messageId) {
      return;
    }
    handled.current = messageId;
    if (isDm) {
      latest.current.focusComposer();
    } else {
      latest.current.replyInThread(topLevelId);
    }
  }, [reply, messageId, topLevelId, isDm]);
}

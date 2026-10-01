import { useCallback, useEffect, useState } from "react";
import {
  choicesFor,
  type ThreadChoices,
  withThreadChoice,
} from "./lib/inlineThread.ts";

const NONE: ThreadChoices = new Map();

/**
 * Which rows' inline threads the viewer opened or folded (web redesign
 * Phase 2), and which reply box holds the caret.
 *
 * Threads are open by default (`threadOpen` in lib/inlineThread.ts), so what
 * this keeps is the viewer's explicit choices: a fold, or an open on a row
 * with no replies yet (↩). The route owns them rather than the timeline
 * because three things open a thread from outside a row: a permalink to a
 * reply (`reveal`), the ↩ action and a card's "Answer in chat instead"
 * (`reply`, which also hands the caret to that thread's reply box).
 *
 * Choices are kept per conversation for the session: a thread folded in one
 * channel is still folded on the way back to it. The caret is not — a switch
 * drops `focusId`, so returning never steals focus into an old reply box.
 */
export function useInlineThreads(conversationId: string | undefined) {
  const [all, setAll] = useState<ThreadChoices>(NONE);
  const [focusId, setFocusId] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the reset trigger by design — read nowhere in the effect
  useEffect(() => {
    setFocusId(null);
  }, [conversationId]);

  const toggle = useCallback(
    (rowId: string, open: boolean) => {
      setAll((previous) =>
        withThreadChoice(previous, conversationId, rowId, open),
      );
      if (!open) {
        setFocusId((previous) => (previous === rowId ? null : previous));
      }
    },
    [conversationId],
  );
  const reply = useCallback(
    (rowId: string) => {
      setAll((previous) =>
        withThreadChoice(previous, conversationId, rowId, true),
      );
      setFocusId(rowId);
    },
    [conversationId],
  );
  const reveal = useCallback(
    (rowId: string) => {
      setAll((previous) =>
        withThreadChoice(previous, conversationId, rowId, true),
      );
    },
    [conversationId],
  );

  return {
    choices: choicesFor(all, conversationId),
    focusId,
    toggle,
    reply,
    reveal,
  };
}

import { useCallback, useEffect, useState } from "react";

interface ThreadsState {
  expanded: ReadonlySet<string>;
  focusId: string | null;
}

const NONE: ThreadsState = { expanded: new Set(), focusId: null };

function withRow(
  expanded: ReadonlySet<string>,
  rowId: string,
  open: boolean,
): ReadonlySet<string> {
  if (expanded.has(rowId) === open) {
    return expanded;
  }
  const next = new Set(expanded);
  if (open) {
    next.add(rowId);
  } else {
    next.delete(rowId);
  }
  return next;
}

/**
 * Which rows' inline threads are open in the conversation on screen (web
 * redesign Phase 2).
 *
 * The route owns this rather than the timeline because three things open a
 * thread from outside a row: a permalink to a reply (`reveal`), the ↩ action
 * and a card's "Answer in chat instead" (`reply`, which also hands the caret
 * to that thread's reply box).
 *
 * The open set belongs to the conversation it was opened in: switching
 * conversations folds everything. Unlike the old thread pane, nothing is
 * "kept open" across a switch — a thread lives under its message, and the
 * message is not on screen anymore.
 */
export function useInlineThreads(conversationId: string | undefined) {
  const [state, setState] = useState<ThreadsState>(NONE);

  // biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the reset trigger by design — read nowhere in the effect
  useEffect(() => {
    setState(NONE);
  }, [conversationId]);

  const toggle = useCallback((rowId: string, open: boolean) => {
    setState((previous) => ({
      expanded: withRow(previous.expanded, rowId, open),
      focusId: !open && previous.focusId === rowId ? null : previous.focusId,
    }));
  }, []);
  const reply = useCallback((rowId: string) => {
    setState((previous) => ({
      expanded: withRow(previous.expanded, rowId, true),
      focusId: rowId,
    }));
  }, []);
  const reveal = useCallback((rowId: string) => {
    setState((previous) => {
      const expanded = withRow(previous.expanded, rowId, true);
      return expanded === previous.expanded
        ? previous
        : { expanded, focusId: previous.focusId };
    });
  }, []);

  return {
    expandedIds: state.expanded,
    focusId: state.focusId,
    toggle,
    reply,
    reveal,
  };
}

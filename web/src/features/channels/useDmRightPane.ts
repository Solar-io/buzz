import { useEffect, useState } from "react";
import {
  thinkingPaneVisible,
  threadPaneVisible,
  threadToggleAvailable,
  toggleThinkingPatch,
  toggleThreadPatch,
  type DmPanePatch,
  type DmPaneState,
  type PaneToggles,
  type RightTab,
} from "./lib/dmPaneToggles.ts";

/**
 * The DM right-pane state the route used to hold inline, plus the two-way
 * toggles Sam asked for on 2026-09-22 (🧠 and the new Replies button).
 *
 * Extracted from `repos.tsx` when the toggles arrived: the show/hide policy
 * lives in `lib/dmPaneToggles.ts` (pure, unit-tested), this hook owns the
 * three state cells and the viewport flag, and the route keeps `threadRootId`
 * itself because the permalink effect and the thread lookup read it long
 * before the DM agent is known.
 *
 * The viewport flag mirrors the lg breakpoint the panes switch on
 * (`AgentActivityPanel`'s `lg:static` dock, `ThreadPanel`'s overlay): below it,
 * the thinking pane is only on screen while the sheet is open, which is one
 * of the two inputs `thinkingPaneVisible` reads.
 */
export function useDmRightPane(options: {
  /** An agent DM is open (both tabs exist). */
  agentDm: boolean;
  /** The selected conversation — a change forgets the remembered thread root. */
  channelId: string | undefined;
  threadRootId: string | null;
  /** The route's setter — the Replies toggle can restore a remembered root. */
  setThreadRootId: (id: string | null) => void;
}) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [dmPaneHidden, setDmPaneHidden] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("thinking");
  const [lastThreadRootId, setLastThreadRootId] = useState<string | null>(null);
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? !window.matchMedia("(min-width: 1024px)").matches
      : false,
  );

  // D-1 (QA 2026-09-22): a remembered thread root belongs to the channel it
  // was opened in. Switching conversations must forget it, or the Replies
  // toggle stays enabled in a channel where the root can never resolve —
  // phantom-pressed with no pane. Declared BEFORE the remember effect so a
  // deep link that sets channel + root in one update still remembers.
  useEffect(() => {
    setLastThreadRootId(null);
  }, [options.channelId]);

  useEffect(() => {
    if (options.threadRootId !== null) {
      setLastThreadRootId(options.threadRootId);
    }
  }, [options.threadRootId]);

  useEffect(() => {
    if (!window.matchMedia) {
      return;
    }
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setMobile(!query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Snapshot read at click time — the toggles fire from the composer's
  // action row, not from a render, so they must not close over stale state.
  const state = (): DmPaneState => ({
    agentDm: options.agentDm,
    paneHidden: dmPaneHidden,
    mobileOpen: thinkingOpen,
    mobile,
    threadRootId: options.threadRootId,
    rightTab,
    lastThreadRootId,
  });

  const applyPatch = (patch: DmPanePatch) => {
    if (patch.paneHidden !== undefined) {
      setDmPaneHidden(patch.paneHidden);
    }
    if (patch.mobileOpen !== undefined) {
      setThinkingOpen(patch.mobileOpen);
    }
    if (patch.rightTab !== undefined) {
      setRightTab(patch.rightTab);
    }
    if (patch.threadRootId !== undefined) {
      options.setThreadRootId(patch.threadRootId);
    }
  };

  return {
    thinkingOpen,
    setThinkingOpen,
    dmPaneHidden,
    setDmPaneHidden,
    rightTab,
    setRightTab,
    /** The composer action row's 🧠 + Replies controls, as one group. */
    panes: {
      thinkingVisible: thinkingPaneVisible(state()),
      toggleThinking: () => applyPatch(toggleThinkingPatch(state())),
      threadsVisible: threadPaneVisible(state()),
      threadsAvailable: threadToggleAvailable(state()),
      toggleThreads: () => {
        const patch = toggleThreadPatch(state());
        if (patch) {
          applyPatch(patch);
        }
      },
    } satisfies PaneToggles,
  };
}

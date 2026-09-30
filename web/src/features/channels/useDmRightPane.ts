import { useEffect, useRef, useState } from "react";
import { loadRightTab, saveRightTab } from "@/features/work/lib/workPrefs.ts";
import {
  thinkingPaneVisible,
  threadPaneVisible,
  threadToggleAvailable,
  toggleThinkingPatch,
  toggleThreadPatch,
  type DmPanePatch,
  type DmPaneState,
  type PaneToggles,
  type RightTabId,
} from "./lib/dmPaneToggles.ts";
import {
  loadThinkingPaneHidden,
  saveThinkingPaneHidden,
} from "./lib/thinkingPanePref.ts";

function paneStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The right pane's tab state (web redesign phase-1 §3: Work | Thread |
 * Thinking) plus the two-way 🧠 and Replies toggles Sam asked for on
 * 2026-09-22.
 *
 * The policy lives in `lib/dmPaneToggles.ts` (pure, unit-tested); this hook
 * owns the state cells and the viewport flag, and the route keeps
 * `threadRootId` itself because the permalink effect and the thread lookup
 * read it long before the DM agent is known.
 *
 * The viewport flag mirrors the lg breakpoint the panes switch on: below it
 * the thinking pane is only on screen while its sheet is open, which is one
 * of the inputs `thinkingPaneVisible` reads.
 */
export function useDmRightPane(options: {
  /** An agent DM is open (the thinking tab can exist). */
  agentDm: boolean;
  /** The selected conversation — a change forgets the remembered thread root. */
  channelId: string | undefined;
  threadRootId: string | null;
  /** The route's setter — the Replies toggle can restore a remembered root. */
  setThreadRootId: (id: string | null) => void;
  /** Whose remembered pane choice applies (plan item 1); null = default. */
  ownerPubkey?: string | null;
}) {
  const owner = options.ownerPubkey ?? null;
  const [thinkingOpen, setThinkingOpen] = useState(false);
  // Thinking tab: closed by default, and each user's last choice sticks.
  const [dmPaneHidden, setPaneHiddenState] = useState(() =>
    loadThinkingPaneHidden(paneStorage(), owner),
  );
  useEffect(() => {
    setPaneHiddenState(loadThinkingPaneHidden(paneStorage(), owner));
  }, [owner]);
  const setDmPaneHidden = (hidden: boolean) => {
    saveThinkingPaneHidden(paneStorage(), owner, hidden);
    setPaneHiddenState(hidden);
  };
  const [tabs, setTabs] = useState<{
    active: RightTabId;
    previous: RightTabId;
  }>(() => ({ active: loadRightTab(), previous: "work" }));
  const [lastThreadRootId, setLastThreadRootId] = useState<string | null>(null);
  const [mobile, setMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia
      ? !window.matchMedia("(min-width: 1024px)").matches
      : false,
  );

  const setActive = (active: RightTabId, previous?: RightTabId) => {
    setTabs((current) => {
      if (current.active === active) {
        return previous === undefined ? current : { active, previous };
      }
      return { active, previous: previous ?? current.active };
    });
    saveRightTab(active);
  };

  // D-1 (QA 2026-09-22): a remembered thread root belongs to the channel it
  // was opened in. Switching conversations must forget it, or the Replies
  // toggle stays enabled in a channel where the root can never resolve —
  // phantom-pressed with no pane. Declared BEFORE the remember effect so a
  // deep link that sets channel + root in one update still remembers.
  // biome-ignore lint/correctness/useExhaustiveDependencies: channelId is the reset trigger by design — read nowhere in the effect
  useEffect(() => {
    setLastThreadRootId(null);
  }, [options.channelId]);

  useEffect(() => {
    if (options.threadRootId !== null) {
      setLastThreadRootId(options.threadRootId);
    }
  }, [options.threadRootId]);

  // Entering an agent DM whose thinking tab is open selects it — once per
  // entry (today's default: the thinking pane opens), not on every render,
  // so a viewer who then picks Work stays on Work.
  const enteredRef = useRef<string | null>(null);
  const entryKey =
    options.agentDm && !dmPaneHidden ? (options.channelId ?? null) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on entry only; setActive is a fresh closure over a stable setter
  useEffect(() => {
    if (entryKey === null || enteredRef.current === entryKey) {
      return;
    }
    enteredRef.current = entryKey;
    setActive("activity");
  }, [entryKey]);

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
    active: tabs.active,
    previous: tabs.previous,
    lastThreadRootId,
  });

  const applyPatch = (patch: DmPanePatch) => {
    if (patch.paneHidden !== undefined) {
      setDmPaneHidden(patch.paneHidden);
    }
    if (patch.mobileOpen !== undefined) {
      setThinkingOpen(patch.mobileOpen);
    }
    if (patch.active !== undefined) {
      setActive(patch.active, patch.previous);
    }
    if (patch.threadRootId !== undefined) {
      options.setThreadRootId(patch.threadRootId);
    }
  };

  const back = (leaving: RightTabId): RightTabId =>
    tabs.previous !== leaving ? tabs.previous : "work";

  return {
    thinkingOpen,
    setThinkingOpen,
    dmPaneHidden,
    setDmPaneHidden,
    active: tabs.active,
    previous: tabs.previous,
    /** Pick a tab from the strip. */
    selectTab: (tab: RightTabId) => setActive(tab),
    /** A timeline "N replies" click: that thread, on the thread tab. */
    openThreadTab: (id: string) => {
      options.setThreadRootId(id);
      setActive("thread");
    },
    /** The thread tab's ✕: close it and return to the tab before it. */
    closeThread: () => {
      options.setThreadRootId(null);
      if (tabs.active === "thread") {
        setActive(back("thread"), "work");
      }
    },
    /** The thinking tab's ✕ / the pane's own close. */
    closeThinking: () => {
      setDmPaneHidden(true);
      setThinkingOpen(false);
      if (tabs.active === "activity") {
        setActive(back("activity"), "work");
      }
    },
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

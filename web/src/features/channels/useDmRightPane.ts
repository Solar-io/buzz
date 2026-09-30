import { useEffect, useState } from "react";
import { loadRightTab, saveRightTab } from "@/features/work/lib/workPrefs.ts";
import {
  thinkingPaneVisible,
  toggleThinkingPatch,
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
 * The right pane's tab state (Work | Thinking) plus the two-way 🧠 toggle
 * Sam asked for on 2026-09-22.
 *
 * The policy lives in `lib/dmPaneToggles.ts` (pure, unit-tested); this hook
 * owns the state cells and the viewport flag. Threads are no longer part of
 * it: they open inline, under their message (web redesign Phase 2).
 *
 * The viewport flag mirrors the lg breakpoint the pane switches on: below it
 * the thinking pane is only on screen while its sheet is open, which is one
 * of the inputs `thinkingPaneVisible` reads.
 */
export function useDmRightPane(options: {
  /** An agent DM is open (the thinking tab can exist). */
  agentDm: boolean;
  /** The selected conversation — entering an agent DM selects Thinking. */
  channelId: string | undefined;
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

  // Entering an agent DM whose thinking tab is open selects it — once per
  // entry (today's default: the thinking pane opens). The key changes only on
  // entry (and on re-entry, via null), so a viewer who then picks Work stays
  // on Work until they leave and come back.
  const entryKey =
    options.agentDm && !dmPaneHidden ? (options.channelId ?? null) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires on entry only; setActive is a fresh closure over a stable setter
  useEffect(() => {
    if (entryKey !== null) {
      setActive("activity");
    }
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

  // Snapshot read at click time — the toggle fires from the composer's
  // action row, not from a render, so it must not close over stale state.
  const state = (): DmPaneState => ({
    agentDm: options.agentDm,
    paneHidden: dmPaneHidden,
    mobileOpen: thinkingOpen,
    mobile,
    active: tabs.active,
    previous: tabs.previous,
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
  };

  return {
    thinkingOpen,
    setThinkingOpen,
    dmPaneHidden,
    setDmPaneHidden,
    active: tabs.active,
    previous: tabs.previous,
    /** Pick a tab from the strip. */
    selectTab: (tab: RightTabId) => setActive(tab),
    /** The thinking tab's ✕ / the pane's own close. */
    closeThinking: () => {
      setDmPaneHidden(true);
      setThinkingOpen(false);
      if (tabs.active === "activity") {
        setActive("work", "work");
      }
    },
    /** The composer action row's 🧠 control. */
    panes: {
      thinkingVisible: thinkingPaneVisible(state()),
      toggleThinking: () => applyPatch(toggleThinkingPatch(state())),
    } satisfies PaneToggles,
  };
}

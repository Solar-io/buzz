import { Search } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import { PULSE_TABS, type PulseTab } from "../lib/pulseTypes.ts";

export const pulsePanelId = (tab: PulseTab) => `pulse-panel-${tab}`;
export const pulseTabId = (tab: PulseTab) => `pulse-tab-${tab}`;

const TAB_LABELS: Record<PulseTab, string> = {
  search: "Search",
  everyone: "Everyone",
  people: "Following",
  liked: "Liked",
  agents: "Agents",
  mine: "Mine",
};

const tabClass = cn(
  "h-7 shrink-0 rounded-full border border-transparent px-2.5 text-2xs font-medium",
  "text-muted-foreground",
  "data-[active=true]:border-border/70 data-[active=true]:bg-background/80",
  "data-[active=true]:text-foreground data-[active=true]:shadow-xs",
);

/**
 * Pulse's tab strip, in the desktop's shape
 * (`desktop/src/features/pulse/ui/PulseTabBar.tsx`): a magnifier button for
 * Search, then Everyone / Following / Liked / Agents / Mine, with the agent
 * count pinned to its tab.
 *
 * The strip is a real ARIA tablist — `aria-selected` plus `aria-controls`
 * pointing at the panel — because the panel below is swapped rather than
 * re-mounted, and without the relationship a screen reader announces a tab
 * press and nothing else.
 */
export function PulseTabBar({
  activeTab,
  agentCount,
  onTabChange,
}: {
  activeTab: PulseTab;
  agentCount: number;
  onTabChange: (tab: PulseTab) => void;
}) {
  return (
    <div className="relative z-10 shrink-0 border-b border-border/50 px-4 py-3">
      <div
        aria-label="Pulse sections"
        className="mx-auto flex w-full max-w-2xl items-center gap-1 overflow-x-auto"
        role="tablist"
      >
        {PULSE_TABS.map((tab) =>
          tab === "search" ? (
            <Button
              aria-controls={pulsePanelId("search")}
              aria-label="Search Pulse"
              aria-selected={activeTab === "search"}
              className={cn(tabClass, "w-7 px-0")}
              data-active={activeTab === "search"}
              data-testid="pulse-tab-search"
              id={pulseTabId("search")}
              key={tab}
              onClick={() => onTabChange("search")}
              role="tab"
              size="sm"
              type="button"
              variant="ghost"
            >
              <Search aria-hidden className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              aria-controls={pulsePanelId(tab)}
              aria-selected={activeTab === tab}
              className={tabClass}
              data-active={activeTab === tab}
              data-testid={`pulse-tab-${tab}`}
              id={pulseTabId(tab)}
              key={tab}
              onClick={() => onTabChange(tab)}
              role="tab"
              size="sm"
              type="button"
              variant="ghost"
            >
              {TAB_LABELS[tab]}
              {tab === "agents" && agentCount > 0 ? (
                <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-badge font-medium text-muted-foreground">
                  {agentCount}
                </span>
              ) : null}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

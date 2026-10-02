import type { AgentTab } from "./agentScreenModel";

const TABS: { id: AgentTab; label: string }[] = [
  { id: "settings", label: "Settings" },
  { id: "channels", label: "Channels" },
  { id: "logs", label: "Logs" },
  { id: "memory", label: "Memory" },
  { id: "activity", label: "Activity" },
];

export function AgentTabs({
  tab,
  channelCount,
  onSelect,
}: {
  tab: AgentTab;
  channelCount: number;
  onSelect: (tab: AgentTab) => void;
}) {
  return (
    <nav
      aria-label="Agent sections"
      className="flex gap-1 rounded-lg bg-muted p-1 md:rounded-none md:border-b md:border-border md:bg-transparent md:p-0"
      data-testid="agent-tabs"
    >
      {TABS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-label={id === "channels" ? `${label} ${channelCount}` : label}
          aria-current={tab === id ? "page" : undefined}
          onClick={() => onSelect(id)}
          className={`min-h-11 min-w-0 flex-1 rounded-md px-2 text-sm font-medium md:flex-none md:rounded-none md:px-3 ${id === "memory" || id === "activity" ? "hidden md:block" : ""} ${tab === id ? "bg-card text-foreground shadow-sm md:border-b-2 md:border-foreground md:bg-transparent md:shadow-none" : "text-muted-foreground hover:text-foreground"}`}
        >
          {label}
          {id === "channels" ? (
            <span className="ml-1 text-xs">{channelCount}</span>
          ) : null}
        </button>
      ))}
    </nav>
  );
}

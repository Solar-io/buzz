import { useEffect, useState } from "react";
import { ChevronDown, Search, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { UserAvatar } from "@/shared/ui/UserAvatar";
import { RANGES, civilDate, type UsageSearch } from "../lib/analytics";

export type AgentOption = {
  key: string;
  label: string;
  avatarUrl: string | null;
};
export function UsageControls({
  agents,
  selected,
  search,
  onChange,
}: {
  agents: AgentOption[];
  selected: string[];
  search: UsageSearch;
  onChange: (patch: Partial<Record<keyof UsageSearch, string | null>>) => void;
}) {
  const [filter, setFilter] = useState("");
  const [start, setStart] = useState(search.start ?? civilDate(new Date()));
  const [end, setEnd] = useState(search.end ?? civilDate(new Date()));
  useEffect(() => {
    if (search.start) setStart(search.start);
    if (search.end) setEnd(search.end);
  }, [search.start, search.end]);
  const isAll = selected.length === 0;
  const toggle = (key: string) => {
    const current =
      search.agents === "none"
        ? []
        : isAll
          ? agents.map((agent) => agent.key)
          : selected;
    const next = current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key];
    onChange({
      agents:
        next.length === agents.length
          ? null
          : next.length === 0
            ? "none"
            : next.sort().join(","),
    });
  };
  return (
    <div className="usage-controls">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="usage-button"
            aria-label="Filter by agents"
          >
            <Users size={15} />
            {search.agents === "none"
              ? "No agents"
              : isAll
                ? "All agents"
                : `${selected.length} agent${selected.length === 1 ? "" : "s"}`}
            <ChevronDown size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="usage-agent-picker w-80 max-w-[calc(100vw-2rem)]"
        >
          <label className="usage-search">
            <Search size={14} />
            <input
              aria-label="Search agents"
              placeholder="Search agents…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="usage-picker-actions">
            <button type="button" onClick={() => onChange({ agents: null })}>
              Select all
            </button>
            <button type="button" onClick={() => onChange({ agents: "none" })}>
              Clear
            </button>
          </div>
          <div className="usage-agent-list">
            {agents
              .filter((agent) =>
                `${agent.label} ${agent.key}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )
              .map((agent) => (
                <label key={agent.key} title={agent.key}>
                  <input
                    type="checkbox"
                    checked={
                      search.agents !== "none" &&
                      (isAll || selected.includes(agent.key))
                    }
                    onChange={() => toggle(agent.key)}
                  />
                  <UserAvatar
                    size="sm"
                    avatarUrl={agent.avatarUrl}
                    displayName={agent.label}
                  />
                  <span>{agent.label}</span>
                </label>
              ))}
            {agents.length === 0 && <p>No archived agents yet.</p>}
          </div>
        </PopoverContent>
      </Popover>
      <fieldset className="usage-ranges" aria-label="Date range">
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            aria-pressed={(search.range ?? "30D") === range}
            onClick={() =>
              onChange({ range, ...(range === "Custom" ? { start, end } : {}) })
            }
          >
            {range}
          </button>
        ))}
      </fieldset>
      {search.range === "Custom" && (
        <form
          className="usage-custom"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ start, end });
          }}
        >
          <label>
            From
            <input
              aria-label="Start date"
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              required
            />
          </label>
          <label>
            Through
            <input
              aria-label="End date"
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              required
            />
          </label>
          <button className="usage-button" type="submit">
            Apply
          </button>
        </form>
      )}
    </div>
  );
}

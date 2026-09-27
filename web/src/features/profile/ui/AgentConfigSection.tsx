import { useAgentConfigCard } from "@/features/agents/useAgentConfigCard";
import type { AgentConfigRow } from "@/features/agents/lib/agentConfigCard";
import { Skeleton } from "@/shared/ui/skeleton";

/** The two-column rows list shared by the hover card and the profile card. */
export function AgentConfigList({
  rows,
  loading,
}: {
  rows: AgentConfigRow[];
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return <Skeleton className="h-10 w-full" />;
  }
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No published configuration
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map((row) => (
        <div
          className="contents"
          data-testid={`agent-config-row-${row.key}`}
          key={row.key}
        >
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 truncate font-medium" title={row.value}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Agent config inside the profile card — the TAP path: on touch devices the
 * avatar opens the profile card, and this section carries what the hover card
 * would have shown. Only the avatar trigger passes `showAgentConfig`.
 */
export function AgentConfigSection({ pubkey }: { pubkey: string }) {
  const { rows, loading } = useAgentConfigCard(pubkey);
  return (
    <div className="flex flex-col gap-1.5" data-testid="agent-config-section">
      <span className="text-xs text-muted-foreground">Configured on agent</span>
      <AgentConfigList loading={loading} rows={rows} />
    </div>
  );
}

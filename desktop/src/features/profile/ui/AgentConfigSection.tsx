import type { ManagedAgent } from "@/shared/api/types";

import { agentConfigRows } from "../lib/agentConfigRows";
import { useAgentVoiceLabel } from "./useAgentVoiceLabel";

/**
 * Agent config rows (model, runtime, effort knobs, voice) inside the profile
 * popover. Rendered ONLY for avatar triggers (`showAgentConfig`): the owner
 * asked that hovering an agent's name never shows its config.
 */
export function AgentConfigSection({
  pubkey,
  managedAgent,
  relayAgentType,
}: {
  pubkey: string;
  managedAgent: ManagedAgent | null;
  relayAgentType: string | null;
}) {
  const voice = useAgentVoiceLabel(pubkey, true);
  const rows = agentConfigRows({
    agent: managedAgent,
    fallbackRuntime: relayAgentType,
    voice: voice.data ?? null,
  });
  return (
    <div className="flex flex-col gap-1.5" data-testid="agent-config-section">
      {rows.length > 0 ? (
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
      ) : null}
      {managedAgent?.acpCommand ? (
        <span className="inline-flex self-start rounded-full bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">
          ACP: {managedAgent.acpCommand}
        </span>
      ) : null}
    </div>
  );
}

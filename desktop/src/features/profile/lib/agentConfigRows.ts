import { resolveModelLabel } from "@/features/agents/lib/formatAgentModelLabel";
import type { ManagedAgent } from "@/shared/api/types";

/**
 * Rows for the agent config section of the profile popover (avatar hover
 * only). Mirrors `web/src/features/agents/lib/agentConfigCard.ts` — same
 * order and labels — but reads the local managed-agent summary, whose
 * `model`/`provider` are already the effective values and whose `effort` is
 * resolved by the Tauri side. Never reads env keys.
 */

export interface AgentConfigRow {
  key: string;
  label: string;
  value: string;
}

const RUNTIME_LABELS: Record<string, string> = {
  goose: "Goose",
  "claude-code": "Claude Code",
  "codex-acp": "Codex",
  aider: "Aider",
};

/** Friendly harness label; unknown commands pass through. */
export function runtimeLabel(command: string): string {
  return RUNTIME_LABELS[command] ?? command;
}

/** `555000` → `555,000 tokens` (fixed locale so output is deterministic). */
export function formatContextTokens(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

/**
 * Ordered, non-empty rows. `fallbackRuntime` is the relay agent type, used
 * when the agent is not managed by this desktop.
 */
export function agentConfigRows({
  agent,
  fallbackRuntime = null,
  voice = null,
}: {
  agent: Pick<
    ManagedAgent,
    "model" | "provider" | "agentCommand" | "effort"
  > | null;
  fallbackRuntime?: string | null;
  voice?: string | null;
}): AgentConfigRow[] {
  const effort = agent?.effort ?? null;
  const runtime = agent?.agentCommand || fallbackRuntime;
  const candidates: Array<[string, string, string | null | undefined]> = [
    [
      "model",
      "Model",
      agent?.model
        ? resolveModelLabel(agent.model, null, agent.provider)
        : null,
    ],
    ["provider", "Provider", agent?.provider],
    ["runtime", "Runtime", runtime ? runtimeLabel(runtime) : null],
    ["acp", "Effort", effort?.acp],
    ["textTurn", "Text-turn effort", effort?.textTurn],
    ["voiceTurn", "Voice-turn effort", effort?.voiceTurn],
    ["thinking", "Thinking effort", effort?.thinking],
    ["claudeCode", "Claude Code effort", effort?.claudeCode],
    [
      "maxContext",
      "Max context",
      effort?.maxContextTokens
        ? formatContextTokens(effort.maxContextTokens)
        : null,
    ],
    ["voice", "Voice", voice],
  ];
  return candidates
    .filter((candidate): candidate is [string, string, string] =>
      Boolean(candidate[2]?.trim()),
    )
    .map(([key, label, value]) => ({ key, label, value }));
}

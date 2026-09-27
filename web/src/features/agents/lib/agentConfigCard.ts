import type { AgentRegistryEntry } from "./agentRegistry";
import type { PersonaDefinition } from "./personas";
import { buildRoster } from "./roster.ts";

/**
 * Rows for the agent avatar config card: the effective model/provider (via
 * `buildRoster`, so the linked/standalone rule is shared with the agents
 * screen), the definition's runtime, the published 30177 effort knobs, and
 * the agent's 30182 voice label. Pure, React-free. Mirrored by
 * `desktop/src/features/profile/lib/agentConfigRows.ts` (same order/labels).
 */

export interface AgentConfigRow {
  key: string;
  label: string;
  value: string;
}

export interface AgentConfigInput {
  entry: AgentRegistryEntry | null;
  persona: PersonaDefinition | null;
  /** 30182 voice selection label, when the agent published one. */
  voice: string | null;
}

/** `555000` → `555,000 tokens` (fixed locale so output is deterministic). */
export function formatContextTokens(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

/** Ordered, non-empty config rows for one agent. */
export function agentConfigRows({
  entry,
  persona,
  voice,
}: AgentConfigInput): AgentConfigRow[] {
  const personas = new Map<string, PersonaDefinition>();
  if (entry?.personaId && persona) {
    personas.set(entry.personaId, persona);
  }
  const row = entry ? buildRoster([entry], personas, [])[0] : null;
  const effort = entry?.effort ?? null;
  const candidates: Array<[string, string, string | null | undefined]> = [
    ["model", "Model", row?.model],
    ["provider", "Provider", row?.provider],
    ["runtime", "Runtime", persona?.runtime],
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

/**
 * Arm the hover card only for a hover-capable pointer. Touch never arms it:
 * a tap belongs to the profile card (which shows the agent section instead).
 */
export function shouldArmAgentHover(
  pointerType: string,
  anyHover: boolean,
): boolean {
  return anyHover && pointerType !== "touch";
}

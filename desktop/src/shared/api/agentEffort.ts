/**
 * Display-only effort/context knobs resolved by the Tauri side
 * (`src-tauri/src/managed_agents/agent_effort.rs`) and carried on the managed
 * agent summary. Named, validated values only — the UI never reads env keys
 * (features/agents/AGENTS.md rule 2).
 */
export type AgentEffort = {
  acp: string | null;
  textTurn: string | null;
  voiceTurn: string | null;
  thinking: string | null;
  claudeCode: string | null;
  maxContextTokens: number | null;
};

/** Snake-case wire shape; Rust omits empty fields. */
export type RawAgentEffort = {
  acp?: string | null;
  text_turn?: string | null;
  voice_turn?: string | null;
  thinking?: string | null;
  claude_code?: string | null;
  max_context_tokens?: number | null;
};

/** Map the summary's `effort`; null when absent. */
export function fromRawAgentEffort(
  raw: RawAgentEffort | null | undefined,
): AgentEffort | null {
  if (!raw) {
    return null;
  }
  return {
    acp: raw.acp ?? null,
    textTurn: raw.text_turn ?? null,
    voiceTurn: raw.voice_turn ?? null,
    thinking: raw.thinking ?? null,
    claudeCode: raw.claude_code ?? null,
    maxContextTokens: raw.max_context_tokens ?? null,
  };
}

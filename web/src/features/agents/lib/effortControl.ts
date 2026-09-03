/**
 * The thinking-effort env control for the agent edit panel — set/clear only.
 *
 * The key and the value set are deliberate mirrors of the desktop's
 * buzz-agent harness surface: `BUZZ_AGENT_THINKING_EFFORT`
 * (desktop/src/features/agents/ui/buzzAgentConfig.ts) and the exact valid
 * enum none|minimal|low|medium|high|xhigh|max
 * (desktop/src/features/agents/ui/modelCapabilities.ts THINKING_EFFORT_VALUES,
 * itself mirroring parse_thinking_effort in crates/buzz-agent/src/config.rs).
 * This is the env-var surface ONLY — the desktop's canonical effort_level →
 * BUZZ_ACP_EFFORT_LEVEL path is a separate authority that wins at spawn when
 * set, and the web never touches it.
 *
 * The web has no env read path (30177 publishes none), so the control is
 * blind-set: it never displays a value it cannot know, defaults to "leave
 * unchanged", and its copy says so.
 */

export const THINKING_EFFORT_ENV_KEY = "BUZZ_AGENT_THINKING_EFFORT";

export const THINKING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingEffortValue = (typeof THINKING_EFFORT_VALUES)[number];

/** What the effort select holds: keep / remove the agent-level key / a value. */
export type EffortSelection = "keep" | "clear" | ThinkingEffortValue;

/**
 * The envVarsPatch for the current selection: a value pins the key, "clear"
 * deletes it (null), "keep" sends nothing (undefined). Deleting removes the
 * AGENT-LEVEL setting only — a persona-defined value, if any, re-exposes
 * underneath at spawn.
 */
export function effortPatchFromSelection(
  selection: EffortSelection,
): Record<string, string | null> | undefined {
  if (selection === "keep") {
    return undefined;
  }
  if (selection === "clear") {
    return { [THINKING_EFFORT_ENV_KEY]: null };
  }
  return { [THINKING_EFFORT_ENV_KEY]: selection };
}

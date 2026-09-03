import type { RespondToMode } from "./types";

/**
 * `UpdateManagedAgentInput`, extracted from `types.ts` (file-size cap; the
 * parent file is over the 1000-line ratchet and frozen). Shape mirror of the
 * Rust `UpdateManagedAgentRequest` — every field tri-state by absence.
 */

export type UpdateManagedAgentInput = {
  pubkey: string;
  name?: string;
  model?: string | null;
  provider?: string | null;
  systemPrompt?: string | null;
  /** Absent = don't touch. Present = replace the env_vars map entirely. */
  envVars?: Record<string, string>;
  /**
   * Absent = don't touch. Present = merge onto the stored env map AFTER any
   * `envVars` replace in the same command: string sets the key, null deletes
   * it. The backend validates the FINAL merged map before saving.
   */
  envVarsPatch?: Record<string, string | null>;
  /**
   * Absent = don't touch. Non-empty = set. `""` = clear to the harness
   * default avatar (the empty string, not null, is the clear sentinel).
   */
  avatarUrl?: string;
  /** Absent = don't touch. `>0` = set. `0` = clear to the harness default. */
  idleTimeoutSeconds?: number;
  /** Absent = don't touch. `>0` = set. `0` = clear to the harness default. */
  maxTurnDurationSeconds?: number;
  /** Absent = don't touch. Present = set the flag. */
  startOnAppLaunch?: boolean;
  parallelism?: number;
  turnTimeoutSeconds?: number;
  relayUrl?: string;
  acpCommand?: string;
  agentCommand?: string;
  /**
   * True when `agentCommand` is a runtime/Custom command the user deliberately
   * picked (the dialog is not inheriting). Preserves a pin that maps to the
   * linked persona's own runtime instead of letting the backend drop it back
   * to inherit. Ignored when `agentCommand` is absent or the inherit sentinel.
   */
  harnessOverride?: boolean;
  agentArgs?: string[];
  mcpCommand?: string;
  /** Absent = don't touch. Present = set the mode. */
  respondTo?: RespondToMode;
  /**
   * Absent = don't touch. Present = replace the allowlist with this list
   * (validated & normalized server-side).
   */
  respondToAllowlist?: string[];
};

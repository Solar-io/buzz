import type { AdminCommand, HarnessSelection } from "./adminCommands";
import type { AgentRegistryEntry } from "./agentRegistry";
import type { PersonaDefinition } from "./personas";

/**
 * Pure edit-form → update-command builder, testable without React. The
 * contract: the request carries ONLY the fields the user actually changed —
 * unchanged fields are absent (never sent as empty strings), a "keep current"
 * harness sends no harness key, and a blank env textarea sends no envVars key.
 * The desktop's update path treats absent as "leave alone".
 */

export interface EditAgentFormValue {
  /** Raw input values, exactly as the form holds them. */
  name: string;
  systemPrompt: string;
  model: string;
  provider: string;
  parallelism: string;
  respondTo: "owner-only" | "anyone" | "allowlist";
  respondToAllowlist: string;
  /** "__keep" = keep current harness; otherwise a catalog/preset id, or "__custom". */
  harnessId: string;
  customCommand: string;
  customArgs: string;
  /** Blank = keep current env vars. */
  envText: string;
  /** "keep" sends nothing; "on"/"off" sends the boolean. */
  startOnAppLaunch: "keep" | "on" | "off";
}

export interface EditAgentFormPrefill extends EditAgentFormValue {
  /** True when the entry is definition-linked (30177 carries persona_id). */
  personaLinked: boolean;
}

/**
 * Prefill the form from the registry entry. For definition-linked entries the
 * 30177 omits the quad ("slimming"), so the persona's kind-30175 definition
 * supplies name/system prompt/model/provider.
 */
export function prefillEditForm(
  entry: AgentRegistryEntry,
  persona: PersonaDefinition | null,
): EditAgentFormPrefill {
  const linked = entry.personaId !== null;
  const name = linked && persona ? persona.name : entry.name;
  const systemPrompt = linked
    ? (persona?.systemPrompt ?? "")
    : entry.systemPrompt;
  const model = linked ? (persona?.model ?? "") : entry.model;
  const provider = linked ? (persona?.provider ?? "") : entry.provider;
  return {
    name,
    systemPrompt,
    model,
    provider,
    parallelism: entry.parallelism !== null ? String(entry.parallelism) : "",
    respondTo:
      entry.respondTo === "anyone" || entry.respondTo === "allowlist"
        ? entry.respondTo
        : "owner-only",
    respondToAllowlist: entry.respondToAllowlist.join("\n"),
    harnessId: "__keep",
    customCommand: "",
    customArgs: "",
    envText: "",
    startOnAppLaunch: "keep",
    personaLinked: linked,
  };
}

/** Parse "KEY=value" lines; null (with the bad line) on a malformed line. */
export function parseEnvText(
  text: string,
): { envVars: Record<string, string> } | { error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { envVars: {} };
  }
  const envVars: Record<string, string> = {};
  for (const line of trimmed.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) {
      return { error: `Env line is not KEY=value: ${line}` };
    }
    envVars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return { envVars };
}

/**
 * Build the update command. Returns `{ error }` for invalid input instead of
 * throwing, so the form can toast it. Fields equal to the prefill-time value
 * are omitted; only real changes ride the wire.
 */
export function buildUpdateCommand(
  entry: AgentRegistryEntry,
  prefill: EditAgentFormPrefill,
  value: EditAgentFormValue,
): { command: AdminCommand } | { error: string } {
  const changed: Record<string, unknown> = {};
  if (value.name.trim() && value.name.trim() !== prefill.name.trim()) {
    changed.name = value.name.trim();
  }
  if (
    value.systemPrompt.trim() &&
    value.systemPrompt.trim() !== prefill.systemPrompt.trim()
  ) {
    changed.systemPrompt = value.systemPrompt.trim();
  }
  if (value.model.trim() && value.model.trim() !== prefill.model.trim()) {
    changed.model = value.model.trim();
  }
  if (
    value.provider.trim() &&
    value.provider.trim() !== prefill.provider.trim()
  ) {
    changed.provider = value.provider.trim();
  }
  const parallelism = Number.parseInt(value.parallelism.trim(), 10);
  if (
    Number.isFinite(parallelism) &&
    parallelism > 0 &&
    String(parallelism) !== prefill.parallelism
  ) {
    changed.parallelism = parallelism;
  }
  if (value.respondTo !== prefill.respondTo) {
    changed.respondTo = value.respondTo;
  }
  if (value.respondToAllowlist.trim() !== prefill.respondToAllowlist.trim()) {
    const lines = value.respondToAllowlist
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.some((line) => !/^[0-9a-f]{64}$/.test(line))) {
      return {
        error: "Allowlist entries must be 64-hex pubkeys, one per line.",
      };
    }
    changed.respondToAllowlist = lines;
  }
  if (value.harnessId !== "__keep") {
    const harness: HarnessSelection | null =
      value.harnessId === "__custom"
        ? value.customCommand.trim()
          ? {
              kind: "custom",
              command: value.customCommand.trim(),
              args: value.customArgs
                .split(/\s+/)
                .map((arg) => arg.trim())
                .filter(Boolean),
            }
          : null
        : { kind: "preset", runtimeId: value.harnessId };
    if (!harness) {
      return { error: "A custom harness needs a command." };
    }
    changed.harness = harness;
  }
  if (value.envText.trim()) {
    const parsed = parseEnvText(value.envText);
    if ("error" in parsed) {
      return { error: parsed.error };
    }
    changed.envVars = parsed.envVars;
  }
  if (value.startOnAppLaunch !== "keep") {
    changed.startOnAppLaunch = value.startOnAppLaunch === "on";
  }
  if (Object.keys(changed).length === 0) {
    return { error: "Nothing changed." };
  }
  return {
    command: {
      action: "update",
      request: { pubkey: entry.pubkey, ...changed },
    },
  };
}

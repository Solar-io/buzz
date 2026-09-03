import type { AdminCommand, HarnessSelection } from "./adminCommands";
import type { AgentRegistryEntry } from "./agentRegistry";
import type { PersonaDefinition } from "./personas";
import {
  envRowsToRecord,
  reservedKeyErrors,
  type EnvRow,
} from "./envRows.ts";

/**
 * Pure edit-form → update-command builder, testable without React. The
 * contract: the request carries ONLY the fields the user actually changed —
 * unchanged fields are absent, a blank string is NEVER sent (the desktop
 * parses a sent "" as Some("") and would overwrite; there is no field-clear
 * op except the envVars replace), a "keep current" harness sends no harness
 * key, and an untouched env table sends no envVars key at all. The desktop's
 * update path treats absent as "leave alone".
 *
 * Two Phase-1 semantics on top of the original:
 * - `startOnAppLaunch` is GONE — the desktop applier drops it on update
 *   (useOwnerAdminCommands.ts update case), so the control was a false
 *   affordance and is no longer rendered or sent.
 * - Definition-linked entries refuse quad edits (prompt/model/provider) with
 *   a clear error: the desktop's applier ignores quad updates for linked
 *   records (managed_agent_definition.rs guards persona_id.is_none()), so
 *   sending them would silently do nothing.
 */

export interface EditAgentFormValue {
  /** Raw input values, exactly as the form holds them. */
  name: string;
  systemPrompt: string;
  model: string;
  provider: string;
  /** Blank = keep (the 30177 always publishes a value; the protocol cannot unset). */
  parallelism: string;
  respondTo: "owner-only" | "anyone" | "allowlist";
  /** Allowlist row-editor output (untrimmed entries allowed mid-edit). */
  respondToAllowlist: string[];
  /** "__keep" = keep current harness; otherwise a catalog/preset id, or "__custom". */
  harnessId: string;
  customCommand: string;
  customArgs: string;
  /** Env table rows; ignored unless `envDirty` is true. */
  envRows: EnvRow[];
  /** Set by ANY add/edit/remove in the table — gates the envVars key. */
  envDirty: boolean;
}

export interface EditAgentFormPrefill extends EditAgentFormValue {
  /** True when the entry is definition-linked (30177 carries persona_id). */
  personaLinked: boolean;
}

/**
 * Prefill the form from the registry entry. For definition-linked entries the
 * 30177 omits the quad ("slimming"), so the persona's kind-30175 definition
 * supplies name/system prompt/model/provider. The env table starts EMPTY and
 * clean: the web has no env read path, and only a deliberate edit sends
 * envVars (replace semantics — see EnvVarsTable's warning).
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
    respondToAllowlist: [...entry.respondToAllowlist],
    harnessId: "__keep",
    customCommand: "",
    customArgs: "",
    envRows: [],
    envDirty: false,
    personaLinked: linked,
  };
}

/**
 * Build the update command. Returns `{ error }` for invalid input instead of
 * throwing, so the form can toast it. Fields equal to the prefill-time value
 * are omitted; only real changes ride the wire. Evaluation order follows the
 * plan's field table — the first error wins.
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

  const quadGuard = (
    field: "systemPrompt" | "model" | "provider",
    label: string,
  ): { error: string } | null => {
    const next = value[field].trim();
    if (!next || next === prefill[field].trim()) {
      return null;
    }
    if (prefill.personaLinked) {
      return {
        error: `This agent's ${label} comes from its definition — edit it in the desktop app.`,
      };
    }
    return null;
  };
  const promptGuard = quadGuard("systemPrompt", "prompt");
  if (promptGuard) {
    return promptGuard;
  }
  if (
    value.systemPrompt.trim() &&
    value.systemPrompt.trim() !== prefill.systemPrompt.trim()
  ) {
    changed.systemPrompt = value.systemPrompt.trim();
  }
  const modelGuard = quadGuard("model", "model");
  if (modelGuard) {
    return modelGuard;
  }
  if (value.model.trim() && value.model.trim() !== prefill.model.trim()) {
    changed.model = value.model.trim();
  }
  const providerGuard = quadGuard("provider", "provider");
  if (providerGuard) {
    return providerGuard;
  }
  if (
    value.provider.trim() &&
    value.provider.trim() !== prefill.provider.trim()
  ) {
    changed.provider = value.provider.trim();
  }

  const parallelismText = value.parallelism.trim();
  if (parallelismText !== "") {
    const parsed = Number.parseInt(parallelismText, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: "Parallelism must be a whole number of 1 or more." };
    }
    if (String(parsed) !== prefill.parallelism) {
      changed.parallelism = parsed;
    }
  }

  const normalizedAllowlist = value.respondToAllowlist
    .map((entryKey) => entryKey.trim())
    .filter(Boolean);
  const allowlistChanged =
    normalizedAllowlist.length !== prefill.respondToAllowlist.length ||
    normalizedAllowlist.some(
      (entryKey, index) => entryKey !== prefill.respondToAllowlist[index],
    );

  if (value.respondTo !== prefill.respondTo) {
    if (value.respondTo === "allowlist") {
      const effective = allowlistChanged
        ? normalizedAllowlist
        : prefill.respondToAllowlist;
      if (effective.length === 0) {
        return { error: "Specific people requires at least one key." };
      }
    }
    changed.respondTo = value.respondTo;
  }
  if (allowlistChanged) {
    if (
      normalizedAllowlist.some(
        (entryKey) => !/^[0-9a-f]{64}$/.test(entryKey),
      )
    ) {
      return {
        error: "Allowlist entries must be agent keys — copy them from the desktop or a profile.",
      };
    }
    changed.respondToAllowlist = normalizedAllowlist;
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

  if (value.envDirty) {
    const reserved = reservedKeyErrors(value.envRows);
    if (reserved.length > 0) {
      return { error: reserved[0] };
    }
    // Replace semantics: the FULL table rides the wire — an empty table is
    // an explicit clear of every env var the desktop holds for this agent.
    changed.envVars = envRowsToRecord(value.envRows);
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

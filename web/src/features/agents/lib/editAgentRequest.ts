import type { AdminCommand, HarnessSelection } from "./adminCommands";
import type { AgentRegistryEntry } from "./agentRegistry";
import type { PersonaDefinition } from "./personas";
import { envRowsToRecord, reservedKeyErrors, type EnvRow } from "./envRows.ts";
import {
  effortPatchFromSelection,
  THINKING_EFFORT_ENV_KEY,
  type EffortSelection,
} from "./effortControl.ts";

/**
 * Pure edit-form → update-command builder, testable without React. The
 * contract: the request carries ONLY the fields the user actually changed —
 * unchanged fields are absent, a blank string is NEVER sent for the
 * replace-only fields (the desktop parses a sent "" as Some("") and would
 * overwrite), a "keep current" harness sends no harness key, and an untouched
 * env table sends no envVars key at all. The desktop's update path treats
 * absent as "leave alone".
 *
 * Phase 2 adds the clear-sentinel fields (desktop catalog >= v2 applies
 * them): avatarUrl (absent = keep, non-empty changed = set, cleared = ""
 * clears to the harness default), both turn timeouts (blank = keep, 0 =
 * clear, positive = set), startOnAppLaunch ("keep"/"on"/"off"), and the
 * effort control riding envVarsPatch (set/clear the agent-level
 * BUZZ_AGENT_THINKING_EFFORT). None of them are readable from the relay, so
 * "changed" for them means "the user expressed a value", never a comparison
 * against a current value the web cannot know.
 *
 * Definition-linked entries refuse quad edits (prompt/model/provider) with a
 * clear error: the desktop's applier ignores quad updates for linked records
 * (managed_agent_definition.rs guards persona_id.is_none()), so sending them
 * would silently do nothing.
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
  // ── Phase 2 (gated on catalog >= v2 in the panel; the builder is ungated) ──
  /** Prefilled from the kind-0 profile picture; cleared-to-empty sends "". */
  avatarUrl: string;
  /** Blank = keep; "0" = clear to the harness default; positive int = set. */
  idleTimeoutSeconds: string;
  maxTurnDurationSeconds: string;
  startOnAppLaunch: "keep" | "on" | "off";
  /** Effort select state; see effortControl.ts. */
  effort: EffortSelection;
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
 * envVars (replace semantics — see EnvVarsTable's warning). avatarUrl
 * prefills from the kind-0 profile picture (the only avatar the web can see);
 * the timeouts and start-on-launch start as "keep" for the same no-read-path
 * reason.
 */
export function prefillEditForm(
  entry: AgentRegistryEntry,
  persona: PersonaDefinition | null,
  profileAvatar?: string | null,
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
    avatarUrl: profileAvatar ?? "",
    idleTimeoutSeconds: "",
    maxTurnDurationSeconds: "",
    startOnAppLaunch: "keep",
    effort: "keep",
    personaLinked: linked,
  };
}

/** Parse one timeout input: blank = keep, "0" = clear, positive int = set. */
function parseTimeoutSeconds(
  label: string,
  text: string,
): { seconds?: number; error?: string } {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {};
  }
  if (!/^\d+$/.test(trimmed)) {
    return {
      error: `${label} must be a whole number of seconds (0 resets it to the default).`,
    };
  }
  return { seconds: Number.parseInt(trimmed, 10) };
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

  // Avatar: the one Phase-2 scalar with a readable prefill (the kind-0
  // picture). Clearing to empty sends "" — the protocol's clear sentinel,
  // which resets to the harness default picture on the desktop.
  const avatarNext = value.avatarUrl.trim();
  if (avatarNext !== prefill.avatarUrl.trim()) {
    changed.avatarUrl = avatarNext;
  }

  // Timeouts: no read path, so any expressed value is the change. Blank =
  // keep, 0 = clear to the harness default, positive = set.
  const idle = parseTimeoutSeconds("Idle timeout", value.idleTimeoutSeconds);
  if (idle.error) {
    return { error: idle.error };
  }
  if (idle.seconds !== undefined) {
    changed.idleTimeoutSeconds = idle.seconds;
  }
  const maxTurn = parseTimeoutSeconds(
    "Max turn duration",
    value.maxTurnDurationSeconds,
  );
  if (maxTurn.error) {
    return { error: maxTurn.error };
  }
  if (maxTurn.seconds !== undefined) {
    changed.maxTurnDurationSeconds = maxTurn.seconds;
  }

  if (value.startOnAppLaunch !== "keep") {
    changed.startOnAppLaunch = value.startOnAppLaunch === "on";
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
      normalizedAllowlist.some((entryKey) => !/^[0-9a-f]{64}$/.test(entryKey))
    ) {
      return {
        error:
          "Allowlist entries must be agent keys — copy them from the desktop or a profile.",
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
    const envVars = envRowsToRecord(value.envRows);
    // Fold rule: the web never sends envVars and envVarsPatch together. A
    // dirty table folds the effort pick INTO the replace — set overwrites a
    // table row holding the same key (the pick is the newer intent), clear
    // must not collide with one. Replace-then-patch precedence makes the
    // fold and the pair identical in outcome; the fold keeps the wire
    // unambiguous.
    if (value.effort === "clear") {
      if (THINKING_EFFORT_ENV_KEY in envVars) {
        return {
          error:
            "The environment table sets the same key the effort control would remove.",
        };
      }
    } else if (value.effort !== "keep") {
      envVars[THINKING_EFFORT_ENV_KEY] = value.effort;
    }
    changed.envVars = envVars;
  } else if (value.effort !== "keep") {
    // Clean table: the effort pick rides the patch alone, touching nothing
    // else in the stored env map.
    changed.envVarsPatch = effortPatchFromSelection(value.effort);
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

import type { AdminCommand, HarnessSelection } from "./adminCommands";
import { envRowsToRecord, reservedKeyErrors, type EnvRow } from "./envRows.ts";
import { validateAllowlist, type RespondToMode } from "./respondToField.ts";

/**
 * Pure create-form → create-command builder, testable without React. Sends
 * ONLY the fields the desktop applier actually applies on create
 * (useOwnerAdminCommands.ts create case) and only when the user set them:
 * blank optionals stay absent, the env record rides only when the table has
 * content, and parallelism rides only when it parses. No timeout fields —
 * the desktop applier never forwards them (plan §0), so the form never
 * offers them. `spawnAfterCreate` is always true and `startOnAppLaunch`
 * defaults on — both are applied on create, unlike on update.
 */

export interface CreateAgentFormValue {
  name: string;
  systemPrompt: string;
  /** Create-only (the update path drops avatarUrl — plan §0). */
  avatarUrl: string;
  model: string;
  provider: string;
  /** Blank = "" keeps the desktop's default harness (no harness key sent). */
  parallelism: string;
  respondTo: RespondToMode;
  respondToAllowlist: string[];
  /** "" = desktop default harness; "__custom" = custom command; else preset id. */
  harnessId: string;
  customCommand: string;
  customArgs: string;
  envRows: EnvRow[];
  startOnAppLaunch: boolean;
}

/**
 * Build the create command. Returns `{ error }` for invalid input instead of
 * throwing, so the form can toast it.
 */
export function buildCreateCommand(
  value: CreateAgentFormValue,
): { command: AdminCommand } | { error: string } {
  const name = value.name.trim();
  if (!name) {
    return { error: "A name is required." };
  }
  const systemPrompt = value.systemPrompt.trim();
  if (!systemPrompt) {
    return { error: "A system prompt is required." };
  }

  let harness: HarnessSelection | undefined;
  if (value.harnessId === "__custom") {
    const command = value.customCommand.trim();
    if (!command) {
      return { error: "A custom harness needs a command." };
    }
    harness = {
      kind: "custom",
      command,
      args: value.customArgs
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter(Boolean),
    };
  } else if (value.harnessId !== "") {
    harness = { kind: "preset", runtimeId: value.harnessId };
  }

  const reserved = reservedKeyErrors(value.envRows);
  if (reserved.length > 0) {
    return { error: reserved[0] };
  }
  const envVars = envRowsToRecord(value.envRows);

  let parallelism: number | undefined;
  const parallelismText = value.parallelism.trim();
  if (parallelismText !== "") {
    const parsed = Number.parseInt(parallelismText, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { error: "Parallelism must be a whole number of 1 or more." };
    }
    parallelism = parsed;
  }

  const allowlistError = validateAllowlist(value.respondToAllowlist);
  if (value.respondTo === "allowlist" && allowlistError !== null) {
    return { error: allowlistError };
  }

  return {
    command: {
      action: "create",
      request: {
        name,
        systemPrompt,
        ...(value.avatarUrl.trim()
          ? { avatarUrl: value.avatarUrl.trim() }
          : {}),
        ...(value.model.trim() ? { model: value.model.trim() } : {}),
        ...(value.provider.trim() ? { provider: value.provider.trim() } : {}),
        ...(harness ? { harness } : {}),
        ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
        ...(parallelism !== undefined ? { parallelism } : {}),
        respondTo: value.respondTo,
        ...(value.respondTo === "allowlist"
          ? {
              respondToAllowlist: value.respondToAllowlist
                .map((entry) => entry.trim())
                .filter(Boolean),
            }
          : {}),
        spawnAfterCreate: true,
        startOnAppLaunch: value.startOnAppLaunch,
      },
    },
  };
}

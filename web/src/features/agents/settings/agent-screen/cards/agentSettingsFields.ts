import type { RosterRow } from "../../../lib/roster";
import {
  buildUpdateCommand,
  prefillEditForm,
} from "../../../lib/editAgentRequest";
import type { ApiKeySelection } from "../../../lib/providerApiKey";
import type {
  SettingsCommandPlan,
  SettingValue,
} from "../../lib/settingsDraft";

/** Scalars stay in W7's draft; compound wire fields are encoded only internally. */
export const SETTINGS_FIELDS = {
  model: ["Model", null],
  provider: ["Provider", null],
  harness: ["Runtime", null],
  parallelism: ["Turns at once", null],
  idleTimeoutSeconds: ["Idle timeout", 0],
  maxTurnDurationSeconds: ["Longest turn", 0],
  startOnAppLaunch: ["Start with Buzz Desktop", null],
  respondTo: ["Who can instruct", null],
  respondToAllowlist: ["Specific people", null],
  apiKey: ["API key", null],
} as const;
export type AgentSettingField = keyof typeof SETTINGS_FIELDS;
export type SettingsEcho = Partial<Record<AgentSettingField, SettingValue>>;
export const IDLE_BUILTIN = 900;
export const LONGEST_BUILTIN = 43_200;
export const UNREPORTED = "__unreported";

/** A projection is reported data; an echo is only a previously acknowledged edit. */
export function settingBaseline(
  row: RosterRow,
  echo: SettingsEcho,
  field: AgentSettingField,
): SettingValue {
  if (Object.prototype.hasOwnProperty.call(echo, field)) return echo[field] ?? null;
  switch (field) {
    case "model":
      return row.model || UNREPORTED;
    case "provider":
      return row.provider || UNREPORTED;
    case "parallelism":
      return row.entry.parallelism ?? UNREPORTED;
    case "respondTo":
      return row.entry.respondTo ?? UNREPORTED;
    case "respondToAllowlist":
      return JSON.stringify(row.entry.respondToAllowlist);
    case "harness":
      return row.persona?.runtime
        ? JSON.stringify({ kind: "preset", runtimeId: row.persona.runtime })
        : UNREPORTED;
    default:
      return UNREPORTED;
  }
}

/** Reuse the shipped update builder; no new desktop fields or effort env writer. */
export function buildCardUpdate(
  plan: SettingsCommandPlan,
  row: RosterRow,
  apiKey: ApiKeySelection,
  apiKeyEnvVar: string | null,
) {
  if (plan.request.pubkey !== row.pubkey)
    return { error: "The selected agent changed." };
  const prefill = prefillEditForm(row.entry, row.persona);
  const value = { ...prefill };
  for (const entry of plan.entries) {
    const field = entry.field as AgentSettingField;
    if (!Object.prototype.hasOwnProperty.call(SETTINGS_FIELDS, field))
      return { error: "Unsupported setting." };
    const next = plan.request[field];
    switch (field) {
      case "model":
      case "provider":
        if (typeof next !== "string" || !next.trim())
          return { error: "Update Buzz Desktop to reset this setting." };
        prefill[field] =
          entry.original.value === UNREPORTED
            ? ""
            : String(entry.original.value ?? "");
        value[field] = next;
        break;
      case "harness": {
        if (typeof next !== "string")
          return { error: "Update Buzz Desktop to use an inherited runtime." };
        try {
          const harness = JSON.parse(next);
          if (
            harness.kind === "preset" &&
            typeof harness.runtimeId === "string" &&
            harness.runtimeId.trim()
          )
            value.harnessId = harness.runtimeId;
          else if (
            harness.kind === "custom" &&
            typeof harness.command === "string" &&
            Array.isArray(harness.args) &&
            harness.args.every((arg: unknown) => typeof arg === "string")
          ) {
            value.harnessId = "__custom";
            value.customCommand = harness.command;
            value.customArgs = harness.args.join(" ");
          } else
            return { error: "Choose a runtime or enter a custom command." };
        } catch {
          return { error: "Invalid runtime." };
        }
        break;
      }
      case "parallelism":
        if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 1)
          return { error: "Turns at once must be a positive whole number." };
        prefill.parallelism =
          entry.original.value === UNREPORTED
            ? ""
            : String(entry.original.value);
        value.parallelism = String(next);
        break;
      case "idleTimeoutSeconds":
      case "maxTurnDurationSeconds":
        if (typeof next !== "number" || !Number.isSafeInteger(next) || next < 0)
          return { error: "Choose a duration in whole seconds." };
        value[field] = String(next);
        break;
      case "startOnAppLaunch":
        if (typeof next !== "boolean")
          return { error: "Choose On or Off for Start with Buzz Desktop." };
        value.startOnAppLaunch = next ? "on" : "off";
        break;
      case "respondTo":
        if (next !== "owner-only" && next !== "allowlist" && next !== "anyone")
          return { error: "Update Buzz Desktop to choose Nobody (paused)." };
        prefill.respondTo = entry.original.value as typeof prefill.respondTo;
        value.respondTo = next;
        break;
      case "respondToAllowlist":
        try {
          const people: unknown = JSON.parse(String(next));
          if (
            !Array.isArray(people) ||
            !people.every(
              (person) =>
                typeof person === "string" && /^[0-9a-f]{64}$/.test(person),
            )
          )
            return { error: "Choose people from the list." };
          prefill.respondToAllowlist = JSON.parse(String(entry.original.value));
          value.respondToAllowlist = people;
        } catch {
          return { error: "Choose people from the list." };
        }
        break;
      case "apiKey":
        if (apiKey.kind === "keep" || !apiKeyEnvVar)
          return { error: "Choose a provider and set or remove its API key." };
        value.apiKey = apiKey;
        value.apiKeyEnvVar = apiKeyEnvVar;
    }
  }
  if (value.respondTo === "allowlist" && value.respondToAllowlist.length === 0)
    return { error: "Choose at least one person." };
  return buildUpdateCommand(row.entry, prefill, value);
}

/** Reload echoes only timeout edits, never secrets, commands, or decrypted state. */
export function readTimeoutEcho(
  storage: Pick<Storage, "getItem">,
  key: string,
): SettingsEcho {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? "{}");
    const result: SettingsEcho = {};
    for (const field of [
      "idleTimeoutSeconds",
      "maxTurnDurationSeconds",
    ] as const) {
      if (Number.isSafeInteger(parsed[field]) && parsed[field] >= 0)
        result[field] = parsed[field] === 0 ? null : parsed[field];
    }
    return result;
  } catch {
    return {};
  }
}

/** Whitelist browser-authored acknowledged knobs; this is not a config cache. */
export function writeTimeoutEcho(
  storage: Pick<Storage, "setItem">,
  key: string,
  echo: SettingsEcho,
) {
  const result: Record<string, number> = {};
  for (const field of [
    "idleTimeoutSeconds",
    "maxTurnDurationSeconds",
  ] as const) {
    if (echo[field] === null) result[field] = 0;
    else if (typeof echo[field] === "number") result[field] = echo[field];
  }
  try {
    storage.setItem(key, JSON.stringify(result));
  } catch {
    /* Storage may be unavailable; the memory-only echo still works. */
  }
}

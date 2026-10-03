import type { SettingDraftEntry, SettingValue } from "../../lib/settingsDraft";
import { durationLabel } from "@/shared/ui/settings/DurationSelect";
import { UNREPORTED } from "./agentSettingsFields";

/** Render wire scalars as plain language; names replace keys in receipts. */
export function cardChangeText(
  entry: SettingDraftEntry,
  people: readonly { pubkey: string; name: string }[],
): string {
  if (entry.field === "envChanges")
    return `${entry.agentName} Environment variables changed`;
  if (entry.field === "systemPrompt")
    return `${entry.agentName} Instructions changed`;
  const readable = (value: SettingValue): string => {
    if (value === UNREPORTED) return "Not reported";
    if (value === null) return entry.defaultLabel;
    if (typeof value === "boolean") return value ? "On" : "Off";
    if (
      (entry.field === "idleTimeoutSeconds" ||
        entry.field === "maxTurnDurationSeconds") &&
      typeof value === "number"
    )
      return durationLabel(value);
    if (entry.field === "respondTo")
      return value === "owner-only"
        ? "Only me"
        : value === "allowlist"
          ? "Specific people"
          : "Anyone in the channel";
    if (entry.field === "respondToAllowlist" || entry.field === "harness") {
      try {
        const parsed = JSON.parse(String(value));
        if (entry.field === "harness")
          return parsed.kind === "custom" ? "Custom command" : parsed.runtimeId;
        return parsed.length
          ? parsed
              .map(
                (pubkey: string) =>
                  people.find((person) => person.pubkey === pubkey)?.name ??
                  "Person without a profile",
              )
              .join(", ")
          : "No people selected";
      } catch {
        return "Not reported";
      }
    }
    return String(value);
  };
  const from = entry.original.inherited
    ? entry.defaultLabel
    : readable(entry.original.value);
  const to =
    entry.change.kind === "clear"
      ? entry.defaultLabel
      : readable(entry.change.value);
  return `${entry.agentName} ${entry.label} ${from} → ${to}`;
}

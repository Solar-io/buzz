export type SettingValue = string | number | boolean | null;
export type DraftChange =
  | { kind: "set"; value: SettingValue }
  | { kind: "clear" };
export type SettingEffect =
  | "restart-when-idle"
  | "on-restart"
  | "next-turn"
  | "next-wake"
  | "now";

export interface SettingDraftEntry {
  agentPubkey: string;
  agentName: string;
  machine: string;
  field: string;
  label: string;
  original: { value: SettingValue; inherited: boolean; label?: string };
  /** The consuming command builder supplies its field's actual clear sentinel. */
  clearValue: SettingValue;
  defaultLabel: string;
  takesEffect: SettingEffect;
  change: DraftChange;
}
export type SettingsDraft = ReadonlyMap<string, SettingDraftEntry>;

/** Stable identity supports edits across the roster without name collisions. */
export function draftKey(
  entry: Pick<SettingDraftEntry, "agentPubkey" | "field">,
): string {
  return `${entry.agentPubkey}:${entry.field}`;
}

/** Keep a baseline once captured; returning to its override state removes dirt. */
export function editSettingsDraft(
  draft: SettingsDraft,
  entry: SettingDraftEntry,
): SettingsDraft {
  const key = draftKey(entry);
  const original = draft.get(key)?.original ?? entry.original;
  const unchanged =
    entry.change.kind === "clear"
      ? original.inherited
      : !original.inherited && Object.is(entry.change.value, original.value);
  const next = new Map(draft);
  if (unchanged) next.delete(key);
  else next.set(key, { ...entry, original });
  return next;
}

/** Explicit reset stays a clear operation even when its resolved value matches. */
export function resetSettingsDraft(
  draft: SettingsDraft,
  entry: SettingDraftEntry,
): SettingsDraft {
  return editSettingsDraft(draft, { ...entry, change: { kind: "clear" } });
}

/** Summary for both one-agent screens and multi-agent roster drafts. */
export function settingsDraftSummary(draft: SettingsDraft): string {
  const agents = new Set([...draft.values()].map((entry) => entry.agentPubkey))
    .size;
  return `${draft.size} ${draft.size === 1 ? "change" : "changes"} on ${agents} ${agents === 1 ? "agent" : "agents"}`;
}

/** A plain-text change receipt; never interpret user or desktop text as HTML. */
export function settingChangeSummary(entry: SettingDraftEntry): string {
  const from = entry.original.label ?? String(entry.original.value);
  const to =
    entry.change.kind === "clear"
      ? `default (${entry.defaultLabel})`
      : String(entry.change.value);
  return `${entry.agentName} ${entry.label} ${from} → ${to}`;
}

const effectLabels: Record<SettingEffect, string> = {
  "restart-when-idle": "restart when idle",
  "on-restart": "on restart",
  "next-turn": "next turn",
  "next-wake": "next wake",
  now: "now",
};
export function settingsEffectSummary(draft: SettingsDraft): string {
  const counts = new Map<SettingEffect, number>();
  for (const entry of draft.values())
    counts.set(entry.takesEffect, (counts.get(entry.takesEffect) ?? 0) + 1);
  return [...counts]
    .map(([effect, count]) => `${count} ${effectLabels[effect]}`)
    .join(" · ");
}

export interface SettingsCommandPlan {
  machine: string;
  action: "update";
  /** Validate/cap-gate through the consuming phase's command builder before sending. */
  request: { pubkey: string } & Record<string, SettingValue>;
  entries: readonly SettingDraftEntry[];
}

/** One atomic patch per agent, unchanged keys omitted and resets explicit. */
export function planSettingsCommands(
  draft: SettingsDraft,
): SettingsCommandPlan[] {
  const plans = new Map<string, SettingsCommandPlan>();
  for (const entry of draft.values()) {
    if (
      entry.field === "pubkey" ||
      entry.field === "__proto__" ||
      entry.field === "constructor" ||
      entry.field === "prototype"
    ) {
      throw new Error("Invalid settings field");
    }
    const previous = plans.get(entry.agentPubkey);
    if (previous && previous.machine !== entry.machine)
      throw new Error("An agent's changes must target one desktop");
    const plan = previous ?? {
      machine: entry.machine,
      action: "update",
      request: { pubkey: entry.agentPubkey },
      entries: [],
    };
    plan.request[entry.field] =
      entry.change.kind === "clear" ? entry.clearValue : entry.change.value;
    plan.entries = [...plan.entries, entry];
    plans.set(entry.agentPubkey, plan);
  }
  return [...plans.values()];
}

/** Inverse of acknowledged edits only; an inherited baseline becomes a clear. */
export function undoSettingsDraft(
  entries: readonly SettingDraftEntry[],
): SettingsDraft {
  return new Map(
    entries.map((entry) => [
      draftKey(entry),
      {
        ...entry,
        original: {
          value:
            entry.change.kind === "clear"
              ? entry.clearValue
              : entry.change.value,
          inherited: entry.change.kind === "clear",
        },
        change: entry.original.inherited
          ? { kind: "clear" }
          : { kind: "set", value: entry.original.value },
      },
    ]),
  );
}

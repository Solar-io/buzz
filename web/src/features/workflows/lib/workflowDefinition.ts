/**
 * Reading a kind:30620 workflow-definition event.
 *
 * Wire shape (`crates/buzz-sdk/src/builders.rs`, `build_workflow_def`):
 *   kind    30620 — NIP-33 parameterized replaceable
 *   d tag   workflow UUID
 *   h tag   channel UUID (the workflow's scope; the relay authorizes against it)
 *   content the workflow definition, as raw YAML
 *
 * Everything the list needs is derived from that one event, exactly as Buzz
 * Desktop derives it in `desktop/src-tauri/src/commands/workflows.rs`
 * (`workflow_from_event`). In particular `enabled` is a field of the YAML body
 * (`crates/buzz-workflow/src/schema.rs`, defaulting to true) — the relay's own
 * disable/archive lifecycle is never written back into the event, so a client
 * cannot see it and must not pretend to.
 */

import { parseYamlMapping, type YamlValue } from "./yaml.ts";

/** The event fields this module reads. Matches `SignedNostrEvent`. */
export type WorkflowEventLike = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

export const WORKFLOW_DEFINITION_KIND = 30620;

export type WorkflowStep = {
  /** Step id from the definition, or a positional fallback when absent. */
  id: string;
  /**
   * A render key that is unique within the list.
   *
   * The relay rejects a definition with duplicate step ids, but a client reads
   * whatever the author last saved — including a body that never passed
   * validation — so `id` alone is not a safe React key. Occurrences after the
   * first get a `#n` suffix.
   */
  key: string;
  /** `action:` — the serde tag of the action enum. */
  action: string | null;
  /** Optional human-readable `name:`. */
  name: string | null;
  /** The `if:` guard expression, if any. */
  condition: string | null;
  /** Every other key of the step, in document order, for the detail view. */
  fields: Array<{ key: string; value: string }>;
};

export type WorkflowTrigger = {
  /** `on:` — one of message_posted, reaction_added, diff_posted, schedule, webhook. */
  on: string | null;
  emoji: string | null;
  filter: string | null;
  cron: string | null;
  interval: string | null;
};

export type WorkflowSummary = {
  /** d tag — the workflow UUID. */
  id: string;
  /** h tag — the channel UUID this workflow is scoped to. */
  channelId: string | null;
  /** Author of the definition event; only the owner may trigger a run. */
  ownerPubkey: string;
  /** Event id of this revision — the `expected-revision` value for an update. */
  revision: string;
  /** `name:`, falling back to the workflow id when the body has none. */
  name: string;
  description: string | null;
  /** `enabled:` — absent means enabled, per the engine's serde default. */
  enabled: boolean;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  /** The event content verbatim. */
  yaml: string;
  /** Why the YAML could not be read, when it could not be. */
  parseError: string | null;
  updatedAt: number;
};

const EMPTY_TRIGGER: WorkflowTrigger = {
  on: null,
  emoji: null,
  filter: null,
  cron: null,
  interval: null,
};

function firstTag(event: WorkflowEventLike, name: string): string | null {
  for (const tag of event.tags) {
    if (tag.length >= 2 && tag[0] === name) return tag[1];
  }
  return null;
}

function asMapping(value: YamlValue): { [key: string]: YamlValue } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

function asText(value: YamlValue): string | null {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

/** Render any leaf value for display without inventing structure. */
function displayValue(value: YamlValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

const STEP_META_KEYS = new Set(["id", "action", "name", "if"]);

function readSteps(definition: { [key: string]: YamlValue }): WorkflowStep[] {
  const raw = definition.steps;
  if (!Array.isArray(raw)) return [];
  const steps: WorkflowStep[] = [];
  const seen = new Map<string, number>();
  raw.forEach((entry, index) => {
    const step = asMapping(entry);
    if (step === null) return;
    const fields: Array<{ key: string; value: string }> = [];
    for (const [key, value] of Object.entries(step)) {
      if (STEP_META_KEYS.has(key)) continue;
      fields.push({ key, value: displayValue(value) });
    }
    const id = asText(step.id) ?? `step-${index + 1}`;
    const occurrence = seen.get(id) ?? 0;
    seen.set(id, occurrence + 1);
    steps.push({
      id,
      key: occurrence === 0 ? id : `${id}#${occurrence}`,
      action: asText(step.action),
      name: asText(step.name),
      condition: asText(step.if),
      fields,
    });
  });
  return steps;
}

function readTrigger(definition: {
  [key: string]: YamlValue;
}): WorkflowTrigger {
  const trigger = asMapping(definition.trigger);
  if (trigger === null) return EMPTY_TRIGGER;
  return {
    on: asText(trigger.on),
    emoji: asText(trigger.emoji),
    filter: asText(trigger.filter),
    cron: asText(trigger.cron),
    interval: asText(trigger.interval),
  };
}

/**
 * Build the summary for one kind:30620 event. Returns `null` for an event that
 * is not a workflow definition or carries no `d` tag — there is nothing to
 * address it by, so it cannot be listed, opened or triggered.
 */
export function workflowFromEvent(
  event: WorkflowEventLike,
): WorkflowSummary | null {
  if (event.kind !== WORKFLOW_DEFINITION_KIND) return null;
  const id = firstTag(event, "d");
  if (id === null || id.trim() === "") return null;

  const yaml = event.content ?? "";
  const parsed = parseYamlMapping(yaml);
  const definition = parsed ?? {};
  // Distinguish "unreadable" from "readable but empty": an empty body is a
  // workflow with no steps, not a broken one.
  const parseError =
    parsed === null && yaml.trim() !== ""
      ? "This definition could not be read as YAML."
      : null;

  return {
    id,
    channelId: firstTag(event, "h"),
    ownerPubkey: event.pubkey,
    revision: event.id,
    name: asText(definition.name) ?? id,
    description: asText(definition.description),
    enabled: definition.enabled !== false,
    trigger: readTrigger(definition),
    steps: readSteps(definition),
    yaml,
    parseError,
    updatedAt: event.created_at,
  };
}

/**
 * Merge a newly-seen revision into a workflow map.
 *
 * kind:30620 is parameterized replaceable, so the relay may replay several
 * revisions of the same `d` tag. Newest `created_at` wins; ties break on the
 * event id so the result does not depend on arrival order.
 */
export function mergeWorkflow(
  previous: Map<string, WorkflowSummary>,
  next: WorkflowSummary,
): Map<string, WorkflowSummary> {
  const existing = previous.get(next.id);
  if (existing !== undefined) {
    if (existing.updatedAt > next.updatedAt) return previous;
    if (
      existing.updatedAt === next.updatedAt &&
      existing.revision >= next.revision
    ) {
      return previous;
    }
  }
  const merged = new Map(previous);
  merged.set(next.id, next);
  return merged;
}

const TRIGGER_LABELS: Record<string, string> = {
  message_posted: "Message posted",
  reaction_added: "Reaction added",
  diff_posted: "Diff posted",
  schedule: "On a schedule",
  webhook: "Webhook",
};

const ACTION_LABELS: Record<string, string> = {
  send_message: "Send a message",
  send_dm: "Send a DM",
  set_channel_topic: "Set the channel topic",
  add_reaction: "Add a reaction",
  call_webhook: "Call a webhook",
  request_approval: "Request approval",
  delay: "Wait",
};

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Label for a trigger's `on:` value; unknown values are humanized, not hidden. */
export function triggerLabel(trigger: WorkflowTrigger): string {
  if (trigger.on === null) return "No trigger";
  return TRIGGER_LABELS[trigger.on] ?? humanize(trigger.on);
}

/** Label for a step's `action:` value. */
export function actionLabel(action: string | null): string {
  if (action === null) return "No action";
  return ACTION_LABELS[action] ?? humanize(action);
}

/** One-line description of when a workflow fires. */
export function triggerDescription(trigger: WorkflowTrigger): string {
  const base = triggerLabel(trigger);
  const parts: string[] = [];
  if (trigger.on === "reaction_added" && trigger.emoji !== null) {
    parts.push(`:${trigger.emoji}:`);
  }
  if (trigger.on === "schedule") {
    if (trigger.cron !== null) parts.push(`cron ${trigger.cron}`);
    else if (trigger.interval !== null) parts.push(`every ${trigger.interval}`);
  }
  if (trigger.filter !== null) parts.push(`when ${trigger.filter}`);
  return parts.length === 0 ? base : `${base} — ${parts.join(", ")}`;
}

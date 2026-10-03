import type { UnsignedNostrEvent } from "@/shared/lib/nostr-signer";
import {
  WORKFLOW_DEFINITION_KIND,
  type WorkflowSummary,
} from "./workflowDefinition.ts";
import { parseYamlDocument } from "./yaml.ts";

export const NEW_WORKFLOW_YAML = `name: New workflow
trigger:
  on: message_posted
  filter: 'trigger_text == "run workflow"'
steps:
  - id: wait
    action: delay
    duration: 1s
`;

/** Local syntax/shape feedback; the relay remains the schema authority. */
export function workflowYamlError(yaml: string): string | null {
  if (new TextEncoder().encode(yaml).length > 64 * 1024) {
    return "The definition must be at most 64 KB.";
  }
  const { value, error } = parseYamlDocument(yaml);
  if (error !== null) return error;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "Enter a workflow as a YAML mapping.";
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    return "The workflow needs a name.";
  }
  const trigger = value.trigger;
  if (
    trigger === null ||
    typeof trigger !== "object" ||
    Array.isArray(trigger) ||
    typeof trigger.on !== "string"
  ) {
    return "The workflow needs a trigger with an on value.";
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    return "The workflow needs at least one step.";
  }
  return null;
}

/** Mirror buzz-sdk build_workflow_def/update, including the edit revision guard. */
export function workflowEventTemplate(
  channelId: string,
  yaml: string,
  existing?: WorkflowSummary,
  draftId?: string,
): Omit<UnsignedNostrEvent, "created_at"> {
  const error = workflowYamlError(yaml);
  if (error !== null) throw new Error(error);
  if (existing !== undefined && existing.channelId !== channelId) {
    throw new Error("This workflow belongs to another channel.");
  }
  const tags = [
    ["d", existing?.id ?? draftId ?? crypto.randomUUID()],
    ["h", channelId],
  ];
  if (existing !== undefined)
    tags.push(["expected-revision", existing.revision]);
  return { kind: WORKFLOW_DEFINITION_KIND, tags, content: yaml };
}

/**
 * Starting a workflow run by hand.
 *
 * A manual trigger is a signed kind:46020 event whose `d` tag is the workflow
 * UUID and whose content is either empty or a JSON object of inputs
 * (`build_workflow_trigger` in `crates/buzz-sdk/src/builders.rs`; the inputs
 * form is `buzz-cli`'s `--inputs`, which the relay folds into the trigger
 * context's webhook fields).
 *
 * The relay answers on the event's OK message with `response:{"run_id": ...}`
 * (`handle_workflow_trigger` in
 * `crates/buzz-relay/src/handlers/command_executor.rs`).
 *
 * Who may trigger, per that same handler: only the workflow's owner, and only
 * while the workflow is enabled and active. A member of the channel who does
 * not own the workflow is refused — "forbidden: not authorized to trigger this
 * workflow" — so the button belongs to the owner alone.
 */

export const KIND_WORKFLOW_TRIGGER = 46020;

export type TriggerEventTemplate = {
  kind: number;
  tags: string[][];
  content: string;
};

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Build the unsigned trigger event.
 *
 * `inputs` must be a JSON object when given — the relay only folds an object's
 * entries into the trigger context and ignores anything else, so rejecting it
 * here beats publishing an event whose payload is silently dropped.
 */
export function triggerEventTemplate(
  workflowId: string,
  inputs?: Record<string, unknown>,
): TriggerEventTemplate {
  if (!UUID.test(workflowId)) {
    throw new Error("Workflow id must be a UUID.");
  }
  return {
    kind: KIND_WORKFLOW_TRIGGER,
    tags: [["d", workflowId.toLowerCase()]],
    content: inputs === undefined ? "" : JSON.stringify(inputs),
  };
}

/**
 * Read the run id out of the relay's OK message.
 *
 * The relay prefixes its structured answers with `response:`; a bare JSON body
 * is accepted too, matching Buzz Desktop's `parse_command_response`. Returns
 * null when the message carries no run id — the caller then reports that the
 * run started without saying which, rather than inventing an id.
 */
export function runIdFromRelayMessage(message: string): string | null {
  const body = message.startsWith("response:")
    ? message.slice("response:".length)
    : message;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const runId = (parsed as Record<string, unknown>).run_id;
    return typeof runId === "string" && runId.length > 0 ? runId : null;
  } catch {
    return null;
  }
}

/**
 * Whether the viewer may start this workflow by hand, mirroring the relay's
 * own preconditions so the UI does not offer a refused action.
 */
export function canTrigger(
  ownerPubkey: string,
  enabled: boolean,
  viewerPubkey: string | null,
): boolean {
  if (viewerPubkey === null || viewerPubkey === "") return false;
  return enabled && ownerPubkey.toLowerCase() === viewerPubkey.toLowerCase();
}

/**
 * Owner-reviewed agent drafts, published through the observer-frame channel
 * (kind 24200, NIP-44 v2 to the owner) — the wire shape of the CLI's
 * `agents draft-create` / `draft-update` (crates/buzz-cli/src/agent_management.rs).
 * The owner's Buzz Desktop renders the draft card; nothing changes until they
 * save it there.
 */

export const AGENT_MANAGEMENT_REQUEST = "agent_management_request";

export const MAX_NAME_CHARS = 120;
export const MAX_PROMPT_CHARS = 20_000;

export interface CreateDraftInput {
  channelId: string;
  displayName: string;
  systemPrompt: string;
}

export interface UpdateDraftInput {
  channelId: string;
  agentName: string;
  displayName?: string;
  systemPrompt?: string;
  runtime?: string;
  provider?: string;
  model?: string;
  respondTo?: "owner-only" | "anyone";
}

/** Mirrors the CLI's validation: trimmed, non-empty, length-capped. */
export function validateDraftText(
  value: string,
  max = MAX_NAME_CHARS,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: "This field is required." };
  }
  if (trimmed.length > max) {
    return { ok: false, error: `Too long (max ${max} characters).` };
  }
  return { ok: true, value: trimmed };
}

/**
 * The observer-frame envelope (serde camelCase on the wire) the desktop's
 * frame readers expect. `kind` names the payload type; requestId/timestamp
 * are injected so the builder stays pure and testable.
 */
export function buildObserverEnvelope(
  payload: object & { channelId?: string; type?: string },
  channelId: string,
  _requestId?: string,
  timestamp = new Date().toISOString(),
): string {
  // _requestId kept in the signature for call-site symmetry; the id lives in
  // the payload itself.void _requestId;
  const envelope = {
    seq: 0,
    timestamp,
    kind: payload.type ?? AGENT_MANAGEMENT_REQUEST,
    agentIndex: null,
    channelId,
    sessionId: null,
    turnId: null,
    payload,
  };
  return JSON.stringify(envelope);
}

/** An update must carry at least one change beyond identity fields. */
export function updateHasChanges(update: UpdateDraftInput): boolean {
  return Boolean(
    update.displayName ??
      update.systemPrompt ??
      update.runtime ??
      update.provider ??
      update.model ??
      update.respondTo,
  );
}

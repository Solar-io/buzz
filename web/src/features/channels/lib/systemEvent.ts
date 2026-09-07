/**
 * Kind 40099 system messages — relay-signed channel state changes.
 *
 * The relay emits these for membership changes and for message deletions:
 * `handle_delete_event_side_effect` (buzz-relay side_effects.rs) soft-deletes
 * the target and publishes a `message_deleted` tombstone. Without them the
 * browser shows no trace at all that a message was removed.
 *
 * The event content is a JSON object. This module parses it and reduces it to
 * the two-part caption the timeline renders. It is deliberately pure — label
 * resolution is injected — so it stays free of React/profile deps and is
 * directly unit-testable (mirrors desktop `describeSystemEvent` and mobile
 * `SystemEvent.describe`).
 *
 * Scope: the deletion-tombstone path and the membership join/leave path.
 * Other 40099 types (topic_changed, channel_created, huddles, …) parse fine but
 * describe to `null` and render no row, exactly as the desktop's `default:`
 * branch does for a type it does not know.
 */

/** `KIND_SYSTEM_MESSAGE` in crates/buzz-core/src/kind.rs. */
export const SYSTEM_MESSAGE_KIND = 40099;

export interface SystemEventPayload {
  type: string;
  /** Who performed the action (hex pubkey). */
  actor?: string;
  /** Who it was performed on (hex pubkey) — membership events. */
  target?: string;
  /**
   * Deletion tombstone ("message_deleted"): the id of the removed event.
   * The relay soft-deleted it server-side, so the row must be hidden locally.
   */
  target_event_id?: string;
}

export interface SystemEventDescription {
  /** Lead of the caption — an actor/target name. */
  title: string;
  /** Predicate — "joined the channel", "removed a message". */
  action: string;
}

/** Resolve a hex pubkey to a display label. `undefined` → a generic stand-in. */
export type SystemLabelResolver = (pubkey: string | undefined) => string;

/** Hex pubkeys are compared case-insensitively; the relay emits lowercase. */
function samePubkey(a: string | undefined, b: string | undefined): boolean {
  return (
    typeof a === "string" &&
    typeof b === "string" &&
    a.toLowerCase() === b.toLowerCase()
  );
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse a kind-40099 event body. Returns null for anything that is not a JSON
 * object with a string `type` — an unparsable system row renders nothing
 * rather than leaking a raw JSON blob into the conversation.
 */
export function systemEventFromContent(
  content: string,
): SystemEventPayload | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(content);
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return null;
  }
  const source = decoded as Record<string, unknown>;
  const type = optionalString(source, "type");
  if (!type) {
    return null;
  }
  return {
    type,
    actor: optionalString(source, "actor"),
    target: optionalString(source, "target"),
    target_event_id: optionalString(source, "target_event_id"),
  };
}

/**
 * The event id a deletion tombstone refers to, or null when the payload is
 * not a removal. Callers hide that row: the relay already soft-deleted it, so
 * a live client that keeps rendering it is showing content the community has
 * removed.
 */
export function tombstoneTargetId(
  payload: SystemEventPayload | null,
): string | null {
  if (payload?.type !== "message_deleted") {
    return null;
  }
  return payload.target_event_id ?? null;
}

/**
 * Caption for a system payload, or null when this row should not render.
 *
 * Wording follows the desktop client so the two read identically:
 *   - a self-join is titled by the joiner, "joined the channel";
 *   - an add is titled by the person added, "added by <actor>";
 *   - a leave/removal is titled by the actor.
 */
export function describeSystemEvent(
  payload: SystemEventPayload | null,
  resolveLabel: SystemLabelResolver,
): SystemEventDescription | null {
  if (!payload) {
    return null;
  }
  switch (payload.type) {
    case "member_joined": {
      if (!payload.actor || !payload.target) {
        return null;
      }
      if (samePubkey(payload.actor, payload.target)) {
        return {
          title: resolveLabel(payload.target),
          action: "joined the channel",
        };
      }
      return {
        title: resolveLabel(payload.target),
        action: `added by ${resolveLabel(payload.actor)}`,
      };
    }
    case "member_left": {
      if (!payload.actor) {
        return null;
      }
      return { title: resolveLabel(payload.actor), action: "left the channel" };
    }
    case "member_removed": {
      if (!payload.actor || !payload.target) {
        return null;
      }
      return {
        title: resolveLabel(payload.actor),
        action: `removed ${resolveLabel(payload.target)} from the channel`,
      };
    }
    case "message_deleted": {
      // Deletion tombstone: the relay soft-deleted the target server-side and
      // this row is the room-facing trace. The removed content never appears.
      if (!payload.actor) {
        return null;
      }
      return {
        title: resolveLabel(payload.actor),
        action: "removed a message",
      };
    }
    default:
      return null;
  }
}

/**
 * Which resolutions a queue viewer may actually carry out — the client mirror
 * of the relay's own arms, per action.
 *
 * A resolution is TWO events, and they are enforced by two different pieces of
 * the relay with two different notions of authority. Collapsing them into one
 * "is a moderator" boolean is exactly how a button comes to promise something
 * the relay refuses:
 *
 * | Resolution | Events        | Enforced by                                                              |
 * |------------|---------------|--------------------------------------------------------------------------|
 * | delete     | 9005 + 9044   | 9005: `side_effects.rs::validate_admin_event` arm 9005 — the event author, |
 * |            |               | or **channel** owner/admin of the `h` channel. 9044: community owner/admin |
 * | kick       | 9001 + 9044   | 9001: `validate_admin_event` arm 9001 — **channel** owner/admin            |
 * | ban        | 9040 + 9044   | 9040: `moderation_authz::decide_authority` — **community** owner/admin     |
 * | timeout    | 9042 + 9044   | 9042: `decide_authority` — **community** owner/admin                       |
 * | escalate   | 9044 only     | `decide_authority` — **community** owner/admin                             |
 * | dismiss    | 9044 only     | `decide_authority` — **community** owner/admin                             |
 *
 * The asymmetry is real and load-bearing. `ModerationAction::DeleteMessage`
 * and `::Kick` exist in `moderation_authz` but **nothing in production calls
 * `authorize_moderation_action` with them** — verified by grep across
 * `crates/buzz-relay/src`, where the only references are that module's own
 * unit tests. The live 9005/9001 path is `ingest.rs` → `validate_admin_event`,
 * which never reads `relay_members`. `moderation_authz.rs`'s module doc calls
 * community authority "the bridge `validate_admin_event` is missing today",
 * and today is still today: **a community owner who holds no role in the
 * reported message's channel cannot delete it or kick its author.**
 *
 * So this module needs the viewer's role in the *reported message's channel*,
 * not just their community role, and the queue has to fetch a kind-39001
 * snapshot per channel it is showing. The desktop client's queue does not: its
 * `resolvableActions` offers Delete and Kick on the strength of `targetKind`
 * and a channel id alone, so a community admin with no channel role is shown
 * both and the relay refuses them. Following the relay rather than the desktop
 * is deliberate here.
 *
 * Import-free by design so the node test runner can load it directly.
 */

/** Community-wide role from the NIP-43 kind-13534 snapshot. */
export type CommunityRole = "owner" | "admin" | "member";
/** Channel-local role from the NIP-29 kind-39001 snapshot. */
export type ChannelRole = "owner" | "admin";

/**
 * The `action` vocabulary of a kind-9044 resolve, verbatim from
 * `moderation_commands.rs::handle_resolve`. Anything outside it is rejected at
 * ingest with "invalid action: …".
 */
export type ResolutionAction =
  | "delete"
  | "kick"
  | "ban"
  | "timeout"
  | "dismiss"
  | "escalate";

export const RESOLUTION_ACTIONS: readonly ResolutionAction[] = [
  "delete",
  "kick",
  "ban",
  "timeout",
  "escalate",
  "dismiss",
];

export interface QueueAuthorityInput {
  /** The viewer's community role, or null when they hold none. */
  actorCommunityRole: CommunityRole | null;
  /**
   * The viewer's role in the reported message's own channel, or null when
   * they hold none — or when the snapshot has not arrived yet, which fails
   * closed for the same reason.
   */
  actorChannelRole: ChannelRole | null;
  /** The reported author's community role, for the admin guard rail. */
  targetCommunityRole: CommunityRole | null;
  /** What the report points at. */
  targetKind: "event" | "pubkey" | "blob";
  /** The report carries a channel id — 9005 and 9001 both need an `h` tag. */
  hasChannel: boolean;
  /**
   * The author a member-directed enforcement would act on is known. For a
   * pubkey report that is the target itself; for an event report it has to be
   * read back off the reported event, which can fail (already deleted, not
   * replayed yet).
   */
  targetAuthorKnown: boolean;
  /** The reported author is the viewer. */
  targetIsSelf: boolean;
}

/** Why one resolution is not offered — shown rather than silently hidden. */
export type ResolutionBlockReason =
  | "not-a-moderator"
  | "needs-channel-role"
  | "needs-a-channel"
  | "needs-an-author"
  | "admin-cannot-action-admin"
  | "not-against-yourself";

export interface QueueAuthority {
  /** The resolutions the relay would accept, in presentation order. */
  allowed: ResolutionAction[];
  /** For every other resolution, why it is unavailable. */
  blocked: Record<string, ResolutionBlockReason>;
}

/** Human copy for a block reason — one sentence, shown in the menu. */
export function blockReasonLabel(reason: ResolutionBlockReason): string {
  switch (reason) {
    case "not-a-moderator":
      return "Requires a community moderator.";
    case "needs-channel-role":
      return "Requires owner or admin of this channel.";
    case "needs-a-channel":
      return "This report is not tied to a channel.";
    case "needs-an-author":
      return "The reported author could not be resolved.";
    case "admin-cannot-action-admin":
      return "Only the community owner can action another moderator.";
    case "not-against-yourself":
      return "Not available against your own account.";
  }
}

/**
 * Decide the resolutions to offer.
 *
 * Every arm below is the relay's, restated:
 *
 *  - **Community authority** (`decide_authority`): `owner` holds everything;
 *    `admin` holds everything except banning or timing out a community
 *    `owner` or a fellow `admin` — "an admin cannot ban or time out a
 *    community owner or fellow admin". A target with no `relay_members` row
 *    (a drive-by spammer who already left) is bannable, so the guard trips on
 *    a target ROLE of owner/admin, not on the absence of one.
 *  - **Channel authority** (`validate_admin_event`): 9005 wants the event's
 *    author or a channel owner/admin; 9001 wants a channel owner/admin. Both
 *    need the `h` tag, hence `hasChannel`.
 *  - Self-targeting: 9040/9042 against yourself is accepted by the relay for
 *    an owner and then locks you out — `handle_moderation_command` rejects
 *    every later command from a banned actor before it looks at the kind. It
 *    is not offered. Deleting your own reported message is ordinary and stays.
 */
export function queueAuthority(input: QueueAuthorityInput): QueueAuthority {
  const isCommunityModerator =
    input.actorCommunityRole === "owner" ||
    input.actorCommunityRole === "admin";
  const isChannelModerator =
    input.actorChannelRole === "owner" || input.actorChannelRole === "admin";
  const targetIsPrivileged =
    input.targetCommunityRole === "owner" ||
    input.targetCommunityRole === "admin";

  const allowed: ResolutionAction[] = [];
  const blocked: Record<string, ResolutionBlockReason> = {};

  const deny = (
    action: ResolutionAction,
    reason: ResolutionBlockReason,
  ): void => {
    blocked[action] = reason;
  };

  // Nothing at all without community authority: every resolution ends in a
  // 9044, and ViewQueue/ResolveReport are community-only capabilities.
  if (!isCommunityModerator) {
    for (const action of RESOLUTION_ACTIONS) {
      deny(action, "not-a-moderator");
    }
    return { allowed, blocked };
  }

  // delete → 9005. Channel axis, plus a target that IS an event in a channel.
  if (input.targetKind !== "event") {
    deny("delete", "needs-a-channel");
  } else if (!input.hasChannel) {
    deny("delete", "needs-a-channel");
  } else if (!isChannelModerator && !input.targetIsSelf) {
    // `validate_admin_event` also lets the target event's own author delete
    // it, which is the only route a viewer without a channel role has.
    deny("delete", "needs-channel-role");
  } else {
    allowed.push("delete");
  }

  // kick → 9001. Channel axis. Self-removal is a member action, not a
  // moderation decision, and the relay guards it separately (last owner).
  if (input.targetKind !== "event" || !input.hasChannel) {
    deny("kick", "needs-a-channel");
  } else if (!input.targetAuthorKnown) {
    deny("kick", "needs-an-author");
  } else if (input.targetIsSelf) {
    deny("kick", "not-against-yourself");
  } else if (!isChannelModerator) {
    deny("kick", "needs-channel-role");
  } else {
    allowed.push("kick");
  }

  // ban → 9040, timeout → 9042. Community axis, with the admin guard rail.
  for (const action of ["ban", "timeout"] as const) {
    if (input.targetKind === "blob") {
      deny(action, "needs-an-author");
    } else if (!input.targetAuthorKnown) {
      deny(action, "needs-an-author");
    } else if (input.targetIsSelf) {
      deny(action, "not-against-yourself");
    } else if (input.actorCommunityRole === "admin" && targetIsPrivileged) {
      deny(action, "admin-cannot-action-admin");
    } else {
      allowed.push(action);
    }
  }

  // escalate and dismiss are decision-only: one 9044 and nothing else, so
  // community authority is the whole gate.
  allowed.push("escalate", "dismiss");

  // Presentation order, not insertion order.
  allowed.sort(
    (a, b) => RESOLUTION_ACTIONS.indexOf(a) - RESOLUTION_ACTIONS.indexOf(b),
  );
  return { allowed, blocked };
}

/**
 * The `status` tag that pairs with an `action` tag.
 *
 * `handle_resolve` rejects a mismatch outright — `(action == "dismiss") ==
 * (status == "dismissed")` — so the pairing is encoded once, here, and the UI
 * cannot submit an invalid combination.
 */
export function statusForAction(
  action: ResolutionAction,
): "resolved" | "dismissed" {
  return action === "dismiss" ? "dismissed" : "resolved";
}

/** Whether a resolution has an enforcement event to send before its 9044. */
export function enforcementKindFor(action: ResolutionAction): number | null {
  switch (action) {
    case "delete":
      return 9005;
    case "kick":
      return 9001;
    case "ban":
      return 9040;
    case "timeout":
      return 9042;
    case "escalate":
    case "dismiss":
      return null;
  }
}

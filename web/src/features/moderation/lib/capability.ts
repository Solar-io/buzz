/**
 * Who may moderate what — the client mirror of the relay's enforced policy.
 *
 * This gate exists so a member never sees a control the relay will refuse. It
 * therefore mirrors the code that actually *enforces*, not the plan document,
 * and the two axes below are genuinely different authorities:
 *
 * | Action           | Kind      | Enforced by                                                        |
 * |------------------|-----------|--------------------------------------------------------------------|
 * | Remove message   | 9005      | `side_effects.rs::validate_admin_event` arm 9005 — event author, or |
 * |                  |           | **channel** owner/admin of the `h` channel                          |
 * | Kick from channel| 9001      | `validate_admin_event` arm 9001 — **channel** owner/admin           |
 * | Ban / Unban      | 9040/9041 | `moderation_authz::decide_authority` — **community** owner/admin    |
 * | Timeout / Untimeout | 9042/9043 | `moderation_authz::decide_authority` — **community** owner/admin |
 *
 * The asymmetry is real and load-bearing: `decide_authority`'s
 * `channel_role_covers_only_delete_and_kick` test pins that a channel role
 * grants *no* community action, and `validate_admin_event` never consults
 * `relay_members` — a fact `moderation_authz.rs`'s own module doc calls out
 * ("this is the bridge `validate_admin_event` is missing today"). Collapsing
 * the two axes into one "isModerator" boolean would show a community admin a
 * Kick button the relay rejects, and hide Remove Message from a channel admin
 * who is entitled to it.
 *
 * Both roles reach the browser as ordinary relay-signed events, so no privileged
 * transport is needed:
 * - community role — kind:13534 NIP-43 membership snapshot, tags
 *   `["member", <pubkey>, <role>]` (buzz-db `publish_nip43_membership_locked`).
 * - channel role — kind:39001 NIP-29 group admins for `#d = channelId`, tags
 *   `["p", <pubkey>, <role>]`, emitted only for owner/admin
 *   (`side_effects.rs` group-discovery emission).
 *
 * Import-free by design so the node test runner can load it directly.
 */

/** `KIND_NIP43_MEMBERSHIP_LIST` in crates/buzz-core/src/kind.rs. */
export const KIND_RELAY_MEMBERSHIP_LIST = 13534;
/** `KIND_NIP29_GROUP_ADMINS` in crates/buzz-core/src/kind.rs. */
export const KIND_CHANNEL_ADMINS = 39001;

/** Community-wide role from the NIP-43 snapshot. */
export type CommunityRole = "owner" | "admin" | "member";
/** Channel-local role, as published in the kind-39001 admin snapshot. */
export type ChannelRole = "owner" | "admin";

/** The minimal shape this module needs from a relay event. */
export interface RoleEvent {
  tags: string[][];
}

/** Which per-message moderation controls the viewer may actually exercise. */
export interface ModerationCapability {
  /** kind:9005 — soft-delete another member's message in this channel. */
  canRemoveMessage: boolean;
  /** kind:9001 — remove the author from this channel. */
  canKick: boolean;
  /** kind:9040 / 9041 — ban the author from the community, or lift it. */
  canBan: boolean;
  /** kind:9042 / 9043 — time-box the author's writes, or lift it. */
  canTimeout: boolean;
}

/** Nothing is permitted — the default for every unauthenticated or plain member. */
export const NO_MODERATION_CAPABILITY: ModerationCapability = {
  canRemoveMessage: false,
  canKick: false,
  canBan: false,
  canTimeout: false,
};

function normalize(pubkey: string | null | undefined): string | null {
  if (!pubkey) {
    return null;
  }
  const trimmed = pubkey.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function asCommunityRole(value: string | undefined): CommunityRole | null {
  return value === "owner" || value === "admin" || value === "member"
    ? value
    : null;
}

/**
 * Read one pubkey's community role out of a kind-13534 snapshot.
 *
 * Accepts both tag shapes NIP-43 permits: Buzz emits
 * `["member", <pubkey>, <role>]`, while a stock NIP-43 relay may emit
 * `["p", <pubkey>, <relay>, <role>]` — note the role sits one slot further
 * along on a `p` tag. Returns `null` when the snapshot is absent or does not
 * list the pubkey, which is the fail-closed answer: an open relay publishes no
 * snapshot at all, and "not listed" must never read as authority.
 */
export function communityRoleFromMembershipEvent(
  event: RoleEvent | null | undefined,
  viewerPubkey: string | null | undefined,
): CommunityRole | null {
  const viewer = normalize(viewerPubkey);
  if (!event || !viewer) {
    return null;
  }
  for (const tag of event.tags) {
    const [name, rawPubkey] = tag;
    if (name !== "member" && name !== "p") {
      continue;
    }
    if (normalize(rawPubkey) !== viewer) {
      continue;
    }
    const rawRole = name === "member" ? tag[2] : tag[3];
    // A listed pubkey with an unrecognized or absent role is a plain member:
    // it is present in the community, but nothing about it grants authority.
    return asCommunityRole(rawRole) ?? "member";
  }
  return null;
}

/**
 * Read one pubkey's channel role out of a kind-39001 admin snapshot for
 * `channelId`.
 *
 * The relay publishes 39001 with only owner/admin rows, so an absent entry
 * means "not a channel moderator" and yields `null`. The `d` tag is checked
 * against `channelId` because a single subscription can deliver snapshots for
 * several channels; a mismatched snapshot must never answer for this one.
 */
export function channelRoleFromAdminsEvent(
  event: RoleEvent | null | undefined,
  viewerPubkey: string | null | undefined,
  channelId: string | null | undefined,
): ChannelRole | null {
  const viewer = normalize(viewerPubkey);
  if (!event || !viewer || !channelId) {
    return null;
  }
  const dTag = event.tags.find((tag) => tag[0] === "d")?.[1];
  if (dTag !== channelId) {
    return null;
  }
  for (const tag of event.tags) {
    if (tag[0] !== "p" || normalize(tag[1]) !== viewer) {
      continue;
    }
    return tag[2] === "owner" || tag[2] === "admin" ? tag[2] : null;
  }
  return null;
}

export interface CapabilityInput {
  /** The viewer's community role, or null when they hold none. */
  actorCommunityRole: CommunityRole | null;
  /** The viewer's role in the channel the message lives in, or null. */
  actorChannelRole: ChannelRole | null;
  /**
   * The *target author's* community role, for the admin guard rail below.
   * Null when the author holds no community role, which is bannable.
   */
  targetCommunityRole: CommunityRole | null;
  /** The viewer is the message author — no moderation controls at all. */
  targetIsSelf: boolean;
}

/**
 * Decide which controls to render.
 *
 * Guard rail, mirroring `decide_authority`: an `admin` may not ban or time out
 * a community `owner` or a fellow `admin` — only the owner may action an
 * admin. The relay bails with "an admin cannot ban or time out a community
 * owner or fellow admin", so rendering the item would guarantee a failure.
 * Reversals (unban/untimeout) are deliberately unguarded at that seam, but the
 * per-message cluster only ever *applies* a restriction against a live author,
 * so the single `canBan`/`canTimeout` pair is the right granularity here.
 */
export function moderationCapability(
  input: CapabilityInput,
): ModerationCapability {
  if (input.targetIsSelf) {
    return NO_MODERATION_CAPABILITY;
  }

  const isCommunityOwner = input.actorCommunityRole === "owner";
  const isCommunityAdmin = input.actorCommunityRole === "admin";
  const isChannelModerator =
    input.actorChannelRole === "owner" || input.actorChannelRole === "admin";

  const targetIsPrivileged =
    input.targetCommunityRole === "owner" ||
    input.targetCommunityRole === "admin";
  const communityRestrictionAllowed =
    isCommunityOwner || (isCommunityAdmin && !targetIsPrivileged);

  return {
    canRemoveMessage: isChannelModerator,
    canKick: isChannelModerator,
    canBan: communityRestrictionAllowed,
    canTimeout: communityRestrictionAllowed,
  };
}

/** True when at least one moderation control should render. */
export function hasAnyModerationCapability(
  capability: ModerationCapability,
): boolean {
  return (
    capability.canRemoveMessage ||
    capability.canKick ||
    capability.canBan ||
    capability.canTimeout
  );
}

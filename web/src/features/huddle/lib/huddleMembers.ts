/**
 * Channel roster WITH roles, from the relay's own kind-39002 snapshot.
 *
 * The desktop reads this over an authenticated REST call
 * (`fetch_channel_members_with_roles`,
 * desktop/src-tauri/src/huddle/relay_api.rs) and hands the result to the
 * huddle code as `Vec<(pubkey, Option<role>)>`. The browser does not need
 * that endpoint: the relay SIGNS the same roster as a parameterized-
 * replaceable event and the role is right there on the tag.
 *
 *   ["d", channel_id]
 *   ["p", pubkey_hex, relay_url, role]
 *
 * `group_members_tags`, crates/buzz-relay/src/handlers/side_effects.rs:1040-1049.
 * The relay_url is empty by construction — "the canonical relay is implicit
 * (this event is signed by it)" — so the ROLE IS INDEX 3. Reading index 2
 * yields "" for every member and silently classifies nobody as a bot, which
 * is the failure this module exists to make impossible to write twice.
 *
 * Import-free, so `node --test` loads it.
 */

/** `KIND_NIP29_GROUP_MEMBERS` — crates/buzz-core/src/kind.rs:443. */
export const GROUP_MEMBERS_KIND = 39002;

/** The relay's default role, sent as no tag at all rather than "member". */
export const DEFAULT_MEMBER_ROLE = "member";

export interface MemberSnapshotEventLike {
  kind: number;
  tags: string[][];
}

/**
 * Decode one snapshot into pubkey → role.
 *
 * Returns null when the event is not this channel's snapshot (wrong kind, or
 * a `d` tag for somewhere else), so a caller cannot mistake "not ours" for
 * "empty roster" — the difference between staying quiet and adopting another
 * room's membership.
 *
 * A `p` tag with no role position falls back to {@link DEFAULT_MEMBER_ROLE},
 * matching the relay's own "None means member" convention.
 */
export function membersFromMemberEvent(
  event: MemberSnapshotEventLike,
  channelId: string,
): Map<string, string> | null {
  if (event.kind !== GROUP_MEMBERS_KIND) {
    return null;
  }
  if (event.tags.find((tag) => tag[0] === "d")?.[1] !== channelId) {
    return null;
  }
  const members = new Map<string, string>();
  for (const tag of event.tags) {
    if (tag[0] !== "p" || typeof tag[1] !== "string" || tag[1].length === 0) {
      continue;
    }
    const role =
      typeof tag[3] === "string" && tag[3].length > 0
        ? tag[3]
        : DEFAULT_MEMBER_ROLE;
    members.set(tag[1].toLowerCase(), role);
  }
  return members;
}

/** The `bot`-role members of a decoded roster — a huddle's agents. */
export function botPubkeys(members: ReadonlyMap<string, string>): Set<string> {
  const bots = new Set<string>();
  for (const [pubkey, role] of members) {
    if (role === "bot") {
      bots.add(pubkey);
    }
  }
  return bots;
}

/** The REQ filter for one channel's relay-signed member snapshot. */
export function huddleMemberSnapshotFilter(channelId: string): {
  kinds: number[];
  "#d": string[];
  limit: number;
} {
  return { kinds: [GROUP_MEMBERS_KIND], "#d": [channelId], limit: 10 };
}

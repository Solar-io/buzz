/**
 * The community roster — kind:13534, the relay's NIP-43 membership snapshot.
 *
 * # Where the data comes from
 *
 * The relay signs one replaceable kind-13534 per community, rebuilt on every
 * membership change, carrying `["member", <pubkey>, <role>]` for each row of
 * `relay_members` **ordered by `created_at ASC`**
 * (`buzz-db/src/lib.rs::publish_nip43_membership_locked`). So the tag order is
 * join order, and there is no per-member timestamp anywhere in the event —
 * which is why nothing here claims a "joined" date per person. The snapshot's
 * own `created_at` is the only timestamp, and it means "roster as of", not
 * "this person joined then". (The desktop card labels each row `Joined
 * <snapshot date>`; every row therefore shows the same date, which is the
 * date of the last membership change. That is misleading, so it is not
 * reproduced.)
 *
 * # Why the capability rules live here
 *
 * Every rule below mirrors `crates/buzz-relay/src/handlers/relay_admin.rs`
 * verbatim, because a control the relay will refuse is worse than a missing
 * one: the user clicks, waits, and gets an error for something the client
 * already knew was impossible. The mirror is per-kind, and it is not
 * symmetric — read the table in {@link communityMemberCapability}.
 *
 * Pure and import-free so `node --test` can load it directly.
 */

/** `KIND_NIP43_MEMBERSHIP_LIST` in crates/buzz-core/src/kind.rs. */
export const KIND_RELAY_MEMBERSHIP_LIST = 13534;

/** `RELAY_ADMIN_ADD_MEMBER` — admin or owner. */
export const KIND_ADD_MEMBER = 9030;
/** `RELAY_ADMIN_REMOVE_MEMBER` — admin or owner, with a role guard. */
export const KIND_REMOVE_MEMBER = 9031;
/** `RELAY_ADMIN_CHANGE_ROLE` — owner only. */
export const KIND_CHANGE_ROLE = 9032;

export type CommunityRole = "owner" | "admin" | "member";

export interface CommunityMember {
  /** Lowercase hex. */
  pubkey: string;
  role: CommunityRole;
  /**
   * Position in the roster, 0-based. The relay orders member tags by join
   * time, so this is a join *order* — the only ordering information the wire
   * format carries.
   */
  joinIndex: number;
}

export interface RosterEvent {
  tags: string[][];
  created_at: number;
}

export interface CommunityRoster {
  members: CommunityMember[];
  /** `created_at` of the snapshot, or null when none has arrived. */
  asOf: number | null;
  /** False until a snapshot arrives — an open relay never publishes one. */
  loaded: boolean;
}

export const EMPTY_ROSTER: CommunityRoster = {
  members: [],
  asOf: null,
  loaded: false,
};

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

function normalize(pubkey: string | undefined | null): string | null {
  if (typeof pubkey !== "string") {
    return null;
  }
  const trimmed = pubkey.trim().toLowerCase();
  return HEX_PUBKEY.test(trimmed) ? trimmed : null;
}

function asRole(value: string | undefined): CommunityRole | null {
  return value === "owner" || value === "admin" || value === "member"
    ? value
    : null;
}

/**
 * Read a roster out of a kind-13534 snapshot.
 *
 * Both NIP-43 tag shapes are accepted: Buzz emits
 * `["member", <pubkey>, <role>]`, while a stock NIP-43 relay may emit
 * `["p", <pubkey>, <relay>, <role>]` — note the role sits one slot further
 * along on a `p` tag. A listed pubkey with an unrecognized role is a plain
 * `member`: it is present, but nothing about it grants authority.
 * Non-pubkey tags (`["-"]`, the NIP-70 marker) and duplicates are dropped.
 */
export function rosterFromEvent(
  event: RosterEvent | null | undefined,
): CommunityRoster {
  if (!event) {
    return EMPTY_ROSTER;
  }
  const seen = new Set<string>();
  const members: CommunityMember[] = [];
  for (const tag of event.tags) {
    const [name, rawPubkey] = tag;
    if (name !== "member" && name !== "p") {
      continue;
    }
    const pubkey = normalize(rawPubkey);
    if (pubkey === null || seen.has(pubkey)) {
      continue;
    }
    seen.add(pubkey);
    members.push({
      pubkey,
      role: asRole(name === "member" ? tag[2] : tag[3]) ?? "member",
      joinIndex: members.length,
    });
  }
  return { members, asOf: event.created_at, loaded: true };
}

/**
 * One pubkey's role, or null when the roster does not list them.
 *
 * `null` is the fail-closed answer and is *not* the same as `"member"`: an
 * open relay publishes no snapshot at all, so "not listed" must never read as
 * authority — nor as membership.
 */
export function roleOf(
  roster: CommunityRoster,
  pubkey: string | null | undefined,
): CommunityRole | null {
  const needle = normalize(pubkey);
  if (needle === null) {
    return null;
  }
  return (
    roster.members.find((member) => member.pubkey === needle)?.role ?? null
  );
}

const ROLE_RANK: Record<CommunityRole, number> = {
  owner: 0,
  admin: 1,
  member: 2,
};

/** Owners first, then admins, then members; join order within a rank. */
export function sortMembers(members: readonly CommunityMember[]) {
  return [...members].sort(
    (left, right) =>
      ROLE_RANK[left.role] - ROLE_RANK[right.role] ||
      left.joinIndex - right.joinIndex,
  );
}

/**
 * Filter the roster by a free-text needle.
 *
 * Matches a resolved display name when the caller supplies one, and always
 * matches a pubkey prefix, because pasting the front of a key someone gave
 * you is how you find a person with no profile.
 */
export function filterMembers(
  members: readonly CommunityMember[],
  query: string,
  labelFor: (pubkey: string) => string | null | undefined = () => null,
): CommunityMember[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...members];
  }
  return members.filter((member) => {
    if (member.pubkey.startsWith(needle)) {
      return true;
    }
    if (member.role.startsWith(needle)) {
      return true;
    }
    const label = labelFor(member.pubkey);
    return typeof label === "string" && label.toLowerCase().includes(needle);
  });
}

/**
 * What the viewer may do to one roster row.
 *
 * Mirrors `relay_admin.rs::execute_relay_admin_command`, arm by arm:
 *
 * | Action | Kind | Relay rule |
 * |--------|------|------------|
 * | Add    | 9030 | sender admin\|owner; `role=admin` needs owner; `role=owner` refused outright |
 * | Remove | 9031 | sender admin\|owner; never self; **admin may remove only `member`**; an owner row is never removable |
 * | Role   | 9032 | **owner only**; never self; never *to* owner; the owner row's role cannot change |
 *
 * The asymmetry is the point: an admin may add and remove plain members but
 * may not touch another admin, and only the owner can promote. Collapsing
 * this into one "canManage" boolean shows an admin a Make-Admin item the
 * relay answers `actor not authorized: only owner can grant admin role`.
 */
export interface MemberCapability {
  canRemove: boolean;
  canPromoteToAdmin: boolean;
  canDemoteToMember: boolean;
}

export const NO_MEMBER_CAPABILITY: MemberCapability = {
  canRemove: false,
  canPromoteToAdmin: false,
  canDemoteToMember: false,
};

export function communityMemberCapability(input: {
  viewerRole: CommunityRole | null;
  targetRole: CommunityRole;
  targetIsSelf: boolean;
}): MemberCapability {
  const { viewerRole, targetRole, targetIsSelf } = input;
  if (targetIsSelf || viewerRole === null || viewerRole === "member") {
    return NO_MEMBER_CAPABILITY;
  }
  // The relay refuses to remove an owner row on either path
  // (`RemoveResult::IsOwner`) and refuses to change its role.
  if (targetRole === "owner") {
    return NO_MEMBER_CAPABILITY;
  }
  const isOwner = viewerRole === "owner";
  return {
    canRemove: isOwner || targetRole === "member",
    canPromoteToAdmin: isOwner && targetRole === "member",
    canDemoteToMember: isOwner && targetRole === "admin",
  };
}

/** True when the viewer may open the add-member flow at all (9030 / invites). */
export function canAddMembers(viewerRole: CommunityRole | null): boolean {
  return viewerRole === "owner" || viewerRole === "admin";
}

/**
 * Roles the viewer may assign on a 9030 add.
 *
 * `owner` is never offered: the relay answers `invalid role: use kind:9032 to
 * promote to owner`, and 9032 in turn refuses `owner` — ownership transfer is
 * deliberately a config-level operation only.
 */
export function assignableRoles(
  viewerRole: CommunityRole | null,
): CommunityRole[] {
  if (viewerRole === "owner") {
    return ["member", "admin"];
  }
  if (viewerRole === "admin") {
    return ["member"];
  }
  return [];
}

/**
 * Whether a 9030 add would be a silent no-op.
 *
 * The relay's add is idempotent and **does not overwrite an existing role**
 * ("if target already exists at any role, this is a silent no-op"). So adding
 * someone already listed appears to succeed and changes nothing; the caller
 * must refuse it up front and point at the role menu instead.
 */
export function isAlreadyMember(
  roster: CommunityRoster,
  pubkey: string | null | undefined,
): boolean {
  return roleOf(roster, pubkey) !== null;
}

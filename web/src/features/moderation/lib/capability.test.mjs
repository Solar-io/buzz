import assert from "node:assert/strict";
import { test } from "node:test";
import {
  channelRoleFromAdminsEvent,
  communityRoleFromMembershipEvent,
  hasAnyModerationCapability,
  KIND_CHANNEL_ADMINS,
  KIND_RELAY_MEMBERSHIP_LIST,
  moderationCapability,
  NO_MODERATION_CAPABILITY,
} from "./capability.ts";

const VIEWER = "11".repeat(32);
const AUTHOR = "22".repeat(32);
const CHANNEL = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function membership(entries) {
  return {
    tags: [["-"], ...entries.map(([pk, role]) => ["member", pk, role])],
  };
}

function admins(channelId, entries) {
  return {
    tags: [["d", channelId], ...entries.map(([pk, role]) => ["p", pk, role])],
  };
}

/** The full input, with a plain-member author, so each test varies one axis. */
function gate(overrides) {
  return moderationCapability({
    actorCommunityRole: null,
    actorChannelRole: null,
    targetCommunityRole: null,
    targetIsSelf: false,
    ...overrides,
  });
}

test("kind constants match crates/buzz-core/src/kind.rs", () => {
  assert.equal(KIND_RELAY_MEMBERSHIP_LIST, 13534);
  assert.equal(KIND_CHANNEL_ADMINS, 39001);
});

// --- The gate itself. These must DISCRIMINATE: every assertion below pairs a
// permitted case with a refused one on the same axis, so a gate stuck open or
// stuck shut fails at least one of them.

test("a plain member sees nothing", () => {
  const capability = gate({
    actorCommunityRole: "member",
    actorChannelRole: null,
  });
  assert.deepEqual(capability, NO_MODERATION_CAPABILITY);
  assert.equal(hasAnyModerationCapability(capability), false);
});

test("a stranger with no role at all sees nothing", () => {
  assert.equal(hasAnyModerationCapability(gate({})), false);
});

test("community role grants ban/timeout but NOT remove/kick", () => {
  for (const role of ["owner", "admin"]) {
    const capability = gate({ actorCommunityRole: role });
    assert.equal(capability.canBan, true, `${role} may ban`);
    assert.equal(capability.canTimeout, true, `${role} may time out`);
    // decide_authority's channel_role_covers_only_delete_and_kick has the
    // mirror of this: the two authorities do not cross. 9005/9001 are checked
    // by validate_admin_event against CHANNEL roles only, which never reads
    // relay_members — so a community admin who is not a channel admin must
    // not be offered Remove or Kick.
    assert.equal(
      capability.canRemoveMessage,
      false,
      `${role} is not a channel mod`,
    );
    assert.equal(capability.canKick, false, `${role} is not a channel mod`);
  }
});

test("channel role grants remove/kick but NOT ban/timeout", () => {
  for (const role of ["owner", "admin"]) {
    const capability = gate({ actorChannelRole: role });
    assert.equal(
      capability.canRemoveMessage,
      true,
      `channel ${role} may remove`,
    );
    assert.equal(capability.canKick, true, `channel ${role} may kick`);
    assert.equal(capability.canBan, false, `channel ${role} may not ban`);
    assert.equal(
      capability.canTimeout,
      false,
      `channel ${role} may not time out`,
    );
  }
});

test("holding both roles grants all four", () => {
  const capability = gate({
    actorCommunityRole: "owner",
    actorChannelRole: "owner",
  });
  assert.deepEqual(capability, {
    canRemoveMessage: true,
    canKick: true,
    canBan: true,
    canTimeout: true,
  });
});

test("an admin may not ban or time out an owner or a fellow admin", () => {
  for (const targetRole of ["owner", "admin"]) {
    const capability = gate({
      actorCommunityRole: "admin",
      actorChannelRole: "admin",
      targetCommunityRole: targetRole,
    });
    assert.equal(capability.canBan, false, `admin vs ${targetRole}`);
    assert.equal(capability.canTimeout, false, `admin vs ${targetRole}`);
    // The guard rail is scoped to the community restrictions; the channel
    // authority is untouched by it (admin_guard_rail_is_scoped_to_ban_and_timeout).
    assert.equal(capability.canRemoveMessage, true);
    assert.equal(capability.canKick, true);
  }
  // …but a plain member or a non-member target IS actionable by an admin.
  for (const targetRole of ["member", null]) {
    const capability = gate({
      actorCommunityRole: "admin",
      targetCommunityRole: targetRole,
    });
    assert.equal(capability.canBan, true, `admin vs ${targetRole}`);
    assert.equal(capability.canTimeout, true, `admin vs ${targetRole}`);
  }
});

test("the owner has no guard rail — they may action an admin", () => {
  const capability = gate({
    actorCommunityRole: "owner",
    targetCommunityRole: "admin",
  });
  assert.equal(capability.canBan, true);
  assert.equal(capability.canTimeout, true);
});

test("no moderator may act on their own message", () => {
  const capability = moderationCapability({
    actorCommunityRole: "owner",
    actorChannelRole: "owner",
    targetCommunityRole: "owner",
    targetIsSelf: true,
  });
  assert.deepEqual(capability, NO_MODERATION_CAPABILITY);
});

// --- Role parsing off the real relay-signed snapshots.

test("community role reads Buzz's member tags", () => {
  const event = membership([
    [AUTHOR, "member"],
    [VIEWER, "admin"],
  ]);
  assert.equal(communityRoleFromMembershipEvent(event, VIEWER), "admin");
  assert.equal(communityRoleFromMembershipEvent(event, AUTHOR), "member");
});

test("community role tolerates the NIP-43 p-tag shape, role at index 3", () => {
  // ["p", pubkey, relay, role] — the role sits one slot later than on a
  // member tag. Reading index 2 here would return the relay URL.
  const event = { tags: [["p", VIEWER, "wss://relay.example", "owner"]] };
  assert.equal(communityRoleFromMembershipEvent(event, VIEWER), "owner");
});

test("an unlisted pubkey, an absent snapshot, and an unknown viewer are all null", () => {
  const event = membership([[AUTHOR, "owner"]]);
  assert.equal(communityRoleFromMembershipEvent(event, VIEWER), null);
  assert.equal(communityRoleFromMembershipEvent(null, VIEWER), null);
  assert.equal(communityRoleFromMembershipEvent(event, null), null);
});

test("a listed pubkey with a junk role is a plain member, not a moderator", () => {
  const event = { tags: [["member", VIEWER, "superuser"]] };
  assert.equal(communityRoleFromMembershipEvent(event, VIEWER), "member");
  assert.equal(
    hasAnyModerationCapability(
      gate({
        actorCommunityRole: communityRoleFromMembershipEvent(event, VIEWER),
      }),
    ),
    false,
  );
});

test("community role matching is case-insensitive on the key", () => {
  const event = membership([[VIEWER, "admin"]]);
  assert.equal(
    communityRoleFromMembershipEvent(event, VIEWER.toUpperCase()),
    "admin",
  );
});

test("channel role reads the 39001 admin snapshot for the matching d tag", () => {
  const event = admins(CHANNEL, [[VIEWER, "admin"]]);
  assert.equal(channelRoleFromAdminsEvent(event, VIEWER, CHANNEL), "admin");
  assert.equal(channelRoleFromAdminsEvent(event, AUTHOR, CHANNEL), null);
});

test("a 39001 snapshot for ANOTHER channel grants nothing here", () => {
  const other = "00000000-0000-4000-8000-000000000000";
  const event = admins(other, [[VIEWER, "owner"]]);
  // Discriminating: dropping the `d` check would return "owner" here and let
  // one channel's moderator moderate every channel.
  assert.equal(channelRoleFromAdminsEvent(event, VIEWER, CHANNEL), null);
  assert.equal(channelRoleFromAdminsEvent(event, VIEWER, other), "owner");
});

test("a non-elevated channel entry is not a channel role", () => {
  const event = admins(CHANNEL, [[VIEWER, "member"]]);
  assert.equal(channelRoleFromAdminsEvent(event, VIEWER, CHANNEL), null);
});

test("end to end: snapshots in, rendered capability out", () => {
  // The viewer is a community admin and a channel admin; the author is a
  // plain member. Everything unlocks.
  const capability = moderationCapability({
    actorCommunityRole: communityRoleFromMembershipEvent(
      membership([
        [VIEWER, "admin"],
        [AUTHOR, "member"],
      ]),
      VIEWER,
    ),
    actorChannelRole: channelRoleFromAdminsEvent(
      admins(CHANNEL, [[VIEWER, "admin"]]),
      VIEWER,
      CHANNEL,
    ),
    targetCommunityRole: communityRoleFromMembershipEvent(
      membership([
        [VIEWER, "admin"],
        [AUTHOR, "member"],
      ]),
      AUTHOR,
    ),
    targetIsSelf: false,
  });
  assert.deepEqual(capability, {
    canRemoveMessage: true,
    canKick: true,
    canBan: true,
    canTimeout: true,
  });

  // Same snapshots, but the viewer is the author: nothing.
  const openRelay = moderationCapability({
    actorCommunityRole: communityRoleFromMembershipEvent(null, VIEWER),
    actorChannelRole: channelRoleFromAdminsEvent(null, VIEWER, CHANNEL),
    targetCommunityRole: null,
    targetIsSelf: false,
  });
  // An open relay publishes no snapshot at all — nobody is a moderator.
  assert.equal(hasAnyModerationCapability(openRelay), false);
});

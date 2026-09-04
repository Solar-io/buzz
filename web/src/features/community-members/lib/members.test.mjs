import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_ROSTER,
  KIND_ADD_MEMBER,
  KIND_CHANGE_ROLE,
  KIND_REMOVE_MEMBER,
  assignableRoles,
  canAddMembers,
  communityMemberCapability,
  filterMembers,
  isAlreadyMember,
  roleOf,
  rosterFromEvent,
  sortMembers,
} from "./members.ts";
import {
  buildAddMemberEvent,
  buildChangeRoleEvent,
  buildRemoveMemberEvent,
} from "./memberCommands.ts";

const OWNER = "1".repeat(64);
const ADMIN = "2".repeat(64);
const MEMBER = "3".repeat(64);
const STRANGER = "4".repeat(64);

function snapshot(tags, createdAt = 1_700_000_000) {
  return { tags, created_at: createdAt };
}

const ROSTER = rosterFromEvent(
  snapshot([
    ["-"],
    ["member", OWNER, "owner"],
    ["member", ADMIN, "admin"],
    ["member", MEMBER, "member"],
  ]),
);

test("rosterFromEvent reads the Buzz member-tag shape", () => {
  assert.equal(ROSTER.loaded, true);
  assert.equal(ROSTER.asOf, 1_700_000_000);
  assert.deepEqual(
    ROSTER.members.map((member) => [member.pubkey, member.role]),
    [
      [OWNER, "owner"],
      [ADMIN, "admin"],
      [MEMBER, "member"],
    ],
  );
  // Join order is the only ordering the wire format carries.
  assert.deepEqual(
    ROSTER.members.map((member) => member.joinIndex),
    [0, 1, 2],
  );
});

test("rosterFromEvent reads the stock NIP-43 p-tag shape, role one slot later", () => {
  const roster = rosterFromEvent(
    snapshot([["p", ADMIN, "wss://relay.example", "admin"]]),
  );
  assert.equal(roleOf(roster, ADMIN), "admin");
  // The relay hint slot must not be read as the role.
  const misread = rosterFromEvent(snapshot([["p", ADMIN, "admin"]]));
  assert.equal(
    roleOf(misread, ADMIN),
    "member",
    "a role in the relay slot is not a role",
  );
});

test("rosterFromEvent drops junk, keeps the first of a duplicate", () => {
  const roster = rosterFromEvent(
    snapshot([
      ["-"],
      ["member", "not-hex", "owner"],
      ["member", OWNER.toUpperCase(), "owner"],
      ["member", OWNER, "member"],
      ["e", MEMBER, "member"],
    ]),
  );
  assert.equal(roster.members.length, 1);
  assert.equal(roleOf(roster, OWNER), "owner");
});

test("an unrecognized role degrades to member, never to authority", () => {
  const roster = rosterFromEvent(snapshot([["member", MEMBER, "superuser"]]));
  assert.equal(roleOf(roster, MEMBER), "member");
});

test("roleOf fails closed for an absent snapshot and an unlisted key", () => {
  assert.equal(roleOf(EMPTY_ROSTER, OWNER), null);
  assert.equal(roleOf(ROSTER, STRANGER), null);
  assert.equal(roleOf(ROSTER, null), null);
  assert.equal(rosterFromEvent(null).loaded, false);
});

test("sortMembers puts owner, then admin, then member", () => {
  const shuffled = [ROSTER.members[2], ROSTER.members[0], ROSTER.members[1]];
  assert.deepEqual(
    sortMembers(shuffled).map((member) => member.role),
    ["owner", "admin", "member"],
  );
});

test("filterMembers matches a pubkey prefix, a role, and a resolved name", () => {
  const labels = new Map([[ADMIN, "Ada Lovelace"]]);
  const byName = filterMembers(ROSTER.members, "lovelace", (pubkey) =>
    labels.get(pubkey),
  );
  assert.deepEqual(
    byName.map((member) => member.pubkey),
    [ADMIN],
  );

  const byPrefix = filterMembers(ROSTER.members, "3333", () => null);
  assert.deepEqual(
    byPrefix.map((member) => member.pubkey),
    [MEMBER],
  );

  const byRole = filterMembers(ROSTER.members, "admin", () => null);
  assert.deepEqual(
    byRole.map((member) => member.pubkey),
    [ADMIN],
  );

  assert.equal(filterMembers(ROSTER.members, "   ", () => null).length, 3);
  assert.equal(filterMembers(ROSTER.members, "zzz", () => null).length, 0);
});

test("an owner may promote and demote; an admin may not", () => {
  // Discriminating on the viewer: same target, opposite answers.
  const ownerOnMember = communityMemberCapability({
    viewerRole: "owner",
    targetRole: "member",
    targetIsSelf: false,
  });
  assert.deepEqual(ownerOnMember, {
    canRemove: true,
    canPromoteToAdmin: true,
    canDemoteToMember: false,
  });

  const adminOnMember = communityMemberCapability({
    viewerRole: "admin",
    targetRole: "member",
    targetIsSelf: false,
  });
  assert.deepEqual(adminOnMember, {
    canRemove: true,
    canPromoteToAdmin: false,
    canDemoteToMember: false,
  });
});

test("an admin may not remove a fellow admin, but an owner may", () => {
  assert.equal(
    communityMemberCapability({
      viewerRole: "admin",
      targetRole: "admin",
      targetIsSelf: false,
    }).canRemove,
    false,
  );
  assert.equal(
    communityMemberCapability({
      viewerRole: "owner",
      targetRole: "admin",
      targetIsSelf: false,
    }).canRemove,
    true,
  );
  assert.equal(
    communityMemberCapability({
      viewerRole: "owner",
      targetRole: "admin",
      targetIsSelf: false,
    }).canDemoteToMember,
    true,
  );
});

test("the owner row is untouchable, even by an owner", () => {
  assert.deepEqual(
    communityMemberCapability({
      viewerRole: "owner",
      targetRole: "owner",
      targetIsSelf: false,
    }),
    { canRemove: false, canPromoteToAdmin: false, canDemoteToMember: false },
  );
});

test("nobody may action their own row, and plain members may action nothing", () => {
  assert.deepEqual(
    communityMemberCapability({
      viewerRole: "owner",
      targetRole: "admin",
      targetIsSelf: true,
    }),
    { canRemove: false, canPromoteToAdmin: false, canDemoteToMember: false },
  );
  assert.deepEqual(
    communityMemberCapability({
      viewerRole: "member",
      targetRole: "member",
      targetIsSelf: false,
    }),
    { canRemove: false, canPromoteToAdmin: false, canDemoteToMember: false },
  );
  assert.deepEqual(
    communityMemberCapability({
      viewerRole: null,
      targetRole: "member",
      targetIsSelf: false,
    }),
    { canRemove: false, canPromoteToAdmin: false, canDemoteToMember: false },
  );
});

test("only an owner may offer the admin role on an add", () => {
  assert.deepEqual(assignableRoles("owner"), ["member", "admin"]);
  assert.deepEqual(assignableRoles("admin"), ["member"]);
  assert.deepEqual(assignableRoles("member"), []);
  assert.deepEqual(assignableRoles(null), []);
  assert.equal(canAddMembers("admin"), true);
  assert.equal(canAddMembers("member"), false);
  assert.equal(canAddMembers(null), false);
});

test("isAlreadyMember guards the relay's silent no-op add", () => {
  assert.equal(isAlreadyMember(ROSTER, ADMIN), true);
  assert.equal(isAlreadyMember(ROSTER, ADMIN.toUpperCase()), true);
  assert.equal(isAlreadyMember(ROSTER, STRANGER), false);
});

test("command templates carry the kinds and tags the relay parses", () => {
  assert.deepEqual(buildAddMemberEvent({ pubkey: MEMBER, role: "admin" }), {
    kind: 9030,
    content: "",
    tags: [
      ["p", MEMBER],
      ["role", "admin"],
    ],
  });
  assert.deepEqual(buildRemoveMemberEvent(MEMBER.toUpperCase()), {
    kind: 9031,
    content: "",
    tags: [["p", MEMBER]],
  });
  assert.deepEqual(buildChangeRoleEvent({ pubkey: MEMBER, role: "member" }), {
    kind: 9032,
    content: "",
    tags: [
      ["p", MEMBER],
      ["role", "member"],
    ],
  });
  // The kind constants are the relay's, not ours to drift.
  assert.equal(KIND_ADD_MEMBER, 9030);
  assert.equal(KIND_REMOVE_MEMBER, 9031);
  assert.equal(KIND_CHANGE_ROLE, 9032);
});

test("a malformed pubkey is refused before it reaches the relay", () => {
  assert.throws(() => buildRemoveMemberEvent("nope"), /64 hex characters/);
  assert.throws(
    () => buildAddMemberEvent({ pubkey: `${MEMBER}ff`, role: "member" }),
    /64 hex characters/,
  );
});

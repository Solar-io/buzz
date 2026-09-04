import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botPubkeys,
  DEFAULT_MEMBER_ROLE,
  GROUP_MEMBERS_KIND,
  huddleMemberSnapshotFilter,
  membersFromMemberEvent,
} from "./huddleMembers.ts";

const AGENT = "a".repeat(64);
const ADMIN = "b".repeat(64);
const HUMAN = "c".repeat(64);
const CHANNEL = "eph-1";

function snapshot(tags) {
  return { kind: 39002, tags };
}

test("the member-snapshot kind is 39002 and the default role is member", () => {
  assert.equal(GROUP_MEMBERS_KIND, 39002);
  assert.equal(DEFAULT_MEMBER_ROLE, "member");
});

test("roles are read from tag index 3, past the empty relay url", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", HUMAN, "", "member"],
      ["p", AGENT, "", "bot"],
      ["p", ADMIN, "", "admin"],
    ]),
    CHANNEL,
  );
  assert.equal(members.get(HUMAN), "member");
  assert.equal(members.get(AGENT), "bot");
  assert.equal(members.get(ADMIN), "admin");
});

test("a p tag with no role position defaults to member, not bot", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", AGENT],
    ]),
    CHANNEL,
  );
  assert.equal(members.get(AGENT), "member");
  assert.equal(botPubkeys(members).size, 0);
});

test("a role at index 2 is not mistaken for the role", () => {
  // The relay always emits the empty relay_url, so index 2 is never a role.
  // A parser reading index 2 would classify this as a bot; it must not.
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", AGENT, "bot"],
    ]),
    CHANNEL,
  );
  assert.equal(members.get(AGENT), "member");
});

test("an empty role string falls back to member", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", AGENT, "", ""],
    ]),
    CHANNEL,
  );
  assert.equal(members.get(AGENT), "member");
});

test("pubkeys are normalised to lowercase", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", AGENT.toUpperCase(), "", "bot"],
    ]),
    CHANNEL,
  );
  assert.ok(members.has(AGENT));
  assert.ok(botPubkeys(members).has(AGENT));
});

test("only bot-role members come back as bots", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", HUMAN, "", "member"],
      ["p", AGENT, "", "bot"],
      ["p", ADMIN, "", "admin"],
    ]),
    CHANNEL,
  );
  assert.deepEqual([...botPubkeys(members)], [AGENT]);
});

test("a snapshot for another channel is rejected, not read as empty", () => {
  assert.equal(
    membersFromMemberEvent(
      snapshot([
        ["d", "eph-2"],
        ["p", AGENT, "", "bot"],
      ]),
      CHANNEL,
    ),
    null,
  );
});

test("a snapshot with no d tag is rejected", () => {
  assert.equal(
    membersFromMemberEvent(snapshot([["p", AGENT, "", "bot"]]), CHANNEL),
    null,
  );
});

test("a non-39002 event is not a member snapshot", () => {
  // 39001 is the group-ADMINS event: a real neighbour with the same tag
  // shape, so this case discriminates on kind and nothing else.
  assert.equal(
    membersFromMemberEvent(
      {
        kind: 39001,
        tags: [
          ["d", CHANNEL],
          ["p", AGENT, "", "bot"],
        ],
      },
      CHANNEL,
    ),
    null,
  );
});

test("non-p tags are ignored", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["name", "huddle-abcd"],
      ["p", AGENT, "", "bot"],
    ]),
    CHANNEL,
  );
  assert.equal(members.size, 1);
});

test("a p tag with an empty pubkey is skipped", () => {
  const members = membersFromMemberEvent(
    snapshot([
      ["d", CHANNEL],
      ["p", "", "", "bot"],
      ["p", AGENT, "", "bot"],
    ]),
    CHANNEL,
  );
  assert.equal(members.size, 1);
  assert.ok(members.has(AGENT));
});

test("the snapshot filter keys on #d, the addressable coordinate", () => {
  const filter = huddleMemberSnapshotFilter(CHANNEL);
  assert.deepEqual(filter, {
    kinds: [39002],
    "#d": [CHANNEL],
    limit: 10,
  });
});

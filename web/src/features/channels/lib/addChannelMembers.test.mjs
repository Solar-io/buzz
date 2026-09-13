import assert from "node:assert/strict";
import { test } from "node:test";
import {
  excludeCurrentMembers,
  memberAddRoleFor,
  publishChannelMemberAdds,
} from "./addChannelMembers.ts";

const SELF = "aa".repeat(32);
const AGENT = "bb".repeat(32);
const HUMAN = "cc".repeat(32);
const MEMBER = "dd".repeat(32);
const CHANNEL = "01890a5d-ac96-774b-bcce-b3022099b81d";

const agents = [
  { pubkey: AGENT, name: "Crash Override" },
  { pubkey: MEMBER, name: "Already In" },
];

test("excludeCurrentMembers drops roster pubkeys from both sources", () => {
  const { agents: keptAgents, contacts: keptContacts } = excludeCurrentMembers({
    agents,
    contacts: [HUMAN, MEMBER, SELF],
    memberPubkeys: [MEMBER],
  });
  assert.deepEqual(
    keptAgents.map((a) => a.pubkey),
    [AGENT],
  );
  assert.deepEqual(keptContacts, [HUMAN, SELF]);
});

test("excludeCurrentMembers matches roster keys case-insensitively", () => {
  // The roster as stored by kind-39002 p tags is lowercase hex; a source
  // carrying uppercase must still be recognised as already-present.
  const { contacts } = excludeCurrentMembers({
    agents: [],
    contacts: ["CC".repeat(16)],
    memberPubkeys: ["cc".repeat(16)],
  });
  assert.deepEqual(contacts, []);
});

test("publishChannelMemberAdds sends ONE event per member, in order", async () => {
  const sent = [];
  const outcome = await publishChannelMemberAdds({
    channelId: CHANNEL,
    members: [
      { pubkey: AGENT, role: "bot" },
      { pubkey: HUMAN, role: "member" },
    ],
    send: async (event) => {
      sent.push(event);
      return { ok: true, message: "" };
    },
  });
  assert.deepEqual(outcome, { added: [AGENT, HUMAN], failures: [] });
  assert.equal(sent.length, 2, "one publish per member, never a bulk event");
  // Desktop parity (events.rs:222): h + p + role only when not member.
  assert.deepEqual(sent[0], {
    kind: 9000,
    content: "",
    tags: [
      ["h", CHANNEL],
      ["p", AGENT],
      ["role", "bot"],
    ],
  });
  assert.deepEqual(sent[1], {
    kind: 9000,
    content: "",
    tags: [
      ["h", CHANNEL],
      ["p", HUMAN],
    ],
  });
});

test("publishChannelMemberAdds keeps going after a refusal and reports it verbatim", async () => {
  const REFUSAL = "only the channel owner can add members";
  const sent = [];
  const outcome = await publishChannelMemberAdds({
    channelId: CHANNEL,
    members: [
      { pubkey: AGENT, role: "bot" },
      { pubkey: HUMAN, role: "member" },
    ],
    send: async (event) => {
      sent.push(event);
      const target = event.tags.find((tag) => tag[0] === "p")?.[1];
      return target === AGENT
        ? { ok: false, message: REFUSAL }
        : { ok: true, message: "" };
    },
  });
  assert.equal(sent.length, 2, "a refused add does not stop the rest");
  assert.deepEqual(outcome.added, [HUMAN]);
  assert.deepEqual(outcome.failures, [{ pubkey: AGENT, message: REFUSAL }]);
});

test("publishChannelMemberAdds fails a malformed key before the wire", async () => {
  const sent = [];
  const outcome = await publishChannelMemberAdds({
    channelId: CHANNEL,
    members: [{ pubkey: "not-a-key", role: "member" }],
    send: async (event) => {
      sent.push(event);
      return { ok: true, message: "" };
    },
  });
  assert.equal(sent.length, 0);
  assert.deepEqual(outcome.added, []);
  assert.match(outcome.failures[0].message, /64 hex/);
});

test("memberAddRoleFor: registered agents ride as bot, humans ride role-less", () => {
  assert.equal(memberAddRoleFor(AGENT, agents), "bot");
  assert.equal(memberAddRoleFor(HUMAN, agents), "member");
  assert.equal(memberAddRoleFor(AGENT.toUpperCase(), agents), "bot");
});

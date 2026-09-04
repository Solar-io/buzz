import assert from "node:assert/strict";
import test from "node:test";

import {
  blockReasonLabel,
  enforcementKindFor,
  queueAuthority,
  statusForAction,
} from "./queueAuthority.ts";

/**
 * The two axes, tested where they DISAGREE.
 *
 * A fixture where both roles would allow the same thing proves nothing, so
 * every case below picks a pair the relay treats differently: a community
 * owner with no channel role (the case the desktop client gets wrong), a
 * channel owner with no community role, an admin against an admin.
 */

/** An event-target report in a channel, with a resolvable author. */
function input(overrides = {}) {
  return {
    actorCommunityRole: "owner",
    actorChannelRole: "owner",
    targetCommunityRole: null,
    targetKind: "event",
    hasChannel: true,
    targetAuthorKnown: true,
    targetIsSelf: false,
    ...overrides,
  };
}

test("an owner of both axes may take every resolution", () => {
  const { allowed, blocked } = queueAuthority(input());
  assert.deepEqual(allowed, [
    "delete",
    "kick",
    "ban",
    "timeout",
    "escalate",
    "dismiss",
  ]);
  assert.deepEqual(blocked, {});
});

/**
 * THE case. `validate_admin_event` never reads `relay_members`, so community
 * authority does not reach 9005 or 9001 — a community owner with no role in
 * the reported channel gets Ban and Timeout and neither channel-scoped action.
 * The desktop client offers both here and the relay refuses them.
 */
test("a community owner with no channel role loses delete and kick, keeps ban", () => {
  const { allowed, blocked } = queueAuthority(
    input({ actorCommunityRole: "owner", actorChannelRole: null }),
  );
  assert.deepEqual(allowed, ["ban", "timeout", "escalate", "dismiss"]);
  assert.equal(blocked.delete, "needs-channel-role");
  assert.equal(blocked.kick, "needs-channel-role");
});

/** The mirror image: channel authority alone reaches no resolution at all,
 *  because every resolution ends in a resolve command and that is community-only. */
test("a channel owner who holds no community role may take nothing", () => {
  const { allowed, blocked } = queueAuthority(
    input({ actorCommunityRole: null, actorChannelRole: "owner" }),
  );
  assert.deepEqual(allowed, []);
  assert.equal(blocked.delete, "not-a-moderator");
  assert.equal(blocked.dismiss, "not-a-moderator");
  assert.equal(blocked.ban, "not-a-moderator");
});

test("a plain community member may take nothing", () => {
  const { allowed } = queueAuthority(
    input({ actorCommunityRole: "member", actorChannelRole: "admin" }),
  );
  assert.deepEqual(allowed, []);
});

test("a channel admin is as good as a channel owner for delete and kick", () => {
  const { allowed } = queueAuthority(
    input({ actorCommunityRole: "admin", actorChannelRole: "admin" }),
  );
  assert.ok(allowed.includes("delete"));
  assert.ok(allowed.includes("kick"));
});

/**
 * The admin guard rail, from `decide_authority`: "an admin cannot ban or time
 * out a community owner or fellow admin". The discriminating half is the third
 * assertion — the SAME admin actor may ban an unlisted target, so the block is
 * about the target's role and not about the actor's.
 */
test("an admin may not ban or time out a fellow moderator, but may ban a member", () => {
  const againstOwner = queueAuthority(
    input({ actorCommunityRole: "admin", targetCommunityRole: "owner" }),
  );
  assert.equal(againstOwner.blocked.ban, "admin-cannot-action-admin");
  assert.equal(againstOwner.blocked.timeout, "admin-cannot-action-admin");

  const againstAdmin = queueAuthority(
    input({ actorCommunityRole: "admin", targetCommunityRole: "admin" }),
  );
  assert.equal(againstAdmin.blocked.ban, "admin-cannot-action-admin");

  const againstMember = queueAuthority(
    input({ actorCommunityRole: "admin", targetCommunityRole: "member" }),
  );
  assert.ok(againstMember.allowed.includes("ban"));
  assert.ok(againstMember.allowed.includes("timeout"));

  // A target with no membership row at all — the drive-by spammer who already
  // left — is bannable. The guard trips on a ROLE, not on its absence.
  const againstStranger = queueAuthority(
    input({ actorCommunityRole: "admin", targetCommunityRole: null }),
  );
  assert.ok(againstStranger.allowed.includes("ban"));
});

/** The owner is not bound by that rail. */
test("an owner may ban an admin", () => {
  const { allowed } = queueAuthority(
    input({ actorCommunityRole: "owner", targetCommunityRole: "admin" }),
  );
  assert.ok(allowed.includes("ban"));
  assert.ok(allowed.includes("timeout"));
});

test("a pubkey-target report offers ban and timeout but nothing channel-scoped", () => {
  const { allowed, blocked } = queueAuthority(
    input({ targetKind: "pubkey", hasChannel: false }),
  );
  assert.deepEqual(allowed, ["ban", "timeout", "escalate", "dismiss"]);
  assert.equal(blocked.delete, "needs-a-channel");
  assert.equal(blocked.kick, "needs-a-channel");
});

test("a blob-target report offers only the decision-only resolutions", () => {
  const { allowed, blocked } = queueAuthority(
    input({ targetKind: "blob", hasChannel: false, targetAuthorKnown: false }),
  );
  assert.deepEqual(allowed, ["escalate", "dismiss"]);
  assert.equal(blocked.ban, "needs-an-author");
});

/**
 * An event report whose event could not be read back: the enforcement that
 * needs an author is not offerable, but deleting the message — which needs
 * only its id and channel — still is.
 */
test("an unresolvable author blocks ban, timeout and kick but not delete", () => {
  const { allowed, blocked } = queueAuthority(
    input({ targetAuthorKnown: false }),
  );
  assert.ok(allowed.includes("delete"));
  assert.equal(blocked.ban, "needs-an-author");
  assert.equal(blocked.timeout, "needs-an-author");
  assert.equal(blocked.kick, "needs-an-author");
});

/**
 * Self-targeting: a ban against yourself is accepted for an owner and then
 * locks you out of every later command, so it is not offered. Removing your
 * own reported message is ordinary and stays, even with no channel role.
 */
test("nothing is aimed at your own account except deleting your own message", () => {
  const { allowed, blocked } = queueAuthority(
    input({ targetIsSelf: true, actorChannelRole: null }),
  );
  assert.deepEqual(allowed, ["delete", "escalate", "dismiss"]);
  assert.equal(blocked.ban, "not-against-yourself");
  assert.equal(blocked.timeout, "not-against-yourself");
  assert.equal(blocked.kick, "not-against-yourself");
});

/**
 * The pairing the relay enforces: `(action == "dismiss") == (status ==
 * "dismissed")`. Values are hardcoded — deriving them from the function under
 * test would move with the bug.
 */
test("only dismiss pairs with the dismissed status", () => {
  assert.equal(statusForAction("dismiss"), "dismissed");
  assert.equal(statusForAction("escalate"), "resolved");
  assert.equal(statusForAction("delete"), "resolved");
  assert.equal(statusForAction("kick"), "resolved");
  assert.equal(statusForAction("ban"), "resolved");
  assert.equal(statusForAction("timeout"), "resolved");
});

test("each resolution names the enforcement kind it must send first", () => {
  assert.equal(enforcementKindFor("delete"), 9005);
  assert.equal(enforcementKindFor("kick"), 9001);
  assert.equal(enforcementKindFor("ban"), 9040);
  assert.equal(enforcementKindFor("timeout"), 9042);
  assert.equal(enforcementKindFor("escalate"), null);
  assert.equal(enforcementKindFor("dismiss"), null);
});

test("every block reason has copy a moderator can read", () => {
  for (const reason of [
    "not-a-moderator",
    "needs-channel-role",
    "needs-a-channel",
    "needs-an-author",
    "admin-cannot-action-admin",
    "not-against-yourself",
  ]) {
    const label = blockReasonLabel(reason);
    assert.equal(typeof label, "string");
    assert.ok(label.length > 0, `no copy for ${reason}`);
  }
});

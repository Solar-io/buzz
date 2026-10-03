import assert from "node:assert/strict";
import { test } from "node:test";
import {
  banTags,
  channelMemberRole,
  isLastOwner,
  putUserTags,
  removeUserTags,
  timeoutTags,
} from "./channelMemberAdmin.ts";

const pk = "a".repeat(64);
test("putUserTags pins explicit Member, Guest and Admin role tags", () => {
  for (const role of ["member", "guest", "admin", "owner"]) {
    assert.deepEqual(putUserTags("channel", pk.toUpperCase(), role), [
      ["h", "channel"],
      ["p", pk],
      ["role", role],
    ]);
  }
});
test("removeUserTags pins channel-scoped 9001 tags", () => {
  assert.deepEqual(removeUserTags("channel", pk), [
    ["h", "channel"],
    ["p", pk],
  ]);
});
test("timeoutTags pins absolute expiration and reason without channel tags", () => {
  assert.deepEqual(timeoutTags(pk, 3600, " Spam ", 1700000000), [
    ["p", pk],
    ["expiration", "1700003600"],
    ["reason", "Spam"],
  ]);
});
test("banTags pins permanent community ban tags with reason", () => {
  assert.deepEqual(banTags(pk, " Spam "), [
    ["p", pk],
    ["reason", "Spam"],
  ]);
});
test("restriction builders reject empty reasons and invalid durations or keys", () => {
  assert.throws(() => banTags(pk, "  "), /reason/);
  assert.throws(() => timeoutTags(pk, 0, "spam"), /duration/);
  assert.throws(() => timeoutTags(pk, 1.5, "spam"), /duration/);
  assert.throws(() => timeoutTags(pk, 3600, "\n"), /reason/);
  assert.throws(() => removeUserTags("ch", "invalid"), /public key/);
});
test("last owner guard counts the full roster, including owners outside People", () => {
  assert.equal(isLastOwner({ role: "owner" }, [{ role: "owner" }]), true);
  assert.equal(
    isLastOwner({ role: "owner" }, [{ role: "owner" }, { role: "owner" }]),
    false,
  );
  assert.equal(isLastOwner({ role: "member" }, [{ role: "owner" }]), false);
});
test("channelMemberRole reads the fourth p-tag slot and short tags never grant authority", () => {
  assert.equal(channelMemberRole(["p", pk, "", "owner"]), "owner");
  assert.equal(channelMemberRole(["p", pk, "admin"]), undefined);
  assert.equal(channelMemberRole(["p", pk, "", "invalid"]), undefined);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  editMetadataTags,
  parseChannelAbout,
  TTL_PRESETS,
} from "./channelMetadataEdit.ts";

const id = "channel-w1";
test('archive emits exactly [["h",id],["archived","true"]]', () => {
  assert.deepEqual(editMetadataTags(id, { archived: true }), [
    ["h", id],
    ["archived", "true"],
  ]);
});
test("purpose edit never touches about", () => {
  assert.deepEqual(editMetadataTags(id, { purpose: " Ship the fix " }), [
    ["h", id],
    ["purpose", "Ship the fix"],
  ]);
  assert.deepEqual(editMetadataTags(id, { purpose: "" }), [
    ["h", id],
    ["purpose", ""],
  ]);
});
test("ttl preset 7d emits 604800", () => {
  assert.equal(TTL_PRESETS.length, 5);
  const preset = TTL_PRESETS.find(
    (item) => item.label === "Temporary · 7 days",
  );
  assert.ok(preset);
  assert.deepEqual(editMetadataTags(id, { ttl: preset.seconds }), [
    ["h", id],
    ["ttl", "604800"],
  ]);
});
test("Ongoing clears ttl with the desktop's empty tag", () => {
  assert.deepEqual(editMetadataTags(id, { ttl: null }), [
    ["h", id],
    ["ttl", ""],
  ]);
});
test("metadata patches canonicalize names and reject invalid edits", () => {
  assert.deepEqual(editMetadataTags(id, { name: " # New name " }), [
    ["h", id],
    ["name", "New name"],
  ]);
  assert.throws(
    () => editMetadataTags(id, { name: "###" }),
    /name is required/,
  );
  assert.throws(() => editMetadataTags(id, {}), /detail to change/);
  for (const ttl of [0, -1, 0.5, NaN, Infinity, 2147483648])
    assert.throws(() => editMetadataTags(id, { ttl }), /positive/);
});
test("About parses relay tags and keeps joining independent of visibility", () => {
  const event = {
    kind: 39000,
    id: "a",
    created_at: 1,
    tags: [
      ["d", id],
      ["name", "W1"],
      ["purpose", "Testing"],
      ["about", "[parent:original]"],
      ["private"],
      ["closed"],
      ["ttl", "604800"],
      ["t", "forum"],
      ["archived", "true"],
    ],
  };
  assert.deepEqual(parseChannelAbout(event), {
    name: "W1",
    purpose: "Testing",
    visibility: "private",
    ttl: 604800,
    type: "forum",
    archived: true,
    joining: "invite",
  });
  assert.equal(
    parseChannelAbout({ ...event, tags: [["d", id], ["public"], ["closed"]] })
      .joining,
    "invite",
  );
  assert.equal(
    parseChannelAbout({ ...event, tags: [["d", id], ["public"]] }).joining,
    "anyone",
  );
  assert.equal(parseChannelAbout({ ...event, kind: 9 }), null);
  assert.equal(parseChannelAbout({ ...event, tags: [] }), null);
});

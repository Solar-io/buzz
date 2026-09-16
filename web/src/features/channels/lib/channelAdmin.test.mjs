import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalChannelName,
  deleteChannelTags,
  deleteChannelVerdict,
  renameChannelTags,
  withoutChannel,
} from "./channelAdmin.ts";

test("canonicalChannelName strips leading # and whitespace", () => {
  assert.equal(canonicalChannelName("#general"), "general");
  assert.equal(canonicalChannelName("  #general"), "general");
  assert.equal(canonicalChannelName("###triple"), "triple");
  assert.equal(canonicalChannelName("general  "), "general");
  assert.equal(canonicalChannelName("mid # keep"), "mid # keep");
});

test("canonicalChannelName on all-separator input yields empty", () => {
  assert.equal(canonicalChannelName("#"), "");
  assert.equal(canonicalChannelName("   "), "");
});

test("renameChannelTags builds the 9002 h+name shape", () => {
  assert.deepEqual(renameChannelTags("abc", "#Renamed Room "), [
    ["h", "abc"],
    ["name", "Renamed Room"],
  ]);
});

test("deleteChannelTags builds the 9008 h-only shape", () => {
  assert.deepEqual(deleteChannelTags("abc"), [["h", "abc"]]);
});

test("deleteChannelVerdict on success returns the channel id for eviction", () => {
  const verdict = deleteChannelVerdict("chan-1", {
    ok: true,
    message: "deleted group",
  });
  assert.deepEqual(verdict, { outcome: "deleted", channelId: "chan-1" });
});

test("deleteChannelVerdict on refusal propagates the relay message verbatim", () => {
  const verdict = deleteChannelVerdict("chan-1", {
    ok: false,
    message: "only owner can delete group",
  });
  assert.deepEqual(verdict, {
    outcome: "refused",
    message: "only owner can delete group",
  });
});

test("withoutChannel removes exactly the deleted channel", () => {
  const list = [
    { id: "a", name: "general" },
    { id: "b", name: "random" },
    { id: "c", name: "dev" },
  ];
  assert.deepEqual(
    withoutChannel(list, "b").map((c) => c.id),
    ["a", "c"],
  );
});

test("withoutChannel keeps the input untouched (pure eviction)", () => {
  const list = [{ id: "a", name: "general" }];
  withoutChannel(list, "a");
  assert.equal(list.length, 1, "caller's array must not be mutated");
  assert.deepEqual(withoutChannel(list, "missing"), list);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalChannelName,
  deleteChannelTags,
  renameChannelTags,
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

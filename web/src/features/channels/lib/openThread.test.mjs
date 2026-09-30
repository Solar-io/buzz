import assert from "node:assert/strict";
import { test } from "node:test";
import {
  retargetThread,
  threadAfterNavigation,
  threadPaneSource,
} from "./openThread.ts";

const inGeneral = { channelId: "general", rootId: "root-1" };

test("docked: the open thread survives a switch to another channel", () => {
  assert.deepEqual(
    threadAfterNavigation(inGeneral, { selectedId: "random", docked: true }),
    inGeneral,
  );
});

test("docked: the open thread survives a full-page view (no channel)", () => {
  assert.deepEqual(
    threadAfterNavigation(inGeneral, { selectedId: undefined, docked: true }),
    inGeneral,
  );
});

test("overlay: a switch away closes the sheet; staying keeps it", () => {
  assert.equal(
    threadAfterNavigation(inGeneral, { selectedId: "random", docked: false }),
    null,
  );
  assert.deepEqual(
    threadAfterNavigation(inGeneral, { selectedId: "general", docked: false }),
    inGeneral,
  );
});

test("nothing open stays nothing open", () => {
  assert.equal(
    threadAfterNavigation(null, { selectedId: "random", docked: true }),
    null,
  );
});

test("opening a thread anchors it to the open conversation", () => {
  assert.deepEqual(retargetThread(inGeneral, "root-9", "random"), {
    channelId: "random",
    rootId: "root-9",
  });
  assert.deepEqual(retargetThread(null, "root-9", "random"), {
    channelId: "random",
    rootId: "root-9",
  });
});

test("re-setting the open root keeps its own channel (Replies toggle)", () => {
  assert.deepEqual(retargetThread(inGeneral, "root-1", "random"), inGeneral);
});

test("null closes; a root with no open conversation cannot re-anchor", () => {
  assert.equal(retargetThread(inGeneral, null, "general"), null);
  assert.deepEqual(retargetThread(inGeneral, "root-9", undefined), inGeneral);
});

test("pane source: none / the open conversation / another channel", () => {
  assert.equal(threadPaneSource(null, "general"), "none");
  assert.equal(threadPaneSource(inGeneral, "general"), "current");
  assert.equal(threadPaneSource(inGeneral, "random"), "other");
  assert.equal(threadPaneSource(inGeneral, undefined), "other");
});

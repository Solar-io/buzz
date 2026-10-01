import assert from "node:assert/strict";
import test from "node:test";

import {
  clampFileWidth,
  closeFileTab,
  EMPTY_FILE_TABS,
  fileTabKey,
  MAX_FILE_TABS,
  openFileTab,
  selectFileTab,
  setFileTabsExpanded,
} from "./fileTabs.ts";

function file(name, messageId = "m1") {
  const url = `https://r/${name}`;
  return {
    key: fileTabKey(messageId, url),
    url,
    filename: name,
    mime: null,
    size: null,
    channelId: "c",
    messageId,
    authorPubkey: "a",
    createdAt: 1,
    rootId: null,
    replyToId: null,
    path: null,
  };
}

const keys = (state) => state.files.map((open) => open.filename);

test("opening adds a tab after the others and shows it; reopening only shows it", () => {
  let state = openFileTab(EMPTY_FILE_TABS, file("a.md"));
  state = openFileTab(state, file("b.html"));
  assert.deepEqual(keys(state), ["a.md", "b.html"]);
  assert.equal(state.active, file("b.html").key);
  state = openFileTab(state, file("a.md"));
  assert.deepEqual(keys(state), ["a.md", "b.html"], "no duplicate tab");
  assert.equal(state.active, file("a.md").key);
});

test("the same blob in two messages is two tabs (two comment threads)", () => {
  const one = file("a.md", "m1");
  const two = file("a.md", "m2");
  assert.notEqual(one.key, two.key);
  const state = openFileTab(openFileTab(EMPTY_FILE_TABS, one), two);
  assert.equal(state.files.length, 2);
});

test("past the cap the oldest tab you are not looking at closes", () => {
  assert.equal(MAX_FILE_TABS, 6);
  let state = EMPTY_FILE_TABS;
  for (const name of ["1", "2", "3", "4", "5", "6"]) {
    state = openFileTab(state, file(name));
  }
  state = selectFileTab(state, file("1").key);
  state = openFileTab(state, file("7"));
  assert.deepEqual(keys(state), ["1", "3", "4", "5", "6", "7"]);
  assert.equal(state.active, file("7").key);
});

test("closing the active file goes left; closing the first goes back to Work", () => {
  let state = EMPTY_FILE_TABS;
  for (const name of ["a", "b", "c"]) {
    state = openFileTab(state, file(name));
  }
  state = closeFileTab(state, file("c").key);
  assert.equal(state.active, file("b").key);
  state = selectFileTab(state, file("a").key);
  state = setFileTabsExpanded(state, true);
  state = closeFileTab(state, file("a").key);
  assert.equal(state.active, null, "back to the shell's tab");
  assert.equal(state.expanded, false);
  assert.deepEqual(keys(state), ["b"]);
  // Closing a tab you are not on leaves the screen alone.
  state = openFileTab(state, file("d"));
  state = closeFileTab(state, file("b").key);
  assert.equal(state.active, file("d").key);
});

test("picking the shell's tab unexpands; expanding needs an active file", () => {
  let state = openFileTab(EMPTY_FILE_TABS, file("a"));
  state = setFileTabsExpanded(state, true);
  assert.equal(state.expanded, true);
  state = selectFileTab(state, null);
  assert.equal(state.active, null);
  assert.equal(state.expanded, false);
  assert.equal(setFileTabsExpanded(state, true).expanded, false);
  assert.equal(selectFileTab(state, "missing"), state);
});

test("the file pane width clamps to 380–960", () => {
  assert.equal(clampFileWidth(100), 380);
  assert.equal(clampFileWidth(2000), 960);
  assert.equal(clampFileWidth(600.4), 600);
  assert.equal(clampFileWidth(Number.NaN), 540);
});

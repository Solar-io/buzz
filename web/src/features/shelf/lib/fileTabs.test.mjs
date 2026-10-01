import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_CANVAS_KEY,
  canvasItemKeys,
  clampFileWidth,
  closeFileTab,
  EMPTY_FILE_TABS,
  fileOnScreen,
  fileTabKey,
  MAX_FILE_TABS,
  openFileTab,
  resolveCanvasItem,
  selectFileTab,
  setFileTabsExpanded,
  showCanvas,
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

// ---- Canvas (Sam, 2026-09-30): Work | Canvas, documents under Canvas ------

test("opening a file puts Canvas on screen with that file selected", () => {
  assert.equal(EMPTY_FILE_TABS.open, false, "the shell starts on Work");
  const state = openFileTab(EMPTY_FILE_TABS, file("report.pdf"));
  assert.equal(state.open, true);
  assert.equal(state.active, "m1|https://r/report.pdf");
  assert.equal(fileOnScreen(state), "m1|https://r/report.pdf");
  // Reopening from chat while Work is on screen brings Canvas back to it.
  const onWork = showCanvas(openFileTab(state, file("b.md")), false);
  assert.equal(onWork.open, false);
  const back = openFileTab(onWork, file("report.pdf"));
  assert.equal(back.open, true);
  assert.equal(back.active, "m1|https://r/report.pdf");
});

test("Work hides Canvas without forgetting its document; Canvas comes back to it", () => {
  let state = openFileTab(EMPTY_FILE_TABS, file("a.md"));
  state = openFileTab(state, file("b.html"));
  state = selectFileTab(state, file("a.md").key);
  state = setFileTabsExpanded(state, true);
  state = showCanvas(state, false);
  assert.equal(state.open, false);
  assert.equal(state.expanded, false, "Work never sits under a full-row file");
  assert.equal(state.active, "m1|https://r/a.md", "the choice survives");
  assert.equal(fileOnScreen(state), null, "no tile is highlighted on Work");
  assert.deepEqual(keys(state), ["a.md", "b.html"], "nothing closed");
  state = showCanvas(state, true);
  assert.equal(state.open, true);
  assert.equal(fileOnScreen(state), "m1|https://r/a.md");
  // Expanding needs Canvas on screen.
  assert.equal(
    setFileTabsExpanded(showCanvas(state, false), true).expanded,
    false,
  );
});

test("the channel canvas is the first document and can be selected, never closed", () => {
  assert.equal(CHANNEL_CANVAS_KEY, "canvas:channel");
  const files = ["f1", "f2"];
  assert.deepEqual(canvasItemKeys(files, true), ["canvas:channel", "f1", "f2"]);
  assert.deepEqual(canvasItemKeys(files, false), ["f1", "f2"]);
  let state = openFileTab(EMPTY_FILE_TABS, file("a.md"));
  state = showCanvas(state, false);
  state = selectFileTab(state, CHANNEL_CANVAS_KEY);
  assert.equal(state.open, true);
  assert.equal(state.active, "canvas:channel");
  assert.equal(fileOnScreen(state), null, "the channel canvas is not a file");
  // It is not a file: closing it is a no-op.
  assert.equal(closeFileTab(state, CHANNEL_CANVAS_KEY), state);
  // An unknown file key changes nothing.
  assert.equal(selectFileTab(state, "missing"), state);
});

test("a chosen document that is gone resolves to the first one", () => {
  assert.equal(resolveCanvasItem(["canvas:channel", "f1"], "f1"), "f1");
  assert.equal(resolveCanvasItem(["f1", "f2"], "canvas:channel"), "f1");
  assert.equal(
    resolveCanvasItem(["canvas:channel", "f1"], null),
    "canvas:channel",
  );
  assert.equal(resolveCanvasItem([], "f1"), null);
});

test("closing the selected document goes left, from the first goes right, and the last hands the pane to Work", () => {
  let state = EMPTY_FILE_TABS;
  for (const name of ["a", "b", "c"]) {
    state = openFileTab(state, file(name));
  }
  state = closeFileTab(state, file("c").key);
  assert.equal(state.active, file("b").key, "left neighbour");
  state = selectFileTab(state, file("a").key);
  state = setFileTabsExpanded(state, true);
  state = closeFileTab(state, file("a").key);
  assert.equal(state.active, file("b").key, "the first closes to its right");
  assert.equal(state.open, true);
  assert.equal(state.expanded, true, "still expanded on the next document");
  assert.deepEqual(keys(state), ["b"]);
  // Closing a tab you are not on leaves the screen alone.
  state = openFileTab(state, file("d"));
  state = closeFileTab(state, file("b").key);
  assert.equal(state.active, file("d").key);
  // The last document closes Canvas: back to Work, unexpanded.
  state = closeFileTab(state, file("d").key);
  assert.deepEqual(state, EMPTY_FILE_TABS);
});

test("with the channel canvas drawn first, closing the first file lands on it", () => {
  let state = openFileTab(EMPTY_FILE_TABS, file("a"));
  state = openFileTab(state, file("b"));
  state = selectFileTab(state, file("a").key);
  const items = canvasItemKeys(
    state.files.map((open) => open.key),
    true,
  );
  const closed = closeFileTab(state, file("a").key, items);
  assert.equal(closed.active, "canvas:channel");
  assert.equal(closed.open, true);
  // Closing the only file beside the channel canvas keeps Canvas up on it.
  const only = openFileTab(EMPTY_FILE_TABS, file("x"));
  const left = closeFileTab(only, file("x").key, [
    "canvas:channel",
    file("x").key,
  ]);
  assert.equal(left.open, true);
  assert.equal(left.active, "canvas:channel");
  assert.deepEqual(left.files, []);
});

test("the file pane width clamps to 380–960", () => {
  assert.equal(clampFileWidth(100), 380);
  assert.equal(clampFileWidth(2000), 960);
  assert.equal(clampFileWidth(600.4), 600);
  assert.equal(clampFileWidth(Number.NaN), 540);
});

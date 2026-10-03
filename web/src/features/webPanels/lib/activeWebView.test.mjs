import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INITIAL_ACTIVE_WEB,
  KEEP_ALIVE,
  activeWebReducer,
  pickFilesPanel,
  webLayerMode,
  webViewKey,
} from "./activeWebView.ts";
import { DAILY_DIGEST_PANEL, DAILY_DIGEST_TARGET } from "./dailyDigest.ts";

const link = (panelId) => ({ kind: "link", panelId });
const files = (panelId) => ({ kind: "files", panelId });

function run(...actions) {
  return actions.reduce(activeWebReducer, INITIAL_ACTIVE_WEB);
}

test("Daily Digest has a fixed target, title and edition URL", () => {
  assert.deepEqual(DAILY_DIGEST_TARGET, {
    kind: "digest",
    panelId: "daily-digest",
  });
  assert.equal(DAILY_DIGEST_PANEL.label, "Daily Digest");
  assert.equal(
    DAILY_DIGEST_PANEL.url,
    "https://crichton.tailb3d4b8.ts.net:6450/edition/latest.html",
  );
  assert.equal(webViewKey(DAILY_DIGEST_TARGET), "digest:daily-digest");
});

test("Daily Digest replaces Files and hides for a conversation without losing its frame", () => {
  const shown = run(
    { type: "show", target: files("files") },
    { type: "focus", focused: true },
    { type: "show", target: DAILY_DIGEST_TARGET },
  );
  assert.deepEqual(shown.active, { kind: "digest", panelId: "daily-digest" });
  assert.deepEqual(shown.mounted, ["files:files", "digest:daily-digest"]);
  assert.equal(shown.focus, false);
  assert.equal(webLayerMode(shown), "page");
  const hidden = activeWebReducer(shown, { type: "hide" });
  assert.equal(hidden.active, null);
  assert.equal(webLayerMode(hidden), "none");
  assert.deepEqual(hidden.mounted, ["files:files", "digest:daily-digest"]);
});

test("Daily Digest shares the four-frame LRU and refreshes on another click", () => {
  const shown = run(
    { type: "show", target: DAILY_DIGEST_TARGET },
    { type: "show", target: link("1") },
    { type: "show", target: link("2") },
    { type: "show", target: files("files") },
    { type: "show", target: DAILY_DIGEST_TARGET },
    { type: "show", target: link("3") },
  );
  assert.deepEqual(shown.active, { kind: "link", panelId: "3" });
  assert.deepEqual(shown.mounted, [
    "link:2",
    "files:files",
    "digest:daily-digest",
    "link:3",
  ]);
});

test("link A then link B: B shows at once and A stays mounted (was: B ignored)", () => {
  const state = run(
    { type: "show", target: link("a") },
    { type: "show", target: link("b") },
  );
  assert.deepEqual(state.active, link("b"));
  assert.deepEqual(state.mounted, ["link:a", "link:b"]);
});

test("a link click while Files shows switches straight to the link", () => {
  const state = run(
    { type: "show", target: files("files") },
    { type: "show", target: link("a") },
  );
  assert.deepEqual(state.active, link("a"));
  assert.deepEqual(state.mounted, ["files:files", "link:a"]);
});

test("hide returns to the conversation but keeps every frame alive", () => {
  const state = run(
    { type: "show", target: files("files") },
    { type: "show", target: link("a") },
    { type: "hide" },
  );
  assert.equal(state.active, null);
  assert.deepEqual(state.mounted, ["files:files", "link:a"]);
});

test("7 distinct links: every open succeeds, at most 4 frames live (LRU)", () => {
  let state = INITIAL_ACTIVE_WEB;
  for (const id of ["1", "2", "3", "4", "5", "6", "7"]) {
    state = activeWebReducer(state, { type: "show", target: link(id) });
    assert.deepEqual(state.active, link(id), `open ${id} is never refused`);
  }
  assert.equal(KEEP_ALIVE, 4);
  assert.deepEqual(state.mounted, ["link:4", "link:5", "link:6", "link:7"]);
});

test("re-showing a frame refreshes its recency so it is not the one evicted", () => {
  const state = run(
    { type: "show", target: link("1") },
    { type: "show", target: link("2") },
    { type: "show", target: link("3") },
    { type: "show", target: link("4") },
    { type: "show", target: link("1") },
    { type: "show", target: link("5") },
  );
  assert.deepEqual(state.mounted, ["link:3", "link:4", "link:1", "link:5"]);
});

test("full screen belongs to one open: switching page or hiding resets it", () => {
  const focused = run(
    { type: "show", target: link("a") },
    { type: "focus", focused: true },
  );
  assert.equal(focused.focus, true);
  assert.equal(
    activeWebReducer(focused, { type: "show", target: link("b") }).focus,
    false,
    "the next page opens with the sidebar visible",
  );
  const back = activeWebReducer(focused, { type: "hide" });
  assert.equal(back.focus, false);
  assert.equal(
    activeWebReducer(back, { type: "show", target: link("a") }).focus,
    false,
    "coming back to the same page after a DM does not resurrect full screen",
  );
  assert.equal(
    activeWebReducer(focused, { type: "show", target: link("a") }).focus,
    true,
    "re-clicking the page that is showing keeps full screen",
  );
});

test("focus is ignored while nothing is showing", () => {
  const state = run({ type: "focus", focused: true });
  assert.equal(state, INITIAL_ACTIVE_WEB);
});

test("prune drops removed panels, and hides a removed active page", () => {
  const state = run(
    { type: "show", target: link("a") },
    { type: "show", target: link("b") },
    { type: "prune", validKeys: new Set(["link:a"]) },
  );
  assert.equal(state.active, null);
  assert.deepEqual(state.mounted, ["link:a"]);
});

test("pickFilesPanel: last used Files site, else first, else setup id", () => {
  assert.equal(
    pickFilesPanel(["files", "nas"], ["files:nas", "link:a"]),
    "nas",
  );
  assert.equal(pickFilesPanel(["files", "nas"], ["files:gone"]), "files");
  assert.equal(pickFilesPanel([], []), "files");
});

test("layer mode: Files is a main-column page; a link or full screen covers the row", () => {
  assert.equal(webLayerMode(INITIAL_ACTIVE_WEB), "none");
  assert.equal(
    webLayerMode(run({ type: "show", target: files("files") })),
    "files",
  );
  assert.equal(webLayerMode(run({ type: "show", target: link("a") })), "page");
  const focused = run(
    { type: "show", target: files("files") },
    { type: "focus", focused: true },
  );
  assert.equal(webLayerMode(focused), "page", "full screen takes the row");
  assert.equal(
    webLayerMode(
      run({ type: "show", target: files("files") }, { type: "hide" }),
    ),
    "none",
  );
});
